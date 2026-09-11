import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Launcher } from '../src/control/launcher.js';
import { fingerprint } from '../src/control/guard.js';

// 「断开」与「移除」必须区分开：
//   · 断开：hwb 只是撤销接入，它自己拉起的本机 dsh web 要继续跑（用户还能一键重连）；
//   · 移除：实例即将从索引里消失。若此时也只标记 detached，进程会一直占着端口与 DSH_HOME，
//     并且再也无法从任何 UI/API 触达 —— 只有 hwb 进程退出时那个 'exit' 钩子才兜底回收。

function trackExitListeners() {
  const before = new Set(process.listeners('exit'));
  return () => {
    for (const l of process.listeners('exit')) if (!before.has(l)) process.removeListener('exit', l);
  };
}

function managedInstance() {
  const killed = [];
  const inst = {
    kind: 'dsh-web',
    port: 3080,
    url: 'http://127.0.0.1:3080',
    proc: { pid: 4242, exitCode: null, signalCode: null, kill: (sig) => { killed.push(sig ?? 'SIGTERM'); } },
    previewProxy: { close: async () => {} },
  };
  return { inst, killed };
}

test('disconnect(默认)：只撤销接入，不杀 hwb 拉起的本机 dsh web', async (t) => {
  const cleanup = trackExitListeners();
  t.after(cleanup);
  const launcher = new Launcher();
  const { inst, killed } = managedInstance();
  launcher.procs.set('managed', inst);

  await launcher.disconnect({ homeId: 'managed' });
  assert.deepEqual(killed, [], '断开不应杀进程');
  assert.equal(launcher.procs.get('managed'), inst, '句柄仍保留，便于重连');
  assert.equal(inst.detached, true);
  assert.equal(launcher.status('managed'), null, '断开后对外表现为未连接');
});

test('disconnect({release:true})：移除实例时回收受管进程，避免孤儿进程占着端口', async (t) => {
  const cleanup = trackExitListeners();
  t.after(cleanup);
  const launcher = new Launcher();
  const { inst, killed } = managedInstance();
  launcher.procs.set('managed', inst);

  await launcher.disconnect({ homeId: 'managed' }, { release: true });
  assert.equal(killed.length, 1, '应真的 kill 掉 hwb 拉起的 dsh web');
  assert.equal(launcher.procs.has('managed'), false, '句柄必须从 procs 里移除');
  assert.equal(inst.detached, undefined, '移除路径不应留下 detached 标记');
  assert.equal(launcher.status('managed'), null);
});

test('disconnect({release:true})：已退出的句柄不再 kill（guard 防误杀 pid 复用）', async (t) => {
  const cleanup = trackExitListeners();
  t.after(cleanup);
  const launcher = new Launcher();
  const { inst, killed } = managedInstance();
  inst.proc.exitCode = 0; // 已经退出了
  launcher.procs.set('managed', inst);

  await launcher.disconnect({ homeId: 'managed' }, { release: true });
  assert.deepEqual(killed, [], '已退出就不该再 kill');
  assert.equal(launcher.procs.has('managed'), false);
});

test('fingerprint：被信号杀掉的子进程不再算「存活」', () => {
  assert.equal(fingerprint(null), false);
  assert.equal(fingerprint(undefined), false);
  assert.equal(fingerprint({ exitCode: null, signalCode: null }), true, '仍在运行');
  // 被 SIGKILL / OOM killer 收掉的句柄：exitCode 仍为 null，只设 signalCode。
  // 原实现只判 exitCode，于是 stop() 会对一个已被信号终止的进程报「仍在运行」。
  assert.equal(fingerprint({ exitCode: null, signalCode: 'SIGKILL' }), false);
  assert.equal(fingerprint({ exitCode: null, signalCode: 'SIGTERM' }), false);
  assert.equal(fingerprint({ exitCode: 0, signalCode: null }), false);
  assert.equal(fingerprint({ exitCode: 1, signalCode: null }), false);
});


// 等待 createProxy 落地期间实例可能失效（断开/移除/换端点）。disconnect 只关得掉「当时已经存在」
// 的代理；previewPending 只能作废那个引用，管不到这个已经跑起来的 Promise —— 于是刚监听起来、
// 又没人持有的端口会一直留到进程退出。这里用可注入的慢速 proxyFactory 精确复现该窗口。
test('预览代理就绪时实例已断开 → 回收该端口，不留孤儿监听', async (t) => {
  const cleanup = trackExitListeners();
  t.after(cleanup);
  const { createServer } = await import('node:http');
  const upstream = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><body>dsh</body></html>'); });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { upstream.closeAllConnections?.(); upstream.close(r); }));

  const closed = [];
  let releaseFactory;
  const gate = new Promise((resolve) => { releaseFactory = resolve; });
  const launcher = new Launcher({
    registry: { set() {} },
    proxyFactory: async () => {
      await gate; // 模拟 createProxy 尚未返回（真实环境下要 bind 端口、建 server）
      return { port: 45678, url: 'http://127.0.0.1:45678', retarget() {}, close: async () => { closed.push(45678); } };
    },
  });

  const home = { homeId: 'racy-preview', hostType: 'local', homePath: '/x', localPort: upstream.address().port };
  const opening = launcher.open(home);
  // 等 open() 走到 #withPreview 并挂起在 proxyFactory 上
  for (let i = 0; i < 50 && !launcher.procs.get(home.homeId)?.previewPending; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.ok(launcher.procs.get(home.homeId)?.previewPending, '前置条件：代理正在建立');

  await launcher.disconnect(home); // 代理还没就绪时断开
  // 这里走的是「直连已在跑的本机实例」(adopted-local)：hwb 不持有该进程，
  // 断开即移除句柄（与 dsh-web 的 detached 语义不同）。
  assert.equal(launcher.procs.has(home.homeId), false, '断开后句柄不再保留（adopted-local 语义）');

  releaseFactory(); // 代理现在才就绪
  await opening;

  assert.deepEqual(closed, [45678], '失效实例的预览代理必须被关掉，否则端口会一直监听');
  assert.equal(launcher.procs.get(home.homeId)?.previewProxy, undefined, '不应把代理挂到已断开的实例上');
});
