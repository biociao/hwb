import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  cleanWorkbuddyTitle,
  readWorkbuddySnapshot,
  workbuddyHomeInfo,
  workbuddyHomePath,
} from '../src/workbuddyhome/reader.js';
import {
  deepLinkFor,
  isWorkbuddySessionId,
  openWorkbuddyConversation,
  resolveWorkbuddyTarget,
} from '../src/workbuddyhome/open.js';

const NOW = Date.parse('2026-10-25T04:00:00.000Z');
const DAY = 86_400_000;

const S1 = '8d13a377-25e2-4732-9064-806d409c0e69';
const S2 = '46ca0f6a-4975-4a9d-a902-1ad8b73f7d59';
const S3 = '01a15000-0000-7000-8000-000000000000';
const S_DELETED = '01a16000-0000-7000-8000-000000000000';

function makeWorkbuddyHome(t, { sessions = [], workspaces = [], usage = [], withDb = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwb-workbuddy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (!withDb) return dir;

  const db = new DatabaseSync(path.join(dir, 'workbuddy.db'));
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, cwd TEXT, title TEXT, custom_title TEXT, status TEXT,
      created_at INTEGER, updated_at INTEGER, deleted_at INTEGER, model TEXT,
      last_activity_at INTEGER, project_id TEXT
    );
    CREATE TABLE workspaces (path TEXT PRIMARY KEY, last_opened_at INTEGER);
    CREATE TABLE session_usage (session_id TEXT PRIMARY KEY, used INTEGER, size INTEGER, updated_at INTEGER);
  `);
  const insertSession = db.prepare(`INSERT INTO sessions
    (id, cwd, title, custom_title, status, created_at, updated_at, deleted_at, model, last_activity_at, project_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const session of sessions) {
    insertSession.run(
      session.id,
      session.cwd ?? null,
      session.title ?? null,
      session.customTitle ?? null,
      session.status ?? null,
      session.createdAt ?? NOW - DAY,
      session.updatedAt ?? NOW - DAY,
      session.deletedAt ?? null,
      session.model ?? null,
      session.lastActivityAt ?? session.updatedAt ?? NOW - DAY,
      session.projectId ?? null,
    );
  }
  const insertWorkspace = db.prepare('INSERT INTO workspaces (path, last_opened_at) VALUES (?, ?)');
  for (const workspace of workspaces) insertWorkspace.run(workspace.path, workspace.lastOpenedAt ?? NOW);
  const insertUsage = db.prepare('INSERT INTO session_usage (session_id, used, size, updated_at) VALUES (?, ?, ?, ?)');
  for (const row of usage) insertUsage.run(row.sessionId, row.used, row.size, row.updatedAt ?? NOW);
  db.close();
  return dir;
}

test('workbuddyHomePath：WORKBUDDY_HOME 覆盖，默认 ~/.workbuddy', () => {
  assert.equal(workbuddyHomePath({}), path.join(os.homedir(), '.workbuddy'));
  assert.equal(workbuddyHomePath({ WORKBUDDY_HOME: '/tmp/wb-custom' }), '/tmp/wb-custom');
  assert.equal(workbuddyHomePath({ WORKBUDDY_HOME: '  ' }), path.join(os.homedir(), '.workbuddy'));
});

test('workbuddyHomeInfo：目录存在性 + workbuddy.db 哨兵', (t) => {
  const withDb = makeWorkbuddyHome(t, {});
  assert.deepEqual(workbuddyHomeInfo(withDb), {
    path: withDb,
    exists: true,
    looksLikeWorkbuddy: true,
  });

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'hwb-workbuddy-empty-'));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  assert.deepEqual(workbuddyHomeInfo(empty), { path: empty, exists: true, looksLikeWorkbuddy: false });

  const missing = path.join(empty, 'nope');
  assert.deepEqual(workbuddyHomeInfo(missing), { path: missing, exists: false, looksLikeWorkbuddy: false });
});

