import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateWorkspaceJson,
  validateProjcacheJson,
  validateModelTierJson,
  validateCredentials,
} from '../src/lib/schema.js';

const wsFile = (workspaces, global = {}) => ({
  unit: { name: 'workspace', version: 2 },
  global: { initialized: true, workspaceIds: Object.keys(workspaces), ...global },
  tables: { workspaces },
});

test('validateWorkspaceJson accepts unit version 2 with tables map', () => {
  const r = validateWorkspaceJson(wsFile({
    'ws-1': { title: 'A', path: '/x/a', sessionIds: ['s1'], createdAt: 1786665487928, updatedAt: 1786665531377 },
  }));
  assert.equal(r.ok, true);
  assert.equal(r.version, 2);
  assert.equal(r.workspaces[0].workspaceId, 'ws-1');
  assert.equal(r.workspaces[0].archived, false);
  assert.equal(r.workspaces[0].createdAt, new Date(1786665487928).toISOString());
});

test('validateWorkspaceJson marks workspaces missing from global.workspaceIds as archived', () => {
  const r = validateWorkspaceJson(wsFile(
    { 'ws-1': { title: 'A', path: '/x/a', sessionIds: [] } },
    { workspaceIds: [] },
  ));
  assert.equal(r.ok, true);
  assert.equal(r.workspaces[0].archived, true);
});

test('validateWorkspaceJson degrades unknown version', () => {
  const r = validateWorkspaceJson({ unit: { name: 'workspace', version: 99 }, tables: { workspaces: {} } });
  assert.equal(r.ok, false);
  assert.match(r.error, /unsupported version 99/);
});

test('validateWorkspaceJson rejects missing unit version and bad tables', () => {
  assert.equal(validateWorkspaceJson({ tables: { workspaces: {} } }).ok, false);
  assert.equal(validateWorkspaceJson(null).ok, false);
  assert.equal(validateWorkspaceJson({ unit: { version: 2 } }).ok, false);
});

const pcFile = (sessions) => ({
  unit: { name: 'session_projcache', version: 3 },
  global: null,
  tables: { sessions },
});

