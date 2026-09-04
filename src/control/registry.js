// —— 实例注册表（M6·控制平面状态机）——
// 为每个 instance 维护唯一权威的控制状态：phase（unknown/probing/running/degraded/
// crashed/stopped）+ web/tunnel 的端口、pid、URL，以及 degraded 重连的退避计数。
// 前端通过 monitor.get 映射到 runtime 形状；launcher 打开/关闭时写入。

export const PHASES = ['unknown', 'probing', 'running', 'degraded', 'crashed', 'stopped'];

const BACKOFF = [1, 2, 4, 8, 16, 30]; // degraded 重连退避（秒），封顶 30s

export class InstanceRegistry {
  constructor() {
    this.entries = new Map(); // homeId -> entry
  }

  #base(homeId) {
    return {
      homeId,
      phase: 'unknown',
      url: null,
      port: null,
      pid: null,
      deeplink: false,
      tunnel: null, // { localPort, sshPid, host, remotePort }
      attempts: 0,
      lastError: null,
      updatedAt: Date.now(),
    };
  }

  seed(homeId) {
    if (!this.entries.has(homeId)) this.entries.set(homeId, this.#base(homeId));
    return this.entries.get(homeId);
  }

  get(homeId) {
    return this.entries.get(homeId) ?? this.#base(homeId);
  }

  has(homeId) {
    return this.entries.has(homeId);
  }

  set(homeId, patch) {
    const cur = this.entries.has(homeId) ? this.entries.get(homeId) : this.#base(homeId);
    const next = { ...cur, ...patch, updatedAt: Date.now() };
    this.entries.set(homeId, next);
    return next;
  }

  delete(homeId) {
    this.entries.delete(homeId);
  }

  list() {
    return [...this.entries.values()];
  }

  // —— 状态机推进（§5.2）——
  // probeResult: { ok: boolean, url?, port?, pid?, deeplink?, alive? }
  applyProbe(homeId, probeResult) {
    const cur = this.seed(homeId);
    const { ok, url, port, pid, deeplink, alive } = probeResult;
    let next;

    if (!ok) {
      // 隧道/进程不可用 → degraded，退避计数递增；持续失败封顶 crashed。
      if (cur.phase === 'running' || cur.phase === 'degraded') {
        next = { phase: 'degraded', attempts: cur.attempts + 1 };
      } else {
        next = { phase: 'stopped', attempts: 0 };
      }
    } else {
      next = {
        phase: 'running',
        attempts: 0,
        lastError: null,
        ...(url !== undefined && { url }),
        ...(port !== undefined && { port }),
        ...(pid !== undefined && { pid }),
        ...(deeplink !== undefined && { deeplink }),
      };
    }
    if (cur.lastError) next.lastError = cur.lastError;
    return this.set(homeId, next);
  }

  // degraded 的下一次重连延迟（秒），按 §5.2 退避 1/2/4/8/16/30。
  nextBackoffMs(homeId) {
    const cur = this.get(homeId);
    const sec = BACKOFF[Math.min(Math.max(cur.attempts - 1, 0), BACKOFF.length - 1)];
    return sec * 1000;
  }
}

export { BACKOFF };
