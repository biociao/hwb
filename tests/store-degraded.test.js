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

// 穷举「哪些域降级」的全部 16 种组合，逐一核对「该域对应的表保留、其余照常清空」。
// 单点用例容易恰好都写在对的路径上；组合矩阵能抓到「两个域同时降级时的相互影响」这类问题
// （历史上这里就出过顺序问题：归属映射在 DELETE 之后才读，读到的已经是空表）。
const DOMAIN_TABLE = { workspace: 'workspaces', projcache: 'sessions', credentials: 'providers', modelTier: 'model_tiers' };

test('upsertRows：16 种降级组合下，保留/清空的表都与降级域一一对应', () => {
  const domains = Object.keys(DOMAIN_TABLE);
  const seeded = (homeId) => normalize({
    homeId, homePath: '/m', generatedAt: iso(0), wsVersion: 2, pcVersion: 3,
    workspaces: [{ workspaceId: 'w1', title: 'A', path: '/r/a', archived: false, sessionIds: ['s1'] }],
    sessions: [{ sessionId: 's1', tokenUsage: null, lastActivity: iso(1) }],
    modelTier: { activeId: 'std', tiers: { std: { provider: 'p', model: 'm' } } },
    providers: [{ ref: 'K', provider: 'p' }], degraded: [],
  });

  const mismatches = [];
  for (let mask = 0; mask < 16; mask++) {
    const degradedDomains = domains.filter((_, i) => mask & (1 << i));
    const store = new IndexStore(':memory:');
    const homeId = store.registerHome({ homePath: '/m' });
    store.upsertRows(seeded(homeId));
    // 第二次 upsert：所有域都产出 0 行，被标记降级的域应对应的表必须保留旧行
    store.upsertRows(normalize({
      homeId, homePath: '/m', generatedAt: iso(0),
      wsVersion: degradedDomains.includes('workspace') ? 999 : 2,
      pcVersion: degradedDomains.includes('projcache') ? 999 : 3,
      workspaces: [], sessions: [], modelTier: null, providers: [],
      degraded: degradedDomains.map((domain) => ({ domain, error: 'x', degraded: true })),
    }));

    const home = store.getHome(homeId);
    const actual = {
      sessions: store.recentSessions({ homeId }).length,
      workspaces: store.listWorkspaces({ homeId }).length,
      providers: home.providers.length,
      modelTiers: home.activeTier ? 1 : 0,
    };
    const expected = {
      sessions: degradedDomains.includes('projcache') ? 1 : 0,
      workspaces: degradedDomains.includes('workspace') ? 1 : 0,
      providers: degradedDomains.includes('credentials') ? 1 : 0,
      modelTiers: degradedDomains.includes('modelTier') ? 1 : 0,
    };
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      mismatches.push(`degraded=[${degradedDomains.join(',') || '无'}] 实际 ${JSON.stringify(actual)} 期望 ${JSON.stringify(expected)}`);
    }
    store.close();
  }
  assert.deepEqual(mismatches, [], `降级组合行为不符：\n${mismatches.join('\n')}`);
});

// ── 降级 + 实时合并不能吃掉文件索引撑起来的行（审查 F1，CRITICAL）──
// projcache 域降级时 normalize() 产出 0 条会话行，于是 mergeLiveStatus 把**每一条**实时会话都
// 当成「文件里还没有的新会话」（liveOnly=1、title/workspaceId/tokenUsage 全 null）。
// 而库里那行是被刻意保留下来的（降级时跳过 DELETE）。两者相撞时，原先的 ON CONFLICT 会用 live 的
// 空值覆盖文件值，并把 liveOnly 从 0 翻成 1 —— 用量面板整段历史归零（实测 1520550 → 620550，
// 丢 59%），会话丢掉标题与工作区归属；更要命的是翻成 1 之后，下一次「实时列表为空」的轮询会
// 把它删掉。文件快照坏掉不该等于历史被删。
test('降级 + 实时合并：不得用 live 的空值覆盖文件值，也不得把它翻成 liveOnly=1', () => {
  const store = new IndexStore(':memory:');
  const homeId = store.registerHome({ homePath: '/m', hostType: 'local' });
  const now = new Date().toISOString();
  // ① 先有一次成功的文件索引
  store.upsertRows([
    { type: 'session', homeId, sessionId: 'sess-003', workspaceId: 'ws-beta', workspaceTitle: 'beta',
      project: 'quota-axi', title: '额度适配器框架',
      tokenUsage: JSON.stringify({ uncachedInputTokens: 230000, outputTokens: 41200, cacheReadTokens: 610000, cacheWriteTokens: 18800 }),
      contextPressure: null, status: JSON.stringify({ kind: 'idle' }), lastActivity: now, generatedAt: now, liveOnly: 0 },
  ]);
  const before = store.usageSummary({ days: 30 });

  // ② projcache 降级 + 实时列表里有同一条会话（reader.js 在降级时就是这个形状）
  store.upsertRows([
    { type: 'home', homeId, homePath: '/m', degraded: [{ domain: 'projcache', error: 'unsupported version' }],
      generatedAt: now },
    { type: 'session', homeId, sessionId: 'sess-003', workspaceId: null, workspaceTitle: null,
      project: 'sess-003', title: null, tokenUsage: null, contextPressure: null,
      status: JSON.stringify({ kind: 'running' }), lastActivity: now, generatedAt: now, liveOnly: 1 },
  ]);
  const row = store.db.prepare("SELECT * FROM sessions WHERE sessionId = 'sess-003'").get();
  assert.equal(row.liveOnly, 0, '文件索引撑起来的行不该被翻成 liveOnly=1（否则下一轮空列表会删掉它）');
  assert.equal(row.title, '额度适配器框架', '标题不该被 live 的空值覆盖');
  assert.equal(row.workspaceId, 'ws-beta', '工作区归属不该被清掉');
  assert.ok(row.tokenUsage && row.tokenUsage.includes('230000'), 'token 历史不该被清成 null');
  assert.equal(JSON.parse(row.status).kind, 'running', '实时状态仍要生效（这才是 live 该提供的）');
  assert.deepEqual(store.usageSummary({ days: 30 }), before, '用量统计不该因为一次降级而缩水');

  // ③ 降级期间实时列表变成空：那行**不能**被删（它还有文件索引依据）
  store.applyLiveStatus(homeId, []);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE sessionId = 'sess-003'").get().n, 1,
    '文件索引撑起来的行不该被「空实时列表」删掉');
  store.close();
});

