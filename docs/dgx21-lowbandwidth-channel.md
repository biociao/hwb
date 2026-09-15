# 低带宽 / 不稳定链路下连 dgx21.tun 上的 dsh —— 一条命令通道

日期：2026-09-14
结论一句话：**别用浏览器连。** 用 `dsh --profile headless` 走 SSH，一次指令实测
**9.6 KB**（冷）/ **0.7 KB**（复用连接）；而 dsh web 在 UI 可用之前必须先拉完
**3 501 190 B（3.34 MB）**。差 **354× ~ 4 900×**。
远端只放一个 **173 字节**的 profile 文件，不下载任何插件、不建缓存。

**最快上手**（两条命令）：

```sh
scripts/dsh21-deploy.sh dgx21.tun          # 一次性：装那个 173 字节的 profile（幂等，不下载）
node scripts/dsh21.mjs "你的指令"            # 之后每次：发一条指令
```

配套工具：

| 文件 | 作用 |
|---|---|
| `scripts/dsh21-deploy.sh` | 把那个 **173 字节**的 profile 装到任意远端 dsh 主机（幂等、拒绝下载、带预检） |
| `scripts/dsh21.mjs` | 主交付：向远端 dsh 发一条指令（复用连接、压缩、保活、带安全重试、可测字节） |
| `scripts/soak/net-shim.mjs` | 量具：SSH `ProxyCommand` 上精确数线速字节，并可注入限速/延迟/断流 |
| `scripts/soak/soak.mjs` | 通宵稳定性测试（默认每 30 分钟一轮，写 JSONL，可出报告） |
| `scripts/soak/nodownload-check.mjs` | 只读取证：证明这一夜**没有下载任何包/缓存** |
| `scripts/soak/bundle-weight.mjs` | 复现「web 首屏 3.34 MB / gzip 后 0.79 MB」这个核心数字 |
| `tests/dsh21-classify.test.js` | 守住「不许重复执行」「一次尝试必须有界」等安全线（38 项） |
| `tests/nodownload-check.test.js` | 守住「没下载东西」的判定（7 项） |

---

## 1. 为什么原来的路走不通

`docs/dgx21-tun-access.md` 记录了两个月的排查：隧道建不起来、`Failed to load plugins`、
固定入口随机端口、代理连接池饥饿、`MaxSessions 10` 撞穿……修完这些，页面**还是慢**。

因为**瓶颈不在隧道，在载荷**。在 dgx21 本机直接量（不占 VPN 带宽，
一条命令即可复现：`node scripts/soak/bundle-weight.mjs --host dgx21.tun`）：

```
46 个唯一的 /plugins/…/client.js   raw = 3 485 976 B (3.32 MB)
root 文档                              =    15 214 B
首屏（UI 可用前必须先到齐）             = 3 501 190 B (3.34 MB)
```

注意这里有两个**不同**的问题，别混为一谈：

- **服务端压根没开压缩**：带 `Accept-Encoding` 去要，拿回的字节数一模一样 → 白送的优化空间（§6）。
- **内容本身很能压**：同一批 bundle 用 `gzip -9` 压是 **813 796 B（4.28×）** —— 这是「开了压缩能省多少」，
  不是「现在省了多少」。

两点：

1. **浏览器必须先把这 3.34 MB 全拉下来才能用**，而这笔钱是**按 payload 算**的，
   跟传输层压不压缩无关（压缩只减少线上字节，不会减少浏览器要解析的字节）。
   所以要把两种传输分开说，不然数字会互相打架：

   | 传输 | 线上要搬多少 | 典型耗时 |
   |---|---|---|
   | 不带压缩 | 3.34 MB | **约 2 分钟**（`docs/dgx21-tun-access.md` 实测 140 s） |
   | ssh `-C`（hwb 与 `dsh21` 都用） | 约 0.79 MB（4.28× 压缩后） | **约 30 s**（同一文档实测 30.4 s） |

   两者是**同一份 3.34 MB payload** 走不同传输——所以「2–4 分钟」和「30 s」都出现过，
   并不矛盾，但**必须说清是哪种**。而且 30 s 只是**顺风时的名义值**：实际观察到的
   首次加载经常是**分钟级**，原因见下一条。
2. **真正的杀手不是慢，是并发失败。** 这 46 个 bundle 是**并发**拉的，任何一个超时，
   插件加载器整体报错、UI 直接死：`Failed to load plugins`（浏览器自己不会重试）。
   慢是确定的、失败是概率性的——**所以表现为「经常」打不开而不是「总是很慢」**。
   这也是为什么本文的优化清单里，光把 payload 压小**并不能**解决这个问题。

结论：在 25–30 KB/s 的链路上，把浏览器 UI 当作「连接 dsh 的方式」不成立——
**30 s 起步、且随时可能整体失败**，而一条指令只要 **9.6 KB / 约 3 s**。
dsh 本身是 CLI，不需要浏览器。

---

## 2. 正解：headless profile + SSH

`dsh` 自带一个一次性任务模式（README：*"no GUI, no server, no browser"*）：

```sh
node scripts/dsh21.mjs "你的指令"      # 推荐：处理了 PATH / 复用 / 重试，见 §3
```

裸 ssh 的等价写法（**PATH 别只写 `~/.local/node/bin`** —— dsh 常装在 nvm 下，
见 §2.3 的两个坑）：

```sh
ssh dgx21.tun 'export PATH=$HOME/.local/node/bin:$PATH; dsh --profile headless "你的指令"'
# dgx21 上这样写没问题；换主机请用 §2.3 的 for 循环版本，或直接用 dsh21-deploy.sh
```

它把答案打到 stdout、退出码表示成败，**不开端口、不常驻、不加载任何浏览器插件**。

### 2.1 远端部署：396 字节，零下载

dgx21 上原本只有 `web` profile。关键发现是：**`headless` profile 的依赖是空的** ——
它复用 `~/.dsh/profiles/node_modules` 里**已经装好**的 `@deepseek-ai/dsh-base` 与
`@deepseek-ai/dsh-headless`（核对过：两个包都在）。所以只需写一个 package.json。

一行命令搞定（幂等，可对 `c4g.tun`、`cms.tun` 等同病主机复用）：

```sh
scripts/dsh21-deploy.sh dgx21.tun
```

它会**先预检** `dsh-base`/`dsh-headless` 是否已在远端、`dsh` 是否在 PATH 上；缺任何一项
就直接失败退出（因为那意味着要下载，而这条路存在的意义就是避免下载）。它**从不**跑
pnpm、从不安装任何东西。手写等价物：

