import { test } from 'node:test';
import assert from 'node:assert/strict';

// 「Projects 与 Sessions 两栏分不清」的回归守卫。
// 这些断言只关心**结构/语义差异**（形状、锚点、分区身份、来源标记），不锁具体色值：
// 颜色来自主题变量与项目哈希，锁死会让换配色就红。
// 例外：来源底色必须「明暗主题各有一套」—— 那是可见性契约，不是配色偏好。
globalThis.document = {
  documentElement: { dataset: { theme: 'light' } },
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
};
globalThis.window = { matchMedia: () => ({ matches: false }) };

const { renderRecentProjects, monogramOf } = await import('../src/web/components/recent-projects.js');
const { renderRecentSessions, shortSessionId } = await import('../src/web/components/recent-sessions.js');
const { renderWorkbench } = await import('../src/web/components/workbench.js');

const EVIL = 'x"><img src=x onerror=alert(1)>';
const INJECTED_TAG = /<(?:img|script|svg|iframe|object|embed|body|style|link)\b/i;

const project = (extra = {}) => ({
  homeId: 'abcdef1234567890', workspaceId: 'w1', project: 'PMAID-RENJI',
  sessionId: '01a1669a-4aed-74c0-8f45-945379c56e0d', lastActivity: null,
  sessionCount: 4, inputTokens: 0, outputTokens: 0, totalTokens: 34_230_439, ...extra,
});
const session = (extra = {}) => ({
  homeId: 'abcdef1234567890', sessionId: '01a1669a-4aed-74c0-8f45-945379c56e0d',
  title: '将本项目构建成一款适合软著申报的软件形态', project: 'PMAID-RENJI',
  lastActivity: null, status: { kind: 'running', label: '运行中', subagents: 0 }, ...extra,
});

test('项目卡与会话卡的第一视觉锚点不同：项目=身份徽标，会话=状态竖轨', () => {
  const p = renderRecentProjects([project()]);
  assert.match(p, /class="row clickable card project-card"/);
  assert.match(p, /class="project-badge" aria-hidden="true">PR</, '双字母 monogram 作为项目身份锚点');
  assert.match(p, /class="card-rail" aria-hidden="true"><\/span>/, '项目卡有竖轨（项目色）');
  assert.match(p, /style="--card-accent:#[0-9a-f]{6};--card-tint:#[0-9a-f]{6}"/, '项目色通过 CSS 变量下发');

  const s = renderRecentSessions([session()]);
  assert.match(s, /class="row clickable card session-card"/);
  assert.match(s, /data-status="running"/, '会话卡带状态数据属性（竖轨与标题字重都靠它）');
  assert.doesNotMatch(s, /project-badge/, '会话卡绝不能出现项目徽标——两栏的锚点必须互斥');
  assert.doesNotMatch(p, /session-card/);
});

test('项目卡底色按 app 来源（实例 harness）区分：dsh / Codex / Claude Code / WorkBuddy / 未知', () => {
  const homes = [
    { homeId: 'h-dsh', harness: 'dsh', alias: 'bee' },
    { homeId: 'h-codex', harness: 'codex', alias: 'Codex' },
    { homeId: 'h-claude', harness: 'claude-code', alias: 'Claude' },
    { homeId: 'h-wb', harness: 'workbuddy', alias: 'WorkBuddy' },
    { homeId: 'h-alias', harness: 'Claude_Code', alias: '别名' },
    { homeId: 'h-unknown', harness: EVIL, alias: '未知' },
  ];
  const projects = homes.map((h, i) => project({ homeId: h.homeId, project: `proj-${i}` }));
  const html = renderRecentProjects(projects, homes);
  const sources = [...html.matchAll(/class="row clickable card project-card"[^>]*data-source="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(sources, ['dsh', 'codex', 'claude-code', 'workbuddy', 'claude-code', 'other'],
    '别名归一化到同一来源；未知/恶意 harness 一律归 other');
  assert.doesNotMatch(html, INJECTED_TAG, 'data-source 是白名单值，不可能带出注入');
  assert.match(html, /title="数据来源：Codex · 点击筛选该项目会话"/, 'title 说明底色的来源含义 + 点击语义');
});

test('index.html：项目卡按来源着色的 CSS 契约（明/暗主题各一套底色）', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('../src/web/index.html', import.meta.url), 'utf8');
  const sources = {
    dsh: '--src-dsh',
    codex: '--src-codex',
    'claude-code': '--src-claude',
    workbuddy: '--src-workbuddy',
    other: '--src-other',
  };
  for (const [source, varName] of Object.entries(sources)) {
    // 每个来源必须真的把 --card-bg 指到自己的变量，否则 data-source 就只是没有视觉效果的属性
    assert.match(css, new RegExp(`\\.project-card\\[data-source="${source}"\\]\\s*\\{\\s*--card-bg:\\s*var\\(${varName}\\);`),
      `${source} 缺少 --card-bg 规则`);
    assert.match(css, new RegExp(`${varName}:\\s*#[0-9a-f]{6}`), `${source} 缺少浅色底色变量`);
    assert.match(css, new RegExp(`${varName}-line:\\s*#[0-9a-f]{6}`), `${source} 缺少浅色描边变量`);
  }
  // 深浅两套：显式「黑夜」与「跟随系统」都必须覆盖，否则深色主题会拿到浅色底（刺眼）。
  const darkBlocks = css.match(/(?::root\[data-theme="dark"\]|:root:not\(\[data-theme="light"\]\))\s*\{[\s\S]*?\n\s*\}/g) ?? [];
  assert.equal(darkBlocks.length, 2, '深色主题应有两套变量（手动 + 跟随系统）');
  for (const block of darkBlocks) {
    for (const varName of Object.values(sources)) {
      assert.match(block, new RegExp(`${varName}:\\s*#[0-9a-f]{6}`), `深色主题缺少 ${varName}`);
    }
  }
  // 项目卡的底色不能再写死成 panel：否则来源着色只剩 hover 时才可见
  assert.doesNotMatch(css, /\.pane-projects \.rows > \.row\.card \{[^}]*background: var\(--panel\)/,
    '项目卡底色应取 --card-bg（按来源），不能写死 --panel');
});

