import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PendingInteractionWatcher,
  normalizeRemoteEventFrame,
  interventionOfFrame,
  mergeIntervention,
} from '../src/dshhome/pending-interactions.js';
import { createRemoteMuxTransport } from '../src/dshhome/pending-interactions.js';
import { initLogger, getLogs } from '../src/lib/logger.js';

// 单测里的 warn 不该刷终端；「probe 失败只 warnOnce」那条用日志环断言（getLogs）。
initLogger({ level: 'info', file: false, color: false, silent: true });

// 观察器（注入 transport）的行为契约。
//
// 这里**不碰网络**：token→cookie 交接与 `$events/result` 应答都走被替换的 globalThis.fetch
// （与 tests/live-status.test.js 同一手法），帧由假 transport 直接喂进来。真实 socket 的
// 编解码/握手/pong 在 tests/pending-interactions-ws.test.js 里单独覆盖。
//
// 要守住的三条边界（也是本文件里最重要的断言）：
//   ① 只观察：每条 waterfall 都恰好回一次 `{kind:'next'}`，绝不解帧里的 signal、绝不替人决定；
//   ② 只降级：畸形帧/断流/应答失败/广播抛错都不抛、不崩、不产生幽灵标记；
//   ③ 断流即清空：覆盖层立刻清掉，重连后按 Host 的重放帧重建。

const NOW = Date.parse('2026-10-27T06:00:00.000Z');
const NOW_ISO = '2026-10-27T06:00:00.000Z';
const HOME = 'home-1';
const URL1 = 'http://127.0.0.1:9/?token=test-token';
const URL2 = 'http://127.0.0.1:10/?token=test-token-2';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const flush = () => new Promise((resolve) => setImmediate(resolve));

// probe 的内部定时器都是 unref 的（生产环境里不该阻止进程退出），而单测里若没有别的句柄，
// 事件循环会直接空掉、`await job` 永远等不到。用一个 ref 的 interval 撑住循环，结束后清掉。
async function awaitWithLoop(promise) {
  const ticker = setInterval(() => {}, 10);
  try {
    return await promise;
  } finally {
    clearInterval(ticker);
  }
}

async function waitFor(predicate, label = 'condition', timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`等待超时: ${label}`);
    await sleep(5);
  }
}

// token→cookie 交接（GET → 303 Set-Cookie）与 `$events/result` 应答（POST → server-response）
// 都用这个假的 fetch。返回的 calls 用于断言「应答了几次、回了什么」。
function mockFetch(t) {
  const saved = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input?.url ?? input);
    const method = String(init?.method ?? 'GET').toUpperCase();
    calls.push({ url, method, body: init?.body ?? null });
    if (method === 'GET') {
      return new Response(null, { status: 303, headers: { 'set-cookie': 'sid=test; Path=/' } });
    }
    return Response.json({ type: 'server-response', rpcId: 'rpc-test', result: { ok: true, value: {} } });
  };
  t.after(() => { globalThis.fetch = saved; });
  calls.answers = () => calls
    .filter((call) => call.method === 'POST' && call.url.endsWith('/api/$events/result'))
    .map((call) => JSON.parse(call.body).payload.args);
  return calls;
}

// 假 transport：把连接当成可手动驱动的对象（push 帧 / drop 断流 / close 被主动关闭）。
function fakeTransport(t) {
  const connections = [];
  return {
    connections,
    async connect(handlers) {
      const connection = {
        handlers,
        closed: false,
        push(value) { handlers.onValue(value); },
        drop(reason = 'socket closed') { handlers.onClose(reason); },
      };
      connections.push(connection);
      return { close() { connection.closed = true; } };
    },
  };
}

function makeWatcher(t, overrides = {}) {
  const calls = mockFetch(t);
  const transport = overrides.transport ?? fakeTransport(t);
  const broadcasts = [];
  const watcher = new PendingInteractionWatcher({
    transport,
    broadcast: (event, data) => { broadcasts.push({ event, data }); },
    now: () => NOW,
    reconnectBaseMs: 5,
    reconnectMaxMs: 20,
    connectTimeoutMs: 200,
    // 默认关掉自动对账定时器：单测显式调 reconcile() / 用短间隔，避免后台 probe 干扰连接计数。
    reconcileIntervalMs: 0,
    ...overrides.options,
  });
  t.after(() => watcher.stop());
  return { watcher, transport, broadcasts, calls };
}

// 建立第一条连接（sync → 假 transport 的 connect 被调用）。
async function connect(t, overrides = {}) {
  const ctx = makeWatcher(t, overrides);
  ctx.watcher.sync([{ homeId: HOME, url: URL1 }]);
  await waitFor(() => ctx.transport.connections.length === 1, '建立连接');
  return ctx;
}

const ready = (clientId = 'client-1') => ({ type: 'ready', clientId, host: { home: '/Users/tester' } });

let eventSeq = 0;
function approvalFrame(overrides = {}) {
  eventSeq += 1;
  return {
    type: 'waterfall',
    event: 'approval/request',
    eventId: `event-approval-${eventSeq}`,
    agentId: 'session-1',
    request: { toolName: 'Bash', reason: 'rm -rf build' },
    ...overrides,
  };
}

function questionFrame(overrides = {}) {
  eventSeq += 1;
  return {
    type: 'waterfall',
    event: 'user-questions/request',
    eventId: `event-question-${eventSeq}`,
    agentId: 'session-2',
    request: { questions: [{ id: 'q1', question: '用哪个端口？' }] },
    ...overrides,
  };
}

// —— 1. 帧归一（外部输入的唯一收口） ——

