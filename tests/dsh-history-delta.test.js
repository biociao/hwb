import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply, deltaFromWindow, CHANNEL, ENDPOINT } from '../dsh-history-delta/lib/index.js';

// —— dsh-history-delta（Host 半，纯新增通道）——
// 已确认的事实（本机实测）：`/api/session.history` 的请求 schema 是 zod 严格对象，未知字段被静默剥掉
// （打完包装后收到的 payload 只有 `sessionId,maxMessages`，afterSeq=undefined），所以**不能**给既有
// 路由加参数；本插件改为注册一条新通道 /api.histdelta。这些用例守住：
// ① 既有 session.history 完全不被碰（一旦有人再回头去包它，这里会红）；
// ② 新端点只做减法：窗口语义/projections/hasMore 全部沿用上游，返回的增量能**逐条拼回**整段；
// ③ 参数非法/上游形状异常 → 明确报错（调用方据此回退整段），绝不猜。

const rec = (seq) => ({ event: { type: 'assistant/chunk', seq } });
const window = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => rec(from + i));

function fakeCtx({ history, withConnection = true, withApi = true } = {}) {
  const registered = new Map();
  const logs = [];
  const api = withApi ? { sessions: { history: history ?? (async () => ({ rpcId: 'r', result: { ok: true, value: { events: window(100, 199), hasMore: true, projections: { asOfSeq: 199 } } } })) } } : {};
  const connection = withConnection ? { rpc: { handle: (channel, handler, options) => registered.set(channel, { handler, options }) } } : {};
  return {
    api, connection, registered, logs,
    ctx: {
      get: (key) => (key === 'apiProxy' ? api : key === 'connection' ? connection : undefined),
      logger: { info: () => {}, warn: () => {} },
    },
  };
}

const rpc = (handler, args) => handler(ENDPOINT, { args });

test('history-delta: 注册的是一条新通道，既有 sessions.history 不被包装', () => {
  const { ctx, registered, api } = fakeCtx();
  const original = api.sessions.history;
  apply(ctx);
  assert.equal(registered.has(CHANNEL), true, '应注册 /api.histdelta');
  // 必须显式给 authority：上游 register() 会读 options.authority，不传会直接抛。
  assert.deepEqual(registered.get(CHANNEL).options, { authority: 'trusted-host' });
  assert.equal(api.sessions.history, original, '既有方法必须原样保留（绝不包装）');
});

test('history-delta: 只回 afterSeq 之后的增量，并给出窗口原始边界', async () => {
  const { ctx, registered } = fakeCtx();
  apply(ctx);
  const handler = registered.get(CHANNEL).handler;
  const result = await rpc(handler, { sessionId: 's', afterSeq: 150, maxMessages: 50 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.events.map((r) => r.event.seq), window(151, 199).map((r) => r.event.seq));
  assert.equal(result.value.windowFirstSeq, 100);
  assert.equal(result.value.windowLastSeq, 199);
  assert.equal(result.value.afterSeq, 150);
  assert.equal(result.value.hasMore, true, '其余字段原样透传');
  assert.deepEqual(result.value.projections, { asOfSeq: 199 });
});

test('history-delta: 拼接等价 —— 本地旧窗口 + 增量，按 windowFirstSeq 裁头 = 整段重取', async () => {
  // 上游现在会给 [140..239]；本地有 [100..159]；带 afterSeq=159 取增量，拼完必须与整段逐条相同。
  const full = window(140, 239);
  const cached = window(100, 159);
  const { ctx, registered } = fakeCtx({ history: async () => ({ rpcId: 'r', result: { ok: true, value: { events: full, hasMore: true } } }) });
  apply(ctx);
  const delta = await rpc(registered.get(CHANNEL).handler, { sessionId: 's', afterSeq: 159 });
  const merged = [...cached, ...delta.value.events]
    .filter((r) => (r.event.seq ?? -1) >= delta.value.windowFirstSeq)
    .map((r) => r.event.seq);
  assert.deepEqual(merged, full.map((r) => r.event.seq));
});

test('history-delta: 窗口滑过头时调用方必须能察觉（windowFirstSeq > afterSeq+1）', async () => {
  // 本地只有到 120、上游窗口从 140 开始：140 > 121 ⇒ 不连续，调用方应回退整段重取。
  const { ctx, registered } = fakeCtx({ history: async () => ({ rpcId: 'r', result: { ok: true, value: { events: window(140, 199), hasMore: true } } }) });
  apply(ctx);
  const delta = await rpc(registered.get(CHANNEL).handler, { sessionId: 's', afterSeq: 120 });
  const continuous = 100 <= delta.value.windowFirstSeq && delta.value.windowFirstSeq <= 120 + 1;
  assert.equal(continuous, false, '不连续必须为假，否则会拼出一个带空洞的窗口');
});

test('history-delta: 空窗口 / 无 seq 记录 / beforeSeq 透传', async () => {
  const { ctx, registered } = fakeCtx({ history: async () => ({ rpcId: 'r', result: { ok: true, value: { events: [{ event: { type: 'x' } }, rec(9)], hasMore: false } } }) });
  apply(ctx);
  const handler = registered.get(CHANNEL).handler;
  const kept = await rpc(handler, { sessionId: 's', afterSeq: 8 });
  assert.deepEqual(kept.value.events.map((r) => (r.event.seq ?? 'no-seq')), ['no-seq', 9], '无 seq 的记录必须保留');

  const { ctx: ctx2, registered: reg2 } = fakeCtx({ history: async () => ({ rpcId: 'r', result: { ok: true, value: { events: [], hasMore: false } } }) });
  apply(ctx2);
  const empty = await rpc(reg2.get(CHANNEL).handler, { sessionId: 's', afterSeq: 5 });
  assert.deepEqual(empty.value.events, []);
  assert.equal(empty.value.windowFirstSeq, null);
});

test('history-delta: 参数非法 / 上游形状异常 → 明确报错，绝不猜测', async () => {
  const { ctx, registered } = fakeCtx({ history: async () => ({ rpcId: 'r', result: { ok: true, value: { events: 'not-an-array' } } }) });
  apply(ctx);
  const handler = registered.get(CHANNEL).handler;
  for (const args of [{}, { sessionId: '' }, { sessionId: 's' }, { sessionId: 's', afterSeq: -1 }, { sessionId: 's', afterSeq: 1.5 }, { sessionId: 's', afterSeq: 0, maxMessages: 0 }]) {
    const result = await rpc(handler, args);
    assert.equal(result.ok, false, `${JSON.stringify(args)} 应被拒绝`);
    assert.equal(result.error.code, 'bad-request');
  }
  assert.equal((await rpc(handler, { sessionId: 's', afterSeq: 0 })).error.code, 'internal', '上游形状异常 → 让调用方回退整段');
  assert.equal((await handler('nope', { args: {} })).error.code, 'not-found');
});

test('history-delta: 缺服务时只打一行日志、不抛（不能拖垮 dsh 启动）', () => {
  const a = fakeCtx({ withConnection: false });
  assert.doesNotThrow(() => apply(a.ctx));
  assert.equal(a.registered.size, 0);
  const b = fakeCtx({ withApi: false });
  assert.doesNotThrow(() => apply(b.ctx));
  assert.equal(b.registered.size, 0);
});

test('history-delta: deltaFromWindow 是纯函数（形状不符返回 null）', () => {
  assert.equal(deltaFromWindow({}, 3), null);
  assert.equal(deltaFromWindow({ events: 'x' }, 3), null);
  assert.deepEqual(deltaFromWindow({ events: [rec(1), rec(2)] }, 1).events.map((r) => r.event.seq), [2]);
});
