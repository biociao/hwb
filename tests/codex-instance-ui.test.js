import { test } from 'node:test';
import assert from 'node:assert/strict';

// 「Codex 作为实例」的 UI 契约测试。
//
// 用户纠正了产品设计：Codex 不再是独立面板，而是和 dsh 同构的一种 harness 实例 ——
//   - 添加：INSTANCES 的「＋ 添加」表单里选 Codex（只读），或 onboarding 里的检测按钮；
//   - 展示：INSTANCES 里一张 Codex 卡（已就绪 / 路径缺失、打开 Codex / 重新索引 / 设置）；
//   - 汇总：Codex 的项目/会话混进 RECENT PROJECTS / RECENT SESSIONS，靠实例 chip 区分；
//   - 点击：drill-in 带 data-session-id（thread）与 data-workspace-id（project），
//     实例卡「打开 Codex」带 data-action="codex-open-home"，都由 app.js 调 POST /api/codex/open。
//
// 这些属性名是与 app.js 的契约，改错不会让页面崩，只会让点击"没反应"，所以在这里钉住。
// chipColor() 会读 document/window 判断深浅主题；其余组件都是纯字符串拼接。

globalThis.document = { documentElement: { dataset: { theme: 'light' } } };
globalThis.window = { matchMedia: () => ({ matches: false }) };

const { renderHomeForm, renderSettingsForm, applyHomeMode, renderOnboarding } = await import('../src/web/components/add-home.js');
const { renderInstanceGrid } = await import('../src/web/components/instance-grid.js');
const { renderRecentProjects } = await import('../src/web/components/recent-projects.js');
const { renderRecentSessions } = await import('../src/web/components/recent-sessions.js');

const EVIL = '"><img src=x onerror=alert(1)>';
const INJECTED_TAG = /<(?:img|script|svg|iframe|object|embed|body|style|link)\b/i;

function fakeForm() {
  const names = ['homePath', 'host', 'remotePort', 'remoteHome', 'remoteCmd', 'remoteLog', 'token', 'localPort', 'accessPort'];
  const form = { mode: { value: 'local' } };
  for (const name of names) form[name] = { hidden: false, disabled: false, required: false, placeholder: '' };
  return form;
}

const CODEX_HOME = {
  harness: 'codex', homeId: 'cccccccccccccccc', hostType: 'local', homePath: '/Users/test/.codex',
  alias: 'Codex 本机', runtime: { runtime: 'running', checkedAt: new Date().toISOString() },
  workspaceCount: 51, sessionCount: 409, degraded: [], endpoints: [],
};

// ── 添加表单：Codex 模式 ──────────────────────────────────────────────
test('renderHomeForm 的实例类型下拉里有 Codex（只读）', () => {
  const html = renderHomeForm();
  assert.match(html, /<option value="codex">Codex（只读）<\/option>/);
  assert.match(html, /name="mode"/);
});

test('applyHomeMode(codex)：只留 homePath（可见/必填/~/.codex），接入字段全部隐藏', () => {
  const form = fakeForm();
  assert.equal(applyHomeMode(form, 'codex'), 'codex', '返回生效的模式');

  assert.equal(form.homePath.hidden, false);
  assert.equal(form.homePath.required, true, 'Codex 只需要 home 路径');
  assert.equal(form.homePath.placeholder, '~/.codex');

  for (const name of ['host', 'remotePort', 'remoteHome', 'remoteCmd', 'remoteLog', 'accessPort', 'localPort', 'token']) {
    assert.equal(form[name].hidden, true, `${name} 在 Codex 模式下必须隐藏（Codex 不连接进程）`);
  }
  assert.equal(form.accessPort.disabled, true);
  assert.equal(form.host.required, false);
  assert.equal(form.remotePort.required, false);
});

