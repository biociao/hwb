import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { IndexStore } from '../src/dshhome/store.js';
import { Launcher } from '../src/control/launcher.js';
import { createRouter } from '../src/api/routes.js';
import { normalizeEndpoints, assertSshHost } from '../src/lib/endpoints.js';

const endpoints = [
  { id: 'lan', label: '内网', host: 'bot@cms.lo', port: 3080, token: 'lan-token' },
  { id: 'vpn', label: '虚拟网', host: 'bot@cms.tun', port: 4080, token: 'vpn-token' },
];

test('endpoint validation rejects duplicates, bad ports, and malformed addresses', () => {
  for (const port of [0, 65536, 1.5, 'bad']) assert.throws(() => normalizeEndpoints([{ ...endpoints[0], port }], 'remote'));
  assert.throws(() => normalizeEndpoints(endpoints.map((e) => ({ ...e, id: 'same' })), 'remote'));
  assert.throws(() => normalizeEndpoints([endpoints[0], { ...endpoints[0], id: 'other' }], 'remote'));
  assert.throws(() => normalizeEndpoints([{ ...endpoints[0], host: '-oProxyCommand=bad' }], 'remote'));
  assert.throws(() => normalizeEndpoints([], 'remote'));
});

function fixture(t) {
  const store = new IndexStore(); t.after(() => store.close());
  const homeId = store.registerHome({ homePath: 'ssh://bot@cms.lo:3080', hostType: 'remote', endpoints });
  return { store, homeId };
}

test('switching selected endpoint preserves homeId and indexed sessions, including across port changes', (t) => {
  const { store, homeId } = fixture(t);
  store.db.prepare('INSERT INTO sessions (homeId, sessionId, title) VALUES (?, ?, ?)').run(homeId, 'session', 'Keep me');
  const after = store.updateHomeConfig(homeId, { activeEndpointId: 'vpn' });
  assert.equal(after.homeId, homeId);
  assert.equal(after.host, 'bot@cms.tun');
  assert.equal(after.remotePort, 4080);
  assert.equal(after.token, 'vpn-token');
  assert.equal(after.sessionCount, 1);
  assert.equal(store.listHomes().length, 1);
  assert.throws(() => store.updateHomeConfig(homeId, { endpoints: [{ port: 0 }] }));
  assert.deepEqual(store.getHome(homeId), after);
});

test('legacy dual channels merge unique sessions and deduplicate repeated usage rows', (t) => {
  const { store, homeId } = fixture(t);
  const other = store.registerHome({ homePath: 'ssh://bot@cms.tun:4080', hostType: 'remote', host: 'bot@cms.tun', remotePort: 4080, serverId: 'cms' });
  store.updateHomeConfig(homeId, { serverId: 'cms' });
  const insert = store.db.prepare('INSERT INTO sessions (homeId, sessionId) VALUES (?, ?)');
  insert.run(homeId, 'same'); insert.run(other, 'same'); insert.run(other, 'unique');
  store.db.exec('ALTER TABLE homes DROP COLUMN endpoints; ALTER TABLE homes DROP COLUMN activeEndpointId');
  store.migrate();
  assert.equal(store.listHomes().length, 1);
  assert.equal(store.getHome(homeId).sessionCount, 2);
  assert.equal(store.getHome(homeId).endpoints.length, 2);
  store.migrate();
  assert.equal(store.getHome(homeId).endpoints.length, 2);
});

