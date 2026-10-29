import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// 「项目栏只显示 20 个」的回归守卫。
//
// 用户反馈：分区头写着「项目 20」，看起来就像「我的项目一共 20 个」（截图）。根因有两层：
// `/api/projects/recent` 的默认 `limit=20`（前端还不传 limit），以及 `recentProjects` 的
// 7 天时间窗；更糟的是被截断时界面**没有任何说明**。这个文件锁四件事：
//   ① store 的 all 语义：不设时间窗，但排序与「无会话工作区也算项目」的口径不变；
//   ② API 契约：all 只认显式真值、limit 上限、truncated（多取 1 行判断）；
//   ③ 分区头「最近 / 全部」控件与列表底部说明条的 DOM 契约；
//   ④ app.js 的接线（范围 → 取数地址、持久化、切换动作）与 index.html 的样式。
globalThis.document = {
  documentElement: { dataset: { theme: 'light' } },
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
};
globalThis.window = { matchMedia: () => ({ matches: false }) };

const { IndexStore } = await import('../src/dshhome/store.js');
const { createRouter } = await import('../src/api/routes.js');
const { renderWorkbench } = await import('../src/web/components/workbench.js');
const { renderProjectsMore } = await import('../src/web/components/recent-projects.js');
const appJs = await readFile(new URL('../src/web/app.js', import.meta.url), 'utf8');
const indexHtml = await readFile(new URL('../src/web/index.html', import.meta.url), 'utf8');

const HOME_ID = 'abcdef1234567890';
const day = 86_400_000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

// —— store：all 语义 ——

function seededStore() {
  const store = new IndexStore();
  const home = store.registerHome({ homePath: '/seed' });
  const insert = store.db.prepare('INSERT INTO sessions (homeId, sessionId, project, lastActivity, tokenUsage) VALUES (?, ?, ?, ?, ?)');
  insert.run(home, 's-fresh', 'fresh-proj', iso(60_000), JSON.stringify({ outputTokens: 1 }));
  insert.run(home, 's-stale', 'stale-proj', iso(40 * day), JSON.stringify({ outputTokens: 1 }));
  // 没有会话的工作区也算项目（§4.5）：这条口径在 all 模式下不能被时间窗顺手改掉。
  store.db.prepare('INSERT INTO workspaces (homeId, workspaceId, project) VALUES (?, ?, ?)').run(home, 'w-empty', 'empty-ws');
  return { store, home };
}

test('store：默认只收时间窗内的项目，all=true 不设时间窗（旧项目不再消失）', (t) => {
  const { store } = seededStore();
  t.after(() => store.close());

  assert.deepEqual(store.recentProjects().map((p) => p.project), ['fresh-proj', 'empty-ws'],
    '默认仍是「最近 7 天」：40 天前的项目不进最近列表');
  assert.deepEqual(store.recentProjects({ all: true }).map((p) => p.project), ['fresh-proj', 'stale-proj', 'empty-ws'],
    '全部视图按 lastActivity 倒序，无会话的工作区照旧追加在末尾');
  assert.equal(store.recentProjects({ all: true }).find((p) => p.project === 'stale-proj').sessionCount, 1,
    '全部视图的 sessionCount 是项目全部会话数（不再是窗口内条数）');
});

test('store：all 模式仍然按 limit 收口（调用方多取 1 行判断截断）', (t) => {
  const { store } = seededStore();
  t.after(() => store.close());
  assert.deepEqual(store.recentProjects({ all: true, limit: 2 }).map((p) => p.project), ['fresh-proj', 'stale-proj']);
  assert.equal(store.recentProjects({ all: true, limit: 2 }).length, 2);
  assert.deepEqual(store.recentProjects({ all: false, limit: 2 }).map((p) => p.project), ['fresh-proj', 'empty-ws']);
});

// —— API：all / limit / truncated ——

function makeRouter({ calls = [], rows = [] } = {}) {
  return createRouter({
    store: {
      listHomes: () => [],
      getHome: () => null,
      recentProjects: (args) => { calls.push(args); return rows; },
      recentSessions: () => [],
      searchAll: () => ({ projects: [], sessions: [], truncated: { projects: false, sessions: false } }),
      listWorkspaces: () => [],
      getSession: () => null,
    },
    indexer: { reindexNow: async () => [] },
    hub: { broadcast() {}, handle() {} },
    launcher: { status: () => null },
    monitor: { get: () => ({ runtime: 'running' }) },
    quota: { list: () => [] },
    logApi: { getLogs: () => [] },
  });
}

