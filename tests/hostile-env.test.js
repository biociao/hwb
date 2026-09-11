import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile } from 'node:fs/promises';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { IndexStore } from '../src/dshhome/store.js';
import { Indexer } from '../src/dshhome/indexer.js';
import { readHome, readMetadataFile } from '../src/lib/read-home.js';
import { initLogger, logger } from '../src/lib/logger.js';

// 「敌意环境」下的一批修复。每一条都先用探针复现过，见 CHANGELOG。

// ── CRITICAL：数据库里一个坏 JSON 列曾让整个进程退出 ──
test('store: 数据库里的坏 JSON 列降级为默认值，不再让进程退出', () => {
  const store = new IndexStore(':memory:');
  const homeId = store.registerHome({ homePath: '/m' });
  // 制造「外部工具改过」的坏值
  store.db.prepare('UPDATE homes SET endpoints = ?, degraded = ? WHERE homeId = ?').run('{not json', 'oops', homeId);
  const now = new Date().toISOString();
  store.db.prepare('INSERT INTO sessions (homeId, sessionId, project, lastActivity, status, tokenUsage) VALUES (?,?,?,?,?,?)')
    .run(homeId, 's1', 'p', now, 'running garbage', 'also not json');

  // 原实现：这三处裸 JSON.parse 会抛 SyntaxError；而 #enrichHome 被 live-poller 的
  // 定时器**同步**调用，于是直接冒成 uncaughtException → process.exit(1)。
  assert.doesNotThrow(() => store.listHomes());
  assert.doesNotThrow(() => store.getHome(homeId));
  assert.doesNotThrow(() => store.recentSessions({ homeId }));
  const home = store.getHome(homeId);
  assert.deepEqual(home.endpoints, [], '坏 JSON 应降级为默认值');
  assert.deepEqual(home.degraded, []);
  assert.equal(store.recentSessions({ homeId })[0].status, null);
  assert.equal(store.recentSessions({ homeId })[0].tokenUsage, null);
  store.close();
});

test('live-poller: 读取实例列表抛错时只跳过本轮，不带崩进程', async () => {
  const { LiveStatusPoller } = await import('../src/dshhome/live-poller.js');
  const poller = new LiveStatusPoller({
    store: { listHomes: () => { throw new Error('数据库里的坏 JSON'); }, getHome: () => null },
    homes: () => { throw new Error('数据库里的坏 JSON'); },
    read: async () => [],
    intervalMs: 10,
  });
  // start() 里会同步调用一次 tick —— 原实现会直接抛出
  assert.doesNotThrow(() => poller.start());
  await new Promise((r) => setTimeout(r, 40)); // 让定时器再跑几轮
  poller.stop();
});

// ── CRITICAL：FIFO 曾让进程永久卡死（端口都不存在、SIGTERM 也无效） ──
test('read-home: 元数据文件是 FIFO 时立刻降级，不再永久阻塞', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hwb-fifo-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'storages'), { recursive: true });
  await writeFile(path.join(dir, 'storages', 'workspace.json'), '{}');
  // node 没有 mkfifo 的绑定，直接用系统的（POSIX-only 测试）
  await new Promise((resolve, reject) => {
    execFile('mkfifo', [path.join(dir, 'storages', 'session_projcache.json')], (e) => (e ? reject(e) : resolve()));
  });

  const started = Date.now();
  const snapshot = readHome(dir);   // 原实现在这里永远不返回
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `不该阻塞，实际 ${elapsed}ms`);
  assert.ok(snapshot.degraded.some((d) => d.domain === 'projcache' && /不是普通文件/.test(d.error)));
});

test('read-home: 元数据文件是符号链接时拒绝（不把 home 之外的文件读进来）', async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), 'hwb-symread-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  await mkdir(path.join(home, 'storages'), { recursive: true });
  const secret = path.join(base, 'outside.json');
  await writeFile(secret, JSON.stringify({
    unit: { name: 'session_projcache', version: 3 }, global: null,
    tables: { sessions: { leak: { identity: { createdAt: 1, cwd: '/etc/secret' }, rows: { title: { val: 'OUTSIDE-SECRET' } } } } },
  }));
  await symlink(secret, path.join(home, 'storages', 'session_projcache.json'));
  await writeFile(path.join(home, 'storages', 'workspace.json'), 'x');

  const snapshot = readHome(home);
  assert.equal(snapshot.sessions.length, 0, '符号链接必须被拒绝');
  assert.ok(!JSON.stringify(snapshot).includes('OUTSIDE-SECRET'), '不得把 home 之外的内容读进来');
  assert.ok(snapshot.degraded.some((d) => d.domain === 'projcache' && /符号链接/.test(d.error)));
});

