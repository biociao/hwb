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
