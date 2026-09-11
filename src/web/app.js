import { endpointRow, readEndpoints, endpointSelector } from './components/endpoint-editor.js';
import { attachFilePreview } from './components/file-preview.js';
import { api, subscribe, esc } from './store.js';
import { renderWorkbench } from './components/workbench.js';
import { renderRecentProjects } from './components/recent-projects.js';
import { renderRecentSessions } from './components/recent-sessions.js';
import { connectedHomes, tabHomes } from './instance-state.js';
import { planPaneNavigation, planPaneRecovery, updatePaneSession } from './instance-navigation.js';
import { renderInstanceGrid } from './components/instance-grid.js';
import { renderUsageCard, usageTrendHtml, fitTrendLabels, USAGE_PERIODS } from './components/usage-card.js';
import { renderHomeForm, renderOnboarding, renderSettingsForm, applyHomeMode } from './components/add-home.js';
import { logInit, logRefresh, appendLog, setLogFilter, toggleLogFollow, clearLogView, logPanelHtml } from './components/log-panel.js';
import { captureFormDraft, restoreFormDraft } from './components/form-draft.js';
import { createUsageCache } from './components/usage-cache.js';
import { createNote } from './components/note.js';

const main = document.getElementById('main');
const dashboardEl = document.getElementById('dashboard');
const tabs = document.getElementById('tabs');
const live = document.getElementById('live');
// 刷新/连接失败提示（挂在 dashboard 之外，避免被每轮重建清掉）。
// 粘性语义见 components/note.js：普通提示会被成功刷新撤掉，粘性提示（如添加实例时的 warning）不会。
const note = createNote(document.getElementById('note'));
const modalEl = document.getElementById('modal');
const themeBtn = document.getElementById('theme-btn');
const themeMenu = document.getElementById('theme-menu');

let showAddForm = false;
let lastHomes = [];
let refreshSequence = 0;
const endpointSwitching = new Set();
// Token 用量趋势：当前按哪个维度堆叠（total|project|provider|model|instance）+ 最新 /api/usage 数据。
let lastUsage = null;
// lastUsage 对应的统计周期 key。渲染时**用数据自己的周期**去高亮按钮，而不是用「用户刚点的那个」：
// 点「30天」→ 请求失败 → handleAction 的 catch 会 alert 后 refresh()，而 refresh 之前用的是
// 用户刚点的 key —— 卡片于是变成「新周期高亮 + 旧周期的数字」，读者无法察觉自己看的是哪个窗口。
// 现在高亮永远与屏上数据一致（失败时自然回退到旧的周期）。
let lastUsageKey = null;
// 渲染由 SSE 驱动（每 3s 一次），而 /api/usage 是 8 个同步聚合（实测 40k 会话 ~330ms，
// 期间整个单线程服务都停着）。所以渲染路径上不再「每次都要」：同一个统计周期 15s 内复用。
const usageCache = createUsageCache(15_000);
const usageKey = () => `${usagePeriod.days}:${usagePeriod.hours}`;
// 实例集合或名称变了（新增/移除/改名）之后必须丢掉这层缓存：用量数据（尤其「按实例」维度）
// 已经不是同一份了 —— 否则刚移除的实例最多还在图表里挂 15 秒（服务端那层 10s 记忆同理，已在路由里清）。
function dropUsageCache() { usageCache.invalidate(); }
function fetchUsage({ force = false } = {}) {
  const key = usageKey();
  if (!force) {
    const cached = usageCache.peek(key);
    if (cached) return Promise.resolve(cached);
  } else {
    usageCache.invalidate();
  }
  return api(`/api/usage?days=${usagePeriod.days}&hours=${usagePeriod.hours}`)
    .then((body) => usageCache.store(key, body));
}
let usageDim = 'total';
// 当前统计周期（过去 24h / 3天 / 7天 / 14天 / 30天）。hours 驱动趋势图，days 驱动汇总/按项目。
let usagePeriod = USAGE_PERIODS[0];
// 视图：工作台（纯元数据，零 iframe）或某个实例（持久 iframe，切走只隐藏不销毁）
let view = { kind: 'dashboard' };
// 每个已打开实例一个持久 iframe 面板：homeId -> { el, iframe, url, sessionId }
const panes = new Map();
window.addEventListener('message', (event) => {
  const type = event.data?.type;
  if (!['hwb:file-preview', 'hwb:preview-context', 'hwb:open-workspace'].includes(type)) return;
  if (type === 'hwb:file-preview' && (typeof event.data.path !== 'string' || event.data.path.length > 4096)) return;
  // 桥接会带上内嵌页的完整 URL；URL 里有 ?session= 时以它为准（比只信任桥接解析更稳），
  // 没有再退回桥接上报的 sessionId。当前 dsh 客户端不做 URL 导航，所以通常两者都为空。
  if (type === 'hwb:preview-context' && typeof event.data.href === 'string' && event.data.href.length <= 4096) {
    try { event.data.sessionId = new URL(event.data.href).searchParams.get('session') || event.data.sessionId || null; } catch { /* URL 不合法则用原值 */ }
  }
  if (event.data.sessionId != null && (typeof event.data.sessionId !== 'string' || event.data.sessionId.length > 512)) return;
  for (const [homeId, pane] of panes) {
    if ((type === 'hwb:file-preview' && pane.el.hidden) || event.source !== pane.iframe?.contentWindow || !pane.url) continue;
    if (event.origin !== new URL(pane.url).origin) continue;
    if (type === 'hwb:open-workspace') {
      if (pane.el.hidden || typeof event.data.workspaceId !== 'string') return;
      api(`/api/homes/${homeId}/open-workspace`, { method: 'POST', body: { workspaceId: event.data.workspaceId } }).catch((e) => alert(e.message));
    } else if (type === 'hwb:preview-context') {
      pane.preview.context(event.data);
      if (updatePaneSession(pane, event.data.sessionId) && view.kind === 'instance' && view.homeId === homeId) {
        view.sessionId = pane.sessionId;
        view.sessionTitle = null;
        view.project = null;
        saveView();
      }
    } else pane.preview.receive(event.data);
    break;
  }
});
// 拖拽排序后短暂抑制紧随其后的 click（避免拖完就切换实例）
let suppressNavClick = false;
let dragHomeId = null;

