#!/usr/bin/env bash
# =============================================================================
# dsh-remote-web.sh——在本地一键把远端 `dsh web` 拉起来、抓回 token、建 SSH 隧道、
# 并打出可直接打开的 URL。
#
# 背景:新版 `dsh web` 每次启动都会在 stdout 打印一个带 `?token=...` 的鉴权 URL,而
# token 只存在于远端那个进程的日志里 -> 只能在远端抓。本脚本从本地 SSH 过去,
# (可选)重启远端服务,从日志抓回 token,再在本地建隧道把远端 :3080 映射到本地端口,
# 最后拼出 `http://127.0.0.1:<本地端口>/?token=...` 给你(可选自动打开浏览器)。
#
# 用法(在本地运行):
#   scripts/dsh-remote-web.sh <ssh-host> [--port 3080] [--local-port 3081]
#                                  [--log ~/.dsh/web.log] [--cmd '...'] [--open]
#                                  [--no-restart] [--token-only] [--kill-tunnel]
#                                  [--dry-run] [--verbose]
#
# 默认把「重启 + 抓 token」合并到一次 SSH 往返;`--no-restart` 则只抓当前运行实例
# 已写入日志的 token。`--token-only` 只抓 token,不建隧道。
# =============================================================================
set -euo pipefail

# --------------------------- 默认值 ------------------------------------------
REMOTE=""
REMOTE_PORT="${REMOTE_PORT:-3080}"
LOCAL_PORT="${LOCAL_PORT:-0}"                      # 0 = 自动挑空闲端口
REMOTE_LOG="${REMOTE_LOG:-$HOME/.dsh/web.log}"        # 远端日志路径
REMOTE_TARGET_HOST="${REMOTE_TARGET_HOST:-127.0.0.1}" # 隧道指向的远端绑定地址
# 远端启动命令(默认复用你的 dsh-web-cached.sh 冷启动加速封装,可改):
REMOTE_CMD="${REMOTE_CMD:-bash \$HOME/scripts/dsh-web-cached.sh web}"
KILL_PATTERN="${KILL_PATTERN:-}"                     # 兜底杀旧进程模式
OPEN_BROWSER=0
NO_RESTART=0
TOKEN_ONLY=0
KILL_TUNNEL=0
DRY_RUN=0
VERBOSE=0
# 状态文件放在**用户私有目录**里，而不是 /tmp 下的固定可预测路径：
#   · /tmp 是全局可写的，任何本地用户都能在文件不存在时抢先创建它（sticky 位只保护已存在的条目）；
#   · 旧实现会把文件内容当 PID 直接 kill，于是「内容写成 0」等于 kill 掉调用者的整个进程组，
#     而一个过期的 PID（隧道早退了、PID 被系统复用）会打死一个毫不相干的进程；
#   · 旧实现还把隧道输出重定向到固定的 /tmp 路径且不先 rm —— 谁提前放一个指向
#     ~/.ssh/authorized_keys 的符号链接，重定向就会把那个文件截成 0 字节。
# 统一放进 0700 的私有运行目录，并且 kill 之前校验「这个 PID 确实是我们的 ssh 隧道」。
RUNTIME_DIR="${DSH_REMOTE_WEB_DIR:-${XDG_RUNTIME_DIR:-$HOME/.dsh}/dsh-remote-web}"
mkdir -p "$RUNTIME_DIR" && chmod 700 "$RUNTIME_DIR" 2>/dev/null || true
TUNNEL_PID_FILE="${TUNNEL_PID_FILE:-$RUNTIME_DIR/tunnel.pid}"
TUNNEL_OUT="${TUNNEL_OUT:-$RUNTIME_DIR/tunnel.out}"
TUNNEL_ERR="${TUNNEL_ERR:-$RUNTIME_DIR/tunnel.err}"