test('validateProjcacheJson accepts version 3 and extracts rows.val', () => {
  const r = validateProjcacheJson(pcFile({
    s1: {
      identity: { createdAt: 1786665487928, cwd: '/x/a' },
      rows: {
        title: { ver: 1, seq: 1, val: 'hello' },
        tokenUsage: { ver: 1, seq: 1, val: { totals: { outputTokens: 10 } } },
        contextPressure: { ver: 1, seq: 1, val: { pressureTokens: 1, contextWindow: 100 } },
        sessionListMetadata: { ver: 1, seq: 1, val: { lastPromptAt: 1786665531377 } },
      },
    },
  }));
  assert.equal(r.ok, true);
  const s = r.sessions[0];
  assert.equal(s.title, 'hello');
  assert.equal(s.cwd, '/x/a');
  assert.deepEqual(s.tokenUsage, {
    uncachedInputTokens: 0,
    outputTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  assert.equal(s.contextPressure.contextWindow, 100);
  assert.equal(s.lastActivity, new Date(1786665531377).toISOString());
  // 无状态类投影 → 默认空闲
  assert.deepEqual(s.status, { kind: 'idle', label: '空闲', subagents: 0, approval: null });
});

test('validateProjcacheJson derives running/completed status from projections', () => {
  // 「进行中」的判定自带新鲜度门限（投影快照会冻结，见 lib/status.js），所以这个夹具必须用
  // **当前时间**：写死的历史时间戳会被判成陈旧 → idle，测试会随日期推移假失败。
  const now = Date.now();
  const r = validateProjcacheJson(pcFile({
    run: {
      identity: { createdAt: now, cwd: '/x/a' },
      rows: {
        sessionStats: { ver: 1, seq: 3, val: { openStep: { turn: 1, step: 2 } } },
        sessionListMetadata: { ver: 1, seq: 3, val: { lastPromptAt: now } },
      },
    },
    done: {
      identity: { createdAt: 1786665487928, cwd: '/x/b' },
      rows: { goal: { ver: 4, seq: 9, val: { goal: { phase: 'complete' } } } },
    },
  }));
  assert.equal(r.sessions[0].status.kind, 'running');
  assert.equal(r.sessions[1].status.kind, 'completed');
});

test('validateProjcacheJson falls back to identity.createdAt for lastActivity', () => {
  const r = validateProjcacheJson(pcFile({
    s1: { identity: { createdAt: 1786665487928, cwd: '/x/a' }, rows: {} },
  }));
  assert.equal(r.sessions[0].lastActivity, new Date(1786665487928).toISOString());
  assert.equal(r.sessions[0].contextPressure, undefined);
});

test('validateProjcacheJson degrades unknown version', () => {
  const r = validateProjcacheJson({ unit: { version: 2 }, tables: { sessions: {} } });
  assert.equal(r.ok, false);
  assert.match(r.error, /unsupported version 2/);
});

test('validateModelTierJson reads tiers from the active scheme', () => {
  const ok = validateModelTierJson({
    schema: 2,
    activeId: 'scheme-1',
    schemes: [
      { id: 'other', tiers: { default: { provider: 'x', model: 'y' } } },
      { id: 'scheme-1', tiers: { default: { provider: 'deepseek', model: 'deepseek-chat' } } },
    ],
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.modelTier.tiers.default.provider, 'deepseek');
  assert.equal(validateModelTierJson({ schema: 2, schemes: [] }).ok, false);
  assert.equal(validateModelTierJson({ schema: 1, activeId: 'x', schemes: [] }).ok, false);
  assert.equal(validateModelTierJson({ schema: 2, activeId: 'missing', schemes: [{ id: 'a', tiers: {} }] }).ok, false);
});

test('validateCredentials requires {ref, provider} entries', () => {
  assert.equal(validateCredentials([{ ref: 'A_API_KEY', provider: 'a' }]).ok, true);
  assert.equal(validateCredentials([{ ref: 'A_API_KEY' }]).ok, false);
  assert.equal(validateCredentials('nope').ok, false);
});

// tierId 直接来自 model-tier.json：`tiers['__proto__'] = …` 会走原型 setter，
// 那个 tier 会从 Object.entries 里凭空消失（normalize 于是不产出 modelTier 行），
// 同时返回对象的原型被文件内容控制。
test('validateModelTierJson: __proto__ 作为 tierId 不会污染原型、也不会静默丢 tier', () => {
  // 必须用 JSON.parse 构造：在**对象字面量**里写 `__proto__:` 是设置原型、不会产生自有属性，
  // 而真实路径正是 JSON.parse（它用 DefineOwnProperty，会真的建出自有的 "__proto__" 键）。
  const file = JSON.parse('{"schema":2,"activeId":"std","schemes":[{"id":"std","tiers":{"default":{"provider":"p","model":"m"},"__proto__":{"provider":"evil","model":"evil"}}}]}');
  const r = validateModelTierJson(file);
  assert.equal(r.ok, true);
  assert.equal(Object.getPrototypeOf(r.modelTier.tiers), null, '应使用无原型对象');
  assert.deepEqual(Object.keys(r.modelTier.tiers).sort(), ['__proto__', 'default'], 'tier 不该凭空消失');
  assert.equal(r.modelTier.tiers.default.provider, 'p');
  // 普通对象上不应出现被污染的 provider/model
  assert.equal({}.provider, undefined);
});

// dsh 的域声明（dsh-session-projection-cache/lib/index.js:89-101，实测 dsh 0.1.5-rc.1）是
// `{ name: 'session_projcache', version: 7, compatibleVersions: [3, 4, 5, 6] }`，
// 而记录形状在 3–7 之间**对 hwb 用到的字段完全一致**：
// `{ identity: { createdAt, cwd? }, rows: { key: { ver, seq, val } } }`（同包 spec.d.ts），
// 4–7 只是多了可选的 lineage 字段（formatVersion / isSeeded / inheritedEventCount）。
// hwb 原先只认 3（后来是 3/4/5）—— 一旦某个 home 被新版 dsh 标成 6/7，该域会被判 degraded、
// **整块停止更新**（「实例看起来空了」那一类）。
//
// ⚠️ 这条测试的版本清单**故意写死**，用来固定「已知契约」；而「dsh 是否又漂移了」由
// tests/compat/dsh-compat.test.js 从实际安装的 dsh 里提取后比对。两者分工不同：
// 这里防**回归**（别把已支持的版本改窄），compat 那边发现**新漂移**。
test('schema: projcache 的 3/4/5/6/7 都被接受，其它版本仍然拒绝', () => {
  const mk = (version) => ({
    unit: { name: 'session_projcache', version },
    global: null,
    tables: { sessions: { s1: {
      identity: { createdAt: 1, cwd: '/r', isSeeded: true, inheritedEventCount: 3 }, // 4+ 才有的可选字段
      rows: { title: { ver: 1, seq: 2, val: 'T' }, tokenUsage: { ver: 1, seq: 3, val: { totals: { uncachedInputTokens: 5, outputTokens: 6, cacheReadTokens: 7, cacheWriteTokens: 8 }, last: null } } },
    } } },
  });
  for (const v of [3, 4, 5, 6, 7]) {
    const res = validateProjcacheJson(mk(v));
    assert.equal(res.ok, true, `version ${v} 应被接受（实际 ${JSON.stringify(res).slice(0, 120)}）`);
    assert.equal(res.sessions[0].title, 'T');
    assert.equal(res.sessions[0].tokenUsage.uncachedInputTokens, 5, '记录形状在 3–7 之间一致');
  }
  for (const v of [0, 1, 2, 8, 99]) {
    assert.equal(validateProjcacheJson(mk(v)).ok, false, `version ${v} 必须拒绝（dsh 没有声明兼容它）`);
  }
});
