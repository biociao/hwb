import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  LOCAL_TOOL_HARNESSES,
  LOCAL_TOOL_SOURCES,
  detectLocalTool,
  isLocalToolHome,
  localToolDefaultHome,
  localToolHomePlaceholder,
  localToolLabel,
} from '../src/lib/harnesses.js';
import { codexHomePath } from '../src/codexhome/reader.js';
import { workbuddyHomePath } from '../src/workbuddyhome/reader.js';

const NOW = Date.parse('2026-10-25T04:00:00.000Z');
const DAY = 86_400_000;
const T_RECENT = '8d13a377-25e2-4732-9064-806d409c0e69';
const T_OLD = '46ca0f6a-4975-4a9d-a902-1ad8b73f7d59';
const HOME_ID = 'ab'.repeat(8);

// —— 夹具：WorkBuddy（workbuddy.db）/ Codex（state_5.sqlite + global json）——

function mkTemp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeWorkbuddyHome(t, { sessions = [], workspaces = [] } = {}) {
  const dir = mkTemp(t, 'hwb-harnesses-wb-');
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
  for (const s of sessions) {
    insertSession.run(s.id, s.cwd ?? null, s.title ?? null, s.customTitle ?? null, s.status ?? null,
      s.at ?? NOW, s.at ?? NOW, null, s.model ?? null, s.at ?? NOW, s.projectId ?? null);
  }
  const insertWorkspace = db.prepare('INSERT INTO workspaces (path, last_opened_at) VALUES (?, ?)');
  for (const w of workspaces) insertWorkspace.run(w.path, w.lastOpenedAt ?? NOW);
  db.close();
  return dir;
}

