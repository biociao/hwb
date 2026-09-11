import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IndexStore } from '../src/dshhome/store.js';
import { normalize } from '../src/lib/normalize.js';
import { mergeLiveStatus } from '../src/dshhome/reader.js';

// 实时列表变成空时的清理语义。
//
// live-status 的一次**成功**读取若返回空数组，含义是「dsh 当前没有会话」——这与读取失败
// （poller 传 null，根本不会调到 applyLiveStatus）不同。原先空数组被直接 return：
// 纯实时行（文件索引里还没有、只有 RPC 支撑的那些）会一直留着，于是用户在 dsh 里关掉全部会话后，
// 工作台仍显示上一个会话的「运行中」徽标，直到 60s 后的文件索引才纠正。

function seed(store) {
  const homeId = store.registerHome({ homePath: '/mock/home' });
  store.upsertRows(normalize({
    homeId, homePath: '/mock/home', generatedAt: new Date().toISOString(),
    wsVersion: 2, pcVersion: 3,
    workspaces: [{ workspaceId: 'ws-1', title: 'A', path: '/r/a', archived: false, sessionIds: ['from-file'] }],
    sessions: [{ sessionId: 'from-file', workspaceId: 'ws-1', tokenUsage: { uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }, lastActivity: new Date().toISOString() }],
    modelTier: null, providers: [], degraded: [],
  }));
  return homeId;
}

function liveSession(sessionId, kind = 'running') {
  return {
    sessionId, cwd: '/r/a', title: `${sessionId} title`,
    status: { kind, label: kind === 'running' ? '运行中' : '空闲', subagents: 0, approval: null },
    lastActivity: new Date().toISOString(),
    tokenUsage: { uncachedInputTokens: 5, outputTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 0 },
  };
}

test('mergeLiveStatus: 实时里独有的会话被标记为 liveOnly', () => {
  const rows = mergeLiveStatus([], [liveSession('rpc-only')], { homeId: 'h', generatedAt: 'now' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].liveOnly, 1, '只有 RPC 支撑的行必须带上标记');
});

test('applyLiveStatus: 实时列表变空时清掉纯实时行，但保留文件索引的会话', () => {
  const store = new IndexStore(':memory:');
  const homeId = seed(store);

  store.applyLiveStatus(homeId, [liveSession('from-file', 'running'), liveSession('rpc-only', 'running')]);
  assert.equal(store.recentSessions({ homeId }).length, 2, '前置条件：文件会话 + 实时补插会话');

  store.applyLiveStatus(homeId, []); // dsh 报「当前没有会话」
  const left = store.recentSessions({ homeId });
  assert.deepEqual(left.map((s) => s.sessionId), ['from-file'],
    '纯实时行应被清掉；有文件索引支撑的会话必须保留（它的权威来源是文件索引）');
  store.close();
});

test('applyLiveStatus: 空数组不再被当成「无事发生」', () => {
  const store = new IndexStore(':memory:');
  const homeId = seed(store);
  store.applyLiveStatus(homeId, [liveSession('rpc-only')]);
  assert.equal(store.recentSessions({ homeId }).length, 2);
  store.applyLiveStatus(homeId, []);
  assert.equal(store.recentSessions({ homeId }).length, 1, '空实时列表必须产生清理动作');
  store.close();
});

test('applyLiveStatus: 非数组（读取失败）不产生任何清理', () => {
  const store = new IndexStore(':memory:');
  const homeId = seed(store);
  store.applyLiveStatus(homeId, [liveSession('rpc-only')]);
  for (const bad of [null, undefined, 'oops', { items: [] }]) {
    store.applyLiveStatus(homeId, bad);
  }
  assert.equal(store.recentSessions({ homeId }).length, 2, '读取失败不能误删');
  store.close();
});

test('恢复后纯实时行可以重新补插', () => {
  const store = new IndexStore(':memory:');
  const homeId = seed(store);
  store.applyLiveStatus(homeId, [liveSession('rpc-only')]);
  store.applyLiveStatus(homeId, []);
  assert.equal(store.recentSessions({ homeId }).length, 1);
  store.applyLiveStatus(homeId, [liveSession('rpc-only', 'idle')]);
  const back = store.recentSessions({ homeId }).find((s) => s.sessionId === 'rpc-only');
  assert.ok(back, 'dsh 再次报告该会话时应重新补插');
  assert.equal((typeof back.status === 'string' ? JSON.parse(back.status) : back.status).kind, 'idle');
  store.close();
});

test('文件索引重跑后，实时补插的行被正式收录（liveOnly 归零语义）', () => {
  const store = new IndexStore(':memory:');
  const homeId = seed(store);
  store.applyLiveStatus(homeId, [liveSession('rpc-only')]);
  // 下一次文件索引会整表替换：rpc-only 若已在 projcache 里就会带上 liveOnly=0 重新落库
  store.upsertRows(normalize({
    homeId, homePath: '/mock/home', generatedAt: new Date().toISOString(),
    wsVersion: 2, pcVersion: 3,
    workspaces: [{ workspaceId: 'ws-1', title: 'A', path: '/r/a', archived: false, sessionIds: ['from-file', 'rpc-only'] }],
    sessions: [
      { sessionId: 'from-file', workspaceId: 'ws-1', tokenUsage: null, lastActivity: new Date().toISOString() },
      { sessionId: 'rpc-only', workspaceId: 'ws-1', tokenUsage: null, lastActivity: new Date().toISOString() },
    ],
    modelTier: null, providers: [], degraded: [],
  }));
  const ids = store.recentSessions({ homeId }).map((s) => s.sessionId).sort();
  assert.deepEqual(ids, ['from-file', 'rpc-only']);
  // 此后即使实时列表为空，两者都不该被删（都已有文件索引支撑）
  store.applyLiveStatus(homeId, []);
  assert.equal(store.recentSessions({ homeId }).length, 2);
  store.close();
});