// —— 持久化：浏览器刷新后仍保持「当前位置 / Token 用量筛选」——
// 视图位置（工作台 or 某实例）用 sessionStorage：同标签页内跨刷新保持，关标签即清，
// 避免把「正在看哪个实例」误存成跨会话偏好；Token 用量筛选（统计周期 + 维度）用
// localStorage：这是用户偏好，理应跨会话保留。
const VIEW_KEY = 'hwb:view';
const USAGE_KEY = 'hwb:usage';
const USAGE_DIMS = ['total', 'project', 'provider', 'model', 'instance'];

function loadUsagePrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(USAGE_KEY) || 'null');
    if (!raw) return;
    if (USAGE_DIMS.includes(raw.dim)) usageDim = raw.dim;
    const p = USAGE_PERIODS.find((x) => x.key === raw.period);
    if (p) usagePeriod = p;
  } catch { /* storage 不可用/损坏时静默回退默认值 */ }
}
function saveUsagePrefs() {
  try { localStorage.setItem(USAGE_KEY, JSON.stringify({ dim: usageDim, period: usagePeriod.key })); } catch { /* 忽略 */ }
}
function loadView() {
  try {
    const raw = JSON.parse(sessionStorage.getItem(VIEW_KEY) || 'null');
    if (raw && raw.kind === 'instance' && typeof raw.homeId === 'string') return raw;
  } catch { /* 忽略 */ }
  return null;
}
function saveView() {
  try {
    if (view.kind === 'instance') {
      sessionStorage.setItem(VIEW_KEY, JSON.stringify({
        kind: 'instance',
        homeId: view.homeId,
        sessionId: view.sessionId || null,
        sessionTitle: view.sessionTitle || null,
        project: view.project || null,
      }));
    } else {
      sessionStorage.removeItem(VIEW_KEY);
    }
  } catch { /* 忽略 */ }
}

function tabLabel(h) {
  return esc(h.alias || h.serverId || h.homePath);
}

function renderTabs() {
  const dashboard = `<button class="tab ${view.kind === 'dashboard' ? 'active' : ''}"
                              data-action="nav-dashboard" data-tab="dashboard">◧ 工作台</button>`;
  const inst = tabHomes(lastHomes).map((h) => {
    const rt = h.runtime?.runtime ?? 'stopped';
    const active = view.kind === 'instance' && view.homeId === h.homeId;
    const pane = panes.get(h.homeId);
    const externalUrl = active && (pane?.externalUrl || pane?.url);
    return `<button class="tab ${active ? 'active' : ''}" draggable="true"
                    data-action="nav-instance" data-home-id="${esc(h.homeId)}"
                    title="${esc(h.homePath)}${rt === 'unreachable' ? ' · 连接暂时无响应，等待恢复' : ''}">
      <span class="dot ${esc(rt)}"></span>
      <span class="label">${tabLabel(h)}</span>
    </button>${externalUrl ? `<button class="tab tab-popout" data-action="popout"
      data-url="${esc(externalUrl)}" title="在外部浏览器打开" aria-label="在外部浏览器打开 ${tabLabel(h)}">↗</button>` : ''}`;
  }).join('');
  tabs.innerHTML = dashboard + inst;
}

// 切换视图：只显示/隐藏面板，绝不销毁 iframe（持久化，不重载）
function showView() {
  dashboardEl.hidden = view.kind !== 'dashboard';
  for (const [homeId, pane] of panes) {
    pane.el.hidden = !(view.kind === 'instance' && view.homeId === homeId);
    pane.preview.toggle.hidden = pane.el.hidden;
  }
}

async function refresh() {
  const sequence = ++refreshSequence;
  const { homes } = await api('/api/homes');
  if (sequence !== refreshSequence) return;
  // 这一轮成功了，撤掉上一次的失败提示；粘性提示（见 components/note.js）不在此列。
  note.clearUnlessSticky();
  lastHomes = homes;
  if (view.kind === 'instance' && !tabHomes(homes).some((h) => h.homeId === view.homeId)) {
    view = { kind: 'dashboard' };
    saveView();
  }
  if (view.kind === 'instance') {
    const pane = panes.get(view.homeId);
    const runtime = homes.find((home) => home.homeId === view.homeId)?.runtime;
    const recovery = planPaneRecovery(pane, runtime);
    if (recovery) {
      pane.deeplink = recovery.deeplink;
      pane.externalUrl = recovery.externalUrl;
      mountPane(view.homeId, recovery.url, recovery.sessionId, pane, recovery.force);
    }
  }
  renderTabs();
  showView();
  if (view.kind === 'instance') return; // 持久 iframe 不被 SSE 刷新打断
  await renderDashboard(sequence);
}

