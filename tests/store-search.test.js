import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IndexStore } from '../src/dshhome/store.js';

// 全库搜索（searchAll）的回归：它存在的唯一理由就是「Recent 面板只装最近一小段」。
// 因此这里的用例全部围绕两个口径：① 时间窗/条数上限之外的历史命中必须能搜到；
// ② 匹配口径与 components/search-filter.js 一致（项目名；会话标题 / 工作区名 / 项目名）。
//
// 直接用 INSERT 造数据而不是走 normalize(snapshot)：这些用例要精确控制「多旧」，
// 而 recent 的快照路径本身有 7 天窗口的语义（见 store.test.js），不适合当这里的前置。

const NOW = Date.now();
const daysAgo = (d) => new Date(NOW - d * 86_400_000).toISOString();

function insertSession(store, row) {
  store.db.prepare(
    `INSERT INTO sessions (homeId, sessionId, workspaceId, workspaceTitle, project, title, tokenUsage, status, lastActivity)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.homeId, row.sessionId, row.workspaceId ?? null, row.workspaceTitle ?? null,
    row.project ?? null, row.title ?? null,
    row.tokenUsage === undefined ? null : JSON.stringify(row.tokenUsage),
    row.status === undefined ? null : JSON.stringify(row.status),
    row.lastActivity ?? null,
  );
}

function insertWorkspace(store, row) {
  store.db.prepare(
    'INSERT INTO workspaces (homeId, workspaceId, title, path, project, archived, sessionCount) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(row.homeId, row.workspaceId, row.title ?? null, row.path ?? null, row.project ?? null, row.archived ?? 0, 0);
}

function seed() {
  const store = new IndexStore(':memory:');
  const dsh = store.registerHome({ homePath: '/mock/dsh-home' });
  const codex = store.registerHome({ homePath: '/mock/codex-home', harness: 'codex' });

  for (const s of seedSessionRows({ dsh, codex })) insertSession(store, s);
  for (const w of seedWorkspaceRows({ dsh })) insertWorkspace(store, w);
  return { store, dsh, codex };
}

function seedSessionRows({ dsh, codex }) {
  return [
    // 32 天前的旧项目：recentProjects(days:7) 看不到它 —— 这正是「搜不到 GPPH」的真实形状。
    { homeId: dsh, sessionId: 's-gpph-1', workspaceId: 'ws-gpph', workspaceTitle: 'PMAID-GPPH',
      project: 'PMAID-GPPH', title: '按临床表型分类设计 GPPH 提示词', lastActivity: daysAgo(32),
      tokenUsage: { uncachedInputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 },
      status: { kind: 'idle', label: '空闲', subagents: 0 } },
    { homeId: dsh, sessionId: 's-gpph-2', workspaceId: 'ws-gpph', workspaceTitle: 'PMAID-GPPH',
      project: 'PMAID-GPPH', title: '数据库病原报出信息核查', lastActivity: daysAgo(31) },
    // 另一个实例上的同名项目（Codex），活动较新 —— 合并展示时排序要按最后活动倒序。
    { homeId: codex, sessionId: 's-pumch-1', workspaceId: 'proj-pumch', workspaceTitle: 'PUMCH-GPPH',
      project: 'PUMCH-GPPH', title: 'gpph 数据治理', lastActivity: daysAgo(4),
      tokenUsage: { totalTokens: 500 } },
    // 干扰项：项目名/标题里都没有查询词。
    { homeId: dsh, sessionId: 's-hwb-1', workspaceId: 'ws-hwb', workspaceTitle: 'hwb',
      project: 'hwb', title: '修搜索框', lastActivity: daysAgo(1) },
    // 干扰项：标题命中但项目名不命中（搜索词只出现在标题里）。
    { homeId: dsh, sessionId: 's-notes-1', workspaceId: 'ws-notes', workspaceTitle: 'notes',
      project: 'notes', title: '整理 GPPH 会议记录', lastActivity: daysAgo(2) },
    // 通配符文面匹配：项目名里真的带下划线与百分号。
    { homeId: dsh, sessionId: 's-wild-1', workspaceId: 'ws-wild', workspaceTitle: 'a_b',
      project: 'a_b', title: '100% 覆盖', lastActivity: daysAgo(3) },
    { homeId: dsh, sessionId: 's-wild-2', workspaceId: 'ws-wild2', workspaceTitle: 'axb',
      project: 'axb', title: '普通项目', lastActivity: daysAgo(3) },
  ];
}

function seedWorkspaceRows({ dsh }) {
  return [
    // 没有会话的 workspace 也算项目（与 recentProjects 的「孤立 workspace」口径一致）。
    { homeId: dsh, workspaceId: 'ws-empty-gpph', title: '空项目', path: '/r/gpph-empty', project: 'GPPH-EMPTY' },
    // 归档的 workspace 不参与搜索。
    { homeId: dsh, workspaceId: 'ws-archived', title: '旧归档', path: '/r/archived', project: 'GPPH-ARCHIVED', archived: 1 },
  ];
}

test('searchAll: 7 天窗口之外的旧项目/旧会话能被搜到（Recent 面板看不到）', () => {
  const { store } = seed();
  // 前置：最近列表确实看不到 PMAID-GPPH —— 这就是用户搜索 0/20 的原因。
  assert.equal(store.recentProjects({ days: 7 }).some((p) => p.project === 'PMAID-GPPH'), false);
  // 会话的 Recent 面板没有时间窗、只有条数上限：取最近 2 条时旧会话同样不在其中。
  assert.equal(store.recentSessions({ limit: 2 }).some((s) => s.sessionId === 's-gpph-1'), false);

  const r = store.searchAll({ q: 'GPPH' });
  const projects = r.projects.map((p) => p.project);
  assert.ok(projects.includes('PMAID-GPPH'), `旧项目应被搜到，实际 ${projects}`);
  assert.ok(projects.includes('PUMCH-GPPH'));
  // 排序：按最后活动倒序（Codex 的 PUMCH-GPPH 4 天前 > 32 天前的 PMAID-GPPH）。
  assert.equal(projects[0], 'PUMCH-GPPH');
  // 项目名不含查询词、只有标题命中的项目不进「项目」栏（与 search-filter 的匹配口径一致）。
  assert.equal(projects.includes('notes'), false);

  const sessions = r.sessions.map((s) => s.sessionId);
  assert.deepEqual(sessions, ['s-notes-1', 's-pumch-1', 's-gpph-2', 's-gpph-1'],
    '标题 / 项目名命中都算会话命中，且按最后活动倒序');
  assert.equal(store.searchAll({ q: 'GPPH' }).truncated.sessions, false);
  store.close();
});

test('searchAll: 大小写不敏感 + NFKC（全角）归一化', () => {
  const { store } = seed();
  const lower = store.searchAll({ q: 'gpph' }).projects.map((p) => p.project);
  const fullWidth = store.searchAll({ q: 'ＧＰＰＨ' }).projects.map((p) => p.project);
  assert.deepEqual(fullWidth, lower, '全角输入应与半角等价');
  assert.ok(lower.includes('PMAID-GPPH'));
  store.close();
});

test('searchAll: 只在该组 homeIds 内搜（与 dataHomeIds 的「运行中实例」口径配合）', () => {
  const { store, codex } = seed();
  const onlyCodex = store.searchAll({ q: 'GPPH', homeIds: [codex] });
  assert.deepEqual(onlyCodex.projects.map((p) => p.project), ['PUMCH-GPPH']);
  assert.deepEqual(onlyCodex.sessions.map((s) => s.sessionId), ['s-pumch-1']);

  const none = store.searchAll({ q: 'GPPH', homeIds: [] });
  assert.deepEqual(none.projects, []);
  assert.deepEqual(none.sessions, []);
  store.close();
});

test('searchAll: 匹配的是字面子串（% 与 _ 不是通配符）', () => {
  const { store } = seed();
  const underscore = store.searchAll({ q: 'a_b' }).projects.map((p) => p.project);
  assert.deepEqual(underscore, ['a_b'], 'a_b 只应命中字面 a_b，不应把 axb 也当通配符命中');
  const percent = store.searchAll({ q: '100%' }).sessions.map((s) => s.sessionId);
  assert.deepEqual(percent, ['s-wild-1']);
  store.close();
});

test('searchAll: 命中行与 recent 行同构（JSON 列已解析、带跳转目标）', () => {
  const { store, dsh } = seed();
  const r = store.searchAll({ q: 'PMAID-GPPH' });
  const project = r.projects.find((p) => p.project === 'PMAID-GPPH');
  assert.equal(project.homeId, dsh);
  assert.equal(project.sessionId, 's-gpph-2', '项目卡跳转目标 = 该项目最新会话');
  assert.equal(project.workspaceId, 'ws-gpph');
  assert.equal(project.sessionCount, 2);
  assert.equal(project.inputTokens, 10 + 30 + 40, '项目总输入 = 新增 + 缓存读 + 缓存写');
  assert.equal(project.outputTokens, 20);

  const session = r.sessions.find((s) => s.sessionId === 's-gpph-1');
  assert.deepEqual(session.tokenUsage, { uncachedInputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 });
  assert.deepEqual(session.status, { kind: 'idle', label: '空闲', subagents: 0 });
  assert.equal(session.project, 'PMAID-GPPH');
  assert.equal(session.workspaceTitle, 'PMAID-GPPH');
  store.close();
});

test('searchAll: 无会话的 workspace 也作为项目返回；归档的不返回', () => {
  const { store } = seed();
  const projects = store.searchAll({ q: 'GPPH' }).projects;
  const empty = projects.find((p) => p.project === 'GPPH-EMPTY');
  assert.ok(empty, `孤立 workspace 应作为项目出现，实际 ${projects.map((p) => p.project)}`);
  assert.equal(empty.sessionCount, 0);
  assert.equal(empty.sessionId, null);
  assert.equal(empty.workspaceId, 'ws-empty-gpph');
  assert.equal(projects.some((p) => p.project === 'GPPH-ARCHIVED'), false, '归档 workspace 不参与搜索');
  store.close();
});

test('searchAll: 超出上限时截断并标记 truncated（前端据此提示「还有更多」）', () => {
  const { store } = seed();
  const r = store.searchAll({ q: 'GPPH', projectLimit: 1, sessionLimit: 2 });
  assert.equal(r.projects.length, 1);
  assert.deepEqual(r.truncated, { projects: true, sessions: true });
  assert.equal(r.sessions.length, 2);

  const exact = store.searchAll({ q: 'PMAID-GPPH', sessionLimit: 2 });
  assert.equal(exact.sessions.length, 2);
  assert.equal(exact.truncated.sessions, false, '恰好等于上限时不算截断');
  store.close();
});

test('searchAll: 空查询/非字符串查询不做扫描，直接返回空结果', () => {
  const { store } = seed();
  for (const q of ['', '   ', null, undefined, 42]) {
    const r = store.searchAll({ q });
    assert.deepEqual(r, { projects: [], sessions: [], truncated: { projects: false, sessions: false } });
  }
  store.close();
});
