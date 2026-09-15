import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createProxy } from '../src/control/proxy.js';
import { createProxyCache } from '../src/control/proxy-cache.js';

// 模拟一个「dsh web」上游: `/?token=good` → 303+set-cookie; 带 cookie 的 `/` → 200 index;
// `/plugins/...` → 200 插件; 无 cookie 的 `/` → 401。
function mockUpstream() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const cookie = req.headers.cookie || '';
    if (url.pathname === '/plugins/') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end('/* plugin */');
      return;
    }
    if (url.searchParams.get('token') === 'good') {
      res.writeHead(303, { location: '/', 'set-cookie': 'dsh-auth-test=ok; Path=/; HttpOnly' });
      res.end();
      return;
    }
    if (cookie.includes('dsh-auth-test=ok')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><title>DeepSeek Harness</title></html>');
      return;
    }
    res.writeHead(401, { 'content-type': 'text/plain' });
    res.end('auth required');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

test('proxy: 根路径 1:1 转发 token 握手、cookie、plugins 绝对路径', async () => {
  const up = await mockUpstream();
  const prox = await createProxy({ target: up.base });
  try {
    // token 握手 → 303 + set-cookie(经代理)
    const r1 = await fetch(`${prox.url}/?token=good`, { redirect: 'manual' });
    assert.equal(r1.status, 303);
    const sc = r1.headers.get('set-cookie') || '';
    assert.equal(sc.includes('dsh-auth-test=ok'), true);

    // 带 cookie 访问根 → 200 index
    const r2 = await fetch(`${prox.url}/`, { redirect: 'manual', headers: { cookie: sc.split(';')[0] } });
    assert.equal(r2.status, 200);
    assert.equal((await r2.text()).includes('<title>DeepSeek Harness</title>'), true);

    // 根绝对路径 /plugins/ 也透传
    const r3 = await fetch(`${prox.url}/plugins/`);
    assert.equal(r3.status, 200);
    assert.equal((await r3.text()).includes('plugin'), true);

    // 无 cookie → 401(原样回传)
    const r4 = await fetch(`${prox.url}/`, { redirect: 'manual' });
    assert.equal(r4.status, 401);
  } finally {
    await prox.close();
    up.server.close();
  }
});

test('proxy: close 后不再接受连接', async () => {
  const up = await mockUpstream();
  const prox = await createProxy({ target: up.base });
  await prox.close();
  await assert.rejects(() => fetch(`${prox.url}/`, { signal: AbortSignal.timeout(1500) }));
  up.server.close();
});

test('proxy: disconnect closes an active SSE stream without waiting for upstream to finish', async () => {
  const upstream = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': connected\n\n');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = await createProxy({ target: `http://127.0.0.1:${upstream.address().port}` });
  const response = await fetch(proxy.url);
  const reader = response.body.getReader();
  await reader.read();
  try {
    await proxy.close();
    await assert.rejects(reader.read());
  } finally {
    upstream.closeAllConnections();
    upstream.close();
  }
});

test('preview proxy injects bridge only in authenticated HTML, preserves original proxy', async () => {
  const up = await mockUpstream();
  const prox = await createProxy({ target: up.base, preview: true });
  try {
    const denied = await fetch(prox.url);
    assert.equal(denied.status, 401);
    assert.equal(await denied.text(), 'auth required');
    const auth = await fetch(`${prox.url}/?token=good`, { redirect: 'manual' });
    assert.equal(auth.status, 303);
    const html = await fetch(prox.url, { headers: { cookie: auth.headers.get('set-cookie').split(';')[0] } });
    const htmlText = await html.text();
    assert.match(htmlText, /__hwb\/preview-bridge.js/);
    // 主题脚本必须**一起**注入：它是「hwb 切主题 → 已打开的 dsh 页面立刻换肤」的那条腿，
    // 漏注入不会报错、只表现为「主题切换要等 dsh 自己热重载」，所以在这里钉住它。
    assert.match(htmlText, /__hwb\/dsh-theme\.js/);
    assert.equal(html.headers.get('cache-control'), 'no-store');
    const bridge = await fetch(`${prox.url}/__hwb/preview-bridge.js`);
    assert.match(await bridge.text(), /hwb:file-preview/);
    const theme = await fetch(`${prox.url}/__hwb/dsh-theme.js`);
    assert.match(await theme.text(), /hwb:theme/);
    assert.equal(theme.headers.get('cache-control'), 'no-store', '主题脚本绝不能进浏览器缓存');
    assert.equal(await (await fetch(`${prox.url}/plugins/`)).text(), '/* plugin */');
  } finally { await prox.close(); up.server.close(); }
});

