// —— 最小 Matrix client（bot 场景，零 npm 依赖）——
//
// 为什么不用 matrix-js-sdk：
//   · hwb 的既定约束是 **零 npm 依赖**（package.json 里没有 dependencies），而 matrix-js-sdk
//     会把 crypto/IndexedDB 等一整套浏览器运行时带进来；
//   · hwb 只需要一个 bot 的 Client-Server API 子集（同步、发消息、编辑、反应、状态），
//     这些端点是**纯 HTTPS + JSON + Bearer token**，`fetch` 就够了；
//   · 同一份代码要在两个地方跑：P1 在 hwb 进程内、P2 原样复制成远端单文件 sidecar。
//     所以本模块**不 import 任何 hwb 模块**，只用 node: 内建。
//
// 明确边界（见 docs/im-channel-design.md §13）：
//   · **不支持 E2EE**（Olm/Megolm 需要设备密钥、to-device、cross-signing、key backup）。
//     因此本模块**拒绝加密房间**：遇到 `m.room.encryption` 状态或 `m.room.encrypted` 事件时
//     抛 EncryptedRoomError 而不是静默继续——否则会「看起来发成功了，对方永远看不到」。
//   · 不做媒体上传、多设备、密钥备份、推送规则；大产物只回引用（com.hwb.artifact）。
//
// 可靠性的三条主线：
//   1. `/sync` 的 `since` 是**不透明游标**，只在调用方确认处理完一批事件后才 commit；
//      处理中崩溃 → 下一轮重放同一批 → 由 event_id 去重挡住重复执行。
//   2. 出站消息**先落盘再发**，同一 txnId 重试返回原 event_id ⇒ 「HTTP 超时 ≠ 失败」。
//   3. 429 只看 `retry_after_ms`；401/M_UNKNOWN_TOKEN 是**致命**的（停止自动重试并告警）。

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const CLIENT_API = '/_matrix/client/v3';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_SYNC_TIMEOUT_MS = 30_000;
// 长轮询的服务端 hold 时间之外再留一点余量；否则客户端会在服务端正常返回前先超时。
const SYNC_GRACE_MS = 15_000;
const MAX_DEDUPE = 512;
const MAX_OUTBOX = 200;
const MAX_RATE_LIMIT_WAITS = 5;

// 只订阅 hwb 真正需要的类型：把 presence/typing/成员变更的噪音挡在服务端。
// （成员事件仍保留：加入/离开房间是权限变化，不能漏。）
export const DEFAULT_ROOM_TYPES = [
  'm.room.message',
  'm.reaction',
  'm.room.member',
  'm.room.encryption',
  'm.room.encrypted',
  'com.hwb.instance',
  'com.hwb.heartbeat',
  'com.hwb.session',
  'com.hwb.turn',
  'com.hwb.approval',
  'com.hwb.presentation',
  'com.hwb.artifact',
];

export function defaultFilter(types = DEFAULT_ROOM_TYPES) {
  return {
    room: {
      timeline: { limit: 20, types: [...types] },
      state: { lazy_load_members: false },
    },
  };
}

export function emptyState() {
  return { since: null, rooms: {}, dedupe: [], outbox: [] };
}

// —— 错误分类 ——
// 调用方（syncLoop / flushOutbox）只依赖这几个语义，不解析 HTTP 细节。
export class MatrixError extends Error {
  constructor(message, { status = 0, errcode = null, retryAfterMs = null, fatal = false } = {}) {
    super(message);
    this.name = 'MatrixError';
    this.status = status;
    this.errcode = errcode;
    this.retryAfterMs = Number.isFinite(retryAfterMs) ? retryAfterMs : null;
    this.fatal = Boolean(fatal);
  }
  get rateLimited() {
    return this.status === 429 || this.errcode === 'M_LIMIT_EXCEEDED';
  }
  get tokenInvalid() {
    return this.status === 401 || this.errcode === 'M_UNKNOWN_TOKEN';
  }
}

// 状态文件损坏必须显式失败：静默重置 `since` 会让「已处理事件」被重新投递，
// 而 outbox 丢失会让「已发消息」被认为没发。宁可让运维看到错误。
export class StateCorruptError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'StateCorruptError';
    this.cause = cause;
  }
}

// 加密房间：本模块不支持 E2EE。继续跑只会产生「发出去但没人看得见」的消息。
export class EncryptedRoomError extends Error {
  constructor(roomId, where) {
    super(`房间 ${roomId} 启用了加密（命中 ${where}）；本最小客户端不支持 E2EE，请改用明文私有房间`);
    this.name = 'EncryptedRoomError';
    this.roomId = roomId;
    this.where = where;
  }
}

