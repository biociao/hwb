import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IndexStore } from '../src/dshhome/store.js';
import { instanceKey, connectedHomes, tabHomes } from '../src/web/instance-state.js';
import { renderInstanceGrid } from '../src/web/components/instance-grid.js';
import { Readable } from 'node:stream';
import { createRouter } from '../src/api/routes.js';
import { Launcher } from '../src/control/launcher.js';

const channel = (host, extra = {}) => ({ homeId: host === 'cms.lo' ? 'aaaaaaaaaaaaaaaa' : 'bbbbbbbbbbbbbbbb', hostType: 'remote', host, serverId: 'cms', remotePort: 3080, degraded: [], runtime: { runtime: 'running' }, ...extra });

test('same server and home share identity across channels, distinct homes/ports do not', () => {
  const a = channel('cms.lo'), b = channel('cms.tun');
  assert.equal(instanceKey(a), instanceKey(b));
  assert.notEqual(instanceKey(a), instanceKey({ ...b, remotePort: 4000 }));
  assert.notEqual(instanceKey(a), instanceKey({ ...b, remoteHome: '/another/home' }));
  assert.notEqual(instanceKey({ ...a, host: 'alice@cms.lo' }), instanceKey({ ...b, host: 'bob@cms.tun' }));
  assert.notEqual(instanceKey({ ...a, serverId: null }), instanceKey({ ...b, serverId: null }));
  assert.deepEqual(connectedHomes([a, b, channel('other', { runtime: { runtime: 'stopped' } })]), [a]);
  assert.deepEqual(connectedHomes([channel('cms.lo', { runtime: { runtime: 'unreachable' } })]), []);
});

test('instance tabs survive a failed health probe while connected data remains filtered', () => {
  const home = channel('cms.tun', { runtime: { runtime: 'running', url: 'http://localhost:5555/?token=test' } });
  assert.deepEqual(tabHomes([home]), [home]);
  const timedOut = { ...home, runtime: { ...home.runtime, runtime: 'unreachable' } };
  assert.deepEqual(tabHomes([timedOut]), [timedOut], 'an open or restored tab retains the same instance');
  assert.deepEqual(connectedHomes([timedOut]), [], 'a failed health probe still excludes aggregate data');
  assert.deepEqual(tabHomes([home]), [home], 'the same tab becomes healthy when the next probe succeeds');
  for (const runtime of ['stopped', 'gone', 'unknown']) {
    assert.deepEqual(tabHomes([{ ...home, runtime: { ...home.runtime, runtime } }]), [], `${runtime} closes the tab even if a stale URL remains`);
  }
  assert.deepEqual(tabHomes([{ ...home, runtime: { runtime: 'unreachable', url: null } }]), []);
  assert.deepEqual(tabHomes([]), [], 'removed instances are not retained');
});

test('tabs prefer the running channel when an alias of the same instance is unreachable', () => {
  const slow = channel('cms.lo', { runtime: { runtime: 'unreachable', url: 'http://localhost:5555/' } });
  const running = channel('cms.tun');
  assert.deepEqual(tabHomes([slow, running]), [running]);
  assert.deepEqual(tabHomes([running, slow]), [running]);
  assert.deepEqual(tabHomes([slow, { ...running, runtime: slow.runtime }]), [slow]);
});

test('legacy cms SSH aliases migrate to a shared server identity, including user@host', (t) => {
  const store = new IndexStore(); t.after(() => store.close());
  const a = store.registerHome({ homePath: 'ssh://bot@cms.lo:3080', hostType: 'remote', host: 'bot@cms.lo', remotePort: 3080 });
  const b = store.registerHome({ homePath: 'ssh://bot@cms.tun:3080', hostType: 'remote', host: 'bot@cms.tun', remotePort: 3080 });
  store.db.exec('ALTER TABLE homes DROP COLUMN serverId; ALTER TABLE homes DROP COLUMN endpoints; ALTER TABLE homes DROP COLUMN activeEndpointId');
  store.migrate();
  assert.equal(store.getHome(a).serverId, 'cms');
  assert.equal(store.getHome(b), null);
  assert.equal(store.getHome(a).endpoints.length, 2);
  store.updateHomeConfig(a, { serverId: 'override' });
  store.migrate();
  assert.equal(store.getHome(a).serverId, 'override');
});

test('instance cards stay visible without folding or endpoint selectors; controls reflect connection state', () => {
  const offline = renderInstanceGrid([channel('cms.lo', { runtime: { runtime: 'stopped' } })]);
  assert.match(offline, /未连接/);
  assert.match(offline, /data-action="connect"/);
  assert.doesNotMatch(offline, /<details|<summary|<select|data-action="switch-endpoint"/);
  const online = renderInstanceGrid([channel('cms.lo')]);
  assert.match(online, /data-action="disconnect"/);
  assert.doesNotMatch(online, /data-action="choose-channel"/);
  assert.match(online, /当前通道：cms.lo:3080/);
  assert.doesNotMatch(online, /<details|<select/);
});

