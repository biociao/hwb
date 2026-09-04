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
TUNNEL_PID_FILE="${TUNNEL_PID_FILE:-/tmp/.dsh-remote-web.tunnel}"

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
  tok="$(grep -o '?token=[^ ]*' "$log" 2>/dev/null | tail -1 || true)"
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
  tok="$(tail -n +$((start_line+1)) "$log" 2>/dev/null | grep -o '?token=[^ ]*' | tail -1 || true)"
  if [ -n "$tok" ]; then printf '%s' "$tok"; exit 0; fi
  sleep 1
done
echo "TIMEOUT: no fresh token in $log after 40s (tail:)" >&2
tail -n 15 "$log" >&2 || true
exit 1
RS
}

# ---- kill-tunnel ------------------------------------------------------------
if [ "$KILL_TUNNEL" = 1 ]; then
  if [ -f "$TUNNEL_PID_FILE" ]; then
    pid="$(cat "$TUNNEL_PID_FILE" 2>/dev/null || true)"
    if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; echo "killed tunnel pid $pid"; fi
    rm -f "$TUNNEL_PID_FILE"
  fi
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
set +e
TOKEN="$(ssh "$REMOTE" bash -s \
    "$REMOTE_LOG" "$REMOTE_CMD" "$REMOTE_PORT" "$KILL_PATTERN" \
    "$NO_RESTART" "$TOKEN_ONLY" < "$TMP_RS")"
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
  printf 'URL   = http://127.0.0.1:%s/%s\n' "$REMOTE_PORT" "$TOKEN"
  exit 0
fi

# ---- 2) 建 SSH 隧道 --------------------------------------------------------
LOCAL_PORT="$(pick_free_port)"
vlog "local port = $LOCAL_PORT"
if [ -f "$TUNNEL_PID_FILE" ]; then
  old="$(cat "$TUNNEL_PID_FILE" 2>/dev/null || true)"
  [ -n "$old" ] && kill "$old" 2>/dev/null || true
  rm -f "$TUNNEL_PID_FILE"
fi
ssh -N -L "${LOCAL_PORT}:${REMOTE_TARGET_HOST}:${REMOTE_PORT}" "$REMOTE" \
  >/tmp/.dsh-remote-web.tunnel.out 2>/tmp/.dsh-remote-web.tunnel.err &
TUNNEL_PID=$!
echo "$TUNNEL_PID" > "$TUNNEL_PID_FILE"
vlog "tunnel pid $TUNNEL_PID -> $REMOTE:$REMOTE_PORT"
for i in $(seq 1 20); do port_ready "$LOCAL_PORT" && break; sleep 0.5; done

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
