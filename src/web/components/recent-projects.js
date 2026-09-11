import { esc, fmtTokens, timeAgo, chipColor } from '../store.js';

export function renderRecentProjects(projects, homes = []) {
  if (!projects.length) return '<div class="empty">no active projects in the last 7 days</div>';
  const homeById = new Map(homes.map((h) => [h.homeId, h]));
  const rows = projects.map((p) => {
    const inst = homeById.get(p.homeId);
    const instName = inst ? (inst.alias || inst.homePath) : null;
    const instColor = inst ? chipColor(p.homeId) : null;
    return `
    <div class="row clickable" role="button" tabindex="0" data-action="drill-in" data-kind="project" data-home-id="${esc(p.homeId)}"
         data-session-id="${esc(p.sessionId ?? '')}" data-project="${esc(p.project)}"
         title="点击打开该项目所在实例的最新会话">
      <div class="t">
        <span class="name">${esc(p.project)}</span>
        <span class="meta">${timeAgo(p.lastActivity)}</span>
      </div>
      <div class="meta">
        ${instName ? `<span class="chip home-chip" style="background:${instColor.bg};color:${instColor.fg}" title="${esc(inst?.homePath ?? instName)}">${esc(instName)}</span>` : ''}
        <span>${p.sessionCount} session${p.sessionCount === 1 ? '' : 's'}</span>
        <span>in ${fmtTokens(p.inputTokens)}</span>
        <span>out ${fmtTokens(p.outputTokens)}</span>
        ${p.sessionId ? '' : '<span class="chip">no sessions</span>'}
      </div>
    </div>`;
  }).join('');
  return `<div class="rows">${rows}</div>`;
}
