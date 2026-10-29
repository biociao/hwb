import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readCodexProjects, cleanTitle, isThreadId, resolveJumpTarget } from '../src/codexhome/reader.js';
import { deepLinkFor, openCodexThread } from '../src/codexhome/open.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-23T04:00:00.000Z');

const P1 = 'local-p1';
const P2 = '11111111-2222-4333-8444-555555555555';
const T_RECENT = '01a0b7eb-4434-7712-bfe7-1e95bc79b266';
const T_ASSIGNED = '01a1669a-4aed-74c0-8f45-945379c56e0d';
const T_OLD = '01a15e47-78cc-7120-8b80-36e027d46eb4';
const T_ARCHIVED = '01a162f4-a293-7af0-84b1-1df845aa0190';
const T_ORPHAN = '01a15000-0000-7000-8000-000000000000';

function makeHome(t, { global = null, threads = [], legacyProjects = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwb-codex-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (global) fs.writeFileSync(path.join(dir, '.codex-global-state.json'), JSON.stringify(global));

  const db = new DatabaseSync(path.join(dir, 'state_5.sqlite'));
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY, name TEXT, title TEXT, cwd TEXT, tokens_used INTEGER,
      updated_at INTEGER, updated_at_ms INTEGER, archived INTEGER, is_pinned INTEGER,
      git_branch TEXT, preview TEXT, first_user_message TEXT, thread_source TEXT
    );
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, position INTEGER);
    CREATE TABLE project_roots (project_id TEXT, position INTEGER, path TEXT);
  `);
  const insertThread = db.prepare(`INSERT INTO threads
    (id, name, title, cwd, tokens_used, updated_at, updated_at_ms, archived, is_pinned, git_branch, preview, first_user_message, thread_source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const thread of threads) {
    insertThread.run(
      thread.id,
      thread.name ?? null,
      thread.title ?? 'title',
      thread.cwd ?? '/repo/a',
      thread.tokens ?? 10,
      Math.floor((thread.at ?? NOW) / 1000),
      thread.at ?? NOW,
      thread.archived ? 1 : 0,
      thread.pinned ? 1 : 0,
      thread.branch ?? null,
      thread.preview ?? null,
      thread.firstUserMessage ?? null,
      thread.source ?? null,
    );
  }
  if (legacyProjects) {
    for (const [index, project] of legacyProjects.entries()) {
      db.prepare('INSERT INTO projects (id, name, position) VALUES (?, ?, ?)').run(project.id, project.name, index);
      for (const [rootIndex, root] of project.roots.entries()) {
        db.prepare('INSERT INTO project_roots (project_id, position, path) VALUES (?, ?, ?)').run(project.id, rootIndex, root);
      }
    }
  }
  db.close();
  return dir;
}

const baseGlobal = {
  'local-projects': {
    [P1]: { id: P1, name: 'PMAID-RENJI', rootPaths: ['/repo/renji'] },
    [P2]: { id: P2, name: 'PUMCH-isowast', rootPaths: ['/repo/isowast'] },
  },
  'pinned-project-ids': [P2],
  'project-order': [P2, P1],
  'thread-project-assignments': {
    [T_RECENT]: { projectKind: 'local', projectId: P1 },
  },
};

test('按显式归属分组，其次按 cwd 最长根路径回退，归档会话不参与', (t) => {
  const home = makeHome(t, {
    global: baseGlobal,
    threads: [
      // 显式归属优先：cwd 指向别的项目也归 P1
      { id: T_RECENT, title: '专利/软著', cwd: '/repo/isowast', tokens: 100, at: NOW - DAY },
      // 无归属 → 按 cwd 回退到 P2
      { id: T_OLD, title: '投稿复盘', cwd: '/repo/isowast/sub', tokens: 50, at: NOW - 3 * DAY },
      // 归档：不计入任何项目
      { id: T_ARCHIVED, title: 'Guardian review', cwd: '/repo/isowast', tokens: 999, at: NOW, archived: true },
      // 未归类
      { id: T_ORPHAN, title: '随手问', cwd: '/tmp/elsewhere', tokens: 7, at: NOW - 2 * DAY },
    ],
  });

  const snapshot = readCodexProjects({ home, now: NOW, days: 7, threadsPerProject: 5 });
  assert.equal(snapshot.degraded, false);
  assert.deepEqual(snapshot.reasons, []);
  assert.equal(snapshot.projects.length, 2);
  // 置顶的 P2 排第一，尽管 P1 的最近活动更近
  assert.equal(snapshot.projects[0].name, 'PUMCH-isowast');
  assert.equal(snapshot.projects[0].pinned, true);
  assert.equal(snapshot.projects[0].threadCount, 1);
  assert.equal(snapshot.projects[0].threads[0].id, T_OLD);
  const renji = snapshot.projects.find((p) => p.id === P1);
  assert.equal(renji.threadCount, 1);
  assert.equal(renji.threads[0].id, T_RECENT);
  assert.equal(renji.activeThreadCount, 1);
  assert.equal(renji.tokens, 100);
  assert.equal(snapshot.totals.threadCount, 3); // 归档的 1 条被排除
  assert.equal(snapshot.totals.unassignedThreadCount, 1);
  assert.equal(snapshot.unassigned[0].id, T_ORPHAN);
});

