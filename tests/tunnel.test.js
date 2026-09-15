import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { withoutForwardings } from '../src/control/tunnel.js';

test('resolved SSH config retains host/auth/jump settings but only forwards the hwb port', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hwb-tunnel-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const original = path.join(dir, 'original');
  const included = path.join(dir, 'included');
  const filtered = path.join(dir, 'filtered');
  writeFileSync(included, 'Host test-hwb\n  RemoteForward 7897 127.0.0.1:7897\n  LocalForward 8888 127.0.0.1:8888\n  DynamicForward 9999\n');
  writeFileSync(original, `Include ${included}\nHost test-hwb\n  HostName 192.0.2.10\n  User bot\n  Port 2222\n  IdentityFile /tmp/hwb-test-key\n  ProxyJump jump.example\n  ClearAllForwardings no\n`);
  const resolve = args => execFileSync('ssh', ['-G', ...args, '--', 'test-hwb'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const config = resolve(['-F', original]);
  assert.match(config, /^remoteforward 7897 /m);
  writeFileSync(filtered, withoutForwardings(config));
  const result = resolve(['-F', filtered, '-o', 'ClearAllForwardings=no', '-o', 'ControlPath=none', '-L', '127.0.0.1:45678:127.0.0.1:3080']);
  assert.doesNotMatch(result, /^(remoteforward|dynamicforward) /m);
  const forwards = result.split('\n').filter(line => line.startsWith('localforward '));
  assert.equal(forwards.length, 1);
  assert.match(forwards[0], /45678.*3080/);
  for (const setting of ['hostname 192.0.2.10', 'user bot', 'port 2222', 'identityfile /tmp/hwb-test-key', 'proxyjump jump.example']) assert.ok(result.includes(setting), setting);
});

// `openTunnel` 的真实 argv 在套件里从没被测过：launcher 的测试全都注入 tunnelFactory，
// 于是「-L 映射到哪个端口」与「私有 ssh 配置快照的权限」都没人守。审查实测两种变异全绿：
//   · `-L 127.0.0.1:<local>:127.0.0.1:<remote>` 把 remote 改成 9999 → 整机远端实例全部连不上；
//   · 配置快照 `mode: 0o600` 改成 0o644 → 那份配置可能带 Host/Jump/IdentityFile，等于世界可读。
// 这里用 PATH 前置的假 ssh（与 dsh-remote-index.test.js 同一手法）把真实参数录下来。
test('openTunnel: -L 必须映射到请求的远端端口，且私有 ssh 配置快照是 0600', async (t) => {
  const { mkdtemp, mkdir, writeFile, chmod, stat } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = (await import('node:path')).default;
  const { openTunnel } = await import('../src/control/tunnel.js');
  const dir = await mkdtemp(path.join(tmpdir(), 'hwb-tunnel-argv-'));
  const bin = path.join(dir, 'bin');
  await mkdir(bin, { recursive: true });
  const fake = path.join(bin, 'ssh');
  // 假 ssh：`-G` 回一份配置；建隧道时保持存活（隧道是长连接子进程），避免真去连网。
  await writeFile(fake, `#!/bin/bash
if [ "$1" = "-G" ]; then printf 'hostname example.invalid\nport 22\n'; exit 0; fi
exec sleep 30
`);
  await chmod(fake, 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  t.after(() => { process.env.PATH = saved; });
  let tunnel = null;
  t.after(() => { try { tunnel?.proc?.kill('SIGKILL'); } catch { /* 已退出 */ } });

  tunnel = await openTunnel({ host: 'bot@example.invalid', remotePort: 4321 });
  // 直接读子进程的 spawnargs：比「让假 ssh 把 argv 写文件再读」更稳（后者要等子进程真的跑起来，
  // 我第一版就因为读得太早而 ENOENT）。
  const argv = tunnel.proc.spawnargs ?? [];
  const idx = argv.indexOf('-L');
  assert.ok(idx >= 0, `argv 里必须有 -L（实际 ${argv.join(' ')}）`);
  assert.equal(argv[idx + 1], `127.0.0.1:${tunnel.localPort}:127.0.0.1:4321`,
    '本地端口可以随机，但**远端端口必须是调用方要的那个**');
  const fIdx = argv.indexOf('-F');
  assert.ok(fIdx >= 0, 'argv 里必须有 -F <私有配置>');
  const mode = (await stat(argv[fIdx + 1])).mode & 0o777;
  assert.equal(mode, 0o600, `私有 ssh 配置快照必须 0600（实际 ${mode.toString(8)}）`);
});

// —— 隧道复用 master（2026-09-13）——
//
// 动机：dgx21 等 .tun 主机用 sshd 默认 MaxStartups 10:30:100，而该 VPN 握手要 11.7–14s，
// hwb 并发**新建**连接会堆满未认证队列被随机丢弃（实测 25 并发 → 5/25 失败，报
// "Connection closed by <host> port 22"；错开 0.6s 或 ≤8 并发则 0 失败）。
// 隧道原written死 mux:false，故成为最大受害者（hwb 日志 192 次隧道异常退出中 121 次是它）。
// 现在改为优先 `ssh -O forward` 把 -L 挂到既有 master 上 —— 完全不新建连接。
//
// 这组测试守的是「零新建连接」这个核心收益，以及合成句柄对 launcher 的子进程语义。
async function fakeSshFixture({ checkPid = 4242, failAfter = -1, forwardListener = true } = {}) {
  const { mkdtemp, mkdir, writeFile, chmod } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = (await import('node:path')).default;
  const dir = await mkdtemp(path.join(tmpdir(), 'hwb-tunnel-master-'));
  const bin = path.join(dir, 'bin');
  await mkdir(bin, { recursive: true });
  const argsLog = path.join(dir, 'args.log');
  const counter = path.join(dir, 'check.count');
  const forwardPid = path.join(dir, 'forward.pid');
  const fake = path.join(bin, 'ssh');
  // 录下每次调用的完整 argv（每行一条调用），供断言 -O 子命令与 -L 规格。
  // failAfter：第 N 次 `-O check` 之后开始失败（-1 = 永不失败），用于模拟 master 中途消失。
  // forwardListener：`-O forward` 时是否真的在本地端口上起一个监听（用 node，环境里必然有）。
  //   真 ssh 会建这个监听，而巡检正是靠「这个口还能不能连上」判断 -L 有没有丢；模拟出监听，
  //   测试才跟线上同构（此前假 ssh 不建监听，于是「master 活着但转发已丢」这个真实故障
  //   在测试里根本复现不出来）。cancel 时把监听杀掉，避免测试泄漏进程。
  await writeFile(fake, `#!/bin/bash
{ printf 'CALL'; for a in "$@"; do printf ' %s' "$a"; done; printf '\\n'; } >> ${argsLog}
SPEC=$(printf '%s\\n' "$@" | awk '/^-L$/{getline; print; exit}')
for a in "$@"; do
  if [ "$a" = "-G" ]; then printf 'hostname example.invalid\\nport 22\\n'; exit 0; fi
  if [ "$a" = "check" ]; then
    N=0; [ -f ${counter} ] && N=$(cat ${counter})
    echo $((N+1)) > ${counter}
    if [ ${failAfter} -ge 0 ] && [ "$N" -ge ${failAfter} ]; then
      echo "Control socket connect: No such file or directory" 1>&2; exit 255
    fi
    echo "Master running (pid=${checkPid})" 1>&2; exit 0
  fi
  if [ "$a" = "forward" ]; then
    if [ "${forwardListener}" = "true" ] && [ -n "$SPEC" ]; then
      LP=$(echo "$SPEC" | cut -d: -f2)
      node -e "require('net').createServer(s=>s.end()).listen($LP,'127.0.0.1')" >/dev/null 2>&1 &
      echo $! > ${forwardPid}
      sleep 0.2
    fi
    exit 0
  fi
  if [ "$a" = "cancel" ]; then
    [ -f ${forwardPid} ] && kill "$(cat ${forwardPid})" 2>/dev/null; rm -f ${forwardPid}
    exit 0
  fi
done
exec sleep 30
`);
  await chmod(fake, 0o755);
  return { dir, bin, argsLog, forwardPid };
}

async function readCalls(argsLog) {
  const { readFile } = await import('node:fs/promises');
  try {
    return (await readFile(argsLog, 'utf8')).split('\n').filter(Boolean);
  } catch { return []; }
}

// 子进程/execFile 都是异步的：断言前必须等它真的写过日志，否则会假失败（本测试第一版就踩了）。
async function waitForCall(argsLog, needle, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = (await readCalls(argsLog)).find(c => c.includes(needle));
    if (found) return found;
    if (Date.now() > deadline) {
      return { missing: true, calls: await readCalls(argsLog) };
    }
    await new Promise(r => setTimeout(r, 25));
  }
}

// 把 PATH / HWB_SSH_MUX_DIR / 巡检间隔换成假 ssh 环境，并在 t.after 还原。
async function withFakeSsh(t, fx, { pollMs = '120' } = {}) {
  const path = (await import('node:path')).default;
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { muxPath } = await import('../src/control/ssh-opts.js');
  const muxDir = path.join(fx.dir, 'mux');
  await mkdir(muxDir, { recursive: true });
  const saved = {
    PATH: process.env.PATH,
    HWB_SSH_MUX_DIR: process.env.HWB_SSH_MUX_DIR,
    HWB_TUNNEL_MASTER_POLL_MS: process.env.HWB_TUNNEL_MASTER_POLL_MS,
    HWB_TUNNEL_FORWARD_PROBE_MS: process.env.HWB_TUNNEL_FORWARD_PROBE_MS,
  };
  process.env.PATH = `${fx.bin}:${saved.PATH}`;
  process.env.HWB_SSH_MUX_DIR = muxDir;
  process.env.HWB_TUNNEL_MASTER_POLL_MS = pollMs;
  process.env.HWB_TUNNEL_FORWARD_PROBE_MS = '300';
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
  const host = 'bot@example.invalid';
  // 复用套接字「存在」是走 master 路径的前提（不存在时代码刻意跳过 -O check 以免等超时）。
  await writeFile(muxPath(host), '');
  return { host };
}

test('openTunnel: 有 master 时走 -O forward 复用（不新建连接），且 kill 会用 -O cancel 摘除', async (t) => {
  const { openTunnel } = await import('../src/control/tunnel.js');

  const fx = await fakeSshFixture();
  const { host } = await withFakeSsh(t, fx);

  const tunnel = await openTunnel({ host, remotePort: 4321 });
  t.after(() => { try { tunnel.proc.kill('SIGKILL'); } catch { /* 已退出 */ } });

  assert.equal(tunnel.viaMaster, true, '有 master 时必须走复用路径（零新建连接）');
  assert.equal(tunnel.proc.pid, 4242, '应从 `-O check` 的 stderr 解析出 master pid');
  assert.equal(tunnel.proc.exitCode, null, '存活时 exitCode 必须为 null（fingerprint 依赖）');
  assert.equal(tunnel.proc.signalCode, null);

  const forward = await waitForCall(fx.argsLog, ' forward ');
  assert.ok(!forward.missing, `必须调用 -O forward（实际调用：${JSON.stringify(forward.calls)}）`);
  assert.ok(forward.includes(`127.0.0.1:${tunnel.localPort}:127.0.0.1:4321`),
    '-L 规格必须映射到调用方要的远端端口');
  const beforeKill = await readCalls(fx.argsLog);
  assert.ok(!beforeKill.some(c => c.includes(' -N ')), '走复用路径时不应再起 -N 独占隧道');

  let exited = null;
  tunnel.proc.on('exit', (code, signal) => { exited = { code, signal }; });
  tunnel.proc.kill('SIGTERM');
  assert.equal(tunnel.proc.exitCode, 0, 'kill 后必须立刻标记死亡（与真实子进程语义一致）');
  assert.deepEqual(exited, { code: 0, signal: 'SIGTERM' }, 'kill 必须触发 exit 事件（#signalAndWait 依赖）');

  const cancel = await waitForCall(fx.argsLog, ' cancel ');
  assert.ok(!cancel.missing, `kill 必须调用 -O cancel 摘掉转发（实际：${JSON.stringify(cancel.calls)}）`);
  assert.ok(cancel.includes(`127.0.0.1:${tunnel.localPort}:127.0.0.1:4321`), 'cancel 的 -L 规格必须与 forward 一致');
});

test('openTunnel: master 巡检发现其死亡时，隧道必须报告 exit（触发 launcher 恢复）', async (t) => {
  const { openTunnel } = await import('../src/control/tunnel.js');

  // failAfter=1 → 首次 `-O check` 仍然成功（隧道得以建立），此后失败（模拟 master 中途消失）。
  const fx = await fakeSshFixture({ failAfter: 1 });
  const { host } = await withFakeSsh(t, fx);

  const tunnel = await openTunnel({ host, remotePort: 4321 });
  t.after(() => { try { tunnel.proc.kill('SIGKILL'); } catch { /* 已退出 */ } });
  assert.equal(tunnel.viaMaster, true);

  // 巡检间隔在 withFakeSsh 里压到 120ms，避免测试真等 10s。
  const deadline = Date.now() + 5000;
  while (tunnel.proc.exitCode === null && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 25));
  }
  assert.notEqual(tunnel.proc.exitCode, null, 'master 消失后隧道必须被判定为死亡');
  assert.equal(tunnel.proc.exitCode, 255);
  assert.match(tunnel.stderr(), /master 已消失/);
});

