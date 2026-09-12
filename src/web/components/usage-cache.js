// 用量数据的客户端节流。
//
// 为什么需要它：`/api/usage` 是**八个同步 SQLite 聚合**（node:sqlite 没有异步接口），实测 40k 会话
// 时合计 ~330ms —— 这期间整个单线程服务（HTTP、SSE、30s 心跳）都停着。而用量数据原先**每次渲染
// 都取一次**，渲染又由 SSE 驱动（每 3s 一次），于是「开着大库的工作台」就是每 3 秒冻一次。
//
// 服务端也有一层 10s 的 TTL 记忆（多客户端共享），这里是客户端这一侧：同一个周期在窗口内不重复
// 请求。用量面板统计的是历史，十几秒的滞后无感。抽成独立模块是为了能直接测（app.js 依赖完整 DOM，
// 不方便在 node:test 里跑）。
export function createUsageCache(ttlMs, now = () => Date.now()) {
  let entry = null;   // { key, at, body }
  return {
    // 窗口内且同一周期 → 直接复用，不请求
    peek(key) {
      if (!entry || entry.key !== key) return null;
      return now() - entry.at < ttlMs ? entry.body : null;
    },
    store(key, body) {
      entry = { key, at: now(), body };
      return body;
    },
    // 强制刷新前先丢弃缓存（用户主动切换周期时用，避免把旧周期的数据再写回去）
    invalidate() { entry = null; },
  };
}
