import { spawn } from 'node:child_process';
import { logger } from '../lib/logger.js';
import { sshOpts, withConnectRetry } from './ssh-opts.js';

const log = logger('remote');

// —— 远程 dsh web 生命周期(§5.4):「启动 / 重启 / 停止」 + 抓取新版 token ——
// 把 dsh-remote-web.sh 的算法原样搬进 Node:用一次 `ssh host bash -s -- args`
// 在【远端】拉起 dsh web 并抓回 stdout 里的 `?token=...`,供 hwb 拼 token URL。
// 完整 token URL 由 Launcher 负责(建隧道后拼 `http://127.0.0.1:<local>/<token>`)。

// 连接策略统一由 ssh-opts 提供：放宽 ConnectTimeout（高延迟链路）、加保活、启用复用。
// 原实现硬编码 ConnectTimeout=10，实测经 tun 的远端建连需 11.7–14.0s，导致脚本化连接
// 必然 255 超时（而手动 ssh 无上限故能成功）——见 ssh-opts.js 的说明。
const DEFAULT_TIMEOUT = 90_000;     // 远端脚本整体超时(ms)
const TOKEN_WAIT_SECONDS = 40;      // 远端 poll 日志等 token 的秒数

/**
 * 在远端执行 `bash -s -- args`,stdin 写脚本,返回 { code, stdout, stderr }。
 * 注意:stdin 只能用来传脚本本身。bash 会把 stdin 里脚本之后的字节当命令继续执行
 * (实测:数据会被当成“……: command not found”),所以大量数据不能走这条 stdin——
 * 请改用命令行参数分片传输(见 src/lib/file-preview.js 的远端上传)。
 *
 * 连接级瞬时失败（握手超时 / mux 套接字失效 / 链路抖动）会按退避重试，`retries: 0` 可关闭
 * （测试注入 fake spawn 时需要保持单次调用语义）。
 */
function sshBash(host, script, args = [], timeoutMs = DEFAULT_TIMEOUT, { maxStdoutBytes = 64 * 1024, spawnProcess = spawn, retries = 2 } = {}) {
  if (!host) return Promise.resolve({ code: -2, stdout: '', stderr: 'no host' });
  // 关键:ssh 会把「远程命令」交给远端 shell 重新按空白分段。含空格的命令(如
  // `dsh --profile web --port 3080`)必须用双引号括成【一个】参数,否则会被拆开,
  // 导致 $3=$cmd 变成 `dsh`、$4 变成 `--profile`。这里用 JSON.stringify 给每个参数
  // 加双引号。双引号内 $HOME 等变量会在远端展开(用户填的 wrapper 路径)。
  const remoteCmd = ['bash', '-s', '--', ...args.map((a) => JSON.stringify(String(a)))].join(' ');
  const attempt = () => new Promise((resolve) => {
    const startedAt = Date.now();
    let proc;
    try {
      proc = spawnProcess('ssh', [...sshOpts({ host }), host, remoteCmd], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      // spawn **同步**抛错（例如参数里含 NUL → ERR_INVALID_ARG_VALUE，或 cwd/env 非法）。
      // 异步的 ENOENT 由下面的 proc.on('error') 处理，但同步抛错会变成一次 rejection：
      // sshBash 的约定是「失败也用返回值表达」，rejection 会绕过所有调用方的 code 检查，
      // 冒成未处理拒绝。这里统一成返回值（-2，与 spawn 失败同码）。
      resolve({ code: -2, stdout: '', stderr: `ssh spawn failed: ${error?.message ?? String(error)}`, elapsedMs: Date.now() - startedAt });
      return;
    }
    let stdout = '';
    let stdoutBytes = 0;
    let overflow = false;
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve({ code: -1, stdout: stdout.trim(), stderr: `${stderr}\n[ssh bash timed out after ${timeoutMs}ms]`.trim(), elapsedMs: Date.now() - startedAt, timedOutByClient: true });
    }, timeoutMs);
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => {
      if (overflow) return;
      stdoutBytes += Buffer.byteLength(d);
      if (stdoutBytes > maxStdoutBytes) {
        overflow = true;
        stdout = '';
        clearTimeout(timer);
        resolve({ code: -3, stdout: '', stderr: `ssh stdout exceeded ${maxStdoutBytes} bytes; output discarded`, elapsedMs: Date.now() - startedAt });
        proc.kill('SIGKILL');
        return;
      }
      stdout += d;
    });
    proc.stderr.on('data', (d) => { stderr += d; if (stderr.length > 64 * 1024) stderr = stderr.slice(-64 * 1024); });
    proc.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout: stdout.trim(), stderr: stderr.trim(), elapsedMs: Date.now() - startedAt }); });
    proc.on('error', (e) => { clearTimeout(timer); resolve({ code: -2, stdout: stdout.trim(), stderr: String(e.message), elapsedMs: Date.now() - startedAt }); });
    proc.stdin.on('error', () => {});
    proc.stdin.write(script);
    proc.stdin.end();
  });
  return withConnectRetry(async () => {
    const r = await attempt();
    // 客户端整体超时（-1）重试无意义：那不是连接级故障，而是远端脚本本身跑太久。
    return { ...r, ok: r.code === 0 || r.timedOutByClient === true || r.code === -3 };
  }, { retries }).then((r) => {
    if (!r.ok) log.warn('ssh 连接失败（重试后仍失败）', { host, code: r.code, elapsedMs: r.elapsedMs, stderr: (r.stderr || '').split('\n').pop() });
    return r;
  });
}

