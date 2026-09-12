const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { checks: [] };
const check = (name, pass, detail) => out.checks.push({ name, pass, detail });

const measure = (label) => {
  const card = document.getElementById('usage-card');
  const plot = card.querySelector('.trend-plot')?.getBoundingClientRect();
  if (!plot) return { name: label, pass: false, detail: 'no plot' };
  const dots = [...card.querySelectorAll('.trend-dot')].map((d) => { const r = d.getBoundingClientRect(); return r.left + r.width / 2; });
  const labels = [...card.querySelectorAll('.trend-xlabel')].filter((l) => !l.hidden).map((l) => {
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
  const oob = labels.filter((l) => l.right > plot.right + 1 || l.left < plot.left - 1).length;
  return {
    name: label,
    pass: labels.length > 0 && worst.every((d) => d < 1.5) && !overlap && oob === 0,
    detail: `labels=${labels.length} 偏差=${worst.map((d) => d.toFixed(1)).join(',')} 越界=${oob}${overlap ? ` 重叠=${overlap}` : ''}`,
  };
};

// 切到 30 天（有数据），再切维度（本地重渲染，不发请求）
document.querySelector('#usage-period-toggle button[data-period="30d"]')?.click();
await wait(2500);
check('周期切换后', measure('周期切换后').pass, measure('周期切换后').detail);

document.querySelector('#usage-dim-toggle button[data-dim="project"]')?.click();
await wait(600);
check('切维度（本地重渲染）后', measure('切维度后').pass, measure('切维度后').detail);
check('切维度后仍没有 0 值散点', [...document.querySelectorAll('.trend-dot')].every((d) => d.dataset.tok !== '0'),
  `zeros=${[...document.querySelectorAll('.trend-dot')].filter((d) => d.dataset.tok === '0').length}`);

out.ok = out.checks.every((c) => c.pass);
return out;
