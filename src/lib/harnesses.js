import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { codexIndexRows } from '../codexhome/index-rows.js';
import { workbuddyIndexRows } from '../workbuddyhome/index-rows.js';

// 本地工具（local tool）描述符的唯一来源（契约 §2/§5）。
//
// 「本地工具实例」= 只读本地元数据、没有进程 / 端口 / token / 隧道的实例。当前集合：
//   codex（~/.codex）、workbuddy（~/.workbuddy），以及 dsh 的只读实例（readOnly:true，
//   home 里带进程的是「连接型 dsh」，不属于这里）。
//
// 这个文件是**纯模块**：静态依赖只有 node:fs/os/path 与两个纯函数 index-rows 模块，
// 静态图里绝不能出现 node:sqlite —— src/server.js 的 `enforceNodeVersion()` 在模块体里执行，
// 而 monitor/routes 是被它静态 import 的；一旦这里静态引入 codexhome/reader.js 或
// workbuddyhome/reader.js（两者都 import 'node:sqlite'），Node < 22.5 会先炸在与根因
// 无关的 ERR_UNKNOWN_BUILTIN_MODULE 上（与 dshhome/store.js 被改成动态 import 的原因相同）。
//
// 因此：reader/open 这类会碰 SQLite 的实现一律在**函数内部** dynamic import，
// 且这些方法是 async（readSnapshot / resolveTarget / open）；indexRows 是同步纯函数。

export const LOCAL_TOOL_HARNESSES = Object.freeze(['codex', 'workbuddy']);

// 判定的唯二入口之一（另一端在前端 src/web/store.js）。只允许在这里写 harness 组合条件。
export function isLocalToolHome(home) {
  const harness = asHarness(home);
  if (LOCAL_TOOL_HARNESSES.includes(harness)) return true;
  return harness === 'dsh' && home?.readOnly === true;
}

// 卡片/按钮文案：Codex / WorkBuddy / dsh。
// dsh 用小写：契约 §4.1 的 runtime.toolLabel 明确写 'dsh'，§2 的 chip 文本也是
// `dsh 0.2.0-rc.2`（§5 散文里的 DSH 按小写实现，已报 lead）。
export function localToolLabel(home) {
  const harness = asHarness(home);
  if (harness === 'codex') return 'Codex';
  if (harness === 'workbuddy') return 'WorkBuddy';
  if (harness === 'dsh' && home?.readOnly === true) return 'dsh';
  return null;
}

// 默认 home 与「与 reader 同口径」的重复实现说明：
// reader 模块静态 import node:sqlite，不能在纯模块的静态图里出现；这两个函数只有 5 行，
// 在 tests/harnesses.test.js 里与 reader 的 homePath 对拍，防止口径漂移。
function codexDefaultHome(env = process.env) {
  const custom = typeof env.CODEX_HOME === 'string' ? env.CODEX_HOME.trim() : '';
  return custom ? path.resolve(custom) : path.join(homedir(), '.codex');
}

function workbuddyDefaultHome(env = process.env) {
  const custom = typeof env.WORKBUDDY_HOME === 'string' ? env.WORKBUDDY_HOME.trim() : '';
  return custom ? path.resolve(custom) : path.join(homedir(), '.workbuddy');
}

export function localToolDefaultHome(harness) {
  const h = asHarness({ harness });
  if (h === 'codex') return codexDefaultHome();
  if (h === 'workbuddy') return workbuddyDefaultHome();
  // dsh 的默认 home 只供表单占位/提示用；dsh 的探测与注册仍走现有逻辑。
  if (h === 'dsh') return path.join(homedir(), '.dsh');
  return null;
}

export function localToolHomePlaceholder(harness) {
  const h = asHarness({ harness });
  if (h === 'codex') return '~/.codex';
  if (h === 'workbuddy') return '~/.workbuddy';
  if (h === 'dsh') return '~/.dsh';
  return null;
}

// 表单里用户可能填 `~/.workbuddy`：path.resolve('~/.workbuddy') 会变成 `<cwd>/~/.workbuddy`
// （一个永远不存在的目录），所以先单独展开 `~`。
function expandTilde(text) {
  if (text === '~') return homedir();
  if (text.startsWith('~/')) return path.join(homedir(), text.slice(2));
  return text;
}

