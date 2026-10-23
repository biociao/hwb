// 最小 Matrix client 的契约测试（零依赖：node:http 起假 homeserver，真 fetch 打过去）。
//
// 这些用例守的不是「HTTP 能不能通」，而是四条会静默出错的可靠性约定：
//   1. `/sync` 的 since 只在调用方处理完一批后才推进（否则崩溃=丢事件）；
//   2. 出站先落盘、同 txnId 重试不产生第二条（否则丢包=重复执行）；
//   3. 429 按 retry_after_ms 退避、401 停止重试（否则重试风暴/无效重连）；
//   4. 加密房间必须显式失败（本客户端不支持 E2EE，静默继续=消息永远没人看见）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createMatrixClient,
  createFileStore,
  createMemoryStore,
  defaultFilter,
  emptyState,
  backoffMs,
  decideInvite,
  MatrixError,
  EncryptedRoomError,
  StateCorruptError,
} from '../src/channel/matrix-min.js';

// —— 假 homeserver：只实现本模块用到的端点，行为由 state 驱动 ——

async function startHomeserver({ token = 'tok', userId = '@dsh:test' } = {}) {
  const requests = [];
  const sent = [];
  const txns = new Map();
  const state = {
    syncReply: () => ({ next_batch: 's-1', rooms: {} }),
    syncDelayMs: 0,
    rateLimitLeft: 0,
    sendRateLimitLeft: 0,
    retryAfterMs: 5,
    failStatus: null,
    roomState: new Map(), // `${roomId}|${type}|${stateKey}` -> content
  };

  const readBody = (req) => new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try { resolve(text ? JSON.parse(text) : null); } catch { resolve(null); }
    });
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fake');
    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams) });
    const body = await readBody(req);
    const json = (code, payload) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    res.on('error', () => {});
    try {
      if (url.pathname === '/_matrix/client/v3/versions') return json(200, { versions: ['v1.11'] });
      if (req.headers.authorization !== `Bearer ${token}`) {
        return json(401, { errcode: 'M_UNKNOWN_TOKEN', error: 'bad token' });
      }
      if (state.failStatus) return json(state.failStatus.code, state.failStatus.body);

      if (url.pathname === '/_matrix/client/v3/account/whoami') return json(200, { user_id: userId });

      if (url.pathname === '/_matrix/client/v3/sync') {
        if (state.syncDelayMs) await new Promise((r) => setTimeout(r, state.syncDelayMs));
        if (state.rateLimitLeft > 0) {
          state.rateLimitLeft -= 1;
          return json(429, { errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: state.retryAfterMs });
        }
        return json(200, state.syncReply(url.searchParams));
      }

      let m;
      if ((m = url.pathname.match(/^\/_matrix\/client\/v3\/rooms\/([^/]+)\/send\/([^/]+)\/([^/]+)$/))) {
        if (state.sendRateLimitLeft > 0) {
          state.sendRateLimitLeft -= 1;
          return json(429, { errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: state.retryAfterMs });
        }
        const roomId = decodeURIComponent(m[1]);
        const type = decodeURIComponent(m[2]);
        const txnId = decodeURIComponent(m[3]);
        const key = `${roomId}|${type}|${txnId}`;
        if (!txns.has(key)) {
          txns.set(key, `$evt-${txns.size + 1}`);
          sent.push({ roomId, type, txnId, content: body, eventId: txns.get(key) });
        }
        return json(200, { event_id: txns.get(key) });
      }
      if ((m = url.pathname.match(/^\/_matrix\/client\/v3\/rooms\/([^/]+)\/state\/([^/]+)\/([^/]*)$/))) {
        const key = `${decodeURIComponent(m[1])}|${decodeURIComponent(m[2])}|${decodeURIComponent(m[3])}`;
        if (req.method === 'PUT') { state.roomState.set(key, body); return json(200, { event_id: '$state-1' }); }
        if (state.roomState.has(key)) return json(200, state.roomState.get(key));
        return json(404, { errcode: 'M_NOT_FOUND' });
      }
      if ((m = url.pathname.match(/^\/_matrix\/client\/v3\/rooms\/([^/]+)\/messages$/))) {
        return json(200, { chunk: [{ type: 'm.room.message', event_id: '$old-1' }], start: 'a', end: 'b' });
      }
      if ((m = url.pathname.match(/^\/_matrix\/client\/v3\/rooms\/([^/]+)\/typing\/([^/]+)$/))) {
        return json(200, {});
      }
      if (url.pathname === '/_matrix/client/v3/joined_rooms') return json(200, { joined_rooms: ['!a:test'] });
      if ((m = url.pathname.match(/^\/_matrix\/client\/v3\/join\/([^/]+)$/))) {
        return json(200, { room_id: decodeURIComponent(m[1]) });
      }
      if (url.pathname === '/_matrix/client/v3/createRoom') return json(200, { room_id: '!new:test' });

      return json(404, { errcode: 'M_NOT_FOUND', path: url.pathname });
    } catch (error) {
      return json(500, { errcode: 'M_UNKNOWN', error: String(error?.message) });
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    baseUrl,
    token,
    userId,
    requests,
    sent,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function makeClient(home, overrides = {}) {
  return createMatrixClient({
    baseUrl: home.baseUrl,
    token: home.token,
    userId: home.userId,
    store: createMemoryStore(),
    sleep: async () => {},
    log: () => {},
    ...overrides,
  });
}

// —— 账号 ——

test('whoami：token 有效时返回 user_id；配置的 userId 不一致时立即致命失败', async () => {
  const home = await startHomeserver();
  try {
    const client = makeClient(home);
    assert.equal(await client.whoami(), '@dsh:test');

    const wrong = makeClient(home, { userId: '@other:test' });
    await assert.rejects(() => wrong.whoami(), (error) => {
      assert.ok(error instanceof MatrixError);
      assert.equal(error.fatal, true, 'userId 不一致必须致命：说明 token 配错了账号');
      return true;
    });
  } finally { await home.close(); }
});

// —— 同步 / 游标 ——

test('syncOnce：带 since 与 filter、返回归一化事件，但**不推进** since；commit 后才推进并落盘', async () => {
  const home = await startHomeserver();
  home.state.syncReply = () => ({
    next_batch: 's-2',
    rooms: {
      join: {
        '!a:test': {
          timeline: { events: [{ type: 'm.room.message', event_id: '$m1', content: { body: 'hi' } }], limited: false },
          state: { events: [] },
        },
      },
    },
  });
  try {
    const store = createMemoryStore();
    const client = makeClient(home, { store });
    client.commit({ nextBatch: 's-1' }); // 模拟上一次已处理完的游标

    const batch = await client.syncOnce({ timeout: 1234 });
    const syncReq = home.requests.find((r) => r.path.endsWith('/sync'));
    assert.equal(syncReq.query.since, 's-1', '必须从已提交的 since 续上');
    assert.equal(syncReq.query.timeout, '1234');
    assert.deepEqual(JSON.parse(syncReq.query.filter).room.timeline.types, defaultFilter().room.timeline.types);
    assert.equal(batch.nextBatch, 's-2');
    assert.equal(batch.rooms[0].events[0].event_id, '$m1');
    assert.equal(client.getState().since, 's-1', '未 commit 前 since 不能动（崩溃会重放而不是丢事件）');
    assert.equal(store.peek().since, 's-1');

    client.commit(batch);
    assert.equal(client.getState().since, 's-2');
    assert.equal(store.peek().since, 's-2', 'commit 必须持久化');
  } finally { await home.close(); }
});

test('syncOnce：limited 透出 prev_batch（缺口信号），去重集合按 event_id 有界增长', async () => {
  const home = await startHomeserver();
  home.state.syncReply = () => ({
    next_batch: 's-2',
    rooms: { join: { '!a:test': { timeline: { events: [], limited: true, prev_batch: 'p-1' }, state: { events: [] } } } },
  });
  try {
    const client = makeClient(home);
    const batch = await client.syncOnce();
    assert.equal(batch.rooms[0].limited, true);
    assert.equal(batch.rooms[0].prevBatch, 'p-1', '缺口必须能回填，不能假装没发生');

    client.markSeen('$e1');
    assert.equal(client.isSeen('$e1'), true);
    assert.equal(client.isSeen('$e2'), false);
    client.markSeen('$e1'); // 重复标记不重复入队
    assert.equal(client.getState().dedupe.length, 1);
  } finally { await home.close(); }
});

// —— 出站 / 幂等 ——

test('send：同一 txnId 重发返回原 event_id，服务端只落一条；不同 txnId 才是两条', async () => {
  const home = await startHomeserver();
  try {
    const client = makeClient(home);
    const first = await client.send('!a:test', 'm.room.message', { msgtype: 'm.text', body: 'x' }, { txnId: 't-1' });
    const again = await client.send('!a:test', 'm.room.message', { msgtype: 'm.text', body: 'x' }, { txnId: 't-1' });
    assert.equal(first, again, 'txnId 幂等：HTTP 超时重发不会产生第二条');
    assert.equal(home.sent.length, 1);

    await client.send('!a:test', 'm.room.message', { msgtype: 'm.text', body: 'x' }, { txnId: 't-2' });
    assert.equal(home.sent.length, 2);
  } finally { await home.close(); }
});

test('outbox：先落盘再发；新进程（新 client）用同一 store 恢复后补发，且不重复', async () => {
  const home = await startHomeserver();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwb-matrix-'));
  const file = path.join(dir, 'state.json');
  try {
    const first = createMatrixClient({
      baseUrl: home.baseUrl, token: home.token, store: createFileStore(file), sleep: async () => {}, log: () => {},
    });
    const txnId = first.sendText('!a:test', '重启前入队');
    assert.equal(first.getState().outbox.length, 1, '入队即落盘');
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(onDisk.outbox[0].txnId, txnId);

    // 模拟进程重启：新 client 读同一个文件
    const second = createMatrixClient({
      baseUrl: home.baseUrl, token: home.token, store: createFileStore(file), sleep: async () => {}, log: () => {},
    });
    const result = await second.flushOutbox();
    assert.deepEqual(result, { sent: 1, remaining: 0 });
    assert.equal(home.sent.length, 1);
    assert.equal(home.sent[0].txnId, txnId, '必须用原 txnId 补发');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).outbox.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await home.close();
  }
});

