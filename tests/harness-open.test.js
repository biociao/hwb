import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRouter } from '../src/api/routes.js';
import { openDshApp } from '../src/lib/open-session.js';
import { initLogger } from '../src/lib/logger.js';

// 统一本地工具跳转：POST /api/harness/open（契约 §4.2）。
//
// 这个接口是无鉴权的本机 API，「打开」= 把任意输入拼进一个交给桌面端的深链 URL。
// 因此这组测试的重点是不变量，而不只是 happy path：
//   · 未知 home → 404；非本地工具 → 400；跨站写 → 403；
//   · 深链 id 必须由数据面按 UUID 白名单校验（非法 → 400，且**绝不调用 open**）；
//   · 本地只读 dsh 在无会话/插件缺失时退化成「聚焦 DSH 桌面端」（200 + code:'app-focused'），
//     而不是拿非法会话 id 去写触发器；
//   · 响应里不出现实例 token（本机接口回给浏览器的东西里不该有控制凭据）。

initLogger({ level: 'error', file: false, color: false, silent: true });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const THREAD = '01a0b7eb-4434-7712-bfe7-1e95bc79b266';
const WB_SESSION = '8d13a377-25e2-4732-9064-806d409c0e69';
const CODEX_HOME_ID = 'ab'.repeat(8);
const WB_HOME_ID = 'bc'.repeat(8);
const DSH_HOME_ID = 'cd'.repeat(8);

function localToolHome(harness, homeId = harness === 'codex' ? CODEX_HOME_ID : WB_HOME_ID) {
  return { homeId, homePath: `/mock/${harness}`, alias: harness, hostType: 'local', harness };
}

function readOnlyDshHome(overrides = {}) {
  return {
    homeId: DSH_HOME_ID, homePath: '/mock/dsh', alias: 'DSH 只读', hostType: 'local',
    harness: 'dsh', readOnly: true, current: null, token: 'SUPER-SECRET-TOKEN', ...overrides,
  };
}