test('server identity persists through config edits without changing channel IDs', (t) => {
  const store = new IndexStore(); t.after(() => store.close());
  const id = store.registerHome({ homePath: 'ssh://cms.lo:3080', hostType: 'remote', host: 'cms.lo', remotePort: 3080, serverId: 'cms' });
  store.updateHomeConfig(id, { alias: 'CMS LAN' });
  assert.equal(store.getHome(id).serverId, 'cms');
  store.updateHomeConfig(id, { serverId: 'different' });
  assert.equal(store.getHome(id).serverId, 'different');
});

test('API serializes same-instance channel connections and allows switching after disconnect', async () => {
  const homes = [channel('cms.lo'), channel('cms.tun')];
  const active = new Set();
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const route = createRouter({
    store: { listHomes: () => homes, getHome: (id) => homes.find((h) => h.homeId === id) },
    launcher: {
      status: (id) => active.has(id),
      open: async (h) => { await pending; active.add(h.homeId); return { url: 'http://local' }; },
      disconnect: async (h) => active.delete(h.homeId),
    },
    monitor: { refresh: async () => {}, get: (id) => ({ runtime: active.has(id) ? 'running' : 'stopped' }) },
    indexer: { reindexNow() {} },
  });
  async function request(home, action) {
    let status, body;
    await route({ method: 'POST' }, { writeHead(s) { status = s; }, end(b) { body = JSON.parse(b); } }, new URL(`http://local/api/homes/${home.homeId}/${action}`));
    return { status, body };
  }
  const first = request(homes[0], 'open');
  assert.equal((await request(homes[1], 'open')).status, 409);
  release();
  assert.equal((await first).status, 200);
  assert.match((await request(homes[1], 'open')).body.error, /cms.lo/);
  assert.equal((await request(homes[0], 'disconnect')).status, 200);
  assert.equal((await request(homes[1], 'open')).status, 200);
});

test('disconnect adopted local closes proxies without stopping the instance', async (t) => {
  const before = new Set(process.listeners('exit'));
  const launcher = new Launcher();
  t.after(() => { for (const listener of process.listeners('exit')) if (!before.has(listener)) process.removeListener('exit', listener); });
  let closed = 0;
  launcher.procs.set('local', { kind: 'adopted-local', previewProxy: { close: async () => closed++ } });
  await launcher.disconnect({ homeId: 'local', hostType: 'local' });
  assert.equal(closed, 1);
  assert.equal(launcher.status('local'), null);
});

// 「正在使用的端点」判定原先把「没有 active 端点 + 提交了端点」也当成改动当前端点 ——
// 而「没有 active 端点」正是**拉起模式**（hwb 自己启动、还没配连接端点）的常态。
// 结果是：连接着的实例无法在设置里补第一个端点，409 还建议「添加其他端点并切换后再修改」，
// 而切换需要 ≥2 个端点，那句建议在这条路径上无法执行。实测：同一请求先断开就 200。
test('配置更新: 连接中的实例可以新增端点（只有改动/删除当前端点才拒绝）', async () => {
  const store = new IndexStore(':memory:');
  const homeId = store.registerHome({ homePath: '/tmp/mock-home', hostType: 'local' });
  const router = createRouter({
    store,
    launcher: { status: () => ({ phase: 'running' }), disconnect: async () => {} },
    monitor: { get: () => ({ runtime: 'running' }) },
    indexer: { reindexNow: async () => [] },
  });
  const put = async (body) => {
    const req = new Readable({ read() {} });
    req.on('error', () => {});
    req.method = 'PUT';
    req.headers = { 'content-type': 'application/json', origin: 'http://127.0.0.1:4310', host: '127.0.0.1:4310' };
    const chunks = [Buffer.from(JSON.stringify(body))];
    const result = { headers: {} };
    const res = {
      setHeader(k, v) { result.headers[k] = v; },
      writeHead(code, fields) { result.status = code; Object.assign(result.headers, fields || {}); },
      end(payload) { result.body = payload ? JSON.parse(payload) : null; },
    };
    const url = new URL(`http://127.0.0.1/api/homes/${homeId}`);
    const pending = router(req, res, url).catch((e) => { result.error = e.message; });
    for (const c of chunks) req.push(c);
    req.push(null);
    await pending;
    return result;
  };

  // ① 拉起模式（没有 active 端点）：新增一个端点应当被接受
  const added = await put({ endpoints: [{ host: null, port: 3080 }] });
  assert.equal(added.status, 200, `新增端点应成功，实际 ${added.status}: ${JSON.stringify(added.body)}`);
  assert.ok(store.getHome(homeId).endpoints.length >= 1);

  // ② 改动**当前**端点：仍然要拒绝（实例正在用它）
  const active = store.getHome(homeId);
  const modified = await put({ endpoints: active.endpoints.map((e) => ({ ...e, port: e.id === active.activeEndpointId ? 9999 : e.port })) });
  assert.equal(modified.status, 409, '改动正在使用的端点必须拒绝');
  assert.match(modified.body.error, /断开|切换/);

  // ③ 新增一个与当前无关的端点：允许
  const extra = await put({ endpoints: [...store.getHome(homeId).endpoints.map((e) => ({ ...e })), { host: null, port: 3099 }] });
  assert.equal(extra.status, 200, `新增另一个端点应成功，实际 ${extra.status}`);
  store.close();
});