```sh
# 本地
printf '%s\n' '{"name":"dsh-profile-headless","private":true,"dependencies":{},
"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-headless"],
"patchReload":"startup"}}}' > /tmp/headless-package.json

# 推到远端（173 字节）
ssh dgx21.tun 'mkdir -p ~/.dsh/profiles/headless && cat > ~/.dsh/profiles/headless/package.json' \
  < /tmp/headless-package.json
```

`cordis.yml` 由 dsh 首次启动自己写（223 字节）。事后核对：

```
~/.dsh/profiles/headless/  =  package.json 173 B  +  cordis.yml 223 B   （共 396 B）
node_modules/              =  0 项
pnpm store                 =  最后修改 8/30，本次未动
```

**没有 pnpm install、没有下载、没有缓存预热。** 这也是「尽量不要下载 dsh 插件和缓存」
这条要求的直接满足方式：走的是已装的包，新增物只有 396 字节。

> 远端版本：`dsh 0.1.1-rc.2`，`node v22.23.2`（在 `/home/bot/.local/node/bin`）。
> **非交互 ssh 的 PATH 里没有 node，所以命令里必须自己 export PATH**；而且 dsh 未必
> 只装在 `~/.local`（c4g.tun 就在 nvm 下），正确写法见 §2.3。

### 2.2 实测字节数（在 TCP 层数的，含 SSH 加密与压缩后的真实线上字节）

**所有行都在同一条件下量的（都开压缩）**——上一版把「不带压缩的裸握手」和
「带压缩的任务」放在一张表里比，属于条件不一致：

| 路径 | 线上字节 | 说明 |
|---|---|---|
| `ssh host 'echo hi'` | **9 509 B** | 纯 SSH 握手的地板价 |
| headless 冷启动跑一条指令 | **9 865 B** | 地板价 **+ 约 0.35 KB** 载荷 |
| headless 复用连接（暖） | **685–712 B** | 只付指令那一份 |
| dsh web 首屏 | **3 501 190 B** | root + 46 个插件 bundle，UI 可用前必须全到齐 |

- 冷启动 ≈ 握手；所以优化方向是**摊薄握手**，即复用连接（§3）。
- 相比 web UI：冷启动 **354×**、暖启动 **4 900×** 左右。
- **别把单次数字当常数看**：同一句 PONG 任务的冷启动在本次通宵里采了 7 次——
  9 625 / 9 745 / 9 761 / 9 825 / 9 833 / 9 857 / 9 865 B ——
  均值 **9 787 B**、标准差 **85 B（0.87%）**、极差 240 B（2.45%）。
  （早先写成「±2%」是偏松的：那是极差的一半，不是标准差。）
- **压缩对握手几乎没用、对暖调用很有用**：裸握手开压缩只省 180 B（1.9%，因为密钥交换
  是随机数据、本来就压不动），而暖调用能省约一半（1 368 → 685 B，§3.6）。
  也就是说 `-C` 的价值随载荷可压性变化，而握手那部分省不掉。

> 交叉验证（**同一趟**连接上取的，两边条件一致）：ssh 自己的 `-v` 汇总报
> `sent 4660, received 4268` = 8 928 B，shim 在 TCP 层数到 9 473 B，
> 差 **6.1%**，正是 SSH 二进制包的头/填充/MAC 开销（§4.1 用 100 KB 载荷标定为 4.85%）。
> 两个独立来源对得上，说明这个数不是估的；shim 数的是**真正上线的字节**，故以它为准。

---

### 2.3 不只在 dgx21 上成立

同一个部署脚本对**同病的兄弟主机**同样适用。只读探测（未写入、未部署）结果：

| 主机 | dsh 位置 | dsh-base / dsh-headless | headless profile |
|---|---|---|---|
| `dgx21.tun` | `~/.local/node/bin/dsh`（0.1.1-rc.2） | 都在 | 已部署 |
| `c4g.tun` | **`~/.nvm/versions/node/v24.15.0/bin/dsh`**（0.1.2-rc.1） | 都在 | 未部署（`scripts/dsh21-deploy.sh c4g.tun` 即可） |
| `cms.tun` | 未在常见位置找到 | 都在 | 未部署 |

**这条探测顺带暴露了一个真 bug。** 最初的 PATH 只加了 `~/.local/node/bin`，于是
`c4g.tun` 被报成 `dsh=MISSING` —— 而那台机器上 dsh 好好地装在 `v24.15.0/bin` 下
（正是 `scripts/README-dsh-remote-web.md` 记录过的第 1 号坑）。

修的时候还踩了第二个坑：写成

```sh
export PATH=$HOME/.nvm/versions/node/*/bin:$PATH   # ✗ 通配符不会展开
```

是**错的**。赋值语句的右侧**不做文件名展开**，于是 PATH 里留下一个字面量 `*`，
静默地什么都匹配不到（表现和「没加」一模一样）。必须用单词表：

```sh
for d in "$HOME/.nvm/versions/node/"*/bin "$HOME/.npm-global/bin" "$HOME/.local/bin" \
         "$HOME/.local/node/bin" "$HOME/bin" "/usr/local/bin"; do
  [ -d "$d" ] || continue
  case ":$PATH:" in *":$d:"*) ;; *) PATH="$d:$PATH";; esac
done
export PATH
```

这条正是 `src/control/remote.js` 里已经验证过的写法，现在被原样复用到 `dsh21.mjs`
与 `dsh21-deploy.sh`。生效验证：`dsh21 --probe --host c4g.tun` 现在能报出
`dsh 0.1.2-rc.1`（此前报 MISSING）。

#### 还有第三个坑：远端 shell 可能是 **zsh**，那里「没匹配到」是致命的

上面那套 PATH 写法在 bash 上是对的，但**在 zsh 上会让整条命令直接作废**。zsh 默认
`nomatch`：通配符没匹配到任何文件时，zsh 报 `no matches found` 并**中止整行**，
后面用 `;` 接的命令一个都不执行。在 `cms.tun`（一台 macOS/zsh 主机）实测：

```sh
ssh cms.tun 'for d in "$HOME/.nvm/versions/node/"*/bin; do :; done; echo AFTER'
# → zsh:1: no matches found: /Users/bot/.nvm/versions/node/*/bin
# → 连 AFTER 都不打印
```

后果很直接：**在 zsh 主机上 `dsh21` 不是「慢」或「降级」，而是完全跑不起来** ——
PATH 那行就中止了，后面的 `export PATH`、`unset`、`dsh` 一个都没执行。
而在 bash 上完全看不出来（bash 的失败通配符会原样保留，`[ -d "$d" ]` 自然跳过）。

