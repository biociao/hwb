import { endpointRow, readEndpoints, endpointSelector } from './components/endpoint-editor.js';
import { downloadFile, uploadFiles, partitionUploads, MAX_UPLOAD_BYTES, MAX_UPLOAD_FILES } from './file-ops.js';
import { api, subscribe, esc, isLocalToolHome, localToolLabel } from './store.js';
import { renderWorkbench } from './components/workbench.js';
import { renderRecentProjects } from './components/recent-projects.js';
import { renderRecentSessions, renderSessionFilter } from './components/recent-sessions.js';
import { SESSION_FILTERS, filterSessionState, renderSessionStatusFilter } from './components/session-state.js';
import { renderSearchResults } from './components/search-results.js';
import { readMutedProjects, writeMutedProjects, toggleMutedProject, splitMutedSessions, mutedNoteSpec, renderMutedNote, renderMutedIdleNote, DEFAULT_MUTED_PROJECTS } from './components/session-mute.js';
import { filterRecent, filterExactProject, searchEmptyHtml, searchPendingHtml, mergeSearchResults, normalizeQuery } from './components/search-filter.js';
import { connectedHomes, tabHomes } from './instance-state.js';
import { planPaneNavigation, planPaneRecovery, updatePaneSession } from './instance-navigation.js';
import { renderInstanceGrid } from './components/instance-grid.js';
import { renderUsageCard, usageTrendHtml, fitTrendLabels, USAGE_PERIODS } from './components/usage-card.js';
import { renderHomeForm, renderOnboarding, renderSettingsForm, applyHomeMode } from './components/add-home.js';
import { logInit, logRefresh, appendLog, setLogFilter, toggleLogFollow, clearLogView, logPanelHtml } from './components/log-panel.js';
import { captureFormDraft, restoreFormDraft } from './components/form-draft.js';
import { createUsageCache } from './components/usage-cache.js';
import { createNote } from './components/note.js';
import { planFrameEviction, touchFrameOrder, resolveMaxLiveFrames } from './frame-budget.js';

const main = document.getElementById('main');
const dashboardEl = document.getElementById('dashboard');
const tabs = document.getElementById('tabs');
const live = document.getElementById('live');
// 刷新/连接失败提示（挂在 dashboard 之外，避免被每轮重建清掉）。
// 粘性语义见 components/note.js：普通提示会被成功刷新撤掉，粘性提示（如添加实例时的 warning）不会。
const note = createNote(document.getElementById('note'));
// 短暂的成功反馈：先设成粘性（refresh() 的 clearUnlessSticky 不会把它撤掉），再定时清除。
// 与 addHome 的「粘性 + 定时清除」同一套路 —— 普通提示会被紧随其后的成功刷新立刻清掉。
function flashNote(text, ms = 5000) {
  note.set(text, { sticky: true });
  setTimeout(() => note.clear(), ms);
}
const modalEl = document.getElementById('modal');
const themeBtn = document.getElementById('theme-btn');
const themeMenu = document.getElementById('theme-menu');
const searchInput = document.getElementById('search');
const searchClear = document.getElementById('search-clear');
const searchWrap = document.getElementById('search-wrap');
const searchResults = document.getElementById('search-results');
const searchScope = document.getElementById('search-scope');

