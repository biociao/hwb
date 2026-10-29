import { esc, timeAgo } from '../store.js';
import { sessionStatusChip, interventionChip } from './session-state.js';

// 有介入时给结果行挂 data-intervention（无则完全不输出该属性，空的也会命中 CSS 选择器）。
function interventionStateAttr(session) {
  const kind = session?.intervention?.kind ?? session?.status?.intervention?.kind;
  return ['approval', 'plan-review', 'question'].includes(kind) ? ` data-intervention="${kind}"` : '';
}

// 复用全库搜索结果，不再维护另一条取数路径。所有名字与 data-* 都来自不可信元数据。
export function renderSearchResults({ projects = [], sessions = [], pending = false, failed = false, scope = null, selectedProject = null, truncated = false } = {}) {
  const projectRows = projects.slice(0, 4).map((p) => `<button type="button" class="search-result" data-action="search-project" data-project="${esc(p.project)}" data-home-id="${esc(p.homeId)}" data-session-id="${esc(p.sessionId)}" data-workspace-id="${esc(p.workspaceId)}"><span class="search-result-name">${esc(p.project)}</span><span class="search-result-meta">查看项目会话</span></button>`).join('');
  // 搜索结果也要标出「在等你操作」：搜索往往是「我记得有个会话卡住了」的入口，
// 只给状态 chip 的话，一个在等 Approve 的会话看起来仍然是「空闲」。
// 介入 chip 前置（与 Recent Sessions 卡片同一口径），同样全部 esc。
  const sessionRows = sessions.slice(0, 6).map((s) => `<button type="button" class="search-result" data-action="drill-in" data-kind="session" data-home-id="${esc(s.homeId)}" data-session-id="${esc(s.sessionId)}"${interventionStateAttr(s)}><span class="search-result-body"><span class="search-result-name">${esc(s.title || s.workspaceTitle || s.project || s.sessionId)}</span><span class="search-result-meta">${esc(s.project || '未归类')} · ${timeAgo(s.lastActivity)}</span></span>${interventionChip(s)}${sessionStatusChip(s)}</button>`).join('');
  return `<div class="search-result-heading"><span>${scope ? `项目：${esc(scope)}` : '全局搜索'}</span>${!scope && selectedProject ? `<button type="button" data-action="scope-search" data-project="${esc(selectedProject)}">仅搜索当前项目</button>` : ''}</div>
    ${projectRows ? `<div class="search-result-group" role="group" aria-label="项目结果"><h3>项目</h3>${projectRows}</div>` : ''}
    ${sessionRows ? `<div class="search-result-group" role="group" aria-label="会话结果"><h3>会话</h3>${sessionRows}</div>` : ''}
    ${pending ? '<div class="search-result-note" role="status">正在检索全部索引…</div>' : failed ? '<div class="search-result-note" role="status">全库搜索暂不可用，仅显示最近列表内的匹配</div>' : !projects.length && !sessions.length ? '<div class="search-result-note" role="status">没有匹配的项目或会话</div>' : ''}
    ${truncated || projects.length > 4 || sessions.length > 6 ? '<div class="search-result-note">更多结果见下方项目与会话列表</div>' : ''}`;
}
