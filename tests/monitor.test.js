import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Monitor } from '../src/control/monitor.js';
import { InstanceRegistry } from '../src/control/registry.js';
import { initLogger } from '../src/lib/logger.js';

// 单元测试静默日志，避免 degraded/removed 等路径把 warn/info 打进测试输出。
initLogger({ level: 'error', file: false, color: false, silent: true });

function fixture({ launcherInst = null, exists = true, probeOk = true } = {}) {
  const home = { homeId: 'a1b2c3d4e5f60708', homePath: '/mock/home', hostType: 'local' };
  const events = [];
  const state = { exists, probeOk, launcherInst };
  const monitor = new Monitor({
    store: {
      listHomes: () => (state.exists === 'removed' ? [] : [home]),
      getHome: (id) => (state.exists === 'removed' ? null : id === home.homeId ? home : null),
    },
    launcher: { status: () => state.launcherInst },
    registry: new InstanceRegistry(),
    probe: async () => state.probeOk,
    exists: () => state.exists === true,
    broadcast: (event, data) => events.push({ event, data }),
    intervalMs: 60_000,
  });
  return { monitor, events, state, home };
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
