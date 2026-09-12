import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IndexStore } from '../src/dshhome/store.js';
import { normalize } from '../src/lib/normalize.js';

function seed(store) {
  const now = Date.now();
  const iso = (minAgo) => new Date(now - minAgo * 60_000).toISOString();
  const homeId = store.registerHome({ homePath: '/mock/home' });
  const rows = normalize({
    homeId,
    homePath: '/mock/home',
    generatedAt: iso(0),
    wsVersion: 2,
    pcVersion: 3,
    workspaces: [
      { workspaceId: 'ws-1', title: 'Alpha', path: '/r/alpha', archived: false, sessionIds: ['s1', 's2'] },
      { workspaceId: 'ws-2', title: 'Empty', path: '/r/empty-proj', archived: false, sessionIds: [] },
    ],
    sessions: [
      { sessionId: 's1', workspaceId: 'ws-1', tokenUsage: { uncachedInputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 }, status: { kind: 'running', label: '运行中', subagents: 1, approval: 'ask' }, lastActivity: iso(30) },
      { sessionId: 's2', workspaceId: 'ws-1', tokenUsage: { uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }, lastActivity: iso(60 * 30) },
    ],
    modelTier: { activeId: 'std', tiers: { std: { provider: 'deepseek', model: 'deepseek-chat' } } },
    providers: [{ ref: 'DEEPSEEK_API_KEY', provider: 'deepseek' }],
    degraded: [],
  });
  store.upsertRows(rows);
  return homeId;
}

test('store upsert + query: homes, recent sessions, recent projects', () => {
  const store = new IndexStore(':memory:');
  const homeId = seed(store);

  const homes = store.listHomes();
  assert.equal(homes.length, 1);
  assert.equal(homes[0].homeId, homeId);
  assert.equal(homes[0].status, 'ok');
  assert.equal(homes[0].sessionCount, 2);
  assert.equal(homes[0].providers[0].provider, 'deepseek');
  assert.equal(homes[0].activeTier.tierId, 'std');

  const sessions = store.recentSessions({ homeId });
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].sessionId, 's1');
  assert.equal(sessions[0].tokenUsage.outputTokens, 20);
  assert.deepEqual(sessions[0].status, { kind: 'running', label: '运行中', subagents: 1, approval: 'ask' });
  assert.equal(sessions[1].status, null);

  const projects = store.recentProjects();
  const alpha = projects.find((p) => p.project === 'alpha');
  assert.equal(alpha.sessionCount, 2);
  assert.equal(alpha.outputTokens, 22);
  // workspace without sessions still appears as a project
  assert.ok(projects.some((p) => p.project === 'empty-proj' && p.sessionCount === 0));

  // 每个 home 的「当前项目/当前会话」= 最近活跃 session（s1 比 s2 新）及其所属项目。
  assert.equal(homes[0].current.sessionId, 's1');
  assert.equal(homes[0].current.project, 'alpha');
  assert.equal(homes[0].current.workspaceId, 'ws-1');
  assert.deepEqual(homes[0].current.status, { kind: 'running', label: '运行中', subagents: 1, approval: 'ask' });
  assert.equal(homes[0].current.tokenUsage.outputTokens, 20);

  store.close();
});

test('store re-upsert replaces child rows wholesale', () => {
  const store = new IndexStore(':memory:');
  const homeId = seed(store);
  const rows = normalize({
    homeId, homePath: '/mock/home', generatedAt: new Date().toISOString(),
    wsVersion: 2, pcVersion: 3,
    workspaces: [], sessions: [], modelTier: null,
    providers: [], degraded: [],
  });
  store.upsertRows(rows);
  assert.equal(store.recentSessions({}).length, 0);
  assert.equal(store.listWorkspaces().length, 0);
  assert.equal(store.listHomes()[0].status, 'ok');
  store.close();
});

