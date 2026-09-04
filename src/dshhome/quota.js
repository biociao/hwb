import { readCredentials, queryBalance } from '../lib/balance.js';

// 额度服务（§8）：TTL 缓存 60s，批量异步，绝不阻塞仪表盘。
// list() 只返回缓存（首屏可能为空）；stale 时后台刷新完成后广播 quota:updated。
export class QuotaService {
  constructor({ store, broadcast = () => {}, fetchImpl = fetch, ttlMs = 60_000 }) {
    this.store = store;
    this.broadcast = broadcast;
    this.fetchImpl = fetchImpl;
    this.ttlMs = ttlMs;
    this.cache = new Map(); // `${homeId}:${ref}` -> { at, homeId, ref, provider, remaining?, currency?, error? }
    this.pending = null;
  }

  list() {
    const rows = [...this.cache.values()].map(({ at, ...r }) => ({ ...r, queriedAt: new Date(at).toISOString() }));
    if (this.#hasStale()) this.refresh().catch(() => {});
    return rows;
  }

  #hasStale() {
    const now = Date.now();
    for (const { at } of this.cache.values()) {
      if (now - at > this.ttlMs) return true;
    }
    return this.cache.size === 0 && this.store.listHomes().length > 0;
  }

  // 单flight：并发调用共享同一次刷新。
  refresh() {
    if (this.pending) return this.pending;
    this.pending = this.#refreshAll().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  async #refreshAll() {
    const tasks = [];
    for (const home of this.store.listHomes()) {
      const creds = new Map(readCredentials(home.homePath).map((c) => [c.ref, c.key]));
      for (const p of home.providers) {
        const key = creds.get(p.ref);
        const id = `${home.homeId}:${p.ref}`;
        tasks.push(
          (key ? queryBalance({ provider: p.provider, key }, this.fetchImpl) : { provider: p.provider, error: 'key not found' })
            .then((r) => {
              // key 绝不进缓存/广播（§11）
              this.cache.set(id, { at: Date.now(), homeId: home.homeId, ref: p.ref, ...r });
            })
        );
      }
    }
    await Promise.allSettled(tasks);
    this.broadcast('quota:updated', { count: this.cache.size });
    return this.listFresh();
  }

  listFresh() {
    return [...this.cache.values()].map(({ at, ...r }) => ({ ...r, queriedAt: new Date(at).toISOString() }));
  }
}
