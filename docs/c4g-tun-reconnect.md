# c4g.tun 上 dsh 客户端反复「Reconnecting」——链路侧排查与处置

日期：2026-09-19
对象：hwb 工作台里的远程实例 `c4g.tun`（`ssh://bot@c4g.tun:3080`，homeId=`ecd10877bad61ddc`，
远端 = 10.8.0.12，Ubuntu 24.04，256 核 / 257 GB）
相关：[`dgx21-tun-access.md`](./dgx21-tun-access.md)（同病主机 dgx21.tun 的多轮排查）、
[`dgx21-lowbandwidth-channel.md`](./dgx21-lowbandwidth-channel.md)（低带宽链路的命令通道）

---

## 0. 结论（TL;DR）

1. 截图里那个 pill 是 **dsh 客户端自己的网关连接状态**（`connection.connecting` = "Reconnecting"），
   不是 hwb 顶栏的 `live` / `reconnecting…`（后者是浏览器↔hwb 的本地 SSE，跟 c4g 无关）。
   它的判死阈值很硬：一次 connection generation **3s 未就绪就告警、15s 未就绪即判失败并退避重连**
   （`dsh-client-connection` 默认 `backoffBaseMs=500`、×2、上限 10s）。
2. **c4g 这台机器与它上面的 dsh 都没问题**（见 §1 现场核对）。问题在「hwb → c4g」这条链路上。
3. 三层原因，按影响排序：
   - **A. sshd 仍是默认 `MaxStartups 10:30:100` + 慢握手** → 新建连接被随机丢弃（占比最大）。
     被丢的若是承载数据的 master，挂在其上的 `-L` 一起消失 → 浏览器 WS 立刻断 → Reconnecting。
   - **B. 长命 master 退化** → 复用 master 是最有效的杠杆，代价是把吞吐押在一条长命连接上；
     它一慢，整页一起慢到越过客户端的 15s 就绪门限。
   - **C. hwb 侧探测预算偏紧（4s）** → 这条链路上有秒级毛刺，4s 门槛被反复越过；
     代价是工作台在「实时 / 文件索引」之间横跳、日志每 7s 一跳（用户看得到的抖动）。
4. 处置：远端 sshd drop-in（§3.1，唯一能**真正减少**丢连的一步）+ 客户端两处加固
   （§3.2，本次已实现并带测试）+ VPN 侧 MSS clamp（§3.3）。

---

## 1. 现场核对（2026-09-19 19:18，全部实测）

| 检查 | 结果 | 判读 |
|------|------|------|
| 远端负载 / 内存 | 256 核，load 43.5（≈17%），159 GB free，`%wa` 14.7 | 排除资源瓶颈 |
| 远端 dsh web | pid 54850，**已运行 2d19h**，RSS 421 MB，监听 `127.0.0.1:3080` | 排除「dsh 崩了 / 在重启」 |
| 远端 sshd 配置 | `/etc/ssh/sshd_config` 里**没有** `MaxStartups` / `MaxSessions`，`sshd_config.d/` 为空 | 仍是编译默认 `10:30:100` / `10` |
| ssh 串行建连 | 一次 `ssh … 'echo OK'` 端到端 2.25 s（含远端命令） | 串行永远成功 —— 所以手动 ssh 看着是好的 |
| 隧道口 59267（不过反代） | 8/8 命中，0.13–0.15 s | SSH 转发本身是通的 |
| 稳定入口 65068（iframe 用的那个） | 一批 10 次里出现 **5.97 s / 3.61 s / 1.42 s** 毛刺；紧接着另一批 25 次全部 ≤0.29 s | 链路有**秒级毛刺**，不是稳定退化 |
| master | `ssh -O check` → `Master running (pid=49607)`，master 建于 16:55 | 一条 3 h+ 的长命连接承载全部流量 |
| 远端 `RemoteForward 7897` | 每次新 ssh 都报 `remote port forwarding failed for listen port 7897` | 端口已被 master 占着（仅噪声，见 §3.4） |

本地 hwb 日志统计（`hwb.log` + `.1` + `.2`，2026-09-13 → 09-19）：

