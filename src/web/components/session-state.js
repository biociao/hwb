import { esc } from '../store.js';

// 保存记录不代表执行状态。保持索引协议不变，在展示层区分 unknown 与真正的 idle。
// 计数字段归一：非数字 / 负数 / 空串一律 null（未知），而不是 0 —— 「不知道」与「已知是 0」
// 在 UI 上必须长得不一样（见 lib/intervention.js 的键存在约定）。
function countOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : null;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Math.max(0, Math.floor(Number(value)));
  }
  return null;
}

export function sessionState(session) {
  const status = session?.status;
  const saved = status?.label === '已保存' || status?.label === 'Codex';
  const kind = !saved && ['running', 'completed', 'idle'].includes(status?.kind) ? status.kind : 'unknown';
  const labels = { running: '运行中', completed: '已完成', idle: '空闲', unknown: '状态未知' };
  const icons = { running: '●', completed: '✓', idle: 'Ⅱ', unknown: '?' };
  const total = countOf(status?.subagents);
  // 「其中几个在跑」：缺键 = 未知（null），与「已观测的 0」不同。两个数都做取整钳制；
  // running 不可能大于历史总数（annotate 保证），但外部/未来数据源可能不守约，展示层再兜一层。
  const running = countOf(status?.subagentsRunning);
  return {
    kind, saved,
    label: kind === 'unknown' ? labels.unknown : status.label || labels[kind],
    icon: icons[kind],
    subagents: total ?? 0,
    subagentsKnown: total !== null,
    subagentsRunning: running !== null && total !== null ? Math.min(running, total) : running,
  };
}

export const SESSION_FILTERS = [
  ['all', '全部'], ['running', '运行中'], ['completed', '已完成'], ['other', '其他'],
];

export function filterSessionState(sessions, filter = 'all') {
  return sessions.filter((s) => {
    const { kind } = sessionState(s);
    return filter === 'all' || (filter === 'other' ? kind === 'idle' || kind === 'unknown' : kind === filter);
  }).sort((a, b) => {
    const priority = Number(sessionState(b).kind === 'running') - Number(sessionState(a).kind === 'running');
    const time = (s) => Date.parse(s.lastActivity) || 0;
    return priority || time(b) - time(a);
  });
}

export function renderSessionStatusFilter(sessions, active = 'all', { showSubagents = false, subagentCount = 0 } = {}) {
  return `<div class="session-status-filter" role="group" aria-label="按会话状态筛选">${SESSION_FILTERS.map(([key, label]) =>
    `<button type="button" data-action="filter-session-status" data-status-filter="${key}" aria-pressed="${active === key}">${label}<span>${filterSessionState(sessions, key).length}</span></button>`
  ).join('')}<button type="button" class="subagent-toggle" data-action="toggle-subagents" aria-pressed="${showSubagents}" title="显示或隐藏已索引的子代理会话（父会话卡上的子代理计数不受此开关影响）">${showSubagents ? '隐藏子代理' : '显示子代理'}${subagentCount > 0 ? `<span>${Number(subagentCount) || 0}</span>` : ''}</button><span class="session-order">运行中优先</span></div>`;
}

export function sessionStatusChip(session) {
  const state = sessionState(session);
  const cls = { running: 'run', completed: 'done', idle: 'idle', unknown: 'unknown' }[state.kind];
  const approval = session?.status?.approval ? ` · 审批 ${session.status.approval}` : '';
  const hint = state.kind === 'unknown' ? '未取得执行状态；索引记录不能证明正在运行或空闲' : `会话状态: ${state.label}`;
  return `<span class="chip status ${cls}" title="${esc(hint + approval)}"><span class="status-symbol" aria-hidden="true">${state.icon}</span>${esc(state.label)}</span>`;
}
