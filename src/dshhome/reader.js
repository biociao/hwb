import path from 'node:path';
import { readHome } from '../lib/read-home.js';
import { normalize } from '../lib/normalize.js';
import { readHomeRemote } from './remote-reader.js';

const TOKEN_KEYS = ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];

// 实时用量**按 key 合并**进已有的 tokenUsage，而不是整列替换。
//
// 这条路径写的是 sessions.tokenUsage 这一个 JSON 列（用量面板与派生列 tokInput/… 全都从它算），
// 所以「实时对象里缺哪个键」就等于「把哪个键清零」：实测把文件侧合计 109100 的会话
// （12400/3200/88100/5400）喂给一个只带 {uncachedInputTokens:100, outputTokens:20} 的实时对象后，
// 用量面板变成 120 —— 静默丢掉 99.9%。normalizeLiveTokenUsage 的契约是「认得出来才返回对象」，
// 但**部分**认得出来（少一两个键）同样会返回对象，于是照样整列覆盖。
// 正常情况下下一轮文件索引会把累计值写回来（实测），但 projcache 降级时实时值就是权威 ——
// 那正是这套实时保护存在的场景，错了就永久错了。
// 因此逐个 key 覆盖：实时报了哪个键就更新哪个键，没报的保持投影缓存的值（宁可保守也不清零）。
// 实时对象四个键齐全时（dsh 的常规情形）结果与整列替换完全一致。
function mergeTokenUsage(existing, liveUsage) {
  const patch = {};
  for (const k of TOKEN_KEYS) {
    const v = liveUsage?.[k];
    if (typeof v === 'number' && Number.isFinite(v)) patch[k] = v;
    else if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) patch[k] = Number(v);
  }
  if (Object.keys(patch).length === 0) return existing; // 一个可用计数都没有：不动这一列
  let base = null;
  if (typeof existing === 'string' && existing) {
    try { base = JSON.parse(existing); } catch { base = null; } // 坏 JSON 当成没有基线
  }
  if (!base || typeof base !== 'object' || Array.isArray(base)) base = {};
  return JSON.stringify({ ...base, ...patch });
}

// 实时状态的 status 是**整块**覆盖的（运行中/完成/空闲由实时通道权威判定）。唯一需要
// 「实时没报就保留文件侧」的字段是 `intervention`：它的一条来源是 dsh 的 `userQuestions` 投影，
// 而**旧版 dsh 的 `/api/session/list` 可能根本不带这个 projection**。整块替换的话，那些
// 「文件索引已推导出在等回答、实时行却没这个字段」的会话会每 3s 被清一次标记（在等回答的
// 标记会闪，甚至一直不出现）。
// 判定口径（与 live-status.toLiveRow 约定）：实时 status **自带** `intervention` 键（含显式
// null）就是权威——null 表示「实时确认没有在等」；没有这个键才沿用文件侧的值。
function mergeLiveStatusJson(existing, live) {
  let base = null;
  if (typeof existing === 'string' && existing) {
    try { base = JSON.parse(existing); } catch { base = null; } // 坏 JSON 当成没有基线
  }
  if (!base || typeof base !== 'object' || Array.isArray(base)) return JSON.stringify(live);
  if (Object.hasOwn(live, 'intervention') || !Object.hasOwn(base, 'intervention')) {
    return JSON.stringify({ ...base, ...live });
  }
  const { intervention, ...rest } = base;
  return JSON.stringify({ ...rest, ...live, intervention });
}

