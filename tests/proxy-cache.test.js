import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createProxy } from '../src/control/proxy.js';
// 增量补差默认关闭（见 proxy.js 的 HISTORY_DELTA_ENABLED 注释）：相关用例在 createProxy 上显式打开。
import { createProxyCache } from '../src/control/proxy-cache.js';

// —— 为什么有这些用例（2026-09-14，dgx21.tun 实测）——
//
// 远端 dsh 给插件 bundle 回 `cache-control: no-cache` 且不带 ETag，浏览器每次打开页面
// 都要把这 3.27 MiB 重下一遍（这条 VPN 只有 25–30 KB/s ⇒ 每次约 2 分钟）；会话列表/历史
// 走 POST RPC，浏览器在 HTTP 语义上无法缓存。于是缓存只能做在 hwb 代理这一层。
// 这些用例守住三件事：**该缓存的真缓存（含命中后不再打上游）**、
// **不该缓存的绝不缓存（无指纹的 URL、写类 RPC、鉴权响应）**、**回放不改语义（rpcId 必须换回本次的）**。

const BUNDLE = '/plugins/dsh-drop-any-file/client.js?rev=9eae050df40e';
const BUNDLE_BODY = '/* plugin bundle */'.repeat(64);

function mockUpstream() {
  const hits = new Map();
  const server = createServer((req, res) => {
    const key = `${req.method} ${req.url}`;
    hits.set(key, (hits.get(key) ?? 0) + 1);
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (req.url === BUNDLE) {
        // 远端 0.1.1 的真实形状：no-cache 且没有任何校验器。
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' });
        res.end(BUNDLE_BODY);
        return;
      }
      if (req.url === '/plugins/bar/client.js') {
        // 不带内容指纹的插件 URL：内容可以原地变化 —— 不许缓存。
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
        res.end(`/* bar ${hits.get(key)} */`);
        return;
      }
      if (req.url.startsWith('/api/')) {
        const envelope = JSON.parse(body);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, method: envelope.method, value: { items: [{ sessionId: 's1', running: false }, { sessionId: 's2', running: true }] } } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'auth=1; Path=/' });
      res.end('<html>index</html>');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server,
    base: `http://127.0.0.1:${server.address().port}`,
    hits,
    count: (m, u) => hits.get(`${m} ${u}`) ?? 0,
  })));
}

async function withProxy(up, opts = {}) {
  const cache = opts.cache === undefined ? createProxyCache({ dir: null }) : opts.cache;
  const proxy = await createProxy({ target: up.base, cache, cacheScope: opts.scope ?? 'home-test' });
  return proxy;
}

function rpcBody(method, rpcId, args = { _request: {} }) {
  return JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } });
}

test('proxy 缓存：插件 bundle 第二次打开不再打上游（这就是「每次都要下载」的正解）', async () => {
  const up = await mockUpstream();
  const proxy = await withProxy(up);
  try {
    const r1 = await fetch(`${proxy.url}${BUNDLE}`);
    assert.equal(r1.status, 200);
    assert.equal(await r1.text(), BUNDLE_BODY);
    assert.equal(up.count('GET', BUNDLE), 1);

    const r2 = await fetch(`${proxy.url}${BUNDLE}`);
    assert.equal(r2.status, 200);
    assert.equal(await r2.text(), BUNDLE_BODY);
    assert.equal(up.count('GET', BUNDLE), 1, '第二次必须由本地副本作答');
    assert.equal(r2.headers.get('x-hwb-cache'), 'hit');
    // 上游的 no-cache 策略原样保留（我们不改写上游策略），但**必须**补上校验器 ——
    // 远端 dsh 0.1.1 恰恰是「no-cache 且没有 ETag」，浏览器因此只能整包重下。
    assert.equal(r2.headers.get('cache-control'), 'no-cache');
    assert.ok(r2.headers.get('etag'), '命中回放也要带 ETag，浏览器才能只发一次条件请求');

    // 浏览器拿着我们发的 ETag 回来校验 → 304，且仍然不打上游。
    const etag = r1.headers.get('etag');
    assert.ok(etag, '必须给浏览器一个校验器，否则每次都得重下整包');
    const r3 = await fetch(`${proxy.url}${BUNDLE}`, { headers: { 'if-none-match': etag } });
    assert.equal(r3.status, 304);
    assert.equal(up.count('GET', BUNDLE), 1);
  } finally {
    await proxy.close();
    up.server.close();
  }
});

