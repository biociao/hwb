import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

// Codex（ChatGPT 桌面版 / codex-cli）的本地元数据读取器。
//
// 与 src/dshhome 同一条边界：**只读元数据，不读会话正文**。Codex 的元数据分布在两处：
//   1. `<CODEX_HOME>/state_5.sqlite` —— threads 表（标题 / cwd / token / 活跃时间 / 归档 / 分支）
//      以及 projects + project_roots（app-server 侧的项目镜像）；
//   2. `<CODEX_HOME>/.codex-global-state.json` —— 桌面前端真正的项目模型
//      （local-projects / project-order / pinned-project-ids / thread-project-assignments）。
// 两者用「项目根路径」对齐（实测本机 54 个项目全部按 rootPaths 一一对应）。
//
// 为什么不用 app-server（JSON-RPC / 62535 端口）：那条路需要桌面进程的会话凭据，
// 且会让 hwb 依赖 Codex 在运行；SQLite/JSON 是 Codex 自己落盘的稳定投影，断线也能看历史。
//
// 所有解析都按「可降级」写：任一文件缺失/损坏只降级对应域并记 reasons，不抛给调用方。

const DAY_MS = 86_400_000;
const THREAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TITLE_MAX = 120;
// Codex 会把「自动审查 / 子 agent」也写进 threads（实测本机 2256 条里 1350 条是 Guardian review、
// 580 条 subagent）。它们是真实的运行活动，但不代表「用户在某个项目上推进了什么」——
// 如果直接按 updated_at 取最近会话，每个项目的头条都会变成 0 token 的 Guardian review。
// 所以进度视图以用户会话为准，自动会话只进计数；只有用户会话数为 0 时才回退展示。
const AUTOMATED_SOURCES = new Set(['guardian_review', 'subagent']);

export function codexHomePath(env = process.env) {
  const custom = typeof env.CODEX_HOME === 'string' ? env.CODEX_HOME.trim() : '';
  return custom ? path.resolve(custom) : path.join(homedir(), '.codex');
}

export function isThreadId(value) {
  return typeof value === 'string' && THREAD_ID_RE.test(value);
}

function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function asString(value) {
  return typeof value === 'string' ? value : '';
}

function normalizeRoots(roots) {
  if (!Array.isArray(roots)) return [];
  return roots
    .filter((r) => typeof r === 'string' && r.startsWith('/'))
    .map((r) => r.replace(/\/+$/, ''))
    .filter(Boolean);
}

// Codex 的标题可能是超长的粘贴内容（实测有条目直接是文件清单）。截成单行短标题，
// 完整内容留在 preview 里由前端按需展示。
// Codex 把「浏览器上下文块」原样写进 title/first_user_message：实测有整条会话的标题就是
// `<in-app-browser-context source="ambient-ui-state">…`。这不是用户的问题，直接出现在
// 会话列表里既不可读也没有信息量；剥掉它，剩下的才是用户真正输入的内容（可能为空）。
const APP_CONTEXT_RE = /<in-app-browser-context[\s\S]*?<\/in-app-browser-context>/gi;

export function cleanTitle(raw, fallback = '未命名会话') {
  const text = asString(raw).replace(APP_CONTEXT_RE, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return fallback;
  return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX - 1)}…` : text;
}

// 带附件的首条用户消息由 Codex 拼成：
//   `# Files mentioned by the user:` → 附件清单 → `## My request:` → 用户真正的问题。
// 附件清单不是问题，只是信封。只有在拿不到会话名（threads.name）时才会走到这里
// （旧版库没有 name 列 / 新会话还没生成名字），此时取 `## My request:` 之后的正文；
// 连正文都没有（纯附件消息）就回退成「未命名会话」，而不是把文件清单当标题。
const FILES_PREAMBLE_RE = /^#\s*Files mentioned by the user:/i;
const MY_REQUEST_RE = /^##\s*My request:\s*/im;

