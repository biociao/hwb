import { currentChannel } from './endpoint-editor.js';
import { esc, timeAgo } from '../store.js';

// 域降级提示。degraded 由 schema 校验产出（如 dsh 升级后 unit.version 超出支持范围），
// 此前**只写进数据库、界面上任何地方都不显示**：用户看到的是「这个实例的会话/项目变少了」，
// 却没有任何线索指向「元数据格式不兼容」。降级时对应表的旧行会被保留（见 store.upsertRows），
// 所以这里的提示同时也解释了「为什么数字停在上一次」。
function degradedChips(degraded) {
  if (!Array.isArray(degraded) || !degraded.length) return '';
  return degraded.map((d) => {
    const domain = esc(d?.domain ?? 'unknown');
    const error = esc(d?.error ?? '');
    return `<span class="chip warn" title="该元数据域校验失败，已沿用上一次成功索引的数据：${error}">⚠ ${domain} 降级</span>`;
  }).join('');
}

// 该实例上的 dsh 版本号（服务端探测：本地读本机安装、远程经 SSH 问 `dsh --version`）。
//
// 取不到时**什么都不显示**：卡片上的「未连接 / 连接不可达」说的是 hwb 与这个实例的接入，
// 而版本取不到还可能是「远端没装 dsh」或「SSH 主机不通」—— 画一个「dsh —」会把两件事混成
// 一件，读者反而不知道该去查什么。版本号本身已由服务端限定成干净的版本字面量，这里仍转义。
function versionChip(runtime) {
  const version = runtime?.dshVersion;
  if (typeof version !== 'string' || !version) return '';
  return `<span class="chip ver" title="该实例上 dsh 的版本号">dsh ${esc(version)}</span>`;
}

// Codex 实例卡：与 dsh 实例同构（同一张 INSTANCES 列表），但语义是「只读元数据接入」——
// 没有连接/断开、没有当前通道、没有端点选择，也没有版本号。状态只有两种：
//   running → 已就绪（能读到 home 并完成过一次索引）；
//   其他    → 路径缺失（homePath 不在，需要用户去设置里改路径）。
// 「打开 Codex」由 app.js 调 POST /api/codex/open（homeId → 最近会话/最近项目）。
function codexCard(h) {
  const id = esc(h.homeId);
  const running = h.runtime?.runtime === 'running';
  return `<div class="row">
      <div class="t">
        <span class="name">${esc(h.alias || h.serverId || h.homePath)}</span>
        <span class="chips">
          <span class="chip harness-codex" title="只读接入的 Codex 本地实例">Codex</span>
          <span class="chip ${running ? 'ok' : 'bad'}">${running ? '已就绪' : '路径缺失'}</span>
          ${degradedChips(h.degraded)}
        </span>
      </div>
      <div class="meta">
        <span>${Number(h.workspaceCount) || 0} projects</span>
        <span>${Number(h.sessionCount) || 0} sessions</span>
        <span>检查 ${timeAgo(h.runtime?.checkedAt)}</span>
      </div>
      <div class="meta actions">
        <button class="primary" data-action="codex-open-home" data-home-id="${id}">打开 Codex</button>
        <button data-action="reindex" data-home-id="${id}">重新索引</button>
        <button data-action="settings" data-home-id="${id}" title="编辑实例配置">⚙ 设置</button>
      </div>
    </div>`;
}

export function renderInstanceGrid(homes) {
  if (!homes.length) return '<div class="empty">暂无实例，请添加实例</div>';
  return `<div class="rows">${homes.map((h) => {
    if (h.harness === 'codex') return codexCard(h);
    const running = h.runtime?.runtime === 'running';
    const attached = running || h.runtime?.runtime === 'unreachable';
    const id = esc(h.homeId);
    return `<div class="row">
      <div class="t">
        <span class="name">${esc(h.alias || h.serverId || h.homePath)}</span>
        <span class="chips">${versionChip(h.runtime)}<span class="chip ${running ? 'ok' : attached ? 'warn' : ''}">${running ? '已连接' : attached ? '连接不可达' : '未连接'}</span>${degradedChips(h.degraded)}</span>
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
