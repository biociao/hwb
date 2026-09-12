# 远端 `dsh web` 一键拉起 + 抓 token + 建隧道 — `dsh-remote-web.sh`

新版本 `dsh web` 每次启动都会在 **stdout** 打印一个带 `?token=...` 的鉴权 URL,而 token
**只存在于远端那个进程里**(本地拿不到)。本脚本从本地发起,SSH 到远端去(可选)重启服务、
从远端日志抓回 token,再在本地建 SSH 隧道(`远端:3080 -> 本地:<port>`),最后拼出
`http://127.0.0.1:<本地端口>/?token=...` 给你,可选直接用浏览器打开。

> 前提:你的远端有可用的 SSH 别名(如 `~/.ssh/config` 里的 `Host hwb`),且远端已装有
> `dsh`。默认启动命令复用同目录的 [`dsh-web-cached.sh`](dsh-web-cached.sh) 冷启动加速封装,
> 日志落在远端 `~/.dsh/web.log`。

## 用法(在【本地】运行)

```bash
scripts/dsh-remote-web.sh <ssh-host> [选项]
```

常用示例:

```bash
# 1) 重启远端 dsh web + 抓 token + 建隧道,并自动用浏览器打开
scripts/dsh-remote-web.sh hwb --open

# 2) 远端 dsh web 已在跑,只抓它当前日志里的 token(不重启、不打隧道)
scripts/dsh-remote-web.sh hwb --token-only

# 3) 只抓 token,不重启:配合你已有的隧道/可直接访问的场景
scripts/dsh-remote-web.sh hwb --no-restart --open

# 4) 收掉之前建好的隧道
scripts/dsh-remote-web.sh --kill-tunnel
```

## 选项

| 选项 | 说明 | 默认 |
|------|------|------|
| `<ssh-host>` | 远端 SSH 别名(位置参数,放最后) | — |
| `--port N` | 远端 dsh web 端口 | `3080` |
| `--local-port N` | 本地隧道端口；`0`=自动挑空闲 | `0`(自动) |
| `--log PATH` | 远端日志路径 | `~/.dsh/web.log` |
| `--cmd CMD` | 远端启动命令 | `bash $HOME/scripts/dsh-web-cached.sh web` |
| `--trusted-host H` | 隧道指向的远端绑定地址 | `127.0.0.1` |
| `--open` | 打印后调用默认浏览器打开(macOS) | 关 |
| `--no-restart` | 不重启,只抓当前实例已写入日志的 token | 关 |
| `--token-only` | 只抓 token,不打隧道(隐含 `--no-restart`) | 关 |
| `--kill-tunnel` | 结束已建隧道(读 `${XDG_RUNTIME_DIR:-$HOME/.dsh}/dsh-remote-web/tunnel.pid`) | 关 |
| `--dry-run` | 只打印将执行的远端命令,不实际执行 | 关 |
| `--verbose` | 打印调试信息 | 关 |
| `-h/--help` | 帮助 | — |

## 它做了什么

1. **抓 token(一次 SSH 往返)**：把远端脚本经 `ssh ... bash -s <args>` 送入执行。
   - 默认(**重启**模式):先 `fuser -k <port>/tcp` 杀掉占用端口的旧实例(`--kill-pattern` 可兜底),
     `sleep 1`,再用你的 `--cmd` 后台启动;然后循环读日志中**本次启动后新增**的 `?token=...`。
   - `--no-restart` / `--token-only`:直接 grep 整个日志里最新一条 `?token=...`。
   - 40s 内抓不到就报错并回显日志尾部。
2. **建 SSH 隧道**：`ssh -N -L <local>:<host>:<remote>` 后台运行,PID 存到
   `${XDG_RUNTIME_DIR:-$HOME/.dsh}/dsh-remote-web/tunnel.pid`。本地绑定 `127.0.0.1`,避免跨机再触发 `/api` 信任围栏。
3. **拼 URL**：`http://127.0.0.1:<local>/?token=<token>`,打印(可选 `--open` 打开)。

> token 只在远端进程里,所以"本地注入启动命令→远端抓 token→本地建隧道访问"是**唯一可靠**的
> 自动化路径。隧道只解决"连到远端",鉴权只认 token 值,跟端口无关。

## 与 `dsh-web-cached.sh` 的配合

- 新脚本**默认**的 `--cmd` 就是 `bash $HOME/scripts/dsh-web-cached.sh web`,即沿用你的冷启动
  加速封装。远端需先有该脚本:`scp scripts/dsh-web-cached.sh user@server:$HOME/scripts/`。
- 若你已改用 systemd 服务(`dsh-web-cached.service`)托管,建议用 `--no-restart`(让 systemd 管理
  启停,脚本只抓 token),或把 `--cmd` 换成 `systemctl --user restart dsh-web-cached`。

## 注意

- **token 每次重启都变**:重启模式每次都会拿新 token;`--no-restart` 拿的是当次实例的 token。
- **本地 3080 常被本地 GUI 占用**,脚本会自动挑空闲端口(默认从 3081 往后找);也可 `--local-port` 指定。
- **`fuser` 在 macOS 上语义不同**,脚本里已把它全部输出吞掉(`>/dev/null 2>&1`),在 Linux 上
  才是杀掉端口进程的正确工具。若远端没有 `fuser`,可加 `--kill-pattern "dsh --profile web"` 兜底。
- 生产环境开 `--open` 会调 `open`(macOS);远程无桌面环境时别开。

## 在 hwb 实例按钮中集成(启动 / 重启 / 关闭)

同一套「远端拉起来 + 抓 token + 建隧道」逻辑已**原生搬进 hwb 的控制平面**(不再是外挂脚本),
并接到实例网格的按钮上。对 **SSH 远程实例**,按钮按运行态显示:

