import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IndexStore } from '../src/dshhome/store.js';

// 「点击项目 → 只看该项目的会话」的数据层契约。
//
// 为什么必须在服务端筛：Recent Sessions 只有最近 50 条，一个项目的会话完全可能被挤出
// 那 50 条（实测 PMAID-GPPH 有 7 条会话、最后活动在 32 天前），前端拿这 50 条根本凑不出
// 「该项目的全部会话」。所以 /api/sessions/recent?project= 走 recentSessions({project})，
// 直接在索引上做**精确**等值过滤。
//
// 这些用例锁三件事：
//   ① 精确而不是子串（project 是身份，不是搜索词：筛 PMAID 不能带出 PMAID-GPPH）；
//   ② 跨实例聚合与 homeIds 作用域（与 recentSessions 原语义一致）；
//   ③ searchAll 的 project 只收窄**会话**，不限制项目结果（筛选下仍然能搜到别的项目）。

const MIN = 60_000;
const iso = (minsAgo) => new Date(Date.now() - minsAgo * MIN).toISOString();

function seed() {
  const store = new IndexStore(':memory:');
  const a = store.registerHome({ homePath: '/home/a' });
  const b = store.registerHome({ homePath: '/home/b' });
  const ins = store.db.prepare(
    `INSERT INTO sessions (homeId, sessionId, project, workspaceTitle, title, lastActivity, tokenUsage, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const row = (homeId, sessionId, project, title, minsAgo) => ins.run(
    homeId, sessionId, project, project, title, iso(minsAgo),
    JSON.stringify({ uncachedInputTokens: 10, outputTokens: 1 }),
    JSON.stringify({ kind: 'idle', label: '空闲', subagents: 0 }),
  );
  row(a, 'gpph-new', 'PMAID-GPPH', 'GPPH 新会话', 10);
  row(a, 'gpph-old', 'PMAID-GPPH', 'GPPH 旧会话', 300);
  row(b, 'gpph-b', 'PMAID-GPPH', 'B 实例上的 GPPH 会话', 60);
  row(b, 'pmaid', 'PMAID', '只有 PMAID 这个项目', 5);
  row(a, 'other', 'hwb', '别的项目', 1);
  return { store, a, b };
}

test('recentSessions({project})：跨实例取该项目的全部会话，按最后活动倒序', (t) => {
  const { store, a, b } = seed();
  t.after(() => store.close());
  const rows = store.recentSessions({ homeIds: [a, b], project: 'PMAID-GPPH' });
  assert.deepEqual(rows.map((r) => r.sessionId), ['gpph-new', 'gpph-b', 'gpph-old'],
    '跨实例聚合 + 按 lastActivity 倒序');
  assert.equal(rows.length, 3);
});

test('recentSessions({project})：精确等值，不是前缀/子串匹配', (t) => {
  const { store, a, b } = seed();
  t.after(() => store.close());
  const pmaid = store.recentSessions({ homeIds: [a, b], project: 'PMAID' });
  assert.deepEqual(pmaid.map((r) => r.sessionId), ['pmaid'],
    '筛 PMAID 不能把 PMAID-GPPH 的会话带进来（那是搜索语义，不是项目筛选语义）');
  assert.deepEqual(store.recentSessions({ homeIds: [a, b], project: 'PMAID-G' }), []);
  assert.deepEqual(store.recentSessions({ homeIds: [a, b], project: 'PMAID-GPPH ' }), [],
    '项目名不做 trim/模糊修正：前端传什么就按什么精确匹配');
});

test('recentSessions({project})：homeIds 作用域仍然生效（未连接实例的数据不外泄）', (t) => {
  const { store, a } = seed();
  t.after(() => store.close());
  assert.deepEqual(
    store.recentSessions({ homeIds: [a], project: 'PMAID-GPPH' }).map((r) => r.sessionId),
    ['gpph-new', 'gpph-old'],
    '只取作用域内的实例，哪怕别的实例索引里也有同名项目',
  );
  assert.deepEqual(store.recentSessions({ homeIds: [], project: 'PMAID-GPPH' }), []);
});

test('recentSessions({project})：limit 生效；project 为空串/undefined 时等于不筛选', (t) => {
  const { store, a, b } = seed();
  t.after(() => store.close());
  assert.deepEqual(
    store.recentSessions({ homeIds: [a, b], project: 'PMAID-GPPH', limit: 2 }).map((r) => r.sessionId),
    ['gpph-new', 'gpph-b'],
  );
  const all = store.recentSessions({ homeIds: [a, b] });
  assert.equal(all.length, 5);
  // 前端不会传空串（空白会被路由 normalize 成 null），但数据层也不该把它当通配：
  // 空串是「精确匹配空项目名」，自然返回 0 行。
  assert.deepEqual(store.recentSessions({ homeIds: [a, b], project: '' }), []);
});

test('recentSessions({project})：返回行与不筛时同形（hydrateSessionRow 口径一致）', (t) => {
  const { store, a, b } = seed();
  t.after(() => store.close());
  const [row] = store.recentSessions({ homeIds: [a, b], project: 'PMAID-GPPH', limit: 1 });
  for (const key of ['homeId', 'sessionId', 'project', 'title', 'status', 'tokenUsage', 'lastActivity']) {
    assert.ok(Object.hasOwn(row, key), `缺字段 ${key}`);
  }
  assert.equal(row.status.kind, 'idle', 'status 是解析后的对象，不是原始 JSON 串');
  assert.equal(row.tokenUsage.outputTokens, 1);
});

test('searchAll({project})：只收窄会话；项目结果仍然是全库命中', (t) => {
  const { store, a, b } = seed();
  t.after(() => store.close());
  const byProject = store.searchAll({ q: 'GPPH', homeIds: [a, b], project: 'PMAID-GPPH' });
  assert.deepEqual(byProject.sessions.map((r) => r.sessionId), ['gpph-new', 'gpph-b', 'gpph-old']);
  const unscoped = store.searchAll({ q: 'GPPH', homeIds: [a, b] });
  assert.equal(unscoped.sessions.length, 3, 'q=GPPH 本来就只命中该项目的会话，这里做对照');
  const broad = store.searchAll({ q: 'PMAID', homeIds: [a, b], project: 'PMAID-GPPH' });
  assert.ok(broad.sessions.every((s) => s.project === 'PMAID-GPPH'), '会话结果必须全部属于被筛项目');
  assert.deepEqual(broad.projects.map((p) => p.project).sort(), ['PMAID', 'PMAID-GPPH'],
    '项目结果不受 project 限制：否则筛着 GPPH 就搜不到别的 PMAID 项目、没法切换');
});
