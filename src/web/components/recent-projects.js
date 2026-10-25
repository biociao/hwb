import { esc, fmtTokens, timeAgo, chipColor, sourceKind, sourceLabel } from '../store.js';

// 项目卡与会话卡刻意长得不一样（用户反馈「两栏混在一起分不清」）：
//   · 项目 = workspace 身份 → 左侧**项目色徽标（双字母 monogram）+ 竖轨**，右侧聚合统计；
//     卡片**底色**另按「来源 app（实例 harness）」区分（见 index.html 的 --src-*）；
//   · 会话 = 一次对话     → 左侧**状态竖轨**（运行/完成/空闲），右侧状态 chip + 时间。
// 两种卡的「第一视觉锚点」不同（徽标 vs 竖轨），扫视时不会串栏。
// 这里每个字段都来自 dsh home 元数据（不可信输入），一律 esc；来源标识走白名单归一化。

// 双字母/双字 monogram：PMAID-RENJI → PR，2026-Student-HZY → 2S，广实分布式系统 → 广实。
// 取「分隔符后的首字母」而不是首字符，是为了让同前缀的多个项目（PMAID-*）仍能区分。
export function monogramOf(name) {
  const text = String(name ?? '').trim();
  if (!text) return '?';
  const words = text.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  if (words.length === 1 && /^[\x00-\x7F]+$/.test(text)) return text.slice(0, 2).toUpperCase();
  return [...text].slice(0, 2).join('');
}

// selectedProject：当前被「筛选」的项目名（与 Recent Sessions 联动）。
// 点击项目卡不再直接跳转实例，而是把它名下的会话筛到 Recent Sessions（见 app.js 的
// setProjectFilter）；再次点击同一个项目取消筛选，所以这张卡同时也是筛选开关，
// 用 aria-pressed 表达开关状态。跳转能力仍在：筛选条里的「打开项目」按钮保留原语义。
export function renderRecentProjects(projects, homes = [], { selectedProject = null } = {}) {
  if (!projects.length) return '<div class="empty">no active projects in the last 7 days</div>';
  const homeById = new Map(homes.map((h) => [h.homeId, h]));
  const rows = projects.map((p) => {
    const selected = selectedProject !== null && p.project === selectedProject;
    const inst = homeById.get(p.homeId);
    const instName = inst ? (inst.alias || inst.homePath) : null;
    const instColor = inst ? chipColor(p.homeId) : null;
    // 来源 app：项目卡底色按它区分（dsh 蓝 / Codex 灰 / Claude Code 橙 / WorkBuddy 绿）。
    // 取「该项目最新会话所在实例」的 harness —— 与卡片跳转目标、实例 chip 同一口径。
    // sourceKind 只返回白名单标识，可以安全进 data-source 属性。
    const source = sourceKind(inst?.harness);
    // 项目色：同一项目始终同色，作为徽标/竖轨的身份色（与会话卡的状态色是两套语义）。
    const projColor = chipColor(p.project);
    // Codex 只提供「会话累计 token」这一个数，没有新增输入 / 输出拆分（dsh 才有）。
    // 若按 in/out 渲染会变成 in 0 / out 0，看起来像「没用量」，所以回退到 total。
    const input = Number(p.inputTokens) || 0;
    const output = Number(p.outputTokens) || 0;
    const total = Number(p.totalTokens) || 0;
    const totalsOnly = total > 0 && input + output === 0;
    const tokenHtml = totalsOnly
      ? `<span class="project-tokens" title="Codex 只提供会话累计 token，无输入/输出拆分">total ${fmtTokens(total)} tokens</span>`
      // 「入」在项目卡片里是**总输入**（新增输入 + 缓存读 + 缓存写），与用量卡片的
      // 「新增输入」不是同一个口径：同一条会话实测 1950 vs 1000。数字本身没错（卡片按
      // 总消耗排序），但只写 in/out 会让人以为两处应该相等，所以标签写全。
      : `<span class="project-tokens" title="新增输入 + 缓存读 + 缓存写"><span>in ${fmtTokens(p.inputTokens)}</span><span>out ${fmtTokens(p.outputTokens)}</span></span>`;
    return `
    <div class="row clickable card project-card${selected ? ' selected' : ''}" role="button" tabindex="0" data-action="filter-project" data-kind="project" data-home-id="${esc(p.homeId)}"
         data-workspace-id="${esc(p.workspaceId ?? '')}"
         data-session-id="${esc(p.sessionId ?? '')}" data-project="${esc(p.project)}"
         data-source="${source}"
         aria-pressed="${selected ? 'true' : 'false'}"
         style="--card-accent:${projColor.fg};--card-tint:${projColor.bg}"
         title="数据来源：${esc(sourceLabel(source))} · ${selected ? '再次点击取消筛选，回到最近会话' : '点击筛选该项目会话'}">
      <span class="card-rail" aria-hidden="true"></span>
      <div class="card-body">
        <div class="t">
          <span class="project-badge" aria-hidden="true">${esc(monogramOf(p.project))}</span>
          <span class="name">${esc(p.project)}</span>
          <span class="card-time">${timeAgo(p.lastActivity)}</span>
        </div>
        <div class="meta project-meta">
          ${instName ? `<span class="chip home-chip" style="background:${instColor.bg};color:${instColor.fg}" title="${esc(inst?.homePath ?? instName)}">${esc(instName)}</span>` : ''}
          ${p.historical ? '<span class="chip hist-chip" title="不在最近 7 天列表里，来自全库检索">历史</span>' : ''}
          <span class="project-stat"><b>${p.sessionCount}</b> session${p.sessionCount === 1 ? '' : 's'}</span>
          ${tokenHtml}
          ${p.sessionId ? '' : '<span class="chip">no sessions</span>'}
        </div>
      </div>
    </div>`;
  }).join('');
  return `<div class="rows">${rows}</div>`;
}