修法是在循环前加一句**只对 zsh 生效**的开关：

```sh
[ -n "${ZSH_VERSION:-}" ] && unsetopt nomatch 2>/dev/null
for d in "$HOME/.nvm/versions/node/"*/bin ...; do ...; done
```

bash 没有 `unsetopt`，靠 `ZSH_VERSION` 判断成 no-op。修完实测：
`dsh21 --probe --host cms.tun` 从此前的「整行中止」变成能正常返回
（`bot host=CHAOsMacStudio`；该机确实没装 dsh，于是如实报 `command not found`），
而 bash 主机（dgx21、c4g.tun）行为不变。

> 这个坑也顺带修正了 `dsh21-deploy.sh` 的一个**误导性报错**：修之前，
> 它会对 `cms.tun` 报「dsh-base / dsh-headless 缺失」（其实两个都在），
> 只因为 PATH 那行被 zsh 中止、预检没跑成。现在它给的才是真原因：
> 「dsh not found on the remote PATH」。**失败方向是安全的**（它拒绝部署而不是
> 硬上），但理由错了会把人引向错误的排查方向。

## 3. 让它扛得住低带宽和不稳定

`scripts/dsh21.mjs` 把这几个杠杆固化下来：

```sh
node scripts/dsh21.mjs "看看 ~/data 里有什么，列个摘要"
node scripts/dsh21.mjs --cwd /home/bot/data "在当前目录跑一遍测试"   # 目录须存在，否则直接失败
node scripts/dsh21.mjs --probe                 # 只探链路，不调模型
node scripts/dsh21.mjs --measure "…"           # 顺便报线上字节
```

### 3.1 连接复用（最大的那个杠杆）

握手 ~9 KB 且在这条 VPN 上很慢。`ControlMaster=auto` + `ControlPersist=600` 让
**第一条指令付握手，后面 10 分钟内的指令只付 712 B**。

实测同一台机器：

| | 冷 | 暖（复用 master） |
|---|---|---|
| 线上字节 | 9 625–9 865 B | **685–712 B** |
| 端到端耗时 | **约 3 s**（2.7–3.8 s） | **约 1.7 s**（1.3–2.5 s） |

> 延迟区间是**仍在增长的采样**：前 3 轮给出 3.0–3.8 s，第 4 轮落到 2.7 s，
> 就把上界撑开了——**样本少时的「区间」会随数据增长而变**，这很正常。
> 所以这里只给「约多少 + 当前区间」，**权威分布以 §4.5 那份全量 soak 结果为准**，
> 而不是把这些数字当常数抄走。字节区间见 §2.2 的 7 次采样（那组已稳定，sd 85 B）。

### 3.2 压缩必须加在「承载数据的那条连接」上

`-C` 写在本条 ssh 的 argv 上没有用——复用 master 时，真正搬数据的是 **master**。
（这条是 `docs/dgx21-tun-access.md` 里踩过的坑：漏了 `-C` 的 master 让 3.32 MB
从 30 s 变 140 s。）`dsh21.mjs` 把 `Compression=yes` 加在建 master 的那组参数里。

这个差别**在小请求上同样量得出来**（§3.6 有完整量法）——同一个暖调用，
压缩的 master 是 685 B、不压缩是 1 368 B，**约 2×**。也就是说 `-C` 放错位置
不是「大文件才吃亏」，而是**每一次调用都在付双倍**。

### 3.3 关掉 `RemoteForward`，避开 7897 陷阱

实测现场：

```
dgx21 上 127.0.0.1:7897 在监听（某个旧 ssh 会话留下的 RemoteForward）
但本机 127.0.0.1:7897 并没有进程在听  →  经该代理访问 api.deepseek.com：0.096 s 失败
直连  api.deepseek.com                                ：6.12 s，HTTP 401（通）
```

即：**那条反向转发当前是个死代理**。非交互 ssh 不会 source `~/.bashrc`，所以我们的
命令本来就不带 `HTTP_PROXY`（走直连，正确）；但只要哪个环节让它继承了
`HTTPS_PROXY=127.0.0.1:7897`，远端就会**瞬间失败或挂住**。

所以 wrapper 默认 `ClearAllForwardings=yes`，并在远端脚本里显式
`unset HTTP_PROXY HTTPS_PROXY ALL_PROXY …` ——**把环境钉成确定态**，而不是赌它。
（`--keep-forwardings` 可恢复原行为。）

> 顺带核对：正在跑的 `dsh web` **没有**代理变量，走直连，没被这个陷阱毒到。
> （别把 PID 写进文档——复核期间它已经从 2294 变成 408058，见 §5。）

### 3.4 重试：只重试「确定还没开始」的失败

这是本方案里唯一需要小心的正确性问题：**一次性指令不是幂等的**——远端 agent 可能
正在改文件，重试就等于**把指令跑两遍**。这条链路上断连又很常见，所以不能简单地
「失败就重连重发」。

**先试错的做法（已废弃）**：用 `ssh -v` 的 `Authenticated to` 行判断有没有过认证。
两个坑都实测踩到了：

1. 这行**没有 `debug1: ` 前缀**（OpenSSH 10.2 实测），按前缀匹配会让判断
   **永远**返回「没认证」——安全闸门静默失效，比没有还危险。
2. 更致命：**开了 mux 之后这条根本不出现**。复用 master 时 ssh 既不打印
   `Authenticated to` 也不打印 `Sending command`，而且 master 还会把 debug 输出写到
   **创建它的那条连接的 stderr** 上。也就是说：**stderr 无法回答这个问题。**

**现在的做法：让远端自己留痕。** 每次调用带一个随机 token，远端脚本在**启动 dsh 之前**
写标记文件：

```sh
mkdir -p $HOME/.dsh21/state
echo started > $HOME/.dsh21/state/<token>
dsh --profile headless -- '<task>'
__rc=$?
printf 'finished %s\n' "$__rc" >> $HOME/.dsh21/state/<token>
exit $__rc                      # 必须显式 exit，否则尾部的 append 会把状态码吞成 0
```

重试前读这个标记（读后即删，不可复用；探测本身失败会退避重试 3 次，免得链路抖一下
就不敢重连）：

- 标记**不存在** → 远端确实没开始 → **安全重试**；
- 标记**存在** → 已经跑过了 → **绝不重试**，报 `phase=started-remote`；
- 完全探不到（链路断透）→ 默认仍重试（保证可用性），要严格安全可用
  `--require-verified`。

两种性质都实测验证过（§4.2）。

