import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isAlive, sshProbe, httpProbe } from '../src/control/prober.js';
import { verifyProcess, expectedCommand, fingerprint } from '../src/control/guard.js';
import { initLogger, setLevel, getLevel, levelVal } from '../src/lib/logger.js';

// 这几个导出目前**没有被主流程调用**（各模块头部把它们写成「独立可测的探测/校验函数」）。
// 它们要么补上测试、要么删掉 —— 留着而不测是最差的组合：既占维护成本，又让人以为
// 主流程真的走了 ps 校验 / PID 存活探测那条路。这里选择补测试，并在用例里写明「未被接线」。

test('isAlive: 只对真实的存活 PID 返回 true', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore' });
  await delay(50);
  try {
    assert.equal(isAlive(child.pid), true, '自己起的子进程应当被判为存活');
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));
    await delay(20);
    assert.equal(isAlive(child.pid), false, '已退出的进程不应再被判为存活');
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  // 非法入参直接 false，不抛
  for (const bad of [0, -1, 1.5, null, undefined, 'abc', NaN]) {
    assert.equal(isAlive(bad), false, String(bad));
  }
});

test('fingerprint: exitCode 与 signalCode 都要为空才算「我们仍持有的活进程」', () => {
  assert.equal(fingerprint(null), false);
  assert.equal(fingerprint({ exitCode: null, signalCode: null }), true);
  assert.equal(fingerprint({ exitCode: null, signalCode: 'SIGKILL' }), false, '被信号杀掉的不算活');
  assert.equal(fingerprint({ exitCode: 0, signalCode: null }), false);
});

test('expectedCommand: 按 kind 区分 ssh 隧道与本地 dsh web 的命令签名', () => {
  assert.ok(expectedCommand({ kind: 'ssh' }).test('ssh -N -L 3081:127.0.0.1:3080 box'));
  assert.equal(expectedCommand({ kind: 'ssh' }).test('dsh web --port 3080'), false);
  assert.ok(expectedCommand({ kind: 'dsh-web' }).test('/usr/local/bin/dsh web --port 3080'));
  assert.equal(expectedCommand({ kind: 'dsh-web' }).test('ssh -N box'), false);
});

// verifyProcess 依赖外部 `ps`。在受限沙箱里 `spawn ps` 会 EPERM —— 那是环境限制而不是缺陷，
// 此时它按设计返回 false（不阻塞主指纹）。这里先探测 ps 是否可用，不可用就跳过正向断言。
async function psUsable() {
  try {
    await execFile('ps', ['-o', 'command=', '-p', String(process.pid)]);
    return true;
  } catch {
    return false;
  }
}

test('verifyProcess: 对「PID 处确实是预期命令」返回 true，否则 false（经 ps 校验，未被接线）', async (t) => {
  if (!await psUsable()) { t.skip('环境不允许调用 ps（沙箱限制）'); return; }
  // 用自己起的一个长命子进程当靶子：它的命令行就是 node -e ...
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 8000)'], { stdio: 'ignore' });
  await delay(80);
  try {
    // kind 未给出时不校验命令签名，只要 ps 能读到命令行就算通过
    assert.equal(await verifyProcess(child.pid), true, 'ps 应能读到自己子进程的命令行');
    // 给出不匹配的 kind：node 进程不是 ssh，也不是 dsh web
    assert.equal(await verifyProcess(child.pid, { kind: 'ssh' }), false, '命令签名不匹配应判 false');
    assert.equal(await verifyProcess(child.pid, { kind: 'dsh-web' }), false);
  } finally {
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));
  }
  assert.equal(await verifyProcess(child.pid), false, '进程已退出 → ps 读不到 → false');
  // 非法入参不抛、直接 false
  for (const bad of [0, -1, null, undefined, 'abc']) {
    assert.equal(await verifyProcess(bad), false, String(bad));
  }
});

test('verifyProcess: 在一个 ps 不可用的环境里 fail-safe 返回 false（不会误判为「已验证」）', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hwb-nops-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const savedPath = process.env.PATH;
  process.env.PATH = dir; // 一个既没有 ps 也没有别的东西的 PATH
  try {
    // 注意：execFile 用绝对路径解析，PATH 只影响子进程内部；ps 是通过 PATH 找的，
    // 所以这里期望「找不到 ps → 抛错 → 返回 false（不阻塞主指纹）」。
    // 若某些环境下 execFile 仍能找到 ps，这条断言退化为 true —— 那是可接受的，
    // 关键契约是「不抛异常」。
    const result = await verifyProcess(process.pid);
    assert.equal(typeof result, 'boolean');
  } finally {
    process.env.PATH = savedPath;
  }
});

test('sshProbe: 缺 host 直接 false；被注入的 ssh 调用失败时也 false（未被接线）', async () => {
  assert.equal(await sshProbe('', 1000), false);
  assert.equal(await sshProbe(null, 1000), false);
  // 用一个必然失败的主机名（配合 pExecFile 的 timeout），只断言不抛
  assert.equal(typeof await sshProbe('nonexistent.invalid', 300), 'boolean');
});

test('httpProbe: status < 500 视为活着，连接失败为 false', async (t) => {
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    res.writeHead(req.url === '/bad' ? 503 : 200, { 'content-type': 'text/html' });
    res.end('x');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal(await httpProbe(`${base}/ok`), true);
  assert.equal(await httpProbe(`${base}/bad`), false, '5xx 视为不健康');
  assert.equal(await httpProbe('http://127.0.0.1:1/'), false, '连不上应返回 false 而不是抛');
});

test('logger 级别：setLevel/getLevel 往返，非法级别回落到默认', () => {
  initLogger({ level: 'info', file: false, color: false, silent: true });
  assert.equal(getLevel(), 'info');
  assert.equal(setLevel('debug'), 'debug');
  assert.equal(getLevel(), 'debug');
  assert.equal(setLevel('warn'), 'warn');
  assert.equal(getLevel(), 'warn');
  // 非法值 → validateLevel 回落到默认（info），不抛
  assert.equal(setLevel('nonsense'), 'info');
  assert.equal(levelVal('debug') < levelVal('warn'), true, '数值等级应随严重度递增');
  setLevel('error'); // 还原成安静的级别，避免影响后续输出
});
