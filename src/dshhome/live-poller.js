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
      for (const home of this.homes()) this.refresh(home.homeId);
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
