import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveStatusReader } from '../src/dshhome/live-status.js';


// dsh 的投影值在**文件**侧是带版本包装的 `{ver,seq,val:{totals:{…}}}`；而 `/api/session/list`
// 的 `projections.values.tokenUsage` 给的是哪一层，本项目没有可对照的实例可以确定。
// 不归一的话，若 dsh 给的是带包装的那层，我们就会把**嵌套结构**存进 sessions.tokenUsage：
// 用量聚合按 `$.uncachedInputTokens` 取值只会得到 0，而且这次实时写入会覆盖掉文件索引里
// 正确的扁平值（正在跑的会话，历史用量突然归零）。三种形态都必须能吃。
test('live-status: 实时 tokenUsage 的三种形态都被归一成扁平计数', async () => {
  const { normalizeLiveTokenUsage } = await import('../src/dshhome/live-status.js');
  const flat = { uncachedInputTokens: 5, outputTokens: 6, cacheReadTokens: 7, cacheWriteTokens: 8 };
  assert.deepEqual(normalizeLiveTokenUsage(flat), flat, '扁平形态原样通过');
  assert.deepEqual(normalizeLiveTokenUsage({ totals: flat }), flat, '只有 totals 一层');
  assert.deepEqual(normalizeLiveTokenUsage({ ver: 1, seq: 2, val: { totals: flat } }), flat,
    '文件侧那种带版本包装的形态');
  assert.deepEqual(normalizeLiveTokenUsage({ uncachedInputTokens: '9' }), { uncachedInputTokens: 9 }, '字符串数字');
  // 认不出来的形态必须返回 null（保持文件索引的值），而不是把一个解析不出来的结构存进去
  for (const bad of [null, undefined, {}, [1, 2], 'nope', 42, { val: {} }]) {
    assert.equal(normalizeLiveTokenUsage(bad), null, `${JSON.stringify(bad)} 应归一为 null`);
  }
});

// 实时通道的 `permissions.approval` 原先直接落库，绕过了 lib/status.js 的守卫（只留字符串、截断到 64），
// 而且在宽限期内**赢过**文件侧被守卫过的值 —— 每次轮询重新赢，不自愈。
// 实测（审查）：`{"obj":true}` 落库 → 界面显示「审批 [object Object]」；
// 30 万字符的字符串会把 sessions.status 这一列撑到 300KB，且每 3s 重写一次。
test('toLiveRow: 实时 approval 与文件侧走同一套守卫（长串截断、非字符串丢弃）', async () => {
  const { LiveStatusReader } = await import('../src/dshhome/live-status.js');
  const saved = globalThis.fetch;
  const rowsFor = async (values) => {
    globalThis.fetch = async () => Response.json({
      type: 'server-response',
      result: { ok: true, value: { items: [{ sessionId: 's1', cwd: '/r', projections: { values } }] } },
    });
    return new LiveStatusReader().read('http://127.0.0.1:1/', {});
  };
  try {
    const obj = await rowsFor({ permissions: { approval: { obj: true } } });
    assert.equal(obj[0].status.approval, null, '非字符串一律丢弃');
    const long = await rowsFor({ permissions: { approval: 'x'.repeat(300_000) } });
    assert.equal(long[0].status.approval.length, 65, '超长截断到 64 字符 + 省略号');
    const ok = await rowsFor({ permissions: { approval: 'never' } });
    assert.equal(ok[0].status.approval, 'never', '正常字符串照旧');

    // 只当它**确实长得像版本包装**（除 val 外只剩 ver/seq）才解一层：
    // dsh 允许插件贡献任意 JSON 键（SessionProjectionValues 里有 Record<string, …>），
    // 一个恰好带 `val` 字段的投影值不该被我们吃掉一层。
    const notWrapper = await rowsFor({ sessionStats: { val: 1, openStep: 3 } });
    assert.equal(notWrapper[0].status.kind, 'running',
      '带 val 字段但不像包装的对象必须原样保留（否则会把 openStep 吃掉、状态错判成空闲）');
  } finally { globalThis.fetch = saved; }
});

