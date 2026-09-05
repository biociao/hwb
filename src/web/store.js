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
const CHIP_PALETTE = [
  ['#1c2b4a', '#8fb7ff'], // blue
  ['#3a2f1c', '#e6b45c'], // amber
  ['#1f3a2a', '#6fd08a'], // green
  ['#3a1f33', '#e58ec4'], // pink
  ['#25284a', '#aab0ff'], // indigo
  ['#3a2a1c', '#e0a13c'], // orange
  ['#1f3a3a', '#5fd0d0'], // teal
  ['#3a3232', '#d0a0a0'], // rose
  ['#2a3a20', '#a8d06a'], // lime
  ['#3a2020', '#e08686'], // red
  ['#1c333a', '#7fd0e0'], // cyan
  ['#2a203a', '#b9a0ff'], // violet
  ['#3a361c', '#e6d05c'], // yellow
  ['#1f3a30', '#7fd0a0'], // sea
  ['#3a2a26', '#e0a080'], // coral
  ['#33203a', '#e080d0'], // magenta
  ['#363a1c', '#c8d05c'], // olive
  ['#1c2f4a', '#8fc7ff'], // sky
  ['#3a3026', '#e0c0a0'], // peach
  ['#1c284a', '#9fb6ff'], // azure
];

// 全局颜色分配表：每个标识（实例 homeId / 项目名）首次出现时领取一个"空闲"的
// 调色板颜色并记住，保证已分配的不同 id 颜色互不相同（可区分）、同 id 始终同色。
// 同一实例、同一项目在 Projects 与 Sessions 两栏里颜色一致；用于区分不同 dsh / projects。
const colorAssign = new Map();
let nextColor = 0;
export function chipColor(id) {
  const key = String(id ?? '');
  let idx = colorAssign.get(key);
  if (idx === undefined) {
    idx = nextColor % CHIP_PALETTE.length;
    colorAssign.set(key, idx);
    nextColor++;
  }
  const [bg, fg] = CHIP_PALETTE[idx];
  return { bg, fg };
}