// 远端启动脚本(驻留于远端 shell 自身变量,避免与 JS 模板插值冲突)。
// 参数顺序:$1=port $2=log $3=cmd $4=pollSeconds $5=mode(ensure|restart)
//
// 向下兼容说明(旧版 dsh 不打印 token,如 v0.1.1):
//   · ensure + 端口已监听但日志里抓不到 token → 直接返回 __NO_TOKEN__ 让上层用「裸 URL」兜底,
//     绝不像旧逻辑那样 killport 再重启——那会打断一个健康的旧版实例,且重启后可能起不来
//     (这正是「远程连 v0.1.1 反而报错」的根因)。
//   · 启动后若日志出现「带 http 但不带 ?token=」的 URL 行 → 判定为旧版,立即返回 __NO_TOKEN__,
//     而不是干等满整个 poll 窗口(旧逻辑会白等 40s,前端若设了更短的 timeout 就会报错)。
const REMOTE_START = String.raw`
log="$2"; port="$1"; cmd="$3"; t="$4"; mode="$5"
# SSH 非交互会话往往缺少 nvm/本地 bin 目录(如 dsh 装在 v24.15.0/bin 而 PATH 指向旧版本),
# 导致 dsh 找不到;把常见位置加进 PATH 再启动。
for d in "$HOME/.nvm/versions/node/"*/bin "$HOME/.npm-global/bin" "$HOME/.local/bin" "$HOME/bin" "/usr/local/bin"; do
  [ -d "$d" ] || continue
  case ":$PATH:" in *":$d:"*) ;; *) PATH="$d:$PATH";; esac
done
# 端口监听检测 / 回收。必须跨 Linux 与 BSD(macOS) 远端都能用:
#   · 原生实现只用 ss + netstat -tln + fuser —— 三者都是 Linux 专有。远端若是 macOS,
#     listening() 恒为 false、killport() 是空操作:ensure 模式于是跳过「复用已在跑的服务」
#     又去起一个 dsh(端口被占起不来),日志轮询等满 40s 拿到 __NO_TOKEN__,
#     最后 hwb 却把这个实例报成 running —— 仪表盘一片绿,iframe 里是 401。
#   · lsof 在 macOS 与 Linux 上都有,-nP -iTCP:<port> -sTCP:LISTEN 的输出形态也一致,
#     所以优先用它;lsof 不存在时才退回 ss/netstat。
#     (旧脚本 scripts/dsh-remote-web.sh 早就因为同样的原因用了 lsof。)
listening() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 && return 0
    return 1
  fi
  { ss -tln 2>/dev/null || netstat -tln 2>/dev/null; } | grep -E "[.:]$port[[:space:]]" >/dev/null 2>&1
}
killport() {
  if command -v lsof >/dev/null 2>&1; then
    pids="$(lsof -t -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
    if [ -n "$pids" ]; then
      # 不用 xargs(BSD 的 xargs 没有 -r),逐个 kill 才是可移植写法。
      for p in $pids; do kill "$p" >/dev/null 2>&1 || true; done
      sleep 1
      return 0
    fi
  fi
  if command -v fuser >/dev/null 2>&1; then fuser -k "$port/tcp" >/dev/null 2>&1 || true; sleep 1; fi
}
# ensure + 已在跑:若日志有 token 则复用;否则(旧版 dsh / 日志未写 token)不动它,返回裸 URL 哨兵。
if { [ "$mode" = "ensure" ] || [ "$mode" = "connect" ]; } && listening; then
  tok="$(grep -oE '\?token=[A-Za-z0-9_-]+' "$log" 2>/dev/null | tail -1 || true)"
  if [ -n "$tok" ]; then printf '%s' "$tok"; exit 0; fi
  printf '__NO_TOKEN__'; exit 0
fi
[ "$mode" = "connect" ] && { printf 'endpoint is not listening\n' >&2; exit 1; }
start_line=0
[ -f "$log" ] && start_line="$(wc -l < "$log" 2>/dev/null || echo 0)"
if [ "$mode" = "restart" ] || listening; then killport; fi
# 启动(追加写日志,便于抓本次新 token;start_line 之前的旧 token 会被排除)
# 用 eval 让 $cmd 里的 $HOME(用户填的 wrapper 路径)在远端展开
eval "nohup $cmd >> \"$log\" 2>&1 < /dev/null &"
for i in $(seq 1 "$t"); do
  new_lines="$(tail -n +$((start_line+1)) "$log" 2>/dev/null || true)"
  # 新版本:抓到带 token 的 URL 行 → 直接返回 token 片段(优先判定)。
  # 注意 charset 必须与本地 captureDshToken 对齐([A-Za-z0-9_-]),否则会把行尾的右括号等
  # 标点误并进 token(如 ?token=xxx)),导致拼出的 URL 鉴权失败。
  tok="$(printf '%s' "$new_lines" | grep -oE '\?token=[A-Za-z0-9_-]+' | tail -1 || true)"
  if [ -n "$tok" ]; then printf '%s' "$tok"; exit 0; fi
  # 向下兼容:出现「带 http 但不带 ?token=」的 URL 行 → 旧版 dsh,立即用裸 URL 兜底,不再等满窗口。
  if printf '%s' "$new_lines" | grep -q 'dsh web: .*http'; then printf '__NO_TOKEN__'; exit 0; fi
  sleep 1
done
# 未抓到 token(旧版 dsh 不打印 URL 行):仍返回 0,让上层用无 token 的 URL 兜底
printf '__NO_TOKEN__'
`;

