import { logger } from '../lib/logger.js';
import { msToIso } from '../lib/time.js';
import { normalizeApproval } from '../lib/status.js';
import { stripNul } from '../lib/normalize.js';

const log = logger('live-status');

// 实时状态读取器 —— 让 hwb 的「会话状态」不再只依赖可能冻结的投影缓存，
// 而是直接读「运行中的 dsh 实例」的实时状态。
//
// 传输机制（与 dsh web 的 browser channel 同构，见 dsh-client-connection）：
//   · dsh 把实时会话/投影状态暴露在 `/api` 共享 RPC channel（HTTP POST），
//     信封为 { type: 'client-request', rpcId, method, payload } →
//     响应 { type: 'server-response', rpcId, result }。
//   · 鉴权：`?token=<launchToken>` 首次请求 303 并 Set-Cookie，之后带 cookie
//     请求后续端点。hwb 复用与 launcher.authFetch 相同的 token→cookie 交接思路。
//
// 读取结果以「原始投影值」返回（sessionStats / goal / todos / subagent / plan / permissions /
// sessionListMetadata / tokenUsage），由调用方用 hwb 自己的 deriveSessionStatus 推导状态，
// 从而与投影缓存走同一套状态逻辑，但数据源是实时的。
//
// 安全设计：任何一步失败（实例不可达 / token 无效 / 端点不存在 / 解析失败）都返回 null，
// 调用方回退到投影缓存推导的状态，绝不让实时读取代价影响主链路。

const RPC_TIMEOUT_MS = 4000;

// 从带 `?token=` 的 URL 拆出 origin 与 token。兼容 `http://host:port/?token=x` 与裸 origin。
function splitAuthUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return { origin: url, token: null };
  }
  const token = u.searchParams.get('token') ?? null;
  u.searchParams.delete('token');
  return { origin: u.origin, token };
}

// token→cookie 交接：GET `origin/?token=<t>`（manual redirect），
// 成功(303)时带回 set-cookie 供后续 RPC 使用。返回 cookie 的 `name=value` 片段。
async function acquireCookie(origin, token, timeoutMs) {
  const authUrl = token ? `${origin}/?token=${encodeURIComponent(token)}` : origin;
  let first;
  try {
    first = await fetch(authUrl, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    return { __error: error.name === 'TimeoutError' ? 'auth timeout' : 'auth fetch failed' }; // 实例不可达：显式失败标记，调用方回退
  }
  // 无 token 栅栏（旧版 dsh / 直接放行）→ 无需 cookie。
  if (first.status === 303) {
    return first.headers.get('set-cookie')?.split(';')[0] ?? '';
  }
  if (first.status === 401 || first.status === 403) {
    // launch token 无效/过期：实例被外部重启后 hwb 持有的旧 token 会落到这里。
    // 明确返回 null 哨兵，让调用方回退，并把问题留到日志层提示。
    return { __error: `auth http ${first.status}` };
  }
  if (!first.ok) return { __error: `auth http ${first.status}` };
  return first.headers.get('set-cookie')?.split(';')[0] ?? '';
}

// 实时 RPC 响应的上限。与文件侧（read-home 的 64 MiB 元数据上限、remote-reader 的 32 MiB stdout）
// 同类：这条通道同样服务**远程**实例（服务器侧的隧道 URL），对面完全可以是外来的 dsh，
// 所以「响应用户可控的大对象」这种情况必须有上限。
// 审查实测（假 dsh 用复用的 1 MiB buffer 分块推送 200 MiB）：原先 `res.json()` 照单全收 ——
// 读入侧 RSS +844 MiB、耗时 195ms，200 MiB 的「标题」还会原样落进 sessions.title 发给浏览器。
// 只受 4s 的 AbortSignal 约束，在环回/高速隧道上等价于没有上限。
const MAX_RPC_BYTES = 32 * 1024 * 1024;

// 有上限地读 JSON：先看 content-length，再流式计数；超限就 cancel 并当作失败（不落库）。
async function readJsonBounded(res, maxBytes = MAX_RPC_BYTES) {
  const declared = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try { await res.body?.cancel?.(); } catch { /* 尽力而为 */ }
    return { __error: 'rpc response too large' };
  }
  if (!res.body) {
    // 没有流（某些运行时/实现）：退回整体读取，但仍用文本长度兜一道上限
    const text = await res.text();
    if (text.length > maxBytes) return { __error: 'rpc response too large' };
    try { return JSON.parse(text); } catch { return { __error: 'rpc response not json' }; }
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* 尽力而为 */ }
        return { __error: 'rpc response too large' };
      }
      chunks.push(value);
    }
  } catch (error) {
    // 读取中途失败/被 abort：原因必须**如实**报出来。原先是 `res.json()` 抛错后统一写成
    // 「rpc response not json」—— 一个 4s 超时被 abort 的请求会显示成「响应不是 JSON」，
    // 排查时把人引向「对方返回格式不对」（审查指出的小瑕疵）。
    const name = error?.name ?? '';
    return { __error: name === 'AbortError' || name === 'TimeoutError' ? 'rpc timeout' : 'rpc read failed' };
  } finally {
    try { reader.releaseLock?.(); } catch { /* 已经释放/已取消 */ }
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
  try { return JSON.parse(buf.toString('utf8')); } catch { return { __error: 'rpc response not json' }; }
}

