export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // 把服务端的 code/status 挂在 Error 上：调用方需要区分「插件没装 → 回退 iframe」
    // 与真正的失败，而不是去解析错误文案（文案会变）。
    const error = new Error(data.error || `${path}: ${res.status}`);
    error.status = res.status;
    error.code = data.code ?? null;
    error.detail = data; // 需要展示安装命令等结构化信息时用（例如 plugin-missing 的 install）
    throw error;
  }
  return data;
}

export function subscribe(cb, onState, onLog) {
  const es = new EventSource('/api/events');
  es.addEventListener('index:updated', () => cb());
  es.addEventListener('instance:status', () => cb());
  es.addEventListener('monitor:updated', () => cb());
  es.addEventListener('quota:updated', () => cb());
  es.addEventListener('log:event', (e) => {
    try { onLog?.(JSON.parse(e.data)); } catch { /* 忽略无法解析的日志事件 */ }
  });
  es.onopen = () => onState?.(true);
  es.onerror = () => onState?.(false);
  return es;
}

// 只接受数值。最后那个分支原先是 `String(n)` —— 只要调用方把一个非数字传进来，
// 它就会原样变成 innerHTML 里的内容（好几个调用点都不转义，因为「这个值就是个数」）。
// 用量数据来自 dsh 元数据经 SQL 聚合，正常情况下必然是数字；但「正常情况下」不该是唯一的防线，
// 这里统一兜住：无法转成有限数就显示占位符，绝不把任意文本透出去。
export function fmtTokens(n) {
  const v = Number(n);
  if (n == null || n === '' || !Number.isFinite(v)) return '—';
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(v);
}