function firstMessageTitle(raw) {
  const text = asString(raw);
  if (!FILES_PREAMBLE_RE.test(text)) return text;
  const marker = MY_REQUEST_RE.exec(text);
  return marker ? text.slice(marker.index + marker[0].length) : '';
}

// threads.updated_at 是秒级、updated_at_ms 是毫秒级（新行才有）。统一成毫秒，并挡掉明显越界的值
// （0 / 未来 10 年）—— 否则前端 timeAgo 会渲染出 "2068d ago" 这种噪声。
function toEpochMs(seconds, millis) {
  const fromMs = Number(millis);
  if (Number.isFinite(fromMs) && fromMs > 0) return fromMs;
  const fromSec = Number(seconds);
  if (Number.isFinite(fromSec) && fromSec > 0) return fromSec * 1000;
  return 0;
}

function isoOf(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  if (date.getUTCFullYear() < 2000 || date.getUTCFullYear() > 2100) return null;
  return date.toISOString();
}

// 只读打开 Codex 的 WAL 库。两条路：
//   1. 普通 readOnly —— Codex 桌面端在跑时 `-wal`/`-shm` 都在，一致性最好；
//   2. Codex 退出后 WAL 文件会被 checkpoint/删除，此时只读连接要么打不开（无法创建 `-shm`），
//      要么「打开成功但第一条查询就报 attempt to write a readonly database」（WAL 恢复需要写）。
//      这个状态下没有写者，用 `immutable=1` 读主文件快照是安全的；它绕过锁与 WAL，
//      而「无写者」正是走这条分支的前提（有写者时第 1 条通常已成功）。
//
// 所以降级判据必须是「**完整读一遍**失败」而不只是「open() 失败」—— 实测后者会漏掉第二种形态。
function withThreadsDb(dbFile, read) {
  let db;
  try {
    db = new DatabaseSync(dbFile, { readOnly: true });
    return read(db);
  } catch (primaryError) {
    try { db?.close(); } catch { /* 未打开 */ }
    try {
      db = new DatabaseSync(`${pathToFileURL(dbFile).href}?immutable=1`, { readOnly: true });
      return read(db);
    } catch {
      throw primaryError; // 两条都失败：把原始错误交给上层统一降级，保留更准确的报错
    }
  } finally {
    try { db?.close(); } catch { /* 已关闭 */ }
  }
}

// —— 运行态与未读：Codex 自己落盘的两张表 ——
//
// threads 表没有「是否在跑」：运行态在 `thread_history_<N>.sqlite` 的 `thread_turns`
// （每 turn 一行，status ∈ inProgress/completed/interrupted/failed；实测写入延迟 ~1s，
//  turn 开始/结束几秒内可见）。「未读」在 `state_5.sqlite` 的 `thread_read_receipts`：
//  Codex 只在**有未读 turn** 时留一行（`first_unread_turn` 非空），用户看过就删 —— 实测
//  已查看的会话没有行、刚跑完没看的会话有行，两者一一对应。
// 两处都是 Codex 自己的投影，hwb 只读；缺表/坏库一律降级为「未知」，不影响会话列表。
const TURN_HISTORY_RE = /^thread_history_(\d+)\.sqlite$/;
// inProgress 但线程 3 分钟没有任何更新 = 僵尸 turn（Codex 被杀/崩溃后永远不会收尾；实测 15 条、
// 最老 105 天）。3 分钟 = turn 进行中 updated_at 实测最大刷新间隔（28.75s）的 6 倍。
const TURN_RUNNING_STALE_MS = 3 * 60_000;

// thread_history 的文件名带版本号，按最大值挑（与 state_5 一样的「版本漂移」风险）。
function findTurnHistoryDb(home) {
  try {
    let best = null;
    for (const name of readdirSync(home)) {
      const m = TURN_HISTORY_RE.exec(name);
      if (!m) continue;
      const version = Number(m[1]);
      if (!best || version > best.version) best = { version, file: path.join(home, name) };
    }
    return best?.file ?? null;
  } catch {
    return null;
  }
}

