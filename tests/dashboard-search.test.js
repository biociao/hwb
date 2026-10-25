import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// 顶栏搜索的「接线」回归：过滤逻辑本身在 search-filter.test.js，这里守的是
// ① 输入框真的在顶栏右侧（红框标注的原空白处）且可访问；
// ② 样式契约（聚焦可见、原生清除按钮不与自定义 ✕ 重复、隐藏态不占位）；
// ③ app.js 里过滤走的是「复用最近一轮数据」的渲染路径，而不是每键一次网络刷新。
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

const topbarRight = indexHtml.slice(indexHtml.indexOf('<div class="topbar-right">'), indexHtml.indexOf('</header>'));

test('顶栏搜索框：在主题按钮左侧、可访问、清除按钮默认隐藏', () => {
  assert.ok(topbarRight.indexOf('id="search"') > 0, '顶栏右侧必须有搜索输入框');
  assert.ok(topbarRight.indexOf('class="theme-wrap"') > topbarRight.indexOf('id="search"'),
    '搜索框在主题按钮左侧（原先的空白处）');
  assert.match(topbarRight, /role="search"/);
  assert.match(topbarRight, /type="search"/);
  assert.match(topbarRight, /placeholder="搜索项目 \/ 会话名…"/);
  assert.match(topbarRight, /aria-label="[^"]*搜索[^"]*"/);
  assert.match(topbarRight, /id="search-clear"[^>]*hidden/, '清除按钮默认隐藏：没输入时不占位');
  assert.match(topbarRight, /id="search-clear"[^>]*data-action="clear-search"/,
    '✕ 必须挂 data-action：body 上的委托 click 处理器只认 [data-action]（真浏览器检查实测漏过）');
});

test('顶栏搜索框样式：聚焦可见、原生清除按钮隐藏、隐藏态不占位', () => {
  assert.match(indexHtml, /\.search-input:focus\s*\{[^}]*border-color:\s*var\(--accent\)/);
  assert.match(indexHtml, /\.search-input:focus\s*\{[^}]*box-shadow:\s*0 0 0 3px var\(--accent-soft\)/);
  assert.match(indexHtml, /\.search-input::-webkit-search-cancel-button\s*\{[^}]*appearance:\s*none/,
    '自绘 ✕ 与浏览器原生清除按钮不能同时出现');
  assert.match(indexHtml, /\.search-wrap\[hidden\]\s*\{\s*display:\s*none !important/);
  assert.match(indexHtml, /\.search-clear\[hidden\]\s*\{\s*display:\s*none !important/);
  assert.match(indexHtml, /\.search-empty button/, '过滤到 0 条时「清除搜索」必须可点');
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

test('app.js：输入只做本地过滤（复用 lastLists），实例视图里隐藏搜索框', () => {
  assert.match(appJs, /import \{ filterRecent, searchEmptyHtml \} from '\.\/components\/search-filter\.js'/);
  assert.match(appJs, /lastLists = \{ projects, sessions, connectedIds \}/);
  assert.match(appJs, /function paintDashboard\(\)/);
  assert.match(appJs, /if \(repaint && view\.kind === 'dashboard' && lastHomes\.length\) paintDashboard\(\)/,
    '搜索框输入 → paintDashboard（不 refresh）');
  assert.match(appJs, /case 'clear-search':/);
  assert.match(appJs, /searchInput\?\.addEventListener\('input'/);
  assert.match(appJs, /searchWrap\.hidden = view\.kind !== 'dashboard'/, '实例视图里隐藏（只作用于工作台）');
  // 真浏览器实测的第二个缺陷：添加实例表单展开时，重绘的「默认聚焦 homePath」会把焦点
  // 从搜索框抢走 → 敲一个字就跳出，连续输入被打断。重绘时必须在搜索框有焦点的情况下跳过。
  assert.match(appJs, /!restored && document\.activeElement !== searchInput\) form\.querySelector\('input\[name=homePath\]'\)\?\.focus\(\)/,
    '搜索框获得焦点时，仪表盘重绘不得把焦点抢回添加表单');
});
