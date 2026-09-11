import { endpointEditor, endpointSelector } from './endpoint-editor.js';
import { esc } from '../store.js';

// 实例设置表单（实例名称 / 远程连接参数）。
function settingsField(name, title, value, placeholder) {
  return `<label class="config-field"><span>${esc(title)}</span><input name="${name}" placeholder="${esc(placeholder)}" value="${esc(value ?? '')}" autocomplete="off"></label>`;
}

export function renderSettingsForm(home) {
  const isRemote = home.hostType === 'remote';
  return `
    <form id="settings-form" class="home-form" data-mode="${isRemote ? 'remote' : 'local'}">
      ${settingsField('alias', '实例名称', home.alias || home.serverId, '例如 CMS')}
      ${isRemote ? `<label class="config-field"><span>本地接入端口</span><input name="accessPort" type="number" min="1" max="65535" step="1" value="${esc(home.accessPort ?? '')}" placeholder="自动分配并保持"></label>
      <p class="meta readonly">用于 SSH 远程实例的 hwb 页面接入。留空时自动分配并保存，重连与重启 hwb 后复用；更改前请先断开实例。</p>` : ''}
      ${isRemote
        ? `${settingsField('remoteHome', '远端 dsh home 路径', home.remoteHome, '默认 ~/.dsh')}
           ${settingsField('remoteCmd', '远端启动命令', home.remoteCmd, '留空使用默认启动命令')}
           ${settingsField('remoteLog', '远端 token 日志', home.remoteLog, '默认 ~/.dsh/web.log')}
           <p class="meta readonly">Token 可在下方按端点填写；留空时尝试从远端日志读取。</p>`
        : `${settingsField('homePath', '本机 dsh home 路径', home.homePath, '例如 ~/.dsh')}
           <p class="meta readonly">直接使用本机 dsh web 的服务端口，不经过转发；没有端点时启动本机 dsh web。</p>`}
      ${endpointEditor(home)}
      ${endpointSelector(home)}
    </form>`;
}

export function renderHomeForm() {
  return `
    <form id="add-home" class="home-form" data-mode="local">
      <select name="mode" class="home-mode" title="实例类型">
        <option value="local">本机</option>
        <option value="remote">SSH 远程</option>
      </select>
      <input name="homePath" placeholder="dsh home 路径，如 ~/.dsh" required autocomplete="off">
      <input name="host" placeholder="SSH 主机（别名 / user@host）" autocomplete="off" hidden>
      <input name="remotePort" placeholder="远程 dsh web 端口" autocomplete="off" hidden>
      <input name="remoteHome" placeholder="远端 dsh home 路径（默认 ~/.dsh）" autocomplete="off" hidden>
      <input name="remoteCmd" placeholder="远端启动命令（默认 dsh web --port <port> --no-open）" autocomplete="off" hidden>
      <input name="remoteLog" placeholder="远端 token 日志（默认 ~/.dsh/web.log）" autocomplete="off" hidden>
      <input name="localPort" placeholder="本机 dsh web 端口（可选，填入则直连已有实例）" autocomplete="off">
      <input name="token" placeholder="dsh web 鉴权 token（可选，填入直连）" autocomplete="off">
      <input name="alias" placeholder="实例名称（可选）" aria-label="实例名称" autocomplete="off">
      <input name="accessPort" type="number" min="1" max="65535" step="1" placeholder="本地接入端口（自动分配并保持）" aria-label="本地接入端口" hidden disabled>
      <button type="submit">添加</button>
      <div class="form-msg" hidden></div>
    </form>`;
}

// First-run onboarding: no homes registered yet (§7.1 空态引导).
// 本机 / SSH 远程 模式的字段显隐与必填切换。
//
// 单独导出是必须的：这些属性是**值之外**的状态，只在 change 处理器里设置，
// 而 dashboard 每次 SSE 重建都会生成一个「本机」布局的新表单 —— 恢复草稿时若不重放这个函数，
// 就会出现「select 显示 SSH 远程、host/port 仍隐藏、而空 homePath 仍 required」的表单，
// 原生校验直接拦下提交（submit 事件根本不触发）。
export function applyHomeMode(form, mode) {
  const remote = mode === 'remote';
  form.homePath.hidden = remote;
  form.host.hidden = !remote;
  form.remotePort.hidden = !remote;
  form.remoteHome.hidden = !remote;
  form.remoteCmd.hidden = !remote;
  form.remoteLog.hidden = !remote;
  form.token.hidden = false;        // 手填 token：本机/远程直连通用
  form.localPort.hidden = remote;   // 本机直连端口：仅本机模式
  form.accessPort.hidden = !remote;
  form.accessPort.disabled = !remote;
  form.homePath.required = !remote;
  form.host.required = remote;
  form.remotePort.required = remote;
  return mode;
}

export function renderOnboarding(detected) {
  const detect = detected?.exists
    ? `<button class="primary" data-action="add-detected" data-path="${esc(detected.path)}">
         添加检测到的 ${esc(detected.path)}
       </button>
       ${detected.looksLikeDshHome ? '' : '<p class="hint">该目录存在，但缺少 storages/workspace.json —— 仍可添加，索引会标记 degraded。</p>'}`
    : `<p class="hint">未检测到默认的 ~/.dsh 目录，请手动指定路径（或添加一个 SSH 远程实例）。</p>`;
  return `
    <section class="onboarding">
      <h2>欢迎使用 hwb</h2>
      <p>hwb 读取 dsh home 目录（workspace / 会话投影 / 模型 tier / provider），构建本地索引并在此展示工作台。只读，不修改任何 dsh 文件。</p>
      <p>先添加一个本地 dsh home，或通过 SSH 隧道接入远程 dsh 实例：</p>
      ${detect}
      ${renderHomeForm()}
    </section>`;
}
