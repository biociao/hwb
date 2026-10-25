import { logger } from '../lib/logger.js';

const log = logger('live-status');

// 会话状态独立于文件索引/SSH 退避；每个实例独立调度。
//
// —— 轮询节奏（2026-09-22，dgx21.tun 实测后改为自适应）——
//
// 原实现是全局固定 3s 的 setInterval。对本地实例（一次 RPC 约 1ms）这没问题，
// 但对**远程隧道实例**它是自伤：一次 session.list 实测要 3.4–7.3s（129 KB 过隧道），
// 3s 的节奏意味着下一轮在上一轮还没回来时就到点了 —— 单飞（pending 去重）挡住了并发，
// 但结果是每一轮都在「刚失败/刚超时」的状态下重新起跑，日志里成功与失败交替刷屏，
// 实例长期停在 degraded，界面的「实时状态」几乎从不生效。
//
// 现在按**实测往返**自适应：一轮花得越久，下一轮等得越久（至少 intervalMs，
// 至多 maxIntervalMs），成功得快就回到基线。这样：
//   · 本地实例：仍按 intervalMs（3s）轮询，行为不变；
//   · 远程慢链路：自动降到 ~15–30s 一轮，把链路让给用户真正在等的请求
//     （打开实例、翻历史），而不是让后台轮询去抢带宽。
// 失败时指数退避（对齐文件索引的退避语义），成功一次即复位。
const DEFAULT_MAX_INTERVAL_MS = 30_000;

export class LiveStatusPoller {
  constructor({ store, homes, read, broadcast = () => {}, intervalMs = 3000, maxIntervalMs = DEFAULT_MAX_INTERVAL_MS, adaptive = true } = {}) {
    Object.assign(this, { store, homes, read, broadcast, intervalMs, maxIntervalMs, adaptive });
    this.pending = new Map();
    // homeId -> 上一次失败的原因（用于「同 home 同原因只记一次」的去重，成功即清除）。
    this.writeErrors = new Map();
    // homeId -> { nextAt, failures }：自适应节奏的每实例状态。
    this.cadence = new Map();
    this.timer = null;
    this.running = false;
  }

