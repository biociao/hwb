import { esc, fmtTokens, chipColor } from '../store.js';

const fmtPct = (n) => `${(n * 100).toFixed(1)}%`;

function barRow(label, value, max, cls) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return `<div class="usage-line"><span class="u-label">${esc(label)}</span>
      <span class="u-bar"><i class="${cls}" style="width:${pct}%"></i></span>
      <span class="u-val">${fmtTokens(value)}</span></div>`;
}

// 趋势图维度切换按钮：总 Tokens / 按项目堆叠 / 按 LLM provider 堆叠 / 按实例堆叠。
const DIM_BUTTONS = [
  { dim: 'total', label: '合计' },
  { dim: 'project', label: '按项目' },
  { dim: 'provider', label: '按 LLM provider' },
  { dim: 'instance', label: '按实例' },
];
const DIM_LABELS = { total: '总 Tokens', project: '项目', provider: 'LLM provider', instance: '实例' };
// 稳定的柱色：按分组标签记色，跨重渲染同色（复用实例/项目 chip 配色）。
const colorOf = (label) => chipColor(label).fg;

// 统计周期：过去 24h / 3天 / 7天 / 14天 / 30天。
// hours 驱动「用量趋势」柱状图，days 驱动「汇总 + 按项目」统计，两者统一切换保持一致。
export const USAGE_PERIODS = [
  { key: '24h', label: '24h', hours: 24, days: 1 },
  { key: '3d', label: '3天', hours: 72, days: 3 },
  { key: '7d', label: '7天', hours: 168, days: 7 },
  { key: '14d', label: '14天', hours: 336, days: 14 },
  { key: '30d', label: '30天', hours: 720, days: 30 },
];

// 每桶粒度的人类可读标签。
function granLabel(stepMs) {
  if (!stepMs) return '';
  if (stepMs < 3_600_000) return `${Math.round(stepMs / 60_000)} 分钟`;
  const h = stepMs / 3_600_000;
  if (h < 24) return `${h % 1 === 0 ? h : +h.toFixed(1)} 小时`;
  return `${h / 24} 天`;
}

// 统计周期的人类可读标签（用于范围说明）。
function rangeLabel(hours) {
  const d = hours / 24;
  if (d % 1 === 0) return `最近 ${d} 天`;
  return `最近 ${hours} 小时`;
}

