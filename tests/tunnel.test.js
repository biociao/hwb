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
