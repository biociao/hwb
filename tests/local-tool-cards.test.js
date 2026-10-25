import { test } from 'node:test';
import assert from 'node:assert/strict';

// 本地工具实例的统一卡片契约（docs/local-tool-harness-alignment.md §2/§3）。
//
// Codex / WorkBuddy / 本地 dsh 只读 是同一类实例：只读本地元数据，没有进程 / 端口 / token /
// 隧道 / Web 页面。它们必须渲染**同一段模板**，否则用户又要用两套心智去读同一张列表：
//
//   name（alias || serverId || homePath）
//     chips: [<label> <version>](chip harness-<id>) [已就绪|路径缺失] [⚠ 域降级]…
//     meta:  N projects  M sessions  索引 <timeAgo(lastIndexedAt) | 尚未索引>
//     actions: [打开 <label>](primary, local-tool-open) [重新索引] [⚙ 设置]
//
// 这里钉住三件事：
//   1. 三种工具的输出骨架完全一致（把 label/version/计数/id 归一化后逐字相等）；
//   2. 「只读」是类型说明，只进身份 chip 的 title，绝不占状态位；
//   3. 版本/时间/动作的口径只有一套，且所有不可信文本（alias/path/label/version）都转义。
//
// 后端契约：GET /api/homes 的 runtime 提供 toolLabel / toolVersion（toolVersion 可能为 null）。
// 若后端尚未升级，fixture 里也放 dshVersion 验证兼容回退 —— 但 Codex/WorkBuddy 绝不回退到
// dshVersion（那正是「Codex 卡显示 dsh 版本」的老 bug）。

globalThis.document = { documentElement: { dataset: { theme: 'light' } } };
globalThis.window = { matchMedia: () => ({ matches: false }) };

const { renderInstanceGrid } = await import('../src/web/components/instance-grid.js');
const {
  renderHomeForm, renderSettingsForm, applyHomeMode, renderOnboarding,
} = await import('../src/web/components/add-home.js');
const {
  isLocalToolHome, localToolLabel, localToolKind, localToolDefaultHome, localToolHomePlaceholder,
  localToolVersion, dshVersionOf,
} = await import('../src/web/store.js');
const { tabHomes } = await import('../src/web/instance-state.js');

const EVIL = '"><img src=x onerror=alert(1)>';
const INJECTED_TAG = /<(?:img|script|svg|iframe|object|embed|body|style|link)\b/i;

const TOOLS = [
  {
    kind: 'codex',
    label: 'Codex',
    version: '0.153.4',
    home: {
      harness: 'codex', homeId: 'c0de000000000001', hostType: 'local', homePath: '/Users/me/.codex',
      alias: 'Codex 本机', lastIndexedAt: new Date().toISOString(),
      workspaceCount: 51, sessionCount: 409, degraded: [], endpoints: [],
      runtime: { runtime: 'running', checkedAt: new Date().toISOString(), toolLabel: 'Codex', toolVersion: '0.153.4' },
    },
  },
  {
    kind: 'workbuddy',
    label: 'WorkBuddy',
    version: '5.8.3',
    home: {
      harness: 'workbuddy', homeId: 'c0de000000000002', hostType: 'local', homePath: '/Users/me/.workbuddy',
      alias: 'WorkBuddy 本机', lastIndexedAt: new Date().toISOString(),
      workspaceCount: 4, sessionCount: 17, degraded: [], endpoints: [],
      runtime: { runtime: 'running', checkedAt: null, toolLabel: 'WorkBuddy', toolVersion: '5.8.3' },
    },
  },
  {
    kind: 'dsh',
    label: 'dsh',
    version: '0.2.0-rc.2',
    home: {
      harness: 'dsh', readOnly: true, homeId: 'c0de000000000003', hostType: 'local', homePath: '/Users/me/.dsh',
      alias: 'dsh 只读', lastIndexedAt: new Date().toISOString(),
      workspaceCount: 3, sessionCount: 12, degraded: [], endpoints: [],
      runtime: { runtime: 'running', checkedAt: null, toolLabel: 'dsh', toolVersion: '0.2.0-rc.2', dshVersion: '0.2.0-rc.2' },
    },
  },
];

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const oneRow = (home) => renderInstanceGrid([home]);