test('proxy: immutable browser caching is limited to versioned static responses', async (t) => {
  const cacheControl = 'private, max-age=31536000, immutable';
  const asset = '/assets/index-BNsW4eBh.js';
  const combo = '/plugins/??@deepseek-ai/dsh-client-ui-workspace/client.js,dsh-session-deeplink/client.js&rev=012345abcdef';
  let responseHeaders, responseStatus;
  const upstream = createServer((_req, res) => {
    res.writeHead(responseStatus, responseHeaders);
    res.end('static response bytes');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  // 本地读取缓存（proxy-cache）在同一个 URL 上会记住第一次的响应，而这个用例刻意用同一个 URL
  // 逐场景换响应来验证头策略 —— 所以每个场景前必须清空缓存，否则它验证的是「上一个场景」。
  const cache = createProxyCache({ dir: null });
  const proxy = await createProxy({ target: `http://127.0.0.1:${upstream.address().port}`, preview: true, cache });
  t.after(async () => { await proxy.close(); upstream.closeAllConnections(); upstream.close(); });
  const cases = [
    { name: 'hashed script', path: asset, cache: cacheControl },
    { name: 'HEAD metadata', path: asset, method: 'HEAD', cache: cacheControl },
    { name: 'hashed CSS', path: '/assets/vendor-BNsW4eBh.css', type: 'text/css; charset=utf-8', cache: cacheControl },
    { name: 'nested hashed script', path: '/assets/langs/bash-BNsW4eBh.js', cache: cacheControl },
    { name: 'hashed font', path: '/assets/fonts/KaTeX_Main-Italic-flOr_0UB.woff2', type: 'font/woff2', cache: cacheControl },
    { name: 'hashed image', path: '/assets/logo-BNsW4eBh.svg', type: 'image/svg+xml', cache: cacheControl },
    { name: 'content-addressed plugin combo', path: combo, cache: cacheControl },
    { name: 'HTML entry', path: '/', type: 'text/html', cache: 'no-store' },
    { name: 'HTML under asset path', path: asset, type: 'text/html' },
    { name: 'JSON under asset path', path: asset, type: 'application/json' },
    { name: 'wrong type for extension', path: '/assets/theme-BNsW4eBh.css' },
    { name: 'unknown MIME', path: asset, type: 'application/octet-stream' },
    { name: 'missing MIME', path: asset, type: null },
    { name: 'API path with apparent hash', path: '/api/index-BNsW4eBh.js' },
    { name: 'unversioned asset', path: '/assets/index.js' },
    { name: 'short asset suffix', path: '/assets/index-latest.js' },
    { name: 'query-bearing asset', path: asset + '?language=en' },
    { name: 'token-bearing asset', path: asset + '?token=private' },
    { name: 'encoded token query', path: asset + '?%74oken=private' },
    { name: 'unversioned plugin', path: '/plugins/@deepseek-ai/dsh-client-ui-workspace/client.js' },
    { name: 'arbitrary plugin rev query', path: '/plugins/example/client.js?rev=012345abcdef' },
    { name: 'unversioned combo', path: combo.split('&rev=')[0] },
    { name: 'nonce combo revision', path: combo.replace('012345abcdef', 'nonce-17') },
    { name: 'combo with extra query', path: combo + '&token=private' },
    { name: 'combo source map', path: '/plugins/??example/client.js.map&rev=012345abcdef', type: 'application/json' },
    { name: 'combo with directory traversal', path: '/plugins/??../example/client.js&rev=012345abcdef' },
    { name: 'POST to hashed asset', path: asset, method: 'POST' },
    { name: 'not found', path: asset, status: 404 },
    { name: 'unauthorized', path: asset, status: 401 },
    { name: 'upstream error', path: asset, status: 503 },
    { name: 'partial response', path: asset, status: 206 },
    { name: 'session-setting response', path: asset, headers: { 'set-cookie': 'session=secret; HttpOnly' } },
    { name: 'no-store upstream', path: asset, headers: { 'cache-control': 'no-store' }, cache: 'no-store' },
    { name: 'no-cache upstream', path: combo, headers: { 'cache-control': 'private, no-cache' }, cache: 'private, no-cache' },
    { name: 'short lifetime upstream', path: asset, headers: { 'cache-control': 'private, max-age=60' }, cache: 'private, max-age=60' },
    { name: 'legacy upstream policy', path: asset, headers: { pragma: 'no-cache' } },
    { name: 'explicit expiry upstream', path: asset, headers: { expires: 'Thu, 01 Jan 1970 00:00:00 GMT' } },
    { name: 'uncacheable variance', path: asset, headers: { vary: '*' } },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      cache.clear();
      responseStatus = scenario.status || 200;
      responseHeaders = { ...(scenario.type === null ? {} : { 'content-type': scenario.type || 'text/javascript; charset=utf-8' }), ...scenario.headers };
      const response = await fetch(proxy.url + scenario.path, { method: scenario.method || 'GET' });
      assert.equal(response.status, responseStatus);
      assert.equal(response.headers.get('cache-control'), scenario.cache || null);
      if (scenario.headers?.['set-cookie']) assert.equal(response.headers.get('set-cookie'), scenario.headers['set-cookie']);
      await response.arrayBuffer();
    });
  }
});