// POST 一次 RPC 到 `/api/<endpoint>`，返回 result（或 null）。
// args 是端点参数；dsh 的 RPC 信封要求 payload 形如 { args: <object> }。
async function rpc(url, endpoint, args = {}, timeoutMs = RPC_TIMEOUT_MS, maxBytes = MAX_RPC_BYTES) {
  const { origin, token } = splitAuthUrl(url);
  const cookie = await acquireCookie(origin, token, timeoutMs);
  // 鉴权/握手失败（实例不可达、token 无效）：返回失败标记，调用方回退。
  if (cookie && typeof cookie === 'object') return cookie;

  const body = JSON.stringify({
    type: 'client-request',
    rpcId: globalThis.crypto?.randomUUID?.() ?? String(Date.now()),
    method: endpoint,
    payload: { args },
  });
  let res;
  try {
    res = await fetch(`${origin}/api/${endpoint}`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { __error: error.name === 'TimeoutError' ? 'rpc timeout' : 'rpc fetch failed' };
  }
  if (!res.ok) return { __error: `rpc http ${res.status}` };
  const parsed = await readJsonBounded(res, maxBytes);
  if (parsed?.__error) return parsed;
  const msg = parsed;
  if (msg?.type !== 'server-response') return { __error: 'bad rpc envelope' };
  if (msg.result?.ok === false) {
    const code = msg.result.error?.code;
    return { __error: `rpc rejected (${typeof code === 'string' && /^[a-zA-Z0-9_/-]{1,80}$/.test(code) ? code : 'unknown'})` };
  }
  return msg.result;
}

// 把 dsh 实时返回的一条会话折叠成 hwb 会话行可用的「状态覆盖」。
// 实测 dsh `/api/session/list` 的 item 形状：
//   { sessionId, updatedAt(ms), running(bool), blank, cwd, projections: { values: {...} } }
// values 内含 sessionStats/goal/todos/subagent/plan/permissions/sessionListMetadata/tokenUsage/title。
// `running` 是权威的实时运行信号；其余经 deriveSessionStatus 推导 completed/idle，保持与缓存一致。
// ms → ISO：超出 ECMAScript 日期范围（±8.64e15 ms）的时间戳 toISOString 会抛 RangeError，
// 而 isFinite 仍为 true（例如单位写错成纳秒）。这里降级为 null，绝不因为一个脏字段抛穿整个轮询。
// 统一实现见 lib/time.js。
// dsh 的投影值在**文件**侧是带版本包装的：`{ver, seq, val: {totals: {...}}}`（见 lib/schema.js）。
// 而 `/api/session/list` 的 `projections.values.tokenUsage` 给的是哪一层，本项目没有可对照的实例
// 可以确定（`values` 是 dsh 的内存投影表，理论上也可能是解开后的值）。所以三种形态都接受：
//   {uncachedInputTokens,…} / {totals:{…}} / {val:{totals:{…}}}
//
// 为什么要在这里归一：不归一的话，若 dsh 给的是带包装的那层，我们就会把一个**嵌套结构**存进
// sessions.tokenUsage —— 用量聚合按 `$.uncachedInputTokens` 取值只会得到 0，而且这次实时写入会
// **覆盖掉文件索引里正确的扁平值**。宁可返回 null（保持文件索引的值），也不存一个自己解析不出来的结构。
// 只有确实取到至少一个有限数字才返回对象。
// 注意「部分认得出来」（少一两个键）也会返回对象，这本身没问题：写入侧 mergeLiveStatus 是
// **按 key 合并**进已有 tokenUsage，没报的键保留投影缓存的值 —— 所以这里不需要（也不该）把
// 部分对象一律判为 null，否则会连带丢掉实时确实报了的那个键。
export function normalizeLiveTokenUsage(raw) {
  const candidate = raw?.val?.totals ?? raw?.totals ?? raw;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const out = {};
  for (const k of ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
    const v = candidate[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) out[k] = Number(v);
  }
  return Object.keys(out).length ? out : null;
}

// 投影值可能是**带版本包装**的 `{ver,seq,val}`（文件侧就是这个形状）。
// tokenUsage 早就按「三种形态都接受」归一，但 goal / todos / plan / subagent / permissions /
// sessionListMetadata 当时只接受**解开后的**形态 —— 本项目没有可对照的 live dsh，谁也不知道
// `/api/session/list` 给的是哪一层（见 normalizeLiveTokenUsage 的注释）。若实际是包装形态，
// 实时通道会把「已完成」系统性降级成「空闲」、丢掉 in_progress todo，而且**每 3s 重写一次**、
// 在宽限期内赢过文件侧的正确值 —— 与「实时 approval 绕过守卫」同一类「不自愈」的缺陷。
// 解一层即可：没有 `val` 字段的值原样返回（解开形态的载荷不受影响）。
// 只对**对象**解（数组、字符串、null 原样返回）。
function unwrapProjection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return 'val' in value ? value.val : value;
}

