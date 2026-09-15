import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IndexStore } from '../src/dshhome/store.js';
import { Launcher } from '../src/control/launcher.js';
import { createProxy } from '../src/control/proxy.js';
import { createRouter } from '../src/api/routes.js';
import { normalizeAccessPort } from '../src/lib/access-port.js';
import { renderSettingsForm, renderHomeForm } from '../src/web/components/add-home.js';
import { planPaneRecovery, planPaneNavigation } from '../src/web/instance-navigation.js';

async function upstream(t, label) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<html><head></head><body>${label} session-deeplink</body></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { port: server.address().port, url: `http://127.0.0.1:${server.address().port}` };
}
function launcherFor(t, store, target) {
  const before = new Set(process.listeners('exit'));
  const launcher = new Launcher({
    rememberAccessPort: (id, port) => store.updateHomeConfig(id, { accessPort: port }),
    tunnelReadyDelayMs: 0,
    remotePathExists: async () => true,
    tunnelFactory: async () => {
      assert.ok(target, 'tests must not create a real SSH connection');
      const proc = new EventEmitter();
      Object.assign(proc, { pid: 999999, exitCode: null, signalCode: null, kill() { this.exitCode = 0; this.emit('exit', 0, null); } });
      return { proc, url: target.url, localPort: target.port, stderr: () => '' };
    },
  });
  t.after(async () => {
    for (const id of launcher.procs.keys()) await launcher.disconnect({ homeId: id });
    for (const listener of process.listeners('exit')) if (!before.has(listener)) process.removeListener('exit', listener);
  });
  return launcher;
}

test('local access port validates exact integers and permits automatic allocation', () => {
  for (const value of [null, undefined, '']) assert.equal(normalizeAccessPort(value), null);
  assert.equal(normalizeAccessPort('55000'), 55000);
  for (const value of [true, {}, -1, 0, 65536, 1.5, '1e3', 'hello']) assert.throws(() => normalizeAccessPort(value), /本地端口/);
});

test('port assignment persists on disk, survives ordinary edits, and prevents duplicate reservations', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwb-access-port-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = path.join(dir, 'index.db');
  let store = new IndexStore(db);
  const id = store.registerHome({ homePath: '/one', hostType: 'remote', accessPort: 55123 });
  const other = store.registerHome({ homePath: '/two', hostType: 'remote' });
  store.updateHomeConfig(id, { alias: 'changed' });
  assert.throws(() => store.updateHomeConfig(other, { accessPort: 55123 }), /另一个实例/);
  store.close();
  store = new IndexStore(db); t.after(() => store.close());
  assert.equal(store.getHome(id).accessPort, 55123);
  store.registerHome({ homePath: '/one', hostType: 'remote' });
  assert.equal(store.getHome(id).accessPort, 55123, 'registration does not forget an allocated port');
  store.updateHomeConfig(id, { accessPort: null });
  assert.equal(store.getHome(id).accessPort, null);
  assert.equal(store.updateHomeConfig(other, { accessPort: 55123 }).accessPort, 55123);
});

test('old databases gain automatic port configuration without losing instances', (t) => {
  const store = new IndexStore(); t.after(() => store.close());
  const id = store.registerHome({ homePath: '/existing' });
  store.db.exec('DROP INDEX homes_access_port; ALTER TABLE homes DROP COLUMN accessPort');
  store.migrate();
  assert.equal(store.getHome(id).accessPort, null);
  store.db.prepare('UPDATE homes SET accessPort = 55003 WHERE homeId = ?').run(id);
  store.migrate();
  assert.equal(store.getHome(id).accessPort, null, 'legacy local proxy reservations are released');
});

