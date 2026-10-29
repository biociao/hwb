// 「未读」= 任务跑完了但用户还没查看。与「空闲」区分开：后者是「没事发生」，前者是「有事发生了你没看」。
//
// 两层契约：
//   · 服务端（IndexStore）：从 running 落到 idle/completed 时置未读；用户打开会话后清掉；
//     上游显式给 unread（Codex 的 read receipts）时以它为准；首次索引的老会话不算未读。
//   · 前端（session-state）：unread 压过 idle/completed 的展示，但不压 running；
//     有独立筛选/排序（待在运行中之后），chip 文案与 tooltip 说明「点击打开后标记为已读」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IndexStore } from '../src/dshhome/store.js';

globalThis.document = {
  documentElement: { dataset: { theme: 'light' } },
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
};
globalThis.window = { matchMedia: () => ({ matches: false }) };

const {
  sessionState, sessionStatusChip, SESSION_FILTERS, filterSessionState, renderSessionStatusFilter,
} = await import('../src/web/components/session-state.js');

const ISO = '2026-10-28T05:00:00.000Z';
const homeId = 'h'.repeat(16);

function snapshot(sessions) {
  return [
    { type: 'home', homeId, homePath: '/mock/home', generatedAt: ISO, degraded: [] },
    ...sessions.map((s) => ({
      type: 'session', homeId, sessionId: s.id, title: s.id, project: 'p',
      lastActivity: s.lastActivity ?? ISO, generatedAt: ISO,
      status: s.kind ? JSON.stringify({ kind: s.kind, label: s.label ?? s.kind, subagents: 0 }) : null,
      ...(s.unread === undefined ? {} : { unread: s.unread }),
    })),
  ];
}

const row = (sessionId, kind, extra = {}) => ({
  homeId, sessionId, title: sessionId, project: 'p', lastActivity: ISO,
  status: kind ? { kind, label: { running: '运行中', idle: '空闲', completed: '已完成' }[kind] ?? kind } : null,
  ...extra,
});

test('IndexStore：running → idle 置未读；粘住；打开后清除；再次运行清除', (t) => {
  const store = new IndexStore(':memory:');
  t.after(() => store.close());
  store.registerHome({ homePath: '/mock/home' });
  const unreadOf = () => store.recentSessions({ homeId }).find((s) => s.sessionId === 's1').unread;

  // 首次索引的老会话（已经是 idle）不算未读 —— 否则升级后满屏未读。
  store.upsertRows(snapshot([{ id: 's1', kind: 'idle' }]));
  assert.equal(unreadOf(), false, '首次索引不产生未读');

  store.upsertRows(snapshot([{ id: 's1', kind: 'running' }]));
  assert.equal(unreadOf(), false, '运行中不是未读');
  store.upsertRows(snapshot([{ id: 's1', kind: 'idle' }]));
  assert.equal(unreadOf(), true, '跑完落到空闲 → 未读');

  store.upsertRows(snapshot([{ id: 's1', kind: 'idle' }]));
  assert.equal(unreadOf(), true, '未读粘住，不会因为又索引一次就消失');

  assert.equal(store.markSessionViewed(homeId, 's1'), true);
  assert.equal(unreadOf(), false, '打开会话后清除');
  assert.equal(store.markSessionViewed(homeId, 's1'), false, '已读再点不重复写');

  // 跑起来 → 清未读，跑完 → 又是未读。
  store.upsertRows(snapshot([{ id: 's1', kind: 'running' }]));
  store.upsertRows(snapshot([{ id: 's1', kind: 'idle' }]));
  assert.equal(unreadOf(), true);
  store.upsertRows(snapshot([{ id: 's1', kind: 'running' }]));
  assert.equal(unreadOf(), false, '又开始跑 = 你正在用它，清掉未读');
});

test('IndexStore：上游显式 unread（Codex read receipts）优先于跃迁推断', (t) => {
  const store = new IndexStore(':memory:');
  t.after(() => store.close());
  store.registerHome({ homePath: '/mock/home' });
  const unreadOf = (id) => store.recentSessions({ homeId }).find((s) => s.sessionId === id).unread;

  store.upsertRows(snapshot([
    { id: 'c1', kind: 'idle', unread: true },
    { id: 'c2', kind: 'idle', unread: false },
  ]));
  assert.equal(unreadOf('c1'), true);
  assert.equal(unreadOf('c2'), false);
  // 未读的会话再次被索引（idle 不变）仍是未读；读过之后显式 false 才清。
  store.upsertRows(snapshot([{ id: 'c1', kind: 'idle', unread: true }]));
  assert.equal(unreadOf('c1'), true);
  store.upsertRows(snapshot([{ id: 'c1', kind: 'idle', unread: false }]));
  assert.equal(unreadOf('c1'), false);
});

