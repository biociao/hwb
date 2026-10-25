// 三栏的「分区身份」：Projects 用项目色（赭石），Sessions 用强调色（墨蓝），Instances 中性。
// 分区的颜色 + 图标 + 计数，配合两种卡不同的第一视觉锚点（项目徽标 / 会话状态轨），
// 让两栏在扫视时不会串。计数由调用方传入（缺省不画，保持旧调用兼容）。
export function renderWorkbench({ projects, sessions, homes, usage, logs, projectCount = null, sessionCount = null }) {
  const count = (n) => (Number.isInteger(n) ? `<span class="pane-count">${n}</span>` : '');
  return `
    <section class="pane pane-projects"><h2><span class="pane-title"><span class="pane-mark" aria-hidden="true">▦</span>Recent Projects</span>${count(projectCount)}</h2>${projects}</section>
    <section class="pane pane-sessions"><h2><span class="pane-title"><span class="pane-mark" aria-hidden="true">◍</span>Recent Sessions</span>${count(sessionCount)}</h2>${sessions}</section>
    <section class="pane pane-instances"><h2><span class="pane-title"><span class="pane-mark" aria-hidden="true">▣</span>Instances</span><button class="add" data-action="toggle-add-form">＋ 添加</button></h2>${homes}</section>
    <section class="usage"><h2>Token 用量</h2><div id="usage-card">${usage}</div></section>
    ${logs || ''}
  `;
}
