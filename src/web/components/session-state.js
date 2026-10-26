import { esc } from '../store.js';

// 保存记录不代表执行状态。保持索引协议不变，在展示层区分 unknown 与真正的 idle。
export function sessionState(session) {
  const status = session?.status;
  const saved = status?.label === '已保存' || status?.label === 'Codex';
  const kind = !saved && ['running', 'completed', 'idle'].includes(status?.kind) ? status.kind : 'unknown';
  const labels = { running: '运行中', completed: '已完成', idle: '空闲', unknown: '状态未知' };
  const icons = { running: '●', completed: '✓', idle: 'Ⅱ', unknown: '?' };
  return {
    kind, saved, label: kind === 'unknown' ? labels.unknown : status.label || labels[kind], icon: icons[kind],
    subagents: Number.isFinite(Number(status?.subagents)) ? Math.max(0, Math.floor(Number(status.subagents))) : 0,
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

export function renderSessionStatusFilter(sessions, active = 'all') {
  return `<div class="session-status-filter" role="group" aria-label="按会话状态筛选">${SESSION_FILTERS.map(([key, label]) =>
    `<button type="button" data-action="filter-session-status" data-status-filter="${key}" aria-pressed="${active === key}">${label}<span>${filterSessionState(sessions, key).length}</span></button>`
  ).join('')}<span class="session-order">运行中优先</span></div>`;
}

export function sessionStatusChip(session) {
  const state = sessionState(session);
  const cls = { running: 'run', completed: 'done', idle: 'idle', unknown: 'unknown' }[state.kind];
  const approval = session?.status?.approval ? ` · 审批 ${session.status.approval}` : '';
  const hint = state.kind === 'unknown' ? '未取得执行状态；索引记录不能证明正在运行或空闲' : `会话状态: ${state.label}`;
  return `<span class="chip status ${cls}" title="${esc(hint + approval)}"><span class="status-symbol" aria-hidden="true">${state.icon}</span>${esc(state.label)}</span>`;
}
