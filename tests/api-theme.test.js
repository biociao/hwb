import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRouter } from '../src/api/routes.js';
import { writeThemePreference } from '../src/lib/dsh-theme.js';

// GET/POST /api/theme 的路由级测试。
//
// 这里要钉住的三条语义（都来自真实使用场景，不是假想）：
//   ① 只下发给**已连接**的实例 —— 没连上的实例写盘只是留个将来才生效的偏好；
//   ② 某个实例失败**不拖垮**其余实例（部分成功要如实回报，而不是笼统 502）；
//   ③ 偏好先落盘再下发 —— 全失败时用户的选择也不该丢。

const L = 'localhome0000001';
const R = 'remotehome000002';

function homeEntry(overrides) {
  return {
    homeId: L, alias: '本机', hostType: 'local', homePath: '/tmp/x',
    endpoints: [], ...overrides,
  };
}

function makeRouter({ homes, connected = [], syncTheme, themePreference = () => 'system', setThemePreference = () => {}, result } = {}) {
  const calls = { syncTheme: [], saved: [] };
  return {
    calls,
    route: createRouter({
      store: { getHome: (id) => homes.find((h) => h.homeId === id), listHomes: () => homes },
      indexer: { reindexNow() {} },
      hub: { broadcast() {} },
      launcher: {
        status: (id) => connected.includes(id),
        syncTheme: syncTheme ?? (async (home, preference) => {
          calls.syncTheme.push({ homeId: home.homeId, preference });
          if (result?.[home.homeId] instanceof Error) throw result[home.homeId];
          // 走**真实**的本机写入路径（远端才需要 ssh，这里不假装）。
          if (home.hostType !== 'remote') writeThemePreference(home.homePath, preference);
          return { changed: true, transport: home.hostType === 'remote' ? 'ssh' : 'file' };
        }),
      },
      monitor: { get: () => ({ runtime: 'stopped' }), refresh: async () => {} },
      quota: { list: () => [] },
      logApi: { getLogs: () => [] },
      themePreference,
      setThemePreference: (v) => { calls.saved.push(v); setThemePreference(v); },
    }),
  };
}

async function request(route, method, pathname, body) {
  const out = { status: null, body: null };
  const req = {
    method,
    headers: {},
    async *[Symbol.asyncIterator]() { if (body !== undefined) yield JSON.stringify(body); },
  };
  const res = {
    writeHead(status) { out.status = status; },
    end(payload) { out.body = payload ? JSON.parse(payload) : null; },
    setHeader() {},
  };
  await route(req, res, new URL(`http://127.0.0.1${pathname}`));
  return out;
}

// —— 真实文件系统上的「本机」实例（GET 的 dshPreference 要能读到）——

test('POST /api/theme：只下发给已连接的实例，未连接的不写盘', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hwb-api-theme-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const homes = [homeEntry({ homePath: dir }), homeEntry({ homeId: R, alias: '远端', hostType: 'remote', host: 'h' })];
  const { route, calls } = makeRouter({ homes, connected: [L] });   // 只有本机连上了

  const res = await request(route, 'POST', '/api/theme', { preference: 'dark' });
  assert.equal(res.status, 200);
  assert.equal(res.body.synced, 1);
  assert.deepEqual(calls.syncTheme, [{ homeId: L, preference: 'dark' }]);
  assert.equal(readFileSync(join(dir, 'settings.yaml'), 'utf8'), 'ui-theme:\n  preference: dark\n');
});

test('POST /api/theme：显式 homeIds 可越过「已连接」过滤（给调用方留精确控制）', async () => {
  const homes = [homeEntry({}), homeEntry({ homeId: R, alias: '远端', hostType: 'remote', host: 'h' })];
  const { route, calls } = makeRouter({ homes, connected: [] });
  const res = await request(route, 'POST', '/api/theme', { preference: 'light', homeIds: [R] });
  assert.equal(res.status, 200);
  assert.deepEqual(calls.syncTheme, [{ homeId: R, preference: 'light' }]);
});

test('POST /api/theme：个别实例失败不影响其余实例，且逐条如实回报', async () => {
  const homes = [homeEntry({}), homeEntry({ homeId: R, alias: '远端', hostType: 'remote', host: 'h' })];
  const { route } = makeRouter({
    homes, connected: [L, R],
    result: { [R]: new Error('ssh 连不上') },
  });
  const res = await request(route, 'POST', '/api/theme', { preference: 'dark' });
  assert.equal(res.status, 200, '部分失败不该降级成 5xx');
  assert.equal(res.body.synced, 1);
  assert.equal(res.body.failed, 1);
  const byId = Object.fromEntries(res.body.results.map((r) => [r.homeId, r]));
  assert.equal(byId[L].ok, true);
  assert.equal(byId[R].ok, false);
  assert.match(byId[R].error, /ssh 连不上/);
});

test('POST /api/theme：非法偏好 400，且一个实例都不碰', async () => {
  const homes = [homeEntry({})];
  const { route, calls } = makeRouter({ homes, connected: [L] });
  for (const bad of ['purple', '', null, 5]) {
    const res = await request(route, 'POST', '/api/theme', { preference: bad });
    assert.equal(res.status, 400, `preference=${JSON.stringify(bad)} 应被拒`);
  }
  assert.deepEqual(calls.syncTheme, [], '校验失败时不该下发');
});

