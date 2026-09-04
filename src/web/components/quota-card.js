import { esc, timeAgo } from '../store.js';

const fmtAmount = (n, currency) =>
  `${currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : `${esc(currency)} `}${Number(n).toFixed(2)}`;

// §8.2 额度卡片：只读展示 { provider, remaining, currency }，失败降级 "不可用"。
export function renderQuotaCards(quota, homes) {
  const aliasOf = new Map(homes.map((h) => [h.homeId, h.alias || h.homePath]));
  if (!quota.length) {
    return '<div class="empty">额度查询中…（若无凭证配置则始终为空）</div>';
  }
  const byHome = new Map();
  for (const q of quota) {
    if (!byHome.has(q.homeId)) byHome.set(q.homeId, []);
    byHome.get(q.homeId).push(q);
  }
  return `<div class="rows">${[...byHome.entries()].map(([homeId, rows]) => `
    <div class="row">
      <div class="t"><span class="name">${esc(aliasOf.get(homeId) ?? homeId)}</span></div>
      <div class="meta quota-row">
        ${rows.map((q) => q.error != null || q.remaining == null
          ? `<span class="chip warn" title="${esc(q.error ?? '')}">${esc(q.provider)}: 不可用</span>`
          : `<span class="chip ok">${esc(q.provider)}: ${fmtAmount(q.remaining, q.currency)}</span>`).join('')}
      </div>
      <div class="meta"><span>queried ${timeAgo(rows[0]?.queriedAt)}</span></div>
    </div>`).join('')}</div>`;
}