// 探测口径（契约 §4.4）：codex 认 state_5.sqlite / .codex-global-state.json；
// workbuddy 认 workbuddy.db。字段名保持各自 API 的既有形状：
// codex 的 looksLikeCodexHome 不能改（/api/homes/detect 兼容），workbuddy 用 looksLikeWorkbuddy。
const DETECT = {
  codex: {
    sentinels: ['state_5.sqlite', '.codex-global-state.json'],
    field: 'looksLikeCodexHome',
  },
  workbuddy: {
    sentinels: ['workbuddy.db'],
    field: 'looksLikeWorkbuddy',
  },
};

/**
 * 探测某个本地工具的 home。
 *
 * @param {string} harness 'codex' | 'workbuddy'
 * @param {string} [homePath] 用户填的路径；缺省用 localToolDefaultHome(harness)。
 *        GET /api/homes/detect 用默认 home，POST/PUT /api/homes 用用户路径。
 * @returns {{path:string, exists:boolean, looksLikeCodexHome?:boolean, looksLikeWorkbuddy?:boolean}|null}
 */
export function detectLocalTool(harness, homePath = localToolDefaultHome(harness)) {
  const h = asHarness({ harness });
  const spec = DETECT[h];
  if (!spec) return null;
  const fallback = localToolDefaultHome(h);
  const target = typeof homePath === 'string' && homePath.trim()
    ? path.resolve(expandTilde(homePath.trim()))
    : fallback;
  let exists = false;
  try {
    exists = Boolean(target) && existsSync(target) && statSync(target).isDirectory();
  } catch {
    exists = false;
  }
  const looksLike = exists && spec.sentinels.some((sentinel) => existsSync(path.join(target, sentinel)));
  return { path: target, exists, [spec.field]: looksLike };
}

function asHarness(value) {
  if (typeof value === 'string') return value.trim().toLowerCase();
  return typeof value?.harness === 'string' ? value.harness.trim().toLowerCase() : '';
}

function homePathOf(home) {
  if (typeof home === 'string') {
    const text = home.trim();
    return text ? path.resolve(expandTilde(text)) : null;
  }
  const raw = home?.homePath ?? home?.home;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  return path.resolve(expandTilde(raw.trim()));
}

// —— 数据面：LOCAL_TOOL_SOURCES ——（供 indexer / routes / server 使用）
//
// 形状（契约 §5）：
//   { harness: { label, readSnapshot({home,...}), indexRows(home, snapshot),
//                resolveTarget(home, {sessionId, projectId}), open(sessionId, opts?) } }
// 同步性：readSnapshot / resolveTarget / open 为 async（内部 dynamic import 读 SQLite 的模块）；
// indexRows 为同步纯函数。故意不做成工厂：server/routes/indexer 直接 import 本对象即可。

// Codex 的快照读取默认按**全量索引**口径（与 indexer 原来的 #indexCodexHome 完全一致），
// 而不是 readCodexProjects 的展示默认值（limit 30 / 7 天）—— 少了这些参数会把索引截断成
// 「最近 30 个项目、每个 5 条会话」。
const CODEX_INDEX_OPTIONS = Object.freeze({
  days: 3650,
  limit: 1000,
  threadsPerProject: 100_000,
  maxThreads: 20_000,
});

const WORKBUDDY_MAX_SESSIONS = 20_000;

function latestCodexSessionId(snapshot) {
  // 「该实例最近一条会话」= 各项目最近用户会话 + 未归属会话里最近的一条。
  // resolveJumpTarget 只处理 projectId，这里补上「无 projectId 时落到最近一条会话」。
  let best = null;
  const consider = (thread) => {
    if (!thread?.id) return;
    const ts = Number(thread.updatedAtMs) > 0 ? Number(thread.updatedAtMs) : (Date.parse(thread.updatedAt ?? '') || 0);
    if (!best || ts > best.ts) best = { id: thread.id, ts };
  };
  for (const project of snapshot?.projects ?? []) consider(project?.lastThread);
  // unassigned 已按最近活跃降序（readCodexProjects 过滤 threads 的顺序），第一条即最近。
  if (Array.isArray(snapshot?.unassigned) && snapshot.unassigned.length) consider(snapshot.unassigned[0]);
  // 只回可安全拼进深链的 UUID；脏 id 宁可不跳转。
  if (!best) return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(best.id) ? best.id : null;
}

