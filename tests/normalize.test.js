import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../src/lib/normalize.js';

function snapshot() {
  return {
    homeId: 'a1b2c3d4e5f60708',
    homePath: '/home/u/.dsh',
    generatedAt: '2026-09-04T01:00:00.000Z',
    wsVersion: 2,
    pcVersion: 3,
    workspaces: [
      { workspaceId: 'ws-1', title: 'Alpha', path: '/repo/alpha-app', archived: false, sessionIds: ['s1', 's2'] },
    ],
    sessions: [
      {
        sessionId: 's1',
        cwd: '/repo/alpha-app',
        title: 'first session',
        tokenUsage: { uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
        contextPressure: { pressureTokens: 5, projectedTokens: 6, contextWindow: 100 },
        status: { kind: 'running', label: '运行中', subagents: 0, approval: 'ask' },
        lastActivity: '2026-09-04T00:59:00.000Z',
      },
      { sessionId: 's-orphan', cwd: '/repo/orphan-app', title: '', tokenUsage: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      { sessionId: 's-nowhere', cwd: '', title: '', tokenUsage: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    ],
    modelTier: { activeId: 'std', tiers: { std: { provider: 'deepseek', model: 'deepseek-chat' } } },
    providers: [{ ref: 'DEEPSEEK_API_KEY', provider: 'deepseek' }],
    degraded: [],
  };
}

test('normalize joins sessions to workspaces via sessionIds inversion', () => {
  const rows = normalize(snapshot());
  const s1 = rows.find((r) => r.type === 'session' && r.sessionId === 's1');
  assert.equal(s1.workspaceId, 'ws-1');
  // 项目名跟 workspace.title 走（fixture 的 title 与目录名故意不同），不再是 basename(path)
  assert.equal(s1.project, 'Alpha');
  assert.equal(s1.workspaceTitle, 'Alpha');
  assert.equal(s1.title, 'first session');
  assert.deepEqual(JSON.parse(s1.tokenUsage).outputTokens, 2);
  assert.deepEqual(JSON.parse(s1.contextPressure).contextWindow, 100);
  assert.deepEqual(JSON.parse(s1.status), { kind: 'running', label: '运行中', subagents: 0, approval: 'ask' });
  assert.equal(s1.lastActivity, '2026-09-04T00:59:00.000Z');
});

test('normalize handles orphan sessions via cwd and missing contextPressure', () => {
  const rows = normalize(snapshot());
  const orphan = rows.find((r) => r.type === 'session' && r.sessionId === 's-orphan');
  assert.equal(orphan.workspaceId, null);
  assert.equal(orphan.project, 'orphan-app');
  assert.equal(orphan.workspaceTitle, null);
  assert.equal(orphan.contextPressure, null);
  const nowhere = rows.find((r) => r.type === 'session' && r.sessionId === 's-nowhere');
  assert.equal(nowhere.project, 'unknown');
});

test('normalize emits home/workspace/provider/modelTier rows', () => {
  const rows = normalize(snapshot());
  const home = rows.find((r) => r.type === 'home');
  assert.equal(home.homeId, 'a1b2c3d4e5f60708');
  assert.deepEqual(home.degraded, []);

  const ws = rows.find((r) => r.type === 'workspace');
  assert.equal(ws.project, 'Alpha');
  assert.equal(ws.sessionCount, 1);

  assert.deepEqual(rows.filter((r) => r.type === 'provider'), [
    { type: 'provider', homeId: home.homeId, ref: 'DEEPSEEK_API_KEY', provider: 'deepseek' },
  ]);

  const tier = rows.find((r) => r.type === 'modelTier');
  assert.equal(tier.tierId, 'std');
  assert.equal(tier.active, true);
});

test('normalize carries degraded domains onto the home row', () => {
  const s = snapshot();
  s.degraded.push({ domain: 'projcache', error: 'unsupported version 9', degraded: true });
  const home = normalize(s).find((r) => r.type === 'home');
  assert.equal(home.degraded[0].domain, 'projcache');
});

// dsh 里重命名项目只会改 workspace 记录的 title（`workspace.rename` → `setTitle`），path 是
// canonical 目录、永远不变。项目名必须跟 title 走，否则「编辑项目名后 hwb 不更新」；而且同一目录
// 在 Codex 侧用的是它自己的项目名，两个名字会把同一目录拆成两张项目卡。
test('normalize: 项目名跟 workspace.title（dsh 重命名即生效），目录名只作兜底', () => {
  const rows = normalize({
    homeId: 'h1', homePath: '/p', generatedAt: 'now', wsVersion: 2, pcVersion: 3, degraded: [],
    workspaces: [
      // title 是用户在 dsh 里改的名字，path 仍是原目录
      { workspaceId: 'ws-1', title: 'PMAID-Production', path: '/repo/PMSEQ/PMAID1.0-Production', archived: false, sessionIds: ['s1'] },
      // title 是空白 ⇒ 不算有效名，回退目录名
      { workspaceId: 'ws-2', title: '   ', path: '/repo/BGI-Raw', archived: false, sessionIds: [] },
      // title 缺失（旧文件/外部工具写的记录）⇒ 同样回退目录名
      { workspaceId: 'ws-3', path: '/repo/no-title', archived: false, sessionIds: [] },
    ],
    sessions: [{ sessionId: 's1', cwd: '/repo/PMSEQ/PMAID1.0-Production', title: 't', lastActivity: 'now' }],
    providers: [], modelTier: null,
  });
  const byWs = (id) => rows.find((r) => r.type === 'workspace' && r.workspaceId === id);
  assert.equal(byWs('ws-1').project, 'PMAID-Production', '重命名后项目名跟 title 走');
  assert.equal(byWs('ws-1').path, '/repo/PMSEQ/PMAID1.0-Production', 'path 原样保留（打开工作区要用）');
  assert.equal(byWs('ws-2').project, 'BGI-Raw', '空白 title 回退目录名');
  assert.equal(byWs('ws-3').project, 'no-title', '缺 title 回退目录名');
  // 会话行与 workspace 行必须是同一个项目名，否则筛选 / 聚合 / 静音按名字对不上
  assert.equal(rows.find((r) => r.type === 'session').project, 'PMAID-Production');
});

// dsh 的 sessionIds 只记「被 attach 过的会话」，同一目录里用 CLI / 其它入口跑出来的会话不在
// 里面（实测本机 PMAID1.0-Production 有 8 个）。它们的 cwd 就是工作区目录，项目名必须跟工作区
// 的 title 走，否则改名只生效一半；但 workspaceId 不能伪造 —— dsh 的 attachSession 判据是
// cwd(realpath) === workspace.path（**不是前缀**），归属还被预览 / 上传 / 打开工作区使用。
test('normalize: cwd 与 workspace.path 相同的未归属会话取该工作区的项目名，但不伪造 workspaceId', () => {
  const rows = normalize({
    homeId: 'h1', homePath: '/p', generatedAt: 'now', wsVersion: 2, pcVersion: 3, degraded: [],
    workspaces: [
      { workspaceId: 'ws-1', title: 'PMAID-Production', path: '/repo/PMSEQ/PMAID1.0-Production', archived: false, sessionIds: ['linked'] },
    ],
    sessions: [
      { sessionId: 'linked', cwd: '/repo/PMSEQ/PMAID1.0-Production', title: 'a', lastActivity: 'now' },
      { sessionId: 'same-cwd', cwd: '/repo/PMSEQ/PMAID1.0-Production/', title: 'b', lastActivity: 'now' },
      { sessionId: 'subdir', cwd: '/repo/PMSEQ/PMAID1.0-Production/sub', title: 'c', lastActivity: 'now' },
    ],
    providers: [], modelTier: null,
  });
  const of = (id) => rows.find((r) => r.type === 'session' && r.sessionId === id);
  assert.equal(of('linked').project, 'PMAID-Production');
  assert.equal(of('same-cwd').project, 'PMAID-Production', '尾部斜杠不影响匹配');
  assert.equal(of('same-cwd').workspaceId, null, '归属仍以 dsh 的 sessionIds 为准，不按路径伪造');
  assert.equal(of('same-cwd').workspaceTitle, null);
  assert.equal(of('subdir').project, 'sub', '子目录不是这个工作区（dsh 判据是 cwd===path，不是前缀）');
});


// node:sqlite 绑 TEXT 时按 C 字符串处理：值里的 U+0000 会把后面**全部静默截掉**（没有报错、
// 没有 degraded）。实测（审查）：`run('A\u0000B')` 读回 `'A'`，`run('\u0000leading')` 读回 `''`。
// 外部 dsh home 的 title / cwd / path 里一旦有 NUL，入库时就只剩前半截 —— 界面上看不出少了什么。
// 现在在产出侧（normalize）统一剥掉 NUL。
test('normalize: 文本字段里的 NUL 会被剥掉（否则入库时被静默截断）', () => {
  const rows = normalize({
    homeId: 'h1', homePath: '/p', generatedAt: 'now', wsVersion: 2, pcVersion: 3,
    workspaces: [{ workspaceId: 'ws-1', title: 'A\u0000B', path: '/r/\u0000x', archived: false, sessionIds: ['s1'] }],
    sessions: [{ sessionId: 's1', title: '\u0000leading', cwd: '/r/demo', lastActivity: 'now' }],
    providers: [{ ref: 'X\u0000API_KEY', provider: 'x' }],
    modelTier: null, degraded: [],
  });
  const ws = rows.find((r) => r.type === 'workspace');
  assert.equal(ws.title, 'AB', 'NUL 剥掉而不是截断到 NUL 之前');
  assert.equal(ws.path, '/r/x');
  // 项目名取 title：NUL 必须在**取名之前**剥掉，否则写库时 project 会被截成 'A'
  assert.equal(ws.project, 'AB');
  const sess = rows.find((r) => r.type === 'session');
  assert.equal(sess.title, 'leading', '开头的 NUL 也要剥掉（原先整个值会变成空串）');
  assert.equal(sess.workspaceTitle, 'AB');
  assert.equal(sess.project, 'AB');
  assert.equal(rows.find((r) => r.type === 'provider').ref, 'XAPI_KEY');
});