test('读取会话：deleted_at 过滤、last_activity_at 降序、字段映射', (t) => {
  const home = makeWorkbuddyHome(t, {
    sessions: [
      {
        id: S1, cwd: '/repo/alpha', title: '做U盘启动盘', status: 'completed',
        updatedAt: NOW - DAY, lastActivityAt: NOW - 3 * DAY, model: 'space-bunny',
      },
      {
        id: S2, cwd: '/repo/beta', title: '每日 AI 新闻推送', status: 'error',
        updatedAt: NOW - 2 * DAY, lastActivityAt: NOW - DAY, model: 'auto',
      },
      {
        id: S_DELETED, cwd: '/repo/alpha', title: '已删除的会话', status: 'completed',
        updatedAt: NOW, lastActivityAt: NOW, deletedAt: NOW,
      },
    ],
  });

  const snapshot = readWorkbuddySnapshot({ home, now: NOW });
  assert.equal(snapshot.home, home);
  assert.equal(snapshot.degraded, false);
  assert.deepEqual(snapshot.reasons, []);
  assert.equal(snapshot.dbPath, path.join(home, 'workbuddy.db'));
  assert.equal(snapshot.generatedAt, new Date(NOW).toISOString());
  assert.equal(snapshot.sessions.length, 2); // 软删除的不出现
  assert.equal(snapshot.sessions[0].id, S2); // last_activity_at 更新
  assert.equal(snapshot.sessions[1].id, S1);
  assert.deepEqual(snapshot.sessions[0].title, '每日 AI 新闻推送');
  assert.equal(snapshot.sessions[0].status, 'error'); // 原始状态保留，语义映射交给 index-rows
  assert.equal(snapshot.sessions[0].model, 'auto');
  assert.equal(snapshot.sessions[0].cwd, '/repo/beta');
  assert.equal(snapshot.sessions[0].updatedAt, new Date(NOW - DAY).toISOString());
  assert.deepEqual(snapshot.totals, { workspaceCount: 0, sessionCount: 2 });
});

test('last_activity_at 缺失/为 0 时回退 updated_at；last_activity_at 优先于 updated_at', (t) => {
  const home = makeWorkbuddyHome(t, {
    sessions: [
      { id: S1, title: '只有 updated_at', lastActivityAt: 0, updatedAt: NOW - 5 * DAY },
      { id: S2, title: '两个都有', lastActivityAt: NOW - DAY, updatedAt: NOW - 10 * DAY },
    ],
  });
  const snapshot = readWorkbuddySnapshot({ home, now: NOW });
  const first = snapshot.sessions.find((s) => s.id === S1);
  const second = snapshot.sessions.find((s) => s.id === S2);
  assert.equal(first.updatedAt, new Date(NOW - 5 * DAY).toISOString());
  assert.equal(second.updatedAt, new Date(NOW - DAY).toISOString()); // 优先 last_activity_at
  assert.equal(snapshot.sessions[0].id, S2);
});

test('标题清洗：custom_title 优先、压成单行、超长截断、空标题回退', (t) => {
  const longTitle = '很长的标题'.repeat(40);
  const home = makeWorkbuddyHome(t, {
    sessions: [
      { id: S1, title: '自动标题', customTitle: '我改的名字' },
      { id: S2, title: `第一行\n第二行\t带制表符` },
      { id: S3, title: longTitle },
    ],
  });
  const byId = new Map(readWorkbuddySnapshot({ home, now: NOW }).sessions.map((s) => [s.id, s]));

  assert.equal(byId.get(S1).title, '我改的名字');
  assert.equal(byId.get(S2).title, '第一行 第二行 带制表符');
  assert.equal(byId.get(S2).title.includes('\n'), false);
  const truncated = byId.get(S3).title;
  assert.equal(truncated.length, 120);
  assert.equal(truncated.endsWith('…'), true);

  assert.equal(cleanWorkbuddyTitle('', '未命名会话'), '未命名会话');
  assert.equal(cleanWorkbuddyTitle('   ', '未命名会话'), '未命名会话');
  assert.equal(cleanWorkbuddyTitle(null, '未命名会话'), '未命名会话');
  assert.equal(cleanWorkbuddyTitle('  正常  ', 'x'), '正常');
});

