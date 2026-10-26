import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// 「默认过滤掉批量/噪音项目会话」的前端接线。
// 纯规则在 tests/session-mute.test.js；这里守 ① 组件上的可见入口（项目卡隐藏按钮、筛选条状态、
// 隐藏/恢复提示条）与 ② app.js 的接线（localStorage 读取、split → 渲染/计数、动作、CSS 契约）。
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
const { renderSessionFilter } = await import('../src/web/components/recent-sessions.js');
const appJs = await readFile(new URL('../src/web/app.js', import.meta.url), 'utf8');
const indexHtml = await readFile(new URL('../src/web/index.html', import.meta.url), 'utf8');

const EVIL = 'x"><img src=x onerror=alert(1)>';
const project = (extra = {}) => ({
  homeId: 'abcdef1234567890', workspaceId: 'w1', project: 'relic-distill-cwd',
  sessionId: 's1', lastActivity: null, sessionCount: 997, inputTokens: 0, outputTokens: 0,
  totalTokens: 1000, ...extra,
});

test('项目卡：未静音有 hover 才出现的「隐藏」按钮；已静音是常驻可点的「已隐藏」按钮', () => {
  // 可发现性：不必先点开项目、再在筛选条里找隐藏入口 —— 项目卡上直接给开关。
  const normal = renderRecentProjects([project()], [], { mutedProjects: [] });
  assert.match(normal, /<button type="button" class="chip card-mute" data-action="toggle-mute-project" data-project="relic-distill-cwd"/);
  assert.match(normal, /title="默认隐藏该项目的会话（不再出现在 Recent Sessions；可随时恢复）">隐藏</);
  assert.doesNotMatch(normal, /muted-chip/);

  const mutedHtml = renderRecentProjects([project()], [], { mutedProjects: ['relic-distill-cwd'] });
  assert.match(mutedHtml, /<button type="button" class="chip muted-chip" data-action="toggle-mute-project" data-project="relic-distill-cwd"/);
  assert.match(mutedHtml, /title="该项目的会话在 Recent Sessions 中默认隐藏；点击恢复显示">已隐藏</);
  assert.doesNotMatch(mutedHtml, /card-mute/, '已静音后不再画 hover 隐藏按钮（同一张卡只留一个开关）');
  // 项目卡本体的动作仍是筛选（点按钮走按钮自己的 action，不会误触发筛选）。
  assert.match(mutedHtml, /data-action="filter-project"/);
  assert.match(mutedHtml, /aria-pressed="false"/);

  // 旧调用（无静音列表）默认按「未静音」渲染，不影响既有调用方
  assert.match(renderRecentProjects([project()]), /card-mute/);
});

test('项目卡：静音 + 选中可以同时存在（点开被隐藏项目时仍显示会话）', () => {
  const html = renderRecentProjects([project()], [], {
    selectedProject: 'relic-distill-cwd',
    mutedProjects: ['relic-distill-cwd'],
  });
  assert.match(html, /project-card selected/);
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /muted-chip/);
});

test('项目卡：项目名进 data-project 前转义（按钮也是注入面）', () => {
  const html = renderRecentProjects([project({ project: EVIL })], [], { mutedProjects: [EVIL] });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /data-project="[^"]*&lt;img/);
});