let showAddForm = false;
let lastHomes = [];
let lastDetected = null; // 最近一次 /api/homes/detect 结果（Instances 添加表单的只读快捷入口用）
let refreshSequence = 0;
// 顶栏搜索的原始输入。不持久化：它是「当下想找什么」，刷新后回到未过滤状态，
// 免得用户下次打开面对一个自己忘了的隐藏过滤器（与 sessionStorage 里的视图位置是两种语义）。
let searchQuery = '';
let searchScopeProject = null; // 显式指定的搜索范围；选择项目导航不会自动限制全局搜索。
let searchOpen = false;
let lastSearchResults = { projects: [], sessions: [] };
let sessionStatusFilter = 'all';
// 最近一轮拉到的原始列表 + 已连接实例集合。按键过滤直接复用它们（见 paintDashboard）：
// 过滤只改「显示哪些行」，不该每敲一个字就重新打一次 /api/projects|sessions|usage。
let lastLists = { projects: [], sessions: [], connectedIds: new Set() };
// 项目筛选（Recent Projects → Recent Sessions 联动）。
// 点项目卡不再跳转实例，而是把这个项目名下的会话筛到 Sessions 栏；服务端按 project **精确**
// 取该项目的全部会话（/api/sessions/recent?project=），不受「最近 50 条」限制。
// 与搜索词同语义：只存在内存里，刷新页面回到未筛选 —— 免得下次打开面对一个忘了的隐藏过滤器。
let projectFilter = null; // { project, homeId, sessionId, workspaceId } | null
// 已拉到的项目会话，与 projectFilter.project 配对；筛选切换时旧数据立即作废（paint 显示 loading）。
let projectSessions = { project: null, status: 'idle', sessions: [], truncated: false };
// 一个项目最多取这么多条会话：够定位，又不会把 990 会话的大项目整页渲染出来。
// 超出时服务端回 truncated，列表底部说明「还有更多，可用顶栏搜索定位」。
const PROJECT_SESSION_LIMIT = 200;
// 默认静音项目（Recent Sessions 里默认隐藏它们的会话）。批量/自动化项目（如 relic-distill-cwd
// 的 "Distill durable knowledge from the"）会持续产出成百上千条会话，把其它项目挤出视野。
// 列表存在 localStorage：首次打开用内置默认；用户点「取消隐藏」后以显式列表为准（空 = 不隐藏）。
// localStorage 在某些上下文里连读属性都会抛 SecurityError，所以取一次、包一层兜底。
const browserStorage = (() => {
  try { return window.localStorage; } catch { return null; }
})();
let mutedProjects = readMutedProjects(browserStorage);
// 「显示已隐藏」只是当前视图的临时开关（不写偏好）：点一次看全部，刷新/恢复默认后仍按默认隐藏。
let showMutedSessions = false;
// 「新前端 + 旧后端」混合状态只提示一次（见 renderDashboard 里的 project 兜底过滤）。
let staleBackendNoted = false;
// 全库补搜的状态（顶栏搜索框的历史部分）。
//
// 为什么不能只过滤 lastLists：那两段数据分别是「近 7 天 top 20 项目」和「最近 50 条会话」，
// 更早的项目/会话根本不在里面。实测：PMAID-GPPH 最后活动在 32 天前，输入 GPPH 得到
// 0/20、0/50，而索引里明明有它 7 条会话。这里在用户停手后向 /api/search 再问一次全库，
// 把历史命中合并进列表（行上打 historical 标记），本地过滤仍然即时生效。
// query/seq 成对使用：连续输入时先发后到的慢响应不能覆盖新查询的结果。
let searchState = {
  query: '',
  seq: 0,
  status: 'idle', // idle | loading | done | error
  projects: [],
  sessions: [],
  truncated: { projects: false, sessions: false },
};
let searchSeq = 0;
let searchTimer = null;
// 防抖窗口：太短会让每个字都触发一次全表扫描（instr 走不了索引），
// 太长会让「历史结果」明显晚于本地过滤出现。200ms 是输入停顿的常见阈值。
const SEARCH_DEBOUNCE_MS = 200;
// 与 /api/projects/recent、/api/sessions/recent 的默认量级一致：搜索是给人定位用的，不是导出。
const SEARCH_PROJECT_LIMIT = 20;
const SEARCH_SESSION_LIMIT = 50;
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
// 视图：工作台（纯元数据，零 iframe）或某个实例（热 iframe，切走只隐藏；超出预算才释放）
let view = { kind: 'dashboard' };
// 每个已打开实例一个持久 iframe 面板：homeId -> { el, iframe, url, sessionId }
const panes = new Map();
// 活跃 iframe 的 LRU 顺序（最旧 → 最新）与预算。见 frame-budget.js：每个 iframe 都是一整个
// dsh web SPA，无上限地留着会把浏览器内存拖爆（Safari 会直接重载页面）。
const MAX_LIVE_FRAMES = resolveMaxLiveFrames(window.location.search);
let frameOrder = [];
let frameReleased = 0; // 累计释放次数（只被 __hwbFrameBudget 读出用于排查/测量，不参与逻辑）
// 内嵌 dsh 页面里由**注入控件**派发的两个文件动作：下载到本机、上传回工作区。
// 预览与浏览本身不再经过 hwb —— 点击文件路径由 dsh 自己开进右侧 Sidebar 的文档预览
// （chat 的 openFile → sidebarRight.openResource），桥接不再拦截；hwb 只补 dsh 缺的两件事：
// 把文件本体取回本机（documentpreview 头部注入的按钮）与把本机文件写回工作区
// （sidebar-files 头部注入的按钮）。真正的鉴权/围栏/上限全在服务端，见 file-ops.js。
window.addEventListener('message', (event) => {
  const type = event.data?.type;
  if (!['hwb:file-download', 'hwb:file-upload', 'hwb:preview-context', 'hwb:open-workspace'].includes(type)) return;
  // 下载必须有真实路径：空串会被服务端解析成工作区根目录（目录是下载不了的，白跑一趟）。
  if (type === 'hwb:file-download' && (typeof event.data.path !== 'string' || !event.data.path || event.data.path.length > 4096)) return;
  // 上传：目标目录必须是绝对/相对路径串，文件清单必须是有限的 File 数组（File 经结构化克隆过来）。
  if (type === 'hwb:file-upload') {
    if (typeof event.data.dir !== 'string' || !event.data.dir || event.data.dir.length > 4096) return;
    if (!Array.isArray(event.data.files) || event.data.files.length === 0 || event.data.files.length > MAX_UPLOAD_FILES) return;
  }
  // 桥接会带上内嵌页的完整 URL；URL 里有 ?session= 时以它为准（比只信任桥接解析更稳），
  // 没有再退回桥接上报的 sessionId。当前 dsh 客户端不做 URL 导航，所以通常两者都为空。
  if (type === 'hwb:preview-context' && typeof event.data.href === 'string' && event.data.href.length <= 4096) {
    try { event.data.sessionId = new URL(event.data.href).searchParams.get('session') || event.data.sessionId || null; } catch { /* URL 不合法则用原值 */ }
  }
  if (event.data.sessionId != null && (typeof event.data.sessionId !== 'string' || event.data.sessionId.length > 512)) return;
  for (const [homeId, pane] of panes) {
    if (event.source !== pane.iframe?.contentWindow || !pane.url) continue;
    if (event.origin !== new URL(pane.url).origin) continue;
    if (type === 'hwb:open-workspace') {
      if (pane.el.hidden || typeof event.data.workspaceId !== 'string') return;
      api(`/api/homes/${homeId}/open-workspace`, { method: 'POST', body: { workspaceId: event.data.workspaceId } }).catch((e) => alert(e.message));
    } else if (type === 'hwb:preview-context') {
      // 只用于跟踪「这个 iframe 现在是哪个会话」：标签、深链与上面的文件动作都靠它解析工作区。
      if (updatePaneSession(pane, event.data.sessionId) && view.kind === 'instance' && view.homeId === homeId) {
        view.sessionId = pane.sessionId;
        view.sessionTitle = null;
        view.project = null;
        saveView();
      }
    } else if (pane.el.hidden) {
      return; // 面板已隐藏（切走/被释放）：文件动作没有可归属的界面去反馈，直接丢弃
    } else if (type === 'hwb:file-download') {
      downloadFile(homeId, paneQuery(pane, event.data), event.data.path)
        .catch((e) => note.set(`下载失败：${e.message}`, { sticky: true }));
    } else {
      uploadIntoPane(pane, homeId, event.data);
    }
    break;
  }
});
// 文件动作归属哪个工作区：桥接上报的会话优先（用户刚切过去的那个），否则用面板跟踪到的会话。
function paneQuery(pane, data) {
  const sessionId = (typeof data?.sessionId === 'string' && data.sessionId) || pane.sessionId;
  return sessionId ? { sessionId } : {};
}
function postUploadStatus(pane, text, tone, reload = false) {
  if (!pane.url) return;
  pane.iframe?.contentWindow?.postMessage({ type: 'hwb:upload-status', text, tone, reload }, new URL(pane.url).origin);
}
// 上传整批文件：进度与逐条失败原因回传到**注入按钮所在的那个侧栏**（而不是 hwb 自己的界面），
// 因为用户的眼睛在那里；失败额外记一条 hwb 顶栏提示，免得浮层 20 秒后消失就再无线索。
async function uploadIntoPane(pane, homeId, data) {
  const { accepted, oversize } = partitionUploads(data.files);
  // 超限的文件在本地就拦下（服务端也会挡，但没必要先把几百 MiB 传过去）；一并记在顶栏，
  // 免得浮层 20 秒后消失就再无线索。
  const skipped = oversize.length ? `已跳过 ${oversize.length} 个超过 ${MAX_UPLOAD_BYTES / (1024 * 1024)} MiB 的文件。` : '';
  if (skipped) note.set(skipped, { sticky: true });
  if (!accepted.length) { postUploadStatus(pane, skipped, 'error'); return; }
  postUploadStatus(pane, `${skipped}正在上传 ${accepted.length} 个文件…`, 'info');
  try {
    const result = await uploadFiles(homeId, paneQuery(pane, data), data.dir, accepted, (percent) => {
      postUploadStatus(pane, `${skipped}正在上传… ${percent}%`, 'info');
    });
    if (!result.uploaded) {
      const why = `上传失败：${result.failed.join('；')}`;
      postUploadStatus(pane, why, 'error');
      note.set(why, { sticky: true });
      return;
    }
    const renamed = result.renamed.length ? `；同名已改名：${result.renamed.join('，')}` : '';
    const failed = result.failed.length ? `；${result.failed.length} 个失败：${result.failed.join('；')}` : '';
    postUploadStatus(pane, `${skipped}已上传 ${result.uploaded} 个文件${renamed}${failed}`, result.failed.length ? 'error' : 'ok', !result.failed.length);
    if (result.failed.length) note.set(`上传部分失败：${result.failed.join('；')}`, { sticky: true });
  } catch (e) {
    postUploadStatus(pane, `${skipped}上传失败：${e.message}`, 'error');
    note.set(`上传失败：${e.message}`, { sticky: true });
  }
}
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
    // 外链优先用稳定入口（远程实例 = 已保存的接入端口）：它跨隧道重建不变，
    // 且与 iframe 同 origin（token→cookie 已握手过）。externalUrl 是本次连接的运行地址，
    // 只在稳定入口不可得时兜底（例如尚未建立预览代理的旧响应）。
    const externalUrl = active && (pane?.popoutUrl || pane?.externalUrl || pane?.url);
    return `<button class="tab ${active ? 'active' : ''}" draggable="true"
                    data-action="nav-instance" data-home-id="${esc(h.homeId)}"
                    title="${esc(h.homePath)}${rt === 'unreachable' ? ' · 连接暂时无响应，等待恢复' : ''}${pane?.released ? ' · 已释放内存（重新进入时重新加载）' : ''}">
      <span class="dot ${esc(rt)}"></span>
      <span class="label">${tabLabel(h)}</span>
    </button>${externalUrl ? `<button class="tab tab-popout" data-action="popout"
      data-url="${esc(externalUrl)}" title="在外部浏览器打开" aria-label="在外部浏览器打开 ${tabLabel(h)}">↗</button>` : ''}`;
  }).join('');
  tabs.innerHTML = dashboard + inst;
}