// 非白名单邀请：不自动 join，避免任何人把 bot 拉进房间就等于拿到 shell。
export class InviteRefusedError extends Error {
  constructor(roomId, reason) {
    super(`拒绝加入房间 ${roomId}：${reason}`);
    this.name = 'InviteRefusedError';
    this.roomId = roomId;
    this.reason = reason;
  }
}

// —— 状态持久化 ——

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function normalizeState(raw) {
  if (!raw || typeof raw !== 'object') throw new StateCorruptError('状态不是对象');
  const state = { ...emptyState(), ...raw };
  if (state.since !== null && typeof state.since !== 'string') {
    throw new StateCorruptError('since 不是字符串');
  }
  if (!state.rooms || typeof state.rooms !== 'object' || Array.isArray(state.rooms)) {
    throw new StateCorruptError('rooms 不是对象');
  }
  if (!Array.isArray(state.dedupe)) throw new StateCorruptError('dedupe 不是数组');
  if (!Array.isArray(state.outbox)) throw new StateCorruptError('outbox 不是数组');
  state.dedupe = state.dedupe.filter((x) => typeof x === 'string').slice(-MAX_DEDUPE);
  state.outbox = state.outbox.filter((x) => x && typeof x.txnId === 'string' && typeof x.roomId === 'string');
  return state;
}

// 原子写：tmp + rename + 0600。不 fsync 是刻意的——outbox 的幂等性由 txnId 保证，
// 最坏情况是「已发但未落盘」→ 重启用同一 txnId 重发 → 服务端返回原 event_id，不会重复。
export function createFileStore(filePath) {
  if (!filePath) throw new TypeError('createFileStore 需要文件路径');
  return {
    filePath,
    load() {
      let text;
      try {
        text = fs.readFileSync(filePath, 'utf8');
      } catch (error) {
        if (error?.code === 'ENOENT') return emptyState();
        throw new StateCorruptError(`读取状态文件失败：${filePath}`, error);
      }
      try {
        return normalizeState(JSON.parse(text));
      } catch (error) {
        if (error instanceof StateCorruptError) throw error;
        throw new StateCorruptError(`状态文件不是合法 JSON：${filePath}`, error);
      }
    },
    save(state) {
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(normalizeState(state)), { mode: 0o600 });
      fs.renameSync(tmp, filePath);
    },
  };
}

export function createMemoryStore(initial = emptyState()) {
  let state = normalizeState(clone(initial));
  return {
    load: () => clone(state),
    save: (next) => { state = normalizeState(clone(next)); },
    peek: () => clone(state),
  };
}

// —— 退避（纯函数，便于测试） ——

export function backoffMs(attempt, { base = 1_000, cap = 60_000, jitter = 0.2, random = Math.random } = {}) {
  const raw = Math.min(cap, base * 2 ** Math.max(0, attempt));
  const delta = raw * jitter;
  // 抖动只向下取整到 [raw-delta, raw]：避免多实例同时重连形成同步风暴。
  return Math.max(0, Math.round(raw - delta * random()));
}