usage() {
  printf 'dsh-remote-web.sh <ssh-host> [options]\n\n'
  cat <<'EOF'
Options:
  --port N          远端 dsh web 端口 (默认 3080)
  --local-port N    本地隧道端口 (默认自动挑空闲)
  --log PATH        远端日志路径 (默认 ~/.dsh/web.log)
  --cmd CMD         远端启动命令 (默认 bash $HOME/scripts/dsh-web-cached.sh web)
  --trusted-host H  隧道指向的远端绑定地址 (默认 127.0.0.1)
  --open            打印 URL 后调用默认浏览器打开 (macOS)
  --no-restart      不重启,只抓当前运行实例已写入日志的 token
  --token-only      只抓 token,不打隧道
  --kill-tunnel     结束之前建好的隧道(读 TUNNEL_PID_FILE)
  --dry-run         只打印将要执行的远端命令与 URL,不实际执行
  --verbose         打印调试信息
  -h, --help        显示本帮助
EOF
}

# ---- 解析参数 ---------------------------------------------------------------
# 先解析选项,非选项词首个作为 <ssh-host>(放在最后,避免被当 REMOTE)。
REMOTE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --port)         REMOTE_PORT="${2:?}"; shift 2 ;;
    --local-port)   LOCAL_PORT="${2:?}"; shift 2 ;;
    --log)          REMOTE_LOG="${2:?}"; shift 2 ;;
    --cmd)          REMOTE_CMD="${2:?}"; shift 2 ;;
    --trusted-host) REMOTE_TARGET_HOST="${2:?}"; shift 2 ;;
    --open)         OPEN_BROWSER=1; shift ;;
    --no-restart)   NO_RESTART=1; shift ;;
    --token-only)   TOKEN_ONLY=1; NO_RESTART=1; shift ;;
    --kill-tunnel)  KILL_TUNNEL=1; shift ;;
    --dry-run)      DRY_RUN=1; shift ;;
    --verbose)      VERBOSE=1; shift ;;
    -h|--help)      usage; exit 0 ;;
    -*)             echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
    *)              if [ -z "$REMOTE" ]; then REMOTE="$1"; else echo "unexpected arg: $1" >&2; usage >&2; exit 2; fi; shift ;;
  esac
done

vlog() { [ "$VERBOSE" = 1 ] && printf '[debug] %s\n' "$*" >&2 || true; }

# ---- 本地端口测试(macOS/Linux 通用:先 lsof 再 nc) --------------------------
port_free() {
  local p="$1"
  if command -v lsof >/dev/null 2>&1; then
    ! lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1 && return 0
    return 1
  fi
  if command -v nc >/dev/null 2>&1; then
    ! nc -z 127.0.0.1 "$p" >/dev/null 2>&1 && return 0
    return 1
  fi
  return 0   # 无法探测时假定空闲
}
port_ready() {
  local p="$1"
  if command -v nc >/dev/null 2>&1; then
    nc -z 127.0.0.1 "$p" >/dev/null 2>&1 && return 0
    return 1
  fi
  return 0   # 无 nc,跳过就绪探测
}
pick_free_port() {
  if [ "$LOCAL_PORT" != "0" ]; then
    if ! port_free "$LOCAL_PORT"; then
      echo "local port $LOCAL_PORT is already in use" >&2
      exit 1
    fi
    printf '%s' "$LOCAL_PORT"; return
  fi
  for cand in 3081 3082 3083 3084 6081 6082 8081 8082 8083; do
    if port_free "$cand"; then printf '%s' "$cand"; return; fi
  done
  echo "could not find a free local port" >&2; exit 1
}

# ---- 生成「远端脚本」:重启(可选)+ 等 token + 打印 token ------------------
# 参数顺序:$1=log $2=cmd $3=port $4=killp $5=norestart $6=token_only
remote_script() {
cat <<'RS'
set -e
log="$1"; cmd="$2"; port="$3"; killp="$4"; norestart="$5"; token_only="$6"

# 不重启:直接取整个日志里最新的一条 token(要求该实例的 token 已写入日志)
if [ "$token_only" = "1" ] || [ "$norestart" = "1" ]; then
  tok="$(grep -oE '\?token=[A-Za-z0-9_-]+' "$log" 2>/dev/null | tail -1 || true)"
  if [ -n "$tok" ]; then printf '%s' "$tok"; exit 0; fi
  echo "NO_TOKEN: no token found in $log" >&2
  exit 1
fi

# 重启模式:记录当前行数作为起点,只抓「本次启动之后」新增的 token
start_line=0
[ -f "$log" ] && start_line=$(wc -l < "$log" 2>/dev/null || echo 0)
if command -v fuser >/dev/null 2>&1; then fuser -k "${port}/tcp" >/dev/null 2>&1 || true; fi
if [ -n "$killp" ]; then pkill -f "$killp" >/dev/null 2>&1 || true; fi
sleep 1
# 追加写日志启动,便于保留历史并抓「本次」的新 token
nohup $cmd >> "$log" 2>&1 < /dev/null &
for i in $(seq 1 40); do
  # 字符集必须与 remote.js / launcher.js 一致（[A-Za-z0-9_-]）：真实 dsh 输出里 token 后面
  # 会跟右括号之类的标点，宽字符集会把标点并进 token，拼出的 URL 直接 401。
  tok="$(tail -n +$((start_line+1)) "$log" 2>/dev/null | grep -oE '\?token=[A-Za-z0-9_-]+' | tail -1 || true)"
  if [ -n "$tok" ]; then printf '%s' "$tok"; exit 0; fi
  sleep 1
done
echo "TIMEOUT: no fresh token in $log after 40s (tail:)" >&2
tail -n 15 "$log" >&2 || true
exit 1
RS
}