// 实时 RPC 响应**没有大小上限**（文件侧有：read-home 64 MiB、remote-reader 32 MiB）。
// 审查实测（假 dsh 用**复用**的 1 MiB buffer 分块推送 200 MiB，读取侧增长全在客户端）：
// 原先 `res.json()` 照单全收 —— 客户端 RSS +844 MiB、耗时 195ms；200 MiB 的「标题」还会原样
// 落进 sessions.title 发给浏览器。只受 4s 的 AbortSignal 约束，环回/高速隧道上等价无上限。
// 这条通道同样服务**远程**实例（对面可以是外来的 dsh），所以必须有上限。
test('rpc 响应超上限时判为失败（不把超大对象读进内存、不落库）', async () => {
  const { LiveStatusReader } = await import('../src/dshhome/live-status.js');
  const saved = globalThis.fetch;
  try {
    // ① content-length 预检：声明超限就不读 body
    let cancelled = 0;
    globalThis.fetch = async () => new Response(JSON.stringify({ type: 'server-response', result: { ok: true } }), {
      headers: { 'content-type': 'application/json', 'content-length': String(64 * 1024 * 1024) },
    });
    const reader1 = new LiveStatusReader({ maxResponseBytes: 1024 });
    assert.equal(await reader1.read('http://127.0.0.1:1/', {}), null, '声明超限 → 失败（调用方回退文件索引）');

    // ② 没有 content-length 时的流式计数（分块推送，总量超限）
    const big = 'x'.repeat(64 * 1024);
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) {
        for (let i = 0; i < 8; i++) controller.enqueue(new TextEncoder().encode(big));
        controller.close();
      },
      cancel() { cancelled++; },
    }), { headers: { 'content-type': 'application/json' } });
    const reader2 = new LiveStatusReader({ maxResponseBytes: 100 * 1024 });
    assert.equal(await reader2.read('http://127.0.0.1:1/', {}), null, '流式超限 → 失败');
    assert.ok(cancelled >= 1, '超限后必须取消读取（否则连接与内存都留着）');

    // ③ 正常大小的响应照旧可用（上限不能把正常路径挡住）
    globalThis.fetch = async () => Response.json({
      type: 'server-response',
      result: { ok: true, value: { items: [{ sessionId: 's1', cwd: '/r', projections: { values: {} } }] } },
    });
    const ok = await new LiveStatusReader().read('http://127.0.0.1:1/', {});
    assert.equal(ok?.[0]?.sessionId, 's1');
  } finally { globalThis.fetch = saved; }
});

// 投影值可能是**带版本包装**的 `{ver,seq,val}`（文件侧就是这个形状），而 `projections.values.*`
// 给的是哪一层本项目无法确定（tokenUsage 早就按三种形态归一，其余字段当时只接受解开形态）。
// 若实际是包装形态，实时通道会把「已完成」系统性降级成「空闲」、丢掉 in_progress todo，
// 而且每 3s 重写一次、宽限期内赢过文件侧的正确值 —— 与 approval 那条同一类「不自愈」缺陷。
test('toLiveRow: 包装形态（{ver,seq,val}）的投影值同样被解开', async () => {
  const { LiveStatusReader } = await import('../src/dshhome/live-status.js');
  const saved = globalThis.fetch;
  try {
    const wrap = (val) => ({ ver: 1, seq: 3, val });
    globalThis.fetch = async () => Response.json({
      type: 'server-response',
      result: {
        ok: true,
        value: {
          items: [{
            sessionId: 's1', cwd: '/r',
            projections: {
              values: {
                goal: wrap({ goal: { phase: 'complete' } }),
                todos: wrap([{ status: 'completed' }, { status: 'completed' }]),
                title: wrap('包装标题'),
                plan: wrap({ running: null }),
                subagent: wrap({ a: {} }),
                permissions: wrap({ approval: 'never' }),
                sessionListMetadata: wrap({ lastPromptAt: 1_700_000_000_000 }),
              },
            },
          }],
        },
      },
    });
    const rows = await new LiveStatusReader().read('http://127.0.0.1:1/', {});
    assert.equal(rows[0].status.kind, 'completed', '包装形态下的 goal.phase=complete 必须被认出来');
    assert.equal(rows[0].status.subagents, 1, 'subagent 计数要能穿透包装');
    assert.equal(rows[0].status.approval, 'never', 'approval 也要解一层');
    assert.equal(rows[0].title, '包装标题');
    assert.equal(rows[0].lastActivity, new Date(1_700_000_000_000).toISOString(), 'lastPromptAt 同样');

    // 对照：解开形态照旧
    globalThis.fetch = async () => Response.json({
      type: 'server-response',
      result: { ok: true, value: { items: [{ sessionId: 's2', cwd: '/r', projections: { values: { goal: { phase: 'complete' } } } }] } },
    });
    const flat = await new LiveStatusReader().read('http://127.0.0.1:1/', {});
    assert.equal(flat[0].status.kind, 'completed');
  } finally { globalThis.fetch = saved; }
});

