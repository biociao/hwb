import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isNodeSupported, nodeRequirementMessage, enforceNodeVersion, MIN_NODE } from '../src/lib/node-version.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('node-version: accepts 22.5.0 and anything newer', () => {
  for (const version of ['22.5.0', '22.5.1', '22.21.1', '23.0.0', '24.1.0', 'v22.5.0']) {
    assert.equal(isNodeSupported(version), true, version);
  }
});

test('node-version: rejects the 22.0–22.4 range where node:sqlite does not exist', () => {
  for (const version of ['18.20.4', '20.11.0', '22.0.0', '22.4.9', '20.99.99']) {
    assert.equal(isNodeSupported(version), false, version);
  }
});

test('node-version: rejects a prerelease of the exact minimum', () => {
  assert.equal(isNodeSupported('22.5.0-rc.1'), false);
  assert.equal(isNodeSupported('22.5.1-rc.1'), true, 'a prerelease above the minimum is still fine');
});

test('node-version: unparsable input fails closed', () => {
  for (const version of ['', null, 'not-a-version', '22', '22.5']) {
    assert.equal(isNodeSupported(version), false, String(version));
  }
});

test('node-version: default argument reads the running Node version', () => {
  assert.equal(isNodeSupported(), isNodeSupported(process.versions.node));
  assert.match(process.versions.node, /^v?\d+\.\d+\.\d+/);
});

test('node-version: the message names the requirement and the fix, not just the failure', () => {
  const message = nodeRequirementMessage('22.4.0');
  assert.match(message, /22\.5\.0/);
  assert.match(message, /22\.4\.0/, 'should echo the running version so the user can see the gap');
  assert.match(message, /node:sqlite/);
  assert.match(message, /ERR_UNKNOWN_BUILTIN_MODULE/, 'explains the cryptic error it prevents');
  assert.match(message, /npm install/, 'warns against the wrong fix');
});

test('node-version: enforceNodeVersion prints and exits only when unsupported', () => {
  const printed = [];
  let exitCode = null;
  const deps = { exit: (code) => { exitCode = code; }, error: (line) => printed.push(line) };

  assert.equal(enforceNodeVersion('22.5.0', deps), true);
  assert.deepEqual(printed, [], 'supported version must stay silent');
  assert.equal(exitCode, null);

  assert.equal(enforceNodeVersion('22.4.0', deps), false);
  assert.equal(exitCode, 1);
  assert.equal(printed.length, 1);
  assert.match(printed[0], /需要 Node\.js/);
});

// 单一事实来源：engines 门槛、CLI 文案、预检常量必须与 node-version.js 一致，
// 否则「装了 22.4 却被 engines 放行」这类漂移会重新出现。
test('node-version: package.json engines agrees with MIN_NODE', async () => {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.engines.node, `>=${MIN_NODE}`);
});

test('node-version: server.js checks the version before importing node:sqlite', async () => {
  const server = await readFile(path.join(root, 'src/server.js'), 'utf8');
  assert.match(server, /enforceNodeVersion\(\);/);
  assert.doesNotMatch(server, /^import \{ IndexStore \} from '\.\/dshhome\/store\.js';$/m,
    'a static store.js import would evaluate node:sqlite before the version check');
  assert.match(server, /await import\('\.\/dshhome\/store\.js'\)/);
});
