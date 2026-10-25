// hwb 侧「在 DSH 中打开会话」的单元测试：
//   · 触发器写入/读回的原子性、0600 权限、过期判定；
//   · 插件安装检测（dependencies / bundles / node_modules 软链三种痕迹）；
//   · 编排：平台/App/插件/会话 id 的分支与降级，全部通过注入的依赖驱动，不真的开 App。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_TTL_MS,
  PLUGIN_NAME,
  installHint,
  openSessionInDsh,
  pluginProfiles,
  readTriggerFile,
  triggerFileFor,
  validateSessionId,
  writeTrigger,
} from '../src/lib/open-session.js';
import { findDshAppPath } from '../src/lib/dsh-app.js';

function tempDir(prefix = 'hwb-dsh-open-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('validateSessionId：只接受白名单字符与长度 1–200', () => {
  for (const ok of ['session-1', '01a1669a-4aed-74c0', 'a_b.c:d', 'x'.repeat(200)]) {
    assert.equal(validateSessionId(ok), true, ok.slice(0, 20));
  }
  for (const bad of ['', ' ', 'a/b', 'a b', '"><x>', 'x'.repeat(201), null, 42, undefined]) {
    assert.equal(validateSessionId(bad), false, JSON.stringify(bad));
  }
});

test('writeTrigger/readTriggerFile：0600 + 原子写 + 过期判定', () => {
  const home = tempDir();
  try {
    const sessionId = 'session-abc-123';
    const trigger = writeTrigger(home, sessionId, { ttlMs: 60_000, now: () => 1_000_000, id: () => 'fixed-id' });
    assert.equal(trigger.id, 'fixed-id');
    assert.equal(trigger.sessionId, sessionId);
    assert.equal(trigger.expiresAt, 1_060_000);
    assert.equal(trigger.file, triggerFileFor(home));

    const stat = fs.statSync(trigger.file);
    assert.equal(stat.mode & 0o777, 0o600, '触发器只允许 owner 读写');
    assert.deepEqual(fs.readdirSync(path.dirname(trigger.file)), ['open-session.json'], '不能留 .tmp');

    const back = readTriggerFile(home, { now: 1_030_000 });
    assert.equal(back.id, 'fixed-id');
    assert.equal(back.sessionId, sessionId);

    // 过期：按没有触发器处理
    assert.equal(readTriggerFile(home, { now: 1_060_001 }), null);

    // 非法 sessionId：写的时候就抛，绝不把未校验内容落盘
    assert.throws(() => writeTrigger(home, 'a/b'), /无效的会话 ID/);
    assert.equal(DEFAULT_TTL_MS, 120_000);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('readTriggerFile：损坏 JSON / 非法 sessionId / 缺 id 一律 null', () => {
  const home = tempDir();
  const file = triggerFileFor(home);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'not json');
    assert.equal(readTriggerFile(home), null);

    fs.writeFileSync(file, JSON.stringify({ id: 'x', sessionId: 'a/b', expiresAt: Date.now() + 60_000 }));
    assert.equal(readTriggerFile(home), null);

    fs.writeFileSync(file, JSON.stringify({ sessionId: 'session-1', expiresAt: Date.now() + 60_000 }));
    assert.equal(readTriggerFile(home), null);

    fs.writeFileSync(file, JSON.stringify({ id: 'x', sessionId: 'session-1', expiresAt: 'later' }));
    assert.equal(readTriggerFile(home), null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('pluginProfiles：dependencies / bundles / node_modules 三种安装痕迹都认', () => {
  const home = tempDir();
  try {
    const mk = (name, pkg, linked = false) => {
      const dir = path.join(home, 'profiles', name);
      fs.mkdirSync(dir, { recursive: true });
      if (pkg !== null) fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
      if (linked) {
        const mod = path.join(dir, 'node_modules', PLUGIN_NAME);
        fs.mkdirSync(mod, { recursive: true });
        fs.writeFileSync(path.join(mod, 'package.json'), JSON.stringify({ name: PLUGIN_NAME }));
      }
    };
    mk('desktop', { dependencies: { [PLUGIN_NAME]: 'link:/x' } });
    mk('web', { dsh: { profile: { bundles: [PLUGIN_NAME] } } });
    mk('linked', {}, true);
    mk('plain', { dependencies: { lodash: '1.0.0' } });
    mk('broken', null);
    fs.mkdirSync(path.join(home, 'profiles', '.hidden'), { recursive: true });

    assert.deepEqual(pluginProfiles(home), ['desktop', 'linked', 'web']);
    assert.deepEqual(pluginProfiles(path.join(home, 'missing')), []);
    assert.deepEqual(pluginProfiles(''), []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('findDshAppPath：只在 macOS 且 .app 存在时返回路径', () => {
  const calls = [];
  const exists = (p) => { calls.push(p); return p === '/Applications/DeepSeek Harness.app'; };
  assert.equal(findDshAppPath({ platform: 'linux', exists }), null);
  assert.equal(calls.length, 0, '非 macOS 不探测文件系统');
  assert.equal(
    findDshAppPath({ platform: 'darwin', home: '/Users/x', exists }),
    '/Applications/DeepSeek Harness.app',
  );
  assert.equal(findDshAppPath({ platform: 'darwin', home: '/Users/x', exists: () => false }), null);
});

test('openSessionInDsh：已运行时聚焦、未运行时启动，触发器先落盘', async () => {
  const home = tempDir();
  const calls = [];
  const deps = {
    findDshAppPath: () => '/Applications/DeepSeek Harness.app',
    pluginProfiles: () => ['desktop'],
    writeTrigger: (homePath, sessionId) => {
      calls.push(['write', homePath, sessionId]);
      return { id: 't1', sessionId, expiresAt: 123 };
    },
    isDshAppRunning: async () => true,
    focusDshApp: async () => { calls.push(['focus']); },
    launchDshApp: async () => { calls.push(['launch']); },
  };
  try {
    const running = await openSessionInDsh({
      home: { homeId: 'h1', homePath: home },
      sessionId: 'session-1',
      platform: 'darwin',
      deps,
    });
    assert.equal(running.ok, true);
    assert.equal(running.mode, 'in-app');
    assert.equal(running.focused, true);
    assert.deepEqual(calls, [['write', home, 'session-1'], ['focus']], '必须先写触发器再聚焦');

    calls.length = 0;
    const launched = await openSessionInDsh({
      home: { homeId: 'h1', homePath: home },
      sessionId: 'session-1',
      platform: 'darwin',
      deps: { ...deps, isDshAppRunning: async () => false, launchDshApp: async (appPath) => { calls.push(['launch', appPath]); } },
    });
    assert.equal(launched.ok, true);
    assert.equal(launched.focused, false);
    assert.deepEqual(calls[0], ['write', home, 'session-1']);
    assert.deepEqual(calls[1], ['launch', '/Applications/DeepSeek Harness.app']);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('openSessionInDsh：平台/App/插件/会话 id 的降级分支', async () => {
  const home = tempDir();
  const base = {
    home: { homeId: 'h1', homePath: home },
    sessionId: 'session-1',
    platform: 'darwin',
    deps: {
      findDshAppPath: () => '/Applications/DeepSeek Harness.app',
      pluginProfiles: () => ['desktop'],
      writeTrigger: () => ({ id: 't', sessionId: 'session-1', expiresAt: 1 }),
      isDshAppRunning: async () => true,
      focusDshApp: async () => {},
      launchDshApp: async () => {},
    },
  };
  try {
    assert.deepEqual(
      pick(await openSessionInDsh({ ...base, platform: 'linux' })),
      { ok: false, code: 'platform-unsupported' },
    );
    assert.deepEqual(
      pick(await openSessionInDsh({ ...base, sessionId: 'a/b' })),
      { ok: false, code: 'bad-session-id' },
    );
    assert.deepEqual(
      pick(await openSessionInDsh({ ...base, deps: { ...base.deps, findDshAppPath: () => null } })),
      { ok: false, code: 'app-missing' },
    );
    const missing = await openSessionInDsh({
      ...base,
      deps: { ...base.deps, pluginProfiles: () => ['web'] },
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'plugin-missing');
    assert.match(missing.install, /install-dsh-open-session\.mjs/);

    // 唤起失败：触发器已落盘，仍返回 ok + warning（别让一次 open 失败变成 5xx）
    const warn = await openSessionInDsh({
      ...base,
      deps: { ...base.deps, focusDshApp: async () => { throw new Error('dsh scheme missing'); } },
    });
    assert.equal(warn.ok, true);
    assert.match(warn.warning, /dsh scheme missing/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('installHint：指向仓库安装脚本（desktop profile 由 App 独占，CLI 不能直接装）', () => {
  const hint = installHint('/Users/me/.dsh', '/repo');
  assert.equal(hint, 'node /repo/scripts/install-dsh-open-session.mjs --home /Users/me/.dsh');
});

function pick(result) {
  return { ok: result.ok, code: result.code };
}
