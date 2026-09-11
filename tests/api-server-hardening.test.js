import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createApiServer, isLoopbackHost } from '../src/api/server.js';

// 真实 HTTP 服务端上的加固回归。这些行为**只有走真 socket 才测得出来**：
// 假 req（async generator + 假 res）拿不到 TCP 分片边界、看不到响应是否真的送到了对端，
// 也无法构造伪造 Host 的请求。前两个缺陷正是因此才漏掉的。

const HOME_ID = 'abcdef1234567890';

function makeServer() {
  const registered = [];
  const server = createApiServer({
    store: {
      listHomes: () => [{ homeId: HOME_ID, hostType: 'local', hostPath: '/home/u/.dsh', token: 'secret-token' }],
      getHome: (id) => (id === HOME_ID ? { homeId: id, hostType: 'local' } : null),
      registerHome: (body) => { registered.push(body); return 'newhome'; },
      listWorkspaces: () => [],
      getSession: () => null,
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
