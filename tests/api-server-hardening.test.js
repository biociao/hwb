import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createApiServer, isLoopbackHost, allowedHostsFromEnv, hostNameOf } from '../src/api/server.js';
import { IndexStore } from '../src/dshhome/store.js';

// 真实 HTTP 服务端上的加固回归。这些行为**只有走真 socket 才测得出来**：
// 假 req（async generator + 假 res）拿不到 TCP 分片边界、看不到响应是否真的送到了对端，
// 也无法构造伪造 Host 的请求。前两个缺陷正是因此才漏掉的。

const HOME_ID = 'abcdef1234567890';

function makeServer({ allowedHosts = [] } = {}) {
  const registered = [];
  const server = createApiServer({
    allowedHosts,
    store: {
      listHomes: () => [{ homeId: HOME_ID, hostType: 'local', hostPath: '/home/u/.dsh', token: 'secret-token' }],
      getHome: (id) => (id === HOME_ID ? { homeId: id, hostType: 'local' } : null),
      registerHome: (body) => { registered.push(body); return 'newhome'; },
      listWorkspaces: () => [],
      getSession: () => null,
      // 这几个查询会被「极端查询参数」用例打到；返回空结构即可，测的是**参数解析**不抛错。
      recentProjects: () => [],
      recentSessions: () => [],
      usageSummary: () => ({ sessionCount: 0 }),
      usageByProject: () => [],
      usageTrend: () => [],
      usageTrendGrouped: () => ({ buckets: [] }),
    },
    indexer: { reindexNow: async () => [] },
    hub: { broadcast() {}, handle() {} },
    launcher: { status: () => null },
    monitor: { get: () => ({ runtime: 'stopped' }), refresh: async () => {} },
    quota: { list: () => [], refresh: async () => ({}) },
    logApi: { getLogs: () => [] },
    webRoot: '/nonexistent-web-root',
  });
  return { server, registered };
}

async function listen(t) {
  const { server, registered } = makeServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  return { port: server.address().port, registered };
}

// 发一个可以完全控制 Host 与写入分片的原始 HTTP 请求。
function rawRequest(port, { method = 'GET', path = '/', host, headers = {}, chunks = [] }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ port, host: '127.0.0.1' });
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (d) => { data += d; });
    socket.on('error', reject);
    socket.on('close', () => resolve(data));
    socket.on('connect', () => {
      const lines = [`${method} ${path} HTTP/1.1`, `Host: ${host ?? `127.0.0.1:${port}`}`];
      for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
      lines.push('Connection: close', '', '');
      socket.write(lines.join('\r\n'));
      for (const chunk of chunks) socket.write(chunk);
      if (!chunks.length) socket.end();
      else socket.end();
    });
  });
}

const statusOf = (raw) => Number(/^HTTP\/1\.1 (\d+)/.exec(raw)?.[1]);
const bodyOf = (raw) => raw.slice(raw.indexOf('\r\n\r\n') + 4);

test('isLoopbackHost: 只认回环地址，端口与 IPv6 括号要能正确处理', () => {
  for (const host of ['127.0.0.1', '127.0.0.1:4310', 'localhost', 'localhost:4310', 'LOCALHOST:4310', '[::1]', '[::1]:4310']) {
    assert.equal(isLoopbackHost(host), true, host);
  }
  for (const host of ['', undefined, null, 'evil.example', 'evil.example:4310', '127.0.0.1.evil.example', '0.0.0.0', '[::]:4310', 'example.com:4310']) {
    assert.equal(isLoopbackHost(host), false, String(host));
  }
});

