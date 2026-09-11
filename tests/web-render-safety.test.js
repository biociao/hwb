import { test } from 'node:test';
import assert from 'node:assert/strict';

// 渲染安全回归。hwb 把 dsh home 的元数据（会话标题 / 项目名 / 权限策略…）直接拼进 HTML 字符串，
// 再交给 innerHTML —— 也就是说**远端实例上的元数据就是不可信输入**：一个被改过的 dsh home，
// 或者 dsh 未来新增的字段，都可能带着 `"><img src=x onerror=…>` 这类内容。
// 这里用最小 globals 顶替浏览器环境（chipColor 会读主题），只依赖组件真正用到的那部分。
globalThis.document = {
  documentElement: { dataset: { theme: 'light' } },
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
};
globalThis.window = { matchMedia: () => ({ matches: false }) };

const { renderRecentSessions } = await import('../src/web/components/recent-sessions.js');
const { renderRecentProjects } = await import('../src/web/components/recent-projects.js');
const { renderInstanceGrid } = await import('../src/web/components/instance-grid.js');

const PAYLOAD = 'x"><img src=x onerror=alert(1)>';
// 只有在「真的被解析成标签」时才算注入成功。注意不能拿 `onerror=` 之类的**字面量**当判据：
// 正确转义后它仍会作为可见文本原样出现在 HTML 里（无害），那正是我们要的正向证据。
const INJECTED_TAG = /<(?:img|script|svg|iframe|object|embed|body|style|link)\b/i;
const ESCAPED_TAG = /&lt;img/;

function session(status, extra = {}) {
  return { homeId: 'abcdef1234567890', sessionId: 's1', title: 'title', project: 'proj',
    lastActivity: null, status, ...extra };
}

test('recent-sessions: 恶意 approval 不能突破 title 属性（原先的存储型 XSS）', () => {
  const html = renderRecentSessions([session({ kind: 'idle', label: '空闲', subagents: 0, approval: PAYLOAD })]);
  assert.doesNotMatch(html, INJECTED_TAG, 'approval 必须转义，不得产生可执行标签');
  assert.match(html, ESCAPED_TAG, '证据：注入内容应作为转义文本出现');
  assert.match(html, /&quot;/, '双引号应转义为 &quot;，属性不会被提前闭合');
  // 转义后仍是「可见文本」，用户依旧能看到审批策略原文的一部分
  assert.match(html, /审批/);
});

test('recent-sessions: 正常的 approval 照常展示', () => {
  const html = renderRecentSessions([session({ kind: 'running', label: '运行中', subagents: 0, approval: 'never' })]);
  assert.match(html, /审批 never/);
  assert.doesNotMatch(html, /&amp;(?!nbsp)/, '普通文本不应被过度转义');
});

test('recent-sessions: label / subagents 字段同样不可注入', () => {
  const html = renderRecentSessions([session({ kind: 'idle', label: PAYLOAD, subagents: 0 })]);
  assert.doesNotMatch(html, INJECTED_TAG);
});

