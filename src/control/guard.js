import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pExecFile = promisify(execFile);

// —— 进程指纹校验（M6·防误杀）——
// 在 kill 前确认目标确实是"我们自己拉起、且仍存活"的子进程，避免：
//   · 子进程已退出、pid 被系统复用 → 误杀无关进程；
//   · 依赖 `ps` 的命令签名校验在受限环境下不可靠。
// 作为"自主选择"而非继承法则。

// 主指纹：我们持有 ChildProcess 句柄，且它仍未退出。
// 判据必须同时看 exitCode 与 signalCode —— 被信号杀掉的子进程（SIGKILL / OOM killer / SIGTERM）
// 保持 exitCode === null，只设 signalCode。原实现只判 exitCode，于是「已被信号杀掉」的句柄
// 仍被判成存活：与 Launcher.status() 的判据（两个字段都看）不一致，
// 也让 stop() 的返回值对「被信号终止」这种情况说谎。
export function fingerprint(proc) {
  return !!proc && proc.exitCode === null && proc.signalCode == null;
}

// 可选：从启动参数构造该进程应有的命令签名（供 ps 校验时的补充判断，需 ps 可用）。
export function expectedCommand({ kind }) {
  if (kind === 'ssh') return /(?:\bssh\b)[\s\S]*-N\b/; // ssh 隧道（可带路径前缀 + `-N`）
  return /\bdsh\b.*\bweb\b/; // 本地 dsh web 命令含 `dsh ... web`
}

// 可选：ps 校验 pid 处的命令是否仍匹配预期签名。ps 不可用/失败时返回 false（不阻塞主指纹）。
export async function verifyProcess(pid, { kind } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    const { stdout } = await pExecFile('ps', ['-o', 'command=', '-p', String(pid)]);
    const cmd = stdout.trim();
    if (!cmd) return false;
    if (kind && !expectedCommand({ kind }).test(cmd)) return false;
    return true;
  } catch {
    return false;
  }
}
