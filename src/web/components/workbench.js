import { esc } from '../store.js';

// 三栏的「分区身份」：Projects 用项目色（赭石），Sessions 用强调色（墨蓝），Instances 中性。
// 分区的颜色 + 图标 + 计数，配合两种卡不同的第一视觉锚点（项目徽标 / 会话状态轨），
// 让两栏在扫视时不会串。计数由调用方传入（缺省不画，保持旧调用兼容）。
// projectCount / sessionCount 既可以是数字（未过滤），也可以是 "3/20" 这样的字符串
// （搜索过滤中：命中/总数）—— 两种形态都走同一条 esc → innerHTML 路径。
// sessionFilter：项目筛选条（见 recent-sessions.js 的 renderSessionFilter）。它放在 h2 与
// 列表之间、不属于滚动区（.rows），所以筛选中时它会一直留在分区顶部，不被列表滚走。
export function renderWorkbench({ projects, sessions, homes, usage, logs, projectCount = null, sessionCount = null, sessionFilter = '', statusFilter = '', searching = false }) {
  const count = (n) => (n == null || n === '' ? '' : `<span class="pane-count">${esc(n)}</span>`);
  return `
    <section class="pane pane-projects"><h2><span class="pane-title"><span class="pane-mark" aria-hidden="true">▦</span>项目</span>${count(projectCount)}</h2>${projects}</section>
    <section class="pane pane-sessions"><h2><span class="pane-title"><span class="pane-mark" aria-hidden="true">◍</span>${searching ? '会话搜索结果' : '最近会话'}</span>${count(sessionCount)}</h2>${sessionFilter}${statusFilter}<div class="session-list">${sessions}</div></section>
    <section class="pane pane-instances"><h2><span class="pane-title"><span class="pane-mark" aria-hidden="true">▣</span>实例与连接</span><button class="add" data-action="toggle-add-form">＋ 添加</button></h2>${homes}</section>
    <section class="usage"><h2>Token 用量</h2><div id="usage-card">${usage}</div></section>
    ${logs || ''}
  `;
}
