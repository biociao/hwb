import { esc } from '../store.js';

export function endpointRow(endpoint = {}, remote = true, activeId = null) {
  return `<div class="endpoint-row" data-endpoint-id="${esc(endpoint.id || '')}" data-legacy-label="${esc(endpoint.label || '')}">
    ${remote ? `<label class="config-field"><span>SSH 主机</span><input data-field="host" placeholder="例如 bot@cms.lo" value="${esc(endpoint.host || '')}" autocomplete="off"></label>` : ''}
    <label class="config-field"><span>dsh web 端口</span><input data-field="port" type="number" min="1" max="65535" placeholder="例如 3080" value="${esc(endpoint.port || '')}"></label>
    <label class="config-field endpoint-token"><span>鉴权 Token <small>可选</small></span><input data-field="token"
      placeholder="${endpoint.tokenSet ? '已配置，留空保持不变' : '留空自动读取'}" value="" autocomplete="off"
      ${endpoint.tokenSet ? 'data-token-set="1"' : ''}></label>
    <div class="endpoint-row-actions"><span class="meta">${endpoint.id && endpoint.id === activeId ? '当前选用' : ''}${
      endpoint.tokenSet ? '<span data-token-state>已配置 token</span>' : ''}</span>${
      endpoint.tokenSet ? '<button type="button" data-action="clear-endpoint-token">清除 token</button>' : ''}<button type="button" data-action="remove-endpoint">移除</button></div>
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

// 服务端不再回传端点 token（它是控制凭据），所以这里也必须改语义：
//   · 输入框留空 → **不传 token 字段**，服务端沿用已存的那个（否则「打开设置再保存」= 静默清除）；
//   · 用户点了「清除 token」→ 传 tokenClear: true；
//   · 用户填了新值 → 正常传 token。
export function readEndpoints(form) {
  return [...form.querySelectorAll('.endpoint-row')].map((row) => {
    const read = (name) => row.querySelector(`[data-field="${name}"]`)?.value.trim() || '';
    const typed = read('token');
    const out = { id: row.dataset.endpointId || undefined, label: row.dataset.legacyLabel || '',
      host: read('host') || null, port: Number(read('port')) };
    if (typed) out.token = typed;
    else if (row.dataset.tokenClear === '1') out.tokenClear = true;
    return out;
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
