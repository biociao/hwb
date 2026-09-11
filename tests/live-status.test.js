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