test('proxy 缓存：无内容指纹的插件 URL 与带 token 的入口一律不缓存', async () => {
  const up = await mockUpstream();
  const proxy = await withProxy(up);
  try {
    await fetch(`${proxy.url}/plugins/bar/client.js`);
    await fetch(`${proxy.url}/plugins/bar/client.js`);
    assert.equal(up.count('GET', '/plugins/bar/client.js'), 2, '没有指纹的 URL 内容可原地变化，绝不能缓存');

    // 鉴权响应（set-cookie）不进缓存：两次都必须是上游的。
    const a = await fetch(`${proxy.url}/`, { redirect: 'manual' });
    await a.text();
    const b = await fetch(`${proxy.url}/`, { redirect: 'manual' });
    await b.text();
    assert.equal(up.count('GET', '/'), 2);
  } finally {
    await proxy.close();
    up.server.close();
  }
});

test('proxy 缓存：只读 RPC 第二次本地作答，且回放的 rpcId 必须是本次请求的', async () => {
  const up = await mockUpstream();
  const proxy = await withProxy(up);
  try {
    const post = (body) => fetch(`${proxy.url}/api/session.list`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    });
    const first = await post(rpcBody('session.list', 'rpc-1'));
    assert.equal(first.status, 200);
    const j1 = await first.json();
    assert.equal(j1.rpcId, 'rpc-1');
    assert.equal(up.count('POST', '/api/session.list'), 1);

    const second = await post(rpcBody('session.list', 'rpc-2'));
    const j2 = await second.json();
    assert.equal(up.count('POST', '/api/session.list'), 1, '第二次必须命中本地缓存');
    assert.equal(j2.rpcId, 'rpc-2', 'rpcId 对不上号时客户端会丢弃响应 —— 回放必须改写它');
    assert.equal(j2.result.value.items[0].sessionId, 's1');
    assert.equal(second.headers.get('x-hwb-cache'), 'rpc-hit');
  } finally {
    await proxy.close();
    up.server.close();
  }
});

test('proxy 缓存：写类 RPC 永不缓存（prompt/create/cancel 每次都到上游）', async () => {
  const up = await mockUpstream();
  const proxy = await withProxy(up);
  try {
    for (const method of ['session.prompt', 'session.create', 'session.cancel', 'session.updateQueue']) {
      for (let i = 0; i < 2; i++) {
        const res = await fetch(`${proxy.url}/api/${method}`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: rpcBody(method, `id-${i}`),
        });
        assert.equal(res.status, 200);
        await res.text();
      }
      assert.equal(up.count('POST', `/api/${method}`), 2, `${method} 不该被缓存或提前返回`);
    }
  } finally {
    await proxy.close();
    up.server.close();
  }
});

test('proxy 缓存：不同实例（cacheScope）之间不串台', async () => {
  const up = await mockUpstream();
  const cache = createProxyCache({ dir: null });
  const a = await createProxy({ target: up.base, cache, cacheScope: 'home-a' });
  const b = await createProxy({ target: up.base, cache, cacheScope: 'home-b' });
  try {
    await (await fetch(`${a.url}${BUNDLE}`)).text();
    await (await fetch(`${b.url}${BUNDLE}`)).text();
    assert.equal(up.count('GET', BUNDLE), 2, '另一个实例必须自己取一份（缓存键按 home 隔离）');
    const again = await fetch(`${a.url}${BUNDLE}`);
    await again.text();
    assert.equal(up.count('GET', BUNDLE), 2, '原实例仍然命中自己的副本');
  } finally {
    await a.close();
    await b.close();
    up.server.close();
  }
});

