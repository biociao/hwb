import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';

import { PendingInteractionWatcher } from '../src/dshhome/pending-interactions.js';

// 真实 socket 上的 WebSocket 桥（默认 transport）：
//   · 握手：GET /api/remote.mux，headers 带 Cookie（dsh 的鉴权是 Cookie，全局 WebSocket 带不了头）、
//     Connection/Upgrade/Sec-WebSocket-Version/Sec-WebSocket-Key（16 字节 base64）；
//   · 逻辑流：101 之后发 {type:'open',streamId,endpoint:'$events',payload:{args:{}}}；
//   · 下行：ready → waterfall → 覆盖层；每个 waterfall **恰好**回一次 {kind:'next'}；
//   · 保活（真机实测）：dsh 每 2s 发 WS ping(0x9)，客户端必须回 pong(0xa) 并回显 payload，
//     否则服务端约 10s 后直接关 socket —— 这里用真 ping 断言 pong；
//   · 断流：服务端关 socket → 立刻清空覆盖层 → 自动重连 → 按 Host 重放重建。
//
// 这台假 dsh 只实现观察器用到的子集：303 Set-Cookie、/api/remote.mux 升级、$events 下行、
// `POST /api/$events/result` 上行应答。

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const HOME = 'home-live';
const NOW = Date.parse('2026-10-27T06:00:00.000Z');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// probe 的窗口定时器是 unref 的：单测里若没有别的句柄，事件循环会空掉、await 永远等不到。
async function awaitWithLoop(promise) {
  const ticker = setInterval(() => {}, 10);
  try {
    return await promise;
  } finally {
    clearInterval(ticker);
  }
}

async function waitFor(predicate, label, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`等待超时: ${label}`);
    await sleep(5);
  }
}

// 服务端 → 客户端：不 mask（RFC6455 要求）。
function encodeServerFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = body.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, body]);
}

// 客户端 → 服务端：必须 mask。这里解出来做断言（证明观察器写的是**合规**帧）。
function createClientFrameDecoder(onFrame) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const first = buffer[0];
      const second = buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const maskLength = masked ? 4 : 0;
      if (buffer.length < offset + maskLength + length) return;
      const mask = masked ? buffer.subarray(offset, offset + 4) : null;
      offset += maskLength;
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3];
      buffer = buffer.subarray(offset + length);
      if (!fin) continue; // 客户端不会分片发送；真出现就交给下一个用例暴露
      onFrame({ opcode, payload, masked });
    }
  };
}

