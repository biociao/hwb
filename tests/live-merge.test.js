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
