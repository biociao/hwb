#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexStore } from './dshhome/store.js';
import { Indexer } from './dshhome/indexer.js';
import { LiveStatusReader } from './dshhome/live-status.js';
import { Launcher } from './control/launcher.js';
import { Monitor } from './control/monitor.js';
import { InstanceRegistry } from './control/registry.js';
import { QuotaService } from './dshhome/quota.js';
import { SSEHub } from './api/sse.js';
import { createApiServer } from './api/server.js';
import { initLogger, logger, defaultLogFile, installCrashHandlers, getLogs, onLog } from './lib/logger.js';

const pkgRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const defaultDb = path.join(homedir(), '.hwb', 'hwb.db');

function parseArgs(argv) {
  const opts = { homes: [], port: 4310, db: defaultDb, intervalMs: 60_000, logFile: defaultLogFile(), level: 'info', silent: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--home':
        opts.homes.push(path.resolve(argv[++i]));
        break;
      case '--port':
        opts.port = Number(argv[++i]);
        break;
      case '--db':
        opts.db = argv[++i];
        break;
      case '--interval-ms':
        opts.intervalMs = Number(argv[++i]);
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

if (opts.db !== ':memory:') mkdirSync(path.dirname(opts.db), { recursive: true });
const store = new IndexStore(opts.db);
for (const homePath of opts.homes) {
  store.registerHome({ homePath });
}

const hub = new SSEHub();
// 每条通过阈值的新日志（含报错时的上下文/堆栈）实时推送到「日志区域」。
onLog((entry) => hub.broadcast('log:event', entry));
const registry = new InstanceRegistry(); // 控制平面唯一权威状态（M6）
const launcher = new Launcher({ registry });
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
const indexer = new Indexer({
  store,
  // 本地 + 远程都索引：本地走 fs，远程经 SSH 只读 cat（§4.6），让远程实例的
  // 「当前项目/当前会话」也能入库并出现在工作台。remoteExec 缺省走真实 sshBash。
  homes: () => store.listHomes(),
  broadcast: (event, data) => hub.broadcast(event, data),
  baseMs: opts.intervalMs,
  // 读取源扩展：对「运行中且可直达」的实例，从 dsh web 的 /api RPC channel 读取实时会话状态，
  // 覆盖（可能冻结的）投影缓存推导出的状态。实例不可达 / token 无效 / 端点缺失一律回退（返回 null）。
  liveStatus: async (home) => {
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
      return await liveStatusReader.read(url);
    } catch {
      return null;
    }
  },
});
indexer.start();
monitor.start();

const server = createApiServer({
  store,
  indexer,
  hub,
  launcher,
  monitor,
  quota,
  logApi: { getLogs },
  webRoot: path.join(pkgRoot, 'src', 'web'),
});
server.listen(opts.port, '127.0.0.1', () => {
  log.info(`hwb listening on http://127.0.0.1:${opts.port} (level=${opts.level}${opts.logFile ? ` log=${opts.logFile}` : ''})`);
  log.info(`db: ${opts.db}`);
  for (const h of store.listHomePaths()) log.info(`home: ${h}`);
});

let shuttingDown = false;
function shutdown(reason = 'signal') {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`shutdown (${reason})`);
  indexer.stop();
  monitor.stop();
  server.close();
  store.close();
  process.exit(0); // 'exit' 事件里 Launcher 会杀掉所有 dsh web 子进程
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