test('normalizeRemoteEventFrame: 四种帧 + 陌生/畸形输入', () => {
  assert.deepEqual(
    normalizeRemoteEventFrame({ type: 'ready', clientId: 'c1', host: { home: '/Users/x' }, extra: 1 }),
    { type: 'ready', clientId: 'c1', host: { home: '/Users/x' } },
    'ready：只保留协议字段（多余键忽略）',
  );
  assert.deepEqual(
    normalizeRemoteEventFrame({
      type: 'waterfall', event: 'approval/request', eventId: 'e1',
      agentId: 'session-a', request: { toolName: 'bash' },
    }),
    {
      type: 'waterfall', event: 'approval/request', eventId: 'e1',
      sessionId: 'session-a', request: { toolName: 'bash' },
    },
    'waterfall：agentId 即 sessionId',
  );
  assert.deepEqual(
    normalizeRemoteEventFrame({ type: 'cancel', eventId: 'e1' }),
    { type: 'cancel', eventId: 'e1' },
  );
  assert.deepEqual(
    normalizeRemoteEventFrame({ type: 'emit', event: 'x/y', args: [1] }),
    { type: 'emit', event: 'x/y', args: [1] },
  );

  // 畸形/陌生输入一律 null（调用方据此「忽略这一帧」，而不是抛错断开整条连接）。
  const bad = [
    undefined, null, 0, 42, true, 'ready', [], {},
    { type: 'unknown' },
    { type: 'ready' },
    { type: 'ready', clientId: '' },
    { type: 'ready', clientId: 'c1' },
    { type: 'ready', clientId: 'c1', host: {} },
    { type: 'ready', clientId: 'c1', host: { home: 42 } },
    { type: 'waterfall' },
    { type: 'waterfall', event: 'approval/request' },
    { type: 'waterfall', event: 'approval/request', eventId: 'e1' },
    { type: 'waterfall', event: '', eventId: 'e1', agentId: 's', request: {} },
    { type: 'waterfall', event: 'approval/request', eventId: '', agentId: 's', request: {} },
    { type: 'waterfall', event: 'approval/request', eventId: 'e1', agentId: 7, request: {} },
    { type: 'waterfall', event: 'approval/request', eventId: 'e1', agentId: '   ', request: {} },
    { type: 'waterfall', event: 'approval/request', eventId: 'e1', agentId: 's', request: [] },
    { type: 'waterfall', event: 'approval/request', eventId: 'e1', agentId: 's' },
    { type: 'cancel' },
    { type: 'cancel', eventId: 1 },
    { type: 'emit', event: 'x', args: 'nope' },
    { type: 'emit', event: '', args: [] },
  ];
  for (const value of bad) {
    assert.equal(normalizeRemoteEventFrame(value), null, `应拒绝: ${JSON.stringify(value)}`);
  }
});

// —— 2. interventionOfFrame：审批归类与 displayReason 的真实形态 ——

test('interventionOfFrame: approval 归类，displayReason 是 locale 映射对象（真机形态）', () => {
  // 真机样本（lead 实测 dsh 0.2.0-rc.2）：displayReason 是 {en, zh} 而不是字符串。
  // 归一后的 reason 必须是**字符串**（服务端统一，前端不再自己解映射）。
  const shapes = [
    [{ displayReason: { en: 'Allow this operation', zh: '允许本次操作' } }, '允许本次操作', 'zh 优先'],
    [{ displayReason: { en: 'Allow this operation' } }, 'Allow this operation', '只有 en'],
    [{ displayReason: 'plain display string', reason: 'raw' }, 'plain display string', '字符串形态'],
    [{ displayReason: { xx: 42, yy: 'any string' } }, 'any string', '未知语种取任一字符串值'],
    [{ reason: 'escalate sandbox' }, 'escalate sandbox', '没有 displayReason 时退回 reason'],
    [{ displayReason: '', reason: 'raw fallback' }, 'raw fallback', '空字符串 displayReason 不算数'],
    [{}, null, '两者都没有'],
    [{ displayReason: { en: 42 }, reason: 7 }, null, '非字符串一律丢弃'],
  ];
  for (const [request, expected, label] of shapes) {
    const intervention = interventionOfFrame({
      type: 'waterfall', event: 'approval/request', eventId: 'e1', sessionId: 's1', request,
    }, NOW);
    assert.equal(intervention.kind, 'approval', label);
    assert.equal(intervention.label, '等待审批', label);
    assert.equal(intervention.source, 'live', label);
    assert.equal(intervention.reason, expected, label);
    assert.equal(intervention.since, NOW_ISO, label);
    assert.equal(intervention.count, 1, label);
  }
  const withTool = interventionOfFrame({
    type: 'waterfall', event: 'approval/request', eventId: 'e1', sessionId: 's1',
    request: { toolName: 'bash', displayReason: { zh: '原因' } },
  }, NOW);
  assert.equal(withTool.tool, 'bash', 'tool 取 request.toolName');
  assert.equal(withTool.label, '等待审批');
});

