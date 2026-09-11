import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