async function renderDashboard(sequence = refreshSequence) {
  if (lastHomes.length === 0) {
    dashboardEl.dataset.layout = 'onboarding';
    // 首装时这个表单是唯一的出口，而 monitor 每 30s 就会无条件广播一次 → 重建。
    // 不保留草稿的话用户每半分钟就被清空一次输入（与 grid 布局同一个问题）。
    // 但**捕获必须紧挨着重建**：detect 是一次网络请求，先捕获再 await 的话，用户在这段时间里
    // 敲的字会被随后的重建覆盖掉（而「不让输入丢失」正是这个模块存在的理由）。
    // 所以顺序是：await → 确认这次渲染仍然有效 → 捕获 → 重建 → 恢复。
    const detected = await api('/api/homes/detect');
    if (sequence !== refreshSequence || view.kind !== 'dashboard') return;
    const onboardingDraft = captureAddFormDraft();
    dashboardEl.innerHTML = renderOnboarding(detected);
    restoreAddFormDraft(onboardingDraft);
    return;
  }
  dashboardEl.dataset.layout = 'grid';
  // allSettled 而不是 all：任何一个端点失败（后端重启、单个查询 500）都不该把另外三栏一起清空。
  // 失败的栏目退化为空态渲染，并在顶部提示具体是哪个接口挂了。
  const [projectsRes, sessionsRes, usageRes] = await Promise.allSettled([
    api('/api/projects/recent'),
    api('/api/sessions/recent'),
    fetchUsage(),
  ]);
  if (sequence !== refreshSequence || view.kind !== 'dashboard') return;
  const failed = [['项目列表', projectsRes], ['会话列表', sessionsRes], ['用量统计', usageRes]]
    .filter(([, r]) => r.status === 'rejected')
    .map(([label, r]) => `${label}(${r.reason?.message ?? r.reason})`);
  if (failed.length) {
    // 「当下失败」属于普通提示：会覆盖掉粘性提示（它更紧急），也会被下一次成功刷新撤掉。
    note.set(`部分数据加载失败：${failed.join('；')}`);
  }
  const projects = projectsRes.status === 'fulfilled' ? projectsRes.value.projects : [];
  const sessions = sessionsRes.status === 'fulfilled' ? sessionsRes.value.sessions : [];
  const usage = usageRes.status === 'fulfilled' ? usageRes.value : null;
  lastUsage = usage;
  if (usage) lastUsageKey = usageKey(); // 与 fetchUsage 的缓存键同源（这里拿到的就是这个周期的数据）
  const connectedIds = new Set(connectedHomes(lastHomes).map((h) => h.homeId));
  // 草稿必须在重建之前取：下面这行 innerHTML 会把旧表单连同用户输入一起丢掉。
  const draft = captureAddFormDraft();
  dashboardEl.innerHTML = renderWorkbench({
    projects: connectedIds.size ? renderRecentProjects(projects.filter((p) => connectedIds.has(p.homeId)), lastHomes) : '<div class="empty">连接实例后显示对应项目</div>',
    sessions: connectedIds.size ? renderRecentSessions(sessions.filter((s) => connectedIds.has(s.homeId))) : '<div class="empty">连接实例后显示对应会话</div>',
    homes: renderInstanceGrid(lastHomes),
    usage: renderUsageCard(usage, usageDim, lastUsageKey ?? usagePeriod.key),
    logs: logPanelHtml(),
  });
  fitTrendLabels(dashboardEl); // X 轴标签按实测宽度收边/去重叠（见 usage-card.js）
  logRefresh(); // 日志面板：重绘 + 同步过滤/跟随按钮激活态
  if (showAddForm) {
    dashboardEl.querySelector('section:nth-child(3) h2').insertAdjacentHTML('afterend', renderHomeForm());
    const form = dashboardEl.querySelector('#add-home');
    const restored = restoreFormDraft(form, draft); // 内部会重放模式（显隐/必填）
    applyHomeMode(form, form.mode?.value === 'remote' ? 'remote' : 'local');
    if (!restored) form.querySelector('input[name=homePath]')?.focus();
  }
  hlProject = null; hlRow = null; hlKind = null; // 刷新后清除残留高亮状态
}

function goDashboard() {
  view = { kind: 'dashboard' };
  saveView();
  renderTabs();
  showView();
  refresh().catch(reportRefreshFailure);
}

// —— Token 用量趋势：切换堆叠维度（不整页刷新，只就地重绘图表 + 高亮按钮）——
// 把趋势图渲染进容器，并按**实测**宽度收边/去重叠（见 usage-card.fitTrendLabels）。
// 收敛成一个函数是因为「漏掉拟合」已经真实发生过一次：切维度（合计/按项目/…）走的是这条纯本地
// 重渲染路径，它原先只写了 innerHTML —— 实测切到「按项目」后两个标签重叠（09-04 20:00|09-05 20:00），
// 而周期切换那条路径（refreshUsageCard）是拟合过的，于是同一个图表两种表现。
function renderTrendInto(el) {
  if (!el || !lastUsage) return;
  el.innerHTML = usageTrendHtml(lastUsage, usageDim);
  fitTrendLabels(el);
}

function renderUsageTrend() {
  renderTrendInto(document.getElementById('usage-trend'));
  document.querySelectorAll('#usage-dim-toggle .usage-dim-btn')
    .forEach((b) => b.classList.toggle('active', b.dataset.dim === usageDim));
}

// —— Token 用量：切换统计周期（过去 24h / 3天 / 7天 / 14天 / 30天）——
// 按当前周期重新拉取 /api/usage，并就地重绘整个用量卡片（汇总 + 趋势 + 按项目保持一致）。
// 周期切换的序号守卫：`/api/usage` 的耗时随周期变化（30 天比 24h 重得多），
// 「先点 30 天、再快速点 24h」会让响应**乱序返回** —— 没有守卫时会把 30 天的数字配着
// 「24h」的高亮一起画出来，并且污染 lastUsage（后续切换维度时画出与周期不符的趋势）。
// 与 refresh() / renderDashboard() 的做法一致：只有最后一次请求的结果可以落盘。
let usageSequence = 0;
async function refreshUsageCard() {
  const seq = ++usageSequence;
  const key = usageKey();
  const usage = await fetchUsage({ force: true });
  if (seq !== usageSequence || key !== usageKey()) return;   // 期间用户又切了周期 → 丢弃
  lastUsage = usage;
  lastUsageKey = key;
  const el = document.getElementById('usage-card');
  if (el) {
    el.innerHTML = renderUsageCard(usage, usageDim, lastUsageKey);
    fitTrendLabels(el);
  }
}