test('applyHomeMode：codex 切回 local/remote 后布局与 placeholder 复原（不污染 dsh）', () => {
  const form = fakeForm();
  applyHomeMode(form, 'codex');
  applyHomeMode(form, 'local');
  assert.equal(form.homePath.hidden, false);
  assert.equal(form.homePath.required, true);
  assert.equal(form.homePath.placeholder, 'dsh home 路径，如 ~/.dsh', '回到本机 dsh 时 placeholder 要复原');
  assert.equal(form.token.hidden, false, '本机 dsh 仍可手填 token');
  assert.equal(form.localPort.hidden, false);

  applyHomeMode(form, 'remote');
  assert.equal(form.host.hidden, false);
  assert.equal(form.host.required, true);
  assert.equal(form.remotePort.required, true);
  assert.equal(form.homePath.hidden, true, '远程模式隐藏本机 homePath');
  assert.equal(form.homePath.required, false);
  assert.equal(form.accessPort.disabled, false);
  assert.equal(form.token.hidden, false, '远程 dsh 仍可手填 token');

  applyHomeMode(form, 'local');
  assert.equal(form.host.hidden, true);
  assert.equal(form.localPort.hidden, false);
});

// ── 设置表单：Codex 只读实例 ──────────────────────────────────────────
test('renderSettingsForm(codex)：只有 alias + homePath + 只读说明，没有端点/端口/token', () => {
  const html = renderSettingsForm({ ...CODEX_HOME, alias: 'Codex 本机' });
  assert.match(html, /data-harness="codex"/);
  assert.match(html, /name="alias"/);
  assert.match(html, /name="homePath"/);
  assert.match(html, /只读读取 state_5\.sqlite 与 \.codex-global-state\.json，不连接任何进程/);
  assert.doesNotMatch(html, /name="(host|remotePort|remoteHome|remoteCmd|remoteLog|accessPort|localPort|token)"/);
  assert.doesNotMatch(html, /class="endpoint-editor"|选择连接端点|data-action="switch-endpoint"/);
});

test('renderSettingsForm(dsh)：远程实例的设置仍保留接入端口与端点编辑（行为不变）', () => {
  const html = renderSettingsForm({
    homePath: 'ssh://cms.lo:3080', hostType: 'remote', host: 'cms.lo', remotePort: 3080,
    accessPort: 55000, endpoints: [{ id: 'cli', host: 'cms.lo', port: 3080 }, { id: 'tun', host: 'cms.tun', port: 3080 }],
  });
  assert.match(html, /name="accessPort"/);
  assert.match(html, /class="endpoint-editor"/);
  assert.match(html, /选择连接端点/);
});

// ── INSTANCES 卡片 ───────────────────────────────────────────────────
test('instance-grid(Codex)：harness chip + 已就绪 + 三个动作，没有连接/通道/版本', () => {
  const html = renderInstanceGrid([CODEX_HOME]);
  assert.match(html, /class="chip harness-codex" title="只读接入的 Codex 本地实例">Codex</);
  assert.match(html, /class="chip ok">已就绪</);
  assert.match(html, /51 projects/);
  assert.match(html, /409 sessions/);
  assert.match(html, /检查 /);
  assert.match(html, /class="primary" data-action="codex-open-home" data-home-id="cccccccccccccccc">打开 Codex</);
  assert.match(html, /data-action="reindex" data-home-id="cccccccccccccccc"/);
  assert.match(html, /data-action="settings" data-home-id="cccccccccccccccc"/);
  // 只读实例没有这些接入概念
  assert.doesNotMatch(html, /data-action="(connect|disconnect|choose-channel)"/);
  assert.doesNotMatch(html, /当前通道|响应 \d* ?ms|dsh 0\./);
});

test('instance-grid(Codex)：路径缺失时状态 chip 为 bad，降级 chip 照常保留且转义', () => {
  const missing = renderInstanceGrid([{ ...CODEX_HOME, runtime: { runtime: 'stopped', checkedAt: null } }]);
  assert.match(missing, /class="chip bad">路径缺失</);
  assert.doesNotMatch(missing, /已就绪/);
  assert.match(missing, /检查 —/);

  const degraded = renderInstanceGrid([{ ...CODEX_HOME, degraded: [{ domain: 'codex-db', error: EVIL, degraded: true }] }]);
  assert.match(degraded, /codex-db 降级/);
  assert.doesNotMatch(degraded, INJECTED_TAG, '降级原因里的 HTML 必须转义');
});