// 降级域是「整表替换」的例外：它对应的表必须保留上一次成功索引的行。
// 否则一次 dsh 升级（unit.version 不再被识别）就会把该实例的会话/项目静默删空
// —— 界面上没有任何地方显示 degraded，用户只会看到实例「变空了」。
// 完整覆盖见 tests/store-degraded.test.js。
test('store re-upsert keeps rows of degraded domains only', () => {
  const store = new IndexStore(':memory:');
  const homeId = seed(store);
  const rows = normalize({
    homeId, homePath: '/mock/home', generatedAt: new Date().toISOString(),
    wsVersion: 999, pcVersion: 3,
    workspaces: [], sessions: [], modelTier: null,
    providers: [], degraded: [{ domain: 'workspace', error: 'gone', degraded: true }],
  });
  store.upsertRows(rows);
  assert.equal(store.listWorkspaces().length, 2, 'workspace 降级 → 保留旧行（seed 建了 2 个工作区）');
  assert.equal(store.recentSessions({}).length, 0, 'projcache 未降级 → 照常按快照替换');
  assert.equal(store.listHomes()[0].status, 'degraded');
  store.close();
});

test('store removeHome deletes home and all child rows', () => {
  const store = new IndexStore(':memory:');
  const homeId = seed(store);
  assert.deepEqual(store.listHomePaths(), ['/mock/home']);

  store.removeHome(homeId);
  assert.equal(store.listHomes().length, 0);
  assert.equal(store.getHome(homeId), null);
  assert.equal(store.recentSessions({}).length, 0);
  assert.equal(store.listWorkspaces().length, 0);
  assert.equal(store.listHomePaths().length, 0);
  store.close();
});

test('store 7-day window excludes stale sessions from recent projects', () => {
  const store = new IndexStore(':memory:');
  const homeId = store.registerHome({ homePath: '/mock/home2' });
  const stale = new Date(Date.now() - 10 * 86_400_000).toISOString();
  store.upsertRows(normalize({
    homeId, homePath: '/mock/home2', generatedAt: new Date().toISOString(),
    wsVersion: 2, pcVersion: 3,
    workspaces: [{ workspaceId: 'w', title: 'Old', path: '/r/old-proj', archived: false, sessionIds: ['s9'] }],
    sessions: [{ sessionId: 's9', workspaceId: 'w', tokenUsage: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, lastActivity: stale }],
    modelTier: null, providers: [], degraded: [],
  }));
  assert.equal(store.recentProjects({ days: 7 }).length, 0);
  assert.equal(store.recentProjects({ days: 30 }).length, 1);
  store.close();
});

test('store setHomeOrder persists tab order', () => {
  const store = new IndexStore(':memory:');
  const a = store.registerHome({ homePath: '/mock/a' });
  const b = store.registerHome({ homePath: '/mock/b' });
  const c = store.registerHome({ homePath: '/mock/c' });
  // 默认按注册顺序
  assert.deepEqual(store.listHomePaths(), ['/mock/a', '/mock/b', '/mock/c']);
  // 重排为 b,c,a
  store.setHomeOrder([b, c, a]);
  assert.deepEqual(store.listHomePaths(), ['/mock/b', '/mock/c', '/mock/a']);
  assert.deepEqual(store.listHomes().map((h) => h.homeId), [b, c, a]);
  // 重注册已存在 home 不会打乱排序
  store.registerHome({ homePath: '/mock/c', alias: 'C' });
  assert.deepEqual(store.listHomePaths(), ['/mock/b', '/mock/c', '/mock/a']);
  store.close();
});

test('store registers remote homes (host/remotePort) and skips them from local index paths', () => {
  const store = new IndexStore(':memory:');
  const localId = store.registerHome({ homePath: '/mock/local', alias: 'MBP' });
  const remoteId = store.registerHome({ homePath: 'ssh://c4g.tun:3080', alias: 'c4g.tun', hostType: 'remote', host: 'c4g.tun', remotePort: 3080, remoteHome: '/home/u/.dsh' });
  const homes = store.listHomes();
  const local = homes.find((h) => h.homeId === localId);
  const remote = homes.find((h) => h.homeId === remoteId);
  assert.equal(local.hostType, 'local');
  assert.equal(remote.hostType, 'remote');
  assert.equal(remote.host, 'c4g.tun');
  assert.equal(remote.remotePort, 3080);
  assert.equal(remote.remoteHome, '/home/u/.dsh');
  // 本地索引路径只含 local home
  assert.deepEqual(store.listLocalHomePaths(), ['/mock/local']);
  // 重注册远程不丢配置
  store.registerHome({ homePath: 'ssh://c4g.tun:3080', alias: 'c4g', hostType: 'remote', host: 'c4g.tun', remotePort: 4444 });
  assert.equal(store.getHome(remoteId).remotePort, 4444);
  store.close();
});

