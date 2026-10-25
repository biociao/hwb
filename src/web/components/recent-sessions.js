import { esc, timeAgo, chipColor } from '../store.js';

// 状态 chip：运行中 / 已完成 / 空闲；附带子 agent 计数与审批策略作为次级提示。
// Codex 会话的 status 是 {kind:'idle', label:'Codex'}，走 idle 样式、文本显示 Codex。
function statusChip(status) {
  const st = status ?? { kind: 'idle', label: '空闲', subagents: 0 };
  const cls = st.kind === 'running' ? 'run' : st.kind === 'completed' ? 'done' : 'idle';
  const sub = st.subagents > 0 ? ` · ${st.subagents} 子agent` : '';
  // approval 直接来自 dsh 元数据（projcache 的 permissions.approval / live RPC），是**未校验的自由文本**。
  // 它被拼进 title="…" 属性里，不转义就能用 `">` 提前闭合属性、注入任意标签 → 存储型 XSS。
  // 这里对整段（含前缀）转义，避免以后改前缀时又漏掉一次。
  const approve = st.approval ? esc(` · 审批 ${st.approval}`) : '';
  // kind → cls 是白名单映射，st.label / sub 均为转义或数值，属性与文本都安全。
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

// 会话 id 对用户几乎无用（UUID 前缀都一样），但在排查时唯一：默认只显示尾部 6 位，
// 完整值放 title；既降低第二行的视觉噪音，也让「项目卡 vs 会话卡」的 meta 内容不同。
export function shortSessionId(id) {
  const text = String(id ?? '');
  if (!text) return '';
  const tail = text.replace(/^session-/, '').slice(-6);
  return tail;
}

// 项目筛选条：Recent Sessions 分区头下方的一条状态带。
//
// 为什么单独一条而不是只把标题改掉：筛选态必须同时回答三个问题 ——
//   ① 现在筛的是哪个项目（名字可能很长，要能看出被截断的完整值 → title）；
//   ② 怎么退出（✕ 清除；点同一个项目卡也会取消）；
//   ③ 原来的「点项目跳实例」能力去哪了（右侧「打开项目」按钮，语义与原项目卡点击一致）。
//   ④ 这个项目是否在默认静音列表里（muted → 「取消隐藏」按钮；显式点开时仍显示会话）。
// 计数只报**筛出来的条数**（不是「命中/总数」—— 项目筛选不是搜索，没有可比的分母）；
// 被 limit 截断时由调用方在列表底部补一句「仅显示最近 N 条」，这里不重复。
//
// 所有字段都来自索引元数据 / 项目卡（不可信输入），进 HTML 前一律 esc；
// homeId/sessionId/workspaceId 只作为 data-* 交给 drill-in 处理，同样是 esc。
export function renderSessionFilter({ project, homeId = null, sessionId = null, workspaceId = null, count = null, muted = false } = {}) {
  const name = String(project ?? '');
  // 条数口径与项目卡不同（卡上是「近 7 天会话数」，这里是索引里的全部会话），title 说明差异，
  // 免得用户以为两个数字有一个错了。
  const countHtml = count == null ? '' : `<span class="filter-count"
      title="该项目在索引中的全部会话（不受 Recent 的 7 天窗口 / 最近 50 条限制）">${Number(count) || 0} 条</span>`;
  // 无 homeId 时不画「打开项目」：没有可解析的目标，点了只会弹错误。
  const openHtml = homeId
    ? `<button type="button" class="filter-open" data-action="drill-in" data-kind="project"
         data-home-id="${esc(homeId)}" data-session-id="${esc(sessionId ?? '')}"
         data-workspace-id="${esc(workspaceId ?? '')}" data-project="${esc(name)}"
         title="打开该项目所在实例的最新会话（恢复原来的项目卡点击行为）">打开项目</button>`
    : '';
  // 「隐藏」= 把该项目加入 Recent Sessions 的默认静音列表（持久化）；显式点开时仍显示。
  // 已静音时必须明确写「已默认隐藏」，否则用户会把「取消隐藏」当成隐藏按钮（实测踩过）。
  const muteHtml = `<button type="button" class="filter-mute" data-action="toggle-mute-project" data-project="${esc(name)}"
      title="${muted ? '不再默认隐藏该项目的会话' : '把这些会话从 Recent Sessions 的默认视图里隐藏（可随时取消）'}">${muted ? '取消默认隐藏' : '默认隐藏'}</button>`;
  const mutedStateHtml = muted ? '<span class="filter-state" title="该项目的会话在 Recent Sessions 默认视图中被隐藏；这里是你显式点开的查看视图">已默认隐藏</span>' : '';
  return `<div class="pane-filter" data-project="${esc(name)}">
    <span class="filter-label">项目筛选</span>
    <span class="filter-project" title="${esc(name)}">${esc(name)}</span>
    <button type="button" class="filter-clear" data-action="clear-project-filter"
      title="清除项目筛选，回到最近会话" aria-label="清除项目筛选">✕</button>
    ${countHtml}
    ${mutedStateHtml}
    ${muteHtml}
    ${openHtml}
  </div>`;
}

// homes 用于在会话行里标出「属于哪个实例」：dsh 与 Codex 会话现在都汇总进同一栏，
// 没有实例 chip 时 Codex 会话和 dsh 会话长得一模一样。缺实例信息时不画 chip（旧调用兼容）。
export function renderRecentSessions(sessions, homes = []) {
  if (!sessions.length) return '<div class="empty">no sessions indexed yet</div>';
  const homeById = new Map((Array.isArray(homes) ? homes : []).map((h) => [h.homeId, h]));
  return `<div class="rows">${sessions.map((s) => {
    const projColor = s.project ? chipColor(s.project) : null;
    const inst = homeById.get(s.homeId);
    const instName = inst ? (inst.alias || inst.homePath) : null;
    const status = s.status ?? { kind: 'idle', label: '空闲', subagents: 0 };
    const statusKind = status.kind === 'running' ? 'running' : status.kind === 'completed' ? 'completed' : 'idle';
    return `
    <div class="row clickable card session-card" role="button" tabindex="0" data-action="drill-in" data-kind="session" data-home-id="${esc(s.homeId)}"
         data-status="${statusKind}"
         data-session-id="${esc(s.sessionId)}" data-title="${esc(s.title || '')}" data-project="${esc(s.project ?? '')}"
         title="点击钻入该会话">
      <span class="card-rail" aria-hidden="true"></span>
      <div class="card-body">
        <div class="t">
          <span class="name session-title">${esc(s.title || s.workspaceTitle || s.project || s.sessionId)}</span>
          <span class="status-col">
            ${statusChip(status)}
            <span class="active-time">${timeAgo(s.lastActivity)}</span>
          </span>
        </div>
        <div class="meta session-meta">
          ${s.project ? `<span class="chip proj-chip" style="background:${projColor.bg};color:${projColor.fg}">${esc(s.project)}</span>` : '<span class="chip">unknown</span>'}
          ${instName ? `<span class="chip home-chip" title="${esc(inst?.homePath ?? instName)}">${esc(instName)}</span>` : ''}
          ${s.historical ? '<span class="chip hist-chip" title="不在最近 50 条会话里，来自全库检索">历史</span>' : ''}
          <span class="sid" title="session ${esc(s.sessionId)}">#${esc(shortSessionId(s.sessionId))}</span>
        </div>
        ${pressureBar(s.contextPressure)}
      </div>
    </div>`;
  }).join('')}</div>`;
}
