import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRouter } from '../src/api/routes.js';
import { createApiServer } from '../src/api/server.js';
import { IndexStore } from '../src/dshhome/store.js';
import { initLogger, getLogs } from '../src/lib/logger.js';

// GET /api/sessions/recent 与 /api/search 的「人工介入」契约：
//   ① 传入 interventions（PendingInteractionWatcher 的 apply）时，session 行带上顶层
//      `intervention` 字段；没有介入的行**逐字段不变**；
//   ② 未传 interventions（旧测试/嵌入场景）时，响应形状与本特性不存在时完全一致
//      —— 顶层没有 intervention 字段，投影来源的介入仍只在 session.status.intervention 里；
//   ③ 合并是**附加信息**：查询只发一次、条数与顺序不变、truncated 语义不变；
//   ④ 合并失败/返回坏值时降级为原样返回并只记 warn，绝不能变成 500（列表是首屏主视图）。
//
// 覆盖层本身（WS 帧 → intervention）由 dshhome/pending-interactions.js 的单测覆盖；
// 这里用假 apply 只验证**接线**与**降级语义**，不重复实现合并规则。

// 单测里 warn 不该刷终端；「降级」那条用它自己的日志环断言（getLogs）。
initLogger({ level: 'info', file: false, color: false, silent: true });

const HOME_ID = 'abcdef1234567890';
const NOW = '2026-10-27T06:00:00.000Z';

// 与 store.hydrateSessionRow 同形的行（recentSessions 与 searchAll 逐字段同构）。
const row = (sessionId, title = `会话 ${sessionId}`, extra = {}) => ({
  homeId: HOME_ID,
  sessionId,
  workspaceId: `w-${sessionId}`,
  workspaceTitle: 'hwb',
  project: 'hwb',
  title,
  tokenUsage: null,
  contextPressure: null,
  status: { kind: 'idle', label: '空闲' },
  lastActivity: '2026-10-27T05:00:00.000Z',
  ...extra,
});

const liveApproval = (overrides = {}) => ({
  kind: 'approval',
  label: '等待审批',
  source: 'live',
  since: NOW,
  tool: 'Bash',
  reason: '需要批准：rm -rf build',
  count: 1,
  ...overrides,
});

// 假覆盖层：只给指定 sessionId 加 intervention，其它行原样返回（模拟 watcher.apply 的契约：
// 不修改入参、返回新数组、条数与顺序不变）。
function fakeWatcher(overrides = {}) {
  return {
    calls: [],
    apply(rows) {
      this.calls.push(rows);
      return rows.map((r) => (Object.hasOwn(overrides, r.sessionId)
        ? { ...r, intervention: overrides[r.sessionId] }
        : r));
    },
  };
}