const codexSource = {
  label: 'Codex',

  readSnapshot: async (options = {}) => {
    const { home, ...rest } = options ?? {};
    const { readCodexProjects } = await import('../codexhome/reader.js');
    return readCodexProjects({
      ...CODEX_INDEX_OPTIONS,
      ...rest,
      home: homePathOf(home) ?? codexDefaultHome(),
    });
  },

  // 同步纯函数：indexer 落库路径不需要 await。
  indexRows: (home, snapshot) => {
    return codexIndexRows(home, snapshot);
  },

  resolveTarget: async (home, { sessionId, projectId } = {}) => {
    const { readCodexProjects, resolveJumpTarget, isThreadId } = await import('../codexhome/reader.js');
    if (typeof sessionId === 'string' && sessionId.trim()) {
      const id = sessionId.trim();
      // 非法 id 抛错：调用方（POST /api/harness/open）必须回 400 —— 无鉴权本机接口
      // 不能变成任意深链派发器。
      if (!isThreadId(id)) throw new Error('无效的 Codex 会话 id');
      return id;
    }
    const snapshot = readCodexProjects({
      ...CODEX_INDEX_OPTIONS,
      threadsPerProject: 1,
      home: homePathOf(home) ?? codexDefaultHome(),
    });
    if (typeof projectId === 'string' && projectId.trim()) {
      return resolveJumpTarget(snapshot, { projectId: projectId.trim() }) ?? null;
    }
    return latestCodexSessionId(snapshot);
  },

  open: async (sessionId, options = {}) => {
    const { openCodexThread } = await import('../codexhome/open.js');
    const result = await openCodexThread(sessionId, options ?? {});
    // 归一成与 workbuddy 一致的形状（sessionId 而不是 threadId），路由只需处理一种结果。
    return {
      ok: result.ok,
      sessionId: result.threadId ?? String(sessionId),
      url: result.url,
      ...(result.fallback ? { fallback: result.fallback } : {}),
      ...(result.error ? { error: result.error } : {}),
    };
  },
};

const workbuddySource = {
  label: 'WorkBuddy',

  readSnapshot: async (options = {}) => {
    const { home, ...rest } = options ?? {};
    const { readWorkbuddySnapshot } = await import('../workbuddyhome/reader.js');
    return readWorkbuddySnapshot({
      limit: WORKBUDDY_MAX_SESSIONS,
      ...rest,
      home: homePathOf(home) ?? workbuddyDefaultHome(),
    });
  },

  indexRows: (home, snapshot) => {
    return workbuddyIndexRows(home, snapshot);
  },

  resolveTarget: async (home, { sessionId, projectId } = {}) => {
    const { isWorkbuddySessionId, resolveWorkbuddyTarget } = await import('../workbuddyhome/open.js');
    if (typeof sessionId === 'string' && sessionId.trim()) {
      const id = sessionId.trim();
      if (!isWorkbuddySessionId(id)) throw new Error('无效的 WorkBuddy 会话 id');
      return id;
    }
    const { readWorkbuddySnapshot } = await import('../workbuddyhome/reader.js');
    const snapshot = readWorkbuddySnapshot({
      limit: WORKBUDDY_MAX_SESSIONS,
      home: homePathOf(home) ?? workbuddyDefaultHome(),
    });
    if (typeof projectId === 'string' && projectId.trim()) {
      return resolveWorkbuddyTarget(snapshot, { projectId: projectId.trim() }) ?? null;
    }
    return resolveWorkbuddyTarget(snapshot, {}) ?? null;
  },

  open: async (sessionId, options = {}) => {
    const { openWorkbuddyConversation } = await import('../workbuddyhome/open.js');
    return openWorkbuddyConversation(sessionId, options ?? {});
  },
};

// 描述符表：codex / workbuddy。dsh 只读**不在这里**（routes 单独处理：它走插件/聚焦桌面端，
// 不是深链；契约 §2/§4.2）。
export const LOCAL_TOOL_SOURCES = Object.freeze({
  codex: Object.freeze(codexSource),
  workbuddy: Object.freeze(workbuddySource),
});