### 3.5 一次尝试必须**有界**：别等 `close`

一个只在「真坏链路」上才会暴露的问题。最初用 Node 的 `child.on('close')` 判断 ssh 结束，
而 `close` 要等**所有**持有 stdio 管道的进程都放手才触发。ssh 会把管道交给 fork 出去的
`ControlPersist` master —— 连接中断时把 ssh 客户端打死，那个 master 却可能继续攥着管道，
于是：

- 120 s 的超时到了、ssh 也被 SIGTERM/SIGKILL 了；
- 但 `close` 永远不触发，**整个调用吊死在自己的超时之外**（实测对 `c4g.tun` 吊死 200 s，
  最后只能由外层 `timeout` 收尸）。

连夜无人值守的自动化最怕这个：不是失败，而是**静静地卡住**。现在改为

- `exit` 之后给 300 ms 收尾缓冲就结算（不再等管道）；
- 超时kill 之后再挂一个 5 s 硬上限，无论如何都要结算。

实测：`--timeout 1` 的调用 1.3 s 返回 `timedOut=true`；新增的回归用例用一个「自己退出、
却把 stdout 交给一个 2 s 后才会死的孙进程」的假 ssh 复现了这个场景。

### 3.6 长任务：脱离连接去跑，回来再取结果

同步路径把一条 ssh 连接**从头开到任务结束**。这在坏链路上是致命的，而且不只是「答案丢了」：
连接一断，sshd 会给会话的进程组发 SIGHUP，**跑着的 dsh 本身也一起死**。任务越长，撞上断线的
概率越高——而「让远端干点实事」恰恰是长任务。

所以给长/不可靠的任务加一条**脱离连接**的路：

```sh
id=$(node scripts/dsh21.mjs --detach "分析 /data/work 下这批样本，写一份报告")   # 立刻返回
node scripts/dsh21.mjs --status  $id        # 一次往返，看 running / done(rc)
node scripts/dsh21.mjs --collect $id        # 等到跑完，打印答案，退出码=任务退出码
```

机制：

- 任务被写成一个 runner 脚本（`$HOME/.dsh21/runs/<id>.sh`），经**带引号的 heredoc** 投递，
  分隔符由随机 run id 派生 —— 这样**彻底消除嵌套引用**，任务正文由远端 shell 原样落盘，
  不再被二次解析；
- 用 `setsid`（没有则退回 `nohup`）启动，stdio 全部指向文件，于是 **ssh 立刻返回、任务照跑**；
- 退出码写进 `<id>.done`，输出留在 `<id>.log`，`--status`/`--collect` 各一次往返就能取回。

实测（都在 dgx21 上）：

| 验证 | 结果 |
|---|---|
| 起一个 12 s 的任务、**立即断开连接**、12 s 后回来查 | 任务照常跑完，退出码 `42` 留在文件里 |
| `--detach` 一个含 `sleep 12` 的任务 | 立刻返回 run id |
| 紧接着 `--status` | `running`（正确反映「还在跑」） |
| `--collect` | 等 21 s 后返回答案，`rc=0` |
| 之后再 `--status` | `done (rc 0)` |
| **链路在任务运行期间持续断**（60% 的轮询连接在握手期被杀） | 5 次轮询中 1 次失败，**答案照样取回**（`failedPolls=1`，任务输出 `SURVIVED`） |

#### 这条路更贵——贵多少是量出来的

先前的说法是「两条路的字节成本同量级」，**这是没量过的猜测，量完之后得改**：

| 组成 | 实测 |
|---|---|
| `--detach` 启动 | **约 10 KB**（一条全新连接，和同步路径差不多） |
| 每次 `--collect` 轮询（复用 master） | **539 B**（master 带压缩；不带压缩是 1 077 B） |

（量法：用一个**监听模式**的 `net-shim` 把整条链路包起来，再让两个进程共用同一个
mux master —— 为此给 `dsh21` 加了 `--control-path`，顺带也方便手动共享 master。
注意不能直接用 `--measure`：它会为了量准而**强制独占连接**，于是每次轮询都付一遍
9.8 KB 握手，量出来的不是常态。）

> 这组数字**修正过一次**。原先写的 1 077 B 是用一条**没开压缩**的 master 量的
> （量的时候自己漏了 `-o Compression=yes`），而 `dsh21` 默认是开压缩的。
> 用同一种量法把两种 master 都量了一遍，差别非常清楚：
>
> | 暖调用 | master 带压缩（默认） | master 不带压缩 |
> |---|---|---|
> | 完整任务 | **685 B**（与 §3.1 的 712 B 一致，属同一量级） | 1 368 B |
> | 一次 `--status` 轮询 | **539 B** | 1 077 B |
>
> 两点收获：① §3.2 那条「压缩必须加在 master 上」的教训，**代价是约 2×** ——
> 而且对**小请求**同样成立，不只是那 3.32 MB 的插件包；② 两个都叫「暖」的数字
> 之所以不同，是因为**载荷不同、且一度压缩状态也不同**，不是量错了。

所以总成本 ≈ **10 KB + 轮询次数 × 1.1 KB**，而轮询次数**随任务时长线性增长**：

| 任务时长 | 固定 10 s 轮询 | 退避后（默认） | 同步路径（作对照） |
|---|---|---|---|
| 1 分钟 | 6 次 ≈ 12.9 KB | 4 次 ≈ **11.9 KB** | 9.6 KB |
| 5 分钟 | 30 次 ≈ 25.6 KB | 8 次 ≈ **14.0 KB** | 9.6 KB |
| 20 分钟 | 120 次 ≈ 72.9 KB | 23 次 ≈ **21.9 KB** | 9.6 KB |

（按 启动 10 005 B + 每次轮询 539 B 算。）

也就是说：**`--detach` 是花 1.4×~3.5× 的字节买「断线也能活」**，不是免费的。
为此 `--collect` 的轮询间隔默认会**退避**（每次 ×1.5，上限 `--max-poll-ms` 默认 60 s）：
短任务前几次仍然是 10 s 的响应度，长任务自动滑到便宜节奏。实测一个 45 s 的任务
用 `--poll-ms 5000` 只花了 **6 次**轮询。

> 上表最后一行是为了让「扛住了坏链路」这句话**可被检验**：`--collect` 会记
> `failedPolls`（有几轮询是失败的）。没有这个字段时，「在坏链路上跑通了」和
> 「根本没遇到坏链路」在输出里长得一模一样——那就等于用一个未经检验的前提去下结论。

