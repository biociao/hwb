// —— 会话历史：用「向前增量」把重传变成补差（配合 dsh-history-delta 插件）——
//
// 背景（实测 dgx21.tun，dsh 0.1.1-rc.2）：`session.history {sessionId, maxMessages:50}` 每次都返回
// 整个尾部窗口的**原始事件**（大会话 8–10 MiB / 四万多条事件）；它只有 `beforeSeq`（往回翻），
// 没有 `afterSeq`，而事件流又没有游标（开流 payload 为 `{}`）—— 所以「打开/刷新/切回会话」必然重传全量。
//
// `dsh-history-delta` 插件补上了这条向前增量通道（`POST /api.histdelta/history`，纯新增，不动既有路由）：
// 调用方带 `afterSeq`（自己已有的最大 seq）去，它只回缺的那一段，并附上窗口原始边界
// （windowFirstSeq/windowLastSeq）。本模块负责**拼接**：
//
//   本地旧窗口 [cachedFirst..cachedLast]  +  delta[>cachedLast]  再裁到 >= windowFirstSeq
//   == 上游此刻本来会返回的整段窗口（逐条相同）
//
// 前提是「连续」：cachedFirst <= windowFirstSeq 且 windowFirstSeq <= cachedLast + 1。
// 不连续（窗口往前滑过头、日志被裁剪、本地副本太旧）→ 调用方必须**整段重取**，绝不拼出一个带空洞的窗口。
// 本模块只做纯计算；网络与缓存读写由 proxy.js 负责。

const seqOf = (record) => {
  const seq = record?.event?.seq ?? record?.seq;
  return Number.isInteger(seq) ? seq : null;
};

/** 从一份 history 响应体里取出窗口事实；形状不符返回 null（调用方一律回退整段）。 */
export function windowOf(body) {
  let parsed;
  try { parsed = JSON.parse(body.toString('utf8')); } catch { return null; }
  const value = parsed?.result?.ok === true ? parsed.result.value : null;
  const events = value?.events;
  if (!Array.isArray(events) || events.length === 0) return null;
  const firstSeq = seqOf(events[0]);
  const lastSeq = seqOf(events.at(-1));
  if (firstSeq === null || lastSeq === null) return null;
  return { parsed, value, events, firstSeq, lastSeq, hasMore: value.hasMore === true, projections: value.projections };
}

/** 这份 delta 能不能与本地旧窗口拼成「上游此刻会给的窗口」。 */
export function canMerge(cached, delta) {
  if (!cached || !delta) return false;
  return cached.firstSeq <= delta.windowFirstSeq && delta.windowFirstSeq <= cached.lastSeq + 1;
}

/**
 * 拼出与整段重取逐条相同的窗口值。cached/delta 为 windowOf() 的结果 + delta 的窗口边界。
 * 返回 null 表示不满足前提（调用方回退整段重取）。
 */
export function mergeWindows(cached, delta) {
  if (!cached || !delta || !Array.isArray(delta.events)) return null;
  if (!canMerge(cached, delta)) return null;
  const seen = new Set();
  const merged = [];
  for (const record of [...cached.events, ...delta.events]) {
    const seq = seqOf(record);
    if (seq === null) continue;                       // 无 seq 的记录无法判定归属：整段拼接不适用
    if (seq < delta.windowFirstSeq) continue;         // 裁到上游窗口的起点（多出来的头部是上游会丢掉的）
    if (seen.has(seq)) continue;                      // delta 与本地副本重叠时去重
    seen.add(seq);
    merged.push(record);
  }
  if (merged.length === 0) return null;
  const firstSeq = seqOf(merged[0]);
  const lastSeq = seqOf(merged.at(-1));
  if (firstSeq !== delta.windowFirstSeq || lastSeq !== delta.windowLastSeq) {
    // 拼出来的首尾必须与上游窗口完全对齐，否则说明中间有洞 —— 宁可重取。
    return null;
  }
  return {
    events: merged,
    hasMore: cached.hasMore,                          // 合并后的窗口起点 = 上游窗口起点，所以沿用旧窗口的 hasMore
    ...(delta.projections === undefined ? {} : { projections: delta.projections }),
    firstSeq,
    lastSeq,
  };
}

/** 用合并结果重建一份**与上游同形**的响应体（丢掉我们自己的 afterSeq/window* 内部字段）。 */
export function buildHistoryBody(template, value, rpcId) {
  let parsed;
  try { parsed = JSON.parse(template.toString('utf8')); } catch { return null; }
  const out = {
    ...parsed,
    rpcId: rpcId ?? parsed.rpcId,
    result: { ...parsed.result, ok: true, value: { events: value.events, hasMore: value.hasMore, ...(value.projections === undefined ? {} : { projections: value.projections }) } },
  };
  return Buffer.from(JSON.stringify(out), 'utf8');
}

/** `session.history` 的请求体是否可用于增量：只读、带 sessionId、且没有 beforeSeq（往回翻页本来就是最小传输）。 */
export function historyRequestOf(body) {
  let parsed;
  try { parsed = JSON.parse(body.toString('utf8')); } catch { return null; }
  const payload = parsed?.payload ?? {};
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId
    : (typeof payload.args?.sessionId === 'string' ? payload.args.sessionId : null);
  if (!sessionId) return null;
  if (payload.beforeSeq !== undefined || payload.args?.beforeSeq !== undefined) return null;
  const maxMessages = payload.maxMessages ?? payload.args?.maxMessages;
  if (!Number.isSafeInteger(maxMessages) || maxMessages <= 0) return null;
  return { sessionId, maxMessages, rpcId: parsed.rpcId ?? null };
}

/** 构造发往插件通道的增量请求体。 */
export function deltaRequestBody({ sessionId, maxMessages, rpcId, afterSeq }) {
  return Buffer.from(JSON.stringify({
    type: 'client-request',
    rpcId: rpcId ?? 'hwb-delta',
    method: 'history',
    payload: { args: { sessionId, afterSeq, maxMessages } },
  }), 'utf8');
}