// 读取中途被 abort（4s 超时）原先会被写成「rpc response not json」—— 排查时把人引向
// 「对方返回格式不对」，而真实原因是超时（审查指出的小瑕疵）。
test('rpc 读取被 abort 时报「rpc timeout」而不是「not json」', async () => {
  const { LiveStatusReader } = await import('../src/dshhome/live-status.js');
  const saved = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"type":"server-response"'));
        const err = new Error('aborted'); err.name = 'AbortError';
        controller.error(err);
      },
    }), { headers: { 'content-type': 'application/json' } });
    const reader = new LiveStatusReader();
    assert.equal(await reader.read('http://127.0.0.1:9/', {}), null);
    // 状态里记的是 timeout 这个原因（report 只在原因变化时打日志，所以这里直接读 states）
    assert.equal([...reader.states.values()][0], 'rpc timeout');
  } finally { globalThis.fetch = saved; }
});

// —— v0.1.1 兼容：端点命名有两代 ——
// 0.1.2 是 `/api/session/list`，0.1.1-rc.2（远端 dgx21 实测）是 `/api/session.list`。
// 写死一种写法的后果不是「慢一点」，而是**整个实时通道从未生效**（每 3 秒一条 404，
// 工作台一直回退冻结的文件索引）。
test('live reader 遇到 404 会换用另一代端点命名，并记住可用写法', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    if (opts.method !== 'POST') return new Response(null, { status: 303, headers: { 'Set-Cookie': 'auth=ok; HttpOnly' } });
    calls.push(new URL(url).pathname);
    if (String(url).endsWith('/api/session/list')) return new Response('not found', { status: 404 });
    return Response.json({ type: 'server-response', result: { value: { items: [{ sessionId: 's1', running: true }] } } });
  });
  const reader = new LiveStatusReader();
  const rows = await reader.read('http://localhost:3080/', { homeId: 'h1' });
  assert.equal(rows.length, 1);
  assert.deepEqual(calls.slice(-2), ['/api/session/list', '/api/session.list'], '先试 0.1.2 的写法，404 后再试 0.1.1 的');
  assert.equal(reader.endpoints.get('h1'), 'session.list');

  // 第二轮：直接用记住的写法，不再白发那条 404。
  const before = calls.length;
  await reader.read('http://localhost:3080/', { homeId: 'h1' });
  assert.deepEqual(calls.slice(before), ['/api/session.list']);
});

test('live reader 只在 404 时换写法：超时/鉴权失败不做第二次尝试（慢链路上别多打一轮）', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    if (opts.method !== 'POST') return new Response(null, { status: 303, headers: { 'Set-Cookie': 'auth=ok; HttpOnly' } });
    calls.push(new URL(url).pathname);
    return new Response('boom', { status: 401 });
  });
  const reader = new LiveStatusReader();
  const rows = await reader.read('http://localhost:3080/', { homeId: 'h2' });
  assert.equal(rows, null);
  assert.deepEqual(calls, ['/api/session/list'], '401 不是「写法不对」，不该再试第二种');
});

