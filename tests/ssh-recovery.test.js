import { after, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { InstanceRegistry } from '../src/control/registry.js';
import { initLogger } from '../src/lib/logger.js';

initLogger({ level: 'error', file: false, color: false, silent: true });

// These tests never create real SSH or dsh processes, including on a regression
// that accidentally falls back to ensureRemoteToken during automatic recovery.
const spawnGuard = mock.method(childProcess, 'spawn', () => {
  throw new Error('ssh-recovery tests forbid real child processes');
});
const execFileGuard = mock.method(childProcess, 'execFile', () => {
  throw new Error('ssh-recovery tests forbid real external commands');
});
syncBuiltinESMExports();
const [{ Launcher }, { Monitor }] = await Promise.all([
  import('../src/control/launcher.js'),
  import('../src/control/monitor.js'),
]);
after(() => {
  spawnGuard.mock.restore();
  execFileGuard.mock.restore();
  syncBuiltinESMExports();
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function until(predicate, message) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await sleep(5);
  }
}

function fakeProc(pid) {
  const proc = new EventEmitter();
  Object.assign(proc, { pid, exitCode: null, signalCode: null, killed: false, killCalls: 0 });
  proc.exit = (code = 255, signal = null) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    proc.exitCode = code;
    proc.signalCode = signal;
    proc.emit('exit', code, signal);
  };
  proc.kill = (signal = 'SIGTERM') => {
    proc.killCalls++;
    proc.killed = true;
    proc.exit(null, signal);
    return true;
  };
  return proc;
}