function toLiveRow(item) {
  const raw = item?.sessionId ?? item?.id ?? null;
  // sessionId 必须是**非空字符串**。它是唯一没做类型校验的绑定点，而外层 applyLiveStatus 走的是
  // 整批 upsert：一行脏数据会让**整批**一行都写不进去并抛
  // 「Provided value cannot be bound to SQLite parameter 2」（审查实测：`true`/`{}`/`[]` 都抛，
  // committed rows = 0），而库里的行保持上一轮的值 —— 显示的是**错**的状态，不只是旧状态。
  // 数字虽然能写进去（被 TEXT affinity 改写），但那也不是 sessionId，一并拒绝。
  // 顺手剥掉 NUL：node:sqlite 绑 TEXT 时按 C 字符串处理，值里的 U+0000 会把后面**静默截掉**
  // （实测：`run('A\u0000B')` 读回 `'A'`）。外部 dsh 的 title 里带 NUL 时不该只剩第一个字符。
  const sid = typeof raw === 'string' && stripNul(raw).trim() !== '' ? stripNul(raw) : null;
  if (!sid) return null;
  const rawValues = item?.projections?.values ?? {};
  const values = {
    ...rawValues,
    sessionStats: unwrapProjection(rawValues.sessionStats) ?? {},
    goal: unwrapProjection(rawValues.goal ?? null),
    todos: unwrapProjection(rawValues.todos),
    plan: unwrapProjection(rawValues.plan),
    subagent: unwrapProjection(rawValues.subagent),
    permissions: unwrapProjection(rawValues.permissions),
    sessionListMetadata: unwrapProjection(rawValues.sessionListMetadata) ?? {},
    title: unwrapProjection(rawValues.title),
  };
  const stats = values.sessionStats ?? {};
  const goal = values.goal ?? null;
  const todos = Array.isArray(values.todos) ? values.todos : [];
  const hasInProgressTodo = todos.some((t) => t && t.status === 'in_progress');
  const goalPhase = (typeof goal === 'object' && goal ? goal.goal?.phase ?? goal.phase : null) ?? null;
  // 与 lib/status.js 保持一致：`plan.active` 是持久的**模式开关**（plan/mode 设置，空闲不复位），
  // 只有 `plan.running`（进行中的 /plan 命令）才代表正在跑。把它当活动信号会让任何开过
  // plan 模式的会话在回退推断时永久显示「运行中」。
  const planRunning = !!(values.plan && values.plan.running != null);
  const inferredRunning = stats.openStep != null || (stats.pendingCalls && Object.keys(stats.pendingCalls).length > 0) || hasInProgressTodo || goalPhase === 'active' || planRunning;
  const isRunning = typeof item.running === 'boolean' ? item.running : !!inferredRunning;
  const kind = isRunning ? 'running' : (goalPhase === 'complete' || (todos.length > 0 && todos.every((t) => t && t.status === 'completed')) ? 'completed' : 'idle');
  const labels = { running: '运行中', completed: '已完成', idle: '空闲' };
  const subagentRaw = values.subagent;
  const subagents = subagentRaw && typeof subagentRaw === 'object' && !Array.isArray(subagentRaw) && !(subagentRaw instanceof Date) ? Object.keys(subagentRaw).length : 0;
  const meta = values.sessionListMetadata ?? {};
  const lastPromptAt = typeof meta.lastPromptAt === 'number' ? meta.lastPromptAt : (typeof item.updatedAt === 'number' ? item.updatedAt : null);
  return {
    sessionId: sid,
    // cwd 用于给「projcache 里还没有的新会话」推导 project 归属（basename(cwd)，与 normalize 一致）。
    cwd: typeof item.cwd === 'string' && item.cwd ? stripNul(item.cwd) : null,
    status: {
      kind,
      label: labels[kind],
      subagents,
      // 与文件侧走同一套守卫（长字符串截断、非字符串丢弃）：实时值在宽限期内会**赢过**文件值，
      // 不守卫就等于把守卫整条绕过。
      approval: normalizeApproval(values.permissions?.approval),
    },
    lastActivity: msToIso(lastPromptAt),
    tokenUsage: normalizeLiveTokenUsage(values.tokenUsage),
    title: typeof values.title === 'string' ? stripNul(values.title) : null,
  };
}

