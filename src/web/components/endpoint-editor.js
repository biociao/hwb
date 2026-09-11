import { esc } from '../store.js';

export function endpointRow(endpoint = {}, remote = true, activeId = null) {
  return `<div class="endpoint-row" data-endpoint-id="${esc(endpoint.id || '')}" data-legacy-label="${esc(endpoint.label || '')}">
    ${remote ? `<label class="config-field"><span>SSH 主机</span><input data-field="host" placeholder="例如 bot@cms.lo" value="${esc(endpoint.host || '')}" autocomplete="off"></label>` : ''}
    <label class="config-field"><span>dsh web 端口</span><input data-field="port" type="number" min="1" max="65535" placeholder="例如 3080" value="${esc(endpoint.port || '')}"></label>
    <label class="config-field endpoint-token"><span>鉴权 Token <small>可选</small></span><input data-field="token" placeholder="留空自动读取" value="${esc(endpoint.token || '')}" autocomplete="off"></label>
    <div class="endpoint-row-actions"><span class="meta">${endpoint.id && endpoint.id === activeId ? '当前选用' : ''}</span><button type="button" data-action="remove-endpoint">移除</button></div>
  </div>`;
}

export function endpointEditor(home) {
  return `<fieldset class="endpoint-editor" data-remote="${home.hostType === 'remote'}">
    <legend>连接端点</legend>
    <p class="meta">使用主机和端口区分连接。修改当前端点前，请先切换或断开。</p>
    <div class="endpoint-rows">${(home.endpoints || []).map((e) => endpointRow(e, home.hostType === 'remote', home.activeEndpointId)).join('')}</div>
    <button type="button" data-action="add-endpoint">＋ 添加端点</button>
  </fieldset>`;
}

export function readEndpoints(form) {
  return [...form.querySelectorAll('.endpoint-row')].map((row) => {
    const read = (name) => row.querySelector(`[data-field="${name}"]`)?.value.trim() || '';
    return { id: row.dataset.endpointId || undefined, label: row.dataset.legacyLabel || '', host: read('host') || null,
      port: Number(read('port')), token: read('token') || null };
  });
}

export function endpointSelector(home) {
  if ((home.endpoints?.length || 0) < 2) return '';
  return `<div class="meta endpoint-switch">
    <label class="config-field"><span>连接通道</span><select data-endpoint-select="${esc(home.homeId)}" aria-label="选择连接端点">
      ${home.endpoints.map((e) => `<option value="${esc(e.id)}" ${e.id === home.activeEndpointId ? 'selected' : ''}>${esc(e.host || '127.0.0.1')}:${e.port}${e.id === home.activeEndpointId ? '（当前选用）' : ''}</option>`).join('')}
    </select></label>
    <button type="button" data-action="switch-endpoint" data-home-id="${esc(home.homeId)}">切换连接</button>
  </div>`;
}


export function currentChannel(home) {
  const endpoint = home.endpoints?.find((e) => e.id === home.activeEndpointId);
  const host = endpoint?.host || (home.hostType === 'remote' ? home.host : '127.0.0.1');
  const port = endpoint?.port || (home.hostType === 'remote' ? home.remotePort : home.localPort || home.runtime?.port);
  const address = host && port ? `${host}:${port}` : host || '本机';
  return address;
}