| 指标 | 次数 |
|------|------|
| c4g 相关记录总数 | 1177 |
| `[remote] ssh 连接失败（重试后仍失败）`（stderr 全是 `Connection closed by 10.8.0.12 port 22`） | 238 |
| `[live-status] 实时会话同步失败`（reason 全是 `auth timeout`，`timeoutMs=4000`） | 294 |
| `[remote-reader] 读取远程 dsh home 元数据失败` | 164 |
| `[indexer] 索引该 home 失败` | 91 |
| `[launcher] ssh 隧道子进程异常退出`（stderr 全是「master 已消失」） | 15 |
| `[launcher] 远程 SSH 连接已恢复` | 37 |

只看今天（09-19）：`Connection closed by 10.8.0.12 port 22` **35 次**；
`live-status` c4g 共 43 轮、**失败 21 轮（49%）**，失败全部集中在用户 19:12 手工重连之后，
日志形态是「成功 —— 7 s 后失败 —— 7 s 后成功」地交替。这就是「总是在重连」的量化画像。

---

## 2. 三层原因

### 2.1 sshd 默认值 + 慢握手 = 随机丢连（占比最大）

dgx21 上做过的决定性对照（见 [`dgx21-tun-access.md`](./dgx21-tun-access.md)「结论」一节，
c4g 作为对照组同样 4/25 失败）：同一目标、同样 25 条连接，**只改并发方式**——

| 实验 | 结果 |
|------|------|
| 25 条**同时**发起 | **5/25 失败**，`Connection closed by <host> port 22` / `kex_exchange_identification: read: Connection reset by peer` |
| 25 条**错开 0.6 s** | **0/25 失败** |
| ≤8 条并发（低于 `MaxStartups` 的 10） | **0/8 失败** |
| 逐条串行 | 20/20、25/25、20/20 全通过 |

机制：慢握手（这条 VPN 上实测首次建连 2–14 s）让 hwb 并发发起的 ssh 在 sshd 的**未认证队列**
里堆过 10 条，sshd 随机丢弃约 30%。hwb 对每台远程主机同时要开多条连接（隧道 + mux master +
`sshPathExists` + remote-reader + indexer + live-status）。**被丢的若是承载数据的 master**，
`-L` 一起消失 → 浏览器 WS 立刻断 → `Reconnecting`。

hwb 侧已有一半的修法（隧道优先 `ssh -O forward` 挂到既有 master，完全不新建连接），所以
09-19 的失败以「master 已消失」和「新的 ssh 被丢」两种形态出现——但**只要还有必须新建连接的
路径**（master 死后的重建、remote-reader/indexer 的 ssh、probe），A 就还在扣分。

### 2.2 长命 master 退化

复用 master 把吞吐押在**一条长命连接**上。实测（dgx21，同一 master pid 7299 存活较久）：
后期单次请求被拖到 **20 s**，而同刻新建一条 master 只要 **0.5–0.8 s**、独占连接 0.4 s。
当前 c4g 的 master（pid 49607）从 16:55 一直用到现在，正是这个形态。

这就是「Reconnecting 总是出现」的直接放大器：客户端一次 generation 只有 **15 s** 预算，
master 一旦进入秒级往返，无论握手还是事件补拉都可能超时 → 判失败 → 退避重连。

### 2.3 探测预算偏紧（4 s）放大了观感

`src/dshhome/live-status.js` 用 `RPC_TIMEOUT_MS = 4000` 卡一次「token→cookie 交接 + `/api` 往返」。
在 §1 的秒级毛刺下，这个门槛一天被越过 21/43 次（49%），于是日志与界面每 7 s 抖一次。
它**不是** Reconnecting 的根因，但它把「链路在抖」的事实变成了用户看得见的持续噪声，
而且让「实例不可达」与「链路这一刻慢」在日志里长得一样。

---

## 3. 处置

### 3.1 远端 sshd（唯一能真正减少丢连的一步，需要 c4g 上的 sudo）

`sudo -n` 不可用（无密码），所以这条要人工执行。c4g 的 `/etc/ssh/sshd_config` 第 12 行已有
`Include /etc/ssh/sshd_config.d/*.conf`，用 drop-in 最干净：

