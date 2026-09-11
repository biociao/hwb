import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sshOpts } from './ssh-opts.js';

const pExecFile = promisify(execFile);

// —— 探测模块（M6）：进程存活 / HTTP 端口 / SSH 连通 / 远端路径，均为独立可测函数 ——

// HTTP 端口响应（status < 500 视为"活着"）。
//
// 这个口径服务的是「那个端口上有没有 dsh web 在听」这类判断 —— 那里 401 **恰恰是**「在听」的证据
// （新版 dsh 的入口有 token 栅栏，裸 URL 必然 401）。要判断「这个入口用户点开能不能用」，
// 请用 probeAlive()：对用户来说 401 栅栏页面和挂了没区别。
export async function httpProbe(url, timeoutMs = 3000) {
  const status = await httpProbeStatus(url, timeoutMs);
  return status !== null && status < 500;
}

// 探测并返回 HTTP 状态码；不可达/超时/非法响应返回 null。
// 单独导出是因为「活着」与「可用」是两回事，而 httpProbe 的布尔值把状态码信息丢掉了。
export async function httpProbeStatus(url, timeoutMs = 3000) {
  try {
    // token 入口的重定向已能说明服务存活，无需继续下载页面；及时释放响应流。
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    try { await res.body?.cancel(); } catch { /* 释放失败不改变已收到的 HTTP 状态。 */ }
    return res.status;
  } catch {
    return null;
  }
}

// 鉴权感知的存活探测（Monitor 的心跳用它）：401/403 判为**不可用**。
//
// 为什么不能沿用 httpProbe：token 填错、或远端 dsh web 轮换了 token 之后，url/iframeUrl 仍然
// 指向 dsh 端口本身，于是探测每 30s 拿到一个 401 —— status < 500 ⇒ running，界面一片绿、
// iframe 里却是 401 栅栏页（审查实测：monitor.refresh() 对只有 401 的端点报 running，
// latencyMs 7）。这类实例需要的是「降级并提示重新填 token」，不是「运行中」。
export async function probeAlive(url, timeoutMs = 3000) {
  const status = await httpProbeStatus(url, timeoutMs);
  return status !== null && status < 500 && status !== 401 && status !== 403;
}

// 进程是否存活（signal 0 不发送信号，仅探测）。
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// SSH 连通性（BatchMode 免交互，超时即失败）。
// 客户端超时须 ≥ 连接策略的 ConnectTimeout：实测经 tun 的远端建连 11.7–14s，
// 原来 10s 的客户端上限会把「慢但能连上」的链路误判为不可达（并让探测反复白等）。
// 启用 ControlMaster 复用时，探测走常驻 master，耗时降到毫秒级。
export async function sshProbe(host, timeoutMs = 30_000, cmd = 'true') {
  if (!host) return false;
  try {
    await pExecFile('ssh', [
      ...sshOpts({ host }),
      host,
      cmd,
    ], { timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

// 远端 dsh home 目录是否可访问（`ssh host "test -d <path>"`）。
// 这个字符串会被**远端的登录 shell**解释，所以路径必须按字面量引用：只要 remoteHome 里有空格
// （`~/my dsh`），不加引号就会让 `test -d` 收到多个参数 → bash 以 exit 2 失败
// （binary operator expected）→ 一个本来正常的路径被判成「不可访问」而拒绝连接；
// 而 `;` / `$()` 更会被直接执行（remoteHome 只经过 trim 校验）。
//
// 引用方式必须是**单引号**：双引号里 `$(...)`、反引号、`$VAR` 仍会被解释，实测
// `"$HOME/a$(echo LEAKED)"` 会真的执行命令替换。单引号内除了 `'` 本身什么都不解释。
export async function sshPathExists(host, homePath, timeoutMs = 30_000, run = pExecFile) {
  if (!host || !homePath) return false;
  try {
    await run('ssh', [
      ...sshOpts({ host }),
      host,
      buildSshPathCommand(homePath),
    ], { timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

// POSIX 单引号引用：把内容整体放进单引号，内部的 `'` 用 `'\''` 收尾-转义-续接。
export function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// 生成远端的 `test -d` 命令。单独导出：引号处理是安全相关的，应当能被直接断言。
//
// `~` 需要由远端 shell 展开，但展开后剩下的部分必须按字面量处理。做法是**拼接**：
//   "$HOME"  +  单引号字面量
// 双引号部分只让 $HOME 展开，单引号部分不解释任何字符。实测 `"$HOME"'/x'` → `/Users/…/x`。
//
// 只支持 `~` 与 `~/…` 两种形式——与 remote.js / dshhome/remote-reader.js 的 expandHome
// 保持一致（它们同样只把开头的 `~` 换成 $HOME）。`~user/x` 这类写法在本项目里从来不是
// 受支持的输入，此前只是因为没加引号而被 shell 顺带展开；现在按字面量处理，需要跨用户
// 路径请直接写绝对路径。
export function buildSshPathCommand(homePath) {
  const p = String(homePath);
  if (/^~(?=\/|$)/.test(p)) return `test -d "$HOME"${shellSingleQuote(p.slice(1))}`;
  return `test -d ${shellSingleQuote(p)}`;
}