async function fixture(t, { recoveryDelaysMs = [10, 20, 30], recoveryCooldownMs, waitHttp = async () => true, tunnelFactoryWait = async () => {} } = {}) {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><head></head><body>session-deeplink local dsh mock</body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const upstreamPort = server.address().port;
  const tunnels = [];
  const remoteStops = [];
  let readinessCalls = 0;
  const registry = new InstanceRegistry();
  const exitListeners = new Set(process.listeners('exit'));
  const launcher = new Launcher({
    registry,
    tunnelFactory: async (options) => {
      const proc = fakeProc(7000 + tunnels.length);
      tunnels.push({ proc, options });
      await tunnelFactoryWait(tunnels.length);
      return { proc, url: `http://127.0.0.1:${upstreamPort}`, localPort: upstreamPort, stderr: () => '' };
    },
    remotePathExists: async () => true,
    stopRemoteFn: async (home) => { remoteStops.push(home.homeId); },
    waitHttp: (...args) => waitHttp(++readinessCalls, ...args),
    tunnelReadyDelayMs: 0,
    recoveryDelaysMs,
    ...(recoveryCooldownMs === undefined ? {} : { recoveryCooldownMs }),
  });
  const home = {
    homeId: 'ssh-recovery-local-mock',
    homePath: 'ssh://mock.invalid:3080',
    hostType: 'remote',
    host: 'mock.invalid',
    remotePort: 3080,
    remoteHome: '/mock/dsh-home',
    token: 'token=local-test-token',
  };
  const monitor = new Monitor({
    launcher,
    registry,
    store: { listHomes: () => [home], getHome: (id) => id === home.homeId ? home : null },
    // Even a stale proxy that still answers must not make a dead SSH connection
    // healthy while its replacement is being established.
    probe: async () => true,
    intervalMs: 60_000,
  });
  t.after(async () => {
    monitor.stop();
    for (const homeId of [...launcher.procs.keys()]) await launcher.disconnect({ ...home, homeId });
    for (const listener of process.listeners('exit')) {
      if (!exitListeners.has(listener)) process.off('exit', listener);
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { launcher, registry, monitor, home, tunnels, remoteStops, readinessCalls: () => readinessCalls };
}

async function assertClosed(url) {
  await assert.rejects(fetch(url, { signal: AbortSignal.timeout(1000) }), /fetch failed/);
}

test('ssh recovery retains the browser port while replacing its upstream and closing the old upstream proxy', async (t) => {
  const ready = deferred();
  const f = await fixture(t, { waitHttp: (attempt) => attempt === 2 ? ready.promise : true });
  const original = await f.launcher.open(f.home);
  await f.monitor.refresh(f.home.homeId);
  assert.equal(f.monitor.get(f.home.homeId).runtime, 'running');

  f.tunnels[0].proc.exit();
  assert.equal(f.launcher.status(f.home.homeId)?.url, original.url);
  assert.equal(f.registry.get(f.home.homeId).phase, 'degraded');
  await until(() => f.readinessCalls() === 2, 'automatic replacement did not begin');
  await f.monitor.refresh(f.home.homeId);
  assert.equal(f.monitor.get(f.home.homeId).runtime, 'unreachable');
  assert.equal(f.monitor.get(f.home.homeId).url, original.url);
  assert.equal(f.launcher.status(f.home.homeId).iframeUrl, original.iframeUrl);

  ready.resolve(true);
  await until(() => f.registry.get(f.home.homeId).phase === 'running', 'replacement did not become ready');
  const recovered = f.launcher.status(f.home.homeId);
  assert.notEqual(recovered.url, original.url);
  assert.equal(recovered.iframeUrl, original.iframeUrl);
  assert.equal(new URL(recovered.url).search, new URL(original.url).search);
  assert.equal(recovered.pid, f.tunnels[1].proc.pid);
  assert.equal(f.registry.get(f.home.homeId).url, recovered.url);
  assert.equal(f.registry.get(f.home.homeId).attempts, 0);
  assert.match(await (await fetch(recovered.url)).text(), /local dsh mock/);
  assert.match(await (await fetch(recovered.iframeUrl)).text(), /__hwb\/preview-bridge\.js/);
  await assertClosed(original.url);
  assert.match(await (await fetch(original.iframeUrl)).text(), /local dsh mock/);
  await f.monitor.refresh(f.home.homeId);
  assert.equal(f.monitor.get(f.home.homeId).runtime, 'running');
  assert.equal(f.tunnels.length, 2);
  assert.deepEqual(f.tunnels.map(({ options }) => options), [
    { host: f.home.host, remotePort: f.home.remotePort },
    { host: f.home.host, remotePort: f.home.remotePort },
  ]);
});

test('ssh recovery gives up after its finite backoff budget and keeps the existing page URL', async (t) => {
  const delays = [10, 20, 30];
  const f = await fixture(t, {
    recoveryDelaysMs: delays,
    waitHttp: (attempt) => {
      if (attempt > 1) throw new Error('mock upstream temporarily unavailable');
      return true;
    },
  });
  const original = await f.launcher.open(f.home);
  f.tunnels[0].proc.exit();
  await until(() => f.readinessCalls() === 1 + delays.length, 'automatic retries did not consume the configured budget');
  await until(() => f.tunnels.slice(1).every(({ proc }) => proc.killed), 'failed replacement tunnels were not cleaned up');
  await sleep(100);
  assert.equal(f.tunnels.length, 1 + delays.length);
  assert.equal(f.launcher.status(f.home.homeId)?.url, original.url);
  assert.equal(f.launcher.status(f.home.homeId)?.iframeUrl, original.iframeUrl);
  await f.monitor.refresh(f.home.homeId);
  assert.equal(f.monitor.get(f.home.homeId).runtime, 'unreachable');
  assert.equal(f.monitor.get(f.home.homeId).url, original.url);
});

for (const action of ['disconnect', 'stop']) {
  test(`${action} cancels a scheduled SSH recovery and closes both page entries`, async (t) => {
    const f = await fixture(t, { recoveryDelaysMs: [40] });
    const original = await f.launcher.open(f.home);
    f.tunnels[0].proc.exit();
    await f.launcher[action](f.home);
    await sleep(80);
    assert.equal(f.tunnels.length, 1);
    assert.equal(f.launcher.status(f.home.homeId), null);
    assert.equal(f.registry.get(f.home.homeId).phase, 'stopped');
    assert.equal(f.registry.get(f.home.homeId).url, null);
    assert.equal(f.registry.get(f.home.homeId).iframeUrl, null);
    await f.monitor.refresh(f.home.homeId);
    assert.equal(f.monitor.get(f.home.homeId).runtime, 'stopped');
    assert.equal(f.monitor.get(f.home.homeId).url, null);
    await assertClosed(original.url);
    await assertClosed(original.iframeUrl);
    assert.deepEqual(f.remoteStops, action === 'stop' ? [f.home.homeId] : []);
  });
}

for (const action of ['disconnect', 'stop']) {
  for (const outcome of ['success', 'failure']) {
    test(`${action} cancels an in-flight SSH replacement and ignores its late ${outcome}`, async (t) => {
      const ready = deferred();
      const f = await fixture(t, { waitHttp: (attempt) => attempt === 2 ? ready.promise : true });
      await f.launcher.open(f.home);
      f.tunnels[0].proc.exit();
      await until(() => f.readinessCalls() === 2, 'replacement did not reach readiness check');
      await f.launcher[action](f.home);
      if (outcome === 'success') ready.resolve(true);
      else ready.reject(new Error('late failure of cancelled replacement'));
      await until(() => f.tunnels[1].proc.killed, 'cancelled replacement tunnel was not killed');
      await sleep(80);
      assert.equal(f.tunnels.length, 2);
      assert.equal(f.launcher.status(f.home.homeId), null);
      assert.equal(f.registry.get(f.home.homeId).phase, 'stopped');
      assert.equal(f.registry.get(f.home.homeId).url, null);
      assert.equal(f.registry.get(f.home.homeId).iframeUrl, null);
      assert.deepEqual(f.remoteStops, action === 'stop' ? [f.home.homeId] : []);
    });
  }
}

test('a late failed recovery cannot overwrite a newer explicit connection', async (t) => {
  const ready = deferred();
  const f = await fixture(t, { waitHttp: (attempt) => attempt === 2 ? ready.promise : true });
  await f.launcher.open(f.home);
  f.tunnels[0].proc.exit();
  await until(() => f.readinessCalls() === 2, 'old replacement did not begin');
  await f.launcher.disconnect(f.home);
  const next = await f.launcher.open(f.home);
  ready.reject(new Error('obsolete replacement failed'));
  await sleep(80);
  assert.equal(f.tunnels.length, 3);
  assert.equal(f.launcher.status(f.home.homeId)?.url, next.url);
  assert.equal(f.launcher.status(f.home.homeId)?.iframeUrl, next.iframeUrl);
  assert.equal(f.registry.get(f.home.homeId).phase, 'running');
  assert.equal(f.registry.get(f.home.homeId).url, next.url);
  assert.equal(f.registry.get(f.home.homeId).lastError, null);
  assert.equal(f.tunnels[1].proc.killed, true);
  assert.equal(f.tunnels[2].proc.killed, false);
});

test('disconnect before the tunnel factory resolves prevents an unregistered candidate from replacing a new connection', async (t) => {
  const created = deferred();
  const f = await fixture(t, { tunnelFactoryWait: (attempt) => attempt === 2 ? created.promise : undefined });
  await f.launcher.open(f.home);
  f.tunnels[0].proc.exit();
  await until(() => f.tunnels.length === 2, 'replacement tunnel factory did not begin');
  assert.equal(f.readinessCalls(), 1, 'candidate must still be awaiting its factory');
  await f.launcher.disconnect(f.home);
  const next = await f.launcher.open(f.home);
  created.resolve();
  await until(() => f.tunnels[1].proc.killed, 'late unregistered candidate was not released');
  await sleep(80);
  assert.equal(f.tunnels.length, 3);
  assert.equal(f.readinessCalls(), 2);
  assert.equal(f.launcher.status(f.home.homeId)?.url, next.url);
  assert.equal(f.launcher.status(f.home.homeId)?.iframeUrl, next.iframeUrl);
  assert.equal(f.registry.get(f.home.homeId).phase, 'running');
  assert.equal(f.registry.get(f.home.homeId).url, next.url);
  assert.equal(f.tunnels[2].proc.killed, false);
});

test('a late successful recovery cannot undo an endpoint switch', async (t) => {
  const ready = deferred();
  const f = await fixture(t, { waitHttp: (attempt) => attempt === 2 ? ready.promise : true });
  const original = await f.launcher.open(f.home);
  f.tunnels[0].proc.exit();
  await until(() => f.readinessCalls() === 2, 'old replacement did not begin');
  const next = await f.launcher.switchEndpoint(f.home, { ...f.home, host: 'new-mock.invalid', remotePort: 4080 });
  assert.equal(next.iframeUrl, original.iframeUrl, 'switching endpoints retains the browser cache origin');
  ready.resolve(true);
  await sleep(80);
  assert.equal(f.tunnels.length, 3);
  assert.equal(f.launcher.status(f.home.homeId)?.url, next.url);
  assert.equal(f.launcher.status(f.home.homeId)?.iframeUrl, next.iframeUrl);
  assert.equal(f.registry.get(f.home.homeId).phase, 'running');
  assert.equal(f.registry.get(f.home.homeId).url, next.url);
  assert.equal(f.tunnels[1].proc.killed, true);
  assert.equal(f.tunnels[2].proc.killed, false);
  assert.equal(f.tunnels[2].options.host, 'new-mock.invalid');
});

test('open immediately starts a waiting recovery and concurrent opens share its one attempt', async (t) => {
  const ready = deferred();
  const f = await fixture(t, { recoveryDelaysMs: [70], waitHttp: (attempt) => attempt === 2 ? ready.promise : true });
  await f.launcher.open(f.home);
  f.tunnels[0].proc.exit();
  const first = f.launcher.open(f.home);
  const second = f.launcher.open(f.home);
  assert.equal(f.tunnels.length, 2, 'open should start one replacement before the retry timer fires');
  await until(() => f.readinessCalls() === 2, 'open did not start the replacement');
  await sleep(90);
  assert.equal(f.tunnels.length, 2);
  ready.resolve(true);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.url, b.url);
  assert.equal(a.iframeUrl, b.iframeUrl);
  assert.equal(a.url, f.launcher.status(f.home.homeId).url);
  assert.equal(f.registry.get(f.home.homeId).phase, 'running');
});

// 快退避预算用尽后必须还能自愈。
// 原生实现里 #scheduleRecovery 在预算用尽时**直接 return，什么状态都不清**：recovering 永远为真，
// 于是 status() 跳过「进程已死」判断继续吐出失效 URL，Monitor 走 recovering 分支既不探测也不安排
// 重连 —— 网络恢复后实例永远回不来，而且换一条通道连同一实例会被 409 判成「已被占用」。
// 现在预算用尽后转入慢速常驻重试（recoveryCooldownMs），这里把冷却压到 40ms 验证它真的会重试并恢复。
test('ssh recovery keeps self-healing after the fast budget is exhausted', async (t) => {
  let upstreamDown = true;
  const f = await fixture(t, {
    recoveryDelaysMs: [10, 20],
    recoveryCooldownMs: 40,
    // 第 1 次是初次连接（必须成功），之后的重连在 upstreamDown 期间失败。
    waitHttp: (attempt) => {
      if (attempt === 1) return true;
      if (upstreamDown) throw new Error('mock upstream temporarily unavailable');
      return true;
    },
  });
  const original = await f.launcher.open(f.home);
  f.tunnels[0].proc.exit();

  // 快退避两次都用尽（tunnels: 原 1 + 2 次重试）
  await until(() => f.readinessCalls() === 1 + 2, 'fast backoff budget was not consumed');
  assert.equal(f.launcher.status(f.home.homeId)?.url, original.url, '预算用尽后仍保留旧入口，页面不白屏');

  // 网络恢复：下一次冷却重试应当成功，实例自愈
  upstreamDown = false;
  await until(() => f.readinessCalls() > 1 + 2, 'cooldown retry never happened after the fast budget was exhausted');
  // 等到重连真正完成：status().recovering 归位为 false（只看 url 不能区分「旧入口仍在」与「已重连」）
  await until(() => f.launcher.status(f.home.homeId)?.recovering === false, 'cooldown retry did not complete the reconnect');
  await f.monitor.refresh(f.home.homeId);
  assert.equal(f.monitor.get(f.home.homeId).runtime, 'running', '网络恢复后实例必须能自愈为 running');
});

// 反向保证：冷却重试并不是「无脑刷」——真正被取消（disconnect/stop）后不能再安排任何重试。
test('ssh recovery cooldown stops once the instance is disconnected', async (t) => {
  const f = await fixture(t, {
    recoveryDelaysMs: [10, 20],
    recoveryCooldownMs: 30,
    waitHttp: (attempt) => { if (attempt === 1) return true; throw new Error('down'); },
  });
  await f.launcher.open(f.home);
  f.tunnels[0].proc.exit();
  await until(() => f.readinessCalls() === 1 + 2, 'fast backoff budget was not consumed');
  await f.launcher.disconnect(f.home);
  const tunnelsAtDisconnect = f.tunnels.length;
  await sleep(150);
  assert.equal(f.tunnels.length, tunnelsAtDisconnect, '取消后不得再建隧道');
});
