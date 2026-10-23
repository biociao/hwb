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
import { codexIndexRows } from '../src/codexhome/index-rows.js';
import { initLogger } from '../src/lib/logger.js';

// 单元测试静默日志：索引失败路径会把 error 打进测试输出。
initLogger({ level: 'error', file: false, color: false, silent: true });

const NOW = Date.parse('2026-10-23T04:00:00.000Z');
const ISO = new Date(NOW).toISOString();
const CODEX_HOME = '/mock/codex';
const HOME_ID = 'ab'.repeat(8);
const THREAD_USER = '01a0b7eb-4434-7712-bfe7-1e95bc79b266';
const THREAD_AUTO = '01a166a3-3866-7eb0-a34c-b30bc1026ef1';

function codexHome(overrides = {}) {
  return { homeId: HOME_ID, homePath: CODEX_HOME, alias: 'Codex', hostType: 'local', harness: 'codex', ...overrides };
}

function snapshot() {
  return {
    generatedAt: ISO,
    degraded: false,
    reasons: [],
    projects: [
      {
        id: 'proj-renji',
        name: 'PMAID-RENJI',
        roots: ['/repo/renji', '/repo/renji2'],
        threads: [
          { id: THREAD_USER, title: '软著申报', tokens: 100, updatedAt: ISO, source: null, automated: false },
          { id: THREAD_AUTO, title: 'Guardian review', tokens: 0, updatedAt: ISO, source: 'guardian_review', automated: true },
        ],
      },
      {
        id: 'proj-empty',
        name: '只有自动会话的项目',
        roots: ['/repo/empty'],
        threads: [{ id: THREAD_AUTO, title: 'Guardian review', tokens: 0, updatedAt: ISO, source: 'guardian_review', automated: true }],
      },
    ],
  };
}

test('Codex 快照 → 同构行：workspace=项目、session=用户会话，自动线程不进列表', () => {
  const rows = codexIndexRows(codexHome(), snapshot(), { now: NOW });
  const homeRow = rows.find((r) => r.type === 'home');
  assert.equal(homeRow.homeId, HOME_ID);
  assert.deepEqual(homeRow.degraded, []);

  const workspaces = rows.filter((r) => r.type === 'workspace');
  assert.equal(workspaces.length, 1); // 只有自动会话的项目不建 workspace
  assert.equal(workspaces[0].workspaceId, 'proj-renji');
  assert.equal(workspaces[0].project, 'PMAID-RENJI');
  assert.equal(workspaces[0].path, '/repo/renji');
  assert.equal(workspaces[0].title, 'PMAID-RENJI');

  const sessions = rows.filter((r) => r.type === 'session');
  assert.equal(sessions.length, 1); // Guardian review 被排除
  assert.equal(sessions[0].sessionId, THREAD_USER);
  assert.equal(sessions[0].workspaceId, 'proj-renji');
  assert.equal(sessions[0].project, 'PMAID-RENJI');
  assert.equal(sessions[0].lastActivity, ISO);
  assert.deepEqual(JSON.parse(sessions[0].tokenUsage), { totalTokens: 100 });
  assert.deepEqual(JSON.parse(sessions[0].status), { kind: 'idle', label: '已保存', subagents: 0 });
});

test('未归属项目根的会话按 cwd basename 归一化，仍进 Recent Sessions', () => {
  const rows = codexIndexRows(codexHome(), {
    ...snapshot(),
    unassigned: [
      { id: '01a15000-0000-7000-8000-000000000000', title: '随手问', cwd: '/tmp/elsewhere', tokens: 7, updatedAt: ISO, source: null, automated: false },
      { id: '01a15001-0000-7000-8000-000000000001', title: 'Guardian review', cwd: '/tmp/elsewhere', tokens: 0, updatedAt: ISO, source: 'guardian_review', automated: true },
    ],
  }, { now: NOW });
  const session = rows.find((r) => r.sessionId === '01a15000-0000-7000-8000-000000000000');
  assert.ok(session, '未归属的用户会话应被索引');
  assert.equal(session.project, 'elsewhere');
  assert.equal(session.workspaceId, null);
  assert.equal(rows.filter((r) => r.source === 'guardian_review').length, 0);
});

test('Codex 快照降级时把原因带进 home 行（不阻塞已读到的数据）', () => {
  const rows = codexIndexRows(codexHome(), { ...snapshot(), degraded: true, reasons: ['db locked'] }, { now: NOW });
  assert.equal(rows[0].degraded.length, 1);
  assert.equal(rows[0].degraded[0].domain, 'codex');
  assert.match(rows[0].degraded[0].error, /db locked/);
  assert.equal(rows.filter((r) => r.type === 'session').length, 1);
});

