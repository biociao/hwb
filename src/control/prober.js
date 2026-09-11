import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sshOpts } from './ssh-opts.js';

const pExecFile = promisify(execFile);

// —— 探测模块（M6）：进程存活 / HTTP 端口 / SSH 连通 / 远端路径，均为独立可测函数 ——

// HTTP 端口响应（status < 500 视为"活着"）。
export async function httpProbe(url, timeoutMs = 3000) {
  try {
    // token 入口的重定向已能说明服务存活，无需继续下载页面；及时释放响应流。
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    try { await res.body?.cancel(); } catch { /* 释放失败不改变已收到的 HTTP 状态。 */ }
    return res.status < 500;
  } catch {
    return false;
  }
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
// 以 `~` 开头让远端 shell 展开（~/.dsh）；否则加引号防空格/注入，仅作 test -d 判断。
export async function sshPathExists(host, homePath, timeoutMs = 30_000) {
  if (!host || !homePath) return false;
  const remoteCmd = homePath.startsWith('~')
    ? `test -d ${homePath}`
    : `test -d ${JSON.stringify(homePath)}`;
  try {
    await pExecFile('ssh', [
      ...sshOpts({ host }),
      host,
      remoteCmd,
    ], { timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}