**什么时候用哪条路**：几秒钟的短指令用默认同步路径（最省字节）；
超过约 10 秒、或者链路正不稳时用 `--detach` + `--collect`——但要知道这是**用字节换韧性**，
长任务建议显式调大 `--poll-ms`。

### 3.7 其他加固（都是「不写测试就会悄悄退化」的那类）

- **每个 ssh 调用都在 host 前加 `--`。** ssh 会把 host 位置上一个以 `-` 开头的参数
  当成**它自己的选项**：实测传 `--host '-oProxyCommand=echo INJECTED'` 时，
  ssh 真的把那条 ProxyCommand 配上了（而不是当成主机名拒绝）。加上 `--` 之后
  它才被当作（非法的）主机名。host 通常来自调用者自己，但把位置钉死是零成本的。
- **任务文本与 profile 一律单引号包裹**（`shq()`），恶意输入不会被当命令执行。
  这条有真实用例守着：一个含 `$(echo …)`、反引号、单引号与换行的任务文本，
  经过真正的 `bash -c` 往返后必须**逐字节不变**；`--profile 'a$(id)b'` 也必须
  仍是**一个** shell 词。远端标记文件名取自随机 token，因此任务文本也无法左右它。

---

## 4. 实测数据

### 4.1 链路劣化下仍然能用

用 `net-shim` 主动把链路做坏（`--shim-*` 系列开关），全部通过：

| 注入条件 | 结果 |
|---|---|
| 限速 **4 KB/s**（32 kbps） | ✅ 成功，3.8 s |
| 限速 **2 KB/s**（16 kbps） | ✅ 成功，4.8 s |
| 限速 **0.5 KB/s**（4 kbps） | ✅ 成功，18.4 s |
| 限速 **0.25 KB/s**（2 kbps） | ✅ 成功，34.4 s |
| 连接延迟 1000 ms + 抖动 1500 ms | ✅ 成功，5.2 s |
| **60%** 连接在 700 ms 被重置 | ⚠️ 4 次全部被判为 `pre-exec`（握手期断）——判定正确，只是运气差；全程未误判 |
| **30%** 连接在 700 ms 被重置 | ✅ 第 2 次尝试成功，共 7.3 s（日志：`marker absent` → 重连） |
| **75%** 连接在 700 ms 被重置 | ✅ 3 次运行：2 次在 2 次重试后恢复（~11 s）；1 次 6 连败（0.75⁶ ≈ 18%，与理论相符） |

即：**低到 0.25 KB/s（2 kbps）仍然跑得通**——因为一条指令只有 ~9.6 KB 且一次性付清，
而 web UI 的 3.34 MB 在 2 KB/s 下就要 28 分钟，在 0.25 KB/s 下要接近 4 小时。

> ⚠️ **这张表本身修过一次。** 前四行原先写的是「4 KB/s → 18.4 s」「2 KB/s → 34.4 s」，
> 而当时的 `--rate-kbps` 在代码里按 **kilobits/s** 算、文档却当成 KB/s 读，**差了 8 倍**：
> 那两个测试实际跑的是 0.5 KB/s 和 0.25 KB/s。
> 现在把单位显式化（`--rate-kbps`=千比特、`--rate-kbyte`=千字节），并**重跑**了 4 KB/s 与
> 2 KB/s 两档（3.8 s / 4.8 s），把旧档位如实改标成 0.5 / 0.25 KB/s。
> 教训：限速工具的**单位错了不会报错**，只会安静地测出一条跟标签不符的链路。

上表的注入开关本身也做过**标定**（不然「没失败」可能只是注入没生效）；
所有字节数都来自同一个量具，所以量具本身也得先量一遍：

| 标定项 | 方法 | 结果 |
|---|---|---|
| 数得准不准 | 传 100 000 B 不可压数据、关压缩，比对量具读数 | **104 851 B**，即 4.85% 的 SSH 分帧开销 —— 与另一条独立路径（ssh 自己报的 `-v` 汇总）差 5.9%，两边吻合 |
| 限速准不准 | 用 16 KB / 48 KB 两档差分，把握手成本消掉 | `--rate-kbyte 8` 实测 **8.38 KB/s（105%）** |
| 断流注入是否真的生效 | `--reset-pct 100 --reset-after-ms 700` | 连续 2 次都把 ssh 打成 `rc=255`，且记到 `injected-reset` 事件 |

**「坏链路」是造出来的，不是碰上的。**

另外，`--require-verified` 并没有把重试能力砍掉：75% 重置下它照样重试并恢复（上表最后一行即在该开关下跑的），
因为它只在「探不到标记」（链路断透）这一支上收紧，而「标记确实不存在」仍然判为安全可重试。

### 4.2 安全闸门（不重复执行）

| 场景 | 期望 | 实测 |
|---|---|---|
| 连接在**握手期**（700 ms）被杀 | 允许重试 | `phase=pre-exec, marker absent` → 重试 → 成功 |
| 连接在**任务跑起来之后**（5000 ms）被杀，任务是 `sleep 8` | **禁止重试** | `attemptsUsed=1, phase=started-remote, remoteStarted=true`，**无重试** |

第二行是关键：即使给了 `--attempts 3`，它也只跑了一次。

### 4.3 「真活儿」也能干（不只是 PONG）

上面所有延迟/字节数都是拿一句 `Reply with … PONG` 量出来的，容易让人怀疑「是不是只测了
闲聊」。补一个真正用到远端 shell 工具的任务：

```sh
node scripts/dsh21.mjs --measure "Run the shell commands 'hostname', 'nproc' and 'uptime -p'
                                  and reply with just those three results on one line."
# → aitopatom-4148 20 up 2 days, 10 hours, 14 minutes
# → 线上 9 833 B，3.7 s
```

即：**真任务的字节数与「闲聊」在噪声范围内无法区分**。这句话原先写的是
「只比闲聊贵约 200 B（9833 vs 9625）」——**那个说法把噪声当成了信号**：
本次通宵里同一句 PONG 任务的冷启动 7 次采样**均值是 9 787 B（sd 85 B）**，
真任务那次是 9 833 B——**只差 46 B，连一个标准差都不到**。
（原说法拿 9 625 B 去比，可那是这组采样的**最小值**；拿极值当基线，
差值自然被放大成 200 B。这类错误比「数字抄错」更难发现，因为数字本身没抄错。）

> 一个真正调用远端 shell 工具的任务，其线上字节与一句闲聊**看不出差别**。

这其实比原说法**更有力**：结论本来就是「成本几乎全在 SSH 握手，与任务内容无关」，
而「差 200 B」反而暗示载荷有一点点可测的影响，实际上没有。