// —— 远程实例的实时 RPC 预算（2026-09-19）——
//
// 4000ms 对本地实例绰绰有余，但这条通道同样服务**远程**实例（经 SSH 隧道 / 低带宽 VPN）。
// 实测 c4g.tun 当天 43 轮探测失败 21 轮（49%），原因全是 `auth timeout`：同一时刻稳定入口上
// 0.07s 的请求里夹着 1.4s / 3.6s / 6.0s 的秒级停顿，把这个门槛反复越过 —— 日志于是每 7s
// 一条成功一条失败，工作台在「实时 / 文件索引」之间横跳。
// 修法：预算可配置，默认值**不变**（不改变本机与健康链路的既有行为）。
test('live-status: RPC 预算可由 HWB_LIVE_RPC_TIMEOUT_MS 覆盖，默认仍是 4000', async () => {
  const { defaultRpcTimeoutMs, LiveStatusReader } = await import('../src/dshhome/live-status.js');
  assert.equal(defaultRpcTimeoutMs({}), 4000, '未配置时必须保持 4000');
  assert.equal(defaultRpcTimeoutMs({ HWB_LIVE_RPC_TIMEOUT_MS: '12000' }), 12000, '配置必须生效');
  // 非法值一律回退默认，绝不因为一个坏环境变量把预算变成 0/NaN（那会让每次探测都立刻超时）。
  for (const bad of ['', 'abc', '0', '-5', 'NaN']) {
    assert.equal(defaultRpcTimeoutMs({ HWB_LIVE_RPC_TIMEOUT_MS: bad }), 4000, `${bad} 应回退 4000`);
  }
  const saved = process.env.HWB_LIVE_RPC_TIMEOUT_MS;
  process.env.HWB_LIVE_RPC_TIMEOUT_MS = '9000';
  try {
    assert.equal(new LiveStatusReader().timeoutMs, 9000, '读取器的默认值必须走环境变量');
  } finally {
    if (saved === undefined) delete process.env.HWB_LIVE_RPC_TIMEOUT_MS;
    else process.env.HWB_LIVE_RPC_TIMEOUT_MS = saved;
  }
  // 显式注入仍然赢过环境变量（调用方与测试都能钉住自己的预算）。
  assert.equal(new LiveStatusReader({ timeoutMs: 1500 }).timeoutMs, 1500);
});

// —— token→cookie 交接的记忆化（2026-09-22，dgx21.tun 实测）——
//
// 原实现每轮 RPC 都重做一次交接（GET ?token= → POST /api/…），在远程实例上就是
// **两个隧道往返**。实测日志里 `auth timeout` 占失败原因 2215 次（远超 `rpc timeout` 226 次）
// —— 大多数轮询死在交接那一段。这两条用例守住：**交接只做一次**，且**cookie 失效能自愈**。

test('live reader: token→cookie 交接只做一次，后续轮询不再打 auth 腿', async (t) => {
  const authCalls = [];
  const rpcCalls = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    if (opts.method !== 'POST') {
      authCalls.push(new URL(url).pathname);
      return new Response(null, { status: 303, headers: { 'Set-Cookie': 'auth=ok; HttpOnly' } });
    }
    rpcCalls.push(new URL(url).pathname);
    return Response.json({ type: 'server-response', result: { value: { items: [{ sessionId: 's1', running: true }] } } });
  });
  const reader = new LiveStatusReader();
  const url = 'http://localhost:3080/?token=secret';
  await reader.read(url, { homeId: 'memo1' });
  await reader.read(url, { homeId: 'memo1' });
  await reader.read(url, { homeId: 'memo1' });
  assert.equal(authCalls.length, 1, `交接只该发生一次（实际 ${authCalls.length} 次）`);
  assert.equal(rpcCalls.length, 3, '每轮仍要真的取一次数据');
});

