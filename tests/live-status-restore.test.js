import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IndexStore } from '../src/dshhome/store.js';
import { indexSnapshot, mergeLiveStatus } from '../src/dshhome/reader.js';

// 「宽限期内保留实时状态」这层保护（见 store.upsertRows）必须只保留**这次实时列表确实还在报**
// 的会话，否则它会退化成「幽灵徽标」：
//
// 轮询器每 3s 写一次实时状态，所以只要 dsh 里还有**任意一个**会话活着，宽限期就永远成立。
// 而保护逻辑是「替换前记下该 home 所有非 NULL 的 status/lastActivity，替换后写回」——
// 于是那些**已经从实时列表里消失**（在 dsh 里归档/关掉）的会话，它们的陈旧 status 也会被写回，
// 文件索引再也纠正不了。实测（A/B 对照 f69d495 与加了保护的版本，3/3 次一致）：
// s1 一小时前活跃、文件推导为 idle，实时列表只报 s2 —— 保护前得到 s1=idle s2=running（正确），
// 保护后得到 s1=running s2=running，且这个错误的「运行中」会一直挂到 dsh 停止为止。
// 幽灵行清理只删 liveOnly=1 的行，救不了它；RUNNING_STALE_MS 的陈旧度闸门也被绕过了。
//
// 因此记账「最近一次实时列表里的 sessionId 集合」，回写时只认这个集合内的会话。

function iso(minAgo) {
  return new Date(Date.now() - minAgo * 60_000).toISOString();
}

// 文件侧快照：projcache 推导出两个会话都是「空闲」（s1 一小时没动静，s2 也没开着的步骤）。
function fileSnapshot(homeId) {
  const usage = { uncachedInputTokens: 12400, outputTokens: 3200, cacheReadTokens: 88100, cacheWriteTokens: 5400 };
  return {
    homeId,
    homePath: '/mock/home',
    generatedAt: new Date().toISOString(),
    wsVersion: 2,
    pcVersion: 3,
    workspaces: [{ workspaceId: 'ws-1', title: 'A', path: '/r/a', archived: false, sessionIds: ['s1', 's2'] }],
    sessions: [
      { sessionId: 's1', workspaceId: 'ws-1', title: 'archived', tokenUsage: usage, lastActivity: iso(60), status: { kind: 'idle', label: '空闲' } },
      { sessionId: 's2', workspaceId: 'ws-1', title: 'alive', tokenUsage: usage, lastActivity: iso(1), status: { kind: 'idle', label: '空闲' } },
    ],
    modelTier: null,
    providers: [],
    degraded: [],
  };
}

