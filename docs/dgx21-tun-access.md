# dgx21.tun 通过 hwb 端口转发「经常进不去」排查记录

日期：2026-09-13
路径：hwb 工作台 → 远程实例 `dgx21.tun`（`ssh://bot@dgx21.tun:3080`，homeId=`fe53172819028365`）

> **2026-09-14 复核提示：下文是多轮历史排查记录，早期“根因”“已修复”不能作为当前故障的最终结论。**
> 本次发现独立的代理连接池饥饿与 HTTP 故障恢复缺口，详见文末；不修改远端 sshd。

> **本文更正了同日晚间的一个错误结论。** 最初把原因归为 `RemoteForward 7897` 端口冲突与
> 「VPN 路径停顿」，那两条都真实存在但**不是主因**。下面是复现验证后的结论。

---

## 结论：dgx21 的 sshd `MaxStartups` 丢连接

**根因**：dgx21（及所有 .tun 主机）使用 sshd 默认 `MaxStartups 10:30:100`。
该 VPN 链路握手慢（实测 SSH 首次建连 11.7–14.0s，见 `src/control/ssh-opts.js` 注释），
于是 hwb 并发发起的多条 ssh 会在 sshd 的**未认证队列**里堆积超过 10 条，
sshd 随机丢弃其中约 30% → 报 `Connection closed by 10.8.0.21 port 22`。
当被丢的恰好是隧道进程时，隧道以 `exitCode=255` 死亡 → 实例 `degraded` → **用户进不去**。

### 复现证据（决定性）

同一目标、同样 25 条连接，**只改并发方式**：

| 实验 | 结果 |
|------|------|
| 25 条**同时**发起（burst） | **5/25 失败**，报错 `Connection closed by 10.8.0.21 port 22` / `kex_exchange_identification: read: Connection reset by peer` |
| 25 条**错开 0.6s** 发起 | **0/25 失败** |
| 8 条并发（低于 MaxStartups=10） | **0/8 失败** |
| 逐条串行（历次测试） | 20/20、25/25、20/20 全通过 |

对照组：同样 25 并发打 `c4g.tun`（同一 VPN）也 **4/25 失败**，同样报错
→ 不是 dgx21 独有故障，而是 **sshd 默认值 + 慢握手的通病**。

### hwb 日志侧证据

`~/.hwb/hwb.log`（含 `.1` 轮转）：

- **隧道异常退出 192 次**，其中 **121 次（63%）** stderr 正是
  `Connection closed by 10.8.0.21 port 22`；另有 `connect ... Operation timed out` 32 次、
  `Timeout, server 10.8.0.21 not responding.` 14 次
- **实时会话同步失败 583 次**（`auth timeout` / `auth fetch failed` / `rpc http 404` / `auth http 502`）
- **实例降级 77 次**
- 用户可感知中断：**57 次降级→恢复配对，中位 7s，最长 164s**（>10s 占 19/57，>60s 占 5/57）
- 退避耗尽（`SSH 重连快退避已用尽，转为慢速常驻重试`）9 次
- `ssh bash timed out after 90000ms` 105 次（remote-reader / indexer）

最近一次隧道死亡：`2026-09-13T21:41:19`，`Timeout, server 10.8.0.21 not responding.`，5s 后恢复。

### 为什么表现为「经常」而不是「总是」

串行 / 低频时**永远成功**（所以手动 ssh、单点测试都正常）；只有 hwb 并发发起
（隧道 + mux master + sshPathExists + remote-reader + indexer + live-status）
且恰好撞在慢握手窗口时才丢 —— 概率性，故为「经常」。

---

## 决策：不改远端 sshd

**远端 sshd 配置不做改动**（用户明确否决：改坏 sshd 会导致彻底连不上服务器，
风险远大于收益）。以下客户端方案即为最终路线，服务端一节仅作为背景记录。

补充实测（2026-09-13）：服务端同时有两道**默认值都是 10** 的墙，方向不同但都卡在 10：

| 路径 | 撞的墙 | 典型报错 |
|------|--------|----------|
| 新建连接（隧道，`mux:false`） | `MaxStartups 10:30:100`（未认证连接队列） | `Connection closed by 10.8.0.21 port 22` |
| 复用 master（`mux:true`） | `MaxSessions 10`（单连接上的并发 channel） | `mux_client_request_session: session request failed: Session open refused by peer` |

