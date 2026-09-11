import { deriveSessionStatus } from './status.js';
import { msToIso } from './time.js';

export const SUPPORTED_VERSIONS = {
  workspace: 2,
  projcache: 3,
  modelTier: 2,
};

const fail = (error) => ({ ok: false, error });

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

// msToIso：毫秒时间戳 → ISO，越界降级为 null。实现在 lib/time.js —— dsh 元数据里的时间戳
// 可能「有限但超出日期范围」（如单位写错成纳秒得到 1e300），直接 toISOString 会抛 RangeError
// 并把整个 projcache 域拖成 degraded（该实例会话在仪表盘上凭空消失）。

// dsh storage files carry a unit envelope: { unit: { name, version }, global, tables }.
// We validate unit.version per domain, not the whole file shape (§4.3).
function unitVersion(data, file) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { error: `${file}: root must be an object` };
  }
  const v = data.unit?.version;
  if (typeof v !== 'number') {
    return { error: `${file}: missing numeric unit.version` };
  }
  return { version: v };
}

export function validateWorkspaceJson(data) {
  const u = unitVersion(data, 'workspace.json');
  if (u.error) return fail(u.error);
  if (u.version !== SUPPORTED_VERSIONS.workspace) {
    return fail(`workspace.json: unsupported version ${u.version} (supported: ${SUPPORTED_VERSIONS.workspace})`);
  }
  const table = data.tables?.workspaces;
  if (table === null || typeof table !== 'object' || Array.isArray(table)) {
    return fail('workspace.json: tables.workspaces must be an object map');
  }
  const activeIds = Array.isArray(data.global?.workspaceIds) ? data.global.workspaceIds : null;
  const workspaces = [];
  for (const [workspaceId, w] of Object.entries(table)) {
    if (!w || typeof w !== 'object') continue;
    workspaces.push({
      workspaceId,
      title: typeof w.title === 'string' ? w.title : '',
      path: typeof w.path === 'string' ? w.path : '',
      archived: activeIds ? !activeIds.includes(workspaceId) : false,
      sessionIds: Array.isArray(w.sessionIds) ? w.sessionIds.map(String) : [],
      createdAt: msToIso(w.createdAt),
      updatedAt: msToIso(w.updatedAt),
    });
  }
  return { ok: true, version: u.version, workspaces };
}

export function validateProjcacheJson(data) {
  const u = unitVersion(data, 'session_projcache.json');
  if (u.error) return fail(u.error);
  if (u.version !== SUPPORTED_VERSIONS.projcache) {
    return fail(`session_projcache.json: unsupported version ${u.version} (supported: ${SUPPORTED_VERSIONS.projcache})`);
  }
  const table = data.tables?.sessions;
  if (table === null || typeof table !== 'object' || Array.isArray(table)) {
    return fail('session_projcache.json: tables.sessions must be an object map');
  }
  const sessions = [];
  for (const [sessionId, s] of Object.entries(table)) {
    if (!s || typeof s !== 'object') continue;
    const rows = s.rows ?? {};
    const totals = rows.tokenUsage?.val?.totals ?? {};
    const cp = rows.contextPressure?.val;
    const meta = {
      sessionId,
      cwd: typeof s.identity?.cwd === 'string' ? s.identity.cwd : '',
      title: typeof rows.title?.val === 'string' ? rows.title.val : '',
      tokenUsage: {
        uncachedInputTokens: num(totals.uncachedInputTokens),
        outputTokens: num(totals.outputTokens),
        cacheReadTokens: num(totals.cacheReadTokens),
        cacheWriteTokens: num(totals.cacheWriteTokens),
      },
      lastActivity: msToIso(rows.sessionListMetadata?.val?.lastPromptAt) ?? msToIso(s.identity?.createdAt),
    };
    if (cp && typeof cp === 'object') {
      meta.contextPressure = {
        pressureTokens: num(cp.pressureTokens),
        projectedTokens: num(cp.projectedTokens),
        contextWindow: num(cp.contextWindow),
      };
    }
    // 折叠状态类投影 → 会话工作状态（running / completed / idle）。
    meta.status = deriveSessionStatus({
      sessionStats: rows.sessionStats?.val,
      goal: rows.goal?.val,
      todos: rows.todos?.val,
      subagent: rows.subagent?.val,
      plan: rows.plan?.val,
      permissions: rows.permissions?.val,
    });
    sessions.push(meta);
  }
  return { ok: true, version: u.version, sessions };
}

export function validateModelTierJson(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return fail('model-tier.json: root must be an object');
  }
  if (data.schema !== SUPPORTED_VERSIONS.modelTier) {
    return fail(`model-tier.json: unsupported schema ${data.schema} (supported: ${SUPPORTED_VERSIONS.modelTier})`);
  }
  if (typeof data.activeId !== 'string' || data.activeId === '') {
    return fail('model-tier.json: missing activeId');
  }
  if (!Array.isArray(data.schemes)) {
    return fail('model-tier.json: schemes must be an array');
  }
  const active = data.schemes.find((s) => s && s.id === data.activeId);
  if (!active || active.tiers === null || typeof active.tiers !== 'object') {
    return fail(`model-tier.json: active scheme ${data.activeId} has no tiers`);
  }
  const tiers = {};
  for (const [tierId, t] of Object.entries(active.tiers)) {
    if (!t || typeof t !== 'object') continue;
    tiers[tierId] = {
      provider: typeof t.provider === 'string' ? t.provider : '',
      model: typeof t.model === 'string' ? t.model : '',
    };
  }
  return { ok: true, modelTier: { activeId: data.activeId, tiers } };
}

export function validateCredentials(providers) {
  if (!Array.isArray(providers)) {
    return fail('credentials: providers must be an array');
  }
  for (const p of providers) {
    if (!p || typeof p.ref !== 'string' || typeof p.provider !== 'string') {
      return fail('credentials: provider entry must have { ref, provider }');
    }
  }
  return { ok: true, providers };
}
