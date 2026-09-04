import { homeIdOf } from '../lib/read-home.js';
import { indexHome } from './reader.js';

const DOMAINS = ['workspace', 'projcache', 'modelTier', 'credentials'];

// Data Index Loop (§6): 60s baseline, failure ×2 capped at 5min,
// consecutive successes ÷1.5 back toward baseline.
export class Indexer {
  constructor({ store, homePaths, broadcast = () => {}, baseMs = 60_000, maxMs = 300_000 }) {
    this.store = store;
    this.homePaths = homePaths;
    this.broadcast = broadcast;
    this.baseMs = baseMs;
    this.maxMs = maxMs;
    this.intervalMs = baseMs;
    this.timer = null;
    this.running = false;
    this.current = null;
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
  }

  reindexNow(homeId = null) {
    return this.#run(homeId);
  }

  #tick() {
    this.#run().finally(() => {
      if (!this.running) return;
      this.timer = setTimeout(() => this.#tick(), this.intervalMs);
      this.timer.unref?.();
    });
  }

  #run(onlyHomeId = null) {
    if (this.current) return this.current;
    this.current = this.#runAll(onlyHomeId).finally(() => {
      this.current = null;
    });
    return this.current;
  }

  async #runAll(onlyHomeId) {
    const results = [];
    for (const homePath of this.homePaths()) {
      const homeId = homeIdOf(homePath);
      if (onlyHomeId && homeId !== onlyHomeId) continue;
      try {
        const { snapshot, rows } = indexHome(this.store, homePath);
        const failed = DOMAINS.every((d) => snapshot.degraded.some((x) => x.domain === d));
        const payload = {
          homeId,
          rowCount: rows.length,
          sessionCount: snapshot.sessions.length,
          workspaceCount: snapshot.workspaces.length,
          degraded: snapshot.degraded,
          indexedAt: snapshot.generatedAt,
        };
        this.broadcast('index:updated', payload);
        results.push({ homeId, ok: !failed, ...payload });
      } catch (e) {
        this.store.markHomeError(homeId, e.message);
        results.push({ homeId, ok: false, error: e.message });
      }
    }
    const anyFailed = results.some((r) => !r.ok);
    if (anyFailed) {
      this.intervalMs = Math.min(this.intervalMs * 2, this.maxMs);
    } else {
      this.intervalMs = Math.max(this.baseMs, this.intervalMs / 1.5);
    }
    return results;
  }
}