**复用 master 显著更稳**（同为目标 dgx21、同时长）：

- 不复用（各建连接）：25 并发 → **5/25 失败**
- 复用已有 master：25 并发 → **1/25 失败**；16 并发 → **0/16 失败**

→ 客户端最有效的杠杆是**让调用复用常驻 master，并给「必须新建连接」的路径
（隧道）串行化/错开**，把每主机瞬时未认证连接数压到远低于 10。

---

## 修复（客户端路线）

### 1. 服务端（已否决，仅存档）

dgx21 上 `sudo` 需要密码（`sudo: a password is required`），故需人工执行。
Ubuntu 24 的 `/etc/ssh/sshd_config` 第 12 行已有 `Include /etc/ssh/sshd_config.d/*.conf`，
用 drop-in 最干净：

```bash
# 在 dgx21 上执行
sudo tee /etc/ssh/sshd_config.d/99-hwb-concurrency.conf >/dev/null <<'EOF'
# hwb 经 tun 并发建连时会撞上 MaxStartups 默认值 10:30:100，
# 慢握手导致未认证队列堆积、sshd 随机丢连（Connection closed by ... port 22）。
MaxStartups 100:30:300
MaxSessions 50
EOF
sudo sshd -t && sudo systemctl reload ssh
```

**同样要对 `c4g.tun`(10.8.0.12) 及其他 `.tun` 主机执行**（对照组已证明它们同病）。

### 2. hwb 代码：隧道改走既有 master（已实现，本文件对应改动的落点）

`src/control/tunnel.js` 的 `openTunnel` 现在**优先复用既有 master**：
用 `ssh -O forward -L …` 把 `-L` 挂到常驻 master 上，**完全不新建 ssh 连接** ——
master 已是认证态，因此绕过 `MaxStartups` 那条未认证队列。无 master 时才回退为
原来的 `ssh -N -L` 独占连接（行为与修复前完全一致）。

几个关键实现点（都踩过坑）：

- `muxControlPath()` 先看套接字文件是否存在，不存在就直接跳过 `ssh -O check`：
  「无 master」是最常见路径，不该为它白等一次超时。
- `-O check` 把 `Master running (pid=NNNN)` **打到 stderr**（OpenSSH 9.x 实测），
  两个流都要解析，否则拿不到 master pid。
- master 模式没有独占子进程，故合成一个 EventEmitter 句柄给 launcher，
  保持子进程语义（`exitCode`/`signalCode`/`on('exit')`/`kill()`），
  并用 `ssh -O check` 巡检发现 master 死亡（master 一死，依附的 `-L` 同时失效）。
- **`-O cancel` 必须排在快照目录清理之前**：cancel 用的是 `-F <configFile>`，
  若先删目录，异步 cancel 会因配置缺失静默失败、转发残留（实测 bug，已修）。

实测收益（真实 dgx21）：

| 场景 | 修复前 | 修复后 |
|------|--------|--------|
| 25 个隧道并发建立 | **5/25 失败** | **25/25 成功**（全部零新建连接，HTTP 200 各一次） |
| 单条隧道 | 独占连接 | 复用 master，`viaMaster=true` |
| 端到端（隧道→反代→鉴权探测） | — | HTTP 200，鉴权探测通过 |

测试：新增 3 条用例守住「零新建连接」「kill 走 `-O cancel`」「master 死亡触发 exit」
「无 master 必须回退」；全量 **663 项测试通过**。

> ⚠️ 生效前提：**运行中的 hwb 需重启**才会加载新代码（旧进程仍持有旧实现）。

### 3. `~/.ssh/config`（仅保活加固；RemoteForward 已恢复）

- `dgx21.tun` / `c4g.tun` 加了 `ServerAliveInterval 15 / CountMax 4 / TCPKeepAlive / ConnectTimeout 20`。
- `RemoteForward 7897 127.0.0.1:7897` **一度被误删、现已恢复**：它的作用是把本机代理
  （`http_proxy=http://127.0.0.1:7897`）反向暴露给远端，让远端能出网/访问 DeepSeek API。
  当初误判为「空转」，只因删除那一刻本机 7897 恰好没有进程监听。
  实测 dgx21 经该桥访问 `api.deepseek.com` 仅 **0.64s**，而直连路径约有一半概率卡 7.5–10s ——
  这条桥顺带缓解了远端的 LLM API 超时。
  备份：`~/.ssh/config.bak.*`、`~/.ssh/config.bak.c4g.*`
