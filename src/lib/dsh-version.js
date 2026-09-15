/**
 * 每个 dsh 实例的版本号（工作台实例卡上展示）。
 *
 * ## 为什么不从 home 元数据里读
 *
 * hwb 索引的是 dsh **home 目录**里的存储域文件，它们信封里的 `unit.version`（如 projcache 7）
 * 是**存储布局**的版本，不是 dsh 自己的版本号 —— 两者各自演化（实测本机：dsh 0.1.5-rc.1
 * 写出来的 home 里仍写着 `session_projcache` 的旧版本）。用户问「这个实例是哪个 dsh」时，
 * 问的是 CLI 的版本号，所以只能去问那台机器上的 dsh 本身。
 *
 * ## 取值口径（与 `hwb doctor` 的本地检查同源）
 *
 *   · 本地实例：读本机安装的 dsh（复用 `dsh-compat` 的 findDshRoot + dshVersionOf）。
 *     **同步**完成（几次目录/文件读），所以实例卡首帧就带版本号，不必等一轮异步。
 *   · 远程实例：`ssh <host> [<remoteCmd 里的 dsh>] --version`，与启动远端 dsh web 用的是
 *     **同一份** PATH 补齐前导（control/remote.js 的 REMOTE_PATH_PRELUDE）——否则会出现
 *     「启动的是新版、卡片报的是旧版」。SSH 走复用 master（见 ssh-opts），命中后接近本地开销。
 *
 * ## 绝不阻塞 /api/homes
 *
 * `resolve()` 在每次 `/api/homes` 都会被调用，而远程路径可能触发一次 ssh 往返（慢链路秒级）。
 * 因此远程一律「就地返回上一次已知值 + 后台探测」：结果到手后经 onChange 回调广播成 SSE 事件，
 * 前端刷新后自然看到新值。探测失败按更短的退避重试，且**不清空**已显示的版本
 * （陈旧的值比没有值有用，何况 dsh 升级是低频事件）。
 */

import { findDshRoot, dshVersionOf } from './dsh-compat.js';
import { logger } from './logger.js';
import { sshBash, REMOTE_PATH_PRELUDE } from '../control/remote.js';

const log = logger('dsh-version');

// dsh 版本号形态（0.1.5-rc.1 / 0.1.1 / 1.2.3）。dsh 明确不承诺 semver，所以这里只做
// **宽松的单向校验**：匹配得到就显示，匹配不到就当未知。这样界面上出现的版本号一定是干净的
// 字面量 —— 远端命令的输出、甚至 package.json 的内容都不必被信任。
const VERSION_RE = /\b\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?\b/;

/** 从 `dsh --version`（或任何含版本号的文本）里取出干净的版本号；取不到返回 null。 */
export function parseDshVersion(output) {
  const m = VERSION_RE.exec(String(output ?? ''));
  return m ? m[0] : null;
}

/** 本机安装的 dsh 版本；没装 dsh 或读不出时返回 null（不抛 —— 它只是一张卡片上的一行字）。 */
export function localDshVersion(options = undefined) {
  try { return parseDshVersion(dshVersionOf(findDshRoot(options))); } catch { return null; }
}

// `--version` 只需一次往返、几十字节输出。上限只是防御性的（远端 dsh 万一打出一大坨）。
const REMOTE_VERSION_BYTES = 4 * 1024;
// 15s：握手已由 SSH 复用摊销；真断了就快点失败，不为一张卡片拖住后台。
const REMOTE_VERSION_TIMEOUT_MS = 15_000;

/**
 * 从用户配置的远端启动命令里取出 dsh 可执行文件。
 *
 * 为什么值得多这一步：`remoteCmd` 存在的原因正是「远端把 dsh 装在非默认位置」——
 * 那种情况下若还去 PATH 里找 dsh，报出来的就是**另一个**安装的版本号，比不显示更糟。
 *
 * 只接受「第一个 token 且带路径分隔符、字符集保守」的形态：
 *   · `~/.local/node/bin/dsh web --port 3080` → `~/.local/node/bin/dsh`（`~` 由远端 shell 展开）
 *   · `dsh web --port 3080`（默认值）→ null，退回 PATH 探测
 *   · `env FOO=1 dsh web` / `bash -lc '...'` → null，因为把 `env`/`bash` 当成 dsh 去问版本
 *     只会得到一句无关输出 —— 宁可退化成 PATH 探测，也不猜。
 * 带空格/引号/分号的 token 一律拒绝（它要原样进远端脚本）。
 */
export function dshBinaryFromCmd(cmd) {
  const first = String(cmd ?? '').trim().split(/\s+/)[0] ?? '';
  if (!first.includes('/')) return null;
  return /^[A-Za-z0-9_@%+=:,.\/~$-]+$/.test(first) ? first : null;
}

/** 远端版本探测脚本：PATH 补齐与启动脚本共用，并在用户显式配了 dsh 路径时优先用那个。 */
export function remoteVersionScript(cmd = null) {
  return `${REMOTE_PATH_PRELUDE}\n${dshBinaryFromCmd(cmd) ?? 'dsh'} --version 2>/dev/null || true`;
}

/**
 * 远端主机上 dsh 的版本号；连不上 / 没装 / 输出不像版本号时返回 null。
 *
 * 不重试（retries: 0）：它是展示用的旁路信息，一次失败等下一轮即可，不该为它把 SSH 的
 * 连接级重试退避（1.5s + 4s）走完 —— 那会把一次「问版本」拖成十几秒的后台任务。
 */