test('flushOutbox：429 按 retry_after_ms 退避后用同一 txnId 重试（不新建消息）', async () => {
  const home = await startHomeserver();
  home.state.sendRateLimitLeft = 1;
  home.state.retryAfterMs = 7;
  try {
    const waits = [];
    const client = makeClient(home, { sleep: async (ms) => { waits.push(ms); } });
    const txnId = client.sendText('!a:test', '限流一次');
    const result = await client.flushOutbox();
    assert.deepEqual(waits, [7], '必须尊重服务端给的 retry_after_ms');
    assert.deepEqual(result, { sent: 1, remaining: 0 });
    assert.equal(home.sent.length, 1);
    assert.equal(home.sent[0].txnId, txnId);
  } finally { await home.close(); }
});

test('flushOutbox：401/M_UNKNOWN_TOKEN 是致命错误——不重试、outbox 保留、错误可归因', async () => {
  const home = await startHomeserver();
  try {
    const client = makeClient(home, { token: 'expired-token' });
    client.sendText('!a:test', '不会发出去');
    const sendAttempts = () => home.requests.filter((r) => r.path.includes('/send/')).length;
    await assert.rejects(() => client.flushOutbox(), (error) => {
      assert.ok(error instanceof MatrixError);
      assert.equal(error.tokenInvalid, true);
      assert.equal(error.fatal, true);
      return true;
    });
    assert.equal(sendAttempts(), 1, '致命错误不能自动重试');
    assert.equal(client.getState().outbox.length, 1, '失败的消息必须留在 outbox 里');
  } finally { await home.close(); }
});

