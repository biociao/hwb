import path from 'node:path';

function projectOf(ws) {
  // path 可能不是字符串（外部/未来版本的文件内容），path.basename 会抛 TypeError。
  // normalize 是导出函数，一次抛错 = 整个 home 的索引失败，所以这里逐字段兜底。
  if (typeof ws?.path === 'string' && ws.path) {
    const base = path.basename(ws.path);
    if (base) return base;
  }
  return (typeof ws?.title === 'string' && ws.title) || 'unknown';
}

const asArray = (v) => (Array.isArray(v) ? v : []);

// node:sqlite 绑 TEXT 时按 C 字符串处理：**值里的 U+0000 会把后面全部截掉**且不报错。
// 实测（审查）：`run('A\u0000B')` 读回 `'A'`，`run('\u0000leading')` 读回 `''`。
// 也就是说外部 dsh home 的 title/cwd/path 里一旦有 NUL，入库时会被静默截断
// （无日志、无 degraded、界面上看不出少了什么）。这里在**产出侧**统一剥掉 NUL ——
// 比在 store 的每个绑定点上处理更集中，也顺带覆盖实时通道（live-status 的 toLiveRow 同样用它）。
// JSON 列不受影响（JSON.stringify 会把 NUL 转义成 \u0000 文本），所以只处理纯文本字段。
export const stripNul = (v) => (typeof v === 'string' && v.includes('\u0000') ? v.replace(/\u0000/g, '') : v);

// HomeSnapshot → IndexedRows[] (§4.4). Pure function, no side effects.
export function normalize(snapshot) {
  const rows = [];
  // projcache sessions don't carry workspaceId — invert workspace.sessionIds.
  const wsBySession = new Map();
  for (const w of asArray(snapshot.workspaces)) {
    for (const sid of asArray(w?.sessionIds)) wsBySession.set(sid, w);
  }

  rows.push({
    type: 'home',
    homeId: snapshot.homeId,
    homePath: snapshot.homePath,
    generatedAt: snapshot.generatedAt,
    degraded: snapshot.degraded,
  });

  const sessionCountByWs = new Map();
  for (const s of asArray(snapshot.sessions)) {
    const ws = wsBySession.get(s.sessionId);
    if (ws) sessionCountByWs.set(ws.workspaceId, (sessionCountByWs.get(ws.workspaceId) ?? 0) + 1);
  }

  for (const w of asArray(snapshot.workspaces)) {
    rows.push({
      type: 'workspace',
      homeId: snapshot.homeId,
      workspaceId: w.workspaceId,
      title: stripNul(w.title),
      path: stripNul(w.path),
      project: projectOf(w),
      archived: w.archived,
      sessionCount: sessionCountByWs.get(w.workspaceId) ?? 0,
    });
  }

  for (const s of asArray(snapshot.sessions)) {
    const ws = wsBySession.get(s.sessionId);
    rows.push({
      type: 'session',
      homeId: snapshot.homeId,
      sessionId: s.sessionId,
      workspaceId: ws?.workspaceId ?? null,
      workspaceTitle: stripNul(ws?.title ?? null),
      project: stripNul(ws ? projectOf(ws) : (typeof s.cwd === 'string' && s.cwd ? path.basename(s.cwd) : 'unknown')),
      title: stripNul(s.title || null),
      tokenUsage: JSON.stringify(s.tokenUsage),
      contextPressure: s.contextPressure ? JSON.stringify(s.contextPressure) : null,
      status: s.status ? JSON.stringify(s.status) : null,
      lastActivity: s.lastActivity ?? null,
      generatedAt: snapshot.generatedAt,
    });
  }

  for (const p of asArray(snapshot.providers)) {
    rows.push({
      type: 'provider',
      homeId: snapshot.homeId,
      ref: stripNul(p.ref),
      provider: p.provider,
    });
  }

  if (snapshot.modelTier) {
    // tiers 全部来自 active scheme（validateModelTierJson 已按 activeId 选出），
    // 因此都标记 active；activeId 是 scheme id，不是 tierId。
    for (const [tierId, t] of Object.entries(snapshot.modelTier.tiers ?? {})) {
      if (!t || typeof t !== 'object') continue;
      rows.push({
        type: 'modelTier',
        homeId: snapshot.homeId,
        tierId,
        active: true,
        provider: t.provider,
        model: t.model,
      });
    }
  }

  return rows;
}