| 状态 | 按钮 | 动作 |
|------|------|------|
| stopped | **启动** | `POST /api/homes/{id}/open` → `Launcher.open` → 远端若未运行则拉起 + 抓 token + 建隧道 |
| running | **重启** | `POST /api/homes/{id}/restart` → 停远端 dsh + 拆隧道,再重启 + 抓新 token |
| running | **关闭** | `POST /api/homes/{id}/stop` → 杀掉**远端** dsh web(SSH `fuser -k <port>/tcp`)+ 拆隧道 |

涉及文件:
- `src/control/remote.js` — 新增:远端 `ensure/restart/stop` + 抓 token(把 `dsh-remote-web.sh` 算法搬进 Node)
- `src/control/launcher.js` — 远程 `open/restart/stop` 接上 remote.js;返回值拼 token URL
- `src/api/routes.js` — 新增 `POST /api/homes/{id}/restart`;`/stop` 传 `home`(同时停远端)
- `src/dshhome/store.js` / `src/web/components/add-home.js` / `src/web/app.js` — 实例配置新增 `remoteCmd`(远端启动命令)与 `remoteLog`(token 日志),可在「设置」里填成你的 `bash $HOME/scripts/dsh-web-cached.sh web`

> 旧版 dsh(不打印 token)自动回退到普通 URL(不带 `?token=`),行为与原先一致。
> 新版 dsh 打印 token,则由 hwb 拼接 `http://127.0.0.1:<本地>/<token>` 交给 iframe。
> `remoteCmd` 默认 `dsh web --port <port> --no-open`;如远端用缓存 wrapper,把
> `remoteCmd` 设为 `bash $HOME/scripts/dsh-web-cached.sh web`、`remoteLog` 设为 `~/.dsh/web.log` 即可。

## 远程 dsh 升级后连不上:三个高频坑(已内置到 hwb 代码)

1. **`dsh` 不在 SSH 会话的 PATH 里** —— 升级/换 nvm 版本后,`dsh` 常装到
   `~/.nvm/versions/node/v24.15.0/bin`,而 SSH 非交互会话的 PATH 只带旧版本(如 v24.14.1)。
   → 现已自动把 `~/.nvm/versions/node/*/bin`、`~/.local/bin`、`$HOME/bin` 等加进远端 PATH。
2. **ssh 会把含空格的远程启动命令按空白拆开** —— `dsh --profile web --port 3080 --no-open`
   被拆成 `dsh` + 若干片段,`$3=$cmd` 只剩 `dsh`,进而报
   `error: --profile <name> is required` 或 `nohup: failed to run command 'dsh'`,且
   `seq 1 --profile` 报 `invalid floating point argument`。
   → 现已给每个 ssh 参数加双引号(JSON.stringify),cmd 作为**单一参数**传过去。
3. **新版 dsh 要求显式 `--profile web`** —— 裸 `dsh web` 在个别的 build 上不再识别。
   → 默认启动命令改为 `dsh --profile web --port <port> --no-open`(旧版也兼容)。

> 若仍连不上,先看远端日志 `tail -n 30 ~/.dsh/web.log`。若出现
> `error: --profile <name> is required`,说明 cmd 被拆开了(见第 2 条);
> 若 `nohup: failed to run command 'dsh'`,说明 PATH 没带上(见第 1 条)。
> `~/.dsh/web.log` 里最新一条 `dsh web: http://127.0.0.1:<port>/?token=...` 就是当前 token
> (存在多条也不会混淆——脚本只抓该次启动【新增】的那条)。

## 状态文件位置（已从 `/tmp` 迁到用户私有目录）

隧道 PID 与 ssh 的输出原先放在 `/tmp/.dsh-remote-web.*`。那是一组**全局可写的固定路径**：

- 任何本地用户都能在文件不存在时抢先创建它（`/tmp` 的 sticky 位只保护已存在的条目）；
- 旧实现把文件内容当 PID 直接 `kill` —— 内容写成 `0` 就等于让调用者 `kill 0`（SIGTERM 掉整个
  进程组），而一个过期的 PID（隧道早已退出、PID 被系统复用）会打死一个毫不相干的进程；
- 隧道输出用的是固定路径且**不先删除**，谁提前放一个指向 `~/.ssh/authorized_keys` 的符号链接，
  重定向就会把那个文件截成 0 字节。

现在统一放在用户私有运行目录，默认 `${XDG_RUNTIME_DIR:-$HOME/.dsh}/dsh-remote-web/`（权限 `0700`），
可用环境变量 `DSH_REMOTE_WEB_DIR` 覆盖。`--kill-tunnel` 会先校验：PID 必须是数字且非 `0`，
再用 `ps` 确认它确实是一条 `ssh -N -L` 隧道 —— 对不上就**拒绝 kill 并说明原因**，
而不是"照着文件里的数字杀"。

另外修掉了两处会让脚本"看起来成功、实际什么都没做成"的问题：

- **远端参数引用**：ssh 会把 host 之后的 argv 用空格拼成一个字符串交给远端 shell 重新切分。
  原先没有逐个引用，默认的 `remoteCmd`（含空格）会把后面每个参数整体错位一格 ——
  实测远端拿到 `cmd=[bash]`、`port=[$HOME/scripts/...]`、`killp=[web]`：远端跑了一个裸 `bash`
  （永远等不到 token），而 `pkill -f web` 会把远端**任何**命令行含 "web" 的进程杀掉。
  现在用 `printf '%q'` 逐参引用（远端就是 `bash -s`）。
- **隧道没起来也报成功**：原先不检查端口就绪就打印 URL 并 `exit 0`，真正的错误（ssh 的 stderr）
  丢在临时文件里没人看。现在端口没起来会打印 ssh 的 stderr 并 `exit 1`。
