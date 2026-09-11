import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRouter } from '../src/api/routes.js';

test('removing an instance cancels its connection before deletion and blocks concurrent opens', async () => {
  const home = { homeId: 'aaaaaaaaaaaaaaaa', hostType: 'remote', host: 'example', remotePort: 3080 };
  let present = true;
  const events = [];
  let release;
  const closing = new Promise(resolve => { release = resolve; });
  const route = createRouter({
    store: {
      getHome: () => present ? home : null,
      listHomes: () => present ? [home] : [],
      removeHome: () => { events.push('remove'); present = false; },
    },
    launcher: {
      status: () => null,
      disconnect: async h => {
        assert.equal(h, home);
        events.push('disconnect');
        await closing;
        events.push('closed');
      },
      open: () => assert.fail('must not reopen an instance being removed'),
    },
    hub: { broadcast: () => events.push('broadcast') },
  });
  async function request(method, suffix = '') {
    let status, data;
    await route({ method }, { writeHead(s) { status = s; }, end(body) { data = JSON.parse(body); } },
      new URL(`http://local/api/homes/${home.homeId}${suffix}`));
    return { status, data };
  }
  const removing = request('DELETE');
  assert.deepEqual(events, ['disconnect']);
  assert.equal((await request('POST', '/open')).status, 409);
  assert.equal((await request('DELETE')).status, 409);
  release();
  assert.equal((await removing).status, 200);
  assert.deepEqual(events, ['disconnect', 'closed', 'remove', 'broadcast']);
  assert.equal((await request('POST', '/open')).status, 404);
});
