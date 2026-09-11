import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { apply } from '../dsh-static-cache/lib/index.js';

// `GET /assets/<一个真实存在的目录>` 曾经抛 EISDIR。
//
// 原因：越界检查用的是 `stat()`，而 stat 对**目录**是成功的 —— 后面那个
// `err.code === 'EISDIR'` 分支永远不会命中；真正抛 EISDIR 的是随后的 `readFile(target)`。
// dist/assets 下确实有目录（assets/langs、assets/fonts），所以这是一次请求就能走到的路径：
// dsh 的 webserver 会兜住这个拒绝，但用户拿到 400 而不是 404，且每次命中都往 dsh 日志里写警告+堆栈。

// 用桩 ctx 抓住注册进来的 handler，再喂假的 req/res。
function mount(distRoot) {
  let handler = null;
  const registrations = [];
  const ctx = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    effect(fn) { return fn(); },
    webServer: { register(route) { registrations.push(route); handler = route.handler; } },
  };
  apply(ctx, { distRoot });
  return { handler, registrations };
}

function fakeRes() {
  return {
    status: null,
    headers: null,
    body: undefined,
    ended: false,
    writeHead(status, headers) { this.status = status; this.headers = headers ?? null; return this; },
    end(body) { this.body = body; this.ended = true; },
  };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'hwb-static-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'assets', 'langs'), { recursive: true });
  await writeFile(path.join(root, 'assets', 'app-1234abcd.js'), 'console.log(1)\n');
  return root;
}

test('目录请求返回 404，而不是让处理器以 EISDIR 拒绝', async (t) => {
  const root = await fixture(t);
  const { handler } = mount(root);
  assert.ok(handler, 'apply 应注册一个 handler');

  const res = fakeRes();
  await handler({ method: 'GET', url: '/assets/langs', headers: {} }, res);
  assert.equal(res.status, 404, `目录应 404，实际 ${res.status}`);
  assert.equal(res.ended, true);
});

test('真实文件照常 200，并带上不可变缓存头', async (t) => {
  const root = await fixture(t);
  const { handler } = mount(root);
  const res = fakeRes();
  await handler({ method: 'GET', url: '/assets/app-1234abcd.js', headers: {} }, res);
  assert.equal(res.status, 200);
  assert.match(res.headers['cache-control'], /immutable/);
  assert.equal(Buffer.isBuffer(res.body) ? res.body.toString() : String(res.body), 'console.log(1)\n');
});

test('不存在的资源返回 404（回归：越界/缺失都应稳稳 404）', async (t) => {
  const root = await fixture(t);
  const { handler } = mount(root);
  // 越界用 403、缺失用 404；空的资源名（`/assets/`）按「请求不合法」给 400。
  const expectations = [
    ['/assets/missing.js', [404]],
    ['/assets/%2e%2e/%2e%2e/etc/passwd', [403, 404]],
    ['/assets/../../etc/passwd', [403, 404]],
    ['/assets/', [400, 404]],
  ];
  for (const [url, allowed] of expectations) {
    const res = fakeRes();
    await handler({ method: 'GET', url, headers: {} }, res);
    assert.ok(allowed.includes(res.status), `${url} 应为 ${allowed.join('/')}，实际 ${res.status}`);
    assert.notEqual(res.status, 200, `${url} 绝不能是 200`);
  }
});

test('条件请求命中 ETag 时返回 304', async (t) => {
  const root = await fixture(t);
  const { handler } = mount(root);
  const first = fakeRes();
  await handler({ method: 'GET', url: '/assets/app-1234abcd.js', headers: {} }, first);
  const second = fakeRes();
  await handler({ method: 'GET', url: '/assets/app-1234abcd.js', headers: { 'if-none-match': first.headers.etag } }, second);
  assert.equal(second.status, 304);
});