# 只回收「确实是我们那条 ssh -L 隧道」的 PID。
# 拒绝空/非数字（尤其 `0` —— kill 0 会 SIGTERM 掉调用者的整个进程组），
# 并用 ps 比对命令行，避免 PID 被复用后打死无关进程（编辑器、agent、本机 dsh web…）。
stop_tunnel() {
  [ -f "$TUNNEL_PID_FILE" ] || return 0
  local pid cmd
  pid="$(cat "$TUNNEL_PID_FILE" 2>/dev/null || true)"
  rm -f "$TUNNEL_PID_FILE"
  case "$pid" in
    ''|*[!0-9]*) echo "忽略无效的隧道 PID 记录: '${pid}'（拒绝 kill）" >&2; return 0 ;;
    0) echo "忽略 PID 0（kill 0 会杀掉整个进程组）" >&2; return 0 ;;
  esac
  # 没有 ps 就无从验证身份。宁可留着一条隧道，也不误杀一个不相干的进程 ——
  # 明确告诉用户手工确认，而不是假装回收成功。
  if ! command -v ps >/dev/null 2>&1; then
    echo "系统没有 ps，无法验证 PID $pid 的身份；为避免误杀，请手动确认后再 kill $pid" >&2
    return 0
  fi
  cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  case "$cmd" in
    *ssh*-N*-L*) kill "$pid" 2>/dev/null || true; echo "killed tunnel pid $pid" ;;
    # ps 读不到既可能是进程已退出，也可能是 ps 被限制（受限沙箱）。
    # 两种情况都不 kill，但措辞不能断言「不存在」。
    '') echo "ps 读不到 PID ${pid}（可能已退出，或 ps 被限制）——为安全起见不做 kill" >&2 ;;
    *) echo "PID $pid 现在跑的不是 ssh 隧道，拒绝 kill: $cmd" >&2 ;;
  esac
}

# ---- kill-tunnel ------------------------------------------------------------
if [ "$KILL_TUNNEL" = 1 ]; then
  stop_tunnel
  exit 0
fi

# ---- 前置校验 ---------------------------------------------------------------
[ -z "$REMOTE" ] && { echo "missing <ssh-host>: pass as first arg" >&2; exit 2; }

if [ "$DRY_RUN" = 1 ]; then
  echo "# would run on $REMOTE (bash -s <script>):"
  remote_script | sed 's/^/#    /'
  echo "# then build URL = http://127.0.0.1:<local>/?token=<captured>"
  exit 0
fi

