#!/usr/bin/env bash
# dsh-web-cached.sh — 用本地缓存加速远程服务器上 `dsh web` 的冷启动
#
# 作用:
#   1) 开启 Node 22 内置的 V8 编译缓存 (NODE_COMPILE_CACHE)
#      —— 缓存每个模块编译后的字节码,下次启动跳过重新解析/编译;
#   2) 关闭遥测 (DSH_TELEMETRY_DISABLED),省去启动时的遥测提交;
#   3) 若装有 vmtouch,预热 dsh 安装 + profiles 到内存页面缓存
#      —— 命中内存而非磁盘 (专治慢盘 / 网络 FS / NFS 上的 node_modules)。
#
# 用法 (在远程服务器上, 用它替换原来的 `nohup dsh web &`):
#   nohup bash /path/to/dsh-web-cached.sh web >> ~/.dsh/web.log 2>&1 &
#
# 也兼容其它 profile / 参数, 例如:
#   nohup bash /path/to/dsh-web-cached.sh headless "run ..." >> ~/.dsh/h.log 2>&1 &

set -euo pipefail

# ---------------------------------------------------------------------------
# 0) 缓存目录 —— 务必放在【本地 SSD】, 不要放 NFS/网络挂载。
#    可用环境变量 DSH_CACHE_DIR 覆盖 (例如服务器内存大且是网络盘时, 可指到 tmpfs)。
# ---------------------------------------------------------------------------
DSH_CACHE_DIR="${DSH_CACHE_DIR:-$HOME/.cache/dsh}"
mkdir -p "$DSH_CACHE_DIR"

NODE_COMPILE_CACHE="$DSH_CACHE_DIR/node-compile"
mkdir -p "$NODE_COMPILE_CACHE"
export NODE_COMPILE_CACHE

# 关闭遥测 (启动期省一次网络提交; 纯开关, 无副作用)
export DSH_TELEMETRY_DISABLED=1

# ---------------------------------------------------------------------------
# 1) 预热 OS 页面缓存 (可选)。没有 vmtouch 就静默跳过, 不影响启动。
#    首次安装 vmtouch: sudo apt-get install vmtouch 或 make 安装。
#    注: 只做一次性 touch (-t, 尽量驻留), 不做 -d 常驻守护 —— 常驻请用下面
#        的 dsh-web-cached.service, 避免 wrapper 里 fork 后台进程。
# ---------------------------------------------------------------------------
warm_vmtouch() {
  command -v vmtouch >/dev/null 2>&1 || return 0
  # 预热目标: dsh 的真实安装目录(含 node_modules) + 个人 profiles。
  # readlink -f 解析 `dsh` 指向的真实脚本/bin; 再上溯到安装根。
  local dsh_bin dsh_root
  dsh_bin="$(command -v dsh || true)"
  if [ -n "$dsh_bin" ]; then
    dsh_root="$(dirname "$(dirname "$(readlink -f "$dsh_bin")")")"
  fi
  local targets=()
  [ -n "${dsh_root:-}" ] && [ -d "$dsh_root" ] && targets+=("$dsh_root")
  [ -d "$HOME/.dsh/profiles" ] && targets+=("$HOME/.dsh/profiles")
  if [ "${#targets[@]}" -gt 0 ]; then
    # 失败不致命 (例如权限限制), 记录后继续
    vmtouch -t "${targets[@]}" >/dev/null 2>&1 || true
  fi
}
warm_vmtouch

# ---------------------------------------------------------------------------
# 2) 用缓存环境启动 dsh。exec 使本脚本被 dsh 进程替换 —— 对 nohup 友好,
#    保证日志/信号都直接落到 dsh, 不会残留多余 shell。
# ---------------------------------------------------------------------------
exec dsh "$@"
