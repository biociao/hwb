import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';

import { logger } from '../lib/logger.js';
import { stripNul } from '../lib/normalize.js';
import { msToIso } from '../lib/time.js';
import { normalizeIntervention, mergeIntervention, strongestIntervention } from '../lib/intervention.js';
// token→cookie 交接、RPC 信封、keep-alive agent 都复用实时状态那条通道的实现：
// 同一个 dsh 实例、同一套鉴权语义，没必要再写第二份（也就不会有两套 token 处理差异）。
import { splitAuthUrl, acquireCookie, rpc } from './live-status.js';

const log = logger('intervention');

// 合并规则本身就是本模块对外契约的一部分（server.js 的集成方与测试都可能直接拿它做断言），
// 从 lib/intervention.js 原样转发，避免出现「第二份合并实现」。
export { mergeIntervention };

// 实时人工介入观察器：从 dsh 的 remote-events 逻辑流上「看」到正在等用户决定的事情。
//
// 为什么需要一条 WebSocket：审批（approval/request）与提问（user-questions/request）在 dsh 里
// 是 **waterfall 事件**，不是投影 —— 它们不落 projcache，也不出现在 `/api/session/list` 里。
// 一个正在等 Approve 的会话在轮询视角下就是「空闲」，人一走开任务就永远卡住。
// 唯一能及时发现它们的通道是 dsh web 自己用的那条：`/api/remote.mux` WebSocket 上的
// `$events` 逻辑流（见 dsh-api-gateway 的 stream-protocol / client.node.js 的 pumpEvents）。
//
// —— 本模块的边界（三条，缺一条都会从「附加信息」变成故障源）——
//
//   1. **只观察，绝不替人做决定**。每个 waterfall 帧都立刻用 outcome `{kind:'next'}` 应答回 Host
//      —— 这在 dsh 的 waterfall 语义里等于「我不处理，交给下一个监听器」（浏览器 UI 就是那个
//      最终应答者）。我们既不解帧里的 signal，也不缓存应答权；观察器崩了只是少一个标记，
//      不会把用户的审批流程带到沟里。
//   2. **任何失败都只降级**。连不上 / 握不上手 / 帧畸形 / 应答失败 / 广播抛错 —— 全部吞掉，
//      只记 warn（同一 home 同一原因只记一次，长连接反复重连时不刷屏），绝不抛穿调用方。
//      日志里**不得出现 URL / token / cookie**（它们等于那个 dsh 实例的完整控制权）。
//   3. **断流即清空**。Host 会在重连后重放仍挂起的 waterfall（dsh 的 pending 事件语义），
//      所以断流时立刻清掉该 home 的覆盖层、重连成功后按重放帧重建 —— 否则界面上会挂着
//      「幽灵等待审批」（人已经批过了，标记还在）。
//   4. **必须自己发现「已结算」**。dsh 的 `cancel` 帧只在 **Host 侧**中止/撤销请求时下发；
//      我们的观察器已经用 `next` 把请求委托出去了，之后请求被浏览器（或自动审阅）答掉时
//      **Host 不会再通知本连接**。也就是说 pending 集合没有内建的结算信号：
//      · 快路径：`api-session/status(sessionId, running=false)` / `api-session/removed(sessionId)`
//        emit 帧 → 该会话的 pending 全部作废（覆盖「turn 已结束」这个最常见情形）；
//      · 对账：`running` 可能一直是 true（浏览器批准后 turn 继续跑），所以还要周期性另开一条
//        **短寿命 probe 流**。Host 会把**当前仍挂起**的 waterfall 全量重放到每条新流上，且
//        eventId 保持不变 —— 「重放集合」就等于「仍挂起集合」。probe 期间没重放到的旧 eventId
//        视为已结算并清掉。probe 自己收到 waterfall 时立刻用自己的 clientId 回 `next`
//        （绝不挡在真实 UI 前面），也绝不往 overlay 里写数据（主连接是唯一数据源）。
//
// 帧形状（实测 dsh 0.2.0-rc.2，见 tests/pending-interactions-ws.test.js 的真 socket 用例）：
//   ready    {type:'ready', clientId, host:{home}}
//   waterfall{type:'waterfall', event:'approval/request'|'user-questions/request',
//             eventId, agentId, request:{…}}
//   cancel   {type:'cancel', eventId}
//   emit     {type:'emit', event, args}      ← 通知帧，无需应答，本模块只忽略
//
// 覆盖层形状：homeId → sessionId → intervention（intervention 的定义与合并优先级见 lib/intervention.js）。
// API 层（routes.js 的 withInterventions）在返回会话行时调 apply(sessions) 合入；
// 变化时这里自己 broadcast('intervention:updated', {homeId})，前端据此重画。

// 逻辑流相关的固定常量（与 dsh-api-gateway 的 stream-protocol.ts 一一对应）。
const MUX_PATH = '/api/remote.mux';
const EVENTS_ENDPOINT = '$events';
const EVENTS_RESULT_ENDPOINT = '$events/result';
const EVENTS_OPEN_PAYLOAD = { args: {} };
// RFC6455 要求的握手 GUID（Sec-WebSocket-Accept = base64(sha1(key + GUID))）。
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
// 单条逻辑帧的字节上限。ready / waterfall 都是几百字节的小对象；给 1 MiB 是给「插件往
// displayReason 里塞计划全文」这种合法用法留余量，同时挡住「对面推一条 200 MiB 帧」把内存打满
// （与 live-status 的 MAX_RPC_BYTES 同一思路：这条通道的对面可以是外来 dsh）。
const WS_MAX_MESSAGE_BYTES = 1024 * 1024;

const DEFAULT_RECONNECT_BASE_MS = 1000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;
const DEFAULT_STALE_MS = 30 * 60_000;
// 单连接预算（token→cookie 交接 + WS 握手 + 等 ready + 每次应答 RPC 共用）。
// 5s 对本地实例绰绰有余，但这条通道同样服务**远程隧道**实例（90–140ms RTT、10–50% 丢包，
// 与 live-status 注释里记录的 dgx21/c4g 实测同一类链路）：一次握手 + ready 往返抖动到 5s
// 以上并不罕见，而超时的代价是「白白断流重连一轮」并且漏掉这段窗口里的审批。
// 放宽到 10s 是安全的：失败仍然会按退避重连，最坏只是发现「真挂了」晚几秒；
// 反过来，把慢但健康的链路误判成挂了会让界面上的审批时有时无。
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
// 对账节奏与 probe 窗口（见文件头「必须自己发现已结算」）。只在 overlay 非空时才起 probe，
// 空闲时零成本；窗口只需盖住 Host 在 open 后立刻重放挂起项的那一小段。
const DEFAULT_RECONCILE_INTERVAL_MS = 5000;
const DEFAULT_PROBE_WINDOW_MS = 1200;
// 广播去抖：一次断流会同时影响该 home 的多个会话，逐条广播没有意义。
const NOTIFY_DEBOUNCE_MS = 50;
// 每个 home 最多记住多少条「已发出但未 cancel」的 waterfall。正常场景是个位数；
// 上限只是防止对面永不发 cancel 时 Map 无限增长（内存安全，不是功能）。
const MAX_PENDING_EVENTS = 1024;
// 应答 RPC 的响应上限：Host 只会回 `{ok:true}` 之类的小结构，不需要 32 MiB。
const ANSWER_MAX_BYTES = 256 * 1024;

