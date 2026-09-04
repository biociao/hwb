import { spawn } from 'node:child_process';

// —— 远程 dsh web 生命周期(§5.4):「启动 / 重启 / 停止」 + 抓取新版 token ——
// 把 dsh-remote-web.sh 的算法原样搬进 Node:用一次 `ssh host bash -s -- args`
// 在【远端】拉起 dsh web 并抓回 stdout 里的 `?token=...`,供 hwb 拼 token URL。
// 完整 token URL 由 Launcher 负责(建隧道后拼 `http://127.0.0.1:<local>/<token>`)。

const SSHO = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];
const DEFAULT_TIMEOUT = 90_000;     // 远端脚本整体超时(ms)
const TOKEN_WAIT_SECONDS = 40;      // 远端 poll 日志等 token 的秒数

/** 在远端执行 `bash -s -- args`,stdin 写脚本,返回 { code, stdout, stderr }。 */
function sshBash(host, script, args = [], timeoutMs = DEFAULT_TIMEOUT) {
  if (!host) return Promise.resolve({ code: -2, stdout: '', stderr: 'no host' });
  return new Promise((resolve) => {
    // 关键:ssh 会把「远程命令」交给远端 shell 重新按空白分段。含空格的命令(如
    // `dsh --profile web --port 3080`)必须用双引号括成【一个】参数,否则会被拆开,
    // 导致 $3=$cmd 变成 `dsh`、$4 变成 `--profile`。这里用 JSON.stringify 给每个参数
    // 加双引号。双引号内 $HOME 等变量会在远端展开(用户填的 wrapper 路径)。
    const remoteCmd = ['bash', '-s', '--', ...args.map((a) => JSON.stringify(String(a)))].join(' ');
    const proc = spawn('ssh', [...SSHO, host, remoteCmd], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve({ code: -1, stdout: stdout.trim(), stderr: `${stderr}\n[ssh bash timed out after ${timeoutMs}ms]`.trim() });
    }, timeoutMs);
    proc.stdout.on('data', (d) => { stdout += d; if (stdout.length > 64 * 1024) stdout = stdout.slice(-64 * 1024); });
    proc.stderr.on('data', (d) => { stderr += d; if (stderr.length > 64 * 1024) stderr = stderr.slice(-64 * 1024); });
    proc.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }); });
    proc.on('error', (e) => { clearTimeout(timer); resolve({ code: -2, stdout: stdout.trim(), stderr: String(e.message) }); });
    proc.stdin.on('error', () => {});
    proc.stdin.write(script);
    proc.stdin.end();
  });
}

// 远端启动脚本(驻留于远端 shell 自身变量,避免与 JS 模板插值冲突)。
// 参数顺序:$1=port $2=log $3=cmd $4=pollSeconds $5=mode(ensure|restart)
const REMOTE_START = String.raw`
log="$2"; port="$1"; cmd="$3"; t="$4"; mode="$5"
# SSH 非交互会话往往缺少 nvm/本地 bin 目录(如 dsh 装在 v24.15.0/bin 而 PATH 指向旧版本),
# 导致 dsh 找不到;把常见位置加进 PATH 再启动。
for d in "$HOME/.nvm/versions/node/"*/bin "$HOME/.npm-global/bin" "$HOME/.local/bin" "$HOME/bin" "/usr/local/bin"; do
  [ -d "$d" ] || continue
  case ":$PATH:" in *":$d:"*) ;; *) PATH="$d:$PATH";; esac
done
listening() { { ss -tln 2>/dev/null || netstat -tln 2>/dev/null; } | grep -E "[.:]$port[[:space:]]" >/dev/null 2>&1; }
killport() { if command -v fuser >/dev/null 2>&1; then fuser -k "$port/tcp" >/dev/null 2>&1 || true; sleep 1; fi; }
# ensure + 已在跑且日志有 token -> 直接复用,不动它
if [ "$mode" = "ensure" ] && listening; then
  tok="$(grep -o '?token=[^ ]*' "$log" 2>/dev/null | tail -1 || true)"
  if [ -n "$tok" ]; then printf '%s' "$tok"; exit 0; fi
fi
start_line=0
[ -f "$log" ] && start_line="$(wc -l < "$log" 2>/dev/null || echo 0)"
if [ "$mode" = "restart" ] || listening; then killport; fi
# 启动(追加写日志,便于抓本次新 token;start_line 之前的旧 token 会被排除)
# 用 eval 让 $cmd 里的 $HOME(用户填的 wrapper 路径)在远端展开
eval "nohup $cmd >> \"$log\" 2>&1 < /dev/null &"
for i in $(seq 1 "$t"); do
  tok="$(tail -n +$((start_line+1)) "$log" 2>/dev/null | grep -o '?token=[^ ]*' | tail -1 || true)"
  if [ -n "$tok" ]; then printf '%s' "$tok"; exit 0; fi
  sleep 1
done
# 未抓到 token(旧版 dsh 不打印 token):仍返回 0,让上层用无 token 的 URL 兜底
printf '__NO_TOKEN__'
`;

// 抓取/保证远端 dsh web 在跑并带回 token(或 __NO_TOKEN__)。home: { host, remotePort, remoteLog?, remoteCmd? }
async function ensureRemoteToken(home) {
  const r = await sshBash(home.host, REMOTE_START, remoteArgs(home, 'ensure'));
  return r.code === 0 ? r.stdout : throwSsh(r, '启动远程 dsh web');
}

// 重启远端 dsh web 并带回新 token。
async function restartRemoteToken(home) {
  const r = await sshBash(home.host, REMOTE_START, remoteArgs(home, 'restart'));
  return r.code === 0 ? r.stdout : throwSsh(r, '重启远程 dsh web');
}

// 停止远端 dsh web(按端口 kill,尽力而为)。
async function stopRemote(home) {
  const script = `#!/bin/bash\nport="$1"\nif command -v fuser >/dev/null 2>&1; then fuser -k "$port/tcp" >/dev/null 2>&1 || true; echo killed; exit 0; fi\necho "no-fuser"`;
  const r = await sshBash(home.host, script, [String(home.remotePort)], 20_000);
  if (r.code !== 0) throw new Error(`停止远程 dsh web 失败(${home.host}:${home.remotePort}): ${r.stderr || r.stdout}`);
  return r.stdout;
}

function remoteArgs(home, mode) {
  const port = String(home.remotePort);
  // 日志路径:把开头的 ~ 换成 $HOME——双引号传参时 $HOME 会在远端展开,~ 不会。
  const log = (home.remoteLog || '~/.dsh/web.log').replace(/^~(?=\/|$)/, '$HOME');
  // 新版 dsh 要求显式 `--profile web`(不再接受裸 `dsh web`);旧版也兼容该写法。
  const cmd = home.remoteCmd || `dsh --profile web --port ${home.remotePort} --no-open`;
  return [port, log, cmd, String(TOKEN_WAIT_SECONDS), mode];
}

function throwSsh(r, what) {
  const reason = (r.stderr || r.stdout || '').trim().split('\n').pop();
  throw new Error(`${what} 失败(${r.code}): ${reason || 'ssh 返回异常'}`);
}

// —— 暴露(供 Launcher 使用)——
export { ensureRemoteToken, restartRemoteToken, stopRemote };
