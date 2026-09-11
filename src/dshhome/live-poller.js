import { logger } from '../lib/logger.js';

const log = logger('live-status');

// 会话状态独立于文件索引/SSH 退避；每个实例独立调度。
export class LiveStatusPoller {
  constructor({ store, homes, read, broadcast = () => {}, intervalMs = 3000 }) {
    Object.assign(this, { store, homes, read, broadcast, intervalMs });
    this.pending = new Map();
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
      for (const home of homes) this.refresh(home.homeId);
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

  refresh(homeId) {
    if (this.pending.has(homeId)) return this.pending.get(homeId);
    const home = this.homes().find((h) => h.homeId === homeId);
    if (!home) return Promise.resolve();
    const work = Promise.resolve().then(() => this.read(home)).then((live) => {
      if (!this.running || !Array.isArray(live) || !this.store.getHome(homeId)) return;
      if (this.store.getHome(homeId).activeEndpointId !== home.activeEndpointId) return;
      this.store.applyLiveStatus(homeId, live);
      this.broadcast('index:updated', { homeId, source: 'live', sessionCount: live.length });
    }).catch((error) => {
      log.debug('实时会话刷新失败', { homeId, error: error.message });
    }).finally(() => this.pending.delete(homeId));
    this.pending.set(homeId, work);
    return work;
  }
}
