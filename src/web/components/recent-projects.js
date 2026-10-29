import { esc, timeAgo, chipColor, sourceKind, sourceLabel } from '../store.js';
import { normalizeMutedProjects } from './session-mute.js';

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

// 把项目切成「主列表可见 / 已隐藏」两半。
//
// 为什么必须有这一层：原先「默认静音」只过滤 Recent Sessions 的会话，项目卡仍然留在项目栏里，
// 只是多一个「已隐藏」chip —— 用户看到卡上写着「已隐藏」却还杵在列表里，只会认为隐藏没生效
// （截图反馈的原话：「项目显示已隐藏为什么还能看到？」）。隐藏的语义应该是**从默认视图移走**，
// 想看时再主动展开，而不是「留在原地 + 加个标记」。
//
// 判定口径与 session-mute.js 完全一致（同一个 `hwb:muted-projects` 偏好、同一次 normalize）：
// 一处隐藏、两处生效，不会出现「项目栏说隐藏了、会话栏说没隐藏」的分裂。
export function splitHiddenProjects(projects, { hiddenProjects = [] } = {}) {
  const list = Array.isArray(projects) ? projects.filter(Boolean) : [];
  const muted = new Set(normalizeMutedProjects(hiddenProjects));
  const visible = [];
  const hidden = [];
  for (const p of list) {
    if (muted.has(String(p?.project ?? ''))) hidden.push(p);
    else visible.push(p);
  }
  return { visible, hidden };
}

// 单张项目卡。hidden=true 时用于「已隐藏」栏里的卡片：动作换成「取消隐藏」，并整体压暗。
// selectedProject：当前被「筛选」的项目名（与 Recent Sessions 联动）。
// 点击项目卡不再直接跳转实例，而是把它名下的会话筛到 Recent Sessions（见 app.js 的
// setProjectFilter）；再次点击同一个项目取消筛选，所以这张卡同时也是筛选开关，
// 用 aria-pressed 表达开关状态。跳转能力仍在：筛选条里的「打开项目」按钮保留原语义。
function renderProjectCard(p, { homeById, selectedProject = null, hidden = false } = {}) {
  const selected = selectedProject !== null && p.project === selectedProject;
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
  // 隐藏栏里的卡片：只保留「取消隐藏」这一个开关（它已经不在主列表，再画「隐藏」没有意义）。
  const muteHtml = hidden
    ? `<button type="button" class="chip muted-chip" data-action="toggle-mute-project" data-project="${esc(p.project)}"
        title="恢复显示：项目回到项目列表，会话回到 Recent Sessions">取消隐藏</button>`
    : `<button type="button" class="chip card-mute" data-action="toggle-mute-project" data-project="${esc(p.project)}"
        title="把该项目移入项目栏底部的「已隐藏」栏（会话也从 Recent Sessions 默认视图移走；可随时恢复）">隐藏</button>`;
  const classes = `row clickable card project-card${selected ? ' selected' : ''}${hidden ? ' hidden-project' : ''}`;
  return `
    <div class="${classes}" role="button" tabindex="0" data-action="filter-project" data-kind="project" data-home-id="${esc(p.homeId)}"
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
          ${muteHtml}
          <span class="project-stat"><b>${p.sessionCount}</b> session${p.sessionCount === 1 ? '' : 's'}</span>
          <span class="project-last-active">${timeAgo(p.lastActivity)}</span>
          ${p.sessionId ? '' : '<span class="chip">no sessions</span>'}
        </div>
      </div>
    </div>`;
}

// 「已隐藏」栏：项目栏底部一条折叠栏，默认收起。
//
// 为什么默认收起：隐藏的语义就是「不占默认视图」。如果展开态写进偏好、下次打开又看见它们，
// 隐藏就成了「换个位置放」而不是隐藏。所以展开只是当前会话的临时动作（与「显示已隐藏会话」
// 同一种语义：看一次就收回），用户的持久偏好只有「哪些项目被隐藏」。
//
// 为什么挂在列表底部（不塞进 .rows 滚动区）：项目多的时候要翻很久才看得到它；而它是
// 「列表里少了一些东西」的唯一说明入口，必须在列表滚动之外常驻可见。
// 展开时内容出现在折叠条**上方**（抽屉向上展开）：这样折叠条始终钉在栏底，不会随内容移动。
function renderHiddenProjectsShelf(hidden, { homeById, selectedProject = null } = {}, { expanded = false } = {}) {
  if (!hidden.length) return '';
  const count = hidden.length;
  const cardOptions = { homeById, selectedProject, hidden: true };
  const panel = expanded
    ? `<div class="projects-hidden-panel" id="hidden-projects">
        <div class="projects-hidden-note">这些项目已从项目列表移入这里，会话也不再出现在 Recent Sessions；点「取消隐藏」恢复。</div>
        <div class="rows hidden-rows">${hidden.map((p) => renderProjectCard(p, cardOptions)).join('')}</div>
      </div>`
    : '';
  const label = expanded ? '收起已隐藏项目' : `已隐藏 <b>${count}</b> 个项目`;
  return `<div class="projects-hidden${expanded ? ' open' : ''}">
      ${panel}
      <button type="button" class="projects-hidden-toggle" data-action="toggle-hidden-projects"
        aria-expanded="${expanded ? 'true' : 'false'}"
        title="${expanded ? '收起已隐藏的项目' : '查看已隐藏的项目（默认不显示，只有主动展开才可见）'}">
        <span class="ph-caret" aria-hidden="true">${expanded ? '▾' : '▸'}</span><span>${label}</span>
      </button>
    </div>`;
}

// showHiddenProjects：隐藏栏当前是否展开（默认 false = 收起，被隐藏的项目连名字都不渲染）。
export function renderRecentProjects(projects, homes = [], {
  selectedProject = null,
  mutedProjects = [],
  showHiddenProjects = false,
} = {}) {
  const list = Array.isArray(projects) ? projects.filter(Boolean) : [];
  if (!list.length) return '<div class="empty">no active projects in the last 7 days</div>';
  const homeById = new Map((Array.isArray(homes) ? homes : []).map((h) => [h.homeId, h]));
  const { visible, hidden } = splitHiddenProjects(list, { hiddenProjects: mutedProjects });
  const cardOptions = { homeById, selectedProject };
  const rows = visible.map((p) => renderProjectCard(p, cardOptions)).join('');
  const shelf = renderHiddenProjectsShelf(hidden, cardOptions, { expanded: showHiddenProjects === true });
  // 全被隐藏时不能再画「没有活跃项目」：它和底部「已隐藏 N 个项目」自相矛盾，
  // 用户会以为项目真的没了。改为指路隐藏栏（那里才是它们现在的位置）。
  const body = rows
    ? `<div class="rows">${rows}</div>`
    : hidden.length
      ? '<div class="empty">项目都已隐藏 · 展开底部「已隐藏」栏查看</div>'
      : '<div class="empty">no active projects in the last 7 days</div>';
  return body + shelf;
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