```bash
# 在 c4g.tun 上，以有 sudo 的账号执行
sudo tee /etc/ssh/sshd_config.d/99-hwb-concurrency.conf >/dev/null <<'EOF'
# hwb 经 tun 并发建连（隧道 + mux master + sshPathExists + remote-reader + indexer + live-status）
# 会撞上 sshd 默认 MaxStartups 10:30:100：慢握手让未认证队列堆过 10 条，sshd 随机丢弃新连接
# （hwb 日志：Connection closed by 10.8.0.12 port 22）。复用 master 时，单连接上的并发 channel
# 还会撞 MaxSessions 默认 10（报 mux_client_request_session: Session open refused by peer）。
MaxStartups 100:30:300
MaxSessions 50
EOF

# 语法检查 —— 不通过就不要 reload（改坏 sshd 会彻底连不上，这也是此前的顾虑所在）
sudo sshd -t && sudo systemctl reload ssh
```

生效验证（三条都该有输出）：

```bash
sudo sshd -T | grep -iE 'maxstartups|maxsessions'   # 期望 100:30:300 / 50
```

回滚（一条命令，随时可做）：

```bash
sudo rm /etc/ssh/sshd_config.d/99-hwb-concurrency.conf && sudo systemctl reload ssh
```

> 说明：`sshd -t` 通过才 reload，且 drop-in 只动两个并发上限、不碰认证与端口 —— 回滚即恢复原状。
> 服务单元名是 `ssh.service`（`sshd.service` 只是 alias，已在本机核对）。
> **cms.tun / dgx21.tun 同病**，该文件可原样复用。

### 3.2 客户端加固（本仓库，已实现 + 已带测试）

**(a) 实时 RPC 预算可配置**（`src/dshhome/live-status.js`）：默认值仍是 4000（不改本机与健康链路行为），
新增 `HWB_LIVE_RPC_TIMEOUT_MS`。低带宽/高毛刺的远程实例建议放宽到 8–12 s。
放宽是安全的：轮询器对同一实例单飞（`LiveStatusPoller` 的 pending 去重），慢一轮只会跳过下一轮。

**(b) master 健康探测与自愈**（`src/control/tunnel.js`）：巡检原来只问两件事——master 活着吗、
转发口还在监听吗。这两件都「在」时，用户侧照样整页卡死。现在补第三问「它现在还快吗」：
每轮经 ControlPath 跑一条 `true`（`ControlMaster=no`，**只复用、绝不新建**，因此不经过
sshd 的未认证队列）并计时；连续 N 轮「慢或失败」即判定退化，**先 `ssh -O exit` 回收这条 master
再报告 exit**，由 launcher 重建一条新的。

> 顺序很重要：「先回收再报死」是必须的 —— 否则 launcher 立刻重建时仍能看到那条（已退化的）
> master，会把 `-L` 重新挂回同一条连接，等于没自愈。

可调旋钮与默认值：

| 环境变量 | 默认 | 含义 |
|----------|------|------|
| `HWB_LIVE_RPC_TIMEOUT_MS` | 4000 | 实时 RPC（鉴权 + `/api` 往返）预算 |
| `HWB_TUNNEL_MASTER_POLL_MS` | 10000 | master 巡检间隔 |
| `HWB_TUNNEL_MASTER_RTT_MS` | 3000 | 单轮往返超过它即记「不健康」 |
| `HWB_TUNNEL_MASTER_RTT_TIMEOUT_MS` | 8000 | 单次往返探测的超时 |
| `HWB_TUNNEL_MASTER_RTT_STREAK` | 3 | 连续 N 轮不健康才回收（防一次抖动就拆） |
| `HWB_TUNNEL_MASTER_HEAL_COOLDOWN_MS` | 600000 | 同一主机自愈冷却期（链路整体慢时不反复拆） |

自愈冷却的意义：如果**整条链路**就是慢的，重建一条 master 也一样慢。没有冷却就会变成
「每 30 s 拆一次 master」，反而把这条窄链路刷得更乱 —— 所以同一主机 10 分钟内只自愈一次。

生效方式（环境变量随 `hwb start` 进入服务进程，`src/cli.js` 把 `process.env` 透传给 detached 服务）：

```bash
# 低带宽隧道的建议档位
HWB_LIVE_RPC_TIMEOUT_MS=10000 hwb restart
```

> ⚠️ 两点前提：① **必须重启 hwb**，运行中的旧进程仍持有旧代码；② 已存在的**退化 master 要回收**
> 才会换成新的（本次自愈逻辑会自己处理；手工做法见 §4）。

