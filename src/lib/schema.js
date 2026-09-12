import { deriveSessionStatus } from './status.js';
import { msToIso } from './time.js';

// 每个域**允许**的版本清单（不是「唯一版本」）。依据来自 dsh 自己的域声明，而不是猜：
//   · `session_projcache`：`projectionCacheDomainSpec = { name, version: 5, compatibleVersions: [3, 4],
//     layout: 'per-record', tables: { sessions: checkpointRecord } }`
//     （dsh-session-projection-cache/lib/index.js:86-90）。记录形状在 3/4/5 之间**对 hwb 用到的字段
//     完全一致**：`{ identity: { createdAt, cwd? }, rows: { <key>: { ver, seq, val } } }`
//     （同包 lib/types/spec.d.ts:40-66）；4/5 只多了可选的 lineage 字段（isSeeded/inheritedEventCount），
//     而 hwb 只读 `identity.cwd` / `identity.createdAt` / `rows[*].val`。
//     为什么必须放宽：dsh 认为 3/4/5 都可读（它自己声明 compatible），而 hwb 原先只认 3 ——
//     一旦某个 home 的文件被新版 dsh 标成 4 或 5，hwb 就会把该域判 degraded、**整块停止更新**
//     （「实例看起来空了」那一类，只是这次不是版本未知、而是我们没列出来）。
//   · `workspace`：dsh-workspace 当前写 `version: 2`（lib/index.js:226）—— 与这里一致。
export const SUPPORTED_VERSIONS = {
  workspace: [2],
  projcache: [3, 4, 5],
  modelTier: [2],
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
  if (!SUPPORTED_VERSIONS.workspace.includes(u.version)) {
    return fail(`workspace.json: unsupported version ${u.version} (supported: ${SUPPORTED_VERSIONS.workspace.join('/')})`);
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
  if (!SUPPORTED_VERSIONS.projcache.includes(u.version)) {
    return fail(`session_projcache.json: unsupported version ${u.version} (supported: ${SUPPORTED_VERSIONS.projcache.join('/')})`);
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
      // 投影缓存是**快照**：进程被杀/机器休眠/会话被放弃时，里面那些「进行中」的信号会永远
      // 冻结在那里。不断言新鲜度的话，几周前的会话会一直显示「运行中」（实测真实 home：
      // 179 个会话里 18 个被判 running，全部空闲 7–28 天，0 个在 10 分钟内）。
      lastActivity: meta.lastActivity,
    });
    sessions.push(meta);
  }
  return { ok: true, version: u.version, sessions };
}

export function validateModelTierJson(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return fail('model-tier.json: root must be an object');
  }
  if (!SUPPORTED_VERSIONS.modelTier.includes(data.schema)) {
    return fail(`model-tier.json: unsupported schema ${data.schema} (supported: ${SUPPORTED_VERSIONS.modelTier.join('/')})`);
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
  // 无原型对象：tierId 直接来自文件，而 `tiers['__proto__'] = …` 会走原型 setter ——
  // 那个 tier 会从 Object.entries 里凭空消失（normalize 于是不产出 modelTier 行），
  // 同时返回对象的原型被文件内容控制。
  const tiers = Object.create(null);
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
