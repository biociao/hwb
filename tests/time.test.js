import { test } from 'node:test';
import assert from 'node:assert/strict';
import { msToIso, MAX_TIMESTAMP_MS } from '../src/lib/time.js';

// 回归背景：dsh 元数据里的时间戳来自外部，单位写错（纳秒/微秒当毫秒）会产生 1e300 这类
// 「isFinite 为 true、但 toISOString 抛 RangeError」的值。schema.js 原先直接调用
// `new Date(v).toISOString()`，于是一个脏字段把整个 projcache 域判成 degraded，
// 用户看到的是该实例的会话凭空消失。这里锁定「降级为 null 而不是抛」的契约。

test('msToIso: 正常毫秒时间戳照常转换', () => {
  assert.equal(msToIso(0), '1970-01-01T00:00:00.000Z');
  assert.equal(msToIso(1_700_000_000_000), new Date(1_700_000_000_000).toISOString());
});

test('msToIso: 边界值 ±8.64e15 仍可转换', () => {
  assert.equal(typeof msToIso(MAX_TIMESTAMP_MS), 'string');
  assert.equal(typeof msToIso(-MAX_TIMESTAMP_MS), 'string');
});

test('msToIso: 有限但超出日期范围的值降级为 null 且不抛（原缺陷）', () => {
  for (const v of [1e300, -1e300, MAX_TIMESTAMP_MS + 1, -MAX_TIMESTAMP_MS - 1]) {
    assert.equal(Number.isFinite(v), true, `${v} 应当 isFinite 为 true（这正是原缺陷的前提）`);
    assert.equal(msToIso(v), null, `${v} 应降级为 null`);
  }
});

test('msToIso: 非数字与特殊值降级为 null', () => {
  for (const v of [null, undefined, NaN, Infinity, -Infinity, '1700000000000', {}, [], true]) {
    assert.equal(msToIso(v), null, String(v));
  }
});

test('schema: 超范围 lastPromptAt 不会把 projcache 域拖成 degraded', async () => {
  const { validateProjcacheJson } = await import('../src/lib/schema.js');
  const file = {
    unit: { name: 'session_projcache', version: 3 },
    global: null,
    tables: {
      sessions: {
        'sess-1': {
          identity: { createdAt: 1_786_665_487_928, cwd: '/x/a' },
          rows: {
            title: { ver: 1, seq: 1, val: 'dirty timestamp' },
            sessionListMetadata: { ver: 1, seq: 1, val: { lastPromptAt: 1e300 } },
          },
        },
      },
    },
  };
  const result = validateProjcacheJson(file);
  // 修复前：msToIso(1e300) 抛 RangeError: Invalid time value，validateProjcacheJson 整个返回
  // { ok:false, error:'Invalid time value' }，会话行一条都不产出（该实例在仪表盘上直接消失）。
  assert.equal(result.ok, true, '单个脏时间戳不应让整个域降级');
  const row = result.sessions.find((s) => s.sessionId === 'sess-1');
  assert.ok(row, '会话行仍应产出');
  // lastPromptAt 不可表示 → 降级为 null → 回落到 identity.createdAt，而不是把脏值原样带出来。
  assert.equal(row.lastActivity, new Date(1_786_665_487_928).toISOString());
});