function createDshStub(t) {
  const state = {
    port: 0,
    tokenGets: 0,
    upgrades: [],
    opens: [],
    results: [],
    resultRequests: [],
    pongs: [],
    connections: [],
    sockets: new Set(),
  };

  const server = http.createServer((req, res) => {
    // token→cookie 交接：303 + Set-Cookie（与 live-status 的 acquireCookie 契约一致）。
    if (req.method === 'GET' && req.url.startsWith('/?token=')) {
      state.tokenGets += 1;
      res.writeHead(303, { Location: '/', 'Set-Cookie': 'dsh_session=stub; Path=/' });
      res.end();
      return;
    }
    // waterfall 的委托应答：POST /api/$events/result。
    if (req.method === 'POST' && req.url === '/api/$events/result') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        try {
          const message = JSON.parse(body);
          state.results.push(message.payload.args);
          state.resultRequests.push({ cookie: req.headers.cookie ?? null, message });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ type: 'server-response', rpcId: message.rpcId, result: { ok: true, value: {} } }));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end('{}');
        }
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.on('upgrade', (req, socket, head) => {
    state.upgrades.push({
      path: req.url,
      cookie: req.headers.cookie ?? null,
      key: req.headers['sec-websocket-key'] ?? null,
      version: req.headers['sec-websocket-version'] ?? null,
    });
    const accept = crypto.createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}${WS_GUID}`)
      .digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '', '',
    ].join('\r\n'));
    socket.setNoDelay?.(true);
    state.sockets.add(socket);
    socket.on('close', () => state.sockets.delete(socket));
    socket.on('error', () => { /* 用例会主动 destroy */ });

    const connection = {
      socket,
      streamId: null,
      open: null,
      // 下行必须包一层逻辑流信封：{type:'item', streamId, value}（streamId 来自 open）。
      send(value) {
        if (socket.destroyed) return;
        socket.write(encodeServerFrame(0x1, JSON.stringify({
          type: 'item',
          streamId: connection.streamId,
          value,
        })));
      },
      ping(payload = '') {
        if (socket.destroyed) return;
        socket.write(encodeServerFrame(0x9, payload));
      },
      close() {
        if (socket.destroyed) return;
        try { socket.write(encodeServerFrame(0x8, Buffer.from([0x03, 0xe8]))); } catch { /* 已断 */ }
        try { socket.destroy(); } catch { /* 已断 */ }
      },
    };
    state.connections.push(connection);

    const decode = createClientFrameDecoder(({ opcode, payload, masked }) => {
      if (opcode === 0x1 || opcode === 0x2) {
        let message = null;
        try { message = JSON.parse(payload.toString('utf8')); } catch { /* 非 JSON：测试不关心 */ }
        if (!message) return;
        if (message.type === 'open') {
          connection.streamId = message.streamId;
          connection.open = message;
          state.opens.push(message);
        }
        return;
      }
      if (opcode === 0xa) {
        // 真机保活断言：pong 必须回显 ping 的 payload，且客户端帧必须是 masked 的。
        state.pongs.push({ payload: payload.toString('utf8'), masked });
        return;
      }
      if (opcode === 0x8) connection.close();
    });
    if (head && head.length) decode(head);
    socket.on('data', decode);
  });

  t.after(() => new Promise((resolve) => {
    for (const socket of state.sockets) {
      try { socket.destroy(); } catch { /* 已断 */ }
    }
    server.closeAllConnections?.();
    server.close(() => resolve());
    // close() 的回调可能等不到（连接已被 destroy），兜底 resolve。
    setTimeout(resolve, 50).unref?.();
  }));

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      state.port = server.address().port;
      resolve(state);
    });
  });
}

function startWatcher(t, stub) {
  const watcher = new PendingInteractionWatcher({
    reconnectBaseMs: 20,
    reconnectMaxMs: 60,
    connectTimeoutMs: 800,
    // 对账由用例显式调 reconcile()（窗口压短到 200ms）；关掉后台定时器以免干扰连接计数。
    reconcileIntervalMs: 0,
    probeWindowMs: 200,
    now: () => NOW,
  });
  t.after(() => watcher.stop());
  watcher.sync([{ homeId: HOME, url: `http://127.0.0.1:${stub.port}/?token=stub-token` }]);
  return watcher;
}

const ready = (clientId = 'stub-client') => ({ type: 'ready', clientId, host: { home: '/Users/tester' } });
const approval = (eventId = 'event-approval-1') => ({
  type: 'waterfall',
  event: 'approval/request',
  eventId,
  agentId: 'session-a',
  request: {
    toolName: 'bash',
    callId: 'call_1',
    reason: 'escalate sandbox to danger-full-access',
    displayReason: {
      en: 'Allow this operation with danger-full-access permissions',
      zh: '允许本次操作使用 danger-full-access 权限',
    },
  },
});
const question = (eventId = 'event-question-1') => ({
  type: 'waterfall',
  event: 'user-questions/request',
  eventId,
  agentId: 'session-b',
  request: { questions: [{ id: 'q1', question: '用哪个端口？' }] },
});

