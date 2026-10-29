import { Agent } from 'node:http';
import { logger } from '../lib/logger.js';
import { msToIso } from '../lib/time.js';
import { normalizeApproval, subagentStatus, subagentCatalogIds, annotateSubagentRunning } from '../lib/status.js';
import { deriveProjectionIntervention } from '../lib/intervention.js';
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

// 单次实时 RPC（token→cookie 交接 + `/api` 往返）的预算。4s 对**本地**实例绰绰有余，
// 但这条通道同样服务**远程**实例（经 SSH 隧道 / 低带宽 VPN 的 dsh）：
// 实测 2026-09-19 的 c4g.tun，同一时刻稳定入口上 0.07s 的请求里夹着 1.4s / 3.6s / 6.0s 的
// 秒级停顿，于是 4s 门槛被频繁越过 —— 当天 43 轮探测失败 21 轮（49%），原因全是 `auth timeout`，
// 日志因此每 7s 一条成功一条失败，工作台在「实时 / 文件索引」之间反复横跳。
// 预算可配置（默认不变）：
//   HWB_LIVE_RPC_TIMEOUT_MS=10000
// 放宽是安全的：轮询器（LiveStatusPoller）对同一实例单飞（pending 去重），慢一轮只会跳过下一轮，
// 不会堆积请求。链路正常时这条预算也不会被用到（请求自己就结束了）。
export function defaultRpcTimeoutMs(env = process.env) {
  const raw = env?.HWB_LIVE_RPC_TIMEOUT_MS;
  if (raw === undefined || raw === '') return RPC_TIMEOUT_MS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : RPC_TIMEOUT_MS;
}

// 自适应超时的上界。放宽是为了容纳**慢但健康**的链路，不是为了让真挂掉的实例无限等待：
// 一次轮询最多占用这么久，之后仍按失败处理并让调用方回退到文件索引。
const MAX_ADAPTIVE_TIMEOUT_MS = 30_000;

// dsh 的 RPC 端点有两代命名，必须都认：
//   · 0.1.2（本机 MBP）：`/api/session/list`
//   · 0.1.1-rc.2（远端 dgx21 实测）：`/api/session.list`
// 用错写法的唯一症状是 HTTP 404 —— 而 hwb 原先写死 `session/list`，于是 dgx21 的实时状态
// **从来没生效过**（日志里每 3 秒一条 `rpc http 404`，工作台一直回退到冻结的文件索引）。
// 成功一次就按 home 记住写法（见 endpoints），之后每轮只发一次请求。
//
// **导出**供契约测试断言「首选写法是否仍与 dsh 现状一致」：回退能容错，但首选写错会让
// 每次发现都先白发一条 404（实测 0.1.5-rc.1 的 host 注册 slash 形，与首选一致）。
// 见 tests/compat 的 C2。
export const DEFAULT_ENDPOINTS = ['session/list', 'session.list'];

// —— 连接复用（2026-09-22，dgx21.tun 实测）——
//
// 这条通道服务远程实例时，每次 `fetch` 默认都会**新建一条 TCP 连接**；而远程实例的
// origin 是 hwb 自己的隧道口（127.0.0.1:<tunnelPort>），一条新 TCP 连接 = 隧道里一次
// 新的 channel 建立 + 对端一次新的 TCP 握手，在 90–140ms RTT / 10–50% 丢包的链路上
// 每次都要重新走慢启动。实测同一条链路上：
//   · 冷连接请求 1.86s，同一连接复用后 0.17s（auth GET 连发三次）；
//   · 轮询周期 3s，每次两段请求（cookie 交接 + RPC）⇒ 每 3 秒建两条连接。
// 复用一个 keep-alive agent 后，稳态下连接常驻，省掉每轮两次握手与慢启动。
//
// maxSockets 刻意压到 2：这条链路的总吞吐上限在 VPN 核心（约 1 Mbps），
// 并发只会互相抢带宽并推高丢包（实测并发总量封顶不变）。两个槽位对应
// 「cookie 交接 + RPC」这两段，且同一 home 的轮询本身已由 poller 单飞。
const LIVE_AGENT = new Agent({ keepAlive: true, maxSockets: 2, maxFreeSockets: 2, timeout: 60_000 });

export function liveAgent() {
  return LIVE_AGENT;
}