test('interventionOfFrame: user-questions 区分 plan-review 与普通提问', () => {
  const planReview = interventionOfFrame({
    type: 'waterfall', event: 'user-questions/request', eventId: 'e2', sessionId: 's2',
    request: {
      questions: [{
        id: 'q1',
        question: 'Approve this plan?',
        detail: '# Plan\n1. do it',
        intent: { kind: 'plan-review', approve: 'Approve' },
      }],
    },
  }, NOW);
  assert.equal(planReview.kind, 'plan-review');
  assert.equal(planReview.label, '计划待审');
  assert.equal(planReview.reason, 'Approve this plan?');
  assert.equal(planReview.count, 1);

  const cases = [
    [[{ id: 'q1', question: '随便问问' }], 'question', '没有 intent'],
    [[{ id: 'q1', question: '问', intent: { kind: 'plan-review' } }], 'question', 'plan-review 但没有 detail'],
    [[{ id: 'q1', question: '问', detail: '  ', intent: { kind: 'plan-review' } }], 'question', 'detail 全是空白'],
    [[{ id: 'q1', question: '问', intent: { kind: 'other' } }], 'question', '其它 intent'],
    [[{ id: 'q2', question: '第二问' }], 'question', '普通提问'],
  ];
  for (const [questions, expected, label] of cases) {
    const intervention = interventionOfFrame({
      type: 'waterfall', event: 'user-questions/request', eventId: 'e3', sessionId: 's2',
      request: { questions },
    }, NOW);
    assert.equal(intervention.kind, expected, label);
    assert.equal(intervention.source, 'live', label);
  }

  const twoQuestions = interventionOfFrame({
    type: 'waterfall', event: 'user-questions/request', eventId: 'e4', sessionId: 's2',
    request: {
      questions: [
        { id: 'q1', question: '第一问', detail: '# plan', intent: { kind: 'plan-review' } },
        { id: 'q2', question: '第二问' },
      ],
    },
  }, NOW);
  assert.equal(twoQuestions.kind, 'question', '多于一个问题就不是「计划待审」');
  assert.equal(twoQuestions.count, 2);
  assert.equal(twoQuestions.reason, '第一问', 'reason 取第一条 question 的 question 文本');

  // 不认识的事件 / 非 waterfall 帧 → null（不应产生介入标记）。
  assert.equal(interventionOfFrame({
    type: 'waterfall', event: 'some/other', eventId: 'e5', sessionId: 's3', request: {},
  }, NOW), null);
  assert.equal(interventionOfFrame(null, NOW), null);
});

// —— 3. 覆盖层：帧 → 状态 + 立刻委托 next ——

test('approval 帧进入覆盖层，并立刻用 {kind:next} 委托回 Host（每个 waterfall 恰好一次）', async (t) => {
  const ctx = await connect(t);
  const conn = ctx.transport.connections[0];
  conn.push(ready('client-abc'));
  assert.equal(ctx.watcher.overlay(HOME).size, 0, 'ready 本身不产生介入');

  const frame = approvalFrame({
    request: {
      toolName: 'bash',
      callId: 'call_1',
      reason: 'escalate sandbox',
      displayReason: { en: 'Allow this operation', zh: '允许本次操作使用 danger-full-access 权限' },
    },
  });
  conn.push(frame);

  assert.deepEqual(ctx.watcher.overlay(HOME).get('session-1'), {
    kind: 'approval',
    label: '等待审批',
    source: 'live',
    since: NOW_ISO,
    tool: 'bash',
    reason: '允许本次操作使用 danger-full-access 权限',
    count: 1,
  });

  // overlay() 必须是只读视图的等价物：调用方改它不能影响内部状态。
  const view = ctx.watcher.overlay(HOME);
  view.delete('session-1');
  assert.equal(ctx.watcher.overlay(HOME).size, 1, 'overlay() 返回副本，改它不影响内部覆盖层');
  assert.equal(ctx.watcher.all().get(HOME).size, 1);

  await waitFor(() => ctx.calls.answers().length === 1, '委托 next 的应答');
  const [answer] = ctx.calls.answers();
  assert.deepEqual(answer, {
    clientId: 'client-abc',
    eventId: frame.eventId,
    outcome: { kind: 'next' },
  }, 'outcome 必须恰好是 {kind:next}：只观察，绝不替人做决定');

  // 同一会话的第二个 waterfall（同 rank）不应丢失应答；不同 kind 时覆盖层取更强者。
  const second = questionFrame({ agentId: 'session-1' });
  conn.push(second);
  await waitFor(() => ctx.calls.answers().length === 2, '第二条帧也要应答');
  assert.equal(ctx.calls.answers()[1].eventId, second.eventId);
  assert.equal(ctx.watcher.overlay(HOME).get('session-1').kind, 'approval', 'approval 优先级更高');

  // 不认识的 waterfall 事件也必须委托（否则 Host 会一直等这个订阅者），但不产生标记。
  conn.push({ type: 'waterfall', event: 'unknown/event', eventId: 'event-unknown', agentId: 'session-9', request: {} });
  await waitFor(() => ctx.calls.answers().length === 3, '陌生事件同样要应答');
  assert.equal(ctx.calls.answers()[2].eventId, 'event-unknown');
  assert.equal(ctx.watcher.overlay(HOME).has('session-9'), false);

  // emit（通知帧）不需要应答，也不产生介入标记。
  conn.push({ type: 'emit', event: 'turn/start', args: [] });
  await flush();
  assert.equal(ctx.calls.answers().length, 3, 'emit 不应答');
});

test('cancel 按 eventId 逐条撤销：同一会话的多个 waterfall 不会被一起误清', async (t) => {
  const ctx = await connect(t);
  const conn = ctx.transport.connections[0];
  conn.push(ready());

  const approval = approvalFrame({ agentId: 'session-1' });
  const question = questionFrame({ agentId: 'session-1' });
  conn.push(approval);
  conn.push(question);
  assert.equal(ctx.watcher.overlay(HOME).get('session-1').kind, 'approval');

  conn.push({ type: 'cancel', eventId: approval.eventId });
  assert.equal(ctx.watcher.overlay(HOME).get('session-1').kind, 'question',
    '取消审批后应回落到仍挂起的提问');

  conn.push({ type: 'cancel', eventId: question.eventId });
  assert.equal(ctx.watcher.overlay(HOME).size, 0, '全部取消后覆盖层清空');

  // 未知 eventId 的 cancel：忽略，不抛错、不影响其它条目。
  conn.push({ type: 'cancel', eventId: 'never-seen' });
  assert.equal(ctx.watcher.overlay(HOME).size, 0);
  await waitFor(() => ctx.broadcasts.some((item) => item.event === 'intervention:updated'), '广播变更');
  assert.ok(ctx.broadcasts.every((item) => item.data.homeId === HOME));
});