test('POST /api/theme：偏好落盘**先于**下发（全失败时用户的选择也不丢）', async () => {
  const homes = [homeEntry({})];
  let saved = null;
  const order = [];
  const { route } = makeRouter({
    homes, connected: [L],
    setThemePreference: (v) => { saved = v; order.push('save'); },
    syncTheme: async () => { order.push('sync'); throw new Error('boom'); },
  });
  const res = await request(route, 'POST', '/api/theme', { preference: 'dark' });
  assert.equal(res.status, 200);
  assert.equal(saved, 'dark');
  assert.deepEqual(order, ['save', 'sync'], '必须先保存偏好再下发');
});

test('POST /api/theme：偏好持久化失败 → 500（不能假装成功）', async () => {
  const homes = [homeEntry({})];
  const { route } = makeRouter({
    homes, connected: [L],
    setThemePreference: () => { throw new Error('磁盘只读'); },
  });
  const res = await request(route, 'POST', '/api/theme', { preference: 'dark' });
  assert.equal(res.status, 500);
  assert.match(res.body.error, /磁盘只读/);
});

test('POST /api/theme：没有已连接实例时是成功的空操作（不是错误）', async () => {
  const { route } = makeRouter({ homes: [homeEntry({})], connected: [] });
  const res = await request(route, 'POST', '/api/theme', { preference: 'dark' });
  assert.equal(res.status, 200);
  assert.equal(res.body.synced, 0);
  assert.equal(res.body.failed, 0);
  assert.deepEqual(res.body.results, []);
});

test('POST /api/theme：连接实现不支持主题下发时逐条报错，而不是 500', async () => {
  const homes = [homeEntry({})];
  const route = createRouter({
    store: { getHome: () => homes[0], listHomes: () => homes },
    indexer: { reindexNow() {} }, hub: { broadcast() {} },
    launcher: { status: () => true },          // 故意没有 syncTheme
    monitor: { get: () => ({ runtime: 'running' }), refresh: async () => {} },
    quota: { list: () => [] }, logApi: { getLogs: () => [] },
    themePreference: () => 'system', setThemePreference: () => {},
  });
  const res = await request(route, 'POST', '/api/theme', { preference: 'dark' });
  assert.equal(res.status, 200);
  assert.equal(res.body.failed, 1);
  assert.match(res.body.results[0].error, /不支持主题下发/);
});

test('GET /api/theme：读出偏好、支持的取值、以及各实例 dsh 侧的实际值', async (t) => {
  const local = mkdtempSync(join(tmpdir(), 'hwb-api-theme-get-'));
  const other = mkdtempSync(join(tmpdir(), 'hwb-api-theme-get2-'));
  t.after(() => { for (const d of [local, other]) rmSync(d, { recursive: true, force: true }); });
  writeFileSync(join(local, 'settings.yaml'), 'ui-theme:\n  preference: dark\n');
  // other 故意没有 settings.yaml → dshPreference 应为 null（「不知道」，不是编一个默认值）

  const homes = [
    homeEntry({ homePath: local }),
    homeEntry({ homeId: R, alias: '远端', hostType: 'remote', host: 'h', homePath: other }),
  ];
  const { route } = makeRouter({ homes, connected: [L], themePreference: () => 'light' });

  const res = await request(route, 'GET', '/api/theme');
  assert.equal(res.status, 200);
  assert.equal(res.body.preference, 'light');
  assert.deepEqual(res.body.supported, ['light', 'dark', 'system']);
  const byId = Object.fromEntries(res.body.homes.map((h) => [h.homeId, h]));
  assert.equal(byId[L].connected, true);
  assert.equal(byId[L].dshPreference, 'dark', '本机实例应读出磁盘上的实际值');
  assert.equal(byId[L].alias, '本机');
  assert.equal(byId[R].connected, false);
  assert.equal(byId[R].dshPreference, null, '远程实例不读盘（每次 GET 都跑 ssh 太贵）');
});

test('GET /api/theme：settings.yaml 读不动时该实例为 null，整体仍 200', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hwb-api-theme-bad-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // 目录而非文件：readFileSync 抛 EISDIR，属于「读不动」而不是「没有」
  const { route } = makeRouter({ homes: [homeEntry({ homePath: dir })], connected: [L] });
  const res = await request(route, 'GET', '/api/theme');
  assert.equal(res.status, 200);
  assert.equal(res.body.homes[0].dshPreference, null);
});

test('主题路由走的是同一套跨站写保护（POST 不带 Origin 时放行，跨站时 403）', async () => {
  const homes = [homeEntry({})];
  const { route, calls } = makeRouter({ homes, connected: [L] });
  // 跨站来源必须被拦在最前面
  const blocked = await (async () => {
    const out = { status: null, body: null };
    const req = {
      method: 'POST', headers: { 'sec-fetch-site': 'cross-site' },
      async *[Symbol.asyncIterator]() { yield JSON.stringify({ preference: 'dark' }); },
    };
    await route(req, { writeHead(s) { out.status = s; }, end(p) { out.body = JSON.parse(p); }, setHeader() {} },
      new URL('http://127.0.0.1/api/theme'));
    return out;
  })();
  assert.equal(blocked.status, 403);
  assert.deepEqual(calls.syncTheme, [], '被拦下的请求绝不能触发下发');
});
