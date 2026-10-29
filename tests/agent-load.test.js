// 会话卡「子代理 N（M 运行）」：纯函数 + 渲染 + 文件索引端到端。
//
// 这是 S0+S1 的守卫：子代理总数早就在 status.subagents 里，S1 补的是「其中几个在跑」——
// 判据必须**可判定才写键**（缺子会话行 = 未知，不是 0），且只在父会话自己运行时判。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subagentCatalogIds, annotateSubagentRunning } from '../src/lib/status.js';
import { buildSnapshot } from '../src/lib/read-home.js';
import { normalize } from '../src/lib/normalize.js';
import { sessionState } from '../src/web/components/session-state.js';
import { renderRecentSessions } from '../src/web/components/recent-sessions.js';

globalThis.document = { documentElement: { dataset: { theme: 'light' } } };

const row = (id, status) => ({ homeId: 'h1', sessionId: id, title: id, status });

// —— subagentCatalogIds：wire 数组 / 磁盘链接结构 ——

test('catalog id 两种形态都收：wire 数组与磁盘 head.values[].childId', () => {
  assert.deepEqual(subagentCatalogIds([{ id: 'a' }, { id: 'b' }, { id: 'a' }, null, { id: '' }]), ['a', 'b']);
  assert.deepEqual(
    subagentCatalogIds({ head: { values: [{ childId: 'b' }], previous: { values: [{ childId: 'a' }, { childId: 'b' }] } } }),
    ['b', 'a'],
  );
  // 不可用 / 非法 → null（不可判定），不是空数组
  for (const raw of [undefined, null, {}, [], { head: { values: [] } }, [{ id: 42 }], { a: {}, b: {} }]) {
    assert.equal(subagentCatalogIds(raw), null);
  }
  // 上限：超过 max 视为不可判定（宁可不显示运行数，也不为超大 catalog 做 O(n) join）
  assert.equal(subagentCatalogIds(Array.from({ length: 65 }, (_, i) => ({ id: `c${i}` }))), null);
  assert.equal(subagentCatalogIds(Array.from({ length: 64 }, (_, i) => ({ id: `c${i}` })))?.length, 64);
});

// —— annotateSubagentRunning：三条硬规则 ——

test('父会话 running + 子会话全部可查 → 写入运行数（含已观测的 0）', () => {
  const sessions = [
    { sessionId: 'parent', status: { kind: 'running', subagents: 3 }, childSessionIds: ['a', 'b', 'c'] },
    { sessionId: 'a', status: { kind: 'running' } },
    { sessionId: 'b', status: { kind: 'idle' } },
    { sessionId: 'c', status: { kind: 'completed' } },
  ];
  annotateSubagentRunning(sessions);
  assert.equal(sessions[0].status.subagentsRunning, 1);

  const allIdle = [
    { sessionId: 'p', status: { kind: 'running', subagents: 1 }, childSessionIds: ['x'] },
    { sessionId: 'x', status: { kind: 'idle' } },
  ];
  annotateSubagentRunning(allIdle);
  assert.equal(allIdle[0].status.subagentsRunning, 0, '全部可查且都没在跑 = 已观测的 0');
});

test('父会话非 running / 子会话缺失 / 无 catalog → 一律不写键（未知）', () => {
  const sessions = [
    { sessionId: 'idle-parent', status: { kind: 'idle', subagents: 2 }, childSessionIds: ['a'] },
    { sessionId: 'missing-child', status: { kind: 'running', subagents: 1 }, childSessionIds: ['ghost'] },
    { sessionId: 'no-catalog', status: { kind: 'running', subagents: 0 } },
    { sessionId: 'a', status: { kind: 'running' } },
  ];
  annotateSubagentRunning(sessions);
  assert.equal(sessions[0].status.subagentsRunning, undefined);
  assert.equal(sessions[1].status.subagentsRunning, undefined);
  assert.equal(sessions[2].status.subagentsRunning, undefined);
  // 不修改子会话行
  assert.equal(sessions[3].status.subagentsRunning, undefined);
});

test('annotate 防御非法入参：非数组 / 空数组 / 坏行不抛错', () => {
  assert.deepEqual(annotateSubagentRunning(null), null);
  assert.deepEqual(annotateSubagentRunning([]), []);
  const rows = [null, { sessionId: 1 }, { status: null }, { sessionId: 'p', status: { kind: 'running' }, childSessionIds: 'a' }];
  annotateSubagentRunning(rows);
  assert.equal(rows[3].status.subagentsRunning, undefined);
});

// —— 展示层：sessionState 归一 + 卡片渲染 ——

test('sessionState：运行数是数字才暴露，运行数不超过总数；缺键保持 null（未知）', () => {
  assert.equal(sessionState(row('s', { kind: 'running', subagents: 3, subagentsRunning: 1 })).subagentsRunning, 1);
  assert.equal(sessionState(row('s', { kind: 'running', subagents: 3 })).subagentsRunning, null);
  // 外部脏数据：钳到总数，不显示「3 个里 9 个在跑」
  assert.equal(sessionState(row('s', { kind: 'running', subagents: 3, subagentsRunning: 9 })).subagentsRunning, 3);
  assert.equal(sessionState(row('s', { kind: 'running', subagents: '3', subagentsRunning: '2' })).subagentsRunning, 2);
  assert.equal(sessionState(row('s', { kind: 'running', subagents: '"><img', subagentsRunning: 2 })).subagentsKnown, false);
  assert.equal(sessionState(row('s', { kind: 'running', subagents: 2, subagentsRunning: '"><img' })).subagentsRunning, null);
});

