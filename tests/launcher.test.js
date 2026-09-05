import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { captureDshToken, authFetch, probeDeeplink, isTokenFragment, localWebUrl, Launcher } from '../src/control/launcher.js';
import { InstanceRegistry } from '../src/control/registry.js';

// 构造一个伪造的子进程: stdout 为 PassThrough, 并支持 exit 事件。
function fakeProc() {
  const proc = new EventEmitter();
  proc.stdout = new PassThrough();
  return proc;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('captureDshToken: 新版 dsh 打印 `?token=` 行 → 返回 token 片段', async () => {
  const proc = fakeProc();
  const p = captureDshToken(proc, 1000);
  proc.stdout.write('dsh web: http://127.0.0.1:5678/?token=AbC-xyz_123 (LAN: http://10.0.0.1:5678/?token=AbC-xyz_123)\n');
  assert.equal(await p, '?token=AbC-xyz_123');
});

test('captureDshToken: 半行 token 不误判为「旧版无 token」, 等完整行后返回', async () => {
  const proc = fakeProc();
  const p = captureDshToken(proc, 1000);
  proc.stdout.write('dsh web: http://127.0.0.1:5678/?to'); // 未完成半行
  await sleep(20);
  proc.stdout.write('ken=abc\n'); // 补全成 ?token=abc
  assert.equal(await p, '?token=abc');
});

test('captureDshToken: 旧版 dsh 打印裸 URL(无 token) → 返回 null(用裸 URL 兜底)', async () => {
  const proc = fakeProc();
  const p = captureDshToken(proc, 1000);
  proc.stdout.write('dsh web: http://127.0.0.1:5678\n');
  assert.equal(await p, null);
});

test('captureDshToken: 先出现无 token 的提示行, 后续 token 行仍被捕获', async () => {
  const proc = fakeProc();
  const p = captureDshToken(proc, 1000);
  proc.stdout.write('dsh web: opening the default browser; pass --no-open to disable\n');
  await sleep(20);
  proc.stdout.write('dsh web: http://127.0.0.1:5678/?token=tok_9\n');
  assert.equal(await p, '?token=tok_9');
});

test('captureDshToken: 进程退出且无 token → 返回 null', async () => {
  const proc = fakeProc();
  const p = captureDshToken(proc, 1000);
  proc.emit('exit');
  assert.equal(await p, null);
});

test('captureDshToken: 超时(无任何 dsh web 行) → 返回 null', async () => {
  const proc = fakeProc();
  const p = captureDshToken(proc, 40);
  proc.stdout.write('some unrelated output\n');
  assert.equal(await p, null);
});

// —— isTokenFragment: 远端 token 判定（决定拼 ?token= 还是回退裸 URL）——
test('isTokenFragment: 真 token 片段 → true', () => {
  assert.equal(isTokenFragment('?token=AbC-xyz_123'), true);
});

test('isTokenFragment: 旧版哨兵 __NO_TOKEN__ / null / 空串 → false（回退裸 URL，向下兼容）', () => {
  assert.equal(isTokenFragment('__NO_TOKEN__'), false);
  assert.equal(isTokenFragment(null), false);
  assert.equal(isTokenFragment(''), false);
  assert.equal(isTokenFragment(undefined), false);
});

// —— localWebUrl: 本地实例「原始服务连接」——不经 hwb 反代，token 可见、可跨 hwb 生命周期复用 ——
test('localWebUrl: 带 token → 本机直连 `http://127.0.0.1:<port>/?token=<x>`', () => {
  assert.equal(localWebUrl('http://127.0.0.1:5678', '?token=AbC-xyz_123'), 'http://127.0.0.1:5678/?token=AbC-xyz_123');
});

test('localWebUrl: 无 token（旧版 dsh null / 哨兵 __NO_TOKEN__ / 空串）→ 回退裸 URL', () => {
  assert.equal(localWebUrl('http://127.0.0.1:5678', null), 'http://127.0.0.1:5678');
  assert.equal(localWebUrl('http://127.0.0.1:5678', '__NO_TOKEN__'), 'http://127.0.0.1:5678');
  assert.equal(localWebUrl('http://127.0.0.1:5678', ''), 'http://127.0.0.1:5678');
});

test('localWebUrl: 仅拼本机直连地址，绝不引入反代/隧道端口', () => {
  // 关键回归：URL host 就是 dsh web 自身端口（无 hwb proxy 端口、无转发）。
  assert.equal(localWebUrl('http://127.0.0.1:5678', '?token=tok').startsWith('http://127.0.0.1:5678/'), true);
});


// —— authFetch / probeDeeplink: 模拟新版 dsh 的 token→cookie 交接 ——
// 请求 `/?token=good` → 303 + set-cookie;带 cookie 请求 `/` → 200 index.html;无 cookie → 401。
function mockDsh({ withPlugin }) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const cookies = req.headers.cookie || '';
    if (url.searchParams.get('token') === 'good') {
      res.writeHead(303, {
        'set-cookie': 'dsh-auth-test=v1.abc.sig; Path=/; HttpOnly; SameSite=Strict',
        location: '/',
      });
      res.end();
      return;
    }
    if (cookies.includes('dsh-auth-test=v1.abc.sig')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(withPlugin ? '<html><body>session-deeplink</body></html>' : '<html><title>DeepSeek Harness</title></html>');
      return;
    }
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('dsh web authentication required; reopen the URL printed by dsh web.\n');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
  }));
}

