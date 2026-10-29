import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// 「隐藏项目」的前端接线：项目卡移入栏底「已隐藏」折叠条（默认收起），会话同时默认隐藏。
//
// 纯规则在 tests/session-mute.test.js；这里守 ① 组件产出的 DOM 契约（收起态不渲染隐藏项目、
// 展开态给「取消隐藏」、无隐藏项不画折叠条）、② app.js 的接线（状态 / 计数 / 动作 / 焦点）
// 与 ③ CSS 契约。
//
// 背景（用户反馈）：卡片上写着「已隐藏」却还留在项目列表里 —— 原实现的「隐藏」只过滤
// Recent Sessions 的会话，项目卡原地不动，所以看起来像没生效。隐藏的语义必须是**移出默认
// 视图**：进折叠栏、默认收起，只有主动展开才可见。
globalThis.document = {
  documentElement: { dataset: { theme: 'light' } },
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
};
globalThis.window = { matchMedia: () => ({ matches: false }) };

const { renderRecentProjects, splitHiddenProjects } = await import('../src/web/components/recent-projects.js');
const { renderSessionFilter } = await import('../src/web/components/recent-sessions.js');
const appJs = await readFile(new URL('../src/web/app.js', import.meta.url), 'utf8');
const indexHtml = await readFile(new URL('../src/web/index.html', import.meta.url), 'utf8');

const EVIL = 'x"><img src=x onerror=alert(1)>';
const project = (extra = {}) => ({
  homeId: 'abcdef1234567890', workspaceId: 'w1', project: 'relic-distill-cwd',
  sessionId: 's1', lastActivity: null, sessionCount: 997, inputTokens: 0, outputTokens: 0,
  totalTokens: 1000, ...extra,
});

// —— 纯函数：可见 / 已隐藏切分 ——

test('splitHiddenProjects：按同一个静音偏好切分，保持原顺序，脏输入不崩', () => {
  const rows = [project({ project: 'a' }), project({ project: 'b' }), project({ project: 'c' })];
  const split = splitHiddenProjects(rows, { hiddenProjects: ['b'] });
  assert.deepEqual(split.visible.map((p) => p.project), ['a', 'c']);
  assert.deepEqual(split.hidden.map((p) => p.project), ['b']);

  assert.deepEqual(splitHiddenProjects(rows).hidden, [], '没有偏好时全部可见');
  assert.deepEqual(splitHiddenProjects(null, { hiddenProjects: ['a'] }), { visible: [], hidden: [] });
  assert.deepEqual(splitHiddenProjects([null, rows[0], undefined], { hiddenProjects: [' a '] }).hidden.length, 1,
    '偏好名去首尾空白后仍然匹配（与 session-mute 的 normalize 口径一致）');
  const all = splitHiddenProjects(rows, { hiddenProjects: ['a', 'b', 'c'] });
  assert.deepEqual(all.visible, []);
  assert.equal(all.hidden.length, 3);
});

// —— 组件：主列表 + 隐藏栏 ——

test('项目卡：未隐藏才有 hover 才出现的「隐藏」按钮；隐藏后主列表不再出现这张卡', () => {
  // 可发现性：不必先点开项目、再在筛选条里找隐藏入口 —— 项目卡上直接给开关。
  const normal = renderRecentProjects([project()], [], { mutedProjects: [] });
  assert.match(normal, /<button type="button" class="chip card-mute" data-action="toggle-mute-project" data-project="relic-distill-cwd"/);
  assert.match(normal, /把该项目移入项目栏底部的「已隐藏」栏/);
  assert.match(normal, /data-action="filter-project"/);
  assert.doesNotMatch(normal, /projects-hidden/, '没有隐藏项目时不画折叠条');

  const hidden = renderRecentProjects([project()], [], { mutedProjects: ['relic-distill-cwd'] });
  assert.doesNotMatch(hidden, /data-project="relic-distill-cwd"/, '收起态连隐藏项目的卡都不渲染（不是「留原地加标记」）');
  assert.doesNotMatch(hidden, /card project-card hidden-project/, '收起态没有隐藏项目卡');
  assert.match(hidden, /class="projects-hidden"/, '折叠条本身要可见：告诉用户「少了的项目在哪」');
  assert.match(hidden, /已隐藏 <b>1<\/b> 个项目/);

  // 还有可见项目时：主列表照常画，折叠条只报告「少了几个」，不能说「都已隐藏」。
  const mixed = renderRecentProjects([project({ project: 'hwb' }), project()], [], { mutedProjects: ['relic-distill-cwd'] });
  assert.match(mixed, /data-project="hwb"/);
  assert.doesNotMatch(mixed, /全部项目都已隐藏/);
  assert.match(mixed, /已隐藏 <b>1<\/b> 个项目/);
});