test('DNS rebinding：非回环 Host 的 API 请求一律 403，且不泄露 token', async (t) => {
  const { port } = await listen(t);
  // rebinding 场景：浏览器访问攻击者域名，该域名解析到 127.0.0.1。
  // 此时 Host / Origin 都是攻击者域名，Sec-Fetch-Site 是 same-origin —— 同源检查拦不住。
  const rebind = await rawRequest(port, {
    path: '/api/homes',
    host: 'evil.example:4310',
    headers: { Origin: 'http://evil.example:4310', 'Sec-Fetch-Site': 'same-origin' },
  });
  assert.equal(statusOf(rebind), 403);
  assert.doesNotMatch(bodyOf(rebind), /secret-token/, '被拒绝的响应里绝不能带上 token');

  // rebinding 下的写操作同样必须被拦（此前它会「通过」同源检查并被真正处理）。
  const write = await rawRequest(port, {
    method: 'POST', path: '/api/homes', host: 'evil.example:4310',
    headers: { Origin: 'http://evil.example:4310', 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' },
    chunks: ['{"homePath":"/tmp"}'],
  });
  assert.equal(statusOf(write), 403);

  // 回环 Host 照常可用。
  const ok = await rawRequest(port, { path: '/api/homes' });
  assert.equal(statusOf(ok), 200);
  assert.match(bodyOf(ok), new RegExp(HOME_ID));
});

test('超限请求体在真实连接上仍然返回 400 body too large（不能是 EPIPE）', async (t) => {
  const { port } = await listen(t);
  const big = 'x'.repeat(100 * 1024);
  const raw = await rawRequest(port, {
    method: 'PUT', path: `/api/homes/${HOME_ID}`,
    headers: { 'Content-Type': 'application/json', 'Content-Length': String(big.length) },
    chunks: [big],
  });
  assert.equal(statusOf(raw), 400, '应当收到明确的 400，而不是连接被重置');
  assert.match(bodyOf(raw), /body too large/);
});

test('非 ASCII 请求体被 TCP 分片切开时仍能正确解码', async (t) => {
  const { port, registered } = await listen(t);
  // 真实中文别名，故意在「别」字的 UTF-8 字节序列中间切开。
  const payload = Buffer.from(JSON.stringify({ homePath: '/tmp', alias: '中文别名' }));
  const marker = Buffer.from('别名');
  const cut = payload.indexOf(marker) + 2; // 落在多字节字符内部
  assert.ok(cut > 0 && cut < payload.length);

  const raw = await rawRequest(port, {
    method: 'POST', path: '/api/homes',
    headers: { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) },
    chunks: [payload.subarray(0, cut), payload.subarray(cut)],
  });
  assert.ok([200, 202].includes(statusOf(raw)), `unexpected status: ${statusOf(raw)}`);
  // 落库的别名必须是完整的中文，而不是带 U+FFFD 的乱码。
  assert.equal(registered.at(-1)?.alias, '中文别名');
  assert.doesNotMatch(JSON.stringify(registered.at(-1)), /\uFFFD/);
});

// 逃生口：/etc/hosts 别名、devcontainer 转发域名、保留浏览器 authority 的反代，都会让 Host
// 不是回环名 —— 那时 SPA 能加载但每个 /api/* 都 403，没有任何办法自证是本人。
// HWB_ALLOWED_HOSTS 是显式的放行名单（默认空 = 只允许回环）。
test('isLoopbackHost: allowedHosts 显式放行，且不放松回环默认', () => {
  assert.equal(isLoopbackHost('hwb.local:4310'), false, '默认不放行');
  assert.equal(isLoopbackHost('hwb.local:4310', ['hwb.local']), true);
  assert.equal(isLoopbackHost('HWB.LOCAL:4310', ['hwb.local']), true, '大小写不敏感');
  assert.equal(isLoopbackHost('other.local:4310', ['hwb.local']), false);
  assert.equal(isLoopbackHost('127.0.0.1:4310', []), true, '回环始终允许');
  assert.equal(isLoopbackHost(undefined, ['hwb.local']), false, '空 Host 仍拒绝');
});

test('hostNameOf: 去端口与 IPv6 方括号', () => {
  assert.equal(hostNameOf('127.0.0.1:4310'), '127.0.0.1');
  assert.equal(hostNameOf('[::1]:4310'), '::1');
  assert.equal(hostNameOf('Example.COM:80'), 'example.com');
  assert.equal(hostNameOf(''), '');
});

test('allowedHostsFromEnv: 逗号分隔、去空白、大小写归一', () => {
  assert.deepEqual(allowedHostsFromEnv({}), []);
  assert.deepEqual(allowedHostsFromEnv({ HWB_ALLOWED_HOSTS: 'hwb.local, Dev.Box ' }), ['hwb.local', 'dev.box']);
  assert.deepEqual(allowedHostsFromEnv({ HWB_ALLOWED_HOSTS: ' , ' }), []);
});