`--cwd` 也已验证（`--cwd /tmp` 下 `pwd` 返回 `/tmp`）。

### 4.4 「真的没下载任何东西」是可以验证的

「零下载」是这条路的立足点，也最容易在某个环节悄悄破功（一次误跑的 `pnpm install`、
一个隐式依赖拉取、一次缓存预热）。所以给它配了一个**只读**的取证脚本：

```sh
node scripts/soak/nodownload-check.mjs --host dgx21.tun --snapshot base.json   # 开工前
node scripts/soak/nodownload-check.mjs --host dgx21.tun --compare  base.json   # 收工时
```

它对「下载会落地的地方」做一次普查——pnpm store、`~/.cache/pnpm`、`~/.npm/_cacache`、
`~/.cache/node-gyp`、`~/.dsh/profiles/node_modules`、headless profile 目录——记录
存在性/mtime/大小，然后比对。**只读**：一个会改动被检查对象的检查等于没检查。

开工前基线（dgx21，2026-09-14 02:34）：

```
present  2292KB    /home/bot/.local/share/pnpm/store
absent             /home/bot/.pnpm-store
present  10464KB   /home/bot/.cache/pnpm
present  544108KB  /home/bot/.npm/_cacache
absent             /home/bot/.cache/node-gyp
present  1824KB    /home/bot/.dsh/profiles/node_modules
dsh version: 0.1.1-rc.2
```

（顺带看到远端有个 544 MB 的 npm 缓存 —— 与本次无关，但说明「有缓存」和
「这次用了缓存」是两件事，不记录基线就分不清。）

一个细节值得单独说：**整盘用量故意不记**。dsh 干活时会写会话和日志，磁盘用量必然变化，
把它算进比对里会让每次比对都报「有变化」，等于什么都没证明。这条也有用例守着。

### 4.5 通宵 soak

```sh
node scripts/soak/soak.mjs                    # 默认 16 轮 × 30 分钟 ≈ 8 小时
node scripts/soak/soak.mjs --report           # 早上看结论
```

每轮记三个量，追加进 `scripts/soak/results/soak-<host>-<date>.jsonl`：

| 步骤 | 走哪条连接 | 量的是什么 |
|---|---|---|
| `probe` | 复用（会**建立** master，`ControlPersist=600`） | 链路可达性/延迟，不调模型 |
| `cold` | `--measure` 强制独占连接 | 冷启动端到端延迟 + **线上字节** |
| `warm` | 复用 `probe` 建立的 master | 暖启动延迟（同一个 master，**确实**是热的） |

**每条记录带 `v`（记录格式版本）**。这不是洁癖：这次工作本身就在**运行中改过 harness**
（加了 `attemptsUsed`、修了探针超时余量），而行号一旦混在一起，读的人无法区分
「这一轮没有重试数据」和「这一轮的字段还没被发明出来」。所以：

- `v=2` 起含 `cold.attemptsUsed` / `warm.attemptsUsed` / `cold.remoteStarted`；
- **本次通宵那个文件是个特例**：它是在「字段已加、版本标记还没加」的窗口里跑的，
  所以行里**有 v2 的字段、却没有 `v` 标记**。报告对这种情况按 `n/a` 处理，
  不会把它误读成「重试 0 次」。真正的出处是：该文件由 `02:43` 启动的那个进程写出，
  其代码等价于 v2 字段、无 `v` 标记。

每轮还记 **`attemptsUsed`**（这条指令用掉了几次连接）。这个字段是刻意加的：
一次任务「第 1 次就成了」和「第 3 次才成」是**不同强度的证据**，而只看 ok/fail
两者长得一模一样——soak 一度把这张最灵敏的「链路质量表」直接丢掉了。
报告里会汇总成 `N first-try · M after 1 retry …`。

（本轮之前已跑过 2 轮，那时还没有这个字段，单独留在
`soak-dgx21.tun-2026-09-13-part1.jsonl` 里，报告按 `n/a` 处理。）

> `warm` 这一步一度被我自己怀疑「名不副实」——以为 `ControlPersist` 会在 30 分钟的
> 间隔里过期、于是每轮都退化成冷启动。实测否掉了：**每轮的 `probe` 先跑**，它就把
> master 建起来了，`warm` 复用的正是它（实测 1262–2360 ms，明显快于 cold 的 2503–3203 ms）。
> 这也说明「30 分钟一轮」这种稀疏用法，**一轮里的多条指令本来就共享一次握手**。

#### 读这份数据前必须知道的一件事：同一台机器上有**第二个 ssh 消费者**

当晚本机的 **hwb 工作台也在跑**（`src/service.js`，60s 巡检一次），它自己就对 dgx21
持有 **5 条 ssh 进程 + 2 个 mux master**，并且会建隧道、抓 token、跑索引器。
它的日志里有 205 次 `ssh 连接失败`、64 次 `隧道子进程异常退出`。

这意味着：soak 与 hwb **在抢同一个 sshd 的未认证连接窗口**（§5 的
`MaxStartups 10:30:100`）。所以某一轮 probe 失败，**未必是「链路坏」，
也可能是两个消费者互相挤掉的** —— 两种解释在数据里长得一样。

证据（同一时间窗）：hwb 在 `01:45:47` 报「ssh 隧道子进程异常退出」，`01:45:51` 报
「远程 SSH 连接已恢复」，随后 `01:46–01:55` 连续报 ssh 连接失败；而这段时间正是本次工作
ssh 最密集的时候。另外复核时发现远端 `dsh web` **被重启过**（PID 2294 → 408058，
启动于 01:54）——重启未必由本次工作引起，但 hwb 的恢复逻辑本身就会重建连接、重开实例。

**结论怎么用**：soak 的失败率应读作「该链路在**有竞争**的情况下的表现」，这其实更接近
真实使用（你不可能独占这条链路）。但如果要归因到链路本身，需要在**停掉 hwb** 的窗口里
重测一轮做对照。谁都没有把这条写进结论，就容易得出「链路 X% 不可用」这种过强的断言。

早上用 `--report`（或 `--report --markdown` 直接产出可贴进本文档的表格）看结论。
报告把「**同一台机器上还有第二个 ssh 消费者**」这条caveat 一起写在数据旁边，
免得成功/失败率被单独摘出来误读。

失败也继续跑，不会因为一轮失败就退出；`run()` 同样按 §3.5 的「有界结算」写法，
一根管道被吊住不会把整夜测试悄悄停掉。报告中给出可达率、p50/p90/max 延迟、字节数、
**失败阶段分布**和去重后的错误原文——目的是搞清**它到底怎么坏**，而不是证明它好。

