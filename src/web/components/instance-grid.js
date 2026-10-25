import { currentChannel } from './endpoint-editor.js';
import {
  esc, timeAgo, isLocalToolHome, localToolKind, localToolLabel, localToolVersion, dshVersionOf,
} from '../store.js';

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

// 普通可连接 dsh 卡的版本 chip（服务端探测：本地读本机安装、远程经 SSH 问 `dsh --version`）。
//
// 取不到时**什么都不显示**：卡片上的「未连接 / 连接不可达」说的是 hwb 与这个实例的接入，
// 而版本取不到还可能是「远端没装 dsh」或「SSH 主机不通」—— 画一个「dsh —」会把两件事混成
// 一件，读者反而不知道该去查什么。版本号本身已由服务端限定成干净的版本字面量，这里仍转义。
// 服务端新增了归一化的 runtime.toolVersion 后优先用它；dshVersion 仍作为老后端的回退保留。
function versionChip(runtime) {
  const version = dshVersionOf({ runtime });
  if (!version) return '';
  return `<span class="chip ver" title="该实例上 dsh 的版本号">dsh ${esc(version)}</span>`;
}

// 本地工具实例卡（契约 docs/local-tool-harness-alignment.md §3）。
//
// Codex / WorkBuddy / 本地 dsh 只读 是同一类实例：只读本地元数据，没有进程 / 端口 / token /
// 隧道，也没有 Web 页面。此前它们各长一张卡（Codex 卡有打开动作没版本、dsh 只读卡有版本却把
// 「只读」占了状态位、时间口径一个是 checkedAt 一个是 lastIndexedAt）—— 这里统一成一段模板：
//
//   name（alias || serverId || homePath）
//     chips: [<label> <version>](chip harness-<id>) [已就绪|路径缺失] [⚠ 域降级]…
//     meta:  N projects  M sessions  索引 <timeAgo(lastIndexedAt)|尚未索引>
//     actions: [打开 <label>](primary, local-tool-open) [重新索引] [⚙ 设置]
//
// 「只读」是这类实例的类型说明，只写进身份 chip 的 title，不再占状态位。
// 身份 chip 的 class 由 harness 白名单决定（harness-codex / harness-workbuddy / harness-dsh），
// 不从 label 拼 —— label 来自服务端，只能进文本节点。
function localToolCard(h) {
  const id = esc(h.homeId);
  const runtime = h.runtime;
  const kind = localToolKind(h);
  const toolLabel = typeof runtime?.toolLabel === 'string' && runtime.toolLabel.trim()
    ? runtime.toolLabel.trim()
    : localToolLabel(h);
  const label = esc(toolLabel);
  const version = localToolVersion(h);
  const identity = version ? `${label} ${esc(version)}` : label;
  const title = `只读接入的 ${label} 本地实例（版本 ${version ? esc(version) : '未知'}）`;
  const ready = runtime?.runtime === 'running';
  return `<div class="row">
      <div class="t">
        <span class="name">${esc(h.alias || h.serverId || h.homePath)}</span>
        <span class="chips">
          <span class="chip harness-${kind}" title="${title}">${identity}</span>
          <span class="chip ${ready ? 'ok' : 'bad'}">${ready ? '已就绪' : '路径缺失'}</span>
          ${degradedChips(h.degraded)}
        </span>
      </div>
      <div class="meta">
        <span>${Number(h.workspaceCount) || 0} projects</span>
        <span>${Number(h.sessionCount) || 0} sessions</span>
        <span>${h.lastIndexedAt ? `索引 ${timeAgo(h.lastIndexedAt)}` : '尚未索引'}</span>
      </div>
      <div class="meta actions">
        <button class="primary" data-action="local-tool-open" data-home-id="${id}">打开 ${label}</button>
        <button data-action="reindex" data-home-id="${id}">重新索引</button>
        <button data-action="settings" data-home-id="${id}" title="编辑实例配置">⚙ 设置</button>
      </div>
    </div>`;
}

export function renderInstanceGrid(homes) {
  if (!homes.length) return '<div class="empty">暂无实例，请添加实例</div>';
  return `<div class="rows">${homes.map((h) => {
    if (isLocalToolHome(h)) return localToolCard(h);
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
