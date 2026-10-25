import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRouter } from '../src/api/routes.js';
import { createApiServer } from '../src/api/server.js';
import { IndexStore } from '../src/dshhome/store.js';

// GET /api/sessions/recent 的「项目筛选」契约：
//   ① project 参数归一化后原样传给 store（精确等值，不是搜索词）；
//   ② 项目筛选时多取 1 行判断 truncated，但响应里最多 limit 条；
//   ③ 未筛选时形状与语义保持原样（最近 N 条、truncated=false）；
//   ④ 端到端：项目下会话超过 50 条也能全部取到（这就是「按项目筛会话」与
//      「最近 50 条里挑」的区别），且未连接实例的数据不出现。

const HOME_ID = 'abcdef1234567890';

function makeRouter({ calls = [], rows = [], homes = [{ homeId: HOME_ID }], running = true } = {}) {
  const route = createRouter({
    store: {
      listHomes: () => homes,
      getHome: () => null,
      recentProjects: () => [],
      recentSessions: (args) => { calls.push(args); return rows; },
      searchAll: (args) => { calls.push(args); return { projects: [], sessions: [], truncated: { projects: false, sessions: false } }; },
      listWorkspaces: () => [],
      getSession: () => null,
    },
    indexer: { reindexNow: async () => [] },
    hub: { broadcast() {}, handle() {} },
    launcher: { status: () => null },
    monitor: { get: () => ({ runtime: running ? 'running' : 'stopped' }) },
    quota: { list: () => [] },
    logApi: { getLogs: () => [] },
  });
  return route;
}

async function request(route, method, pathname) {
  const result = { status: null, body: null };
  const req = { method, headers: {} };
  const res = {
    setHeader() {},
    writeHead(status) { result.status = status; },
    end(raw) { result.body = raw ? JSON.parse(raw) : null; },
  };
  await route(req, res, new URL(`http://127.0.0.1:4310${pathname}`));
  return result;
}

const fakeRows = (n) => Array.from({ length: n }, (_, i) => ({
  homeId: HOME_ID,
  sessionId: `s${i}`,
  project: 'PMAID-GPPH',
  title: `会话 ${i}`,
  lastActivity: new Date(Date.now() - i * 60_000).toISOString(),
}));

test('GET /api/sessions/recent?project=：参数传给 store，多取 1 行判断截断', async () => {
  const calls = [];
  const route = makeRouter({ calls, rows: fakeRows(11) });
  const res = await request(route, 'GET', '/api/sessions/recent?project=%20PMAID-GPPH%20&limit=10');
  assert.equal(res.status, 200);
  assert.deepEqual(calls[0], { homeIds: [HOME_ID], homeId: null, project: 'PMAID-GPPH', limit: 11 },
    'project 去空白后精确传给 store；内部多取 1 行');
  assert.equal(res.body.sessions.length, 10, '响应里最多 limit 条');
  assert.equal(res.body.truncated, true, '多出来的那一行说明「还有更多」');
});

test('GET /api/sessions/recent：未筛项目时形状不变（最近 N 条，不截断）', async () => {
  const calls = [];
  const route = makeRouter({ calls, rows: fakeRows(3) });
  const res = await request(route, 'GET', '/api/sessions/recent');
  assert.equal(res.status, 200);
  assert.deepEqual(calls[0], { homeIds: [HOME_ID], homeId: null, project: null, limit: 50 });
  assert.deepEqual(res.body.sessions.map((s) => s.sessionId), ['s0', 's1', 's2']);
  assert.equal(res.body.truncated, false);
});

test('GET /api/sessions/recent：空白/超长 project 参数不会变成通配或超长串', async () => {
  const blank = [];
  await request(makeRouter({ calls: blank, rows: [] }), 'GET', '/api/sessions/recent?project=%20%20');
  assert.equal(blank[0].project, null, '只有空白 = 没筛选');
  const long = [];
  await request(makeRouter({ calls: long, rows: [] }), 'GET', `/api/sessions/recent?project=${'x'.repeat(500)}`);
  assert.equal(long[0].project.length, 200, '自由文本参数限长 200（只当等值条件用）');
});

test('POST /api/sessions/recent 不触达 store（项目筛选没有写入口）', async () => {
  const calls = [];
  const res = await request(makeRouter({ calls, rows: fakeRows(1) }), 'POST', '/api/sessions/recent?project=PMAID-GPPH');
  assert.equal(res.status, 404);
  assert.deepEqual(calls, []);
});

