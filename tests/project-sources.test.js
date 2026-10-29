import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IndexStore } from '../src/dshhome/store.js';
import { renderRecentProjects } from '../src/web/components/recent-projects.js';
import { renderRecentSessions } from '../src/web/components/recent-sessions.js';

globalThis.document = { documentElement: { dataset: { theme: 'light' } } };

function seed(t) {
  const store = new IndexStore(':memory:');
  t.after(() => store.close());
  const dsh = store.registerHome({ homePath: '/dsh' });
  const codex = store.registerHome({ homePath: '/codex', harness: 'codex' });
  const wb = store.registerHome({ homePath: '/wb', harness: 'workbuddy' });
  const archived = store.registerHome({ homePath: '/archived' });
  const insert = store.db.prepare('INSERT INTO sessions (homeId,sessionId,project,lastActivity) VALUES (?,?,?,?)');
  insert.run(dsh, 'latest', 'hwb', new Date().toISOString());
  insert.run(codex, 'old', 'hwb', new Date(Date.now() - 40 * 86400_000).toISOString());
  insert.run(codex, 'no-time', 'hwb', null);
  const workspace = store.db.prepare('INSERT INTO workspaces (homeId,workspaceId,project,archived) VALUES (?,?,?,?)');
  workspace.run(wb, 'w1', 'hwb', 0);
  workspace.run(archived, 'w2', 'hwb', 1);
  return { store, dsh, codex, wb, archived };
}

test('项目来源覆盖旧会话、无时间会话及活动 workspace，不改变最近计数或跳转目标', (t) => {
  const { store, dsh, codex, wb, archived } = seed(t);
  const [project] = store.recentProjects();
  assert.equal(project.project, 'hwb');
  assert.equal(project.homeId, dsh);
  assert.equal(project.sessionId, 'latest');
  assert.equal(project.sessionCount, 1);
  assert.deepEqual(new Set(project.homeIds), new Set([dsh, codex, wb]));
  assert.ok(!project.homeIds.includes(archived));
});

test('最近项目与历史搜索使用相同来源口径，作用域外实例不会进入标签', (t) => {
  const { store, dsh, codex, wb } = seed(t);
  assert.deepEqual(new Set(store.searchAll({ q: 'hwb' }).projects[0].homeIds), new Set([dsh, codex, wb]));
  for (const p of [store.recentProjects({ homeIds: [dsh] })[0], store.searchAll({ q: 'hwb', homeIds: [dsh] }).projects[0]]) {
    assert.deepEqual(p.homeIds, [dsh]);
  }
  assert.deepEqual(store.recentProjects({ homeIds: [] }), []);
});

test('同名的无会话 workspace 只生成一张项目卡，保留全部来源', (t) => {
  const { store, dsh, codex } = seed(t);
  const insert = store.db.prepare('INSERT INTO workspaces (homeId,workspaceId,project,archived) VALUES (?,?,?,0)');
  insert.run(dsh, 'empty-a', 'empty');
  insert.run(codex, 'empty-b', 'empty');
  for (const projects of [store.recentProjects(), store.searchAll({ q: 'empty' }).projects]) {
    const empty = projects.filter(p => p.project === 'empty');
    assert.equal(empty.length, 1);
    assert.deepEqual(new Set(empty[0].homeIds), new Set([dsh, codex]));
  }
});

test('项目卡显示所有来源、不展示 token；来源相同的重复标签去重，完整名称转义', () => {
  const homes = [{ homeId: 'd', harness: 'dsh', alias: '大肥鱼桌面版' }, { homeId: 'c', harness: 'codex', alias: 'Codex' }, { homeId: 'c2', harness: 'codex', alias: 'Codex' }];
  const project = { homeId: 'd', homeIds: ['d', 'c', 'c2'], project: 'hwb', sessionId: 's1', sessionCount: 24, totalTokens: 9999999 };
  const html = renderRecentProjects([project], homes);
  assert.match(html, /大肥鱼桌面版<\/span>/);
  assert.match(html, /Codex<\/span>/);
  assert.equal((html.match(/>Codex<\/span>/g) || []).length, 1);
  assert.doesNotMatch(html, /project-tokens|tokens|9\.9M/);
  const evil = renderRecentProjects([{ ...project, homeIds: ['d', 'c'] }], [homes[0], { ...homes[1], alias: '"><img src=x>' }]);
  assert.doesNotMatch(evil, /<img/);
  assert.match(evil, /&lt;img/);
});

test('session 卡片来源由各自实例确定，同项目的 app 不会互相覆盖；未知来源安全兜底', () => {
  const session = { project: 'hwb', sessionId: 's', status: { kind: 'running' } };
  const html = renderRecentSessions([{ ...session, homeId: 'd' }, { ...session, homeId: 'c' }, { ...session, homeId: 'evil' }], [{ homeId: 'd', harness: 'dsh' }, { homeId: 'c', harness: 'codex' }, { homeId: 'evil', harness: '"><img src=x>' }]);
  assert.deepEqual([...html.matchAll(/data-status="running" data-source="([^"]*)"/g)].map(m => m[1]), ['dsh', 'codex', 'other']);
  assert.doesNotMatch(html, /<img/);
});
