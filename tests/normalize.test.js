import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../src/lib/normalize.js';

function snapshot() {
  return {
    homeId: 'a1b2c3d4e5f60708',
    homePath: '/home/u/.dsh',
    generatedAt: '2026-09-04T01:00:00.000Z',
    wsVersion: 2,
    pcVersion: 3,
    workspaces: [
      { workspaceId: 'ws-1', title: 'Alpha', path: '/repo/alpha-app', archived: false, sessionIds: ['s1', 's2'] },
    ],
    sessions: [
      {
        sessionId: 's1',
        cwd: '/repo/alpha-app',
        title: 'first session',
        tokenUsage: { uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
        contextPressure: { pressureTokens: 5, projectedTokens: 6, contextWindow: 100 },
        status: { kind: 'running', label: '运行中', subagents: 0, approval: 'ask' },
        lastActivity: '2026-09-04T00:59:00.000Z',
      },
      { sessionId: 's-orphan', cwd: '/repo/alpha-app', title: '', tokenUsage: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      { sessionId: 's-nowhere', cwd: '', title: '', tokenUsage: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    ],
    modelTier: { activeId: 'std', tiers: { std: { provider: 'deepseek', model: 'deepseek-chat' } } },
    providers: [{ ref: 'DEEPSEEK_API_KEY', provider: 'deepseek' }],
    degraded: [],
  };
}

test('normalize joins sessions to workspaces via sessionIds inversion', () => {
  const rows = normalize(snapshot());
  const s1 = rows.find((r) => r.type === 'session' && r.sessionId === 's1');
  assert.equal(s1.workspaceId, 'ws-1');
  assert.equal(s1.project, 'alpha-app');
  assert.equal(s1.workspaceTitle, 'Alpha');
  assert.equal(s1.title, 'first session');
  assert.deepEqual(JSON.parse(s1.tokenUsage).outputTokens, 2);
  assert.deepEqual(JSON.parse(s1.contextPressure).contextWindow, 100);
  assert.deepEqual(JSON.parse(s1.status), { kind: 'running', label: '运行中', subagents: 0, approval: 'ask' });
  assert.equal(s1.lastActivity, '2026-09-04T00:59:00.000Z');
});

test('normalize handles orphan sessions via cwd and missing contextPressure', () => {
  const rows = normalize(snapshot());
  const orphan = rows.find((r) => r.type === 'session' && r.sessionId === 's-orphan');
  assert.equal(orphan.workspaceId, null);
  assert.equal(orphan.project, 'alpha-app');
  assert.equal(orphan.workspaceTitle, null);
  assert.equal(orphan.contextPressure, null);
  const nowhere = rows.find((r) => r.type === 'session' && r.sessionId === 's-nowhere');
  assert.equal(nowhere.project, 'unknown');
});

test('normalize emits home/workspace/provider/modelTier rows', () => {
  const rows = normalize(snapshot());
  const home = rows.find((r) => r.type === 'home');
  assert.equal(home.homeId, 'a1b2c3d4e5f60708');
  assert.deepEqual(home.degraded, []);

  const ws = rows.find((r) => r.type === 'workspace');
  assert.equal(ws.project, 'alpha-app');
  assert.equal(ws.sessionCount, 1);

  assert.deepEqual(rows.filter((r) => r.type === 'provider'), [
    { type: 'provider', homeId: home.homeId, ref: 'DEEPSEEK_API_KEY', provider: 'deepseek' },
  ]);

  const tier = rows.find((r) => r.type === 'modelTier');
  assert.equal(tier.tierId, 'std');
  assert.equal(tier.active, true);
});

test('normalize carries degraded domains onto the home row', () => {
  const s = snapshot();
  s.degraded.push({ domain: 'projcache', error: 'unsupported version 9', degraded: true });
  const home = normalize(s).find((r) => r.type === 'home');
  assert.equal(home.degraded[0].domain, 'projcache');
});

// node:sqlite 绑 TEXT 时按 C 字符串处理：值里的 U+0000 会把后面**全部静默截掉**（没有报错、
// 没有 degraded）。实测（审查）：`run('A\u0000B')` 读回 `'A'`，`run('\u0000leading')` 读回 `''`。
// 外部 dsh home 的 title / cwd / path 里一旦有 NUL，入库时就只剩前半截 —— 界面上看不出少了什么。
// 现在在产出侧（normalize）统一剥掉 NUL。
test('normalize: 文本字段里的 NUL 会被剥掉（否则入库时被静默截断）', () => {
  const rows = normalize({
    homeId: 'h1', homePath: '/p', generatedAt: 'now', wsVersion: 2, pcVersion: 3,
    workspaces: [{ workspaceId: 'ws-1', title: 'A\u0000B', path: '/r/\u0000x', archived: false, sessionIds: ['s1'] }],
    sessions: [{ sessionId: 's1', title: '\u0000leading', cwd: '/r/demo', lastActivity: 'now' }],
    providers: [{ ref: 'X\u0000API_KEY', provider: 'x' }],
    modelTier: null, degraded: [],
  });
  const ws = rows.find((r) => r.type === 'workspace');
  assert.equal(ws.title, 'AB', 'NUL 剥掉而不是截断到 NUL 之前');
  assert.equal(ws.path, '/r/x');
  const sess = rows.find((r) => r.type === 'session');
  assert.equal(sess.title, 'leading', '开头的 NUL 也要剥掉（原先整个值会变成空串）');
  assert.equal(sess.workspaceTitle, 'AB');
  assert.equal(rows.find((r) => r.type === 'provider').ref, 'XAPI_KEY');
});
