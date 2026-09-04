import { esc, timeAgo, chipColor } from '../store.js';

// 状态 chip：运行中 / 已完成 / 空闲；附带子 agent 计数与审批策略作为次级提示。
function statusChip(status) {
  const st = status ?? { kind: 'idle', label: '空闲', subagents: 0 };
  const cls = st.kind === 'running' ? 'run' : st.kind === 'completed' ? 'done' : 'idle';
  const sub = st.subagents > 0 ? ` · ${st.subagents} 子agent` : '';
  const approve = st.approval ? ` · 审批 ${st.approval}` : '';
  return `<span class="chip status ${cls}"
      title="状态: ${esc(st.label)}${approve}${sub}">${esc(st.label)}${sub}</span>`;
}

function pressureBar(cp) {
  if (!cp || !cp.contextWindow) return '';
  const pct = Math.min(100, Math.round((cp.pressureTokens / cp.contextWindow) * 100));
  const cls = pct >= 85 ? 'bad' : pct >= 65 ? 'warn' : '';
  return `<div class="pressure" title="context pressure ${pct}%">
    <i style="width:${pct}%;${cls ? `background:var(--${cls})` : ''}"></i>
  </div>`;
}

export function renderRecentSessions(sessions) {
  if (!sessions.length) return '<div class="empty">no sessions indexed yet</div>';
  return `<div class="rows">${sessions.map((s) => {
    const projColor = s.project ? chipColor(s.project) : null;
    return `
    <div class="row clickable" data-action="drill-in" data-kind="session" data-home-id="${esc(s.homeId)}"
         data-session-id="${esc(s.sessionId)}" data-title="${esc(s.title || '')}" data-project="${esc(s.project ?? '')}"
         title="点击钻入该会话">
      <div class="t">
        <span class="name">${esc(s.title || s.workspaceTitle || s.project || s.sessionId)}</span>
        ${statusChip(s.status)}
      </div>
      <div class="meta">
        ${s.project ? `<span class="chip proj-chip" style="background:${projColor.bg};color:${projColor.fg}">${esc(s.project)}</span>` : '<span class="chip">unknown</span>'}
        <span>${esc(s.sessionId)}</span>
        <span>${timeAgo(s.lastActivity)}</span>
      </div>
      ${pressureBar(s.contextPressure)}
    </div>`;
  }).join('')}</div>`;
}