test('store updateHomeConfig edits alias/remote config and preserves unspecified fields', () => {
  const store = new IndexStore(':memory:');
  const id = store.registerHome({ homePath: 'ssh://c4g:3080', alias: 'c4g', hostType: 'remote', host: 'c4g', remotePort: 3080, remoteHome: '~/.dsh' });
  store.updateHomeConfig(id, { alias: 'x', remotePort: 4444 });
  const h = store.getHome(id);
  assert.equal(h.alias, 'x');
  assert.equal(h.remotePort, 4444);
  assert.equal(h.host, 'c4g');       // 未指定 → 保留
  assert.equal(h.remoteHome, '~/.dsh'); // 未指定 → 保留
  // 未知 homeId → null
  assert.equal(store.updateHomeConfig('ffffffffffffffff', { alias: 'z' }), null);
  store.close();
});

test('store persists hand-set token on remote homes (register + update + clear)', () => {
  const store = new IndexStore(':memory:');
  const id = store.registerHome({ homePath: 'ssh://c4g:3080', hostType: 'remote', host: 'c4g', remotePort: 3080, token: '?token=AbC-xyz_123' });
  assert.equal(store.getHome(id).token, '?token=AbC-xyz_123');
  // 更新其它字段不丢 token
  store.updateHomeConfig(id, { remotePort: 4444 });
  assert.equal(store.getHome(id).token, '?token=AbC-xyz_123');
  // 显式清空 token（回到远端抓取流程）
  store.updateHomeConfig(id, { token: null });
  assert.equal(store.getHome(id).token, null);
  store.close();
});

test('store updateHomeConfig re-keys a local home when homePath changes', () => {
  const store = new IndexStore(':memory:');
  const id = store.registerHome({ homePath: '/mock/a', alias: 'A' });
  // 预置子行，验证随 re-key 迁移
  store.upsertRows(normalize({
    homeId: id, homePath: '/mock/a', generatedAt: new Date().toISOString(),
    wsVersion: 2, pcVersion: 3,
    workspaces: [{ workspaceId: 'w', title: 'T', path: '/r/p', archived: false, sessionIds: ['s1'] }],
    sessions: [{ sessionId: 's1', workspaceId: 'w', tokenUsage: { outputTokens: 1 }, lastActivity: new Date().toISOString() }],
    modelTier: null, providers: [], degraded: [],
  }));
  const updated = store.updateHomeConfig(id, { homePath: '/mock/b', alias: 'B' });
  assert.notEqual(updated.homeId, id);
  assert.equal(updated.homePath, '/mock/b');
  assert.equal(updated.alias, 'B');
  // 子行迁移到新 homeId
  assert.equal(store.recentSessions({ homeId: updated.homeId }).length, 1);
  assert.equal(store.getHome(id), null); // 旧 homeId 已不存在
  // 目标路径已被注册 → 报错
  store.registerHome({ homePath: '/mock/c', alias: 'C' });
  assert.throws(() => store.updateHomeConfig(updated.homeId, { homePath: '/mock/c' }), /已注册/);
  store.close();
});