// X 轴刻度标签：亚小时桶显示「HH:MM」；1h~24h 桶显示「MM-DD HH:00」；天级桶显示「MM-DD」。
function axisLabel(ts, stepMs) {
  const t = new Date(ts);
  const hh = String(t.getHours()).padStart(2, '0');
  const mm = String(t.getMinutes()).padStart(2, '0');
  const md = `${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
  if (stepMs < 3_600_000) return `${hh}:${mm}`;
  if (stepMs >= 86_400_000) return md;
  return `${md} ${hh}:00`;
}

// 渲染堆叠柱状图（带坐标轴 + 图例）。dim ∈ total|project|provider|instance。
// 粒度由后端按周期自动调整（stepMs 随 hours 变化），X 轴标签按 stepMs 自适应格式化。
export function usageTrendHtml(usage, dim = 'total') {
  const source = usage?.trendBy?.[dim] || null;
  const buckets = Array.isArray(source?.buckets) ? source.buckets : [];
  const hours = source?.hours ?? 24;
  const stepMs = source?.stepMs ?? 3_600_000;
  // 只画有数据（total>0）的桶，避免空桶把坐标拉扁。
  const data = buckets.filter((b) => b.total > 0);
  if (data.length === 0) {
    return '<div class="empty">暂无 token 趋势数据（需先有被索引的活跃会话）</div>';
  }
  const max = Math.max(...data.map((b) => b.total), 1);
  // 收集本维度出现过的分组，按名排序并分配稳定颜色。
  const groupSet = new Set();
  for (const b of data) for (const k of Object.keys(b.groups)) groupSet.add(k);
  const groups = [...groupSet].sort((a, b) => a.localeCompare(b));
  // X 轴标签稀疏显示：每约 8 个桶显示一个，末尾必显示。
  const step = Math.max(1, Math.ceil(data.length / 8));
  const cols = data.map((b) => {
    const pctH = (b.total / max) * 100; // 该桶高度相对最大值
    const time = axisLabel(b.ts, stepMs);
    const segs = groups.map((g) => {
      const v = b.groups[g] || 0;
      if (v <= 0) return '';
      const pct = (v / b.total) * 100; // 桶内各分组占比（堆叠）
      return `<i style="height:${pct}%;background:${colorOf(g)}"
                title="${esc(g)} · ${fmtTokens(v)} tok"></i>`;
    }).join('');
    return `<div class="trend-col" title="${time} · 合计 ${fmtTokens(b.total)} tok">
      <div class="trend-stack" style="height:${pctH}%">${segs}</div>
    </div>`;
  }).join('');
  const xcells = data.map((b, i) => {
    const show = i % step === 0 || i === data.length - 1;
    return `<div class="trend-xcell">${show ? axisLabel(b.ts, stepMs) : ''}</div>`;
  }).join('');
  // Y 轴刻度（0/25/50/75/100% of max）+ 网格线。
  const ticks = [1, 0.75, 0.5, 0.25, 0];
  const yhtml = ticks.map(
    (f) => `<span class="trend-ytick" style="bottom:${f * 100}%">${f === 0 ? '0' : fmtTokens(Math.round(max * f))}</span>`
  ).join('');
  const grid = ticks.filter((f) => f > 0).map(
    (f) => `<i class="trend-gridline" style="bottom:${f * 100}%"></i>`
  ).join('');
  const legend = groups.map(
    (g) => `<span class="trend-legend-item"><i style="background:${colorOf(g)}"></i>${esc(g)}</span>`
  ).join('');
  const isStacked = dim !== 'total';
  return `
    <div class="trend-chart">
      <div class="trend-y">${yhtml}</div>
      <div class="trend-main">
        <div class="trend-plotarea">${grid}<div class="trend-bars">${cols}</div></div>
        <div class="trend-x">${xcells}</div>
      </div>
    </div>
    <div class="trend-caption">${rangeLabel(hours)} · 每 ${granLabel(stepMs)} 一柱${isStacked ? ` · 按${DIM_LABELS[dim]}堆叠` : ''}</div>
    ${isStacked ? `<div class="trend-legend">${legend}</div>` : ''}`;
}

// 维度切换按钮组：合计 / 按项目 / 按 provider / 按实例 + 右侧「最近 X 天 · 每 Y」范围说明。
function dimToggleHtml(activeDim, hours, stepMs) {
  const btns = DIM_BUTTONS.map(
    ({ dim, label }) => `<button data-action="usage-dim" data-dim="${dim}"
        class="usage-dim-btn ${dim === activeDim ? 'active' : ''}">${label}</button>`
  ).join('');
  const rangeMeta = `${rangeLabel(hours)}${stepMs ? ' · 每 ' + granLabel(stepMs) : ''}`;
  return `<div class="trend-toggle" id="usage-dim-toggle">${btns}<span class="trend-range">${rangeMeta}</span></div>`;
}

// 统计周期切换按钮组：过去 24h / 3天 / 7天 / 14天 / 30天。
function periodToggleHtml(activePeriodKey) {
  const btns = USAGE_PERIODS.map(
    (p) => `<button data-action="usage-period" data-period="${p.key}"
        class="usage-period-btn ${p.key === activePeriodKey ? 'active' : ''}">${p.label}</button>`
  ).join('');
  return `<div class="trend-toggle usage-period-toggle" id="usage-period-toggle">${btns}</div>`;
}

export function renderUsageCard(usage = {}, activeDim = 'total', activePeriodKey = USAGE_PERIODS[0].key) {
  if (!usage || !usage.summary || usage.summary.sessionCount === 0) {
    return '<div class="empty">暂无 token 用量数据（需先有被索引的活跃会话）</div>';
  }
  const { summary, byProject = [] } = usage;
  const totalTrend = usage?.trendBy?.total || null;
  const hours = totalTrend?.hours ?? 24;
  const stepMs = totalTrend?.stepMs ?? 3_600_000;
  const max = Math.max(summary.inputTokens, summary.outputTokens, summary.cacheRead, summary.cacheWrite, 1);
  const projRows = byProject.map((p) => `
    <div class="meta up-row"><span>${esc(p.project)}</span>
      <span>${p.sessionCount} 会话 · ${fmtTokens(p.tokens)} tok</span></div>`).join('');
  return `
    <div class="usage-grid">
      <div class="usage-big"><span class="num">${fmtTokens(summary.totalTokens)}</span><span class="cap">总 Tokens · ${summary.days}天</span></div>
      <div class="usage-stat"><span class="n">${fmtTokens(summary.inputTokens)}</span><span class="c">新增输入</span></div>
      <div class="usage-stat"><span class="n">${fmtTokens(summary.outputTokens)}</span><span class="c">Output</span></div>
      <div class="usage-stat"><span class="n">${fmtTokens(summary.cacheRead)}</span><span class="c">缓存命中</span></div>
      <div class="usage-stat"><span class="n">${fmtTokens(summary.cacheWrite)}</span><span class="c">缓存创建</span></div>
    </div>
    <div class="meta">
      <span class="chip ok">缓存命中率 ${fmtPct(summary.cacheHitRate)}</span>
      <span>${summary.sessionCount} 活跃会话</span>
    </div>
    <div class="usage-lines">
      ${barRow('新增输入', summary.inputTokens, max, 'b-in')}
      ${barRow('Output', summary.outputTokens, max, 'b-out')}
      ${barRow('缓存命中', summary.cacheRead, max, 'b-hit')}
      ${barRow('缓存创建', summary.cacheWrite, max, 'b-write')}
    </div>
    <div class="usage-trend-block">
      <div class="usage-trend-head">
        <span class="usage-trend-title">用量趋势</span>
        ${dimToggleHtml(activeDim, hours, stepMs)}
      </div>
      ${periodToggleHtml(activePeriodKey)}
      <div id="usage-trend">${usageTrendHtml(usage, activeDim)}</div>
    </div>
    ${projRows ? `<div class="nav-head">按项目</div><div class="usage-projects">${projRows}</div>` : ''}`;
}
