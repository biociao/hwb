import { deriveSessionStatus } from './status.js';
import { msToIso } from './time.js';

// 每个域**允许**的版本清单（不是「唯一版本」）。依据来自 dsh 自己的域声明，而不是猜：
//   · `session_projcache`：`projectionCacheDomainSpec = { name, version: 7,
//     compatibleVersions: [3, 4, 5, 6], invalidRecords: 'backup-and-skip', layout: 'per-record',
//     tables: { sessions: checkpointRecord } }`
//     （dsh-session-projection-cache/lib/index.js:89-101，实测 dsh 0.1.5-rc.1）。
//     记录形状在 3–7 之间**对 hwb 用到的字段完全一致**：
//     `{ identity: { createdAt, cwd? }, rows: { <key>: { ver, seq, val } } }`
//     （同包 lib/types/spec.d.ts 的 checkpointRecord 与 checkpointIdentity）。4–7 只多了可选的
//     lineage 字段（formatVersion / isSeeded / inheritedEventCount），而 hwb 只读
//     `identity.cwd` / `identity.createdAt` / `rows[*].val`。
//     为什么必须放宽：dsh 认为 3–7 都可读（它自己声明 compatible），而 hwb 原先只认 3 ——
//     一旦某个 home 的文件被新版 dsh 标成 4/5/6/7，hwb 就会把该域判 degraded、**整块停止更新**
//     （「实例看起来空了」那一类，只是这次不是版本未知、而是我们没列出来）。
//     ⚠️ **不要手抄**：tests/compat/dsh-compat.test.js 会从**实际安装的 dsh** 里提取这份清单
//     并逐条比对，dsh 一升级就报出「缺哪个版本」。升级 dsh 后先跑 `npm run test:compat`，
//     再按它的提示改这里。
//   · `workspace`：dsh-workspace 当前写 `version: 2`（lib/index.js:248-260，实测 0.1.5-rc.1）
//     —— 与这里一致；且 dsh 未声明 compatibleVersions（single 布局是硬校验，版本不符直接抛）。
export const SUPPORTED_VERSIONS = {
  workspace: [2],
  projcache: [3, 4, 5, 6, 7],
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

/**
 * 把「一条 projcache 记录」(`{ identity, rows }`) 折成 hwb 的会话 meta。
 *
 * **两种磁盘布局共用这一处**：聚合文件里 `tables.sessions[id]` 的值、per-record 文件里
 * `record` 字段的值，形状**完全一致**（dsh 的 checkpointRecord 是同一个 zod schema）。
 * 抽出来是为了保证两条读取路径永远产出同一组字段 —— 否则「per-record 会话缺 status」
 * 这类分歧会以「有些会话不显示状态」的形式悄悄出现，且只在部分数据上复现。
 */
function projcacheRecordToSession(sessionId, s) {
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
  return meta;
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
    sessions.push(projcacheRecordToSession(sessionId, s));
  }
  return { ok: true, version: u.version, sessions };
}

/**
 * 校验一个 **per-record** projcache 文件，并折成会话 meta。
 *
 * per-record 布局（dsh 的 `layout: 'per-record'`）下每个会话一个文件：
 *   `storages/session_projcache/sessions/<sessionId>.json`
 * 信封与聚合文件**不同** —— 是 `{ version: N, record: { identity, rows } }`
 * （dsh-storage-json 的 `serializeRecord`，无 unit/global/tables）。实测 dsh 0.1.5-rc.1。
 *
 * `fileName` 用于把错误定位回具体文件（读取失败只记日志，不该让整域 degraded）。
 * 会话 id 取 `record.identity` 之外的文件名？—— **不**：文件名可能带 `.bak.<stamp>` 后缀，
 * 而 dsh 的键就是会话 id（含 `session-` 前缀）。这里以**文件名去掉 .json** 为准，
 * 因为 dsh 用会话 id 作为 per-record 的 key（`SAFE_KEY_RE=[a-zA-Z0-9_-]+`，会话 id 恰好合法）；
 * 与聚合路径的 `table` 键语义一致（那里也是会话 id）。
 */
export function validateProjcacheRecord(data, fileName = 'per-record') {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return fail(`${fileName}: root must be an object`);
  }
  const v = data.version;
  if (typeof v !== 'number') {
    return fail(`${fileName}: missing numeric version`);
  }
  if (!SUPPORTED_VERSIONS.projcache.includes(v)) {
    return fail(`${fileName}: unsupported version ${v} (supported: ${SUPPORTED_VERSIONS.projcache.join('/')})`);
  }
  const record = data.record;
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    return fail(`${fileName}: record must be an object`);
  }
  // 会话 id：文件名去 .json。`session-<uuid>.json` / `<uuid>.json` 都是合法形态
  // （实测两种都存在：带 `session-` 前缀的是新版，纯 uuid 来自更早的写法）。
  const base = String(fileName).split('/').pop().replace(/\.json$/, '');
  return { ok: true, version: v, session: projcacheRecordToSession(base, record) };
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