test('openTunnel: `-O check` 失败时回退为独占连接（不能因没有 master 就连不上）', async (t) => {
  const { openTunnel } = await import('../src/control/tunnel.js');

  const fx = await fakeSshFixture({ failAfter: 0 }); // master 从未存在
  const { host } = await withFakeSsh(t, fx);

  const tunnel = await openTunnel({ host, remotePort: 4321 });
  t.after(() => { try { tunnel.proc.kill('SIGKILL'); } catch { /* 已退出 */ } });
  assert.equal(tunnel.viaMaster, false, '无 master 必须回退为独占连接');

  // 回退走的是 spawn，子进程写日志是异步的 —— 必须等它落盘再断言。
  const dedicated = await waitForCall(fx.argsLog, ' -N ');
  assert.ok(!dedicated.missing, `回退路径必须是 -N 独占隧道（实际：${JSON.stringify(dedicated.calls)}）`);
  const calls = await readCalls(fx.argsLog);
  assert.ok(!calls.some(c => c.includes(' forward ')), '回退路径不应尝试 -O forward');
});

// —— 「master 活着 ≠ 转发还在」（2026-09-14）——
//
// 线上实证：hwb 报 dgx21.tun unreachable，`ssh -O check` 却回 "Master running (pid=71088)"，
// 而 `lsof -iTCP -sTCP:LISTEN` 里一个 ssh 监听都没有 —— 旧 master 崩溃后被新连接用同一
// ControlPath 复用，巡检于是永远认为隧道健康：既不重建也不报错，实例永久卡在 unreachable，
// 用户手上的入口只会回 `proxy: upstream error — connect ECONNREFUSED`。
// 修法：巡检除「master 存活」外，还要求本地转发口能建立 TCP 连接（forwardListening）。

