// POST /api/homes/{homeId}/open-session 的路由契约：
// 只允许本地 dsh；home 不存在 404；插件缺失/平台不支持时把 code 带回前端（前端据此回退 iframe），
// 并且会话 id 由 hwb 侧再校验一次（不要信任浏览器传来的值）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRouter } from '../src/api/routes.js';

const HOME_ID = 'abcdef1234567890';

function makeRouter({ home = { homeId: HOME_ID, homePath: '/mock/.dsh', hostType: 'local', harness: 'dsh' }, openSession } = {}) {
  return createRouter({
    store: { getHome: (id) => (id === HOME_ID ? home : null), listHomes: () => [home] },
    indexer: { reindexNow: async () => [] },
    hub: { broadcast() {} },
    launcher: { disconnect: async () => {} },
    monitor: { get: () => ({ runtime: 'stopped' }), refresh: async () => ({}) },
    quota: { list: () => [], refresh: async () => [] },
    logApi: { getLogs: () => [] },
    openSession,
  });
}

async function request(route, method, pathname, body) {
  const result = { status: null, body: null };
  const req = {
    method,
    headers: {},
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield JSON.stringify(body);
    },
  };
  const res = {
    writeHead(status) { result.status = status; },
    end(raw) { result.body = raw ? JSON.parse(raw) : null; },
  };
  await route(req, res, new URL(`http://127.0.0.1:4310${pathname}`));
  return result;
}

test('POST open-session：本地 dsh 把 home + sessionId 交给 openSession', async () => {
  const calls = [];
  const home = { homeId: HOME_ID, homePath: '/mock/.dsh', hostType: 'local', harness: 'dsh' };
  const route = makeRouter({
    home,
    openSession: async (args) => { calls.push(args); return { ok: true, mode: 'in-app', trigger: { id: 't1' } }; },
  });
  const res = await request(route, 'POST', `/api/homes/${HOME_ID}/open-session`, { sessionId: 'session-1' });
  assert.equal(res.status, 200);
  assert.equal(res.body.mode, 'in-app');
  assert.deepEqual(calls, [{ home, sessionId: 'session-1' }]);
});

test('POST open-session：插件缺失 409、平台不支持 501、无效 id 400', async () => {
  const route = (result) => makeRouter({ openSession: async () => result });

  const missing = await request(route({ ok: false, code: 'plugin-missing', error: '未安装', install: 'dsh plugin ...' }), 'POST', `/api/homes/${HOME_ID}/open-session`, { sessionId: 'session-1' });
  assert.equal(missing.status, 409);
  assert.equal(missing.body.code, 'plugin-missing');
  assert.match(missing.body.install, /dsh plugin/);

  const platform = await request(route({ ok: false, code: 'platform-unsupported', error: '仅 macOS' }), 'POST', `/api/homes/${HOME_ID}/open-session`, { sessionId: 'session-1' });
  assert.equal(platform.status, 501);
  assert.equal(platform.body.code, 'platform-unsupported');

  const appMissing = await request(route({ ok: false, code: 'app-missing', error: '未找到 App' }), 'POST', `/api/homes/${HOME_ID}/open-session`, { sessionId: 'session-1' });
  assert.equal(appMissing.status, 409);
  assert.equal(appMissing.body.code, 'app-missing');

  // 服务端不盲目信任前端：id 缺失/非法一律 400（lib 自己的校验兜住）
  const openSession = async ({ sessionId }) => (sessionId === 'session-1' ? { ok: true } : { ok: false, code: 'bad-session-id', error: '无效的会话 ID' });
  const bad = await request(makeRouter({ openSession }), 'POST', `/api/homes/${HOME_ID}/open-session`, { sessionId: '' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'bad-session-id');
});

test('POST open-session：未知 home 404，远程/非 dsh 400', async () => {
  const route = makeRouter({ openSession: async () => ({ ok: true }) });
  const unknown = await request(route, 'POST', '/api/homes/ffffffffffffffff/open-session', { sessionId: 'session-1' });
  assert.equal(unknown.status, 404);

  for (const home of [
    { homeId: HOME_ID, homePath: '/mock/.dsh', hostType: 'remote', harness: 'dsh' },
    { homeId: HOME_ID, homePath: '/mock/.codex', hostType: 'local', harness: 'codex' },
  ]) {
    const res = await request(makeRouter({ home, openSession: async () => ({ ok: true }) }), 'POST', `/api/homes/${HOME_ID}/open-session`, { sessionId: 'session-1' });
    assert.equal(res.status, 400, `${home.harness}/${home.hostType}`);
    assert.match(res.body.error, /本地 dsh/);
  }
});