// —— 邀请白名单 ——

test('handleInvites：只 join 白名单邀请；非白名单不发任何请求（防止 bot 被拉进任意房间）', async () => {
  const home = await startHomeserver();
  try {
    const client = makeClient(home);
    const results = await client.handleInvites(
      [
        { roomId: '!allowed:test', inviter: '@owner:test' },
        { roomId: '!evil:test', inviter: '@stranger:test' },
      ],
      { allowlist: { rooms: [], users: ['@owner:test'] } },
    );
    assert.deepEqual(results.map((r) => r.action), ['joined', 'refused']);
    const joins = home.requests.filter((r) => r.method === 'POST' && r.path.includes('/join/'));
    assert.equal(joins.length, 1);
    assert.ok(joins[0].path.includes(encodeURIComponent('!allowed:test')));
    assert.equal(decideInvite({ roomId: '!x:test', inviter: '@stranger:test' }, { rooms: [], users: ['@owner:test'] }).join, false);
  } finally { await home.close(); }
});

// —— 加密房间：明确拒绝 ——

test('syncOnce：房间出现 m.room.encryption 状态或 m.room.encrypted 事件时必须显式失败，且不推进 since', async () => {
  const home = await startHomeserver();
  try {
    const client = makeClient(home);
    home.state.syncReply = () => ({
      next_batch: 's-2',
      rooms: { join: { '!enc:test': { state: { events: [{ type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } }] }, timeline: { events: [] } } } },
    });
    await assert.rejects(() => client.syncOnce(), EncryptedRoomError);
    assert.equal(client.getState().since, null, '失败时 since 不能推进');

    home.state.syncReply = () => ({
      next_batch: 's-3',
      rooms: { join: { '!enc:test': { state: { events: [] }, timeline: { events: [{ type: 'm.room.encrypted', event_id: '$e' }] } } } },
    });
    await assert.rejects(() => client.syncOnce(), EncryptedRoomError);
  } finally { await home.close(); }
});

