import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeLiveStatus } from '../src/dshhome/reader.js';
import { initLogger } from '../src/lib/logger.js';

// 单元测试静默日志。
initLogger({ level: 'error', file: false, color: false, silent: true });

const CTX = { homeId: 'h1', generatedAt: '2026-09-06T08:00:00.000Z' };

function sessionRow(sessionId, over = {}) {
  return {
    type: 'session',
    homeId: 'h1',
    sessionId,
    workspaceId: 'ws-1',
    workspaceTitle: 'demo',
    project: 'demo',
    title: null,
    tokenUsage: null,
    contextPressure: null,
    status: null,
    lastActivity: '2026-09-04T10:00:00.000Z',
    generatedAt: CTX.generatedAt,
    ...over,
  };
}

test('mergeLiveStatus: 覆盖已有会话的 status/lastActivity/tokenUsage/title', () => {
  const rows = [sessionRow('s1')];
  const live = [{
    sessionId: 's1',
    cwd: '/repo/demo',
    status: { kind: 'running', label: '运行中', subagents: 0, approval: null },
    lastActivity: '2026-09-06T07:00:00.000Z',
    tokenUsage: { outputTokens: 42 },
    title: '新标题',
  }];
  const out = mergeLiveStatus(rows, live, CTX);
  assert.equal(out.length, 1);
  assert.equal(out[0].lastActivity, '2026-09-06T07:00:00.000Z');
  assert.deepEqual(JSON.parse(out[0].status).kind, 'running');
  assert.deepEqual(JSON.parse(out[0].tokenUsage), { outputTokens: 42 });
  assert.equal(out[0].title, '新标题');
  // 未被覆盖的字段保持投影缓存原值
  assert.equal(out[0].workspaceId, 'ws-1');
  assert.equal(out[0].project, 'demo');
});

test('mergeLiveStatus: 补插 projcache 里没有的新会话（冻结期间产生）', () => {
  const rows = [sessionRow('s1')];
  const live = [
    { sessionId: 's1', cwd: '/repo/demo', lastActivity: '2026-09-06T07:00:00.000Z' },
    {
      sessionId: 's2-new', cwd: '/Volumes/repo/ciao/github.com/hwb',
      status: { kind: 'idle', label: '空闲', subagents: 0, approval: null },
      lastActivity: '2026-09-06T07:30:00.000Z',
      tokenUsage: { outputTokens: 7 }, title: '冻结期新会话',
    },
  ];
  const out = mergeLiveStatus(rows, live, CTX);
  assert.equal(out.length, 2);
  const inserted = out.find((r) => r.sessionId === 's2-new');
  assert.ok(inserted);
  assert.equal(inserted.type, 'session');
  assert.equal(inserted.homeId, 'h1');
  assert.equal(inserted.project, 'hwb'); // basename(cwd)
  assert.equal(inserted.workspaceId, null);
  assert.equal(inserted.title, '冻结期新会话');
  assert.equal(inserted.lastActivity, '2026-09-06T07:30:00.000Z');
  assert.deepEqual(JSON.parse(inserted.tokenUsage), { outputTokens: 7 });
  assert.equal(inserted.generatedAt, CTX.generatedAt);
});

test('mergeLiveStatus: 新会话缺 cwd 时 project 落 unknown、缺 tokenUsage 时保持 null', () => {
  const out = mergeLiveStatus([], [{ sessionId: 's9', lastActivity: null }], CTX);
  assert.equal(out.length, 1);
  assert.equal(out[0].project, 'unknown');
  assert.equal(out[0].tokenUsage, null);
  assert.equal(out[0].status, null);
});

test('mergeLiveStatus: live 为空/非法时原样返回', () => {
  const rows = [sessionRow('s1')];
  assert.equal(mergeLiveStatus(rows, null, CTX), rows);
  assert.equal(mergeLiveStatus(rows, [], CTX), rows);
  const out = mergeLiveStatus(rows, [{ noSessionId: true }], CTX);
  assert.equal(out.length, 1); // 无 sessionId 的 live 项被忽略，不补插
});

// 实测（审查复现）：文件侧一个合计 109100 的会话（12400/3200/88100/5400），
// 被一个只带 {uncachedInputTokens:100, outputTokens:20} 的实时对象整列覆盖后，
// 用量面板掉到 120 —— 静默丢 99.9%，而且仪表盘上没有任何异常迹象。
// 正常路径下一轮文件索引会把累计值写回来，但 projcache 降级时实时值就是权威（这套实时保护
// 存在的场景），于是永久错下去。所以实时用量必须逐 key 合并。
test('mergeLiveStatus: 实时用量只带部分计数器时按 key 合并，不清零没报的键', () => {
  const file = { uncachedInputTokens: 12400, outputTokens: 3200, cacheReadTokens: 88100, cacheWriteTokens: 5400 };
  const rows = [sessionRow('s1', { tokenUsage: JSON.stringify(file) })];
  const out = mergeLiveStatus(rows, [{
    sessionId: 's1',
    lastActivity: '2026-09-06T07:00:00.000Z',
    tokenUsage: { uncachedInputTokens: 100, outputTokens: 20 }, // dsh 只报了这两项
  }], CTX);

  const usage = JSON.parse(out[0].tokenUsage);
  assert.equal(usage.uncachedInputTokens, 100, '实时报了的键以实时为准');
  assert.equal(usage.outputTokens, 20);
  assert.equal(usage.cacheReadTokens, 88100, '实时没报的键必须保留文件索引的值');
  assert.equal(usage.cacheWriteTokens, 5400);
  const total = Object.values(usage).reduce((a, b) => a + b, 0);
  assert.equal(total, 93620, `合计不该塌成 120（实测会丢 99.9%），实际 ${total}`);
});

test('mergeLiveStatus: 实时用量四个计数器齐全时仍然整体生效（含把缓存计数归零）', () => {
  const rows = [sessionRow('s1', {
    tokenUsage: JSON.stringify({ uncachedInputTokens: 12400, outputTokens: 3200, cacheReadTokens: 88100, cacheWriteTokens: 5400 }),
  })];
  const full = { uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const out = mergeLiveStatus(rows, [{ sessionId: 's1', tokenUsage: full }], CTX);
  assert.deepEqual(JSON.parse(out[0].tokenUsage), full, '四个键齐全时实时值就是权威（0 也要写进去）');
});

test('mergeLiveStatus: 实时用量一个可用计数都没有时不动这一列', () => {
  const rows = [sessionRow('s1', { tokenUsage: JSON.stringify({ uncachedInputTokens: 12400 }) })];
  const out = mergeLiveStatus(rows, [{ sessionId: 's1', tokenUsage: { last: { uncachedInputTokens: 9 } } }], CTX);
  assert.deepEqual(JSON.parse(out[0].tokenUsage), { uncachedInputTokens: 12400 },
    '认不出来的形状不能把已知值抹掉');
});

test('mergeLiveStatus: 已有 tokenUsage 是坏 JSON 时按无基线处理，不抛异常', () => {
  const rows = [sessionRow('s1', { tokenUsage: '{坏掉的' })];
  const out = mergeLiveStatus(rows, [{ sessionId: 's1', tokenUsage: { outputTokens: 7 } }], CTX);
  assert.deepEqual(JSON.parse(out[0].tokenUsage), { outputTokens: 7 });
});
