import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRouter } from '../src/api/routes.js';

// 跨站写保护回归：hwb 只监听 127.0.0.1 且无鉴权，浏览器里任意页面都能发请求；
// Content-Type 为 text/plain 的 POST 属于 CORS 简单请求（不触发预检），所以服务端必须自己拦。
// 这里覆盖「以前漏掉的那些写路由」——它们原先没有 sec-fetch-site 检查。

const HOME_ID = 'abcdef1234567890';

function makeRouter(calls) {
  const record = (name) => (...args) => { calls.push(name); return args; };
  return createRouter({
    store: {
      getHome: (id) => { calls.push('getHome'); return id === HOME_ID ? { homeId: id, hostType: 'local' } : null; },
      listHomes: () => { calls.push('listHomes'); return []; },
      listWorkspaces: () => [],
      getSession: () => null,
      registerHome: () => { calls.push('registerHome'); return 'newhome'; },
      removeHome: () => { calls.push('removeHome'); },
      updateHomeConfig: () => { calls.push('updateHomeConfig'); return {}; },
      setHomeOrder: () => { calls.push('setHomeOrder'); },
    },
    indexer: { reindexNow: record('reindexNow') },
    hub: { broadcast: record('broadcast') },
    launcher: { status: () => null, disconnect: record('disconnect'), stop: record('stop') },
    monitor: { get: () => ({ runtime: 'stopped' }), refresh: record('refresh') },
    quota: { list: () => [], refresh: record('quotaRefresh') },
    logApi: { getLogs: () => [] },
  });
}

async function request(route, method, pathname, { headers = {}, body } = {}) {
  const result = { status: null, body: null };
  const req = {
    method,
    ...(headers === null ? {} : { headers }),
    async *[Symbol.asyncIterator]() { if (body !== undefined) yield typeof body === 'string' ? body : JSON.stringify(body); },
  };
  const res = {
    setHeader() {},
    writeHead(status) { result.status = status; },
    end(raw) { result.body = raw ? JSON.parse(raw) : null; },
  };
  await route(req, res, new URL(`http://127.0.0.1:4310${pathname}`));
  return result;
}

// 这些写路由原先完全没有来源校验。
const MUTATING_ROUTES = [
  ['POST', '/api/homes', { homePath: '/tmp/x' }],
  ['POST', '/api/homes/order', { homeIds: [] }],
  ['POST', `/api/homes/${HOME_ID}/reindex`],
  ['POST', `/api/homes/${HOME_ID}/open`],
  ['POST', `/api/homes/${HOME_ID}/stop`],
  ['POST', `/api/homes/${HOME_ID}/restart`],
  ['POST', `/api/homes/${HOME_ID}/disconnect`],
  ['POST', '/api/quota/refresh'],
  ['PUT', `/api/homes/${HOME_ID}`, { alias: 'x' }],
  ['DELETE', `/api/homes/${HOME_ID}`],
];

for (const [method, pathname, body] of MUTATING_ROUTES) {
  test(`cross-site ${method} ${pathname} is rejected before touching state`, async () => {
    for (const headers of [{ 'sec-fetch-site': 'cross-site' }, { origin: 'http://evil.example', host: '127.0.0.1:4310' }]) {
      const calls = [];
      const route = makeRouter(calls);
      const res = await request(route, method, pathname, { headers, body });
      assert.equal(res.status, 403, `${method} ${pathname} with ${JSON.stringify(headers)}`);
      assert.deepEqual(calls, [], `${method} ${pathname} must not reach the store/launcher`);
    }
  });
}

test('same-origin mutating requests are still served', async () => {
  const route = makeRouter([]);
  const sameOrigin = { 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:4310', host: '127.0.0.1:4310' };
  const reindexed = await request(route, 'POST', `/api/homes/${HOME_ID}/reindex`, { headers: sameOrigin });
  assert.equal(reindexed.status, 200);
  const refreshed = await request(route, 'POST', '/api/quota/refresh', { headers: sameOrigin });
  assert.equal(refreshed.status, 200);
});

test('non-browser clients (no Origin / no Sec-Fetch-Site) are not blocked', async () => {
  const route = makeRouter([]);
  for (const headers of [{}, { host: '127.0.0.1:4310' }, null]) {
    const res = await request(route, 'POST', `/api/homes/${HOME_ID}/reindex`, { headers });
    assert.equal(res.status, 200, `headers=${JSON.stringify(headers)}`);
  }
});

test('oversized JSON bodies are rejected once the limit is crossed, not after buffering all of it', async () => {
  const route = makeRouter([]);
  const chunk = Buffer.from('x'.repeat(1024));
  let pulled = 0;
  const req = {
    method: 'PUT',
    headers: {},
    async *[Symbol.asyncIterator]() {
      // 100 KiB 的请求体：超限即应停止读取，而不是把它全部拉进内存。
      for (let i = 0; i < 100; i++) { pulled++; yield chunk; }
    },
  };
  const result = { status: null, body: null };
  await route(req, { setHeader() {}, writeHead(s) { result.status = s; }, end(b) { result.body = JSON.parse(b); } },
    new URL(`http://127.0.0.1:4310/api/homes/${HOME_ID}`));
  assert.equal(result.status, 400);
  assert.ok(pulled <= 66, `should stop reading right after the 64 KiB limit, pulled=${pulled} chunks`);
});

test('malformed JSON bodies are rejected with 400', async () => {
  const route = makeRouter([]);
  const res = await request(route, 'PUT', `/api/homes/${HOME_ID}`, { body: '{not json' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /invalid JSON body/);
});