// 每个 thread 的**最新** turn（rollout_ordinal 最大）。只碰 thread_turns 这张小表
// （实测 1.2 万行、2.5ms），绝不扫 thread_items 的会话正文。
function loadTurnStates(db) {
  const map = new Map();
  try {
    const rows = db.prepare(`
      SELECT t.thread_id, t.status, t.started_at, t.completed_at
        FROM thread_turns t
        JOIN (SELECT thread_id, MAX(rollout_ordinal) AS m FROM thread_turns GROUP BY thread_id) x
          ON x.thread_id = t.thread_id AND x.m = t.rollout_ordinal
    `).all();
    for (const row of rows) {
      map.set(String(row.thread_id), {
        status: String(row.status ?? ''),
        startedAtMs: toEpochMs(row.started_at, null),
        completedAtMs: toEpochMs(row.completed_at, null),
      });
    }
  } catch {
    return null; // schema 不认识 / 表缺失 → 状态未知（不是「空闲」）
  }
  return map;
}

function loadUnreadThreads(db) {
  try {
    const rows = db.prepare('SELECT thread_id FROM thread_read_receipts WHERE first_unread_turn IS NOT NULL').all();
    return new Set(rows.map((r) => String(r.thread_id)));
  } catch {
    return new Set(); // 老版本 Codex 没有这张表 = 没有未读概念
  }
}

function readTurnStates(home) {
  const file = findTurnHistoryDb(home);
  if (!file) return null;
  try {
    return withThreadsDb(file, (db) => {
      db.exec('PRAGMA busy_timeout = 2000');
      return loadTurnStates(db);
    });
  } catch {
    return null; // 坏库/权限问题：状态降级为「未知」，绝不拖垮会话列表
  }
}

// 'running' | 'ended' | null（未知）。新鲜度用 thread 的 updated_at_ms：turn 进行中它每 10–30s
// 刷新一次；陈旧说明是崩溃残留的 inProgress，不能报「运行中」（实测本机 16 条 inProgress 里
// 15 条是 7–9 月的僵尸）。
function deriveTurnState(turn, updatedAtMs, now) {
  if (!turn) return null;
  if (turn.status === 'inProgress') {
    const age = Number.isFinite(updatedAtMs) && updatedAtMs > 0 ? now - updatedAtMs : NaN;
    // 未来时间戳也按陈旧处理（与 lib/status.js 同一取舍：本机时钟判断不了未来有多新）
    return Number.isFinite(age) && age >= 0 && age <= TURN_RUNNING_STALE_MS ? 'running' : null;
  }
  if (turn.status === 'completed' || turn.status === 'interrupted' || turn.status === 'failed') return 'ended';
  return null;
}

function readDbMetadata(dbFile, maxThreads) {
  return withThreadsDb(dbFile, (db) => ({
    threads: loadThreads(db, maxThreads),
    legacyProjects: loadLegacyProjects(db),
    unreadThreads: loadUnreadThreads(db),
  }));
}

// Codex 的会话有**两个**标题字段，含义不同：
//   · `threads.name`  —— 会话名（Codex 自动摘要生成、用户重命名后覆盖），也就是 Codex 桌面端
//     侧边栏里显示的那一行；它同时被镜像到 `session_index.jsonl` 的 `thread_name`；
//   · `threads.title` —— 建会话时落盘的**首条用户消息原文**。带附件的会话开头就是
//     `# Files mentioned by the user:` 附件前言，所以它天然不是标题。
// 历史实现只读 title，于是 hwb 的会话列表显示成文件清单，而 Codex 里显示的是
// 「新增PUMCH分支报出解读模块」这类会话名 —— 这就是「标题与实际不符」的来源。
// 旧版 state_5.sqlite 可能没有 name 列（Codex 后加的），用 PRAGMA 探测后降级，
// 不让缺列把整个 Codex 快照读崩。
function hasThreadColumn(db, column) {
  try {
    return db.prepare('PRAGMA table_info(threads)').all().some((c) => c.name === column);
  } catch {
    return false;
  }
}

