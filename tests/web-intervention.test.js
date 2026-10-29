import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// 「需要人工介入」的前端展示层回归守卫。
// 数据契约（FROZEN）：session.intervention / session.status.intervention 可能是
//   { kind:'approval'|'plan-review'|'question', label, source:'live'|'projection',
//     since:ISO|null, tool:string|null, reason:string|null, count:number }
// 这里只测前端：归一 / 排序 / 筛选 / chip / 提示条 / 转义 / CSS 契约 / SSE 监听。
// tool/reason/label 来自 dsh 元数据 —— 存储型 XSS 面，恶意字符串必须只以转义形式出现。
globalThis.document = {
  documentElement: { dataset: { theme: 'light' } },
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
};
globalThis.window = { matchMedia: () => ({ matches: false }) };

const {
  interventionState, normalizeIntervention, mergeInterventions, interventionRank,
  interventionChip, SESSION_FILTERS, filterSessionState, renderSessionStatusFilter,
} = await import('../src/web/components/session-state.js');
const { renderRecentSessions } = await import('../src/web/components/recent-sessions.js');
const { renderWorkbench, renderInterventionBanner } = await import('../src/web/components/workbench.js');
const appJs = await readFile(new URL('../src/web/app.js', import.meta.url), 'utf8');
const indexHtml = await readFile(new URL('../src/web/index.html', import.meta.url), 'utf8');
const storeJs = await readFile(new URL('../src/web/store.js', import.meta.url), 'utf8');

const EVIL = '"><img src=x onerror=alert(1)>';
const INJECTED_TAG = /<(?:img|script|svg|iframe|object|embed|body|style|link)\b/i;
const ISO = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

const row = (id, status, lastActivity = '2026-10-26T01:00:00Z', extra = {}) => ({
  homeId: 'h1', sessionId: id, title: id, project: 'P1', lastActivity, status, ...extra,
});
const withIntervention = (intervention, extra = {}) => row(`iv-${intervention.kind}`, { kind: 'running' }, '2026-10-26T00:00:00Z', { intervention, ...extra });

test('interventionState：只认三种 kind，label 有中文兜底，两个落点都读得到', () => {
  assert.deepEqual(SESSION_FILTERS[0], ['intervention', '待介入'], '「待介入」必须是第一个筛选键');
  assert.equal(interventionState(row('plain', { kind: 'running' })), null);
  assert.equal(interventionState({}), null);
  assert.equal(interventionState(null), null);

  const approval = interventionState(withIntervention({
    kind: 'approval', label: '等待审批', source: 'live', since: ISO(10), tool: 'Bash', reason: '需要写入 /etc/hosts', count: 1,
  }));
  assert.equal(approval.kind, 'approval');
  assert.equal(approval.label, '等待审批');
  assert.equal(approval.icon, '⏳');
  assert.match(approval.title, /工具 Bash/, 'title 带工具名');
  assert.match(approval.title, /原因 需要写入/, 'title 带原因');
  assert.match(approval.title, /来源 实时/);
  assert.match(approval.title, /已等待 10 分钟/);

  // 投影落点（session.status.intervention）：离线实例只靠它才能看到「等待回答」。
  const projected = interventionState(row('proj', { kind: 'idle', intervention: { kind: 'question', reason: '选哪个方案？', source: 'projection' } }));
  assert.equal(projected.kind, 'question');
  assert.equal(projected.label, '等待回答');
  assert.match(projected.title, /来源 投影/);

  // 服务端 label 缺失/非法 → 中文兜底，不出现 undefined / 原始对象。
  for (const [kind, label] of [['approval', '等待审批'], ['plan-review', '计划待审'], ['question', '等待回答']]) {
    const fallback = interventionState(withIntervention({ kind }));
    assert.equal(fallback.label, label, `${kind} 缺少服务端 label 时必须有中文兜底`);
    assert.ok(fallback.icon === '⏳' || fallback.icon === '⚠');
    assert.equal(interventionState(withIntervention({ kind, label: 42 })).label, label);
    assert.equal(interventionState(withIntervention({ kind, label: '   ' })).label, label);
  }
  // 未知/缺失 kind 一律视为「没有介入」，不能把坏结构标成「在等你」。
  for (const bad of [null, undefined, {}, { kind: 'meeting' }, { kind: 'approval'.toUpperCase() }, [], 'approval']) {
    assert.equal(normalizeIntervention(bad), null);
  }
});

