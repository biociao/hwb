import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// 「点 Recent Projects 的一行 → Recent Sessions 只列该项目的会话」的前端接线。
//
// 分工：数据层在 store / API（tests/store-project-sessions.test.js、
// tests/api-project-sessions.test.js），这里只锁 ① 组件产出的 DOM 契约（动作名、选中态、
// 转义）与 ② app.js 的接线（点击→状态→请求→重绘、清除、与搜索的叠加、键盘可达性）。
globalThis.document = {
  documentElement: { dataset: { theme: 'light' } },
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
};
globalThis.window = { matchMedia: () => ({ matches: false }) };

const { renderRecentProjects } = await import('../src/web/components/recent-projects.js');
const { renderRecentSessions, renderSessionFilter } = await import('../src/web/components/recent-sessions.js');
const { renderWorkbench } = await import('../src/web/components/workbench.js');
const appJs = await readFile(new URL('../src/web/app.js', import.meta.url), 'utf8');
const indexHtml = await readFile(new URL('../src/web/index.html', import.meta.url), 'utf8');

const EVIL = 'x"><img src=x onerror=alert(1)>';
const INJECTED_TAG = /<(?:img|script|svg|iframe|object|embed|body|style|link)\b/i;

const project = (extra = {}) => ({
  homeId: 'abcdef1234567890', workspaceId: 'w1', project: 'PMAID-GPPH',
  sessionId: '01a1669a-4aed-74c0-8f45-945379c56e0d', lastActivity: null,
  sessionCount: 7, inputTokens: 100, outputTokens: 10, ...extra,
});
const session = (extra = {}) => ({
  homeId: 'abcdef1234567890', sessionId: 's1', title: 'GPPH 会话', project: 'PMAID-GPPH',
  lastActivity: null, status: { kind: 'idle', label: '空闲', subagents: 0 }, ...extra,
});

// —— 组件：项目卡变成筛选开关 ——

test('项目卡：动作是 filter-project（不再直接 drill-in），带开关语义与选中态', () => {
  const plain = renderRecentProjects([project()]);
  assert.match(plain, /data-action="filter-project"/);
  assert.doesNotMatch(plain, /data-action="drill-in"/, '项目卡点击不再直接跳转实例');
  assert.match(plain, /role="button"/);
  assert.match(plain, /tabindex="0"/);
  assert.match(plain, /aria-pressed="false"/);
  assert.match(plain, /title="数据来源：[^"]* · 点击筛选该项目会话"/);
  assert.doesNotMatch(plain, /project-card selected/);

  const selected = renderRecentProjects([project()], [], { selectedProject: 'PMAID-GPPH' });
  assert.match(selected, /class="row clickable card project-card selected"/);
  assert.match(selected, /aria-pressed="true"/);
  assert.match(selected, /title="数据来源：[^"]* · 再次点击取消筛选，回到最近会话"/);

  const other = renderRecentProjects([project({ project: '另一个项目' })], [], { selectedProject: 'PMAID-GPPH' });
  assert.match(other, /aria-pressed="false"/, '只有被选中的那张卡是按下态');
});

test('项目卡：项目名进 title / data-* 前必须转义（索引元数据是不可信输入）', () => {
  const html = renderRecentProjects([project({ project: EVIL, workspaceId: EVIL, sessionId: EVIL })], [], { selectedProject: EVIL });
  assert.doesNotMatch(html, INJECTED_TAG);
  assert.match(html, /&lt;img/);
  assert.match(html, /data-action="filter-project"/);
});

// —— 组件：筛选条 ——

test('筛选条：项目名、条数、✕ 与「打开项目」按钮', () => {
  const html = renderSessionFilter({
    project: 'PMAID-GPPH',
    homeId: 'abcdef1234567890',
    sessionId: '01a1669a',
    workspaceId: 'w1',
    count: 7,
  });
  assert.match(html, /class="pane-filter"/);
  assert.match(html, /项目筛选/);
  assert.match(html, /class="filter-project"[^>]*>PMAID-GPPH</);
  assert.match(html, /class="filter-count"[^>]*>7 条</);
  assert.match(html, /data-action="clear-project-filter"/, '✕ 必须能被 body 上的委托 click 处理器识别');
  // 原来的「点项目卡打开实例」能力保留在筛选条里，语义仍是 drill-in。
  assert.match(html, /data-action="drill-in"/);
  assert.match(html, /data-home-id="abcdef1234567890"/);
  assert.match(html, /data-session-id="01a1669a"/);
  assert.match(html, /data-workspace-id="w1"/);
  assert.match(html, /data-project="PMAID-GPPH"/);
  assert.match(html, /打开项目/);
});

