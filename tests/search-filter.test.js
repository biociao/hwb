import { test } from 'node:test';
import assert from 'node:assert/strict';

// 顶栏搜索的过滤内核。这些用例锁的是**匹配口径**（用户看得见的名字）与**计数口径**
// （未过滤是数字、过滤中是「命中/总数」），不锁具体渲染文案的排版。
const { normalizeQuery, projectMatches, sessionMatches, filterRecent, searchEmptyHtml,
  searchPendingHtml, mergeSearchResults } =
  await import('../src/web/components/search-filter.js');

const project = (extra = {}) => ({ homeId: 'h1', project: 'PMAID-RENJI', ...extra });
const session = (extra = {}) => ({
  homeId: 'h1', sessionId: '01a1669a-4aed-74c0-8f45-945379c56e0d',
  title: '将本项目构建成软著形态', project: 'PMAID-RENJI', ...extra,
});

test('normalizeQuery: 大小写 / 全角 / 首尾空白归一化，空白查询视为未过滤', () => {
  assert.equal(normalizeQuery('  PMAID  '), 'pmaid');
  assert.equal(normalizeQuery('ＰＭＡＩＤ'), 'pmaid', 'NFKC 把全角字母折叠成半角');
  assert.equal(normalizeQuery(null), '');
  assert.equal(normalizeQuery('   '), '');
});

test('projectMatches: 只匹配项目名（子串、大小写/全角不敏感）', () => {
  const p = project();
  assert.equal(projectMatches(p, 'pmaid'), true);
  assert.equal(projectMatches(p, 'renji'), true);
  assert.equal(projectMatches(p, 'ＰＭＡＩＤ'), true);
  assert.equal(projectMatches(p, 'other'), false);
  assert.equal(projectMatches(p, ''), true, '空查询不过滤');
  assert.equal(projectMatches({ project: 'hwb', workspaceId: 'secret-workspace' }, 'secret'), false,
    'workspaceId 不是名字，不参与匹配');
});

test('sessionMatches: 标题 / 回退工作区名 / 所属项目名；sessionId 不参与', () => {
  assert.equal(sessionMatches(session(), '软著'), true);
  assert.equal(sessionMatches(session(), 'pmaid'), true, '搜项目名能筛出该项目的会话');
  assert.equal(sessionMatches(session({ title: null, workspaceTitle: 'hwb 工作台' }), '工作台'), true,
    '标题缺失时回退工作区名');
  assert.equal(sessionMatches(session(), '01a1669a'), false,
    'sessionId 不是名字：UUID 前缀会让「敲几个字符就全命中」变成噪音');
});

test('filterRecent: 只保留已连接实例；计数未过滤是数字、过滤是「命中/总数」', () => {
  const projects = [project(), project({ homeId: 'h2', project: 'hwb' })];
  const sessions = [session(), session({ homeId: 'h2', sessionId: 's2', title: '修搜索框', project: 'hwb' })];
  const connectedIds = new Set(['h1', 'h2']);

  const plain = filterRecent({ projects, sessions, connectedIds, query: '  ' });
  assert.equal(plain.filtering, false, '只有空格 = 没在搜');
  assert.equal(plain.projectCount, 2);
  assert.equal(plain.sessionCount, 2);

  const filtered = filterRecent({ projects, sessions, connectedIds, query: 'pmaid' });
  assert.equal(filtered.filtering, true);
  assert.deepEqual(filtered.projects.map((p) => p.project), ['PMAID-RENJI']);
  assert.deepEqual(filtered.sessions.map((s) => s.title), ['将本项目构建成软著形态']);
  assert.equal(filtered.projectCount, '1/2');
  assert.equal(filtered.sessionCount, '1/2');
});

test('filterRecent: 未连接实例的数据不参与渲染；没有连接时计数为 null', () => {
  const projects = [project(), project({ homeId: 'h2', project: 'hwb' })];
  const sessions = [session(), session({ homeId: 'h2' })];
  const only = filterRecent({ projects, sessions, connectedIds: new Set(['h2']) });
  assert.deepEqual(only.projects.map((p) => p.homeId), ['h2']);
  assert.deepEqual(only.sessions.map((s) => s.homeId), ['h2']);

  const none = filterRecent({ projects, sessions, connectedIds: new Set() });
  assert.equal(none.connected, false);
  assert.deepEqual(none.projects, []);
  assert.equal(none.projectCount, null);
  assert.equal(none.sessionCount, null);
});