test('proxy 缓存：TTL 过后先回旧副本（用户不等），后台再刷新', async () => {
  const up = await mockUpstream();
  const cache = createProxyCache({ dir: null, staticTtlMs: 20 });
  const proxy = await createProxy({ target: up.base, cache, cacheScope: 'home-ttl' });
  try {
    const first = await fetch(`${proxy.url}${BUNDLE}`);
    await first.text();
    assert.equal(up.count('GET', BUNDLE), 1);
    await new Promise((r) => setTimeout(r, 40));
    const stale = await fetch(`${proxy.url}${BUNDLE}`);
    assert.equal(await stale.text(), BUNDLE_BODY, '过期也要立刻给旧副本，绝不空等一条慢链路');
    assert.equal(stale.headers.get('x-hwb-cache'), 'stale');
    // 后台刷新是异步的：等它落地后，计数会上升且副本被换新。
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(up.count('GET', BUNDLE), 2, '陈旧副本被使用时必须去后台拉一次');
  } finally {
    await proxy.close();
    up.server.close();
  }
});

test('proxy 缓存：cache=null 时完全退化为透传', async () => {
  const up = await mockUpstream();
  const proxy = await withProxy(up, { cache: null });
  try {
    await (await fetch(`${proxy.url}${BUNDLE}`)).text();
    await (await fetch(`${proxy.url}${BUNDLE}`)).text();
    assert.equal(up.count('GET', BUNDLE), 2);
  } finally {
    await proxy.close();
    up.server.close();
  }
});

test('proxy 缓存：大请求体不进缓存（附件上传不能被当成 RPC 读缓存）', async () => {
  const up = await mockUpstream();
  const proxy = await withProxy(up);
  try {
    // 用 session.list 这个「白名单方法」+ 超长 body 验证上限闸门，而不是靠方法名。
    const big = rpcBody('session.list', 'big', { blob: 'x'.repeat(128 * 1024) });
    for (let i = 0; i < 2; i++) {
      const res = await fetch(`${proxy.url}/api/session.list`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: big,
      });
      assert.equal(res.status, 200);
      await res.text();
    }
    assert.equal(up.count('POST', '/api/session.list'), 2, '超过请求体上限的调用不缓存');
  } finally {
    await proxy.close();
    up.server.close();
  }
});

// —— 命名空间/动词策略（dgx21 的 0.1.1-rc.2 用的是点号命名）——
// 抓包实测远端每次加载都会发 session.list / session.history / workspace.list / llm.providers /
// host.describe 等；而写类方法（session.prompt/respond 等）**绝不能被提前返回**。
test('proxy 缓存：只读形态放行、写类动词一律否决（含 dgx21 的点号命名）', async () => {
  const { isReadOnlyRpc } = await import('../src/control/proxy-cache.js');
  for (const m of ['session.list', 'session.history', 'workspace.list', 'skill.list', 'agentPreset.list',
    'llm.providers', 'host.describe', 'session.models', 'subagent.list', 'commands/list',
    'dynamicCordisRunner/inventory', 'session/list', 'skills/list']) {
    assert.equal(isReadOnlyRpc(m), true, `${m} 是只读，应该被缓存`);
  }
  for (const m of ['session.prompt', 'session.create', 'session.cancel', 'session.updateQueue',
    'session.respond', 'attachment.upload', 'approval.respond', 'session.set', 'skill.install',
    'session.fork', 'session.control', 'workspace.open', 'session.rename', 'dynamicCordisRunner.syncInspectManifest',
    'events.mux', '', null, 'a'.repeat(200)]) {
    assert.equal(isReadOnlyRpc(m), false, `${String(m)} 不该被缓存`);
  }
});

