import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subagentStatus } from '../src/lib/status.js';
import { validateProjcacheJson } from '../src/lib/schema.js';
import { isSubagentSession, splitSubagentSessions } from '../src/web/components/subagent-visibility.js';
import { renderRecentSessions } from '../src/web/components/recent-sessions.js';
import { renderSessionStatusFilter } from '../src/web/components/session-state.js';
import { LiveStatusReader } from '../src/dshhome/live-status.js';

globalThis.document = { documentElement: { dataset: { theme: 'light' } } };
const identity = { mode: 'continuable', label: 'reviewer', seq: 12 };
const row = (id, status) => ({ homeId: 'h1', sessionId: id, title: id, status });

test('DSH 的子代理自身身份不再被误计成一个或三个子代理', () => {
  for (const raw of [identity, { identity }, { mode: 'one-shot', seq: 3 }]) {
    assert.deepEqual(subagentStatus(raw), { subagents: 0, isSubagent: true });
  }
  assert.deepEqual(subagentStatus({ identity: null }), { subagents: 0 });
  assert.deepEqual(subagentStatus({ identity: { mode: 'continuable', seq: 3 } }), { subagents: 0 });
  assert.deepEqual(subagentStatus({ mode: 'one-shot', seq: -1 }), { subagents: 0 });
});

test('父会话的 catalog/旧 child 字典计数不会成为自身身份；继承的 descriptor 不隐藏普通 fork', () => {
  assert.deepEqual(subagentStatus(null, [{ id: 'a' }, { id: 'b' }, { id: 'a' }, null]), { subagents: 2 });
  assert.deepEqual(subagentStatus({ a: {}, b: {} }), { subagents: 2 });
  assert.deepEqual(subagentStatus(null, { head: { values: [{ childId: 'b' }], previous: { values: [{ childId: 'a' }, { childId: 'b' }] } } }), { subagents: 2 });
  assert.deepEqual(subagentStatus({ identity }, undefined, 20), { subagents: 0 });
  assert.deepEqual(subagentStatus({ identity }, undefined, 12), { subagents: 0, isSubagent: true });
});

test('文件索引状态带明确子代理标记，保留普通父会话；继承前缀被排除', () => {
  const record = (subagent, inheritedEventCount = 0) => ({ identity: { createdAt: 1, inheritedEventCount }, rows: { subagent: { ver: 2, seq: 15, val: subagent } } });
  const result = validateProjcacheJson({ unit: { name: 'session_projcache', version: 7 }, tables: { sessions: { child: record({ identity }), parent: record({}), fork: record({ identity }, 20) } } });
  assert.equal(result.ok, true);
  const byId = new Map(result.sessions.map(s => [s.sessionId, s]));
  assert.equal(byId.get('child').status.isSubagent, true);
  assert.equal(byId.get('child').status.subagents, 0);
  assert.equal(byId.get('parent').status.isSubagent, undefined);
  assert.equal(byId.get('fork').status.isSubagent, undefined);
});

test('实时 RPC 使用明确 origin/父会话信息，也识别 wire descriptor；旧计数仍兼容', async () => {
  const saved = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ type: 'server-response', result: { ok: true, value: { items: [
      { sessionId: 'origin-child', origin: 'subagent', projections: { values: {} } },
      { sessionId: 'parent-linked', parentSessionId: 'parent', projections: { values: {} } },
      { sessionId: 'wire-child', projections: { values: { subagent: identity } } },
      { sessionId: 'parent', projections: { values: { subagentCatalog: [{ id: 'a' }, { id: 'b' }] } } },
    ] } } });
    const rows = await new LiveStatusReader().read('http://127.0.0.1:1/', {});
    assert.deepEqual(rows.slice(0, 3).map(s => s.status.isSubagent), [true, true, true]);
    assert.equal(rows[3].status.subagents, 2);
    assert.equal(rows[3].status.isSubagent, undefined);
  } finally { globalThis.fetch = saved; }
});