test('筛选条：未静音显示「默认隐藏」；已静音显示「取消默认隐藏」+「已默认隐藏」状态（避免误点）', () => {
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

test('app.js：从 localStorage 读默认静音列表，并把「显示已隐藏」做成临时开关', () => {
  assert.match(appJs, /import \{ readMutedProjects, writeMutedProjects, toggleMutedProject, splitMutedSessions, mutedNoteSpec, renderMutedNote, renderMutedIdleNote, DEFAULT_MUTED_PROJECTS \} from '\.\/components\/session-mute\.js'/);
  assert.match(appJs, /try \{ return window\.localStorage; \} catch \{ return null; \}/, 'localStorage 访问本身也可能抛');
  assert.match(appJs, /let mutedProjects = readMutedProjects\(browserStorage\);/);
  assert.match(appJs, /let showMutedSessions = false;/);
});

test('app.js：paintDashboard 在 filterRecent 之后切分隐藏行，计数只算可见行，提示条挂在列表底部', () => {
  assert.match(appJs, /const mute = splitMutedSessions\(filtered\.sessions, \{[\s\S]{0,160}?mutedProjects,[\s\S]{0,160}?showMuted: showMutedSessions,[\s\S]{0,160}?projectFilter: project,/);
  assert.match(appJs, /const shownSessions = filterSessionState\(mute\.visible, sessionStatusFilter\);/);
  assert.match(appJs, /renderRecentSessions\(shownSessions, lastHomes\)/);
  // 默认隐藏行不算进分区计数；隐藏了多少由 mutedNote 明说，不能无声消失。
  assert.match(appJs, /sessionCount: filtered\.connected \? count\(shownSessions\.length, shownSessions\.length\) : null/);
  assert.match(appJs, /const noteSpec = mutedNoteSpec\(mute, \{/);
  assert.match(appJs, /const mutedNote = noteSpec \? renderMutedNote\(noteSpec\) : ''/);
  // 默认静音被关掉（列表为空）时给恢复入口；项目筛选视图里不画这两条。
  assert.match(appJs, /const mutedIdleNote = project \? '' : renderMutedIdleNote\(\{ mutedProjects \}\);/);
  assert.match(appJs, /sessions: sessionsHtml \+ projectMore \+ sessionsMore \+ mutedNote \+ mutedIdleNote/);
  // 全部被隐藏时不能再画「没有匹配」——那句会和提示条互相矛盾。
  assert.match(appJs, /\(mute\.hidden\.length > 0 && !mute\.visible\.length\)/);
});

test('app.js：隐藏项目在筛选视图里点隐藏会回到默认视图（否则显式视图必然显示全部会话，看起来没生效）', () => {
  const branch = appJs.slice(appJs.indexOf("case 'toggle-mute-project': {"), appJs.indexOf("case 'reset-muted-projects':"));
  assert.match(branch, /const wasMuted = mutedProjects\.includes\(project\);/);
  assert.match(branch, /mutedProjects = toggleMutedProject\(mutedProjects, project\);/);
  assert.match(branch, /writeMutedProjects\(browserStorage, mutedProjects\);/);
  assert.match(branch, /if \(projectFilter\?\.project === project\) \{\s*\n\s*setProjectFilter\(null\);/);
  assert.match(branch, /flashNote\(/, '隐藏/恢复后要有短暂可见反馈');
});

test('app.js：显示 / 恢复隐藏 / 恢复默认静音三个动作', () => {
  assert.match(appJs, /case 'show-muted-sessions':\s*\n\s*showMutedSessions = true;\s*\n\s*paintDashboard\(\);/);
  assert.match(appJs, /case 'hide-muted-sessions':\s*\n\s*showMutedSessions = false;\s*\n\s*paintDashboard\(\);/);
  assert.match(appJs, /case 'reset-muted-projects':[\s\S]{0,160}?mutedProjects = \[\.\.\.DEFAULT_MUTED_PROJECTS\];/);
});

test('app.js：项目卡拿到静音列表、筛选条拿到 muted 标记', () => {
  assert.match(appJs, /renderRecentProjects\(filtered\.projects, lastHomes, \{ selectedProject: searching \? null : project, mutedProjects \}\)/);
  assert.match(appJs, /muted: mutedProjects\.includes\(project\)/);
});

test('index.html：隐藏按钮（hover 显现）/ 已隐藏 chip / 提示条 / 状态 chip 都有样式', () => {
  assert.match(indexHtml, /\.chip\.muted-chip \{[^}]*dashed/);
  assert.match(indexHtml, /button\.chip\.muted-chip \{[^}]*border-radius/);
  assert.match(indexHtml, /button\.chip\.card-mute \{[^}]*opacity: 0/);
  assert.match(indexHtml, /\.row\.project-card:hover button\.chip\.card-mute/);
  assert.match(indexHtml, /\.pane-filter \.filter-state \{/);
  assert.match(indexHtml, /\.muted-note \{[^}]*display: flex/);
  assert.match(indexHtml, /\.muted-note\.muted-idle \{/);
  assert.match(indexHtml, /\.muted-note b \{[^}]*tabular-nums/);
  assert.match(indexHtml, /\.muted-note button \{/);
  assert.match(indexHtml, /\.pane-filter \.filter-mute \{/);
});