function identityText(html) {
  const m = /class="chip harness-(?:codex|workbuddy|dsh)"[^>]*>([^<]*)</.exec(html);
  assert.ok(m, '应有一个身份 chip（chip harness-<id>）');
  return m[1];
}

// 把「会随实例/时间变化」的片段归一化，剩下的结构必须逐字相等 —— 这是「同一模板」的硬证据。
function skeleton(html) {
  return html
    .replace(/<span class="name">[^<]*<\/span>/, '<span class="name">NAME</span>')
    .replace(/<span class="chip harness-(?:codex|workbuddy|dsh)" title="[^"]*">[^<]*<\/span>/, '<span class="chip harness-KIND" title="TITLE">IDENTITY</span>')
    .replace(/<span>\d+ projects<\/span>/, '<span>N projects</span>')
    .replace(/<span>\d+ sessions<\/span>/, '<span>M sessions</span>')
    .replace(/<span>索引 [^<]*<\/span>/, '<span>索引 TIME</span>')
    .replace(/data-home-id="[^"]*"/g, 'data-home-id="ID"')
    .replace(/打开 (?:Codex|WorkBuddy|dsh)<\/button>/, '打开 TOOL</button>');
}

// ── 同一模板 ─────────────────────────────────────────────────────────
test('三种本地工具渲染同一段卡片模板（归一化后逐字相等）', () => {
  const [codex, workbuddy, dsh] = TOOLS;
  const base = skeleton(oneRow(codex.home));
  assert.equal(skeleton(oneRow(workbuddy.home)), base, 'WorkBuddy 卡必须与 Codex 卡同一模板');
  assert.equal(skeleton(oneRow(dsh.home)), base, 'dsh 只读卡必须与 Codex 卡同一模板');
});

test('身份 chip 文本 = `<label> <version>`（Codex 0.153.4 / WorkBuddy 5.8.3 / dsh 0.2.0-rc.2）', () => {
  for (const { kind, label, version, home } of TOOLS) {
    const html = oneRow(home);
    assert.match(html, new RegExp(`class="chip harness-${kind}"`), `${label} 的身份 chip class 用 harness 白名单`);
    assert.equal(identityText(html), `${label} ${version}`, `${label} 版本 chip 的文本口径`);
    // 身份说明（「只读」+ 版本）只放在 title 里
    assert.match(html, new RegExp(`title="只读接入的 ${escapeRe(label)} 本地实例（版本 ${escapeRe(version)}）"`));
    // 不再额外画第二枚「版本 chip」（旧 dsh 只读卡是 `chip ver` + 状态位写「只读」）
    assert.doesNotMatch(html, /class="chip ver"/, '本地工具不要第二枚版本 chip');
  }
});

test('版本缺失时只显示 label，不画占位符、不留半截文案', () => {
  for (const { kind, label, home } of TOOLS) {
    const runtime = { runtime: 'running' }; // toolVersion 缺失（dsh 连 dshVersion 也缺失）
    const html = oneRow({ ...home, runtime });
    assert.equal(identityText(html), label, `缺版本时 ${label} 只显示 label`);
    assert.doesNotMatch(html, /chip ver/);
    assert.doesNotMatch(html, new RegExp(`${escapeRe(label)}\\s*(?:—|-|未知)`), '不能画占位符/未知');
    assert.match(html, new RegExp(`title="只读接入的 ${escapeRe(label)} 本地实例（版本 未知）"`),
      'title 里明确说版本未知，而不是让 chip 变成半截文案');
    assert.match(html, new RegExp(`class="chip harness-${kind}"`), '缺版本不影响身份 chip');
  }
});

test('Codex/WorkBuddy 不回退到 runtime.dshVersion（老 bug：Codex 卡显示 dsh 版本）', () => {
  for (const { kind, label, home } of TOOLS.filter((t) => t.kind !== 'dsh')) {
    const html = oneRow({ ...home, runtime: { runtime: 'running', dshVersion: '0.2.0-rc.2' } });
    assert.equal(identityText(html), label, `${label} 不该显示 dsh 的版本号`);
    assert.doesNotMatch(html, /0\.2\.0-rc\.2/);
    assert.match(html, new RegExp(`class="chip harness-${kind}"`));
  }
  // dsh 只读的版本号历史上由 runtime.dshVersion 承载：老后端仍能显示（兼容回退）。
  const dsh = TOOLS[2].home;
  assert.equal(identityText(oneRow({ ...dsh, runtime: { runtime: 'running', dshVersion: '0.1.5-rc.1' } })), 'dsh 0.1.5-rc.1');
});