// —— 小工具（全部防御式：这些函数的入参是**不可信的外部数据**） ——

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function positiveNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegativeNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

// 错误/断流原因只保留**短标识符**——它会被写进日志，而原始错误消息里常有
// `http://127.0.0.1:PORT/?token=…`（transfer 层抛错时很典型）。宁可少一条诊断信息，
// 也不能把实例凭据写进 ~/.hwb/hwb.log 与 SSE 日志环。
function safeReason(reason) {
  if (typeof reason !== 'string') return 'unknown';
  return /^[A-Za-z0-9][A-Za-z0-9 _.:-]{0,63}$/.test(reason) ? reason : 'unknown';
}

function errorCode(error) {
  const raw = error?.code ?? error?.name;
  return typeof raw === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(raw) ? raw : 'error';
}

// 第一个「非空字符串」参数（用于 displayReason 的 locale 映射）。
function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return null;
}

/**
 * 审批请求里「给人看的原因」。
 *
 * 实测形状（dsh 0.2.0-rc.2）：`displayReason` 是 **locale 映射对象**而不是字符串
 *   `{en: 'Allow this operation with …', zh: '允许本次操作使用 …'}`
 * 早期/其它路径上它是字符串，也可能干脆没有。优先级：
 *   字符串 displayReason → displayReason.zh → displayReason.en → displayReason 里任一非空字符串值
 *   → request.reason（tool 侧原始的、通常更技术化的原因）。
 * 纯函数（不读时钟、不碰网络），便于单测覆盖五种形态。
 *
 * @param {unknown} request waterfall 帧的 request
 * @returns {string|null}
 */
function approvalReasonOf(request) {
  if (!isRecord(request)) return null;
  const display = request.displayReason;
  if (typeof display === 'string') return firstText(display) ?? firstText(request.reason);
  if (isRecord(display)) {
    const localized = firstText(display.zh, display.en);
    if (localized) return localized;
    // 未知语种（或字段名换了）：取第一个非空字符串值。Object.values 顺序即插入顺序，
    // 不保证语义，但比「完全放弃 displayReason 退回技术性 reason」更贴近使用者看到的内容。
    for (const value of Object.values(display)) {
      const text = firstText(value);
      if (text) return text;
    }
  }
  return firstText(request.reason);
}

// 时间入参（now() 的返回值）→ ISO。now() 可注入（测试），所以它可能给出非法值；
// 超出 ECMAScript 日期范围的数字 `toISOString()` 会抛 RangeError，统一降级 null。
function isoOf(at) {
  if (typeof at === 'number') return msToIso(at);
  if (at instanceof Date) return msToIso(at.getTime());
  if (typeof at === 'string') return at;
  return null;
}

/**
 * 归一 dsh `$events` 逻辑流里一个 item 的 value。
 *
 * 这是**外部输入的唯一收口**：任何字段缺失/类型不对/形状陌生都返回 null，调用方据此
 * 「忽略这一帧」（畸形帧绝不能炸掉整条连接）。agentId 即 sessionId（实测 `session-<uuid>`），
 * 按 node:sqlite 的 TEXT 语义剥掉 NUL —— 带 NUL 的 key 会在绑定时被静默截断，两张表就对不上了。
 *
 * @param {unknown} value
 * @returns {{type:'ready',clientId:string,host:{home:string}}
 *   | {type:'waterfall',event:string,eventId:string,sessionId:string,request:object}
 *   | {type:'cancel',eventId:string}
 *   | {type:'emit',event:string,args:unknown[]}
 *   | null}
 */
export function normalizeRemoteEventFrame(value) {
  try {
    if (!isRecord(value)) return null;
    switch (value.type) {
      case 'ready': {
        if (!isNonEmptyString(value.clientId)) return null;
        if (!isRecord(value.host) || typeof value.host.home !== 'string') return null;
        return { type: 'ready', clientId: value.clientId, host: { home: stripNul(value.host.home) } };
      }
      case 'cancel': {
        if (!isNonEmptyString(value.eventId)) return null;
        return { type: 'cancel', eventId: value.eventId };
      }
      case 'emit': {
        if (!isNonEmptyString(value.event) || !Array.isArray(value.args)) return null;
        return { type: 'emit', event: value.event, args: value.args };
      }
      case 'waterfall': {
        if (!isNonEmptyString(value.event) || !isNonEmptyString(value.eventId)) return null;
        if (typeof value.agentId !== 'string') return null;
        const sessionId = stripNul(value.agentId).trim();
        if (!sessionId) return null;
        // request 是投影出来的 JSON 对象（Host 已剥掉 agent / signal）。这里不校验具体
        // 业务字段 —— 陌生事件名也要能应答（委托 next），所以只要求它是对象。
        if (!isRecord(value.request)) return null;
        return {
          type: 'waterfall',
          event: value.event,
          eventId: value.eventId,
          sessionId,
          request: value.request,
        };
      }
      default:
        return null;
    }
  } catch {
    // 极端值（被 Proxy 包裹、getter 抛错…）：当作不认识这一帧。
    return null;
  }
}

/**
 * waterfall 帧 → intervention（不认识的事件 / 与人工介入无关的事件 → null）。
 *
 * 归类规则（与 lib/intervention.js 的三种 kind 对齐）：
 *   · `approval/request`                          → approval
 *   · `user-questions/request` 单个 plan-review 问题 → plan-review
 *     条件：只有 1 个 question，且 `intent.kind === 'plan-review'`，且带非空 `detail`
 *     （detail 就是被审的计划 markdown —— dsh 的 ask() 在 intent 存在时强制要求它）
 *   · 其它 `user-questions/request`                → question
 *
 * 一律经 normalizeIntervention 归一：kind 白名单、label 由本地文案派生（不信任上游文案）、
 * source 固定 live、文本截断（tool ≤ 64、reason ≤ 160）、count ≥ 1。
 *
 * @param {{type:string,event?:string,request?:object}|null|undefined} frame normalizeRemoteEventFrame 的输出
 * @param {number|string|Date} [at] 观察时刻（默认 null → since 为 null）
 * @returns {ReturnType<typeof normalizeIntervention>}
 */
export function interventionOfFrame(frame, at) {
  if (!isRecord(frame) || frame.type !== 'waterfall') return null;
  const request = isRecord(frame.request) ? frame.request : {};
  const since = isoOf(at);
  if (frame.event === 'approval/request') {
    return normalizeIntervention({
      kind: 'approval',
      source: 'live',
      since,
      tool: typeof request.toolName === 'string' ? request.toolName : null,
      reason: approvalReasonOf(request),
      count: 1,
    });
  }
  if (frame.event === 'user-questions/request') {
    const questions = Array.isArray(request.questions)
      ? request.questions.filter((question) => isRecord(question))
      : [];
    const first = questions.length ? questions[0] : null;
    const intent = isRecord(first?.intent) ? first.intent : null;
    const detail = typeof first?.detail === 'string' ? first.detail.trim() : '';
    const isPlanReview = questions.length === 1 && intent?.kind === 'plan-review' && detail !== '';
    return normalizeIntervention({
      kind: isPlanReview ? 'plan-review' : 'question',
      source: 'live',
      since,
      reason: typeof first?.question === 'string' ? first.question : null,
      count: questions.length,
    });
  }
  return null;
}

