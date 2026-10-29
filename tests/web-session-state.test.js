import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionState, filterSessionState, renderSessionStatusFilter } from '../src/web/components/session-state.js';
import { renderSearchResults } from '../src/web/components/search-results.js';
import { renderRecentSessions } from '../src/web/components/recent-sessions.js';

globalThis.document = { documentElement: { dataset: { theme: 'light' } } };
const row = (id, status, lastActivity = '2026-10-26T01:00:00Z') => ({ homeId: 'h1', sessionId: id, title: id, project: 'P1', lastActivity, status });

test('保存记录和缺失状态均为未知，只有明确的 idle 才显示空闲', () => {
  for (const status of [null, {}, { kind: 'idle', label: '已保存' }, { kind: 'idle', label: 'Codex' }, { kind: 'new-state' }]) {
    assert.equal(sessionState(row('s', status)).kind, 'unknown');
  }
  assert.equal(sessionState(row('idle', { kind: 'idle' })).label, '空闲');
  assert.equal(sessionState(row('done', { kind: 'completed' })).kind, 'completed');
});

test('状态筛选不改变输入，运行中优先，同状态按最近活动排序；未知归其他', () => {
  const input = [row('new-idle', { kind: 'idle' }, '2026-10-26T02:00:00Z'), row('run', { kind: 'running' }), row('saved', { kind: 'idle', label: '已保存' }), row('done', { kind: 'completed' })];
  assert.deepEqual(filterSessionState(input).map(s => s.sessionId), ['run', 'new-idle', 'saved', 'done']);
  assert.equal(input[0].sessionId, 'new-idle');
  assert.deepEqual(filterSessionState(input, 'other').map(s => s.sessionId), ['new-idle', 'saved']);
  assert.deepEqual(filterSessionState(input, 'running').map(s => s.sessionId), ['run']);
  const html = renderSessionStatusFilter(input, 'running');
  assert.match(html, /data-status-filter="running" aria-pressed="true">运行中<span>1<\/span>/);
  assert.match(html, /data-status-filter="other" aria-pressed="false">其他<span>2<\/span>/);
});

test('运行中卡片的子代理计数与开关解耦；未知不写 0，恶意计数不会进入标记', () => {
  const running = row('s', { kind: 'running', subagents: 3, subagentsRunning: 1 });
  const html = renderRecentSessions([running]);
  assert.match(html, /class="chip status run"[^>]*><span[^>]*>●<\/span>运行中<\/span>/);
  assert.match(html, /class="session-secondary agent-load"[^>]*>子代理 3（1 运行）<\/span>/);
  // 「显示子代理」开关只管子代理会话卡，不再决定父会话上的计数
  assert.match(renderRecentSessions([running], [], { showSubagents: true }), /子代理 3（1 运行）/);
  // 运行数未知：只画历史总数，绝不写「0 运行」
  const unknown = renderRecentSessions([row('u', { kind: 'running', subagents: 2 })]);
  assert.match(unknown, /class="session-secondary agent-load"[^>]*>子代理 2<\/span>/);
  assert.doesNotMatch(unknown, /0 运行/);
  // 空闲 / 已完成卡片不画：历史计数不能冒充现状
  for (const kind of ['idle', 'completed']) {
    assert.doesNotMatch(renderRecentSessions([row('i', { kind, subagents: 3, subagentsRunning: 3 })]), /agent-load/);
  }
  // 没有子代理就不画「0 个子代理」
  assert.doesNotMatch(renderRecentSessions([row('z', { kind: 'running', subagents: 0 })]), /agent-load/);
  // 恶意计数：Number 守卫后不产生标记，更不会落 HTML
  const evil = renderRecentSessions([row('s', { kind: 'running', subagents: '"><img src=x>', subagentsRunning: 2 })]);
  assert.doesNotMatch(evil, /<img/);
  assert.doesNotMatch(evil, /agent-load/);
});

test('上下文是有标签的容量比例，非法数值不产生 CSS 或假进度', () => {
  const s = row('s', null);
  assert.match(renderRecentSessions([{ ...s, contextPressure: { pressureTokens: 45, contextWindow: 100 } }]), /上下文 45%/);
  assert.match(renderRecentSessions([{ ...s, contextPressure: { pressureTokens: 150, contextWindow: 100 } }]), /aria-valuenow="100"/);
  for (const cp of [{ pressureTokens: NaN, contextWindow: 100 }, { pressureTokens: 10, contextWindow: 0 }, { pressureTokens: 10, contextWindow: Infinity }]) {
    assert.doesNotMatch(renderRecentSessions([{ ...s, contextPressure: cp }]), /class="context-usage/);
  }
});

test('分组搜索结果保留真实导航目标与会话状态，未知状态不显示已完成', () => {
  const html = renderSearchResults({ projects: [{ project: 'P1', homeId: 'h1', workspaceId: 'w1' }], sessions: [row('s1', { kind: 'running' }), row('s2', null)], selectedProject: 'P2' });
  assert.match(html, /aria-label="项目结果"/);
  assert.match(html, /aria-label="会话结果"/);
  assert.match(html, /data-action="search-project" data-project="P1"/);
  assert.match(html, /data-kind="session" data-home-id="h1" data-session-id="s1"/);
  assert.match(html, /状态未知/);
  assert.doesNotMatch(html, /已完成/);
  assert.match(html, /全局搜索/);
  assert.match(html, /data-action="scope-search" data-project="P2"/);
});

test('搜索范围、标题与导航数据都转义，失败与空结果有独立提示', () => {
  const evil = '"><img src=x onerror=alert(1)>';
  const html = renderSearchResults({ projects: [{ project: evil, homeId: evil }], sessions: [{ ...row(evil, { kind: 'running', label: evil }), title: evil, homeId: evil }], scope: evil });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
  assert.match(renderSearchResults({ pending: true }), /正在检索全部索引/);
  assert.match(renderSearchResults({ failed: true }), /全库搜索暂不可用/);
  assert.match(renderSearchResults(), /没有匹配的项目或会话/);
});
