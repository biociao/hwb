import { logger } from '../lib/logger.js';

const log = logger('live-status');

// 会话状态独立于文件索引/SSH 退避；每个实例独立调度。
export class LiveStatusPoller {
  constructor({ store, homes, read, broadcast = () => {}, intervalMs = 3000 }) {
    Object.assign(this, { store, homes, read, broadcast, intervalMs });
    this.pending = new Map();
    // homeId -> 上一次失败的原因（用于「同 home 同原因只记一次」的去重，成功即清除）。
    this.writeErrors = new Map();
    this.timer = null;
    this.running = false;
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
      for (const home of homes) {
        try {
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
    const work = Promise.resolve().then(() => this.read(home)).then((live) => {
      if (!this.running || !Array.isArray(live) || !this.store.getHome(homeId)) return;
      if (this.store.getHome(homeId).activeEndpointId !== home.activeEndpointId) return;
      this.store.applyLiveStatus(homeId, live);
      this.writeErrors.delete(homeId);
      this.broadcast('index:updated', { homeId, source: 'live', sessionCount: live.length });
    }).catch((error) => {
      // 写失败必须在**默认级别**可见：默认 level=info，原先这里记 debug ⇒ 日志环里只剩
      // 「实时会话同步成功」，而库里一行都没写进去（审查实测：一行脏数据让整批回滚，
      // committed rows = 0，界面继续显示上一轮的**错**状态，home 也不 degraded）。
      // 轮询每 3s 一次，所以按「同 home 同原因」去重，成功一次即复位（见上面的 delete）。
      const reason = error?.message ?? String(error);
      const key = `${homeId}|${reason}`;
      if (this.writeErrors.get(homeId) !== key) {
        this.writeErrors.set(homeId, key);
        log.warn('实时状态写入失败（该实例的状态不会被更新）', { homeId, error: reason });
      }
    }).finally(() => this.pending.delete(homeId));
    this.pending.set(homeId, work);
    return work;
  }
}