test('sourceKind：来源别名归一化，未知值不会进 data-source', async () => {
  const { sourceKind, sourceLabel } = await import('../src/web/store.js');
  assert.equal(sourceKind('dsh'), 'dsh');
  assert.equal(sourceKind('DSH'), 'dsh');
  assert.equal(sourceKind('codex'), 'codex');
  assert.equal(sourceKind('claude-code'), 'claude-code');
  assert.equal(sourceKind('claude'), 'claude-code');
  assert.equal(sourceKind('Claude_Code'), 'claude-code');
  assert.equal(sourceKind('workbuddy'), 'workbuddy');
  assert.equal(sourceKind('work buddy'), 'workbuddy');
  assert.equal(sourceKind(undefined), 'other');
  assert.equal(sourceKind(EVIL), 'other');
  assert.equal(sourceLabel('claude-code'), 'Claude Code');
  assert.equal(sourceLabel('other'), '未识别');
});

test('分区头带身份 class 与计数；未传计数时不画空胶囊', () => {
  const withCounts = renderWorkbench({
    projects: '<div class="rows"></div>', sessions: '<div class="rows"></div>', homes: '',
    usage: '', logs: '', projectCount: 14, sessionCount: 50,
  });
  assert.match(withCounts, /class="pane pane-projects"/);
  assert.match(withCounts, /class="pane pane-sessions"/);
  assert.match(withCounts, /class="pane pane-instances"/);
  assert.match(withCounts, /Recent Projects<\/span><span class="pane-count">14</);
  assert.match(withCounts, /Recent Sessions<\/span><span class="pane-count">50</);

  const withoutCounts = renderWorkbench({ projects: '', sessions: '', homes: '', usage: '', logs: '' });
  assert.doesNotMatch(withoutCounts, /pane-count/, '旧调用没传计数时不能出现 0/undefined 胶囊');
});

test('monogram：分隔符取首字母、中文取前两字、空值不崩', () => {
  assert.equal(monogramOf('PMAID-RENJI'), 'PR');
  assert.equal(monogramOf('2026-Student-HZY'), '2S');
  assert.equal(monogramOf('AIxBIxSCI'), 'AI');
  assert.equal(monogramOf('广实分布式系统'), '广实');
  assert.equal(monogramOf('  '), '?');
  assert.equal(monogramOf(EVIL), 'XI', 'ASCII 结构名只取字母数字，不把标签字符带进徽标');
});

test('session id：默认只露尾部 6 位，完整值留给 title 属性（可排查、不占视觉）', () => {
  assert.equal(shortSessionId('01a1669a-4aed-74c0-8f45-945379c56e0d'), 'c56e0d');
  assert.equal(shortSessionId('session-abcd1234'), 'cd1234');
  assert.equal(shortSessionId(''), '');
  const html = renderRecentSessions([session()]);
  assert.match(html, /class="sid" title="session 01a1669a-4aed-74c0-8f45-945379c56e0d">#c56e0d</);
});

test('新结构仍逐字段转义（徽标/monogram、短 id、title 属性都是不可信输入派生）', () => {
  const p = renderRecentProjects([project({ project: EVIL, workspaceId: EVIL })], [{ homeId: 'abcdef1234567890', alias: EVIL, homePath: EVIL }]);
  assert.doesNotMatch(p, INJECTED_TAG);

  const s = renderRecentSessions([session({ title: EVIL, project: EVIL, sessionId: EVIL })], [{ homeId: 'abcdef1234567890', alias: EVIL, homePath: '/x' }]);
  assert.doesNotMatch(s, INJECTED_TAG);
  assert.match(s, /&lt;script&gt;|&lt;img/, '恶意文本必须以转义形式可见');
});

test('项目/会话的计数与 token 文案保持原契约（Codex total 回退、dsh in/out）', () => {
  const codex = renderRecentProjects([project({ inputTokens: 0, outputTokens: 0, totalTokens: 716_992_900 })]);
  assert.match(codex, /total 717\.0M tokens/);
  assert.match(codex, /<b>4<\/b> sessions/);

  const dsh = renderRecentProjects([project({ inputTokens: 1500, outputTokens: 300, totalTokens: 0 })]);
  assert.match(dsh, /in 1\.5k/);
  assert.match(dsh, /out 300/);
  assert.doesNotMatch(dsh, /total .* tokens/);
});
