import { logger } from '../lib/logger.js';
import { msToIso } from '../lib/time.js';

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

// POST 一次 RPC 到 `/api/<endpoint>`，返回 result（或 null）。
// args 是端点参数；dsh 的 RPC 信封要求 payload 形如 { args: <object> }。
async function rpc(url, endpoint, args = {}, timeoutMs = RPC_TIMEOUT_MS) {
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
  try {
    const msg = await res.json();
    if (msg?.type !== 'server-response') return { __error: 'bad rpc envelope' };
    if (msg.result?.ok === false) {
      const code = msg.result.error?.code;
      return { __error: `rpc rejected (${typeof code === 'string' && /^[a-zA-Z0-9_/-]{1,80}$/.test(code) ? code : 'unknown'})` };
    }
    return msg.result;
  } catch {
    return { __error: 'rpc response not json' };
  }
}

// 把 dsh 实时返回的一条会话折叠成 hwb 会话行可用的「状态覆盖」。
// 实测 dsh `/api/session/list` 的 item 形状：
//   { sessionId, updatedAt(ms), running(bool), blank, cwd, projections: { values: {...} } }
// values 内含 sessionStats/goal/todos/subagent/plan/permissions/sessionListMetadata/tokenUsage/title。
// `running` 是权威的实时运行信号；其余经 deriveSessionStatus 推导 completed/idle，保持与缓存一致。
// ms → ISO：超出 ECMAScript 日期范围（±8.64e15 ms）的时间戳 toISOString 会抛 RangeError，
// 而 isFinite 仍为 true（例如单位写错成纳秒）。这里降级为 null，绝不因为一个脏字段抛穿整个轮询。
// 统一实现见 lib/time.js。
function toLiveRow(item) {
  const sid = item?.sessionId ?? item?.id ?? null;
  if (!sid) return null;
  const values = item?.projections?.values ?? {};
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
    cwd: typeof item.cwd === 'string' && item.cwd ? item.cwd : null,
    status: {
      kind,
      label: labels[kind],
      subagents,
      approval: values.permissions?.approval ?? null,
    },
    lastActivity: msToIso(lastPromptAt),
    tokenUsage: values.tokenUsage ?? null,
    title: typeof values.title === 'string' ? values.title : null,
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
  constructor({ timeoutMs = RPC_TIMEOUT_MS } = {}) {
    this.timeoutMs = timeoutMs;
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
      else log.info('实时会话同步成功', { ...context, sessionCount: count });
    };
    try {
      const result = await rpc(url, 'session/list', { _request: {} }, this.timeoutMs);
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
