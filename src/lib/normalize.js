import path from 'node:path';

function projectOf(ws) {
  if (ws?.path) {
    const base = path.basename(ws.path);
    if (base) return base;
  }
  return ws?.title || 'unknown';
}

// HomeSnapshot → IndexedRows[] (§4.4). Pure function, no side effects.
export function normalize(snapshot) {
  const rows = [];
  // projcache sessions don't carry workspaceId — invert workspace.sessionIds.
  const wsBySession = new Map();
  for (const w of snapshot.workspaces) {
    for (const sid of w.sessionIds) wsBySession.set(sid, w);
  }

  rows.push({
    type: 'home',
    homeId: snapshot.homeId,
    homePath: snapshot.homePath,
    generatedAt: snapshot.generatedAt,
    degraded: snapshot.degraded,
  });

  const sessionCountByWs = new Map();
  for (const s of snapshot.sessions) {
    const ws = wsBySession.get(s.sessionId);
    if (ws) sessionCountByWs.set(ws.workspaceId, (sessionCountByWs.get(ws.workspaceId) ?? 0) + 1);
  }

  for (const w of snapshot.workspaces) {
    rows.push({
      type: 'workspace',
      homeId: snapshot.homeId,
      workspaceId: w.workspaceId,
      title: w.title,
      path: w.path,
      project: projectOf(w),
      archived: w.archived,
      sessionCount: sessionCountByWs.get(w.workspaceId) ?? 0,
    });
  }

  for (const s of snapshot.sessions) {
    const ws = wsBySession.get(s.sessionId);
    rows.push({
      type: 'session',
      homeId: snapshot.homeId,
      sessionId: s.sessionId,
      workspaceId: ws?.workspaceId ?? null,
      workspaceTitle: ws?.title ?? null,
      project: ws ? projectOf(ws) : (s.cwd ? path.basename(s.cwd) : 'unknown'),
      title: s.title || null,
      tokenUsage: JSON.stringify(s.tokenUsage),
      contextPressure: s.contextPressure ? JSON.stringify(s.contextPressure) : null,
      status: s.status ? JSON.stringify(s.status) : null,
      lastActivity: s.lastActivity ?? null,
      generatedAt: snapshot.generatedAt,
    });
  }

  for (const p of snapshot.providers) {
    rows.push({
      type: 'provider',
      homeId: snapshot.homeId,
      ref: p.ref,
      provider: p.provider,
    });
  }

  if (snapshot.modelTier) {
    // tiers 全部来自 active scheme（validateModelTierJson 已按 activeId 选出），
    // 因此都标记 active；activeId 是 scheme id，不是 tierId。
    for (const [tierId, t] of Object.entries(snapshot.modelTier.tiers)) {
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