- hwb 侧可调旋钮（`src/control/ssh-opts.js`）：
  `HWB_SSH_CONNECT_TIMEOUT`、`HWB_SSH_ALIVE_INTERVAL`、`HWB_SSH_ALIVE_COUNT_MAX`、`HWB_SSH_MUX`；
  本次新增 `HWB_TUNNEL_MASTER_POLL_MS`（master 巡检间隔，默认 10s）、
  `HWB_TUNNEL_MASTER_CHECK_MS`（`-O check` 超时，默认 4s）。

> 说明：`RemoteForward 7897` 对 hwb 早在 2026-09-11 就由代码处理过
> （`withoutForwardings()` 会从快照里剥掉转发指令，commit `3243989`）——日志里 6 次
> `failed for listen port 7897` 全部发生在 **2026-09-08**，即该修复之前。
> 故它与本次故障无关，**不是主因**。

### 4. 底层放大器：VPN 路径 MTU/MSS 黑洞（建议一并处理）

dgx21 出网约 50% 概率 `connect ≈ 7.52–10.03s`，其余 ≈0.01s；`tun0` MTU=1500 且无 MSS clamp，
SYN 重传计数高（`TcpExtTCPSynRetrans 6906`、`TCPLostRetransmit 7914`）。
**慢握手正是让未认证队列堆到 MaxStartups 阈值的推手**，建议在 VPN 网关做
`--clamp-mss-to-pmtu`（或把 tun0 MTU 调到 1380）。客户端配置只能缓解。

---

## 追加：「Failed to load plugins」的根因 = 压缩回归（已修）

hwb 重启后接入 dgx21，远端页面报：

```
Failed to load plugins
failed to import loader entry a59c4908 (@deepseek-ai/dsh-client-ui-conversation):
client-modules: bundle script /plugins/…/client.js?rev=cf4575517765 failed to load
```

**这与隧道能否建立无关，是带宽问题。** 排查数据：

| 观察 | 数值 |
|------|------|
| dgx21 本机取 448KB bundle | **1–2 ms**（服务端不慢） |
| 该页面要加载的插件 bundle | **46 个 / 合计 3.32 MB** |
| 经隧道的有效吞吐 | 约 **110 KB/s**（3.32 MB 需 30s） |

浏览器会在加载时**一次性并发拉全部 46 个 bundle**，在这条链路上并发争抢 → 大量请求超时 →
插件加载失败。即：**瓶颈是链路吞吐，不是隧道、不是远端 dsh。**

### 真正的元凶：复用 master 把压缩弄丢了

`-C`（压缩）原先只加在**隧道自己那条命令**上。改成复用 master 后，**真正承载数据的是 master 连接**，
而 master 由 `sshOpts()` 建立 —— 它没有 `-C`。于是压缩静默失效：

| 路径 | 46 个 bundle（3.32 MB） |
|------|------------------------|
| 独占连接（带 `-C`） | **30.4s** |
| 复用 master（无 `-C`） | **140.5s**（慢 4.6 倍） |
| 复用 master（补上 `-C`） | **32.9s** ✅ |
| 并发拉 46 个（补上 `-C` 后） | **46/46 成功**（修复前 0/46 或 7/46） |

**修复**：把 `-C` 上提到 `sshOpts()`（共享连接策略），并去掉 `tunnel.js` 里那份重复的 `-C`。
压缩必须落在**承载数据的那条连接**上 —— 加在隧道 argv 上对 master 复用毫无作用。

> 教训：复用一条既存连接时，**连接级选项（压缩、保活、超时）由该连接建立时的参数决定**，
> 调用方在自己 argv 上写什么都不生效。

### 残留风险：长命 master 会退化

实测同一个 master 连接（pid 7299，存活较久）后期把单次请求拖到 **20s**，
而同刻新建一条 master 只要 **0.5–0.8s**，独占连接 0.4s。即：**复用一条长寿连接 =
把吞吐押在它身上**，它退化时整体一起慢。

当前缓解：把退化 master 回收（`ssh -O exit`），让 hwb 重建。
**建议后续加一层健康检查**：若经 master 的探测明显慢于独占连接，就拆掉 master 改走独占，
避免再次出现「整页加载被一条坏连接拖死」。

