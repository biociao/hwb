import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Launcher } from '../src/control/launcher.js';
import { InstanceRegistry } from '../src/control/registry.js';
import { Monitor } from '../src/control/monitor.js';
import { probeAlive, httpProbe } from '../src/control/prober.js';

// 「停止」与「连接」都必须以**事实**为准，而不是以「我们发过信号 / 端口有响应」为准：
//
//  · stop()：原先 kill() 之后无条件 procs.delete + phase 'stopped'。子进程忽略 SIGTERM 时，
//    API 回 {ok:true,stopped:true}、界面显示已停止，而进程仍在监听端口并返回 200 ——
//    句柄已经丢了，UI 连重试的机会都没有（审查实测：lsof 显示同一个 pid 仍在 LISTEN）。
//  · open()：连接路径上的判据只有 httpProbe（status < 500），**401 也算「活着」**，于是 token
//    填错/远端轮换了 token 时照样「连接成功」，iframe 里却是 401 栅栏页，监控每 30s 报 running。
//  · 退出：'exit' 钩子里的 proc.kill() 是投递即返回的，process.exit() 之后事件循环不再运行，
//    忽略 SIGTERM 的子进程会变成孤儿（审查复现：父进程没了，它仍 LISTEN 并返回 200）。
//
// 这些用**真子进程**验证：假 dsh 在 PATH 上，脚本按需忽略 SIGTERM。

// 忽略 SIGTERM 的假 dsh：必须被 SIGKILL 才能收掉（SIGKILL 不可捕获）。
const STUBBORN_DSH = `#!/usr/bin/env node
const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]);
process.on('SIGTERM', () => { /* 故意忽略：模拟收尾卡住的 dsh */ });
const http = require('node:http');
http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><body>session-deeplink ok</body></html>'); })
  .listen(port, '127.0.0.1', () => process.stdout.write('dsh web: http://127.0.0.1:' + port + '/?token=stubborn-token\\n'));
`;

// token 栅栏：裸 URL 与错 token 一律 401；正确 token → 303 + Set-Cookie → 带 cookie 的 / 返回 200。
const FENCE_DSH = `#!/usr/bin/env node
const RIGHT = 'right-token';
const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]);
const http = require('node:http');
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.searchParams.get('token') === RIGHT) {
    res.writeHead(303, { location: '/', 'set-cookie': 'dsh_session=ok; Path=/; HttpOnly' });
    return res.end();
  }
  if ((req.headers.cookie || '').includes('dsh_session=ok')) {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end('<html><body>session-deeplink ok</body></html>');
  }
  res.writeHead(401, { 'content-type': 'text/plain' });
  res.end('unauthorized: token required');
}).listen(port, '127.0.0.1', () => process.stdout.write('dsh web: http://127.0.0.1:' + port + '/?token=' + RIGHT + '\\n'));
`;