// —— 最小 RFC6455 实现（客户端侧） ——
//
// 为什么不用全局 WebSocket：dsh 的鉴权是 **Cookie**，而浏览器/undici 的 WebSocket 构造函数
// 不允许自定义请求头（带不了 `Cookie`）。所以这里用 node:http 的 `upgrade` 事件自己完成
// 握手，再自己编解码帧。只实现观察器需要的子集：
//   · 发送：客户端帧必须 masked（文本 / pong / close）；
//   · 接收：服务端帧（不 mask，但畸形时也容忍 masked）、text/binary、分片续帧、ping/pong/close。

function encodeClientFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const mask = crypto.randomBytes(4);
  const len = body.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i += 1) masked[i] = body[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

/**
 * 默认传输：一条到 dsh `/api/remote.mux` 的真实 WebSocket。
 *
 * transport 契约（测试可注入同一形状的假实现，见 tests/pending-interactions.test.js）：
 *   connect({ origin, cookie, timeoutMs, onValue, onClose }) → Promise<{ close(): void }>
 *     · onValue(value)  每个逻辑流 item 的 value（已 JSON.parse，未做协议校验）
 *     · onClose(reason) 连接/逻辑流意外结束（reason 是短代码，绝不含 URL/token）
 *     · close()         幂等、绝不抛错、**不会**再触发 onClose（调用方自己关的）
 */
export function createRemoteMuxTransport() {
  return {
    connect({ origin, cookie, timeoutMs, onValue, onClose }) {
      return new Promise((resolve, reject) => {
        let target;
        try {
          target = new URL(origin);
        } catch {
          reject(new Error('invalid origin'));
          return;
        }
        const secure = target.protocol === 'https:';
        const client = secure ? https : http;
        const port = target.port ? Number(target.port) : (secure ? 443 : 80);
        const key = crypto.randomBytes(16).toString('base64');
        const streamId = `hwb-${crypto.randomUUID()}`;
        let settled = false;
        let handshakeTimer = null;
        let req = null;
        const failHandshake = (error) => {
          if (settled) return;
          settled = true;
          if (handshakeTimer) clearTimeout(handshakeTimer);
          handshakeTimer = null;
          try { req?.destroy(); } catch { /* 已结束 */ }
          reject(error instanceof Error ? error : new Error('upgrade failed'));
        };
        try {
          req = client.request({
            host: target.hostname,
            port,
            method: 'GET',
            path: MUX_PATH,
            // agent:false —— 这条连接会升级成 WebSocket 并被长期持有，不该进 keep-alive 池。
            agent: false,
            headers: {
              Connection: 'Upgrade',
              Upgrade: 'websocket',
              'Sec-WebSocket-Version': '13',
              'Sec-WebSocket-Key': key,
              ...(cookie ? { Cookie: cookie } : {}),
            },
          });
        } catch (error) {
          failHandshake(error);
          return;
        }
        handshakeTimer = setTimeout(() => failHandshake(new Error('upgrade timeout')), Math.max(1, timeoutMs));
        handshakeTimer.unref?.();
        req.on('error', failHandshake);
        // 非 101（401/403/404…）：HTTP 层给了响应，握手失败。
        req.on('response', (res) => {
          try { res.resume(); } catch { /* 尽力而为 */ }
          const error = new Error(`upgrade rejected ${res.statusCode}`);
          // 只把状态码结构化地传出去（消息本身不会被记录）：watcher 据此判断是不是 cookie 过期。
          error.httpStatus = res.statusCode;
          failHandshake(error);
        });
        req.on('upgrade', (res, socket, head) => {
          if (settled) {
            try { socket.destroy(); } catch { /* 已结束 */ }
            return;
          }
          const expected = crypto.createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
          if (res.statusCode !== 101 || res.headers?.['sec-websocket-accept'] !== expected) {
            try { socket.destroy(); } catch { /* 已结束 */ }
            failHandshake(new Error('bad websocket accept'));
            return;
          }
          settled = true;
          if (handshakeTimer) clearTimeout(handshakeTimer);
          handshakeTimer = null;
          try { socket.setNoDelay(true); socket.setTimeout(0); } catch { /* 平台差异 */ }
          // unref：后台观察连接不该成为「hwb 进程为什么退不掉」的原因
          // （与 SSEHub 心跳 / 各定时器同样的处理）。
          try { socket.unref?.(); } catch { /* 平台差异 */ }
          req?.removeAllListeners?.('error');
          req?.removeAllListeners?.('response');
          startSession(socket, head);
        });
        req.end();

        function startSession(socket, head) {
          let buffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
          const fragments = [];
          let fragmented = false;
          let closed = false;
          let cleanup = null;

          function shutdown(reason) {
            if (closed) return;
            closed = true;
            try { cleanup?.(); } catch { /* 已清理 */ }
            try { socket.destroy(); } catch { /* 已断开 */ }
            if (typeof reason === 'string' && reason) {
              try { onClose?.(reason); } catch { /* 观察者回调不得抛穿传输层 */ }
            }
          }

          function send(opcode, payload) {
            if (closed || socket.destroyed) return;
            try {
              socket.write(encodeClientFrame(opcode, payload));
            } catch {
              shutdown('socket write failed');
            }
          }

          function handleText(text) {
            let message;
            try {
              message = JSON.parse(text);
            } catch {
              return; // 非 JSON 的逻辑流消息：忽略（协议只会发 JSON，这里只是别炸）
            }
            if (!isRecord(message) || message.streamId !== streamId) return;
            if (message.type === 'item') {
              if (Object.hasOwn(message, 'value')) {
                try { onValue?.(message.value); } catch { /* 观察者异常不得打断传输 */ }
              }
              return;
            }
            if (message.type === 'end') {
              shutdown('stream ended');
              return;
            }
            if (message.type === 'error') {
              const code = message.error?.code;
              shutdown(typeof code === 'string' && /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/.test(code)
                ? `stream error ${code}`
                : 'stream error');
            }
          }

          function drain() {
            for (;;) {
              if (closed) return;
              if (buffer.length < 2) return;
              const first = buffer[0];
              const second = buffer[1];
              const fin = (first & 0x80) !== 0;
              const opcode = first & 0x0f;
              if ((first & 0x70) !== 0) { shutdown('protocol error'); return; } // RSV 位必须是 0（无扩展协商）
              const masked = (second & 0x80) !== 0;
              let length = second & 0x7f;
              let offset = 2;
              if (length === 126) {
                if (buffer.length < 4) return;
                length = buffer.readUInt16BE(2);
                offset = 4;
              } else if (length === 127) {
                if (buffer.length < 10) return;
                const big = buffer.readBigUInt64BE(2);
                if (big > BigInt(WS_MAX_MESSAGE_BYTES)) { shutdown('frame too large'); return; }
                length = Number(big);
                offset = 10;
              }
              if (length > WS_MAX_MESSAGE_BYTES) { shutdown('frame too large'); return; }
              const maskLength = masked ? 4 : 0;
              if (buffer.length < offset + maskLength + length) return;
              const maskKey = masked ? buffer.subarray(offset, offset + 4) : null;
              offset += maskLength;
              const payload = Buffer.from(buffer.subarray(offset, offset + length));
              buffer = buffer.subarray(offset + length);
              if (maskKey) {
                // 服务端帧本不该 mask；真收到就按协议解掉（宽容实现）。
                for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i & 3];
              }
              // 控制帧（close/ping/pong）：必须 FIN、payload ≤ 125。
              if (opcode >= 0x8) {
                if (!fin || length > 125) { shutdown('protocol error'); return; }
                if (opcode === 0x8) { shutdown('closed by host'); return; }
                if (opcode === 0x9) { send(0xa, payload); continue; } // ping → pong
                continue; // pong / 未知控制帧：忽略
              }
              if (opcode === 0x0) {
                if (!fragmented) { shutdown('protocol error'); return; }
                fragments.push(payload);
                if (fragments.reduce((sum, part) => sum + part.length, 0) > WS_MAX_MESSAGE_BYTES) {
                  shutdown('frame too large');
                  return;
                }
                if (fin) {
                  fragmented = false;
                  const whole = Buffer.concat(fragments);
                  fragments.length = 0;
                  handleText(whole.toString('utf8'));
                }
                continue;
              }
              if (opcode === 0x1 || opcode === 0x2) {
                if (fragmented) { shutdown('protocol error'); return; }
                if (!fin) {
                  fragmented = true;
                  fragments.length = 0;
                  fragments.push(payload);
                  continue;
                }
                handleText(payload.toString('utf8'));
                continue;
              }
              shutdown('protocol error');
              return;
            }
          }

          const onData = (chunk) => {
            if (closed) return;
            try {
              buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
              // 上限 = 单帧上限 × 2：留一帧的余量，挡住「永不结束的续帧」把内存吃光。
              if (buffer.length > WS_MAX_MESSAGE_BYTES * 2) { shutdown('frame too large'); return; }
              drain();
            } catch {
              shutdown('decode failed');
            }
          };
          const onSocketClose = () => shutdown('socket closed');
          const onSocketError = () => shutdown('socket error');

          cleanup = () => {
            socket.removeListener('data', onData);
            socket.removeListener('close', onSocketClose);
            socket.removeListener('error', onSocketError);
          };
          socket.on('data', onData);
          socket.on('close', onSocketClose);
          socket.on('error', onSocketError);

          // 打开逻辑流：payload 形状见 stream-protocol.ts 的 RemoteEventStreamPayload。
          send(0x1, JSON.stringify({
            type: 'open',
            streamId,
            endpoint: EVENTS_ENDPOINT,
            payload: EVENTS_OPEN_PAYLOAD,
          }));

          resolve({
            close() {
              // 主动关闭：先尽力发一个 close 帧，再销毁；不触发 onClose（调用方已知）。
              if (closed) return;
              send(0x8, Buffer.from([0x03, 0xe8])); // 1000 normal closure
              shutdown('');
            },
          });
        }
      });
    },
  };
}

