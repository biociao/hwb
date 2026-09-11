#!/usr/bin/env node
import { mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enforceNodeVersion } from './lib/node-version.js';
import { MAX_TIMER_MS } from './lib/timers.js';

// 版本预检必须先于 dshhome/store.js 求值：只有它 import 'node:sqlite'，而该模块在
// Node < 22.5 并不存在，静态引入只会抛一行与根因无关的 ERR_UNKNOWN_BUILTIN_MODULE。
// 由于静态 import 全部先于模块体求值，store.js 这里只能改成动态引入。
enforceNodeVersion();
const { IndexStore } = await import('./dshhome/store.js');
import { Indexer } from './dshhome/indexer.js';
import { LiveStatusReader } from './dshhome/live-status.js';
import { LiveStatusPoller } from './dshhome/live-poller.js';
import { Launcher } from './control/launcher.js';
import { Monitor } from './control/monitor.js';
import { InstanceRegistry } from './control/registry.js';
import { QuotaService } from './dshhome/quota.js';
import { SSEHub } from './api/sse.js';
import { createApiServer, allowedHostsFromEnv } from './api/server.js';
import { initLogger, logger, defaultLogFile, installCrashHandlers, getLogs, onLog } from './lib/logger.js';

const pkgRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const defaultDb = path.join(homedir(), '.hwb', 'hwb.db');

