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

// 把「实时状态」合并进 normalize 出来的会话行（两个方向）：
//   1. 覆盖：live 里已有的会话覆盖从（可能冻结的）投影缓存推导出的状态/活跃时间/用量/标题；
//   2. 补插：live 里有、投影缓存里还没有的会话（冻结期间新产生的）补成新的 session 行——
//      否则这些会话永远不会出现在 Recent Sessions / Projects（实时合并的核心目的）。
// 补插行的 project 用 basename(cwd) 推导（与 normalize 的无 workspace 会话 fallback 一致）；
// workspaceId/workspaceTitle/contextPressure 无从得知，置 null。
// 这是 hwb 读取源的核心扩展：运行中的 dsh 实例优先用实时状态，而不是只吃投影缓存。
export function mergeLiveStatus(rows, live, { homeId, generatedAt }) {
  if (!live || !Array.isArray(live) || live.length === 0) return rows;
  const bySession = new Map(live.filter((l) => l && l.sessionId).map((l) => [l.sessionId, l]));
  const known = new Set();
  for (const row of rows) {
    if (row.type !== 'session') continue;
    known.add(row.sessionId);
    const l = bySession.get(row.sessionId);
    if (!l) continue;
    if (l.status) row.status = JSON.stringify(l.status);
    if (l.lastActivity) row.lastActivity = l.lastActivity;
    if (l.tokenUsage) row.tokenUsage = mergeTokenUsage(row.tokenUsage, l.tokenUsage);
    if (l.title) row.title = l.title;
  }
  for (const l of bySession.values()) {
    if (known.has(l.sessionId)) continue;
    rows.push({
      type: 'session',
      homeId,
      sessionId: l.sessionId,
      workspaceId: null,
      workspaceTitle: null,
      project: l.cwd ? path.basename(l.cwd) : 'unknown',
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