test('workspaces 按 last_opened_at 降序，ISO 输出', (t) => {
  const home = makeWorkbuddyHome(t, {
    workspaces: [
      { path: '/repo/old', lastOpenedAt: NOW - 10 * DAY },
      { path: '/repo/new', lastOpenedAt: NOW - DAY },
      { path: '/repo/never', lastOpenedAt: 0 },
    ],
  });
  const snapshot = readWorkbuddySnapshot({ home, now: NOW });
  assert.equal(snapshot.workspaces.length, 3);
  assert.equal(snapshot.workspaces[0].path, '/repo/new');
  assert.equal(snapshot.workspaces[0].lastOpenedAt, new Date(NOW - DAY).toISOString());
  assert.equal(snapshot.workspaces[1].path, '/repo/old');
  assert.equal(snapshot.workspaces[2].lastOpenedAt, null);
});

test('session_usage 带出 used/size；无记录时为 null（不伪装成 token 拆分）', (t) => {
  const home = makeWorkbuddyHome(t, {
    sessions: [
      { id: S1, title: '有用量' },
      { id: S2, title: '没有用量' },
    ],
    usage: [{ sessionId: S1, used: 31130, size: 168000 }],
  });
  const snapshot = readWorkbuddySnapshot({ home, now: NOW });
  const byId = new Map(snapshot.sessions.map((s) => [s.id, s]));
  assert.deepEqual(byId.get(S1).usage, { used: 31130, size: 168000 });
  assert.equal(byId.get(S2).usage, null);
});

test('limit 限制返回会话数（仍按最近活跃优先）', (t) => {
  const sessions = Array.from({ length: 10 }, (_, i) => ({
    id: `01a15000-0000-7000-8000-${String(i).padStart(12, '0')}`,
    title: `会话 ${i}`,
    lastActivityAt: NOW - i * 1000,
  }));
  const home = makeWorkbuddyHome(t, { sessions });
  const snapshot = readWorkbuddySnapshot({ home, limit: 3, now: NOW });
  assert.equal(snapshot.sessions.length, 3);
  assert.deepEqual(snapshot.sessions.map((s) => s.title), ['会话 0', '会话 1', '会话 2']);
});

