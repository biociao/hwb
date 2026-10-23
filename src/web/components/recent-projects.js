import { esc, fmtTokens, timeAgo, chipColor } from '../store.js';

export function renderRecentProjects(projects, homes = []) {
  if (!projects.length) return '<div class="empty">no active projects in the last 7 days</div>';
  const homeById = new Map(homes.map((h) => [h.homeId, h]));
  const rows = projects.map((p) => {
    const inst = homeById.get(p.homeId);
    const instName = inst ? (inst.alias || inst.homePath) : null;
    const instColor = inst ? chipColor(p.homeId) : null;
    // Codex 只提供「会话累计 token」这一个数，没有输入/输出拆分（dsh 才有）。
    // 若按 in/out 渲染会变成 in 0 / out 0，看起来像「没用量」，所以回退到 total。
    const totalTokens = Number(p.totalTokens) || 0;
    const inputTokens = Number(p.inputTokens) || 0;
    const outputTokens = Number(p.outputTokens) || 0;
    const totalsOnly = totalTokens > 0 && inputTokens + outputTokens === 0;
    return `
    <div class="row clickable" role="button" tabindex="0" data-action="drill-in" data-kind="project" data-home-id="${esc(p.homeId)}"
         data-workspace-id="${esc(p.workspaceId ?? '')}"
         data-session-id="${esc(p.sessionId ?? '')}" data-project="${esc(p.project)}"
         title="点击打开该项目所在实例的最新会话">
      <div class="t">
        <span class="name">${esc(p.project)}</span>
        <span class="meta">${timeAgo(p.lastActivity)}</span>
      </div>
      <div class="meta">
        ${instName ? `<span class="chip home-chip" style="background:${instColor.bg};color:${instColor.fg}" title="${esc(inst?.homePath ?? instName)}">${esc(instName)}</span>` : ''}
        <span>${p.sessionCount} session${p.sessionCount === 1 ? '' : 's'}</span>
        <!-- 「入」在项目卡片里是**总输入**（新增输入 + 缓存读 + 缓存写），与用量卡片的
             「新增输入」不是同一个口径：同一条会话实测 1950 vs 1000。数字本身没错（卡片按
             总消耗排序），但只写 in/out 会让人以为两处应该相等，所以标签写全。
             Codex 行没有 in/out 拆分（totalTokens>0 且 in+out=0）时改显累计 token。 -->
        ${totalsOnly
          ? `<span title="Codex 只提供会话累计 token，无输入/输出拆分">total ${fmtTokens(totalTokens)} tokens</span>`
          : `<span title="新增输入 + 缓存读 + 缓存写">in ${fmtTokens(p.inputTokens)}</span>
        <span>out ${fmtTokens(p.outputTokens)}</span>`}
        ${p.sessionId ? '' : '<span class="chip">no sessions</span>'}
      </div>
    </div>`;
  }).join('');
  return `<div class="rows">${rows}</div>`;
}