function liveSession(sessionId, kind = 'running') {
  return {
    sessionId, cwd: '/r/a', title: `${sessionId} title`,
    status: { kind, label: kind === 'running' ? '运行中' : '空闲', subagents: 0, approval: null },
    lastActivity: new Date().toISOString(),
    tokenUsage: { uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
  };
}

function kindOf(store, homeId, sessionId) {
  const row = store.recentSessions({ homeId }).find((s) => s.sessionId === sessionId);
  assert.ok(row, `${sessionId} 应该还在库里（不该被误删）`);
  const status = typeof row.status === 'string' ? JSON.parse(row.status) : row.status;
  return status?.kind ?? null;
}

test('实时列表不再报的会话：宽限期内也不把它的陈旧「运行中」写回（幽灵徽标）', () => {
  const store = new IndexStore(':memory:');
  const homeId = store.registerHome({ homePath: '/mock/home' });
  const fromFile = fileSnapshot(homeId);

  indexSnapshot(store, '/mock/home', fromFile, null);            // ① 首次文件索引：两者都 idle
  assert.equal(kindOf(store, homeId, 's1'), 'idle');

  store.applyLiveStatus(homeId, [liveSession('s1'), liveSession('s2')]);   // ② 两个会话都在跑
  assert.equal(kindOf(store, homeId, 's1'), 'running', '前置条件：实时状态覆盖文件推导');
  assert.equal(kindOf(store, homeId, 's2'), 'running');

  // ③ s1 在 dsh 里被归档/关掉：实时列表只剩 s2（库里 s1 仍是上一步写下的 running）
  store.applyLiveStatus(homeId, [liveSession('s2')]);
  // ④ 紧接着（宽限期内）文件索引整表替换 —— 保护逻辑不能替 s1 回写状态
  indexSnapshot(store, '/mock/home', fromFile, null);

  assert.equal(kindOf(store, homeId, 's1'), 'idle',
    's1 已不在实时列表里，它的 running 是陈旧值，必须让文件索引纠正（否则永久挂住）');
  assert.equal(kindOf(store, homeId, 's2'), 'running',
    's2 仍在实时列表里：文件快照的陈旧 idle 不该覆盖实时的 running');
  store.close();
});

test('实时列表变空之后：宽限期内同样不回写陈旧状态', () => {
  const store = new IndexStore(':memory:');
  const homeId = store.registerHome({ homePath: '/mock/home' });
  const fromFile = fileSnapshot(homeId);

  indexSnapshot(store, '/mock/home', fromFile, null);
  store.applyLiveStatus(homeId, [liveSession('s1'), liveSession('s2')]);
  assert.equal(kindOf(store, homeId, 's2'), 'running');

  store.applyLiveStatus(homeId, []);          // dsh 报「当前没有会话」（成功读取，区别于读取失败）
  indexSnapshot(store, '/mock/home', fromFile, null);

  assert.equal(kindOf(store, homeId, 's1'), 'idle');
  assert.equal(kindOf(store, homeId, 's2'), 'idle',
    '实时列表为空、文件推导为 idle 时不该再回写 running');
  store.close();
});

test('读取失败（非数组）不动账本：宽限期内仍按上一次成功的实时列表保护', () => {
  const store = new IndexStore(':memory:');
  const homeId = store.registerHome({ homePath: '/mock/home' });
  const fromFile = fileSnapshot(homeId);

  indexSnapshot(store, '/mock/home', fromFile, null);
  store.applyLiveStatus(homeId, [liveSession('s2')]);
  store.applyLiveStatus(homeId, null);        // 读取失败 = 「不知道」，不是「没有」
  indexSnapshot(store, '/mock/home', fromFile, null);

  assert.equal(kindOf(store, homeId, 's2'), 'running',
    '一次失败的实时读取不该让上一次成功的实时状态失效（那是通道抖动，不是 dsh 的结论）');
  store.close();
});

// 降级窗口里的「幽灵徽标」（审查实测）：unit.version 超出支持范围是 dsh 升级后的**必然情形**，
// 此时 sessions 域降级、文件索引的整表替换被跳过 —— 而从实时列表里消失的 file-backed 行
// 既不会被幽灵清理删掉（只删 liveOnly=1），也刷不动，于是停在最后一次实时写入的「运行中」上永远挂着。
// 实测：s1 关掉后 3 轮轮询 + 3 轮文件索引仍是 running；projcache 一恢复立刻自愈。
test('降级窗口里：不在实时列表的会话不再永远挂着「运行中」', () => {
  const store = new IndexStore(':memory:');
  const homeId = store.registerHome({ homePath: '/mock/home' });
  const fromFile = fileSnapshot(homeId);
  indexSnapshot(store, '/mock/home', fromFile, null);

  // ① 两个会话都在跑（实时）→ 都被标 running
  store.applyLiveStatus(homeId, [liveSession('s1'), liveSession('s2')]);
  assert.equal(kindOf(store, homeId, 's1'), 'running');
  assert.equal(kindOf(store, homeId, 's2'), 'running');

  // ② dsh 升级：projcache 域降级（文件索引再也刷不动 sessions 表）。
  // 快照必须**同时**把 sessions 置空并带上 degraded 标记 —— 这才是真实读取路径的产出形态
  // （见 store-degraded.test.js 的 rowsFor）：只加标记不置空的话，索引会照常写入文件侧的值，
  // 于是这条用例就测不到降级窗口了（我第一版就是这么写的，pre-fix 也「通过」，是假绿）。
  const degraded = { ...fromFile, sessions: [], degraded: [{ domain: 'projcache', error: 'unsupported unit.version 999' }] };
  indexSnapshot(store, '/mock/home', degraded, null);

  // ③ s1 在 dsh 里被关掉：只剩 s2 在实时列表里
  store.applyLiveStatus(homeId, [liveSession('s2')]);
  store.applyLiveStatus(homeId, [liveSession('s2')]);
  indexSnapshot(store, '/mock/home', degraded, null);   // 文件索引又跑了两轮（仍刷不动）
  indexSnapshot(store, '/mock/home', degraded, null);

  // 清的是**状态徽标**（status = NULL，UI 退回「空闲」），不是删行 —— 数据要留着，
  // 等 dsh 的 unit.version 被支持、域恢复之后再由文件索引覆盖。
  assert.equal(kindOf(store, homeId, 's1'), null,
    's1 已不在实时列表里，降级窗口里它的「运行中」必须被清掉（否则要挂到 dsh 升级被支持为止）');
  assert.equal(kindOf(store, homeId, 's2'), 'running', '仍在实时列表里的会话不受影响');

  // ④ 域恢复后一切照旧由文件索引决定
  indexSnapshot(store, '/mock/home', fromFile, null);
  assert.equal(kindOf(store, homeId, 's1'), 'idle');
  store.close();
});

// 未降级时**不能**清：那种窗口里的 file-backed 行由下一轮文件索引负责纠正（宽限期内还属实时权威）。
test('未降级时：不在实时列表的会话仍由文件索引纠正（不在这里清状态）', () => {
  const store = new IndexStore(':memory:');
  const homeId = store.registerHome({ homePath: '/mock/home' });
  const fromFile = fileSnapshot(homeId);
  indexSnapshot(store, '/mock/home', fromFile, null);
  store.applyLiveStatus(homeId, [liveSession('s1'), liveSession('s2')]);
  store.applyLiveStatus(homeId, [liveSession('s2')]);
  // 未降级：状态仍由文件索引（下一步）决定 —— 这里先不清，文件索引跑完才是 idle
  indexSnapshot(store, '/mock/home', fromFile, null);
  assert.equal(kindOf(store, homeId, 's1'), 'idle');
  assert.equal(kindOf(store, homeId, 's2'), 'running');
  store.close();
});

// 空闲的 dsh 每 3s 送来的内容与库里一模一样，而 upsertRows 是「整表替换」——
// 代价正比于该实例的**总会话数**（规模审查实测：40k/10 实例 891ms/轮，约占每轮 30% 的同步阻塞；
// 单 home 200k 会话时单次 3,494ms）。全等时跳过整表写，任何一处不同仍然走原路径（语义不变）。
test('applyLiveStatus: 没有新增行时走「只写变化的行」，有新增/幽灵时回退整表替换', () => {
  const store = new IndexStore(':memory:');
  const homeId = store.registerHome({ homePath: '/mock/home' });
  indexSnapshot(store, '/mock/home', fileSnapshot(homeId), null);

  let full = 0;
  const origUpsert = store.upsertRows.bind(store);
  store.upsertRows = (...args) => { full++; return origUpsert(...args); };

  const live = [liveSession('s1'), liveSession('s2')];
  store.applyLiveStatus(homeId, live);
  assert.equal(kindOf(store, homeId, 's1'), 'running', '实时状态必须写进去');
  assert.equal(full, 0, '只有已存在的行变化时**不该**整表替换（那就是省下来的那 891ms）');

  const before = kindOf(store, homeId, 's1');
  store.applyLiveStatus(homeId, live);   // 同一组对象：内容逐字节相同
  assert.equal(full, 0, '内容没变更不该整表替换');
  assert.equal(kindOf(store, homeId, 's1'), before);

  // 实时列表里有库里还没有的会话 → 必须回退整表替换（要插入行）
  store.applyLiveStatus(homeId, [...live, liveSession('brand-new')]);
  assert.equal(full, 1, '有新增行时必须走整表替换');
  assert.equal(kindOf(store, homeId, 'brand-new'), 'running');

  // 幽灵行（只有实时支撑的行从列表里消失）→ 同样要回退整表替换（要删行）
  // 注意：brand-new 是**只有实时支撑**的行（liveOnly=1），它从列表里消失时要被删掉 —— 那需要整表替换
  store.applyLiveStatus(homeId, [liveSession('s1')]);
  assert.equal(full, 2, '要删幽灵行时必须走整表替换');
  assert.ok(!store.recentSessions({ homeId }).some((s) => s.sessionId === 'brand-new'), '只有实时支撑的行从列表消失后应被删掉');
  assert.ok(store.recentSessions({ homeId }).some((s) => s.sessionId === 's2'), '有文件索引支撑的行即使不在实时列表也必须保留');
  store.close();
});

// **差分测试**：优化后的「只写变化的行」与原来的整表替换必须产出**完全相同的库状态**。
// 用两个 store 跑同一串实时载荷：A 走 applyLiveStatus（新路径），B 手工做
// rows → mergeLiveStatus → upsertRows（旧路径），最后逐行比对 sessions 表。
test('applyLiveStatus: 只写变化行与整表替换的库状态逐行一致（差分测试）', () => {
  const a = new IndexStore(':memory:');
  const b = new IndexStore(':memory:');
  const homeA = a.registerHome({ homePath: '/mock/home' });
  const homeB = b.registerHome({ homePath: '/mock/home' });
  indexSnapshot(a, '/mock/home', fileSnapshot(homeA), null);
  indexSnapshot(b, '/mock/home', fileSnapshot(homeB), null);

  const dump = (store, homeId) => store.db.prepare(
    'SELECT sessionId, workspaceId, workspaceTitle, project, title, tokenUsage, contextPressure, status, lastActivity, liveOnly FROM sessions WHERE homeId = ? ORDER BY sessionId'
  ).all(homeId).map((r) => ({ ...r }));

  const scenarios = [
    [liveSession('s1'), liveSession('s2')],                                   // 已有行变化
    [liveSession('s1'), liveSession('s2')],                                   // 完全不变
    [{ ...liveSession('s1'), tokenUsage: { uncachedInputTokens: 111, outputTokens: 222 } }, liveSession('s2')],  // 部分 token 合并
    [liveSession('s1'), liveSession('s2'), liveSession('new-live')],          // 新增行
    [liveSession('s1')],                                                      // 幽灵消失
    [],                                                                       // 空列表
    [liveSession('s1'), liveSession('s2')],                                   // 再恢复
  ];
  for (const [i, live] of scenarios.entries()) {
    a.applyLiveStatus(homeA, live);
    // 旧路径的等价复现：与 applyLiveStatus 内部完全相同的步骤，只是不做「只写变化行」的优化
    const rows = b.db.prepare('SELECT * FROM sessions WHERE homeId = ?').all(homeB).map((row) => ({ ...row, type: 'session' }));
    if (live.length === 0) {
      b.db.prepare('DELETE FROM sessions WHERE homeId = ? AND liveOnly = 1').run(homeB);
    } else {
      const liveIds = new Set(live.map((l) => l.sessionId));
      for (const g of b.db.prepare('SELECT id, sessionId FROM sessions WHERE homeId = ? AND liveOnly = 1').all(homeB)) {
        if (!liveIds.has(g.sessionId)) b.db.prepare('DELETE FROM sessions WHERE id = ?').run(g.id);
      }
      const fresh = b.db.prepare('SELECT * FROM sessions WHERE homeId = ?').all(homeB).map((row) => ({ ...row, type: 'session' }));
      b.upsertRows(mergeLiveStatus(fresh, live, { homeId: homeB, generatedAt: rows[0]?.generatedAt ?? new Date().toISOString() }));
    }
    assert.deepEqual(dump(a, homeA), dump(b, homeB), `第 ${i} 个场景后两个库必须逐行一致`);
  }
  a.close(); b.close();
});
