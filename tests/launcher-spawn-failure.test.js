import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { InstanceRegistry } from '../src/control/registry.js';
import { IndexStore } from '../src/dshhome/store.js';
import { Launcher } from '../src/control/launcher.js';

// spawn('dsh', …) 的失败（PATH 里没有 dsh、dsh 不可执行）是**异步**通过 'error' 事件上报的，
// 而且它不触发 'exit'。没挂 'error' 监听时 Node 会把它当 uncaughtException 抛出：
// installCrashHandlers 直接 process.exit(1)，Launcher 的 process 'exit' 钩子再 SIGTERM 掉
// **所有**已托管的 dsh web 子进程 —— 一次「dsh 不在 PATH 里」就变成整个工作台退出。
// 这个测试就是在没有 dsh 的 PATH 下真的点一次「连接」。

function withPath(value, fn) {
  const saved = process.env.PATH;
  process.env.PATH = value;
  return Promise.resolve().then(fn).finally(() => { process.env.PATH = saved; });
}

function trackExitListeners() {
  const before = new Set(process.listeners('exit'));
  return () => {
    for (const listener of process.listeners('exit')) if (!before.has(listener)) process.removeListener('exit', listener);
  };
}

test('本机拉起 dsh：PATH 里没有 dsh 时给出明确错误，而不是把整个进程带走', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'hwb-no-dsh-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const cleanup = trackExitListeners();
  t.after(cleanup);

  const registry = { set() {} };
  const launcher = new Launcher({ registry });
  const spec = { homeId: 'local-no-dsh', hostType: 'local', homePath: home };

  const started = Date.now();
  const error = await withPath('/nonexistent-path-for-hwb-test', () =>
    launcher.open(spec).then(() => null, (e) => e));

  assert.ok(error, 'open() 必须 reject，而不是静默成功或让进程崩溃');
  assert.match(error.message, /dsh web did not come up/);
  // 关键：'error' 事件要被接住并立刻让等待失败，而不是干等 20s 超时。
  assert.ok(Date.now() - started < 5000, `应当立即失败，实际用了 ${Date.now() - started}ms`);
  assert.equal(launcher.status(spec.homeId), null, '失败后不应留下残留实例');
  assert.equal(launcher.procs.has(spec.homeId), false);
});

test('captureDshToken：spawn 失败时立刻 settle，不必等满超时', async () => {
  const { captureDshToken } = await import('../src/control/launcher.js');
  const { spawn } = await import('node:child_process');
  const saved = process.env.PATH;
  let proc;
  try {
    process.env.PATH = '/nonexistent-path-for-hwb-test';
    proc = spawn('dsh', ['web']);
    // 先自己接住，避免这个测试本身把它变成 uncaughtException
    proc.on('error', () => {});
    const started = Date.now();
    const result = await captureDshToken(proc, 20_000);
    assert.equal(result, null);
    assert.ok(Date.now() - started < 5000, `应当立即返回，实际用了 ${Date.now() - started}ms`);
  } finally {
    process.env.PATH = saved;
    proc?.kill?.();
  }
});

// hwb 自己拉起的 dsh web 子进程死掉时，共享注册表必须立刻知道 —— 否则 monitor.get()
// （API 与界面都读它）在下一轮心跳（最多 30s）之前一直报 running + 旧 pid/url：
// 卡片显示「已连接」、标签页圆点是绿的、iframe 指向一个已经没人监听的端口，
// 服务端「已连接实例」的过滤也照样把它算进去。对照：ssh 隧道退出那条路径早就会置 degraded。
//
// 注意夹具要用「活着等被杀」的假 dsh：让子进程自己退出会触发 monitor/recovery 的定时器，
// 测试进程会一直等事件循环（第一版就是这么卡住的）。
test('launcher: 子进程被杀后注册表立刻变成 stopped（不再谎报已连接）', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hwb-launch-exit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'dsh');
  // 假 dsh 必须**自己把真 dsh 启动时会做的两件事做掉**，否则这条用例根本走不到「被杀」那一步：
  //   ① 往 stdout 打印 `dsh web: <url>?token=…` —— 启动路径的 captureDshToken 就是在等这一行；
  //   ② 真的在 --port 上监听 HTTP —— 启动路径会 waitForHttp 探测这个地址，成功后再做
  //      #assertAuthorized（任何 <400 都算通过）与 probeDeeplink（正文里要出现 session-deeplink）。
  // 这条夹具以前只是 `sleep 30`，却一直"绿"：Launcher 忽略了注入的 env，spawn 用的是**本机
  // PATH 里的真 dsh**，上面两件事都是真 dsh 做的，用例其实在"借"本机装好的 dsh 跑。
  // CI 上没有 dsh，于是 `spawn dsh ENOENT` 变红（2026-09-13 定位并修好 env 注入 + 本夹具）。
  // 用 process.execPath 做 shebang：不依赖 PATH 里有 node（复现 CI 时会把 PATH 清空到只有 /usr/bin）。
  await writeFile(bin, `#!${process.execPath}
const http = require('node:http');
const argv = process.argv.slice(2);
const i = argv.indexOf('--port');
const port = i >= 0 ? Number(argv[i + 1]) : 0;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><title>fake dsh web</title><div id="session-deeplink"></div>');
});
server.listen(port, '127.0.0.1', () => {
  console.log('dsh web: http://127.0.0.1:' + port + '/?token=fake-token-for-test');
});
`);
  await chmod(bin, 0o755);
  const registry = new InstanceRegistry();
  const store = new IndexStore(':memory:');
  const homeId = store.registerHome({ homePath: path.join(dir, 'home'), hostType: 'local' });
  const launcher = new Launcher({ store, registry,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    waitHttp: async () => true });   // 跳过真实 HTTP 探测（端口上没人监听）
  t.after(async () => { try { await launcher.disconnect?.(store.getHome(homeId) ?? { homeId, homePath: dir }, { release: true }); } catch { /* 尽力 */ } store.close(); });

  const inst = await launcher.open(store.getHome(homeId));
  assert.equal(registry.get(homeId).phase, 'running', '刚起来时应是 running');
  assert.ok(inst.pid > 0);
  process.kill(inst.pid, 'SIGKILL');                 // 模拟子进程被杀/崩溃
  await new Promise((r) => setTimeout(r, 400));
  const after = registry.get(homeId);
  assert.equal(after.phase, 'stopped', `子进程死后应立刻是 stopped，实际 ${after.phase}`);
  assert.equal(after.pid, null, '不该再留着旧 pid');
});
