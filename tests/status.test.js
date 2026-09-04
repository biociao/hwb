import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveSessionStatus } from '../src/lib/status.js';

test('idle when no activity projections', () => {
  assert.deepEqual(deriveSessionStatus(), { kind: 'idle', label: '空闲', subagents: 0, approval: null });
  assert.deepEqual(deriveSessionStatus({ sessionStats: { openStep: null, pendingCalls: {} } }),
    { kind: 'idle', label: '空闲', subagents: 0, approval: null });
});

test('running when a step is open', () => {
  const st = deriveSessionStatus({ sessionStats: { openStep: { turn: 1, step: 2 } } });
  assert.equal(st.kind, 'running');
  assert.equal(st.label, '运行中');
});

test('running when a tool call is pending / a todo is in progress / goal is active', () => {
  assert.equal(deriveSessionStatus({ sessionStats: { pendingCalls: { call_1: 1786000000000 } } }).kind, 'running');
  assert.equal(deriveSessionStatus({ todos: [{ status: 'in_progress' }] }).kind, 'running');
  assert.equal(deriveSessionStatus({ goal: { goal: { phase: 'active' } } }).kind, 'running');
});

test('completed when goal phase is complete or all todos done', () => {
  assert.equal(deriveSessionStatus({ goal: { goal: { phase: 'complete' } } }).kind, 'completed');
  assert.equal(deriveSessionStatus({ todos: [{ status: 'completed' }, { status: 'completed' }] }).kind, 'completed');
});

test('counts running subagents and carries the approval policy', () => {
  const st = deriveSessionStatus({
    subagent: { a: {}, b: {} },
    permissions: { approval: 'ask' },
    sessionStats: { openStep: { turn: 1, step: 1 } },
  });
  assert.equal(st.kind, 'running');
  assert.equal(st.subagents, 2);
  assert.equal(st.approval, 'ask');
});

test('idle goals without a phase do not force running', () => {
  assert.equal(deriveSessionStatus({ goal: null, todos: [] }).kind, 'idle');
});