test('真实服务：放行的 Host 能访问，未放行的仍然 403', async (t) => {
  const { server, registered } = makeServer({ allowedHosts: ['hwb.local'] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  const port = server.address().port;

  const allowed = await rawRequest(port, { path: '/api/homes', host: `hwb.local:${port}` });
  assert.equal(statusOf(allowed), 200, '显式放行的 Host 应放行');

  const denied = await rawRequest(port, { path: '/api/homes', host: `evil.example:${port}` });
  assert.equal(statusOf(denied), 403, '未放行的 Host 仍必须拒绝');
});

// 查询参数里的数值必须带上下界：`Number(x) || fallback` 只挡得住 0/NaN/'abc'，
// 挡不住 `?days=1e9` —— 那会一路传到 `new Date(Date.now() - days*86400000).toISOString()`，
// 超出 ECMAScript 日期范围后 toISOString 抛 RangeError，请求变成 500。
test('极端查询参数不再把接口打成 500', async (t) => {
  const { port } = await listen(t);
  const paths = ['/api/projects/recent', '/api/sessions/recent', '/api/usage'];
  const queries = ['days=1e9', 'days=999999999999', 'days=-5', 'days=abc', 'days=Infinity', 'hours=1e12', 'limit=1e20'];
  for (const path of paths) {
    for (const q of queries) {
      const raw = await rawRequest(port, { path: `${path}?${q}` });
      assert.equal(statusOf(raw), 200, `${path}?${q} 应为 200，实际 ${statusOf(raw)}`);
    }
  }
});

// 三处 HTTP 细节，都是独立审查第 8 轮提出的：
//  · `/api/*` 的响应原先一条 Cache-Control 都没有（preview/download 单独设了 no-store，其余没有）——
//    这是个无鉴权 API，响应里有实例元数据与会话标题，不该进浏览器缓存或反代。
//  · 路由只匹配 `method === 'GET'`，于是 `curl -I /api/homes`（HEAD）**404** ——
//    任何基于 HEAD 的健康检查都会认为 API 挂了。
//  · 静态 403/404 与 500 没带 Content-Type / charset。
test('HTTP: /api/* 带 no-store 与 nosniff，HEAD 与 GET 行为一致', async () => {
  const { server } = makeServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const get = await fetch(`${base}/api/homes`);
    assert.equal(get.status, 200);
    assert.equal(get.headers.get('cache-control'), 'no-store', '/api/* 必须不可缓存');
    assert.equal(get.headers.get('x-content-type-options'), 'nosniff');

    const head = await fetch(`${base}/api/homes`, { method: 'HEAD' });
    assert.equal(head.status, 200, 'HEAD 应与 GET 同样可达（健康检查常用）');
    assert.equal(await head.text(), '', 'HEAD 不该有 body');

    const missing = await fetch(`${base}/api/nope`);
    assert.equal(missing.status, 404);
    assert.match(missing.headers.get('content-type') || '', /application\/json/);
    assert.equal(missing.headers.get('cache-control'), 'no-store');
  } finally { await new Promise((r) => server.close(r)); }
});

// 路由处理器抛错时必须回 **500** 并留下日志（`src/api/server.js` 的 catch）。
// 这条路径原先没有任何测试：审查把它改成「吞掉 + 回 200」之后整个套件仍然全绿（610/609/0）。
// 后果是任何路由回归都变成「静默的空响应 / 200」，前端错误分支永不触发、日志里也没有痕迹 ——
// 而本项目的原则是「失败必须说出来」。
test('api: 路由处理器抛错时返回 500，并且日志里留下请求路径', async () => {
  const { initLogger, getLogs } = await import('../src/lib/logger.js');
  initLogger({ level: 'info', file: false, color: false, silent: true });
  const store = new IndexStore(':memory:');
  const explosion = new Error('store exploded');
  const server = createApiServer({
    store: { ...{}, listHomes: () => { throw explosion; }, getHome: () => null, dataVersion: () => 1 },
    indexer: { reindexNow: async () => [] },
    hub: { broadcast() {}, handle() {} },
    launcher: { status: () => null },
    monitor: { get: () => ({ runtime: 'stopped' }), refresh: async () => {} },
    quota: { list: () => [], refresh: async () => ({}) },
    logApi: { getLogs: () => [] },
    webRoot: '/nonexistent-web-root',
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/homes`);
    assert.equal(res.status, 500, `路由抛错必须回 500（实际 ${res.status}）`);
    const body = await res.json().catch(() => null);
    assert.ok(body && typeof body.error === 'string' && body.error.includes('store exploded'),
      `响应里要带上真正的错误（实际 ${JSON.stringify(body)}）`);
    const logged = getLogs({ limit: 50 }).some((e) => String(e.message).includes('API 请求处理失败'));
    assert.ok(logged, '日志里必须有「API 请求处理失败」这一条，便于归因');
  } finally {
    await new Promise((r) => server.close(r));
    store.close();
  }
});

// ---- JSON 正文是 `null` 的 POST：路由会把它当成「解析失败、已响应」的哨兵 ----
// 原实现用 `null` 同时表示两件事（解析失败、正文就是 null），调用方一律 `if (body === null) return;`，
// 于是 `curl -d 'null' -H 'content-type: application/json' /api/homes` **既没有响应也没有断开**：
// 请求一直挂在客户端上（实测 curl 6s 超时、`HTTP 000`，连接与 socket 都不释放），
// 而同一条路径上 `{}` / `[]` / `"x"` / `5` 都是一瞬间 400 —— 说明差别只在「正文恰好是 null」。
// 用带超时的 fetch：修复前会以 TimeoutError 失败，修复后立刻拿到 400。
test('api: 正文恰为 JSON null 的 POST 必须有响应，不能把请求挂死', async () => {
  const { server } = makeServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const raw of ['null', '5', '"x"', 'true']) {
      const res = await fetch(`${base}/api/homes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base },
        body: raw,
        signal: AbortSignal.timeout(3000),
      }).catch((e) => { throw new Error(`正文 ${raw} 没有得到任何响应（${e.message}）`); });
      assert.equal(res.status, 400, `正文 ${raw} 应被拒为 400（实际 ${res.status}）`);
      const body = await res.json();
      assert.equal(typeof body.error, 'string');
    }
  } finally { await new Promise((r) => server.close(r)); }
});

