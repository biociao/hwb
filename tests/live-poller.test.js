import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IndexStore } from '../src/dshhome/store.js';
import { LiveStatusPoller } from '../src/dshhome/live-poller.js';
import { LiveStatusReader } from '../src/dshhome/live-status.js';

const status = (kind) => ({ kind, label: kind, subagents: 0, approval: null });

test('live poller inserts new remote sessions and updates stopped sessions without SSH indexing', async () => {
  const store = new IndexStore(':memory:');
  const homeId = store.registerHome({ homePath: 'ssh://bot@cms.lo:3080', hostType: 'remote', host: 'bot@cms.lo' });
  let live = [{ sessionId: 'new', cwd: '/repo/demo', title: 'test', status: status('running') }];
  const events = [];
  const poller = new LiveStatusPoller({ store, homes: () => store.listHomes(), read: async () => live,
    broadcast: (event) => events.push(event) });
  try {
    poller.start();
    await poller.refresh(homeId);
    assert.equal(JSON.parse(store.db.prepare('SELECT status FROM sessions').get().status).kind, 'running');
    store.db.prepare("UPDATE sessions SET workspaceId='ws', workspaceTitle='Demo' WHERE sessionId='new'").run();
    live = [{ sessionId: 'new', status: status('idle') }];
    await poller.refresh(homeId);
    const row = store.db.prepare('SELECT * FROM sessions').get();
    assert.equal(JSON.parse(row.status).kind, 'idle');
    assert.equal(row.project, 'demo');
    assert.equal(row.workspaceId, 'ws');
    assert.equal(row.title, 'test');
    assert.equal(events.length, 2);
    live = null;
    await poller.refresh(homeId);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1);
    assert.equal(events.length, 2);
  } finally { poller.stop(); store.close(); }
});

test('live polling isolates slow homes and coalesces requests; stop ignores in-flight responses', async () => {
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  const homes = [{ homeId: 'slow' }, { homeId: 'fast' }];
  const writes = [];
  const poller = new LiveStatusPoller({ homes: () => homes,
    store: { getHome: () => true, applyLiveStatus: (id) => writes.push(id) },
    read: (home) => home.homeId === 'slow' ? slow : [] });
  poller.start();
  const pending = poller.refresh('slow');
  assert.equal(pending, poller.refresh('slow'));
  await poller.refresh('fast');
  assert.deepEqual(writes, ['fast']);
  poller.stop();
  release([]);
  await pending;
  assert.deepEqual(writes, ['fast']);
});

test('live reader honors running=false over stale projections and authenticates RPC', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    requests.push({ url, opts });
    if (opts.method !== 'POST') return new Response(null, { status: 303, headers: { 'Set-Cookie': 'auth=ok; HttpOnly' } });
    return Response.json({ type: 'server-response', result: { value: { items: [
      { sessionId: 's1', running: false, projections: { values: { sessionStats: { openStep: {} }, todos: [{ status: 'in_progress' }] } } },
      { sessionId: 's2', running: true },
    ] } } });
  });
  const rows = await new LiveStatusReader().read('http://localhost:3080/?token=test');
  assert.equal(rows[0].status.kind, 'idle');
  assert.equal(rows[1].status.kind, 'running');
  assert.equal(requests[1].opts.headers.Cookie, 'auth=ok');
  assert.equal(JSON.parse(requests[1].opts.body).method, 'session/list');
});

test('live reader reports failures once, distinguishes malformed and empty lists, and logs recovery without secrets', async (t) => {
  const { initLogger, getLogs, clearLogs } = await import('../src/lib/logger.js');
  initLogger({ level: 'info', file: false, silent: true });
  clearLogs();
  let response = () => new Response(null, { status: 401 });
  t.mock.method(globalThis, 'fetch', async (_url, opts) => opts.method === 'POST'
    ? response() : new Response(null, { status: 200 }));
  const reader = new LiveStatusReader();
  const url = 'http://localhost:3080/?token=DO_NOT_LOG';
  const context = { homeId: 'cms', host: 'bot@cms.lo' };
  assert.equal(await reader.read(url, context), null);
  assert.equal(await reader.read(url, context), null);
  assert.equal(getLogs({ limit: 100 }).length, 1);
  response = () => Response.json({ type: 'server-response', result: { ok: true, value: {} } });
  assert.equal(await reader.read(url, context), null);
  response = () => Response.json({ type: 'server-response', result: { ok: false, error: { code: 'gateway/bad-request', message: 'PRIVATE' } } });
  assert.equal(await reader.read(url, context), null);
  response = () => Response.json({ type: 'server-response', result: { ok: true, value: { items: [] } } });
  assert.deepEqual(await reader.read(url, context), []);
  const logs = JSON.stringify(getLogs({ limit: 100 }));
  assert.ok(logs.includes('rpc http 401'));
  assert.ok(logs.includes('gateway/bad-request'));
  assert.ok(logs.includes('同步成功'));
  assert.ok(!logs.includes('DO_NOT_LOG'));
  assert.ok(!logs.includes('PRIVATE'));
});

// ── 轮询里**第二次**读实例列表抛错曾直接冒成 uncaughtException ──
// tick() 只给第一次 this.homes() 套了 try/catch，但 refresh() 内部还会再读一次
// （用来取 activeEndpointId）。那次抛错落在同一个 setInterval 同步段里，
// 于是走 crash handler → process.exit(1)：工作台消失、没有任何界面提示。
test('live poller: homes() 第二次调用抛错时只跳过该实例，不再弄崩进程', () => {
  let calls = 0;
  const poller = new LiveStatusPoller({
    homes: () => {
      calls++;
      if (calls === 1) return [{ homeId: 'a', activeEndpointId: 'e1' }]; // 第一次正常
      throw new Error('数据库里的坏 JSON');                                // 之后都坏掉
    },
    store: { getHome: () => ({ activeEndpointId: 'e1' }), applyLiveStatus() {} },
    read: async () => [],
    intervalMs: 10,
  });
  // 原实现：tick() 里 refresh('a') 同步抛出 → start() 直接抛
  assert.doesNotThrow(() => poller.start());
  poller.stop();
});

test('live poller: homes() 返回非数组时也只跳过本轮（不因 .find/for-of 抛 TypeError）', () => {
  const poller = new LiveStatusPoller({
    homes: () => null,
    store: { getHome: () => true, applyLiveStatus() {} },
    read: async () => [],
    intervalMs: 10,
  });
  assert.doesNotThrow(() => poller.start());
  assert.doesNotThrow(() => poller.refresh('a'));
  poller.stop();
});