export async function remoteDshVersion(host, { cmd = null, timeoutMs = REMOTE_VERSION_TIMEOUT_MS, spawnProcess } = {}) {
  if (!host) return null;
  const r = await sshBash(host, remoteVersionScript(cmd), [], timeoutMs, {
    retries: 0,
    maxStdoutBytes: REMOTE_VERSION_BYTES,
    ...(spawnProcess ? { spawnProcess } : {}),
  });
  return r.code === 0 ? parseDshVersion(r.stdout) : null;
}

// 版本号只在升级 dsh / 改配置时变：半小时问一次足够新鲜，失败则 2 分钟后再试。
const TTL_MS = 30 * 60_000;
const RETRY_MS = 2 * 60_000;

// 缓存身份：换了连接方式（本地↔远程）、主机、home 或远端启动命令，都是**另一个实例**，
// 旧版本号必须立刻失效 —— 否则改完配置后卡片会继续显示上一个实例的版本。
function identityOf(home) {
  return JSON.stringify([home?.hostType ?? 'local', home?.host ?? null, home?.homePath ?? null, home?.remoteCmd ?? null]);
}

/**
 * 实例版本号缓存 + 后台探测器。所有依赖（时钟、本地读取、远端探测、回调）都可注入，便于单测。
 *
 * 条目：`homeId -> { key, version, nextAt, inflight }`
 *   · `nextAt` 之前不再探测（成功 = TTL，失败 = retryMs）；
 *   · `inflight` 保证同一实例同时只有一次远端探测；
 *   · `key` 是身份，配置变了就丢弃旧值重新探测。
 */
export class DshVersionResolver {
  constructor({
    ttlMs = TTL_MS,
    retryMs = RETRY_MS,
    now = () => Date.now(),
    localVersion = localDshVersion,
    remoteVersion = (home) => remoteDshVersion(home?.host, { cmd: home?.remoteCmd }),
    onChange = () => {},
    log: lg = log,
  } = {}) {
    this.ttlMs = ttlMs;
    this.retryMs = retryMs;
    this.now = now;
    this.localVersion = localVersion;
    this.remoteVersion = remoteVersion;
    this.onChange = onChange;
    this.log = lg;
    this.entries = new Map();
  }

  /** 实例被移除后丢掉缓存；否则反复增删实例会让这张表单调增长。 */
  prune(activeHomeIds) {
    const keep = new Set(activeHomeIds ?? []);
    for (const id of [...this.entries.keys()]) if (!keep.has(id)) this.entries.delete(id);
  }

  /**
   * 当前已知的版本号（可能为 null）；必要时在**后台**发起一次探测。
   * 幂等、随时可调用：`/api/homes` 每次渲染都会问它一遍。
   */
  resolve(home) {
    const homeId = home?.homeId;
    if (!homeId) return null;
    const key = identityOf(home);
    const now = this.now();
    const prev = this.entries.get(homeId);
    const fresh = prev?.key === key;
    const known = fresh ? (prev.version ?? null) : null;
    if (fresh && (now < prev.nextAt || prev.inflight)) return known;

    if ((home.hostType ?? 'local') !== 'remote') {
      // 本地：一次读取（本机安装的 dsh）就够，同步返回 —— 首帧就有版本号。
      const version = this.#safeLocal();
      this.#set(homeId, { key, version, nextAt: now + this.ttlMs, inflight: false });
      // 同步路径的值**已经随本次响应返回**了，所以只有「屏幕上原本显示着另一个版本」才值得再
      // 广播一次；首次解析（known === null）不广播 —— 否则 hwb 每次启动后，每个本地实例都会
      // 白触发一次前端全量刷新。
      if (known !== null && known !== version) this.#announce(homeId, version);
      return version;
    }

    // 远程：先登记（占住 inflight + 下一个 TTL），探测在后台跑，本轮先用上次的已知值。
    this.#set(homeId, { key, version: known, nextAt: now + this.ttlMs, inflight: true });
    this.#probe(homeId, home, key, known);
    return known;
  }

  #probe(homeId, home, key, known) {
    Promise.resolve()
      .then(() => this.remoteVersion(home))
      .then((version) => {
        const cur = this.entries.get(homeId);
        // 探测期间配置改了 / 实例被移除：这次结果已经不属于当前身份，直接丢弃。
        if (cur?.key !== key || !cur.inflight) return;
        // 「成功但不像版本号」与「失败」同等对待：保留旧值，按更短的退避再来。
        const next = version ?? known;
        this.#set(homeId, {
          key,
          version: next,
          nextAt: this.now() + (version ? this.ttlMs : this.retryMs),
          inflight: false,
        });
        if (version && version !== known) this.#announce(homeId, version);
      })
      .catch((error) => {
        const cur = this.entries.get(homeId);
        if (cur?.key !== key || !cur.inflight) return;
        this.#set(homeId, { key, version: known, nextAt: this.now() + this.retryMs, inflight: false });
        this.log.debug('远端 dsh 版本探测失败（沿用上一次的值，稍后重试）', {
          homeId, host: home?.host, error: error?.message ?? String(error),
        });
      });
  }

  #safeLocal() {
    try { return this.localVersion() ?? null; } catch (error) {
      this.log.debug('本机 dsh 版本读取失败', { error: error?.message ?? String(error) });
      return null;
    }
  }

  #set(homeId, entry) { this.entries.set(homeId, entry); }

  #announce(homeId, version) {
    try { this.onChange(homeId, version); } catch (error) {
      // 广播失败不该影响这一次 /api/homes 的返回：版本号已经在响应体里了。
      this.log.warn('dsh 版本变更广播失败', { homeId, version, error: error?.message ?? String(error) });
    }
  }
}
