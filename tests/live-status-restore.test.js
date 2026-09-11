import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IndexStore } from '../src/dshhome/store.js';
import { indexSnapshot } from '../src/dshhome/reader.js';

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