// —— 观察器本体 ——

/**
 * homeId → sessionId → intervention 的实时覆盖层。
 *
 * 生命周期：server.js 每 5s 调一次 sync(目标实例列表)（幂等：按 homeId 增/删/重连），
 * 连接在内部自维持（断流 → 清空覆盖层 → 指数退避重连 → Host 重放 waterfall → 重建）。
 */
export class PendingInteractionWatcher {
  /**
   * @param {object} [options]
   * @param {(event:string, data:object)=>void} [options.broadcast] 变更通知（抛错会被吞掉）
   * @param {()=>number} [options.now] 时钟（测试可注入；只用于 since 与过期判定）
   * @param {number} [options.reconnectBaseMs] 重连退避基数
   * @param {number} [options.reconnectMaxMs] 重连退避上限
   * @param {number} [options.staleMs] 覆盖层条目过期时间（Host 漏发 cancel 时的兜底）
   * @param {number} [options.connectTimeoutMs] 握手/等 ready 的超时
   * @param {number} [options.reconcileIntervalMs] 对账节奏（0 = 关闭主动对账）
   * @param {number} [options.probeWindowMs] 单次 probe 的观察窗口
   * @param {{connect:Function}|null} [options.transport] 可注入传输（默认真实 WS）
   */
  constructor({
    broadcast = () => {},
    now = () => Date.now(),
    reconnectBaseMs = DEFAULT_RECONNECT_BASE_MS,
    reconnectMaxMs = DEFAULT_RECONNECT_MAX_MS,
    staleMs = DEFAULT_STALE_MS,
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    reconcileIntervalMs = DEFAULT_RECONCILE_INTERVAL_MS,
    probeWindowMs = DEFAULT_PROBE_WINDOW_MS,
    transport = null,
  } = {}) {
    this.broadcast = typeof broadcast === 'function' ? broadcast : () => {};
    this.now = typeof now === 'function' ? now : () => Date.now();
    this.reconnectBaseMs = positiveNumber(reconnectBaseMs, DEFAULT_RECONNECT_BASE_MS);
    this.reconnectMaxMs = Math.max(
      this.reconnectBaseMs,
      positiveNumber(reconnectMaxMs, DEFAULT_RECONNECT_MAX_MS),
    );
    this.staleMs = nonNegativeNumber(staleMs, DEFAULT_STALE_MS);
    this.connectTimeoutMs = positiveNumber(connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS);
    this.reconcileIntervalMs = nonNegativeNumber(reconcileIntervalMs, DEFAULT_RECONCILE_INTERVAL_MS);
    this.probeWindowMs = positiveNumber(probeWindowMs, DEFAULT_PROBE_WINDOW_MS);
    this.reconcileTimer = null;
    this.transport = transport && typeof transport.connect === 'function'
      ? transport
      : createRemoteMuxTransport();

    // homeId → 连接状态（见 #start 里的字段说明）
    this.homes = new Map();
    // homeId → Map<sessionId, {intervention, at}>：API 层要读的就是这一层。
    this.overlays = new Map();
    this.stopped = false;
    // 「同原因只记一次」的去重集合（键含 homeId）。
    this.warned = new Set();
    this.notifyPending = new Set();
    this.notifyTimer = null;
    this.staleTimer = null;
    this.broadcastErrorLogged = false;
  }

  // —— 目标同步 ——