// 规范化 dsh `/api/session/list` 的响应：result.value.items = 会话数组。
function extractLiveRows(result) {
  if (!result || typeof result !== 'object') return null;
  const list = Array.isArray(result)
    ? result
    : (result?.value?.items ?? result?.items ?? result?.sessions);
  if (!Array.isArray(list)) return null;
  const rows = list.map(toLiveRow).filter(Boolean);
  return rows;
}

export class LiveStatusReader {
  constructor({ timeoutMs = RPC_TIMEOUT_MS, maxResponseBytes = MAX_RPC_BYTES } = {}) {
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;   // 可注入：测试不必真造 32 MiB 的响应
    this.states = new Map();
  }

  // 对一个「运行中的 dsh 实例」（url 形如 http://127.0.0.1:<port>/?token=<x>）
  // 读取实时会话状态。返回 [{sessionId,cwd,status,lastActivity,tokenUsage,title}] 或 null。
  // 用 dsh `/api/session/list`（真实端点，payload 为 { args: { _request: {} } }）。
  async read(url, { homeId, host } = {}) {
    if (!url) return null;
    const { origin } = splitAuthUrl(url);
    const key = homeId ?? origin;
    const report = (error, count = 0) => {
      const state = error ?? 'ok';
      if (this.states.get(key) === state) return;
      this.states.set(key, state);
      // 不记录 URL/token/cookie、RPC 正文或远端错误详情。
      const context = { homeId, host, endpoint: 'session/list', timeoutMs: this.timeoutMs };
      if (error) log.warn('实时会话同步失败，工作台仍使用文件索引', { ...context, reason: error });
      else log.info('实时会话读取成功（写入由轮询器负责，失败会单独记 warn）', { ...context, sessionCount: count });
    };
    try {
      const result = await rpc(url, 'session/list', { _request: {} }, this.timeoutMs, this.maxResponseBytes);
      if (result?.__error) {
        report(result.__error);
        return null;
      }
      const rows = extractLiveRows(result);
      if (rows === null) {
        report('invalid session list response');
        return null;
      }
      report(null, rows.length);
      return rows;
    } catch {
      report('invalid session data');
      return null;
    }
  }
}
