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
  const r = validateProjcacheJson(pcFile({
    run: {
      identity: { createdAt: 1786665487928, cwd: '/x/a' },
      rows: { sessionStats: { ver: 1, seq: 3, val: { openStep: { turn: 1, step: 2 } } } },
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
