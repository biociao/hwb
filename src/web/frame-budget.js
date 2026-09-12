// —— 活跃 iframe 预算（前端内存的上界）——
//
// 每个实例面板里的 iframe 都是一整个 dsh web SPA：自己的一条 EventSource、自己的会话 DOM、
// 自己的插件脚本与图片缓存。原实现是「切走只 hidden、绝不销毁」——切换确实是瞬时的，
// 但代价是**浏览器内存与「访问过的实例数」同阶增长、且永不归还**：隐藏的 iframe 不是被冻结的
// 快照，它照旧跑定时器、SSE 与动画。
//
// 2026-09-12 实测（本机 Safari）：一个 WebKit WebContent 进程 2.3 GB / 26% CPU 常驻 7 小时，
// Safari 以「此网页使用了大量内存」把页面直接重载 —— 用户看到的是工作台莫名刷新。
//
// 所以给活跃 iframe 一个预算：预算内保持热实例（切回仍是瞬时的），超出的按 LRU 释放 iframe、
// 只留标签页与会话 id；重新进入时按 pane.sessionId 重新挂载（dsh 支持 session 深链时回到同一会话，
// 见 instance-navigation.js 的二段跳）。这等价于浏览器的「标签页休眠」，只是我们自己做、且只做
// 内存最贵的这一层（iframe），不碰工作台自身。
//
// 策略写成纯函数：前端唯一能被单测直接覆盖的就是这类决策（见 tests/frame-budget.test.js）。

// 3 = 当前正在看的 + 2 个热的。再往上加，省下的切换延迟远小于内存代价：
// 一个跑着长会话的 dsh web SPA 实测可达数百 MB。
export const DEFAULT_MAX_LIVE_FRAMES = 3;

// `?frames=N` 可覆盖：scripts/memory-check.mjs 用它做「有预算 / 无预算」的对照实验，
// 低内存机器也可以调小。非法值（0、负数、小数、NaN、非数字）一律回退默认值 ——
// 预算必须是 ≥1 的整数，否则 0 会让每次进入实例都立刻释放自己（页面永远空白）。
export function resolveMaxLiveFrames(search = '') {
  let raw;
  try {
    raw = new URLSearchParams(search).get('frames');
  } catch {
    return DEFAULT_MAX_LIVE_FRAMES; // search 不是合法 query string
  }
  if (raw === null || raw === '') return DEFAULT_MAX_LIVE_FRAMES;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return DEFAULT_MAX_LIVE_FRAMES;
  // 上限不是安全边界而是防呆：把预算写成天文数字等于关掉这个保护，调用方应当明确知道自己在做什么
  // （memory-check 的对照实验正是这样用的）。
  return Math.min(n, 64);
}

// LRU 记账：把 id 移到「最近使用」的一端（末尾）。返回新数组，不改入参（便于测试与回滚）。
export function touchFrameOrder(order, id) {
  const next = (order || []).filter((x) => x && x !== id);
  if (id) next.push(id);
  return next;
}

/**
 * 超预算时该释放哪些面板的 iframe：从最旧的开始，`keep`（正在看的那个）永不释放。
 * @param {string[]} liveIds 仍有 iframe 的 homeId，**从最旧到最新**（LRU 顺序）
 * @param {{ limit?: number, keep?: string[] }} opts
 * @returns {string[]} 需要释放的 homeId（最旧的在前）
 */
export function planFrameEviction(liveIds, { limit = DEFAULT_MAX_LIVE_FRAMES, keep = [] } = {}) {
  const list = (liveIds || []).filter(Boolean);
  if (!Number.isInteger(limit) || limit < 1) return []; // 非法预算 → 不动（宁可留着，也不要误伤正在看的面板）
  const over = list.length - limit;
  if (over <= 0) return [];
  const protectedIds = new Set((keep || []).filter(Boolean));
  // 正在看的面板占一个名额但不参与淘汰：可淘汰数可能少于超出的数量，此时**只释放能做到的那些**，
  // 而不是回头去动 keep（那会让用户当前页面白屏）。
  return list.filter((id) => !protectedIds.has(id)).slice(0, over);
}
