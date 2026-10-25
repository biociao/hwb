import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IndexStore } from '../src/dshhome/store.js';
import { workbuddyIndexRows } from '../src/workbuddyhome/index-rows.js';
import { initLogger } from '../src/lib/logger.js';

// 单元测试静默日志：索引失败路径会把 error 打进测试输出。
initLogger({ level: 'error', file: false, color: false, silent: true });

const NOW = Date.parse('2026-10-25T04:00:00.000Z');
const ISO = new Date(NOW).toISOString();
const HOME_ID = 'ab'.repeat(8);
const WB_HOME = '/mock/workbuddy';
const S1 = '8d13a377-25e2-4732-9064-806d409c0e69';
const S2 = '46ca0f6a-4975-4a9d-a902-1ad8b73f7d59';
const S3 = '01a15000-0000-7000-8000-000000000000';

function workbuddyHome(overrides = {}) {
  return { homeId: HOME_ID, homePath: WB_HOME, alias: 'WorkBuddy', hostType: 'local', harness: 'workbuddy', ...overrides };
}

function snapshot(overrides = {}) {
  return {
    generatedAt: ISO,
    degraded: false,
    reasons: [],
    workspaces: [
      { path: '/repo/proj/alpha', lastOpenedAt: ISO },
      { path: '/repo/proj/alpha/sub', lastOpenedAt: ISO },
      { path: '/repo/empty', lastOpenedAt: ISO },
    ],
    sessions: [
      { id: S1, title: '完成的项目会话', cwd: '/repo/proj/alpha/sub/deep', status: 'completed', updatedAt: ISO },
      { id: S2, title: '中断的会话', cwd: '/repo/proj/alpha', status: 'Terminated', updatedAt: ISO },
      { id: S3, title: '未归属会话', cwd: '/tmp/elsewhere/work', status: 'error', updatedAt: ISO },
    ],
    ...overrides,
  };
}

test('WorkBuddy 快照 → 同构行：home / workspace / session 三类行', () => {
  const rows = workbuddyIndexRows(workbuddyHome(), snapshot(), { now: NOW });
  const homeRow = rows.find((r) => r.type === 'home');
  assert.equal(homeRow.homeId, HOME_ID);
  assert.equal(homeRow.homePath, WB_HOME);
  assert.equal(homeRow.generatedAt, ISO);
  assert.deepEqual(homeRow.degraded, []);
});

test('workspace = 所有 workspaces 行（含 0 会话），workspaceId=path、title=basename', () => {
  const rows = workbuddyIndexRows(workbuddyHome(), snapshot(), { now: NOW });
  const workspaces = rows.filter((r) => r.type === 'workspace');
  assert.equal(workspaces.length, 3);
  const empty = workspaces.find((w) => w.path === '/repo/empty');
  assert.equal(empty.sessionCount, 0); // 没有会话也建 workspace（dsh workspace.json 口径）
  assert.equal(empty.workspaceId, '/repo/empty');
  assert.equal(empty.title, 'empty');
  assert.equal(empty.project, 'empty');
  const alpha = workspaces.find((w) => w.path === '/repo/proj/alpha');
  assert.equal(alpha.sessionCount, 1); // S2 直接落在 alpha；S1 归更长的 sub
  const sub = workspaces.find((w) => w.path === '/repo/proj/alpha/sub');
  assert.equal(sub.sessionCount, 1);
  assert.equal(sub.workspaceId, '/repo/proj/alpha/sub');
  assert.equal(sub.title, 'sub');
});

test('项目归属按 cwd 最长前缀匹配（嵌套 workspace 落到更具体的那个）', () => {
  const rows = workbuddyIndexRows(workbuddyHome(), snapshot(), { now: NOW });
  const sessions = rows.filter((r) => r.type === 'session');
  const s1 = sessions.find((s) => s.sessionId === S1);
  assert.equal(s1.workspaceId, '/repo/proj/alpha/sub');
  assert.equal(s1.workspaceTitle, 'sub');
  assert.equal(s1.project, 'sub');
  const s2 = sessions.find((s) => s.sessionId === S2);
  assert.equal(s2.workspaceId, '/repo/proj/alpha');
});

test('未归属会话按 basename(cwd) 归一化，workspaceId 为 null', () => {
  const rows = workbuddyIndexRows(workbuddyHome(), snapshot(), { now: NOW });
  const s3 = rows.find((r) => r.type === 'session' && r.sessionId === S3);
  assert.equal(s3.workspaceId, null);
  assert.equal(s3.workspaceTitle, null);
  assert.equal(s3.project, 'work');
});