test('筛选条：没有 homeId 时不画「打开项目」（没有可解析的目标）；名字与计数转义/夹取', () => {
  const noHome = renderSessionFilter({ project: 'PMAID-GPPH', count: 0 });
  assert.doesNotMatch(noHome, /data-action="drill-in"/);
  assert.match(noHome, /0 条/);

  const evil = renderSessionFilter({ project: EVIL, homeId: EVIL, sessionId: EVIL, workspaceId: EVIL, count: 3 });
  assert.doesNotMatch(evil, INJECTED_TAG);
  assert.match(evil, /&lt;img/);
  // 完整项目名放 title：长项目名在窄栏里会被省略号截断，悬停仍可读全。
  assert.match(evil, /class="filter-project" title="[^"]*&lt;img/);
});

// —— 分区头插槽 ——

test('workbench：sessionFilter 插在 Sessions 分区头与列表之间（列表滚动时筛选条不滚走）', () => {
  const html = renderWorkbench({
    projects: '<div class="rows">P</div>',
    sessions: '<div class="rows">S</div>',
    homes: '', usage: '', logs: '',
    sessionFilter: '<div class="pane-filter">F</div>',
  });
  const sessionsSection = html.slice(html.indexOf('pane-sessions'));
  const h2End = sessionsSection.indexOf('</h2>');
  const filterAt = sessionsSection.indexOf('class="pane-filter"');
  const rowsAt = sessionsSection.indexOf('class="rows"');
  assert.ok(h2End > 0 && filterAt > h2End, '筛选条在分区头之后');
  assert.ok(rowsAt > filterAt, '筛选条在列表之前（不在 .rows 滚动区里）');

  const none = renderWorkbench({ projects: '', sessions: '', homes: '', usage: '', logs: '' });
  assert.doesNotMatch(none, /pane-filter/, '未筛选时不留空条');
});

// —— app.js 接线 ——