test('proxy 缓存：远端点号命名的只读 RPC（session.history）第二次本地作答', async () => {
  const up = await mockUpstream();
  const proxy = await withProxy(up);
  try {
    const post = (body) => fetch(`${proxy.url}/api/session.history`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    });
    await (await post(rpcBody('session.history', 'h1', { sessionId: 's1' }))).text();
    assert.equal(up.count('POST', '/api/session.history'), 1);
    const res = await post(rpcBody('session.history', 'h2', { sessionId: 's1' }));
    assert.equal(up.count('POST', '/api/session.history'), 1, '同一会话的历史第二次应命中缓存');
    assert.equal((await res.json()).rpcId, 'h2');
    // 不同会话 → 不同键，必须回源。
    await (await post(rpcBody('session.history', 'h3', { sessionId: 's2' }))).text();
    assert.equal(up.count('POST', '/api/session.history'), 2);
  } finally {
    await proxy.close();
    up.server.close();
  }
});

test('proxy 缓存：同一键的后台刷新单飞（慢链路上不能每个陈旧命中都压一条上游请求）', async () => {
  const up = await mockUpstream();
  // 上游故意慢：刷新没结束时再来几个陈旧命中，也只允许有一条刷新在飞。
  const cache = createProxyCache({ dir: null, staticTtlMs: 10, rpcTtlMs: 1, rpcStaleMs: 5_000 });
  const proxy = await createProxy({ target: up.base, cache, cacheScope: 'home-single-flight' });
  try {
    const post = (rpcId) => fetch(`${proxy.url}/api/session.list`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: rpcBody('session.list', rpcId),
    });
    await (await post('a')).text();
    assert.equal(up.count('POST', '/api/session.list'), 1);
    await new Promise((r) => setTimeout(r, 30));
    const before = up.count('POST', '/api/session.list');
    for (let i = 0; i < 5; i++) await (await post(`s${i}`)).text();
    await new Promise((r) => setTimeout(r, 400));
    const during = up.count('POST', '/api/session.list') - before;
    assert.ok(during <= 2, `陈旧命中期间的上游刷新次数应被单飞压住（实测 ${during}）`);
  } finally {
    await proxy.close();
    up.server.close();
  }
});

