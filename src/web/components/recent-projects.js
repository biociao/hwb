import { esc, timeAgo, chipColor, sourceKind, sourceLabel } from '../store.js';

// 项目卡与会话卡刻意长得不一样（用户反馈「两栏混在一起分不清」）：
//   · 项目 = workspace 身份 → 左侧**项目色徽标（双字母 monogram）+ 竖轨**，右侧聚合统计；
//     卡片底色区分项目，完整来源集合由独立的小标签展示；
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
// mutedProjects：默认静音项目列表（见 components/session-mute.js）。被静音的项目卡上画
// 「已隐藏」chip —— 否则用户会奇怪「Recent Sessions 里怎么没有这个项目的会话」。
export function renderRecentProjects(projects, homes = [], { selectedProject = null, mutedProjects = [] } = {}) {
  if (!projects.length) return '<div class="empty">no active projects in the last 7 days</div>';
  const mutedSet = new Set(Array.isArray(mutedProjects) ? mutedProjects : []);
  const homeById = new Map(homes.map((h) => [h.homeId, h]));
  const rows = projects.map((p) => {
    const selected = selectedProject !== null && p.project === selectedProject;
    const muted = mutedSet.has(p.project);
    const inst = homeById.get(p.homeId);
    // homeId 仍是最新会话的跳转目标，homeIds 是项目的完整来源集合（旧后端回退单来源）。
    const sourceHomes = [...new Set([p.homeId, ...(Array.isArray(p.homeIds) ? p.homeIds : [])])]
      .map((id) => homeById.get(id)).filter(Boolean);
    const labels = new Set();
    const homeChips = sourceHomes.map((home) => {
      const kind = sourceKind(home.harness);
      const label = home.alias || home.homePath || sourceLabel(kind);
      const key = `${kind}\u0000${label}`;
      if (labels.has(key)) return '';
      labels.add(key);
      return `<span class="chip home-chip" data-source="${kind}" title="${esc(home.homePath || label)}">${esc(label)}</span>`;
    }).join('');
    const source = sourceKind(inst?.harness);
    const sourceNames = [...new Set(sourceHomes.map((home) => sourceLabel(sourceKind(home.harness))))].join(' / ') || sourceLabel(source);
    // 项目色：同一项目始终同色，作为徽标/竖轨的身份色（与会话卡的状态色是两套语义）。
    const projColor = chipColor(p.project);
    return `
    <div class="row clickable card project-card${selected ? ' selected' : ''}" role="button" tabindex="0" data-action="filter-project" data-kind="project" data-home-id="${esc(p.homeId)}"
         data-workspace-id="${esc(p.workspaceId ?? '')}"
         data-session-id="${esc(p.sessionId ?? '')}" data-project="${esc(p.project)}"
         data-source="${source}"
         aria-pressed="${selected ? 'true' : 'false'}"
         style="--card-accent:${projColor.fg};--card-tint:${projColor.bg}"
         title="数据来源：${esc(sourceNames)} · ${selected ? '再次点击取消筛选，回到最近会话' : '点击筛选该项目会话'}">
      <span class="card-rail" aria-hidden="true"></span>
      <div class="card-body">
        <div class="t">
          <span class="project-badge" aria-hidden="true">${esc(monogramOf(p.project))}</span>
          <span class="name">${esc(p.project)}</span>
        </div>
        ${homeChips ? `<div class="project-sources" aria-label="项目的 agent app 来源">${homeChips}</div>` : ''}
        <div class="meta project-meta">
          ${p.historical ? '<span class="chip hist-chip" title="不在最近 7 天列表里，来自全库检索">历史</span>' : ''}
          ${muted
            // 已隐藏 = 可点按钮（点一下恢复显示）；未隐藏 = hover 才出现的「隐藏」按钮。
            // 直接放在项目卡上是为了可发现：用户不必先点开项目、再从筛选条里找隐藏入口。
            ? `<button type="button" class="chip muted-chip" data-action="toggle-mute-project" data-project="${esc(p.project)}"
                title="该项目的会话在 Recent Sessions 中默认隐藏；点击恢复显示">已隐藏</button>`
            : `<button type="button" class="chip card-mute" data-action="toggle-mute-project" data-project="${esc(p.project)}"
                title="默认隐藏该项目的会话（不再出现在 Recent Sessions；可随时恢复）">隐藏</button>`}
          <span class="project-stat"><b>${p.sessionCount}</b> session${p.sessionCount === 1 ? '' : 's'}</span>
          <span class="project-last-active">${timeAgo(p.lastActivity)}</span>
          ${p.sessionId ? '' : '<span class="chip">no sessions</span>'}
        </div>
      </div>
    </div>`;
  }).join('');
  return `<div class="rows">${rows}</div>`;
}

// 项目栏底部的范围说明：列表被 limit 截断时，必须**在界面上**说清「这不是全部」。
//
// 为什么必须有：分区头只有一个数字，被截断却不说，用户就会把「20」当成「项目总数」——
// 这次反馈（截图里「项目 20」）的原始症状。这条由调用方拼在列表之后、不进 `.rows`
// 滚动区，所以翻到列表底部也看得见；只在真截断时出现，不截断时列表就是全部，多说一句是噪音。
//
// 两种范围的出路不同：
//   · 「最近」截断 → 给「查看全部项目」按钮（与分区头同一个 action，切到 all 再取一次）；
//   · 「全部」截断 → 没有更大的档位可切，只能指路顶栏搜索（/api/search 不受这个 limit 限制）。
export function renderProjectsMore({ scope = 'recent', truncated = false, recentLimit = 200, allLimit = 1000, days = 7 } = {}) {
  if (!truncated) return '';
  const num = (n) => esc(String(Number(n) || 0));
  if (scope === 'all') {
    return `<div class="pane-note">项目较多，仅显示按最后活动排序的前 ${num(allLimit)} 个；可用顶栏搜索定位更早的项目</div>`;
  }
  return `<div class="pane-note">仅显示最近 ${num(days)} 天内最新的 ${num(recentLimit)} 个项目`
    + '<button type="button" data-action="projects-scope" data-scope="all">查看全部项目</button></div>';
}
