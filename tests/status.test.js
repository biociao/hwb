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

// approval 是自由文本（来自 dsh 元数据），渲染层已经转义；这里补的是**派生层**的兜底：
// 只接受字符串、限制长度。这不是转义的替代品，而是防止非字符串（对象/数组）塞进本来是标量的
// 字段、以及一个畸长值把状态 JSON 撑大。
test('deriveSessionStatus: approval 只保留字符串且限长', () => {
  const withApproval = (v) => deriveSessionStatus({ permissions: { approval: v } }).approval;
  assert.equal(withApproval('never'), 'never');
  assert.equal(withApproval('  ask  '), 'ask', '两端空白应去掉');
  assert.equal(withApproval(''), null);
  assert.equal(withApproval('   '), null);
  assert.equal(withApproval(null), null);
  assert.equal(withApproval(undefined), null);
  assert.equal(withApproval(42), null, '非字符串一律丢弃');
  assert.equal(withApproval({ toString: () => 'x' }), null);
  assert.equal(withApproval(['a']), null);
  const long = withApproval('x'.repeat(500));
  assert.ok(long.length <= 65, `超长值应被截断，实际长度 ${long.length}`);
  assert.match(long, /…$/);
});

test('deriveSessionStatus: 没有 permissions 时 approval 为 null', () => {
  assert.equal(deriveSessionStatus({}).approval, null);
  assert.equal(deriveSessionStatus().approval, null);
});