// ---- 兜底网：路由 return 了却没写任何响应 ----
// 上面那类缺陷的**共同后果**是「请求永远不返回」，而它不该只靠逐个 handler 自觉。
// 这里直接测兜底函数本身，而不是间接依赖某条路由：写得出来才说明这张网真的存在。
test('api: 路由返回但没写响应时，兜底网补一个 500（且不打扰已开始流式响应的请求）', async () => {
  const { ensureResponded } = await import('../src/api/server.js');
  const errors = [];
  const log = { error: (msg, err, meta) => errors.push({ msg, err, meta }) };
  const meta = { method: 'POST', path: '/api/homes' };

  // ① 什么都没写：补 500 + 记日志，返回 true 表示「网住了」。
  const written = { head: null, body: null, ended: false };
  const res = {
    writableEnded: false, headersSent: false,
    writeHead(code, headers) { written.head = { code, headers }; },
    end(chunk) { written.body = chunk; written.ended = true; },
  };
  assert.equal(ensureResponded(res, log, meta), true);
  assert.equal(written.head.code, 500);
  assert.match(String(written.body), /"error"/);
  assert.equal(errors.length, 1);
  assert.deepEqual(errors[0].meta, meta, '日志要带上是哪条请求，否则无法归因');

  // ② 已经结束（正常情况下路由都会走到这里）：什么都不做 —— 否则会把正常响应覆盖成 500。
  const done = { writableEnded: true, headersSent: true, writeHead() { throw new Error('不该再写头'); }, end() { throw new Error('不该再 end'); } };
  assert.equal(ensureResponded(done, log, meta), false);
  assert.equal(errors.length, 1);

  // ③ 已发头但没结束：这是 **SSE**（/api/events 会一直挂着连接）。绝不能在这里补 500 把它掐掉。
  const sse = { writableEnded: false, headersSent: true, writeHead() { throw new Error('不该再写头'); }, end() { throw new Error('不该再 end'); } };
  assert.equal(ensureResponded(sse, log, meta), false);
  assert.equal(errors.length, 1, 'SSE 连接不该被记成「路由没响应」');

  // ④ 接线本身：兜底网写得再对，只要 server 里那句调用被删掉就等于不存在（而它照样能全绿）。
  // 这条是**结构断言**——故意不做行为测试，因为「让路由悄悄 return 不响应」需要一个内部缺陷来喂它，
  // 那样的测试会随实现漂移；源码断言至少保证「网被拆掉」会被发现。
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/api/server.js', import.meta.url), 'utf8');
  assert.match(source, /route\(req, res, url\)\.then\(\(\) => \{[\s\S]*?ensureResponded\(res, log, \{ method: req\.method, path: url\.pathname \}\)/,
    'src/api/server.js 必须在路由返回后调用 ensureResponded（否则兜底网没有任何接线）');
});