test('filterRecent: 过滤后 0 条仍是「过滤中」（渲染方据此画清除入口，而不是空数据源）', () => {
  const r = filterRecent({ projects: [project()], sessions: [session()], connectedIds: new Set(['h1']), query: 'zzz' });
  assert.equal(r.connected, true);
  assert.equal(r.filtering, true);
  assert.deepEqual(r.projects, []);
  assert.deepEqual(r.sessions, []);
  assert.equal(r.projectCount, '0/1');
  assert.equal(r.sessionCount, '0/1');
});

test('searchEmptyHtml: 回显用户输入必须转义（这个值会进 innerHTML）', () => {
  const html = searchEmptyHtml('项目', '"><img src=x onerror=alert(1)>');
  assert.doesNotMatch(html, /<img/i);
  assert.match(html, /&lt;img/, '证据：注入内容应作为转义文本出现');
  assert.match(html, /没有匹配「/);
  assert.match(html, /data-action="clear-search"/);
});

test('searchPendingHtml: 补搜进行中的占位文案同样转义用户输入', () => {
  const html = searchPendingHtml('会话', '"><img src=x onerror=alert(1)>');
  assert.doesNotMatch(html, /<img/i);
  assert.match(html, /&lt;img/);
  assert.match(html, /正在全库检索/);
});

test('mergeSearchResults: 最近行优先，检索结果只补缺并打 historical 标记', () => {
  const recentProject = project({ lastActivity: '2026-10-20T00:00:00.000Z' });
  const extraProject = project({ project: 'PMAID-GPPH', lastActivity: '2026-09-23T00:00:00.000Z' });
  const recentSession = session({ lastActivity: '2026-10-20T00:00:00.000Z' });
  const extraSession = session({ sessionId: 'old-session', title: '旧会话', lastActivity: '2026-09-23T00:00:00.000Z' });

  const merged = mergeSearchResults({
    projects: [recentProject],
    sessions: [recentSession],
    // 同一个项目/会话也被检索返回：必须去重，且保留最近列表里的那一行（不是 historical）。
    searchedProjects: [{ ...recentProject, historical: undefined, sessionCount: 99 }, extraProject],
    searchedSessions: [{ ...recentSession, historical: undefined }, extraSession],
  });

  assert.equal(merged.projects.length, 2);
  assert.equal(merged.projects[0].project, 'PMAID-RENJI', '最近行在前');
  assert.equal(merged.projects[0].historical, undefined, '最近行不带 historical 标记');
  assert.equal(merged.projects[0].sessionCount, recentProject.sessionCount, '去重时保留最近行的聚合值');
  assert.equal(merged.projects[1].project, 'PMAID-GPPH');
  assert.equal(merged.projects[1].historical, true, '只有检索补出来的行才打历史标记');

  assert.deepEqual(merged.sessions.map((s) => s.sessionId), [recentSession.sessionId, 'old-session']);
  assert.equal(merged.sessions[1].historical, true);
});

test('mergeSearchResults: 合并后按最后活动倒序（历史行不一定总在末尾）', () => {
  const merged = mergeSearchResults({
    projects: [project({ project: 'recent', lastActivity: '2026-10-01T00:00:00.000Z' }),
      project({ project: 'orphan', lastActivity: null })],
    searchedProjects: [project({ project: 'older-hit', lastActivity: '2026-09-01T00:00:00.000Z' }),
      project({ project: 'newer-hit', lastActivity: '2026-10-05T00:00:00.000Z' })],
  });
  assert.deepEqual(merged.projects.map((p) => p.project), ['newer-hit', 'recent', 'older-hit', 'orphan'],
    '新命中排在旧命中之前；无时间戳的行排最后');
  assert.equal(merged.projects[0].historical, true);
  assert.equal(merged.projects[1].historical, undefined);
});

test('mergeSearchResults: 空/非法输入不崩（接口失败时调用方仍可安全合并）', () => {
  const merged = mergeSearchResults({});
  assert.deepEqual(merged, { projects: [], sessions: [] });
  const withNulls = mergeSearchResults({
    projects: [null, project()], sessions: [undefined],
    searchedProjects: [null, project({ project: 'x', lastActivity: null })],
    searchedSessions: [undefined, null],
  });
  assert.deepEqual(withNulls.projects.map((p) => p.project ?? null), ['PMAID-RENJI', 'x']);
  assert.deepEqual(withNulls.sessions, []);
});
