import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { IndexStore } from '../src/dshhome/store.js';
import { Indexer } from '../src/dshhome/indexer.js';
import { Monitor } from '../src/control/monitor.js';
import { InstanceRegistry } from '../src/control/registry.js';
import { LOCAL_TOOL_SOURCES } from '../src/lib/harnesses.js';
import { initLogger } from '../src/lib/logger.js';

// WorkBuddy 作为本地工具接入索引器（契约 §2/§6）：
//   真实 workbuddy.db 夹具 → LOCAL_TOOL_SOURCES.workbuddy.readSnapshot → indexRows → 同一套
//   homes/workspaces/sessions 行。重点：
//   · 只读：索引前后 workbuddy.db 字节/mtime 不变，不产生 -wal/-shm；
//   · 项目归属按 cwd 最长前缀；未归属会话按 basename 归一化；
//   · completed → 已完成，其余（大小写混用/terminated）→ 已保存；
//   · 降级只影响该实例（reasons → home 行 degraded domain 'workbuddy'）；
//   · SSE payload 带 harness，Recent 面板天然可用。

initLogger({ level: 'error', file: false, color: false, silent: true });

const SESSION_DONE = '8d13a377-25e2-4732-9064-806d409c0e69';
const SESSION_RUNNING = '9f22b488-36f3-4843-a174-917e510dbf70';
const SESSION_TERMINATED = 'a1b2c3d4-e5f6-4789-8abc-def012345678';
const SESSION_UNASSIGNED = 'b1b2c3d4-e5f6-4789-8abc-def012345678';
const WS_P1 = '/Users/x/WorkBuddy/p1';
const WS_EMPTY = '/Users/x/WorkBuddy/empty-project';