test('卡片：计数插在「上下文 N%」右侧；只在运行中画、未知不写 0', () => {
  const run = { ...row('s', { kind: 'running', subagents: 3, subagentsRunning: 1 }), contextPressure: { pressureTokens: 45, contextWindow: 100 } };
  const html = renderRecentSessions([run]);
  assert.match(html, /上下文 45%/);
  assert.match(html, /class="session-secondary agent-load" title="[^"]*含已结束[^"]*当前 1 个在跑">子代理 3（1 运行）<\/span>/);
  assert.ok(html.indexOf('上下文 45%') < html.indexOf('agent-load'), '计数必须紧跟上下文条之后（DOM 顺序）');
  assert.ok(html.indexOf('agent-load') < html.indexOf('active-time'), '活跃时间仍在最右侧（margin-left:auto）');

  // 运行数未知：只画历史总数
  const unknown = renderRecentSessions([row('u', { kind: 'running', subagents: 2 })]);
  assert.match(unknown, /title="[^"]*暂不可判定[^"]*">子代理 2<\/span>/);
  assert.doesNotMatch(unknown, /0 运行/);

  // 非运行中 / 无子代理 → 整段不出现
  assert.doesNotMatch(renderRecentSessions([row('i', { kind: 'idle', subagents: 3, subagentsRunning: 3 })]), /agent-load/);
  assert.doesNotMatch(renderRecentSessions([row('z', { kind: 'running', subagents: 0 })]), /agent-load/);
});

// —— 文件索引端到端：per-record 的父子 join ——

function snapshotOf(records) {
  const dir = 'storages/session_projcache/sessions';
  const files = Object.fromEntries(Object.entries(records).map(([id, rec]) => [`${dir}/${id}.json`, JSON.stringify({ version: 7, record: rec })]));
  const now = Date.now();
  return buildSnapshot({
    homePath: '/tmp/mock-home',
    readText: (rel) => {
      if (rel === 'storages/workspace.json') {
        return JSON.stringify({ unit: { name: 'workspace', version: 2 }, global: { workspaceIds: [] }, tables: { workspaces: {} } });
      }
      if (!(rel in files)) throw new Error('ENOENT');
      return files[rel];
    },
    exists: (rel) => rel === 'storages/workspace.json' || rel in files,
    listDir: (rel) => {
      if (rel !== dir) return null;
      return Object.keys(files).map((p) => p.split('/').pop());
    },
    statMtime: () => now,
  });
}

function runningRecord(catalogChildIds = []) {
  const now = Date.now();
  const rows = {
    sessionStats: { ver: 1, seq: 1, val: { openStep: { turn: 1, step: 2 } } },
    sessionListMetadata: { ver: 1, seq: 1, val: { lastPromptAt: now } },
  };
  if (catalogChildIds.length) {
    rows.subagentCatalog = { ver: 1, seq: 1, val: { head: { values: catalogChildIds.map((childId) => ({ childId })) } } };
  }
  return { identity: { createdAt: now, cwd: '/repo/p' }, rows };
}

function idleRecord(catalogChildIds = []) {
  const now = Date.now();
  const rows = { sessionListMetadata: { ver: 1, seq: 1, val: { lastPromptAt: now } } };
  if (catalogChildIds.length) {
    rows.subagentCatalog = { ver: 1, seq: 1, val: { head: { values: catalogChildIds.map((childId) => ({ childId })) } } };
  }
  return { identity: { createdAt: now, cwd: '/repo/p' }, rows };
}

test('文件索引：per-record 父会话 join 子会话行得到 subagentsRunning，且临时 childSessionIds 不入库', () => {
  const snap = snapshotOf({
    parent: runningRecord(['c1', 'c2']),
    c1: runningRecord(),
    c2: idleRecord(),
    missing: runningRecord(['ghost']),
    'idle-parent': idleRecord(['c1']),
  });
  assert.deepEqual(snap.degraded, []);
  const byId = new Map(snap.sessions.map((s) => [s.sessionId, s]));
  assert.equal(byId.get('parent').status.subagents, 2);
  assert.equal(byId.get('parent').status.subagentsRunning, 1);
  assert.deepEqual(byId.get('parent').childSessionIds, ['c1', 'c2']);
  assert.equal(byId.get('missing').status.subagentsRunning, undefined, '子会话没被索引 → 未知，不写 0');
  assert.equal(byId.get('idle-parent').status.subagentsRunning, undefined, '父会话空闲 → 不判');

  // normalize 只拷贝已知字段：childSessionIds 不会进 DB / API，subagentsRunning 会
  const sessionRows = normalize(snap).filter((r) => r.type === 'session');
  const parentRow = sessionRows.find((r) => r.sessionId === 'parent');
  const status = JSON.parse(parentRow.status);
  assert.equal(status.subagents, 2);
  assert.equal(status.subagentsRunning, 1);
  assert.equal(status.childSessionIds, undefined);
  assert.equal(parentRow.childSessionIds, undefined);
});
