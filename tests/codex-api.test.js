import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRouter } from '../src/api/routes.js';

// Codex 现在是一个普通实例（harness='codex'）：这里覆盖「添加实例」与「深链跳转」两条路由，
// 重点是不变量 —— 只读、只接受已注册的 Codex home 与 UUID thread、沿用同站写保护。

const THREAD_ID = '01a0b7eb-4434-7712-bfe7-1e95bc79b266';
const CODEX_HOME_ID = 'ab'.repeat(8);

function codexHome(overrides = {}) {
  return { homeId: CODEX_HOME_ID, homePath: '/mock/codex', alias: 'Codex', hostType: 'local', harness: 'codex', ...overrides };
}

function makeRouter({ store = {}, indexer = {}, monitor = {}, codex = null } = {}) {
  return createRouter({
    store: {
      getHome: () => null,
      listHomes: () => [],
      listWorkspaces: () => [],
      getSession: () => null,
      registerHome: () => 'newhome',
      ...store,
    },
    indexer: { reindexNow: async () => [{}], ...indexer },
    hub: { broadcast() {} },
    launcher: { disconnect: async () => {} },
    monitor: { get: () => ({ runtime: 'running' }), refresh: async () => ({}), ...monitor },
    quota: { list: () => [], refresh: async () => [] },
    logApi: { getLogs: () => [] },
    codex,
  });
}

async function request(route, method, pathname, { headers = {}, body } = {}) {
  const result = { status: null, body: null };
  const req = {
    method,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield typeof body === 'string' ? body : JSON.stringify(body);
    },
  };
  const res = {
    setHeader() {},
    writeHead(status) { result.status = status; },
    end(raw) { result.body = raw ? JSON.parse(raw) : null; },
  };
  await route(req, res, new URL(`http://127.0.0.1:4310${pathname}`));
  return result;
}

test('POST /api/codex/open：按 homeId 解析项目/会话并派发深链', async () => {
  const home = codexHome();
  const calls = [];
  const route = makeRouter({
    store: { listHomes: () => [home], getHome: (id) => (id === home.homeId ? home : null) },
    codex: {
      resolveThreadId: (h, { threadId, projectId }) => {
        calls.push(['resolve', h.homeId, threadId, projectId]);
        if (threadId && !/^[0-9a-f-]{36}$/i.test(threadId)) throw new Error('无效的 Codex threadId');
        return threadId || (projectId === 'proj-renji' ? THREAD_ID : null);
      },
      openThread: async (threadId) => { calls.push(['open', threadId]); return { ok: true, threadId, url: `codex://threads/${threadId}` }; },
    },
  });

  // 会话行：带 threadId
  const byThread = await request(route, 'POST', '/api/codex/open', { body: { homeId: home.homeId, threadId: THREAD_ID } });
  assert.equal(byThread.status, 200);
  assert.equal(byThread.body.ok, true);
  assert.deepEqual(calls[calls.length - 1], ['open', THREAD_ID]);

  // 项目行：只带 workspaceId（= Codex project id），服务端解析成最近会话
  calls.length = 0;
  const byProject = await request(route, 'POST', '/api/codex/open', { body: { homeId: home.homeId, projectId: 'proj-renji' } });
  assert.equal(byProject.status, 200);
  assert.deepEqual(calls, [['resolve', home.homeId, undefined, 'proj-renji'], ['open', THREAD_ID]]);

  // 实例卡：什么都不带 → 该实例最近一条会话
  calls.length = 0;
  await request(route, 'POST', '/api/codex/open', { body: { homeId: home.homeId } });
  assert.deepEqual(calls[0], ['resolve', home.homeId, undefined, undefined]);
});