test('openTunnel: master 活着但转发口已丢失时必须报告 exit（否则实例永久卡在 unreachable）', async (t) => {
  const { openTunnel } = await import('../src/control/tunnel.js');
  const { readFile } = await import('node:fs/promises');

  const fx = await fakeSshFixture();
  const { host } = await withFakeSsh(t, fx);
  const tunnel = await openTunnel({ host, remotePort: 4321 });
  t.after(() => { try { tunnel.proc.kill('SIGKILL'); } catch { /* 已退出 */ } });
  assert.equal(tunnel.proc.exitCode, null, '监听还在时必须是活着的隧道');

  // 只杀监听、不动 master：这正是线上那次的形态（check 说活着，-L 已经没了）。
  process.kill(Number(await readFile(fx.forwardPid, 'utf8')), 'SIGKILL');

  const deadline = Date.now() + 5000;
  while (tunnel.proc.exitCode === null && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
  assert.equal(tunnel.proc.exitCode, 255, '转发口丢失后隧道必须被判定死亡，交给 launcher 重建');
  assert.match(tunnel.stderr(), new RegExp(`127.0.0.1:${tunnel.localPort}`), '报错要指出是哪个转发口丢了');
});

test('openTunnel: -O forward 假装成功但端口没监听时，同样判定为死亡', async (t) => {
  const { openTunnel } = await import('../src/control/tunnel.js');

  const fx = await fakeSshFixture({ forwardListener: false });
  const { host } = await withFakeSsh(t, fx);
  const tunnel = await openTunnel({ host, remotePort: 4321 });
  t.after(() => { try { tunnel.proc.kill('SIGKILL'); } catch { /* 已退出 */ } });

  const deadline = Date.now() + 5000;
  while (tunnel.proc.exitCode === null && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
  assert.equal(tunnel.proc.exitCode, 255, '转发没真正建立时必须立刻暴露，而不是伪装成健康');
});