async function sleepAbortable(ms, signal, sleepImpl = (wait) => new Promise((resolve) => setTimeout(resolve, wait))) {
  if (signal?.aborted) throw new MatrixError('aborted', { fatal: true });
  if (ms <= 0) return;
  if (!signal) { await sleepImpl(ms); return; }
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(new MatrixError('aborted', { fatal: true }));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    await Promise.race([sleepImpl(ms), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function nextTxnId(now) {
  return `hwb-${now()}-${randomUUID()}`;
}

// —— 客户端 ——

export function createMatrixClient({
  baseUrl,
  token,
  userId = null,
  filter = defaultFilter(),
  store = createMemoryStore(),
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  syncTimeoutMs = DEFAULT_SYNC_TIMEOUT_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  log = () => {},
} = {}) {
  if (!baseUrl) throw new TypeError('createMatrixClient 需要 baseUrl');
  if (!token) throw new TypeError('createMatrixClient 需要 token');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl 不可用（Node ≥ 18 应内建 fetch）');

  const root = new URL(baseUrl);
  root.pathname = root.pathname.replace(/\/+$/, '') + '/';
  let state = store.load();
  let selfId = userId ?? null;

  function urlOf(apiPath) {
    // 相对路径拼接：保留 baseUrl 里可能存在的子路径（例如 https://example.org/matrix/）。
    return new URL(`${CLIENT_API}${apiPath}`.replace(/^\/+/, ''), root);
  }

  function save() {
    store.save(state);
  }

  async function request(method, apiPath, { body, timeout = timeoutMs, signal } = {}) {
    const timeoutSignal = AbortSignal.timeout(Math.max(1, timeout));
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const headers = { authorization: `Bearer ${token}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res;
    try {
      res = await fetchImpl(urlOf(apiPath), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: combined,
      });
    } catch (error) {
      // 网络错误/超时：保留原始 name 便于区分「被 abort」与「连不上」。
      const err = new MatrixError(`${method} ${apiPath} 失败：${error?.name ?? 'network'}`, { status: 0 });
      err.cause = error;
      err.aborted = error?.name === 'AbortError' || error?.name === 'TimeoutError';
      throw err;
    }
    const text = await res.text().catch(() => '');
    let json = null;
    if (text) {
      try { json = JSON.parse(text); } catch { /* 非 JSON 响应按无 body 处理 */ }
    }
    if (!res.ok) {
      const retryAfterMs = Number.isFinite(json?.retry_after_ms) ? json.retry_after_ms : null;
      throw new MatrixError(
        `matrix ${res.status} ${json?.errcode ?? ''} ${method} ${apiPath}`.trim(),
        {
          status: res.status,
          errcode: json?.errcode ?? null,
          retryAfterMs,
          fatal: res.status === 401 || json?.errcode === 'M_UNKNOWN_TOKEN',
        },
      );
    }
    return json ?? {};
  }

  // —— 账号 ——

  async function whoami() {
    const result = await request('GET', '/account/whoami');
    if (!result?.user_id) throw new MatrixError('whoami 没有返回 user_id', { fatal: true });
    selfId = result.user_id;
    if (userId && result.user_id !== userId) {
      throw new MatrixError(`token 属于 ${result.user_id}，与配置的 ${userId} 不一致`, { fatal: true });
    }
    return result.user_id;
  }

  const versions = () => request('GET', '/_matrix/client/versions');

  // —— 同步 ——

  function assertUnencrypted(roomId, stateEvents, timelineEvents) {
    for (const event of stateEvents) {
      if (event?.type === 'm.room.encryption') throw new EncryptedRoomError(roomId, 'm.room.encryption 状态事件');
    }
    for (const event of timelineEvents) {
      if (event?.type === 'm.room.encrypted') throw new EncryptedRoomError(roomId, 'm.room.encrypted 消息事件');
    }
  }

  function normalizeBatch(json) {
    const rooms = [];
    const join = json?.rooms?.join ?? {};
    for (const [roomId, room] of Object.entries(join)) {
      const timelineEvents = room?.timeline?.events ?? [];
      const stateEvents = room?.state?.events ?? [];
      assertUnencrypted(roomId, stateEvents, timelineEvents);
      rooms.push({
        roomId,
        events: timelineEvents,
        stateEvents,
        limited: room?.timeline?.limited === true,
        prevBatch: room?.timeline?.prev_batch ?? null,
      });
    }
    const invites = Object.entries(json?.rooms?.invite ?? {}).map(([roomId, invite]) => {
      const events = invite?.invite_state?.events ?? [];
      const member = events.find(
        (e) => e?.type === 'm.room.member' && e?.content?.membership === 'invite',
      );
      return { roomId, inviter: member?.sender ?? member?.state_key ?? null, events };
    });
    return { rooms, invites, left: Object.keys(json?.rooms?.leave ?? {}) };
  }

  // 只读同步：**不推进 since**。调用方处理完这批事件后必须显式 commit()，
  // 否则崩溃会丢事件（而不是重放）。这是本模块最重要的可靠性约定。
  async function syncOnce({ timeout = syncTimeoutMs, signal, fullState = false } = {}) {
    const params = new URLSearchParams({ timeout: String(timeout) });
    if (state.since) params.set('since', state.since);
    if (fullState) params.set('full_state', 'true');
    params.set('filter', JSON.stringify(filter));
    const json = await request('GET', `/sync?${params.toString()}`, {
      timeout: timeout + SYNC_GRACE_MS,
      signal,
    });
    const nextBatch = json?.next_batch;
    if (typeof nextBatch !== 'string' || !nextBatch) {
      throw new MatrixError('sync 响应缺少 next_batch', { fatal: true });
    }
    return { nextBatch, ...normalizeBatch(json) };
  }

  function commit(batch) {
    if (!batch?.nextBatch) throw new TypeError('commit 需要带 nextBatch 的 batch');
    state.since = batch.nextBatch;
    save();
  }

  // —— 事件去重 ——

  function isSeen(eventId) {
    return typeof eventId === 'string' && state.dedupe.includes(eventId);
  }

  function markSeen(eventId) {
    if (typeof eventId !== 'string' || !eventId) return;
    if (state.dedupe.includes(eventId)) return;
    state.dedupe.push(eventId);
    if (state.dedupe.length > MAX_DEDUPE) state.dedupe = state.dedupe.slice(-MAX_DEDUPE);
    save();
  }

  // —— 出站 ——

  async function send(roomId, type, content, { txnId = nextTxnId(now), signal } = {}) {
    const body = { ...content };
    delete body.__txnId;
    const result = await request(
      'PUT',
      `/rooms/${encodeURIComponent(roomId)}/send/${encodeURIComponent(type)}/${encodeURIComponent(txnId)}`,
      { body, signal },
    );
    if (!result?.event_id) throw new MatrixError('send 没有返回 event_id', { fatal: true });
    return result.event_id;
  }

  // 先落盘再发：调用方不需要关心重试，flushOutbox 用同一个 txnId 重发即可。
  function enqueue(roomId, type, content, { txnId = nextTxnId(now) } = {}) {
    if (state.outbox.length >= MAX_OUTBOX) {
      throw new MatrixError(`outbox 已满（${MAX_OUTBOX}），拒绝继续入队`, { fatal: true });
    }
    state.outbox.push({ txnId, roomId, type, content: { ...content }, at: now() });
    save();
    return txnId;
  }

  async function flushOutbox({ signal, limit = 50 } = {}) {
    let sent = 0;
    let waits = 0;
    while (!signal?.aborted && sent < limit) {
      const item = state.outbox[0];
      if (!item) break;
      try {
        await send(item.roomId, item.type, item.content, { txnId: item.txnId, signal });
      } catch (error) {
        if (error?.aborted) break;
        if (error instanceof MatrixError && error.rateLimited && waits < MAX_RATE_LIMIT_WAITS) {
          waits += 1;
          const wait = error.retryAfterMs ?? backoffMs(waits - 1);
          log('warn', 'matrix 限流，退避后重试同一 txnId', { wait, roomId: item.roomId });
          try {
            await sleepAbortable(wait, signal, sleep);
          } catch {
            break;
          }
          continue;
        }
        throw error;
      }
      state.outbox = state.outbox.filter((x) => x.txnId !== item.txnId);
      save();
      sent += 1;
    }
    return { sent, remaining: state.outbox.length };
  }

  // 便捷方法：正文走纯文本，编辑走 m.replace，审批/ack 走 m.reaction。
  function sendText(roomId, text, options) {
    return enqueue(roomId, 'm.room.message', { msgtype: 'm.text', body: text }, options);
  }

  function editText(roomId, eventId, text, options) {
    return enqueue(roomId, 'm.room.message', {
      msgtype: 'm.text',
      body: `* ${text}`,
      'm.new_content': { msgtype: 'm.text', body: text },
      'm.relates_to': { rel_type: 'm.replace', event_id: eventId },
    }, options);
  }

  function react(roomId, eventId, key, options) {
    return enqueue(roomId, 'm.reaction', {
      'm.relates_to': { rel_type: 'm.annotation', event_id: eventId, key },
    }, options);
  }

  // —— 房间 ——

  const joinRoom = (roomIdOrAlias) => request('POST', `/join/${encodeURIComponent(roomIdOrAlias)}`, { body: {} });
  const joinedRooms = async () => (await request('GET', '/joined_rooms')).joined_rooms ?? [];

  const createRoom = (options = {}) => request('POST', '/createRoom', {
    body: {
      name: options.name,
      topic: options.topic,
      invite: options.invite ?? [],
      is_direct: options.isDirect === true,
      preset: options.preset ?? 'private_chat',
    },
  });

  async function roomState(roomId, type, stateKey = '') {
    try {
      return await request(
        'GET',
        `/rooms/${encodeURIComponent(roomId)}/state/${encodeURIComponent(type)}/${encodeURIComponent(stateKey)}`,
      );
    } catch (error) {
      if (error instanceof MatrixError && error.status === 404) return null;
      throw error;
    }
  }

  const setRoomState = (roomId, type, content, stateKey = '') => request(
    'PUT',
    `/rooms/${encodeURIComponent(roomId)}/state/${encodeURIComponent(type)}/${encodeURIComponent(stateKey)}`,
    { body: content },
  );

  // 加密房间的最后一道闸：join/首次进房时显式检查，避免「发出去但没人看得见」。
  async function assertRoomUnencrypted(roomId) {
    const encryption = await roomState(roomId, 'm.room.encryption');
    if (encryption) throw new EncryptedRoomError(roomId, 'm.room.encryption 状态事件');
    return true;
  }

  const messages = (roomId, { from, dir = 'b', limit = 50 } = {}) => request(
    'GET',
    `/rooms/${encodeURIComponent(roomId)}/messages?${new URLSearchParams({ from: from ?? state.since ?? '', dir, limit: String(limit) })}`,
  );

  const typing = (roomId, isTyping = true, timeout = 30_000) => request(
    'PUT',
    `/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(selfId ?? '@me')}`,
    { body: { typing: Boolean(isTyping), timeout } },
  );

  // —— 邀请白名单 ——
  // 只 join「房间在白名单」或「邀请人在白名单」的邀请；其余静默拒绝并返回结果供审计。
  async function handleInvites(invites, { allowlist = { rooms: [], users: [] } } = {}) {
    const results = [];
    for (const invite of invites ?? []) {
      const roomAllowed = (allowlist.rooms ?? []).includes(invite.roomId);
      const inviterAllowed = Boolean(invite.inviter) && (allowlist.users ?? []).includes(invite.inviter);
      if (!roomAllowed && !inviterAllowed) {
        results.push({ roomId: invite.roomId, action: 'refused', reason: 'not-allowlisted' });
        log('warn', '拒绝非白名单邀请', { roomId: invite.roomId, inviter: invite.inviter });
        continue;
      }
      await joinRoom(invite.roomId);
      state.rooms[invite.roomId] = { ...(state.rooms[invite.roomId] ?? {}), joinedAt: now() };
      save();
      results.push({ roomId: invite.roomId, action: 'joined' });
    }
    return results;
  }

  // —— 长轮询循环 ——

  async function syncLoop({ onSync, onError, signal, timeout = syncTimeoutMs } = {}) {
    let attempt = 0;
    while (!signal?.aborted) {
      let batch;
      try {
        batch = await syncOnce({ timeout, signal });
        attempt = 0;
      } catch (error) {
        if (signal?.aborted) break;
        if (error?.fatal || error instanceof EncryptedRoomError) {
          onError?.(error, { fatal: true });
          throw error;
        }
        const wait = error?.retryAfterMs ?? backoffMs(attempt);
        attempt += 1;
        onError?.(error, { retryInMs: wait });
        log('warn', 'matrix sync 失败，退避', { wait, error: error?.message });
        try {
          await sleepAbortable(wait, signal, sleep);
        } catch {
          break;
        }
        continue;
      }
      try {
        if (onSync) await onSync(batch);
        commit(batch);
      } catch (error) {
        // 处理失败：**不 commit**，下一轮会重放同一批；去重由调用方用 isSeen/markSeen 承担。
        if (signal?.aborted) break;
        onError?.(error, { retryInMs: 0 });
        log('warn', 'matrix 事件处理失败（since 未推进，将重放）', { error: error?.message });
        try {
          await sleepAbortable(backoffMs(0), signal, sleep);
        } catch {
          break;
        }
      }
    }
  }

  return {
    // 状态（只读快照，供测试/诊断）
    getState: () => clone(state),
    // 账号
    whoami,
    versions,
    // 同步
    syncOnce,
    commit,
    syncLoop,
    // 去重
    isSeen,
    markSeen,
    // 出站
    send,
    enqueue,
    flushOutbox,
    sendText,
    editText,
    react,
    // 房间
    joinRoom,
    joinedRooms,
    createRoom,
    roomState,
    setRoomState,
    assertRoomUnencrypted,
    messages,
    typing,
    handleInvites,
  };
}

// 便于运维脚本直接判断邀请是否可入（与 handleInvites 同一判定，纯函数）。
export function decideInvite(invite, allowlist = { rooms: [], users: [] }) {
  const roomAllowed = (allowlist.rooms ?? []).includes(invite?.roomId);
  const inviterAllowed = Boolean(invite?.inviter) && (allowlist.users ?? []).includes(invite.inviter);
  return roomAllowed || inviterAllowed
    ? { join: true, reason: 'allowlisted' }
    : { join: false, reason: 'not-allowlisted' };
}