// —— Token 构成线（新增输入/缓存命中/缓存创建/输出）与趋势图数据点的悬停 tooltip ——
// 单条构成线的不同颜色分段、趋势图上的圆形数据点：悬停均用 fixed tooltip 展示详细信息
// （名称 · 实际用量 · 占比）。fixed 定位到 body，绝不溢出/被裁剪。
function usageTipEl() {
  let t = document.getElementById('usage-stream-tip');
  if (!t) {
    t = document.createElement('div');
    t.id = 'usage-stream-tip';
    t.className = 'usage-stream-tip';
    t.hidden = true;
    document.body.appendChild(t);
  }
  return t;
}
function positionUsageTip(el, tip) {
  const er = el.getBoundingClientRect();
  const tr = tip.getBoundingClientRect();
  let left = er.left + er.width / 2 - tr.width / 2;
  left = Math.max(6, Math.min(left, window.innerWidth - tr.width - 6));
  let top = er.top - tr.height - 8;
  if (top < 6) top = er.bottom + 8;
  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
}
const USAGE_TIP_TARGET = '.usage-stream .seg, .trend-dot';
document.addEventListener('mouseover', (e) => {
  const target = e.target.closest(USAGE_TIP_TARGET);
  if (!target) return;
  const tip = usageTipEl();
  tip.innerHTML = `<b>${esc(target.dataset.name)}</b><span class="t">${esc(target.dataset.tok)}</span><span class="p">${esc(target.dataset.pct)}%</span>`;
  tip.hidden = false;
  positionUsageTip(target, tip);
});
document.addEventListener('mousemove', (e) => {
  const tip = document.getElementById('usage-stream-tip');
  if (!tip || tip.hidden) return;
  const target = e.target.closest(USAGE_TIP_TARGET);
  if (target) positionUsageTip(target, tip);
});
document.addEventListener('mouseout', (e) => {
  const target = e.target.closest(USAGE_TIP_TARGET);
  if (!target) return;
  const tip = document.getElementById('usage-stream-tip');
  if (tip) tip.hidden = true;
});

// —— 持久实例面板 ——
function paneFor(homeId) {
  let pane = panes.get(homeId);
  if (pane) return pane;
  const el = document.createElement('section');
  el.className = 'view iframe-pane';
  el.dataset.homeId = homeId;
  el.hidden = true;
  el.innerHTML = `
    <div class="frame-loading">连接 dsh web…</div>
    <div class="frame-cover" hidden><span class="frame-cover-label">加载中…</span></div>`;
  main.appendChild(el);
  // _cookieReady: 该实例 origin 是否已种下 dsh 鉴权 cookie(种过即可直达 ?session=, 少一次重载)
  // _iframed: 是否已挂载过 iframe(触发首次导航)  _navTarget/_navStep: 二段跳+遮罩的剩余状态
  pane = { el, iframe: null, url: null, sessionId: null, _iframed: false, _cookieReady: false, _navTarget: null, _navStep: 0 };
  pane.preview = attachFilePreview(pane, homeId);
  panes.set(homeId, pane);
  return pane;
}

function showFrameCover(pane, label) {
  const cover = pane.el.querySelector('.frame-cover');
  if (!cover) return;
  cover.querySelector('.frame-cover-label').textContent = label;
  cover.hidden = false;
}

function hideFrameCover(pane) {
  const cover = pane.el.querySelector('.frame-cover');
  if (cover) cover.hidden = true;
  pane._navStep = 0;
}

// iframe 每次 load 时: 若本轮先加载的是带 token 的入口(与最终 ?session= 目标不同),
// 说明刚完成种 cookie 的握手, 继续二段跳到最终目标并保持遮罩; 否则(最终目标已到达/普通打开)收起遮罩。
function onFrameLoad(pane) {
  const iframe = pane.iframe;
  if (pane.url) iframe.contentWindow?.postMessage({ type: 'hwb:preview-init' }, new URL(pane.url).origin);
  const target = pane._navTarget;
  if (!target) { hideFrameCover(pane); return; }
  if (iframe.src !== target) {
    pane._cookieReady = true; // 入口(带 token)load 完成 ⇒ cookie 已种下
    pane._navStep = 1;
    iframe.src = target;      // 二段跳: 无 token 的 ?session=, 此刻已认证
    return;
  }
  pane._navStep = 0;
  pane._navTarget = null;
  hideFrameCover(pane);
}

function destroyPane(homeId) {
  const pane = panes.get(homeId);
  if (!pane) return;
  pane.preview?.dispose();
  pane.el.remove();
  panes.delete(homeId);
}

function mountPane(homeId, url, sessionId, pane, force = false) {
  const navigation = planPaneNavigation(pane, url, sessionId, force);
  const wantSession = sessionId && pane.deeplink;
  const navLabel = wantSession ? '连接会话…' : 'dsh web 加载中…';

  if (!pane.iframe) {
    const loading = pane.el.querySelector('.frame-loading');
    if (loading) loading.remove();
    const iframe = document.createElement('iframe');
    iframe.title = 'dsh web';
    pane.el.appendChild(iframe);
    pane.iframe = iframe;
    iframe.addEventListener('load', () => onFrameLoad(pane));
  }

  pane.url = url;
  // 首次挂载、会话切换或入口变化时导航；普通标签切换仍复用已打开的 iframe。
  if (navigation) {
    pane._iframed = true;
    pane._cookieReady = navigation.cookieReady;
    pane.sessionId = navigation.sessionId;
    // 会话深链且未种过 cookie → 先加载带 token 的入口(种 cookie), 再由 onFrameLoad 二段跳;
    // 已种过 cookie(本实例内切换会话) → 直达 ?session=, 单次加载。
    const { firstTarget, finalTarget } = navigation;
    pane._navTarget = finalTarget;
    pane._navStep = 0;
    showFrameCover(pane, navLabel);
    if (force || pane.iframe.src !== firstTarget) pane.iframe.src = firstTarget;
  }

}

async function enterInstance(homeId, extra = {}) {
  const token = Symbol('view');
  const pane = paneFor(homeId);
  view = { kind: 'instance', homeId, token, sessionId: pane.sessionId, ...extra };
  saveView();
  renderTabs();
  pane._opening = token;
  showView(); // 懒创建：先 loading，进程就绪后才挂 iframe
  try {
    const inst = await api(`/api/homes/${homeId}/open`, { method: 'POST' });
    if (view.token !== token) return; // 启动期间用户已切走
    pane.deeplink = !!inst.deeplink;
    // 深链会话用「二段跳转」,入口 URL 始终只带 token(先种 cookie);
    // 是否拼 `?session=` 由 mountPane 在 cookie 就绪后处理。
    const url = inst.iframeUrl || inst.url;
    pane.externalUrl = inst.url;
    mountPane(homeId, url, view.sessionId, pane);
    renderTabs();
  } catch (e) {
    if (view.token === token) {
      const loading = pane.el.querySelector('.frame-loading');
      if (loading) loading.textContent = `连接失败: ${e.message}`;
    }
  } finally {
    if (pane._opening === token) pane._opening = null;
  }
  refresh().catch(reportRefreshFailure); // runtime 状态已变，更新 tab 圆点
}

