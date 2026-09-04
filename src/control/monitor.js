import { existsSync } from 'node:fs';
import { httpProbe } from './prober.js';
import { InstanceRegistry } from './registry.js';

// 控制循环（M6 §6）：30s 心跳，探测进程存活/端口响应/隧道健康，推进状态机并广播。
// 状态机（§5.2）：unknown → probing → running → degraded（退避重连）→ stopped/gone。
// 前端运行时词汇：running / unreachable(=degraded) / stopped / gone。
const PHASE_RUNTIME = {
  unknown: 'unknown',
  probing: 'probing',
  running: 'running',
  degraded: 'unreachable',
  stopped: 'stopped',
  gone: 'gone',
};

export class Monitor {
  constructor({ store, launcher, registry = new InstanceRegistry(), broadcast = () => {}, probe = httpProbe, exists = existsSync, intervalMs = 30_000 }) {
    this.store = store;
    this.launcher = launcher;
    this.registry = registry;
    this.broadcast = broadcast;
    this.probe = probe;
    this.exists = exists;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.running = false;
    this.degradedTimers = new Map(); // homeId -> 重连 timeout
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.#tick();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const t of this.degradedTimers.values()) clearTimeout(t);
    this.degradedTimers.clear();
  }

  // 映射到前端 runtime 形状（h.runtime.*）。unknown 未探测过 → 显示 stopped。
  get(homeId) {
    const e = this.registry.get(homeId);
    const runtime = e.phase === 'unknown' ? 'stopped' : (PHASE_RUNTIME[e.phase] ?? e.phase);
    return {
      runtime,
      url: e.url,
      port: e.port,
      pid: e.pid,
      deeplink: e.deeplink,
    };
  }

  checkNow() {
    return this.#checkAll();
  }

  refresh(homeId) {
    return this.#check(homeId, this.store.getHome(homeId));
  }

  #tick() {
    this.#checkAll().finally(() => {
      if (!this.running) return;
      this.timer = setTimeout(() => this.#tick(), this.intervalMs);
      this.timer.unref?.();
    });
  }

  async #checkAll() {
    for (const home of this.store.listHomes()) {
      this.registry.seed(home.homeId);
      await this.#check(home.homeId, home);
    }
    for (const e of this.registry.list()) {
      if (!this.store.getHome(e.homeId)) {
        this.registry.delete(e.homeId);
        this.#clearReconnect(e.homeId);
        this.broadcast('instance:status', { homeId: e.homeId, runtime: 'removed' });
      }
    }
  }

  async #check(homeId, home) {
    if (!home) return this.registry.get(homeId);
    const prev = this.registry.seed(homeId);
    let phase;
    let patch = {};

    const gone = home.hostType !== 'remote' && !this.exists(home.homePath);
    const inst = gone ? null : this.launcher.status(homeId);
    if (gone) {
      phase = 'gone';
    } else if (!inst) {
      phase = 'stopped';
      patch = { url: null, port: null, pid: null, deeplink: false };
    } else {
      const ok = await this.probe(inst.url);
      patch = { url: inst.url, port: inst.port, pid: inst.pid, deeplink: inst.deeplink };
      phase = ok ? 'running' : 'degraded';
    }

    const attempts = phase === 'degraded' ? prev.attempts + 1 : 0;
    const next = this.registry.set(homeId, { phase, attempts, ...patch });
    if (prev.phase !== next.phase || prev.url !== next.url || prev.port !== next.port) {
      this.broadcast('instance:status', {
        homeId,
        runtime: PHASE_RUNTIME[next.phase] ?? next.phase,
        url: next.url,
        port: next.port,
        pid: next.pid,
        deeplink: next.deeplink,
      });
    }

    if (phase === 'degraded') this.#scheduleReconnect(homeId);
    else this.#clearReconnect(homeId);
    return next;
  }

  // §5.2/§5.3：degraded 时按退避（1/2/4/8/16/30s）安排一次更快的重连再探测。
  #scheduleReconnect(homeId) {
    if (this.degradedTimers.has(homeId)) return;
    const ms = this.registry.nextBackoffMs(homeId);
    const t = setTimeout(() => {
      this.degradedTimers.delete(homeId);
      this.refresh(homeId);
    }, ms);
    t.unref?.();
    this.degradedTimers.set(homeId, t);
  }

  #clearReconnect(homeId) {
    const t = this.degradedTimers.get(homeId);
    if (t) {
      clearTimeout(t);
      this.degradedTimers.delete(homeId);
    }
  }
}
