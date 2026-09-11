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


// 用**真实 normalize** 构造行：sessions 的 workspaceId/workspaceTitle/project 是由
// workspace.json 反查推导出来的 —— 手写死 workspaceId 就复现不出「workspace 降级 ⇒ 归属丢失」。
function snapshotRows(homeId, { wsDegraded = false, pcDegraded = false, status = null } = {}) {
  const degraded = [];
  if (wsDegraded) degraded.push({ domain: 'workspace', error: 'unsupported version 999', degraded: true });
  if (pcDegraded) degraded.push({ domain: 'projcache', error: 'unsupported version 999', degraded: true });
  return normalize({
    homeId, homePath: '/mock/home', generatedAt: iso(0),
    wsVersion: wsDegraded ? 999 : 2, pcVersion: pcDegraded ? 999 : 3,
    workspaces: wsDegraded ? [] : [{ workspaceId: 'ws-1', title: 'Alpha', path: '/r/alpha', archived: false, sessionIds: ['s1'] }],
    sessions: pcDegraded ? [] : [{ sessionId: 's1', cwd: '/r/alpha', tokenUsage: null, lastActivity: iso(10), status }],
    modelTier: null, providers: [], degraded,
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

// ── 跨表牵连：单个域降级不能把**别的**域的派生关系弄断 ──
//
// sessions 的 workspaceId/workspaceTitle/project 是从 workspace.json 推导的（normalize 反查
// workspace.sessionIds）。workspace 域降级时 snapshot.workspaces 为空 → 新产出的会话行
// workspaceId 全是 null，而 workspaces 表保留着旧行 → 会话与工作区断开：
// sessionWorkspace() 返回 null，preview/download/upload 对一个正常的会话报
// 「当前会话尚未关联可用的 project 工作区」。这里锁定「降级期间仍能找回归属」。

test('workspace 降级：保留的会话仍能找回自己的 workspace 归属', () => {
  const store = new IndexStore(':memory:');
  const homeId = store.registerHome({ homePath: '/mock/home' });
  store.upsertRows(snapshotRows(homeId));

  const before = store.recentSessions({ homeId })[0];
  assert.equal(before.workspaceId, 'ws-1');
  assert.equal(before.project, 'alpha');

  // 只有 workspace 降级：snapshot.workspaces 为空 → normalize 产出的会话行 workspaceId 为 null
  store.upsertRows(snapshotRows(homeId, { wsDegraded: true }));

  const after = store.recentSessions({ homeId });
  assert.equal(after.length, 1, '会话表照常按新快照刷新（projcache 未降级）');
  assert.equal(after[0].workspaceId, 'ws-1', 'workspace 降级 → 回填上一版的归属，不能让会话变成孤儿');
  assert.equal(after[0].workspaceTitle, 'Alpha');
  assert.equal(after[0].project, 'alpha', 'project 不该退化成 basename(cwd)');
  assert.equal(store.listWorkspaces({ homeId }).length, 1, '工作区本身也保留着');
  store.close();
});

test('workspace 降级：sessionWorkspace 仍能解析出工作区（预览/上传的前置条件）', async () => {
  const { sessionWorkspace } = await import('../src/lib/file-preview.js');
  const store = new IndexStore(':memory:');
  const homeId = store.registerHome({ homePath: '/mock/home' });
  store.upsertRows(snapshotRows(homeId));
  store.upsertRows(snapshotRows(homeId, { wsDegraded: true }));
  const workspaces = store.listWorkspaces({ homeId });
  const session = store.getSession(homeId, 's1');
  const resolved = sessionWorkspace(workspaces, session);
  assert.ok(resolved, '降级期间也必须能解析出工作区，否则预览/下载/上传全部 400');
  assert.equal(resolved.workspaceId, 'ws-1');
  store.close();
});

test('workspace 降级恢复后，归属仍以新数据为准', () => {
  const store = new IndexStore(':memory:');
  const homeId = store.registerHome({ homePath: '/mock/home' });
  store.upsertRows(snapshotRows(homeId));
  store.upsertRows(snapshotRows(homeId, { wsDegraded: true }));
  // 恢复：新快照把会话挂到另一个工作区
  store.upsertRows(normalize({
    homeId, homePath: '/mock/home', generatedAt: iso(0), wsVersion: 2, pcVersion: 3,
    workspaces: [{ workspaceId: 'ws-2', title: 'Beta', path: '/r/beta', archived: false, sessionIds: ['s1'] }],
    sessions: [{ sessionId: 's1', workspaceId: 'ws-2', tokenUsage: null, lastActivity: iso(5) }],
    modelTier: null, providers: [], degraded: [],
  }));
  const row = store.recentSessions({ homeId }).find((s) => s.sessionId === 's1');
  assert.equal(row.workspaceId, 'ws-2', '恢复后必须用新归属覆盖回填值');
  assert.equal(row.project, 'beta');
  store.close();
});

// ── 另一个跨表情形：projcache 降级 + 实时列表变空 ⇒ 幽灵「运行中」 ──

test('projcache 降级 + 实时列表为空：陈旧的状态徽标被清掉（不留幽灵「运行中」）', () => {
  const store = new IndexStore(':memory:');
  const homeId = store.registerHome({ homePath: '/mock/home' });
  // 先来一次带 running 状态的成功索引
  store.upsertRows(snapshotRows(homeId, { status: { kind: 'running', label: '运行中', subagents: 0, approval: null } }));
  assert.equal(((x) => (typeof x === 'string' ? JSON.parse(x) : x))(store.recentSessions({ homeId })[0].status).kind, 'running');

  // dsh 升级 → projcache 降级（会话行被保留）
  store.upsertRows(snapshotRows(homeId, { pcDegraded: true }));
  assert.equal(store.recentSessions({ homeId }).length, 1, '前置条件：行被保留');

  // dsh 报告「当前没有会话」
  store.applyLiveStatus(homeId, []);
  const row = store.recentSessions({ homeId })[0];
  assert.equal(row.status, null, '降级期间没有谁能刷新状态，就必须清掉陈旧的「运行中」，不能永久显示');
  assert.equal(store.recentSessions({ homeId }).length, 1, '清的是状态而不是行：数据仍在');
  store.close();
});

test('projcache 未降级时，空实时列表不会去动文件的 status（那份数据是可信的）', () => {
  const store = new IndexStore(':memory:');
  const homeId = store.registerHome({ homePath: '/mock/home' });
  store.upsertRows(snapshotRows(homeId, { status: { kind: 'running', label: '运行中', subagents: 0, approval: null } }));
  store.applyLiveStatus(homeId, []);
  const row = store.recentSessions({ homeId })[0];
  assert.ok(row.status, 'projcache 正常时不该被实时列表的缺失牵连');
  assert.equal((typeof row.status === 'string' ? JSON.parse(row.status) : row.status).kind, 'running');
  store.close();
});
