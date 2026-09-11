import { test } from 'node:test';
import assert from 'node:assert/strict';


// dsh 的投影值在**文件**侧是带版本包装的 `{ver,seq,val:{totals:{…}}}`；而 `/api/session/list`
// 的 `projections.values.tokenUsage` 给的是哪一层，本项目没有可对照的实例可以确定。
// 不归一的话，若 dsh 给的是带包装的那层，我们就会把**嵌套结构**存进 sessions.tokenUsage：
// 用量聚合按 `$.uncachedInputTokens` 取值只会得到 0，而且这次实时写入会覆盖掉文件索引里
// 正确的扁平值（正在跑的会话，历史用量突然归零）。三种形态都必须能吃。
test('live-status: 实时 tokenUsage 的三种形态都被归一成扁平计数', async () => {
  const { normalizeLiveTokenUsage } = await import('../src/dshhome/live-status.js');
  const flat = { uncachedInputTokens: 5, outputTokens: 6, cacheReadTokens: 7, cacheWriteTokens: 8 };
  assert.deepEqual(normalizeLiveTokenUsage(flat), flat, '扁平形态原样通过');
  assert.deepEqual(normalizeLiveTokenUsage({ totals: flat }), flat, '只有 totals 一层');
  assert.deepEqual(normalizeLiveTokenUsage({ ver: 1, seq: 2, val: { totals: flat } }), flat,
    '文件侧那种带版本包装的形态');
  assert.deepEqual(normalizeLiveTokenUsage({ uncachedInputTokens: '9' }), { uncachedInputTokens: 9 }, '字符串数字');
  // 认不出来的形态必须返回 null（保持文件索引的值），而不是把一个解析不出来的结构存进去
  for (const bad of [null, undefined, {}, [1, 2], 'nope', 42, { val: {} }]) {
    assert.equal(normalizeLiveTokenUsage(bad), null, `${JSON.stringify(bad)} 应归一为 null`);
  }
});

// 实时通道的 `permissions.approval` 原先直接落库，绕过了 lib/status.js 的守卫（只留字符串、截断到 64），
// 而且在宽限期内**赢过**文件侧被守卫过的值 —— 每次轮询重新赢，不自愈。
// 实测（审查）：`{"obj":true}` 落库 → 界面显示「审批 [object Object]」；
// 30 万字符的字符串会把 sessions.status 这一列撑到 300KB，且每 3s 重写一次。
test('toLiveRow: 实时 approval 与文件侧走同一套守卫（长串截断、非字符串丢弃）', async () => {
  const { LiveStatusReader } = await import('../src/dshhome/live-status.js');
  const saved = globalThis.fetch;
  const rowsFor = async (values) => {
    globalThis.fetch = async () => Response.json({
      type: 'server-response',
      result: { ok: true, value: { items: [{ sessionId: 's1', cwd: '/r', projections: { values } }] } },
    });
    return new LiveStatusReader().read('http://127.0.0.1:1/', {});
  };
  try {
    const obj = await rowsFor({ permissions: { approval: { obj: true } } });
    assert.equal(obj[0].status.approval, null, '非字符串一律丢弃');
    const long = await rowsFor({ permissions: { approval: 'x'.repeat(300_000) } });
    assert.equal(long[0].status.approval.length, 65, '超长截断到 64 字符 + 省略号');
    const ok = await rowsFor({ permissions: { approval: 'never' } });
    assert.equal(ok[0].status.approval, 'never', '正常字符串照旧');
  } finally { globalThis.fetch = saved; }
});