// 从带 `?token=` 的 URL 拆出 origin 与 token。兼容 `http://host:port/?token=x` 与裸 origin。
export function splitAuthUrl(url) {
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

// —— token→cookie 交接的记忆化（2026-09-22）——
//
// 原实现**每轮 RPC 都重做一次交接**：先 GET `origin/?token=<t>` 换 cookie，再 POST 真正的
// 端点。在本地环回上这只是多一次 0.1ms 的往返，看不出代价；但远程实例的 origin 是隧道口，
// 于是每次轮询要在这条 90–140ms RTT、10–50% 丢包、约 10–30 KB/s 的链路上走**两个**往返。
// 实测后果（dgx21.tun，~/.hwb/service.log 计数）：失败原因里 `auth timeout` 占 2215 次，
// 远超 `rpc timeout` 的 226 次 —— 也就是说绝大多数轮询**死在了交接那一段**，
// 真正的 RPC 还没开始发。工作台因此在「实时 / 文件索引」之间反复横跳，实例被标成 degraded。
//
// 交接的结果（cookie）在 token 不变、实例不变时是稳定的，所以按 origin 记忆：
//   · 命中即直接用，省掉一整段往返；
//   · 服务端在 cookie 失效时回 401/403 → 丢弃记忆并重做一次交接（见 rpc 的两段式）；
//   · 带 `?token=` 的实例重启后 token 会变，故记忆的键包含 token。
//
// **记忆挂在 reader 实例上，不是模块级**：cookie 是某个 dsh 实例的会话凭据，
// 而同一 origin（例如同一个隧道口被复用）在不同 home 下可能对应不同的 token。
// 放模块级会让两个 home 互相串用凭据，也让「按实例观测链路」的语义失去边界。
const COOKIE_TTL_MS = 10 * 60_000;

function memoKey(origin, token) {
  return `${origin}|${token ?? ''}`;
}

// token→cookie 交接：GET `origin/?token=<t>`（manual redirect），
// 成功(303)时带回 set-cookie 供后续 RPC 使用。返回 cookie 的 `name=value` 片段。
// `memo` 是调用方（reader 实例）持有的记忆表；命中时零往返。
export async function acquireCookie(origin, token, timeoutMs, memo = null) {
  const key = memoKey(origin, token);
  if (memo) {
    const hit = memo.get(key);
    if (hit && Date.now() - hit.at < COOKIE_TTL_MS) return hit.cookie;
  }
  const authUrl = token ? `${origin}/?token=${encodeURIComponent(token)}` : origin;
  let first;
  try {
    first = await fetch(authUrl, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      // 复用 keep-alive 连接：远程实例上这条请求走隧道，建连成本远高于请求本身。
      agent: LIVE_AGENT,
    });
  } catch (error) {
    return { __error: error.name === 'TimeoutError' ? 'auth timeout' : 'auth fetch failed' }; // 实例不可达：显式失败标记，调用方回退
  }
  // 无 token 栅栏（旧版 dsh / 直接放行）→ 无需 cookie。
  if (first.status === 303) {
    const cookie = first.headers.get('set-cookie')?.split(';')[0] ?? '';
    memo?.set(key, { cookie, at: Date.now() });
    return cookie;
  }
  if (first.status === 401 || first.status === 403) {
    // launch token 无效/过期：实例被外部重启后 hwb 持有的旧 token 会落到这里。
    // 明确返回 null 哨兵，让调用方回退，并把问题留到日志层提示。
    memo?.delete(key);
    return { __error: `auth http ${first.status}` };
  }
  if (!first.ok) return { __error: `auth http ${first.status}` };
  const cookie = first.headers.get('set-cookie')?.split(';')[0] ?? '';
  memo?.set(key, { cookie, at: Date.now() });
  return cookie;
}

