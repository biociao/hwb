import { esc, timeAgo } from '../store.js';

function indexChip(h) {
  if (h.hostType === 'remote') return '<span class="chip">remote</span>';
  if (h.degraded.length > 0) return '<span class="chip warn">index degraded</span>';
  if (h.status === 'ok') return '<span class="chip ok">indexed</span>';
  return `<span class="chip">${esc(h.status)}</span>`;
}

function runtimeChip(h) {
  const rt = h.runtime?.runtime ?? 'stopped';
  switch (rt) {
    case 'running':
      return `<span class="chip ok">running · :${h.runtime.port}</span>`;
    case 'unreachable':
      return '<span class="chip warn">unreachable</span>';
    case 'gone':
      return '<span class="chip bad">home 目录不存在</span>';
    default:
      return '<span class="chip">stopped</span>';
  }
}

// §4.3: 版本不兼容时提示“dsh 已升级”，而不是只报原始错误。
function degradedDetail(h) {
  if (!h.degraded.length) return '';
  const upgrade = h.degraded.some((d) => /unsupported (version|schema)/.test(d.error));
  const lines = h.degraded.map((d) => `${d.domain}: ${d.error}`).join(' · ');
  return `<div class="meta degraded-detail">
    ${upgrade ? '<span class="chip warn">dsh 已升级 — 索引待适配</span>' : ''}
    <span>${esc(lines)}</span>
  </div>`;
}

const settingsBtn = (h) =>
  `<button data-action="settings" data-home-id="${esc(h.homeId)}" title="编辑实例配置">⚙ 设置</button>`;

function actions(h) {
  const rt = h.runtime?.runtime ?? 'stopped';
  const cfg = settingsBtn(h);
  // 远程实例（SSH 隧道）：默认动作是【连接】——连接到已有远端 dsh web（重建 ssh 转发），
  // 而非启动；仅当远端确实没有实例在跑时才拉起。运行中=「重启/关闭」（最后手段，需确认）。
  if (h.hostType === 'remote') {
    const life = rt === 'running'
      ? `<button class="primary" data-action="restart" data-home-id="${esc(h.homeId)}" title="重启远端 dsh web（打断实例，仅最后手段）">重启</button>
         <button class="danger" data-action="stop" data-home-id="${esc(h.homeId)}" title="停止远端 dsh web（打断实例，仅最后手段）">关闭</button>`
      : `<button class="primary" data-action="open" data-home-id="${esc(h.homeId)}" title="连接已有远端 dsh 实例（重建 ssh 转发接入）">连接</button>`;
    return `${cfg}${life}
        <button class="danger" data-action="remove-home" data-home-id="${esc(h.homeId)}" data-name="${esc(h.alias || h.host)}">remove</button>`;
  }
  if (rt === 'gone') {
    return `${cfg}<button data-action="reindex" data-home-id="${esc(h.homeId)}">reindex</button>
        <button class="danger" data-action="remove-home" data-home-id="${esc(h.homeId)}" data-name="${esc(h.alias || h.homePath)}">remove</button>`;
  }
  // 本机：同样是【连接】——连接到（必要时拉起并连入）本地 dsh 实例。
  const openBtn = rt === 'running'
    ? `<button class="primary" data-action="open" data-home-id="${esc(h.homeId)}" title="连接本地 dsh 实例">连接 ↗</button>
       <button class="danger" data-action="stop" data-home-id="${esc(h.homeId)}" title="停止本地 dsh web（打断实例，仅最后手段）">stop</button>`
    : `<button class="primary" data-action="open" data-home-id="${esc(h.homeId)}" title="连接本地 dsh 实例（若未运行则拉起）">连接</button>`;
  return `${cfg}${openBtn}
        <button data-action="reindex" data-home-id="${esc(h.homeId)}">reindex</button>
        <button class="danger" data-action="remove-home" data-home-id="${esc(h.homeId)}" data-name="${esc(h.alias || h.homePath)}">remove</button>`;
}

export function renderInstanceGrid(homes) {
  if (!homes.length) return '<div class="empty">no dsh homes registered</div>';
  return `<div class="rows">${homes.map((h) => `
    <div class="row">
      <div class="t">
        <span class="name" title="${esc(h.homePath)}">${esc(h.alias || h.homePath)}</span>
        ${runtimeChip(h)}
      </div>
      <div class="meta">
        ${indexChip(h)}
        ${h.hostType === 'remote'
          ? `<span>ssh · ${esc(h.host)}:${esc(h.remotePort)}${h.remoteHome ? ` · ${esc(h.remoteHome)}` : ''}</span>`
          : `<span>${esc(h.hostType)}</span>`}
        ${h.hostType === 'local' || h.sessionCount || h.workspaceCount
          ? `<span>${h.workspaceCount} workspaces</span><span>${h.sessionCount} sessions</span>`
          : ''}
      </div>
      ${degradedDetail(h)}
      <div class="meta actions">
        <span>indexed ${timeAgo(h.lastIndexedAt)}</span>
        ${actions(h)}
      </div>
    </div>`).join('')}</div>`;
}
