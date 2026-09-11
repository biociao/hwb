import path from 'node:path';
import { readHome } from '../lib/read-home.js';
import { normalize } from '../lib/normalize.js';
import { readHomeRemote } from './remote-reader.js';

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
    if (l.tokenUsage) row.tokenUsage = JSON.stringify(l.tokenUsage);
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
    });
  }
  return rows;
}

export function indexHome(store, homePath, live = null) {
  const snapshot = readHome(homePath);
  const rows = mergeLiveStatus(normalize(snapshot), live, snapshot);
  store.upsertRows(rows);
  return { snapshot, rows };
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
