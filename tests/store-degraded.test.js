import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IndexStore } from '../src/dshhome/store.js';
import { normalize } from '../src/lib/normalize.js';

// dsh 版本升级不该让实例在仪表盘上「变空」。
//
// upsertRows 是「整表替换」语义：先把该 home 的 sessions/workspaces/providers/model_tiers
// 全删，再按本次快照插入。当某个元数据文件的 unit.version 超出 SUPPORTED_VERSIONS 时
// （dsh 升级后的必然情形），该域被判 degraded、产出 0 行，于是**上一次成功索引的内容被删光**，
// 而界面上没有任何地方显示 degraded —— 用户看到的就是「这个实例的会话和项目全没了」。
//
// 正确语义：某域降级时，只保留该域对应的表不动（用上次成功的行），其余域照常刷新。

function iso(minAgo) {
  return new Date(Date.now() - minAgo * 60_000).toISOString();
}

function rowsFor(homeId, { degraded, sessionIds = ['s1'] }) {
  const good = degraded.length === 0;
  return normalize({
    homeId,
    homePath: '/mock/home',
    generatedAt: iso(0),
    wsVersion: good ? 2 : 999,
    pcVersion: good ? 3 : 999,
    modelTierVersion: good ? 2 : 999,
    workspaces: degraded.some((d) => d.domain === 'workspace') ? []
      : [{ workspaceId: 'ws-1', title: 'Alpha', path: '/r/alpha', archived: false, sessionIds: ['s1'] }],
    sessions: degraded.some((d) => d.domain === 'projcache') ? []
      : sessionIds.map((sessionId) => ({ sessionId, workspaceId: 'ws-1', tokenUsage: { uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }, lastActivity: iso(10) })),
    modelTier: degraded.some((d) => d.domain === 'modelTier') ? { activeId: null, tiers: {} } : { activeId: 'std', tiers: { std: { provider: 'deepseek', model: 'deepseek-chat' } } },
    providers: degraded.some((d) => d.domain === 'credentials') ? [] : [{ ref: 'DEEPSEEK_API_KEY', provider: 'deepseek' }],
    degraded,
  });
}

test('projcache 域降级时保留上次成功的会话，而不是清空该实例', () => {
  const store = new IndexStore(':memory:');
  const homeId = store.registerHome({ homePath: '/mock/home' });
  store.upsertRows(rowsFor(homeId, { degraded: [] }));
  assert.equal(store.recentSessions({ homeId }).length, 1, '前置条件：先有一次成功的索引');

  // dsh 升级：projcache 版本号变大 → 该域降级、产出 0 行
  store.upsertRows(rowsFor(homeId, { degraded: [{ domain: 'projcache', error: 'unsupported version 999', degraded: true }] }));

  const home = store.getHome(homeId);
  assert.equal(home.status, 'degraded', '实例状态应如实标记降级');
  assert.equal(home.degraded[0].domain, 'projcache');
  assert.equal(store.recentSessions({ homeId }).length, 1, '降级域的表必须保留上次成功的行，不能被删空');
  assert.equal(home.sessionCount, 1);
});

test('workspace 域降级时保留工作区，projcache 照常刷新', () => {
  const store = new IndexStore(':memory:');
  const homeId = store.registerHome({ homePath: '/mock/home' });
  store.upsertRows(rowsFor(homeId, { degraded: [] }));

  // 只有 workspace 降级：workspaces 保留旧的，而 projcache 未降级 → 会话表照常按新快照替换。
  // 用「会话从 1 条变成 2 条」来证明它确实被刷新了，而不是碰巧留着旧行。
  store.upsertRows(rowsFor(homeId, {
    degraded: [{ domain: 'workspace', error: 'unsupported version 999', degraded: true }],
    sessionIds: ['s1', 's2'],
  }));
  const home = store.getHome(homeId);
  assert.equal(store.listWorkspaces({ homeId }).length, 1, 'workspace 降级 → 保留旧工作区');
  assert.equal(store.recentSessions({ homeId }).length, 2, 'projcache 未降级 → 会话表按新快照替换');
  assert.deepEqual(home.degraded.map((d) => d.domain), ['workspace']);
});

test('credentials / modelTier 域降级各自保留自己的表', () => {
  const store = new IndexStore(':memory:');
  const homeId = store.registerHome({ homePath: '/mock/home' });
  store.upsertRows(rowsFor(homeId, { degraded: [] }));

  store.upsertRows(rowsFor(homeId, {
    degraded: [
      { domain: 'credentials', error: 'providers must be an array', degraded: true },
      { domain: 'modelTier', error: 'unsupported schema 999', degraded: true },
    ],
  }));
  const home = store.getHome(homeId);
  assert.equal(home.providers.length, 1, 'credentials 降级 → 保留旧 provider');
  assert.equal(home.activeTier?.tierId, 'std', 'modelTier 降级 → 保留旧 tier');
  assert.equal(store.recentSessions({ homeId }).length, 1, '未降级的域照常刷新（此处快照仍有会话）');
});

test('全部域降级时一行都不删', () => {
  const store = new IndexStore(':memory:');
  const homeId = store.registerHome({ homePath: '/mock/home' });
  store.upsertRows(rowsFor(homeId, { degraded: [] }));

  store.upsertRows(rowsFor(homeId, {
    degraded: ['workspace', 'projcache', 'modelTier', 'credentials']
      .map((domain) => ({ domain, error: 'unsupported', degraded: true })),
  }));
  const home = store.getHome(homeId);
  assert.equal(store.recentSessions({ homeId }).length, 1);
  assert.equal(store.listWorkspaces({ homeId }).length, 1);
  assert.equal(home.providers.length, 1);
  assert.equal(home.activeTier?.tierId, 'std');
});

test('恢复后降级标记清空、新数据正常覆盖', () => {
  const store = new IndexStore(':memory:');
  const homeId = store.registerHome({ homePath: '/mock/home' });
  store.upsertRows(rowsFor(homeId, { degraded: [] }));
  store.upsertRows(rowsFor(homeId, { degraded: [{ domain: 'projcache', error: 'unsupported version 999', degraded: true }] }));
  store.upsertRows(rowsFor(homeId, { degraded: [] }));
  const home = store.getHome(homeId);
  assert.equal(home.status, 'ok');
  assert.deepEqual(home.degraded, []);
  assert.equal(store.recentSessions({ homeId }).length, 1);
});