// —— 4. 断流 → 清空 → 重连 → 重放重建 ——

test('断流立刻清空覆盖层，重连后按 Host 重放的 waterfall 重建', async (t) => {
  const ctx = await connect(t);
  ctx.transport.connections[0].push(ready());
  ctx.transport.connections[0].push(approvalFrame({ agentId: 'session-1' }));
  assert.equal(ctx.watcher.overlay(HOME).size, 1);

  ctx.transport.connections[0].drop('socket closed');
  assert.equal(ctx.watcher.overlay(HOME).size, 0,
    '断流必须**立刻**清空：Host 会重放，留着旧标记就是幽灵等待审批');

  await waitFor(() => ctx.transport.connections.length === 2, '自动重连');
  const reconnected = ctx.transport.connections[1];
  reconnected.push(ready('client-second'));
  assert.equal(ctx.watcher.overlay(HOME).size, 0, '重放之前覆盖层仍然是空的');

  // Host 重放仍挂起的 waterfall → 覆盖层重建，并且用新一代 clientId 应答。
  const replayed = approvalFrame({ agentId: 'session-1' });
  reconnected.push(replayed);
  assert.equal(ctx.watcher.overlay(HOME).size, 1);
  await waitFor(() => ctx.calls.answers().some((answer) => answer.clientId === 'client-second'), '重连后的应答');
});

// —— 5. 畸形/恶意输入不炸、不应答、不产生标记 ——

test('畸形帧：不炸连接、不产生介入、也不应答；随后合法帧仍被处理', async (t) => {
  const ctx = await connect(t);
  const conn = ctx.transport.connections[0];
  conn.push(ready());

  const junk = [
    null, undefined, 42, true, 'hello', [], {},
    { type: 'unknown' },
    { type: 'waterfall' },
    { type: 'waterfall', event: 'approval/request', eventId: 'e', agentId: '   ', request: {} },
    { type: 'waterfall', event: 'approval/request', eventId: 'e', agentId: 's', request: 'nope' },
    { type: 'cancel' },
    { type: 'emit', event: 'x', args: 'nope' },
    { type: 'ready', clientId: 'late-duplicate', host: { home: '/Users/x' } },
  ];
  for (const value of junk) conn.push(value);
  await flush();

  assert.equal(ctx.watcher.overlay(HOME).size, 0, '畸形帧不应产生任何标记');
  assert.equal(ctx.calls.answers().length, 0, '畸形帧不应触发应答');
  assert.equal(ctx.transport.connections.length, 1, '畸形帧不应断开连接');

  // 连接仍然可用：随后的合法帧照常处理。
  conn.push(approvalFrame({ agentId: 'session-ok' }));
  assert.equal(ctx.watcher.overlay(HOME).get('session-ok').kind, 'approval');
  await waitFor(() => ctx.calls.answers().length === 1, '合法帧仍被应答');
});

test('首帧不是 ready：判为坏连接并重连，不留下任何状态', async (t) => {
  const ctx = await connect(t);
  ctx.transport.connections[0].push({ type: 'emit', event: 'x', args: [] });
  await waitFor(() => ctx.transport.connections.length === 2, '坏连接被替换');
  assert.equal(ctx.transport.connections[0].closed, true, '旧连接被关闭');
  assert.equal(ctx.watcher.overlay(HOME).size, 0);

  // 新连接上 ready 之后一切正常。
  ctx.transport.connections[1].push(ready());
  ctx.transport.connections[1].push(approvalFrame());
  assert.equal(ctx.watcher.overlay(HOME).size, 1);
});

test('握手成功但 ready 迟迟不来：按超时判失败并重连（不会挂在半就绪的通道上）', async (t) => {
  const ctx = makeWatcher(t, { options: { connectTimeoutMs: 30 } });
  ctx.watcher.sync([{ homeId: HOME, url: URL1 }]);
  await waitFor(() => ctx.transport.connections.length === 1, '首连');
  // 故意不发 ready：watcher 必须在 connectTimeoutMs 之后放弃这条连接。
  await waitFor(() => ctx.transport.connections.length === 2, 'ready 超时后重连');
  assert.equal(ctx.transport.connections[0].closed, true);
  assert.equal(ctx.watcher.overlay(HOME).size, 0);
  assert.equal(ctx.calls.answers().length, 0);
});

test('升级被 401 拒：清掉 cookie 记忆，重连时重做 token→cookie 交接', async (t) => {
  let attempts = 0;
  const transport = {
    async connect(handlers) {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error('upgrade rejected 401');
        error.httpStatus = 401;
        throw error;
      }
      return { close() {} };
    },
  };
  const ctx = makeWatcher(t, { transport });
  ctx.watcher.sync([{ homeId: HOME, url: URL1 }]);
  // 第一次握手抛 401 → 退避后立刻重试；不假设两次尝试之间还有可观察的空窗（退避只有几毫秒）。
  await waitFor(() => attempts >= 2, '401 之后自动重连');
  // 第一次尝试做过一次交接（GET）；清掉记忆后第二次必须再 GET 一次 —— 否则就是拿着死 cookie 重试。
  const gets = ctx.calls.filter((call) => call.method === 'GET').length;
  assert.ok(gets >= 2, `401 之后应重新交接 cookie，实际 GET 次数=${gets}`);
  assert.equal(ctx.watcher.overlay(HOME).size, 0);
});

// —— 6. 清洗：NUL / 超长 / 空白 ——

