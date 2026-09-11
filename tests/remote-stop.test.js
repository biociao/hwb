import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { REMOTE_STOP } from '../src/control/remote.js';

const pExec = promisify(execFile);
const BASH = '/bin/bash'; // 必须绝对路径：受限 PATH 下 execFile('bash') 自己就 ENOENT

// 远端「停止 dsh web」原先只用 fuser，而且「找不到 fuser 就 echo no-fuser; exit 0」——
// 最小化的 Linux/容器镜像里没有 fuser，于是 hwb 报「已停止」、隧道也拆了，
// 而远端 dsh web 仍占着 remotePort 与 DSH_HOME（审查复现：no-fuser 分支返回 0 且什么都没杀）。
// 现在与远端启动脚本里的 killport() 用同一套判据（lsof 优先 → fuser → 明确失败），
// 并且杀完复核：还在监听就升级 SIGKILL，仍收不掉则以非 0 退出（上层会如实报失败）。
//
// 这里用**真 bash** 跑这段脚本（端口上放一个真的监听进程）—— 只断言脚本文本里「含 lsof」
// 挡不住「跑起来其实什么都没做」这一类缺陷。

const LISTENER = `
const net = require('node:net');
const srv = net.createServer(() => {});
srv.listen(0, '127.0.0.1', () => { process.stdout.write(String(srv.address().port) + '\\n'); });
process.on('SIGTERM', () => { srv.close(); process.exit(0); });
`;

// 起一个真的监听进程，返回它的端口、子进程句柄，以及「它退出了」这个 Promise。
// exited 必须在杀之前就挂好：事后 await child.on('exit') 会漏掉已经发生过的退出事件
// （第一次写这条测试就踩了：脚本明明杀掉了进程，断言却等满 5s 报 timeout）。
async function startListener() {
  const child = spawn(process.execPath, ['-e', LISTENER], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise((r) => child.on('exit', () => r('exited')));
  const port = await new Promise((resolve, reject) => {
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      const line = buf.split('\n')[0].trim();
      if (/^\d+$/.test(line)) resolve(Number(line));
    });
    child.on('exit', (code) => reject(new Error(`listener exited early: ${code}`)));
  });
  return { child, port, exited };
}

async function freePort() {
  const srv = new net.Server();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

async function runStop(port, { path = process.env.PATH } = {}) {
  try {
    const { stdout, stderr } = await pExec(BASH, ['-c', REMOTE_STOP, 'bash', String(port)], {
      env: { ...process.env, PATH: path }, timeout: 15_000,
    });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    return { ok: false, code: error.code, stdout: (error.stdout ?? '').trim(), stderr: (error.stderr ?? '').trim() };
  }
}

test('REMOTE_STOP：真的杀掉监听该端口的进程（不是打印一句话就退出 0）', async (t) => {
  const { child, port, exited } = await startListener();
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* 已经死了 */ } });

  const result = await runStop(port);
  assert.equal(result.ok, true, `脚本应成功，实际 ${JSON.stringify(result)}`);
  assert.equal(result.stdout, 'killed');

  const outcome = await Promise.race([exited, delay(5000).then(() => 'timeout')]);
  assert.equal(outcome, 'exited', '端口上的进程必须在 stop 之后真的退出');
  // 再用 signal 0 复核一次：句柄的 exit 事件也可能是「被别的信号收掉」以外的情形
  assert.throws(() => process.kill(child.pid, 0), /ESRCH/, '进程必须真的不在了');
});

test('REMOTE_STOP：端口本来就没在监听时算成功（不误报失败）', async () => {
  const port = await freePort();
  const result = await runStop(port);
  assert.equal(result.ok, true, `没在监听时不该失败：${JSON.stringify(result)}`);
  assert.equal(result.stdout, 'not-listening');
});

test('REMOTE_STOP：远端既没有 lsof 也没有 fuser 时必须明确失败（不再谎报已停止）', async (t) => {
  const { child, port } = await startListener();
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* 已经死了 */ } });

  // PATH 里什么都不留：command -v lsof / fuser 都失败 → 无法确认端口状态，只能如实报错
  const result = await runStop(port, { path: '/nonexistent-bin' });
  assert.equal(result.ok, false, '「无法确认端口状态」必须以非 0 结束，否则上层会报「已停止」');
  assert.match(result.stderr, /neither lsof nor fuser/);
});

// 结构断言：即使将来有人把脚本改回 fuser-only，也要有一条测试红掉。
test('REMOTE_STOP 的结构：优先 lsof、复核后升级 SIGKILL、没有 no-fuser 成功分支', () => {
  assert.match(REMOTE_STOP, /command -v lsof/, '必须先试 lsof（macOS/Linux 都有，fuser 在最小镜像里常常没有）');
  assert.match(REMOTE_STOP, /kill -9/, 'kill 之后要复核，仍在监听就升级 SIGKILL');
  assert.doesNotMatch(REMOTE_STOP, /echo "no-fuser"/, '「没有 fuser 就当成功」这条分支正是缺陷本身');
});