async function request(route, pathname) {
  const result = { status: null, body: null };
  await route({ method: 'GET', headers: {} }, {
    setHeader() {},
    writeHead(status) { result.status = status; },
    end(raw) { result.body = raw ? JSON.parse(raw) : null; },
  }, new URL(`http://127.0.0.1:4310${pathname}`));
  return result;
}

const fakeProjects = (n) => Array.from({ length: n }, (_, i) => ({
  homeId: HOME_ID, workspaceId: `w${i}`, project: `proj-${i}`, sessionId: `s${i}`,
  lastActivity: iso(i * 60_000), sessionCount: 1,
}));

test('API：默认行为不变（days=7、limit=20），但多取 1 行并回报 truncated', async () => {
  const calls = [];
  const route = makeRouter({ calls, rows: fakeProjects(20) });
  const res = await request(route, '/api/projects/recent');
  assert.equal(res.status, 200);
  assert.equal(calls[0].days, 7);
  assert.equal(calls[0].all, false, '不传 all 时走「最近」语义');
  assert.equal(calls[0].limit, 21, '多取 1 行用于判断截断');
  assert.equal(res.body.projects.length, 20);
  assert.equal(res.body.truncated, false);
});

test('API：?all=1 透传到 store，且 limit 仍按「最多 N 条」收口 + truncated', async () => {
  const calls = [];
  const route = makeRouter({ calls, rows: fakeProjects(6) });
  const res = await request(route, '/api/projects/recent?all=1&limit=5');
  assert.equal(calls[0].all, true, 'all=1 必须被识别');
  assert.equal(calls[0].limit, 6);
  assert.equal(res.body.projects.length, 5, '响应里最多 limit 条');
  assert.equal(res.body.truncated, true, '多出来的那 1 行只用于说明「还有更多」');
});

test('API：all 只认显式真值（?all=0 不能因为字符串非空就被当成真）', async () => {
  const calls = [];
  const route = makeRouter({ calls });
  await request(route, '/api/projects/recent?all=0');
  await request(route, '/api/projects/recent?all=false');
  await request(route, '/api/projects/recent?all=');
  assert.deepEqual(calls.map((c) => c.all), [false, false, false]);
  await request(route, '/api/projects/recent?all=yes');
  await request(route, '/api/projects/recent?all=true');
  assert.deepEqual(calls.slice(3).map((c) => c.all), [true, true]);
});

test('API：limit 上限 2000（全部视图要装得下几百个项目），非法值回落默认 20', async () => {
  const calls = [];
  const route = makeRouter({ calls });
  await request(route, '/api/projects/recent?limit=99999');
  await request(route, '/api/projects/recent?limit=abc');
  assert.equal(calls[0].limit, 2001, '上限按 2000 条收口（再 +1 判断截断）');
  assert.equal(calls[1].limit, 21, '非法 limit 回落到默认 20');
});

// —— 组件：分区头范围切换 + 底部说明 ——

test('分区头：范围切换是常驻分段控件（最近 / 全部），用 aria-pressed 表达当前范围', () => {
  const all = renderWorkbench({ projects: '', sessions: '', homes: '', usage: '', logs: '', projectScope: 'all', projectCount: 535 });
  assert.match(all, /class="pane-scope" role="group" aria-label="项目范围"/);
  assert.match(all, /data-action="projects-scope" data-scope="recent" aria-pressed="false"/);
  assert.match(all, /data-action="projects-scope" data-scope="all" aria-pressed="true"/);
  assert.match(all, /<span class="pane-count">535<\/span>/, '计数仍在最右');

  const recent = renderWorkbench({ projects: '', sessions: '', homes: '', usage: '', logs: '', projectScope: 'recent', projectCount: 49 });
  assert.match(recent, /data-scope="recent" aria-pressed="true"/);
  assert.match(recent, /data-scope="all" aria-pressed="false"/);

  // 不传时保持旧行为（不画控件）：列表片段/旧调用方不该冒出一个无关按钮。
  const none = renderWorkbench({ projects: '', sessions: '', homes: '', usage: '', logs: '', projectCount: 20 });
  assert.doesNotMatch(none, /pane-scope/);
  assert.doesNotMatch(none, /aria-pressed/);
});

