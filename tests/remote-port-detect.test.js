import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { REMOTE_START } from '../src/control/remote.js';

const pExec = promisify(execFile);

// 远端「端口是否在监听」的检测必须跨 Linux 与 BSD(macOS) 都能用。
//
// 原生实现只用 ss + netstat -tln + fuser —— 三者都是 Linux 专有。远端若是 macOS，
// listening() 恒为 false、killport() 是空操作：ensure 模式会跳过「复用已在跑的服务」又去起
// 一个新 dsh（端口被占起不来），日志轮询等满 40s 拿到 __NO_TOKEN__，最后 hwb 却把实例报成
// running —— 仪表盘一片绿，iframe 里是 401。现在优先用 lsof（macOS/Linux 都有）。

// 从 REMOTE_START 里抽出这两个函数（它们紧跟 PATH 补齐之后），在真 bash 里跑。
function extractHelpers() {
  const start = REMOTE_START.indexOf('listening() {');
  const end = REMOTE_START.indexOf('# ensure +');
  assert.ok(start > 0 && end > start, 'helpers not found in REMOTE_START');
  return REMOTE_START.slice(start, end).trim();
}

const HELPERS = extractHelpers();

// 注意：必须用 bash 的**绝对路径**。给子进程一个受限的 PATH 时，execFile('bash', …)
// 的解析也会受那个 PATH 影响，反而变成 "spawn bash ENOENT"，测不到脚本本身的行为。
const BASH = '/bin/bash';

async function runHelper(kind, port, { path = process.env.PATH } = {}) {
  const script = `port="${port}"\n${HELPERS}\n${kind}`;
  try {
    const { stdout } = await pExec(BASH, ['-c', script], { env: { ...process.env, PATH: path }, timeout: 10_000 });
    return { ok: true, stdout: stdout.trim() };
  } catch (error) {
    return { ok: false, stdout: (error.stdout ?? '').trim(), code: error.code };
  }
}

// 在一个**独立进程**里起监听：killport 会真的 kill 掉这个进程（不能杀掉测试自己）。
function startListener() {
  const child = spawn(process.execPath, ['-e', `
    const net = require('net');
    const s = net.createServer(() => {});
    s.listen(0, '127.0.0.1', () => process.stdout.write(String(s.address().port) + '\\n'));
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => {
    child.stdout.once('data', (d) => resolve({ child, port: Number(String(d).trim()) }));
    child.once('error', reject);
    setTimeout(() => reject(new Error('listener did not start')), 5000);
  });
}

test('listening(): 有监听时返回 0，端口空着时返回 1（lsof 路径）', async (t) => {
  const { child, port } = await startListener();
  t.after(() => child.kill());

  const up = await runHelper('listening && echo YES || echo NO', port);
  assert.equal(up.stdout, 'YES', `lsof 检测不到正在监听的端口：${JSON.stringify(up)}`);

  // 找一个确定空闲的端口（起一下再关掉）
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const freePort = probe.address().port;
  await new Promise((r) => probe.close(r));

  const down = await runHelper('listening && echo YES || echo NO', freePort);
  assert.equal(down.stdout, 'NO', `空闲端口不该被判成在监听：${JSON.stringify(down)}`);
});

test('listening(): 没有 lsof 时退回 ss/netstat（老路径仍在，但会退化）', async (t) => {
  const { child, port } = await startListener();
  t.after(() => child.kill());

  // 模拟「没有 lsof，ss/netstat/fuser 也都没有」的极简远端：PATH 里只留 grep。
  // 旧代码在这种环境下恒判「未监听」，正是线上问题的成因；这里断言它确实退化成 NO
  // —— 以此说明 lsof 分支才是 BSD 远端的保障。
  const shim = await pExec(BASH, ['-c', 'mktemp -d']).then((r) => r.stdout.trim());
  t.after(async () => { await pExec(BASH, ['-c', `rm -rf '${shim}'`]).catch(() => {}); });
  await pExec(BASH, ['-c', `ln -s "$(command -v grep)" '${shim}/grep'`]);

  const degraded = await runHelper('listening && echo YES || echo NO', port, { path: shim });
  assert.equal(degraded.ok, true, `缺工具时不应抛错，只是判定退化：${JSON.stringify(degraded)}`);
  assert.equal(degraded.stdout, 'NO', '缺 lsof/ss/netstat 时必然退化 —— 正是需要 lsof 分支的原因');
});

test('killport(): 真的能回收远端端口（BSD 上 fuser 不存在时也有效）', async (t) => {
  const { child, port } = await startListener();
  let alive = true;
  child.once('exit', () => { alive = false; });
  t.after(() => { if (alive) child.kill(); });

  const killed = await runHelper('killport; echo done', port);
  assert.equal(killed.stdout, 'done', `killport 执行失败：${JSON.stringify(killed)}`);

  for (let i = 0; i < 40 && alive; i++) await delay(50);
  assert.equal(alive, false, 'killport 没有回收掉该端口上的进程（BSD 上 fuser 缺失时会是这样）');

  const after = await runHelper('listening && echo YES || echo NO', port);
  assert.equal(after.stdout, 'NO', '回收后不应再被判为在监听');
});

test('REMOTE_START: lsof 分支位于 ss/netstat 之前（结构约束，避免被改回去）', () => {
  const lsofAt = HELPERS.indexOf('command -v lsof');
  const ssAt = HELPERS.indexOf('ss -tln');
  assert.ok(lsofAt > 0, 'lsof 分支必须存在');
  assert.ok(ssAt > lsofAt, 'lsof 必须作为首选分支出现在 ss/netstat 之前');
  assert.doesNotMatch(HELPERS, /xargs\s+-r/, 'BSD 的 xargs 没有 -r，不能用它');
});
