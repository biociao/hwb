import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REMOTE_START, defaultRemoteCmd, normalizeWebToken, selfServiceHint } from '../src/control/remote.js';

test('defaultRemoteCmd: 用向下兼容的 `dsh web --port <n>`（不带 --profile/--no-open）', () => {
  assert.equal(defaultRemoteCmd(3080), 'dsh web --port 3080');
  // 旧版 v0.1.1 会拒绝未知选项 `--profile`/`--no-open`，故默认命令必须避开它们。
  assert.ok(!defaultRemoteCmd(3080).includes('--profile'));
  assert.ok(!defaultRemoteCmd(3080).includes('--no-open'));
});


// —— 手填 token 规范化（稳定第一·自服务直连）——
test('normalizeWebToken: 完整 URL（含 LAN 尾部）→ 截取 ?token= 片段', () => {
  assert.equal(
    normalizeWebToken('http://127.0.0.1:3080/?token=AbC-xyz_123 (LAN: http://10.0.0.1:3080/?token=AbC-xyz_123)'),
    '?token=AbC-xyz_123'
  );
});

test('normalizeWebToken: token= 前缀 / 裸 token 值 / ?token= 前缀 → 统一为 ?token=<值>', () => {
  assert.equal(normalizeWebToken('token=xyz_9'), '?token=xyz_9');
  assert.equal(normalizeWebToken('?token=xyz_9'), '?token=xyz_9');
  assert.equal(normalizeWebToken('xyz_9'), '?token=xyz_9');
});

test('normalizeWebToken: 空 / 空白 / 旧版哨兵 __NO_TOKEN__ / 非字符串 → null（走远端抓取兜底）', () => {
  assert.equal(normalizeWebToken(''), null);
  assert.equal(normalizeWebToken('   '), null);
  assert.equal(normalizeWebToken('__NO_TOKEN__'), null);
  assert.equal(normalizeWebToken(null), null);
  assert.equal(normalizeWebToken(undefined), null);
  assert.equal(normalizeWebToken(42), null);
});

test('normalizeWebToken: 从含噪音字符串中抽取有效片段；纯噪音 → null', () => {
  // 与 captureDshToken 一致：token 正则到 charset 外即停，`token=xyz)` 解析出 xyz。
  assert.equal(normalizeWebToken('token=xyz)'), '?token=xyz');
  // 无 token= 前缀且不是纯 token 字符集 → 无法识别，返回 null（不猜测）。
  assert.equal(normalizeWebToken('some random text'), null);
});

// —— 用户自助命令提示（hwb 不主动打断远端实例）——
test('selfServiceHint: 无 host → 空串（无法提供命令）', () => {
  assert.equal(selfServiceHint({}), '');
  assert.equal(selfServiceHint({ remotePort: 3080 }), '');
});

test('selfServiceHint: 提供 host/remotePort → 给出可自行在远端执行的启动/读 token/查 home 命令', () => {
  const hint = selfServiceHint({ host: 'c4g.tun', remotePort: 3080 });
  assert.match(hint, /ssh c4g\.tun/);
  assert.match(hint, /dsh web --port 3080/);        // 启动命令
  assert.match(hint, /token=\[A-Za-z0-9_-\]\+/);    // 读 token 命令
  assert.match(hint, /test -d ~\/\.dsh/);           // 查 home 命令
  assert.match(hint, /hwb 不会主动打断实例/);
});

test('selfServiceHint: 尊重用户配置的 remoteCmd/remoteLog', () => {
  const hint = selfServiceHint({ host: 'h', remotePort: 4444, remoteCmd: '/opt/dsh --profile web --port 4444', remoteLog: '/var/log/dsh.log' });
  assert.match(hint, /\/opt\/dsh --profile web --port 4444/);
  assert.match(hint, /\/var\/log\/dsh\.log/);
});