test('真实 socket：握手带 Cookie、open $events、ready+waterfall → 每个恰好回一次 next 并回 pong', async (t) => {
  const stub = await createDshStub(t);
  const watcher = startWatcher(t, stub);

  await waitFor(() => stub.connections.length === 1 && stub.connections[0].open, '建立 WS 并发出 open');
  const [upgrade] = stub.upgrades;

  // ① 握手：路径、Cookie、Sec-WebSocket-Key（16 字节 base64）、版本 13。
  assert.equal(upgrade.path, '/api/remote.mux');
  assert.equal(upgrade.cookie, 'dsh_session=stub', 'dsh 鉴权靠 Cookie：必须把交接来的 cookie 带在升级请求上');
  assert.equal(upgrade.version, '13');
  assert.equal(Buffer.from(upgrade.key, 'base64').length, 16, 'Sec-WebSocket-Key 必须是 16 随机字节的 base64');

  // ② 逻辑流打开消息：endpoint $events，payload {args:{}}（与 stream-protocol.ts 一致）。
  const [open] = stub.opens;
  assert.equal(open.type, 'open');
  assert.equal(open.endpoint, '$events');
  assert.deepEqual(open.payload, { args: {} });
  assert.equal(typeof open.streamId, 'string');
  assert.ok(open.streamId.length > 0);

  // ③ 下行：先 ready，再两条 waterfall，再一条 emit（通知帧不应答）。
  const connection = stub.connections[0];
  connection.send(ready('stub-client'));
  connection.send(approval());
  connection.send(question());
  connection.send({ type: 'emit', event: 'turn/start', args: [] });

  await waitFor(() => stub.results.length === 2, '两条 waterfall 的应答');
  assert.equal(watcher.overlay(HOME).size, 2, '两张卡片：审批 + 提问');
  const approvalCard = watcher.overlay(HOME).get('session-a');
  assert.equal(approvalCard.kind, 'approval');
  assert.equal(approvalCard.label, '等待审批');
  assert.equal(approvalCard.tool, 'bash');
  assert.equal(approvalCard.reason, '允许本次操作使用 danger-full-access 权限',
    'displayReason 的 locale 映射被归一成中文原因');
  const questionCard = watcher.overlay(HOME).get('session-b');
  assert.equal(questionCard.kind, 'question');
  assert.equal(questionCard.reason, '用哪个端口？');

  // ④ 应答：每个 waterfall 恰好一次 {kind:'next'}，clientId/eventId 与 ready/帧对得上，走 Cookie 鉴权。
  assert.deepEqual(stub.results, [
    { clientId: 'stub-client', eventId: 'event-approval-1', outcome: { kind: 'next' } },
    { clientId: 'stub-client', eventId: 'event-question-1', outcome: { kind: 'next' } },
  ]);
  assert.equal(stub.resultRequests[0].cookie, 'dsh_session=stub', '应答 RPC 同样带 cookie');
  assert.equal(stub.resultRequests[0].message.type, 'client-request');
  assert.equal(stub.resultRequests[0].message.method, '$events/result');

  // ⑤ 保活（真机行为）：dsh 每 2s ping，客户端必须回 pong 并回显 payload。
  connection.ping('hb-1');
  await waitFor(() => stub.pongs.length === 1, 'pong 应答');
  assert.equal(stub.pongs[0].payload, 'hb-1', 'pong 必须原样回显 ping 的 payload');
  assert.equal(stub.pongs[0].masked, true, '客户端帧必须 masked（RFC6455）');
  connection.ping('');
  await waitFor(() => stub.pongs.length === 2, '空 payload 的 ping 同样要回 pong');

  // ⑥ 再等一会：不应出现重复应答（每个 waterfall 恰好一次）。
  await sleep(120);
  assert.equal(stub.results.length, 2, 'waterfall 不应被重复应答');

  // ⑦ 停掉观察器：覆盖层清空、连接被关。
  watcher.stop();
  assert.equal(watcher.overlay(HOME).size, 0);
  await waitFor(() => stub.sockets.size === 0, '停止后连接关闭', 2000);
});