test('recent-sessions: 会话元数据（title/project/sessionId）逐字段转义', () => {
  const evil = '"><script>alert(1)</script>';
  const html = renderRecentSessions([session({ kind: 'idle', label: '空闲', subagents: 0 },
    { title: evil, project: evil, sessionId: evil, homeId: evil })]);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('recent-sessions: 空状态与缺 status 不崩', () => {
  assert.match(renderRecentSessions([]), /no sessions indexed yet/);
  assert.doesNotMatch(renderRecentSessions([session(undefined)]), INJECTED_TAG);
});

test('recent-projects: 项目名 / 实例别名 / 实例路径逐字段转义', () => {
  const evil = '"><img src=x onerror=alert(1)>';
  const html = renderRecentProjects(
    [{ homeId: 'abcdef1234567890', project: evil, sessionId: evil, lastActivity: null, sessionCount: 1, inputTokens: 0, outputTokens: 0 }],
    [{ homeId: 'abcdef1234567890', alias: evil, homePath: evil }],
  );
  assert.doesNotMatch(html, INJECTED_TAG);
});

test('recent-projects: 无实例信息时不给 chip，避免读 undefined 崩掉', () => {
  const html = renderRecentProjects(
    [{ homeId: 'abcdef1234567890', project: 'p', sessionId: null, lastActivity: null, sessionCount: 0, inputTokens: 0, outputTokens: 0 }],
    [],
  );
  assert.doesNotMatch(html, /home-chip/);
  assert.match(html, /no sessions/);
});

// 实例网格的降级提示。域降级（如 dsh 升级后 unit.version 不被识别）此前只写进数据库、
// 界面上任何地方都不显示，用户只能看到「这个实例的会话/项目变少了」而毫无线索。
test('instance-grid: 域降级时显示可解释的警告 chip', () => {
  const home = {
    homeId: 'abcdef1234567890', homePath: '/home/u/.dsh', status: 'degraded',
    workspaceCount: 1, sessionCount: 2, runtime: { runtime: 'running', latencyMs: 3, checkedAt: null },
    degraded: [{ domain: 'projcache', error: 'unsupported version 4 (supported: 3)', degraded: true }],
  };
  const html = renderInstanceGrid([home]);
  assert.match(html, /projcache 降级/, '必须出现降级 chip');
  assert.match(html, /unsupported version 4/, 'chip 的 title 应带上具体原因，便于归因');
  assert.match(html, /本次成功索引|上一次成功索引/, '应说明数据仍在沿用上一次');
});

test('instance-grid: 无降级时不显示 chip', () => {
  const home = {
    homeId: 'abcdef1234567890', homePath: '/home/u/.dsh', status: 'ok',
    workspaceCount: 0, sessionCount: 0, runtime: { runtime: 'stopped' }, degraded: [],
  };
  assert.doesNotMatch(renderInstanceGrid([home]), /降级/);
});

test('instance-grid: 降级原因里的 HTML 被转义（错误文本可能含远端路径）', () => {
  const evil = '"><img src=x onerror=alert(1)>';
  const html = renderInstanceGrid([{
    homeId: 'abcdef1234567890', homePath: '/x', status: 'degraded', workspaceCount: 0, sessionCount: 0,
    runtime: { runtime: 'stopped' }, degraded: [{ domain: evil, error: evil, degraded: true }],
  }]);
  assert.doesNotMatch(html, INJECTED_TAG);
  assert.match(html, /&lt;img/);
});

// 键盘可达性：drill-in 行是 <div> + 委托 click —— 只给了鼠标用户。补 role/tabindex 后
// 才能被 Tab 聚焦、被 Enter/Space 激活（见 app.js 的 keydown 委托）。
test('recent-projects/sessions: 可点击行带 role=button 与 tabindex=0', () => {
  const projectHtml = renderRecentProjects(
    [{ homeId: 'abcdef1234567890', project: 'p', sessionId: 's', lastActivity: null, sessionCount: 1, inputTokens: 0, outputTokens: 0 }],
    [],
  );
  assert.match(projectHtml, /data-action="drill-in"[^>]*/, 'sanity');
  assert.match(projectHtml, /role="button"/);
  assert.match(projectHtml, /tabindex="0"/);

  const sessionHtml = renderRecentSessions([session({ kind: 'idle', label: '空闲', subagents: 0 })]);
  assert.match(sessionHtml, /role="button"/);
  assert.match(sessionHtml, /tabindex="0"/);
});

// 格式化辅助函数也是 innerHTML 的插值点。`fmtTokens` 原先最后一个分支是 `String(n)` ——
// 只要传进非数字，任意文本就会原样进入页面（多个调用点不转义，因为「这个值就是个数」）。
// 用量数据来自 dsh 元数据经 SQL 聚合、正常情况下必然是数字，但「正常情况下」不该是唯一防线。
test('fmtTokens: 非数值输入不会把任意文本透进 HTML', async () => {
  const { fmtTokens } = await import('../src/web/store.js');
  assert.equal(fmtTokens(null), '—');
  assert.equal(fmtTokens(undefined), '—');
  assert.equal(fmtTokens(''), '—');
  assert.equal(fmtTokens('<img src=x onerror=alert(1)>'), '—', '任意文本必须被兜成占位符');
  assert.equal(fmtTokens({}), '—');
  assert.equal(fmtTokens(NaN), '—');
  assert.equal(fmtTokens(Infinity), '—');
  assert.equal(fmtTokens('not a number'), '—');
  // 正常数值行为不变
  assert.equal(fmtTokens(0), '0');
  assert.equal(fmtTokens(999), '999');
  assert.equal(fmtTokens(1500), '1.5k');
  assert.equal(fmtTokens(2_500_000), '2.5M');
  assert.equal(fmtTokens('1500'), '1.5k', '数字字符串照常格式化');
});

test('renderUsageCard: 被污染的用量字段不会产出可执行 HTML', async () => {
  const { renderUsageCard } = await import('../src/web/components/usage-card.js');
  const evil = '"><img src=x onerror=alert(1)>';
  const html = renderUsageCard({
    summary: { sessionCount: evil, totalTokens: evil, inputTokens: evil, outputTokens: evil,
      cacheRead: evil, cacheWrite: evil, cacheHitRate: evil, days: evil },
    trendBy: { total: { hours: 24, stepMs: 3_600_000, buckets: [] } },
  }, 'total', '24h');
  assert.doesNotMatch(html, INJECTED_TAG, '用量卡同样不能出现真实注入标签');
});

// 把「前端各插值点已转义」这件事固化成回归测试。
// 这些组件的数据全部来自 dsh 元数据或远端实例，属于不可信输入；手工审计过一轮，
// 但如果只是「审过」而没有测试，下次改动又会悄悄打开一个口子。
const { endpointSelector, currentChannel } = await import('../src/web/components/endpoint-editor.js');
const { renderHomeForm, renderSettingsForm, applyHomeMode } = await import('../src/web/components/add-home.js');

test('endpoint-editor: 端点字段（host/id/homeId）逐字段转义', () => {
  const evil = '"><img src=x onerror=alert(1)>';
  const html = endpointSelector({
    homeId: evil, activeEndpointId: evil,
    endpoints: [{ id: evil, host: evil, port: 3080 }, { id: 'b', host: 'h2', port: 3081 }],
  });
  assert.doesNotMatch(html, INJECTED_TAG);
  assert.match(html, /&lt;img/);
});

test('endpoint-editor: 少于两个端点时不渲染选择器', () => {
  assert.equal(endpointSelector({ homeId: 'a', endpoints: [] }), '');
  assert.equal(endpointSelector({ homeId: 'a', endpoints: [{ id: 'x' }] }), '');
  assert.equal(endpointSelector({ homeId: 'a' }), '');
});

test('currentChannel: 缺字段时不产出 undefined/NaN 之类的字样', () => {
  assert.equal(currentChannel({ hostType: 'local', runtime: { port: 3080 } }), '127.0.0.1:3080');
  // 缺端口时退化成只有主机名（本机默认 127.0.0.1）
  assert.equal(currentChannel({ hostType: 'local' }), '127.0.0.1');
  assert.doesNotMatch(currentChannel({ hostType: 'remote', host: 'box' }), /undefined|NaN/);
  assert.doesNotMatch(currentChannel({}), /undefined|NaN/);
});

test('add-home 表单：实例字段（homePath/alias/host）逐字段转义', () => {
  const evil = '"><img src=x onerror=alert(1)>';
  for (const html of [
    renderHomeForm(),
    renderSettingsForm({ homeId: 'abcdef1234567890', hostType: 'local', homePath: evil, alias: evil, endpoints: [] }),
    renderSettingsForm({ homeId: 'abcdef1234567890', hostType: 'remote', host: evil, remotePort: 3080, alias: evil, endpoints: [] }),
  ]) {
    assert.doesNotMatch(html, INJECTED_TAG, '表单里出现了真实注入标签');
  }
  assert.match(renderSettingsForm({ homeId: 'abcdef1234567890', hostType: 'local', homePath: evil, endpoints: [] }), /&lt;img/);
});

test('log-panel: 日志条目的每个字段都转义（日志内容含远端 stderr）', async () => {
  const { logPanelHtml, appendLog, clearLogView } = await import('../src/web/components/log-panel.js');
  const evil = '"><img src=x onerror=alert(1)>';
  clearLogView();
  appendLog({ ts: evil, level: 'error', scope: evil, message: evil, fields: { k: evil }, stack: evil });
  const html = logPanelHtml();
  assert.doesNotMatch(html, INJECTED_TAG, '日志面板出现了真实注入标签');
  clearLogView();
});

// 日志去重键原先只看 ts|level|message：同一毫秒里两条同文案、不同上下文的日志（索引器对多个
// 实例并发失败，message 相同、homeId 不同）会被当成重复 → 后一条直接丢掉，失败实例少一个。
test('log-panel: 去重键包含 scope 与 fields，不同上下文的同文案日志不会被吞', async () => {
  const { logEntryKey } = await import('../src/web/components/log-panel.js');
  const base = { ts: '2026-09-12T04:00:00.000', level: 'error', scope: 'indexer', message: '索引该 home 失败' };
  const a = logEntryKey({ ...base, fields: { homeId: 'A' } });
  const b = logEntryKey({ ...base, fields: { homeId: 'B' } });
  assert.notEqual(a, b, '不同 homeId 的两条日志必须有两个不同的键');
  assert.equal(logEntryKey({ ...base, fields: { homeId: 'A' } }), a, '同一条日志重复到达时仍要去重');
  assert.notEqual(a, logEntryKey({ ...base, scope: 'other', fields: { homeId: 'A' } }), 'scope 不同也要区分');
});

// 趋势图的 x 轴原先按「第几个非空桶」定位：空桶被过滤掉之后，23 小时的空白与相邻两小时
// 在图上完全一样（实测：数据只在第 1 与第 24 个桶时，两个点画在 0% 与 100%，曲线还平滑连过去，
// 读者会以为中间是逐步衰减）。修好后：x 按时间插值，跨空桶处断开折线。
test('usage-card: 趋势图按时间定位 x，且跨空桶处断线', async () => {
  const { usageTrendHtml } = await import('../src/web/components/usage-card.js');
  const H = 3_600_000, t0 = Date.parse('2026-09-12T00:00:00.000Z');
  const mk = (i, total) => ({ ts: new Date(t0 + i * H).toISOString(), groups: total ? { '合计': total } : {}, total });
  const buckets = Array.from({ length: 24 }, (_, i) => mk(i, 0));
  // 0 与 1 相邻（同一桶宽），1 与 23 之间隔了 21 个空桶 → 应断成两段
  buckets[0].total = 1000; buckets[0].groups = { '合计': 1000 };
  buckets[1].total = 500; buckets[1].groups = { '合计': 500 };
  buckets[23].total = 300; buckets[23].groups = { '合计': 300 };
  const usage = { trendBy: { total: { buckets, hours: 24, stepMs: H } } };
  const html = usageTrendHtml(usage, 'total');

  const lefts = [...html.matchAll(/class="trend-dot" style="left:([\d.]+)%/g)].map((m) => Number(m[1]));
  assert.equal(lefts.length, 3, `应有 3 个数据点，实际 ${lefts.length}`);
  // 第 2 个桶（1/23 ≈ 4.3%）不该被画在中间（按序号会是 50%，那样 21 小时空白就被压缩掉了）
  assert.ok(Math.abs(lefts[0] - 0) < 0.01, `第一个点应在 0%，实际 ${lefts[0]}`);
  assert.ok(Math.abs(lefts[1] - (1 / 23) * 100) < 1, `第 2 小时的桶应画在约 4.3%，实际 ${lefts[1]}`);
  assert.ok(Math.abs(lefts[2] - 100) < 0.01, `最后一个点应在 100%，实际 ${lefts[2]}`);
  // 0→1h 相邻（同一个桶宽内），1h→23h 跨了 21 个空桶 → 必须断成两条路径
  const paths = (html.match(/<path /g) || []).length;
  assert.equal(paths, 2, `跨空桶应断开折线（应为 2 条 path），实际 ${paths}`);
});

// 「空状态」曾经是一个死胡同：renderUsageCard 在 summary.sessionCount === 0 时直接 return 一句
// 「暂无 token 用量数据」，而统计周期按钮（24h/3天/…/30天）在早退之后的代码里 ——
// 于是默认 24h 窗口内没有数据、更早有数据的用户：卡片说没数据，页面上一个周期按钮都没有，
// 唯一能放宽窗口的入口点不到。独立审查用真浏览器复现：`#usage-period-toggle button` 数量为 0，
// 而同一个 API 用 ?days=30 返回 5 个活跃会话 —— 不是没数据，是这个窗口里没有数据。
test('renderUsageCard: 空窗口也必须给出周期切换按钮（否则用户永远放宽不了窗口）', async () => {
  const { renderUsageCard } = await import('../src/web/components/usage-card.js');
  const empty = { summary: { sessionCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, cacheHitRate: 0, days: 1 },
    trendBy: { total: { hours: 24, stepMs: 900_000, buckets: [] } } };
  const html = renderUsageCard(empty, 'total', '24h');
  for (const key of ['24h', '3d', '7d', '14d', '30d']) {
    assert.match(html, new RegExp(`data-action="usage-period" data-period="${key}"`), `空状态也要有 ${key} 按钮`);
  }
  assert.match(html, /id="usage-period-toggle"/);
  assert.match(html, /这个窗口/, '文案应说明「这个窗口内没有数据」，而不是「没有数据」');
  // 完全没有 usage 时也不能抛
  const bare = renderUsageCard(null, 'total', '7d');
  assert.match(bare, /data-period="30d"/);
});

// x 轴标签曾经是 n 个 flex:1 的等分单元格，而散点按时间定位 —— 有空桶时两者必然错位。
// 独立审查用真浏览器实测（30 天周期、60 桶里 5 个非空）：标签中心 9.9/29.9/50.0/70.1/90.1%，
// 对应的散点却在 72.9/86.4/96.6/98.3/100.0% —— 所有数据都堆在最后一个标签底下，读者会看错日期。
test('usage-card: x 轴标签与散点用同一个定位函数（不随空桶错位）', async () => {
  const { usageTrendHtml } = await import('../src/web/components/usage-card.js');
  const H = 3_600_000, t0 = Date.parse('2026-09-01T00:00:00.000Z');
  const mk = (i, total) => ({ ts: new Date(t0 + i * H).toISOString(), groups: total ? { '合计': total } : {}, total });
  // 稀疏窗口：60 个桶里只有**末尾** 5 个有数据（等价于审查实测的「30 天窗口、最近几小时才有数据」）
  const buckets = Array.from({ length: 60 }, (_, i) => mk(i, 0));
  for (const i of [55, 56, 57, 58, 59]) buckets[i] = mk(i, 100 + i);
  const html = usageTrendHtml({ trendBy: { total: { buckets, hours: 24, stepMs: H } } }, 'total');

  const dotLefts = [...html.matchAll(/class="trend-dot" style="left:([\d.]+)%/g)].map((m) => Number(m[1]));
  const labelLefts = [...html.matchAll(/class="trend-xlabel[^"]*" style="left:([\d.]+)%"/g)].map((m) => Number(m[1]));
  assert.equal(dotLefts.length, 5);
  assert.ok(labelLefts.length >= 2, `应至少渲染 2 个标签，实际 ${labelLefts.length}`);
  // 每个标签的 left 必须是某个散点的 left（同一个 pxAt），而不是等分位置
  for (const l of labelLefts) {
    assert.ok(dotLefts.some((d) => Math.abs(d - l) < 0.01), `标签 ${l}% 必须落在某个数据点上，散点在 ${dotLefts.join('/')}%`);
  }
  // 等分位置（i/(n-1)）不该再出现：数据都在末尾，第一个标签就应该在 93% 附近，而不是 0%
  assert.ok(labelLefts[0] > 90, `稀疏窗口下第一个标签应贴近真实数据位置，实际 ${labelLefts[0]}%`);
  assert.doesNotMatch(html, /trend-xcell/, '等分单元格已废弃');
});

// 按维度拆分时，绝大多数「分组 × 桶」都是 0：画出来是一排 8px 圆点全叠在 0% 基线上，
// 且同一位置有多个不同 tooltip。独立审查实测 24h + 按项目：12 个点里 8 个 data-tok="0"。
test('usage-card: 拆维度时不再为 0 值画散点（避免基线上一堆重叠圆点）', async () => {
  const { usageTrendHtml } = await import('../src/web/components/usage-card.js');
  const H = 3_600_000, t0 = Date.parse('2026-09-12T00:00:00.000Z');
  const buckets = Array.from({ length: 6 }, (_, i) => ({
    ts: new Date(t0 + i * H).toISOString(),
    groups: i < 2 ? { projA: 1000, projB: 0 } : { projA: 0, projB: 0 },
    total: i < 2 ? 1000 : 0,
  }));
  const html = usageTrendHtml({ trendBy: { project: { buckets, hours: 24, stepMs: H } } }, 'project');
  const toks = [...html.matchAll(/class="trend-dot"[^>]*data-tok="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(toks.length > 0);
  assert.ok(!toks.includes('0'), `不该有 0 值的散点，实际 ${toks.join(',')}`);
  // 非 0 的点仍在
  assert.equal(toks.length, 2, `只有两个非零点，实际 ${toks.length}`);
});

// 用量卡高亮哪个周期，必须由**屏上数据所属的周期**决定，而不是用户刚点的那个：
// 点「30 天」→ 请求失败 → handleAction 的 catch 会 alert 后 refresh()，而 refresh 渲染时若用
// `usagePeriod.key`（用户刚点的）配 `lastUsage`（上一个周期的数据），卡片就变成
// 「30 天高亮 + 24 小时的数字」—— 读者无法察觉自己看的是哪个窗口。
// app.js 需要整套 DOM 才能 import，所以这里做源码级一致性断言（同 docs-consistency 的做法）。
test('app.js: 用量卡的高亮周期取自屏上数据（lastUsageKey），不是用户刚点的周期', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/web/app.js', import.meta.url), 'utf8');
  assert.match(src, /let lastUsageKey = null/, '需要单独记录「屏上数据属于哪个周期」');
  assert.match(src, /lastUsageKey = key;/, '成功拉到某个周期的数据后要更新它');
  assert.match(src, /renderUsageCard\(usage, usageDim, lastUsageKey\)/);
  assert.match(src, /renderUsageCard\(usage, usageDim, lastUsageKey \?\? usagePeriod\.key\)/);
  assert.doesNotMatch(src, /renderUsageCard\(usage, usageDim, usagePeriod\.key\)/,
    '不得用「用户刚点的周期」去高亮旧数据');
});