// —— 向下兼容回归测试：旧版 dsh（不打印 token，如 v0.1.1）也能远程连上 ——
// 直接跑 REMOTE_START 这段真实 bash，绕过 ssh 封装，验证三件事：
//   ① 旧版启动后打印裸 URL → 立即返回 __NO_TOKEN__（不白等整个 poll 窗口）；
//   ② 新版启动后打印带 token 的 URL → 返回 token 片段；
//   ③ ensure + 端口已在监听但日志无 token → 返回 __NO_TOKEN__，且【不】killport/重启
//      （这就是旧逻辑打断一个健康旧版实例的根因）。
//
// 注：macOS 的 `netstat -tln` 无法稳定暴露 TCP listener（且无 `ss`），
// 所以这里通过替换 REMOTE_START 里的 `listening()` 定义来桩定端口探测：
//   return 0 → listening（真）；return 1 → 未 listening（假）。

// 用正则整段替换 listening() 函数体，而不是匹配一行字面量：
// 该函数已经是多行的（lsof 优先 + ss/netstat 兜底），写死单行会在实现一改动时静默失配，
// 于是 stub 没生效、真实检测照跑 —— 测试仍然「通过/失败」但测的已经不是它以为的东西。
const LISTENING_REAL = /listening\(\) \{[\s\S]*?\n\}/;
const LISTENING_TRUE = 'listening() { return 0; }';
const LISTENING_FALSE = 'listening() { return 1; }';

function withListening(script, value) {
  return script.replace(LISTENING_REAL, value);
}

function runScript(scriptText, args, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('bash', ['-s', '--', ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('script timeout')); }, timeoutMs);
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }); });
    proc.on('error', reject);
    proc.stdin.write(scriptText);
    proc.stdin.end();
  });
}

function makeTemp() {
  const dir = mkdtempSync(join(tmpdir(), 'hwb-remote-'));
  return dir;
}

// 造一个伪 dsh：启动即往 stdout 打 URL 行（`??url??` 在测试里替换成裸/带 token 两种），
// 并把自身 pid 写入 $HWB_FAKE_PIDFILE（供测试清理），随后 sleep 让人工 kill。
function makeFakeDsh(dir, urlLine) {
  const fake = join(dir, 'fake_dsh.sh');
  const pidfile = join(dir, 'fake.pid');
  writeFileSync(fake, `#!/bin/bash
echo "${urlLine}"
# 写成 pidfile 供外层清理；HWB_FAKE_PIDFILE 由测试环境注入
if [ -n "$HWB_FAKE_PIDFILE" ]; then echo $$ > "$HWB_FAKE_PIDFILE"; fi
sleep 30
`);
  chmodSync(fake, 0o755);
  return { fake, pidfile };
}

function killFake(pidfile) {
  try {
    if (existsSync(pidfile)) {
      const pid = Number(readFileSync(pidfile, 'utf8').trim());
      if (pid) process.kill(pid, 'SIGKILL');
    }
  } catch { /* already gone */ }
}

// 兜底清理：nohup 拉起的伪 dsh 可能因 pidfile 竞态未被 kill，这里按脚本路径 pkill 兜底，
// 避免测试遗留后台 sleep 进程。每个用例的 finally 都调用，保证成功/失败都不漏。
function cleanup(dir) {
  try {
    const pidfile = join(dir, 'fake.pid');
    killFake(pidfile);
    if (dir) spawnSync('pkill', ['-f', join(dir, 'fake_dsh.sh')]);
  } catch { /* 清理尽力而为 */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 已删 */ }
}

