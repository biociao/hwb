#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexStore } from './dshhome/store.js';
import { Indexer } from './dshhome/indexer.js';
import { Launcher } from './control/launcher.js';
import { Monitor } from './control/monitor.js';
import { InstanceRegistry } from './control/registry.js';
import { QuotaService } from './dshhome/quota.js';
import { SSEHub } from './api/sse.js';
import { createApiServer } from './api/server.js';

const pkgRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const defaultDb = path.join(homedir(), '.hwb', 'hwb.db');

function parseArgs(argv) {
  const opts = { homes: [], port: 4310, db: defaultDb, intervalMs: 60_000 };
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
      default:
        console.error(`unknown option: ${argv[i]}`);
        process.exit(2);
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

if (opts.db !== ':memory:') mkdirSync(path.dirname(opts.db), { recursive: true });
const store = new IndexStore(opts.db);
for (const homePath of opts.homes) {
  store.registerHome({ homePath });
}

const hub = new SSEHub();
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
const indexer = new Indexer({
  store,
  homePaths: () => store.listLocalHomePaths(), // 远程实例元数据不本地索引（走 tunnel 访问）
  broadcast: (event, data) => hub.broadcast(event, data),
  baseMs: opts.intervalMs,
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
  webRoot: path.join(pkgRoot, 'src', 'web'),
});
server.listen(opts.port, '127.0.0.1', () => {
  console.log(`hwb listening on http://127.0.0.1:${opts.port}`);
  console.log(`db: ${opts.db}`);
  for (const h of store.listHomePaths()) console.log(`home: ${h}`);
});

function shutdown() {
  indexer.stop();
  monitor.stop();
  server.close();
  store.close();
  process.exit(0); // 'exit' 事件里 Launcher 会杀掉所有 dsh web 子进程
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