test('authFetch: 完成 token→cookie 交接取回真实 index.html(而非 401 文本)', async () => {
  const { server, base } = await mockDsh({ withPlugin: false });
  try {
    const res = await authFetch(`${base}/?token=good`);
    const body = await res.text();
    assert.equal(res.status, 200);
    assert.equal(body.includes('<title>DeepSeek Harness</title>'), true);
    assert.equal(body.includes('dsh web authentication required'), false);
  } finally {
    server.close();
  }
});

test('authFetch: 无 token 栅栏的旧版(直接 200)原样返回', async () => {
  const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>ok</html>'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await authFetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.equal((await res.text()).includes('ok'), true);
  } finally {
    server.close();
  }
});

test('probeDeeplink: 插件存在(index.html 含 session-deeplink)→ true', async () => {
  const { server, base } = await mockDsh({ withPlugin: true });
  try {
    assert.equal(await probeDeeplink(`${base}/?token=good`), true);
  } finally {
    server.close();
  }
});

test('probeDeeplink: 原厂无插件(index.html 无 session-deeplink)→ false; 但不再误吞 401', async () => {
  const { server, base } = await mockDsh({ withPlugin: false });
  try {
    assert.equal(await probeDeeplink(`${base}/?token=good`), false);
    assert.equal(await probeDeeplink(`${base}/`), false); // 裸 URL(401)也安全返回 false
  } finally {
    server.close();
  }
});

// —— 连接已运行的本机 dsh web（§5.x·本地直连已有实例）——
// 配置了 localPort+token 时，「打开」直接接入该实例：同机直连 URL、无 hwb 反代、无子进程（pid null），
// 且 hwb 不持有/不 kill 它（stop 拆状态但不动进程）。关键回归：返回的 URL host 就是 dsh 本体端口，
// 绝不出现第二个「代理/转发」端口。
test('connect-existing: 配置 localPort+token → 直连 URL、无反代、无子进程', async () => {
  const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<html>ok</html>'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const launcher = new Launcher({ registry: new InstanceRegistry() });
  const home = { homeId: 'abcd'.repeat(4), homePath: '/mock/home', hostType: 'local', localPort: port, token: 'token=abc' };
  try {
    const inst = await launcher.open(home);
    // 直连：URL 端口 = 假 dsh 端口；pid null（不持子进程）；dsh 无插件 → deeplink false。
    assert.equal(inst.url, `http://127.0.0.1:${port}/?token=abc`);
    assert.equal(inst.port, port);
    assert.equal(inst.pid, null);
    assert.equal(inst.deeplink, false);
    // URL 一切以 dsh 本体端口为准，不引入 hwb 代理/隧道端口。
    assert.equal(inst.url.startsWith(`http://127.0.0.1:${port}/`), true);
    // status() 对无子进程的直连实例不崩，返回同一直连 URL。
    const st = launcher.status(home.homeId);
    assert.equal(st.url, `http://127.0.0.1:${port}/?token=abc`);
    assert.equal(st.port, port);
  } finally {
    // stop：直连实例无子进程可 kill → 返回 false，且不再持有该实例。
    assert.equal(await launcher.stop(home), false);
    assert.equal(launcher.status(home.homeId), null);
    server.close();
  }
});
