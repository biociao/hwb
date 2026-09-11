import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { IndexStore } from '../src/dshhome/store.js';
import { createApiServer } from '../src/api/server.js';

// `/api/usage` 是**八个同步 SQLite 聚合**（node:sqlite 没有异步接口），40k 会话实测合计 ~330ms，
// 而这期间整个单线程服务（HTTP / SSE / 30s 心跳）都停着。所以服务端有一层按周期的记忆。
//
// 但「按时间」的记忆有个坑：它不知道数据变没变。一个**空闲**的仪表盘（没有实例在跑 ⇒ 没有实时写入）
// 一个字节都不会变，却仍然每 10s 白跑一次那 330ms。现在 memo 带上 `store.dataVersion()`：
//   ① 版本没变 → 缓存**永远有效**（空闲时零成本）；
//   ② 版本变了但还在 TTL 内 → 仍然复用（实例在跑、每 3s 都有实时写入时，聚合频率仍压在 1/10s）。
// 这里用可注入的 `usageTtlMs`（40ms）把这个语义钉住。

async function withServer(store, fn) {
  const server = createApiServer({
    store,
    indexer: { reindexNow: async () => [] },
    hub: { broadcast() {}, handle() {} },
    launcher: { status: () => null, disconnect: async () => {} },
    monitor: { get: () => ({ runtime: 'stopped' }), refresh: async () => {} },
    quota: { list: () => [], refresh: async () => ({}) },
    logApi: { getLogs: () => [] },
    webRoot: '/nonexistent-web-root',
    usageTtlMs: 40,
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base); } finally { await new Promise((r) => server.close(r)); }
}

function sessionRow(homeId, sessionId, tokens, now) {
  return {
    type: 'session', homeId, sessionId, project: 'p', title: null,
    tokenUsage: JSON.stringify({ uncachedInputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    contextPressure: null, status: JSON.stringify({ kind: 'idle' }), lastActivity: now, generatedAt: now, liveOnly: 0,
  };
}

test('usage memo：数据版本没变时缓存长期有效，版本一变立刻重算（TTL 之外也一样）', async () => {
  const store = new IndexStore(':memory:');
  const homeId = store.registerHome({ homePath: '/m', hostType: 'local' });
  const now = new Date().toISOString();
  store.upsertRows([sessionRow(homeId, 's1', 100, now)]);

  let summaryCalls = 0;
  const orig = store.usageSummary.bind(store);
  store.usageSummary = (...args) => { summaryCalls++; return orig(...args); };

  await withServer(store, async (base) => {
    const get = async () => (await fetch(`${base}/api/usage?days=30&hours=720`)).json();

    assert.equal((await get()).summary.totalTokens, 100);
    assert.equal(summaryCalls, 1, '首次请求要真跑聚合');

    // 数据没变 + 超过 TTL（40ms）→ 仍然复用缓存
    await sleep(90);
    assert.equal((await get()).summary.totalTokens, 100);
    assert.equal(summaryCalls, 1, '版本没变就不该重算 —— 空闲的仪表盘不该每 10s 白跑 330ms');

    // 数据变了（新增一个会话）→ 版本 +1，TTL 也早过了 → 必须重算，且拿到新数字
    store.upsertRows([sessionRow(homeId, 's2', 5, now)]);
    assert.equal((await get()).summary.totalTokens, 105);
    assert.equal(summaryCalls, 2, '版本变了必须重算');

    // 版本又变了，但**在 TTL 内** → 仍然复用（节流还在：实例每 3s 写一次实时状态，不能每次都聚合）
    store.upsertRows([sessionRow(homeId, 's3', 7, now)]);
    assert.equal((await get()).summary.totalTokens, 105, 'TTL 内返回的是缓存的旧数字（这是有意的节流）');
    assert.equal(summaryCalls, 2, 'TTL 内不重算');

    // s3 的版本变化 + TTL 已过 → 这次才真的重算，拿到 112
    await sleep(90);
    assert.equal((await get()).summary.totalTokens, 112);
    assert.equal(summaryCalls, 3);

    // 之后版本没再变：即便又过了 TTL，也仍然复用（版本判据优先于时间判据）
    await sleep(90);
    assert.equal((await get()).summary.totalTokens, 112);
    assert.equal(summaryCalls, 3);
  });
  store.close();
});

// 数据版本必须覆盖所有会改变用量数据集的写入路径：文件索引 / 实时状态都走 upsertRows，
// 移除实例走 removeHome。少一条就会让「数据变了但版本没变」的缓存永久留着旧数字。
// （注意：TTL 内的失效由路由里的 dropUsageMemo() 负责 —— 版本判据本身是「TTL 之后必须重算」，
//   两者是互补的：前者保证用户操作立刻可见，后者保证空闲时不白跑聚合。）
test('usage memo：upsertRows 与 removeHome 都会抬高数据版本', () => {
  const store = new IndexStore(':memory:');
  const homeId = store.registerHome({ homePath: '/m', hostType: 'local' });
  const now = new Date().toISOString();
  const v0 = store.dataVersion();

  store.upsertRows([sessionRow(homeId, 's1', 42, now)]);
  const v1 = store.dataVersion();
  assert.ok(v1 > v0, '文件索引/实时状态写入必须抬高版本');

  store.upsertRows([sessionRow(homeId, 's2', 1, now)]);
  assert.ok(store.dataVersion() > v1, '再次写入继续抬高');

  const v2 = store.dataVersion();
  store.removeHome(homeId);
  assert.ok(store.dataVersion() > v2, '移除实例必须抬高版本');
  assert.equal(store.usageSummary({ days: 30 }).totalTokens, 0);
  store.close();
});
