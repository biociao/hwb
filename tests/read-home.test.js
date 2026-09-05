import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readHome, homeIdOf, parseCredentialsYaml, buildSnapshot } from '../src/lib/read-home.js';

let homePath;

function writeHome(overrides = {}) {
  homePath = mkdtempSync(path.join(tmpdir(), 'dsh-test-'));
  mkdirSync(path.join(homePath, 'storages'), { recursive: true });
  const files = {
    'storages/workspace.json': {
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: ['ws-1'] },
      tables: { workspaces: { 'ws-1': { title: 'T', path: '/r/proj', sessionIds: ['s1'] } } },
    },
    'storages/session_projcache.json': {
      unit: { name: 'session_projcache', version: 3 },
      global: null,
      tables: {
        sessions: {
          s1: {
            identity: { createdAt: 1786665487928, cwd: '/r/proj' },
            rows: {
              title: { ver: 1, seq: 1, val: 'test session' },
              tokenUsage: { ver: 1, seq: 1, val: { totals: { uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 } } },
            },
          },
        },
      },
    },
    'model-tier.json': {
      schema: 2,
      activeId: 'scheme-1',
      schemes: [{ id: 'scheme-1', tiers: { default: { provider: 'deepseek', model: 'deepseek-chat' } } }],
    },
    '.credentials.yaml': 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-real-looking-secret-value\n  KIMI_CODE_API_KEY: another-secret\n',
    ...overrides,
  };
  for (const [rel, content] of Object.entries(files)) {
    if (content === null) continue;
    writeFileSync(path.join(homePath, rel), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return homePath;
}

after(() => {
  if (homePath) rmSync(homePath, { recursive: true, force: true });
});

test('readHome produces a HomeSnapshot with 16-hex homeId', () => {
  writeHome();
  const snap = readHome(homePath);
  assert.equal(snap.homeId, homeIdOf(homePath));
  assert.match(snap.homeId, /^[0-9a-f]{16}$/);
  assert.equal(snap.wsVersion, 2);
  assert.equal(snap.pcVersion, 3);
  assert.equal(snap.workspaces.length, 1);
  assert.equal(snap.sessions.length, 1);
  assert.equal(snap.sessions[0].tokenUsage.outputTokens, 2);
  assert.equal(snap.sessions[0].title, 'test session');
  // 无状态类投影 → 默认空闲
  assert.deepEqual(snap.sessions[0].status, { kind: 'idle', label: '空闲', subagents: 0, approval: null });
  assert.equal(snap.modelTier.activeId, 'scheme-1');
  assert.deepEqual(snap.degraded, []);
});

test('readHome extracts provider names without key values', () => {
  writeHome();
  const snap = readHome(homePath);
  assert.deepEqual(snap.providers, [
    { ref: 'DEEPSEEK_API_KEY', provider: 'deepseek' },
    { ref: 'KIMI_CODE_API_KEY', provider: 'kimi' },
  ]);
  assert.ok(!JSON.stringify(snap).includes('sk-real-looking-secret-value'));
});

test('readHome degrades only the unknown-version domain', () => {
  writeHome({ 'storages/session_projcache.json': { unit: { version: 9 }, tables: { sessions: {} } } });
  const snap = readHome(homePath);
  assert.equal(snap.sessions.length, 0);
  assert.equal(snap.pcVersion, null);
  assert.equal(snap.workspaces.length, 1);
  assert.deepEqual(snap.degraded.map((d) => d.domain), ['projcache']);
  assert.match(snap.degraded[0].error, /unsupported version 9/);
});

test('readHome treats missing optional files (model-tier/credentials) as empty, not degraded', () => {
  writeHome({ 'model-tier.json': null, '.credentials.yaml': null });
  const snap = readHome(homePath);
  assert.equal(snap.modelTier, null);
  assert.equal(snap.providers.length, 0);
  assert.deepEqual(snap.degraded.map((d) => d.domain), []); // 可选文件缺失不 degraded
  assert.equal(snap.workspaces.length, 1);
});

test('readHome degrades a present but invalid model-tier.json', () => {
  writeHome({ 'model-tier.json': { schema: 2, activeId: 'x' } }); // 缺 schemes → 非法
  const snap = readHome(homePath);
  assert.equal(snap.degraded.some((d) => d.domain === 'modelTier'), true);
});

test('parseCredentialsYaml reads the refs: block, skips comments and non-keys', () => {
  const providers = parseCredentialsYaml([
    '# comment',
    'version: 1',
    'refs:',
    '  OTHER_SETTING: not-a-key',
    '  EMPTY_API_KEY:',
    '  ZAI_API_KEY: zzz',
    'other_section:',
    '  IGNORED_API_KEY: out-of-refs',
  ].join('\n'));
  assert.deepEqual(providers, [{ ref: 'ZAI_API_KEY', provider: 'zai' }]);
});

test('parseCredentialsYaml also accepts flat top-level keys', () => {
  const providers = parseCredentialsYaml('DEEPSEEK_API_KEY: x\n');
  assert.deepEqual(providers, [{ ref: 'DEEPSEEK_API_KEY', provider: 'deepseek' }]);
});

test('buildSnapshot builds the same snapshot from a pluggable readText/exists map (remote-reader shape)', () => {
  // 模拟 remote-reader 的「文件集」形式：存在 → 文本；缺失 → 不存在。
  const workspaceJson = JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['ws-1'] },
    tables: { workspaces: { 'ws-1': { title: 'R', path: '/remote/proj', sessionIds: ['s1'] } } },
  });
  const projcacheJson = JSON.stringify({
    unit: { name: 'session_projcache', version: 3 },
    global: null,
    tables: {
      sessions: {
        s1: {
          identity: { createdAt: 1, cwd: '/remote/proj' },
          rows: {
            title: { ver: 1, seq: 1, val: 'remote session' },
            tokenUsage: { ver: 1, seq: 1, val: { totals: { uncachedInputTokens: 9, outputTokens: 9, cacheReadTokens: 9, cacheWriteTokens: 9 } } },
          },
        },
      },
    },
  });
  const files = {
    'storages/workspace.json': workspaceJson,
    'storages/session_projcache.json': projcacheJson,
  };
  const snap = buildSnapshot({
    homePath: 'ssh://c4g:3080',
    readText: (rel) => {
      if (!(rel in files)) throw new Error(`missing ${rel}`);
      return files[rel];
    },
    exists: (rel) => rel in files,
  });
  assert.equal(snap.homeId, homeIdOf('ssh://c4g:3080'));
  assert.equal(snap.wsVersion, 2);
  assert.equal(snap.pcVersion, 3);
  assert.equal(snap.workspaces.length, 1);
  assert.equal(snap.sessions.length, 1);
  assert.equal(snap.sessions[0].title, 'remote session');
  assert.equal(snap.sessions[0].tokenUsage.outputTokens, 9);
  assert.equal(snap.modelTier, null);
  assert.deepEqual(snap.degraded.map((d) => d.domain), []); // 可选文件缺失不 degraded
});

test('buildSnapshot degrades a required file that readText reports missing', () => {
  const snap = buildSnapshot({
    homePath: '/h',
    readText: (rel) => { throw new Error(`missing ${rel}`); },
    exists: () => false,
  });
  assert.deepEqual(snap.degraded.map((d) => d.domain).sort(), ['projcache', 'workspace']);
  assert.equal(snap.workspaces.length, 0);
  assert.equal(snap.sessions.length, 0);
});
