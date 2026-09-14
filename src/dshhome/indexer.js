import { homeIdOf } from '../lib/read-home.js';
import { indexRemoteHome, readHomeSnapshot, indexSnapshot } from './reader.js';
import { logger } from '../lib/logger.js';

const log = logger('indexer');

// 同一实例的同一失败原因：首次记全（含栈），之后每 ERROR_REPEAT_MS 记一次摘要，成功即复位。
// 见 Indexer 构造器里 lastFailure 的说明（真实日志里 700 次同一句话 + 700 套栈帧）。
const ERROR_REPEAT_MS = 10 * 60_000;
function logFailure(homeId, error, fields) {
  const reason = error?.message ?? String(error);
  const prev = this.lastFailure.get(homeId);
  const now = Date.now();
  if (prev && prev.reason === reason && now - prev.at < ERROR_REPEAT_MS) return;   // 已记过，静默
  const repeated = prev && prev.reason === reason;
  this.lastFailure.set(homeId, { reason, at: now });
  if (repeated) {
    log.error('索引该 home 仍然失败（同一原因，已抑制重复日志）', null, { homeId, reason: String(reason).slice(0, 200), ...fields });
  } else {
    log.error('索引该 home 失败', error, { homeId, ...fields });
  }
}

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
  constructor({ store, homes, broadcast = () => {}, baseMs = 60_000, maxMs = 300_000, remoteExec, liveStatus = null, concurrency = 3 }) {
    this.store = store;
    this.homes = homes;
    this.broadcast = broadcast;
    this.remoteExec = remoteExec;
    this.liveStatus = liveStatus;
    this.baseMs = baseMs;
    this.maxMs = maxMs;
    this.concurrency = Math.max(1, Math.min(8, Number(concurrency) || 3)); // 同时索引的实例数上限
    this.backoffMs = new Map(); // homeId -> 该实例当前间隔（失败 ×2 / 成功 ÷1.5）
    // homeId -> 上一次失败原因 + 上次记录时间（用于**抑制重复的同一失败**的日志噪音）。
    // 为什么需要：一个长期不可达的远端（实测用户真实日志里占了大头 —— 16,334 行 hwb.log 里
    // 约 700 次同一句「读取远程 dsh home 失败(bot@cms.lo)」，每次都带一整套 async 栈帧，
    // 也就是 10 行/次、7,000 行）会把有用的信息淹掉，并让日志以 ~20 MB/h 的速度增长。
    // 同一个 home 的同一原因只在**首次**记全（含栈），之后每 ERROR_REPEAT_MS 记一次摘要行；
    // 原因变了或成功一次就复位。
    this.lastFailure = new Map();
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
    const homes = this.homes();
    // 退避状态是按 homeId 记的，实例删掉后没人来清 —— 长跑（反复增删实例）下这两个 Map
    // 会一直涨。每轮顺手丢掉已经不在实例列表里的键。
    if (this.backoffMs.size || this.nextDue.size) {
      const alive = new Set(homes.map((h) => h.homeId || homeIdOf(h.homePath)));
      for (const id of this.backoffMs.keys()) if (!alive.has(id)) this.backoffMs.delete(id);
      for (const id of this.nextDue.keys()) if (!alive.has(id)) this.nextDue.delete(id);
    }
    const due = [];
    for (const home of homes) {
      const homeId = home.homeId || homeIdOf(home.homePath);
      if (onlyHomeId && homeId !== onlyHomeId) continue;
      // 周期索引只跑到点的实例；reindexNow（onlyHomeId）不受退避影响，立即执行。
      if (!onlyHomeId && (this.nextDue.get(homeId) ?? 0) > now) continue;
      due.push({ home, homeId });
    }

    // 有限的并发：远程实例的索引要走 SSH（几秒到几十秒），串行时一个慢实例会把后面
    // 所有实例的刷新一起拖住。本地实例的读取/解析是同步的，并发对它们没有额外收益，
    // 但也不会更差（同步段之间不会被插入）。
    // 上限刻意压得很小：每条远程索引都带着一次 ssh 连接，同时开太多会打爆远端。
    const resultsByIndex = new Array(due.length);
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const i = cursor++;
        if (i >= due.length) return;
        const { home, homeId } = due[i];
        const bucket = [];
        resultsByIndex[i] = bucket;
        const ok = await this.#indexHome(home, homeId, bucket);
        // per-home 退避：失败只拖慢自己，成功逐步回到 baseline。
        const prev = this.backoffMs.get(homeId) ?? this.baseMs;
        const next = ok ? Math.max(this.baseMs, prev / 1.5) : Math.min(prev * 2, this.maxMs);
        this.backoffMs.set(homeId, next);
        this.nextDue.set(homeId, Date.now() + next);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, due.length) }, worker));
    for (const bucket of resultsByIndex) results.push(...(bucket ?? []));
    return results;
  }

  // 索引单个 home，结果追加到 results；返回是否成功（供 per-home 退避）。
  async #indexHome(home, homeId, results) {
    try {
      // 实时状态：本地实例先读文件、**再**抓实时状态。这两步的顺序很要紧 —— 反过来的话，
      // 「实时快照被取到」与「落库」之间就夹着一次完整的文件读取（远程实例是 SSH，几秒到
      // 几十秒），期间 live-poller 写进的新状态会被这边更旧的快照覆盖，界面上的状态徽标
      // 倒退一拍。把读文件放在前面之后，这段间隔里只剩等待 RPC 本身，本机实例中间不再有
      // 事件循环轮次（读文件与落库都是同步的），定时器驱动的写入插不进来。
      // 注意这**不等于**「窗口为 0」：实时抓取要等一次 RPC，若另一个更早发起的抓取恰好
      // 在这期间返回并写库，仍可能被覆盖 —— 那要靠版本号/时间戳才能根治。
      // 远程实例由 indexRemoteHome 内部自己按同样的顺序处理。
      let live = null;
      if (home.hostType === 'remote') {
        const { snapshot, rows } = await indexRemoteHome(this.store, home, this.remoteExec,
          this.liveStatus ? () => this.liveStatus(home) : null);
        return this.#finish(home, homeId, snapshot, rows, results);
      }
      // 端点守卫：和 live-poller 里那句一样（`getHome(homeId).activeEndpointId !== home.activeEndpointId`
      // 就放弃）。原先只有轮询器有这句话，索引器这条路径没有 —— 用户在索引跑动期间切换连接端点时，
      // 索引器会把**上一个端点**读到的实时数据写进库（同一个实例 id、不同的 dsh 进程）。
      // 这里在抓取前后各读一次，端点变了就丢弃这份实时数据（文件快照来自磁盘，与端点无关）。
      const endpointBefore = this.store.getHome?.(homeId)?.activeEndpointId ?? null;
      const snapshot = readHomeSnapshot(home.homePath);
      if (this.liveStatus) {
        // 抓实时状态要等一次 RPC（本机也可能几百毫秒），而 live-poller 每 3s 就在写同一批行。
        // 我们把「开始抓」的时间记下来：如果这期间轮询器已经写入更新的数据，就丢弃自己这份 ——
        // 否则索引器会拿一份**更旧**的快照把刚写进去的新状态覆盖回去（实测：dsh 报 running、
        // 轮询器刚写成「运行中」，随后索引器把它改回「空闲」；那份快照里还缺了窗口内新出现的会话，
        // 整表替换会把它们删掉，直到下一次轮询才回来）。
        const liveCaptureStartedAt = Date.now();
        try { live = await this.liveStatus(home); } catch { live = null; }
        if (this.store.liveStatusAt?.(homeId) > liveCaptureStartedAt) live = null;
        const endpointAfter = this.store.getHome?.(homeId)?.activeEndpointId ?? null;
        if (endpointAfter !== endpointBefore) live = null;
      }
      const rows = indexSnapshot(this.store, home.homePath, snapshot, live);
      return this.#finish(home, homeId, snapshot, rows, results);
    } catch (e) {
      // 单个实例的失败绝不该中断这一批剩下的实例：记录失败状态本身也可能失败（DB 不可写），
      // 所以再包一层 —— 原实现里 markHomeError 的二次异常会直接从 catch 里冒出去，
      // 让 #runAll 的循环半途而废（后续实例这一轮完全不刷新）。
      try { this.store.markHomeError(homeId, e.message); } catch { /* 已在 store 内部记录 */ }
      logFailure.call(this, homeId, e, { host: home.host, homePath: home.homePath });
      results.push({ homeId, ok: false, error: e.message });
      return false;
    }
  }

  // 成功路径的收尾：判定降级、广播、登记结果。
  #finish(home, homeId, snapshot, rows, results) {
      const failed = DOMAINS.every((d) => snapshot.degraded.some((x) => x.domain === d));
      const payload = {
        homeId,
        rowCount: rows.length,
        sessionCount: snapshot.sessions.length,
        workspaceCount: snapshot.workspaces.length,
        degraded: snapshot.degraded,
        // 带上「读了哪种 projcache 布局 / 最高版本」：排查「某实例数据变少」时，
        // 第一个要回答的问题就是「它走的是 per-record 还是那个冻结的聚合文件」。
        // 放在 payload 里，日志与 SSE 都能看到，不必再去翻代码。
        // 已实测这条数据通路：磁盘 → reader → 本 payload → `/api/events` 的
        // `index:updated` 事件（收到 `pcLayout:{"perRecord":476,"aggregate":false,
        // "versions":{"5":466,"7":10}}`）。
        pcLayout: snapshot.pcLayout,
        pcVersion: snapshot.pcVersion,
        indexedAt: snapshot.generatedAt,
      };
      if (failed) {
        log.warn('索引失败：全部域降级', { homeId, homePath: home.homePath, host: home.host, degraded: snapshot.degraded });
      } else if (snapshot.degraded.length) {
        log.debug('部分域降级（其余照常索引）', { homeId, degraded: snapshot.degraded });
      }
      // 布局与版本记在 debug 档：正常运行时安静，排查时一行 `HWB_LOG=debug hwb restart`
      // 就能看到每个实例走的是哪种布局。perRecord=0 而磁盘上有文件 = 布局不认识（事故形态）。
      log.debug('索引布局', {
        homeId,
        perRecord: snapshot.pcLayout?.perRecord ?? 0,
        aggregate: snapshot.pcLayout?.aggregate ?? false,
        versions: snapshot.pcLayout?.versions ?? null,
        sessionCount: snapshot.sessions.length,
      });
    this.lastFailure.delete(homeId);   // 成功了 → 复位「重复失败」抑制（下次失败要重新记全）
    this.broadcast('index:updated', payload);
    results.push({ homeId, ok: !failed, ...payload });
    return !failed;
  }
}
