export function renderWorkbench({ projects, sessions, homes, usage, logs }) {
  return `
    <section><h2>Recent Projects</h2>${projects}</section>
    <section><h2>Recent Sessions</h2>${sessions}</section>
    <section><h2>Instances <button class="add" data-action="toggle-add-form">＋ 添加</button></h2>${homes}</section>
    <section class="usage"><h2>Token 用量</h2><div id="usage-card">${usage}</div></section>
    ${logs || ''}
  `;
}