// 抓取/保证远端 dsh web 在跑并带回 token(或 __NO_TOKEN__)。home: { host, remotePort, remoteLog?, remoteCmd? }
async function ensureRemoteToken(home) {
  const r = await sshBash(home.host, REMOTE_START, remoteArgs(home, home.connectOnly ? 'connect' : 'ensure'));
  return r.code === 0 ? r.stdout : throwSsh(r, '启动远程 dsh web', home);
}

// 重启远端 dsh web 并带回新 token。
async function restartRemoteToken(home) {
  const r = await sshBash(home.host, REMOTE_START, remoteArgs(home, 'restart'));
  return r.code === 0 ? r.stdout : throwSsh(r, '重启远程 dsh web', home);
}

// 停止远端 dsh web(按端口 kill,尽力而为)。
async function stopRemote(home) {
  const script = `#!/bin/bash\nport="$1"\nif command -v fuser >/dev/null 2>&1; then fuser -k "$port/tcp" >/dev/null 2>&1 || true; echo killed; exit 0; fi\necho "no-fuser"`;
  const r = await sshBash(home.host, script, [String(home.remotePort)], 20_000);
  if (r.code !== 0) {
    log.error('停止远程 dsh web 失败', { homeId: home.homeId, host: home.host, remotePort: home.remotePort, code: r.code, stderr: r.stderr, stdout: r.stdout });
    throw new Error(`停止远程 dsh web 失败(${home.host}:${home.remotePort}): ${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

// 默认远端启动命令。向下兼容：用「裸 `dsh web` 别名」(新版等价于 `--profile web`，旧版 v0.1.x
// 原生支持)，并显式 `--port` 绑定到隧道目标端口。不传 `--profile` 与 `--no-open`，原因：
//   · `--profile web` 是 ≥0.1.2-rc.1 的新写法；旧版 v0.1.1 会把它当成未知选项直接退场，
//     导致 web 起不来 → 远端 dsh web 不可达（这正是「远程连 v0.1.1 反而报错」的另一个根因）。
//   · `--no-open` 同样是新旗标；远端经 SSH 拉起时 web 对无 TTY 会话会自动抑制浏览器打开，
//     所以不必依赖它（旧版没有它反而因未知选项而失败）。
export function defaultRemoteCmd(port) {
  return `dsh web --port ${port}`;
}

function remoteArgs(home, mode) {
  const port = String(home.remotePort);
  // 日志路径:把开头的 ~ 换成 $HOME——双引号传参时 $HOME 会在远端展开,~ 不会。
  const log = (home.remoteLog || '~/.dsh/web.log').replace(/^~(?=\/|$)/, '$HOME');
  // 默认用向下兼容的 `dsh web --port N`；用户显式配置的 remoteCmd 优先（原样交给远端）。
  const cmd = home.remoteCmd || defaultRemoteCmd(home.remotePort);
  return [port, log, cmd, String(TOKEN_WAIT_SECONDS), mode];
}

function throwSsh(r, what, home) {
  const reason = (r.stderr || r.stdout || '').trim().split('\n').pop();
  // 记录完整 ssh stderr/stdout + 目标 host，便于排查认证/可达性问题。
  log.error(`${what} 失败`, {
    host: home?.host, remotePort: home?.remotePort, code: r.code,
    stderr: r.stderr, stdout: r.stdout, msg: what,
  });
  throw new Error(`${what} 失败(${r.code}): ${reason || 'ssh 返回异常'}`);
}

// —— 实例配置手填 token 规范化（稳定第一·自服务直连，见「token 栏」原则）——
// 用户已更新远端 dsh web 后，往往已经拿到新 token；在此把手填的 token 规范化成拼 URL 用的
// `?token=...` 片段。兼容三种粘贴形态：
//   · 完整 URL：`http://host:port/?token=xyz (LAN: ...)` → 截取 `?token=xyz`；
//   · `token=xyz` 或 `?token=xyz` → 原样形式，取 `?token=xyz`；
//   · 裸 `xyz` → 补成 `?token=xyz`。
// 空 / 空白 / `__NO_TOKEN__`（旧版哨兵）→ null，表示「无手填 token，走远程抓取兜底」。
// 只接受 `[A-Za-z0-9_-]` 字符集（与本地 captureDshToken / 远端 grep 正则一致）。
export function normalizeWebToken(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (!s || s === '__NO_TOKEN__') return null;
  const m = s.match(/(?:\?token=|token=)([A-Za-z0-9_-]+)/);
  if (m) return `?token=${m[1]}`;
  if (/^[A-Za-z0-9_-]+$/.test(s)) return `?token=${s}`;
  return null; // 无法识别（可能含噪音/换行），不猜，交给远端抓取流程
}

// —— 用户自助命令提示（稳定第一·hwb 不主动打断远端实例）——
// 当远端 dsh web 不可达 / 远端 home 不可访问时，把【自服务】命令拼进报错，让用户自行在远端
// 检查/更新/重启实例，而不是由 hwb 去 killport/重启。cmd/log 缺省用与 remoteArgs 相同的兜底，
// 保证提示与实际连接参数一致。
export function selfServiceHint({ host, remotePort, remoteCmd, remoteLog }) {
  if (!host) return '';
  const port = Number(remotePort) || 0;
  const log = (remoteLog || '~/.dsh/web.log').replace(/^~(?=\/|$)/, '$HOME');
  const cmd = remoteCmd || (port ? `dsh web --port ${port}` : 'dsh web');
  const lines = [];
  if (port) lines.push(`ssh ${host} "${cmd}"            # 在远端手动启动/重启 dsh web`);
  lines.push(`ssh ${host} "grep -oE 'token=[A-Za-z0-9_-]+' ${log} | tail -1"   # 读取最新鉴权 token`);
  lines.push(`ssh ${host} "test -d ~/.dsh && echo ok"     # 确认远端 dsh home 存在（或改 remoteHome）`);
  return `\n可自行在远端执行（hwb 不会主动打断实例）：\n  ${lines.join('\n  ')}`;
}

// —— 暴露(供 Launcher 使用)—— REMOTE_START / defaultRemoteCmd 亦导出,便于做回归测试。
export { ensureRemoteToken, restartRemoteToken, stopRemote, REMOTE_START, sshBash };