test('状态映射：completed/Completed → 已完成；terminated/error/failed → 已保存', () => {
  const rows = workbuddyIndexRows(workbuddyHome(), {
    ...snapshot(),
    sessions: [
      { id: S1, title: 'a', cwd: '/repo/proj/alpha', status: 'completed', updatedAt: ISO },
      { id: S2, title: 'b', cwd: '/repo/proj/alpha', status: 'Completed', updatedAt: ISO },
      { id: S3, title: 'c', cwd: '/repo/proj/alpha', status: 'terminated', updatedAt: ISO },
      { id: '01a16000-0000-7000-8000-000000000000', title: 'd', cwd: '/repo/proj/alpha', status: 'failed', updatedAt: ISO },
      { id: '01a17000-0000-7000-8000-000000000000', title: 'e', cwd: '/repo/proj/alpha', status: null, updatedAt: ISO },
    ],
  }, { now: NOW });
  const sessions = rows.filter((r) => r.type === 'session');
  const statusOf = (id) => JSON.parse(sessions.find((s) => s.sessionId === id).status);
  assert.deepEqual(statusOf(S1), { kind: 'completed', label: '已完成', subagents: 0 });
  assert.deepEqual(statusOf(S2), { kind: 'completed', label: '已完成', subagents: 0 });
  assert.deepEqual(statusOf(S3), { kind: 'idle', label: '已保存', subagents: 0 });
  assert.deepEqual(statusOf('01a16000-0000-7000-8000-000000000000'), { kind: 'idle', label: '已保存', subagents: 0 });
  assert.deepEqual(statusOf('01a17000-0000-7000-8000-000000000000'), { kind: 'idle', label: '已保存', subagents: 0 });
});

test('tokenUsage/contextPressure 一律 null（上下文用量不伪装成 token 拆分）', () => {
  const rows = workbuddyIndexRows(workbuddyHome(), snapshot(), { now: NOW });
  const sessions = rows.filter((r) => r.type === 'session');
  assert.ok(sessions.length > 0);
  for (const session of sessions) {
    assert.equal(session.tokenUsage, null);
    assert.equal(session.contextPressure, null);
  }
});

test('lastActivity 取会话 updatedAt；generatedAt 缺失时用注入的 now', () => {
  const rows = workbuddyIndexRows(workbuddyHome(), {
    ...snapshot(),
    generatedAt: undefined,
  }, { now: NOW });
  assert.equal(rows[0].generatedAt, ISO);
  const session = rows.find((r) => r.type === 'session');
  assert.equal(session.lastActivity, ISO);
  assert.equal(session.generatedAt, ISO);
});

test('reasons → home 行 degraded 域固定为 workbuddy', () => {
  const rows = workbuddyIndexRows(workbuddyHome(), {
    ...snapshot(),
    reasons: ['未找到 workbuddy.db（会话列表降级）', '读取 WorkBuddy 元数据失败：database is locked'],
  }, { now: NOW });
  const homeRow = rows.find((r) => r.type === 'home');
  assert.equal(homeRow.degraded.length, 1);
  assert.equal(homeRow.degraded[0].domain, 'workbuddy');
  assert.match(homeRow.degraded[0].error, /workbuddy\.db/);
  assert.match(homeRow.degraded[0].error, /database is locked/);
});

test('空快照只产出 home 行，不抛', () => {
  const rows = workbuddyIndexRows(workbuddyHome(), { generatedAt: ISO, workspaces: [], sessions: [], reasons: [] }, { now: NOW });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'home');
});

test('行格式能直接落进 IndexStore：计数/降级/最近会话可查', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwb-workbuddy-index-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new IndexStore(path.join(dir, 'hwb.db'));
  t.after(() => store.close?.());

  const homeId = store.registerHome({ homePath: WB_HOME, alias: 'WorkBuddy', hostType: 'local', harness: 'workbuddy' });
  const home = store.getHome(homeId);
  store.upsertRows(workbuddyIndexRows(home, snapshot(), { now: NOW }));

  const stored = store.getHome(homeId);
  assert.equal(stored.harness, 'workbuddy');
  assert.equal(stored.status, 'ok');
  assert.equal(stored.workspaceCount, 3);
  assert.equal(stored.sessionCount, 3);
  assert.equal(stored.lastIndexedAt, ISO);

  const sessions = store.recentSessions({ homeId, limit: 10 });
  assert.equal(sessions.length, 3);
  const titles = sessions.map((s) => s.title).sort();
  assert.deepEqual(titles, ['中断的会话', '完成的项目会话', '未归属会话'].sort());

  // 降级快照：home 行写 degraded 域，且不抛。
  store.upsertRows(workbuddyIndexRows(home, {
    ...snapshot(),
    reasons: ['未找到 workbuddy.db（会话列表降级）'],
  }, { now: NOW }));
  const degraded = store.getHome(homeId);
  assert.equal(degraded.status, 'degraded');
  assert.equal(degraded.degraded[0].domain, 'workbuddy');
});
