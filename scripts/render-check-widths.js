// 宽度扫描：不同卡片宽度下，x 轴标签都必须对齐、不重叠、不越界。
// 这正是「静态常量算不出真实宽度」那件事的压力测试：320px 的卡片与 900px 的卡片，
// 标签宽度一样但可用水平空间差 3 倍。
await import('/src/web/components/usage-card.js');
const { usageTrendHtml, fitTrendLabels } = await import('/src/web/components/usage-card.js');

const cssText = await (await fetch('/src/web/index.html')).text();
const styleBlock = cssText.match(/<style>([\s\S]*?)<\/style>/);
if (styleBlock) { const s = document.createElement('style'); s.textContent = styleBlock[1]; document.head.appendChild(s); }

const stage = document.getElementById('stage');
const H = 3_600_000, t0 = Date.parse('2026-09-01T00:00:00.000Z');
const mk = (i, total) => ({ ts: new Date(t0 + i * H).toISOString(), groups: total ? { '合计': total } : {}, total });

// 三种形态：满窗口 / 审查实测的稀疏窗口 / 末尾聚集
const cases = {
  dense: (() => { const b = Array.from({ length: 60 }, (_, i) => mk(i, i + 1)); return b; })(),
  sparse: (() => { const b = Array.from({ length: 60 }, (_, i) => mk(i, 0)); for (const i of [43, 51, 57, 58, 59]) b[i] = mk(i, 100 + i); return b; })(),
  clustered: (() => { const b = Array.from({ length: 60 }, (_, i) => mk(i, 0)); for (const i of [55, 56, 57, 58, 59]) b[i] = mk(i, 100 + i); return b; })(),
};

const checks = [];
const widths = [300, 360, 480, 640, 900, 1200];
for (const [name, buckets] of Object.entries(cases)) {
  for (const w of widths) {
    stage.style.width = `${w}px`;
    stage.innerHTML = usageTrendHtml({ trendBy: { total: { buckets, hours: 720, stepMs: 12 * H } } }, 'total');
    fitTrendLabels(stage);
    const plot = stage.querySelector('.trend-plot').getBoundingClientRect();
    const dots = [...stage.querySelectorAll('.trend-dot')].map((d) => { const r = d.getBoundingClientRect(); return r.left + r.width / 2; });
    const labels = [...stage.querySelectorAll('.trend-xlabel')].filter((l) => !l.hidden).map((l) => {
      const r = l.getBoundingClientRect();
      const anchor = l.classList.contains('trend-xlabel-right') ? 'right' : (l.classList.contains('trend-xlabel-left') ? 'left' : 'center');
      return { text: l.textContent, left: r.left, right: r.right, cx: r.left + r.width / 2, anchor };
    });
    const worst = labels.map((l) => {
      const ax = l.anchor === 'right' ? l.right : (l.anchor === 'left' ? l.left : l.cx);
      return Math.min(...dots.map((d) => Math.abs(d - ax)));
    });
    let overlap = null;
    for (let i = 1; i < labels.length; i++) if (labels[i].left < labels[i - 1].right - 0.5) overlap = `${labels[i - 1].text}|${labels[i].text}`;
    const outOfBounds = labels.filter((l) => l.right > plot.right + 1 || l.left < plot.left - 1).length;
    checks.push({
      name: `${name}@${w}px`,
      pass: labels.length > 0 && worst.every((d) => d < 1.5) && !overlap && outOfBounds === 0,
      detail: `plot=${Math.round(plot.width)}px labels=${labels.length} 偏差=${worst.map((d) => d.toFixed(1)).join(',')}`
        + ` 越界=${outOfBounds}${overlap ? ` 重叠=${overlap}` : ''}`,
    });
  }
}
const failed = checks.filter((c) => !c.pass);
return { ok: failed.length === 0, failed, checks };