test('local instances inject preview in the iframe while external entry stays direct', async (t) => {
  const target = await upstream(t, 'local dsh');
  const other = await upstream(t, 'other local dsh');
  const store = new IndexStore(); t.after(() => store.close());
  const id = store.registerHome({ homePath: '/local', localPort: target.port });
  const launcher = launcherFor(t, store);
  const home = store.getHome(id);
  const direct = await launcher.open({ ...home, accessPort: other.port });
  assert.equal(direct.url, target.url);
  assert.notEqual(new URL(direct.iframeUrl).origin, target.url);
  assert.match(await (await fetch(direct.iframeUrl)).text(), /__hwb\/preview-bridge/);
  assert.doesNotMatch(await (await fetch(direct.url)).text(), /__hwb\/preview-bridge/);
  assert.equal(store.getHome(id).accessPort, null);
  const switched = await launcher.switchEndpoint(home, { ...home, localPort: other.port });
  assert.equal(switched.url, other.url);
  const switchedHtml = await (await fetch(switched.iframeUrl)).text();
  assert.match(switchedHtml, /other local dsh/);
  assert.match(switchedHtml, /__hwb\/preview-bridge/);
  const inst = launcher.procs.get(id);
  inst.kind = 'dsh-web'; // Already-owned process, without spawning a real dsh.
  const managed = await launcher.open(home);
  assert.equal(managed.url, other.url);
  assert.equal(managed.iframeUrl, switched.iframeUrl);
  assert.ok(inst.previewProxy);
  assert.equal(store.getHome(id).accessPort, null);
});

test('local instance API rejects a forwarding port while retaining its dsh service port', async (t) => {
  const store = new IndexStore(); t.after(() => store.close());
  const id = store.registerHome({ homePath: '/local-api', localPort: 3080 });
  const route = createRouter({ store });
  let status;
  await route({ method: 'PUT', async *[Symbol.asyncIterator]() { yield JSON.stringify({ accessPort: 55000 }); } },
    { writeHead(s) { status = s; }, end() {} }, new URL(`http://local/api/homes/${id}`));
  assert.equal(status, 400);
  assert.equal(store.getHome(id).localPort, 3080);
  assert.equal(store.getHome(id).accessPort, null);
});

test('auto-assigned browser entry survives disconnect and a new launcher', async (t) => {
  const target = await upstream(t, 'existing service');
  const store = new IndexStore(); t.after(() => store.close());
  const id = store.registerHome({ homePath: '/existing', hostType: 'remote', host: 'mock.invalid', remotePort: target.port, token: 'test' });
  const first = launcherFor(t, store, target);
  const entry = await first.open(store.getHome(id));
  const port = Number(new URL(entry.iframeUrl).port);
  assert.equal(store.getHome(id).accessPort, port);
  assert.notEqual(new URL(entry.url).port, String(target.port), 'remote instances use an SSH proxy');
  await first.disconnect(store.getHome(id));
  const second = launcherFor(t, store, target);
  const reopened = await second.open(store.getHome(id));
  assert.equal(reopened.iframeUrl, entry.iframeUrl);
  assert.match(await (await fetch(reopened.iframeUrl)).text(), /existing service/);
});

test('remote 外链拿到的就是配置的接入端口，且跨重连不变（不再给随机端口）', async (t) => {
  const target = await upstream(t, 'remote dsh');
  // 预留一个空闲端口当「用户配置的本地接入端口」：起一个监听再关掉，与真实分配路径一致。
  const reserved = http.createServer();
  await new Promise((resolve) => reserved.listen(0, '127.0.0.1', resolve));
  const wanted = reserved.address().port;
  await new Promise((resolve) => reserved.close(resolve));

  const store = new IndexStore(); t.after(() => store.close());
  const id = store.registerHome({ homePath: '/entry', hostType: 'remote', host: 'mock.invalid', remotePort: target.port, token: 'test', accessPort: wanted });
  const first = launcherFor(t, store, target);
  const opened = await first.open(store.getHome(id));
  assert.equal(new URL(opened.iframeUrl).port, String(wanted), 'iframe 入口 = 配置端口');
  assert.equal(new URL(opened.externalUrl).port, String(wanted), '外链入口 = 同一个配置端口（不是 inst.url）');
  assert.notEqual(new URL(opened.url).port, String(wanted), 'inst.url 仍是本次连接的反代端口，两者必须区分开');
  assert.equal(first.status(id).externalUrl, opened.externalUrl, 'status() 必须带上 externalUrl，否则监控会把它抹掉');
  assert.match(await (await fetch(opened.externalUrl)).text(), /remote dsh/);

  // 重连（新 launcher、新隧道/反代端口）后，外链地址一字不变。
  await first.disconnect(store.getHome(id));
  const second = launcherFor(t, store, target);
  const reopened = await second.open(store.getHome(id));
  assert.equal(reopened.externalUrl, opened.externalUrl);
  assert.equal(new URL(reopened.externalUrl).port, String(wanted));
});

