import { esc } from '../store.js';

// 介入提示条：列表上方的「N 个会话需要你操作」。
//
// 为什么卡片上的橙色 chip 还不够：chip 只在「你正好扫到那一行」时起作用，而列表会滚动、
// 会被状态筛选切掉一部分。把计数放在列表入口处，才保证打开仪表盘就能看到「有人在等你」，
// 按钮则提供一步到位的收敛视图（切到「待介入」筛选）。
// 计数 ≤ 0 / 非法时返回空字符串 —— 没有介入就绝不画这条（否则会变成常驻噪音）。
// unobserved：屏上会话所属实例里「没有实时通道」的名字。这些实例只有落盘元数据，
// 等待审批 / 计划待审 / 等待回答**永远观察不到** —— 所以「0 个需要你操作」不能当成「没事」，
// 必须把观测盲区说出来（2026-10-27 实测事故：只读实例上一条会话在等审批，界面显示待介入 0）。
export function renderInterventionBanner(count, { active = false, unobserved = [] } = {}) {
  const n = Number(count);
  const blind = (Array.isArray(unobserved) ? unobserved : []).filter((x) => typeof x === 'string' && x.trim());
  const coverage = blind.length
    ? `<span class="iv-coverage" title="这些实例只有落盘元数据、没有实时通道：等待审批 / 计划待审 / 等待回答不会出现在「待介入」里">${blind.length} 个实例无实时通道（${blind.map((x) => esc(x)).join('、')}），那里的等待审批看不到</span>`
    : '';
  if (!Number.isFinite(n) || n <= 0) {
    // 没有可见介入 + 没有观测盲区 → 不画（旧的「没有介入不画提示条」语义保持不变）。
    return coverage ? `<div class="intervention-banner coverage" role="status">${coverage}</div>` : '';
  }
  const total = Math.max(1, Math.floor(n));
  return `<div class="intervention-banner" role="status" aria-live="polite">
      <span class="iv-dot" aria-hidden="true"></span>
      <span class="iv-text"><b>${total}</b> 个会话需要你操作</span>
      ${coverage}
      <button type="button" data-action="filter-session-status" data-status-filter="intervention"
        aria-pressed="${active === true}" title="只看正在等你审批 / 审计划 / 回答的会话">只看待介入</button>
    </div>`;
}

// 三栏的「分区身份」：Projects 用项目色（赭石），Sessions 用强调色（墨蓝），Instances 中性。
// 分区的颜色 + 图标 + 计数，配合两种卡不同的第一视觉锚点（项目徽标 / 会话状态轨），
// 让两栏在扫视时不会串。计数由调用方传入（缺省不画，保持旧调用兼容）。
// projectCount / sessionCount 既可以是数字（未过滤），也可以是 "3/20" 这样的字符串
// （搜索过滤中：命中/总数）—— 两种形态都走同一条 esc → innerHTML 路径。
// sessionFilter：项目筛选条（见 recent-sessions.js 的 renderSessionFilter）。它放在 h2 与
// 列表之间、不属于滚动区（.rows），所以筛选中时它会一直留在分区顶部，不被列表滚走。
// interventionBanner：列表上方的介入提示（见 renderInterventionBanner）。同样留在滚动区外，
// 缺省空字符串 = 不画。
// projectScope：项目栏的范围（'recent' = 最近 7 天，'all' = 全部项目）。见 projectsScopeHtml。
// 缺省 null = 不画切换控件，旧调用方（只渲染列表的测试/片段）行为不变。
export function renderWorkbench({ projects, sessions, homes, usage, logs, projectCount = null, sessionCount = null, sessionFilter = '', statusFilter = '', interventionBanner = '', searching = false, projectScope = null }) {
  const count = (n) => (n == null || n === '' ? '' : `<span class="pane-count">${esc(n)}</span>`);
  return `
    <section class="pane pane-projects"><h2><span class="pane-title"><span class="pane-mark" aria-hidden="true">▦</span>项目</span>${projectsScopeHtml(projectScope)}${count(projectCount)}</h2>${projects}</section>
    <section class="pane pane-sessions"><h2><span class="pane-title"><span class="pane-mark" aria-hidden="true">◍</span>${searching ? '会话搜索结果' : '最近会话'}</span>${count(sessionCount)}</h2>${sessionFilter}${statusFilter}${interventionBanner}<div class="session-list">${sessions}</div></section>
    <section class="pane pane-instances"><h2><span class="pane-title"><span class="pane-mark" aria-hidden="true">▣</span>实例与连接</span><button class="add" data-action="toggle-add-form">＋ 添加</button></h2>${homes}</section>
    <section class="usage"><h2>Token 用量</h2><div id="usage-card">${usage}</div></section>
    ${logs || ''}
  `;
}

// 「最近 / 全部」分段控件。
//
// 为什么必须有它：项目栏原来只显示「最近 7 天 + LIMIT 20」，被截断时**界面上没有任何提示**
// —— 分区头写 20，看起来就像「你的项目一共 20 个」。用户实测索引里 532 个项目、近 7 天
// 活跃 46 个，看到 20 只能靠顶栏搜索猜有没有漏。范围必须是用户能看见、能切换的状态。
//
// 为什么放在分区头而不是列表里：它决定「这一栏装什么」，属于表头语义；放进列表会随列表
// 滚走（翻到第 300 个项目时找不到切回「最近」的入口）。计数仍在最右（.pane-count 的
// margin-left:auto），控件紧跟标题，从属于「项目」这个分区身份。
// 用 aria-pressed 表达当前范围：这是原生 button 的按下态语义，键盘/读屏都能拿到，
// 也让 CSS 只认一个可访问性属性、不必再额外挂 class。
function projectsScopeHtml(scope) {
  if (scope !== 'recent' && scope !== 'all') return '';
  const btn = (key, label, title) => `<button type="button" class="pane-scope-btn"
      data-action="projects-scope" data-scope="${key}" aria-pressed="${scope === key}" title="${esc(title)}">${label}</button>`;
  return `<span class="pane-scope" role="group" aria-label="项目范围">${btn('recent', '最近', '只显示最近 7 天内有活动的项目')}${btn('all', '全部', '显示索引里的全部项目（不设时间窗，含更早的项目）')}</span>`;
}
