import { homeIdOf } from '../lib/read-home.js';
import { indexHome, indexRemoteHome } from './reader.js';
import { logger } from '../lib/logger.js';

const log = logger('indexer');

const DOMAINS = ['workspace', 'projcache', 'modelTier', 'credentials'];

// Data Index Loop (§6): 60s baseline, failure ×2 capped at 5min,
// consecutive successes ÷1.5 back toward baseline.
// 同时索引【本地 + 远程】实例：本地走 fs（readHome），远程走 SSH 只读 cat（readHomeRemote），
// 使远程 dsh 实例的「当前项目/当前会话」也能入库并出现在工作台（§6/§7 语义扩展）。
export class Indexer {
  // `homes` 返回完整实例列表（含 homeId/homePath/hostType/host/remoteHome），`remoteExec` 可注入测试用假 SSH。
  constructor({ store, homes, broadcast = () => {}, baseMs = 60_000, maxMs = 300_000, remoteExec }) {
    this.store = store;
    this.homes = homes;
    this.broadcast = broadcast;
    this.remoteExec = remoteExec;
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
    for (const home of this.homes()) {
      const homeId = home.homeId || homeIdOf(home.homePath);
      if (onlyHomeId && homeId !== onlyHomeId) continue;
      try {
        // 按 hostType 分流：远程经 SSH 只读索引，本地走 fs。
        const { snapshot, rows } = home.hostType === 'remote'
          ? await indexRemoteHome(this.store, home, this.remoteExec)
          : indexHome(this.store, home.homePath);
        const failed = DOMAINS.every((d) => snapshot.degraded.some((x) => x.domain === d));
        const payload = {
          homeId,
          rowCount: rows.length,
          sessionCount: snapshot.sessions.length,
          workspaceCount: snapshot.workspaces.length,
          degraded: snapshot.degraded,
          indexedAt: snapshot.generatedAt,
        };
        if (failed) {
          log.warn('索引失败：全部域降级', { homeId, homePath: home.homePath, host: home.host, degraded: snapshot.degraded });
        } else if (snapshot.degraded.length) {
          log.debug('部分域降级（其余照常索引）', { homeId, degraded: snapshot.degraded });
        }
        this.broadcast('index:updated', payload);
        results.push({ homeId, ok: !failed, ...payload });
      } catch (e) {
        this.store.markHomeError(homeId, e.message);
        log.error('索引该 home 失败', e, { homeId, host: home.host, homePath: home.homePath });
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
