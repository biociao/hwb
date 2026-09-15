import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createProxy } from '../src/control/proxy.js';

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
  const proxy = await createProxy({ target: `http://127.0.0.1:${upstream.address().port}`, preview: true });
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

test('proxy: static cache headers survive preview chaining without sharing authenticated responses', async (t) => {
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
  for (const [hash, cookie] of [['BNsW4eBh', 'user=one'], ['BNsW4eBh', 'user=two'], ['C0xS9mPB', 'user=one']]) {
    const path = `/assets/vendor-${hash}.js`;
    const response = await fetch(preview.url + path, { headers: { cookie } });
    assert.equal(response.headers.get('cache-control'), 'private, max-age=31536000, immutable');
    assert.equal(response.headers.get('etag'), '"asset-revision"');
    assert.equal(response.headers.get('vary'), 'Accept-Encoding');
    assert.deepEqual(await response.json(), { path, cookie });
  }
  // The proxy supplies browser policy; it never stores or reuses response bodies.
  assert.equal(requests, 3);
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