  // 该实例此刻是否到点了（没有记录 = 首次，立即跑）。
  #due(homeId, now) {
    const c = this.cadence.get(homeId);
    return !c || now >= c.nextAt;
  }

  // 记录一轮的结果，算出下一轮的间隔。
  // 成功：间隔取「本轮耗时 × 2」，夹在 [intervalMs, maxIntervalMs] —— 保证下一轮
  // 在上一轮回来后还有余量，不会立刻撞上；失败：在上一轮间隔上翻倍退避（同样有上界）。
  #schedule(homeId, ok, elapsedMs) {
    const prev = this.cadence.get(homeId) ?? { interval: this.intervalMs, failures: 0 };
    let interval;
    let failures = prev.failures;
    if (ok) {
      failures = 0;
      interval = this.adaptive
        ? Math.min(this.maxIntervalMs, Math.max(this.intervalMs, Math.round(elapsedMs * 2)))
        : this.intervalMs;
    } else {
      failures += 1;
      interval = Math.min(this.maxIntervalMs, Math.max(this.intervalMs, prev.interval * 2));
    }
    this.cadence.set(homeId, { interval, failures, nextAt: Date.now() + interval });
    return interval;
  }

  start() {
    if (this.running) return;
    this.running = true;
    const tick = () => {
      // 这里的 listHomes() 是同步的，跑在 setInterval 回调里 —— 一旦抛错（例如数据库里某行
      // 的 JSON 列坏了），它会直接变成 uncaughtException：crash handler 走 process.exit(1)，
      // 整个工作台消失且没有任何界面提示。轮询失败只该跳过这一轮。
      let homes;
      try {
        homes = this.homes();
      } catch (error) {
        log.warn('实时轮询读取实例列表失败（本轮跳过）', { error: error?.message ?? String(error) });
        return;
      }
      if (!Array.isArray(homes)) {
        log.warn('实时轮询读到非数组的实例列表（本轮跳过）', { type: typeof homes });
        return;
      }
      // 注意：refresh() 在拿不到 home 对象时**还会再读一次** homes()（用来取端点信息），
      // 那一次抛错同样落在这个同步段里 —— 上面只兜住了第一次调用。实测：让 homes() 第二次调用抛错，
      // start() 会直接抛出，进而被 crash handler 变成 process.exit(1)。
      // 所以逐个 refresh 也要兜住，失败只跳过该实例。
      //
      // 这里**把已经拿到的 home 对象传进去**（而不是 homeId）：原先每个实例都要再跑一次
      // `this.homes()`，而那是 `store.listHomes()` —— 带两个相关子查询 COUNT + 每实例一次
      // #enrichHome（providers / activeTier / currentSession）。规模审查实测 200 个实例时，
      // 单是这 200 次冗余调用就 **3,868.9ms**/轮（同步阻塞），并发探针最大停顿 4,936.7ms；
      // 首轮更是 185.8s。传入 home 之后每轮只读一次实例列表。
      const now = Date.now();
      for (const home of homes) {
        try {
          // 自适应节奏：没到点的实例本轮跳过（慢链路实例不会每 3s 被叫醒一次）。
          if (!this.#due(home?.homeId, now)) continue;
          this.refresh(home);
        } catch (error) {
          log.warn('实时轮询刷新单个实例失败（跳过该实例）', {
            homeId: home?.homeId, error: error?.message ?? String(error),
          });
        }
      }
    };
    tick();
    this.timer = setInterval(tick, this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    this.running = false;
    clearInterval(this.timer);
    this.timer = null;
  }

  // 接受 home 对象（tick 里已经有）或 homeId（API 路由/测试）。传对象可以省掉一次
  // `listHomes()`（O(实例数) 的同步查询），见 start() 里的注释。
  refresh(homeOrId) {
    const homeId = typeof homeOrId === 'string' ? homeOrId : homeOrId?.homeId;
    if (!homeId) return Promise.resolve();
    if (this.pending.has(homeId)) return this.pending.get(homeId);
    let home = typeof homeOrId === 'string' ? null : homeOrId;
    if (!home) {
      // 同上：这次 homes() 在 refresh 里是同步调用，抛错会直接冒到调用方（API 路由或 tick 的
      // 同步段）。这里自己兜住，返回一个已完成的 promise，保持 refresh 的返回契约。
      try {
        const list = this.homes();
        home = Array.isArray(list) ? list.find((h) => h.homeId === homeId) : null;
      } catch (error) {
        log.warn('实时轮询读取实例列表失败（本次刷新跳过）', { homeId, error: error?.message ?? String(error) });
        return Promise.resolve();
      }
    }
    if (!home) return Promise.resolve();
    const startedAt = Date.now();
    const work = Promise.resolve().then(() => this.read(home)).then((live) => {
      // 一次点查就够：两行之间没有 await（getHome 是同步的），所以第二次读到的必然是同一个值 ——
      // 原先每轮每实例多花一次 `getHome`，而它在大库上是真实成本（规模审查实测：单个 400k 会话的
      // home 上 `getHome` 要 32.6ms，而这个函数每轮每实例都会被调用）。
      const current = this.store.getHome(homeId);
      // 自适应节奏：这一轮无论成败都要排下一轮。读失败（live 为 null）也要退避 ——
      // 否则慢链路上每一轮都白跑一次，既刷日志又抢带宽。
      if (!this.running) return;
      const ok = Array.isArray(live) && !!current;
      const interval = this.#schedule(homeId, ok, Date.now() - startedAt);
      if (!ok) {
        log.debug('实时状态本轮未取到（按自适应节奏退避）', { homeId, nextInMs: interval });
        return;
      }
      if (current.activeEndpointId !== home.activeEndpointId) return;
      this.store.applyLiveStatus(homeId, live);
      this.writeErrors.delete(homeId);
      this.broadcast('index:updated', { homeId, source: 'live', sessionCount: live.length });
    }).catch((error) => {
      // 写失败必须在**默认级别**可见：默认 level=info，原先这里记 debug ⇒ 日志环里只剩
      // 「实时会话同步成功」，而库里一行都没写进去（审查实测：一行脏数据让整批回滚，
      // committed rows = 0，界面继续显示上一轮的**错**状态，home 也不 degraded）。
      // 按「同 home 同原因」去重，成功一次即复位（见上面的 delete）。
      const reason = error?.message ?? String(error);
      const key = `${homeId}|${reason}`;
      if (this.writeErrors.get(homeId) !== key) {
        this.writeErrors.set(homeId, key);
        log.warn('实时状态写入失败（该实例的状态不会被更新）', { homeId, error: reason });
      }
      // 抛到这里说明是写入/库侧异常，同样要排下一轮（否则该实例会被永久跳过）。
      this.#schedule(homeId, false, Date.now() - startedAt);
    }).finally(() => this.pending.delete(homeId));
    this.pending.set(homeId, work);
    return work;
  }
}
