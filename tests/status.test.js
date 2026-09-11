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

// 投影缓存是**快照**：进程被杀 / 机器休眠 / 会话被放弃后，里面「进行中」的标记会永久冻结。
// 实测真实 home：179 个会话里 18 个被判 running，全部空闲 7–28 天，0 个在 10 分钟内 ——
// 也就是说仪表盘在撒谎。这里锁定两条规则：陈旧则降级为 idle；plan.active 只是模式开关。
test('deriveSessionStatus: 陈旧的活动信号降级为 idle（投影快照会冻结）', () => {
  const now = Date.now();
  const at = (ms) => new Date(now - ms).toISOString();
  const MIN = 60_000;
  const runningShapes = [
    { sessionStats: { openStep: 3 } },
    { sessionStats: { pendingCalls: { a: 1 } } },
    { todos: [{ status: 'in_progress' }] },
    { goal: { goal: { phase: 'active' } } },
    { plan: { running: { commandId: 'c' } } },
  ];
  for (const shape of runningShapes) {
    assert.equal(deriveSessionStatus({ ...shape, lastActivity: at(1 * MIN) }).kind, 'running',
      `新鲜的应判 running: ${JSON.stringify(shape)}`);
    assert.equal(deriveSessionStatus({ ...shape, lastActivity: at(20 * 24 * 60 * MIN) }).kind, 'idle',
      `陈旧 20 天的必须降级为 idle: ${JSON.stringify(shape)}`);
  }
  // 没有时间信息时不做判断（例如只从实时通道来的会话）
  assert.equal(deriveSessionStatus({ sessionStats: { openStep: 3 } }).kind, 'running');
  // 无法解析的时间戳同样不判断
  assert.equal(deriveSessionStatus({ sessionStats: { openStep: 3 }, lastActivity: 'garbage' }).kind, 'running');
  // completed 不受新鲜度影响
  assert.equal(deriveSessionStatus({ goal: { goal: { phase: 'complete' } }, lastActivity: at(30 * 24 * 60 * MIN) }).kind, 'completed');
});

test('deriveSessionStatus: plan.active 是持久模式开关，不表示「正在跑」', () => {
  const fresh = new Date().toISOString();
  // 空闲状态下 plan 模式开着：{active: true, running: null} 是 plan 模式的正常稳态
  assert.equal(deriveSessionStatus({ plan: { active: true }, lastActivity: fresh }).kind, 'idle',
    'active 只是模式开关；把它当活动信号会让开过 plan 模式的会话永久显示「运行中」');
  assert.equal(deriveSessionStatus({ plan: { running: null, active: true }, lastActivity: fresh }).kind, 'idle');
  // 真正在跑的是 running（进行中的 /plan 命令）
  assert.equal(deriveSessionStatus({ plan: { running: { commandId: 'c' }, active: true }, lastActivity: fresh }).kind, 'running');
  assert.equal(deriveSessionStatus({ plan: { running: { commandId: 'c' } }, lastActivity: fresh }).kind, 'running');
});
