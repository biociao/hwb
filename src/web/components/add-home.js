import { endpointEditor, endpointSelector } from './endpoint-editor.js';
import {
  esc, isLocalToolHome, localToolKind, localToolLabel, localToolHomePlaceholder,
} from '../store.js';

const DSH_HOME_PLACEHOLDER = 'dsh home 路径，如 ~/.dsh';
const DSH_HOME_DEFAULT = '~/.dsh';
const CODEX_HOME_PLACEHOLDER = localToolHomePlaceholder('codex');
const WORKBUDDY_HOME_PLACEHOLDER = localToolHomePlaceholder('workbuddy');
// 各模式自动填入的默认 home：切模式时只清理「来自别的模式的默认值」，绝不动用户手输的路径。
const DEFAULT_HOMES = new Set([DSH_HOME_DEFAULT, CODEX_HOME_PLACEHOLDER, WORKBUDDY_HOME_PLACEHOLDER]);

// 「只读本地工具」模式（codex / workbuddy / local-readonly 的 dsh）的路径占位与说明。
function localToolModeDefaults(mode) {
  if (mode === 'codex') return { home: CODEX_HOME_PLACEHOLDER, placeholder: CODEX_HOME_PLACEHOLDER };
  if (mode === 'workbuddy') return { home: WORKBUDDY_HOME_PLACEHOLDER, placeholder: WORKBUDDY_HOME_PLACEHOLDER };
  return { home: DSH_HOME_DEFAULT, placeholder: DSH_HOME_PLACEHOLDER }; // local-readonly
}

// 实例设置表单（实例名称 / 远程连接参数）。
function settingsField(name, title, value, placeholder) {
  return `<label class="config-field"><span>${esc(title)}</span><input name="${name}" placeholder="${esc(placeholder)}" value="${esc(value ?? '')}" autocomplete="off"></label>`;
}

// 本地工具设置面的说明：三种工具同构（只有 alias + homePath），差异只在读的是哪个文件。
const LOCAL_TOOL_NOTES = {
  codex: '只读读取 state_5.sqlite 与 .codex-global-state.json，不连接任何进程。',
  workbuddy: '只读读取 workbuddy.db（项目 / 会话元数据），不连接任何进程、不写库。',
  dsh: '只读读取该 home 的索引：不连接 dsh web、不需要 token；点会话时由 DSH 桌面端打开。',
};