test('真实 socket：服务端关连接 → 立刻清空 → 自动重连 → 按重放重建', async (t) => {
  const stub = await createDshStub(t);
  const watcher = startWatcher(t, stub);

  await waitFor(() => stub.connections.length === 1 && stub.connections[0].open, '首连');
  stub.connections[0].send(ready('first-client'));
  stub.connections[0].send(approval('event-approval-1'));
  await waitFor(() => stub.results.length === 1, '首条应答');
  assert.equal(watcher.overlay(HOME).size, 1);

  // 真机行为：应答后服务端会关 socket（真因是没回 pong，我们已经会回；这里模拟「无论如何都会断」）。
  stub.connections[0].close();
  await waitFor(() => watcher.overlay(HOME).size === 0, '断流立刻清空覆盖层');

  // 自动重连（指数退避基数 20ms，很快）。
  await waitFor(() => stub.connections.length === 2 && stub.connections[1].open, '自动重连');
  assert.equal(stub.tokenGets, 1, 'cookie 交接有记忆：重连不再重做 token→cookie');

  // Host 在重连后重放仍挂起的 waterfall → 覆盖层重建。
  stub.connections[1].send(ready('second-client'));
  assert.equal(watcher.overlay(HOME).size, 0, '重放之前保持空（避免幽灵等待审批）');
  stub.connections[1].send(approval('event-approval-1'));
  await waitFor(() => watcher.overlay(HOME).size === 1, '重放后重建');
  await waitFor(() => stub.results.length === 2, '重放后的应答');
  assert.equal(stub.results[1].clientId, 'second-client', '应答必须用新一代 clientId');
  assert.deepEqual(stub.results[1].outcome, { kind: 'next' });

  watcher.stop();
  await waitFor(() => stub.sockets.size === 0, '停止后连接关闭', 2000);
});

test('真实 socket：probe 对账流（重放=仍挂起保留；空重放=已结算清掉），关闭后不留连接', async (t) => {
  const stub = await createDshStub(t);
  const watcher = startWatcher(t, stub);

  await waitFor(() => stub.connections.length === 1 && stub.connections[0].open, '主连接');
  stub.connections[0].send(ready('main-client'));
  stub.connections[0].send(approval('event-approval-1'));
  await waitFor(() => stub.results.length === 1, '主流应答');
  assert.equal(watcher.overlay(HOME).size, 1);

  // 第一轮对账：Host 在 probe 流上重放同一 eventId ⇒ 仍挂起 ⇒ 保留。
  const first = watcher.reconcile();
  await waitFor(() => stub.connections.length === 2 && stub.connections[1].open, 'probe #1');
  stub.connections[1].send(ready('probe-client-1'));
  stub.connections[1].send(approval('event-approval-1'));
  await awaitWithLoop(first);
  assert.equal(watcher.overlay(HOME).size, 1, '被重放 = 仍挂起，保留标记');
  await waitFor(() => stub.results.length === 2, 'probe #1 的 next 应答');
  assert.equal(stub.results[1].clientId, 'probe-client-1', 'probe 用**自己**的 clientId 应答');
  assert.deepEqual(stub.results[1].outcome, { kind: 'next' });
  await waitFor(() => stub.connections[1].socket.destroyed || stub.sockets.size <= 1, 'probe #1 关闭');

  // 第二轮对账：probe 什么都不重放 ⇒ 已结算 ⇒ 清掉「幽灵等待审批」。
  const second = watcher.reconcile();
  await waitFor(() => stub.connections.length === 3 && stub.connections[2].open, 'probe #2');
  stub.connections[2].send(ready('probe-client-2'));
  await awaitWithLoop(second);
  assert.equal(watcher.overlay(HOME).size, 0, '没有重放 = 已结算');
  assert.equal(stub.results.length, 2, '空重放不产生额外应答');

  watcher.stop();
  await waitFor(() => stub.sockets.size === 0, '停止后所有连接关闭', 2000);
});
