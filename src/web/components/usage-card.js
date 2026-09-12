import { esc, fmtTokens, chipColor } from '../store.js';

// 非数字时 toFixed 会抛（整卡渲染失败）；同时这里也是 innerHTML 的插值点，统一兜住。
const fmtPct = (n) => {
  const v = Number(n);
  return Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '—';
};

// —— 单条构成线：新增输入 / 缓存命中 / 缓存创建 / 输出 按占比分段显示在同一条线上。
//    各项以不同颜色区分，悬停可查看该项的实际用量与占比
//    （data-name / data-tok / data-pct 交由前端 JS tooltip 展示，见 app.js）。
function usageStreamHtml(summary) {
  const segs = [
    { label: '新增输入', val: summary.inputTokens, cls: 's-in' },
    { label: '缓存命中', val: summary.cacheRead, cls: 's-hit' },
    { label: '缓存创建', val: summary.cacheWrite, cls: 's-write' },
    { label: 'Output', val: summary.outputTokens, cls: 's-out' },
  ].filter((s) => s.val > 0);
  if (segs.length === 0) return '';
  const total = summary.totalTokens || 0;
  const parts = segs.map((s) => {
    const pct = total > 0 ? (s.val / total) * 100 : 0;
    // flex: <val> 1 0 → 按数值占比分配宽度；min-width 保证极小项仍可悬停。
    return `<i class="seg ${s.cls}" style="flex:${s.val} 1 0"
        data-name="${esc(s.label)}" data-tok="${esc(fmtTokens(s.val))}" data-pct="${pct.toFixed(1)}"></i>`;
  }).join('');
  return `<div class="usage-stream" aria-label="token 构成占比">${parts}</div>
    <div class="usage-stream-cap">悬停查看各项实际用量与占比</div>`;
}

// 趋势图维度切换按钮：总 Tokens / 按项目 / 按 LLM provider / 按 Model / 按实例。
const DIM_BUTTONS = [
  { dim: 'total', label: '合计' },
  { dim: 'project', label: '按项目' },
  { dim: 'provider', label: '按 LLM provider' },
  { dim: 'model', label: '按 Model' },
  { dim: 'instance', label: '按实例' },
];
const DIM_LABELS = { total: '总 Tokens', project: '项目', provider: 'LLM provider', model: 'Model', instance: '实例' };
// 稳定的曲线/点颜色：按分组标签记色，跨重渲染同色（复用实例/项目 chip 配色）。
const colorOf = (label) => chipColor(label).fg;


// 统计周期：过去 24h / 3天 / 7天 / 14天 / 30天。
// hours 驱动「用量趋势」点图，days 驱动「汇总 + 按项目」统计，两者统一切换保持一致。
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

