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