export function timeAgo(iso) {
  if (!iso) return '—';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// 气泡标签配色：按标识（实例 homeId / 项目名）哈希到调色板，
// 保证同一实例、同一项目始终同色，用不同颜色区分不同的 dsh 实例 / projects。
// 低饱和学术色系（石板蓝、苔绿、赭石、绛红、黛紫等），深浅两套随主题切换。
const CHIP_PALETTE_LIGHT = [
  ['#e6eaf2', '#3e5c94'], // slate
  ['#e5ece3', '#4a6b4a'], // moss
  ['#f1e9d8', '#7d6420'], // ochre
  ['#f0e2df', '#8a4438'], // oxblood
  ['#e9e5f0', '#5d4f7d'], // dusk violet
  ['#e0eaeb', '#3c6b6e'], // teal
  ['#f0e5da', '#8a5a2e'], // clay
  ['#e2eae6', '#2f6050'], // pine
  ['#ece2e8', '#7a4660'], // plum
  ['#e3e7ea', '#4a5a68'], // steel
  ['#e9ead9', '#6a6d2a'], // olive
  ['#efe0e0', '#8a3f4a'], // wine
];

const CHIP_PALETTE_DARK = [
  ['#252c3a', '#9db1d4'], // slate
  ['#26302a', '#9cba9c'], // moss
  ['#33301f', '#c9b06a'], // ochre
  ['#332825', '#cf9a8e'], // oxblood
  ['#2b2836', '#b3a7d0'], // dusk violet
  ['#222f31', '#8cb5b8'], // teal
  ['#332c22', '#cda678'], // clay
  ['#232f2b', '#8cb5a4'], // pine
  ['#312832', '#c9a3b8'], // plum
  ['#262b31', '#a4b2bd'], // steel
  ['#2d2e20', '#bcbf7d'], // olive
  ['#33262a', '#d09aa6'], // wine
];

function isDarkTheme() {
  const t = document.documentElement.dataset.theme;
  if (t === 'dark') return true;
  if (t === 'light') return false;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

// —— 数据来源 app（实例的 harness）——
// Projects 栏的项目卡用**来源底色**区分「这条项目来自哪个 app」（dsh 蓝 / Codex 灰 /
// Claude Code 橙 / WorkBuddy 绿 / 其它紫）。颜色写在 index.html 的 CSS 变量里，这里只做
// 「harness → 稳定标识」的归一化：
//   · 返回白名单里的固定值，它会作为 data-source 属性进入 HTML —— 未知/恶意 harness
//     一律归到 'other'，不可能把任意文本带进属性（也就不需要转义兜底）；
//   · 别名归一化（claude / claude-code / claudecode 同色），未来新增来源在这里加一行。
const SOURCE_KINDS = new Map([
  ['dsh', 'dsh'],
  ['deepseek-harness', 'dsh'],
  ['deepseek', 'dsh'],
  ['codex', 'codex'],
  ['openai-codex', 'codex'],
  ['chatgpt', 'codex'],
  ['claude-code', 'claude-code'],
  ['claudecode', 'claude-code'],
  ['claude', 'claude-code'],
  ['anthropic', 'claude-code'],
  ['workbuddy', 'workbuddy'],
  ['work-buddy', 'workbuddy'],
]);

const SOURCE_LABELS = {
  dsh: 'dsh',
  codex: 'Codex',
  'claude-code': 'Claude Code',
  workbuddy: 'WorkBuddy',
  other: '未识别',
};

// harness 是数据库字段（注册时已限制为 dsh/codex/workbuddy），但老库/未来版本可能带来新值，
// 所以这里仍按「不可信输入」处理：只做归一化，不做透传。
export function sourceKind(harness) {
  const key = String(harness ?? '').trim().toLowerCase().replace(/[_\s]+/g, '-');
  return SOURCE_KINDS.get(key) ?? 'other';
}

// —— 本地工具实例（Codex / WorkBuddy / 本地 dsh 只读）——
//
// 这一类实例的共同点：**只读本地元数据**，没有进程 / 端口 / token / 隧道，也没有 Web 页面。
// 判定只允许存在于这一处（契约 docs/local-tool-harness-alignment.md §2）；组件、instance-state、
// app.js 都必须调用 isLocalToolHome()，不要再各自写 `harness === 'codex'` 之类的分支。
//
// 展示口径也集中在这里：
//   · 身份 chip 文本 = `<label> <version>`，版本取不到就只显示 label（不画占位符）；
//   · 「只读」是这类实例的**类型说明**，只进 chip 的 title，不占状态位；
//   · 状态只有「已就绪 / 路径缺失」，索引时间只用 lastIndexedAt。
const LOCAL_TOOL_KINDS = {
  codex: { label: 'Codex', home: '~/.codex' },
  workbuddy: { label: 'WorkBuddy', home: '~/.workbuddy' },
  dsh: { label: 'dsh', home: '~/.dsh' },
};

export function localToolKind(home) {
  const harness = sourceKind(home?.harness);
  if (harness === 'codex' || harness === 'workbuddy') return harness;
  return 'dsh'; // dsh 只读；也兜住「只带 readOnly 标记」的老数据
}

export function isLocalToolHome(home) {
  if (!home) return false;
  if (home.readOnly === true) return true;
  const harness = sourceKind(home.harness);
  return harness === 'codex' || harness === 'workbuddy';
}

// 卡片 / 按钮上的工具名：Codex | WorkBuddy | dsh（dsh 用小写，与版本 chip 的既有写法一致）。
export function localToolLabel(home) {
  return LOCAL_TOOL_KINDS[localToolKind(home)].label;
}

// 该 harness 的默认 home（添加表单的默认值；后端也持有一份，见契约 §5）。
export function localToolDefaultHome(harness) {
  return LOCAL_TOOL_KINDS[sourceKind(harness) === 'other' ? 'dsh' : sourceKind(harness)].home;
}

// 添加/设置表单里 homePath 输入框的占位提示。
export function localToolHomePlaceholder(harness) {
  return localToolDefaultHome(harness);
}

// 版本字面量：优先用服务端归一化后的 runtime.toolVersion；dsh 的版本历史上一直由
// runtime.dshVersion 承载（服务端现在也只在 harness === 'dsh' 时赋值），保留它作为回退。
// 其它 harness 绝不回退到 dshVersion —— 那正是「Codex 卡显示 dsh 版本」的老 bug。
export function localToolVersion(home) {
  const runtime = home?.runtime;
  const normalized = cleanVersion(runtime?.toolVersion);
  if (normalized) return normalized;
  if (localToolKind(home) === 'dsh') return cleanVersion(runtime?.dshVersion);
  return null;
}

// 普通可连接 dsh 卡的版本 chip：服务端新增 toolVersion 后优先用它，老后端仍只有 dshVersion。
export function dshVersionOf(home) {
  return cleanVersion(home?.runtime?.toolVersion) ?? cleanVersion(home?.runtime?.dshVersion);
}

function cleanVersion(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

// 来源的人类可读名（用于卡片 title，帮助理解底色含义）。
export function sourceLabel(kind) {
  return SOURCE_LABELS[kind] ?? SOURCE_LABELS.other;
}

// 全局颜色分配表：每个标识（实例 homeId / 项目名）首次出现时领取一个"空闲"的
// 调色板颜色并记住，保证已分配的不同 id 颜色互不相同（可区分）、同 id 始终同色。
// 同一实例、同一项目在 Projects 与 Sessions 两栏里颜色一致；用于区分不同 dsh / projects。
const colorAssign = new Map();
let nextColor = 0;
export function chipColor(id) {
  const key = String(id ?? '');
  let idx = colorAssign.get(key);
  if (idx === undefined) {
    idx = nextColor % CHIP_PALETTE_LIGHT.length;
    colorAssign.set(key, idx);
    nextColor++;
  }
  const palette = isDarkTheme() ? CHIP_PALETTE_DARK : CHIP_PALETTE_LIGHT;
  const [bg, fg] = palette[idx];
  return { bg, fg };
}