async function fakeDshOnPath(t, source) {
  const dir = await mkdtemp(path.join(tmpdir(), 'hwb-fake-dsh-'));
  const bin = path.join(dir, 'dsh');
  await writeFile(bin, source);
  await chmod(bin, 0o755);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function trackExitListeners() {
  const before = new Set(process.listeners('exit'));
  return () => {
    for (const l of process.listeners('exit')) if (!before.has(l)) process.removeListener('exit', l);
  };
}

async function withPath(dir, fn) {
  const saved = process.env.PATH;
  process.env.PATH = `${dir}:${saved}`;
  try { return await fn(); } finally { process.env.PATH = saved; }
}

const FAST = { tunnelReadyDelayMs: 0 };
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('stop()：忽略 SIGTERM 的子进程会被 SIGKILL 收掉，不谎报已停止', async (t) => {
  const dir = await fakeDshOnPath(t, STUBBORN_DSH);
  const cleanup = trackExitListeners();
  t.after(cleanup);
  const home = await mkdtemp(path.join(tmpdir(), 'hwb-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));

  const registry = new InstanceRegistry();
  const launcher = new Launcher({ registry, ...FAST, stopTermMs: 200, stopKillMs: 4000 });
  const homeSpec = { homeId: 'stubborn-local', hostType: 'local', homePath: home };

  const opened = await withPath(dir, () => launcher.open(homeSpec));
  // 兜底：若修复缺失，子进程会活着并被断言发现；这里再补一枪，避免它拖着测试进程不退出。
  t.after(() => { try { process.kill(opened.pid, 'SIGKILL'); } catch { /* 已经死了 */ } });
  const proc = launcher.procs.get(homeSpec.homeId).proc;
  assert.ok(isAlive(opened.pid), '前置条件：子进程在跑');

  const started = Date.now();
  await launcher.stop(homeSpec);
  assert.equal(isAlive(opened.pid), false, 'stop() 返回时进程必须真的没了');
  assert.equal(proc.signalCode, 'SIGKILL', '忽略 SIGTERM 的进程应被升级为 SIGKILL');
  assert.ok(Date.now() - started >= 200, '应先等 SIGTERM 的窗口（这次是 200ms）再升级');
  assert.equal(registry.get(homeSpec.homeId).phase, 'stopped');
  assert.equal(launcher.procs.has(homeSpec.homeId), false);
});

test('stop()：连 SIGKILL 都收不掉时如实失败，并保留句柄供重试', async () => {
  const registry = new InstanceRegistry();
  const launcher = new Launcher({ registry, stopTermMs: 20, stopKillMs: 20 });
  // 用一个永不退出的句柄（真实进程无法忽略 SIGKILL，所以这里是单元级的假句柄）
  const proc = {
    pid: 4242, exitCode: null, signalCode: null,
    on() { return this; }, off() { return this; }, kill() { return true; },
  };
  launcher.procs.set('unkillable', { kind: 'dsh-web', pid: 4242, port: 34567, url: 'http://127.0.0.1:34567', proc });
  registry.set('unkillable', { phase: 'running', pid: 4242, port: 34567, url: 'http://127.0.0.1:34567' });

  await assert.rejects(() => launcher.stop({ homeId: 'unkillable', hostType: 'local' }), /未能停止实例进程/);
  assert.equal(launcher.procs.has('unkillable'), true, '句柄必须保留 —— 否则 UI 再也无法重试停止');
  assert.equal(registry.get('unkillable').phase, 'running', '进程还在跑，就不许把它写成 stopped');
  assert.match(String(registry.get('unkillable').lastError), /SIGTERM/);
});

test('stopAll()：退出前把忽略 SIGTERM 的子进程也收掉（不留孤儿）', async (t) => {
  const dir = await fakeDshOnPath(t, STUBBORN_DSH);
  const cleanup = trackExitListeners();
  t.after(cleanup);
  const home = await mkdtemp(path.join(tmpdir(), 'hwb-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));

  const launcher = new Launcher({ registry: { set() {} }, ...FAST, stopTermMs: 200, stopKillMs: 4000 });
  const homeSpec = { homeId: 'orphan-candidate', hostType: 'local', homePath: home };
  const opened = await withPath(dir, () => launcher.open(homeSpec));
  t.after(() => { try { process.kill(opened.pid, 'SIGKILL'); } catch { /* 已经死了 */ } });
  const proc = launcher.procs.get(homeSpec.homeId).proc;

  const failed = await launcher.stopAll();
  assert.equal(failed, 0, 'stopAll 应把子进程收干净');
  assert.equal(isAlive(opened.pid), false, '父进程退出前子进程必须真的没了（否则就是孤儿）');
  assert.equal(proc.signalCode, 'SIGKILL', '忽略 SIGTERM 时 stopAll 也要升级 SIGKILL');
});

test('本地直连：token 填错时必须失败（401 不等于已连接）', async (t) => {
  const dir = await fakeDshOnPath(t, FENCE_DSH);
  const cleanup = trackExitListeners();
  t.after(cleanup);
  const home = await mkdtemp(path.join(tmpdir(), 'hwb-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));

  // 先用正确 token 起一个带栅栏的 dsh web，拿到它的端口
  const starter = new Launcher({ registry: { set() {} }, ...FAST });
  const boot = { homeId: 'fence-boot', hostType: 'local', homePath: home };
  await withPath(dir, () => starter.open(boot));
  const port = starter.procs.get(boot.homeId).port;
  t.after(() => { for (const inst of starter.procs.values()) { try { inst.proc?.kill('SIGKILL'); } catch { /* 已经死了 */ } } });

  const registry = new InstanceRegistry();
  const launcher = new Launcher({ registry, ...FAST });
  const homeSpec = { homeId: 'fence-wrong-token', hostType: 'local', homePath: home, localPort: port, token: 'wrong-token' };

  const error = await launcher.open(homeSpec).then(() => null, (e) => e);
  assert.ok(error, 'token 错误时必须失败，而不是「已连接」');
  assert.match(error.message, /401/, `错误消息应说明是鉴权被拒：${error?.message}`);
  assert.equal(launcher.status(homeSpec.homeId), null, '失败就不该留下「已连接」状态');
  assert.notEqual(registry.get(homeSpec.homeId).phase, 'running');

  // 反向：token 正确时必须能连上（加了校验不能把正常路径挡住）
  const okSpec = { ...homeSpec, homeId: 'fence-right-token', token: 'right-token' };
  const connected = await launcher.open(okSpec);
  assert.match(connected.url, /token=right-token/);
  assert.equal(launcher.status(okSpec.homeId)?.port, port);
  await launcher.stop(okSpec);
});

test('Monitor 与 prober：401 不算「可用」，但 httpProbe 仍认为端口在听', async (t) => {
  const dir = await fakeDshOnPath(t, FENCE_DSH);
  const cleanup = trackExitListeners();
  t.after(cleanup);
  const home = await mkdtemp(path.join(tmpdir(), 'hwb-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));

  const starter = new Launcher({ registry: { set() {} }, ...FAST });
  const boot = { homeId: 'fence-boot2', hostType: 'local', homePath: home };
  await withPath(dir, () => starter.open(boot));
  const port = starter.procs.get(boot.homeId).port;
  t.after(() => { for (const inst of starter.procs.values()) { try { inst.proc?.kill('SIGKILL'); } catch { /* 已经死了 */ } } });

  const bare = `http://127.0.0.1:${port}/`; // 没有 token 的入口 → 401
  assert.equal(await httpProbe(bare), true, '「端口上有东西在听」这个判断里，401 是证据');
  assert.equal(await probeAlive(bare), false, '但「用户点开能不能用」这个判断里，401 就是不可用');
  assert.equal(await probeAlive(`${bare}?token=right-token`), true, '带对 token 时照常可用');

  // Monitor 默认必须用鉴权感知的那个探测：否则 token 失效的实例会一直显示 running
  const monitor = new Monitor({ store: { getHome: () => null, listHomes: () => [] }, launcher: { status: () => null } });
  assert.equal(monitor.probe, probeAlive, 'Monitor 默认探测必须是 probeAlive（401/403 判为不可用）');
});

test('open() 失败时不留僵尸：刚拉起的本机子进程必须被收掉', async (t) => {
  const dir = await fakeDshOnPath(t, STUBBORN_DSH);
  const cleanup = trackExitListeners();
  t.after(cleanup);
  const home = await mkdtemp(path.join(tmpdir(), 'hwb-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));

  // 记下子进程 pid：失败路径会把注册表刷成 stopped（pid=null），事后就查不到了。
  class SpyRegistry extends InstanceRegistry {
    constructor() { super(); this.pids = []; }
    set(id, patch) { if (patch?.pid) this.pids.push(patch.pid); return super.set(id, patch); }
  }
  const registry = new SpyRegistry();
  const launcher = new Launcher({
    registry, ...FAST, stopTermMs: 200, stopKillMs: 4000,
    // 预览代理起不来（端口占用是真实场景里最常见的一种）。
    // 关键点：open() 必须把**这次刚拉起**的 dsh web 一起收掉，而不是只标 detached ——
    // 否则注册表说 stopped、status() 返回 null，而子进程仍在监听那个端口（审查复现：僵尸 LISTEN）。
    proxyFactory: async () => { const e = new Error('listen EADDRINUSE: address already in use'); e.code = 'EADDRINUSE'; throw e; },
  });
  const homeSpec = { homeId: 'preview-fail-local', hostType: 'local', homePath: home };
  t.after(() => { for (const pid of registry.pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* 已经死了 */ } } });

  const error = await withPath(dir, () => launcher.open(homeSpec).then(() => null, (e) => e));
  assert.ok(error, '预览代理建不起来时必须失败');
  assert.match(error.message, /EADDRINUSE|被占用/);
  assert.doesNotMatch(error.message, /undefined/, '不能出现「本地端口 undefined 已被占用」这种消息');
  assert.equal(launcher.procs.has(homeSpec.homeId), false, '失败的连接不该留下句柄');
  assert.equal(registry.get(homeSpec.homeId).phase, 'stopped');

  const pid = registry.pids.at(-1);
  assert.ok(pid > 0, '前置条件：确实拉起过一个子进程');
  assert.equal(isAlive(pid), false, '失败的连接不能留下仍占着端口的僵尸进程');
});