test('proxy 缓存：preview 的 workspace bundle —— 存原文、本地注入、第二次不再打上游', async () => {
  // 这份 bundle 会被 preview 代理改写（注入「在 Finder 中打开工作区」菜单项），所以它必须
  // 按代理分别处理：缓存里放**未注入**的原文，注入在本地做。dgx21 上它有 115 KB（≈4 s/次）。
  const ANCHOR = 'const workspaceMenuItems = [{';
  const GUARD = 'if (id !== "rename" && id !== "delete") return;';
  const bundle = `/* workspace bundle */\n${ANCHOR}\n${GUARD}\n/* end */`;
  let hits = 0;
  const up = createServer((req, res) => {
    hits++;
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' });
    res.end(bundle);
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const cache = createProxyCache({ dir: null });
  const proxy = await createProxy({ target: `http://127.0.0.1:${up.address().port}`, preview: true, cache, cacheScope: 'home-inject' });
  try {
    const path = '/plugins/@deepseek-ai/dsh-client-ui-workspace/client.js?rev=226eef2a8c75';
    const first = await fetch(proxy.url + path);
    const body1 = await first.text();
    assert.equal(hits, 1);
    assert.equal(body1.includes('hwb-finder'), true, '注入必须发生');
    assert.equal(first.headers.get('cache-control'), 'no-store', '注入过的内容只属于这条 preview 链路');

    const second = await fetch(proxy.url + path);
    const body2 = await second.text();
    assert.equal(hits, 1, '第二次必须由本地原文注入而来，不再打上游');
    assert.equal(second.headers.get('x-hwb-cache'), 'hit');
    assert.equal(body2, body1, '本地注入的结果与首次逐字节一致');
  } finally {
    await proxy.close();
    up.close();
  }
});

// —— 会话历史（`session.history`）是最大的一块 ——
// 实测 dgx21：一个会话 50 条消息的窗口 = 8–10 MiB 原始事件日志（gzip 后 ~0.5–0.9 MiB，
// 25–30 KB/s 的链路上要 20–35 秒）。所以：**已结束**的会话用长 TTL（历史不可变），
// **正在跑**的会话用短窗口（否则界面会停在旧快照上）。
test('proxy 缓存：已结束会话的历史走长 TTL，第二次打开是本地回', async () => {
  const up = await mockUpstream();
  const cache = createProxyCache({ dir: null, historyTtlMs: 60_000, historyStaleMs: 3_600_000 });
  const proxy = await createProxy({ target: up.base, cache, cacheScope: 'home-hist' });
  try {
    const post = (path, body) => fetch(`${proxy.url}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    });
    // 页面先拉 session.list：其中 s1 已结束、s2 正在跑。
    await (await post('/api/session.list', rpcBody('session.list', 'l1'))).text();
    const history = (sid, rpcId) => post('/api/session.history', rpcBody('session.history', rpcId, { sessionId: sid, maxMessages: 50 }));

    await (await history('s1', 'h1')).text();
    assert.equal(up.count('POST', '/api/session.history'), 1);
    await new Promise((r) => setTimeout(r, 30));   // 远超 rpcTtlMs(默认 3s 之外? 不 —— 这里用 30ms 只是为了错开写入时刻)
    const again = await history('s1', 'h2');
    assert.equal(up.count('POST', '/api/session.history'), 1, '已结束会话的历史第二次必须本地回（长 TTL）');
    assert.equal(again.headers.get('x-hwb-cache'), 'rpc-hit');
  } finally {
    await proxy.close();
    up.server.close();
  }
});

test('proxy 缓存：会话一旦在跑，长 TTL 立刻降级为短窗口（界面不能停在旧快照上）', async () => {
  let running = false;
  const hits = new Map();
  const up = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      hits.set(req.url, (hits.get(req.url) ?? 0) + 1);
      const env = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      if (env.method === 'session.list') {
        res.end(JSON.stringify({ type: 'server-response', rpcId: env.rpcId, result: { value: { items: [{ sessionId: 's1', running }] } } }));
        return;
      }
      res.end(JSON.stringify({ type: 'server-response', rpcId: env.rpcId, result: { ok: true, value: { events: [{ event: { seq: 1 } }], hasMore: false } } }));
    });
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const cache = createProxyCache({ dir: null, rpcTtlMs: 10, rpcStaleMs: 20, historyTtlMs: 3_600_000, historyStaleMs: 86_400_000 });
  const proxy = await createProxy({ target: `http://127.0.0.1:${up.address().port}`, cache, cacheScope: 'home-hist-run' });
  try {
    const post = (path, body) => fetch(`${proxy.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    await (await post('/api/session.list', rpcBody('session.list', 'l1'))).text();      // s1 已结束
    await (await post('/api/session.history', rpcBody('session.history', 'h1', { sessionId: 's1' }))).text();
    assert.equal(hits.get('/api/session.history'), 1);

    running = true;                                                                     // 会话恢复运行
    await new Promise((r) => setTimeout(r, 30));                                        // 让 session.list 越过短 TTL
    await (await post('/api/session.list', rpcBody('session.list', 'l2'))).text();
    await new Promise((r) => setTimeout(r, 60));                                        // 超出短窗口（含后台刷新）
    const res = await post('/api/session.history', rpcBody('session.history', 'h2', { sessionId: 's1' }));
    await res.text();
    assert.equal(hits.get('/api/session.history'), 2, '会话在跑 → 旧的「长 TTL」副本不能再被当成新鲜的');
  } finally {
    await proxy.close();
    up.close();
  }
});

test('proxy 缓存：大 RPC 响应必须先发头再流式传输（否则 30s 头超时会把历史会话打成 504）', async () => {
  // 实测 dgx21：一个会话的 session.history 有 8–10 MiB，链路上要几十秒。若代理先攒完整个响应
  // 再写响应头，`upstream response timeout`（默认 30s）会在中途把请求打成 504 —— 用户拿不到历史。
  const up = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const env = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const payload = JSON.stringify({ type: 'server-response', rpcId: env.rpcId, result: { ok: true, value: { events: [], pad: 'x'.repeat(256 * 1024) } } });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.write(payload.slice(0, 1024));
      // 头已经发出，正文慢慢来：模拟慢链路
      setTimeout(() => res.end(payload.slice(1024)), 150);
    });
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const cache = createProxyCache({ dir: null });
  // 超时给足正文间隙（150ms），但要小到能证明「头不是等正文攒完才发的」。
  const proxy = await createProxy({ target: `http://127.0.0.1:${up.address().port}`, cache, cacheScope: 'home-stream', requestTimeoutMs: 400 });
  try {
    const started = Date.now();
    const res = await fetch(`${proxy.url}/api/session.history`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: rpcBody('session.history', 's1', { sessionId: 's1' }),
    });
    const headersMs = Date.now() - started;
    assert.equal(res.status, 200, '不能是 504');
    assert.ok(headersMs < 120, `响应头必须立刻到（实测 ${headersMs}ms），不能等正文攒完（正文还要 150ms）`);
    const body = await res.json();
    assert.equal(body.result.value.pad.length, 256 * 1024);
    // 流完之后仍要进缓存：第二次是本地回。
    const again = await fetch(`${proxy.url}/api/session.history`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: rpcBody('session.history', 's2', { sessionId: 's1' }),
    });
    assert.equal(again.headers.get('x-hwb-cache'), 'rpc-hit');
    assert.equal((await again.json()).rpcId, 's2');
  } finally {
    await proxy.close();
    up.close();
  }
});

// —— 增量问题：dsh 的历史接口没有「向前增量」——
// 实测（远端 0.1.1-rc.2 源码 dsh-host-apiproxy/lib/index.js:2557）：`session.history` 只接受
// `{sessionId, beforeSeq, maxMessages}` —— `beforeSeq` 是**往回翻**更早的内容；不给就是切
// 「最新尾部窗口」（historyCutOf 取整条事件日志再 paginate）。**没有 sinceSeq/afterSeq**。
// 而事件流 `/api/events.host` 开流时 payload 是 `{}`（没有游标），只推订阅之后的新事件。
// 结论：一份陈旧的历史窗口**补不回**中间那段事件 —— 所以运行中的会话连陈旧副本都不能供。
test('proxy 缓存：运行中的会话连陈旧副本也不供（事件流没有游标，补不回中间那段）', async () => {
  const up = await mockUpstream();
  // 先用「已结束」把它灌成长 TTL 条目，再让它变成运行中。
  const cache = createProxyCache({ dir: null, rpcTtlMs: 10, runningStaleMs: 0, historyTtlMs: 600_000, historyStaleMs: 600_000 });
  const proxy = await createProxy({ target: up.base, cache, cacheScope: 'home-nostale' });
  try {
    const post = (p, b) => fetch(`${proxy.url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: b });
    await (await post('/api/session.list', rpcBody('session.list', 'l1'))).text();          // s1 已结束 / s2 在跑
    await (await post('/api/session.history', rpcBody('session.history', 'h1', { sessionId: 's2' }))).text();
    assert.equal(up.count('POST', '/api/session.history'), 1);
    await new Promise((r) => setTimeout(r, 40));                                            // 超出短 TTL
    await (await post('/api/session.history', rpcBody('session.history', 'h2', { sessionId: 's2' }))).text();
    assert.equal(up.count('POST', '/api/session.history'), 2, '运行中的会话必须回源（默认不供陈旧副本）');
  } finally {
    await proxy.close();
    up.server.close();
  }
});

test('proxy 缓存：会话运行状态未知时按保守档处理（不拿旧观测批准长 TTL）', async () => {
  const up = await mockUpstream();
  let clock = 1_000_000;
  const cache = createProxyCache({ dir: null, now: () => clock, rpcTtlMs: 10, runningTrustMs: 100, historyTtlMs: 600_000, historyStaleMs: 600_000 });
  const proxy = await createProxy({ target: up.base, cache, cacheScope: 'home-unknown' });
  try {
    const post = (p, b) => fetch(`${proxy.url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: b });
    await (await post('/api/session.list', rpcBody('session.list', 'l1'))).text();          // 观测 s1=已结束
    assert.equal(cache.isRunning('s1'), false);
    await (await post('/api/session.history', rpcBody('session.history', 'h1', { sessionId: 's1' }))).text();
    assert.equal(up.count('POST', '/api/session.history'), 1);

    clock += 1_000;                                                                          // 观测过期（> runningTrustMs）
    assert.equal(cache.isRunning('s1'), undefined, '过期的观测必须变成「未知」');
    await (await post('/api/session.history', rpcBody('session.history', 'h2', { sessionId: 's1' }))).text();
    assert.equal(up.count('POST', '/api/session.history'), 2, '未知 ≠ 已结束：不能拿几天前的观测批准长 TTL');
  } finally {
    await proxy.close();
    up.server.close();
  }
});

// —— 增量补差：hwb 用 dsh-history-delta 插件的 /api/histdelta/history 把「重传整段」变成「只补差」——
// 实测（dgx21 隔离实例）：大会话整段 8 732 706 B；带 afterSeq 的增量 403 934 B。
// 这里用假上游同时实现两个端点，验证：第二次打开只传增量、回给浏览器的仍是**完整窗口**、
// 不连续时退回整段、插件不在时不反复白试。
function historyUpstream({ withDelta = true } = {}) {
  const calls = { full: 0, delta: 0 };
  let log = Array.from({ length: 60 }, (_, i) => ({ event: { type: 'chunk', seq: 100 + i } }));
  const page = (from, to) => log.filter((r) => r.event.seq >= from && r.event.seq <= to);
  const value = (events) => ({ events, hasMore: true, projections: { asOfSeq: events.at(-1)?.event.seq ?? 0 } });
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const env = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (req.url === '/api/session.list') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ rpcId: env.rpcId, result: { ok: true, value: { items: [{ sessionId: 's1', running: false }] } } }));
        return;
      }
      if (req.url === '/api/session.history') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        calls.full += 1;
        const max = env.payload.maxMessages ?? 50;
        res.end(JSON.stringify({ rpcId: env.rpcId, result: { ok: true, value: value(log.slice(-Math.max(max, 1))) } }));
        return;
      }
      if (req.url === '/api/histdelta/history') {
        calls.delta += 1;                                   // 计数「探测/使用次数」，与是否支持无关
        if (!withDelta) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        const afterSeq = env.payload.args.afterSeq;
        const max = env.payload.args.maxMessages ?? 50;
        // 与上游同构：窗口 = **最新 maxMessages 条消息**（这里一条事件当一条消息），不是整条日志。
        const window = value(log.slice(-Math.max(max, 1)));
        const kept = window.events.filter((r) => r.event.seq > afterSeq);
        res.end(JSON.stringify({
          rpcId: env.rpcId,
          result: {
            ok: true,
            value: {
              ...value(kept),
              afterSeq,
              windowFirstSeq: window.events[0].event.seq,
              windowLastSeq: window.events.at(-1).event.seq,
            },
          },
        }));
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server, base: `http://127.0.0.1:${server.address().port}`, calls,
    grow: (n) => { const last = log.at(-1).event.seq; for (let i = 1; i <= n; i++) log.push({ event: { type: 'chunk', seq: last + i } }); },
  })));
}