// 切换视图：只显示/隐藏面板，不销毁**热** iframe（持久化，不重载）。
// 但「热」是有预算的：进入某个实例即把它标成最近使用，超预算的按 LRU 释放 iframe
// （releasePaneFrame）—— 保留标签页与会话 id，重新进入时重新挂载。
function showView() {
  dashboardEl.hidden = view.kind !== 'dashboard';
  // 搜索只作用于工作台的列表：实例视图（整页 iframe）里放着它没有意义，还会让人以为
  // 它能过滤 dsh 页面。输入值保留，切回工作台时继续生效。
  if (searchWrap) searchWrap.hidden = view.kind !== 'dashboard' || lastHomes.length === 0;
  if (view.kind !== 'dashboard') searchOpen = false;
  paintSearchResults();
  const activeId = view.kind === 'instance' ? view.homeId : null;
  if (activeId) frameOrder = touchFrameOrder(frameOrder, activeId);
  for (const [homeId, pane] of panes) {
    pane.el.hidden = homeId !== activeId;
  }
  enforceFrameBudget();
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
      pane.popoutUrl = recovery.popoutUrl;
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
    lastDetected = detected;
    if (sequence !== refreshSequence || view.kind !== 'dashboard') return;
    const onboardingDraft = captureAddFormDraft();
    dashboardEl.innerHTML = renderOnboarding(detected);
    restoreAddFormDraft(onboardingDraft);
    return;
  }
  dashboardEl.dataset.layout = 'grid';
  // Instances 的「添加」表单里也有「检测到 ~/.dsh → 添加为只读」快捷入口：
  // 首次展开表单时补一次 detect（很便宜），之后复用。
  if (showAddForm && lastDetected === null) {
    try { lastDetected = await api('/api/homes/detect'); } catch { lastDetected = null; }
  }
  // allSettled 而不是 all：任何一个端点失败（后端重启、单个查询 500）都不该把另外三栏一起清空。
  // 失败的栏目退化为空态渲染，并在顶部提示具体是哪个接口挂了。
  // 项目筛选中多拉一条 `/api/sessions/recent?project=`：这是「该项目的全部会话」，
  // 与全局最近 50 条是两份数据（后者仍然保留，清掉筛选时立刻能画）。
  const project = projectKey();
  const [projectsRes, sessionsRes, projectSessionsRes, usageRes] = await Promise.allSettled([
    api('/api/projects/recent'),
    api('/api/sessions/recent'),
    project ? api(projectSessionsUrl(project)) : Promise.resolve(null),
    fetchUsage(),
  ]);
  if (sequence !== refreshSequence || view.kind !== 'dashboard') return;
  const failed = [
    ['项目列表', projectsRes],
    ['会话列表', sessionsRes],
    ...(project ? [['项目会话列表', projectSessionsRes]] : []),
    ['用量统计', usageRes],
  ]
    .filter(([, r]) => r.status === 'rejected')
    .map(([label, r]) => `${label}(${r.reason?.message ?? r.reason})`);
  if (failed.length) {
    // 「当下失败」属于普通提示：会覆盖掉粘性提示（它更紧急），也会被下一次成功刷新撤掉。
    note.set(`部分数据加载失败：${failed.join('；')}`);
  }
  const projects = projectsRes.status === 'fulfilled' ? projectsRes.value.projects : [];
  const sessions = sessionsRes.status === 'fulfilled' ? sessionsRes.value.sessions : [];
  const usage = usageRes.status === 'fulfilled' ? usageRes.value : null;
  if (project) {
    // 只有成功时才算「这批数据属于当前筛选」；失败保留 error 状态让 Sessions 栏说清原因，
    // 而不是拿空的 done 数据画一句「该项目没有会话」——那是在撒谎。
    if (projectSessionsRes.status === 'fulfilled') {
      const raw = Array.isArray(projectSessionsRes.value?.sessions) ? projectSessionsRes.value.sessions : [];
      // 新前端 + 旧后端（只刷新了浏览器、没重启 hwb）时，旧后端不认识 project 参数，
      // 会把全局最近 N 条当项目会话返回 —— 这里按项目名再精确过滤一次兜底，并提示重启。
      const exact = filterExactProject(raw, project);
      if (!staleBackendNoted && raw.length > 0 && exact.length !== raw.length) {
        staleBackendNoted = true;
        note.set('hwb 后端仍是旧版本（未识别按项目筛选）：已在前端按项目名兜底过滤。重启 hwb 后即可取到该项目的全部会话。', { sticky: true });
      }
      projectSessions = {
        project,
        status: 'done',
        sessions: exact,
        truncated: projectSessionsRes.value?.truncated === true,
      };
    } else {
      projectSessions = { project, status: 'error', sessions: [], truncated: false };
    }
  }
  lastUsage = usage;
  if (usage) lastUsageKey = usageKey(); // 与 fetchUsage 的缓存键同源（这里拿到的就是这个周期的数据）
  const connectedIds = new Set(connectedHomes(lastHomes).map((h) => h.homeId));
  lastLists = { projects, sessions, connectedIds };
  paintDashboard();
}

// 当前被筛选的项目名；没有筛选时为 null。
const projectKey = () => projectFilter?.project ?? null;

// 项目会话的取数地址：project 是**精确**等值条件（不是搜索词），limit 用专门的常量。
function projectSessionsUrl(project) {
  return `/api/sessions/recent?${new URLSearchParams({ project, limit: String(PROJECT_SESSION_LIMIT) })}`;
}

// 切换/清除项目筛选。这是唯一的写入点（点项目卡、点筛选条的 ✕ 都走这里）：
//   · 先同步状态并立刻重画：点击当帧就能看到「选中 + 正在筛出…」，不等网络往返；
//   · 再 refresh() 拉这个项目的会话（renderDashboard 会带上 project 参数）；
//   · 清掉筛选时先用 lastLists.sessions（最近 50 条）立刻画出来，再靠 refresh() 校正。
// 浏览项目与全局搜索独立。切换项目时清掉旧补搜，显式搜索范围由 searchScopeProject 管理。
function setProjectFilter(next) {
  const nextProject = typeof next?.project === 'string' && next.project ? next.project : null;
  if (projectKey() === nextProject) return; // 同一项目重复点击由调用方处理成「取消」
  projectFilter = nextProject === null ? null : {
    project: nextProject,
    homeId: next.homeId || null,
    sessionId: next.sessionId || null,
    workspaceId: next.workspaceId || null,
  };
  projectSessions = projectFilter
    ? { project: projectFilter.project, status: 'loading', sessions: [], truncated: false }
    : { project: null, status: 'idle', sessions: [], truncated: false };
  resetSearchState();
  if (searchKey()) scheduleFullSearch();
  paintDashboard();
  refresh().catch(reportRefreshFailure);
}

// 当前有效查询词：本地过滤与 /api/search 共用同一个归一化口径（大小写 / 全角 / 空白）。
const searchKey = () => normalizeQuery(searchQuery);

// 已完成的、与当前输入词一致的全库结果；没有就返回 null（此时只显示最近列表内的命中）。
function fullSearchResult() {
  const key = searchKey();
  if (!key || searchState.query !== key || searchState.status !== 'done') return null;
  return searchState;
}

// 全库补搜进行中（本地暂时没有命中时，用它画「正在全库检索…」而不是先闪「没有匹配」）。
function fullSearchPending() {
  const key = searchKey();
  return !!(key && searchState.query === key && searchState.status === 'loading');
}

