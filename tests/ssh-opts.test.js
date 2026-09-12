import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sshOpts, isTransientSshError, withConnectRetry, muxEnabled, muxPath, muxPathUsable, sshPolicySummary } from '../src/control/ssh-opts.js';

// 背景回归（2026-09）：hwb 原硬编码 `ConnectTimeout=10`，而经 tun 的远端建连实测需
// 11.7–14.0s，导致所有脚本化 ssh（抓 token / 建隧道 / 探测）必然 255 失败，
// 表现为「终端手动 ssh 能连、hwb 连不上」。以下断言锁定修复后的连接策略。

const valueOf = (opts, key) => {
  const i = opts.indexOf(`-o`);
  const found = opts.find((o) => o.startsWith(`${key}=`));
  return found ? found.slice(key.length + 1) : undefined;
};

test('sshOpts: ConnectTimeout 必须宽于实测建连耗时（>10s，默认 30s）', () => {
  const opts = sshOpts({ host: 'bot@dgx21.tun' });
  const timeout = Number(valueOf(opts, 'ConnectTimeout'));
  assert.ok(Number.isFinite(timeout), 'ConnectTimeout 必须存在');
  assert.ok(timeout >= 15, `ConnectTimeout=${timeout} 不足以覆盖 11.7–14s 的建连耗时`);
});

test('sshOpts: 保活参数齐备（ServerAlive + TCPKeepAlive）', () => {
  const opts = sshOpts({ host: 'h' });
  assert.ok(Number(valueOf(opts, 'ServerAliveInterval')) > 0, '需要 ServerAliveInterval');
  assert.ok(Number(valueOf(opts, 'ServerAliveCountMax')) > 0, '需要 ServerAliveCountMax');
  assert.equal(valueOf(opts, 'TCPKeepAlive'), 'yes');
  // 判死窗口不宜过长：间隔 × 次数应在数分钟内，否则掉线后长时间静默僵死。
  const windowSec = Number(valueOf(opts, 'ServerAliveInterval')) * Number(valueOf(opts, 'ServerAliveCountMax'));
  assert.ok(windowSec <= 300, `保活判死窗口 ${windowSec}s 过长`);
});

test('sshOpts: 默认启用连接复用（ControlMaster=auto + ControlPersist）', () => {
  const opts = sshOpts({ host: 'h' });
  assert.equal(valueOf(opts, 'ControlMaster'), 'auto');
  assert.ok(valueOf(opts, 'ControlPath'), 'ControlPath 必须存在才能复用');
  assert.ok(Number(valueOf(opts, 'ControlPersist')) > 0, 'ControlPersist 让 master 在客户端退出后存活');
});

test('sshOpts: 不传 host（如 ssh -G 解析配置）时不加复用参数', () => {
  const opts = sshOpts({});
  assert.equal(valueOf(opts, 'ControlMaster'), undefined);
  assert.equal(valueOf(opts, 'ControlPath'), undefined);
});

test('sshOpts: 可显式关闭复用', () => {
  const opts = sshOpts({ host: 'h', mux: false });
  assert.equal(valueOf(opts, 'ControlMaster'), undefined);
});

test('sshOpts: BatchMode 保持开启（免交互，防止 SSH 挂起等密码）', () => {
  assert.equal(valueOf(sshOpts({ host: 'h' }), 'BatchMode'), 'yes');
});

test('muxPath: 按 host 隔离、长度在平台上限内（macOS unix socket 104 字节）', () => {
  const a = muxPath('bot@dgx21.tun');
  const b = muxPath('bot@c4g.tun');
  assert.notEqual(a, b, '不同主机不得共用套接字');
  assert.equal(muxPath('bot@dgx21.tun'), a, '同一主机映射必须稳定（否则无法复用）');
  assert.ok(a.length <= 104, `套接字路径过长: ${a.length} bytes`);
  assert.ok(muxPathUsable(a));
  assert.equal(muxPathUsable('x'.repeat(105)), false);
  assert.equal(muxEnabled(), true);
});

test('sshOpts: 路径超限时放弃复用而不是让 ssh 报错（ControlPath too long）', () => {
  const saved = process.env.HWB_SSH_MUX_DIR;
  process.env.HWB_SSH_MUX_DIR = '/tmp/' + 'x'.repeat(120);
  try {
    const opts = sshOpts({ host: 'bot@dgx21.tun' });
    assert.equal(valueOf(opts, 'ControlPath'), undefined, '超限时必须不加 ControlPath');
    // 但连接策略的其余部分（超时/保活）仍须生效，保证仍能连上。
    assert.ok(Number(valueOf(opts, 'ConnectTimeout')) >= 15);
  } finally {
    if (saved === undefined) delete process.env.HWB_SSH_MUX_DIR;
    else process.env.HWB_SSH_MUX_DIR = saved;
  }
});

test('isTransientSshError: 识别本次故障原文（connect to host ... timed out）', () => {
  assert.equal(isTransientSshError('ssh: connect to host 10.8.0.21 port 22: Operation timed out'), true);
  assert.equal(isTransientSshError('ssh: connect to host 10.8.0.21 port 22: Connection refused'), true);
  assert.equal(isTransientSshError('mux_client_request_session: read from master failed'), true);
  // 业务性失败（远端脚本报错）不应触发重试，否则会重复执行远端动作。
  assert.equal(isTransientSshError('bash: dsh: command not found'), false);
  assert.equal(isTransientSshError('endpoint is not listening'), false);
  assert.equal(isTransientSshError(''), false);
});

test('withConnectRetry: 连接级快速失败会重试并最终成功', async () => {
  let calls = 0;
  const r = await withConnectRetry(async () => {
    calls += 1;
    return calls < 3
      ? { ok: false, stderr: 'ssh: connect to host 10.8.0.21 port 22: Operation timed out', elapsedMs: 30_000 }
      : { ok: true, stdout: '?token=abc' };
  }, { retries: 2, delaysMs: [1, 1] });
  assert.equal(r.ok, true);
  assert.equal(calls, 3, '应重试到成功');
});

test('withConnectRetry: 业务性失败不重试', async () => {
  let calls = 0;
  const r = await withConnectRetry(async () => {
    calls += 1;
    return { ok: false, stderr: 'bash: dsh: command not found', elapsedMs: 900 };
  }, { retries: 2, delaysMs: [1, 1] });
  assert.equal(r.ok, false);
  assert.equal(calls, 1, '非连接级故障只应尝试一次');
});

test('withConnectRetry: 慢失败（可能是真断线）不重试，避免拖时间', async () => {
  let calls = 0;
  const r = await withConnectRetry(async () => {
    calls += 1;
    return { ok: false, stderr: 'ssh: connect to host h port 22: Operation timed out', elapsedMs: 60_000 };
  }, { retries: 2, delaysMs: [1, 1] });
  assert.equal(calls, 1);
  assert.equal(r.ok, false);
});

test('sshPolicySummary: 暴露生效参数，便于运行期核对', () => {
  const s = sshPolicySummary();
  assert.ok(s.connectTimeout >= 15);
  assert.equal(typeof s.keepAliveInterval, 'number');
  assert.equal(s.multiplexing, true);
});
