import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Monitor } from '../src/control/monitor.js';
import { InstanceRegistry } from '../src/control/registry.js';
import { initLogger } from '../src/lib/logger.js';

// 单元测试静默日志，避免 degraded/removed 等路径把 warn/info 打进测试输出。
initLogger({ level: 'error', file: false, color: false, silent: true });

function fixture({ launcherInst = null, exists = true, probeOk = true, hostType = 'local', probe } = {}) {
  const home = { homeId: 'a1b2c3d4e5f60708', homePath: '/mock/home', hostType };
  const events = [];
  const state = { exists, probeOk, launcherInst };
  const monitor = new Monitor({
    store: {
      listHomes: () => (state.exists === 'removed' ? [] : [home]),
      getHome: (id) => (state.exists === 'removed' ? null : id === home.homeId ? home : null),
    },
    launcher: { status: () => state.launcherInst },
    registry: new InstanceRegistry(),
    probe: probe ?? (async () => state.probeOk),
    exists: () => state.exists === true,
    broadcast: (event, data) => events.push({ event, data }),
    intervalMs: 60_000,
  });
  return { monitor, events, state, home };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('monitor: stopped → running broadcasts instance:status once', async () => {
  const { monitor, events, state } = fixture();
  await monitor.checkNow();
  assert.equal(monitor.get('a1b2c3d4e5f60708').runtime, 'stopped');

  state.launcherInst = { url: 'http://127.0.0.1:5000', port: 5000, pid: 42 };
  await monitor.checkNow();
  const cur = monitor.get('a1b2c3d4e5f60708');
  assert.equal(cur.runtime, 'running');
  assert.equal(cur.port, 5000);

  const transitions = events.filter((e) => e.event === 'instance:status');
  assert.deepEqual(transitions.map((e) => e.data.runtime), ['stopped', 'running']);

  // 状态不变时不重复广播
  await monitor.checkNow();
  assert.equal(events.filter((e) => e.event === 'instance:status').length, 2);
});

test('monitor: running → unreachable when port stops responding', async () => {
  const { monitor, state } = fixture({ launcherInst: { url: 'http://x', port: 1, pid: 1 } });
  await monitor.checkNow();
  assert.equal(monitor.get('a1b2c3d4e5f60708').runtime, 'running');
  state.probeOk = false;
  await monitor.checkNow();
  assert.equal(monitor.get('a1b2c3d4e5f60708').runtime, 'unreachable');
});

test('monitor: gone when home path disappears, removed when unregistered', async () => {
  const { monitor, events, state } = fixture();
  await monitor.checkNow();
  state.exists = false;
  await monitor.checkNow();
  assert.equal(monitor.get('a1b2c3d4e5f60708').runtime, 'gone');

  state.exists = 'removed';
  await monitor.checkNow();
  assert.equal(monitor.get('a1b2c3d4e5f60708').runtime, 'stopped'); // 状态已从 map 删除，回落默认
  assert.ok(events.some((e) => e.event === 'instance:status' && e.data.runtime === 'removed'));
});

test('monitor: remote home (ssh:// path) is not gone; tunnel+probe => running', async () => {
  const home = { homeId: 'deadbeefdeadbeef', homePath: 'ssh://c4g:3080', hostType: 'remote' };
  const events = [];
  const state = { exists: false, probeOk: true, launcherInst: null };
  const monitor = new Monitor({
    store: { listHomes: () => [home], getHome: (id) => (id === home.homeId ? home : null) },
    launcher: { status: () => state.launcherInst },
    registry: new InstanceRegistry(),
    probe: async () => state.probeOk,
    exists: () => state.exists,
    broadcast: (event, data) => events.push({ event, data }),
    intervalMs: 60_000,
  });
  await monitor.checkNow();
  assert.equal(monitor.get(home.homeId).runtime, 'stopped'); // 无隧道（本地目录本来就不存在）
  state.launcherInst = { url: 'http://127.0.0.1:5500', port: 5500, pid: 7 };
  await monitor.checkNow();
  assert.equal(monitor.get(home.homeId).runtime, 'running');
  // 即使 homePath 本地不存在，也绝不判为 gone
  assert.notEqual(monitor.get(home.homeId).runtime, 'gone');
});

test('monitor: remote transient failures keep the connection until three failures, and success resets the count', async (t) => {
  const { monitor, state, home, events } = fixture({ hostType: 'remote', launcherInst: { url: 'http://remote', port: 1, pid: 1 } });
  t.after(() => monitor.stop());
  await monitor.refresh(home.homeId);
  state.probeOk = false;
  await monitor.refresh(home.homeId);
  await monitor.refresh(home.homeId);
  assert.equal(monitor.get(home.homeId).runtime, 'running');
  assert.equal(monitor.degradedTimers.size, 0);
  state.probeOk = true;
  await monitor.refresh(home.homeId);
  state.probeOk = false;
  await monitor.refresh(home.homeId);
  await monitor.refresh(home.homeId);
  assert.equal(monitor.get(home.homeId).runtime, 'running');
  await monitor.refresh(home.homeId);
  assert.equal(monitor.get(home.homeId).runtime, 'unreachable');
  assert.equal(monitor.registry.get(home.homeId).attempts, 1);
  assert.equal(monitor.degradedTimers.size, 1);
  state.probeOk = true;
  await monitor.refresh(home.homeId);
  assert.equal(monitor.get(home.homeId).runtime, 'running');
  assert.equal(monitor.registry.get(home.homeId).attempts, 0);
  assert.equal(monitor.degradedTimers.size, 0);
  assert.deepEqual(events.filter((e) => e.event === 'instance:status').map((e) => e.data.runtime), ['running', 'unreachable', 'running']);
});

test('monitor: remote cold failures are unreachable even if launcher tentatively set running', async (t) => {
  const inst = { url: 'http://remote', port: 1, pid: 1 };
  const { monitor, home } = fixture({ hostType: 'remote', launcherInst: inst, probeOk: false });
  t.after(() => monitor.stop());
  monitor.registry.set(home.homeId, { ...inst, phase: 'running' });
  await monitor.refresh(home.homeId);
  assert.equal(monitor.get(home.homeId).runtime, 'unreachable');
});

test('monitor: remote probes allow 10 seconds and local probes retain their 3 second limit', async (t) => {
  const timeouts = [];
  for (const hostType of ['remote', 'local']) {
    const { monitor, home } = fixture({ hostType, launcherInst: { url: 'http://test', port: 1, pid: 1 }, probe: async (url, timeoutMs) => {
      timeouts.push(timeoutMs);
      return true;
    } });
    t.after(() => monitor.stop());
    await monitor.refresh(home.homeId);
  }
  assert.deepEqual(timeouts, [10_000, 3000]);
});

test('monitor: overlapping refresh and heartbeat share one probe and count one remote failure', async (t) => {
  let outcome = true;
  let calls = 0;
  const { monitor, home } = fixture({ hostType: 'remote', launcherInst: { url: 'http://remote', port: 1, pid: 1 }, probe: async () => {
    calls++;
    return outcome;
  } });
  t.after(() => monitor.stop());
  await monitor.refresh(home.homeId);
  const pending = deferred();
  outcome = pending.promise;
  const checks = [monitor.refresh(home.homeId), monitor.checkNow(), monitor.refresh(home.homeId)];
  await new Promise(setImmediate);
  assert.equal(calls, 2);
  pending.resolve(false);
  await Promise.all(checks);
  assert.equal(monitor.get(home.homeId).runtime, 'running');
  outcome = false;
  await monitor.refresh(home.homeId);
  assert.equal(monitor.get(home.homeId).runtime, 'running');
  await monitor.refresh(home.homeId);
  assert.equal(monitor.get(home.homeId).runtime, 'unreachable');
});

test('monitor: late successful response cannot restore a disconnected instance', async (t) => {
  const pending = deferred();
  const { monitor, state, home, events } = fixture({ hostType: 'remote', launcherInst: { url: 'http://remote', port: 1, pid: 1 }, probe: () => pending.promise });
  t.after(() => monitor.stop());
  const checking = monitor.refresh(home.homeId);
  await new Promise(setImmediate);
  state.launcherInst = null;
  await monitor.refresh(home.homeId);
  pending.resolve(true);
  await checking;
  assert.equal(monitor.get(home.homeId).runtime, 'stopped');
  assert.ok(!events.some((e) => e.event === 'instance:status' && e.data.runtime === 'running'));
});

test('monitor: a switched connection is probed independently and ignores late old failures', async (t) => {
  const oldProbe = deferred();
  let outcome = true;
  const newInst = { url: 'http://new', port: 2, pid: 2 };
  const calls = [];
  const { monitor, state, home } = fixture({ hostType: 'remote', launcherInst: { url: 'http://old', port: 1, pid: 1 }, probe: async (url) => {
    calls.push(url);
    return url === 'http://old' ? oldProbe.promise : outcome;
  } });
  t.after(() => monitor.stop());
  const checkingOld = monitor.refresh(home.homeId);
  await new Promise(setImmediate);
  state.launcherInst = newInst;
  monitor.registry.set(home.homeId, { ...newInst, phase: 'running' });
  await monitor.refresh(home.homeId);
  oldProbe.resolve(false);
  await checkingOld;
  assert.equal(monitor.get(home.homeId).url, newInst.url);
  assert.equal(monitor.get(home.homeId).runtime, 'running');
  assert.deepEqual(calls, ['http://old', 'http://new']);
  outcome = false;
  await monitor.refresh(home.homeId);
  await monitor.refresh(home.homeId);
  assert.equal(monitor.get(home.homeId).runtime, 'running');
  await monitor.refresh(home.homeId);
  assert.equal(monitor.get(home.homeId).runtime, 'unreachable');
  assert.equal(calls.filter((url) => url === 'http://old').length, 1);
});

test('monitor: reconnecting at the same URL does not inherit the old successful probe', async (t) => {
  let outcome = true;
  const inst = { url: 'http://remote', port: 1, pid: 1 };
  const { monitor, home } = fixture({ hostType: 'remote', launcherInst: inst, probe: async () => outcome });
  t.after(() => monitor.stop());
  await monitor.refresh(home.homeId);
  const oldProbe = deferred();
  outcome = oldProbe.promise;
  const checkingOld = monitor.refresh(home.homeId);
  await new Promise(setImmediate);
  monitor.registry.set(home.homeId, { phase: 'stopped', url: null });
  monitor.registry.set(home.homeId, { ...inst, phase: 'running' });
  outcome = false;
  await monitor.refresh(home.homeId);
  oldProbe.resolve(true);
  await checkingOld;
  assert.equal(monitor.get(home.homeId).runtime, 'unreachable');
});

test('monitor: removing a home while its probe is pending does not recreate its registry entry', async (t) => {
  const pending = deferred();
  const { monitor, state, home } = fixture({ hostType: 'remote', launcherInst: { url: 'http://remote', port: 1, pid: 1 }, probe: () => pending.promise });
  t.after(() => monitor.stop());
  const checking = monitor.refresh(home.homeId);
  await new Promise(setImmediate);
  state.exists = 'removed';
  await monitor.checkNow();
  pending.resolve(true);
  await checking;
  assert.equal(monitor.registry.has(home.homeId), false);
  assert.equal(monitor.health.size, 0);
  assert.equal(monitor.degradedTimers.size, 0);
});

test('registry: degraded backoff escalates and resets on recovery', () => {
  const reg = new InstanceRegistry();
  reg.seed('h1');
  // 从 running 转 degraded（也验证 unknown 首探失败应回落 stopped，而非 degraded）
  reg.applyProbe('h1', { ok: false });
  assert.equal(reg.get('h1').phase, 'stopped'); // 从未 running，回落 stopped
  reg.applyProbe('h1', { ok: true, url: 'http://x', port: 1, pid: 1 });
  assert.equal(reg.get('h1').phase, 'running');
  reg.applyProbe('h1', { ok: false });
  assert.equal(reg.get('h1').phase, 'degraded');
  assert.equal(reg.get('h1').attempts, 1);
  reg.applyProbe('h1', { ok: false });
  assert.equal(reg.get('h1').attempts, 2);
  assert.ok(reg.nextBackoffMs('h1') > 1000); // attempts=2 → 2s 退避
  reg.applyProbe('h1', { ok: true, url: 'http://x', port: 1, pid: 1 });
  assert.equal(reg.get('h1').phase, 'running');
  assert.equal(reg.get('h1').attempts, 0);
  assert.equal(reg.nextBackoffMs('h1'), 1000); // 归零后回到 1s 基线
});

test('guard: fingerprint avoids killing dead/reused-pid processes', async () => {
  const { fingerprint, expectedCommand } = await import('../src/control/guard.js');
  // 我们持有且仍存活的子进程 → 可 kill
  assert.equal(fingerprint({ exitCode: null }), true);
  // 已退出（pid 可能被复用）→ 不可 kill
  assert.equal(fingerprint({ exitCode: 0 }), false);
  assert.equal(fingerprint(null), false);
  // 命令签名（供可选 ps 校验）
  assert.equal(expectedCommand({ kind: 'ssh' }).test('/usr/bin/ssh -N -L 1:2:3 host'), true);
  assert.equal(expectedCommand({ kind: 'ssh' }).test('ssh -N -L 1:2:3 host'), true);
  assert.equal(expectedCommand({ kind: 'dsh-web' }).test('dsh web --port 1'), true);
});

// 实例被移除后的兜底清理：Monitor 巡检时会发现 registry 里还留着已删除实例的条目。
// 删除 API 正常走时已经 disconnect 过，这里是「没走到 API」的兜底路径。
// 必须传 release:true —— 否则 hwb 拉起的本机 dsh web 只会被标记 detached，
// 而它在 store 里已经不可达，于是继续占着端口与 DSH_HOME 直到进程退出。
test('monitor: 移除实例的兜底清理要求 Launcher 真正回收进程（release: true）', async (t) => {
  const calls = [];
  const registry = new InstanceRegistry();
  const home = { homeId: 'gone-home', hostType: 'local', homePath: '/x', activeEndpointId: null };
  let present = true;
  const monitor = new Monitor({
    store: { listHomes: () => (present ? [home] : []), getHome: () => (present ? home : null) },
    launcher: {
      status: () => null,
      disconnect: async (h, opts) => { calls.push([h, opts]); },
    },
    registry,
    probe: async () => false,
    exists: () => true,
    broadcast: () => {},
    intervalMs: 60_000,
  });
  t.after(() => monitor.stop());
  await monitor.refresh(home.homeId);
  registry.seed(home.homeId);
  present = false; // 实例已被删除
  // 孤儿清点发生在 #checkAll（心跳整轮）里，不在单实例的 refresh 路径上。
  monitor.start();
  for (let i = 0; i < 50 && calls.length === 0; i++) await new Promise((r) => setTimeout(r, 5));

  assert.equal(calls.length, 1, `兜底清理应调用一次 disconnect，实际 ${calls.length}`);
  assert.deepEqual(calls[0][0], { homeId: home.homeId });
  assert.deepEqual(calls[0][1], { release: true }, '必须要求真正回收，不能只标记 detached');
});

// 端点切换用的临时条目（:switch 后缀）不属于「已删除实例」，不该被当成孤儿回收。
test('monitor: :switch 临时条目不参与孤儿清理', async (t) => {
  const calls = [];
  const registry = new InstanceRegistry();
  const monitor = new Monitor({
    store: { listHomes: () => [], getHome: () => null },
    launcher: { status: () => null, disconnect: async (h, opts) => { calls.push([h, opts]); } },
    registry,
    probe: async () => false,
    exists: () => true,
    broadcast: () => {},
    intervalMs: 60_000,
  });
  t.after(() => monitor.stop());
  registry.seed('staging:switch');
  monitor.start();
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(calls, [], ':switch 是端点候选，不该被回收');
});