function makeCodexHome(t, { threads = [], projects = null } = {}) {
  const dir = mkTemp(t, 'hwb-harnesses-codex-');
  const global = {
    'local-projects': Object.fromEntries((projects ?? [{ id: 'local-p1', name: 'Alpha', rootPaths: ['/repo/alpha'] }])
      .map((p) => [p.id, { id: p.id, name: p.name, rootPaths: p.rootPaths }])),
    'pinned-project-ids': [],
    'project-order': [],
    'thread-project-assignments': {},
  };
  fs.writeFileSync(path.join(dir, '.codex-global-state.json'), JSON.stringify(global));

  const db = new DatabaseSync(path.join(dir, 'state_5.sqlite'));
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY, title TEXT, cwd TEXT, tokens_used INTEGER,
      updated_at INTEGER, updated_at_ms INTEGER, archived INTEGER, is_pinned INTEGER,
      git_branch TEXT, preview TEXT, first_user_message TEXT, thread_source TEXT
    );
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, position INTEGER);
    CREATE TABLE project_roots (project_id TEXT, position INTEGER, path TEXT);
  `);
  const insertThread = db.prepare(`INSERT INTO threads
    (id, title, cwd, tokens_used, updated_at, updated_at_ms, archived, is_pinned, git_branch, preview, first_user_message, thread_source)
    VALUES (?, ?, ?, ?, ?, ?, 0, 0, NULL, NULL, NULL, NULL)`);
  for (const thread of threads) {
    insertThread.run(thread.id, thread.title ?? 'thread', thread.cwd ?? '/repo/alpha', 10,
      Math.floor((thread.at ?? NOW) / 1000), thread.at ?? NOW);
  }
  db.close();
  return dir;
}

function withEnv(t, key, value) {
  const previous = process.env[key];
  process.env[key] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });
}

// —— 纯函数：判定 / 文案 / 默认 home / 探测 ——

test('LOCAL_TOOL_HARNESSES 精确为 codex + workbuddy（dsh 只读不在描述符表里）', () => {
  assert.deepEqual([...LOCAL_TOOL_HARNESSES], ['codex', 'workbuddy']);
  assert.deepEqual(Object.keys(LOCAL_TOOL_SOURCES).sort(), ['codex', 'workbuddy']);
  assert.equal(LOCAL_TOOL_SOURCES.dsh, undefined);
});

test('isLocalToolHome：codex / workbuddy / dsh+readOnly，其余不是', () => {
  assert.equal(isLocalToolHome({ harness: 'codex' }), true);
  assert.equal(isLocalToolHome({ harness: 'workbuddy' }), true);
  assert.equal(isLocalToolHome({ harness: 'dsh', readOnly: true }), true);
  assert.equal(isLocalToolHome({ harness: 'dsh', readOnly: false }), false);
  assert.equal(isLocalToolHome({ harness: 'dsh' }), false);
  assert.equal(isLocalToolHome({ harness: 'unknown' }), false);
  assert.equal(isLocalToolHome(null), false);
  assert.equal(isLocalToolHome(undefined), false);
});

test('localToolLabel：Codex / WorkBuddy / dsh（只读），其余 null', () => {
  assert.equal(localToolLabel({ harness: 'codex' }), 'Codex');
  assert.equal(localToolLabel({ harness: 'workbuddy' }), 'WorkBuddy');
  // 契约 §4.1 与 §2 的 chip 文本都是小写 dsh
  assert.equal(localToolLabel({ harness: 'dsh', readOnly: true }), 'dsh');
  assert.equal(localToolLabel({ harness: 'dsh' }), null);
  assert.equal(localToolLabel({ harness: 'other' }), null);
  assert.equal(localToolLabel(null), null);
});

test('localToolDefaultHome：尊重 CODEX_HOME / WORKBUDDY_HOME，缺省为 ~ 下目录', (t) => {
  // 默认值与 reader 的 homePath 口径一致（纯模块不能静态 import reader，这里对拍防漂移）
  assert.equal(localToolDefaultHome('codex'), codexHomePath());
  assert.equal(localToolDefaultHome('workbuddy'), workbuddyHomePath());
  assert.equal(localToolDefaultHome('dsh'), path.join(os.homedir(), '.dsh'));
  assert.equal(localToolDefaultHome('unknown'), null);

  withEnv(t, 'CODEX_HOME', '/tmp/codex-env-home');
  withEnv(t, 'WORKBUDDY_HOME', '/tmp/workbuddy-env-home');
  assert.equal(localToolDefaultHome('codex'), '/tmp/codex-env-home');
  assert.equal(localToolDefaultHome('workbuddy'), '/tmp/workbuddy-env-home');
  assert.equal(localToolDefaultHome('codex'), codexHomePath()); // reader 同样读 env
  assert.equal(localToolDefaultHome('workbuddy'), workbuddyHomePath());
});

test('localToolHomePlaceholder：~ 形式，未知返回 null', () => {
  assert.equal(localToolHomePlaceholder('codex'), '~/.codex');
  assert.equal(localToolHomePlaceholder('workbuddy'), '~/.workbuddy');
  assert.equal(localToolHomePlaceholder('dsh'), '~/.dsh');
  assert.equal(localToolHomePlaceholder('unknown'), null);
});

test('detectLocalTool：自定义路径探测（workbuddy 认 workbuddy.db）', (t) => {
  const withDb = makeWorkbuddyHome(t, { workspaces: [{ path: '/repo/a' }] });
  assert.deepEqual(detectLocalTool('workbuddy', withDb), {
    path: withDb,
    exists: true,
    looksLikeWorkbuddy: true,
  });

  const empty = mkTemp(t, 'hwb-harnesses-empty-');
  assert.deepEqual(detectLocalTool('workbuddy', empty), {
    path: empty,
    exists: true,
    looksLikeWorkbuddy: false,
  });

  const missing = path.join(empty, 'nope');
  assert.deepEqual(detectLocalTool('workbuddy', missing), {
    path: missing,
    exists: false,
    looksLikeWorkbuddy: false,
  });

  // 用户填 `~` 形式：不会被 path.resolve 拼成 <cwd>/~
  assert.equal(detectLocalTool('workbuddy', '~/nope').path, path.join(os.homedir(), 'nope'));
  assert.equal(detectLocalTool('unknown', empty), null);
});

test('detectLocalTool：codex 认 state_5.sqlite / .codex-global-state.json，字段名沿用 looksLikeCodexHome', (t) => {
  const codexHome = makeCodexHome(t, {});
  assert.deepEqual(detectLocalTool('codex', codexHome), {
    path: codexHome,
    exists: true,
    looksLikeCodexHome: true,
  });

  const onlyGlobal = mkTemp(t, 'hwb-harnesses-codex-global-');
  fs.writeFileSync(path.join(onlyGlobal, '.codex-global-state.json'), '{}');
  assert.equal(detectLocalTool('codex', onlyGlobal).looksLikeCodexHome, true);

  const empty = mkTemp(t, 'hwb-harnesses-empty-');
  assert.equal(detectLocalTool('codex', empty).looksLikeCodexHome, false);
});

test('detectLocalTool：缺省路径用 localToolDefaultHome（不依赖真实 home）', (t) => {
  const wb = makeWorkbuddyHome(t, {});
  const codex = makeCodexHome(t, {});
  withEnv(t, 'WORKBUDDY_HOME', wb);
  withEnv(t, 'CODEX_HOME', codex);
  assert.deepEqual(detectLocalTool('workbuddy'), { path: wb, exists: true, looksLikeWorkbuddy: true });
  assert.deepEqual(detectLocalTool('codex'), { path: codex, exists: true, looksLikeCodexHome: true });
});

// —— 描述符形状 ——

test('LOCAL_TOOL_SOURCES 形状：label + readSnapshot/indexRows/resolveTarget/open', () => {
  assert.equal(LOCAL_TOOL_SOURCES.codex.label, 'Codex');
  assert.equal(LOCAL_TOOL_SOURCES.workbuddy.label, 'WorkBuddy');
  for (const source of Object.values(LOCAL_TOOL_SOURCES)) {
    assert.equal(typeof source.readSnapshot, 'function');
    assert.equal(typeof source.indexRows, 'function');
    assert.equal(typeof source.resolveTarget, 'function');
    assert.equal(typeof source.open, 'function');
  }
  // indexRows 是同步纯函数；碰 SQLite 的方法一律 async
  const rows = LOCAL_TOOL_SOURCES.workbuddy.indexRows(
    { homeId: HOME_ID, homePath: '/mock' },
    { generatedAt: new Date(NOW).toISOString(), workspaces: [], sessions: [], reasons: [] },
  );
  assert.equal(Array.isArray(rows), true);
  assert.equal(typeof LOCAL_TOOL_SOURCES.workbuddy.readSnapshot({ home: '/mock' }).then, 'function');
});

// —— WorkBuddy 数据面（reader → indexRows → resolveTarget → open）——

test('WorkBuddy readSnapshot/indexRows：接受 home 行对象，返回同构行', async (t) => {
  const home = makeWorkbuddyHome(t, {
    sessions: [
      { id: T_RECENT, cwd: '/repo/proj/alpha/sub', title: '最近的会话', status: 'completed', at: NOW - DAY },
      { id: T_OLD, cwd: '/repo/other', title: '更早的会话', status: 'terminated', at: NOW - 5 * DAY },
    ],
    workspaces: [{ path: '/repo/proj/alpha' }, { path: '/repo/proj/alpha/sub' }],
  });
  const homeRow = { homeId: HOME_ID, homePath: home, harness: 'workbuddy' };

  const snapshot = await LOCAL_TOOL_SOURCES.workbuddy.readSnapshot({ home: homeRow });
  assert.equal(snapshot.reasons.length, 0);
  assert.equal(snapshot.sessions.length, 2);
  assert.equal(snapshot.sessions[0].id, T_RECENT);
  assert.equal(snapshot.workspaces.length, 2);

  const rows = LOCAL_TOOL_SOURCES.workbuddy.indexRows(homeRow, snapshot);
  assert.equal(rows[0].type, 'home');
  assert.equal(rows[0].homeId, HOME_ID);
  assert.equal(rows.filter((r) => r.type === 'workspace').length, 2);
  const sessions = rows.filter((r) => r.type === 'session');
  assert.equal(sessions.length, 2);
  const recent = sessions.find((s) => s.sessionId === T_RECENT);
  assert.equal(recent.workspaceId, '/repo/proj/alpha/sub'); // 最长前缀
  assert.deepEqual(JSON.parse(recent.status), { kind: 'completed', label: '已完成', subagents: 0 });
});

test('WorkBuddy resolveTarget：sessionId > projectId 最近会话 > 实例最近会话；非法 id 抛错', async (t) => {
  const older = '01a15000-0000-7000-8000-000000000000';
  const home = makeWorkbuddyHome(t, {
    sessions: [
      { id: T_RECENT, cwd: '/repo/proj/alpha', title: 'a', at: NOW - DAY },
      { id: older, cwd: '/repo/proj/other', title: 'b', at: NOW - 5 * DAY },
    ],
    workspaces: [{ path: '/repo/proj/alpha' }, { path: '/repo/proj/other' }],
  });
  const homeRow = { homeId: HOME_ID, homePath: home, harness: 'workbuddy' };

  assert.equal(await LOCAL_TOOL_SOURCES.workbuddy.resolveTarget(homeRow, { sessionId: older }), older);
  assert.equal(await LOCAL_TOOL_SOURCES.workbuddy.resolveTarget(homeRow, { projectId: '/repo/proj/alpha' }), T_RECENT);
  assert.equal(await LOCAL_TOOL_SOURCES.workbuddy.resolveTarget(homeRow, {}), T_RECENT);
  assert.equal(await LOCAL_TOOL_SOURCES.workbuddy.resolveTarget(homeRow, { projectId: '/repo/none' }), null);
  await assert.rejects(
    LOCAL_TOOL_SOURCES.workbuddy.resolveTarget(homeRow, { sessionId: 'not-a-uuid' }),
    /无效的 WorkBuddy 会话 id/,
  );
});

test('WorkBuddy open：非 darwin 返回可复制回退命令，非法 id 抛错', async () => {
  const result = await LOCAL_TOOL_SOURCES.workbuddy.open(T_RECENT, { platform: 'linux' });
  assert.equal(result.ok, false);
  assert.equal(result.sessionId, T_RECENT);
  assert.equal(result.url, `workbuddy://chat/${T_RECENT}`);
  assert.match(result.fallback, /^xdg-open "workbuddy:\/\/chat\//);
  assert.match(result.error, /不支持自动跳转 WorkBuddy/);

  await assert.rejects(LOCAL_TOOL_SOURCES.workbuddy.open('../evil', { platform: 'linux' }), /无效的 WorkBuddy 会话 id/);
});

