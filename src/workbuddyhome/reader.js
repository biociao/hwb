import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

// WorkBuddy（桌面端）的本地元数据读取器。
//
// 与 src/codexhome、src/dshhome 同一条边界：**只读元数据，不读会话正文，不写库**。
// WorkBuddy 的元数据集中在一个 SQLite 库：
//   · `sessions`     —— 会话（标题 / cwd / 状态 / 时间 / 模型 / 项目归属）★ 只取元数据列
//   · `workspaces`   —— 用户打开过的项目目录（path, last_opened_at）
//   · `session_usage`—— 上下文用量（used/size）。口径是「上下文占用」而不是 input/output，
//                       本期不伪装成 token 拆分（契约 §6），只作为原始值随会话带出。
//
// 为什么要从落盘的 SQLite 读、而不是问 WorkBuddy 自己：hwb 不能在 WorkBuddy 未运行时丢掉历史，
// 也不该依赖它的进程/私有 RPC。库是它自己写下的稳定投影，只读打开即可。
//
// 所有解析都按「可降级」写：库缺失 / 损坏 / schema 变化只降级到 reasons，不抛给调用方。

const TITLE_MAX = 120;
// 索引口径是全量：会话数会随使用增长（实测本机 124 条），留足余量但挡住异常大的库。
const DEFAULT_LIMIT = 5000;
const MAX_LIMIT = 20_000;

export function workbuddyHomePath(env = process.env) {
  const custom = typeof env.WORKBUDDY_HOME === 'string' ? env.WORKBUDDY_HOME.trim() : '';
  return custom ? path.resolve(custom) : path.join(homedir(), '.workbuddy');
}

// WorkBuddy 的哨兵文件只有一个：workbuddy.db。目录存在但库还没建（刚安装、从未使用）
// 也算「像 WorkBuddy home」的前半部分 —— 这里与 /api/homes/detect 保持同一口径。
export function workbuddyHomeInfo(homePath) {
  const target = typeof homePath === 'string' && homePath ? homePath : workbuddyHomePath();
  let exists = false;
  try {
    exists = existsSync(target) && statSync(target).isDirectory();
  } catch {
    exists = false;
  }
  return {
    path: target,
    exists,
    looksLikeWorkbuddy: exists && existsSync(path.join(target, 'workbuddy.db')),
  };
}

function asString(value) {
  return typeof value === 'string' ? value : '';
}