test('proxy 增量：第二次打开会话只传增量，但回给浏览器的仍是完整窗口', async () => {
  const up = await historyUpstream();
  const cache = createProxyCache({ dir: null, rpcTtlMs: 1, rpcStaleMs: 1, historyTtlMs: 1, historyStaleMs: 1 });
  const proxy = await createProxy({ target: up.base, cache, cacheScope: 'home-delta', historyDelta: true });
  try {
    const ask = (rpcId) => fetch(`${proxy.url}/api/session.history`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: rpcBody('session.history', rpcId, { sessionId: 's1', maxMessages: 50 }),
    });
    const first = await ask('a');
    const firstBody = await first.json();
    assert.equal(up.calls.full, 1);
    assert.equal(firstBody.result.value.events.length, 50);

    up.grow(5);                                     // 会话又长了 5 个 seq
    await new Promise((r) => setTimeout(r, 20));    // 让本地副本过期（stale 窗口也设成 1ms）
    const second = await ask('b');
    const secondBody = await second.json();
    assert.equal(up.calls.delta, 1, '必须走增量通道');
    assert.equal(up.calls.full, 1, '不能整段重取');
    assert.equal(second.headers.get('x-hwb-cache'), 'rpc-delta');
    assert.equal(secondBody.rpcId, 'b');
    // 回给浏览器的必须是「上游此刻会给的完整窗口」：55 条里的最后 50 条
    assert.deepEqual(
      secondBody.result.value.events.map((r) => r.event.seq),
      Array.from({ length: 50 }, (_, i) => 115 + i),   // 日志 100..164 的最后 50 条
    );
    assert.equal('windowFirstSeq' in secondBody.result.value, false, '内部字段不能漏给客户端');
  } finally {
    await proxy.close();
    up.server.close();
  }
});