test('IndexStore：点开过的 Codex 未读不会被下一轮索引的上游 receipt 原地复活', (t) => {
  const store = new IndexStore(':memory:');
  t.after(() => store.close());
  store.registerHome({ homePath: '/mock/home' });
  const unreadOf = (id) => store.recentSessions({ homeId }).find((s) => s.sessionId === id).unread;

  // 上游 receipt 说「有未读 turn」，线程最后活动在点击之前。
  store.upsertRows(snapshot([{ id: 'c1', kind: 'idle', unread: true, lastActivity: ISO }]));
  assert.equal(unreadOf('c1'), true);

  // 用户在 hwb 里点开这条会话 → 本地已读（viewedAt = 现在）。
  assert.equal(store.markSessionViewed(homeId, 'c1'), true);
  assert.equal(unreadOf('c1'), false);

  // 索引器下一轮再跑：Codex 的 read receipt 还留在库里（用户点开不等于 receipt 立刻消失），
  // 但线程活动时间没有越过点击时刻 → 同一次未读保持已读，不复活。
  store.upsertRows(snapshot([{ id: 'c1', kind: 'idle', unread: true, lastActivity: ISO }]));
  assert.equal(unreadOf('c1'), false, '同一次上游未读不应复活');
  store.upsertRows(snapshot([{ id: 'c1', kind: 'idle', unread: true, lastActivity: ISO }]));
  assert.equal(unreadOf('c1'), false, '连续多轮索引也一样');

  // 线程出现**新**活动（晚于点击时刻）→ 上游未读重新生效：这是真正的新 turn。
  const later = new Date(Date.now() + 60_000).toISOString();
  store.upsertRows(snapshot([{ id: 'c1', kind: 'idle', unread: true, lastActivity: later }]));
  assert.equal(unreadOf('c1'), true, '点击之后的新 turn 仍然是未读');
});

test('前端：未读压过「空闲」但不压「运行中」，有独立筛选与排序', () => {
  assert.deepEqual(SESSION_FILTERS.find(([key]) => key === 'unread'), ['unread', '未读']);

  const idleUnread = row('u1', 'idle', { unread: true });
  const st = sessionState(idleUnread);
  assert.equal(st.kind, 'unread');
  assert.equal(st.label, '未读');
  assert.equal(st.icon, '✦');
  assert.equal(st.saved, false, '未读时不显示「已保存」次级 chip（那是未知状态的说法）');

  // 正在跑的会话就算服务端标了未读，也显示「运行中」（事实优先）。
  assert.equal(sessionState(row('u2', 'running', { unread: true })).kind, 'running');
  // 未读标记对「状态未知」也生效（Codex 无 turn 记录但有 receipt）。
  assert.equal(sessionState(row('u3', null, { unread: true })).kind, 'unread');

  const sessions = [
    idleUnread,
    row('i1', 'idle'),
    row('r1', 'running'),
    row('iv1', 'running', { intervention: { kind: 'approval', source: 'live' } }),
  ];
  assert.deepEqual(filterSessionState(sessions, 'unread').map((s) => s.sessionId), ['u1']);
  assert.deepEqual(filterSessionState(sessions, 'other').map((s) => s.sessionId), ['i1'],
    '「其他」不包含未读：两者是可区分的状态');
  // 排序：待介入 > 运行中 > 未读 > 其它
  assert.deepEqual(filterSessionState(sessions).map((s) => s.sessionId), ['iv1', 'r1', 'u1', 'i1']);

  const filterHtml = renderSessionStatusFilter(sessions, 'all');
  assert.match(filterHtml, /data-status-filter="unread"[^>]*>未读<span>1<\/span>/);

  const chip = sessionStatusChip(idleUnread);
  assert.match(chip, /class="chip status unread"/);
  assert.match(chip, /✦<\/span>未读/);
  assert.match(chip, /点击打开后标记为已读/);
});

// 陈旧快照被降级成「空闲」不是「跑完了」：一次重启不该冒出几十条假未读（上线实测 30 条）。
// 判据是 status.observedAt（投影文件 mtime）：陈旧 ⇒ 降级；缺失（实时通道）或新鲜 ⇒ 真完成。
test('IndexStore：陈旧快照降级不算未读，真完成/实时完成才算', (t) => {
  const store = new IndexStore(':memory:');
  t.after(() => store.close());
  store.registerHome({ homePath: '/mock/home' });
  const now = Date.now();
  const write = (status) => store.upsertRows([
    { type: 'home', homeId, homePath: '/mock/home', generatedAt: ISO, degraded: [] },
    { type: 'session', homeId, sessionId: 's1', title: 's1', project: 'p', lastActivity: ISO, generatedAt: ISO, status: JSON.stringify(status) },
  ]);
  const unreadOf = () => store.recentSessions({ homeId }).find((s) => s.sessionId === 's1').unread;

  write({ kind: 'running', label: '运行中', observedAt: new Date(now - 60_000).toISOString() });
  assert.equal(unreadOf(), false);
  write({ kind: 'idle', label: '空闲', observedAt: new Date(now - 2 * 3600_000).toISOString() });
  assert.equal(unreadOf(), false, '2 小时前的快照才翻成空闲 = 陈旧闸门降级，不是完成');

  write({ kind: 'running', label: '运行中', observedAt: new Date(now - 60_000).toISOString() });
  write({ kind: 'idle', label: '空闲', observedAt: new Date(now - 5_000).toISOString() });
  assert.equal(unreadOf(), true, '新鲜快照落空闲 = 刚跑完 → 未读');

  // 实时通道写的状态没有 observedAt（live 不来自投影文件）→ 按真实完成处理。
  write({ kind: 'running', label: '运行中' });
  write({ kind: 'idle', label: '空闲' });
  assert.equal(unreadOf(), true, '实时通道报 running=false = 真完成');
});
