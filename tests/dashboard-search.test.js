import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// 顶栏搜索的「接线」回归：过滤/合并逻辑本身在 search-filter.test.js，服务端检索在
// store-search.test.js / api-search.test.js，这里守的是：
// ① 输入框在顶栏中间（与会话区对齐）且可访问；
// ② 样式契约（聚焦可见、原生清除按钮不与自定义 ✕ 重复、隐藏态不占位、历史 chip 有样式）；
// ③ app.js 的搜索路径：本地即时过滤（复用 lastLists）+ 停手后防抖请求 /api/search 补历史，
//    并且全库结果必须经过 mergeSearchResults()、乱序响应必须被 seq 挡掉。
globalThis.document = {
  documentElement: { dataset: { theme: 'light' } },
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
};
globalThis.window = { matchMedia: () => ({ matches: false }) };

const { renderWorkbench } = await import('../src/web/components/workbench.js');
const indexHtml = await readFile(new URL('../src/web/index.html', import.meta.url), 'utf8');
const appJs = await readFile(new URL('../src/web/app.js', import.meta.url), 'utf8');

const topbarRight = indexHtml.slice(indexHtml.indexOf('<header id="topbar">'), indexHtml.indexOf('</header>'));

test('顶栏搜索框：位于独立中间列，可访问、清除按钮默认隐藏', () => {
  assert.ok(topbarRight.indexOf('id="search"') > 0, '顶栏必须有搜索输入框');
  assert.ok(topbarRight.indexOf('class="theme-wrap"') > topbarRight.indexOf('id="search"'),
    '搜索框在主题按钮左侧，作为中间网格列');
  assert.match(topbarRight, /role="search"/);
  assert.match(topbarRight, /aria-controls="search-results"/);
  assert.match(topbarRight, /id="search-scope"[^>]*data-action="clear-search-scope"/);
  assert.match(topbarRight, /type="search"/);
  assert.match(topbarRight, /placeholder="搜索项目或会话…"/);
  assert.match(topbarRight, /aria-label="[^"]*搜索[^"]*"/);
  assert.match(topbarRight, /id="search-clear"[^>]*hidden/, '清除按钮默认隐藏：没输入时不占位');
  assert.match(topbarRight, /id="search-clear"[^>]*data-action="clear-search"/,
    '✕ 必须挂 data-action：body 上的委托 click 处理器只认 [data-action]（真浏览器检查实测漏过）');
});