---

## 5. 环境侧的旁证与遗留问题

顺手确认/复核的几件事：

| 观察 | 证据 | 影响 |
|---|---|---|
| 远端 sshd 仍是默认并发限制 | `sshd: … [listener] 0 of 10-100 startups` | 即 `MaxStartups 10:30:100`；突发建连仍会丢，客户端只能靠「复用 + 错开」规避 |
| `dsh web` 没被死代理毒到 | `/proc/<pid>/environ` 里无 proxy 变量 | 它走直连；但**任何 source 了 .bashrc 的进程**都会拿到死代理 |
| 7897 反向转发是死的 | 远端在听、本机无监听、经它 0.096 s 失败 | 见 §3.3；建议清理这个残留会话或把本机代理恢复 |
| 远端默认模型是过期 id | `settings.yaml`: `deepseek-v4.1-flash-expires-on-0910` | 名字自带「expires-on-0910」。headless 实测能返回，但**建议换成 `deepseek-v4-flash`**，别依赖一个写着过期的 id |
| web 端不压缩插件 | `--compressed` 与裸下同为 3 485 976 B | 见 §6，白送的 3–4× |
| 远端资源充足 | 20 核 / 119 GB / load 0.02 | 排除主机侧瓶颈 |
| `dsh web` 复核期间被重启过 | 复核时 PID 已由 2294 → 408058，启动于 01:54，`HTTP 200` 用时 1.7 ms | 结论不变（它走直连、没被死代理毒到）；但提醒两点：**别在文档里写死 PID**，以及当晚本机有 hwb/其他会话同时在管这台机器，重启未必与本次工作有关 |

---

## 6. 如果偶尔还是想开 UI：按性价比排序

1. **服务端压 `/plugins/*`（改动最小）。** 现在一个字节都不压（`--compressed` 与裸下
   完全同字节）。在 dgx21 本机实测这 46 个 bundle 的可压性：

   | | 字节 | 相当于 |
   |---|---|---|
   | 原样 | 3 485 976 | 3.32 MB |
   | `gzip -9` | **813 796** | **0.78 MB** |
   | 压缩比 | **4.28×** | 省掉 2.54 MB |

   （`brotli` 在 dgx21 上没装，所以**没在远端量**。改在本机量了一份**同类语料**：
   85 个 dsh client bundle、3.10 MB，`brotli -q 11` 是 646 341 B，比 `gzip -9`
   的 773 452 B **再小 16.4%**——原先写的「10–15%」是估的，实测偏保守。
   该语料自身 gzip 比 4.01×，与远端那批的 4.28× 同量级，说明两者可比。
   注意这是**同类语料的比值**，不是远端那 46 个文件的逐字节重测。）
   首屏 3.34 MB → 约 0.79 MB（gzip）。
   仓库里已有现成的反向代理缓存方案（`scripts/dsh-http-cache.Caddyfile`、
   `dsh-http-cache.nginx.conf`），在里面开 gzip 即可。

   > **但要如实说清它救不了什么**：如果访问路径是 hwb 的 `ssh -C` 隧道，**传输层本来就
   > 在压缩**，这 4.28× 就不会再叠加一次，收益主要体现在「避免重复压缩」以及
   > 不经隧道的直接访问。隧道场景下的正解仍然是不用浏览器（§2）。
2. **静态资源强缓存**（同上两个文件已实现的思路）。`client.js?rev=<hash>` 是内容寻址的，
   配 `Cache-Control: immutable` 后，首屏只在**首次**贵；此前实测浏览器命中缓存后确实会快。
3. **保住一条暖 master**。首屏是 46 个并发请求，冷握手 9 KB × 并发 + 慢握手正是
   撞 `MaxStartups` 的推手；master 复用能显著降失败率。
4. **VPN 网关做 MSS clamping（或 tun MTU 调到 1380）**。`utun8` MTU=1500 而路径 MTU≈1428，
   1400 B 段丢 33–38%、1472 B（DF）100% 黑洞——慢握手正是未认证队列堆积的根因之一。
   本机可先 `sudo ifconfig utun8 mtu 1400` 试（可回滚）。
5. **抬高远端 sshd `MaxStartups` / `MaxSessions`**。要 sudo，且用户已明确否决改 sshd
   （改坏的代价远大于收益），故仅列为选项。

---

## 7. 常用操作

```sh
# 探链路（不花钱，不调模型）
node scripts/dsh21.mjs --probe

# 发一条指令
node scripts/dsh21.mjs "统计 /data/work 下每个样本的 reads 数，写成 csv"

# 在指定远端目录里干活（目录不存在会**直接失败**，不会偷偷在别处跑 —— 见下）
node scripts/dsh21.mjs --cwd /home/bot/data "跑 make -j4 并报告错误"

# 带副作用的任务：要求「只有证明没开始过才重试」
node scripts/dsh21.mjs --require-verified --attempts 3 "把结果推到 /Files/Result/…"

# 长任务 / 链路不稳：脱离连接跑，再回来取
id=$(node scripts/dsh21.mjs --detach "分析这批样本并写报告")
node scripts/dsh21.mjs --status  $id
node scripts/dsh21.mjs --collect $id

# 只想看这次花了多少线上字节
node scripts/dsh21.mjs --measure "print the hostname"

# 手动模拟一条 4 KB/s 的链路（注意单位：kbyte=千字节，kbps=千比特，差 8 倍）
node scripts/dsh21.mjs --shim-rate-kbyte 4 "print the hostname"

# 通宵 soak + 早上看报告
nohup node scripts/soak/soak.mjs > scripts/soak/results/soak.log 2>&1 &
node scripts/soak/soak.mjs --report              # 给人看
node scripts/soak/soak.mjs --report --markdown    # 直接贴进交付文档的表格
```

> **`--cwd` 不存在时一律失败**（退出码 90、`phase=bad-cwd`、**不重试**）。
> 这条是修出来的：原先 `cd` 失败后 shell 会继续往下跑，于是
> `--cwd /data/work "make -j4"` 在**没有**该目录的机器上会跑到 home 目录里执行、
> 还返回成功 —— 静默跑错地方比报错危险得多。

一次性手动用法（不依赖 wrapper）：

```sh
ssh dgx21.tun 'export PATH=$HOME/.local/node/bin:$PATH; dsh --profile headless "你的指令"'
```

## 8. 怎么复现本文的每个数字

本文所有数字都能重跑出来。下表给出**claim → 命令 → 期望**，
命令在你的机器上执行（除注明外都会真的连远端）。