export function renderSettingsForm(home) {
  // 本地工具实例（Codex / WorkBuddy / 本地 dsh 只读）：没有进程、端点、端口或 token。
  // 设置里只保留名称与 home 路径，否则用户会在这里找一个不存在的「接入端口」，
  // 或者以为改 endpoint 能换数据源。
  if (isLocalToolHome(home)) {
    const kind = localToolKind(home);
    const label = localToolLabel(home);
    const attrs = kind === 'dsh'
      ? 'data-mode="local-readonly" data-readonly="true"'
      : `data-mode="${kind}" data-harness="${kind}"`;
    return `
    <form id="settings-form" class="home-form" ${attrs}>
      ${settingsField('alias', '实例名称', home.alias || home.serverId, `例如 ${label} 本机`)}
      ${settingsField('homePath', `本机 ${label} home 路径`, home.homePath, localToolHomePlaceholder(kind))}
      <p class="meta readonly">${LOCAL_TOOL_NOTES[kind]}</p>
    </form>`;
  }
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

export function renderHomeForm(detected = null) {
  // 检测到的本机 dsh：给一个「只读添加」快捷入口（Codex 同款；与已有可连接实例可并存）。
  const detectedDsh = detected?.exists
    ? `<p class="hint">检测到本机 dsh home：<code>${esc(detected.path)}</code>
         <button type="button" data-action="add-detected" data-path="${esc(detected.path)}" data-readonly="true">添加为只读实例</button>
       </p>`
    : '';
  // 检测到的本机 WorkBuddy：一键注册为只读本地工具实例（与 Codex / dsh 同构）。
  const workbuddy = detected?.workbuddy;
  const detectedWorkbuddy = workbuddy?.exists
    ? `<p class="hint">检测到本机 WorkBuddy home：<code>${esc(workbuddy.path)}</code>
         <button type="button" data-action="add-detected" data-path="${esc(workbuddy.path)}" data-harness="workbuddy">添加为 WorkBuddy 实例</button>
       </p>`
    : '';
  return `
    ${detectedDsh}
    ${detectedWorkbuddy}
    <form id="add-home" class="home-form" data-mode="local">
      <select name="mode" class="home-mode" title="实例类型">
        <option value="local">本机</option>
        <option value="local-readonly">本机（只读，不连接）</option>
        <option value="remote">SSH 远程</option>
        <option value="codex">Codex（只读）</option>
        <option value="workbuddy">WorkBuddy（只读）</option>
      </select>
      <input name="homePath" placeholder="${DSH_HOME_PLACEHOLDER}" required autocomplete="off">
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
  // codex / workbuddy / local-readonly 都是「只读本地工具」：只有 homePath，
  // 没有 host / 远端端口 / token / 接入端口可言。
  const localTool = mode === 'codex' || mode === 'workbuddy' || mode === 'local-readonly';
  form.homePath.hidden = remote;
  form.homePath.placeholder = localTool ? localToolModeDefaults(mode).placeholder : DSH_HOME_PLACEHOLDER;
  form.host.hidden = !remote;
  form.remotePort.hidden = !remote;
  form.remoteHome.hidden = !remote;
  form.remoteCmd.hidden = !remote;
  form.remoteLog.hidden = !remote;
  form.token.hidden = localTool;              // 手填 token：仅可连接的 dsh 实例需要
  form.localPort.hidden = remote || localTool; // 本机直连端口：仅可连接的本机 dsh
  form.accessPort.hidden = !remote;
  form.accessPort.disabled = !remote;
  form.homePath.required = !remote;
  // 本地工具的默认 home 直接补上，否则 required 会把「直接点添加」拦在原生校验里
  // （placeholder 不算值）。切模式时只清掉「别的模式留下的默认值」，用户手输的路径不动。
  const defaultHome = localTool ? localToolModeDefaults(mode).home : null;
  if (DEFAULT_HOMES.has(form.homePath.value) && form.homePath.value !== defaultHome) form.homePath.value = '';
  if (defaultHome && !form.homePath.value) form.homePath.value = defaultHome;
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
  // Codex 是第二个 harness：检测到 ~/.codex 时额外给一个只读接入入口。它和 dsh 实例同构
  // （出现在 INSTANCES，项目/会话汇总进 RECENT 两栏），但**不启动、不连接任何进程**，
  // 只读 state_5.sqlite 与 .codex-global-state.json；data-harness 让 app.js 区分两种实例。
  const detectDshReadOnly = detected?.exists
    ? `<button data-action="add-detected" data-path="${esc(detected.path)}" data-readonly="true">
         添加检测到的 ${esc(detected.path)}（只读，不连接）
       </button>
       <p class="hint">只读实例直接读本地 home 的索引，不需要 token；点会话时由 DSH 桌面端打开。可与下面的可连接实例并存。</p>`
    : '';
  const codex = detected?.codex;
  const detectCodex = codex?.exists
    ? `<button class="primary" data-action="add-detected" data-path="${esc(codex.path)}" data-harness="codex">
         添加检测到的 ${esc(codex.path)}（Codex）
       </button>
       <p class="hint">Codex 实例只读接入本机元数据（项目 / 会话 / 累计 token），不连接任何进程。${codex.looksLikeCodexHome ? '' : '该目录缺少 state_5.sqlite 或 .codex-global-state.json —— 仍可添加，索引会标记 degraded。'}</p>`
    : '';
  // WorkBuddy 是第三个本地工具 harness：检测到 ~/.workbuddy 时给同一个只读接入入口。
  const workbuddy = detected?.workbuddy;
  const detectWorkbuddy = workbuddy?.exists
    ? `<button data-action="add-detected" data-path="${esc(workbuddy.path)}" data-harness="workbuddy">
         添加检测到的 ${esc(workbuddy.path)}（WorkBuddy）
       </button>
       <p class="hint">WorkBuddy 实例只读接入 workbuddy.db 里的项目 / 会话元数据，不连接任何进程、不写库。${workbuddy.looksLikeWorkbuddy ? '' : '该目录缺少 workbuddy.db —— 仍可添加，索引会标记 degraded。'}</p>`
    : '';
  return `
    <section class="onboarding">
      <h2>欢迎使用 hwb</h2>
      <p>hwb 读取 dsh home 目录（workspace / 会话投影 / 模型 tier / provider），构建本地索引并在此展示工作台。只读，不修改任何 dsh 文件。</p>
      <p>也可以只读接入本机 Codex（ChatGPT 桌面版）或 WorkBuddy 的元数据，把它们的项目与会话汇总到同一张工作台。</p>
      <p>先添加一个本地 dsh home，或通过 SSH 隧道接入远程 dsh 实例：</p>
      ${detect}
      ${detectDshReadOnly}
      ${detectCodex}
      ${detectWorkbuddy}
      ${renderHomeForm()}
    </section>`;
}