// —— 端到端：真 IndexStore + 真 HTTP 服务 ——
function seedStore() {
  const store = new IndexStore(':memory:');
  const online = store.registerHome({ homePath: '/mock/online-home' });
  const offline = store.registerHome({ homePath: '/mock/offline-home' });
  const ins = store.db.prepare(
    `INSERT INTO sessions (homeId, sessionId, project, workspaceTitle, title, lastActivity, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  // 60 条同项目会话（40 天前，被更近的 FILLER 会话挤出「最近 50 条」）。
  // 离线实例上再放一条同名项目的，验证 homeIds 作用域。
  for (let i = 0; i < 60; i++) {
    ins.run(online, `p${i}`, 'PMAID-GPPH', 'PMAID-GPPH', `旧会话 ${i}`,
      new Date(Date.now() - 40 * 86_400_000 - i * 60_000).toISOString(),
      JSON.stringify({ kind: 'idle', label: '空闲' }));
  }
  // 55 条更近的无关会话：保证最近 50 条里一条旧会话都没有（真实场景里也是这样）。
  for (let i = 0; i < 55; i++) {
    ins.run(online, `f${i}`, 'FILLER', 'FILLER', `填充 ${i}`,
      new Date(Date.now() - i * 60_000).toISOString(),
      JSON.stringify({ kind: 'idle', label: '空闲' }));
  }
  ins.run(offline, 'offline-only', 'PMAID-GPPH', 'PMAID-GPPH', '未连接实例的会话',
    new Date().toISOString(), JSON.stringify({ kind: 'idle', label: '空闲' }));
  ins.run(online, 'other', 'PMAID', 'PMAID', '另一个项目',
    new Date().toISOString(), JSON.stringify({ kind: 'idle', label: '空闲' }));
  return { store, online, offline };
}

async function withApiServer(fn) {
  const { store, online, offline } = seedStore();
  const server = createApiServer({
    store,
    indexer: { reindexNow: async () => [] },
    hub: { broadcast() {}, handle() {} },
    launcher: { status: () => null },
    // offline 已索引但未连接：它的数据不能出现在任何返回里。
    monitor: { get: (homeId) => ({ runtime: homeId === online ? 'running' : 'stopped' }) },
    quota: { list: () => [] },
    logApi: { getLogs: () => [] },
    webRoot: '/nonexistent-web-root',
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ base, store, online, offline });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  }
}

test('api: 项目筛选能取到 50 条以外的会话；未连接实例的数据不出现', async () => {
  await withApiServer(async ({ base }) => {
    // 前置：全局最近 50 条里根本没有这些旧会话（它们都在 40 天前）。
    const recent = await (await fetch(`${base}/api/sessions/recent`)).json();
    assert.equal(recent.sessions.some((s) => s.sessionId.startsWith('p')), false);

    const scoped = await (await fetch(`${base}/api/sessions/recent?project=PMAID-GPPH&limit=50`)).json();
    assert.equal(scoped.sessions.length, 50);
    assert.equal(scoped.truncated, true);
    assert.ok(scoped.sessions.every((s) => s.project === 'PMAID-GPPH'));
    assert.equal(scoped.sessions.some((s) => s.sessionId === 'offline-only'), false,
      '未连接实例的同名项目会话不能混进来');

    const all = await (await fetch(`${base}/api/sessions/recent?project=PMAID-GPPH&limit=200`)).json();
    assert.equal(all.sessions.length, 60, 'limit 200 时 60 条全在');
    assert.equal(all.truncated, false);
    assert.deepEqual(all.sessions.map((s) => s.sessionId), Array.from({ length: 60 }, (_, i) => `p${i}`),
      '按 lastActivity 倒序（p0 最新）');
  });
});

test('api: project 是精确等值（PMAID 不吞掉 PMAID-GPPH）', async () => {
  await withApiServer(async ({ base }) => {
    const exact = await (await fetch(`${base}/api/sessions/recent?project=PMAID`)).json();
    assert.deepEqual(exact.sessions.map((s) => s.sessionId), ['other']);
  });
});

test('api: 项目筛选下的 /api/search 只收窄会话，项目结果仍可跨项目', async () => {
  await withApiServer(async ({ base }) => {
    const body = await (await fetch(`${base}/api/search?q=PMAID&project=PMAID-GPPH`)).json();
    assert.ok(body.sessions.length > 0);
    assert.ok(body.sessions.every((s) => s.project === 'PMAID-GPPH'), '会话命中必须都在被筛项目内');
    assert.deepEqual(body.projects.map((p) => p.project).sort(), ['PMAID', 'PMAID-GPPH'],
      '项目结果不受 project 限制（否则筛着 GPPH 就没法切到别的项目）');
  });
});