// 把「最近一轮数据 + 全库补搜结果 + 当前搜索词」画成仪表盘。渲染只有这一条路径：
//   · SSE 刷新拿到新数据 → renderDashboard → paintDashboard；
//   · 搜索框输入 → paintDashboard（本地过滤即时生效，不重新请求最近列表）；
//   · /api/search 返回 → paintDashboard（把历史命中合并进来）。
// 计数、空态、过滤全部由 filterRecent() 决定，所以几条路径不可能画出不同的过滤结果。
function paintDashboard() {
  const { projects, sessions, connectedIds } = lastLists;
  const searching = !!searchKey();
  const project = searching ? searchScopeProject : projectKey();
  // 项目筛选下的数据源：只认「与当前项目配对」的那份；刚切换/还没回来时是 loading，
  // 不能拿上一轮的数组顶替（否则会先闪一段别的项目的会话，再被新数据换掉）。
  const proj = project ? (projectSessions.project === project ? projectSessions : null) : null;
  const projectLoading = !searching && !!project && (!proj || proj.status === 'loading');
  const projectErrored = !searching && !!project && proj?.status === 'error';
  const projSessions = project && proj?.status === 'done' ? proj.sessions : [];
  const baseSessions = project ? (searching ? filterExactProject(sessions, project) : projSessions) : sessions;
  const full = fullSearchResult();
  // 最近列表优先，全库结果只补「最近列表里没有的」历史行（见 mergeSearchResults 的注释）。
  const lists = full
    ? mergeSearchResults({ projects, sessions: baseSessions, searchedProjects: full.projects, searchedSessions: full.sessions })
    : { projects, sessions: baseSessions };
  // 只渲染「已连接实例」的项目/会话；计数与渲染用同一份数组，避免分区头写着 12 但列表只有 5 行。
  const filtered = filterRecent({ projects: lists.projects, sessions: lists.sessions, connectedIds, query: searchQuery });
  if (searching && project) {
    filtered.projects = filtered.projects.filter((p) => p.project === project);
    filtered.sessions = filterExactProject(filtered.sessions, project);
  }
  lastSearchResults = { projects: filtered.projects, sessions: filterSessionState(filtered.sessions) };
  // 默认静音项目：最后一道展示层过滤。项目筛选是显式选择（点开被隐藏项目就是要看它），
  // 或用户点了「显示」时覆盖默认隐藏；hidden 行数用于画「已隐藏 N 条 · 显示」提示。
  const mute = splitMutedSessions(filtered.sessions, {
    mutedProjects,
    showMuted: showMutedSessions,
    projectFilter: project,
  });
  const shownSessions = filterSessionState(mute.visible, sessionStatusFilter);
  const pending = fullSearchPending();
  // 过滤到 0 条时给「清除搜索」的出路；全库补搜还在路上时先说明「正在检索」。
  const projectsHtml = !filtered.connected
    ? '<div class="empty">连接实例后显示对应项目</div>'
    : (filtered.filtering && !filtered.projects.length)
      ? (pending ? searchPendingHtml('项目', searchQuery) : searchEmptyHtml('项目', searchQuery))
      : renderRecentProjects(filtered.projects, lastHomes, { selectedProject: searching ? null : project, mutedProjects });
  // Sessions 栏的空态有优先级：未连接 → 项目会话加载中 → 加载失败 → 该项目确实没有会话 →
  // 匹配到的会话全被默认隐藏，最后才是搜索的「0 命中 / 正在全库检索」。项目本来就没有会话时
  // 提示「清除搜索」是误导（搜索不是原因，清掉也还是没有）。
  const sessionsHtml = !filtered.connected
    ? '<div class="empty">连接实例后显示对应会话</div>'
    : projectLoading
      ? `<div class="empty">正在筛出「${esc(project)}」的会话…</div>`
      : projectErrored
        ? '<div class="empty">项目会话加载失败；可清除筛选回到最近会话</div>'
        : (!searching && project && !projSessions.length)
          ? `<div class="empty">「${esc(project)}」还没有已索引的会话</div>`
          : (mute.hidden.length > 0 && !mute.visible.length)
            // 全部被默认隐藏：交给下面的 mutedNote 说明（它带「显示」按钮），
            // 这里再画一句「没有匹配」会让人以为真的搜不到。
            ? ''
            : (sessionStatusFilter !== 'all' && mute.visible.length > 0 && !shownSessions.length)
              ? '<div class="empty search-empty">该状态下没有会话<button type="button" data-action="filter-session-status" data-status-filter="all">显示全部状态</button></div>'
            : (filtered.filtering && !shownSessions.length)
              ? (pending ? searchPendingHtml('会话', searchQuery) : searchEmptyHtml('会话', searchQuery))
              : renderRecentSessions(shownSessions, lastHomes);
  // 默认隐藏的提示条：始终说明「少了的是被默认规则藏起来的」，并把「显示/恢复隐藏」放在原地。
  // 入参用 mutedNoteSpec() 合成：它用的是 split.muted（按规则本该隐藏的全部行），而不是
  // split.hidden（当前真的藏起来的行）—— 点「显示」后 hidden 为空，用后者会让「恢复隐藏」入口
  // 消失（真实缺陷；见 tests/session-mute.test.js 的 mutedNoteSpec 用例）。
  const noteSpec = mutedNoteSpec(mute, {
    showMuted: showMutedSessions,
    filtering: filtered.filtering,
    projectFilter: project,
  });
  const mutedNote = noteSpec ? renderMutedNote(noteSpec) : '';
  // 默认静音被关掉时的恢复入口（用户可能只是误点了「取消默认隐藏」，之后既没提示也没入口）。
  const mutedIdleNote = project ? '' : renderMutedIdleNote({ mutedProjects });
  // 项目筛选条：只在筛选时画；count 只报筛出来的条数（不是搜索的「命中/总数」）。
  // muted：该项目是否在默认静音列表里（显式点开时仍显示会话，但给一个「取消隐藏」入口）。
  const sessionFilter = !searching && project && filtered.connected
    ? renderSessionFilter({
      project,
      homeId: projectFilter.homeId,
      sessionId: projectFilter.sessionId,
      workspaceId: projectFilter.workspaceId,
      count: proj?.status === 'done' ? projSessions.length : null,
      muted: mutedProjects.includes(project),
    })
    : '';
  // 过滤中的计数不再用「命中/最近列表总数」：命中可能来自全库，分母（最近 20/50 条）与它没有
  // 可比性。只报命中数；未过滤时仍是最近列表的条数（默认隐藏的行不算进「看得见的条数」，
  // 隐藏了多少由 mutedNote 明确写出来）。
  const count = (shown, total) => (filtered.filtering ? `${shown} 命中` : total);
  // 命中超过上限时明确说一声，避免用户以为「只有这些」；更精确的关键词可以继续缩小。
  const projectsMore = full?.truncated.projects
    ? `<div class="search-more">仅显示最近 ${SEARCH_PROJECT_LIMIT} 个项目，可用更精确的关键词缩小范围</div>` : '';
  const sessionsMore = full?.truncated.sessions
    ? `<div class="search-more">仅显示最近 ${SEARCH_SESSION_LIMIT} 条会话，可用更精确的关键词缩小范围</div>` : '';
  // 项目会话被 limit 截断：明确说「只显示了这么多」，并指出继续定位的路径（顶栏搜索会按
  // 项目作用域去全库补搜，不受这个 limit 限制）。
  const projectMore = !searching && project && proj?.status === 'done' && proj.truncated
    ? `<div class="search-more">该项目会话较多，仅显示最近 ${PROJECT_SESSION_LIMIT} 条；可用顶栏搜索继续定位更早的会话</div>` : '';
  // 草稿必须在重建之前取：下面这行 innerHTML 会把旧表单连同用户输入一起丢掉。
  const draft = captureAddFormDraft();
  const openDetails = new Set([...dashboardEl.querySelectorAll('[data-instance-details][open]')].map((el) => el.dataset.instanceDetails));
  const focusedStatus = document.activeElement?.dataset?.statusFilter;
  const focusedDetails = document.activeElement?.closest?.('[data-instance-details]')?.dataset.instanceDetails;
  const focusedDetailsAction = document.activeElement?.dataset?.action;
  const scrolls = [...dashboardEl.querySelectorAll('.pane > .rows, .session-list')].map((el) => el.scrollTop);
  dashboardEl.innerHTML = renderWorkbench({
    projects: projectsHtml + projectsMore,
    sessions: sessionsHtml + projectMore + sessionsMore + mutedNote + mutedIdleNote,
    sessionFilter,
    statusFilter: filtered.connected ? renderSessionStatusFilter(mute.visible, sessionStatusFilter) : '',
    searching,
    projectCount: filtered.connected ? count(filtered.projects.length, filtered.totalProjects) : null,
    // 会话计数用「屏上实际可见行数」：默认隐藏的会话数由 mutedNote 单独说明，不从计数里消失得无声无息。
    sessionCount: filtered.connected ? count(shownSessions.length, shownSessions.length) : null,
    homes: renderInstanceGrid(lastHomes),
    usage: renderUsageCard(lastUsage, usageDim, lastUsageKey ?? usagePeriod.key),
    logs: logPanelHtml(),
  });
  dashboardEl.querySelectorAll('[data-instance-details]').forEach((el) => { el.open = openDetails.has(el.dataset.instanceDetails); });
  dashboardEl.querySelectorAll('.pane > .rows, .session-list').forEach((el, i) => { el.scrollTop = scrolls[i] ?? 0; });
  if (SESSION_FILTERS.some(([key]) => key === focusedStatus)) dashboardEl.querySelector(`[data-status-filter="${focusedStatus}"]`)?.focus({ preventScroll: true });
  if (focusedDetails) {
    const details = [...dashboardEl.querySelectorAll('[data-instance-details]')].find((el) => el.dataset.instanceDetails === focusedDetails);
    const target = focusedDetailsAction ? [...(details?.querySelectorAll('button') ?? [])].find((el) => el.dataset.action === focusedDetailsAction) : details?.querySelector('summary');
    target?.focus({ preventScroll: true });
  }
  paintSearchResults();
  fitTrendLabels(dashboardEl); // X 轴标签按实测宽度收边/去重叠（见 usage-card.js）
  logRefresh(); // 日志面板：重绘 + 同步过滤/跟随按钮激活态
  if (showAddForm) {
    dashboardEl.querySelector('section:nth-child(3) h2').insertAdjacentHTML('afterend', renderHomeForm(lastDetected));
    const form = dashboardEl.querySelector('#add-home');
    const restored = restoreFormDraft(form, draft); // 内部会重放模式（显隐/必填）
    applyHomeMode(form, form.mode?.value || 'local');
    // 默认聚焦 homePath 是「表单刚展开」时的便利；但搜索框输入也会走到这里重绘 ——
    // 那时把焦点抢到表单上会让用户敲一个字就跳出搜索框（实测会断掉连续输入）。
    if (!restored && document.activeElement !== searchInput) form.querySelector('input[name=homePath]')?.focus();
  }
  hlProject = null; hlRow = null; hlKind = null; // 刷新后清除残留高亮状态
}

// —— 顶栏搜索：按名字过滤 Recent Projects / Recent Sessions + 全库补搜历史 ——
// 过滤口径只有一处：filterRecent()（components/search-filter.js）；「历史从哪来」只有一处：
// /api/search（store.searchAll）。这里只负责 DOM 状态（清除按钮）与「什么时候重画/请求」。
function syncSearchChrome() {
  if (searchClear) searchClear.hidden = searchQuery === '';
  if (searchScope) {
    searchScope.hidden = !searchScopeProject;
    searchScope.textContent = searchScopeProject ? `项目：${searchScopeProject} ×` : '';
    searchScope.title = searchScopeProject ? `搜索范围：${searchScopeProject}；点击恢复全局搜索` : '';
  }
  searchWrap?.classList.toggle('has-scope', !!searchScopeProject);
}