// ── 状态：只有 已就绪 / 路径缺失 ─────────────────────────────────────
test('状态位只有「已就绪 / 路径缺失」；running 判定与索引成败无关', () => {
  for (const { home } of TOOLS) {
    const ready = oneRow(home);
    assert.match(ready, /class="chip ok">已就绪</);
    assert.doesNotMatch(ready, /路径缺失/);

    for (const runtime of [{ runtime: 'stopped' }, { runtime: 'gone' }, {}]) {
      const missing = oneRow({ ...home, runtime });
      assert.match(missing, /class="chip bad">路径缺失</, `runtime=${JSON.stringify(runtime)} 应为路径缺失`);
      assert.doesNotMatch(missing, /已就绪/);
    }
    // 索引降级不影响「已就绪」这一位（降级走 ⚠ 域降级 chip）
    const degraded = oneRow({ ...home, degraded: [{ domain: 'workbuddy', error: 'db locked', degraded: true }] });
    assert.match(degraded, /class="chip ok">已就绪</);
    assert.match(degraded, /workbuddy 降级/);
  }
});

test('「只读」只出现在 title 里，绝不占状态位', () => {
  for (const { home } of TOOLS) {
    const html = oneRow(home);
    assert.match(html, /title="只读接入的 /, '类型说明放 title');
    assert.doesNotMatch(html, /class="chip [^"]*">只读</, '「只读」不是状态');
    assert.doesNotMatch(html, />只读<[^/]/, '状态 chip 文本不能是「只读」');
  }
});

// ── 时间口径：只用 lastIndexedAt ────────────────────────────────────
test('索引时间只有一套口径：lastIndexedAt → 索引 <timeAgo>；没索引过 → 尚未索引', () => {
  const recent = new Date().toISOString();
  for (const { home } of TOOLS) {
    const html = oneRow({ ...home, lastIndexedAt: recent });
    assert.match(html, /<span>索引 just now<\/span>/, '索引时间取 lastIndexedAt');
    assert.doesNotMatch(html, /检查 /, '本地工具不再用 runtime.checkedAt（心跳口径）');
  }
  // 有 checkedAt 但没有 lastIndexedAt：仍然是「尚未索引」，不能拿心跳冒充索引时间
  for (const { home } of TOOLS) {
    const html = oneRow({ ...home, lastIndexedAt: null, runtime: { ...home.runtime, checkedAt: new Date().toISOString() } });
    assert.match(html, /<span>尚未索引<\/span>/);
    assert.doesNotMatch(html, /索引 —|检查 /);
  }
  // 旧数据里可能是毫秒数/空串：不崩、不画怪值
  for (const lastIndexedAt of [0, '', undefined, null]) {
    const html = oneRow({ ...TOOLS[2].home, lastIndexedAt });
    assert.match(html, /尚未索引/, `lastIndexedAt=${JSON.stringify(lastIndexedAt)} 视为未索引`);
  }
});

// ── 动作：打开 <label>（primary）+ 重新索引 + ⚙ 设置，顺序一致 ──────
test('动作统一为 打开 <label>(primary, local-tool-open) → 重新索引 → ⚙ 设置', () => {
  for (const { label, home } of TOOLS) {
    const html = oneRow(home);
    assert.match(html, new RegExp(`class="primary" data-action="local-tool-open" data-home-id="[^"]+">打开 ${escapeRe(label)}</`));
    assert.match(html, /data-action="reindex"[^>]*>重新索引</);
    assert.match(html, /data-action="settings"[^>]*>⚙ 设置</);
    // 「打开」是 primary，且动作顺序固定
    const iOpen = html.indexOf('local-tool-open');
    const iReindex = html.indexOf('data-action="reindex"');
    const iSettings = html.indexOf('data-action="settings"');
    assert.ok(iOpen > 0 && iReindex > iOpen && iSettings > iReindex, '动作顺序：打开 → 重新索引 → 设置');
    // 本地工具没有连接/通道/重启/停止这些「有进程」才说得通的动作
    assert.doesNotMatch(html, /data-action="(connect|disconnect|choose-channel|restart|stop|codex-open-home)"/);
    assert.doesNotMatch(html, /当前通道|响应 \d+ ?ms/);
  }
});

// ── 转义 ────────────────────────────────────────────────────────────
test('alias / homePath / label / version 全部转义；harness 只接受白名单 class', () => {
  const evil = {
    harness: 'workbuddy', homeId: EVIL, hostType: 'local', homePath: EVIL, alias: EVIL,
    lastIndexedAt: new Date().toISOString(), workspaceCount: 1, sessionCount: 2, degraded: [], endpoints: [],
    runtime: { runtime: 'running', toolLabel: EVIL, toolVersion: EVIL, checkedAt: EVIL },
  };
  const html = oneRow(evil);
  assert.doesNotMatch(html, INJECTED_TAG, '不可信文本必须转义');
  assert.match(html, /&lt;img/, '恶意文本以转义形式可见');
  assert.match(html, /class="chip harness-workbuddy"/, 'identity class 来自 harness 白名单，不拼 label');
  assert.doesNotMatch(html, /harness-&quot;/, 'class 属性不能出现转义后的 label');

  // 未知 harness + readOnly：仍算本地工具（老数据只有 readOnly 标记），但 class 归一到 dsh
  const legacy = oneRow({ harness: EVIL, readOnly: true, homeId: 'x', homePath: '/x', runtime: { runtime: 'running' } });
  assert.doesNotMatch(legacy, INJECTED_TAG);
  assert.match(legacy, /class="chip harness-dsh"/);
  assert.equal(identityText(legacy), 'dsh');
});

// ── 判断入口与描述符集中在 store.js ─────────────────────────────────
test('store：isLocalToolHome 是唯一判定入口，label/home 描述符随之归一', () => {
  assert.equal(isLocalToolHome({ harness: 'codex' }), true);
  assert.equal(isLocalToolHome({ harness: 'workbuddy' }), true);
  assert.equal(isLocalToolHome({ harness: 'WORKBUDDY' }), true, 'harness 归一化后再判定');
  assert.equal(isLocalToolHome({ harness: 'dsh', readOnly: true }), true);
  assert.equal(isLocalToolHome({ harness: 'dsh', readOnly: false }), false, '可连接的 dsh 不是本地工具');
  assert.equal(isLocalToolHome({ harness: 'dsh' }), false);
  assert.equal(isLocalToolHome({ harness: 'claude-code' }), false);
  assert.equal(isLocalToolHome(null), false);

  assert.equal(localToolLabel({ harness: 'codex' }), 'Codex');
  assert.equal(localToolLabel({ harness: 'workbuddy' }), 'WorkBuddy');
  assert.equal(localToolLabel({ harness: 'dsh', readOnly: true }), 'dsh');
  assert.equal(localToolKind({ harness: 'dsh', readOnly: true }), 'dsh');
  assert.equal(localToolDefaultHome('codex'), '~/.codex');
  assert.equal(localToolDefaultHome('workbuddy'), '~/.workbuddy');
  assert.equal(localToolDefaultHome('dsh'), '~/.dsh');
  assert.equal(localToolHomePlaceholder('workbuddy'), '~/.workbuddy');
  assert.equal(localToolVersion({ harness: 'workbuddy', runtime: { toolVersion: '5.8.3' } }), '5.8.3');
  assert.equal(localToolVersion({ harness: 'workbuddy', runtime: { dshVersion: '0.2.0-rc.2' } }), null);
  assert.equal(localToolVersion({ harness: 'dsh', runtime: { dshVersion: '0.2.0-rc.2' } }), '0.2.0-rc.2');
  assert.equal(localToolVersion({ harness: 'codex', runtime: { toolVersion: '  ' } }), null);
  assert.equal(dshVersionOf({ runtime: { toolVersion: '0.2.1', dshVersion: '0.1.5' } }), '0.2.1');
  assert.equal(dshVersionOf({ runtime: { dshVersion: '0.1.5' } }), '0.1.5', '老后端只有 dshVersion');
  assert.equal(dshVersionOf({ runtime: {} }), null);
});

test('tabHomes：三种本地工具都没有 Web 页面，不能开 iframe / 标签页', () => {
  const connectable = {
    harness: 'dsh', homeId: 'conn000000000001', hostType: 'local', homePath: '/Users/me/.dsh',
    endpoints: [], runtime: { runtime: 'running' },
  };
  const homes = [...TOOLS.map((t) => t.home), connectable];
  const tabs = tabHomes(homes);
  assert.deepEqual(tabs.map((h) => h.homeId), [connectable.homeId], '只保留可连接的 dsh 实例');
});

// ── 普通可连接 dsh 卡保持原样 ───────────────────────────────────────
test('可连接 dsh 卡不变：已连接/连接不可达/未连接、版本 chip、检查时间', () => {
  const base = {
    harness: 'dsh', homeId: 'aaaaaaaaaaaaaaaa', hostType: 'remote', host: 'cms.lo', remotePort: 3080,
    homePath: '/home/u/.dsh', workspaceCount: 2, sessionCount: 3, endpoints: [], degraded: [],
  };
  const running = renderInstanceGrid([{ ...base, runtime: { runtime: 'running', latencyMs: 12, checkedAt: null, dshVersion: '0.1.5-rc.1' } }]);
  assert.match(running, /class="chip ver"[^>]*>dsh 0\.1\.5-rc\.1<\//, 'dshVersion 兼容回退');
  assert.match(running, /已连接/);
  assert.match(running, /当前通道：cms\.lo:3080/);
  assert.match(running, /检查 —/);
  assert.match(running, /data-action="disconnect"/);
  assert.doesNotMatch(running, /harness-dsh|local-tool-open|已就绪/);

  // 新后端：归一化后的 runtime.toolVersion 优先
  const withToolVersion = renderInstanceGrid([{ ...base, runtime: { runtime: 'running', toolVersion: '0.2.1' } }]);
  assert.match(withToolVersion, /dsh 0\.2\.1/);

  assert.match(renderInstanceGrid([{ ...base, runtime: { runtime: 'unreachable' } }]), /连接不可达/);
  assert.match(renderInstanceGrid([{ ...base, runtime: { runtime: 'stopped' } }]), /class="primary" data-action="connect"/);
});

// ── 添加表单：类型下拉 / 模式同构 / 设置面 ─────────────────────────
function fakeForm() {
  const names = ['homePath', 'host', 'remotePort', 'remoteHome', 'remoteCmd', 'remoteLog', 'token', 'localPort', 'accessPort'];
  const form = { mode: { value: 'local' } };
  for (const name of names) form[name] = { hidden: false, disabled: false, required: false, placeholder: '', value: '' };
  return form;
}

test('renderHomeForm：类型下拉含 WorkBuddy（只读），与 Codex 并列', () => {
  const html = renderHomeForm();
  assert.match(html, /<option value="codex">Codex（只读）<\/option>/);
  assert.match(html, /<option value="workbuddy">WorkBuddy（只读）<\/option>/);
  assert.match(html, /name="mode"/);
});

test('applyHomeMode：codex / workbuddy 同构（只留 homePath，默认值按工具），切模式不残留假路径', () => {
  const codex = fakeForm();
  applyHomeMode(codex, 'codex');
  const workbuddy = fakeForm();
  assert.equal(applyHomeMode(workbuddy, 'workbuddy'), 'workbuddy');

  const fields = ['homePath', 'host', 'remotePort', 'remoteHome', 'remoteCmd', 'remoteLog', 'token', 'localPort', 'accessPort'];
  for (const name of fields) {
    assert.equal(workbuddy[name].hidden, codex[name].hidden, `${name} 的显隐必须与 Codex 同构`);
    assert.equal(workbuddy[name].required, codex[name].required, `${name} 的必填必须与 Codex 同构`);
  }
  assert.equal(workbuddy.homePath.hidden, false);
  assert.equal(workbuddy.homePath.required, true);
  assert.equal(workbuddy.homePath.placeholder, '~/.workbuddy');
  assert.equal(workbuddy.homePath.value, '~/.workbuddy', 'WorkBuddy 默认 ~/.workbuddy');
  assert.equal(codex.homePath.value, '~/.codex');
  for (const name of ['host', 'remotePort', 'remoteHome', 'remoteCmd', 'remoteLog', 'accessPort', 'localPort', 'token']) {
    assert.equal(workbuddy[name].hidden, true, `${name} 在 WorkBuddy 模式下隐藏（不连接进程）`);
  }

  // workbuddy → codex：清掉旧默认值并补上新默认值（不留一个「看起来是路径的默认值」）
  applyHomeMode(workbuddy, 'codex');
  assert.equal(workbuddy.homePath.value, '~/.codex');
  // → 本机 dsh：清掉工具默认值，token/localPort 重新可见
  applyHomeMode(workbuddy, 'local');
  assert.equal(workbuddy.homePath.value, '');
  assert.equal(workbuddy.token.hidden, false);
  assert.equal(workbuddy.localPort.hidden, false);
  assert.equal(workbuddy.homePath.placeholder, 'dsh home 路径，如 ~/.dsh');
});

test('renderSettingsForm(workbuddy)：只有 alias + homePath + 只读说明', () => {
  const html = renderSettingsForm({ ...TOOLS[1].home });
  assert.match(html, /data-harness="workbuddy"/);
  assert.match(html, /name="alias"/);
  assert.match(html, /name="homePath"/);
  assert.match(html, /只读读取 workbuddy\.db/);
  assert.doesNotMatch(html, /name="(host|remotePort|remoteHome|remoteCmd|remoteLog|accessPort|localPort|token)"/);
  assert.doesNotMatch(html, /class="endpoint-editor"|选择连接端点|data-action="switch-endpoint"/);
});

// ── 检测入口：onboarding 与添加表单 ─────────────────────────────────
test('renderOnboarding：检测到 ~/.workbuddy 时给出 WorkBuddy 只读接入入口', () => {
  const html = renderOnboarding({
    path: '/Users/me/.dsh', exists: true, looksLikeDshHome: true,
    workbuddy: { path: '/Users/me/.workbuddy', exists: true, looksLikeWorkbuddy: true },
  });
  assert.match(html, /data-action="add-detected" data-path="\/Users\/me\/\.workbuddy" data-harness="workbuddy"/);
  assert.match(html, /（WorkBuddy）/);
  assert.match(html, /不连接任何进程/);

  const none = renderOnboarding({
    path: '/Users/me/.dsh', exists: false,
    workbuddy: { path: '/Users/me/.workbuddy', exists: false },
  });
  assert.doesNotMatch(none, /data-harness="workbuddy"/);

  const shaky = renderOnboarding({
    path: '/Users/me/.dsh', exists: true, looksLikeDshHome: true,
    workbuddy: { path: '/Users/me/.workbuddy', exists: true, looksLikeWorkbuddy: false },
  });
  assert.match(shaky, /该目录缺少 workbuddy\.db/, '不像 WorkBuddy home 时提示会降级');
});

test('renderHomeForm(detected)：顶部可直达检测到的 WorkBuddy；检测路径转义', () => {
  const html = renderHomeForm({ workbuddy: { path: '/Users/me/.workbuddy', exists: true } });
  assert.match(html, /检测到本机 WorkBuddy home/);
  assert.match(html, /data-action="add-detected"[^>]*data-harness="workbuddy"/);

  const evil = renderHomeForm({ workbuddy: { path: EVIL, exists: true } });
  assert.doesNotMatch(evil, INJECTED_TAG);
  assert.match(evil, /&lt;img/);
});

// ── index.html：身份 chip 用项目色，不用状态色 ──────────────────────
test('index.html：harness-workbuddy / harness-dsh 用项目色（不是 ok/warn/bad 状态色）', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('../src/web/index.html', import.meta.url), 'utf8');
  for (const kind of ['codex', 'workbuddy', 'dsh']) {
    // 同一声明块可能把三种 chip 合并写（公共部分），取「带 background」的那条规则
    const rules = [...css.matchAll(new RegExp(`\\.chip\\.harness-${kind} \\{([^}]*)\\}`, 'g'))].map((m) => m[1]);
    assert.ok(rules.length, `缺少 .chip.harness-${kind} 样式`);
    const withBg = rules.find((r) => /background:/.test(r));
    assert.ok(withBg, `${kind} 缺少项目色底`);
    assert.match(withBg, new RegExp(`background: var\\(--src-${kind}\\)`), `${kind} 用项目色底`);
    for (const rule of rules) {
      assert.doesNotMatch(rule, /var\(--(ok|warn|bad)\)/, `${kind} 不能用状态色（那是「已就绪/路径缺失」的语义）`);
    }
  }
});