function formMsg(form, text, isError) {
  const el = form.querySelector('.form-msg');
  el.hidden = false;
  el.textContent = text;
  el.classList.toggle('error', isError);
}

// —— 实例设置弹层 ——
function closeModal() {
  modalEl.hidden = true;
}

function openSettings(homeId) {
  const home = lastHomes.find((h) => h.homeId === homeId);
  if (!home) return;
  modalEl.innerHTML = `
    <div class="modal-card">
      <h3>编辑实例：${esc(home.alias || home.homePath || homeId)}</h3>
      ${renderSettingsForm(home)}
      <div class="meta actions">
        <button data-action="restart" data-home-id="${esc(homeId)}">重启实例</button>
        <button data-action="stop" data-home-id="${esc(homeId)}">停止实例</button>
        <button data-action="reindex" data-home-id="${esc(homeId)}">重新索引</button>
        <button data-action="remove-home" data-home-id="${esc(homeId)}" data-name="${esc(home.alias || home.homePath)}">移除实例</button>
      </div>
      <div class="modal-actions">
        <button data-action="close-settings">取消</button>
        <button class="primary" data-action="save-settings" data-home-id="${esc(homeId)}">保存</button>
      </div>
    </div>`;
  modalEl.hidden = false;
  const first = modalEl.querySelector('input');
  if (first) first.focus();
}

async function saveSettings(homeId) {
  const form = modalEl.querySelector('#settings-form');
  const home = lastHomes.find((h) => h.homeId === homeId);
  if (!form || !home) return;
  const body = { alias: form.alias.value.trim(), endpoints: readEndpoints(form) };
  if (home.hostType === 'remote') {
    body.accessPort = form.accessPort.value.trim() || null;
    body.remoteHome = form.remoteHome.value.trim() || null;
    body.remoteCmd = form.remoteCmd.value.trim() || null;
    body.remoteLog = form.remoteLog.value.trim() || null;
  } else {
    body.homePath = form.homePath.value.trim();
  }
  await api(`/api/homes/${homeId}`, { method: 'PUT', body });
  dropUsageCache();   // 别名决定「按实例」维度的显示名；改名后不该还挂着旧名字
  closeModal();
  // 若该实例正处于打开视图（或配置变更导致 homeId 变化），保存后自动回工作台并清理其 pane。
  if (view.kind === 'instance' && view.homeId === homeId) {
    destroyPane(homeId);
    goDashboard();
    return;
  }
  await refresh();
}

async function addHome({ homePath, alias, hostType = 'local', host, remotePort, remoteHome, remoteCmd, remoteLog, token, localPort, accessPort }, form) {
  const body = hostType === 'remote'
    ? { hostType, host, remotePort, remoteHome: remoteHome || undefined, remoteCmd, remoteLog, token: token || undefined, alias }
    : { homePath, alias, localPort: localPort || undefined, token: token || undefined };
  if (hostType === 'remote' && accessPort !== undefined) body.accessPort = accessPort;
  const data = await api('/api/homes', { method: 'POST', body });
  // warning 必须挂在**持久**的 #note 上：紧接着的 showAddForm = false; refresh() 会重建整个
  // dashboard 的 innerHTML（表单只在 showAddForm 为真时才重新插入），写进表单的消息会被直接抹掉
  // —— 服务端明明回了「这个目录看起来不像 dsh home」，用户一个字都看不到。
  const warning = form && data.warning ? data.warning : null;
  showAddForm = false;
  dropUsageCache();   // 新实例可能立刻带来一批历史会话，别让「按实例」图滞后 15s
  await refresh();
  if (warning) {
    // 粘性：这类提示描述的是「需要你处理的事实」，不是「刚刚那一轮刷新失败了」，
    // 所以刷新与重连都不该把它撤掉（用户处理完之后再刷新页面即可）。
    note.set(`已添加，但注意：${warning}`, { sticky: true });
  }
}