> ⚠️ 本次改动（`sshOpts` 加 `-C`）需**再次重启 hwb** 才生效；
> 且已存在的**无压缩 master 必须回收**，否则隧道仍会挂到它上面继续慢。

---

## 已排除

- 主机资源：20 核负载 0.10、内存 114G available、磁盘用 25% —— 排除满载/磁盘满
- 主机可达性：ping 0% 丢包、22 端口开放
- `~/.dsh` 存在性：`/home/bot/.dsh` 正常存在（沙箱内一度误报 `sshPathExists=false`，
  系本会话文件沙箱阻止 unix socket bind 所致，**非真实故障**，已在沙箱外验证为 true）
- dgx21 上 dsh web 仅监听 `127.0.0.1:3080` 是**正常的**（hwb 本就经隧道访问）；
  PID 2294 健康、`HTTP 200`、已运行 2 天多

## 其他备注

- `CMS` home（homeId=`ce7dd2ece23ac5dd`）处于 degraded：`192.168.31.202:22` 不可达，
  与本次问题无关。
- 大数据禁止下载，仅回传报告、统计结果等小文件。

---

## 追加（2026-09-14）：稳定入口 = 配置的接入端口 + 转发丢失自愈

同一条链路上又定位到两个独立缺陷。前者让「配好的本地端口」根本用不上，后者让实例
**永久卡在 unreachable 且永不重建**——两者叠加才是「地址不对 + 打不开」的完整解释。

### 缺陷 1：外链给的是每次随机端口，不是配置里的本地端口

远程实例上 hwb 同时存在两个入口，前端却把它们混用成一个字段：

| 入口 | 端口来源 | 稳定性 |
|------|----------|--------|
| `iframeUrl`（内嵌标签页） | 预览代理，监听口来自已保存的 `accessPort`（本例 **49670**） | 跨重连 `retarget` 复用，**稳定** |
| `inst.url`（↗ 在外部浏览器打开） | `#connectRemote` 为**本次连接**另建的反代，`tunnel.js` 的 `freePort()` 让内核随机分配 | 重连即换（实测 57686 → 52594 → 55934） |

`renderTabs` 的 ↗ 按钮此前用 `pane.externalUrl = inst.url`，于是把「短命的运行地址」交给用户，
复制/收藏后随隧道重建立刻失效。**修法**：新增 `externalUrl`（远程实例 = 预览代理地址）贯穿
launcher → monitor → 前端 `pane.popoutUrl`；`pane.externalUrl` 保留「本次连接地址」语义，
只用于入口变更判定（隧道换端口仍会强制重新认证一次，因为 `retarget` 会掐断 iframe 的实时通道）。

### 缺陷 2：`ssh -O check` 说 master 活着，但 `-L` 已经不在了

2026-09-14 00:02 起的现场：`ssh -O check` 回 `Master running (pid=71088)`，
而 `lsof -nP -iTCP -sTCP:LISTEN` 里**一个 ssh 监听都没有**（实测计数为 0）。
原因是旧 master 崩溃后，新连接用同一个 `ControlPath` 复用了套接字文件，
`masterAlive()` 只问「master 进程在不在」，于是 hwb 认为隧道健康：既不重建也不报错，
实例永久停在 `unreachable`，稳定入口只会回 `proxy: upstream error — connect ECONNREFUSED 127.0.0.1:52594`。
这正好命中本文件早先记的「长命 master 会退化」风险的更严重变体——不是变慢，而是彻底不再自愈。

**修法**：`masterTunnel` 的巡检改为 liveness =「master 存活」**且**「本地转发口能建立 TCP 连接」
（`forwardListening()`，超时 `HWB_TUNNEL_FORWARD_PROBE_MS`，默认 2s）。任一条不成立即 `finish(255)`，
由 launcher 走既有恢复流程重建转发。该探测只测 ssh 监听口本身，不经过远端，因此不会因远端慢而误判死亡。

### 实测（重启后，2026-09-14 00:10–00:12）

```
POST /api/homes/fe53172819028365/open
state = running | externalUrl = http://127.0.0.1:49670/ | url = http://127.0.0.1:55934（随机，仅内部用）
ssh 监听：127.0.0.1:55910（master 71088 上的 -L）

稳定入口 49670 连续 10 次探测（每 12s）：全部 http=200，0.091–0.188s
```

