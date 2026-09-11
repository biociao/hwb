import { homeIdOf } from '../lib/read-home.js';
import { indexHome, indexRemoteHome } from './reader.js';
import { logger } from '../lib/logger.js';

const log = logger('indexer');

const DOMAINS = ['workspace', 'projcache', 'modelTier', 'credentials'];

// Data Index Loop (§6): 60s baseline，失败 ×2 capped at 5min，连续成功 ÷1.5 回到 baseline。
// 退避按实例独立计算（per-home）：某个远程实例 SSH 失败只会拖慢它自己的节奏，
// 不会把全局间隔钉在上限、连累本地实例的 60s 基线。循环本身固定按 baseMs 节拍运行，
// 每轮只索引「到点」的实例。
// 同时索引【本地 + 远程】实例：本地走 fs（readHome），远程走 SSH 只读 cat（readHomeRemote），
// 使远程 dsh 实例的「当前项目/当前会话」也能入库并出现在工作台（§6/§7 语义扩展）。
export class Indexer {
  // `homes` 返回完整实例列表（含 homeId/homePath/hostType/host/remoteHome），`remoteExec` 可注入测试用假 SSH。
  // `liveStatus`：可选，(home) => Promise<[{sessionId,cwd,status,lastActivity,tokenUsage,title}] | null>；
  //   对「运行中且可达」的 home 读取 dsh 实例实时状态索引前抓取，覆盖冻结投影缓存推导出的状态、
  //   并补插 projcache 里还没有的新会话。任何失败（不可达/token 无效/端点缺失）都返回 null，
  //   回退到投影缓存（绝不阻塞主索引）。
  constructor({ store, homes, broadcast = () => {}, baseMs = 60_000, maxMs = 300_000, remoteExec, liveStatus = null }) {
    this.store = store;
    this.homes = homes;
    this.broadcast = broadcast;
    this.remoteExec = remoteExec;
    this.liveStatus = liveStatus;
    this.baseMs = baseMs;
    this.maxMs = maxMs;
    this.backoffMs = new Map(); // homeId -> 该实例当前间隔（失败 ×2 / 成功 ÷1.5）
    this.nextDue = new Map();   // homeId -> 下一次索引时间戳
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
    // 与 monitor 的心跳同理：#runAll 一旦抛错（例如 store 已关闭、homes() 读不到），
    // .finally() 返回的 promise 就成了未处理拒绝 —— 被 crash handler 记成 fatal 并掩盖真因。
    // 索引循环必须能扛住单轮失败继续跑。
    this.#run().catch((e) => {
      log.warn('索引轮次失败（本轮跳过，下一轮重试）', { error: e?.message ?? String(e) });
    }).finally(() => {
      if (!this.running) return;
      this.timer = setTimeout(() => this.#tick(), this.baseMs);
      this.timer.unref?.();
    });
  }

  #run(onlyHomeId = null) {
    if (this.current) {
      // 连接时的定向刷新必须在当前批次之后执行，不能被旧批次吞掉。
      return onlyHomeId ? this.current.then(() => this.#run(onlyHomeId)) : this.current;
    }
    this.current = this.#runAll(onlyHomeId).finally(() => {
      this.current = null;
    });
    return this.current;
  }

  async #runAll(onlyHomeId) {
    const results = [];
    const now = Date.now();
    for (const home of this.homes()) {
      const homeId = home.homeId || homeIdOf(home.homePath);
      if (onlyHomeId && homeId !== onlyHomeId) continue;
      // 周期索引只跑到点的实例；reindexNow（onlyHomeId）不受退避影响，立即执行。
      if (!onlyHomeId && (this.nextDue.get(homeId) ?? 0) > now) continue;
      const ok = await this.#indexHome(home, homeId, results);
      // per-home 退避：失败只拖慢自己，成功逐步回到 baseline。
      const prev = this.backoffMs.get(homeId) ?? this.baseMs;
      const next = ok ? Math.max(this.baseMs, prev / 1.5) : Math.min(prev * 2, this.maxMs);
      this.backoffMs.set(homeId, next);
      this.nextDue.set(homeId, Date.now() + next);
    }
    return results;
  }

  // 索引单个 home，结果追加到 results；返回是否成功（供 per-home 退避）。
  async #indexHome(home, homeId, results) {
    try {
      // 实时状态覆盖：仅对运行中且可达的实例抓取；失败必回退（loadLive 内部已容错）。
      let live = null;
      if (this.liveStatus && home.hostType !== 'remote') {
        try {
          live = await this.liveStatus(home);
        } catch {
          live = null;
        }
      }
      // 按 hostType 分流：远程经 SSH 只读索引，本地走 fs。live 非空时覆盖/补插会话状态。
      const { snapshot, rows } = home.hostType === 'remote'
        ? await indexRemoteHome(this.store, home, this.remoteExec, this.liveStatus ? () => this.liveStatus(home) : null)
        : indexHome(this.store, home.homePath, live);
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
      return !failed;
    } catch (e) {
      this.store.markHomeError(homeId, e.message);
      log.error('索引该 home 失败', e, { homeId, host: home.host, homePath: home.homePath });
      results.push({ homeId, ok: false, error: e.message });
      return false;
    }
  }
}