test('store usageSummary/usageTrend/usageByProject aggregate tokenUsage over window', () => {
  const store = new IndexStore(':memory:');
  const homeId = store.registerHome({ homePath: '/mock/home' });
  const now = new Date().toISOString();
  store.upsertRows(normalize({
    homeId, homePath: '/mock/home', generatedAt: now, wsVersion: 2, pcVersion: 3,
    workspaces: [
      { workspaceId: 'ws1', title: 'Alpha', path: '/r/alpha', archived: false, sessionIds: ['s1'] },
      { workspaceId: 'ws2', title: 'Beta', path: '/r/beta', archived: false, sessionIds: ['s2'] },
    ],
    sessions: [
      { sessionId: 's1', workspaceId: 'ws1', tokenUsage: { uncachedInputTokens: 100, outputTokens: 20, cacheReadTokens: 80, cacheWriteTokens: 40 }, lastActivity: now },
      { sessionId: 's2', workspaceId: 'ws2', tokenUsage: { uncachedInputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, lastActivity: now },
    ],
    modelTier: null, providers: [], degraded: [],
  }));
  const s = store.usageSummary({ days: 7 });
  assert.equal(s.sessionCount, 2);
  assert.equal(s.inputTokens, 110);
  assert.equal(s.outputTokens, 25);
  assert.equal(s.cacheRead, 80);
  assert.equal(s.cacheWrite, 40);
  assert.equal(s.totalTokens, 255);
  assert.ok(s.cacheHitRate > 0);
  const trend = store.usageTrend({ hours: 24 });
  assert.equal(trend.length, 24);
  const byp = store.usageByProject({ days: 7 });
  assert.equal(byp.length, 2);
  assert.equal(byp[0].project, 'alpha'); // tokens 降序：alpha=240 > beta=15
  store.close();
});

test('store usageTrendGrouped buckets by dimension (total/project/instance/provider)', () => {
  const store = new IndexStore(':memory:');
  const recent = new Date(Date.now() - 10 * 3_600_000).toISOString(); // 窗内（约 10h 前）避免落在当前未满小时桶之外
  const a = store.registerHome({ homePath: '/mock/a', alias: 'A实例' });
  const b = store.registerHome({ homePath: '/mock/b', alias: 'B实例' });

  const rowsOf = (homeId, homePath, provider, ws, sessions) => normalize({
    homeId, homePath, generatedAt: recent, wsVersion: 2, pcVersion: 3,
    workspaces: ws, sessions,
    modelTier: { activeId: 'scheme', tiers: { default: { provider, model: 'm' } } },
    providers: [], degraded: [],
  });
  const aRows = rowsOf(a, '/mock/a', 'deepseek', [
    { workspaceId: 'wa1', title: 'Alpha', path: '/r/alpha', archived: false, sessionIds: ['s1'] },
    { workspaceId: 'wa2', title: 'Beta', path: '/r/beta', archived: false, sessionIds: ['s2'] },
  ], [
    { sessionId: 's1', workspaceId: 'wa1', tokenUsage: { uncachedInputTokens: 100, outputTokens: 20, cacheReadTokens: 80, cacheWriteTokens: 40 }, lastActivity: recent },
    { sessionId: 's2', workspaceId: 'wa2', tokenUsage: { uncachedInputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, lastActivity: recent },
  ]);
  const bRows = rowsOf(b, '/mock/b', 'kimi', [
    { workspaceId: 'wb1', title: 'Gamma', path: '/r/gamma', archived: false, sessionIds: ['s3'] },
  ], [
    { sessionId: 's3', workspaceId: 'wb1', tokenUsage: { uncachedInputTokens: 50, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }, lastActivity: recent },
  ]);
  store.upsertRows([...aRows, ...bRows]);

  const nonEmpty = (t) => t.buckets.find((x) => x.total > 0);
  const groupsOf = (t) => new Set(t.buckets.flatMap((x) => Object.keys(x.groups)));

  const project = store.usageTrendGrouped({ dimension: 'project', hours: 24 });
  const pg = groupsOf(project);
  assert.ok(pg.has('alpha') && pg.has('beta') && pg.has('gamma'));
  assert.equal(nonEmpty(project).total, 315); // (100+20+80+40) + (10+5) + (50+10)

  const total = store.usageTrendGrouped({ dimension: 'total', hours: 24 });
  assert.deepEqual(Object.keys(nonEmpty(total).groups), ['合计']);
  // 自适应粒度：24h → 每 15 分钟一桶，共 96 桶（比固定 1 小时更细）。
  assert.equal(total.buckets.length, 96);
  assert.equal(total.stepMs, 15 * 60_000);

  const provider = store.usageTrendGrouped({ dimension: 'provider', hours: 24 });
  const pr = groupsOf(provider);
  assert.ok(pr.has('deepseek'), 'provider groups include deepseek');
  assert.ok(pr.has('kimi'), 'provider groups include kimi');

  const model = store.usageTrendGrouped({ dimension: 'model', hours: 24 });
  const mg = groupsOf(model);
  // Model 维度的取值来源只有**当前档位配置**（会话真实模型在 .zstd 日志里，而本项目硬性规则
  // 是永不碰它）。所以标签必须自带「（档位推定）」后缀，与事实区分开：
  // 它既不是该会话真实用过的模型，还会随用户改默认模型而改写历史。
  assert.ok(mg.has('m（档位推定）'), `model groups 必须标注档位推定，got ${[...mg].join('/')}`);

  const instance = store.usageTrendGrouped({ dimension: 'instance', hours: 24 });
  const ig = groupsOf(instance);
  assert.ok(ig.has('A实例') && ig.has('B实例'), 'instance groups use home alias labels');

  store.close();
});

// 统计周期 → 自适应粒度：短周期更细、长周期更粗，柱数保持在合理范围（约 48~72）。
test('store usageTrendGrouped auto-adjusts bucket granularity by period (hours)', () => {
  const store = new IndexStore(':memory:');
  const recent = new Date(Date.now() - 10 * 3_600_000).toISOString();
  const a = store.registerHome({ homePath: '/mock/a' });
  const rows = normalize({
    homeId: a, homePath: '/mock/a', generatedAt: recent, wsVersion: 2, pcVersion: 3,
    workspaces: [{ workspaceId: 'ws1', title: 'Alpha', path: '/r/alpha', archived: false, sessionIds: ['s1'] }],
    sessions: [{ sessionId: 's1', workspaceId: 'ws1', tokenUsage: { uncachedInputTokens: 100, outputTokens: 20, cacheReadTokens: 10, cacheWriteTokens: 5 }, lastActivity: recent }],
    modelTier: null, providers: [], degraded: [],
  });
  store.upsertRows(rows);

  const cases = [
    { hours: 24, stepMs: 15 * 60_000, buckets: 96 }, // 过去 24h（每 15 分钟）
    { hours: 72, stepMs: 60 * 60_000, buckets: 72 }, // 3 天
    { hours: 168, stepMs: 3 * 60 * 60_000, buckets: 56 }, // 7 天
    { hours: 336, stepMs: 6 * 60 * 60_000, buckets: 56 }, // 14 天
    { hours: 720, stepMs: 12 * 60 * 60_000, buckets: 60 }, // 30 天
  ];
  for (const c of cases) {
    const t = store.usageTrendGrouped({ dimension: 'total', hours: c.hours });
    assert.equal(t.stepMs, c.stepMs, `stepMs for ${c.hours}h`);
    assert.equal(t.buckets.length, c.buckets, `bucket count for ${c.hours}h`);
    assert.equal(t.hours, c.hours);
  }

  // 长周期下数据仍在（会话落在对应桶中，total>0 至少一桶）。
  const long = store.usageTrendGrouped({ dimension: 'total', hours: 720 });
  assert.ok(long.buckets.some((b) => b.total > 0), '30d 窗口内保留会话数据');

  store.close();
});

test('store recentProjects carry jump targets (homeId/sessionId/workspaceId)', () => {
  const store = new IndexStore(':memory:');
  const homeId = seed(store);
  const projects = store.recentProjects();
  const alpha = projects.find((p) => p.project === 'alpha');
  assert.equal(alpha.homeId, homeId);
  assert.equal(alpha.sessionId, 's1'); // alpha 的最新会话
  assert.equal(alpha.workspaceId, 'ws-1');
  assert.equal(alpha.sessionCount, 2);
  const empty = projects.find((p) => p.project === 'empty-proj');
  assert.equal(empty.homeId, homeId);
  assert.equal(empty.workspaceId, 'ws-2');
  assert.equal(empty.sessionId, null); // 无会话，仅定位到实例/工作区
  assert.equal(empty.sessionCount, 0);
  store.close();
});


test('store localPort: 本机直连端口 round-trip（register/list/update/clear）', () => {
  const store = new IndexStore(':memory:');
  // 注册时带 localPort + token
  const homeId = store.registerHome({ homePath: '/mock/local', hostType: 'local', localPort: 3080, token: 'token=abc' });
  let h = store.getHome(homeId);
  assert.equal(h.localPort, 3080);
  assert.equal(h.token, 'token=abc');
  // listHomes 也带出 localPort
  assert.equal(store.listHomes()[0].localPort, 3080);
  // 更新 localPort / 清空
  store.updateHomeConfig(homeId, { localPort: 60761, token: 'token=xyz' });
  h = store.getHome(homeId);
  assert.equal(h.localPort, 60761);
  assert.equal(h.token, 'token=xyz');
  // 清空（null）→ 回到「新拉起」语义
  store.updateHomeConfig(homeId, { localPort: null });
  assert.equal(store.getHome(homeId).localPort, null);
  store.close();
});

// getHome 必须是**点查**，不能实现成 listHomes().find(...)。
// listHomes 对每个实例都要跑 providers / activeTier / currentSession 三条语句加两次 JSON.parse，
// 而 live-poller 每约 3s 就会对每个实例多次调用 getHome：十几个实例时就是每轮十几毫秒的同步阻塞
// （node:sqlite 是同步 API，直接卡住事件循环 —— SSE、HTTP、监控心跳一起等）。
// 这里用「把 listHomes 换成一调用就抛」来结构性地钉住这一点，不依赖计时（避免慢机器误报）。
test('getHome is a point query and never goes through listHomes', () => {
  const store = new IndexStore(':memory:');
  const homeId = seed(store);
  const original = store.listHomes;
  store.listHomes = () => { throw new Error('getHome must not call listHomes'); };
  try {
    const home = store.getHome(homeId);
    assert.equal(home.homeId, homeId);
    assert.equal(home.sessionCount, 2, '点查也必须带上同一套派生字段');
    // node:sqlite 返回 null-prototype 行，先摊平成普通对象再比较
    assert.deepEqual(home.providers.map((p) => ({ ...p })), [{ homeId, ref: 'DEEPSEEK_API_KEY', provider: 'deepseek' }]);
    assert.equal(home.activeTier.tierId, 'std');
    assert.equal(store.getHome('does-not-exist'), null);
    assert.equal(store.getHome(''), null, '空 id 直接返回 null，不查库');
  } finally {
    store.listHomes = original;
  }
  store.close();
});

test('getHome and listHomes agree on the enriched shape', () => {
  const store = new IndexStore(':memory:');
  const homeId = seed(store);
  const fromList = store.listHomes().find((h) => h.homeId === homeId);
  const fromPoint = store.getHome(homeId);
  assert.deepEqual(JSON.parse(JSON.stringify(fromPoint)), JSON.parse(JSON.stringify(fromList)),
    '两条路径必须返回完全一致的实例视图');
  store.close();
});

// 实例维度按 `basename(homePath)` 打标签，而 dsh 的默认 home 目录就叫 `.dsh` ——
// 两个实例（不同用户/项目下的 .dsh）会得到同一个标签，图例上被**合并成一条**（实测 1000+7000
// 画成一条 `.dsh: 8000`）。撞名时必须补一段标识，而不是让数字悄悄合到一起。
test('usageTrendGrouped: instance 维度不会把同名实例合并成一条', () => {
  const store = new IndexStore(':memory:');
  const now = new Date().toISOString();
  const a = store.registerHome({ homePath: '/Users/alice/.dsh', hostType: 'local' });
  const b = store.registerHome({ homePath: '/Users/bob/proj/.dsh', hostType: 'local' });
  const row = (homeId, sessionId, tok) => ({ type: 'session', homeId, sessionId, project: 'p', title: null,
    tokenUsage: JSON.stringify({ uncachedInputTokens: tok }), contextPressure: null,
    status: JSON.stringify({ kind: 'idle' }), lastActivity: now, generatedAt: now, liveOnly: 0 });
  store.upsertRows([row(a, 's1', 1000), row(b, 's2', 7000)]);
  const g = store.usageTrendGrouped({ dimension: 'instance', hours: 24 });
  const labels = [...new Set(g.buckets.flatMap((x) => Object.keys(x.groups)))];
  assert.equal(labels.length, 2, `两个实例应是两条序列，实际 ${JSON.stringify(labels)}`);
  const total = g.buckets.reduce((acc, x) => acc + x.total, 0);
  assert.equal(total, 8000, '总量不变（只是拆成两条）');
  store.close();
});

// lastActivity 在**未来**（远端实例时钟偏、或 dsh 写了将来时间戳）时，桶号会超出
// [startHour, endHour]：用量汇总把它算进去了、趋势图却整条丢掉（实测 summary 6000 / trend 0）。
test('usageTrend/usageTrendGrouped: 未来时间戳不再被趋势图丢掉（与 summary 口径一致）', () => {
  const store = new IndexStore(':memory:');
  const h = store.registerHome({ homePath: '/x', hostType: 'local' });
  const future = new Date(Date.now() + 6 * 3_600_000).toISOString();   // 时钟偏 6 小时
  store.upsertRows([{ type: 'session', homeId: h, sessionId: 'fut', project: 'p', title: null,
    tokenUsage: JSON.stringify({ uncachedInputTokens: 6000 }), contextPressure: null,
    status: JSON.stringify({ kind: 'idle' }), lastActivity: future, generatedAt: future, liveOnly: 0 }]);
  const sum = store.usageSummary({ days: 30 }).totalTokens;
  const trend = store.usageTrend({ hours: 24 }).reduce((a, r) => a + r.input + r.output + r.cacheRead + r.cacheWrite, 0);
  const grouped = store.usageTrendGrouped({ dimension: 'total', hours: 24 }).buckets.reduce((a, x) => a + x.total, 0);
  assert.equal(sum, 6000);
  assert.equal(trend, sum, `趋势应与汇总一致，实际 trend=${trend} summary=${sum}`);
  assert.equal(grouped, sum, `分组趋势应与汇总一致，实际 grouped=${grouped}`);
  store.close();
});

// `recentProjects` 的「孤立 workspace」那一半需要 `sessions(homeId, workspaceId)`：
// 没有它时 SQLite 只能 SCAN 整张 workspaces 表逐行关联。规模审查实测（400k 会话 / 50k workspace）：
// 那一半本身 **35,340ms** 却产出 0 行，整个查询 44,311ms，期间整个服务停住（并发探针最大停顿 9,758ms）；
// 加上索引后 35,340ms → 43ms。
// 这条测试用**自校准 A/B**（同一份数据、同一台机器，只差这个索引）而不是绝对时间阈值 ——
// 后者在慢机器/负载下会变成假失败。实测对照（20k 会话 / 4k workspace）：368ms → 6ms。
test('store: recentProjects 的孤立 workspace 查询依赖 idx_sessions_home_ws（自校准 A/B）', () => {
  const store = new IndexStore(':memory:');
  const now = new Date().toISOString();
  for (let h = 0; h < 4; h++) {
    const homeId = store.registerHome({ homePath: `/p${h}` });
    const rows = [{ type: 'home', homeId, homePath: `/p${h}`, generatedAt: now, degraded: [] }];
    for (let w = 0; w < 500; w++) rows.push({ type: 'workspace', homeId, workspaceId: `w${h}-${w}`, title: `W${w}`, path: `/r/p${w}`, project: `p${w}`, archived: 0, sessionCount: 0 });
    // 只给一半 workspace 造会话：另一半是「孤儿」（recentProjects 仍要按项目聚合出来）
    for (let s = 0; s < 2500; s++) {
      rows.push({ type: 'session', homeId, sessionId: `s${h}-${s}`, workspaceId: `w${h}-${s % 250}`, workspaceTitle: 'T',
        project: `p${s % 250}`, title: `t${s}`, tokenUsage: null, contextPressure: null, status: null,
        lastActivity: now, generatedAt: now, liveOnly: 0 });
    }
    store.upsertRows(rows);
  }
  // SCHEMA 里必须带这个索引（新库一建就有）
  const idx = store.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_sessions_home_ws'").get();
  assert.ok(idx, 'SCHEMA 必须建 idx_sessions_home_ws（否则大库上 recentProjects 会整表扫）');

  const timed = () => { const t = process.hrtime.bigint(); const rows = store.recentProjects({ days: 3650, limit: 50 }); return { ms: Number(process.hrtime.bigint() - t) / 1e6, rows }; };
  const withIndex = timed();
  store.db.exec('DROP INDEX idx_sessions_home_ws');
  const without = timed();

  assert.ok(withIndex.rows.length > 0 && without.rows.length === withIndex.rows.length,
    `两种情况下结果必须一致（${withIndex.rows.length} vs ${without.rows.length}）`);
  assert.ok(without.ms > withIndex.ms * 3,
    `去掉索引后必须明显更慢（有索引 ${withIndex.ms.toFixed(1)}ms、无索引 ${without.ms.toFixed(1)}ms）—— 这条断言就是在守那个索引`);
  store.close();
});