// —— Codex 数据面（复用现有 codexhome，只做描述符包装）——

test('Codex readSnapshot：按全量索引口径读（不受 7 天 / 每项目 5 条限制）', async (t) => {
  const threads = Array.from({ length: 12 }, (_, i) => ({
    id: `01a15000-0000-7000-8000-${String(i).padStart(12, '0')}`,
    title: `会话 ${i}`,
    cwd: '/repo/alpha',
    at: NOW - i * 1000,
  }));
  const home = makeCodexHome(t, { threads });

  const snapshot = await LOCAL_TOOL_SOURCES.codex.readSnapshot({ home: { homeId: HOME_ID, homePath: home } });
  assert.equal(snapshot.reasons.length, 0);
  assert.equal(snapshot.projects.length, 1);
  assert.equal(snapshot.projects[0].name, 'Alpha');
  assert.equal(snapshot.projects[0].threads.length, 12); // 默认 5 条会截断 → 必须全量

  const rows = LOCAL_TOOL_SOURCES.codex.indexRows({ homeId: HOME_ID, homePath: home }, snapshot);
  assert.equal(rows.filter((r) => r.type === 'session').length, 12);
});

test('Codex resolveTarget：projectId → 该项目最近会话；无参数 → 实例最近会话；非法 id 抛错', async (t) => {
  const older = '01a15000-0000-7000-8000-000000000000';
  const home = makeCodexHome(t, {
    projects: [
      { id: 'local-p1', name: 'Alpha', rootPaths: ['/repo/alpha'] },
      { id: 'local-p2', name: 'Beta', rootPaths: ['/repo/beta'] },
    ],
    threads: [
      { id: T_RECENT, cwd: '/repo/alpha', at: NOW - DAY },
      { id: older, cwd: '/repo/beta', at: NOW - 5 * DAY },
    ],
  });
  const homeRow = { homeId: HOME_ID, homePath: home, harness: 'codex' };

  assert.equal(await LOCAL_TOOL_SOURCES.codex.resolveTarget(homeRow, { sessionId: older }), older);
  assert.equal(await LOCAL_TOOL_SOURCES.codex.resolveTarget(homeRow, { projectId: 'local-p2' }), older);
  assert.equal(await LOCAL_TOOL_SOURCES.codex.resolveTarget(homeRow, {}), T_RECENT);
  assert.equal(await LOCAL_TOOL_SOURCES.codex.resolveTarget(homeRow, { projectId: 'local-none' }), null);
  await assert.rejects(
    LOCAL_TOOL_SOURCES.codex.resolveTarget(homeRow, { sessionId: 'not-a-uuid' }),
    /无效的 Codex 会话 id/,
  );
});