test('proxy 增量：插件不在（404）时回退整段，且不反复白试', async () => {
  const up = await historyUpstream({ withDelta: false });   // 有 history、没有 histdelta 端点
  const cache = createProxyCache({ dir: null, rpcTtlMs: 1, rpcStaleMs: 1, historyTtlMs: 1, historyStaleMs: 1 });
  const proxy = await createProxy({ target: up.base, cache, cacheScope: 'home-nodelta', historyDelta: true });
  try {
    const ask = (rpcId) => fetch(`${proxy.url}/api/session.history`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: rpcBody('session.history', rpcId, { sessionId: 's1', maxMessages: 50 }),
    });
    const first = await ask('a'); await first.text();
    await new Promise((r) => setTimeout(r, 20));
    const second = await ask('b'); await second.text();
    await new Promise((r) => setTimeout(r, 20));    // 让本地副本过期，否则第三次会被本地命中（那也是对的，但不是这条用例要证的）
    const third = await ask('c'); await third.text();
    assert.equal(up.calls.full, 3, '不支持增量时每次都走整段（正确优先）');
    assert.equal(up.calls.delta, 1, '探测一次 404 后就该记住，不再白打');
  } finally {
    await proxy.close();
    up.server.close();
  }
});

test('proxy 增量：陈旧副本的后台刷新也只传增量（否则「用到旧副本」本身就会触发整段重取）', async () => {
  const up = await historyUpstream();
  // 新鲜窗口 1ms、陈旧窗口给足：让第二次请求走「先回旧副本 + 后台刷新」这条路。
  const cache = createProxyCache({ dir: null, rpcTtlMs: 1, rpcStaleMs: 60_000, historyTtlMs: 1, historyStaleMs: 60_000 });
  const proxy = await createProxy({ target: up.base, cache, cacheScope: 'home-delta-refresh', historyDelta: true });
  try {
    const ask = (rpcId) => fetch(`${proxy.url}/api/session.history`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: rpcBody('session.history', rpcId, { sessionId: 's1', maxMessages: 50 }),
    });
    // 先让代理知道 s1 已结束（真实页面每次加载都会拉 session.list）——否则按保守档处理，
    // 陈旧副本不会被供出（那也对，但不是这条用例要证的路径）。
    await (await fetch(`${proxy.url}/api/session.list`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: rpcBody('session.list', 'l1', {}),
    })).text();
    await (await ask('a')).text();
    assert.equal(up.calls.full, 1);
    up.grow(3);
    await new Promise((r) => setTimeout(r, 20));
    const stale = await ask('b');
    assert.equal(stale.headers.get('x-hwb-cache'), 'rpc-stale', '第二次应立刻回旧副本');
    await stale.text();
    await new Promise((r) => setTimeout(r, 150));            // 等后台刷新
    assert.equal(up.calls.delta, 1, '后台刷新必须走增量');
    assert.equal(up.calls.full, 1, '后台刷新不能整段重取');
    // 刷新后缓存里是新窗口：随后的请求从新的 lastSeq 继续补差。
    const third = await ask('c');
    const body = await third.json();
    assert.deepEqual(body.result.value.events.map((r) => r.event.seq), Array.from({ length: 50 }, (_, i) => 113 + i));
  } finally {
    await proxy.close();
    up.server.close();
  }
});