test('NUL、超长与恶意字符串在归一阶段被清洗（不落进覆盖层）', async (t) => {
  const ctx = await connect(t);
  const conn = ctx.transport.connections[0];
  conn.push(ready());

  // agentId 里的 NUL 会被 SQLite 的 TEXT 绑定静默截断，必须在入口剥掉。
  conn.push(approvalFrame({ agentId: 'session-1\u0000evil' }));
  assert.deepEqual([...ctx.watcher.overlay(HOME).keys()], ['session-1evil']);

  // tool ≤ 64（+省略号），reason ≤ 160（+省略号），且都不带 NUL。
  conn.push(approvalFrame({
    agentId: 'session-long',
    request: {
      toolName: `bu\u0000sh${'x'.repeat(300)}`,
      reason: `原\u0000因${'y'.repeat(300)}`,
    },
  }));
  const long = ctx.watcher.overlay(HOME).get('session-long');
  assert.equal(long.tool.length, 65, 'tool 截断到 64 + 省略号');
  assert.ok(long.tool.startsWith('bush'), 'NUL 被剥掉');
  assert.ok(long.tool.endsWith('…'));
  assert.equal(long.reason.length, 161, 'reason 截断到 160 + 省略号');
  assert.ok(long.reason.endsWith('…'));
  assert.equal(long.reason.includes('\u0000'), false, 'reason 不含 NUL');

  // 只是空白的 agentId 视为无会话：整帧拒绝。
  conn.push(approvalFrame({ agentId: ' \u0000\t ' }));
  assert.equal(ctx.watcher.overlay(HOME).has(''), false);
  assert.equal(ctx.watcher.overlay(HOME).size, 2);
});

// —— 6.5 结算信号：emit 快路径 + probe 对账 ——
//
// 背景（真机 E2E 发现的缺陷）：dsh 只在 Host 侧中止/撤销时下发 cancel；我们的 next 把请求
// 委托出去之后，请求被浏览器答掉时**Host 不会再通知本连接** —— pending 集合没有内建结算信号。
// 于是 overlay 会挂一个最长 staleMs（30min）的「幽灵等待审批」。两条结算通道：
//   · emit 快路径：api-session/status(running=false) / api-session/removed；
//   · probe 对账：Host 会把仍挂起的 waterfall 全量重放到新开的 $events 流（eventId 不变），
//     窗口内没被重放的旧 eventId = 已结算。

const approvalWith = (eventId, agentId = 'session-1') => ({
  type: 'waterfall',
  event: 'approval/request',
  eventId,
  agentId,
  request: { toolName: 'bash', reason: 'rm -rf build' },
});

// probe 是「主连接之后的下一条连接」；测试通过它推 ready / 重放帧。
async function startReconcile(ctx, { push = true } = {}) {
  const job = ctx.watcher.reconcile();
  await waitFor(() => ctx.transport.connections.length === 2, 'probe 连接');
  const probe = ctx.transport.connections[1];
  if (push) probe.push(ready('probe-client'));
  return { job, probe };
}

test('对账：probe 重放到同一 eventId → 条目保留；probe 用自己的 clientId 恰好回一次 next 后关闭', async (t) => {
  const ctx = await connect(t, { options: { probeWindowMs: 80, reconcileIntervalMs: 0 } });
  const main = ctx.transport.connections[0];
  main.push(ready('main-client'));
  const live = approvalWith('event-still-pending');
  main.push(live);
  await waitFor(() => ctx.calls.answers().length === 1, '主流应答');

  const { job, probe } = await startReconcile(ctx);
  probe.push(live); // Host 重放：同 eventId = 仍挂起
  await awaitWithLoop(job);

  assert.equal(ctx.watcher.overlay(HOME).size, 1, '仍挂起的条目必须保留');
  assert.equal(probe.closed, true, '窗口结束后 probe 被主动关闭');
  const answers = ctx.calls.answers();
  assert.equal(answers.length, 2, '主流 + probe 各应答一次');
  assert.deepEqual(answers[1], {
    clientId: 'probe-client',
    eventId: 'event-still-pending',
    outcome: { kind: 'next' },
  }, 'probe 必须用自己的 clientId 立刻委托，不能挡在真实 UI 前面');
  assert.equal(ctx.watcher.homes.get(HOME).probe, null, 'probe 收尾后清空在飞标记');
});

test('对账：probe 没有重放（已结算）→ 条目被清掉并广播；未结算项不动', async (t) => {
  const ctx = await connect(t, { options: { probeWindowMs: 80, reconcileIntervalMs: 0 } });
  const main = ctx.transport.connections[0];
  main.push(ready('main-client'));
  const settled = approvalWith('event-already-answered', 'session-1');
  const stillPending = approvalWith('event-still-pending', 'session-2');
  main.push(settled);
  main.push(stillPending);
  await waitFor(() => ctx.calls.answers().length === 2, '主流应答');
  assert.equal(ctx.watcher.overlay(HOME).size, 2);

  const { job, probe } = await startReconcile(ctx);
  probe.push(stillPending); // 只重放仍挂起的那条
  await awaitWithLoop(job);

  assert.equal(ctx.watcher.overlay(HOME).size, 1, '已结算的条目被清掉');
  assert.equal(ctx.watcher.overlay(HOME).has('session-2'), true, '仍挂起的保留');
  assert.equal(ctx.watcher.overlay(HOME).has('session-1'), false);
  assert.ok(ctx.broadcasts.some((item) => item.event === 'intervention:updated'), '清理要广播');
});

test('对账：probe 什么都没重放 → 全部条目被清空（幽灵等待审批消失）', async (t) => {
  const ctx = await connect(t, { options: { probeWindowMs: 60, reconcileIntervalMs: 0 } });
  const main = ctx.transport.connections[0];
  main.push(ready('main-client'));
  main.push(approvalWith('event-ghost'));
  await waitFor(() => ctx.watcher.overlay(HOME).size === 1, '主流建立覆盖层');

  const { job } = await startReconcile(ctx);
  await awaitWithLoop(job);
  assert.equal(ctx.watcher.overlay(HOME).size, 0, '没有重放 = 已结算');
});