function paintSearchResults() {
  if (!searchResults) return;
  searchResults.hidden = !searchOpen || !searchKey() || view.kind !== 'dashboard' || !lastHomes.length;
  if (searchResults.hidden) return;
  const html = renderSearchResults({ ...lastSearchResults, pending: fullSearchPending(), failed: searchState.status === 'error',
    scope: searchScopeProject, selectedProject: projectKey(), truncated: !!(fullSearchResult()?.truncated.sessions || fullSearchResult()?.truncated.projects) });
  // SSE 刷新内容不变时不重建节点，保留键盘焦点。
  if (searchResults.innerHTML !== html) {
    const focused = document.activeElement?.closest?.('.search-result');
    const key = focused ? [focused.dataset.action, focused.dataset.homeId, focused.dataset.sessionId, focused.dataset.project] : null;
    searchResults.innerHTML = html;
    if (key) [...searchResults.querySelectorAll('.search-result')].find((el) => [el.dataset.action, el.dataset.homeId, el.dataset.sessionId, el.dataset.project].every((value, i) => value === key[i]))?.focus({ preventScroll: true });
  }
}

function setSearchScope(project) {
  searchScopeProject = typeof project === 'string' && project ? project : null;
  resetSearchState();
  syncSearchChrome();
  scheduleFullSearch();
  paintDashboard();
  searchInput?.focus();
}

// 在途请求作废 + 取消还没发出去的防抖定时器。清空搜索框、切换查询词都要走这里。
function resetSearchState() {
  searchSeq += 1; // 已发出的请求即使回来也会被 seq 挡掉
  if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }
  searchState = { query: '', seq: searchSeq, status: 'idle', projects: [], sessions: [], truncated: { projects: false, sessions: false } };
}

// 每次输入都重新排一次防抖：只有用户停手超过 SEARCH_DEBOUNCE_MS 才真正请求全库。
// 本地过滤不经过这里（输入当帧就生效），全库只是「补历史」的慢路径。
function scheduleFullSearch() {
  if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }
  const key = searchKey();
  if (!key) { resetSearchState(); return; }
  // 立刻切到 loading：本地暂无命中时先画「正在全库检索…」，避免在 200ms 防抖窗口里
  // 先闪一次「没有匹配」再被结果顶掉。真正的请求在定时器到点后才发出。
  searchState = { query: key, seq: searchSeq, status: 'loading', projects: [], sessions: [], truncated: { projects: false, sessions: false } };
  searchTimer = setTimeout(() => {
    searchTimer = null;
    requestFullSearch(key);
  }, SEARCH_DEBOUNCE_MS);
}

function requestFullSearch(key) {
  const seq = ++searchSeq;
  searchState = { query: key, seq, status: 'loading', projects: [], sessions: [], truncated: { projects: false, sessions: false } };
  const params = new URLSearchParams({
    q: key,
    projectLimit: String(SEARCH_PROJECT_LIMIT),
    sessionLimit: String(SEARCH_SESSION_LIMIT),
  });
  // 默认全局搜索；只有显式搜索范围才收窄会话。范围变化先作废旧请求。
  const project = searchScopeProject;
  if (project) params.set('project', project);
  api(`/api/search?${params}`)
    .then((body) => {
      // 只接受「仍是最新一次请求 + 输入框还是同一个词」的响应：连续输入时慢请求会乱序返回。
      if (seq !== searchSeq || key !== searchKey()) return;
      searchState = {
        query: key,
        seq,
        status: 'done',
        projects: Array.isArray(body?.projects) ? body.projects : [],
        sessions: Array.isArray(body?.sessions) ? body.sessions : [],
        truncated: {
          projects: body?.truncated?.projects === true,
          sessions: body?.truncated?.sessions === true,
        },
      };
      if (view.kind === 'dashboard') paintDashboard();
    })
    .catch((error) => {
      if (seq !== searchSeq || key !== searchKey()) return;
      searchState = { query: key, seq, status: 'error', projects: [], sessions: [], truncated: { projects: false, sessions: false } };
      // 全库补搜失败不能让本地过滤一起失效：保留最近列表内的命中，只提示历史部分不可用。
      note.set(`全库搜索失败：${error?.message ?? error}（仅显示最近列表内的匹配）`);
      if (view.kind === 'dashboard') paintDashboard();
    });
}

function setSearchQuery(value, { repaint = true } = {}) {
  const next = String(value ?? '');
  searchQuery = next;
  searchOpen = true;
  // Esc / ✕ 是程序化改值：input 自己不会收到 input 事件，得手动同步。
  if (searchInput && searchInput.value !== next) searchInput.value = next;
  syncSearchChrome();
  // 输入法组合期间不触发全库请求：拼音中间态（如 "gpp"）既不是用户要搜的词，也会白打
  // 一次全表扫描；compositionend 会以最终文本再排一次（那里 searchComposing 已复位）。
  if (!searchComposing) scheduleFullSearch();
  // 输入法组合中不重画（见下面的 compositionend）：值可能没变，所以这里不因「没变」而跳过。
  if (repaint && view.kind === 'dashboard' && lastHomes.length) paintDashboard();
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
  if (pane.url) {
    const origin = new URL(pane.url).origin;
    iframe.contentWindow?.postMessage({ type: 'hwb:preview-init' }, origin);
    // 主题要**随 load 一起下发**：注入脚本 dep 上只有「宿主主动告知」这一条来源，
    // 一个刚挂载的 iframe 若没收到第一条消息，就会用 dsh 自己 settings 里的（可能过时的）
    // 偏好去渲染首帧 —— 暗色下表现为闪一下亮色。
    iframe.contentWindow?.postMessage({ type: 'hwb:theme-init', preference: currentThemeMode() }, origin);
  }
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
  pane.el.remove();
  panes.delete(homeId);
  frameOrder = frameOrder.filter((id) => id !== homeId);
}

// 释放一个面板的 iframe：**只拆 iframe**，标签页、入口 URL、会话 id 全部保留。
// 这是超预算时的动作（见 frame-budget.js 与 enforceFrameBudget）——留着 iframe 的代价是一整个
// dsh web SPA 常驻内存（实测单个可达数百 MB），而重新进入的代价只是一次重载（有 session 深链时
// 还回到同一个会话）。故意不复位 _cookieReady：cookie 属于浏览器不属于 iframe，重新挂载时
// 仍然是「已认证」状态，深链可以一次直达（见 instance-navigation.planPaneNavigation）。
function releasePaneFrame(homeId) {
  const pane = panes.get(homeId);
  if (!pane?.iframe) return;
  pane.iframe.remove();        // 真正的回收点：iframe 一离开文档，它的 SPA/文档/JSScript 都能被回收
  pane.iframe = null;
  pane._iframed = false;
  pane._navTarget = null;
  pane._navStep = 0;
  pane.released = true;        // 供标签页提示与排查用（重新挂载时清掉）
  const cover = pane.el.querySelector('.frame-cover');
  if (cover) cover.hidden = true;
  // 占位文案复位：mountPane 会把它移除后再挂 iframe，于是「重新进入」看见的是加载态而不是白板。
  if (!pane.el.querySelector('.frame-loading')) {
    pane.el.insertAdjacentHTML('afterbegin', '<div class="frame-loading">连接 dsh web…（已释放内存，重新加载中）</div>');
  }
  frameOrder = frameOrder.filter((id) => id !== homeId);
  frameReleased++;
}

// 预算执行：只保留最近使用的 MAX_LIVE_FRAMES 个 iframe，其余释放。
// 正在看的那个永不释放（否则当前页面会白屏），因此 keep 由 view 决定。
function enforceFrameBudget() {
  const live = frameOrder.filter((id) => panes.get(id)?.iframe);
  const activeId = view.kind === 'instance' ? view.homeId : null;
  for (const id of planFrameEviction(live, { limit: MAX_LIVE_FRAMES, keep: [activeId] })) releasePaneFrame(id);
}