此前同一入口的实测是 12.4s / 21.0s / 30s 超时 / `proxy: upstream error — socket hang up`。
即：**大部分「打不开」来自上面两个缺陷（随机地址 + 转发丢失后不自愈），而不是链路本身的带宽**。

### 仍未解决（需远端权限）

远端 sshd `MaxStartups 10:30:100`（本文件主结论）没有改动——它需要 dgx21 上的 sudo，
本次只保证「被丢弃/断开之后 hwb 能正确发现并重建」，不再出现永久卡死。


## 2026-09-14 再次复核：代理连接池饥饿与恢复缺口

逐层现场检查：远端 DSH 本机 HTTP 200（约 2ms）；经既有 master 执行 curl 约 0.3s；
SSH 转发口 62967 HTTP 200（3.058s）；内部代理 62972 和固定入口 49670 均 5s 超时，
固定入口另一次 12s 超时。这组证据不能归因为远端 DSH 停止或 SSH master 全面失效。

代码层可重复复现：两个串联代理、3 条 SSE 订阅即可占满默认 maxSockets=3 的普通 HTTP 池，
后续页面无法取得连接。旧代码测试在 1.2s 超时；修复后相同测试约 9ms 完成。
这证明了独立阻塞机制，但不等同于复原每一次历史超时的具体连接占用。

修复内容：SSE 响应头到达后用 Node Agent 的 agentRemove 释放普通请求配额；
排队/等待响应头设 30s 上限，普通响应体设空闲超时，SSE 建立后取消空闲超时；
关闭/切换销毁旧池；客户端断开取消延迟重试。
Monitor 原先名为 scheduleReconnect，实际只 refresh；现在连续 3 次失败后调用
Launcher.recoverConnection，沿用已有重建与取消机制，成功后保留固定入口、替换旧代理。

边界更正：MaxSessions 针对 shell/login/subsystem，不直接限制 direct-tcpip 端口转发。
此前仅根据默认值 10，把 HTTP 连接池压到 3 来“规避 MaxSessions”的论证不成立。
此前关于 MTU/MSS 黑洞、所有 tun 主机统一根因的断言，本轮未验证，不作为修复前提。

---

## 追加（2026-09-14 第二轮）：真正的「打不开」= 远端 MaxSessions 10 被撞穿

第一轮的稳定入口与自愈修好后，页面**仍然**打不开。用无头 Chrome + CDP 抓包定位到确切失败点：

```
title="DeepSeek Harness"
body  = "HARNESS\nFailed to load plugins\nfailed to import loader entry … (@deepseek-ai/dsh-client-ui-sidebar):
         client-modules: bundle script /plugins/…/client.js?rev=… failed to load"
非 2xx 请求 4~10 个：[502] /plugins/**/client.js、[502] /api/session.list、[502] /api/workspace.list
失败请求：net::ERR_ABORTED /plugins/…；WebSocket ws://127.0.0.1:49670/api/events.host 建立失败
```

### 根因：复用 master 时，一条 ssh 连接只有 10 个 channel

复用同一 master 顺序开 15 条会话，**1–10 全部成功、11–15 全部被拒**：

```
mux_client_request_session: session request failed: Session open refused by peer
```

即 sshd 默认 `MaxSessions 10`（**每连接**的并发 channel 上限）。而 hwb 把所有流量复用同一条 master：

| 消费者 | 占用 channel |
|---|---|
| 浏览器首屏（HTTP/1.1 每 origin 最多 6 连接） | ~6 |
| dsh 实时通道（WebSocket/SSE） | 1–2 |
| hwb 实时会话轮询（3s 一次，也走隧道） | 1–2 |
| hwb 索引器 / 探测（`ssh host cmd`） | 1–3 |

合计稳定越过 10 → 多出来的 channel 被远端拒 → 本侧的转发连接被掐 → 代理回
`proxy: upstream error — socket hang up`（502）→ 插件加载器对**任何一次**失败都整体报错
（浏览器自己不会重试）→ UI 起不来。

### 修复（都在 hwb 侧，不动远端 sshd）

1. **上游瞬时失败重试一次**（`proxy.js`）：仅 GET/HEAD、仅在上游连接阶段失败且尚未向客户端写出
   字节时，间隔 150ms 重试。判据用**响应**侧 `res.destroyed`，不能用 `req.destroyed`
   （GET 的请求体读完就被 Node autoDestroy，用它会让重试永不触发 —— 实测踩到）。