function loadThreads(db, limits) {
  const nameColumn = hasThreadColumn(db, 'name') ? 'name' : "'' AS name";
  const stmt = db.prepare(`
    SELECT id, ${nameColumn}, title, cwd, tokens_used, updated_at, updated_at_ms,
           archived, is_pinned, git_branch, preview, first_user_message, thread_source
    FROM threads
    ORDER BY CASE WHEN updated_at_ms IS NOT NULL THEN updated_at_ms ELSE updated_at * 1000 END DESC
    LIMIT ?
  `);
  return stmt.all(limits).map((row) => {
    const updatedAtMs = toEpochMs(row.updated_at, row.updated_at_ms);
    const tokens = Number(row.tokens_used);
    const source = asString(row.thread_source) || null;
    // 会话名优先（Codex 自己列表里的那一行）；没有才退回首条用户消息，
    // 且从附件前言里剥出 `## My request:` 正文。
    const name = cleanTitle(row.name, '');
    return {
      id: String(row.id),
      title: name || cleanTitle(firstMessageTitle(row.title || row.first_user_message) || row.preview),
      preview: cleanTitle(row.preview || row.first_user_message, ''),
      cwd: asString(row.cwd) || null,
      gitBranch: asString(row.git_branch) || null,
      source,
      automated: AUTOMATED_SOURCES.has(source),
      tokens: Number.isFinite(tokens) && tokens > 0 ? tokens : 0,
      updatedAt: isoOf(updatedAtMs),
      updatedAtMs,
      archived: Boolean(row.archived),
      pinned: Boolean(row.is_pinned),
    };
  });
}

function loadLegacyProjects(db) {
  // 兼容路径：极旧/极新的 Codex 可能没有 .codex-global-state.json 的 local-projects，
  // 但 app-server 的项目镜像仍在 SQLite 里。仅在 JSON 项目模型缺失时使用。
  try {
    const projects = db.prepare('SELECT id, name FROM projects ORDER BY position ASC').all();
    const roots = db.prepare('SELECT project_id, path FROM project_roots ORDER BY project_id, position ASC').all();
    const byProject = new Map();
    for (const row of roots) {
      if (!byProject.has(row.project_id)) byProject.set(row.project_id, []);
      byProject.get(row.project_id).push(row.path);
    }
    return projects.map((p) => ({
      id: String(p.id),
      name: cleanTitle(p.name, '未命名项目'),
      roots: normalizeRoots(byProject.get(p.id) ?? []),
      pinned: false,
    }));
  } catch {
    return [];
  }
}

// 项目归属：先信桌面端显式的 thread-project-assignments，再按 cwd 的最长根路径前缀回退。
// 采用最长前缀（而不是「第一个命中」）是因为 Codex 允许一个项目挂多个根，且根会互相嵌套
// （如 /Volumes/repo 与 /Volumes/repo/ciao/x），取最长才能落到最具体的项目。
function buildProjectIndex(projects) {
  const byId = new Map(projects.map((p) => [p.id, p]));
  const roots = [];
  for (const project of projects) {
    for (const root of project.roots) roots.push({ project, root });
  }
  roots.sort((a, b) => b.root.length - a.root.length);
  return {
    byId,
    matchCwd(cwd) {
      if (!cwd) return null;
      for (const entry of roots) {
        if (cwd === entry.root || cwd.startsWith(entry.root + '/')) return entry.project;
      }
      return null;
    },
  };
}

function resolveAssignedProject(assignment, projectIndex) {
  const projectId = assignment && typeof assignment === 'object' ? assignment.projectId : null;
  if (typeof projectId !== 'string') return null;
  return projectIndex.byId.get(projectId) ?? null;
}

