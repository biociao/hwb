import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pExecFile = promisify(execFile);

// —— 探测模块（M6）：进程存活 / HTTP 端口 / SSH 连通 / 远端路径，均为独立可测函数 ——

// HTTP 端口响应（status < 500 视为"活着"）。
export async function httpProbe(url, timeoutMs = 3000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
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
export async function sshProbe(host, timeoutMs = 10_000, cmd = 'true') {
  if (!host) return false;
  try {
    await pExecFile('ssh', [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=10',
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
export async function sshPathExists(host, homePath, timeoutMs = 15_000) {
  if (!host || !homePath) return false;
  const remoteCmd = homePath.startsWith('~')
    ? `test -d ${homePath}`
    : `test -d ${JSON.stringify(homePath)}`;
  try {
    await pExecFile('ssh', [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=10',
      host,
      remoteCmd,
    ], { timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}