test('隐藏栏：默认收起；展开才渲染卡片与「取消隐藏」；无隐藏项目时不占位', () => {
  const collapsed = renderRecentProjects([project()], [], { mutedProjects: ['relic-distill-cwd'] });
  assert.match(collapsed, /aria-expanded="false"/);
  assert.doesNotMatch(collapsed, /projects-hidden-panel/);
  assert.doesNotMatch(collapsed, /取消隐藏/);

  const expanded = renderRecentProjects([project()], [], { mutedProjects: ['relic-distill-cwd'], showHiddenProjects: true });
  assert.match(expanded, /aria-expanded="true"/);
  assert.match(expanded, /class="projects-hidden open"/);
  assert.match(expanded, /class="projects-hidden-panel" id="hidden-projects"/);
  assert.match(expanded, /class="row clickable card project-card hidden-project"/);
  assert.match(expanded, /class="chip muted-chip" data-action="toggle-mute-project" data-project="relic-distill-cwd"/);
  assert.match(expanded, /恢复显示：项目回到项目列表/);
  assert.doesNotMatch(expanded, /card-mute/, '已隐藏后不再画「隐藏」按钮（同一张卡只留一个开关）');
  // 卡片本体仍是筛选开关（展开隐藏栏后点它 → 筛到该项目，显式视图会显示它的会话）。
  assert.match(expanded, /data-action="filter-project"/);
  assert.match(expanded, /aria-pressed="false"/);

  assert.equal(renderRecentProjects([project()], [], { mutedProjects: ['x'] }).includes('projects-hidden'), false,
    '偏好里有、但当前列表没有的项目：不该凭名字画折叠条');
});

test('隐藏栏：全部项目被隐藏时给出空态出路，而不是「没有活跃项目」', () => {
  const html = renderRecentProjects([project()], [], { mutedProjects: ['relic-distill-cwd'] });
  assert.match(html, /项目都已隐藏 · 展开底部「已隐藏」栏查看/);
  assert.doesNotMatch(html, /no active projects in the last 7 days/, '和底部折叠条自相矛盾的空态不能说');
  assert.doesNotMatch(html, /class="rows"/);
});

test('项目卡：隐藏 + 选中可以同时存在（展开隐藏栏时能看到选中态）', () => {
  const html = renderRecentProjects([project()], [], {
    selectedProject: 'relic-distill-cwd',
    mutedProjects: ['relic-distill-cwd'],
    showHiddenProjects: true,
  });
  assert.match(html, /project-card selected hidden-project/);
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /muted-chip/);
});

test('项目卡：项目名进 data-project / 折叠条前转义（按钮也是注入面）', () => {
  const collapsed = renderRecentProjects([project({ project: EVIL })], [], { mutedProjects: [EVIL] });
  assert.doesNotMatch(collapsed, /<img/);
  assert.doesNotMatch(collapsed, /onerror/);

  const expanded = renderRecentProjects([project({ project: EVIL })], [], { mutedProjects: [EVIL], showHiddenProjects: true });
  assert.doesNotMatch(expanded, /<img/);
  assert.match(expanded, /data-project="[^"]*&lt;img/);
});