test('Codex open：结果归一成 sessionId/url 形状；非法 id 抛错', async () => {
  const result = await LOCAL_TOOL_SOURCES.codex.open(T_RECENT, { platform: 'linux' });
  assert.equal(result.ok, false);
  assert.equal(result.sessionId, T_RECENT);
  assert.equal(result.url, `codex://threads/${T_RECENT}`);
  assert.equal(result.fallback, `codex resume ${T_RECENT}`);
  assert.match(result.error, /不支持自动跳转 Codex/);

  await assert.rejects(LOCAL_TOOL_SOURCES.codex.open('../evil', { platform: 'linux' }), /无效的 Codex threadId/);
});

// —— 降级：库缺失时数据面仍可工作，reasons 进 home 行 ——

test('WorkBuddy 库缺失：readSnapshot 降级、indexRows 产出带 degraded 的 home 行', async (t) => {
  const emptyHome = mkTemp(t, 'hwb-harnesses-wb-empty-');
  const homeRow = { homeId: HOME_ID, homePath: emptyHome, harness: 'workbuddy' };
  const snapshot = await LOCAL_TOOL_SOURCES.workbuddy.readSnapshot({ home: homeRow });
  assert.equal(snapshot.degraded, true);

  const rows = LOCAL_TOOL_SOURCES.workbuddy.indexRows(homeRow, snapshot);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].degraded.length, 1);
  assert.equal(rows[0].degraded[0].domain, 'workbuddy');
});