test('occupied saved port fails explicitly and never silently changes the browser origin', async (t) => {
  const target = await upstream(t, 'service');
  const occupied = await upstream(t, 'unrelated service');
  const store = new IndexStore(); t.after(() => store.close());
  const id = store.registerHome({ homePath: '/occupied', hostType: 'remote', host: 'mock.invalid', remotePort: target.port, token: 'test', accessPort: occupied.port });
  const launcher = launcherFor(t, store, target);
  await assert.rejects(launcher.open(store.getHome(id)), /已被占用/);
  assert.equal(launcher.status(id), null);
  assert.equal(store.getHome(id).accessPort, occupied.port);
  assert.match(await (await fetch(occupied.url)).text(), /unrelated service/);
});

test('proxy can replace its upstream while retaining its listening port', async (t) => {
  const a = await upstream(t, 'first'), b = await upstream(t, 'second');
  const proxy = await createProxy({ target: a.url }); t.after(() => proxy.close());
  const original = proxy.url;
  assert.match(await (await fetch(original)).text(), /first/);
  proxy.retarget(b.url);
  assert.equal(proxy.url, original);
  assert.match(await (await fetch(original)).text(), /second/);
});

test('same browser port with a changed upstream reauthenticates once and restores the selected session', () => {
  const pane = { _iframed: true, _cookieReady: true, deeplink: true, url: 'http://localhost:55000/', externalUrl: 'http://localhost:55001/', sessionId: 'selected' };
  const runtime = { runtime: 'running', iframeUrl: pane.url, url: 'http://localhost:55002/', deeplink: true };
  const recovery = planPaneRecovery(pane, runtime);
  assert.equal(recovery.force, true);
  const navigation = planPaneNavigation(pane, recovery.url, recovery.sessionId, recovery.force);
  assert.equal(navigation.cookieReady, false);
  assert.equal(new URL(navigation.finalTarget).searchParams.get('session'), 'selected');
  pane.externalUrl = runtime.url;
  assert.equal(planPaneRecovery(pane, runtime), null);
});

test('settings expose the remembered browser port separately from the dsh service endpoint', () => {
  const html = renderSettingsForm({ homePath: '/remote', hostType: 'remote', accessPort: 55000, endpoints: [] });
  assert.match(html, /name="accessPort"[^>]*value="55000"/);
  assert.match(html, /自动分配并保存/);
  assert.match(renderHomeForm(), /name="accessPort"[^>]*hidden/);
  assert.doesNotMatch(renderSettingsForm({ homePath: '/local', hostType: 'local', endpoints: [] }), /name="accessPort"/);
});

test('API rejects invalid, reserved, and connected port changes before editing configuration', async (t) => {
  const store = new IndexStore(); t.after(() => store.close());
  const id = store.registerHome({ homePath: '/one', hostType: 'remote', accessPort: 55000 });
  store.registerHome({ homePath: '/two', hostType: 'remote', accessPort: 55001 });
  let connected = false;
  const route = createRouter({ store, launcher: { status: () => connected }, monitor: { get: () => ({}) } });
  async function put(accessPort) {
    let status;
    await route({ method: 'PUT', async *[Symbol.asyncIterator]() { yield JSON.stringify({ accessPort }); } },
      { writeHead(s) { status = s; }, end() {} }, new URL(`http://local/api/homes/${id}`));
    return status;
  }
  assert.equal(await put('bad'), 400);
  assert.equal(await put(55001), 409);
  connected = true;
  assert.equal(await put(55002), 409);
  assert.equal(await put(55000), 200);
  connected = false;
  assert.equal(await put(null), 200);
  assert.equal(store.getHome(id).accessPort, null);
});