function makeWorkbuddyHome(dir, { sessions = true } = {}) {
  fs.writeFileSync(path.join(dir, 'startup-seed-version.json'), JSON.stringify({ appVersion: '5.8.3' }));
  if (!sessions) return;
  const db = new DatabaseSync(path.join(dir, 'workbuddy.db'));
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, cwd TEXT, title TEXT, custom_title TEXT,
      status TEXT, created_at INTEGER, updated_at INTEGER, deleted_at INTEGER,
      model TEXT, last_activity_at INTEGER, project_id TEXT
    );
    CREATE TABLE workspaces (path TEXT PRIMARY KEY, last_opened_at INTEGER);
    CREATE TABLE session_usage (session_id TEXT PRIMARY KEY, used INTEGER, size INTEGER);
  `);
  const insert = db.prepare('INSERT INTO sessions (id, cwd, title, custom_title, status, created_at, updated_at, deleted_at, model, last_activity_at, project_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  // 真实库里 completed 大小写混用：Completed / completed 都要判成「已完成」。
  insert.run(SESSION_DONE, `${WS_P1}/src`, '做U盘', null, 'Completed',
    1792844789000, 1792852521000, null, 'space-bunny', 1792852131000, null);
  insert.run(SESSION_RUNNING, `${WS_P1}/docs`, null, '写文档', 'pending',
    1792844789000, 1792852600000, null, 'space-bunny', 1792852600000, 'proj-x');
  insert.run(SESSION_TERMINATED, `${WS_P1}/src`, '被终止', null, 'terminated',
    1792844000000, 1792845000000, null, 'space-bunny', 1792845000000, null);
  // 软删除的会话不进列表
  insert.run('c1c2c3d4-e5f6-4789-8abc-def012345678', `${WS_P1}/src`, '已删除', null, 'completed',
    1792844000000, 1792845000000, 1792846000000, 'space-bunny', 1792845000000, null);
  // 未归属任何 workspace 的会话：按 cwd basename 归一化
  insert.run(SESSION_UNASSIGNED, '/tmp/elsewhere', '随手问', null, 'pending',
    1792847000000, 1792847000000, null, 'space-bunny', 1792847000000, null);
  const insertWs = db.prepare('INSERT INTO workspaces (path, last_opened_at) VALUES (?,?)');
  insertWs.run(WS_P1, 1792844789328);
  insertWs.run(WS_EMPTY, 1792840000000);
  const insertUsage = db.prepare('INSERT INTO session_usage (session_id, used, size) VALUES (?,?,?)');
  insertUsage.run(SESSION_DONE, 31130, 168000);
  db.close();
}

function makeIndexer(t, { broadcast } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwb-workbuddy-index-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new IndexStore(path.join(dir, 'hwb.db'));
  t.after(() => store.close());
  const indexer = new Indexer({
    store,
    homes: () => store.listHomes(),
    broadcast: broadcast ?? (() => {}),
    localTools: LOCAL_TOOL_SOURCES,
    baseMs: 100,
  });
  return { dir, store, indexer };
}

function snapshotDb(dbFile) {
  const stat = fs.statSync(dbFile);
  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    siblings: fs.readdirSync(path.dirname(dbFile)).sort(),
  };
}

test('WorkBuddy 实例经 Indexer 落库：项目/会话进 Recent，状态与归属口径正确', async (t) => {
  const { dir, store, indexer } = makeIndexer(t);
  const wbDir = path.join(dir, 'workbuddy');
  fs.mkdirSync(wbDir);
  makeWorkbuddyHome(wbDir);

  const homeId = store.registerHome({ homePath: wbDir, alias: 'WorkBuddy', hostType: 'local', harness: 'workbuddy' });
  const before = snapshotDb(path.join(wbDir, 'workbuddy.db'));

  const results = await indexer.reindexNow(homeId);
  assert.equal(results.length, 1);
  const result = results[0];
  assert.equal(result.ok, true);
  assert.equal(result.harness, 'workbuddy');
  assert.equal(result.sessionCount, 4, '软删除会话被过滤');
  assert.equal(result.workspaceCount, 2, '0 会话的工作区也建行（与 dsh workspace.json 同口径）');
  assert.deepEqual(result.degraded, []);

  // 只读：库文件内容/时间不变，且没有写 WAL/SHM 副产物
  const after = snapshotDb(path.join(wbDir, 'workbuddy.db'));
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.deepEqual(after.siblings, before.siblings, '只读打开不应产生 -wal/-shm');

  // 项目：p1 有 3 条已保存会话（done/running/terminated），empty-project 0 条
  const projects = store.recentProjects({ days: 3650, homeIds: [homeId] });
  const p1 = projects.find((p) => p.project === 'p1');
  assert.ok(p1, 'WorkBuddy 项目应出现在 Recent Projects');
  assert.equal(p1.homeId, homeId);
  assert.equal(p1.sessionCount, 3);
  // 上下文用量不是 token 拆分：本期不写 tokenUsage（Recent 面板显示 0）
  assert.equal(p1.totalTokens, 0);
  assert.equal(p1.inputTokens, 0);
  assert.equal(p1.outputTokens, 0);
  assert.ok(projects.some((p) => p.project === 'empty-project'), '没有会话的工作区也要出现');

  const sessions = store.recentSessions({ homeIds: [homeId] });
  assert.equal(sessions.length, 4);
  const latest = sessions[0];
  assert.equal(latest.sessionId, SESSION_RUNNING, '按 last_activity_at 降序');
  assert.equal(latest.title, '写文档', 'custom_title 优先');
  assert.equal(latest.project, 'p1');
  assert.equal(latest.workspaceId, WS_P1);
  assert.deepEqual(latest.status, { kind: 'idle', label: '已保存', subagents: 0 });
  assert.equal(latest.tokenUsage, null);
  assert.equal(latest.contextPressure, null);

  const done = sessions.find((s) => s.sessionId === SESSION_DONE);
  assert.equal(done.title, '做U盘', 'title 回退');
  assert.deepEqual(done.status, { kind: 'completed', label: '已完成', subagents: 0 },
    'completed 大小写混用（Completed）也要判成已完成');
  const terminated = sessions.find((s) => s.sessionId === SESSION_TERMINATED);
  assert.deepEqual(terminated.status, { kind: 'idle', label: '已保存', subagents: 0 });

  const unassigned = sessions.find((s) => s.sessionId === SESSION_UNASSIGNED);
  assert.equal(unassigned.project, 'elsewhere', '未归属会话按 cwd basename 归一化');
  assert.equal(unassigned.workspaceId, null);

  // 再索引一次：整表替换不能弄丢/重复
  await indexer.reindexNow(homeId);
  assert.equal(store.recentSessions({ homeIds: [homeId] }).length, 4);
});

test('WorkBuddy 索引的 SSE payload 带 harness（前端只需一套刷新逻辑）', async (t) => {
  const events = [];
  const { dir, store, indexer } = makeIndexer(t, { broadcast: (event, data) => events.push({ event, data }) });
  const wbDir = path.join(dir, 'workbuddy');
  fs.mkdirSync(wbDir);
  makeWorkbuddyHome(wbDir);
  const homeId = store.registerHome({ homePath: wbDir, alias: 'WorkBuddy', hostType: 'local', harness: 'workbuddy' });

  await indexer.reindexNow(homeId);
  const payload = events.find((e) => e.event === 'index:updated')?.data;
  assert.ok(payload, '应广播 index:updated');
  assert.equal(payload.harness, 'workbuddy');
  assert.equal(payload.homeId, homeId);
  assert.equal(payload.sessionCount, 4);
  assert.equal(payload.workspaceCount, 2);
  assert.ok(payload.indexedAt);
});

test('WorkBuddy 库缺失/损坏：只降级该实例，不抛错、不影响其它实例', async (t) => {
  const { dir, store, indexer } = makeIndexer(t);
  const noDb = path.join(dir, 'workbuddy-nodb');
  fs.mkdirSync(noDb);
  const noDbId = store.registerHome({ homePath: noDb, alias: 'WB 无库', hostType: 'local', harness: 'workbuddy' });

  const results = await indexer.reindexNow(noDbId);
  assert.equal(results[0].ok, true, '缺库是降级不是索引失败（不影响实例可用性）');
  assert.equal(results[0].degraded.length, 1);
  assert.equal(results[0].degraded[0].domain, 'workbuddy');
  assert.match(results[0].degraded[0].error, /workbuddy\.db/);
  assert.equal(store.getHome(noDbId).status, 'degraded');
  assert.equal(store.recentSessions({ homeIds: [noDbId] }).length, 0);
});

test('Indexer：本地工具数据源缺失时该实例失败，但不影响别的实例（per-home 隔离）', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwb-tool-source-missing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new IndexStore(path.join(dir, 'hwb.db'));
  t.after(() => store.close());
  const indexer = new Indexer({
    store,
    homes: () => store.listHomes(),
    broadcast: () => {},
    localTools: {},   // 模拟 server.js 还没注入数据面
    baseMs: 100,
  });
  const homeId = store.registerHome({ homePath: path.join(dir, 'wb'), alias: 'WB', hostType: 'local', harness: 'workbuddy' });
  const results = await indexer.reindexNow(homeId);
  assert.equal(results[0].ok, false);
  assert.match(results[0].error, /workbuddy 数据源未启用/);
  // markHomeError 把实例状态标成 degraded（域 'index'），与 dsh 的索引失败同一口径。
  assert.equal(store.getHome(homeId).status, 'degraded');
});

test('store.registerHome：接受 workbuddy（仅本机），readOnly 标记仍只给 dsh', (t) => {
  const store = new IndexStore();
  t.after(() => store.close());
  const id = store.registerHome({ homePath: '/home/u/.workbuddy', alias: 'WB', hostType: 'local', harness: 'workbuddy' });
  assert.match(id, /^[0-9a-f]{16}$/);
  const home = store.getHome(id);
  assert.equal(home.harness, 'workbuddy');
  assert.equal(home.hostType, 'local');
  assert.equal(home.readOnly, false);
  assert.deepEqual(home.endpoints, [], '本地工具没有端点/token');

  assert.throws(() => store.registerHome({ homePath: 'ssh://h:1', harness: 'workbuddy', hostType: 'remote' }), /只支持本机路径/);
  assert.throws(() => store.registerHome({ homePath: '/x', harness: 'workbuddy', readOnly: true }), /只读实例只支持本机 dsh home/);
  assert.throws(() => store.registerHome({ homePath: '/x', harness: 'claude-code' }), /未知的 harness/);
});

test('monitor：WorkBuddy 不探测 HTTP/端口，按 home 目录存在与否标 running/gone', async (t) => {
  const home = { homeId: 'bc'.repeat(8), homePath: '/home/u/.workbuddy', hostType: 'local', harness: 'workbuddy', readOnly: false };
  let probed = false;
  let exists = true;
  const monitor = new Monitor({
    store: { listHomes: () => [home], getHome: () => home },
    launcher: { status: () => null },
    registry: new InstanceRegistry(),
    probe: async () => { probed = true; return true; },
    exists: () => exists,
    broadcast: () => {},
    intervalMs: 60_000,
  });
  t.after(() => monitor.stop());
  await monitor.checkNow();
  assert.equal(probed, false, 'WorkBuddy 是只读数据源，不做网络探测');
  assert.equal(monitor.get(home.homeId).runtime, 'running');
  assert.equal(monitor.get(home.homeId).url, null);

  exists = false;
  await monitor.refresh(home.homeId);
  assert.equal(monitor.get(home.homeId).runtime, 'gone');
});