| 结论 | 复现命令 | 期望看到 |
|---|---|---|
| 远端环境就位、通道可用 | `node scripts/dsh21.mjs --probe` | `reachable yes`、`dsh 0.1.1-rc.2`、`headless_profile present` |
| 一条指令能跑完 | `node scripts/dsh21.mjs "Reply with exactly the single word PONG and nothing else."` | `PONG` |
| 冷启动线上字节 ≈ 9.6 KB | `node scripts/dsh21.mjs --measure "print the hostname"` | `wire 9 473–9 865 B`（sd ≈ 85 B） |
| 暖启动边际 ≈ 0.7 KB | 见下「暖启动」小节 | 约 700–1100 B |
| web 首屏 3.34 MB / 46 bundle | `node scripts/soak/bundle-weight.mjs --host dgx21.tun` | `3 501 190 B`、`46 bundles`、`server compresses… NO` |
| gzip 能省 4.28× | 同上 | `813 796 B`、`4.28x smaller` |
| 2 kbit/s（0.25 KB/s）也能跑通 | `node scripts/dsh21.mjs --shim-rate-kbps 2 "Reply with exactly the single word PONG and nothing else."` | 成功，约 34 s |
| 4 KB/s 只要几秒 | `node scripts/dsh21.mjs --shim-rate-kbyte 4 "Reply with exactly the single word PONG and nothing else."` | 成功，约 4 s |
| 坏链路下不重复执行 | `node scripts/dsh21.mjs --json --attempts 3 --shim-reset-pct 100 --shim-reset-after-ms 5000 "Run the shell command 'sleep 8' and then reply with exactly PONG."` | `ok=false`、`attemptsUsed=1`、`phase=started-remote` |
| 握手期断则安全重试 | `node scripts/dsh21.mjs --attempts 5 --shim-reset-pct 30 --shim-reset-after-ms 700 "Reply with exactly the single word PONG and nothing else."` | 多数情况**第 1 次就成**；stderr 出现 `marker absent`。每连接 30% 失败时：第 1 次成功 70%、累计 91%（2 次）、99.8%（5 次），期望尝试 1.43 次 |
| 长任务脱离连接 | `id=$(node scripts/dsh21.mjs --detach "Run 'sleep 20' then reply DONE.")` → `--status $id` → `--collect $id` | 先 `running`，随后 `DONE`、`rc=0` |
| 断线也取得到结果 | `--collect` 时加 `--shim-reset-pct 60` | `failedPolls≥1` 但仍然返回答案 |
| **零下载** | 开工前 `nodownload-check --snapshot base.json`，收工后 `--compare base.json` | `UNCHANGED: no package store, cache or profile was created or written` |
| 通宵稳定性 | `node scripts/soak/soak.mjs`，事后 `--report --markdown` | 可达率 / 延迟分位 / 重试分布 / 失败阶段 |
| 工具本身正确 | `npm test` | 全绿（本次工作结束时 761 项） |

**暖启动（712 B）怎么复现**：需要让多条指令共用一条 master，而 `--measure` 会为了
量准**强制独占连接**，两者不能同时用。所以用一个**监听模式**的量具包住整条链路，
再让两个进程共用同一个 master：

```sh
SHIM=scripts/soak/net-shim.mjs; S=/tmp/all.json; rm -f $S
node $SHIM --listen 127.0.0.1:0 --target 10.8.0.21:22 --stats $S --quiet &
# 取它打印的端口，建一条 master
ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null     -o ControlMaster=yes -o ControlPath=/tmp/shared-master -o ControlPersist=600 \
    -N -f -p <上一步的端口> bot@127.0.0.1
B0=$(node -e "console.log(require('$S').totalBytes)")
for i in 1 2 3 4 5; do node scripts/dsh21.mjs --control-path /tmp/shared-master --status 000000000000 >/dev/null 2>&1; done
B1=$(node -e "console.log(require('$S').totalBytes)")
node -e "console.log('per warm call ≈', Math.round(($B1-$B0)/5), 'B')"
```

> 注意：`--measure` 与「共用 master」互斥是**刻意的**——复用 master 的调用不会走自己的
> ProxyCommand，量具就完全看不到流量，只会安静地报 0。这一点在 §3.6 里也踩过。

---

## 9. 边界与未采纳的路线

### 9.1 评估过、但决定不做的两条路

- **`dsh --profile sdk`（JSON-RPC 常连接）**：这是多轮对话的正解，但远端**没有**装
  `dsh-sdk-app` / `dsh-sdk-jsonrpc-server` / `dsh-sdk-protocol`，走这条路必须下载
  —— 与「尽量不要下载」直接冲突，故放弃。
- **手写小客户端直连正在跑的 web 实例**（payload 也是 KB 级，且能复用你现有会话）：
  技术上 HTTP 端口就在那儿，但服务端是 **Typert RPC**——host 端 `ctx.typertGateway`、
  client 端 `ctx.remote`，两侧消费**同一份生成的 InvocationDescriptor 契约**，还有
  多路复用流与重连语义。手写等于自己重新实现一遍客户端 SDK，且跨 dsh 版本会碎
  （此前排查也记录过 `session/list` RPC 直接 404、工作台只能回退到文件索引）。
  **收益（复用会话）不值得这个脆弱度**，故不做，改为在 §6 给出提升 UI 本身的方案。

### 9.2 边界

- **一次性**：每次调用是一个**全新**会话，没有多轮对话。要接着聊就把上下文写进指令里。
- **没有 TUI 这条路**（试过了）。曾照着 CLI help 里的例子在远端建了个 `tui` profile，
  结果它只挂 `dsh-base`、**没有任何终端 UI**：`dsh --profile tui` 不报错、也不输出，
  就那样**静默挂住**（`--help` 同样挂住）。这是个只会制造困惑的坑，所以已经把它**从远端删掉**了，
  远端 profile 现在只剩 `headless`（本次新增）与 `web`（原有）。
  换言之：多轮交互没有零下载方案（`sdk` profile 要下载，见 §9.1），
  只能用「把上下文写进指令」的方式串。
- 远端残留物是有界的：`~/.dsh21/state`（标记，25 个文件 / 104 KB）与
  `~/.dsh21/runs`（detach 的脚本+日志+退出码，6 个文件 / 28 KB），
  两者都靠 `find -mtime +2 -delete` 自清。
- 标记文件按 2 天自动清理；成功的那次不回删（省一次往返），目录有界。
- 默认 `--attempts 3` 只覆盖**证明没开始过**的失败；需要更高可用性请显式
  `--retry-started`（**仅幂等任务**）。