function summarizeProject(project, threads, { days, now, threadsPerProject, orderIndex }) {
  const userThreads = threads.filter((t) => !t.automated);
  // 优先展示用户会话；一个项目如果只有自动审查/子 agent 会话，才回退到它们（否则卡片会是空的）。
  const visible = userThreads.length > 0 ? userThreads : threads;
  const active = visible.filter((t) => t.updatedAtMs >= now - days * DAY_MS);
  const lastThread = visible[0] ?? null;
  return {
    id: project.id,
    name: project.name,
    roots: project.roots,
    pinned: Boolean(project.pinned),
    orderIndex,
    threadCount: threads.length,
    userThreadCount: userThreads.length,
    automatedThreadCount: threads.length - userThreads.length,
    activeThreadCount: active.length,
    tokens: threads.reduce((sum, t) => sum + t.tokens, 0),
    activeTokens: active.reduce((sum, t) => sum + t.tokens, 0),
    lastActivity: lastThread?.updatedAt ?? null,
    lastThread,
    threads: visible.slice(0, threadsPerProject),
  };
}

function compareProjects(a, b) {
  // 置顶优先，然后按最近活动；完全没活动的项目按 Codex 侧边栏顺序（project-order）兜底。
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  const at = a.lastActivity ? Date.parse(a.lastActivity) : 0;
  const bt = b.lastActivity ? Date.parse(b.lastActivity) : 0;
  if (at !== bt) return bt - at;
  if (a.orderIndex !== b.orderIndex) return a.orderIndex - b.orderIndex;
  return a.name.localeCompare(b.name, 'zh-CN');
}

/**
 * 读取 Codex 项目的「进度快照」。
 *
 * @param {object} [options]
 * @param {string} [options.home]  CODEX_HOME（默认环境变量 / ~/.codex）
 * @param {number} [options.days]  活跃窗口（天），默认 7
 * @param {number} [options.limit] 返回项目数上限，默认 30
 * @param {number} [options.threadsPerProject] 每个项目附带最近会话数，默认 5
 * @param {number} [options.now]   当前时间（毫秒），测试注入
 * @param {number} [options.maxThreads] 从 SQLite 读取的会话上限，默认 5000（按最近活跃排序）
 */