test('实时通道：父会话的「其中几个在跑」来自同一批 session/list 行', async () => {
  const saved = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ type: 'server-response', result: { ok: true, value: { items: [
      // 父会话：catalog 三个子会话，只有 a 在跑 → 1。running 是 SessionSummary 的权威信号。
      { sessionId: 'parent', running: true, projections: { values: { subagentCatalog: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] } } },
      { sessionId: 'a', running: true, parentSessionId: 'parent', projections: { values: {} } },
      { sessionId: 'b', running: false, parentSessionId: 'parent', projections: { values: {} } },
      { sessionId: 'c', running: false, parentSessionId: 'parent', projections: { values: {} } },
      // 子会话不在本批（没被索引/已归档）→ 未知，不写键（不能当 0）。
      { sessionId: 'missing', running: true, projections: { values: { subagentCatalog: [{ id: 'ghost' }] } } },
      // 父会话空闲 → 即使子行还残留 running 也不判（历史数字不贴到空闲卡上）。
      { sessionId: 'idle-parent', running: false, projections: { values: { subagentCatalog: [{ id: 'a' }] } } },
    ] } } });
    const rows = await new LiveStatusReader().read('http://127.0.0.1:1/', {});
    const byId = new Map(rows.map((r) => [r.sessionId, r]));
    assert.equal(byId.get('parent').status.subagents, 3);
    assert.equal(byId.get('parent').status.subagentsRunning, 1);
    assert.equal(byId.get('missing').status.subagentsRunning, undefined, '子会话缺失 → 未知，不写 0');
    assert.equal(byId.get('idle-parent').status.subagentsRunning, undefined, '父会话非运行中 → 不判');
  } finally { globalThis.fetch = saved; }
});

test('默认仅隐藏明确子代理；父会话和标题含 reviewer/子代理的普通会话保留', () => {
  const sessions = [row('parent', { kind: 'running', subagents: 3 }), row('child', { kind: 'idle', isSubagent: true }), row('Independent reviewer 子代理讨论', { kind: 'idle' }), row('untrusted', { isSubagent: 'true' })];
  const split = splitSubagentSessions(sessions);
  assert.deepEqual(split.visible.map(s => s.sessionId), ['parent', 'Independent reviewer 子代理讨论', 'untrusted']);
  assert.equal(split.total, 1);
  assert.equal(isSubagentSession(sessions[0]), false);
  assert.deepEqual(splitSubagentSessions(sessions, true).visible, sessions);
  assert.equal(sessions.length, 4);
});

test('开关只影响子代理会话卡；父会话上的子代理计数始终可见，状态筛选计数来自实际可见集合', () => {
  const sessions = [row('parent', { kind: 'running', subagents: 2, subagentsRunning: 1 }), row('child', { kind: 'idle', isSubagent: true })];
  const hidden = renderRecentSessions(sessions);
  assert.doesNotMatch(hidden, /data-session-id="child"/);
  // 计数与「是否列出子代理会话卡」解耦：开关关着也要能看到父会话有几个子代理。
  assert.match(hidden, /子代理 2（1 运行）/);
  const shown = renderRecentSessions(sessions, [], { showSubagents: true });
  assert.match(shown, /data-session-id="child"/);
  assert.match(shown, />子代理<\/span>/);
  assert.match(shown, /子代理 2（1 运行）/);
  const split = splitSubagentSessions(sessions);
  const filter = renderSessionStatusFilter(split.visible, 'all', { subagentCount: split.total });
  assert.match(filter, /data-status-filter="all" aria-pressed="true">全部<span>1<\/span>/);
  assert.match(filter, /data-action="toggle-subagents" aria-pressed="false"[^>]*>显示子代理<span>1<\/span>/);
  assert.match(renderSessionStatusFilter(sessions, 'all', { showSubagents: true }), /aria-pressed="true"[^>]*>隐藏子代理/);
});