test('合并优先级：approval > plan-review > question，同 kind 时 live 覆盖 projection', () => {
  assert.equal(interventionRank('approval'), 3);
  assert.equal(interventionRank('plan-review'), 2);
  assert.equal(interventionRank('question'), 1);
  assert.equal(interventionRank('unknown'), 0);

  const both = interventionState(row('both', {
    kind: 'idle',
    intervention: { kind: 'question', source: 'projection', reason: '项目投影里的提问' },
  }, '2026-10-26T00:00:00Z', { intervention: { kind: 'approval', source: 'live', tool: 'Write' } }));
  assert.equal(both.kind, 'approval', '审批压过等待回答');
  assert.equal(both.source, 'live');
  assert.match(both.title, /原因 项目投影里的提问/, '弱者只补空字段，不覆盖强者');

  const sameKind = interventionState(row('same', {
    kind: 'idle',
    intervention: { kind: 'plan-review', source: 'projection', reason: '旧' },
  }, '2026-10-26T00:00:00Z', { intervention: { kind: 'plan-review', source: 'live', reason: '新' } }));
  assert.equal(sameKind.source, 'live');
  assert.match(sameKind.title, /原因 新/);

  assert.equal(mergeInterventions(null, null), null);
  assert.equal(mergeInterventions({ kind: 'question' }, { kind: 'nope' }).kind, 'question');
});

test('排序：有介入的排在运行中之前（审批最前），筛选不改变入参', () => {
  const input = [
    row('run', { kind: 'running' }, '2026-10-26T09:00:00Z'),
    withIntervention({ kind: 'question', source: 'projection' }),
    row('done', { kind: 'completed' }, '2026-10-26T08:00:00Z'),
    withIntervention({ kind: 'approval', source: 'live', tool: 'Bash' }),
  ];
  const order = filterSessionState(input).map((s) => s.sessionId);
  assert.deepEqual(order.slice(0, 3), ['iv-approval', 'iv-question', 'run'],
    '介入（审批先于提问）整体排在运行中之前');
  assert.equal(input[0].sessionId, 'run', '排序不得修改入参顺序');
  assert.equal(input[1].intervention.kind, 'question');

  // 只保留有介入的行；没有介入时是空数组而不是 undefined。
  assert.deepEqual(filterSessionState(input, 'intervention').map((s) => s.sessionId), ['iv-approval', 'iv-question']);
  assert.deepEqual(filterSessionState([row('run', { kind: 'running' })], 'intervention'), []);

  // 计数与筛选同源：待介入 tab 的数字 = filterSessionState(...,'intervention').length。
  const chips = renderSessionStatusFilter(input, 'all');
  assert.match(chips, /data-status-filter="intervention" aria-pressed="false">待介入<span>2<\/span>/);
  assert.match(chips, /data-status-filter="running" aria-pressed="false">运行中<span>3<\/span>/, '有介入的运行中会话仍算运行中（介入是叠加标记，不改变状态口径）');
});

test('会话卡：介入 chip 在状态 chip 之前、data-intervention 标在根节点、竖轨为 warn', () => {
  const html = renderRecentSessions([withIntervention({
    kind: 'approval', label: '等待审批', source: 'live', since: ISO(5), tool: 'Bash', reason: '需要确认',
  })]);
  assert.match(html, /class="chip status warn intervention" data-intervention="approval"/, 'chip 带 warn 样式与 data-intervention');
  assert.match(html, /⏳<\/span>等待审批<\/span>/, '文案 = 图标 + 服务端标签');
  assert.match(html, /class="row clickable card session-card"[^>]*data-intervention="approval"/, '卡片根节点带 kind');
  assert.match(html, /class="card-rail warn"/, '竖轨切换成 warn 强调');
  assert.ok(html.indexOf('chip status warn intervention') < html.indexOf('chip status run'),
    '介入 chip 必须渲染在状态 chip 之前（更急的信息先被读到）');
  assert.match(html, /title="[^"]*工具 Bash/, 'tool 进 chip title');

  // 无介入：既有渲染完全不变（不能凭空多出属性/样式钩子）。
  const plain = renderRecentSessions([row('plain', { kind: 'running' })]);
  assert.doesNotMatch(plain, /data-intervention/, '空的 data-intervention 也会命中 CSS，必须整个属性缺席');
  assert.doesNotMatch(plain, /card-rail warn/);
  assert.doesNotMatch(plain, /intervention/);
  assert.match(plain, /class="chip status run"/, '原有状态 chip 仍在');
});