test('底部说明：被截断时必须说清「这不是全部」，并给出出路（只在真截断时出现）', () => {
  assert.equal(renderProjectsMore({ scope: 'recent', truncated: false }), '', '没截断就不加噪音');
  assert.equal(renderProjectsMore({ scope: 'all', truncated: false }), '');

  const recent = renderProjectsMore({ scope: 'recent', truncated: true, recentLimit: 200, days: 7 });
  assert.match(recent, /class="pane-note"/);
  assert.match(recent, /最近 7 天内最新的 200 个项目/);
  assert.match(recent, /data-action="projects-scope" data-scope="all"/, '出路是切到「全部」，与分区头同一个 action');
  assert.match(recent, /查看全部项目/);

  const all = renderProjectsMore({ scope: 'all', truncated: true, allLimit: 1000 });
  assert.match(all, /前 1000 个/);
  assert.match(all, /顶栏搜索/, '全部仍被截断时没有更大的档位可切，只能指路搜索');
  assert.doesNotMatch(all, /data-action="projects-scope"/);
});

// —— app.js 接线 ——

test('app.js：范围 → 取数地址（最近 200 / 全部 1000），持久化在 localStorage', () => {
  assert.match(appJs, /const PROJECTS_SCOPE_KEY = 'hwb:projects-scope';/);
  assert.match(appJs, /const PROJECTS_SCOPES = \['recent', 'all'\];/);
  assert.match(appJs, /const PROJECTS_RECENT_LIMIT = 200;/, '最近视图不能再用 20：7 天窗口里就可能超过它');
  assert.match(appJs, /const PROJECTS_ALL_LIMIT = 1000;/);
  const urlFn = appJs.slice(appJs.indexOf('function projectsUrl()'), appJs.indexOf('// 「新前端 + 旧后端」混合状态只提示一次'));
  assert.match(urlFn, /all: '1'/, '全部视图走 all=1（服务端据此去掉时间窗）');
  assert.match(urlFn, /days: String\(PROJECTS_RECENT_DAYS\)/, '最近视图显式带时间窗');
  assert.match(appJs, /api\(projectsUrl\(\)\)/, '渲染路径必须用范围地址取数，不能写死 /api/projects/recent');
  assert.match(appJs, /let projectsScope = readProjectsScope\(\);/);
  // 默认必须是「全部」：分区头写的是「项目」，默认只给 7 天等于替用户藏起旧项目。
  const readFn = appJs.slice(appJs.indexOf('function readProjectsScope()'), appJs.indexOf('let projectsScope'));
  assert.match(readFn, /: 'all';/, '无偏好/坏值时的默认范围是「全部」');
  assert.match(readFn, /\} catch \{ return 'all'; \}/, 'localStorage 不可用时也回默认「全部」');
  assert.match(appJs, /saveProjectsScope\(scope\);/, '切换后写偏好');
});

test('app.js：切换动作改范围 → 重新取数；新前端+旧后端时提示重启而不是假装是全部', () => {
  assert.match(appJs, /case 'projects-scope': \{/);
  assert.match(appJs, /if \(!PROJECTS_SCOPES\.includes\(scope\) \|\| scope === projectsScope\) break;/,
    '非法/重复的 scope 不能触发请求');
  assert.match(appJs, /projectsScope = scope;[\s\S]{0,120}await refresh\(\);/, '范围决定数据口径，必须重新取数');
  assert.match(appJs, /hwb 后端仍是旧版本（未识别「全部项目」）：当前仍只显示最近的项目。重启 hwb 后即可显示全部。/);
  assert.match(appJs, /projectsTruncated = projectsRes\.status === 'fulfilled' && projectsRes\.value\?\.truncated === true;/);
  assert.match(appJs, /projectScope: projectsScope,/);
  assert.match(appJs, /projects: projectsHtml \+ projectsMore \+ projectsScopeNote,/);
});

// —— 样式契约 ——

test('index.html：范围控件与底部说明条有样式（浅/深主题共用变量）', () => {
  assert.match(indexHtml, /\.pane-scope \{[^}]*display: inline-flex[^}]*flex: none/,
    '控件不能被窄栏挤变形（不参与伸缩）');
  assert.match(indexHtml, /\.pane-scope-btn\[aria-pressed="true"\] \{[^}]*var\(--accent\)/,
    '当前范围要能一眼看出来');
  assert.match(indexHtml, /\.pane-note \{[^}]*border-top: 1px dashed/, '说明条挂在列表之外（不随列表滚走）');
  assert.match(indexHtml, /\.pane-note button \{/);
});