function makeRouter({ store = {}, localTools, openSession, openDshApp, dshVersion = null, hub = null } = {}) {
  return createRouter({
    store: {
      getHome: () => null,
      listHomes: () => [],
      listWorkspaces: () => [],
      getSession: () => null,
      recentProjects: () => [],
      recentSessions: () => [],
      ...store,
    },
    indexer: { reindexNow: async () => [{}] },
    hub: hub ?? { broadcast() {} },
    launcher: { disconnect: async () => {} },
    monitor: { get: () => ({ runtime: 'running' }), refresh: async () => ({}) },
    quota: { list: () => [], refresh: async () => [] },
    logApi: { getLogs: () => [] },
    dshVersion,
    ...(localTools !== undefined ? { localTools } : {}),
    ...(openSession ? { openSession } : {}),
    ...(openDshApp ? { openDshApp } : {}),
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

function fakeSource({ resolveTarget, open }) {
  const calls = [];
  return {
    calls,
    source: {
      label: 'Fake',
      readSnapshot: async () => ({ generatedAt: new Date().toISOString() }),
      indexRows: () => [],
      resolveTarget: async (home, options) => {
        calls.push(['resolve', home.homeId, options]);
        return resolveTarget(home, options);
      },
      open: async (sessionId, options) => {
        calls.push(['open', sessionId, options]);
        return open(sessionId, options);
      },
    },
  };
}

test('POST /api/harness/open：未知 home 404、非本地工具 400、跨站写 403', async () => {
  const connectedDsh = { homeId: DSH_HOME_ID, homePath: '/mock/dsh', harness: 'dsh', hostType: 'local', readOnly: false };

  const unknown = await request(makeRouter({}), 'POST', '/api/harness/open', { body: { homeId: 'ff'.repeat(8) } });
  assert.equal(unknown.status, 404);
  assert.match(unknown.body.error, /unknown homeId/);

  const nonLocal = await request(makeRouter({
    store: { getHome: (id) => (id === DSH_HOME_ID ? connectedDsh : null) },
  }), 'POST', '/api/harness/open', { body: { homeId: DSH_HOME_ID } });
  assert.equal(nonLocal.status, 400);
  assert.match(nonLocal.body.error, /只有本地工具实例/);

  const crossSite = await request(makeRouter({
    store: { getHome: () => localToolHome('codex') },
  }), 'POST', '/api/harness/open', {
    headers: { 'sec-fetch-site': 'cross-site' },
    body: { homeId: CODEX_HOME_ID },
  });
  assert.equal(crossSite.status, 403);
});

test('POST /api/harness/open：Codex 由数据面解析 sessionId 并派发深链', async () => {
  const home = localToolHome('codex');
  const { calls, source } = fakeSource({
    resolveTarget: (_home, { sessionId, projectId }) => {
      if (sessionId && !UUID_RE.test(sessionId)) throw new Error('无效的 Codex 会话 id');
      return sessionId || (projectId === 'proj-renji' ? THREAD : null);
    },
    open: async (sessionId) => ({ ok: true, sessionId, url: `codex://threads/${sessionId}` }),
  });
  const route = makeRouter({
    store: { getHome: (id) => (id === home.homeId ? home : null) },
    localTools: { codex: source },
  });

  // 会话行：显式 sessionId
  const bySession = await request(route, 'POST', '/api/harness/open', {
    body: { homeId: home.homeId, sessionId: THREAD },
  });
  assert.equal(bySession.status, 200);
  assert.deepEqual(bySession.body, {
    ok: true, homeId: home.homeId, harness: 'codex', sessionId: THREAD, url: `codex://threads/${THREAD}`,
  });
  assert.deepEqual(calls, [['resolve', home.homeId, { sessionId: THREAD, projectId: undefined }], ['open', THREAD, undefined]]);

  // 项目行：只带 projectId，数据面解析成最近会话
  const byProject = await request(route, 'POST', '/api/harness/open', {
    body: { homeId: home.homeId, projectId: 'proj-renji' },
  });
  assert.equal(byProject.status, 200);
  assert.equal(byProject.body.sessionId, THREAD);
});

test('POST /api/harness/open：成功打开 Codex 即清未读并广播；唤起失败不清', async () => {
  const home = localToolHome('codex');
  const viewed = [];
  const broadcasts = [];
  let openOk = true;
  const { source } = fakeSource({
    resolveTarget: (_home, { sessionId }) => sessionId,
    open: async (sessionId) => ({ ok: openOk, sessionId, url: `codex://threads/${sessionId}` }),
  });
  const route = makeRouter({
    store: {
      getHome: () => home,
      markSessionViewed: (homeId, sessionId) => { viewed.push([homeId, sessionId]); return true; },
    },
    localTools: { codex: source },
    hub: { broadcast: (event, data) => broadcasts.push([event, data]) },
  });

  const ok = await request(route, 'POST', '/api/harness/open', { body: { homeId: home.homeId, sessionId: THREAD } });
  assert.equal(ok.status, 200);
  assert.deepEqual(viewed, [[home.homeId, THREAD]], '打开成功 = 已读');
  assert.deepEqual(broadcasts, [['index:updated', { homeId: home.homeId, reason: 'session-viewed' }]],
    '必须广播刷新，否则前端要等下一次索引才掉「未读」');

  // 唤起失败（502）：不能把没看到的会话标成已读，也不该广播。
  openOk = false;
  const failed = await request(route, 'POST', '/api/harness/open', { body: { homeId: home.homeId, sessionId: THREAD } });
  assert.equal(failed.status, 502);
  assert.equal(viewed.length, 1, '唤起失败不标记已读');
  assert.equal(broadcasts.length, 1);
});

test('POST /api/harness/open：非法会话 id 400 且绝不调用 open（深链白名单）', async () => {
  const home = localToolHome('codex');
  const { calls, source } = fakeSource({
    resolveTarget: (_home, { sessionId }) => {
      if (sessionId && !UUID_RE.test(sessionId)) throw new Error('无效的 Codex 会话 id');
      return sessionId;
    },
    open: async (sessionId) => ({ ok: true, sessionId, url: `codex://threads/${sessionId}` }),
  });
  const route = makeRouter({ store: { getHome: () => home }, localTools: { codex: source } });

  for (const evil of ['../../etc/passwd', 'javascript:alert(1)', 'codex://threads/x?y=1', ' ', 'not-a-uuid']) {
    const result = await request(route, 'POST', '/api/harness/open', { body: { homeId: home.homeId, sessionId: evil } });
    assert.equal(result.status, 400, `非法 id 必须 400：${JSON.stringify(evil)}`);
    assert.ok(!calls.some((c) => c[0] === 'open'), `非法 id 不应调用 open：${JSON.stringify(evil)}`);
  }
});

test('POST /api/harness/open：目标解析不到 400；唤起失败 502（带可复制回退）', async () => {
  const home = localToolHome('workbuddy', WB_HOME_ID);
  const noTarget = fakeSource({ resolveTarget: () => null, open: async () => ({ ok: true }) });
  const routeNoTarget = makeRouter({ store: { getHome: () => home }, localTools: { workbuddy: noTarget.source } });
  const missing = await request(routeNoTarget, 'POST', '/api/harness/open', { body: { homeId: home.homeId, projectId: 'nope' } });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /缺少可跳转的 WorkBuddy 会话/);

  const noOpen = fakeSource({
    resolveTarget: () => WB_SESSION,
    open: async (sessionId) => ({
      ok: false, sessionId, url: `workbuddy://chat/${sessionId}`,
      fallback: `open "workbuddy://chat/${sessionId}"`, error: '未能唤起 WorkBuddy',
    }),
  });
  const routeNoOpen = makeRouter({ store: { getHome: () => home }, localTools: { workbuddy: noOpen.source } });
  const failed = await request(routeNoOpen, 'POST', '/api/harness/open', { body: { homeId: home.homeId } });
  assert.equal(failed.status, 502);
  assert.equal(failed.body.ok, false);
  assert.equal(failed.body.harness, 'workbuddy');
  assert.match(failed.body.fallback, /workbuddy:\/\/chat\//);
  assert.match(failed.body.error, /未能唤起/);
});

test('POST /api/harness/open：工作区缺失（数据面未启用）503', async () => {
  const home = localToolHome('workbuddy', WB_HOME_ID);
  const route = makeRouter({ store: { getHome: () => home }, localTools: {} });
  const result = await request(route, 'POST', '/api/harness/open', { body: { homeId: home.homeId } });
  assert.equal(result.status, 503);
  assert.match(result.body.error, /WorkBuddy 数据源未启用/);
});

test('POST /api/harness/open：dsh 只读有会话时走插件触发器（in-app）', async () => {
  const home = readOnlyDshHome({ current: { sessionId: 'sess-current' } });
  const calls = [];
  const route = makeRouter({
    store: { getHome: () => home },
    openSession: async ({ home: h, sessionId }) => {
      calls.push([h.homeId, sessionId]);
      return { ok: true, mode: 'in-app', focused: true, trigger: { id: 't1', sessionId, expiresAt: Date.now() + 1000 } };
    },
    openDshApp: async () => { throw new Error('不应在插件可用时聚焦 App'); },
  });

  const result = await request(route, 'POST', '/api/harness/open', { body: { homeId: home.homeId } });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.harness, 'dsh');
  assert.equal(result.body.sessionId, 'sess-current');
  assert.equal(result.body.mode, 'in-app');
  assert.deepEqual(calls, [[home.homeId, 'sess-current']]);

  // 显式 sessionId 优先于「最近会话」
  const explicit = await request(route, 'POST', '/api/harness/open', {
    body: { homeId: home.homeId, sessionId: 'sess-explicit' },
  });
  assert.equal(explicit.status, 200);
  assert.deepEqual(calls.at(-1), [home.homeId, 'sess-explicit']);
});

test('POST /api/harness/open：dsh 只读按 projectId 找该工作区的最近会话', async () => {
  const home = readOnlyDshHome({ current: { sessionId: 'sess-current' } });
  const calls = [];
  const route = makeRouter({
    store: {
      getHome: () => home,
      recentProjects: () => [
        { workspaceId: '/work/a', project: 'a', sessionId: 'sess-a' },
        { workspaceId: '/work/b', project: 'b', sessionId: 'sess-b' },
      ],
    },
    openSession: async ({ sessionId }) => { calls.push(sessionId); return { ok: true, mode: 'in-app' }; },
  });
  const result = await request(route, 'POST', '/api/harness/open', {
    body: { homeId: home.homeId, projectId: '/work/b' },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.sessionId, 'sess-b');
  assert.deepEqual(calls, ['sess-b']);
});

test('POST /api/harness/open：dsh 只读无会话/插件缺失 → 聚焦 DSH 桌面端（200 app-focused）', async () => {
  // 无会话：不写触发器，直接聚焦 App
  const emptyHome = readOnlyDshHome({ current: null });
  let opened = 0;
  const appCalls = [];
  const routeEmpty = makeRouter({
    store: { getHome: () => emptyHome },
    openSession: async () => { opened += 1; return { ok: true }; },
    openDshApp: async () => { appCalls.push('focus'); return { ok: true, mode: 'focus', appPath: '/Applications/DeepSeek Harness.app', focused: true }; },
  });
  const focused = await request(routeEmpty, 'POST', '/api/harness/open', { body: { homeId: emptyHome.homeId } });
  assert.equal(focused.status, 200);
  assert.deepEqual(focused.body, {
    ok: true,
    homeId: emptyHome.homeId,
    harness: 'dsh',
    sessionId: null,
    code: 'app-focused',
    note: '该实例还没有可跳转的会话，已聚焦 DSH 桌面端',
    mode: 'focus',
    focused: true,
  });
  assert.equal(opened, 0, '无会话时不应写触发器');
  assert.deepEqual(appCalls, ['focus']);

  // 插件缺失：有会话但桌面端没装插件 → 退化成聚焦 App
  const home = readOnlyDshHome({ current: { sessionId: 'sess-current' } });
  const routePluginMissing = makeRouter({
    store: { getHome: () => home },
    openSession: async () => ({ ok: false, code: 'plugin-missing', error: 'DSH desktop profile 未安装插件' }),
    openDshApp: async () => ({ ok: true, mode: 'launch', focused: false }),
  });
  const fallback = await request(routePluginMissing, 'POST', '/api/harness/open', { body: { homeId: home.homeId } });
  assert.equal(fallback.status, 200);
  assert.equal(fallback.body.ok, true);
  assert.equal(fallback.body.code, 'app-focused');
  assert.equal(fallback.body.sessionId, 'sess-current');
  assert.match(fallback.body.note, /dsh-hwb-open-session/);
});

test('POST /api/harness/open：非法 dsh 会话 id 400，不退化成聚焦 App', async () => {
  const home = readOnlyDshHome({ current: { sessionId: 'sess-current' } });
  let appCalled = 0;
  const route = makeRouter({
    store: { getHome: () => home },
    openSession: async ({ sessionId }) => {
      // 真实实现（openSessionInDsh）对非法 id 返回 bad-session-id；这里对齐其契约。
      if (!/^[A-Za-z0-9._:-]{1,200}$/.test(sessionId)) return { ok: false, code: 'bad-session-id', error: '无效的会话 ID' };
      return { ok: true };
    },
    openDshApp: async () => { appCalled += 1; return { ok: true }; },
  });
  const result = await request(route, 'POST', '/api/harness/open', {
    body: { homeId: home.homeId, sessionId: '../../etc/passwd' },
  });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'bad-session-id');
  assert.equal(appCalled, 0);
});

test('POST /api/harness/open：App 也唤不起时 502（平台/安装问题如实上报）', async () => {
  const home = readOnlyDshHome({ current: null });
  const route = makeRouter({
    store: { getHome: () => home },
    openDshApp: async () => ({ ok: false, code: 'app-missing', error: '未找到 DeepSeek Harness.app' }),
  });
  const result = await request(route, 'POST', '/api/harness/open', { body: { homeId: home.homeId } });
  assert.equal(result.status, 502);
  assert.equal(result.body.ok, false);
  assert.equal(result.body.code, 'app-missing');
  assert.match(result.body.error, /未找到/);
});

test('openDshApp：聚焦/启动 DSH 桌面端（app-focused 的底层实现）', async () => {
  // 非 macOS：不猜 xdg-open/start 的语义，如实回不支持
  assert.deepEqual(await openDshApp({ platform: 'linux' }), {
    ok: false, code: 'platform-unsupported', error: '仅 macOS 支持唤起 DSH 桌面端',
  });

  const appPath = '/Applications/DeepSeek Harness.app';
  const calls = [];
  const deps = {
    findDshAppPath: () => appPath,
    isDshAppRunning: async () => true,
    focusDshApp: async () => { calls.push(['focus']); },
    launchDshApp: async (p) => { calls.push(['launch', p]); },
  };
  const focused = await openDshApp({ platform: 'darwin', deps });
  assert.deepEqual(focused, { ok: true, mode: 'focus', appPath, focused: true });
  assert.deepEqual(calls, [['focus']]);

  calls.length = 0;
  const launched = await openDshApp({ platform: 'darwin', deps: { ...deps, isDshAppRunning: async () => false } });
  assert.deepEqual(launched, { ok: true, mode: 'launch', appPath, focused: false });
  assert.deepEqual(calls, [['launch', appPath]]);

  // 没装 App
  assert.deepEqual(await openDshApp({ platform: 'darwin', deps: { findDshAppPath: () => null } }), {
    ok: false, code: 'app-missing', error: '未找到 DeepSeek Harness.app',
  });

  // 唤起失败：带 code + 原因，交给路由回 502
  const failed = await openDshApp({
    platform: 'darwin',
    deps: { ...deps, focusDshApp: async () => { throw new Error('boom'); } },
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'app-open-failed');
  assert.match(failed.error, /boom/);
});

test('POST /api/harness/open：响应与错误里不回传实例 token', async () => {
  const home = readOnlyDshHome({ current: { sessionId: 'sess-current' } });
  const route = makeRouter({
    store: { getHome: () => home },
    openSession: async () => ({ ok: true, mode: 'in-app' }),
  });
  const ok = await request(route, 'POST', '/api/harness/open', { body: { homeId: home.homeId } });
  assert.doesNotMatch(JSON.stringify(ok.body), /SUPER-SECRET-TOKEN/);

  const missingBody = await request(route, 'POST', '/api/harness/open', { body: {} });
  assert.equal(missingBody.status, 400);
  assert.doesNotMatch(JSON.stringify(missingBody.body), /SUPER-SECRET-TOKEN/);
});