test('恶意 label/tool/reason 只以转义形式出现，超长文本被截断', () => {
  const evil = withIntervention({
    kind: 'approval', label: EVIL, source: 'live', since: ISO(1), tool: EVIL.repeat(20), reason: EVIL.repeat(200),
  });
  const html = renderRecentSessions([evil]);
  assert.doesNotMatch(html, INJECTED_TAG, '任何位置都不得产生可执行标记');
  assert.match(html, /&lt;img/, '恶意文本必须以转义形式可见');
  assert.doesNotMatch(html, /onerror=alert\(1\)>/, '属性注入面必须被 esc 掉（转义后的文本允许存在，未转义的标签/属性不允许）');

  // 截断：label ≤24、tool ≤64、reason ≤160（超出部分以 … 收尾），避免畸形长文本撑爆 title。
  const state = interventionState(evil);
  assert.ok(state.title.length < 420, `title 应被截断，实际 ${state.title.length}`);
  assert.match(state.title, /…/);
  const longLabel = interventionState(withIntervention({ kind: 'question', label: 'x'.repeat(500) }));
  assert.ok(longLabel.label.length <= 25, `label 应截断到 24+…，实际 ${longLabel.label.length}`);
  assert.equal(interventionState(withIntervention({ kind: 'question', label: 'x'.repeat(500) })).label.endsWith('…'), true);

  // 非审批 kind 不接受 tool（避免显示误导性工具名）。
  assert.equal(interventionState(withIntervention({ kind: 'question', tool: 'Bash' })).tool, null);
  assert.doesNotMatch(renderRecentSessions([withIntervention({ kind: 'question', tool: EVIL })]), /工具/);
});

test('提示条：只在有介入时出现，数字与按钮可核验，非法数字不产生标记', () => {
  const banner = renderInterventionBanner(3);
  assert.match(banner, /class="intervention-banner" role="status"/);
  assert.match(banner, /<b>3<\/b> 个会话需要你操作/);
  assert.match(banner, /data-action="filter-session-status" data-status-filter="intervention"/);
  assert.match(banner, /只看待介入/);
  assert.match(renderInterventionBanner(3, { active: true }), /aria-pressed="true"/);

  for (const empty of [0, -1, null, undefined, '', NaN, 'abc', EVIL]) {
    assert.equal(renderInterventionBanner(empty), '', `${String(empty)} 不应画出提示条`);
  }
  assert.match(renderInterventionBanner('2'), /<b>2<\/b>/, '数字字符串照常显示（服务端计数是数字）');
  assert.equal(renderInterventionBanner(2.9), renderInterventionBanner(2), '计数取整，不画 2.9');

  // 注入面：提示条只有数字，没有来自元数据的文本。
  assert.doesNotMatch(renderInterventionBanner(1), /&lt;|&gt;/, '提示条不拼接任何外部文本');
});

test('workbench：提示条挂在会话列表上方（滚动区外），旧调用不传时不画', () => {
  const html = renderWorkbench({
    projects: '', sessions: '<div class="rows"></div>', homes: '', usage: '', logs: '',
    interventionBanner: renderInterventionBanner(2),
  });
  assert.match(html, /class="intervention-banner"/);
  assert.ok(html.indexOf('intervention-banner') < html.indexOf('class="session-list"'),
    '提示条必须在列表之前（列表滚动时仍可见）');

  const legacy = renderWorkbench({ projects: '', sessions: '<div class="rows"></div>', homes: '', usage: '', logs: '' });
  assert.doesNotMatch(legacy, /intervention-banner/, '旧调用（未传参）行为不变');
});

