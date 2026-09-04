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
  // 远程实例（SSH 隧道）：hwb 直接管理远端 dsh web —— 停止=「启动」，运行中=「重启/关闭」。
  if (h.hostType === 'remote') {
    const life = rt === 'running'
      ? `<button class="primary" data-action="restart" data-home-id="${esc(h.homeId)}" title="重启远端 dsh web">重启</button>
         <button class="danger" data-action="stop" data-home-id="${esc(h.homeId)}" title="停止远端 dsh web">关闭</button>`
      : `<button class="primary" data-action="open" data-home-id="${esc(h.homeId)}" title="启动远端 dsh web 并打开">启动</button>`;
    return `${cfg}${life}
        <button class="danger" data-action="remove-home" data-home-id="${esc(h.homeId)}" data-name="${esc(h.alias || h.host)}">remove</button>`;
  }
  if (rt === 'gone') {
    return `${cfg}<button data-action="reindex" data-home-id="${esc(h.homeId)}">reindex</button>
        <button class="danger" data-action="remove-home" data-home-id="${esc(h.homeId)}" data-name="${esc(h.alias || h.homePath)}">remove</button>`;
  }
  const openBtn = rt === 'running'
    ? `<button class="primary" data-action="open" data-home-id="${esc(h.homeId)}">open ↗</button>
       <button class="danger" data-action="stop" data-home-id="${esc(h.homeId)}">stop</button>`
    : `<button class="primary" data-action="open" data-home-id="${esc(h.homeId)}">open</button>`;
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
          : `<span>${esc(h.hostType)}</span>
             <span>${h.workspaceCount} workspaces</span>
             <span>${h.sessionCount} sessions</span>`}
      </div>
      ${degradedDetail(h)}
      <div class="meta actions">
        <span>indexed ${timeAgo(h.lastIndexedAt)}</span>
        ${actions(h)}
      </div>
    </div>`).join('')}</div>`;
}