test('POST /api/codex/open：非 Codex 实例 / 多个 Codex 实例缺 homeId / 无目标都明确报错', async () => {
  const dshHome = { homeId: 'cd'.repeat(8), homePath: '/mock/dsh', harness: 'dsh', hostType: 'local' };
  let opened = 0;
  const service = {
    resolveThreadId: () => null,
    openThread: async () => { opened += 1; return { ok: true }; },
  };

  const routeNonCodex = makeRouter({
    store: { listHomes: () => [dshHome], getHome: () => dshHome },
    codex: service,
  });
  const notCodex = await request(routeNonCodex, 'POST', '/api/codex/open', { body: { homeId: dshHome.homeId, threadId: THREAD_ID } });
  assert.equal(notCodex.status, 404);
  assert.match(notCodex.body.error, /不是 Codex 实例/);

  const routeMany = makeRouter({
    store: { listHomes: () => [codexHome({ homeId: 'aa'.repeat(8) }), codexHome({ homeId: 'bb'.repeat(8) })] },
    codex: service,
  });
  const ambiguous = await request(routeMany, 'POST', '/api/codex/open', { body: {} });
  assert.equal(ambiguous.status, 400);
  assert.match(ambiguous.body.error, /多个 Codex 实例/);

  const routeNoTarget = makeRouter({
    store: { listHomes: () => [codexHome()], getHome: () => codexHome() },
    codex: service,
  });
  const noTarget = await request(routeNoTarget, 'POST', '/api/codex/open', { body: { homeId: CODEX_HOME_ID, projectId: 'unknown' } });
  assert.equal(noTarget.status, 400);
  assert.match(noTarget.body.error, /缺少可跳转/);
  assert.equal(opened, 0);
});

test('POST /api/codex/open：非法 threadId 400，且不调用 openThread', async () => {
  const home = codexHome();
  let opened = 0;
  const route = makeRouter({
    store: { listHomes: () => [home], getHome: () => home },
    codex: {
      resolveThreadId: (_home, { threadId }) => {
        if (threadId && !/^[0-9a-f-]{36}$/i.test(threadId)) throw new Error('无效的 Codex threadId');
        return threadId;
      },
      openThread: async () => { opened += 1; return { ok: true }; },
    },
  });
  const result = await request(route, 'POST', '/api/codex/open', { body: { homeId: home.homeId, threadId: '../../etc/passwd' } });
  assert.equal(result.status, 400);
  assert.match(result.body.error, /无效/);
  assert.equal(opened, 0);
});

test('Codex 跳转沿用同站写保护：跨站请求 403；未注入数据源 503', async () => {
  const home = codexHome();
  let opened = 0;
  const route = makeRouter({
    store: { listHomes: () => [home], getHome: () => home },
    codex: { resolveThreadId: () => THREAD_ID, openThread: async () => { opened += 1; return { ok: true }; } },
  });
  const crossSite = await request(route, 'POST', '/api/codex/open', {
    headers: { 'sec-fetch-site': 'cross-site' },
    body: { homeId: home.homeId, threadId: THREAD_ID },
  });
  assert.equal(crossSite.status, 403);
  assert.equal(opened, 0);

  const noService = await request(makeRouter({ codex: null }), 'POST', '/api/codex/open', { body: { homeId: home.homeId } });
  assert.equal(noService.status, 503);
});

test('POST /api/homes：harness=codex 只注册本机只读实例并立即索引', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwb-codex-register-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'state_5.sqlite'), '');

  let registered = null;
  let indexed = null;
  const route = makeRouter({
    store: { registerHome: (args) => { registered = args; return 'ab'.repeat(8); } },
    indexer: { reindexNow: async (homeId) => { indexed = homeId; return [{ homeId, ok: true, harness: 'codex' }]; } },
  });

  const result = await request(route, 'POST', '/api/homes', {
    body: { harness: 'codex', homePath: dir, alias: '我的 Codex' },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.harness, 'codex');
  assert.equal(result.body.warning, null);
  assert.deepEqual(registered, { homePath: dir, alias: '我的 Codex', hostType: 'local', harness: 'codex' });
  assert.equal(indexed, 'ab'.repeat(8));

  // 路径不存在 → 400，不落库
  registered = null;
  const missing = await request(route, 'POST', '/api/homes', { body: { harness: 'codex', homePath: '/definitely/missing' } });
  assert.equal(missing.status, 400);
  assert.equal(registered, null);
});

test('GET /api/homes/detect 同时返回 dsh 与 Codex 默认 home', async () => {
  const route = makeRouter({});
  const result = await request(route, 'GET', '/api/homes/detect');
  assert.equal(result.status, 200);
  assert.equal(typeof result.body.exists, 'boolean');
  assert.equal(typeof result.body.codex?.path, 'string');
  assert.ok(result.body.codex.path.endsWith('.codex'));
  assert.equal(typeof result.body.codex.exists, 'boolean');
});