test('app.js 接线：统计可见会话的介入数并传入提示条', () => {
  assert.match(appJs, /import \{ renderWorkbench, renderInterventionBanner \} from '\.\/components\/workbench\.js'/);
  assert.match(appJs, /interventionState \} from '\.\/components\/session-state\.js'/);
  assert.match(appJs, /const interventionCount = shownSessions\.filter\(\(s\) => interventionState\(s\)\)\.length;/);
  assert.match(appJs, /interventionBanner: filtered\.connected \? renderInterventionBanner\(interventionCount, \{ active: sessionStatusFilter === 'intervention', unobserved: unobservedHomeNames \}\) : ''/);
  assert.match(appJs, /const unobservedHomeNames = \[\.\.\.new Set\(shownSessions/, '观测盲区名单必须从屏上可见会话算出来');
});

test('SSE：subscribe 监听 intervention:updated，状态能及时刷新', async () => {
  assert.match(storeJs, /es\.addEventListener\('intervention:updated', \(\) => cb\(\)\);/, 'store.js 必须有该监听');
  const listeners = new Map();
  class FakeEventSource {
    constructor(url) { this.url = url; this.listeners = listeners; FakeEventSource.last = this; }
    addEventListener(type, fn) { listeners.set(type, fn); }
  }
  const previous = globalThis.EventSource;
  globalThis.EventSource = FakeEventSource;
  try {
    const { subscribe } = await import('../src/web/store.js');
    let calls = 0;
    const es = subscribe(() => { calls++; });
    assert.equal(es.url, '/api/events');
    assert.ok(listeners.has('intervention:updated'));
    listeners.get('intervention:updated')();
    assert.equal(calls, 1, '收到事件必须触发刷新回调');
    listeners.get('index:updated')();
    assert.equal(calls, 2, '原有事件监听不受影响');
  } finally {
    globalThis.EventSource = previous;
  }
});

test('index.html：warn 体系下的介入 chip / 卡片 / 竖轨 / 提示条都有样式（明暗主题可读）', () => {
  assert.match(indexHtml, /\.chip\.status\.warn\.intervention\s*\{[^}]*var\(--warn\)/);
  assert.match(indexHtml, /\.session-card\[data-intervention\]\s*\{[^}]*var\(--warn\)/);
  assert.match(indexHtml, /\.session-card\[data-intervention\]\s*>\s*\.card-rail\s*\{[^}]*background:\s*var\(--warn\)/);
  assert.match(indexHtml, /\.intervention-banner\s*\{[^}]*display:\s*flex/);
  assert.match(indexHtml, /\.intervention-banner\s*\.iv-dot\s*\{/);
  assert.match(indexHtml, /\.intervention-banner \.iv-text b\s*\{[^}]*var\(--warn\)/);
  assert.match(indexHtml, /@keyframes iv-breathe/, '轻微呼吸点存在');
  assert.match(indexHtml, /prefers-reduced-motion[^{]*\{[^}]*\.intervention-banner \.iv-dot \{ animation: none; \}/,
    '系统要求减少动态时必须关掉动画');

  // 两套深色主题（手动 + 跟随系统）都必须有 --warn，否则提示条在深色下对比度不足。
  const darkBlocks = indexHtml.match(/(?::root\[data-theme="dark"\]|:root:not\(\[data-theme="light"\]\))\s*\{[\s\S]*?\n\s*\}/g) ?? [];
  assert.equal(darkBlocks.length, 2, '深色主题应有两套变量（手动 + 跟随系统）');
  for (const block of darkBlocks) assert.match(block, /--warn:\s*#[0-9a-f]{6}/);
  assert.match(indexHtml, /:root\s*\{[\s\S]*?--warn:\s*#[0-9a-f]{6}/, '浅色主题也要有 --warn');
});

test('全局搜索结果也会标出待介入（搜索是「找个卡住的会话」的入口）', async () => {
  const { renderSearchResults } = await import('../src/web/components/search-results.js');
  const row = (id, intervention) => ({ homeId: 'h1', sessionId: id, title: id, project: 'P1', lastActivity: '2026-10-26T01:00:00Z', intervention });
  const html = renderSearchResults({ sessions: [row('waiting', { kind: 'approval', label: '等待审批', tool: 'bash' }), row('plain', null)] });
  // 前置介入 chip + 结果行 data-intervention；两处都只出现在有介入的行上。
  assert.match(html, /data-session-id="waiting" data-intervention="approval"/);
  assert.match(html, /chip status warn intervention"[^>]*data-intervention="approval"[^>]*>.*?等待审批/);
  assert.doesNotMatch(html, /data-session-id="plain" data-intervention/);
  assert.equal((html.match(/chip status warn intervention/g) ?? []).length, 1);
  // 恶意 tool 文本只作为 title 的转义文本出现。
  const evil = renderSearchResults({ sessions: [{ homeId: 'h1', sessionId: 's', title: 't', intervention: { kind: 'approval', label: '等待审批', tool: '"><img src=x>' } }] });
  assert.doesNotMatch(evil, /<img/);
  assert.match(evil, /&quot;&gt;&lt;img src=x&gt;/);
});