2. **上游连接池上限**（`proxy.js`）：每个代理自带 keep-alive Agent，HTTP 至多 3 条上游连接、
   升级单独一池（2 条），多余请求本地排队。因为「每条转发 = 1 个 channel」，这直接把隧道占用的
   channel 钉死在 5 以内，给 hwb 自身的 ssh 命令留余量。`close()` 时销毁空闲上游连接。

**复测（同一页面、同一 CDP 手法）**：请求 10 个、非 2xx **0**、失败请求 **0**、控制台异常 **0**，
首屏文本从 `Failed to load plugins` 变为 `Loading plugins…`（在正常排队下载，不再报错）。

### 仍未解决：链路吞吐 ~25-30 KB/s（本轮无法在 hwb 侧解决）

| 载荷 | 丢包 | RTT 均值 |
|---|---|---|
| 100 B | 0 % | 112 ms |
| 600 B | 3.3 % | 124 ms |
| 1200 B | 12–20 % | 467 ms |
| 1400 B | 33–38 % | 388 ms |
| 1472 B（DF） | 100 %（黑洞） | — |

本机 VPN 口 `utun8` MTU = 1500，而路径 MTU ≈1428：满尺寸段全丢。三台 `.tun` 主机吞吐一致偏低
（dgx21 25、c4g 30、cms 37 KB/s）。dsh 首屏 1.2 MB+，所以**首次**加载要 1–2 分钟
（之后浏览器按 `immutable` 缓存命中，会快）。

最低成本的网络侧动作（本机、可回滚）：`sudo ifconfig utun8 mtu 1400`；
彻底解决需要 VPN 网关做 MSS clamping(1380)。另一条思路是换一条到同一台机器的路由 ——
`dgx21.lo`（10.191.39.167，用户 bgi）TCP 可达但 sshd 立即断开连接（`Connection closed … port 22`），
需要正确凭据才能用来做对照。


### 最终实现与验证

- 普通请求池和插件/静态资源池分开，各默认 3 个并发，防止大文件下载挡住根页面、鉴权和 RPC。
  普通请求响应头/空闲超时默认 30s；静态资源至少 120s，为慢链路批量加载留出排队余量。
- 非注入响应立即 flushHeaders，无正文的 SSE 也能穿过双层代理；SSE 不占普通池配额。
- 最终串行全量套件：679/679 通过。此前并发全量中，未修改的 merged-index 健康实例超时用例失败，
  单独及串行执行均通过；不把它写成默认并发套件全绿。
- 真实 DSH 维持 3 条 `/plugins/events` SSE 的临时双层代理：3 次根页面均 HTTP 200，322/119/122ms。
- 正式 hwb 已重启加载最终代码（PID 22169），恢复 MBP 与 dgx21 原有接入，入口仍为 49670。
  在真实插件加载期间连续 6 次根页面 HTTP 200（2.805/7.553/8.460/3.838/7.284/6.559s）。
- 浏览器已见完整 DSH UI：工作区树、会话列表、输入区与模型选择器。
  首次插件加载仍耗时约数分钟，尚不能声称消除了链路吞吐瓶颈或长期稳定性已获证明。
- 独立 SSH 临时对照未表现出持续优势（独立 2.662/0.761s，共享入口 1.063/2.098s），
  不据此改动共享 SSH 方案；临时测试隧道已回收，远端 sshd 与 DSH 均未重启。
- 仍有 `session/list` RPC HTTP 404（工作台回退文件索引），属于现有实时接口兼容问题，
  不能与 DSH 页面加载成功混为一谈。本轮不扩大到接口适配。


刷新复核：独立固定入口刷新后再次出现完整工作区和输入界面。
刷新期间另 6 次根页面探测均 HTTP 200，耗时 2.991/0.934/3.376/0.585/4.849/4.693s。
短时可达性已经改善，插件初次/刷新加载仍慢；浏览器首轮曾记录 Cordis inventory HTTP 502，
因此不声称所有插件后台 API 均已通过。本轮验证不包含发送模型请求。

最终内嵌验证：hwb 的 dgx21 标签页也完成加载，iframe 中可见工作区选择、输入框和模型选择器；保留该标签供用户检查。


## 2026-09-14 第三轮（**本次未开 Clash Verge**）：慢的根因 = VPN 核心 ~1 Mbps 上限 + 2–4% 丢包