// 渲染点图（带坐标轴 + 平滑拟合曲线 + 数据点 + 图例）。dim ∈ total|project|provider|model|instance。
// 每条时间序列对应一条 Catmull-Rom→三次贝塞尔平滑曲线，数据点以圆形散点标出；
// 悬停散点显示详细信息（时间 · 分组 · 用量 · 占峰值百分比，data-name/tok/pct 交前端 tooltip 渲染）。
// 粒度由后端按周期自适应调整。
// 空桶怎么画：**照画，并按 0 连线**（2026-09-13 按用户口径变更）。
//
// 本函数以前是「只画非空桶 + 跨空格断线」，理由是跨空白连一条平滑曲线等于替用户编一段
// 「逐步衰减」。但那个做法在真实数据上的效果是：14 天窗口 56 格里有 19 格是空的、折线被切成
// 12 段，用户看到的是「线怎么不连续了、像是少了一段」。现在整段窗口每一格都画，
// 没有数据的格子落在基线上、折线一路连着。
//
// 代价必须由**图注**接手，不能悄悄消失：这一层的 0 表示「该时段没有会话结束」，
// 不等于「该时段没有用量」—— token 是按会话**累计**、整段落在会话 lastActivity 所在那一格里的
// （见 store.js usageTrendGrouped）。所以有空桶时额外输出一行口径说明。
//
// 另一条不变量保持不变：**0 不画散点**。按维度拆分时大部分分组在大部分格子里都是 0，
// 画出来是一排 8px 圆点全叠在基线上，且 tooltip 各不相同（同一位置只能命中最后那个）。
export function usageTrendHtml(usage, dim = 'total') {
  const source = usage?.trendBy?.[dim] || null;
  const buckets = Array.isArray(source?.buckets) ? source.buckets : [];
  const hours = source?.hours ?? 24;
  const stepMs = source?.stepMs ?? 3_600_000;
  // 全量桶都进 data（空桶是值为 0 的真实数据点），**定位按时间**而不是按「第几个桶」：
  // 整段窗口的首尾桶时间戳为端点、其余按时间插值。这一点必须保住 —— 只按序号等分的话，
  // 边界上多出来的半格会让所有点整体偏移（历史上"标签与散点对不上"就是这类错位）。
  const data = buckets;
  if (!buckets.length || !buckets.some((b) => b.total > 0)) {
    return '<div class="empty">暂无 token 趋势数据（需先有被索引的活跃会话）</div>';
  }
  const max = Math.max(...buckets.map((b) => b.total), 1);
  // 收集本维度出现过的分组，按名排序并分配稳定颜色。
  const groupSet = new Set();
  for (const b of buckets) for (const k of Object.keys(b.groups)) groupSet.add(k);
  const groups = [...groupSet].sort((a, b) => a.localeCompare(b));
  const n = data.length;
  const emptyBuckets = buckets.filter((b) => !(b.total > 0)).length;

  // 点图坐标（SVG viewBox 0..100；preserveAspectRatio=none，随容器横向拉伸）。
  // x：0..100 左→右；y：0..100 顶→底。数据点用 HTML 圆形散点（left%/bottom%）定位，不受拉伸变形。
  // x 按**时间**插值：整段窗口（含空桶）的首尾桶时间戳为端点。
  const t0 = buckets.length ? Date.parse(buckets[0].ts) : 0;
  const t1 = buckets.length ? Date.parse(buckets[buckets.length - 1].ts) : 0;
  const span = t1 - t0;
  const pxAt = (ts) => {
    const t = Date.parse(ts);
    if (!Number.isFinite(span) || span <= 0 || !Number.isFinite(t)) return n <= 1 ? 50 : 50;
    return ((t - t0) / span) * 100;
  };
  const px = (i) => pxAt(data[i].ts);
  const py = (v) => (max > 0 ? (1 - Math.min(1, v / max)) * 100 : 100);
  const bottomOf = (v) => (max > 0 ? Math.min(1, v / max) * 100 : 0);

  // 曲线拟合：Catmull-Rom 样条 → 三次贝塞尔，途径每个数据点；控制点 Y 钳制在绘图区 [0,100] 内，
  // 避免个别尖峰让曲线冲到坐标区以外。
  const clampY = (y) => Math.max(0, Math.min(100, y));
  function smoothPath(pts) {
    if (pts.length === 1) return `M ${pts[0].x} ${pts[0].y}`;
    let d = `M ${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] || p2;
      const c1x = p1.x + (p2.x - p0.x) / 6;
      const c1y = clampY(p1.y + (p2.y - p0.y) / 6);
      const c2x = p2.x - (p3.x - p1.x) / 6;
      const c2y = clampY(p2.y - (p3.y - p1.y) / 6);
      d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)} ${c2x.toFixed(2)} ${c2y.toFixed(2)} ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
    }
    return d;
  }

  // 一条分组 = 一条**连续**曲线：空桶（值 0）就是曲线上的一个点，落在基线上。
  // 不再有「跨空格断线」分支 —— 那是旧口径，见函数头的说明。
  const series = groups.map((g) => {
    const pts = data.map((b, i) => ({ x: px(i), y: py(b.groups[g] || 0) }));
    return { g, path: smoothPath(pts), pts };
  });
  const lineSvg = `<svg class="trend-line" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${
    series.map((s) => `<path d="${s.path}" fill="none" stroke="${colorOf(s.g)}"
        stroke-width="${s.g === '合计' ? 2 : 1.6}" vector-effect="non-scaling-stroke"/>`).join('')
  }</svg>`;
  const dots = series.flatMap((s) => s.pts.map((p, i) => {
    const v = data[i].groups[s.g] || 0;
    // 0 不画点：按维度拆分时，大部分分组在大部分桶里都是 0，画出来是一排 8px 圆点全叠在 0% 基线上，
    // 且各自的 tooltip 不同（同一位置悬停只能命中 DOM 里最后那个）。独立审查实测 24h + 按项目：
    // 12 个点里 8 个 data-tok="0"，两两完全重叠。曲线本身照画（含 0 值点）。
    if (!(v > 0)) return '';
    const pct = max > 0 ? (v / max) * 100 : 0;
    // 数据点悬停显示详细信息：时间 · 分组 · 用量 · 占峰值百分比（交由前端 tooltip 渲染）。
    return `<i class="trend-dot" style="left:${p.x}%;bottom:${bottomOf(v)}%;background:${colorOf(s.g)}"
        data-name="${axisLabel(data[i].ts, stepMs)} · ${esc(s.g)}" data-tok="${esc(fmtTokens(v))}" data-pct="${pct.toFixed(1)}"></i>`;
  })).join('');

  // X 轴标签：**必须与散点用同一个 x 函数**（pxAt）。散点按时间定位，而标签原先只是 n 个 flex:1
  // 的等分单元格 —— 只要有空桶两者就对不上。独立审查用真浏览器实测（30 天周期、60 桶里只有 5 个非空）：
  // 标签中心在 9.9/29.9/50.0/70.1/90.1%，对应散点却在 72.9/86.4/96.6/98.3/100.0% ——
  // 所有数据都堆在「09-11 20:00」底下，而「09-03 20:00」的标签悬在空白上，读者会把用量算到错的日子。
  //
  // 这里只负责**按时间定位 + 稀疏取点**；「贴边裁切」与「相邻压字」交给渲染后的实测拟合
  // （fitTrendLabels）：两者都取决于真实宽度，静态常量给不出正确答案 —— 实测同一组数据在
  // 542px 的绘图区里，12% 的间隔（65px）仍会让两个标签重叠 16px。
  const step = Math.max(1, Math.ceil(n / 8));
  const shownLabels = data
    .map((b, i) => ({ ts: b.ts, left: px(i), last: i === n - 1 }))
    .filter((_, i) => i % step === 0 || i === n - 1);
  const xcells = shownLabels.map(({ ts, left }) =>
    `<span class="trend-xlabel" style="left:${left}%">${axisLabel(ts, stepMs)}</span>`).join('');

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
  // 空桶（按 0 连线）必须配一行口径说明：否则「曲线掉到 0」会被读成「那段时间没用」，
  // 而真相是 token 按会话累计落格，那一格没有会话结束而已。
  const zeroNote = emptyBuckets > 0
    ? `<div class="trend-caption">其中 ${emptyBuckets} 格无数据，按 0 计入并连线 —— 0 表示该时段没有会话结束，不等于该时段没有用量</div>`
    : '';
  return `
    <div class="trend-chart">
      <div class="trend-y">${yhtml}</div>
      <div class="trend-main">
        <div class="trend-plot">${grid}${lineSvg}${dots}</div>
        <div class="trend-x">${xcells}</div>
      </div>
    </div>
    <div class="trend-caption">${rangeLabel(hours)} · 每 ${granLabel(stepMs)} 一个数据点${isStacked ? ` · 按${DIM_LABELS[dim]}拆分` : ''}</div>
    ${zeroNote}
    ${isStacked ? `<div class="trend-legend">${legend}</div>` : ''}`;
}

// —— 渲染后拟合（需要真实布局，浏览器里调用）——
// ① 贴边钳制：居中定位会让最左/最右的标签有一半跑到绘图区外，改成向内对齐；
// ② 相邻压字：真量一遍，重叠的标签删掉（保留最后一个 —— 它就是「现在」）。
// 放在 JS 里按实测宽度做，是因为轴标签宽度取决于字体与卡片宽度，模板字符串里无从得知。
export function fitTrendLabels(root) {
  const el = root?.querySelector?.('.trend-x');
  const plot = root?.querySelector?.('.trend-plot');
  if (!el || !plot || typeof plot.getBoundingClientRect !== 'function') return;
  const bounds = plot.getBoundingClientRect();
  const labels = [...el.querySelectorAll('.trend-xlabel')].filter((l) => !l.hidden);
  if (!labels.length) return;
  // ① 贴边
  for (const l of labels) {
    const r = l.getBoundingClientRect();
    if (r.right > bounds.right + 0.5) l.classList.add('trend-xlabel-right');
    else if (r.left < bounds.left - 0.5) l.classList.add('trend-xlabel-left');
  }
  // ② 重叠（重新量一遍：上一步可能改了锚点、位置随之变化）
  let prevRight = -Infinity;
  let prevNode = null;
  for (let i = 0; i < labels.length; i++) {
    const r = labels[i].getBoundingClientRect();
    if (r.left < prevRight - 0.5) {
      if (i === labels.length - 1) {
        // 末尾那个必须留下：挤掉与它重叠的前一个
        if (prevNode) prevNode.hidden = true;
      } else {
        labels[i].hidden = true;
        continue;
      }
    }
    prevRight = r.right;
    prevNode = labels[i];
  }
}

// 维度切换按钮组：合计 / 按项目 / 按 provider / 按 Model / 按实例。范围说明由外层渲染（trend-range 同级）。
function dimToggleHtml(activeDim) {
  const btns = DIM_BUTTONS.map(
    ({ dim, label }) => `<button data-action="usage-dim" data-dim="${dim}"
        class="usage-dim-btn ${dim === activeDim ? 'active' : ''}">${label}</button>`
  ).join('');
  return `<div class="trend-toggle trend-dim" id="usage-dim-toggle">${btns}</div>`;
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
    // 空状态**也必须渲染周期切换按钮**。原先这里直接 return 一句「暂无 token 用量数据」，
    // 而周期按钮（24h/3天/…/30天）在早退之后的那一段里 —— 于是「默认 24h 窗口里没有数据、但更早
    // 有数据」的用户：卡片说没有数据、页面上一个周期按钮都没有，唯一的出路（放宽窗口）点不到。
    // 独立审查用真浏览器复现过：默认窗口 sessionCount=0 且 `#usage-period-toggle button` 数量为 0，
    // 而同一个 API 用 30 天窗口返回「5 个活跃会话 / 3 个非空桶」—— 不是没数据，是这个窗口里没有。
    const hours = usage?.trendBy?.total?.hours
      ?? USAGE_PERIODS.find((p) => p.key === activePeriodKey)?.hours ?? 24;
    return `
    <div class="usage-trend-block">
      <div class="usage-trend-head">
        <span class="usage-trend-title">用量趋势</span>
        <span class="trend-range">${rangeLabel(hours)}</span>
      </div>
      ${periodToggleHtml(activePeriodKey)}
      <div class="empty">这个窗口（${rangeLabel(hours)}）内没有 token 用量数据。若更早用过 dsh，可切换到更长的周期查看。</div>
    </div>`;
  }
  const { summary } = usage;
  const totalTrend = usage?.trendBy?.total || null;
  const hours = totalTrend?.hours ?? 24;
  const stepMs = totalTrend?.stepMs ?? 3_600_000;
  return `
    <div class="usage-grid">
      <div class="usage-big"><span class="num">${fmtTokens(summary.totalTokens)}</span><span class="cap">总 Tokens · ${esc(summary.days)}天</span></div>
      <div class="usage-stat"><span class="n">${fmtTokens(summary.inputTokens)}</span><span class="c">新增输入</span></div>
      <div class="usage-stat"><span class="n">${fmtTokens(summary.outputTokens)}</span><span class="c">Output</span></div>
      <div class="usage-stat"><span class="n">${fmtTokens(summary.cacheRead)}</span><span class="c">缓存命中</span></div>
      <div class="usage-stat"><span class="n">${fmtTokens(summary.cacheWrite)}</span><span class="c">缓存创建</span></div>
    </div>
    <div class="meta">
      <span class="chip ok">缓存命中率 ${fmtPct(summary.cacheHitRate)}</span>
      <span>${esc(summary.sessionCount)} 活跃会话</span>
    </div>
    ${usageStreamHtml(summary)}
    <div class="usage-trend-block">
      <div class="usage-trend-head">
        <span class="usage-trend-title">用量趋势</span>
        ${dimToggleHtml(activeDim)}
        <span class="trend-range">${rangeLabel(hours)}${stepMs ? ' · 每 ' + granLabel(stepMs) : ''}</span>
      </div>
      ${periodToggleHtml(activePeriodKey)}
      <div id="usage-trend">${usageTrendHtml(usage, activeDim)}</div>
    </div>`;
}