test('库缺失/损坏只降级不抛：reasons 进快照', (t) => {
  const noDb = makeWorkbuddyHome(t, { withDb: false });
  const missing = readWorkbuddySnapshot({ home: noDb, now: NOW });
  assert.equal(missing.degraded, true);
  assert.equal(missing.sessions.length, 0);
  assert.equal(missing.workspaces.length, 0);
  assert.equal(missing.dbPath, null);
  assert.equal(missing.reasons.some((r) => r.includes('workbuddy.db')), true);

  const corruptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwb-workbuddy-corrupt-'));
  t.after(() => fs.rmSync(corruptDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(corruptDir, 'workbuddy.db'), 'not a sqlite database');
  const corrupt = readWorkbuddySnapshot({ home: corruptDir, now: NOW });
  assert.equal(corrupt.degraded, true);
  assert.equal(corrupt.sessions.length, 0);
  assert.equal(corrupt.reasons.some((r) => r.includes('读取 WorkBuddy 元数据失败')), true);
});

test('只读打开：不创建 -wal/-shm，库文件字节不变', (t) => {
  const home = makeWorkbuddyHome(t, {
    sessions: [{ id: S1, title: '只读' }],
    workspaces: [{ path: '/repo/a' }],
  });
  const dbFile = path.join(home, 'workbuddy.db');
  const before = fs.readFileSync(dbFile);
  const dirBefore = new Set(fs.readdirSync(home));

  readWorkbuddySnapshot({ home, now: NOW });

  const after = fs.readFileSync(dbFile);
  assert.equal(after.equals(before), true, '库文件内容必须保持不变');
  assert.deepEqual(new Set(fs.readdirSync(home)), dirBefore, '不得新增 -wal/-shm 等文件');
});

test('UUID 校验与深链：只接受合法 UUID，规范化小写', () => {
  assert.equal(isWorkbuddySessionId(S1), true);
  assert.equal(isWorkbuddySessionId(S1.toUpperCase()), true);
  assert.equal(isWorkbuddySessionId('not-a-uuid'), false);
  assert.equal(isWorkbuddySessionId('../evil'), false);
  assert.equal(isWorkbuddySessionId(''), false);
  assert.equal(isWorkbuddySessionId(null), false);

  assert.equal(deepLinkFor(S1.toUpperCase()), `workbuddy://chat/${S1}`);
  assert.throws(() => deepLinkFor('../../etc/passwd'), /无效的 WorkBuddy 会话 id/);
});

test('openWorkbuddyConversation：darwin 走 open(1)，失败回退可复制命令', async () => {
  const calls = [];
  const runner = async (...args) => { calls.push(args); };
  const ok = await openWorkbuddyConversation(S1, { platform: 'darwin', runner });
  assert.deepEqual(ok, { ok: true, sessionId: S1, url: `workbuddy://chat/${S1}`, fallback: `open "workbuddy://chat/${S1}"` });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/usr/bin/open');
  assert.deepEqual(calls[0][1], [`workbuddy://chat/${S1}`]);

  const failing = await openWorkbuddyConversation(S1, {
    platform: 'darwin',
    runner: async () => { throw new Error('LaunchServices: no handler'); },
  });
  assert.equal(failing.ok, false);
  assert.match(failing.error, /未能唤起 WorkBuddy/);
  assert.equal(failing.fallback, `open "workbuddy://chat/${S1}"`);

  let nonDarwinCalls = 0;
  const linux = await openWorkbuddyConversation(S1, {
    platform: 'linux',
    runner: async () => { nonDarwinCalls += 1; },
  });
  assert.equal(linux.ok, false);
  assert.equal(linux.url, `workbuddy://chat/${S1}`);
  assert.equal(linux.fallback, `xdg-open "workbuddy://chat/${S1}"`);
  assert.match(linux.error, /不支持自动跳转 WorkBuddy/);
  assert.equal(nonDarwinCalls, 0); // 不猜 xdg-open 的行为

  await assert.rejects(openWorkbuddyConversation('bad-id', { platform: 'linux' }), /无效的 WorkBuddy 会话 id/);
});

test('resolveWorkbuddyTarget：sessionId > projectId 最近会话 > 实例最近会话', () => {
  const snapshot = {
    sessions: [
      { id: S1, cwd: '/repo/proj/alpha/sub' },
      { id: S2, cwd: '/repo/proj/alpha' },
      { id: S3, cwd: '/repo/other' },
      { id: 'dirty-id-not-uuid', cwd: '/repo/proj/alpha' },
    ],
  };

  assert.equal(resolveWorkbuddyTarget(snapshot, { sessionId: S2 }), S2);
  assert.equal(resolveWorkbuddyTarget(snapshot, { projectId: '/repo/proj/alpha' }), S1);
  assert.equal(resolveWorkbuddyTarget(snapshot, { projectId: '/repo/proj/alpha/' }), S1);
  assert.equal(resolveWorkbuddyTarget(snapshot, { projectId: '/repo/none' }), null);
  assert.equal(resolveWorkbuddyTarget(snapshot, {}), S1); // 最近一条（跳过非法 id）
  assert.equal(resolveWorkbuddyTarget({ sessions: [] }, {}), null);
  assert.equal(resolveWorkbuddyTarget(null, {}), null);
  assert.throws(() => resolveWorkbuddyTarget(snapshot, { sessionId: 'not-a-uuid' }), /无效的 WorkBuddy 会话 id/);
});