test('assertRoomUnencrypted / roomState：加密房抛错，未设置状态返回 null（404 不等于错误）', async () => {
  const home = await startHomeserver();
  try {
    const client = makeClient(home);
    assert.equal(await client.roomState('!plain:test', 'm.room.encryption'), null);
    assert.equal(await client.assertRoomUnencrypted('!plain:test'), true);

    home.state.roomState.set('!enc:test|m.room.encryption|', { algorithm: 'm.megolm.v1.aes-sha2' });
    await assert.rejects(() => client.assertRoomUnencrypted('!enc:test'), EncryptedRoomError);
  } finally { await home.close(); }
});

// —— 其余房间操作：请求形状 ——

test('房间操作：createRoom / join / messages / typing / setRoomState 的请求形状正确', async () => {
  const home = await startHomeserver();
  try {
    const client = makeClient(home);
    const created = await client.createRoom({ name: 'proj', topic: 't', invite: ['@owner:test'] });
    assert.equal(created.room_id, '!new:test');
    const create = home.requests.find((r) => r.path.endsWith('/createRoom'));
    assert.ok(create);

    await client.joinRoom('!a:test');
    assert.ok(home.requests.some((r) => r.method === 'POST' && r.path.includes('/join/')));

    const page = await client.messages('!a:test', { from: 'p-1', dir: 'b', limit: 10 });
    assert.equal(page.chunk.length, 1);

    await client.typing('!a:test', true, 30_000);
    assert.ok(home.requests.some((r) => r.method === 'PUT' && r.path.includes('/typing/')));

    await client.setRoomState('!a:test', 'com.hwb.instance', { homeId: 'h1' });
    assert.deepEqual(home.state.roomState.get('!a:test|com.hwb.instance|'), { homeId: 'h1' });
    assert.deepEqual(await client.roomState('!a:test', 'com.hwb.instance'), { homeId: 'h1' });
  } finally { await home.close(); }
});

// —— 长轮询循环 ——

test('syncLoop：外部 abort 后干净退出（不抛错、不空转、只发一次 sync）', async () => {
  const home = await startHomeserver();
  home.state.syncDelayMs = 300;
  try {
    const client = makeClient(home);
    const controller = new AbortController();
    const started = Date.now();
    const loop = client.syncLoop({ signal: controller.signal, timeout: 5_000, onError: () => {} });
    setTimeout(() => controller.abort(), 30);
    await loop;
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 280, `abort 后应立刻退出，实际 ${elapsed}ms`);
    assert.equal(home.requests.filter((r) => r.path.endsWith('/sync')).length, 1);
  } finally { await home.close(); }
});

// —— 状态文件 ——

test('createFileStore：0600 权限、原子写（无 .tmp 残留）、损坏文件显式报错', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwb-matrix-store-'));
  const file = path.join(dir, 'nested', 'state.json');
  try {
    const store = createFileStore(file);
    const state = emptyState();
    state.since = 's-1';
    store.save(state);

    assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'bot 的同步游标/队列必须仅 owner 可读');
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['state.json'], '不能留下 .tmp 文件');
    assert.equal(store.load().since, 's-1');

    fs.writeFileSync(file, 'not json', { mode: 0o600 });
    assert.throws(() => store.load(), StateCorruptError, '损坏状态必须显式失败，不能静默重置 since');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('backoffMs：指数增长、封顶、抖动只在 [80%,100%] 区间（不制造重连风暴）', () => {
  const one = () => 1;
  assert.equal(backoffMs(0, { base: 1_000, random: one }), 800);
  assert.equal(backoffMs(1, { base: 1_000, random: one }), 1_600);
  assert.equal(backoffMs(10, { base: 1_000, cap: 60_000, random: one }), 48_000);
  for (let i = 0; i < 20; i += 1) {
    const value = backoffMs(3, { base: 1_000, cap: 60_000 });
    assert.ok(value >= 6_400 && value <= 8_000, `第 3 次退避应在 6400–8000，实际 ${value}`);
  }
});