// 排查/测量钩子：控制台里 `__hwbFrameBudget()` 直接看到当前预算与活跃 iframe 数
// （scripts/memory-check.mjs 也读它做断言）。只读，不暴露任何可变状态。
window.__hwbFrameBudget = () => ({
  limit: MAX_LIVE_FRAMES,
  live: frameOrder.filter((id) => panes.get(id)?.iframe).length,
  order: [...frameOrder],
  released: frameReleased,
});

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
    pane.released = false;
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

  // 这个面板是「刚用过」的：记账 + 立刻执行预算（挂载本身就把活跃数推高了一个）。
  frameOrder = touchFrameOrder(frameOrder, homeId);
  enforceFrameBudget();
}

// 打开本地工具实例（Codex / WorkBuddy / 本地 dsh 只读）统一走 POST /api/harness/open。
//
// 这是服务端的进程外动作（`open "codex://…"` / `open "workbuddy://…"` / 插件信使）：
// 服务端负责「打开哪个工具、落到哪条会话」，无会话或插件缺失时退化为聚焦/启动 App
// （返回 code='app-focused'）。前端不再按 harness 分叉（此前 Codex 走 /api/codex/open、
// dsh 只读走 /api/homes/{id}/open-session，两条路两套错误提示）。
// 按钮/行做防连点，失败一律落到粘性 note（不静默）。
async function openLocalTool(home, { sessionId = null, workspaceId = null } = {}, btn = null) {
  if (!home) return null;
  if (btn?.dataset.busy === '1') return null;
  if (btn) { btn.dataset.busy = '1'; btn.disabled = true; }
  const label = localToolLabel(home);
  try {
    const body = { homeId: home.homeId };
    if (sessionId) body.sessionId = sessionId;
    if (workspaceId) body.projectId = workspaceId;
    const result = await api('/api/harness/open', { method: 'POST', body });
    // app-focused：无会话 / 插件缺失时服务端把桌面端叫到前台，note 是它给出的解释。
    // fallback：非 macOS 等场景下服务端只能返回可复制的深链命令，一并展示。
    const base = result?.code === 'app-focused'
      ? (result.note || `已聚焦 ${label} 应用`)
      : (result?.warning || `已在 ${label} 中打开`);
    note.set(result?.fallback ? `${base}（可手动执行：${result.fallback}）` : base);
    return result;
  } catch (error) {
    // 502（无法唤起）/ 400（非法会话 id）/ 404（实例已不存在）都要让用户看见；
    // 带 fallback 手动命令或安装指引时一并给出 —— 这是用户唯一可操作的出路。
    const extra = error?.detail?.fallback || error?.detail?.install;
    note.set(`打开 ${label} 失败：${error.message}${extra ? `（${extra}）` : ''}`, { sticky: true });
    return null;
  } finally {
    if (btn) { delete btn.dataset.busy; btn.disabled = false; }
  }
}

// 本地 dsh 的「像 Codex 一样在 App 里打开会话」：
// 走服务端 open-session → 写触发器 → 已装 dsh-hwb-open-session 插件的 DSH 桌面端切过去。
// 插件没装/平台不支持/没有会话 id 时返回 false，调用方回退到原来的内嵌 iframe（不破坏 Web 形态）。
async function tryOpenDshSession(home, btn) {
  const sessionId = btn?.dataset.sessionId || '';
  if (sessionId === '') return false;
  if (btn?.dataset.busy === '1') return true; // 防连点：视为已处理
  if (btn) btn.dataset.busy = '1';
  try {
    const result = await api(`/api/homes/${home.homeId}/open-session`, { method: 'POST', body: { sessionId } });
    note.set(result?.warning || '已在 DSH 中打开该会话');
    return true;
  } catch (error) {
    // 只有「插件缺失」值得提示安装；其余（App 不在、平台不支持、会话失效）静默回退，
    // 避免每次点击都弹一条用户无法处理的错误。
    if (error?.code === 'plugin-missing') {
      const install = error?.detail?.install ? `安装：${error.detail.install}` : '安装方式见 dsh-hwb-open-session/README.md';
      note.set(`未安装 dsh-hwb-open-session 插件，已回退内嵌打开。${install}`, { sticky: true });
    }
    return false;
  } finally {
    if (btn) delete btn.dataset.busy;
  }
}