test('instance-grid(dsh)：dsh 卡片行为完全不变', () => {
  const dsh = {
    harness: 'dsh', homeId: 'aaaaaaaaaaaaaaaa', hostType: 'remote', host: 'cms.lo', remotePort: 3080,
    homePath: '/home/u/.dsh', workspaceCount: 2, sessionCount: 3, endpoints: [],
    runtime: { runtime: 'running', latencyMs: 12, checkedAt: null, dshVersion: '0.1.5-rc.1' }, degraded: [],
  };
  const html = renderInstanceGrid([dsh]);
  assert.match(html, /dsh 0\.1\.5-rc\.1/);
  assert.match(html, /已连接/);
  assert.match(html, /当前通道：cms\.lo:3080/);
  assert.match(html, /响应 12 ms/);
  assert.match(html, /data-action="disconnect"/);
  assert.doesNotMatch(html, /harness-codex|codex-open-home/);
});

// ── RECENT PROJECTS ─────────────────────────────────────────────────
test('recent-projects：Codex 行带 data-workspace-id，并用 totalTokens 回退（无 in/out 拆分）', () => {
  const html = renderRecentProjects([
    {
      homeId: 'cccccccccccccccc', workspaceId: 'local-86d51', project: 'PUMCH-isowast',
      sessionId: '01a166b8-9aef-7613-8cb3-6ca933751576', lastActivity: null, sessionCount: 181,
      inputTokens: 0, outputTokens: 0, totalTokens: 716_992_900,
    },
  ], [{ homeId: 'cccccccccccccccc', harness: 'codex', homePath: '/Users/test/.codex', alias: 'Codex 本机' }]);

  assert.match(html, /data-workspace-id="local-86d51"/);
  assert.match(html, /total 717\.0M tokens/);
  assert.match(html, /title="Codex 只提供会话累计 token，无输入\/输出拆分"/);
  assert.doesNotMatch(html, /in 0|out 0/, 'Codex 没有输入/输出拆分，不能渲染成 0');
});