test('Codex 实例经同一个 Indexer 落库后出现在 Recent Projects / Recent Sessions', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwb-codex-home-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new IndexStore(path.join(dir, 'hwb.db'));
  t.after(() => store.close());

  const homeId = store.registerHome({ homePath: CODEX_HOME, alias: 'Codex', hostType: 'local', harness: 'codex' });
  const home = store.getHome(homeId);
  assert.equal(home.harness, 'codex');
  assert.equal(home.hostType, 'local');

  let received = null;
  const indexer = new Indexer({
    store,
    homes: () => store.listHomes(),
    broadcast: () => {},
    codex: { readProjects: (options) => { received = options; return snapshot(); } },
    baseMs: 100,
  });
  const results = await indexer.reindexNow(homeId);
  assert.equal(results[0].ok, true);
  assert.equal(results[0].harness, 'codex');
  assert.equal(results[0].sessionCount, 1);
  assert.equal(results[0].workspaceCount, 1);
  assert.equal(received.days, 3650); // 索引是全量，不受 Recent 的 7 天窗口影响

  const projects = store.recentProjects({ days: 3650, homeIds: [homeId] });
  const renji = projects.find((p) => p.project === 'PMAID-RENJI');
  assert.ok(renji, 'Codex 项目应出现在 Recent Projects');
  assert.equal(renji.sessionCount, 1);
  assert.equal(renji.totalTokens, 100);
  assert.equal(renji.inputTokens, 0);   // Codex 没有输入/输出拆分
  assert.equal(renji.outputTokens, 0);
  assert.equal(renji.workspaceId, 'proj-renji');
  assert.equal(renji.homeId, homeId);

  const sessions = store.recentSessions({ homeIds: [homeId] });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sessionId, THREAD_USER);
  assert.equal(sessions[0].title, '软著申报');
  assert.equal(sessions[0].project, 'PMAID-RENJI');
  assert.deepEqual(sessions[0].tokenUsage, { totalTokens: 100 });

  // Token 用量面板只统计 dsh：Codex 没有输入/输出拆分，不能混进分项/命中率。
  assert.equal(store.usageSummary({ days: 3650 }).sessionCount, 0);
  assert.equal(store.usageSummary({ days: 3650 }).totalTokens, 0);
  assert.deepEqual(store.usageByProject({ days: 3650 }), []);
  assert.deepEqual(store.usageTrend({ hours: 24 * 365 }).filter((b) => b.input || b.output || b.cacheRead || b.cacheWrite), []);

  // 再索引一次：整表替换不能把 Codex 行弄丢/重复
  await indexer.reindexNow(homeId);
  assert.equal(store.recentSessions({ homeIds: [homeId] }).length, 1);
});

test('Codex 实例的 runtime 由 monitor 直接标成 running，且不做进程/端口探测', async () => {
  let probed = false;
  const home = codexHome();
  const registry = new InstanceRegistry();
  const monitor = new Monitor({
    store: { listHomes: () => [home], getHome: () => home },
    launcher: { status: () => null },
    registry,
    probe: async () => { probed = true; return true; },
    exists: () => true,
    broadcast: () => {},
    intervalMs: 60_000,
  });
  await monitor.checkNow();
  assert.equal(probed, false, 'Codex 实例不应触发 HTTP 探测');
  const runtime = monitor.get(HOME_ID);
  assert.equal(runtime.runtime, 'running');
  assert.equal(runtime.url, null);
  assert.ok(runtime.checkedAt);
});

test('Codex home 目录消失时 runtime=gone（而不是 stopped 后无限重连）', async () => {
  const home = codexHome({ homePath: '/missing/codex' });
  const monitor = new Monitor({
    store: { listHomes: () => [home], getHome: () => home },
    launcher: { status: () => null },
    registry: new InstanceRegistry(),
    probe: async () => { throw new Error('不应探测'); },
    exists: () => false,
    broadcast: () => {},
    intervalMs: 60_000,
  });
  await monitor.checkNow();
  assert.equal(monitor.get(HOME_ID).runtime, 'gone');
});

test('老库迁移：没有 harness 列时补列并默认 dsh，已注册的 Codex 实例不受影响', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwb-legacy-homes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'legacy.db');
  const raw = new DatabaseSync(file);
  raw.exec(`CREATE TABLE homes (
    homeId TEXT PRIMARY KEY, homePath TEXT NOT NULL, alias TEXT,
    hostType TEXT CHECK(hostType IN ('local','remote')) DEFAULT 'local',
    status TEXT DEFAULT 'unknown', lastIndexedAt TEXT, degraded TEXT DEFAULT '[]'
  )`);
  raw.prepare('INSERT INTO homes (homeId, homePath, alias, hostType) VALUES (?, ?, ?, ?)').run('cd'.repeat(8), '~/.dsh', 'legacy', 'local');
  raw.close();

  const store = new IndexStore(file);
  t.after(() => store.close());
  const legacy = store.getHome('cd'.repeat(8));
  assert.equal(legacy.harness, 'dsh');

  const codexId = store.registerHome({ homePath: CODEX_HOME, alias: 'Codex', harness: 'codex' });
  assert.equal(store.getHome(codexId).harness, 'codex');
  assert.equal(store.getHome('cd'.repeat(8)).harness, 'dsh');
});