// 标题清洗：自定义标题优先（用户改过名），否则用自动标题。控制字符/换行会撑坏列表，
// 统一压成单行；超长标题截断（完整内容不在这里读，否则等于读会话正文）。
export function cleanWorkbuddyTitle(raw, fallback = '未命名会话') {
  const text = asString(raw)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return fallback;
  return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX - 1)}…` : text;
}

// WorkBuddy 的时间列是毫秒（实测本机 last_activity_at / updated_at / created_at 都是 13 位）。
// 仍然按数量级做一次防御：旧版本若写秒级时间戳，直接当毫秒会得到 1970 年，前端会渲染成噪声。
function toEpochMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e11 ? n * 1000 : n;
}

function isoOf(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  if (date.getUTCFullYear() < 2000 || date.getUTCFullYear() > 2100) return null;
  return date.toISOString();
}

// 只读打开 WorkBuddy 的 WAL 库。两条路（与 src/codexhome/reader.js 的 withThreadsDb 同因同果）：
//   1. 普通 readOnly —— WorkBuddy 在跑时 `-wal`/`-shm` 都在，一致性最好；
//   2. WorkBuddy 退出后 WAL 文件可能被 checkpoint/删除，此时只读连接要么打不开（无法创建
//      `-shm`），要么「打开成功但第一条查询就报 attempt to write a readonly database」
//      （WAL 恢复需要写）。这个状态下没有写者，用 `immutable=1` 读主文件快照是安全的；
//      它绕过锁与 WAL，而「无写者」正是走这条分支的前提。
//
// 所以降级判据必须是「**完整读一遍**失败」而不只是「open() 失败」—— 实测后者会漏掉第二种形态。
function withWorkbuddyDb(dbFile, read) {
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

function loadWorkspaces(db) {
  // workspaces 只有两列（WorkBuddy 自己也拿 path 当 workspace id）。没有任何删除标记：
  // 「没被打开过」不等于「不存在」，全量返回，由 index-rows 决定是否建 workspace 行。
  const rows = db.prepare('SELECT path, last_opened_at FROM workspaces').all();
  return rows
    .filter((row) => typeof row.path === 'string' && row.path.trim())
    .map((row) => ({
      path: row.path,
      lastOpenedAt: isoOf(toEpochMs(row.last_opened_at)),
    }))
    .sort((a, b) => {
      const at = a.lastOpenedAt ? Date.parse(a.lastOpenedAt) : 0;
      const bt = b.lastOpenedAt ? Date.parse(b.lastOpenedAt) : 0;
      return bt - at;
    });
}

function loadUsage(db) {
  // session_usage 是**上下文用量**（used/size），不是 input/output token。这里只把原始值带出去，
  // 不在 reader 层做语义猜测（契约 §6：tokenUsage/contextPressure 本期留 null）。
  const rows = db.prepare('SELECT session_id, used, size FROM session_usage').all();
  const bySession = new Map();
  for (const row of rows) {
    if (typeof row.session_id !== 'string') continue;
    const used = Number(row.used);
    const size = Number(row.size);
    bySession.set(row.session_id, {
      used: Number.isFinite(used) && used >= 0 ? used : null,
      size: Number.isFinite(size) && size > 0 ? size : null,
    });
  }
  return bySession;
}

function loadSessions(db, limit) {
  // deleted_at IS NULL：软删除的会话不进工作台（与 WorkBuddy 自己的列表口径一致）。
  // 排序：last_activity_at 优先、回退 updated_at —— session_usage 的更新、后台任务等
  // 都可能只动其中一个，单看一个会把最近会话排错。
  const stmt = db.prepare(`
    SELECT id, cwd, title, custom_title, status, created_at, updated_at,
           last_activity_at, model, project_id
    FROM sessions
    WHERE deleted_at IS NULL
    ORDER BY COALESCE(NULLIF(last_activity_at, 0), updated_at, created_at, 0) DESC
    LIMIT ?
  `);
  return stmt.all(limit).map((row) => {
    const lastActivityMs = toEpochMs(row.last_activity_at);
    const updatedAtMs = lastActivityMs || toEpochMs(row.updated_at) || toEpochMs(row.created_at);
    return {
      id: String(row.id),
      title: cleanWorkbuddyTitle(row.custom_title || row.title),
      cwd: asString(row.cwd) || null,
      // 原始状态保留（completed/Completed/terminated/error/failed…），语义映射在 index-rows 里做：
      // reader 不替上层决定「什么算完成」。
      status: asString(row.status).trim() || null,
      updatedAt: isoOf(updatedAtMs),
      updatedAtMs,
      model: asString(row.model) || null,
      projectId: asString(row.project_id) || null,
    };
  });
}

/**
 * 读取 WorkBuddy 的本地元数据快照（只读）。
 *
 * @param {object} [options]
 * @param {string|object} [options.home] WORKBUDDY_HOME（默认环境变量 / ~/.workbuddy）；
 *        也接受 home 行对象（取 homePath），便于 LOCAL_TOOL_SOURCES 统一转发。
 * @param {number} [options.limit] 返回会话数上限，默认 5000
 * @param {number} [options.now] 当前时间（毫秒），测试注入
 */
export function readWorkbuddySnapshot({ home = workbuddyHomePath(), limit = DEFAULT_LIMIT, now = Date.now() } = {}) {
  const homePath = typeof home === 'string' ? path.resolve(home) : (home?.homePath ? path.resolve(home.homePath) : workbuddyHomePath());
  const dbFile = path.join(homePath, 'workbuddy.db');
  const reasons = [];

  if (!existsSync(homePath)) reasons.push(`未找到 WorkBuddy home：${homePath}`);
  if (!existsSync(dbFile)) reasons.push(`未找到 ${path.basename(dbFile)}（会话列表降级）`);

  let workspaces = [];
  let sessions = [];
  try {
    if (existsSync(dbFile)) {
      const safeLimit = Math.max(1, Math.min(MAX_LIMIT, Number.isFinite(Number(limit)) ? Number(limit) : DEFAULT_LIMIT));
      const metadata = withWorkbuddyDb(dbFile, (db) => {
        // 三张表一次读全：任一张缺失/损坏都视为该库不可用（与 codex 的 all-or-nothing 一致），
        // 由 immutable 回退再试一次，最后才降级。
        const usage = loadUsage(db);
        const sessionRows = loadSessions(db, safeLimit).map((session) => ({
          ...session,
          usage: usage.get(session.id) ?? null,
        }));
        // 版本号不在库里（读 startup-seed-version.json 是 src/lib/tool-version.js 的职责），
        // reader 只负责元数据。
        return { workspaces: loadWorkspaces(db), sessions: sessionRows };
      });
      workspaces = metadata.workspaces;
      sessions = metadata.sessions;
    }
  } catch (error) {
    reasons.push(`读取 WorkBuddy 元数据失败：${error?.message ?? error}`);
    workspaces = [];
    sessions = [];
  }

  return {
    home: homePath,
    dbPath: existsSync(dbFile) ? dbFile : null,
    generatedAt: new Date(now).toISOString(),
    degraded: reasons.length > 0,
    reasons,
    workspaces,
    sessions,
    totals: {
      workspaceCount: workspaces.length,
      sessionCount: sessions.length,
    },
  };
}