async function handleAction(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  if (suppressNavClick && btn.dataset.action === 'nav-instance') {
    suppressNavClick = false; // 拖拽后的残留点击，忽略且只消费一次
    return;
  }
  try {
    switch (btn.dataset.action) {
      case 'nav-dashboard':
        goDashboard();
        break;
      case 'nav-instance':
        await enterInstance(btn.dataset.homeId);
        break;
      case 'drill-in':
        await enterInstance(btn.dataset.homeId, {
          sessionId: btn.dataset.sessionId || null,
          sessionTitle: btn.dataset.title || null,
          project: btn.dataset.project || null,
        });
        break;
      case 'popout':
        window.open(btn.dataset.url, '_blank');
        break;
      case 'toggle-add-form':
        showAddForm = !showAddForm;
        await refresh();
        break;
      case 'add-detected':
        await addHome({ homePath: btn.dataset.path });
        break;
      case 'add-endpoint': {
        const editor = btn.closest('.endpoint-editor');
        editor.querySelector('.endpoint-rows').insertAdjacentHTML('beforeend', endpointRow({}, editor.dataset.remote === 'true'));
        break;
      }
      case 'remove-endpoint':
        btn.closest('.endpoint-row').remove();
        break;
      case 'clear-endpoint-token': {
        // 服务端不再回传 token，所以「清除」必须在界面上显式表达一次：
        // 标记这一行，由 readEndpoints 转成 tokenClear: true（留空只是「保持不变」）。
        const row = btn.closest('.endpoint-row');
        row.dataset.tokenClear = '1';
        const state = row.querySelector('[data-token-state]');
        if (state) state.textContent = '保存后清除 token';
        btn.disabled = true;
        break;
      }
      case 'choose-channel': {
        const home = lastHomes.find((h) => h.homeId === btn.dataset.homeId);
        if (!home || (home.endpoints?.length || 0) < 2) break;
        modalEl.innerHTML = `<div class="modal-card"><h3>切换连接通道：${esc(home.alias || home.serverId || home.homePath)}</h3>${endpointSelector(home)}<div class="modal-actions"><button data-action="close-settings">取消</button></div></div>`;
        modalEl.hidden = false;
        break;
      }
      case 'switch-endpoint': {
        const id = btn.dataset.homeId;
        if (endpointSwitching.has(id)) return;
        const endpointId = btn.closest('.endpoint-switch').querySelector('select').value;
        btn.disabled = true;
        btn.textContent = '切换中…';
        endpointSwitching.add(id);
        try { await api(`/api/homes/${id}/switch`, { method: 'POST', body: { endpointId } }); }
        finally { endpointSwitching.delete(id); }
        closeModal();
        destroyPane(id);
        if (view.kind === 'instance' && view.homeId === id) await enterInstance(id);
        else await refresh();
        break;
      }
      case 'connect':
        btn.disabled = true;
        btn.textContent = '连接中…';
        await api(`/api/homes/${btn.dataset.homeId}/open`, { method: 'POST' });
        await refresh();
        break;
      case 'disconnect':
        btn.disabled = true;
        await api(`/api/homes/${btn.dataset.homeId}/disconnect`, { method: 'POST' });
        destroyPane(btn.dataset.homeId);
        await refresh();
        break;
      case 'restart':
        // 稳定第一：重启会打断远端实例并换发新 token，属用户主动的最后手段，需要明确授权。
        if (!confirm('重启该 dsh web 实例？（会打断正在运行的实例、换发新 token。若只是更新了远端 dsh，建议在设置里直接填 token 以直连，而不要重启。）')) return;
        btn.disabled = true;
        await api(`/api/homes/${btn.dataset.homeId}/restart`, { method: 'POST' });
        await enterInstance(btn.dataset.homeId); // 用新 token URL 重新挂载面板
        break;
      case 'reindex':
        btn.disabled = true;
        await api(`/api/homes/${btn.dataset.homeId}/reindex`, { method: 'POST' });
        await refresh();
        break;
      case 'stop':
        // 稳定第一：停止会打断实例，属用户主动的最后手段，需明确授权。
        if (!confirm('停止该实例？（会打断正在运行的 dsh web；仅作最后手段。）')) return;
        btn.disabled = true;
        await api(`/api/homes/${btn.dataset.homeId}/stop`, { method: 'POST' });
        await refresh();
        break;
      case 'remove-home':
        if (confirm(`移除 ${btn.dataset.name}？（只删除 hwb 索引，不碰 dsh 文件）`)) {
          const id = btn.dataset.homeId;
          if (view.kind === 'instance' && view.homeId === id) {
            view = { kind: 'dashboard' };
            saveView();
          }
          await api(`/api/homes/${id}`, { method: 'DELETE' });
          destroyPane(id);
          dropUsageCache();
          await refresh();
        }
        break;
      case 'settings':
        openSettings(btn.dataset.homeId);
        break;
      case 'save-settings':
        await saveSettings(btn.dataset.homeId);
        break;
      case 'close-settings':
        closeModal();
        break;
      case 'usage-dim':
        usageDim = btn.dataset.dim || 'total';
        renderUsageTrend();
        saveUsagePrefs();
        break;
      case 'usage-period':
        usagePeriod = USAGE_PERIODS.find((p) => p.key === btn.dataset.period) || usagePeriod;
        await refreshUsageCard();
        saveUsagePrefs();
        break;
      case 'log-filter':
        setLogFilter(btn.dataset.level);
        break;
      case 'log-follow':
        toggleLogFollow();
        break;
      case 'log-clear':
        clearLogView();
        break;
    }
  } catch (err) {
    alert(err.message);
    await refresh();
  }
}

document.body.addEventListener('click', handleAction);

// 键盘可达性：Recent Projects / Recent Sessions 的行是 <div class="row clickable"> 配一个
// 委托到 body 的 click 处理器 —— 只有鼠标能用。这里给同一批 [data-action] 元素补上键盘激活
// （Enter / Space），并让它们在标记里带 role=button + tabindex=0（见两个 recent-* 组件）。
const ACTIVATABLE = new Set(['drill-in', 'nav-instance', 'nav-dashboard']);
document.body.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const el = e.target.closest?.('[data-action]');
  if (!el || !ACTIVATABLE.has(el.dataset.action)) return;
  if (e.target !== el) return; // 只处理「焦点就在这个可激活元素上」，不劫持内部控件的按键
  e.preventDefault(); // Space 默认会滚动页面
  handleAction({ target: el });
});

// —— 实例 tab 拖拽排序（HTML5 DnD）——
function getDragAfterElement(container, x) {
  const els = [...container.querySelectorAll('.tab[draggable=true]:not(.dragging)')];
  let closest = { offset: Number.NEGATIVE_INFINITY, element: null };
  for (const el of els) {
    const box = el.getBoundingClientRect();
    const offset = x - box.left - box.width / 2;
    if (offset < 0 && offset > closest.offset) closest = { offset, element: el };
  }
  return closest.element;
}

function handleDragStart(e) {
  const tab = e.target.closest('.tab[draggable=true]');
  if (!tab) return;
  dragHomeId = tab.dataset.homeId;
  tab.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragHomeId);
}

function handleDragOver(e) {
  if (!dragHomeId) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const dragging = tabs.querySelector('.tab.dragging');
  if (!dragging) return;
  const after = getDragAfterElement(tabs, e.clientX);
  tabs.querySelectorAll('.tab').forEach((t) => t.classList.remove('drag-target'));
  if (after == null) tabs.appendChild(dragging);
  else if (after !== dragging) tabs.insertBefore(dragging, after);
  const popout = tabs.querySelector('.tab-popout');
  const active = tabs.querySelector('.tab.active[data-action="nav-instance"]');
  if (popout && active) active.after(popout);
}