test('proxy: 内容寻址静态资源的本地缓存（含 preview 链路），且鉴权响应绝不进缓存', async (t) => {
  // 行为变更（2026-09-14）：这里的旧版本断言「代理只给浏览器策略，从不复用响应体」。
  // 远端 dsh 给插件 bundle 回 `cache-control: no-cache` 且不带任何校验器，浏览器没有任何
  // 复用依据 —— 每开一次页面就把 3.27 MiB 重下一遍（实测链路 25–30 KB/s，约 2 分钟/次）。
  // 所以代理现在会**本地存一份**内容寻址的静态资源（URL 自带内容指纹），这正是本次修复的核心。
  // 代价与边界：命中时不再回源，因此响应体必须与请求者无关 —— 带 set-cookie 的响应、以及
  // 非内容寻址的 URL 仍然一律不缓存（见 tests/proxy-cache.test.js）。
  let requests = 0;
  const upstream = createServer((req, res) => {
    requests++;
    res.writeHead(200, { 'content-type': 'application/javascript', etag: '"asset-revision"', vary: 'Accept-Encoding' });
    res.end(JSON.stringify({ path: req.url, cookie: req.headers.cookie }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const original = await createProxy({ target: `http://127.0.0.1:${upstream.address().port}` });
  const preview = await createProxy({ target: original.url, preview: true });
  t.after(async () => { await preview.close(); await original.close(); upstream.closeAllConnections(); upstream.close(); });
  const path = '/assets/vendor-BNsW4eBh.js';
  const first = await fetch(preview.url + path, { headers: { cookie: 'user=one' } });
  assert.equal(first.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  assert.equal(first.headers.get('etag'), '"asset-revision"', '上游 ETag 必须原样保留（不覆盖成 hwb 自己的）');
  assert.equal(first.headers.get('vary'), 'Accept-Encoding');
  assert.deepEqual(await first.json(), { path, cookie: 'user=one' });
  const hitsAfterFirst = requests;

  const second = await fetch(preview.url + path, { headers: { cookie: 'user=two' } });
  assert.equal(second.headers.get('x-hwb-cache'), 'hit');
  assert.equal(second.headers.get('etag'), '"asset-revision"');
  assert.deepEqual(await second.json(), { path, cookie: 'user=one' }, '命中即复用副本（内容寻址 ⇒ 与请求者无关）');
  assert.equal(requests, hitsAfterFirst, '第二次必须由本地副本作答，不再打上游');

  // 另一个指纹 → 另一份内容，必须回源。
  const other = await fetch(preview.url + '/assets/vendor-C0xS9mPB.js');
  await other.json();
  assert.equal(requests, hitsAfterFirst + 1);
});

// 目标协议/URL 两条守卫在套件里从没被走到过（审查指出：把协议检查删掉，整套仍然全绿）。
// 它们守的是「代理只转发 http 目标」这个前提：`retarget` 只在同一个 registry 数据上被调用，
// 所以危害有限，但**前提本身**没人守 —— 一旦上游传进 https/ftp（或将来支持 https 的 dsh），
// 代理会静默地去连一个它不支持的目标。
test('createProxy: 非 http 目标与非法 URL 必须被拒绝', async () => {
  const { createProxy } = await import('../src/control/proxy.js');
  await assert.rejects(() => createProxy({ target: 'https://example.invalid:3080' }), /only http target supported/);
  await assert.rejects(() => createProxy({ target: 'not a url' }), /invalid target/);
  // 对照：http 目标可以正常建起来，且 retarget 同样只接受 http
  const proxy = await createProxy({ target: 'http://127.0.0.1:9' });
  try {
    assert.throws(() => proxy.retarget('https://example.invalid'), /only http target supported/);
  } finally {
    await proxy.close();
  }
});

// —— 上游瞬时失败重试（2026-09-14）——
//
// 动机（实测）：经 dgx21.tun 的隧道带宽很差，dsh 前端启动要并发拉约 10 个插件 bundle，
// 无头 Chrome 抓包显示其中若干会拿到 `proxy: upstream error — socket hang up`（502），
// 而同一 URL 随后单发 curl 又是 200 —— 纯瞬时失败。插件加载器对任何一次失败都会整体报
// "Failed to load plugins"，浏览器自己又不会重试，于是整个 UI 打不开。
function flakyUpstream(body = 'second try ok') {
  let calls = 0;
  const server = createServer((req, res) => {
    calls += 1;
    if (calls === 1) { req.socket.destroy(); return; } // 第一次：连接被掐断（隧道瞬时抽风）
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(body);
  });
  return { server, calls: () => calls };
}

test('proxy: GET 遇上游瞬时断连会重试一次并成功（浏览器不会自己重试）', async (t) => {
  const up = flakyUpstream();
  await new Promise((resolve) => up.server.listen(0, '127.0.0.1', resolve));
  const proxy = await createProxy({ target: `http://127.0.0.1:${up.server.address().port}` });
  t.after(async () => { await proxy.close(); up.server.closeAllConnections(); up.server.close(); });

  const res = await fetch(`${proxy.url}/plugins/x/client.js?rev=abc`);
  assert.equal(res.status, 200, '瞬时失败必须被一次重试救回来');
  assert.equal(await res.text(), 'second try ok');
  assert.equal(up.calls(), 2, '恰好重试一次');
});

test('proxy: POST 不重试（有副作用且带请求体）', async (t) => {
  const up = flakyUpstream();
  await new Promise((resolve) => up.server.listen(0, '127.0.0.1', resolve));
  const proxy = await createProxy({ target: `http://127.0.0.1:${up.server.address().port}` });
  t.after(async () => { await proxy.close(); up.server.closeAllConnections(); up.server.close(); });

  const res = await fetch(`${proxy.url}/api/rpc`, { method: 'POST', body: '{"a":1}' });
  assert.equal(res.status, 502);
  assert.match(await res.text(), /upstream error/);
  assert.equal(up.calls(), 1, 'POST 绝不能被重放');
});

test('proxy: 上游持续失败时仍然只重试一次，然后如实报 502', async (t) => {
  let calls = 0;
  const up = createServer((req) => { calls += 1; req.socket.destroy(); });
  await new Promise((resolve) => up.listen(0, '127.0.0.1', resolve));
  const proxy = await createProxy({ target: `http://127.0.0.1:${up.address().port}` });
  t.after(async () => { await proxy.close(); up.closeAllConnections(); up.close(); });

  const res = await fetch(`${proxy.url}/plugins/x/client.js`);
  assert.equal(res.status, 502);
  assert.match(await res.text(), /upstream error/);
  assert.equal(calls, 2, '最多两次尝试，不做无限重试');
});

// —— 上游并发上限：直接决定占用几个 ssh channel（2026-09-14）——
//
// 远端 sshd 默认 MaxSessions 10，而 hwb 全部流量复用一条 master：浏览器并发 + hwb 自身轮询
// 一起越过 10 时，多出来的 channel 会被远端拒绝（本侧表现为 socket hang up → 502 →
// "Failed to load plugins"）。故代理用一个自带上限的 keep-alive 连接池把并发压下去。
test('proxy: 并发请求共用有限的上游连接（不超过 HWB_PROXY_MAX_SOCKETS）', async (t) => {
  let live = 0, peak = 0;
  const upstream = createServer((_req, res) => {
    live += 1; peak = Math.max(peak, live);
    setTimeout(() => { live -= 1; res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); }, 150);
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = await createProxy({ target: `http://127.0.0.1:${upstream.address().port}` });
  t.after(async () => { await proxy.close(); upstream.closeAllConnections(); upstream.close(); });

  const results = await Promise.all(Array.from({ length: 9 }, () => fetch(`${proxy.url}/p`).then((r) => r.status)));
  assert.deepEqual(results, Array(9).fill(200), '排队不能丢请求');
  assert.equal(peak, Number(process.env.HWB_PROXY_MAX_SOCKETS || 3), `上游并发峰值应为 3（实际 ${peak}）`);
});

test('proxy: close 时释放池里的空闲上游连接（别白占远端 channel 名额）', async (t) => {
  let connections = 0;
  const upstream = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); });
  upstream.on('connection', (socket) => { connections += 1; socket.on('close', () => { connections -= 1; }); });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const proxy = await createProxy({ target: `http://127.0.0.1:${upstream.address().port}` });

  await fetch(`${proxy.url}/p`);
  assert.equal(connections, 1, 'keep-alive：一条连接承载多次请求');
  await proxy.close();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(connections, 0, 'close 必须把空闲上游连接也拆掉');
});

test('proxy: long-lived SSE streams do not starve page and auth requests', async (t) => {
  const upstream = createServer((req, res) => {
    if (req.url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': ready\n\n');
    } else res.end('page');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const inner = await createProxy({ target: `http://127.0.0.1:${upstream.address().port}` });
  const outer = await createProxy({ target: inner.url, preview: true });
  const abort = new AbortController();
  t.after(async () => {
    abort.abort();
    await outer.close(); await inner.close();
    upstream.closeAllConnections(); upstream.close();
  });
  const streams = [];
  for (let i = 0; i < 3; i++) {
    const response = await fetch(`${outer.url}/events`, { signal: abort.signal });
    const reader = response.body.getReader();
    await reader.read();
    streams.push(reader);
  }
  const page = await fetch(outer.url, { signal: AbortSignal.timeout(1200) });
  assert.equal(await page.text(), 'page');
  assert.equal(streams.length, 3);
});

test('proxy: silent upstreams time out and release capacity for later requests', async (t) => {
  let posts = 0;
  const upstream = createServer((req, res) => {
    if (req.url === '/hang') { posts++; req.resume(); }
    else res.end('recovered');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = await createProxy({ target: `http://127.0.0.1:${upstream.address().port}`, requestTimeoutMs: 80 });
  t.after(async () => { await proxy.close(); upstream.closeAllConnections(); upstream.close(); });
  const failures = await Promise.all(Array.from({ length: 4 }, () => fetch(`${proxy.url}/hang`, {
    method: 'POST', body: 'once', signal: AbortSignal.timeout(1500),
  }).then(async r => { await r.text(); return r.status; })));
  assert.deepEqual(failures, [504, 504, 504, 504]);
  assert.equal(posts, 3, 'fourth request expired while queued; no POST is replayed');
  const next = await fetch(proxy.url, { signal: AbortSignal.timeout(1000) });
  assert.equal(await next.text(), 'recovered');
});

test('proxy: idle SSE survives the ordinary response timeout and closes on retarget', async (t) => {
  const upstream = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': ready\n\n');
    setTimeout(() => { if (!res.destroyed) res.write(': still alive\n\n'); }, 160);
  });
  const next = createServer((_req, res) => res.end('new target'));
  await Promise.all([upstream, next].map(s => new Promise(resolve => s.listen(0, '127.0.0.1', resolve))));
  const proxy = await createProxy({ target: `http://127.0.0.1:${upstream.address().port}`, requestTimeoutMs: 60 });
  t.after(async () => { await proxy.close(); for (const s of [upstream, next]) { s.closeAllConnections(); s.close(); } });
  const response = await fetch(proxy.url, { signal: AbortSignal.timeout(1500) });
  const reader = response.body.getReader();
  await reader.read();
  assert.match(new TextDecoder().decode((await reader.read()).value), /still alive/);
  proxy.retarget(`http://127.0.0.1:${next.address().port}`);
  await assert.rejects(reader.read());
  assert.equal(await (await fetch(proxy.url)).text(), 'new target');
});

test('proxy: plugin downloads cannot starve auth and page requests', async (t) => {
  const pending = [];
  const upstream = createServer((req, res) => {
    if (req.url.startsWith('/plugins/')) pending.push(res);
    else res.end('auth ok');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const inner = await createProxy({ target: `http://127.0.0.1:${upstream.address().port}` });
  const outer = await createProxy({ target: inner.url, preview: true });
  const abort = new AbortController();
  t.after(async () => { abort.abort(); await outer.close(); await inner.close(); upstream.closeAllConnections(); upstream.close(); });
  const downloads = Array.from({length:3}, (_,i) => fetch(`${outer.url}/plugins/p${i}/client.js`, {signal:abort.signal}).catch(() => null));
  const deadline = Date.now()+1000;
  while (pending.length < 3 && Date.now()<deadline) await new Promise(r=>setTimeout(r,5));
  assert.equal(pending.length,3);
  assert.equal(await (await fetch(outer.url,{signal:AbortSignal.timeout(600)})).text(),'auth ok');
  for (const res of pending) res.end('plugin');
  const responses = await Promise.all(downloads);
  for (const res of responses) assert.equal(await res.text(),'plugin');
});

test('proxy: header-only SSE opens through two layers before any event arrives', async (t) => {
  const upstream = createServer((_req,res) => {res.writeHead(200,{'content-type':'text/event-stream'});res.flushHeaders();});
  await new Promise(resolve => upstream.listen(0,'127.0.0.1',resolve));
  const inner=await createProxy({target:`http://127.0.0.1:${upstream.address().port}`});
  const outer=await createProxy({target:inner.url});
  t.after(async()=>{await outer.close();await inner.close();upstream.closeAllConnections();upstream.close();});
  const res=await fetch(outer.url,{signal:AbortSignal.timeout(600)});
  assert.equal(res.status,200);
  await res.body.cancel();
});
