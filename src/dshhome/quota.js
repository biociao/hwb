import { readCredentials, queryBalance } from '../lib/balance.js';
import { logger } from '../lib/logger.js';

const log = logger('quota');

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
    // 「上次刷新的时间」必须独立记录，不能靠遍历缓存条目推断 —— 见 #hasStale 的注释。
    this.lastRefreshAt = 0;
  }

  list() {
    this.#evictRemovedHomes();
    const rows = [...this.cache.values()].map(({ at, ...r }) => ({ ...r, queriedAt: new Date(at).toISOString() }));
    if (this.#hasStale()) this.refresh().catch(() => {});
    return rows;
  }

  // 实例被删除后，它的额度条目没有任何人会来清 —— 会一直返回给客户端；
  // 而且因为那条记录的时间戳永远是旧的，每次 list() 都会再触发一次全量刷新 + SSE 广播。
  #evictRemovedHomes() {
    if (this.cache.size === 0) return;
    const alive = new Set(this.store.listHomes().map((h) => h.homeId));
    for (const [key, entry] of this.cache) {
      if (!alive.has(entry.homeId)) this.cache.delete(key);
    }
  }

  #hasStale() {
    const now = Date.now();
    for (const { at } of this.cache.values()) {
      if (now - at > this.ttlMs) return true;
    }
    // 「缓存为空」原先被当成「永远 stale」：只要实例在但一个 provider 都没有（很常见 ——
      // 没配 .credentials.yaml），缓存就永远是空的，于是**每一次** GET /api/quota 都会再来一轮
      // 刷新 + 广播 quota:updated。客户端若把 quota:updated 映射回 /api/quota 就是死循环。
    // 改为：只要距上次刷新还在 TTL 内就不再刷，与缓存里有没有条目无关。
    if (now - this.lastRefreshAt > this.ttlMs) return true;
    return false;
  }

  // 单flight：并发调用共享同一次刷新。
  refresh() {
    if (this.pending) return this.pending;
    this.pending = this.#refreshAll()
      .finally(() => {
        // 无论成功失败都记录时间：否则一次持续失败会让每个 GET 都再触发一轮刷新。
        this.lastRefreshAt = Date.now();
        this.pending = null;
      });
    return this.pending;
  }

  async #refreshAll() {
    const tasks = [];
    for (const home of this.store.listHomes()) {
      // 单个 home 的凭据读取失败（权限、异常文件）也要隔离：否则整批额度都刷不出来。
      let creds = new Map();
      try {
        creds = new Map(readCredentials(home.homePath).map((c) => [c.ref, c.key]));
      } catch (e) {
        log('读取凭据失败，跳过该实例', { homeId: home.homeId, error: e?.message });
      }
      for (const p of home.providers) {
        const key = creds.get(p.ref);
        const id = `${home.homeId}:${p.ref}`;
        // 必须 Promise.resolve 包一层：`key` 缺失时右侧是一个**普通对象**（没有 .then），
        // 直接 `.then(...)` 会抛 TypeError，而且是在循环里同步抛 —— 整批 provider（含其它 home）
        // 一个都进不了缓存，quota:updated 也不会广播。而「有 provider 行、但凭据里没有对应 key」
        // 恰恰是很常见的状态（key 还没配 / 换了 ref 名）。
        tasks.push(
          Promise.resolve(
            key ? queryBalance({ provider: p.provider, key }, this.fetchImpl) : { provider: p.provider, error: 'key not found' }
          ).then((r) => {
            // key 绝不进缓存/广播（§11）
            this.cache.set(id, { at: Date.now(), homeId: home.homeId, ref: p.ref, ...r });
          }, (e) => {
            // 单个 provider 的意外失败不该拖垮整批
            this.cache.set(id, { at: Date.now(), homeId: home.homeId, ref: p.ref, provider: p.provider, error: '余额查询失败' });
            log('provider 额度刷新失败', { homeId: home.homeId, ref: p.ref, error: e?.message });
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