async function handleDragEnd() {
  tabs.querySelectorAll('.tab').forEach((t) => t.classList.remove('dragging', 'drag-target'));
  const dragged = dragHomeId;
  dragHomeId = null;
  if (!dragged) return;
  // 从 DOM 读出可见标签的新顺序。但 DOM 里只有 tabHomes（运行中/仍持有入口的实例），
  // 未连接的实例不在其中，而 sortIndex 是**全局**的：只提交可见的那批会留下旧索引与新索引撞车，
  // 刷新后 ORDER BY sortIndex 会把用户刚排好的顺序再次打乱；lastHomes 也会被裁成可见子集，
  // 让 Instances 栏里的其余实例消失到下一次刷新。
  // 因此提交全量：可见的按 DOM 顺序在前，其余保持它们原有的相对顺序跟在后面。
  const visible = [...tabs.querySelectorAll('.tab[draggable=true]')].map((t) => t.dataset.homeId);
  const visibleSet = new Set(visible);
  const hidden = lastHomes.map((h) => h.homeId).filter((id) => !visibleSet.has(id));
  const ids = [...visible, ...hidden];
  const byId = new Map(lastHomes.map((h) => [h.homeId, h]));
  lastHomes = ids.map((id) => byId.get(id)).filter(Boolean);
  suppressNavClick = true;
  setTimeout(() => { suppressNavClick = false; }, 150);
  try {
    await api('/api/homes/order', { method: 'POST', body: { homeIds: ids } });
  } catch (err) {
    console.warn('persist tab order failed:', err.message);
  }
}

tabs.addEventListener('dragstart', handleDragStart);
tabs.addEventListener('dragover', handleDragOver);
tabs.addEventListener('drop', (e) => e.preventDefault());
tabs.addEventListener('dragend', handleDragEnd);

// —— 界面主题切换：白天 / 黑夜 / 跟随系统 ——
const THEME_MODES = ['light', 'dark', 'system'];
const THEME_KEY = 'hwb:theme';
const THEME_GLYPH = { light: '☀️', dark: '🌙', system: '🌓' };
const THEME_LABEL = { light: '白天', dark: '黑夜', system: '跟随系统' };
function currentThemeMode() {
  try {
    const m = localStorage.getItem(THEME_KEY);
    return THEME_MODES.includes(m) ? m : 'system';
  } catch { return 'system'; }
}
function applyTheme(mode) {
  document.documentElement.setAttribute('data-theme', mode);
  if (themeBtn) {
    themeBtn.textContent = THEME_GLYPH[mode] || '🌓';
    themeBtn.title = `界面外观：${THEME_LABEL[mode]}`;
  }
  if (themeMenu) {
    themeMenu.querySelectorAll('.menu-item').forEach((item) => {
      item.classList.toggle('active', item.dataset.mode === mode);
    });
  }
}
function setTheme(mode) {
  try { localStorage.setItem(THEME_KEY, mode); } catch { /* storage 不可用则本次生效 */ }
  applyTheme(mode);
  rerenderForTheme();
}
// 主题切换后重绘工作台：chip 配色为内联样式，深浅两套调色板需重渲染才能切换
function rerenderForTheme() {
  if (view.kind === 'dashboard' && lastHomes.length) renderDashboard();
}
function closeThemeMenu() { if (themeMenu) themeMenu.hidden = true; }
function toggleThemeMenu() { if (themeMenu) themeMenu.hidden = !themeMenu.hidden; }
themeBtn?.addEventListener('click', (e) => { e.stopPropagation(); toggleThemeMenu(); });
themeMenu?.addEventListener('click', (e) => {
  const item = e.target.closest('.menu-item[data-mode]');
  if (item) { setTheme(item.dataset.mode); closeThemeMenu(); }
});
// 点击菜单以外任意处关闭
document.addEventListener('click', (e) => {
  if (themeMenu && !themeMenu.hidden && !e.target.closest('#theme-wrap')) closeThemeMenu();
});
// 跟随系统时，系统亮暗切换自动刷新按钮图标（配色由 CSS media query 决定）
(function watchSystemTheme() {
  const mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
  if (!mq) return;
  mq.addEventListener?.('change', () => { if (currentThemeMode() === 'system') { applyTheme('system'); rerenderForTheme(); } });
})();

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && themeMenu && !themeMenu.hidden) {
    themeMenu.hidden = true;
    return;
  }
  if (e.key === 'Escape' && !modalEl.hidden) {
    closeModal();
    return;
  }
  if (e.key === 'Escape' && view.kind === 'instance') goDashboard();
});

// 点击弹层空白处关闭
modalEl.addEventListener('click', (e) => {
  if (e.target === modalEl) closeModal();
});

main.addEventListener('submit', async (e) => {
  if (e.target.id !== 'add-home') return;
  e.preventDefault();
  const form = e.target;
  const alias = form.alias.value.trim() || undefined;
  try {
    if (form.mode.value === 'remote') {
      await addHome({
        hostType: 'remote',
        host: form.host.value.trim(),
        remotePort: Number(form.remotePort.value),
        remoteHome: form.remoteHome.value.trim(),
        remoteCmd: form.remoteCmd.value.trim() || null,
        remoteLog: form.remoteLog.value.trim() || null,
        accessPort: form.accessPort.value.trim() || null,
        token: form.token.value.trim() || null,
        alias,
      }, form);
    } else {
      await addHome({
        homePath: form.homePath.value.trim(),
        localPort: form.localPort.value.trim() || null,
        token: form.token.value.trim() || null,
        alias,
      }, form);
    }
  } catch (err) {
    formMsg(form, err.message, true);
  }
});

dashboardEl.addEventListener('change', (e) => {
  if (!e.target.matches('#add-home .home-mode')) return;
  applyHomeMode(e.target.closest('form'), e.target.value);
});

