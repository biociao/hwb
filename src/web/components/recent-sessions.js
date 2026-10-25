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