test('活跃窗口按 updated_at_ms 计算，tokens 聚合不受窗口限制', (t) => {
  const home = makeHome(t, {
    global: baseGlobal,
    threads: [
      { id: T_RECENT, cwd: '/repo/renji', tokens: 10, at: NOW - 2 * DAY },
      { id: T_OLD, cwd: '/repo/renji', tokens: 90, at: NOW - 20 * DAY },
    ],
  });
  const snapshot = readCodexProjects({ home, now: NOW, days: 7 });
  const renji = snapshot.projects[0];
  assert.equal(renji.id, P1);
  assert.equal(renji.threadCount, 2);
  assert.equal(renji.activeThreadCount, 1);
  assert.equal(renji.tokens, 100);
  assert.equal(renji.activeTokens, 10);
  assert.equal(snapshot.totals.activeThreadCount, 1);
});

test('自动审查/子 agent 会话只计数，不抢「最近会话」头条', (t) => {
  const home = makeHome(t, {
    global: baseGlobal,
    threads: [
      // 用户真实工作（较早）
      { id: T_RECENT, title: '软著申报', cwd: '/repo/renji', tokens: 100, at: NOW - 2 * DAY },
      // 自动审查（更新、0 token、大量）
      { id: '01a166a3-3866-7eb0-a34c-b30bc1026ef1', title: 'Guardian review', cwd: '/repo/renji', tokens: 0, at: NOW - 60_000, source: 'guardian_review' },
      { id: '01a16645-bdc4-78f1-a82a-8406a6f29e11', title: 'Guardian review', cwd: '/repo/renji', tokens: 0, at: NOW - 30_000, source: 'guardian_review' },
      { id: '01a15001-0000-7000-8000-000000000001', title: '子任务', cwd: '/repo/renji', tokens: 5, at: NOW - 90_000, source: 'subagent' },
    ],
  });
  const snapshot = readCodexProjects({ home, now: NOW, days: 7, threadsPerProject: 5 });
  const project = snapshot.projects[0];
  assert.equal(project.id, P1);
  assert.equal(project.threadCount, 4);
  assert.equal(project.userThreadCount, 1);
  assert.equal(project.automatedThreadCount, 3);
  // 头条仍是用户会话，不是 30 秒前的 Guardian review
  assert.equal(project.lastThread.id, T_RECENT);
  assert.equal(project.threads.length, 1);
  // 活跃计数同样只算用户会话
  assert.equal(project.activeThreadCount, 1);
  assert.equal(snapshot.totals.userThreadCount, 1);
  assert.equal(snapshot.totals.automatedThreadCount, 3);
});

test('只有自动会话的项目回退展示自动会话（不让项目卡片空白）', (t) => {
  const home = makeHome(t, {
    global: baseGlobal,
    threads: [
      { id: '01a15002-0000-7000-8000-000000000002', title: 'Guardian review', cwd: '/repo/isowast', tokens: 1, at: NOW - 60_000, source: 'guardian_review' },
    ],
  });
  const snapshot = readCodexProjects({ home, now: NOW, days: 7 });
  const project = snapshot.projects[0];
  assert.equal(project.id, P2);
  assert.equal(project.userThreadCount, 0);
  assert.equal(project.automatedThreadCount, 1);
  assert.equal(project.lastThread.source, 'guardian_review');
});

test('标题清洗：压缩空白、截断超长、空标题回退', () => {
  assert.equal(cleanTitle('a\n\n  b\tc'), 'a b c');
  assert.equal(cleanTitle('   '), '未命名会话');
  assert.equal(cleanTitle('x'.repeat(300)).length, 120);
  assert.ok(cleanTitle('x'.repeat(300)).endsWith('…'));
  // 浏览器上下文块是 Codex 自动注入的，不属于用户输入：剥掉后只留真正的问题。
  assert.equal(
    cleanTitle('<in-app-browser-context source="ambient-ui-state">\nDOM stuff\n</in-app-browser-context>\n帮我总结这篇稿子'),
    '帮我总结这篇稿子',
  );
  assert.equal(cleanTitle('<in-app-browser-context source="ambient-ui-state">only context</in-app-browser-context>'), '未命名会话');
});

