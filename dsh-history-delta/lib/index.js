/**
 * dsh-history-delta — Host 半：给「读历史」加一条**向前增量**通道。
 *
 * 为什么（2026-09-14 实测 dgx21.tun，dsh 0.1.1-rc.2）：
 *   · `session.history` 只接受 `{sessionId, beforeSeq, maxMessages}`：`beforeSeq` 是**往回翻**更早的
 *     内容，不给就是切「最新尾部窗口」（`historyCutOf` 取整条事件日志再 `paginate`）。
 *     **没有 sinceSeq/afterSeq** —— 于是「打开/刷新/切回会话」每次都要重传整个窗口：实测一个会话
 *     `maxMessages:50` 的窗口 = 42 088 条事件 / **8.33 MiB**（另一个 9.83 MiB），25–30 KB/s 的链路上 43 秒。
 *   · 事件流 `/api/events.host` 代替不了它：那是**从订阅时刻起**的 live 通道（开流 payload 为 `{}`，
 *     没有游标），补不回「我已经有的窗口」和「现在」之间那段。
 *   · 直接给 `session.history` 加 `afterSeq` **行不通**：那条路由的请求 schema 是 zod 严格对象，
 *     未知字段会被**静默剥掉**（实测：打上包装后收到的 payload 只有 `sessionId,maxMessages`，
 *     `afterSeq=undefined`）。所以本插件不碰既有路由。
 *
 * 本插件做的事（**纯新增，零改动既有行为**）：
 *   通过 connection 服务的公开扩展点注册一条 RPC 通道
 *
 *     POST /api.histdelta/history
 *     {type:'client-request', rpcId, method:'history',
 *      payload:{args:{sessionId, afterSeq, maxMessages?, beforeSeq?}}}
 *
 *   它内部照常调用 `apiProxy.sessions.history(...)`（拿到与上游**完全相同**的尾部窗口），
 *   再把 `seq <= afterSeq` 的事件摘掉，只回缺的那一段，并附上窗口原始边界：
 *     value: { events, hasMore, projections, afterSeq, windowFirstSeq, windowLastSeq }
 *
 *   调用方（如 hwb 的代理层）据此做一次**可验证的拼接**：本地副本 + delta，再按 `windowFirstSeq`
 *   裁掉头部 —— 结果与「整段重取」逐条相同。不连续（窗口滑过头/日志被裁剪/本地副本太旧）时，
 *   调用方应退回整段重取；本插件从不伪造事件，也不假设调用方怎么用。
 *
 *   既有前端完全不碰：`/api/session.history` 的行为与打补丁前**逐字节一致**。
 *
 * 依赖的服务：`connection`（注册通道）、`apiProxy`（取历史）。任一缺失 → 只记一行日志，不阻塞启动。
 */

export const name = 'dsh-history-delta';

/** 通道挂在 /api 之外（`/api.histdelta`），channel 只允许单段路径，故用点号分隔。 */
export const CHANNEL = '/api.histdelta';
export const ENDPOINT = 'history';

export const inject = ['connection', 'apiProxy'];

/** 从一条 history 记录里取 seq（上游给的是 `{event:{seq,…}, view?}`；两种形状都认）。 */
function seqOf(record) {
  const seq = record?.event?.seq ?? record?.seq;
  return Number.isInteger(seq) ? seq : null;
}

/**
 * 纯函数核心：把一份「完整尾部窗口」折叠成「afterSeq 之后的增量」。
 * 返回 null 表示形状不符（调用方应原样回退整段响应）。
 */
export function deltaFromWindow(value, afterSeq) {
  const events = value?.events;
  if (!Array.isArray(events)) return null;
  const windowFirstSeq = events.length ? seqOf(events[0]) : null;
  const windowLastSeq = events.length ? seqOf(events.at(-1)) : null;
  const kept = events.filter((record) => {
    const seq = seqOf(record);
    // 取不到 seq 的记录一律**保留**：宁多传一条，也不制造一个看不见的空洞。
    return seq === null || seq > afterSeq;
  });
  return { ...value, events: kept, afterSeq, windowFirstSeq, windowLastSeq };
}

export function apply(ctx) {
  const connection = ctx.get('connection');
  const api = ctx.get('apiProxy');
  const sessions = api?.sessions;
  if (!connection?.rpc?.handle || typeof sessions?.history !== 'function') {
    console.log('[dsh-history-delta] 缺少 connection.rpc.handle 或 apiProxy.sessions.history —— 不打补丁（其余功能不受影响）');
    return;
  }

  const bad = (code, message) => ({ ok: false, error: { code, message } });

  const handler = async (endpoint, payload) => {
    if (endpoint !== ENDPOINT) return bad('not-found', `unknown endpoint ${JSON.stringify(endpoint)}`);
    const args = payload?.args ?? {};
    const { sessionId, afterSeq, maxMessages, beforeSeq } = args;
    if (typeof sessionId !== 'string' || sessionId === '') return bad('bad-request', 'sessionId must be a non-empty string');
    if (!Number.isInteger(afterSeq) || afterSeq < 0) return bad('bad-request', 'afterSeq must be a non-negative integer');
    if (maxMessages !== undefined && (!Number.isSafeInteger(maxMessages) || maxMessages <= 0)) return bad('bad-request', 'maxMessages must be a positive safe integer');
    if (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 0)) return bad('bad-request', 'beforeSeq must be a non-negative safe integer');

    // 照常调用既有方法 —— 窗口语义、projections、hasMore 全部沿用上游实现，这里只做减法。
    const full = await sessions.history({
      rpcId: 'histdelta',
      payload: {
        sessionId,
        ...(maxMessages === undefined ? {} : { maxMessages }),
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
      },
    });
    const value = full?.result?.ok === true ? full.result.value : null;
    const delta = value === null ? null : deltaFromWindow(value, afterSeq);
    if (delta === null) {
      return bad('internal', 'session.history returned an unexpected shape; caller should fall back to the full window');
    }
    return { ok: true, value: delta };
  };

  // authority 与既有 /api 路由一致（受 trustedHosts / 回环 Host 保护）；
  // 不传 options 会被上游读 `options.authority` 而崩（实测：Cannot read properties of undefined）。
  connection.rpc.handle(CHANNEL, handler, { authority: 'trusted-host' });
  console.log(`[dsh-history-delta] 已注册 ${CHANNEL}/${ENDPOINT}（向前增量历史；既有 session.history 未改动）`);
}

// 便于单测直接调用（不依赖 cordis 运行时）。
export const internals = { seqOf, deltaFromWindow };