// ── 幽灵会话：只要有任意一条会话还活着，消失的「纯实时行」也必须清掉（审查 F2，HIGH）──
// liveOnly=1 的行只由实时列表支撑。原先只在「列表完全为空」时清理，于是先前消失的会话会一直留着：
// 永远显示「运行中」、占着 sessionCount、还造出一个幻影项目（实测 70 秒直到下一轮文件索引；
// projcache 降级时是永久的）。
test('实时列表非空时也要清掉消失的 liveOnly 行（幽灵会话）', () => {
  const store = new IndexStore(':memory:');
  const homeId = store.registerHome({ homePath: '/m', hostType: 'local' });
  const live = (ids) => ids.map((sessionId) => ({ sessionId, cwd: '/r/proj',
    status: { kind: 'running', label: '运行中', subagents: 0, approval: null }, lastActivity: new Date().toISOString() }));
  store.applyLiveStatus(homeId, live(['sess-alive', 'sess-gone']));
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 2);
  const usageBefore = store.usageSummary({ days: 30 }).sessionCount;

  store.applyLiveStatus(homeId, live(['sess-alive']));
  const ids = store.db.prepare('SELECT sessionId FROM sessions').all().map((r) => r.sessionId);
  assert.deepEqual(ids, ['sess-alive'], `消失的纯实时行必须被清掉，实际剩下 ${JSON.stringify(ids)}`);
  assert.equal(store.usageSummary({ days: 30 }).sessionCount, usageBefore - 1, '计数也要跟着降下来');
  store.close();
});

// 启动路径上的 `CREATE UNIQUE INDEX homes_access_port` 在库里有重复 accessPort 时会失败 ——
// 而它在启动路径上，于是**每次启动都失败**，用户只能自己拿 sqlite 去改库。
// （重复值只可能来自手改库/早期版本：列、索引、#checkAccessPort 与 API 409 是同一批加的。）
test('store: 库里存在重复接入端口时也要能启动（先清重再建唯一索引）', async (t) => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const path = await import('node:path');
  const os = await import('node:os');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hwb-dupport-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'hwb.db');

  // 先用正常途径建库，然后手工制造重复端口（模拟外部工具改库）
  const a = new IndexStore(file);
  // 必须是 remote：接入端口只对远端实例有意义，迁移会把本机实例的 accessPort 清成 NULL
  const h1 = a.registerHome({ homePath: 'ssh://bot@x/1', hostType: 'remote', host: 'bot@x' });
  const h2 = a.registerHome({ homePath: 'ssh://bot@x/2', hostType: 'remote', host: 'bot@x' });
  a.db.exec('DROP INDEX IF EXISTS homes_access_port');
  a.db.prepare('UPDATE homes SET accessPort = 4400 WHERE homeId IN (?, ?)').run(h1, h2);
  // 夹具前提：确实有两条重复
  assert.equal(a.db.prepare('SELECT COUNT(*) AS n FROM homes WHERE accessPort = 4400').get().n, 2);
  a.close();

  const b = new IndexStore(file);   // 修复前：这里会抛 UNIQUE constraint failed
  const ports = b.db.prepare('SELECT homeId, accessPort FROM homes ORDER BY homeId').all();
  assert.equal(ports.filter((r) => r.accessPort === 4400).length, 1, '重复端口应只保留一个');
  assert.ok(b.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='homes_access_port'").get(), '索引应已建好');
  b.close();
});

