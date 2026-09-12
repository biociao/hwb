import { existsSync } from 'node:fs';
import { probeAlive } from './prober.js';
import { InstanceRegistry } from './registry.js';
import { logger } from '../lib/logger.js';

const log = logger('monitor');

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

// status() 每次返回新对象，按连接属性识别同一连接，而非比较对象引用。
function connectionKey(home, inst, gone) {
  return JSON.stringify([home.hostType, home.homePath, gone, inst?.url, inst?.port, inst?.pid, inst?.kind]);
}

export class Monitor {
  // probe 默认用 probeAlive（鉴权感知）而不是 httpProbe：心跳判的是「用户点开这个入口能不能用」，
  // token 失效时入口回 401，`status < 500` 会把它算成 running（实测：只有 401 的端点被报 running，
  // latencyMs 7，而 iframe 是栅栏页）。「端口上有没有东西在听」那类判断仍用 httpProbe。
  constructor({ store, launcher, registry = new InstanceRegistry(), broadcast = () => {}, probe = probeAlive, exists = existsSync, intervalMs = 30_000 }) {
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
    this.checks = new Map(); // homeId -> 当前连接正在进行的探测，合并手动刷新与心跳。
    this.health = new Map(); // homeId -> 当前连接的成功记录与连续失败次数。
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
      checkedAt: e.checkedAt ?? null,
      latencyMs: e.latencyMs ?? null,
      url: e.url,
      iframeUrl: e.iframeUrl,
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
    // #checkAll 里任何一处抛错（store 查询、launcher 状态、broadcast）都会让 .finally() 返回的
    // promise 变成未处理的拒绝：既污染日志（crash handler 记成 fatal），又掩盖真正的原因。
    // 心跳本身必须能扛住单次失败继续跑。
    this.#checkAll().catch((e) => {
      log.warn('实例心跳检查失败（本轮跳过，下一轮重试）', { error: e?.message ?? String(e) });
    }).finally(() => {
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
    this.broadcast('monitor:updated', {});
    for (const e of this.registry.list()) {
      if (!this.store.getHome(e.homeId)) {
        // 删除路径的兜底清理；显式删除 API 会先 disconnect，避免等待下次心跳。
        // :switch 是 Launcher 尚未提交的端点候选，不属于已删除实例。
        // release=true：实例已从 store 消失，受管子进程必须回收，不能只标记 detached。
        if (!e.homeId.endsWith(':switch')) await this.launcher.disconnect?.({ homeId: e.homeId }, { release: true });
        this.registry.delete(e.homeId);
        this.checks.delete(e.homeId);
        this.health.delete(e.homeId);
        this.#clearReconnect(e.homeId);
        log.info('实例已移除', { homeId: e.homeId });
        this.broadcast('instance:status', { homeId: e.homeId, runtime: 'removed' });
      }
    }
  }

  #check(homeId, home) {
    if (!home) {
      this.checks.delete(homeId);
      this.health.delete(homeId);
      this.#clearReconnect(homeId);
      return Promise.resolve(this.registry.get(homeId));
    }
    const prev = this.registry.seed(homeId);
    const gone = home.hostType !== 'remote' && !this.exists(home.homePath);
    const inst = gone ? null : this.launcher.status(homeId);
    const key = connectionKey(home, inst, gone);
    const pending = this.checks.get(homeId);
    if (pending?.key === key && pending.prev === prev) return pending.promise;

    const check = { key, prev };
    // 先登记，再执行：无连接的同步分支也必须能使旧探测失效。
    check.promise = Promise.resolve().then(() => this.#runCheck(homeId, home, inst, gone, check)).finally(() => {
      if (this.checks.get(homeId) === check) this.checks.delete(homeId);
    });
    this.checks.set(homeId, check);
    return check.promise;
  }

  async #runCheck(homeId, home, inst, gone, check) {
    if (this.checks.get(homeId) !== check) return this.checks.get(homeId)?.promise ?? this.registry.get(homeId);
    const currentHome = this.store.getHome(homeId);
    const currentGone = currentHome && currentHome.hostType !== 'remote' && !this.exists(currentHome.homePath);
    const currentInst = currentGone ? null : this.launcher.status(homeId);
    if (this.registry.get(homeId) !== check.prev || !currentHome
      || connectionKey(currentHome, currentInst, currentGone) !== check.key) return this.#check(homeId, currentHome);
    const { prev, key } = check;
    let phase;
    let patch = {};
    let health = this.health.get(homeId);
    // Launcher 也写入 registry；即使 URL 被复用，断开/切换后的新连接也不能沿用旧成功记录。
    if (health?.key !== key || health.entry !== prev) health = { key, confirmed: false, failures: 0 };
    if (gone) {
      phase = 'gone';
    } else if (!inst) {
      phase = 'stopped';
      patch = { url: null, iframeUrl: null, port: null, pid: null, deeplink: false };
    } else if (inst.recovering) {
      // SSH 已退出时由 Launcher 有界重连；保留旧入口，使前端等待新地址而非关闭页面。
      phase = 'degraded';
      patch = { url: inst.url, iframeUrl: inst.iframeUrl, port: inst.port, pid: inst.pid, deeplink: inst.deeplink };
    } else {
      const started = Date.now();
      const ok = await Promise.resolve().then(() => this.probe(inst.url, home.hostType === 'remote' ? 10_000 : 3000)).catch(() => false);
      const latestHome = this.store.getHome(homeId);
      const latestGone = latestHome && latestHome.hostType !== 'remote' && !this.exists(latestHome.homePath);
      const latestInst = latestGone ? null : this.launcher.status(homeId);
      // 旧连接响应不得覆盖断开、端点切换或更新的探测，也不得累计到新连接的失败次数。
      if (this.checks.get(homeId) !== check) return this.checks.get(homeId)?.promise ?? this.registry.get(homeId);
      if (this.registry.get(homeId) !== prev || !latestHome
        || connectionKey(latestHome, latestInst, latestGone) !== key) {
        return this.#check(homeId, latestHome);
      }
      patch = { latencyMs: ok ? Date.now() - started : null, url: inst.url, iframeUrl: inst.iframeUrl, port: inst.port, pid: inst.pid, deeplink: inst.deeplink };
      health = { ...health, confirmed: health.confirmed || ok, failures: ok ? 0 : health.failures + 1 };
      // 仅对已成功探测的远程连接容忍短暂拥塞；冷启动失败仍立即不可达。
      phase = ok || (home.hostType === 'remote' && health.confirmed && health.failures < 3) ? 'running' : 'degraded';
    }

    const attempts = phase === 'degraded' ? (health.entry === prev ? prev.attempts : 0) + 1 : 0;
    const next = this.registry.set(homeId, { phase, attempts, checkedAt: new Date().toISOString(), latencyMs: null, ...patch });
    if (inst) this.health.set(homeId, { ...health, entry: next });
    else this.health.delete(homeId);
    if (prev.phase !== next.phase || prev.url !== next.url || prev.iframeUrl !== next.iframeUrl || prev.port !== next.port) {
      // 仅在状态迁移/URL 变化时记录，避免每 30s 心跳刷屏。
      if (next.phase === 'degraded') {
        log.warn('实例降级（unreachable），安排退避重连', {
          homeId, prev: prev.phase, phase: next.phase, attempts,
          backoffMs: this.registry.nextBackoffMs(homeId), url: next.url, lastError: next.lastError,
        });
      } else if (next.phase === 'running' && prev.phase === 'degraded') {
        log.info('实例恢复可用', { homeId, prev: prev.phase, phase: next.phase, url: next.url });
      } else {
        log.debug('实例状态变更', { homeId, prev: prev.phase, phase: next.phase, url: next.url });
      }
      this.broadcast('instance:status', {
        homeId,
        runtime: PHASE_RUNTIME[next.phase] ?? next.phase,
        url: next.url,
        iframeUrl: next.iframeUrl,
        port: next.port,
        pid: next.pid,
        deeplink: next.deeplink,
      });
    }

    if (phase === 'degraded' && !inst?.recovering) this.#scheduleReconnect(homeId);
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