test('emit 快路径：api-session/status(running=false) 与 api-session/removed 清掉该会话的挂起项', async (t) => {
  const ctx = await connect(t, { options: { reconcileIntervalMs: 0 } });
  const main = ctx.transport.connections[0];
  main.push(ready());
  main.push(approvalWith('event-a', 'session-1'));
  main.push(approvalWith('event-b', 'session-2'));
  assert.equal(ctx.watcher.overlay(HOME).size, 2);

  // running=true（turn 继续跑）不是结算信号。
  main.push({ type: 'emit', event: 'api-session/status', args: ['session-1', true] });
  assert.equal(ctx.watcher.overlay(HOME).size, 2, 'running=true 不清');

  main.push({ type: 'emit', event: 'api-session/status', args: ['session-1', false] });
  assert.deepEqual([...ctx.watcher.overlay(HOME).keys()], ['session-2'], 'turn 结束 → 清该会话');

  main.push({ type: 'emit', event: 'api-session/removed', args: ['session-2'] });
  assert.equal(ctx.watcher.overlay(HOME).size, 0, '会话移除 → 清该会话');

  // 其它 emit（无关事件 / 畸形 args）不影响覆盖层，也不炸。
  main.push({ type: 'emit', event: 'api-session/status', args: [] });
  main.push({ type: 'emit', event: 'api-session/status', args: [42, false] });
  main.push({ type: 'emit', event: 'something/else', args: ['session-3', false] });
  assert.equal(ctx.watcher.overlay(HOME).size, 0);
});

test('对账：probe 连接失败 → 主覆盖层不动、不抛、同原因只 warn 一次', async (t) => {
  let connects = 0;
  const transport = {
    async connect(handlers) {
      connects += 1;
      if (connects > 1) throw new Error('probe connect boom');
      transport.connections.push({ closed: false, push: (value) => handlers.onValue(value) });
      return { close() {} };
    },
    connections: [],
  };
  const ctx = makeWatcher(t, { transport, options: { reconcileIntervalMs: 0 } });
  ctx.watcher.sync([{ homeId: HOME, url: URL1 }]);
  await waitFor(() => ctx.transport.connections.length === 1, '首连');
  ctx.transport.connections[0].push(ready());
  ctx.transport.connections[0].push(approvalWith('event-x'));
  assert.equal(ctx.watcher.overlay(HOME).size, 1);

  const warnCount = () => getLogs({ level: 'warn', limit: 200 })
    .filter((entry) => entry.scope === 'intervention' && entry.message.includes('探针')).length;
  const before = warnCount();

  await ctx.watcher.reconcile(); // 第一次：probe connect 抛错
  assert.equal(ctx.watcher.overlay(HOME).size, 1, 'probe 失败绝不能动覆盖层');
  assert.equal(warnCount(), before + 1, '失败记一条 warn');
  await ctx.watcher.reconcile(); // 第二次同原因：warnOnce 不再刷
  assert.equal(ctx.watcher.overlay(HOME).size, 1);
  assert.equal(warnCount(), before + 1, '同原因只记一次');
});

test('对账：probe 连上但 ready 不来 → 超时放弃，覆盖层不动', async (t) => {
  const ctx = await connect(t, { options: { probeWindowMs: 500, connectTimeoutMs: 40, reconcileIntervalMs: 0 } });
  const main = ctx.transport.connections[0];
  main.push(ready());
  main.push(approvalWith('event-y'));
  await waitFor(() => ctx.watcher.overlay(HOME).size === 1, '主流建立覆盖层');

  const { job, probe } = await startReconcile(ctx, { push: false }); // 故意不发 ready
  await awaitWithLoop(job);
  assert.equal(ctx.watcher.overlay(HOME).size, 1, 'probe 半就绪不该影响结论');
  assert.equal(probe.closed, true, '超时后 probe 被关闭');
});

test('对账：定时器自动对账（无需手动调用 reconcile）', async (t) => {
  const ctx = await connect(t, { options: { reconcileIntervalMs: 25, probeWindowMs: 25 } });
  const main = ctx.transport.connections[0];
  main.push(ready());
  main.push(approvalWith('event-auto'));
  await waitFor(() => ctx.watcher.overlay(HOME).size === 1, '主流建立覆盖层');

  await waitFor(() => ctx.transport.connections.length === 2, '定时器拉起 probe');
  ctx.transport.connections[1].push(ready('auto-probe'));
  await waitFor(() => ctx.watcher.overlay(HOME).size === 0, '自动对账清掉已结算条目');
});

test('对账：stop() 时在飞 probe 被作废（reconcile 的 Promise 也会收尾）', async (t) => {
  const ctx = await connect(t, { options: { probeWindowMs: 5000, reconcileIntervalMs: 0 } });
  const main = ctx.transport.connections[0];
  main.push(ready());
  main.push(approvalWith('event-z'));

  const { job, probe } = await startReconcile(ctx);
  ctx.watcher.stop();
  await awaitWithLoop(job); // 不能挂住
  assert.equal(probe.closed, true, 'stop 关闭在飞 probe');
  assert.equal(ctx.watcher.overlay(HOME).size, 0, 'stop 清空覆盖层');
  // 作废的 probe 不再把「没重放」误判成已结算（这里只验证没有抛错、状态干净）。
  assert.equal(ctx.watcher.homes.size, 0);
});