test('read-home: 解析错误不再回显文件内容（degraded 会经 SSE 渲染到界面）', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hwb-parseerr-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'storages'), { recursive: true });
  await writeFile(path.join(dir, 'storages', 'workspace.json'), 'SUPER-SECRET-FILE-CONTENT not json');
  const snapshot = readHome(dir);
  const msg = snapshot.degraded.map((d) => d.error).join(' ');
  assert.doesNotMatch(msg, /SUPER-SECRET-FILE-CONTENT/, '解析错误消息不该带出文件字节');
  assert.match(msg, /不是合法的 JSON/);
});

test('read-home: 超过读取上限的文件被拒绝而不是整个读进内存', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hwb-bigmeta-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'storages'), { recursive: true });
  const big = path.join(dir, 'storages', 'session_projcache.json');
  await writeFile(big, '');
  const { truncate } = await import('node:fs/promises');
  await truncate(big, 65 * 1024 * 1024); // 略高于 64 MiB 上限
  assert.throws(() => readMetadataFile(dir, 'storages/session_projcache.json'), /读取上限/);
});

// ── indexer：单个实例的失败不该中断整批 ──
test('indexer: 记录失败状态本身抛错时，剩下的实例仍被处理', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hwb-idxfail-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'storages'), { recursive: true });
  await writeFile(path.join(dir, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 }, global: { initialized: true, workspaceIds: [] }, tables: { workspaces: {} },
  }));
  let markCalls = 0;
  const indexer = new Indexer({
    store: {
      upsertRows() { throw new Error('attempt to write a readonly database'); },
      markHomeError() { markCalls++; throw new Error('数据库仍然不可写'); },
    },
    homes: () => [{ homeId: 'a', hostType: 'local', homePath: dir }, { homeId: 'b', hostType: 'local', homePath: dir }],
  });
  const results = await indexer.reindexNow();
  assert.equal(results.length, 2, '两个实例都应被处理（原实现会在第一个失败后中断）');
  assert.ok(results.every((r) => r.ok === false));
  assert.equal(markCalls, 2, '每个失败实例都应尝试记录一次');
});

test('indexer: 结果顺序与实例列表一致，且并发数有上限', async () => {
  const homes = Array.from({ length: 9 }, (_, i) => ({ homeId: `h${i}`, hostType: 'local', homePath: `/nope/${i}` }));
  const indexer = new Indexer({ store: { upsertRows() {}, markHomeError() {} }, homes: () => homes, concurrency: 3 });
  const results = await indexer.reindexNow();
  assert.deepEqual(results.map((r) => r.homeId), homes.map((h) => h.homeId), '并发不该打乱结果顺序');
  assert.equal(new Indexer({ store: {}, homes: () => [], concurrency: 99 }).concurrency, 8, '并发数应有上限');
});

// ── 实时状态：抓快照必须在读文件之后，否则会被更旧的快照覆盖 ──
test('indexer: 实时状态在文件读取之后才抓，不被整表 upsert 覆盖', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hwb-order-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'storages'), { recursive: true });
  await writeFile(path.join(dir, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['w1'] },
    tables: { workspaces: { w1: { title: 'A', path: '/r/a', sessionIds: ['s1'] } } },
  }));
  await writeFile(path.join(dir, 'storages', 'session_projcache.json'), JSON.stringify({
    unit: { name: 'session_projcache', version: 3 }, global: null,
    tables: { sessions: { s1: { identity: { createdAt: Date.now(), cwd: '/r/a' }, rows: {} } } },
  }));

  const store = new IndexStore(':memory:');
  const homeId = store.registerHome({ homePath: dir });
  const indexer = new Indexer({
    store,
    homes: () => [{ homeId, hostType: 'local', homePath: dir }],
    liveStatus: async () => [{
      sessionId: 's1', cwd: '/r/a',
      status: { kind: 'completed', label: '已完成', subagents: 0, approval: null },
      lastActivity: new Date().toISOString(),
    }],
  });
  await indexer.reindexNow();
  const row = store.recentSessions({ homeId })[0];
  const kind = (typeof row.status === 'string' ? JSON.parse(row.status) : row.status)?.kind;
  assert.equal(kind, 'completed', '实时状态应生效，不该被文件索引的旧状态覆盖');
  store.close();
});

// ── 日志文件被删/改名后，磁盘日志应自动接上 ──
test('logger: 日志文件被删除后会重新创建，磁盘日志不再静默断掉', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hwb-logreopen-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'hwb.log');
  initLogger({ level: 'info', file, color: false });
  logger('t').info('before-delete');
  assert.ok(existsSync(file));

  rmSync(file, { force: true });
  logger('t').info('right-after-delete');   // 仍写到已 unlink 的 inode
  // 越过 5s 的重开检查窗口
  await new Promise((r) => setTimeout(r, 5200));
  logger('t').info('after-window');
  assert.ok(existsSync(file), '日志文件应被重新创建');
  const body = await readFile(file, 'utf8');
  assert.match(body, /after-window/, '重新打开后的日志应写进磁盘');
});