// 重建 dashboard 前后的一对操作：记下 / 写回「添加实例」表单草稿。
// onboarding 与 grid 两条渲染路径都要用 —— 否则首装用户每 ≤30s（monitor 无条件广播）
// 就会丢一次输入，而那正是唯一能让工作台从「空的」变成「有实例」的表单。
function captureAddFormDraft() {
  return captureFormDraft(dashboardEl.querySelector('#add-home'), document.activeElement);
}

function restoreAddFormDraft(draft) {
  const form = dashboardEl.querySelector('#add-home');
  if (!form) return;
  // 先重放模式（显隐/必填），再恢复值/焦点：两者顺序无关，但模式必须在提交前是对的。
  applyHomeMode(form, form.mode?.value === 'remote' ? 'remote' : 'local');
  restoreFormDraft(form, draft);
}

// —— 联动高亮：悬停 project 高亮它 + 其所有 session；悬停 session 只高亮它 + 对应 project ——
let hlProject = null;
let hlRow = null;
let hlKind = null;

const rowSelFor = (proj, kind) => `.row[data-project="${CSS.escape(proj)}"][data-kind="${kind}"]`;

function clearHighlight() {
  if (hlProject === null) return;
  if (hlKind === 'session') {
    hlRow?.classList.remove('hl-project');
    dashboardEl.querySelector(rowSelFor(hlProject, 'project'))?.classList.remove('hl-project');
  } else {
    dashboardEl.querySelectorAll(`[data-project="${CSS.escape(hlProject)}"]`).forEach((r) => r.classList.remove('hl-project'));
  }
  hlProject = null; hlRow = null; hlKind = null;
}

function applyHighlight(row) {
  clearHighlight();
  const proj = row.dataset.project;
  if (!proj) return;
  hlProject = proj; hlRow = row; hlKind = row.dataset.kind;
  if (row.dataset.kind === 'session') {
    // 只高亮当前 session + 它所属的 project（不动同 project 的其它 session）
    row.classList.add('hl-project');
    dashboardEl.querySelector(rowSelFor(proj, 'project'))?.classList.add('hl-project');
  } else {
    // 悬停 project：高亮它 + 名下所有 session
    dashboardEl.querySelectorAll(`[data-project="${CSS.escape(proj)}"]`).forEach((r) => r.classList.add('hl-project'));
  }
}

dashboardEl.addEventListener('mouseover', (e) => {
  const row = e.target.closest('.row[data-project]');
  if (!row || !row.dataset.project) return;
  if (hlProject === row.dataset.project && hlRow === row) return; // 已在高亮该组且就是此行
  applyHighlight(row);
});
dashboardEl.addEventListener('mouseout', (e) => {
  const row = e.target.closest('.row[data-project]');
  if (!row || !row.dataset.project) return;
  const to = e.relatedTarget;
  if (to && to.closest && to.closest(`.row[data-project="${CSS.escape(row.dataset.project)}"]`)) return; // 仍在同 project 组内
  clearHighlight();
});

// SSE 刷新合并：一次索引更新会连着广播 index:updated / instance:status / monitor:updated，
// 逐个直接 refresh() 就是连续几次全量重建（有实例在跑时叠加 live-poller 的 3s 节奏）。
// 合并到一个短窗口里只刷一次，既省重绘，也避免刚恢复的表单草稿又被下一次重建打断。
const REFRESH_COALESCE_MS = 120;
let refreshQueued = false;
function scheduleRefresh() {
  if (refreshQueued) return;
  refreshQueued = true;
  setTimeout(() => { refreshQueued = false; refresh().catch(reportRefreshFailure); }, REFRESH_COALESCE_MS);
}

// 刷新失败时必须让用户看见，而不是把旧内容默默留在屏幕上。
// 提示挂在 dashboard 之外（它每轮都会被 innerHTML 重建）。
function reportRefreshFailure(error) {
  // 普通提示：优先于粘性提示显示，且会在下一次成功刷新时被撤掉。
  note.set(`刷新失败：${error?.message ?? error}`);
}

subscribe(
  () => scheduleRefresh(),
  (on) => {
    live.textContent = on ? 'live' : 'reconnecting…';
    live.classList.toggle('on', on);
    if (!on) { reportRefreshFailure(new Error('实时通道已断开，正在重连')); return; }
    // 恢复时两件事都要做：①把断线提示撤掉（否则顶栏写着 live、下面还挂着「已断开」）；
    // ②补一次刷新 —— 断线期间错过的 index:updated 不会重发，不补就一直是旧数据（最长等到 30s 心跳）。
    // 粘性提示（如添加实例时的 warning）不在此列：它跟「通道通不通」无关。
    note.clearUnlessSticky();
    scheduleRefresh();
  },
  (entry) => appendLog(entry) // 实时日志推送到「运行日志」面板
);

// 预载日志环缓冲快照，让「运行日志」面板打开即有历史。
logInit().catch(() => {});

// 启动：先恢复「Token 用量筛选」偏好，再拉取实例列表，最后按需恢复到上次所在的实例视图。
async function boot() {
  applyTheme(currentThemeMode()); // 同步右上角主题按钮图标与菜单选中态（<head> 内联脚本已抢先应用 data-theme 防闪烁）
  loadUsagePrefs(); // 在首次 renderDashboard 之前恢复周期/维度，让首屏就用回用户上次的选择
  const restored = loadView(); // 上次刷新前停留在哪个实例（若有）
  await refresh();
  if (restored?.kind === 'instance') {
    if (tabHomes(lastHomes).some((h) => h.homeId === restored.homeId)) {
      // 重新挂载该实例的持久 iframe（含会话深链），刷新后位置保持不变。
      await enterInstance(restored.homeId, {
        sessionId: restored.sessionId || null,
        sessionTitle: restored.sessionTitle || null,
        project: restored.project || null,
      });
    } else {
      saveView(); // 该实例已被移除：清掉残留位置，回到工作台。
    }
  }
}

boot().catch((e) => {
  // e.message 可能是服务端回显的自由文本（api() 会把 {error} 当消息抛出），必须转义后再进 innerHTML。
  dashboardEl.innerHTML = `<div class="empty">failed to load: ${esc(e.message)}</div>`;
});
