import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IndexStore } from '../src/dshhome/store.js';
import { LiveStatusPoller } from '../src/dshhome/live-poller.js';
import { LiveStatusReader } from '../src/dshhome/live-status.js';
import { initLogger, getLogs } from '../src/lib/logger.js';

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
  // 成功日志只说「读取」成功 —— 写入是轮询器的事，写失败会单独记 warn（见下面那条用例）。
  // 原先这里写的是「实时会话同步成功」，在「读到了但一行都没写进去」时那句话是假的。
  assert.ok(logs.includes('读取成功'));
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

// 审查实测：一行脏数据（sessionId 是 `true`/`{}`/`[]`）会让整批 upsert 抛
// 「Provided value cannot be bound to SQLite parameter 2」，committed rows = 0 ——
// 而失败只记在 debug 上，默认 level（info）看不到：日志环里只有「同步成功」，
// 库里一行都没写，界面继续显示上一轮的**错**状态。现在：
//   ① 类型校验前移到 toLiveRow（只有非空字符串 sessionId 才接受）；
//   ② 写失败记 warn，并按「同 home 同原因」去重（成功即复位）。
test('live poller: 写失败必须记 warn（默认级别可见），且同因去重', async () => {
  initLogger({ level: 'info', file: false, color: false, silent: true });
  const store = {
    getHome: () => ({ homeId: 'h1', activeEndpointId: null }),
    applyLiveStatus: () => { throw new Error('Provided value cannot be bound to SQLite parameter 2'); },
  };
  const poller = new LiveStatusPoller({
    store, homes: () => [{ homeId: 'h1', activeEndpointId: null }],
    read: async () => [{ sessionId: 'x', status: { kind: 'idle', label: '空闲' } }],
    intervalMs: 60_000,
  });
  // refresh() 的守卫要求 running=true（否则整段静默空转 —— 这也是那条「日志说成功、库里 0 行」
  // 之所以难查的一部分）。这里不 start()，避免留下定时器。
  poller.running = true;
  await poller.refresh('h1');
  await poller.refresh('h1');
  await poller.refresh('h1');
  const warnings = getLogs({ limit: 100 }).filter((e) => e.level === 'warn' && String(e.message).includes('实时状态写入失败'));
  assert.equal(warnings.length, 1, `同 home 同原因只记一次（实际 ${warnings.length} 条）`);
  assert.match(JSON.stringify(warnings[0]), /cannot be bound/, '要带上真正的原因，便于排查');
});

// 「抓取期间端点被切换」这条守卫原先没有任何测试：审查把它改写成 `if (false) return`
// 之后整个套件仍然全绿（610/609/0）。而它守的是**静默写错行**：用户在 RPC 飞行途中切换连接端点，
// 那份快照属于**旧端点**，写下去就等于把 B 实例的状态记在 A 实例名下 —— 无日志、无降级标记，
// 界面上看不出来（本项目已经踩过的「静默错数据」那一类）。
test('live poller: 抓取期间 activeEndpointId 变了就不许写（否则会把状态写到错的实例上）', async () => {
  let applied = 0;
  const store = {
    // 第一次读（refresh 开头）与第二次读（写之前）返回**不同**的端点
    getHome: () => ({ homeId: 'h1', activeEndpointId: 'B' }),
    applyLiveStatus: () => { applied++; },
    liveStatusAt: () => 0,
  };
  const poller = new LiveStatusPoller({
    store,
    homes: () => [{ homeId: 'h1', activeEndpointId: 'A' }],
    read: async () => [{ sessionId: 'x', status: { kind: 'idle', label: '空闲' } }],
    intervalMs: 60_000,
  });
  poller.running = true;
  await poller.refresh('h1');
  assert.equal(applied, 0, '端点已变为 B（快照属于 A）时必须丢弃这份快照');
});

// tick 里已经有 home 列表，原先却还给每个实例传 homeId、让 refresh 再跑一次 `this.homes()`
// （= store.listHomes()，带两个相关子查询 COUNT + 每实例 #enrichHome）。规模审查实测：
// 200 个实例时单是这 200 次冗余调用就 3,868.9ms/轮（同步阻塞），并发探针最大停顿 4,936.7ms。
test('live poller: 一轮 tick 只读一次实例列表（不是每个实例一次）', async () => {
  let listCalls = 0;
  const homes = Array.from({ length: 8 }, (_, i) => ({ homeId: `h${i}`, activeEndpointId: null }));
  const store = { getHome: () => ({ homeId: 'h', activeEndpointId: null }), applyLiveStatus: () => {}, liveStatusAt: () => 0 };
  const poller = new LiveStatusPoller({
    store,
    homes: () => { listCalls++; return homes; },
    read: async () => [],
    intervalMs: 60_000,
  });
  // 直接 start()：它有 `if (this.running) return`，先手动置 running 就什么都不跑了
  // （我第一版就是这么写的 —— 断言恒真、变异也照样通过，典型的空洞断言）。
  poller.start();
  await new Promise((r) => setTimeout(r, 50));
  poller.stop();
  assert.ok(listCalls >= 1, `tick 必须真的跑过（实际读了 ${listCalls} 次实例列表）`);
  assert.ok(listCalls <= 2, `8 个实例只该读 1-2 次实例列表（实际 ${listCalls} 次）—— 传 home 对象正是为此`);
});

// 每轮每实例的 getHome 从两次减到一次：两行之间没有 await（getHome 是同步的），第二次读到的
// 必然是同一个值。规模审查实测单个 400k 会话的 home 上 getHome 要 32.6ms，而这里每轮每实例都跑。
test('live poller: 一轮 refresh 只点查一次该实例（原先是两次相邻的 getHome）', async () => {
  let gets = 0;
  const store = {
    getHome: () => { gets++; return { homeId: 'h1', activeEndpointId: null }; },
    applyLiveStatus: () => {},
    liveStatusAt: () => 0,
  };
  const poller = new LiveStatusPoller({
    store, homes: () => [{ homeId: 'h1', activeEndpointId: null }],
    read: async () => [{ sessionId: 'x', status: { kind: 'idle', label: '空闲' } }], intervalMs: 60_000,
  });
  poller.running = true;
  await poller.refresh('h1');
  assert.equal(gets, 1, `一次 refresh 只该点查一次实例（实际 ${gets} 次）`);
});