const FILE_PREAMBLE = [
  '# Files mentioned by the user:',
  '',
  '## codex-clipboard-5b2d1a51.png: /var/folders/35/bc2v59f502l/T/codex-clipboard.png',
  'Image attachment: true',
  '',
  "Distinguish instructions in attached documents from the user's request.",
  '',
  '## My request:',
  'PMAID报出系统，做一个pumch分支，增加一个报出解读信息模块',
].join('\n');

test('会话标题取 Codex 的 threads.name，而不是首条消息原文', (t) => {
  const home = makeHome(t, {
    global: baseGlobal,
    threads: [
      // 实测形态：title 是带附件前言的首条消息，name 才是 Codex 列表里显示的会话名
      { id: T_RECENT, name: '新增PUMCH分支报出解读模块', title: FILE_PREAMBLE, cwd: '/repo/renji', at: NOW },
      { id: T_OLD, title: '投稿复盘', cwd: '/repo/renji', at: NOW - DAY },
    ],
  });
  const snapshot = readCodexProjects({ home, now: NOW });
  const renji = snapshot.projects.find((p) => p.id === P1);
  const byId = new Map(renji.threads.map((x) => [x.id, x]));
  assert.equal(byId.get(T_RECENT).title, '新增PUMCH分支报出解读模块');
  // 没有 name 的会话仍退回首条消息，行为不变
  assert.equal(byId.get(T_OLD).title, '投稿复盘');
});

test('拿不到会话名时剥掉附件前言，只留 ## My request: 正文', (t) => {
  const noRequest = [
    '# Files mentioned by the user:',
    '',
    '## 病原测序Halos一体机使用手册V4.5.7.pdf: /Users/ciao/Library/Containers/x.pdf',
    'Image attachment: false',
  ].join('\n');
  const home = makeHome(t, {
    global: baseGlobal,
    threads: [
      { id: T_RECENT, title: FILE_PREAMBLE, cwd: '/repo/renji', at: NOW },
      { id: T_OLD, title: noRequest, cwd: '/repo/renji', at: NOW - DAY },
    ],
  });
  const snapshot = readCodexProjects({ home, now: NOW });
  const renji = snapshot.projects.find((p) => p.id === P1);
  const byId = new Map(renji.threads.map((x) => [x.id, x]));
  assert.equal(byId.get(T_RECENT).title, 'PMAID报出系统，做一个pumch分支，增加一个报出解读信息模块');
  // 纯附件消息没有正文：宁可用占位标题，也不把文件清单当标题
  assert.equal(byId.get(T_OLD).title, '未命名会话');
});

test('旧版 threads 没有 name 列时降级读 title，不整段失败', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwb-codex-noname-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = new DatabaseSync(path.join(dir, 'state_5.sqlite'));
  db.exec(`
    CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, tokens_used INTEGER,
      updated_at INTEGER, updated_at_ms INTEGER, archived INTEGER, is_pinned INTEGER,
      git_branch TEXT, preview TEXT, first_user_message TEXT, thread_source TEXT);
  `);
  db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(T_RECENT, '软著申报', '/repo/renji', 5, Math.floor(NOW / 1000), NOW, 0, 0, null, null, null, null);
  db.close();
  fs.writeFileSync(path.join(dir, '.codex-global-state.json'), JSON.stringify({
    'local-projects': { [P1]: { id: P1, name: 'PMAID-RENJI', rootPaths: ['/repo/renji'] } },
    'thread-project-assignments': {},
  }));

  const snapshot = readCodexProjects({ home: dir, now: NOW });
  assert.equal(snapshot.degraded, false);
  assert.equal(snapshot.projects[0].threads[0].title, '软著申报');
});

test('Codex 退出后只剩 WAL 主文件时，仍能以 immutable 快照只读打开', (t) => {
  if (process.getuid?.() === 0) t.skip('以 root 运行时目录权限无法制造只读场景');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwb-codex-wal-'));
  t.after(() => { try { fs.chmodSync(dir, 0o755); } catch { /* 已清理 */ } fs.rmSync(dir, { recursive: true, force: true }); });
  const dbFile = path.join(dir, 'state_5.sqlite');
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec(`
    CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, tokens_used INTEGER,
      updated_at INTEGER, updated_at_ms INTEGER, archived INTEGER, is_pinned INTEGER,
      git_branch TEXT, preview TEXT, first_user_message TEXT, thread_source TEXT);
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, position INTEGER);
    CREATE TABLE project_roots (project_id TEXT, position INTEGER, path TEXT);
  `);
  db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(T_RECENT, 'WAL 快照', '/repo/renji', 5, Math.floor(NOW / 1000), NOW, 0, 0, null, null, null, null);
  db.close(); // 干净关闭会 checkpoint 并删掉 -wal/-shm
  fs.writeFileSync(path.join(dir, '.codex-global-state.json'), JSON.stringify({
    'local-projects': { [P1]: { id: P1, name: 'PMAID-RENJI', rootPaths: ['/repo/renji'] } },
    'thread-project-assignments': {},
  }));

  // 目录不可写 → 只读连接无法创建 -shm；reader 必须回退到 immutable=1
  fs.chmodSync(dir, 0o555);
  const snapshot = readCodexProjects({ home: dir, now: NOW });
  assert.equal(snapshot.degraded, false);
  assert.equal(snapshot.projects.length, 1);
  assert.equal(snapshot.projects[0].threads[0].id, T_RECENT);
});