// 把「实时状态」合并进 normalize 出来的会话行（两个方向）：
//   1. 覆盖：live 里已有的会话覆盖从（可能冻结的）投影缓存推导出的状态/活跃时间/用量/标题；
//   2. 补插：live 里有、投影缓存里还没有的会话（冻结期间新产生的）补成新的 session 行——
//      否则这些会话永远不会出现在 Recent Sessions / Projects（实时合并的核心目的）。
// 补插行的 project 取「cwd 与该工作区 path 完全相同」的工作区项目名（与 normalize 的第二条
// 回退一致，见 src/lib/normalize.js）；匹配不到才用 basename(cwd)。否则工作区在 dsh 里改名后，
// 这些实时补插的会话会带着旧目录名进来，把同一个项目拆成两张卡。
// workspaceId/workspaceTitle/contextPressure 无从得知，置 null。
// 这是 hwb 读取源的核心扩展：运行中的 dsh 实例优先用实时状态，而不是只吃投影缓存。
export function mergeLiveStatus(rows, live, { homeId, generatedAt }) {
  if (!live || !Array.isArray(live) || live.length === 0) return rows;
  const bySession = new Map(live.filter((l) => l && l.sessionId).map((l) => [l.sessionId, l]));
  const projectByPath = new Map();
  for (const row of rows) {
    if (row.type !== 'workspace' || typeof row.path !== 'string' || !row.path) continue;
    const p = row.path.replace(/\/+$/, '');
    if (p && !projectByPath.has(p)) projectByPath.set(p, row.project);
  }
  const known = new Set();
  for (const row of rows) {
    if (row.type !== 'session') continue;
    known.add(row.sessionId);
    const l = bySession.get(row.sessionId);
    if (!l) continue;
    if (l.status) row.status = mergeLiveStatusJson(row.status, l.status);
    if (l.lastActivity) row.lastActivity = l.lastActivity;
    if (l.tokenUsage) row.tokenUsage = mergeTokenUsage(row.tokenUsage, l.tokenUsage);
    if (l.title) row.title = l.title;
  }
  for (const l of bySession.values()) {
    if (known.has(l.sessionId)) continue;
    const cwd = typeof l.cwd === 'string' ? l.cwd : '';
    const project = cwd ? (projectByPath.get(cwd.replace(/\/+$/, '')) ?? path.basename(cwd)) : 'unknown';
    rows.push({
      type: 'session',
      homeId,
      sessionId: l.sessionId,
      workspaceId: null,
      workspaceTitle: null,
      project,
      title: l.title ?? null,
      tokenUsage: l.tokenUsage ? JSON.stringify(l.tokenUsage) : null,
      contextPressure: null,
      status: l.status ? JSON.stringify(l.status) : null,
      lastActivity: l.lastActivity ?? null,
      generatedAt,
      // 这行只有实时 RPC 支撑：文件索引里还没有它。liveOnly 让 applyLiveStatus 能在
      // 「实时列表变成空」时精确清掉它，而不误伤有文件索引支撑的会话。
      liveOnly: 1,
    });
  }
  return rows;
}

export function indexHome(store, homePath, live = null) {
  const snapshot = readHome(homePath);
  const rows = indexSnapshot(store, homePath, snapshot, live);
  return { snapshot, rows };
}

// 把「读文件」与「按快照落库」拆开，供调用方在两者之间插入别的异步步骤
// （indexer 要在读完文件**之后**才抓实时状态，这样「抓快照 → 落库」这段本该最短的间隔里
//   不再夹着一次完整的文件读取；参见 dshhome/indexer.js 的注释）。
export function readHomeSnapshot(homePath) {
  return readHome(homePath);
}

export function indexSnapshot(store, homePath, snapshot, live = null) {
  const rows = mergeLiveStatus(normalize(snapshot), live, snapshot);
  store.upsertRows(rows);
  return rows;
}

// 远程实例只读索引（§4.6）：经 SSH cat 元数据 → buildSnapshot → normalize → 入库。
export async function indexRemoteHome(store, home, exec, live = null) {
  const snapshot = await readHomeRemote(home, exec);
  // SSH 可能很慢；完成后再取实时状态，避免旧响应覆盖期间的新状态。
  if (typeof live === 'function') {
    try { live = await live(); } catch { live = null; }
  }
  const rows = mergeLiveStatus(normalize(snapshot), live, snapshot);
  store.upsertRows(rows);
  return { snapshot, rows };
}