// 实时 RPC 响应的上限。与文件侧（read-home 的 64 MiB 元数据上限、remote-reader 的 32 MiB stdout）
// 同类：这条通道同样服务**远程**实例（服务器侧的隧道 URL），对面完全可以是外来的 dsh，
// 所以「响应用户可控的大对象」这种情况必须有上限。
// 审查实测（假 dsh 用复用的 1 MiB buffer 分块推送 200 MiB）：原先 `res.json()` 照单全收 ——
// 读入侧 RSS +844 MiB、耗时 195ms，200 MiB 的「标题」还会原样落进 sessions.title 发给浏览器。
// 只受 `defaultRpcTimeoutMs()` 的 AbortSignal 约束 —— 在环回/高速隧道上等价于没有上限。
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
export async function rpc(url, endpoint, args = {}, timeoutMs = RPC_TIMEOUT_MS, maxBytes = MAX_RPC_BYTES, memo = null) {
  const { origin, token } = splitAuthUrl(url);
  const body = JSON.stringify({
    type: 'client-request',
    rpcId: globalThis.crypto?.randomUUID?.() ?? String(Date.now()),
    method: endpoint,
    payload: { args },
  });
  // 两段式：先用记忆的 cookie 直发 RPC；若服务端说 cookie 不认（401/403），
  // 丢掉记忆、重做一次交接再发一次。**只在鉴权失败时**才多花这一段往返 ——
  // 常态（cookie 有效）下每轮只有一次隧道往返，而不是原来的两次。
  //
  // 重试的**前提是这次用的是记忆里的 cookie**：那说明 cookie 曾经有效、现在可能只是过期了
  // （实例重启换了密钥），重做一次交接有意义。反之，若刚用 `?token=` 换来的新 cookie 仍被拒，
  // 那是 token 本身无效 —— 再交接一次只会在这条慢链路上白打一个往返。
  for (let leg = 0; leg < 2; leg += 1) {
    const usingMemo = leg === 0 && !!memo && memo.has(memoKey(origin, token));
    const cookie = await acquireCookie(origin, token, timeoutMs, leg === 0 ? memo : null);
    // 鉴权/握手失败（实例不可达、token 无效）：返回失败标记，调用方回退。
    if (cookie && typeof cookie === 'object') return cookie;
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
        // 复用 keep-alive 连接（见 LIVE_AGENT）：远程实例上建连成本远高于请求本身。
        agent: LIVE_AGENT,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      return { __error: error.name === 'TimeoutError' ? 'rpc timeout' : 'rpc fetch failed' };
    }
    // 记忆的 cookie 已失效（实例重启换了密钥）：清掉记忆，再走一次交接。
    // 仅当这次确实用的是记忆（usingMemo）时才重试，理由见上。
    if ((res.status === 401 || res.status === 403) && usingMemo) {
      memo?.delete(memoKey(origin, token));
      try { await res.body?.cancel?.(); } catch { /* 释放失败不改变重试语义 */ }
      continue;
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
  return { __error: 'rpc auth retry exhausted' };
}

// 把 dsh 实时返回的一条会话折叠成 hwb 会话行可用的「状态覆盖」。
// 实测 dsh `/api/session/list` 的 item 形状：
//   { sessionId, updatedAt(ms), running(bool), blank, cwd, projections: { values: {...} } }
// values 内含 sessionStats/goal/todos/subagent/plan/permissions/sessionListMetadata/tokenUsage/title。
// `running` 是权威的实时运行信号；其余经 deriveSessionStatus 推导 completed/idle，保持与缓存一致。
// ms → ISO：超出 ECMAScript 日期范围（±8.64e15 ms）的时间戳 toISOString 会抛 RangeError，
// 而 isFinite 仍为 true（例如单位写错成纳秒）。这里降级为 null，绝不因为一个脏字段抛穿整个轮询。
// 统一实现见 lib/time.js。
// dsh 的投影值在**文件**侧是带版本包装的：`{ver, seq, val: {totals: {...}}}`（durable 行
// `(sessionId, key, ver, seq, val)`）。而 `/api/session/list` 的 `values.tokenUsage` 按 dsh 的类型
// 声明就是 `TokenUsageProjection` —— **扁平四键**（dsh-token-meter/lib/types/projection.d.ts:10）。
// 三种形态都接受是**向后/向前兼容**的余量（上游换一层不会让用量归零），不是「不知道是什么形状」：
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

// 投影值的两层形状 —— 现在有**权威依据**了（此前几轮注释里一直写着「无法确定」）：
//   · 实时 RPC：`/api/session/list` 的 item 是 dsh 的 `SessionSummary`
//     （dsh-api-session-controller/lib/types/types.d.ts:138），带 `projections?: SessionProjectionHints`，
//     而 `SessionProjectionHints = { values: SessionProjectionValues }`（同文件 :40-59）。
//     `values` 里是**投影值本身**、不是包装：`goal`、`plan`、`sessionStats`、`permissions`、
//     `todos`、`title`、`tokenUsage`（= `TokenUsageProjection`，**扁平四键**）、
//     `sessionListMetadata`（= `{blank, lastPromptAt}`）—— 逐条见各包 lib/types 的
//     `SessionProjectionMap` 声明式合并。顺带确认 `SessionSummary.running: boolean` 恒为布尔。
//   · 文件侧（`session_projcache.json`）：durable 行是 `(sessionId, key, ver, seq, val)`
//     （dsh-session-projection/lib/types/index.d.ts:199），所以**那一侧**才是 `{ver,seq,val}` 包装。
// 也就是说：解开形态是常态，包装形态理论上不该出现在实时通道里。但这里仍然保留解一层的能力，
// 作为「上游改成包装形态」的防御（代价是几行代码，而漏判的代价是实时值每 3s 覆盖正确值、不自愈）。
// 只当它**确实长得像包装**（有 `val`，且其余键只有 ver/seq）才解 —— dsh 允许插件贡献任意 JSON 键，
// 一个恰好带 `val` 字段的投影值不该被我们吃掉一层。
function unwrapProjection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  if (!('val' in value)) return value;
  const others = Object.keys(value).filter((k) => k !== 'val');
  return others.every((k) => k === 'ver' || k === 'seq') ? value.val : value;
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
    subagentCatalog: unwrapProjection(rawValues.subagentCatalog),
    permissions: unwrapProjection(rawValues.permissions),
    userQuestions: unwrapProjection(rawValues.userQuestions),
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
  const subagents = subagentStatus(values.subagent, values.subagentCatalog);
  // 子代理 catalog 的 childId 列表：**临时字段**，只用于 extractLiveRows 的两遍 join
  //（父会话 ↔ 同一批 session/list 里的子会话行）。不进 sessions.status，也不入库。
  const childSessionIds = subagentCatalogIds(values.subagentCatalog);
  const intervention = deriveProjectionIntervention({ userQuestions: values.userQuestions });
  // 投影**存在但为空**时也要显式写 `intervention: null`（而不是省略键）：写入侧
  // （reader.mergeLiveStatusJson）据此区分「实时确认没有在等」与「旧版 dsh 没报这个投影」，
  // 后者不该把文件索引推导出的「等待回答」冲掉。undefined = 这条 dsh 没给该投影。
  const projectionReported = values.userQuestions !== undefined && values.userQuestions !== null;
  const meta = values.sessionListMetadata ?? {};
  const lastPromptAt = typeof meta.lastPromptAt === 'number' ? meta.lastPromptAt : (typeof item.updatedAt === 'number' ? item.updatedAt : null);
  return {
    sessionId: sid,
    // cwd 用于给「projcache 里还没有的新会话」推导 project 归属（basename(cwd)，与 normalize 一致）。
    cwd: typeof item.cwd === 'string' && item.cwd ? stripNul(item.cwd) : null,
    status: {
      kind,
      label: labels[kind],
      ...subagents,
      ...(item.origin === 'subagent' || (typeof item.parentSessionId === 'string' && item.parentSessionId.trim()) ? { isSubagent: true } : {}),
      // 与文件侧走同一套守卫（长字符串截断、非字符串丢弃）：实时值在宽限期内会**赢过**文件值，
      // 不守卫就等于把守卫整条绕过。
      approval: normalizeApproval(values.permissions?.approval),
      // 与文件侧一致：投影里能看出的「等待回答」随实时行一起带出（审批由 remote-events 观察器补）。
      // 键的有无是**语义信号**（见上面 projectionReported 的注释），所以这里判断的是投影是否被上报，
      // 而不是 intervention 是否为 null。
      ...(projectionReported ? { intervention } : {}),
    },
    // 临时字段（不入库）：extractLiveRows 用它把「其中几个子代理在跑」join 出来。
    ...(childSessionIds ? { childSessionIds } : {}),
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
  // 第二遍：父会话的子代理运行数要和**同一批**实时行 join（子会话自己的 running 是权威信号）。
  // 与文件索引共用 annotateSubagentRunning，所以两条路径的口径不会分叉。
  annotateSubagentRunning(rows);
  return rows;
}

export class LiveStatusReader {
  constructor({ timeoutMs = defaultRpcTimeoutMs(), maxResponseBytes = MAX_RPC_BYTES, endpoints = DEFAULT_ENDPOINTS, adaptiveTimeout = true } = {}) {
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;   // 可注入：测试不必真造 32 MiB 的响应
    this.states = new Map();
    this.candidates = endpoints;
    this.endpoints = new Map();                 // homeId/origin -> 这个实例认得的那种写法
    // —— 链路自适应的超时（2026-09-22）——
    //
    // 固定 4s 预算对本地实例够用，对远程实例则是**必然失败**：实测经隧道取一次
    // session.list（129 KB）要 3.4–7.3s，于是轮询有一半以上撞在超时上。
    // 而「远端 dsh 服务端只要 1–5ms」说明这些时间全花在链路上 —— 属于**可测量的链路属性**，
    // 不该用一个写死的常数去猜。这里按实例记「最近一次成功往返」的 EWMA，
    // 预算取 max(配置值, EWMA×3 + 2s)：链路快时不改变行为（请求自己就结束了），
    // 链路慢时自动放宽，且放宽有上界（见 MAX_ADAPTIVE_TIMEOUT_MS），不会掩盖真正挂掉的实例。
    this.adaptiveTimeout = adaptiveTimeout;
    this.latency = new Map();                   // key -> EWMA(ms)
    // cookie 记忆（见上）：挂在实例上，避免不同 home / 不同 token 之间串用凭据。
    this.cookies = new Map();                   // memoKey -> { cookie, at }
  }

  // 该实例本次请求该用的超时预算。
  timeoutFor(key) {
    if (!this.adaptiveTimeout) return this.timeoutMs;
    const ewma = this.latency.get(key);
    if (!Number.isFinite(ewma) || ewma <= 0) return this.timeoutMs;
    const adaptive = Math.round(ewma * 3 + 2000);
    return Math.min(MAX_ADAPTIVE_TIMEOUT_MS, Math.max(this.timeoutMs, adaptive));
  }

  // 记录一次成功往返，更新该实例的 EWMA（α=0.4：对新值反应快，又不会因单次抖动翻倍）。
  #noteLatency(key, ms) {
    if (!this.adaptiveTimeout || !Number.isFinite(ms) || ms <= 0) return;
    const prev = this.latency.get(key);
    const next = Number.isFinite(prev) ? prev * 0.6 + ms * 0.4 : ms;
    this.latency.set(key, next);
  }

  /** 该实例当前的 EWMA 往返（ms），无观测时为 null。观测/测试用。 */
  latencyOf(key) {
    const v = this.latency.get(key);
    return Number.isFinite(v) ? Math.round(v) : null;
  }

  // 该实例先试哪种写法：记住过的优先，其余按默认顺序补齐。
  #candidateEndpoints(key) {
    const remembered = this.endpoints.get(key);
    if (!remembered) return this.candidates;
    return [remembered, ...this.candidates.filter((e) => e !== remembered)];
  }

  // 对一个「运行中的 dsh 实例」（url 形如 http://127.0.0.1:<port>/?token=<x>）
  // 读取实时会话状态。返回 [{sessionId,cwd,status,lastActivity,tokenUsage,title}] 或 null。
  // 用 dsh `/api/session/list`（真实端点，payload 为 { args: { _request: {} } }）。
  async read(url, { homeId, host } = {}) {
    if (!url) return null;
    const { origin } = splitAuthUrl(url);
    const key = homeId ?? origin;
    const budget = this.timeoutFor(key);
    const startedAt = Date.now();
    const report = (error, count = 0, endpoint = null) => {
      // 端点写进 state：同一实例换了写法（或换了可用写法）时只记一次。
      const state = error ?? `ok:${endpoint}`;
      if (this.states.get(key) === state) return;
      this.states.set(key, state);
      // 不记录 URL/token/cookie、RPC 正文或远端错误详情。
      const context = {
        homeId,
        host,
        endpoint: endpoint ?? this.endpoints.get(key) ?? this.candidates[0],
        timeoutMs: budget,
        // 链路诊断：本地实例约 1ms，远程隧道实例是秒级。排查「为什么老是超时」时，
        // 这一对数（预算 vs 实测）比 reason 字符串更能说明问题。
        ...(this.latencyOf(key) !== null ? { ewmaMs: this.latencyOf(key) } : {}),
      };
      if (error) log.warn('实时会话同步失败，工作台仍使用文件索引', { ...context, reason: error });
      else log.info('实时会话读取成功（写入由轮询器负责，失败会单独记 warn）', { ...context, sessionCount: count });
    };
    try {
      let lastError = null;
      for (const endpoint of this.#candidateEndpoints(key)) {
        const result = await rpc(url, endpoint, { _request: {} }, budget, this.maxResponseBytes, this.cookies);
        if (result?.__error) {
          lastError = result.__error;
          // 只有「这个端点不存在」才值得换写法；超时/鉴权/响应超限换写法也一样失败，
          // 多打一轮只是把这条已经很窄的链路再占一次。
          if (!/rpc http 404/.test(result.__error)) break;
          if (this.endpoints.get(key) === endpoint) this.endpoints.delete(key);   // 远端换了版本 → 忘掉旧写法
          continue;
        }
        this.endpoints.set(key, endpoint);
        this.#noteLatency(key, Date.now() - startedAt);
        const rows = extractLiveRows(result);
        if (rows === null) {
          report('invalid session list response', 0, endpoint);
          return null;
        }
        report(null, rows.length, endpoint);
        return rows;
      }
      report(lastError ?? 'rpc failed');
      return null;
    } catch {
      report('invalid session data');
      return null;
    }
  }
}