本轮把「慢」量化到根因，并**排除了客户端侧的一切嫌疑**（不含 Clash Verge 在内的本机网络/CPU/TCP 参数）。
决定性证据是**VPN 内部两台主机之间的同一劣化曲线**——这条路径完全不经过本机 ISP。

### 结论（三层，按贡献排序）

| # | 机制 | 量化 | 位置 |
|---|------|------|------|
| 1 | **隧道总带宽 ~1 Mbps 且超出即丢包** | 交付上限 ≈ 110–125 KB/s（≈0.9–1.0 Mbps） | VPN 核心（集中器 120.55.124.219 及其到各站点的链路） |
| 2 | **~2–4% 基础丢包 + 95–100 ms RTT → TCP 拥塞窗塌到 2–3 段** | 单连接 25–50 KB/s；`cwnd=2–4`、`ssthresh=2`、`tot_retrans 28–57/10s` | 同上（丢包在核心内） |
| 3 | **隧道内 PMTU 断崖（≥1348 B 全丢）** | `tun-mtu 1400` + `mssfix 1360` → 实际 MSS 1272–1284（段 1312–1324），**余量仅 ~25 B** | 客户端 tun 与服务端 tun0 配置不一致 |

第 3 条当前被 `mssfix` 恰好压到断崖之下，所以**不再是主因**；但余量只有二十几字节，
这正是历史上「偶发 7.5–10 s 卡住」的来源。第 1、2 条**客户端无法消除**。

### 排除项（本轮实测，均为不含隧道时/本机项）

| 项 | 实测 | 结论 |
|---|---|---|
| 本机外网带宽 | Aliyun 镜像 **14.9 MB/s**、清华 **32.4 MB/s** | 不是本机/接入网 |
| 局域网到网关 | 192.168.31.1：**0% 丢包，5.1 ms** | 不是 Wi-Fi |
| 外网到集中器 | ping 120.55.124.219：**0% 丢包，44.5 ms** | 客户端到集中器这一段干净 |
| Clash Verge | 未运行（只剩特权 helper PID 298；无核、无 7897 监听、无 proxy 环境变量） | 与本轮慢无关 |
| macOS TCP 参数 | recvspace/sendspace 131072、autorcvbuf 开、win_scale 3、PMTUD 开 | 正常 |
| DNS | 114.114.114.114 **能正常解析**（约 40 ms），只是不回 ICMP（早前「DNS 100% 丢包」的判断作废） | 与慢无关 |
| 对端主机负载 | 20 核 load 0.43、内存充足 | 不是 dgx21 本身 |

### 关键测量

**1) 隧道 RTT 与吞吐（单连接，2 MB SSH 传输）**

```
隧道内 ping 10.8.0.21     : 95–113 ms avg（外网到集中器仅 44 ms）
dgx21.tun 25.8 KB/s · c4g.tun 31.7 KB/s · cms.tun 40.3 KB/s   ← 三台 .tun 主机同一量级
```

**2) 对端 TCP_INFO（dgx21 作发送方发往本机）——窗口不是瓶颈，丢包才是**

```
mss=1284  cwnd=2  ssthresh=2  rtt=99ms  tot_retrans=57/10s  rwnd_lim=0 sndbuf_lim=0 busy=10.2s
mss=888   cwnd=3  ssthresh=2  rtt=122ms tot_retrans=45/10s
mss=588   cwnd=3  ssthresh=2  rtt=97ms  tot_retrans=30/10s
mss=288   cwnd=16 ssthresh=8  rtt=87ms  tot_retrans=28/10s   ← 段变小只是把 cwnd 抬高，总速率仍 ~30 KB/s
```
`rwnd_limited=0` / `sndbuf_limited=0` ⇒ **不是接收窗、不是发送缓冲**；`ssthresh` 反复被打回 2 ⇒ 持续丢包事件。

**3) UDP 序列号探测（本机 → dgx21，600/1200 B，无重排）**

| 提供速率 | 丢包 | 交付 |
|---|---|---|
| 56 KB/s | 2.1% | ~55 KB/s |
| 87 KB/s | 4.4% | ~84 KB/s |
| 117 KB/s | 17.9% | ~96 KB/s |
| 175 KB/s | 36.4% | ~112 KB/s |
| 335 KB/s | 65% | ~125 KB/s |
| 937 KB/s | 87% | ~125 KB/s |
| 300 B @ 88 KB/s | 0.2% | 88 KB/s |