test('REMOTE_START: 旧版 dsh 打印裸 URL（无 token）→ 立即返回 __NO_TOKEN__，不白等 40s', async () => {
  const dir = makeTemp();
  try {
    const log = join(dir, 'web.log');
    const { fake } = makeFakeDsh(dir, 'dsh web: http://127.0.0.1:3080');
    const cmd = `bash ${fake}`;
    const script = withListening(REMOTE_START, LISTENING_FALSE);
    const start = Date.now();
    const r = await runScript(script, [String(3080), log, cmd, '40', 'ensure'], { timeoutMs: 8000 });
    const elapsed = Date.now() - start;
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '__NO_TOKEN__');
    // 关键：旧版应【立即】用裸 URL 兜底，而不是等满 40s poll 窗口。
    assert.ok(elapsed < 6000, `返回过慢（${elapsed}ms），违背向下兼容的快速兜底`);
  } finally {
    cleanup(dir);
  }
});

test('REMOTE_START: 新版 dsh 打印带 token 的 URL → 返回 token 片段', async () => {
  const dir = makeTemp();
  try {
    const log = join(dir, 'web.log');
    const urlLine = 'dsh web: http://127.0.0.1:3080/?token=AbC-xyz_123 (LAN: http://10.0.0.1:3080/?token=AbC-xyz_123)';
    const { fake } = makeFakeDsh(dir, urlLine);
    const cmd = `bash ${fake}`;
    const script = withListening(REMOTE_START, LISTENING_FALSE);
    const r = await runScript(script, [String(3080), log, cmd, '40', 'ensure'], { timeoutMs: 8000 });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '?token=AbC-xyz_123');
  } finally {
    cleanup(dir);
  }
});

test('REMOTE_START: ensure + 已在监听但日志无 token（旧版在跑）→ 返回 __NO_TOKEN__ 且不重启', async () => {
  const dir = makeTemp();
  try {
    const log = join(dir, 'web.log');
    // 日志里只有裸 URL（旧版），没有 ?token=
    writeFileSync(log, 'dsh web: http://127.0.0.1:3080\n');
    // cmd 若被误执行会写一个 marker；这里断言 marker 不存在 —— 证明没有 killport/重启。
    const marker = join(dir, 'cmd-ran');
    const { fake } = makeFakeDsh(dir, 'dsh web: http://127.0.0.1:3080');
    const cmd = `bash ${fake} && touch ${marker}`;
    const script = withListening(REMOTE_START, LISTENING_TRUE); // 桩定“端口在监听”
    const r = await runScript(script, [String(3080), log, cmd, '40', 'ensure'], { timeoutMs: 8000 });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '__NO_TOKEN__');
    // 核心断言：未触碰 cmd（未 killport/未重启健康旧版实例）。
    assert.equal(existsSync(marker), false, 'ensure 模式下不应重启已在监听的旧版实例');
  } finally {
    cleanup(dir);
  }
});

test('REMOTE_START: ensure + 已在监听且日志有 token（新版在跑）→ 直接复用并返回 token', async () => {
  const dir = makeTemp();
  try {
    const log = join(dir, 'web.log');
    writeFileSync(log, 'dsh web: http://127.0.0.1:3080/?token=existing_tok\n');
    const marker = join(dir, 'cmd-ran');
    const { fake } = makeFakeDsh(dir, 'dsh web: http://127.0.0.1:3080/?token=should_not_run');
    const cmd = `bash ${fake} && touch ${marker}`;
    const script = withListening(REMOTE_START, LISTENING_TRUE);
    const r = await runScript(script, [String(3080), log, cmd, '40', 'ensure'], { timeoutMs: 8000 });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '?token=existing_tok');
    // 复用已跑实例，不应重新启动。
    assert.equal(existsSync(marker), false);
  } finally {
    cleanup(dir);
  }
});

test('REMOTE_START: endpoint switch never starts a missing remote service', async () => {
  const dir = makeTemp();
  try {
    const marker = join(dir, 'cmd-ran');
    const script = withListening(REMOTE_START, LISTENING_FALSE);
    const r = await runScript(script, ['4080', join(dir, 'web.log'), `touch ${marker}`, '1', 'connect']);
    assert.notEqual(r.code, 0);
    assert.equal(existsSync(marker), false);
  } finally { cleanup(dir); }
});
