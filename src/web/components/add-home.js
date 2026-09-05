import { esc } from '../store.js';

// 实例设置表单（编辑 alias / 远程连接参数）。
export function renderSettingsForm(home) {
  const isRemote = home.hostType === 'remote';
  return `
    <form id="settings-form" class="home-form" data-mode="${isRemote ? 'remote' : 'local'}">
      <input name="alias" placeholder="别名（可选）" value="${esc(home.alias ?? '')}" autocomplete="off">
      ${isRemote
        ? `<input name="host" placeholder="SSH 主机（别名 / user@host）" value="${esc(home.host ?? '')}" autocomplete="off" required>
           <input name="remotePort" placeholder="远程 dsh web 端口" value="${esc(home.remotePort ?? '')}" autocomplete="off" required>
           <input name="remoteHome" placeholder="远端 dsh home 路径（默认 ~/.dsh）" value="${esc(home.remoteHome ?? '')}" autocomplete="off">
           <input name="remoteCmd" placeholder="远端启动命令（默认 dsh web --port <port> --no-open）" value="${esc(home.remoteCmd ?? '')}" autocomplete="off">
           <input name="remoteLog" placeholder="远端 token 日志（默认 ~/.dsh/web.log）" value="${esc(home.remoteLog ?? '')}" autocomplete="off">
           <input name="token" placeholder="dsh web 鉴权 token（可选）" value="${esc(home.token ?? '')}" autocomplete="off">
           <div class="meta readonly"><span class="chip">token</span>
             在远端自行更新 dsh 并读取新 token 后填入此处，hwb 将直接连接、不会重启/打断远端实例。
             远端执行 <code>ssh ${esc(home.host)} "grep -oE 'token=[A-Za-z0-9_-]+' ${esc((home.remoteLog || '~/.dsh/web.log'))} | tail -1"</code> 即可取到。
             <span class="hint-strong">稳定第一：hwb 不会因连接失败主动重启实例；“重启/关闭”仅在必要时使用。</span></div>`
        : `<input name="homePath" placeholder="dsh home 路径，如 ~/.dsh" value="${esc(home.homePath)}" autocomplete="off">
           <input name="localPort" placeholder="本机 dsh web 端口（填入则直连已有实例，如 3080）" value="${esc(home.localPort ?? '')}" autocomplete="off">
           <input name="token" placeholder="dsh web 鉴权 token（与端口配合，直连已有实例）" value="${esc(home.token ?? '')}" autocomplete="off">
           <div class="meta readonly"><span class="chip">本机</span> 修改路径会迁移到同一实例（重新键控）。<br>
             填入「本机 dsh web 端口 + 鉴权 token」后，打开将**直接接入已在跑的那台实例**（同机直连、无端口转发、不新拉起）。端口留空则按原逻辑新起一台。</div>`}
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
      <input name="alias" placeholder="别名（可选）" autocomplete="off">
      <button type="submit">添加</button>
      <div class="form-msg" hidden></div>
    </form>`;
}

// First-run onboarding: no homes registered yet (§7.1 空态引导).
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