function makeRouter({ rows = [], search = null, calls = { recent: [], search: [] }, interventions = null, running = true } = {}) {
  return createRouter({
    store: {
      listHomes: () => [{ homeId: HOME_ID }],
      getHome: () => null,
      recentProjects: () => [],
      recentSessions: (args) => { calls.recent.push(args); return rows; },
      searchAll: (args) => {
        calls.search.push(args);
        return search ?? {
          projects: [{ project: 'hwb', sessionCount: 1 }],
          sessions: rows,
          truncated: { projects: false, sessions: false },
        };
      },
      listWorkspaces: () => [],
      getSession: () => null,
    },
    indexer: { reindexNow: async () => [] },
    hub: { broadcast() {}, handle() {} },
    launcher: { status: () => null },
    monitor: { get: () => ({ runtime: running ? 'running' : 'stopped' }) },
    quota: { list: () => [] },
    logApi: { getLogs: () => [] },
    interventions,
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

// —— ① 合入：有介入的行带字段，无介入的行逐字段不变 ——
test('GET /api/sessions/recent：介入行带上顶层 intervention，其它行不变', async () => {
  const original = [row('s-wait', '等我审批'), row('s-idle', '空闲会话')];
  const watcher = fakeWatcher({ 's-wait': liveApproval() });
  const calls = { recent: [], search: [] };
  const res = await request(
    makeRouter({ rows: original, calls, interventions: watcher }),
    'GET',
    '/api/sessions/recent',
  );
  assert.equal(res.status, 200);
  assert.equal(calls.recent.length, 1, '查询只发一次（覆盖层不是第二次查询）');
  assert.equal(res.body.sessions.length, 2, '条数不变');
  assert.deepEqual(res.body.sessions.map((s) => s.sessionId), ['s-wait', 's-idle'], '顺序不变');
  assert.deepEqual(res.body.sessions[0].intervention, liveApproval(), '介入行带完整契约字段');
  // 无介入的行：与 store 给的原行**逐字段相同**（没有多出 intervention: undefined 之类的字段）。
  assert.deepEqual(res.body.sessions[1], original[1]);
  assert.equal(Object.hasOwn(res.body.sessions[1], 'intervention'), false);
  assert.equal(res.body.truncated, false);
});

// —— ② 未传 watcher：形状与旧版本完全一致 ——
test('未传 interventions 时响应形状不变（旧测试/嵌入调用方）', async () => {
  const original = [row('s-wait', '等我审批'), row('s-idle', '空闲会话')];
  for (const interventions of [undefined, null, {}]) {
    const res = await request(
      makeRouter({ rows: original, interventions }),
      'GET',
      '/api/sessions/recent',
    );
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { sessions: original, truncated: false });
    assert.ok(res.body.sessions.every((s) => !Object.hasOwn(s, 'intervention')),
      '没有覆盖层时不应凭空出现顶层 intervention 字段');
  }
});

// —— ③ project 分支（limit+1 探测截断）：介入合入不影响 truncated/切片 ——
test('GET /api/sessions/recent?project=：介入合入不影响 truncated 与 limit 切片', async () => {
  const rows = Array.from({ length: 11 }, (_, i) => row(`p${i}`, `项目会话 ${i}`));
  const watcher = fakeWatcher({ p0: liveApproval({ kind: 'approval' }), p10: liveApproval() });
  const calls = { recent: [], search: [] };
  const res = await request(
    makeRouter({ rows, calls, interventions: watcher }),
    'GET',
    '/api/sessions/recent?project=hwb&limit=10',
  );
  assert.equal(res.status, 200);
  assert.equal(calls.recent.length, 1);
  assert.deepEqual(calls.recent[0].limit, 11, '仍是 limit + 1（多取一行的截断探测）');
  assert.equal(watcher.calls.length, 1, '覆盖层只被调用一次');
  assert.equal(watcher.calls[0].length, 11, '覆盖层看到的是查询原始行（切片前）');
  assert.equal(res.body.sessions.length, 10, '响应最多 limit 条');
  assert.equal(res.body.truncated, true, '多出来的那一行仍说明「还有更多」');
  assert.deepEqual(res.body.sessions[0].intervention, liveApproval());
  assert.equal(Object.hasOwn(res.body.sessions[9], 'intervention'), false, '未命中的行不受影响');
  // 第 11 行被切片丢掉，但截断判定没有被覆盖层干扰（truncated 由原始行数决定）。
  assert.equal(res.body.sessions.some((s) => s.sessionId === 'p10'), false);
});

// —— ④ /api/search：只合入 sessions，projects/truncated 原样透出 ——
test('GET /api/search：sessions 同样合入介入，projects 与 truncated 不变', async () => {
  const sessions = [row('s-wait', '等我审批'), row('s-idle', '空闲会话')];
  const search = {
    projects: [{ project: 'hwb', sessionCount: 2 }],
    sessions,
    truncated: { projects: true, sessions: true },
  };
  const watcher = fakeWatcher({ 's-wait': liveApproval() });
  const calls = { recent: [], search: [] };
  const res = await request(
    makeRouter({ search, calls, interventions: watcher }),
    'GET',
    '/api/search?q=%E5%AE%A1%E6%89%B9',
  );
  assert.equal(res.status, 200);
  assert.equal(calls.search.length, 1, '查询只发一次');
  assert.deepEqual(res.body.projects, search.projects, '项目结果原样透出');
  assert.deepEqual(res.body.truncated, search.truncated, '截断标志原样透出（不受覆盖层影响）');
  assert.deepEqual(res.body.sessions[0].intervention, liveApproval());
  assert.deepEqual(res.body.sessions[1], sessions[1], '无介入行逐字段不变');
});

// —— ⑤ 降级：apply 抛错/返回坏值 → 200 + 原行 + 一条 warn（绝不 500） ——
test('覆盖层抛错时降级为未标记行并只记 warn（不 500）', async () => {
  const original = [row('s-wait', '等我审批')];
  const before = getLogs({ level: 'warn' }).length;
  const res = await request(
    makeRouter({
      rows: original,
      interventions: { apply() { throw new Error('ws 断开（http://127.0.0.1:9/?token=SECRET）'); } },
    }),
    'GET',
    '/api/sessions/recent',
  );
  assert.equal(res.status, 200, '介入标记是附加信息，坏了也不能让列表 500');
  assert.deepEqual(res.body, { sessions: original, truncated: false });
  const warns = getLogs({ level: 'warn' }).slice(before);
  const entry = warns.find((e) => e.message.includes('合并实时介入状态失败'));
  assert.ok(entry, '必须留下一条 warn 便于排查');
  assert.equal(warns.filter((e) => e.message.includes('合并实时介入状态失败')).length, 1, '一次失败一条，不刷屏');
  assert.equal(JSON.stringify(entry).includes('SECRET'), false, '日志不得带出 token');
  assert.equal(JSON.stringify(entry).includes('127.0.0.1'), false, '日志不得带出实例 URL');
});

test('覆盖层返回非数组时按「未标记」处理（防御性降级）', async () => {
  const original = [row('s-wait', '等我审批')];
  for (const bad of [undefined, null, 'nope', 42, {}]) {
    const res = await request(
      makeRouter({ rows: original, interventions: { apply: () => bad } }),
      'GET',
      '/api/sessions/recent',
    );
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { sessions: original, truncated: false });
  }
});

// —— ⑥ 真 watcher（不建连）：验证 routes 与 dshhome/pending-interactions.js 的 apply 契约一致 ——
// 这里只实例化、调 apply、stop，不 sync（因此不会开任何 WS）；目的是防「接口漂移」：
// 真实 watcher 会把 status.intervention（投影推导）折叠到顶层，routes 必须原样带出。
test('真 PendingInteractionWatcher.apply 的合并结果被 routes 原样带出', async () => {
  const { PendingInteractionWatcher } = await import('../src/dshhome/pending-interactions.js');
  const watcher = new PendingInteractionWatcher({ broadcast: () => {} });
  try {
    const rows = [
      row('s-proj', '等回答', {
        status: {
          kind: 'idle',
          label: '空闲',
          intervention: {
            kind: 'question', label: '等待回答', source: 'projection',
            since: null, tool: null, reason: '选哪个环境？', count: 1,
          },
        },
      }),
      row('s-idle', '空闲会话'),
    ];
    const res = await request(
      makeRouter({ rows, interventions: watcher }),
      'GET',
      '/api/sessions/recent',
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.sessions[0].intervention.kind, 'question');
    assert.equal(res.body.sessions[0].intervention.source, 'projection');
    assert.equal(res.body.sessions[0].status.intervention.kind, 'question', 'status 原样保留');
    assert.equal(Object.hasOwn(res.body.sessions[1], 'intervention'), false);
  } finally {
    watcher.stop();
  }
});

// —— ⑦ 端到端（真 IndexStore + 真 HTTP）：createApiServer 确实把 interventions 透传到 router ——
function seedStore() {
  const store = new IndexStore(':memory:');
  const online = store.registerHome({ homePath: '/mock/online-home' });
  const ins = store.db.prepare(
    `INSERT INTO sessions (homeId, sessionId, project, workspaceTitle, title, lastActivity, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  // 投影来源（持久）：会话在等回答 —— 落在 status JSON 里，由投影推导写入。
  ins.run(online, 's-projection', 'hwb', 'hwb', '等回答的会话',
    new Date().toISOString(),
    JSON.stringify({
      kind: 'idle',
      label: '空闲',
      intervention: {
        kind: 'question', label: '等待回答', source: 'projection',
        since: null, tool: null, reason: '选哪个环境？', count: 1,
      },
    }));
  // 没有介入的普通会话。
  ins.run(online, 's-idle', 'hwb', 'hwb', '普通会话',
    new Date(Date.now() - 60_000).toISOString(),
    JSON.stringify({ kind: 'idle', label: '空闲' }));
  return { store, online };
}

async function withApiServer(fn, { interventions } = {}) {
  const { store } = seedStore();
  const server = createApiServer({
    store,
    indexer: { reindexNow: async () => [] },
    hub: { broadcast() {}, handle() {} },
    launcher: { status: () => null },
    monitor: { get: () => ({ runtime: 'running' }) },
    quota: { list: () => [] },
    logApi: { getLogs: () => [] },
    webRoot: '/nonexistent-web-root',
    ...(interventions ? { interventions } : {}),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ base });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  }
}

test('api: createApiServer 透传 interventions（recent 与 search 都合入到顶层）', async () => {
  const watcher = fakeWatcher({ 's-projection': liveApproval() });
  await withApiServer(async ({ base }) => {
    const recent = await (await fetch(`${base}/api/sessions/recent`)).json();
    const waiting = recent.sessions.find((s) => s.sessionId === 's-projection');
    assert.deepEqual(waiting.intervention, liveApproval(), '实时覆盖层优先于投影（live > projection）');
    // 覆盖层由 watcher 自己合并 status.intervention，routes 不做二次合并 —— 这里只断言
    // routes 把 apply 的结果原样带出、没有改动其它字段。
    assert.equal(recent.sessions.find((s) => s.sessionId === 's-idle').intervention, undefined);

    const searched = await (await fetch(`${base}/api/search?q=%E5%9B%9E%E7%AD%94`)).json();
    assert.ok(searched.sessions.some((s) => s.sessionId === 's-projection'));
    const hit = searched.sessions.find((s) => s.sessionId === 's-projection');
    assert.deepEqual(hit.intervention, liveApproval());
  }, { interventions: watcher });
});

test('api: 未传 interventions 时端到端形状不变（投影介入只留在 status 里）', async () => {
  await withApiServer(async ({ base }) => {
    const recent = await (await fetch(`${base}/api/sessions/recent`)).json();
    assert.equal(recent.sessions.length, 2);
    const waiting = recent.sessions.find((s) => s.sessionId === 's-projection');
    assert.equal(Object.hasOwn(waiting, 'intervention'), false,
      '没有实时覆盖层时不在顶层加字段（投影来源仍在 status.intervention 里）');
    assert.equal(waiting.status.intervention.kind, 'question', '投影来源的字段没有被丢掉');
  });
});