test('app.js：点击项目只设置筛选状态，不再调用 enterInstance/打开工具', () => {
  assert.match(appJs, /case 'filter-project': \{/);
  assert.match(appJs, /if \(projectKey\(\) === project && !wasSearching\) \{[\s\S]{0,80}setProjectFilter\(null\);/,
    '再点一次同一个项目 = 取消筛选');
  // filter-project 分支里不得出现跳转调用（否则又变回点击即跳）。
  const branch = appJs.slice(appJs.indexOf("case 'filter-project': {"), appJs.indexOf("case 'clear-project-filter':"));
  assert.doesNotMatch(branch, /enterInstance|openLocalTool|tryOpenDshSession/);
  assert.match(appJs, /case 'clear-project-filter':[\s\S]{0,100}setProjectFilter\(null\);/);
});

test('app.js：按项目拉会话（精确 project 参数 + 独立 limit），且与全局最近 50 条分开保存', () => {
  assert.match(appJs, /const PROJECT_SESSION_LIMIT = 200;/);
  assert.match(appJs, /function projectSessionsUrl\(project\) \{[\s\S]*?new URLSearchParams\(\{ project, limit: String\(PROJECT_SESSION_LIMIT\) \}\)/);
  assert.match(appJs, /project \? api\(projectSessionsUrl\(project\)\) : Promise\.resolve\(null\)/,
    '筛选时多拉一份「该项目的会话」，全局最近会话仍然照拉（清筛选时立刻能画）');
  assert.match(appJs, /let projectSessions = \{ project: null, status: 'idle', sessions: \[\], truncated: false \}/);
  assert.match(appJs, /if \(projectSessionsRes\.status === 'fulfilled'\) \{/);
  assert.match(appJs, /status: 'error'/, '项目会话拉取失败要能画出错误态，而不是伪装成「没有会话」');
  assert.match(appJs, /lastLists = \{ projects, sessions, connectedIds \}/, '全局最近会话的生命周期不变');
  // 筛选切换时旧数据必须作废：新项目还没回来之前显示 loading，不拿上一批顶替。
  assert.match(appJs, /status: 'loading', sessions: \[\], truncated: false/);
});

test('app.js：paintDashboard 使用项目会话作为 Sessions 栏数据源，并把选中项目传给项目卡', () => {
  assert.match(appJs, /const proj = project \? \(projectSessions\.project === project \? projectSessions : null\) : null;/);
  assert.match(appJs, /const baseSessions = project \? \(searching \? filterExactProject\(sessions, project\) : projSessions\) : sessions;/);
  assert.match(appJs, /renderRecentProjects\(filtered\.projects, lastHomes, \{ selectedProject: searching \? null : project, mutedProjects, showHiddenProjects \}\)/);
  assert.match(appJs, /renderSessionFilter\(\{/);
  assert.match(appJs, /sessionFilter,/);
  assert.match(appJs, /正在筛出「\$\{esc\(project\)\}」的会话…/, '切换瞬间要给出加载态');
  assert.match(appJs, /「\$\{esc\(project\)\}」还没有已索引的会话/, '空态要说清是「项目没有会话」');
});

test('app.js：默认全局搜索，显式项目范围才带 project；范围变化作废旧补搜结果', () => {
  assert.match(appJs, /const project = searching \? searchScopeProject : projectKey\(\);/);
  assert.match(appJs, /const project = searchScopeProject;\s*if \(project\) params\.set\('project', project\);/);
  const setFn = appJs.slice(appJs.indexOf('function setProjectFilter(next)'), appJs.indexOf('// 当前有效查询词'));
  assert.match(setFn, /resetSearchState\(\)/, '筛选一变，旧的全库命中就不能再合并进列表');
  assert.match(setFn, /if \(searchKey\(\)\) scheduleFullSearch\(\);/, '有搜索词时按新作用域重搜');
  assert.match(appJs, /if \(project\) params\.set\('project', project\);/, '/api/search 的会话作用域跟随项目筛选');
});

test('app.js：键盘可达性——项目卡可 Enter/Space 筛选，筛选条按钮不被重复触发', () => {
  assert.match(appJs, /const ACTIVATABLE = new Set\(\['drill-in', 'filter-project', 'nav-instance', 'nav-dashboard'\]\)/);
  assert.match(appJs, /if \(el\.tagName === 'BUTTON'\) return;/,
    '原生按钮自己会把 Enter/Space 变成 click，委托处理器不能再触发一次');
});

// —— 样式契约 ——

test('index.html：筛选条与选中项目卡的样式存在（浅/深主题共用变量）', () => {
  assert.match(indexHtml, /\.pane-filter \{[^}]*display: flex/);
  assert.match(indexHtml, /\.pane-filter \.filter-project \{[^}]*text-overflow: ellipsis/,
    '长项目名必须省略号截断，否则会把 ✕ / 计数挤出可视区');
  assert.match(indexHtml, /\.pane-filter \.filter-clear \{/);
  assert.match(indexHtml, /\.pane-filter \.filter-open \{/);
  assert.match(indexHtml, /\.pane-projects \.rows > \.row\.card\.selected \{/, '选中项目卡要常驻可辨识');
  assert.match(indexHtml, /\.pane-filter \.filter-count \{[^}]*margin-left: auto/);
});

test('app.js：新前端 + 旧后端时按项目名兜底过滤并提示重启（不显示错的行）', () => {
  assert.match(appJs, /import \{[^}]*\bfilterExactProject\b[^}]*\} from '\.\/components\/search-filter\.js'/);
  assert.match(appJs, /const exact = filterExactProject\(raw, project\);/);
  assert.match(appJs, /sessions: exact,/);
  assert.match(appJs, /hwb 后端仍是旧版本（未识别按项目筛选）：已在前端按项目名兜底过滤。重启 hwb 后即可取到该项目的全部会话。/);
  assert.match(appJs, /let staleBackendNoted = false;/);
});
