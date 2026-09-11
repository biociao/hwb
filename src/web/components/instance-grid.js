import { currentChannel } from './endpoint-editor.js';
import { esc, timeAgo } from '../store.js';

export function renderInstanceGrid(homes) {
  if (!homes.length) return '<div class="empty">暂无实例，请添加实例</div>';
  return `<div class="rows">${homes.map((h) => {
    const running = h.runtime?.runtime === 'running';
    const attached = running || h.runtime?.runtime === 'unreachable';
    const id = esc(h.homeId);
    return `<div class="row">
      <div class="t">
        <span class="name">${esc(h.alias || h.serverId || h.homePath)}</span>
        <span class="chip ${running ? 'ok' : attached ? 'warn' : ''}">${running ? '已连接' : attached ? '连接不可达' : '未连接'}</span>
      </div>
      ${attached ? `<div class="meta">当前通道：${esc(currentChannel(h))}</div>` : ''}
      ${running ? `<div class="meta"><span>${h.workspaceCount} projects</span><span>${h.sessionCount} sessions</span><span>响应 ${h.runtime.latencyMs ?? '—'} ms</span><span>检查 ${timeAgo(h.runtime.checkedAt)}</span></div>` : ''}
      <div class="meta actions">
        ${attached
          ? `<button data-action="disconnect" data-home-id="${id}">断开</button>`
          : `<button class="primary" data-action="connect" data-home-id="${id}">连接</button>`}
        ${(h.endpoints?.length || 0) > 1 ? `<button data-action="choose-channel" data-home-id="${id}">切换</button>` : ''}
        <button data-action="settings" data-home-id="${id}" title="编辑实例配置">⚙ 设置</button>
      </div>
    </div>`;
  }).join('')}</div>`;
}