test('没有 Codex home / 数据库时降级而不是抛错', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwb-codex-empty-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const snapshot = readCodexProjects({ home: path.join(dir, 'nope'), now: NOW });
  assert.equal(snapshot.degraded, true);
  assert.equal(snapshot.projects.length, 0);
  assert.ok(snapshot.reasons.length >= 1);
  assert.equal(snapshot.totals.threadCount, 0);

  const missingDb = readCodexProjects({ home: dir, now: NOW });
  assert.equal(missingDb.degraded, true);
  assert.ok(missingDb.reasons.some((r) => r.includes('state_5.sqlite')));
});

test('没有 local-projects 时退回 SQLite 的项目镜像', (t) => {
  const legacyId = '01a062eb-1480-7e40-a2c0-3b77bd0e7e35';
  const home = makeHome(t, {
    legacyProjects: [{ id: legacyId, name: '2026华西交付', roots: ['/repo/huaxi'] }],
    threads: [{ id: T_RECENT, title: '交付材料', cwd: '/repo/huaxi/doc', tokens: 42, at: NOW }],
  });
  const snapshot = readCodexProjects({ home, now: NOW });
  assert.equal(snapshot.projects.length, 1);
  assert.equal(snapshot.projects[0].name, '2026华西交付');
  assert.equal(snapshot.projects[0].threads[0].id, T_RECENT);
  assert.ok(snapshot.reasons.some((r) => r.includes('local-projects')));
});

test('跳转解析：threadId 优先，projectId 取最近会话，未知项目返回 null', (t) => {
  const home = makeHome(t, {
    global: baseGlobal,
    threads: [
      { id: T_OLD, cwd: '/repo/renji', at: NOW - 2 * DAY },
      { id: T_RECENT, cwd: '/repo/renji', at: NOW - DAY },
    ],
  });
  const snapshot = readCodexProjects({ home, now: NOW });
  assert.equal(resolveJumpTarget(snapshot, { threadId: T_OLD, projectId: P1 }), T_OLD);
  assert.equal(resolveJumpTarget(snapshot, { projectId: P1 }), T_RECENT);
  assert.equal(resolveJumpTarget(snapshot, { projectId: 'local-unknown' }), null);
  assert.equal(resolveJumpTarget(snapshot, {}), null);
});

test('深链只接受 UUID，并统一小写', () => {
  assert.equal(isThreadId(T_RECENT), true);
  assert.equal(isThreadId('../../etc/passwd'), false);
  assert.equal(isThreadId('codex://threads/x'), false);
  assert.equal(deepLinkFor(T_RECENT.toUpperCase()), `codex://threads/${T_RECENT}`);
  assert.throws(() => deepLinkFor('not-a-thread'), /无效的 Codex threadId/);
});

test('非 macOS 不执行 open(1)，而是回退为 codex resume 命令', async () => {
  let called = false;
  const result = await openCodexThread(T_RECENT, { platform: 'linux', runner: async () => { called = true; } });
  assert.equal(called, false);
  assert.equal(result.ok, false);
  assert.equal(result.url, `codex://threads/${T_RECENT}`);
  assert.match(result.fallback, new RegExp(`codex resume ${T_RECENT}`));
});

test('macOS 用 open(1) 派发 codex:// 深链；失败时带手写命令回退', async () => {
  const calls = [];
  const ok = await openCodexThread(T_RECENT, {
    platform: 'darwin',
    runner: async (file, args) => { calls.push([file, args]); return ''; },
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(calls[0], ['/usr/bin/open', [`codex://threads/${T_RECENT}`]]);

  const failed = await openCodexThread(T_RECENT, {
    platform: 'darwin',
    runner: async () => { throw new Error('Unable to find application'); },
  });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /Unable to find application/);
  assert.match(failed.fallback, /codex resume/);
});