// —— 组件：筛选条（沿用静音偏好，不因项目卡搬家而失效）——

test('筛选条：未隐藏显示「默认隐藏」；已隐藏显示「取消默认隐藏」+「已默认隐藏」状态（避免误点）', () => {
  const plain = renderSessionFilter({ project: 'relic-distill-cwd', homeId: 'abcdef1234567890', count: 997 });
  assert.match(plain, /class="filter-mute" data-action="toggle-mute-project" data-project="relic-distill-cwd"/);
  assert.match(plain, /title="把这些会话从 Recent Sessions 的默认视图里隐藏（可随时取消）">默认隐藏</);
  assert.doesNotMatch(plain, /filter-state/);

  const muted = renderSessionFilter({ project: 'relic-distill-cwd', muted: true });
  assert.match(muted, /title="不再默认隐藏该项目的会话">取消默认隐藏</);
  assert.match(muted, /class="filter-state"[^>]*>已默认隐藏</);

  const evil = renderSessionFilter({ project: EVIL, muted: true });
  assert.doesNotMatch(evil, /<img/);
  assert.match(evil, /data-project="[^"]*&lt;img/);
});

// —— app.js 接线 ——

test('app.js：从 localStorage 读隐藏列表，隐藏栏默认收起，并把「显示已隐藏会话」做成临时开关', () => {
  assert.match(appJs, /import \{ renderRecentProjects, renderProjectsMore, splitHiddenProjects \} from '\.\/components\/recent-projects\.js'/);
  assert.match(appJs, /import \{ readMutedProjects, writeMutedProjects, toggleMutedProject, splitMutedSessions, mutedNoteSpec, renderMutedNote, renderMutedIdleNote, DEFAULT_MUTED_PROJECTS \} from '\.\/components\/session-mute\.js'/);
  assert.match(appJs, /try \{ return window\.localStorage; \} catch \{ return null; \}/, 'localStorage 访问本身也可能抛');
  assert.match(appJs, /let mutedProjects = readMutedProjects\(browserStorage\);/);
  assert.match(appJs, /let showMutedSessions = false;/);
  assert.match(appJs, /let showHiddenProjects = false;/, '隐藏栏默认收起：被隐藏的项目默认不可见');
});

test('app.js：paintDashboard 先切分隐藏项目，主列表计数不含隐藏项，折叠条在漏出时仍可见', () => {
  assert.match(appJs, /const projectMute = splitHiddenProjects\(filtered\.projects, \{ hiddenProjects: mutedProjects \}\);/);
  assert.match(appJs, /const hiddenProjectCount = projectMute\.hidden\.length;/);
  assert.match(appJs, /Math\.max\(0, filtered\.projects\.length - hiddenProjectCount\)/,
    '分区头计数与主列表卡片一致（隐藏了多少由折叠条写明，不能无声消失）');
  assert.match(appJs, /renderRecentProjects\(filtered\.projects, lastHomes, \{ selectedProject: searching \? null : project, mutedProjects, showHiddenProjects \}\)/);
  // 选中隐藏栏里的项目时自动展开，否则「选中了却看不见卡片」。
  assert.match(appJs, /if \(projectFilter && mutedProjects\.includes\(projectFilter\.project\)\) showHiddenProjects = true;/);
});

test('app.js：折叠条展开/收起动作 + 键盘焦点恢复', () => {
  assert.match(appJs, /case 'toggle-hidden-projects':[\s\S]{0,220}?showHiddenProjects = !showHiddenProjects;[\s\S]{0,120}?paintDashboard\(\);/);
  assert.match(appJs, /const focusedHiddenProjects = document\.activeElement\?\.dataset\?\.action === 'toggle-hidden-projects';/);
  assert.match(appJs, /if \(focusedHiddenProjects\) dashboardEl\.querySelector\('\[data-action="toggle-hidden-projects"\]'\)\?\.focus\(\{ preventScroll: true \}\);/);
});