### 3.3 VPN 侧：MSS clamp（放大器，建议一并处理）

dgx21/c4g 出网约 50% 概率 `connect ≈ 7.5–10 s`（`tun0` MTU=1500 且无 MSS clamp，SYN 重传计数高）。
**慢握手正是把未认证队列顶过 `MaxStartups=10` 的推手**，所以它是 §2.1 的放大器。
在 VPN 网关做 `--clamp-mss-to-pmtu`（或把 `tun0` MTU 调到 1380）；
客户端侧改 OpenVPN profile：`tun-mtu 1300` + `mssfix 1240`（重连后生效）。

### 3.4 清掉 `RemoteForward 7897`（可选，仅降噪）

`~/.ssh/config` 里 `Host c4g.tun` 的 `RemoteForward 7897 127.0.0.1:7897` 对**每条新 ssh** 都会
尝试在远端绑定 7897，而该口已被常驻 master 占着，于是每次都多一条
`remote port forwarding failed for listen port 7897` 告警（本次手动 ssh 即复现）。
hwb 自己早已在私有配置快照里剥掉转发指令（`withoutForwardings()`），所以它与本次故障无关；
如果远端不再需要这条反向代理出口，把这行注释掉即可。

---

## 4. 验证与复现

```bash
# 1) 远端上限是否生效
ssh bot@c4g.tun "sudo sshd -T | grep -iE 'maxstartups|maxsessions'"   # 需 sudo

# 2) 链路毛刺：同一入口连打 25 次，看 p50/p90/max（毛刺是「偶发秒级」，单次测量看不出）
for i in $(seq 1 25); do curl -s -o /dev/null -w '%{time_total}\n' --max-time 20 \
  http://127.0.0.1:65068/; done | sort -n | awk '{a[NR]=$1} END{print "p50="a[int(NR/2)], "max="a[NR]}'

# 3) 隧道口与入口对照（前者是 SSH 转发本身，后者才是浏览器走的路）
curl -s -o /dev/null -w 'tunnel=%{time_total}\n' http://127.0.0.1:59267/   # 端口见 hwb 日志的 localPort

# 4) master 现状（ControlPath 见 ~/.ssh/hwb-mux/cm-<sha256(host)[:12]>）
ssh -O check -o ControlPath="$HOME/.ssh/hwb-mux/cm-0ea78bb56fde" bot@c4g.tun
ssh -O exit  -o ControlPath="$HOME/.ssh/hwb-mux/cm-0ea78bb56fde" bot@c4g.tun   # 手工回收退化 master

# 5) 自愈是否触发（日志里应当能同时看到这两条）
grep -E "健康探测偏慢|已回收该 master" ~/.hwb/hwb.log

# 6) 实时同步失败率（放宽预算后应显著下降）
grep -c "实时会话同步失败" ~/.hwb/hwb.log
```

判据（处置成功的形态）：
- `hwb.log` 里 `Connection closed by 10.8.0.12 port 22` 明显下降（今天 35 次 → 目标个位数）；
- `live-status` c4g 的失败率从 49% 降到偶发；
- 浏览器侧的 `Reconnecting` 不再每几分钟出现一次；出现时也能在日志里找到对应的一次
  `master 健康探测偏慢 / 已回收` 或一次 `ssh 连接失败`——**可归因**，而不是「又莫名重连了」。

---

## 5. 残留风险

- **不改远端 sshd 时，丢连只能被「更快发现 + 重建」，不能被消除。** hwb 侧已做到「不漏判、
  能自愈」，但每一次丢连仍对应一次秒级到分钟级的中断。
- 自愈会**回收整条 master**，因此同一主机上其它依附其上的隧道也一起重建（它们本来就共享
  这条连接，退化时一起慢）。冷却期把这件事限制在 10 分钟一次。
- 判定「慢」用的是单次往返，链路极端拥塞时可能连续 3 轮偏慢而触发自愈；此时重建本身也慢
  （launcher 的恢复退避 1/2/4/8/16 s），但比一直挂在不健康连接上更糟的是**不重建**，故取此策略。
- 本次改动都需要重启 hwb 才加载；`sshOpts` 的 `-C`（压缩）同样要求回收旧的**无压缩 master**，
  否则隧道会继续挂到那条慢连接上（实测同一批 bundle：带压缩 30.4 s vs 不带 140.5 s）。