async function enterInstance(homeId, extra = {}) {
  // 本地工具实例（Codex / WorkBuddy / 本地 dsh 只读）没有 dsh web 页面：
  // 任何「进入实例」都统一转成一次工具跳转（含旧书签/恢复路径）。
  const targetHome = lastHomes.find((h) => h.homeId === homeId);
  if (isLocalToolHome(targetHome)) {
    await openLocalTool(targetHome, { sessionId: extra.sessionId, workspaceId: extra.workspaceId });
    return;
  }
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
    pane.popoutUrl = inst.externalUrl || inst.url; // 稳定入口：远程实例 = 已保存的接入端口
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
  const el = form?.querySelector('.form-msg');
  if (!el) return; // 表单可能已被 SSE 重建并脱离文档，调用方另有粘性提示兜底
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
  // 本地工具实例（Codex / WorkBuddy / 本地 dsh 只读）没有进程可重启/停止，操作面只剩「重新索引 / 移除」。
  const isReadOnly = isLocalToolHome(home);
  modalEl.innerHTML = `
    <div class="modal-card">
      <h3>编辑实例：${esc(home.alias || home.homePath || homeId)}</h3>
      ${renderSettingsForm(home)}
      <div class="meta actions">
        ${isReadOnly ? '' : `<button data-action="restart" data-home-id="${esc(homeId)}">重启实例</button>
        <button data-action="stop" data-home-id="${esc(homeId)}">停止实例</button>`}
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
  // 本地工具实例：只改别名与 home 路径，没有端点/token/端口字段可读。
  if (isLocalToolHome(home)) {
    await api(`/api/homes/${homeId}`, {
      method: 'PUT',
      body: { alias: form.alias.value.trim(), homePath: form.homePath.value.trim() },
    });
    dropUsageCache();
    closeModal();
    await refresh();
    return;
  }
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

async function addHome({ homePath, alias, harness = 'dsh', readOnly = false, hostType = 'local', host, remotePort, remoteHome, remoteCmd, remoteLog, token, localPort, accessPort }, form) {
  // 本地工具 harness（codex / workbuddy）：只带路径/别名，没有 host/端口/token。
  // 本地 dsh 只读实例：harness 仍是 dsh，只多一个 readOnly 标记；与可连接实例可并存。
  const localTool = harness === 'codex' || harness === 'workbuddy';
  const body = localTool
    ? { harness, homePath, alias }
    : readOnly
      ? { harness: 'dsh', homePath, alias, readOnly: true }
      : hostType === 'remote'
        ? { hostType, host, remotePort, remoteHome: remoteHome || undefined, remoteCmd, remoteLog, token: token || undefined, alias }
        : { homePath, alias, localPort: localPort || undefined, token: token || undefined };
  if (!localTool && hostType === 'remote' && accessPort !== undefined) body.accessPort = accessPort;
  const data = await api('/api/homes', { method: 'POST', body });
  // 前后端版本错位的逃生提示：旧后端不认识这个 harness，会把路径当 dsh 处理。
  // 正常情况下这条不会触发（服务端回 400 更早），但升级中途的混合状态值得给一句明确的话。
  if (localTool && data?.harness !== harness) {
    throw new Error(`当前 hwb 后端还不支持 ${localToolLabel({ harness })} 实例，请先重启 hwb 再试`);
  }
  // warning 必须挂在**持久**的 #note 上：紧接着的 showAddForm = false; refresh() 会重建整个
  // dashboard 的 innerHTML（表单只在 showAddForm 为真时才重新插入），写进表单的消息会被直接抹掉
  // —— 服务端明明回了「这个目录看起来不像 dsh home」，用户一个字都看不到。
  const warning = form && data.warning ? data.warning : null;
  showAddForm = false;
  dropUsageCache();   // 新实例可能立刻带来一批历史会话，别让「按实例」图滞后 15s
  await refresh();
  if (localTool || readOnly) {
    // 新卡片排在 Instances 列表末尾、且表单会立刻消失：滚动到它并闪一下。
    // 注意 dashboard 紧接着会被 monitor 的 SSE 刷新重建，所以要按「可能已被替换」重试几次。
    // 三种本地工具卡的身份 chip 都是 .chip.harness-<codex|workbuddy|dsh>。
    const chipSelector = `.chip.harness-${localTool ? harness : 'dsh'}`;
    const reveal = (attempt = 0) => {
      const card = dashboardEl.querySelector(chipSelector)?.closest('.row');
      if (card) {
        card.scrollIntoView({ block: 'nearest' });
        card.classList.add('hl-project');
        setTimeout(() => card.classList.remove('hl-project'), 2000);
      } else if (attempt < 3) {
        setTimeout(() => reveal(attempt + 1), 400);
      }
    };
    reveal();
  }
  if (warning) {
    // 粘性：这类提示描述的是「需要你处理的事实」，不是「刚刚那一轮刷新失败了」，
    // 所以刷新与重连都不该把它撤掉（用户处理完之后再刷新页面即可）。
    note.set(`已添加，但注意：${warning}`, { sticky: true });
  } else if (localTool || readOnly) {
    // 添加成功后表单立即消失、卡片排在列表末尾：给一句明确的成功反馈。
    // 用粘性 + 6s 定时清除：普通 note 会被紧接着的 SSE 刷新立刻清掉（实测 3s 内就没），
    // 而长期粘住又会挡住后续真实错误，所以只留几秒。
    note.set(localTool
      ? `已添加 ${localToolLabel({ harness })} 实例：项目与会话已汇总到 Recent Projects / Sessions`
      : '已添加只读 dsh 实例：不需要连接/token；点会话会交给 DSH 桌面端打开', { sticky: true });
    setTimeout(() => note.clear(), 6000);
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
      case 'clear-search':
        // 空态里的「清除搜索」：清空后把焦点放回搜索框，方便接着换一个词。
        setSearchQuery('');
        searchInput?.focus();
        break;
      case 'filter-session-status':
        if (SESSION_FILTERS.some(([key]) => key === btn.dataset.statusFilter)) {
          sessionStatusFilter = btn.dataset.statusFilter;
          paintDashboard();
        }
        break;
      case 'scope-search':
        setSearchScope(btn.dataset.project);
        break;
      case 'clear-search-scope':
        setSearchScope(null);
        break;
      case 'search-project':
        // 搜索结果中的项目进入普通项目视图；退出搜索，避免项目名继续过滤会话标题。
        setSearchQuery('');
        searchScopeProject = null;
        syncSearchChrome();
        searchOpen = false;
        setProjectFilter({ project: btn.dataset.project, homeId: btn.dataset.homeId, sessionId: btn.dataset.sessionId, workspaceId: btn.dataset.workspaceId });
        paintDashboard();
        break;
      case 'filter-project': {
        // 项目卡的唯一动作：把 Sessions 栏筛到这个项目（不再直接跳转实例）。
        // 再点一次同一个项目 = 取消筛选；「打开项目」仍由筛选条里的按钮提供。
        const project = btn.dataset.project;
        if (!project) break;
        const wasSearching = !!searchKey();
        searchScopeProject = null;
        syncSearchChrome();
        if (wasSearching) { setSearchQuery(''); searchOpen = false; }
        if (projectKey() === project && !wasSearching) {
          setProjectFilter(null);
        } else {
          setProjectFilter({
            project,
            homeId: btn.dataset.homeId || null,
            sessionId: btn.dataset.sessionId || null,
            workspaceId: btn.dataset.workspaceId || null,
          });
        }
        break;
      }
      case 'clear-project-filter':
        searchScopeProject = null;
        syncSearchChrome();
        setProjectFilter(null);
        break;
      case 'toggle-mute-project': {
        // 默认静音开关（项目卡上的「隐藏 / 已隐藏」或筛选条里的「默认隐藏 / 取消默认隐藏」）。
        // 持久化到 localStorage，刷新后仍生效。
        const project = btn.dataset.project;
        if (!project) break;
        const wasMuted = mutedProjects.includes(project);
        mutedProjects = toggleMutedProject(mutedProjects, project);
        writeMutedProjects(browserStorage, mutedProjects);
        if (wasMuted) {
          flashNote(`已恢复显示「${project}」的会话（关闭了默认静音）`);
          paintDashboard();
          break;
        }
        // 刚点了「隐藏」却还处于「显示已隐藏」临时态，会看起来像没生效 —— 顺手收回临时态。
        showMutedSessions = false;
        // 在**该项目的筛选视图**里点隐藏：显式视图按定义会显示它的全部会话，停在这里会看起来
        // 完全没生效。回到默认视图，让「会话消失 + 底部说明 + 卡片已隐藏」立刻可见。
        if (projectFilter?.project === project) {
          setProjectFilter(null);
          flashNote(`已默认隐藏「${project}」的会话；Recent Sessions 底部可临时「显示」`);
          break;
        }
        paintDashboard();
        flashNote(`已默认隐藏「${project}」的会话；Recent Sessions 底部可临时「显示」`);
        break;
      }
      case 'reset-muted-projects':
        // 「默认静音已关闭（…）· 恢复默认静音」：把内置默认列表装回来（用户误点取消隐藏后的出路）。
        mutedProjects = [...DEFAULT_MUTED_PROJECTS];
        writeMutedProjects(browserStorage, mutedProjects);
        showMutedSessions = false;
        paintDashboard();
        break;
      case 'show-muted-sessions':
        showMutedSessions = true;
        paintDashboard();
        break;
      case 'hide-muted-sessions':
        showMutedSessions = false;
        paintDashboard();
        break;
      case 'nav-instance':
        await enterInstance(btn.dataset.homeId);
        break;
      case 'drill-in': {
        const home = lastHomes.find((h) => h.homeId === btn.dataset.homeId);
        // 本地工具没有 iframe 页面：项目行 / 会话行统一交给 /api/harness/open
        // （项目 → 该项目最近会话，会话 → 自身；无会话时聚焦工具）。
        if (isLocalToolHome(home)) {
          await openLocalTool(home, {
            sessionId: btn.dataset.sessionId || null,
            workspaceId: btn.dataset.workspaceId || null,
          }, btn);
          break;
        }
        // 可连接的本地 dsh：先尝试交给 DSH 桌面端（插件信使），插件不可用时回退 iframe。
        if (home?.harness === 'dsh' && home?.hostType === 'local') {
          const opened = await tryOpenDshSession(home, btn);
          if (opened) break;
        }
        await enterInstance(btn.dataset.homeId, {
          sessionId: btn.dataset.sessionId || null,
          sessionTitle: btn.dataset.title || null,
          project: btn.dataset.project || null,
        });
        break;
      }
      case 'local-tool-open': {
        const home = lastHomes.find((h) => h.homeId === btn.dataset.homeId);
        await openLocalTool(home, {}, btn);
        break;
      }
      case 'popout':
        window.open(btn.dataset.url, '_blank');
        break;
      case 'toggle-add-form':
        showAddForm = !showAddForm;
        await refresh();
        break;
      case 'add-detected': {
        // data-harness 只允许白名单值（codex / workbuddy）；dsh 只读走 readOnly 标记。
        const detectedHarness = btn.dataset.harness === 'codex' || btn.dataset.harness === 'workbuddy'
          ? btn.dataset.harness
          : 'dsh';
        await addHome({
          homePath: btn.dataset.path,
          harness: detectedHarness,
          readOnly: btn.dataset.readonly === 'true',
        });
        break;
      }
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
const ACTIVATABLE = new Set(['drill-in', 'filter-project', 'nav-instance', 'nav-dashboard']);
document.body.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const el = e.target.closest?.('[data-action]');
  if (!el || !ACTIVATABLE.has(el.dataset.action)) return;
  if (e.target !== el) return; // 只处理「焦点就在这个可激活元素上」，不劫持内部控件的按键
  // 原生 <button> 自己会把 Enter/Space 变成 click（筛选条里的「打开项目」「✕」）；
  // 这里再调一次 handleAction 就会双触发（打开两次 / 筛选闪两下），所以跳过按钮。
  if (el.tagName === 'BUTTON') return;
  e.preventDefault(); // Space 默认会滚动页面
  handleAction({ target: el });
});

// —— 顶栏搜索的输入事件 ——
// input 事件驱动本地过滤，不 debounce：列表最多 20 + 50 行，字符串比较 + 重绘远低于一次
// 网络往返，加延迟只会让「敲字 → 列表变化」显得卡。
// 中文/日文输入法的组合过程（compositionstart → end）里敲的是拼音字母、不是最终词：
// 若每一步都拿去过滤，列表会在「筛空 → 恢复」之间反复闪；所以组合期间只更新状态与
// 清除按钮，compositionend 再真正过滤。
let searchComposing = false;
searchInput?.addEventListener('compositionstart', () => { searchComposing = true; });
searchInput?.addEventListener('compositionend', (e) => {
  searchComposing = false;
  setSearchQuery(e.target.value);
});
searchInput?.addEventListener('input', (e) => {
  setSearchQuery(e.target.value, { repaint: !searchComposing });
});
// type=search 的原生清除（部分浏览器）走 search 事件：统一同步状态。
searchInput?.addEventListener('search', (e) => setSearchQuery(e.target.value));
searchWrap?.addEventListener('focusin', () => { searchOpen = true; paintSearchResults(); });
searchWrap?.addEventListener('focusout', (e) => {
  if (!searchWrap.contains(e.relatedTarget)) { searchOpen = false; paintSearchResults(); }
});
document.addEventListener('click', (e) => {
  if (!searchWrap?.contains(e.target)) { searchOpen = false; paintSearchResults(); }
});
searchResults?.addEventListener('keydown', (e) => {
  if (e.isComposing) return;
  if (e.key === 'Escape') { e.preventDefault(); searchInput?.focus(); searchOpen = false; paintSearchResults(); return; }
  if (!['ArrowDown', 'ArrowUp'].includes(e.key)) return;
  const buttons = [...searchResults.querySelectorAll('button')];
  const index = buttons.indexOf(document.activeElement);
  e.preventDefault();
  const next = index + (e.key === 'ArrowDown' ? 1 : -1);
  if (next < 0 || next >= buttons.length) searchInput?.focus();
  else buttons[next].focus();
});
searchInput?.addEventListener('keydown', (e) => {
  if (e.isComposing) return;
  if (e.key === 'ArrowDown' && searchKey()) {
    e.preventDefault(); searchOpen = true; paintSearchResults(); searchResults?.querySelector('button')?.focus(); return;
  }
  if (e.key !== 'Escape') return;
  // Esc 语义：有内容 → 清空（仍留在搜索框里）；已清空 → 失焦，把键盘交回页面。
  if (searchQuery !== '') { e.preventDefault(); setSearchQuery(''); return; }
  searchInput.blur();
});
// ⌘/Ctrl+K 与 / 聚焦工作台搜索；输入框内的普通 / 保留输入语义。
document.addEventListener('keydown', (e) => {
  if (e.isComposing || e.altKey) return;
  const shortcut = e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey);
  if (!shortcut && (e.key !== '/' || e.metaKey || e.ctrlKey)) return;
  const target = e.target;
  if (!shortcut && target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
  if (view.kind !== 'dashboard' || !searchInput || searchWrap?.hidden) return;
  if (!modalEl.hidden) return; // 设置弹层里按「/」不该把焦点抢到背后的搜索框
  e.preventDefault();
  searchInput.focus();
  searchInput.select();
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
//
// 主题有两个消费者：① hwb 自己的界面（localStorage + data-theme）；② 各 dsh 实例
// （下发到它的 settings.yaml + 注入脚本即时换肤）。两者的关系是**单向**的：
// hwb 是权威，dsh 跟随。所以主题值的来源仍是 hwb 的 localStorage（本地即时、无网络往返），
// 每次变更都顺带 POST /api/theme 把同一个值推给服务端，由服务端分发给已连接的实例。
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
  broadcastThemeToFrames(mode);   // 已打开的 dsh 页面立刻换肤（不等 settings 热重载）
  if (themeSyncEnabled()) syncThemeToInstances(mode);   // 落盘到各实例，重启/重开页面后依然一致
}
// 主题切换后重绘工作台：chip 配色为内联样式，深浅两套调色板需重渲染才能切换
function rerenderForTheme() {
  if (view.kind === 'dashboard' && lastHomes.length) renderDashboard();
}

// —— 主题下发（hwb → dsh）——

// 同步开关（默认开）。关掉后 hwb 只改自己的界面，不再动任何实例的 settings.yaml ——
// 给「我就是想让两边不一样」留一个出口，而不是把功能做成不可关的副作用。
const THEME_SYNC_KEY = 'hwb:theme-sync';
function themeSyncEnabled() {
  try { return localStorage.getItem(THEME_SYNC_KEY) !== '0'; } catch { return true; }
}
function setThemeSyncEnabled(on) {
  try { localStorage.setItem(THEME_SYNC_KEY, on ? '1' : '0'); } catch { /* 同上 */ }
  const btn = document.getElementById('theme-sync');
  if (btn) btn.setAttribute('aria-checked', on ? 'true' : 'false');
}

// 把主题 postMessage 给**每一个已挂载**的 iframe。
// 为什么广播给全部而不只是当前可见的那个：切走只 hidden，iframe 还活着（见下文的 iframe 预算），
// 用户切回来时不该看到它还是旧主题。
function broadcastThemeToFrames(mode) {
  for (const pane of panes.values()) {
    if (!pane.url || !pane.iframe?.contentWindow) continue;
    try {
      pane.iframe.contentWindow.postMessage({ type: 'hwb:theme', preference: mode }, new URL(pane.url).origin);
    } catch { /* 入口 URL 不可解析时跳过这一个 */ }
  }
}

// 落盘到各实例。**不 await、不阻塞界面**：主题切换必须瞬时，写盘（远程还要走 ssh）是副作用。
// 失败时会话里给一条普通提示 —— 但只在真的失败时提示，成功是常态、不该打扰。
function syncThemeToInstances(mode) {
  api('/api/theme', { method: 'POST', body: { preference: mode } })
    .then((result) => {
      if (result.failed) {
        const names = result.results.filter((r) => !r.ok).map((r) => r.alias || r.homeId.slice(0, 6)).join('、');
        note.set(`主题已切换，但有 ${result.failed} 个实例同步失败（${names}）——重新连接后会补齐`);
      } else if (result.synced) {
        note.clearUnlessSticky();
      }
    })
    .catch((error) => {
      // 服务端不可达（hwb 重启中）不算致命：hwb 自己的主题已经切了，实例等下次连接时补齐。
      console.warn('主题下发失败:', error.message);
    });
}

function closeThemeMenu() { if (themeMenu) themeMenu.hidden = true; }
function toggleThemeMenu() { if (themeMenu) themeMenu.hidden = !themeMenu.hidden; }
themeBtn?.addEventListener('click', (e) => { e.stopPropagation(); toggleThemeMenu(); });
themeMenu?.addEventListener('click', (e) => {
  const item = e.target.closest('.menu-item[data-mode]');
  // 同步开关：切换后**不关菜单**（开关是设置项，不是「选完即走」的动作），
  // 并且立即把当前主题补推一次 —— 用户打开同步的意图通常就是「让 dsh 也变成现在这样」。
  const sync = e.target.closest('#theme-sync');
  if (sync) {
    const next = !themeSyncEnabled();
    setThemeSyncEnabled(next);
    if (next) syncThemeToInstances(currentThemeMode());
    return;
  }
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
  mq.addEventListener?.('change', () => {
    if (currentThemeMode() !== 'system') return;
    applyTheme('system');
    rerenderForTheme();
    // 系统亮暗翻转时**不重写 settings.yaml**：偏好值仍是 `system`（没有变化），
    // 变的是解析结果。已打开的 dsh 页面由注入脚本自己的 media query 跟随，
    // 无需从这边推 —— 两边解析同一个查询，结果必然一致。
  });
})();

// 初始化同步开关的选中态（localStorage 是唯一来源，与主题值同样的存法）。
setThemeSyncEnabled(themeSyncEnabled());

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
  const submitBtn = form.querySelector('button[type=submit]');
  const submitLabel = submitBtn?.textContent;
  // 添加要等一次索引（Codex 本机 2k+ 会话约 1s）：没有 loading 时按钮看起来「点了没反应」。
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = '添加中…'; }
  try {
    if (form.mode.value === 'codex' || form.mode.value === 'workbuddy') {
      await addHome({
        harness: form.mode.value,
        homePath: form.homePath.value.trim() || undefined,
        alias,
      }, form);
    } else if (form.mode.value === 'local-readonly') {
      await addHome({
        readOnly: true,
        homePath: form.homePath.value.trim(),
        alias,
      }, form);
    } else if (form.mode.value === 'remote') {
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
    // 两条通道都写：表单可能已被这一轮的 SSE 重建（旧节点脱离文档，消息谁看不见）；
    // 粘性 note 挂在 dashboard 之外，跨刷新存活，能把「为什么添加失败」留给用户。
    formMsg(form, err.message, true);
    note.set(`添加实例失败：${err.message}`, { sticky: true });
  } finally {
    if (submitBtn?.isConnected) {
      submitBtn.disabled = false;
      submitBtn.textContent = submitLabel;
    }
  }
});

// 原生校验（required / type=number）不触发 submit 事件，只在字段上弹一个短暂的浏览器气泡：
// 用户点「添加」看起来就是「没反应」。这里把校验信息落到表单里，给出可见反馈。
main.addEventListener('invalid', (e) => {
  const form = e.target.closest?.('#add-home');
  if (!form) return;
  const label = e.target.placeholder || e.target.name || '必填项';
  const text = e.target.validity?.valueMissing ? `请填写「${label}」` : (e.target.validationMessage || '请检查表单');
  setTimeout(() => formMsg(form, text, true), 0);
}, true);

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
  applyHomeMode(form, form.mode?.value || 'local');
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
