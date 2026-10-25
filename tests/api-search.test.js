import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRouter } from '../src/api/routes.js';
import { createApiServer } from '../src/api/server.js';
import { IndexStore } from '../src/dshhome/store.js';

// GET /api/search 的契约：
// ① 参数解析/夹取（projectLimit / sessionLimit 有上下界，q 缺失当空串）；
// ② homeIds 只来自 dataHomeIds()（运行中的实例），调用方不能借它读未连接实例的索引；
// ③ 只读：只接受 GET；
// ④ 端到端：7 天窗口之外的旧项目确实能从 HTTP 接口搜到（这就是修 GPPH 搜不到的那条路）。

const HOME_ID = 'abcdef1234567890';

function makeRouter({ calls = [], homes = [{ homeId: HOME_ID }], running = true } = {}) {
  return createRouter({
    store: {
      listHomes: () => homes,
      getHome: () => null,
      searchAll: (args) => {
        calls.push(args);
        return { projects: [], sessions: [], truncated: { projects: false, sessions: false } };
      },
      recentProjects: () => [],
      recentSessions: () => [],
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

test('GET /api/search: 默认参数与 homeIds 作用域', async () => {
  const calls = [];
  const route = makeRouter({ calls });
  const res = await request(route, 'GET', '/api/search?q=GPPH');
  assert.equal(res.status, 200);
  assert.deepEqual(calls, [{ q: 'GPPH', homeIds: [HOME_ID], projectLimit: 20, sessionLimit: 50, project: null }]);
  assert.deepEqual(res.body, { projects: [], sessions: [], truncated: { projects: false, sessions: false } });
});

test('GET /api/search: project 参数原样传给 store（项目筛选下的补搜作用域）', async () => {
  const calls = [];
  await request(makeRouter({ calls }), 'GET', '/api/search?q=GPPH&project=%20PMAID-GPPH%20');
  assert.equal(calls[0].project, 'PMAID-GPPH', '首尾空白去掉；项目名是精确等值条件');
  const blank = [];
  await request(makeRouter({ calls: blank }), 'GET', '/api/search?q=GPPH&project=%20%20');
  assert.equal(blank[0].project, null, '只有空白等于没传（不能被当成空项目名去匹配）');
});

test('GET /api/search: 查询参数有上下界（防 1e9 / 0 / 非数字）', async () => {
  const cases = [
    ['', 20, 50],
    ['?q=x&projectLimit=9999&sessionLimit=9999', 100, 200],
    ['?q=x&projectLimit=0&sessionLimit=-3', 1, 1],
    ['?q=x&projectLimit=abc&sessionLimit=1e9', 20, 200],
  ];
  for (const [qs, expectedProject, expectedSession] of cases) {
    const calls = [];
    await request(makeRouter({ calls }), 'GET', `/api/search${qs}`);
    assert.equal(calls[0].projectLimit, expectedProject, `projectLimit 夹取失败：${qs}`);
    assert.equal(calls[0].sessionLimit, expectedSession, `sessionLimit 夹取失败：${qs}`);
  }
});

test('GET /api/search: 没有运行中实例时 homeIds 为空（不搜未连接实例的数据）', async () => {
  const calls = [];
  await request(makeRouter({ calls, running: false }), 'GET', '/api/search?q=GPPH');
  assert.deepEqual(calls[0].homeIds, []);
});

test('POST /api/search 不存在（搜索是只读接口，不提供写入口）', async () => {
  const calls = [];
  const res = await request(makeRouter({ calls }), 'POST', '/api/search?q=GPPH');
  assert.equal(res.status, 404);
  assert.deepEqual(calls, [], 'POST 不应触达 store.searchAll');
});

// —— 端到端：真 IndexStore + 真 HTTP 服务 ——
// 直接造一条 32 天前的旧会话：/api/projects/recent 看不到它，但 /api/search 必须能搜到。
function seedStore() {
  const store = new IndexStore(':memory:');
  const dsh = store.registerHome({ homePath: '/mock/dsh-home' });
  const offline = store.registerHome({ homePath: '/mock/offline-home' });
  const insert = store.db.prepare(
    `INSERT INTO sessions (homeId, sessionId, project, workspaceTitle, title, lastActivity)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  insert.run(dsh, 's-old-gpph', 'PMAID-GPPH', 'PMAID-GPPH', '按临床表型分类设计 GPPH 提示词',
    new Date(Date.now() - 32 * 86_400_000).toISOString());
  insert.run(offline, 's-offline-gpph', 'OFFLINE-GPPH', 'OFFLINE-GPPH', '未连接实例的会话',
    new Date(Date.now() - 3 * 86_400_000).toISOString());
  return { store, dsh, offline };
}

async function withApiServer(fn) {
  const { store, dsh, offline } = seedStore();
  const server = createApiServer({
    store,
    indexer: { reindexNow: async () => [] },
    hub: { broadcast() {}, handle() {} },
    launcher: { status: () => null },
    // offline 实例故意标成 stopped：它已被索引但未连接，/api/search 不应返回它的数据。
    monitor: { get: (homeId) => ({ runtime: homeId === dsh ? 'running' : 'stopped' }) },
    quota: { list: () => [] },
    logApi: { getLogs: () => [] },
    webRoot: '/nonexistent-web-root',
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ base, store, dsh, offline });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  }
}

test('api: 7 天窗口外的旧项目能通过 /api/search 搜到（端到端）', async () => {
  await withApiServer(async ({ base }) => {
    // 前置：最近项目（7 天窗口）里没有它 —— 与用户看到的 0/20 一致。
    const recent = await (await fetch(`${base}/api/projects/recent`)).json();
    assert.equal(recent.projects.some((p) => p.project === 'PMAID-GPPH'), false);

    const res = await fetch(`${base}/api/search?q=GPPH`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(body.projects.map((p) => p.project), ['PMAID-GPPH']);
    assert.equal(body.projects[0].sessionCount, 1);
    assert.deepEqual(body.sessions.map((s) => s.sessionId), ['s-old-gpph']);
    // 未连接实例的数据不出现（dataHomeIds 的「运行中」口径）。
    assert.equal(body.sessions.some((s) => s.sessionId === 's-offline-gpph'), false);
  });
});

test('api: /api/search 空 q 返回空结果而不是 500/全量扫描', async () => {
  await withApiServer(async ({ base }) => {
    for (const path of ['/api/search', '/api/search?q=', '/api/search?q=%20%20']) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 200, path);
      const body = await res.json();
      assert.deepEqual(body.projects, [], path);
      assert.deepEqual(body.sessions, [], path);
      assert.deepEqual(body.truncated, { projects: false, sessions: false });
    }
  });
});