test('对账：overlay 为空时不发 probe（空闲零成本）', async (t) => {
  const ctx = await connect(t, { options: { reconcileIntervalMs: 0 } });
  ctx.transport.connections[0].push(ready());
  await ctx.watcher.reconcile();
  await flush();
  assert.equal(ctx.transport.connections.length, 1, '没有挂起项就不该建 probe');
});

// —— 7. apply：合并进会话行 ——

test('apply: 不修改入参、顶层写入、优先级正确、status 原样保留', async (t) => {
  const ctx = await connect(t);
  const conn = ctx.transport.connections[0];
  conn.push(ready());
  conn.push(approvalFrame({ agentId: 'session-1' }));
  conn.push(questionFrame({ agentId: 'session-2' }));

  const projectedQuestion = {
    kind: 'question', label: '等待回答', source: 'projection', since: null,
    tool: null, reason: '投影里的问题', count: 3,
  };
  const rows = [
    { homeId: HOME, sessionId: 'session-1', title: 'a', status: { kind: 'idle', label: '空闲' } },
    {
      homeId: HOME, sessionId: 'session-2', title: 'b',
      status: { kind: 'idle', label: '空闲', intervention: projectedQuestion },
      intervention: projectedQuestion,
    },
    { homeId: 'other-home', sessionId: 'session-1', title: 'c', status: { kind: 'idle' } },
    null,
  ];
  const snapshot = structuredClone(rows);

  const out = ctx.watcher.apply(rows);
  assert.deepEqual(rows, snapshot, '入参（含 status 与已有 intervention）必须逐字段不变');
  assert.notEqual(out, rows, '返回新数组');
  assert.equal(out.length, rows.length);
  assert.deepEqual(out.map((row) => row?.sessionId), ['session-1', 'session-2', 'session-1', undefined], '顺序不变');

  // 1) 实时覆盖层 → 顶层 intervention（无则不加字段）。
  assert.equal(out[0].intervention.kind, 'approval');
  assert.equal(out[0].intervention.source, 'live');
  assert.equal(out[0].intervention.reason, 'rm -rf build');
  assert.equal(Object.hasOwn(snapshot[0], 'intervention'), false, '原行本来没有这个字段');

  // 2) 同 kind：live 覆盖 projection（但 count 取较大者，since 取更早）。
  assert.equal(out[1].intervention.kind, 'question');
  assert.equal(out[1].intervention.source, 'live', '同 kind 时 live 赢');
  assert.equal(out[1].intervention.reason, '用哪个端口？');
  assert.equal(out[1].intervention.count, 3, 'count 取较大者');
  assert.equal(out[1].status, rows[1].status, 'status 对象原样保留（引用都不换）');

  // 3) 无覆盖层的行：原样返回同一个对象（绝大多数行走这条路径）。
  assert.equal(out[2], rows[2]);
  assert.equal(out[3], null);

  // 不同 kind：approval 压过 projection 的 question。
  const mixed = ctx.watcher.apply([{
    homeId: HOME, sessionId: 'session-1',
    status: { intervention: projectedQuestion },
  }]);
  assert.equal(mixed[0].intervention.kind, 'approval');
  assert.equal(mixed[0].intervention.reason, 'rm -rf build', 'approval 的 reason 来自实时帧');
  assert.equal(mixed[0].status.intervention.reason, '投影里的问题', 'status 里的投影值不动');

  // 反向：持久来源是 approval、实时覆盖层只是 question → 按 kind 优先级，approval 赢
  // （优先级高于 source：一条 projection 的审批比一条 live 的提问更急）。
  const reverse = ctx.watcher.apply([{
    homeId: HOME, sessionId: 'session-2',
    status: { intervention: { kind: 'approval', source: 'projection', tool: 'Bash', reason: '从投影来的审批' } },
  }]);
  assert.equal(reverse[0].intervention.kind, 'approval', 'approval > question');
  assert.equal(reverse[0].intervention.source, 'projection');
  assert.equal(reverse[0].intervention.reason, '从投影来的审批');
});

test('apply: 非数组/脏行/坏 intervention 都安全降级', async (t) => {
  const ctx = await connect(t);
  assert.equal(ctx.watcher.apply(null), null);
  assert.equal(ctx.watcher.apply('x'), 'x');
  assert.equal(ctx.watcher.apply(undefined), undefined);

  const rows = [
    { homeId: HOME, sessionId: 'session-1', intervention: { kind: 'nope' } },
    { homeId: HOME, sessionId: 'session-1', intervention: 'not-an-object' },
    { homeId: 7, sessionId: 'session-1' },
  ];
  const out = ctx.watcher.apply(rows);
  assert.equal(out.length, 3);
  assert.equal(Object.hasOwn(out[0], 'intervention'), false, '无效 kind 被剔除');
  assert.equal(Object.hasOwn(rows[0], 'intervention'), true, '入参没有被删字段');
  assert.equal(Object.hasOwn(out[1], 'intervention'), false);
  assert.equal(out[2], rows[2], '没有可用 homeId 的行原样返回');

  // 只有持久来源（status.intervention）时也要合并到顶层 —— 形状归一（label 由本地文案派生）。
  const onlyProjection = ctx.watcher.apply([{
    homeId: HOME, sessionId: 'session-x',
    status: { intervention: { kind: 'plan-review', source: 'projection' } },
  }]);
  assert.equal(onlyProjection[0].intervention.kind, 'plan-review');
  assert.equal(onlyProjection[0].intervention.label, '计划待审');
});

test('mergeIntervention 从本模块原样导出（集成方/测试共用同一份规则）', () => {
  const merged = mergeIntervention(
    { kind: 'question', source: 'projection', reason: '投影' },
    { kind: 'question', source: 'live', reason: '实时' },
  );
  assert.equal(merged.kind, 'question');
  assert.equal(merged.source, 'live');
  assert.equal(merged.reason, '实时');
  assert.equal(mergeIntervention(null, null), null);
});

