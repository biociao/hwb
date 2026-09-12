import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IndexStore } from '../src/dshhome/store.js';
import { createRouter } from '../src/api/routes.js';
import { renderSettingsForm } from '../src/web/components/add-home.js';
import { renderInstanceGrid } from '../src/web/components/instance-grid.js';
import { Launcher } from '../src/control/launcher.js';

test('API excludes disconnected data before aggregation, jump target selection and pagination', async (t) => {
  const store = new IndexStore(); t.after(() => store.close());
  const online = store.registerHome({ homePath: '/online' });
  const offline = store.registerHome({ homePath: '/offline' });
  const insert = store.db.prepare('INSERT INTO sessions (homeId, sessionId, project, lastActivity, tokenUsage) VALUES (?, ?, ?, ?, ?)');
  insert.run(online, 'visible', 'shared', new Date(Date.now() - 10000).toISOString(), JSON.stringify({ outputTokens: 10 }));
  insert.run(offline, 'hidden', 'shared', new Date().toISOString(), JSON.stringify({ outputTokens: 999 }));
  const workspace = store.db.prepare('INSERT INTO workspaces (homeId, workspaceId, project) VALUES (?, ?, ?)');
  workspace.run(online, 'empty-on', 'visible-empty'); workspace.run(offline, 'empty-off', 'hidden-empty');
  const connected = new Set([online]);
  const route = createRouter({ store, monitor: { get: (id) => ({ runtime: connected.has(id) ? 'running' : 'stopped' }) } });
  async function get(path) {
    let data;
    await route({ method: 'GET' }, { writeHead(status) { assert.equal(status, 200); }, end(body) { data = JSON.parse(body); } }, new URL(path, 'http://local'));
    return data;
  }
  const { projects } = await get('/api/projects/recent');
  assert.deepEqual(projects.map((p) => p.project), ['shared', 'visible-empty']);
  assert.equal(projects[0].homeId, online);
  assert.equal(projects[0].sessionId, 'visible');
  assert.equal(projects[0].sessionCount, 1);
  assert.equal(projects[0].outputTokens, 10);
  assert.deepEqual((await get('/api/sessions/recent?limit=1')).sessions.map((s) => s.sessionId), ['visible']);
  assert.deepEqual((await get(`/api/sessions/recent?homeId=${offline}`)).sessions, []);
  connected.clear();
  assert.deepEqual((await get('/api/projects/recent')).projects, []);
  assert.deepEqual((await get('/api/sessions/recent')).sessions, []);
  connected.add(offline);
  assert.equal((await get('/api/projects/recent')).projects[0].homeId, offline);
  assert.equal(store.recentSessions().length, 2, 'disconnect does not delete indexed data');
});

test('cards show only current channel and expose switching only for multiple endpoints', () => {
  const home = { homeId: 'abc', alias: 'CMS', hostType: 'remote', homePath: 'ssh://cms', runtime: { runtime: 'running' }, endpoints: [{ id: 'one', host: 'cms.lo', port: 3080 }, { id: 'two', host: 'cms.tun', port: 4080 }], activeEndpointId: 'one' };
  assert.match(renderInstanceGrid([home]), /当前通道：cms.lo:3080/);
  assert.match(renderInstanceGrid([home]), /data-action="choose-channel"/);
  assert.doesNotMatch(renderInstanceGrid([home]), /cms.tun|<select|<details/);
  assert.doesNotMatch(renderInstanceGrid([{ ...home, endpoints: home.endpoints.slice(0, 1) }]), /data-action="choose-channel"/);
  assert.match(renderSettingsForm(home), /选择连接端点/);
  assert.match(renderSettingsForm(home), /cms.tun/);
});

test('disconnect of managed local process hides it without killing it', async (t) => {
  const listeners = new Set(process.listeners('exit'));
  const launcher = new Launcher();
  t.after(() => { launcher.procs.clear(); for (const l of process.listeners('exit')) if (!listeners.has(l)) process.removeListener('exit', l); });
  let closed = false;
  const inst = { kind: 'dsh-web', port: 3080, url: 'http://local', proc: { exitCode: null, kill() { assert.fail('must not kill dsh'); } }, previewProxy: { async close() { closed = true; } } };
  launcher.procs.set('managed', inst);
  await launcher.disconnect({ homeId: 'managed' });
  assert.equal(launcher.status('managed'), null);
  assert.equal(launcher.procs.get('managed'), inst);
  assert.equal(inst.detached, true);
  assert.equal(closed, true);
});