600 B / 100 pps 那组另做了到达顺序统计：`OOO=0（0.00%）`，单程时延分布集中在相差 ~10 ms 的两个簇、
尾部到 +68 ms ⇒ **不是乱序**（也未见明显多路径分裂），是真的丢包；交付曲线封顶 ≈ **110–125 KB/s**。

**4) 决定性对照：VPN 内部主机对主机（dgx21 10.8.0.21 → c4g 10.8.0.12）**

| 提供速率 | 丢包 | 交付 |
|---|---|---|
| 55.8 KB/s | **3.8%** | ~54 KB/s |
| 111.6 KB/s | **19.5%** | ~90 KB/s |
| 334.8 KB/s | **67.3%** | ~111 KB/s |

**与本机作客户端时几乎逐点重合，且完全不经过本机 ISP。** 这条对照把责任锁死在
**VPN 核心（集中器及其到各站点的链路）**：既不是本机、不是本机 ISP、不是 Clash Verge、不是 dgx21。

**5) 并发能否补救**

4 路 / 8 路并发 TCP：单流速率下降，**总和稳定在 ~105–120 KB/s**（与第 3、4 项同一上限）。
即：并发只能「把单流丢掉的份额抢回来」，**顶不到 1 Mbps 以上**。

### PMTU 断崖（次要，仍建议修）

```
ICMP DF: payload 1300 (IP 1328) 0% 丢包；payload 1310 (IP 1338) 起即为 100% 丢包
          （即断崖在 IP 1328–1338 之间；不带 DF 的 1228/1268 也曾出现 12–40% 抖动，属基础丢包）
本机 utun4 MTU=1400（OpenVPN `tun-mtu 1400`）；远端 tun0 MTU=1500；无 PMTU 回馈（黑洞）
当前 profile: tun-mtu 1400 + mssfix 1360 → 实际 MSS 1272–1284（段 1312–1324），余量 ~25 B
```
建议（需用户操作，profile 在工作区沙箱之外）：
`~/Library/Application Support/OpenVPN Connect/profiles/*.ovpn` 改 `tun-mtu 1300` + `mssfix 1240`，重连后生效；
这能消除「满尺寸段偶发全丢 → 卡 7.5–10 s」，但**不会提高 ~30 KB/s / ~1 Mbps 的上限**。

### 可操作结论

1. **提速没有客户端解**：~1 Mbps 上限在服务端。要提速只能找 VPN 管理员（120.55.124.219），
   并可以直接引用上面的「主机对主机」对照（同为 VPN 客户端，不经用户 ISP）。
2. **并发是唯一有效的客户端杠杆**：单流约 30 KB/s、总量约 1 Mbps ⇒ 3–5 路并发 ≈ 3 倍。
   hwb 代理池（普通 3 + 升级 2）已接近上限，这解释了本文件上一轮「46 个 bundle / 3.32 MB ≈ 33 s」的实测。
   再往上加并发收益很小，且会挤占同一条 master 的 channel。
3. **带宽预算**：DSH 首屏 3.32 MB ÷ ~100 KB/s ≈ 30–35 s（首访），之后靠 `immutable` 缓存。
   任何「远端跑完再传结果」的方案都比「远端边跑边同步到本地」划算。
4. **顺手修**：`mssfix 1240`（余量）+ 关掉 Clash 未运行时的 `RemoteForward 7897`（每次连接都会告警）。
5. 本机网络中途切换过一次（`en0` 192.168.31.76 ↔ 172.20.10.3 iPhone 热点，OpenVPN 于 01:36:43 重连），
   切换瞬间会掐断在途传输——排查期间若看到「突然卡住」，先确认 `ipconfig getifaddr en0` 是否变了。

### 复现方法（临时脚本，均落在 /tmp，事后已清理进程）

- 对端 `python3` 起一个 TCP/UDP 计数器服务（记录 `seq`、字节数、`TCP_INFO`），本机按固定 pps 发
  `struct.pack('<III', seq, size, ms)` 载荷；结束后发 `end` 标记、对端回传统计。
- 关键点：`TCP_INFO` 的 `cwnd/ssthresh/rwnd_limited/sndbuf_limited/tot_retrans` 是本轮定性的核心；
  单纯看「带宽」会误判为窗口/MTU 问题。
- 对照必须做「VPN 内主机对主机」，否则无法区分客户端 ISP 与 VPN 核心。