test('API preserves old endpoint on failure, serializes switches, and allows adding alternatives while connected', async (t) => {
  const { store, homeId } = fixture(t);
  let release, rejectSwitch;
  let work = new Promise((resolve, reject) => { release = resolve; rejectSwitch = reject; });
  const route = createRouter({ store,
    launcher: { status: () => ({ url: 'http://old' }), switchEndpoint: () => work },
    monitor: { refresh: async () => {}, get: () => ({ runtime: 'running' }) },
    indexer: { reindexNow() {} }, hub: { broadcast() {} },
  });
  async function request(action, body, method = 'POST') {
    let status, data;
    const req = { method, async *[Symbol.asyncIterator]() { yield JSON.stringify(body); } };
    await route(req, { writeHead(s) { status = s; }, end(b) { data = JSON.parse(b); } }, new URL(`http://local/api/homes/${homeId}${action}`));
    return { status, data };
  }
  const added = [...endpoints, { id: 'third', host: 'bot@cms.lo', port: 5080 }];
  assert.equal((await request('', { endpoints: added }, 'PUT')).status, 200);
  assert.equal((await request('', { endpoints: added.slice(1) }, 'PUT')).status, 409);
  const switching = request('/switch', { endpointId: 'vpn' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await request('/switch', { endpointId: 'third' })).status, 409);
  rejectSwitch(new Error('unreachable'));
  assert.equal((await switching).status, 502);
  assert.equal(store.getHome(homeId).activeEndpointId, 'lan');
  work = Promise.resolve();
  assert.equal((await request('/switch', { endpointId: 'vpn' })).status, 200);
  assert.equal(store.getHome(homeId).activeEndpointId, 'vpn');
  assert.equal(store.getHome(homeId).remotePort, 4080);
  assert.equal((await request('/switch', { endpointId: 'missing' })).status, 400);
});

test('Launcher switches real local HTTP endpoints and keeps original connection on auth failure', async (t) => {
  const servers = [];
  async function endpoint(status) {
    const server = createServer((_req, res) => { res.writeHead(status, { 'content-type': 'text/html' }); res.end('<html>dsh</html>'); });
    servers.push(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return server.address().port;
  }
  const listeners = new Set(process.listeners('exit'));
  const launcher = new Launcher();
  const home = { homeId: 'one-instance', hostType: 'local', localPort: await endpoint(200) };
  t.after(async () => {
    await launcher.disconnect(home);
    for (const server of servers) { server.closeAllConnections(); server.close(); }
    for (const listener of process.listeners('exit')) if (!listeners.has(listener)) process.removeListener('exit', listener);
  });
  await launcher.open(home);
  const original = launcher.status(home.homeId);
  await assert.rejects(launcher.switchEndpoint(home, { ...home, localPort: await endpoint(401) }), /401/);
  assert.deepEqual(launcher.status(home.homeId), original);
  assert.equal(launcher.procs.size, 1);
  const port = await endpoint(200);
  await launcher.switchEndpoint(home, { ...home, localPort: port });
  assert.equal(launcher.status(home.homeId).port, port);
  assert.equal(launcher.procs.size, 1);
  assert.equal((await fetch(original.url)).status, 200, 'old dsh process remains alive');
  assert.equal(launcher.registry.has(`${home.homeId}:switch`), false);
});

// `\s` 不匹配 \0（也不匹配 \x01 之类的控制字符），于是 "bot@x\0y" 能过校验，
// 一直走到 spawn 才抛 ERR_INVALID_ARG_VALUE —— 而那条路径抛的是**同步异常**，
// 会绕过「失败也用返回值表达」的约定（实测：sshBash 直接 reject）。
// 主机名里出现控制字符没有任何正当理由，在校验层拒掉最省事。
test('assertSshHost: 拒绝控制字符（\\0 不在 \\s 的覆盖范围内）', () => {
  for (const bad of ['bot@x\u0000y', 'bot@x\u0001y', 'x\u007fy', 'a\tb']) {
    assert.throws(() => assertSshHost(bad), /控制字符|空白/, `${JSON.stringify(bad)} 应被拒绝`);
  }
  assert.equal(assertSshHost('bot@cms.lo'), 'bot@cms.lo', '正常主机名不受影响');
  assert.equal(assertSshHost('user@10.0.0.1'), 'user@10.0.0.1');
});