function parseArgs(argv) {
  const opts = { homes: [], port: 4310, db: defaultDb, intervalMs: 60_000, logFile: defaultLogFile(), level: 'info', silent: false };
  // 这两项直接喂给 listen()/setTimeout()，非法值不会得到报错，只会得到**奇怪的行为**：
  //   · `--interval-ms abc` → NaN → setTimeout 当 0 处理 → 每 1ms 跑一轮（CPU 打满）
  //   · `--interval-ms 1e16` → 超过 setTimeout 的 2^31-1 上限，Node 警告后同样退化成 1ms
  //   · `--port abc` → listen(NaN) 在部分平台会绑到随机端口，用户看到的端口号就成了假的
  // 所以在这里明确拒绝，而不是让它悄悄变成别的东西。
  const positiveInt = (name, raw, max) => {
    const n = Number(raw);
    const bad = !Number.isInteger(n) || n < 1 || (max !== undefined && n > max);
    if (bad) {
      logger('server').error(`${name} 需要 1 到 ${max ?? '无穷'} 之间的整数，收到 ${JSON.stringify(raw)}`);
      process.exit(2);
    }
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--home':
        opts.homes.push(path.resolve(argv[++i]));
        break;
      case '--port':
        opts.port = positiveInt('--port', argv[++i], 65535);
        break;
      case '--db':
        opts.db = argv[++i];
        break;
      case '--interval-ms':
        // 上限 = setTimeout 的最大延时（2^31-1）。超过它 Node 会把延时当成 1ms。
        opts.intervalMs = positiveInt('--interval-ms', argv[++i], MAX_TIMER_MS);
        break;
      case '-v':
      case '--verbose':
        opts.level = 'debug';
        break;
      case '--silent':
        opts.silent = true;
        break;
      case '--log':
        opts.logFile = argv[++i];
        break;
      case '--no-log':
        opts.logFile = false;
        break;
      default:
        logger('server').error(`unknown option: ${argv[i]}`);
        process.exit(2);
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const log = logger('server');

// 日志模块必须先于一切逻辑初始化：之后每个模块（launcher/monitor/indexer...）都共享
// 同一套 level/file/silent 配置，出错时的上下文统一落到终端 + 日志文件。
initLogger({ level: opts.level, file: opts.logFile, silent: opts.silent });
if (opts.logFile) log.info(`日志文件: ${opts.logFile}`);
if (opts.level === 'debug') log.debug('debug 已开启');

// 进程级 crash handler：把未捕获异常 / 未处理拒绝连同完整 stack 记入日志，便于排查。
installCrashHandlers();

// 0700：hwb 的状态目录里有会话标题、工作区路径与日志，属于当前用户的私有数据。
// 原先不带 mode → 0755（实测 ~/.hwb 就是 drwxr-xr-x），同机其它用户可读。
if (opts.db !== ':memory:') mkdirSync(path.dirname(opts.db), { recursive: true, mode: 0o700 });
// 打不开数据库时给一句能照做的提示。裸的 `new DatabaseSync()` 只会抛
// `unable to open database file`，而它冒成 uncaughtException → crash handler → exit(1)，
// CLI 那边只看到「启动失败 (1)，查看 service.log」——路径本身就是个目录/不可写这种最常见的
// 原因，用户完全无从得知。这里明确说出**哪个路径**、以及可能的原因。
let store;
try {
  store = new IndexStore(opts.db);
} catch (e) {
  const why = opts.db === ':memory:' ? '' : `（${opts.db}）`;
  console.error(`hwb: 无法打开数据库${why}: ${e.message}\n`
    + '  常见原因：该路径已被一个目录占用、父目录不可写、或文件不是 SQLite 数据库。\n'
    + '  可删除/改名该路径后重试，或用 `hwb config set db <新路径>` 换一个位置。');
  log.error('无法打开数据库', e, { db: opts.db });
  process.exit(2);
}
// SQLite 自己按 umask 建文件（实测 0644）。它装着全部会话元数据，收紧到 0600。
if (opts.db !== ':memory:') { try { chmodSync(opts.db, 0o600); } catch { /* 不支持的 fs 上忽略 */ } }
for (const homePath of opts.homes) {
  store.registerHome({ homePath });
}

const hub = new SSEHub();
// 每条通过阈值的新日志（含报错时的上下文/堆栈）实时推送到「日志区域」。
onLog((entry) => hub.broadcast('log:event', entry));
const registry = new InstanceRegistry(); // 控制平面唯一权威状态（M6）
const launcher = new Launcher({ registry, rememberAccessPort: (homeId, accessPort) => {
  if (!store.getHome(homeId)) throw new Error('实例已移除');
  store.updateHomeConfig(homeId, { accessPort });
} });
const monitor = new Monitor({
  store,
  launcher,
  registry,
  broadcast: (event, data) => hub.broadcast(event, data),
  intervalMs: 30_000,
});
const quota = new QuotaService({
  store,
  broadcast: (event, data) => hub.broadcast(event, data),
});
const liveStatusReader = new LiveStatusReader();
const readLiveStatus = async (home) => {
  const rt = monitor.get(home.homeId);
  if (!rt || rt.runtime !== 'running') return null;
  // 本地实例：直接用 home 配置里的最新 token + localPort 拼实时 URL（不依赖可能过期的 rt.url，
  // 用户刚在配置里填了新 token 也能立即生效）。远程实例：经隧道反代的 rt.url。
  let url = rt.url;
  if (home.hostType === 'local' && home.localPort) {
    const base = `http://127.0.0.1:${home.localPort}`;
    url = home.token ? `${base}/?token=${encodeURIComponent(home.token)}` : base;
  }
  if (!url) return null;
  try {
    return await liveStatusReader.read(url, { homeId: home.homeId, host: home.host });
  } catch {
    return null;
  }
};
const indexer = new Indexer({
  store,
  // 本地 + 远程都索引：本地走 fs，远程经 SSH 只读 cat（§4.6），让远程实例的
  // 「当前项目/当前会话」也能入库并出现在工作台。remoteExec 缺省走真实 sshBash。
  homes: () => store.listHomes(),
  broadcast: (event, data) => hub.broadcast(event, data),
  baseMs: opts.intervalMs,
  // 读取源扩展：对「运行中且可直达」的实例，从 dsh web 的 /api RPC channel 读取实时会话状态，
  // 覆盖（可能冻结的）投影缓存推导出的状态。实例不可达 / token 无效 / 端点缺失一律回退（返回 null）。
  liveStatus: readLiveStatus,
});
const livePoller = new LiveStatusPoller({
  store, homes: () => store.listHomes().filter((h) => monitor.get(h.homeId).runtime === 'running'), read: readLiveStatus,
  broadcast: (event, data) => hub.broadcast(event, data),
});
monitor.start();
indexer.start();
livePoller.start();

const server = createApiServer({
  store,
  indexer,
  hub,
  launcher,
  monitor,
  quota,
  logApi: { getLogs },
  webRoot: path.join(pkgRoot, 'src', 'web'),
  // 逃生口：/etc/hosts 别名、devcontainer 转发域名、保留浏览器 authority 的反代都会让 Host
  // 不是回环名，此时 SPA 能加载但每个 /api/* 都 403。显式用 HWB_ALLOWED_HOSTS 放行。
  allowedHosts: allowedHostsFromEnv(),
});
server.listen(opts.port, '127.0.0.1', () => {
  globalThis.hwbServiceReady?.();
  log.info(`hwb listening on http://127.0.0.1:${opts.port} (level=${opts.level}${opts.logFile ? ` log=${opts.logFile}` : ''})`);
  log.info(`db: ${opts.db}`);
  for (const h of store.listHomePaths()) log.info(`home: ${h}`);
});
// 端口被占用是**最常见**的启动失败（另一个 hwb 实例、上次没退干净的进程、或别的程序）。
// 裸事件会把 `Error: listen EADDRINUSE…` 连同 4 行栈帧写进 service.log，而 CLI 只报
// 「启动失败 (1)，查看 service.log」—— 用户得翻日志、还得自己在栈帧里找那一行。这里给出
// 一句能照做的 `hwb:` 提示（CLI 会把 `hwb:` 开头的提示块带回终端）。
server.on('error', (err) => {
  const where = '127.0.0.1:' + opts.port;
  if (err.code === 'EADDRINUSE') {
    console.error(`hwb: 端口 ${where} 已被占用，无法启动。\n`
      + '  可能是另一个 hwb 实例（`hwb status` 看当前端口），或上次没退干净的进程，或别的程序。\n'
      + '  换一个端口：`hwb config set port <新端口>`；或先停掉占用者（macOS/Linux: `lsof -i :'
      + `${opts.port}` + '`）。');
  } else {
    console.error(`hwb: 无法在 ${where} 上启动 HTTP 服务: ${err.message}`);
  }
  log.error('HTTP 服务监听失败', err, { port: opts.port });
  process.exit(3);
});

let shuttingDown = false;
function shutdown(reason = 'signal') {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`shutdown (${reason})`);
  livePoller.stop();
  indexer.stop();
  monitor.stop();
  hub.close(); // 清掉 SSE 心跳定时器并断开所有客户端，避免退出时残留句柄
  server.close();
  store.close();
  process.exit(0); // 'exit' 事件里 Launcher 会杀掉所有 dsh web 子进程
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