test('app.js：隐藏项目 = 移入折叠栏 + 会话默认隐藏；取消隐藏后卡片回主列表', () => {
  const branch = appJs.slice(appJs.indexOf("case 'toggle-mute-project': {"), appJs.indexOf("case 'show-muted-sessions':"));
  assert.match(branch, /const wasMuted = mutedProjects\.includes\(project\);/);
  assert.match(branch, /mutedProjects = toggleMutedProject\(mutedProjects, project\);/);
  assert.match(branch, /writeMutedProjects\(browserStorage, mutedProjects\);/);
  assert.match(branch, /if \(wasMuted\) \{[\s\S]{0,220}?if \(!mutedProjects\.length\) showHiddenProjects = false;/);
  assert.match(branch, /showHiddenProjects = false;/, '新隐藏的项目收进收起态折叠栏（不能留在原地）');
  assert.match(branch, /已移入项目栏底部「已隐藏」栏/, '隐藏后要有可见反馈：告诉用户卡片去哪了');
  assert.match(branch, /if \(projectFilter\?\.project === project\) \{\s*\n\s*setProjectFilter\(null\);/,
    '在该项目的筛选视图里点隐藏要回默认视图，否则看起来没生效');
  assert.match(branch, /flashNote\(/, '隐藏/恢复后要有短暂可见反馈');
  assert.match(appJs, /case 'reset-muted-projects':[\s\S]{0,220}?showHiddenProjects = false;/,
    '恢复默认静音时折叠栏也要回到收起态');
});

test('app.js：显示 / 恢复隐藏 / 恢复默认静音三个动作仍可用', () => {
  assert.match(appJs, /case 'show-muted-sessions':\s*\n\s*showMutedSessions = true;\s*\n\s*paintDashboard\(\);/);
  assert.match(appJs, /case 'hide-muted-sessions':\s*\n\s*showMutedSessions = false;\s*\n\s*paintDashboard\(\);/);
  assert.match(appJs, /case 'reset-muted-projects':[\s\S]{0,160}?mutedProjects = \[\.\.\.DEFAULT_MUTED_PROJECTS\];/);
});

test('app.js：项目卡拿到静音列表与折叠栏展开态、筛选条拿到 muted 标记', () => {
  assert.match(appJs, /muted: mutedProjects\.includes\(project\)/);
});

// —— 样式契约 ——

test('index.html：隐藏栏（折叠条 / 抽屉面板 / 隐藏卡片压暗）有样式，浅深主题共用变量', () => {
  assert.match(indexHtml, /\.projects-hidden \{ flex: 0 0 auto; border-top: 1px dashed/,
    '折叠条挂在 .rows 之外（不随列表滚走）');
  assert.match(indexHtml, /\.projects-hidden-toggle \{ display: flex/);
  assert.match(indexHtml, /\.projects-hidden-toggle:hover, \.projects-hidden-toggle:focus-visible \{/,
    '键盘可达：折叠条必须能被聚焦');
  assert.match(indexHtml, /\.projects-hidden-toggle b \{[^}]*tabular-nums/);
  assert.match(indexHtml, /\.projects-hidden-panel \{/);
  assert.match(indexHtml, /\.projects-hidden-panel \.rows \{[^}]*overflow-y: auto/,
    '隐藏项目多时面板自己滚动，别把项目栏撑出视口');
  assert.match(indexHtml, /\.row\.hidden-project \{/);
  assert.match(indexHtml, /\.row\.hidden-project \.card-rail \{/);
  // 原有静音样式保留
  assert.match(indexHtml, /\.chip\.muted-chip \{[^}]*dashed/);
  assert.match(indexHtml, /button\.chip\.muted-chip \{[^}]*border-radius/);
  assert.match(indexHtml, /button\.chip\.card-mute \{[^}]*opacity: 0/);
  assert.match(indexHtml, /\.row\.project-card:hover button\.chip\.card-mute/);
  assert.match(indexHtml, /\.pane-filter \.filter-state \{/);
  assert.match(indexHtml, /\.muted-note \{[^}]*display: flex/);
});