# ---- 1) 抓 token(把远端脚本写到临时文件,经 stdin 交给 bash -s) -----------
vlog "grabbing token from $REMOTE (log=$REMOTE_LOG cmd=$REMOTE_CMD)"
TMP_RS="$(mktemp)"
remote_script > "$TMP_RS"
# ssh 会把 host 之后的**所有 argv 用空格拼成一个字符串**交给远端 shell 重新切分。
# 不逐个引用的话，默认的 REMOTE_CMD（`bash $HOME/scripts/dsh-web-cached.sh web`，含空格）
# 会把后面每个参数整体错位一格 —— 实测远端拿到的是
#   cmd=[bash] port=[$HOME/scripts/dsh-web-cached.sh] killp=[web]
# 于是：远端跑了一个裸 `bash`（永远等不到 token，40s 后超时），
# 而 `pkill -f "$killp"` 变成了 **`pkill -f web`** —— 把远端机器上任何命令行含 "web"
# 的进程都杀掉。用 bash 的 %q 逐参引用即可原样传过去（远端就是 bash -s）。
REMOTE_ARGS="$(printf '%q ' "$REMOTE_LOG" "$REMOTE_CMD" "$REMOTE_PORT" "$KILL_PATTERN" "$NO_RESTART" "$TOKEN_ONLY")"
set +e
# shellcheck disable=SC2086  # 这里就是要把逐个引用好的参数拼进远端命令行
TOKEN="$(ssh "$REMOTE" bash -s $REMOTE_ARGS < "$TMP_RS")"
SSH_RC=$?
set -e
rm -f "$TMP_RS"
if [ "$SSH_RC" -ne 0 ] || [ -z "$TOKEN" ]; then
  echo "failed to capture token from $REMOTE (rc=$SSH_RC)" >&2
  exit 1
fi
vlog "captured token fragment: ${TOKEN:0:24}..."

if [ "$TOKEN_ONLY" = 1 ]; then
  printf 'token = %s\n' "$TOKEN"
  # 这里**没有**建隧道：下面这个地址是「远端自己那个端口」，只有你在远端本机访问才有效。
  # 以前的措辞看起来像可以直接打开，而若本地恰好有别的进程占着同一个端口，--open
  # 会把这个 token 直接交给它。
  printf 'URL   = http://127.0.0.1:%s/%s   (远端地址，未建隧道；本地访问请另行建隧道或直接取 token)\n' "$REMOTE_PORT" "$TOKEN"
  exit 0
fi

# ---- 2) 建 SSH 隧道 --------------------------------------------------------
LOCAL_PORT="$(pick_free_port)"
vlog "local port = $LOCAL_PORT"
stop_tunnel   # 复用同一套校验：只回收确实是隧道的 PID
# 先删掉旧的重定向目标：固定路径 + 不先删 = 谁提前放个符号链接就能把目标文件截成 0 字节。
rm -f "$TUNNEL_OUT" "$TUNNEL_ERR"
ssh -N -L "${LOCAL_PORT}:${REMOTE_TARGET_HOST}:${REMOTE_PORT}" "$REMOTE" \
  >"$TUNNEL_OUT" 2>"$TUNNEL_ERR" &
TUNNEL_PID=$!
echo "$TUNNEL_PID" > "$TUNNEL_PID_FILE"
vlog "tunnel pid $TUNNEL_PID -> $REMOTE:$REMOTE_PORT"
tunnel_up=0
for i in $(seq 1 20); do port_ready "$LOCAL_PORT" && { tunnel_up=1; break; }; sleep 0.5; done
if [ "$tunnel_up" != 1 ]; then
  # 以前的实现不管端口有没有起来都照样打印 URL 并 exit 0 —— 用户拿到一个打不开的地址、
  # 退出码却是成功，真正的错误（ssh 的 stderr）被丢在临时文件里没人看。
  echo "SSH 隧道未就绪: 127.0.0.1:${LOCAL_PORT} 没有开始监听" >&2
  [ -s "$TUNNEL_ERR" ] && { echo "--- ssh stderr ---" >&2; tail -n 15 "$TUNNEL_ERR" >&2; }
  stop_tunnel
  exit 1
fi

# ---- 3) 打印 URL -----------------------------------------------------------
URL="http://127.0.0.1:${LOCAL_PORT}/${TOKEN}"
echo
echo "  dsh web  : $REMOTE (http://${REMOTE_TARGET_HOST}:${REMOTE_PORT})"
echo "  SSH tunnel: 127.0.0.1:${LOCAL_PORT} -> ${REMOTE_TARGET_HOST}:${REMOTE_PORT}  (pid $TUNNEL_PID)"
echo "  Open URL : $URL"
echo "  Stop     : scripts/dsh-remote-web.sh --kill-tunnel   (or kill $TUNNEL_PID)"
echo
if [ "$OPEN_BROWSER" = 1 ]; then
  command -v open >/dev/null 2>&1 && open "$URL" || echo "no 'open'; open manually: $URL"
fi
