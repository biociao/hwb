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
  if (!res.ok) throw new Error(data.error || `${path}: ${res.status}`);
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

export function fmtTokens(n) {
  if (n == null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
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