export function readCodexProjects({
  home = codexHomePath(),
  days = 7,
  limit = 30,
  threadsPerProject = 5,
  now = Date.now(),
  maxThreads = 5000,
} = {}) {
  const reasons = [];
  const globalFile = path.join(home, '.codex-global-state.json');
  const dbFile = path.join(home, 'state_5.sqlite');
  const hasHome = existsSync(home);

  if (!hasHome) reasons.push(`未找到 Codex home：${home}`);

  const global = readJsonFile(globalFile);
  if (!global) reasons.push(`未能读取 ${path.basename(globalFile)}（项目归属/置顶信息降级）`);

  let threads = [];
  let legacyProjects = [];
  let unreadThreads = new Set();
  try {
    if (existsSync(dbFile)) {
      // readOnly：hwb 绝不写 Codex 的状态库（WAL 由 Codex 自己维护）；桌面端未运行时走 immutable 快照。
      const metadata = readDbMetadata(dbFile, Math.max(1, Math.min(20_000, maxThreads)));
      threads = metadata.threads;
      legacyProjects = metadata.legacyProjects;
      unreadThreads = metadata.unreadThreads ?? new Set();
    } else {
      reasons.push(`未找到 ${path.basename(dbFile)}（会话列表降级）`);
    }

    // 运行态 + 未读：两个投影都要挂到 thread 上；缺任何一个都不编造（turnState=null → 状态未知）。
    const turnStates = readTurnStates(home);
    for (const thread of threads) {
      const turn = turnStates?.get(thread.id) ?? null;
      thread.turnState = deriveTurnState(turn, thread.updatedAtMs, now);
      thread.turnCompletedAt = turn?.completedAtMs ?? null;
      thread.unread = unreadThreads.has(thread.id);
    }

    const jsonProjects = global && global['local-projects'] && typeof global['local-projects'] === 'object'
      ? Object.values(global['local-projects'])
          .filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string')
          .map((p) => ({
            id: p.id,
            name: cleanTitle(p.name, '未命名项目'),
            roots: normalizeRoots(p.rootPaths),
            pinned: false,
          }))
      : [];

    let projects = jsonProjects;
    if (!projects.length && legacyProjects.length) {
      projects = legacyProjects;
      if (projects.length) reasons.push('项目列表来自 SQLite 镜像（未读到 local-projects）');
    }

    const pinnedIds = global && Array.isArray(global['pinned-project-ids']) ? new Set(global['pinned-project-ids']) : new Set();
    const order = global && Array.isArray(global['project-order']) ? global['project-order'] : [];
    const orderOf = (id) => {
      const index = order.indexOf(id);
      return index === -1 ? Number.MAX_SAFE_INTEGER : index;
    };
    for (const project of projects) project.pinned = pinnedIds.has(project.id);

    const projectIndex = buildProjectIndex(projects);
    const assignments = global && global['thread-project-assignments'] && typeof global['thread-project-assignments'] === 'object'
      ? global['thread-project-assignments']
      : {};

    const liveThreads = threads.filter((t) => !t.archived && t.id);
    const buckets = new Map();
    let unassignedThreadCount = 0;
    const unassigned = [];
    for (const thread of liveThreads) {
      const project = resolveAssignedProject(assignments[thread.id], projectIndex) ?? projectIndex.matchCwd(thread.cwd);
      if (!project) {
        unassignedThreadCount += 1;
        // 未归属的会话也要返回（索引器会按 cwd basename 给它们一个 project，跟 dsh 对
        // 「没有 workspace 的会话」的归一化口径一致）；只做防爆上限，不按展示条数截断。
        if (unassigned.length < 5000) unassigned.push(thread);
        continue;
      }
      if (!buckets.has(project.id)) buckets.set(project.id, []);
      buckets.get(project.id).push(thread);
    }

    const summaries = projects
      .map((project) => summarizeProject(project, buckets.get(project.id) ?? [], {
        days,
        now,
        threadsPerProject,
        orderIndex: orderOf(project.id),
      }))
      .filter((project) => project.threadCount > 0)
      .sort(compareProjects);

    const activeProjectCount = summaries.filter((p) => p.activeThreadCount > 0).length;
    const automatedThreadCount = liveThreads.filter((t) => t.automated).length;
    return {
      home,
      dbPath: existsSync(dbFile) ? dbFile : null,
      generatedAt: new Date(now).toISOString(),
      degraded: reasons.length > 0,
      reasons,
      days,
      totals: {
        projectCount: summaries.length,
        activeProjectCount,
        threadCount: liveThreads.length,
        userThreadCount: liveThreads.length - automatedThreadCount,
        automatedThreadCount,
        activeThreadCount: liveThreads.filter((t) => !t.automated && t.updatedAtMs >= now - days * DAY_MS).length,
        unassignedThreadCount,
      },
      projects: summaries.slice(0, Math.max(1, limit)),
      unassigned,
    };
  } catch (error) {
    // 读不到 Codex（没装、库被锁、schema 变了）不是 hwb 的致命错误：给前端一个可展示的降级结果。
    reasons.push(`读取 Codex 元数据失败：${error?.message ?? error}`);
    return {
      home,
      dbPath: existsSync(dbFile) ? dbFile : null,
      generatedAt: new Date(now).toISOString(),
      degraded: true,
      reasons,
      days,
      totals: { projectCount: 0, activeProjectCount: 0, threadCount: 0, activeThreadCount: 0, unassignedThreadCount: 0 },
      projects: [],
      unassigned: [],
    };
  }
}

// 跳转目标：项目 → 最近会话；会话 → 自身。返回 null 表示没有可跳转的会话。
export function resolveJumpTarget(snapshot, { projectId, threadId } = {}) {
  if (isThreadId(threadId)) return threadId;
  if (typeof projectId !== 'string' || !projectId) return null;
  const project = snapshot?.projects?.find((p) => p.id === projectId);
  const candidate = project?.lastThread?.id;
  return isThreadId(candidate) ? candidate : null;
}