test('recent-projects：dsh 行维持 in/out；项目/workspaceId 文本一律转义', () => {
  const dsh = renderRecentProjects([
    {
      homeId: 'aaaaaaaaaaaaaaaa', workspaceId: 'w1', project: 'proj', sessionId: 's1', lastActivity: null,
      sessionCount: 2, inputTokens: 1500, outputTokens: 300, totalTokens: 0,
    },
  ]);
  assert.match(dsh, /in 1\.5k/);
  assert.match(dsh, /out 300/);
  assert.doesNotMatch(dsh, /total .* tokens/);

  const evil = renderRecentProjects([
    {
      homeId: EVIL, workspaceId: EVIL, project: EVIL, sessionId: EVIL, lastActivity: null,
      sessionCount: 1, inputTokens: 0, outputTokens: 0, totalTokens: 1_000,
    },
  ]);
  assert.doesNotMatch(evil, INJECTED_TAG);
  assert.match(evil, /data-workspace-id="&quot;&gt;&lt;img/);
});

// ── RECENT SESSIONS ─────────────────────────────────────────────────
test('recent-sessions：带 homes 时显示实例 chip（alias 优先，缺省回退 homePath）', () => {
  const homes = [
    { homeId: 'cccccccccccccccc', harness: 'codex', alias: 'Codex 本机', homePath: '/Users/test/.codex' },
    { homeId: 'aaaaaaaaaaaaaaaa', harness: 'dsh', alias: null, homePath: '/Users/test/.dsh' },
  ];
  const html = renderRecentSessions([
    {
      homeId: 'cccccccccccccccc', sessionId: 'thread-1', title: 'Codex 会话', project: 'PUMCH',
      lastActivity: null, status: { kind: 'idle', label: 'Codex' }, tokenUsage: { totalTokens: 100 },
    },
    {
      homeId: 'aaaaaaaaaaaaaaaa', sessionId: 's2', title: 'dsh 会话', project: 'proj',
      lastActivity: null, status: { kind: 'idle', label: '空闲', subagents: 0 },
    },
  ], homes);

  assert.match(html, /class="chip home-chip"[^>]*>Codex 本机</);
  assert.match(html, /class="chip home-chip"[^>]*>\/Users\/test\/\.dsh</);
  assert.match(html, /class="chip status idle"[^>]*>Codex</, 'Codex 会话状态 chip 文本为 Codex');
  assert.match(html, /class="chip proj-chip"/);
});

test('recent-sessions：不传 homes（旧调用）不画实例 chip，其余行为不变', () => {
  const session = {
    homeId: 'aaaaaaaaaaaaaaaa', sessionId: 's1', title: 't', project: 'p', lastActivity: null,
    status: { kind: 'idle', label: '空闲', subagents: 0 },
  };
  const html = renderRecentSessions([session]);
  assert.doesNotMatch(html, /home-chip/);
  assert.match(html, /data-action="drill-in"/);
  assert.match(renderRecentSessions([]), /no sessions indexed yet/);
});

test('recent-sessions：实例 alias 里的 HTML 被转义', () => {
  const html = renderRecentSessions([
    { homeId: 'c', sessionId: 's', title: 't', project: 'p', lastActivity: null, status: { kind: 'idle', label: 'Codex' } },
  ], [{ homeId: 'c', alias: EVIL, homePath: EVIL }]);
  assert.doesNotMatch(html, INJECTED_TAG);
  assert.match(html, /&lt;img/);
});

// ── ONBOARDING：检测到 ~/.codex ──────────────────────────────────────
test('renderOnboarding：检测到 ~/.codex 时多一个 Codex 只读接入按钮（data-harness=codex）', () => {
  const html = renderOnboarding({
    path: '/Users/test/.dsh', exists: true, looksLikeDshHome: true,
    codex: { path: '/Users/test/.codex', exists: true, looksLikeCodexHome: true },
  });
  assert.match(html, /data-action="add-detected" data-path="\/Users\/test\/\.dsh"/);
  assert.match(html, /data-action="add-detected" data-path="\/Users\/test\/\.codex" data-harness="codex"/);
  assert.match(html, /（Codex）/);
  assert.match(html, /不连接任何进程/);
});

test('renderOnboarding：没有 ~/.codex 时不出现 Codex 按钮；looksLike 为假时提示降级', () => {
  const none = renderOnboarding({ path: '/Users/test/.dsh', exists: true, looksLikeDshHome: true, codex: { path: '/x', exists: false } });
  assert.doesNotMatch(none, /data-harness="codex"/);

  const shaky = renderOnboarding({
    path: '/Users/test/.dsh', exists: true, looksLikeDshHome: true,
    codex: { path: '/Users/test/.codex', exists: true, looksLikeCodexHome: false },
  });
  assert.match(shaky, /该目录缺少 state_5\.sqlite 或 \.codex-global-state\.json/);
});

test('onboarding：Codex 检测路径同样转义', () => {
  const html = renderOnboarding({
    path: '/dsh', exists: true, looksLikeDshHome: true,
    codex: { path: EVIL, exists: true, looksLikeCodexHome: true },
  });
  assert.doesNotMatch(html, INJECTED_TAG);
  assert.match(html, /&lt;img/);
});

// 窄列回归：RECENT SESSIONS 的状态列很窄，状态 chip 文本（如「已保存」）曾折成两行「已保/存」，
// 把整行撑高。.chip.status 必须 nowrap —— 这条规则在 index.html 里，没有别的运行时测试会踩到。
test('index.html：会话状态 chip 不折行', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('../src/web/index.html', import.meta.url), 'utf8');
  assert.match(css, /\.chip\.status \{[^}]*white-space:\s*nowrap/,
    '.chip.status 需要 white-space: nowrap（否则窄列里状态标签折成两行）');
});