  /**
   * 按 homeId 对齐观察目标：新增即连、消失即断、url 变化即重连。幂等、永不抛错。
   * @param {Array<{homeId:string,url:string}>} homes
   */
  sync(homes) {
    if (this.stopped) return;
    try {
      const desired = new Map();
      if (Array.isArray(homes)) {
        for (const home of homes) {
          const homeId = typeof home?.homeId === 'string' ? home.homeId.trim() : '';
          const url = typeof home?.url === 'string' ? home.url.trim() : '';
          // 缺 homeId 或 url 的目标直接跳过：拼一个坏地址去连只会白耗重连预算。
          if (!homeId || !url) continue;
          desired.set(homeId, url);
        }
      }
      // 先删「不再需要」与「url 变了要重连」的（后者在下一循环重建）。
      for (const [homeId, state] of [...this.homes]) {
        if (desired.get(homeId) === state.url) continue;
        this.#drop(state);
      }
      // 再补新增/重建。
      for (const [homeId, url] of desired) {
        if (this.homes.has(homeId)) continue;
        this.#start(homeId, url);
      }
    } catch (error) {
      // sync 由 server.js 的定时器调用；抛出去会变成 uncaughtException 打穿整个工作台。
      this.#warnOnce('sync', '同步实时介入观察目标失败（本轮跳过，保留上一轮结果）', {
        reason: errorCode(error),
      });
    }
  }

  // —— 覆盖层读取 ——

  /**
   * 某个 home 的当前覆盖层。返回**新 Map**（调用方改了也影响不到内部状态）。
   * @param {string} homeId
   * @returns {ReadonlyMap<string, object>}
   */
  overlay(homeId) {
    const layer = this.overlays.get(homeId);
    if (!layer || layer.size === 0) return new Map();
    const out = new Map();
    for (const [sessionId, entry] of layer) out.set(sessionId, entry.intervention);
    return out;
  }

  /**
   * 全部 home 的覆盖层（新 Map<homeId, Map>）。只包含正在观察的 home。
   * @returns {Map<string, ReadonlyMap<string, object>>}
   */
  all() {
    const out = new Map();
    for (const homeId of this.homes.keys()) out.set(homeId, this.overlay(homeId));
    return out;
  }

  // —— 会话行合并（API 层用） ——

  /**
   * 把实时覆盖层合入会话行：**不修改入参**、返回新数组、顺序与条数不变。
   *
   * 每个会话的介入可能出现在三处：`status.intervention`（投影推导，持久）、
   * `session.intervention`（上一次合并的结果/其它来源）、以及本模块的实时覆盖层。
   * 三者按 lib/intervention.js 的规则折叠（approval > plan-review > question；同 kind 时 live 赢），
   * 结果写回**顶层** `intervention`；没有介入时该字段被移除（原本就没有的行原样返回，
   * 连对象都不重建 —— 绝大多数行属于这种情况）。
   * `status` 一律原样保留（那是持久推导值，不属于这一层的职责）。
   *
   * @param {Array<object>|unknown} sessions
   * @returns {Array<object>|unknown}
   */
  apply(sessions) {
    if (!Array.isArray(sessions)) return sessions;
    try {
      return sessions.map((session) => {
        if (!isRecord(session)) return session;
        let live = null;
        if (typeof session.homeId === 'string' && session.homeId
          && typeof session.sessionId === 'string' && session.sessionId) {
          live = this.overlays.get(session.homeId)?.get(session.sessionId)?.intervention ?? null;
        }
        const merged = strongestIntervention([live, session.intervention, session.status?.intervention]);
        if (!merged) {
          if (!Object.hasOwn(session, 'intervention')) return session;
          const copy = { ...session };
          delete copy.intervention;
          return copy;
        }
        return { ...session, intervention: merged };
      });
    } catch (error) {
      // 合并只是「附加信息」：坏了就退回原行（列表是首屏主视图，绝不能因此 500）。
      this.#warnOnce('apply', '合并实时介入覆盖层失败（已降级为原样返回）', { reason: errorCode(error) });
      return sessions;
    }
  }

  /** 停止观察：断开所有连接（含在飞的对账 probe）、清空覆盖层、清掉定时器。幂等。 */
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    for (const state of [...this.homes.values()]) {
      this.#abortProbe(state);
      state.stopped = true;
      state.generation += 1;
      this.#clearTimer(state, 'reconnectTimer');
      this.#clearTimer(state, 'readyTimer');
      const handle = state.handle;
      state.handle = null;
      if (handle) {
        try { handle.close?.(); } catch { /* 关闭失败无补救 */ }
      }
      state.pending.clear();
      state.byEvent.clear();
    }
    this.homes.clear();
    this.overlays.clear();
    clearTimeout(this.notifyTimer);
    this.notifyTimer = null;
    this.notifyPending.clear();
    if (this.staleTimer) {
      clearInterval(this.staleTimer);
      this.staleTimer = null;
    }
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
  }

  /**
   * 立即对账一轮（内部定时器每 reconcileIntervalMs 也会调用它）。
   *
   * 对每个「overlay 非空」的 home 起一条短寿命 probe 流，拿 Host 的重放集合判断哪些
   * pending 其实已经结算了（Host 只在请求仍挂起时才重放）。没有挂起项时什么都不做，
   * 所以空闲调用是零成本的。返回的 Promise 在本次到期的 probe 全部收尾后 resolve
   * （测试/集成验证可以直接 await 它，不必等定时器）。
   */
  async reconcile() {
    if (this.stopped) return;
    try {
      const jobs = [];
      for (const state of [...this.homes.values()]) {
        if (this.stopped || state.stopped || !state.ready) continue;
        if (!(this.overlays.get(state.homeId)?.size)) continue;
        if (state.probe) { jobs.push(state.probe.done); continue; }
        jobs.push(this.#reconcileHome(state));
      }
      await Promise.all(jobs.map((job) => Promise.resolve(job).catch(() => {})));
    } catch (error) {
      // 对账是后台清理，任何异常都不该冒到调用方（定时器里抛错会变成 uncaughtException）。
      this.#warnOnce('reconcile', '实时介入对账失败（本轮跳过，不影响主连接）', {
        reason: errorCode(error),
      });
    }
  }

  // —— 内部：连接生命周期 ——

  #start(homeId, url) {
    const state = {
      homeId,
      url,
      stopped: false,
      // 每次「建立连接 / 放弃连接」都 +1。异步回调（连上了、收到帧了、断了）执行前先比对它，
      // 这样 stop()、url 变更、重连竞态里的过期回调一律作废，不会往已废弃的 state 里写数据。
      generation: 0,
      attempt: 0,
      ready: false,
      // ready 帧给的这一代订阅者 id；应答 `$events/result` 时必须原样带上。
      clientId: null,
      handle: null,
      readyTimer: null,
      reconnectTimer: null,
      // token→cookie 交接的记忆（live-status 的 acquireCookie / rpc 共用，避免每段请求都重做交接）。
      cookieMemo: new Map(),
      // 已发出、尚未 cancel 的 waterfall：sessionId → Map<eventId, {intervention, at}>
      pending: new Map(),
      // eventId → sessionId（cancel 帧只带 eventId）
      byEvent: new Map(),
      // 在飞的对账 probe（见 reconcile()）；同一 home 同时只允许一条。
      probe: null,
    };
    this.homes.set(homeId, state);
    this.#ensureStaleTimer();
    this.#ensureReconcileTimer();
    void this.#open(state);
  }

  async #open(state) {
    if (this.stopped || state.stopped) return;
    const generation = ++state.generation;
    state.ready = false;
    try {
      const { origin, token } = splitAuthUrl(state.url);
      const cookie = await acquireCookie(origin, token, this.connectTimeoutMs, state.cookieMemo);
      if (this.stopped || state.stopped || state.generation !== generation) return;
      // acquireCookie 用 `{__error}` 表示「取凭据失败」（实例不可达 / token 无效），是**已经脱敏**
      // 的短标记（'auth timeout' / 'auth http 401'…），可以直接进日志。
      if (cookie && typeof cookie === 'object') {
        this.#fail(state, generation, safeReason(cookie.__error ?? 'auth failed'));
        return;
      }
      const handle = await this.transport.connect({
        origin,
        cookie,
        timeoutMs: this.connectTimeoutMs,
        onValue: (value) => this.#onValue(state, generation, value),
        onClose: (reason) => this.#fail(state, generation, safeReason(reason)),
      });
      if (this.stopped || state.stopped || state.generation !== generation) {
        try { handle?.close?.(); } catch { /* 已过期 */ }
        return;
      }
      state.handle = handle;
      // 握手成功 ≠ 逻辑流可用：首帧必须是 ready（Host 用它绑定后续应答的 clientId）。
      // 迟迟不来就当作失败，按退避重来，避免挂在一条「已连上但永不就绪」的通道上。
      state.readyTimer = setTimeout(
        () => this.#fail(state, generation, 'ready timeout'),
        this.connectTimeoutMs,
      );
      state.readyTimer.unref?.();
    } catch (error) {
      // 升级被 401/403 拒：多数是记忆里的 cookie 过期（实例重启换了密钥）。
      // 清掉记忆，让下一次重连重做一次 token→cookie 交接，而不是拿着死 cookie 一直重试。
      if (error?.httpStatus === 401 || error?.httpStatus === 403) state.cookieMemo.clear();
      this.#fail(
        state,
        generation,
        error?.httpStatus ? `connect http ${error.httpStatus}` : `connect ${errorCode(error)}`,
      );
    }
  }

  #fail(state, generation, reason) {
    if (!state || state.stopped || this.stopped) return;
    if (state.generation !== generation) return; // 过期回调
    state.generation += 1;                       // 让这条连接上的所有后续回调作废
    state.ready = false;
    state.clientId = null;
    // 主连接都断了（overlay 马上清空），在飞 probe 的结论已无意义。
    this.#abortProbe(state);
    this.#clearTimer(state, 'readyTimer');
    const handle = state.handle;
    state.handle = null;
    if (handle) {
      try { handle.close?.(); } catch { /* 已经断了 */ }
    }
    // 断流 → 立刻清空该 home 的覆盖层：Host 会在重连后重放仍挂起的 waterfall，
    // 留着旧标记只会产生「幽灵等待审批」（人已经处理过，标记还在）。
    this.#resetPending(state);
    this.#warnOnce(
      `${state.homeId}|fail:${reason}`,
      '实时介入通道断开/异常（已清空该实例的介入标记，并会按指数退避重连）',
      { homeId: state.homeId, reason },
    );
    this.#scheduleReconnect(state);
  }

  #scheduleReconnect(state) {
    if (this.stopped || state.stopped || state.reconnectTimer) return;
    const attempt = state.attempt;
    state.attempt += 1;
    // 指数退避 + 抖动：cap 之前每轮翻倍，抖动取 [50%, 100%] —— 多个 home 同时掉线时
    // 不会在同一毫秒集体重连（把 dsh 打成重连风暴）。
    const exponential = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * 2 ** Math.min(attempt, 16));
    const delay = Math.max(1, Math.round(exponential * (0.5 + Math.random() * 0.5)));
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      void this.#open(state);
    }, delay);
    state.reconnectTimer.unref?.();
  }

  #markReady(state, clientId) {
    state.ready = true;
    // clientId 是后续应答的绑定凭据（`$events/result` 用它说明「我是这一代订阅者」），
    // 每条连接一代，断流后必须丢弃，否则会把应答发到已失效的 generation 上。
    state.clientId = clientId;
    state.attempt = 0; // 连接成功即复位退避
    this.#clearTimer(state, 'readyTimer');
  }

  // —— 内部：帧处理 ——

  #onValue(state, generation, value) {
    if (this.stopped || state.stopped || state.generation !== generation) return;
    const frame = normalizeRemoteEventFrame(value);
    if (!state.ready) {
      // 首帧必须是 ready，否则这条流的语义无法确定（没有 clientId 就没法应答）。
      if (!frame || frame.type !== 'ready') {
        this.#fail(state, generation, 'invalid ready');
        return;
      }
      this.#markReady(state, frame.clientId);
      return;
    }
    if (!frame) {
      this.#warnOnce(`${state.homeId}|bad-frame`, '收到无法识别的实时事件帧（已忽略）', { homeId: state.homeId });
      return;
    }
    if (frame.type === 'ready') return;   // 重复 ready：忽略
    if (frame.type === 'emit') {
      // 通知帧无需应答，但**有的**是结算信号（见文件头第 4 条）：turn 结束 / 会话被移除时
      // 该会话不可能还挂着 waterfall，直接清掉，省掉一轮对账。
      this.#handleEmit(state, frame);
      return;
    }
    if (frame.type === 'cancel') {
      this.#dropEvent(state, frame.eventId, this.#now());
      return;
    }
    this.#observeWaterfall(state, frame);
  }

  #observeWaterfall(state, frame) {
    const at = this.#now();
    // 容量上限：对面永不发 cancel 时也不能让 Map 无限长（内存安全，不是功能）。
    if (!state.byEvent.has(frame.eventId) && state.byEvent.size >= MAX_PENDING_EVENTS) {
      const oldest = state.byEvent.keys().next().value;
      if (oldest !== undefined) this.#dropEvent(state, oldest, at);
    }
    const intervention = interventionOfFrame(frame, at);
    let byEvent = state.pending.get(frame.sessionId);
    if (!byEvent) {
      byEvent = new Map();
      state.pending.set(frame.sessionId, byEvent);
    }
    byEvent.set(frame.eventId, { intervention, at });
    state.byEvent.set(frame.eventId, frame.sessionId);
    this.#setOverlay(state.homeId, frame.sessionId, this.#pendingIntervention(byEvent), at);
    // **立刻**委托回 Host：outcome 'next' 在 waterfall 语义里就是「我不处理，交给下一个监听器」。
    // 只观察、绝不替人做决定 —— 这也是为什么这里不碰 request.signal、不缓存应答权。
    this.#answer(state, frame);
  }

  #dropEvent(state, eventId, at) {
    const sessionId = state.byEvent.get(eventId);
    if (sessionId === undefined) return;
    state.byEvent.delete(eventId);
    const byEvent = state.pending.get(sessionId);
    if (byEvent) {
      byEvent.delete(eventId);
      if (byEvent.size === 0) state.pending.delete(sessionId);
    }
    this.#setOverlay(state.homeId, sessionId, byEvent ? this.#pendingIntervention(byEvent) : null, at);
  }

  // 结算信号（emit 帧）。dsh 的转发事件名单里只有两种与本模块相关：
  //   api-session/status(sessionId, running) —— running=false 表示该 agent 的 turn 已结束
  //   api-session/removed(sessionId)        —— 会话被移除
  // 两者都意味着「该会话不可能还挂着 waterfall」，直接清掉它的全部 pending。
  // 注意 running=true 不清：turn 继续跑时审批可能已经结算（那种情形靠 reconcile 兜）。
  #handleEmit(state, frame) {
    if (frame.event === 'api-session/status') {
      const [sessionId, running] = frame.args;
      if (typeof sessionId === 'string' && sessionId && running === false) {
        this.#clearSession(state, sessionId);
      }
      return;
    }
    if (frame.event === 'api-session/removed') {
      const [sessionId] = frame.args;
      if (typeof sessionId === 'string' && sessionId) this.#clearSession(state, sessionId);
    }
  }

  // 清掉某会话的全部挂起项（emit 快路径用）。overlay 同步移除并广播。
  #clearSession(state, sessionId) {
    const byEvent = state.pending.get(sessionId);
    if (byEvent) {
      for (const eventId of [...byEvent.keys()]) state.byEvent.delete(eventId);
      state.pending.delete(sessionId);
    }
    this.#setOverlay(state.homeId, sessionId, null, this.#now());
  }

  #pendingIntervention(byEvent) {
    const list = [];
    for (const entry of byEvent.values()) {
      if (entry.intervention) list.push(entry.intervention);
    }
    return strongestIntervention(list);
  }

  #setOverlay(homeId, sessionId, intervention, at) {
    let layer = this.overlays.get(homeId);
    if (!intervention) {
      if (!layer) return;
      if (!layer.delete(sessionId)) return;
      if (layer.size === 0) this.overlays.delete(homeId);
      this.#notify(homeId);
      return;
    }
    if (!layer) {
      layer = new Map();
      this.overlays.set(homeId, layer);
    }
    const previous = layer.get(sessionId);
    layer.set(sessionId, { intervention, at });
    if (!previous || !sameIntervention(previous.intervention, intervention)) this.#notify(homeId);
  }

  #resetPending(state) {
    const had = (this.overlays.get(state.homeId)?.size ?? 0) > 0;
    state.pending.clear();
    state.byEvent.clear();
    this.overlays.delete(state.homeId);
    if (had) this.#notify(state.homeId);
  }

  // 立刻把 waterfall 委托回 Host（outcome 'next' = 「我不处理，交给下一个监听器」）。
  // clientId 默认用主连接的；对账 probe 传它**自己**的 clientId（应答必须来自持有该流的同一 Peer）。
  #answer(state, frame, clientId = state.clientId) {
    // 走 live-status 的 rpc：信封 {type:'client-request', rpcId, method, payload:{args}}，
    // POST 到 `/api/$events/result`（与 dsh client.node.js 的 connection.rpc.call 同形）。
    void (async () => {
      try {
        const result = await rpc(
          state.url,
          EVENTS_RESULT_ENDPOINT,
          {
            clientId,
            eventId: frame.eventId,
            outcome: { kind: 'next' },
          },
          this.connectTimeoutMs,
          ANSWER_MAX_BYTES,
          state.cookieMemo,
        );
        if (result?.__error) {
          this.#warnOnce(
            `${state.homeId}|answer:${result.__error}`,
            '实时介入应答失败（该 waterfall 会交给其它监听器，但仍值得关注）',
            { homeId: state.homeId, reason: safeReason(result.__error) },
          );
        }
      } catch (error) {
        this.#warnOnce(
          `${state.homeId}|answer:${errorCode(error)}`,
          '实时介入应答异常（已忽略）',
          { homeId: state.homeId, reason: errorCode(error) },
        );
      }
    })();
  }

  // —— 内部：主动对账（probe 流） ——

  #ensureReconcileTimer() {
    if (this.reconcileTimer || !(this.reconcileIntervalMs > 0)) return;
    const period = Math.max(10, Math.min(60_000, this.reconcileIntervalMs));
    this.reconcileTimer = setInterval(() => { void this.reconcile(); }, period);
    this.reconcileTimer.unref?.();
  }

  #probeAlive(state, probe) {
    return !!probe
      && !probe.finished
      && !probe.aborted
      && !this.stopped
      && !state.stopped
      && state.probe === probe;
  }

  /**
   * 为某个 home 起一条短寿命 probe 流并对账。
   *
   * 关键事实（dsh-api-gateway 的 Host 侧 `startRemoteEvent`）：每条新开的 `$events` 流都会收到
   * **当前仍挂起**的 waterfall 全量重放，且 eventId 不变。于是：
   *   · probe 开始前就在册（`candidates`）且窗口内**没**被重放的 eventId → 已结算 → 清掉；
   *   · 被重放的 → 仍挂起 → 保留。
   * 用「开始前的 eventId 快照」而不是时间戳比较：不依赖时钟精度，也不会误伤窗口期间新到的帧。
   */
  async #reconcileHome(state) {
    if (this.stopped || state.stopped || !state.ready) return undefined;
    if (state.probe) return state.probe.done;
    if (!(this.overlays.get(state.homeId)?.size)) return undefined;
    const candidates = [...state.byEvent.keys()];
    if (!candidates.length) return undefined;

    const probe = {
      state,
      // 本轮参与对账的 eventId 快照（probe 开始前在册）
      candidates: new Set(candidates),
      // 窗口内被重放到的 eventId（= 仍挂起）
      seen: new Set(),
      clientId: null,
      handle: null,
      readyTimer: null,
      windowTimer: null,
      finished: false,
      aborted: false,
      settle: null,
      done: null,
    };
    probe.done = new Promise((resolve) => { probe.settle = resolve; });
    state.probe = probe;

    try {
      const { origin, token } = splitAuthUrl(state.url);
      const cookie = await acquireCookie(origin, token, this.connectTimeoutMs, state.cookieMemo);
      if (!this.#probeAlive(state, probe)) { this.#finishProbe(probe); return probe.done; }
      if (cookie && typeof cookie === 'object') {
        this.#failProbe(state, probe, safeReason(cookie.__error ?? 'auth failed'));
        return probe.done;
      }
      const handle = await this.transport.connect({
        origin,
        cookie,
        timeoutMs: this.connectTimeoutMs,
        onValue: (value) => this.#onProbeValue(state, probe, value),
        onClose: (reason) => this.#onProbeClose(state, probe, safeReason(reason)),
      });
      if (!this.#probeAlive(state, probe)) {
        try { handle?.close?.(); } catch { /* 已过期 */ }
        this.#finishProbe(probe);
        return probe.done;
      }
      probe.handle = handle;
      // probe 连上了但 ready 迟迟不来：放弃本轮对账（绝不动 overlay）。
      probe.readyTimer = setTimeout(() => this.#failProbe(state, probe, 'ready timeout'), this.connectTimeoutMs);
      probe.readyTimer.unref?.();
    } catch (error) {
      if (error?.httpStatus === 401 || error?.httpStatus === 403) state.cookieMemo.clear();
      this.#failProbe(
        state,
        probe,
        error?.httpStatus ? `connect http ${error.httpStatus}` : `connect ${errorCode(error)}`,
      );
    }
    return probe.done;
  }

  #onProbeValue(state, probe, value) {
    if (!this.#probeAlive(state, probe)) return;
    const frame = normalizeRemoteEventFrame(value);
    if (!probe.clientId) {
      if (!frame || frame.type !== 'ready') {
        this.#failProbe(state, probe, 'invalid ready');
        return;
      }
      probe.clientId = frame.clientId;
      this.#clearTimer(probe, 'readyTimer');
      // 窗口从 **ready** 开始计，而不是从 TCP 建连开始：ready 与重放帧在同一条顺序流里，
      // 收到 ready 说明逻辑流真的通了 —— 慢链路上才不会把「重放还在路上」误判成「已结算」
      // （误判的代价是**漏报**真实待审批，比幽灵标记更糟）。
      if (!probe.windowTimer) {
        probe.windowTimer = setTimeout(() => this.#endProbeWindow(state, probe), this.probeWindowMs);
        probe.windowTimer.unref?.();
      }
      return;
    }
    if (!frame) return;                     // 畸形帧：忽略（probe 不该因此中断对账）
    if (frame.type !== 'waterfall') return; // ready/cancel/emit 与对账无关
    // 先记账，再**立刻用 probe 自己的 clientId** 回 next：probe 绝不能成为挡在真实 UI
    // 前面的监听器（Host 的 waterfall 只有在所有订阅者都 next 后才会继续往下走）。
    probe.seen.add(frame.eventId);
    this.#answer(state, frame, probe.clientId);
  }

  #onProbeClose(state, probe, reason) {
    // 我们主动 close() 时传输层不会再回调；走到这里说明 probe 被对面关了。
    if (!this.#probeAlive(state, probe)) return;
    this.#failProbe(state, probe, reason);
  }

  #endProbeWindow(state, probe) {
    if (!this.#probeAlive(state, probe)) { this.#finishProbe(probe); return; }
    const landed = [];
    for (const eventId of probe.candidates) {
      if (!probe.seen.has(eventId)) landed.push(eventId);
    }
    // 先关掉 probe 流（不再需要它），再应用对账结论。
    const handle = probe.handle;
    probe.handle = null;
    if (handle) {
      try { handle.close?.(); } catch { /* 已断开 */ }
    }
    const at = this.#now();
    for (const eventId of landed) {
      if (!this.#probeAlive(state, probe)) break;
      // 已结算的 waterfall：清掉它的挂起项（可能连带清掉 overlay 条目）。
      this.#dropEvent(state, eventId, at);
    }
    this.#finishProbe(probe);
  }

  #failProbe(state, probe, reason) {
    if (probe && probe.finished) return;
    if (this.#probeAlive(state, probe)) {
      this.#warnOnce(
        `${state.homeId}|probe:${reason}`,
        '实时介入对账的探针连接失败（本轮跳过，主连接与现有标记不受影响）',
        { homeId: state.homeId, reason },
      );
    }
    const handle = probe?.handle;
    if (probe) probe.handle = null;
    if (handle) {
      try { handle.close?.(); } catch { /* 已断开 */ }
    }
    this.#finishProbe(probe);
  }

  #finishProbe(probe) {
    if (!probe || probe.finished) return;
    probe.finished = true;
    if (probe.readyTimer) { clearTimeout(probe.readyTimer); probe.readyTimer = null; }
    if (probe.windowTimer) { clearTimeout(probe.windowTimer); probe.windowTimer = null; }
    if (probe.state?.probe === probe) probe.state.probe = null;
    try { probe.settle?.(); } catch { /* resolve 不会抛 */ }
  }

  // 作废在飞 probe（stop / 主连接断开 / 目标被删除时调用）。不写 overlay，只收尾。
  #abortProbe(state) {
    const probe = state.probe;
    if (!probe) return;
    probe.aborted = true;
    const handle = probe.handle;
    probe.handle = null;
    if (handle) {
      try { handle.close?.(); } catch { /* 已断开 */ }
    }
    this.#finishProbe(probe);
  }

  // —— 内部：过期清理 ——

  #ensureStaleTimer() {
    if (this.staleTimer || !(this.staleMs > 0)) return;
    // 清扫周期取过期时间的 1/4，夹在 [10ms, 60s]：30min 的默认过期只需 60s 扫一次。
    const period = Math.max(10, Math.min(60_000, Math.floor(this.staleMs / 4)));
    this.staleTimer = setInterval(() => this.#sweepStale(), period);
    this.staleTimer.unref?.();
  }

  #sweepStale() {
    if (this.stopped) return;
    const now = this.#now();
    for (const state of this.homes.values()) {
      for (const [sessionId, byEvent] of [...state.pending]) {
        let changed = false;
        for (const [eventId, entry] of [...byEvent]) {
          // Host 漏发 cancel（进程被杀、网络黑洞）时的兜底：超过 staleMs 的挂起项视为已失效。
          if (now - entry.at > this.staleMs) {
            byEvent.delete(eventId);
            state.byEvent.delete(eventId);
            changed = true;
          }
        }
        if (byEvent.size === 0) state.pending.delete(sessionId);
        if (changed) this.#setOverlay(state.homeId, sessionId, this.#pendingIntervention(byEvent), now);
      }
    }
  }

  // —— 内部：通知与众工具 ——

  #notify(homeId) {
    if (this.stopped) return;
    this.notifyPending.add(homeId);
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      const targets = [...this.notifyPending];
      this.notifyPending.clear();
      for (const target of targets) {
        try {
          const returned = this.broadcast('intervention:updated', { homeId: target });
          // broadcast 可能是 async 的（SSEHub 不是，但集成方可能包一层）：拒绝也必须吞掉，
          // 否则一个断掉的客户端能让整条观察链路出现 unhandledRejection。
          if (returned && typeof returned.then === 'function') returned.catch(() => {});
        } catch (error) {
          if (!this.broadcastErrorLogged) {
            this.broadcastErrorLogged = true;
            this.#warnOnce('broadcast', '介入变更广播失败（已忽略，界面会等下一次变更）', {
              reason: errorCode(error),
            });
          }
        }
      }
    }, NOTIFY_DEBOUNCE_MS);
    this.notifyTimer.unref?.();
  }

  #drop(state) {
    // 目标消失（实例停止/被移除）或 url 变化：断开并清空它的覆盖层。
    this.#abortProbe(state);
    state.stopped = true;
    state.generation += 1;
    state.clientId = null;
    this.#clearTimer(state, 'reconnectTimer');
    this.#clearTimer(state, 'readyTimer');
    const handle = state.handle;
    state.handle = null;
    if (handle) {
      try { handle.close?.(); } catch { /* 已断开 */ }
    }
    this.#resetPending(state);
    state.pending.clear();
    state.byEvent.clear();
    this.homes.delete(state.homeId);
  }

  #clearTimer(state, key) {
    const timer = state[key];
    if (!timer) return;
    clearTimeout(timer);
    state[key] = null;
  }

  #now() {
    try {
      const value = this.now();
      return typeof value === 'number' && Number.isFinite(value) ? value : Date.now();
    } catch {
      return Date.now();
    }
  }

  #warnOnce(key, message, context) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    try { log.warn(message, context); } catch { /* 日志失败不得影响观察链路 */ }
  }
}

// intervention 的相等判定（用于「值没变就不广播」）。只比较 normalizeIntervention 的七个字段，
// 不 JSON.stringify —— 后者依赖键序，且会把一个对象比较变成字符串分配。
function sameIntervention(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.kind === b.kind
    && a.label === b.label
    && a.source === b.source
    && a.since === b.since
    && a.tool === b.tool
    && a.reason === b.reason
    && a.count === b.count;
}