// 一行缺字段不该让该 home 的**整批**行回滚：node:sqlite 拒绝绑定 undefined，抛的是
// 「Provided value cannot be bound to SQLite parameter N」，而它在 upsertRows 的事务里 ——
// 于是一个字段缺失就让这个实例这一轮什么都写不进去（还带上一句 JS 层的 degraded 信息）。
test('store: 某个会话行缺字段时，该 home 的其余行仍要写入', () => {
  const store = new IndexStore(':memory:');
  const homeId = store.registerHome({ homePath: '/m', hostType: 'local' });
  const now = new Date().toISOString();
  const base = { type: 'session', homeId, project: 'p', title: null, tokenUsage: null,
    status: JSON.stringify({ kind: 'idle' }), lastActivity: now, generatedAt: now, liveOnly: 0 };
  store.upsertRows([
    { ...base, sessionId: 'ok-1', workspaceId: null, workspaceTitle: null, contextPressure: null },
    // contextPressure 故意缺失（undefined）—— 模拟上游少给一个字段
    { ...base, sessionId: 'missing-field', workspaceId: null, workspaceTitle: null },
    { ...base, sessionId: 'ok-2', workspaceId: null, workspaceTitle: null, contextPressure: null },
  ]);
  const ids = store.db.prepare('SELECT sessionId FROM sessions ORDER BY sessionId').all().map((r) => r.sessionId);
  assert.deepEqual(ids, ['missing-field', 'ok-1', 'ok-2'], `三行都该写入，实际 ${JSON.stringify(ids)}`);
  store.close();
});

// projcache 降级 + workspace.json 刷新后删掉了某个 workspace：被保留的会话行里还留着它的 id，
// 于是 sessionWorkspace() 返回 null —— preview/upload 对一个完全正常的会话报
// 「尚未关联可用的 project 工作区」。
test('store: 降级期间被保留的会话，其指向已消失 workspace 的归属要被清掉（不留悬空链接）', () => {
  const store = new IndexStore(':memory:');
  const homeId = store.registerHome({ homePath: '/m', hostType: 'local' });
  const now = new Date().toISOString();
  const sess = (workspaceId, workspaceTitle) => ({ type: 'session', homeId, sessionId: 's1', workspaceId, workspaceTitle,
    project: 'p', title: null, tokenUsage: null, contextPressure: null, status: JSON.stringify({ kind: 'idle' }),
    lastActivity: now, generatedAt: now, liveOnly: 0 });
  const ws = (workspaceId) => ({ type: 'workspace', homeId, workspaceId, title: 'w', path: `/r/${workspaceId}`, project: 'p', archived: false, sessionCount: 1 });

  // ① 健康：s1 归属 ws-1
  store.upsertRows([{ type: 'home', homeId, homePath: '/m', degraded: [], generatedAt: now }, ws('ws-1'), sess('ws-1', 'w')]);
  assert.equal(store.db.prepare('SELECT workspaceId FROM sessions').get().workspaceId, 'ws-1');

  // ② projcache 降级（sessions 被保留）+ workspace.json 刷新后只剩 ws-2
  assert.equal(store.recentSessions({ homeId })[0].workspaceId, 'ws-1', '前提：降级前会话归属 ws-1');
  store.upsertRows([{ type: 'home', homeId, homePath: '/m', degraded: [{ domain: 'projcache', error: 'v4' }], generatedAt: now },
    ws('ws-2')]);
  const after = store.db.prepare('SELECT workspaceId FROM sessions').get();
  assert.equal(after.workspaceId, null, `指向已消失 workspace 的归属应被清掉，实际 ${after.workspaceId}`);
  // 这里 workspaces 域**没有**降级，所以工作区表按新快照刷新了（ws-1 消失、ws-2 出现）——
  // 正是这个组合会让被保留的会话行留下指向 ws-1 的悬空链接。
  const wsIds = store.db.prepare('SELECT workspaceId FROM workspaces').all().map((w) => w.workspaceId);
  assert.deepEqual(wsIds, ['ws-2'], `工作区表应按新快照刷新，实际 ${JSON.stringify(wsIds)}`);
  store.close();
});

// `markHomeError` 的 catch 必须**吞掉**自己的失败：它由 Indexer 的 catch 调用，
// 而那个 catch 在「索引该 home 失败」时执行 —— 若 markHomeError 再抛（只读库、磁盘满、
// 库文件被删），异常会冒出去，**中断整轮索引**里剩下的所有实例（它们一个都不再刷新）。
// 审查把这里改成 `throw e` 之后整个套件仍然全绿（610/609/0）：因为 hostile-env 注入的是
// **桩** markHomeError，真正这个方法在套件里从没被失败路径调用过。
test('store: markHomeError 自身写失败时必须吞掉（否则会中断整轮索引）', () => {
  const store = new IndexStore(':memory:');
  store.registerHome({ homePath: '/mock/home' });
  store.close();   // 库已关：任何写入都会抛（等价于只读库/磁盘满/文件被删）
  assert.doesNotThrow(() => store.markHomeError('any-home', 'boom'), 'markHomeError 不能把异常抛给 Indexer');
});