// —— 8. sync：幂等、增删、重连、非法输入 ——

test('sync: 幂等、按 homeId 增删、url 变化重连、非法输入不抛', async (t) => {
  const ctx = makeWatcher(t);
  const { watcher, transport } = ctx;

  watcher.sync([{ homeId: HOME, url: URL1 }]);
  await waitFor(() => transport.connections.length === 1, '首连');
  watcher.sync([{ homeId: HOME, url: URL1 }]);
  await flush();
  assert.equal(transport.connections.length, 1, '同 homeId + 同 url = 幂等，不重建连接');

  // 非法输入：不抛、不影响既有连接。
  for (const input of [null, undefined, 0, 'x', {}, [null], [{}], [{ homeId: HOME }], [{ url: URL1 }],
    [{ homeId: '', url: URL1 }], [{ homeId: HOME, url: '' }]]) {
    assert.doesNotThrow(() => watcher.sync(input), `sync(${JSON.stringify(input)}) 不应抛错`);
  }
  assert.equal(transport.connections.length, 1);

  // url 变化 → 旧连接关闭、新连接建立。
  watcher.sync([{ homeId: HOME, url: URL2 }]);
  await waitFor(() => transport.connections.length === 2, 'url 变化后重连');
  assert.equal(transport.connections[0].closed, true, '旧连接被主动关闭');
  assert.equal(watcher.homes.get(HOME).url, URL2);

  // 目标消失 → 断开并清空覆盖层。
  transport.connections[1].push(ready());
  transport.connections[1].push(approvalFrame());
  assert.equal(watcher.overlay(HOME).size, 1);
  watcher.sync([]);
  await flush();
  assert.equal(transport.connections[1].closed, true);
  assert.equal(watcher.overlay(HOME).size, 0);
  assert.equal(watcher.all().size, 0);
});

test('stop(): 断开且不再重连，过期回调被作废', async (t) => {
  const ctx = makeWatcher(t);
  const { watcher, transport } = ctx;
  watcher.sync([{ homeId: HOME, url: URL1 }]);
  await waitFor(() => transport.connections.length === 1, '首连');
  transport.connections[0].push(ready());
  transport.connections[0].push(approvalFrame());
  assert.equal(watcher.overlay(HOME).size, 1);
  // 先等这条 waterfall 的应答落地，否则下面读到的 before 会漏掉它（应答是异步 RPC）。
  await waitFor(() => ctx.calls.answers().length === 1, '首条应答');

  watcher.stop();
  assert.equal(watcher.overlay(HOME).size, 0, 'stop 清空覆盖层');
  assert.equal(transport.connections[0].closed, true, 'stop 关闭连接');
  assert.doesNotThrow(() => watcher.stop(), 'stop 幂等');

  // 过期回调：旧连接的帧不应再写进状态，也不应再触发应答。
  const before = ctx.calls.answers().length;
  transport.connections[0].push(ready());
  transport.connections[0].push(approvalFrame());
  await sleep(60);
  assert.equal(watcher.overlay(HOME).size, 0);
  assert.equal(ctx.calls.answers().length, before);
  assert.equal(transport.connections.length, 1, 'stop 后不再重连');

  // stop 之后 sync 是 no-op（server.js 的定时器可能在 stop 后还会跑一轮）。
  assert.doesNotThrow(() => watcher.sync([{ homeId: HOME, url: URL1 }]));
  await sleep(20);
  assert.equal(transport.connections.length, 1);
});

// —— 9. 过期清理与广播 ——

test('staleMs: 超过有效期的挂起条目被清掉，并广播变更', async (t) => {
  let clock = NOW;
  const ctx = await connect(t, { options: { now: () => clock, staleMs: 40 } });
  const conn = ctx.transport.connections[0];
  conn.push(ready());
  conn.push(approvalFrame({ agentId: 'session-1' }));
  assert.equal(ctx.watcher.overlay(HOME).size, 1);

  clock += 100; // 超过 staleMs（Host 漏发 cancel 的兜底）
  await waitFor(() => ctx.watcher.overlay(HOME).size === 0, '过期条目被清扫');
  // 广播有 ~50ms 去抖，不能只等覆盖层变化。
  await waitFor(
    () => ctx.broadcasts.some((item) => item.event === 'intervention:updated'),
    '过期清理的广播',
  );
});

test('broadcast 抛错被吞掉：观察链路继续工作', async (t) => {
  const calls = mockFetch(t);
  const transport = fakeTransport(t);
  let throwCount = 0;
  const watcher = new PendingInteractionWatcher({
    transport,
    broadcast: () => { throwCount += 1; throw new Error('hub is closed'); },
    now: () => NOW,
    reconnectBaseMs: 5,
    connectTimeoutMs: 200,
  });
  t.after(() => watcher.stop());
  watcher.sync([{ homeId: HOME, url: URL1 }]);
  await waitFor(() => transport.connections.length === 1, '首连');
  transport.connections[0].push(ready());
  transport.connections[0].push(approvalFrame());

  await waitFor(() => throwCount > 0, '广播确实被调用过并抛错');
  assert.equal(watcher.overlay(HOME).size, 1, '广播失败不影响覆盖层');
  await waitFor(() => calls.answers().length === 1, '应答照常');
});

test('注入的 transport 缺失/非法时回落到真实 WS transport（不抛）', () => {
  for (const transport of [null, undefined, {}, { connect: 42 }]) {
    const watcher = new PendingInteractionWatcher({ transport });
    assert.equal(typeof watcher.transport.connect, 'function');
    watcher.stop();
  }
  assert.equal(typeof createRemoteMuxTransport().connect, 'function');
});