test('顶栏搜索框样式：聚焦可见、原生清除按钮隐藏、隐藏态不占位、历史标记有样式', () => {
  assert.match(indexHtml, /\.search-input:focus\s*\{[^}]*border-color:\s*var\(--accent\)/);
  assert.match(indexHtml, /\.search-input:focus\s*\{[^}]*box-shadow:\s*0 0 0 3px var\(--accent-soft\)/);
  assert.match(indexHtml, /\.search-input::-webkit-search-cancel-button\s*\{[^}]*appearance:\s*none/,
    '自绘 ✕ 与浏览器原生清除按钮不能同时出现');
  assert.match(indexHtml, /\.search-wrap\[hidden\]\s*\{\s*display:\s*none !important/);
  assert.match(indexHtml, /\.search-clear\[hidden\]\s*\{\s*display:\s*none !important/);
  assert.match(indexHtml, /\.search-empty button/, '过滤到 0 条时「清除搜索」必须可点');
  // 全库检索补出的历史行用弱化 chip 标注来源；没有样式会退化成和普通 chip 一样，看不出区别。
  assert.match(indexHtml, /\.chip\.hist-chip\s*\{[^}]*dashed/);
  assert.match(indexHtml, /\.search-more\s*\{/);
});

test('workbench：计数接受「命中/总数」字符串（过滤中），null 时不画计数', () => {
  const filtered = renderWorkbench({
    projects: '', sessions: '', homes: '', usage: '', logs: '',
    projectCount: '3/20', sessionCount: '0/50',
  });
  assert.match(filtered, /<span class="pane-count">3\/20<\/span>/);
  assert.match(filtered, /<span class="pane-count">0\/50<\/span>/);
  const none = renderWorkbench({
    projects: '', sessions: '', homes: '', usage: '', logs: '',
    projectCount: null, sessionCount: null,
  });
  assert.doesNotMatch(none, /pane-count/);
});

test('app.js：输入先本地过滤，实例视图里隐藏搜索框', () => {
  assert.match(appJs, /import \{[^}]*\bfilterRecent\b[^}]*\} from '\.\/components\/search-filter\.js'/);
  assert.match(appJs, /lastLists = \{ projects, sessions, connectedIds \}/);
  assert.match(appJs, /function paintDashboard\(\)/);
  assert.match(appJs, /if \(repaint && view\.kind === 'dashboard' && lastHomes\.length\) paintDashboard\(\)/,
    '搜索框输入 → paintDashboard（不 refresh 最近列表）');
  assert.match(appJs, /case 'clear-search':/);
  assert.match(appJs, /searchInput\?\.addEventListener\('input'/);
  assert.match(appJs, /searchWrap\.hidden = view\.kind !== 'dashboard'/, '实例视图里隐藏（只作用于工作台）');
  // 真浏览器实测的第二个缺陷：添加实例表单展开时，重绘的「默认聚焦 homePath」会把焦点
  // 从搜索框抢走 → 敲一个字就跳出，连续输入被打断。重绘时必须在搜索框有焦点的情况下跳过。
  assert.match(appJs, /!restored && document\.activeElement !== searchInput\) form\.querySelector\('input\[name=homePath\]'\)\?\.focus\(\)/,
    '搜索框获得焦点时，仪表盘重绘不得把焦点抢回添加表单');
});

// 全库补搜最怕的三件事：每敲一个字打一次数据库、慢响应覆盖新查询、历史结果没合并进列表。
// 这三条都只能从 app.js 的接线看出来（纯函数部分已在 search-filter.test.js 覆盖）。
test('app.js：全库补搜走防抖 + 序号守卫，结果经 mergeSearchResults 合并', () => {
  assert.match(appJs, /const SEARCH_DEBOUNCE_MS = 200;/);
  assert.match(appJs, /function scheduleFullSearch\(\)/);
  assert.match(appJs, /setTimeout\(\(\) => \{[\s\S]*?requestFullSearch\(key\);[\s\S]*?\}, SEARCH_DEBOUNCE_MS\)/,
    '防抖定时器必须在 SEARCH_DEBOUNCE_MS 后调用 requestFullSearch');
  assert.match(appJs, /api\(`\/api\/search\?\$\{params\}`\)/);
  assert.match(appJs, /if \(seq !== searchSeq \|\| key !== searchKey\(\)\) return;/,
    '乱序响应必须被 (seq, 当前查询词) 双重守卫挡掉');
  // 会话基底从 `sessions` 变成 `baseSessions`（项目筛选下是该项目会话，否则是最近 50 条）；
  // 合并语义不变：最近行优先、全库结果只补缺。
  assert.match(appJs, /mergeSearchResults\(\{ projects, sessions: baseSessions, searchedProjects: full\.projects, searchedSessions: full\.sessions \}\)/,
    '全库结果必须与最近列表合并，而不是直接替换');
  assert.match(appJs, /searchState\.status === 'loading'/);
  assert.match(appJs, /searchPendingHtml\('项目', searchQuery\)/);
  assert.match(appJs, /searchPendingHtml\('会话', searchQuery\)/);
  // 输入法组合期间不能发全库请求（拼音中间态会白扫一次全表）。
  assert.match(appJs, /if \(!searchComposing\) scheduleFullSearch\(\);/);
});

test('组件：historical 行渲染「历史」chip（全库补搜的来源说明）', async () => {
  const { renderRecentProjects } = await import('../src/web/components/recent-projects.js');
  const { renderRecentSessions } = await import('../src/web/components/recent-sessions.js');
  const project = { homeId: 'h1', project: 'PMAID-GPPH', sessionCount: 7, lastActivity: '2026-09-23T01:28:15.821Z', historical: true };
  assert.match(renderRecentProjects([project]), /hist-chip[\s\S]*历史/, '历史项目行要有「历史」chip');
  assert.doesNotMatch(renderRecentProjects([{ ...project, historical: false }]), /hist-chip/);

  const session = { homeId: 'h1', sessionId: '01a0cb5f-6a97', project: 'PMAID-GPPH', title: '旧会话',
    lastActivity: '2026-09-23T01:28:15.821Z', status: null, historical: true };
  assert.match(renderRecentSessions([session]), /hist-chip[\s\S]*历史/, '历史会话行要有「历史」chip');
  assert.doesNotMatch(renderRecentSessions([{ ...session, historical: false }]), /hist-chip/);
});