test('live reader: 记忆的 cookie 失效（401）时清掉记忆并重做一次交接', async (t) => {
  let authCalls = 0;
  let rpcCalls = 0;
  let cookieValid = true;
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    if (opts.method !== 'POST') {
      authCalls += 1;
      return new Response(null, { status: 303, headers: { 'Set-Cookie': `auth=v${authCalls}; HttpOnly` } });
    }
    rpcCalls += 1;
    if (!cookieValid) {
      // 第一轮用旧 cookie → 401；服务端换了密钥后必须能自愈。
      cookieValid = true;
      return new Response('stale cookie', { status: 401 });
    }
    return Response.json({ type: 'server-response', result: { value: { items: [{ sessionId: 's1' }] } } });
  });
  const reader = new LiveStatusReader();
  const url = 'http://localhost:3080/?token=secret';
  // 第一轮：建立记忆
  await reader.read(url, { homeId: 'memo2' });
  assert.equal(authCalls, 1);
  // 让记忆里的 cookie 失效，下一轮应 401 → 清记忆 → 重新交接 → 成功
  cookieValid = false;
  const rows = await reader.read(url, { homeId: 'memo2' });
  assert.ok(rows && rows.length === 1, 'cookie 失效后必须自愈而不是一直失败');
  assert.equal(authCalls, 2, '失效后应重做一次交接');
});

test('live reader: 同一 origin 的不同 token 不串用 cookie 记忆', async (t) => {
  const seenCookies = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    if (opts.method !== 'POST') {
      const tok = new URL(url).searchParams.get('token');
      return new Response(null, { status: 303, headers: { 'Set-Cookie': `auth=${tok}; HttpOnly` } });
    }
    seenCookies.push(opts.headers.Cookie);
    return Response.json({ type: 'server-response', result: { value: { items: [{ sessionId: 's1' }] } } });
  });
  const reader = new LiveStatusReader();
  await reader.read('http://localhost:3080/?token=A', { homeId: 'hA' });
  await reader.read('http://localhost:3080/?token=B', { homeId: 'hB' });
  assert.deepEqual(seenCookies, ['auth=A', 'auth=B'], '不同 token 必须各自交接，不能复用对方的 cookie');
});

// —— 链路自适应的 RPC 预算（2026-09-22）——
//
// 固定 4s 预算对远程实例是**必然失败**：实测经隧道取一次 session.list 要 3.4–7.3s。
// 而远端 dsh 服务端只要 1–5ms ⇒ 这些时间全是链路属性，属可测量量，不该用写死的常数去猜。
test('live reader: 超时预算随实测往返自适应，且本地快链路不受影响', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    if (opts.method !== 'POST') return new Response(null, { status: 303, headers: { 'Set-Cookie': 'auth=ok' } });
    await new Promise((r) => setTimeout(r, 1200));   // 模拟慢链路的一次往返
    return Response.json({ type: 'server-response', result: { value: { items: [{ sessionId: 's1' }] } } });
  });
  const reader = new LiveStatusReader({ timeoutMs: 4000 });
  // 无观测时用配置值
  assert.equal(reader.timeoutFor('k'), 4000);
  await reader.read('http://localhost:3080/', { homeId: 'k' });
  const ewma = reader.latencyOf('k');
  assert.ok(ewma >= 1100, `应记下实测往返（实际 ${ewma}ms）`);
  const budget = reader.timeoutFor('k');
  assert.ok(budget > 4000, `慢链路应放宽预算（实际 ${budget}ms）`);
  assert.ok(budget <= 30_000, '预算必须有上界，不能无限放宽');
  // 本地快链路：往返只有毫秒级 ⇒ 预算不该被放宽（行为与改动前一致）
  const fast = new LiveStatusReader({ timeoutMs: 4000 });
  fast.latency.set('local', 2);
  assert.equal(fast.timeoutFor('local'), 4000, '本地实例的预算必须保持 4000ms 不变');
});

test('live reader: adaptiveTimeout=false 时保持固定预算（逃生舱）', async () => {
  const reader = new LiveStatusReader({ timeoutMs: 4000, adaptiveTimeout: false });
  reader.latency.set('k', 9000);
  assert.equal(reader.timeoutFor('k'), 4000, '关掉自适应后应严格用配置值');
});
