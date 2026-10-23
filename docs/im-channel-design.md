# hwb × IM channel：从「在线会话」到「事件通道 + ACP 引擎」

> 状态：设计提案 v2.1（2026-10-23）
> 已拍板：**不做 E2EE**（只用明文私有房间；客户端遇到加密房间必须显式失败）。
> 已落地：`src/channel/matrix-min.js` + `tests/channel-matrix-min.test.js`（14 项契约测试，`node --test` 全绿）。
> 相关：
> - 链路实测：[`dgx21-tun-access.md`](./dgx21-tun-access.md)（~1 Mbps 上限 / 2–4% 丢包 / PMTU 断崖）
> - 命令通道：[`dgx21-lowbandwidth-channel.md`](./dgx21-lowbandwidth-channel.md)（9.6 KB 冷 / 0.7 KB 暖）
> - 断连排查：[`c4g-tun-reconnect.md`](./c4g-tun-reconnect.md)（sshd 并发上限、master 退化、3 s/15 s 判死）
> - 调研附件：[`research/hwb-wire-audit.md`](./research/hwb-wire-audit.md)（线上字节审计）、
>   [`research/dsh-host-extension-points.md`](./research/dsh-host-extension-points.md)（宿主扩展点）、
>   [`research/im-channel-prior-art.md`](./research/im-channel-prior-art.md)（先例调研）

---

## 0. TL;DR

**慢不是单一原因，而是三层叠加；而且「稳态的慢」和「第一次打开的慢」是两件事。**

| 层 | 事实 | 可改性 |
|---|---|---|
| ① 载荷（首次打开） | dsh web 首屏 3.34 MB（46 个插件 bundle）；`session.list` 129 KB；`session.history` 尾部窗口 8–10 MiB | 上游/插件只能止血（压缩、缓存头、增量历史） |
| ② 链路 | VPN 核心 ~110–125 KB/s、2–4% 丢包、RTT 95–113 ms、PMTU 断崖 | **客户端无解**（`dgx21-tun-access.md` 第三轮已定案） |
| ③ hwb 自己的稳态轮询 | **一台空闲远端 1 小时仍要搬 7.1–10.7 MB、约 780 次往返**（占链路满容量 20–30%、占链路时间 34–95%） | **可改，且收益最大**（`research/hwb-wire-audit.md`） |

稳态那 7–10 MB/h 的 ~95% 来自两件事：`session.list` 每 15 s TTL 重搬 129 KB（240 次/h）、
索引器每 60 s 全量 `cat` projcache（60 次/h × 0.22 MiB）。而**往返**的最大单项是
master 健康探测（360 次/h，占往返 46%，只占字节 0.5%）。失败也集中在 auth 段
（`auth timeout` 2215 次 vs `rpc timeout` 226 次）——即「每轮重做 token→cookie 交接」。

**根因不是带宽，是「没有游标」**：dsh 的 `session.list` 没有 `since`、投影缓存没有版本清单、
`events.host` 开流没有 cursor。没有游标就无法证明「只取增量不丢事件」，于是 hwb 只能
用 TTL + 重搬来逼近正确性。**Matrix 恰好补上这个缺口**：`/sync?since=<token>` 是成熟的外置游标。

**IM 方案的本质不是「聊天界面省流量」，而是四件事**（§2）：持久事件日志、增量游标、
出站连接、薄消息。它们分别对着「断线即失败」「拉全量」「入站被访问」「胖客户端」四个病灶。

**引擎不用自己写。** dsh 0.2.x 已经内置两条 stdio 自动化协议，远端随包安装、零下载：

- **ACP v1**：`dsh --profile acp`，stdio **NDJSON JSON-RPC**；`session/new|list|resume|prompt|cancel|close`、
  `session/update` 流式通知、`session/request_permission`（原生审批）。
- **SDK JSON-RPC**：`dsh --profile sdk`，`session/prompt|wait` + `session.event|status`。

两者都实测可用（本机与 `dgx21.tun` / `c4g.tun`），且**与 web 共用同一个持久会话库**
（`session-persistence-jsonl`，root=`$DSH_HOME/sessions`）。所以 channel 适配器只需要做
**「ACP ↔ Matrix」的翻译**，不需要重写 agent 运行时、不需要装插件、不需要下依赖。

**推荐路线：**

```
P0（立刻，1 周）    3 条降频/修复，不依赖 IM，砍掉 70–80% 空闲字节
P1（2–3 周）        hwb 本地桥：Matrix ↔ ssh stdio ACP（多轮/流式/审批，笔记本需在线）
P2（3–4 周）        远端单文件 sidecar：Matrix ↔ 本机 ACP 子进程（笔记本可关，任务不中断）
P3（持续）          状态/心跳/审批全部事件化，hwb 用一条 /sync 看 N 个实例；web 降为手术台
```

**一句话定位**：IM 是远端 dsh 的**遥控器**（发指令、看进度、审批、收结果），
web 是**手术台**（大 diff、多文件编辑、深度排查），hwb 是**调度台**（谁在线、谁在跑、链路如何）。

---

## 1. 先把账算清：三层成本

### 1.1 第一层：dsh 是 local-first 应用，UI 本身就不该跨 WAN

| 载荷 | 实测 | 出处 |
|---|---|---|
| 首屏插件 bundle | 46 个 `client.js`，**3 485 976 B**（gzip 813 796 B） | `dgx21-lowbandwidth-channel.md` §1 |
| 首屏（UI 可用前必须到齐） | **3 501 190 B** | 同上 |
| `session.list`（179 会话） | **129 KB**，慢链路 3.4–7.3 s | `dgx21-tun-access.md` 第四轮 |
| `session.history` 尾部窗口 | 50 条消息 = **8.33 / 9.83 MiB** | `dsh-history-delta/lib/index.js` 注释 |
| 实时连接判死 | 3 s 未就绪告警、**15 s 判失败**并退避重连 | `c4g-tun-reconnect.md` §0 |

这是**部署假设**问题：浏览器与服务端同机或近网。搬 UI 过 WAN 就是每层都在交「在线税」。
上游能优化的是压缩、缓存头、增量游标（hwb 的 `dsh-static-cache`、`dsh-history-delta` 已在做）；
**无法**把 3.34 MB 首屏变成 KB 级——UI 本身就那么大。出路只有两条：**不搬 UI（IM）**，或
**不搬远端（本地 brain + 远端 hands）**。

### 1.2 第二层：链路——客户端没有提速解

`dgx21-tun-access.md` 第三轮已把根因锁死在 VPN 核心：交付上限 **~110–125 KB/s**，
基础丢包 2–4%，并发只能把单流丢掉的份额抢回来、**总量仍封顶**；PMTU 断崖在 IP ≥1348 B
（100% 丢），当前靠 `mssfix 1360`（实际段 1312–1324）压在断崖之下、余量约 25 B。
**不要在这层继续投入。**

### 1.3 第三层：hwb 自己的稳态往返——可改，收益最大

来自 [`research/hwb-wire-audit.md`](./research/hwb-wire-audit.md)（数字出处见该文 §A–B）：

| 项 | 现状（一台远端，空闲 1 小时） | 说明 |
|---|---|---|
| 字节 | **7.1–10.7 MB** | 占满容量 20–30%，占链路时间 34–95% |
| 往返 | **≈780 次** | 瓶颈货币是**往返**，不是字节 |
| 字节最大项 ① | `session.list` 重搬：240 次/h × 129 KB ≈ 7.2 MB/h | TTL 15 s 是唯一节流器 |
| 字节最大项 ② | 索引器全量 `cat` projcache：60 次/h × 0.22 MiB ≈ 3.2 MB/h | 无「无变化跳过」 |
| 往返最大项 | master 健康探测：360 次/h，占往返 46%、字节 0.5% | 合成 `ssh -- host true` |
| 失败集中点 | `auth` 段 2215 / 3380；不在 RPC | 每轮重做 token→cookie |

**洞察 1：空闲不是空闲。** 用户体感「连上就一直在同步」，主要不是 3.34 MB 的 bundle
（`proxy-cache` immortal + `dsh-static-cache` immutable 之后稳态为 0），而是上面这些轮询。

**洞察 2：没有游标 ⇒ 只能 TTL 重搬。** `session.list` 无 `since`、projcache 无版本清单、
`events.host` 开流 payload `{}`——所有「增量」都只能靠「短 TTL 重取整段」近似。

**洞察 3：PMTU 和首屏在本轮不该继续当主战场。** 前者当前被 mssfix 压住（只造成「偶发 7.5–10 s」），
后者在缓存命中后不重复付；继续优化它们是边际收益。

---

## 2. IM/channel 路线的本质：四个语义转换 + 一个游标

把「IM 当界面」翻译成工程语言，它做了五件事：

| # | 旧（在线会话） | 新（事件通道） | 对着哪个病灶 |
|---|---|---|---|
| 1 | 在线会话（断开=重来） | **持久事件日志**（store-and-forward） | 断线即失败 |
| 2 | 客户端拉完整状态 | **增量 + 游标**（`since` token） | 拉全量、无 version |
| 3 | 远端必须被入站访问（隧道/端口/sshd 并发） | **远端主动出站**连 homeserver | MaxStartups / 长命 master / NAT |
| 4 | 胖客户端（3.34 MB 应用） | **薄消息 + 结构化扩展**（stock 客户端可读，增强客户端可渲染） | 载荷税 |
| 5 | 一个会话 = 一条实时连接 | **一个会话 = 房间/线程**，多设备共享 | 单点、移动端缺失 |

**最容易被忽略的是第 2 条**：Matrix 的 `/sync` 给了一个**外部游标**，这恰好是 dsh 缺的东西。
`GET /_matrix/client/v3/sync?since=<token>&timeout=30000` 返回自 `since` 之后的增量事件，
并给出新的 `next_batch`（[Matrix spec: syncing](https://spec.matrix.org/latest/client-server-api/#syncing)）。
客户端持久化 token，断线/休眠/换网后从断点续上——**不要求连接一直活着**。

> 换句话说：**不要试图给 dsh 的每个端点补 `since`；让 Matrix 在会话层提供游标，
> 把 dsh 的「全量对象」降级为「事件流里的一个状态事件」。**
>
> 算术上有多划算：一条 4000 字符的消息事件是 **4 263 B**（构造实测），
> 而 dsh 首屏是 **3 501 190 B** ⇒ 约 **821 条**满长度回复。**一次网页加载 = 821 轮对话的字节。**

---

## 3. 先例：openclaw 怎么做的，哪些能抄

### 3.1 它的形状

- **一个长期存活的 Gateway** 拥有所有消息面（WhatsApp / Telegram / Slack / Discord / Signal /
  iMessage / Matrix / WebChat），channel 是可插拔插件；控制面客户端（mac app / CLI / web）
  走 WebSocket 连 Gateway（[concepts/architecture](https://docs.openclaw.ai/concepts/architecture)）。
- **远程访问仍然推荐 Tailscale/VPN，SSH 隧道只是备选**（同上「Remote access」）。
  这很关键：openclaw 自己也承认「Gateway 的 WS 不适合跨 WAN」，所以把 IM 当主界面、
  把 WS 控制面留在近网。
- Matrix 是「可下载 channel 插件」，基于官方 `matrix-js-sdk`，支持 DM/房间/线程/媒体/表情回应/投票/E2EE
  （[channels/matrix](https://docs.openclaw.ai/channels/matrix)）。

### 3.2 可直接抄的四个决定

| 决定 | openclaw 的做法 | 对 hwb 的含义 |
|---|---|---|
| **默认不逐 token 流式** | 官方明确「there is **no true token-delta streaming** to channel messages」（[streaming](https://docs.openclaw.ai/concepts/streaming)）；Matrix 通道 `streaming.mode` 默认 `"off"`，`partial`/`quiet`/`progress` 可选，并提示「preview edits cost extra Matrix API calls」（[message behaviour](https://docs.openclaw.ai/channels/matrix/messaging)） | 低带宽下**合并推送**：首字 1.5 s 内一条「开始处理」，之后每 3–5 s 合并编辑，最终一条完整答案。禁止逐 token |
| **分块按「字符/标记」而非字节** | Matrix 与 Telegram 默认 chunk 都是 **4000 字符**（`extensions/matrix/src/matrix/format-profile.ts` 的 `chunk:{limit:4_000,unit:"chars"}`）；且 Matrix 单事件硬上限 **64 KiB**（含联邦签名） | hwb 分块阈值取 ≤2 KB 文本；超长答案转 `.txt` 附件 + 摘要 |
| **超长内容有降级路径** | 预览超过 Matrix 单事件大小上限 → 停止预览流式、退回 final-only；替换失败时保留 preview 可见（同上） | 超限 → 摘要 + 文件/远端路径；不能让长输出把通道打死 |
| **审批原生可用** | 审批是带 `com.openclaw.approval` 的普通 `m.room.message`；✅/❌/♾️ 反应为快捷方式，`/approve <id> allow-once\|allow-always\|deny` 兜底；**只有 approvers 白名单**能批（[rich-messages](https://docs.openclaw.ai/channels/matrix/rich-messages)） | shell 权限审批必须「消息 + 反应 + 兜底命令 + 批准人白名单 + 默认/超时拒绝」 |
| **会话路由与线程** | `dm.sessionScope`（per-user / per-room）、`threadReplies`（off / inbound / always）、线程绑定会话、`historyLimit` 控制每轮带多少房间历史（[threads and sessions](https://docs.openclaw.ai/channels/matrix/threads-and-sessions)） | 映射建议：**实例 = bot 账号；项目 = 房间；会话 = 线程**；每轮只带本线程少量上下文，不重传 room history |

### 3.3 不能照搬的

- openclaw 是**通用个人助手**（一个 Gateway 管所有 channel）；hwb 是**多实例工作台**，
  核心资产是每个远端 dsh 的原生会话/项目索引。**dsh 的 session/transcript 仍是唯一真相源，
  Matrix 只是传输与通知层。**
- openclaw 的 Matrix channel 用 `matrix-js-sdk` + Rust crypto（E2EE 需原生绑定，
  见 [encryption](https://docs.openclaw.ai/channels/matrix/encryption)）；这对「远端零下载」是硬约束，
  所以 E2EE 要么放在 hwb 本地桥、要么接受明文私有房（§6.7）。
- 微信没有官方 bot API；用户已有 Matrix 作中枢，正确做法是用 mautrix 系桥接
  把 Telegram/WhatsApp/Signal 等接进 Matrix，**不要**在 hwb 里直连微信（封号/合规风险）。

### 3.4 同类产品对照（细节见 `research/im-channel-prior-art.md`）

| 方案 | 传输/中继 | 断点续传 | 谁提供中继 | 备注 |
|---|---|---|---|---|
| openclaw + Matrix | Matrix CS API | `/sync` since | 自建/公共 homeserver | 与 hwb 最接近的先例 |
| Happy Coder 类 | 自研 E2EE relay + 本地 daemon | cursor/ack | 自建 relay | 要自己造多设备/离线/推送 |
| Telegram Bot | Bot API 长轮询 `getUpdates?offset=` | offset 游标 | Telegram | 起步最快，无 E2EE、无桥接生态 |
| 自建薄协议 | WebSocket/msgpack | 自定义 | 自建 | 重复造 Matrix 的轮子，不推荐 |

> 这张表最重要的结论（详见 `research/im-channel-prior-art.md` §4）：**同类产品几乎都不走 IM 协议**——
> Happy 用自建 E2EE relay + Socket.IO，VibeTunnel 直接代理 PTY 的 WebSocket 二进制帧，
> Omnara 是 Web SPA + 无状态 worker + 机器 daemon，claude-code-telegram 是 Bot API + 本地进程。
> 「用现成 IM 当界面」目前只有 openclaw 一条成熟先例——所以抄 openclaw 的**交互语义**，
> 但传输层按本文件 §4 的 ACP 方案来（它比 IM 更适合「在远端执行」）。

---

## 4. 关键发现：dsh 自带 ACP / SDK —— channel 的引擎不用自己写

### 4.1 ACP v1（首选）

`dsh --profile acp` 启动一个 **stdio NDJSON JSON-RPC** 的 ACP（Agent Client Protocol）服务器。
它不是社区野协议：`dsh-acp` 同时被 `dsh-subagent-acp` 用于跨进程委派，是稳定契约；
官方规范见 [agentclientprotocol.com](https://agentclientprotocol.com)。

**实测证据（只读）：**

| 验证 | 结果 |
|---|---|
| 本机 `dsh --profile acp` + `initialize` | 返回 `agentInfo.name="deepseek-harness-acp"`、`sessionCapabilities={close,list,resume}`、`mcpCapabilities.http=true`、`promptCapabilities` |
| 远端 `dgx21.tun`（dsh **0.2.1-alpha.2**）/ `c4g.tun`（dsh **0.1.5-rc.1**） | 两者安装树里都有 `dsh-acp` / `dsh-acp-app` / `dsh-sdk-jsonrpc-server`；`initialize` 均成功 |
| 远端 `c4g.tun` 上 `session/list` | 列出 **22 个**既有会话（`{sessionId, cwd}`），**整个输出 2 508 B**（含 initialize 约 400 B） |
| 零下载 | `acp` 是**出厂 shipped profile**（`--from-default-profile acp` 会被拒绝并提示「omit 即用」）；隔离 `DSH_HOME` 启动后只有 **5 个文件 + 482 个软链**（2.1 MB，全部指向已装 dsh 的 `node_modules`） |
| 会话库 | `dsh-base` 用 `dsh-session-persistence-jsonl`，root=`dshHomePath('sessions')` ⇒ **acp / web / headless 共用同一个 `~/.dsh/sessions`** |

**ACP 能提供什么**（对照 [ACP v1](https://agentclientprotocol.com)）：

| 能力 | 方法/通知 | 对 hwb 的意义 |
|---|---|---|
| 建/列/恢复/关会话 | `session/new`、`session/list`、`session/resume`、`session/close` | IM 能接着聊**网页里开过的会话**；重启/断线可恢复 |
| 提交一轮 | `session/prompt`（文本/资源链接/图片；每会话同时一个） | 一条 Matrix 消息 = 一轮 prompt |
| 流式更新 | `session/update` 通知：`agent_message_chunk`、`agent_thought_chunk`、`tool_call`、`tool_call_update`、`usage_update`、`config_option_update` | 进度/工具调用/用量 → Matrix 消息或编辑 |
| 取消 | `session/cancel` / `$/cancel_request` | `/stop` |
| **审批** | `session/request_permission`，options 含 `allow_once` / `reject_once` | 直接映射成 Matrix 反应审批 |
| 模型选择 | `session/set_config_option`（`model`、`reasoning_effort`） | `/model` |
| MCP | stdio / 可流式 HTTP | 远端工具扩展 |
| resume 语义 | 恢复日志但**不回放旧更新** | 断线后重连不重传历史——正是低带宽要的 |

**限制（必须写进产品说明）：** ACP 是 automation-only——**没有** DSH 专属呈现（plan/todo 卡片、
diff 视图、终端视图、图片渲染）；同一 session 不能 web 与 ACP **同时**驱动（会报「被占用」）；
`session/prompt` 在 SSH 管道断开时会随子进程一起死（会话日志记录中断轮次，`session/resume`
会修复它，但**长任务仍应走 `--detach`**）。

### 4.2 SDK JSON-RPC（备选）

`dsh --profile sdk` 提供 `initialize`、`session/prompt`、`session/wait`，并流式发
`session.event` 与 `session.status`。优点是「每个持久事实都作为事件发出」；
缺点是**没有 cancel / permission**，且 wire format 是 DSH 私有。**对话界面选 ACP，
批处理/数据管道可选 SDK。**

### 4.3 为什么 v1 不用 Cordis 插件做

调研 [`research/dsh-host-extension-points.md`](./research/dsh-host-extension-points.md) 的结论是
「有保留的可行」，四条保留意见都指向同一结论——**先别做进程内插件**：

| 保留 | 内容 | 影响 |
|---|---|---|
| R1 | 进程内插件的**异步异常是全局致命**：脱离 `apply()` 的 unhandled rejection / 同步回调抛错会让整个 dsh dispose（`dsh-app-boot/README.md:109-110`，实现见 `lib/index.js:4216`） | IM 长连接 + 重连 + 解析外部 JSON，等于把整个 dsh 押在插件不写错 |
| R2 | 旧范本用的 `apiProxy` 在 0.2.x **已不存在**（`dsh-history-delta` 会永远等不到服务、静默不激活） | 照抄旧代码会踩空（顺带：这是仓库里现存的一个 bug，见 §8.2） |
| R3 | Matrix E2EE 需要 libolm/vodozemac（native/WASM），不是零依赖 | 抬高远端落地面 |
| R4 | 插件替代的是交互面，不是 web profile；要真正省载荷得挂 **base-only**（不挂 web-app） | 等于重做一个 app，成本高 |

插件仍有价值：**如果**将来需要 token 级流（`agent/assistant-stream`）或 DSH 富呈现，
它能在进程内拿到（`ctx.agents.followup`、`ctx.on('session/event'|…)`）。但那是 P4 的事，
且必须把所有异步路径包进 try/catch。部署上，最小落地面是「改一个已有 patch 文件 + 加一个 `.mjs`」
（patch 的 `insert` 支持绝对路径，绕开 `pnpm` 联网），比 `dsh plugin add link:` 更可控。

### 4.4 版本矩阵与退化路径

| 主机/版本 | ACP | 退化策略 |
|---|---|---|
| dsh ≥ 0.2.x（本机 0.2.0-rc.2 / dgx21 0.2.1-alpha.2） | ✅ 全能力 | — |
| dsh 0.1.5-rc.1（c4g） | ✅ ACP 存在（实测 initialize/session/list） | 缺的方法按 ACP v1 能力协商结果降级 |
| 更老（≤0.1.1） | ❌ | 用 `headless --session-id` 多轮（若有该 flag）或 `dsh21 --detach` 一次性；无流式/审批 |

> 版本漂移是真实风险：dsh 0.2.x 已删掉 `apiProxy` 这类旧服务。channel 适配器必须
> **启动时先 `initialize` 读 capabilities**，再决定用哪些方法，而不是假设。

---

## 5. 目标形态

### 5.1 四平面

```
┌──────────────────────── 客户端（手机 / iPad / 桌面）──────────────────────────┐
│  Element 等 Matrix 客户端：房间·线程·审批反应·文件   ←也可用 hwb 页面作为补充   │
└──────────────────────────────────┬───────────────────────────────────────────┘
                                   │ Matrix CS API（HTTPS；可断、可续、可多设备）
┌──────────────────────────────────▼───────────────────────────────────────────┐
│                       HOMESERVER（自建 Synapse/Conduit）                      │
│  持久事件日志 · /sync 游标 · 房间/线程 · E2EE（可选） · 推送 · 桥接（mautrix-*） │
└──────────────┬──────────────────────────────────────────┬────────────────────┘
               │ 出站 /sync（1 条连接看 N 个实例）           │ 出站 /sync（bot 账号）
┌──────────────▼───────────────┐            ┌─────────────▼────────────────────┐
│ hwb（本地）                   │  SSH/运维   │ 远端 dsh 主机 #1 #2 … #N            │
│ 控制面：实例·生命周期·配额      │ ─────────►  │ ┌ dsh --profile acp（stdio）     │
│ channel 面：房间/策略/审批/审计 │            │ ├ channel sidecar（P2）           │
│ 手术台：web iframe（按需）      │  ACP stdio  │ └ ~/.dsh/sessions（与 web 共用）  │
│ chatops：@hwb 机器人            │ （P1 用）   │                                   │
└───────────────────────────────┘            └───────────────────────────────────┘
```

| 平面 | 现状 | IM 化之后 |
|---|---|---|
| 控制平面 | SSH 隧道 + 进程状态机 | **不变**（启停/重启仍走 SSH，低频且必须可靠） |
| 数据平面 | SSH 读元数据 + 60 s 索引 | 索引保留（离线可用）；**实时状态改由事件推送** |
| 展示平面 | 工作台 + 唯一 iframe | 工作台保留；日常交互移到 IM；iframe 降级为手术台 |
| **channel 平面** | 无 | 房间注册、bot 身份、策略/白名单、审批路由、审计 |

### 5.2 P1 拓扑：hwb 本地桥（不改远端）

```
Matrix 房间 ──/sync──► hwb channel adapter ──spawn──► ssh -T host 'dsh --profile acp'
      ▲                       │                              │ NDJSON JSON-RPC over stdin/stdout
      │                       ├─ session/list ──────────────►│ （可列出 web 开的 22 个会话）
      │                       ├─ session/prompt ─────────────►│ agent 执行
      │                       ├─ ◄── session/update 流式 ─────┤ 文本/思考/工具/用量
      │                       ├─ ◄── session/request_permission┤ → Matrix 审批消息（✅/❌）
      │                       └─ 断线 → 重新 spawn + session/resume（会话持久化，不回放旧更新）
      └──────── 进度编辑 / 最终答案 / 错误（m.replace + com.hwb.*）
```

- **优点**：零远端安装；多轮/流式/审批/取消全部原生；与 web 共享会话；单条 SSH 管道；
  比 web 少 3 个数量级字节。
- **缺点**：hwb 必须在线；SSH 管道断 = agent 中途死（resume 修复中断轮次，但超长任务应 `--detach`）；
  stdio 一管道一客户端（同一 session 不能多适配器并发）。
- **工程点**：`ssh -T`（不要 pty，保持 ndjson 纯净）、stderr 单独落日志、`ServerAliveInterval=15`、
  重连指数退避、prompt 用 Matrix `txnId` 幂等、断线时**不自动重发**（歧义处理，同 `dsh21` 标记语义）。

### 5.3 P2 拓扑：远端单文件 sidecar（笔记本可关）

- 远端一个 `hwb-channel.mjs`（Node ≥22，**零依赖**，用内建 `fetch`）：Matrix `/sync` ↔ 本机
  ACP 子进程，持久队列、审批、resume；`systemd --user` 托管；token 文件 0600。
- 优点：笔记本关机、手机换网都能继续；任务不因 SSH 断而死（子进程生命周期归 sidecar）；
  与 dsh 进程隔离（sidecar 崩不影响 dsh）。
- 缺点：需要一次部署（scp 一个文件 + token + unit），且 **E2EE 决策**（§6.7）。

### 5.4 映射

| Matrix | hwb / dsh |
|---|---|
| bot 账号 `@dsh-<host>:<home>` | 一个远端实例（故障/凭据隔离） |
| 房间 `#dsh-<host>-<project>` | 一个项目/工作区 |
| 线程（`m.thread`） | 一个 dsh session（也可「一 session 一房间」，线程更省房间） |
| `m.room.message` | 一轮输入/输出（正文纯文本） |
| `m.reaction` | 审批 / ack |
| `m.room.message` + `m.replace` | 进度/流式更新（合并推送） |
| `com.hwb.*` 状态事件 | 实例/会话/心跳元数据（P3，替代轮询） |

---

## 6. 协议设计 v0.1

### 6.1 ACP ↔ Matrix 映射

| ACP | Matrix 行为 |
|---|---|
| `session/list` | 首次进房间时拉一页（默认 ≤100）→ 发一条「已连接，最近会话：…」摘要；不逐条同步 |
| `session/resume {sessionId}` | 用户在房间发 `/resume <id>` 或点击会话卡片 |
| `session/new {cwd, mcpServers}` | 房间缺省会话 = 上次的；`/new [cwd]` 显式新建 |
| `session/prompt {content:[text]}` | 入站 `m.room.message` 的 `body`（纯文本）；附件先转 resource_link |
| `session/update.agent_message_chunk` | 合并进「草稿消息」→ 每 3–5 s 或每 500 字符 `m.replace` 一次（≤5 次） |
| `agent_thought_chunk` | 默认**不转发**（省字节）；`/verbose` 打开后作为 `m.notice` 摘要 |
| `tool_call` / `tool_call_update` | 一条可编辑的进度行：`🔧 shell · npm test · running/done/failed`（截断到 120 字符） |
| `usage_update` | 追加到最终消息 footer（tokens/context），或每轮一条 `m.notice` |
| `config_option_update` | `/model` 的候选与确认 |
| `session/request_permission` | 审批消息 + `com.hwb.approval`；✅=allow_once、❌=reject_once；`/approve <id> ...` 兜底 |
| `session/cancel` | `/stop`（或对草稿消息点 ❌ 取消） |
| `session/close` | `/close`（释放 agent；会话日志仍在，可 resume） |
| prompt 完成（stopReason） | 最终答案 `m.replace` 定稿 + footer（耗时/用量/是否被截断） |

### 6.2 自定义事件（`com.hwb.*`）

| 类型 | 形态 | 载荷（尽量小） | 用途 |
|---|---|---|---|
| `com.hwb.instance` | room state | `{homeId, host, dshVersion, profile, caps, startedAt}` | 替代静态元数据 |
| `com.hwb.heartbeat` | room state（60 s，变化才发） | `{ts, runningSessions, tokensToday}` | 替代 live-status 轮询 |
| `com.hwb.session` | room state / thread root | `{sessionId, title, cwd, status, updatedAt}` | 会话列表增量事实 |
| `com.hwb.turn` | timeline | `{turnId, state: queued\|running\|done\|failed, ms?, tokens?}` | 一轮状态机（幂等锚点） |
| `com.hwb.approval` | `m.room.message` content 扩展 | `{id, kind, decisions, toolCall, cwd}` | 审批（绑定首条消息） |
| `com.hwb.presentation` | `m.room.message` content 扩展 | 文字兜底 + 结构（按钮/表格） | 富交互降级 |
| `com.hwb.artifact` | timeline | `{path, bytes, sha256, remote:true}` | 大产物留远端，只回引用 |

**原则**：所有自定义事件都带人类可读 `body`；不认识 `com.hwb.*` 的客户端仍能正常阅读
（与 openclaw `com.openclaw.presentation` 同款降级策略）。

### 6.3 流式策略（低带宽的关键取舍）

- 默认 `streaming = off`：等一轮结束发一条完整答案。
- 可选 `progress`：首字后 1.5 s 发 `_处理中…_`，之后**每 3–5 s 或每 500 字符**合并一次编辑，
  最多 5 次；之后只保留最终答案。
- 分块阈值取 **≤2 KB 文本 / ≤2000 字符**（openclaw 的 Matrix/Telegram 默认是 4000 字符，
  见 `extensions/matrix/src/matrix/format-profile.ts`；hwb 链路更窄，取一半）。
- 硬上限：Matrix **单事件 64 KiB**（联邦格式含签名，[spec: size limits](https://spec.matrix.org/latest/client-server-api/#size-limits)）。
  超过 → 分块（带 `(1/3)`）或写 `.txt` 作为 `m.file`，正文只留摘要 + 路径。
- **禁止逐 token 编辑**：Synapse 默认 `rc_message` = **0.2 次/秒、burst 10**（≈12 条/分钟持续，
  [config 文档](https://element-hq.github.io/synapse/latest/usage/configuration/config_documentation.html#rc_message)；
  源码默认值见 `synapse/config/ratelimiting.py:89-97`），逐 token 会直接吃 429 并制造重试风暴。
- 发送一律带 `txnId`：同一 device + endpoint + txnId 的重传返回原 `event_id`
  （[spec: transaction identifiers](https://spec.matrix.org/latest/client-server-api/#transaction-identifiers)），
  这是 2–4% 丢包下「HTTP 超时 ≠ 失败」的正确姿势。

> sliding sync（MSC4186）**尚未进入已发布规范 v1.19**（MSC3575 已 obsolete），且 hwb 是单用户、
> 少量房间场景——**用经典 `/sync` 即可**，不要为此引入 matrix-rust-sdk 的依赖。

### 6.4 审批（安全边界，不是 UI 装饰）

- 审批消息含「工具/命令/工作目录/风险」；长内容分块时 `com.hwb.approval` 只挂**首条**，
  反应也绑定首条（openclaw 的做法）。
- 批准人白名单（Matrix user id）+ 房间白名单；非白名单用户消息**静默丢弃并计数**（不回复，避免探测）。
- 默认 **deny**，5 分钟超时自动 reject；`allow-always` 只对**完全相同**的命令生效并落审计事件。
- 兜底 `/approve <id> allow-once|allow-always|deny`（手机上长按复制也能用）。
- 决策以 `com.hwb.turn` / `com.hwb.approval` 事件追加，形成可回放审计链。

### 6.5 幂等、去重、断点

| 风险 | 机制 |
|---|---|
| 同一事件重复投递（/sync 重放、长轮询超时重试） | 按 `event_id` 去重（持久化最近 N 条）；入站先落队列再执行 |
| 出站消息重复 | Matrix `txnId` 幂等（同一 txnId 重发不产生两条，[spec](https://spec.matrix.org/latest/client-server-api/#transaction-identifiers)） |
| prompt 发出后断线（**歧义**） | 不自动重发：`session/resume` 修复中断轮次；`com.hwb.turn` 标 `unknown`，等用户确认（同 `dsh21` 的「只有证明没开始才安全重试」） |
| 进程崩 | 队列持久化（JSONL + fsync）；`queued` 重启重跑；`running` → `unknown` |
| 断线期间消息 | `/sync?since=<token>` 一次补齐，按事件序应用 |
| 事件洪峰 | 合并器 + 队列上限（丢旧进度保最终态）；出站 429 按 `retry_after_ms` 退避 |
| 顺序 | 同线程按 Matrix 事件序；跨线程无全局序（也不需要） |

### 6.6 字节预算（三段账）

| 段 | 项 | 量级 | 说明 |
|---|---|---|---|
| SSH | 冷握手 | 9.5–9.9 KB | 已实测（`dgx21-lowbandwidth-channel.md` §2.2） |
| SSH | 空闲 keepalive | ~15 s 一次，~100 B ⇒ ~24 KB/h | `ServerAliveInterval=15` |
| ACP | prompt 帧 | ~0.3 KB | 一行 NDJSON |
| ACP | `session/update` | 10–30 帧 × 0.3–0.8 KB ⇒ **3–12 KB/轮** | 已提交块 + 工具生命周期 |
| ACP | 权限请求/响应 | ~0.3 KB ×2 | |
| Matrix | 入站消息 | 1–2 KB | 事件壳 + 文本 + 可选加密开销 |
| Matrix | 进度编辑 3–5 条 | 3–5 KB | 每条 `m.replace` 是完整事件 |
| Matrix | 最终答案 | 1–4 KB | 长答案分块/转 artifact |
| **合计/轮** | | **≈10–20 KB** | 对比首屏 3.34 MB ≈ **200–300 轮** |
| **空闲/h** | | **≈0.1–0.2 MB（纯通道）／≈0.5 MB（含索引兜底）** | 对比现状 **7.1–10.7 MB** ⇒ **-93%…-98%** |

> 结论：**每轮成本与「打开一次网页」不是一个量级**；而空闲成本从 MB/h 降到百 KB/h。
> 注意：轮次延迟主要由 LLM + 工具决定，不是这些字节；字节只决定「会不会卡死」。
>
> 可对照的构造测量（`research/im-channel-prior-art.md` §5.1，按规范字段构造 JSON 实测）：
> 一条 **4000 字符**的 `m.room.message` 事件 = **4 263 B**；空 `/sync` 响应 = **196 B**；
> 带一条消息的 `/sync` = **1 024 B**。因此 dsh 首屏 3 501 190 B ≈ **821 条满长度回复**——
> 这就是「IM 路线在低带宽下可行」的核心算术。

### 6.7 E2EE 取舍（已决定：不做）

> **决定（2026-10-23）：No E2EE。** 只用明文私有房间（自建 homeserver + TLS）。
> 客户端实现上这不是「忽略」而是「拒绝」：`sync` 遇到 `m.room.encryption` 状态或
> `m.room.encrypted` 事件、以及 `assertRoomUnencrypted()` 检查到加密状态时，抛
> `EncryptedRoomError` 并停止推进 `since`——否则会出现「发成功了但对方永远看不到」。

| 方案 | 成本 | 安全边界 | 结论 |
|---|---|---|---|
| 明文 + 自建 homeserver + 私有房间 | 零依赖、零下载 | 信任 homeserver 管理员（你自己）；TLS | **采用** |
| E2EE（Olm/Megolm） | 需 crypto 栈（`matrix-js-sdk`/`matrix-rust-sdk`），远端落地面变大 | 端到端；homeserver 只见密文 | 不做（若未来要，必须换客户端实现，而不是给本模块打补丁） |
| 自造应用层加密 | 轻但**自造密码学** | 不推荐 | 不做 |

> 边界：**非加密房间**用纯 `fetch` 实现 CS API 完全可行（P2 sidecar 就靠这个做到零依赖）；
> **加密房间**则要处理 Olm/Megolm、设备/一次性密钥、to-device、cross-signing、key backup——
> 等于把「零依赖」变成「接一整套 SDK」。另外，曾用于「让简单客户端不实现 E2EE」的
> pantalaimon 代理 **已于 2025-06-04 archived**，别把它当逃生通道
> （[GitHub](https://github.com/matrix-org/pantalaimon)）。

---

## 7. hwb 自身要改什么

### 7.1 实例注册表：加 channel 字段

```jsonc
"channel": {
  "type": "matrix",
  "userId": "@dsh-dgx21:example.org",
  "roomId": "!abc:example.org",
  "mode": "bridge",          // "bridge"(P1，hwb 本地) | "sidecar"(P2，远端)
  "e2ee": false,
  "caps": ["prompt", "stream", "approval", "artifacts", "sessions"],
  "acpVersion": "0.2.1"      // initialize 协商出来的，不假设
}
```

### 7.2 状态：从「轮询」改为「事件驱动 + 兜底」

- channel 已启用的实例：`com.hwb.heartbeat` / `com.hwb.session` 是**主**数据源；
  `live-status` 轮询降为「事件静默 N 分钟才探一次」的兜底。
- `remote-reader` / `indexer` 保留（离线索引仍要工作），但可降频（结构元数据变化很慢）。
- 目标：从「N 个实例 × 多种 SSH 轮询」→「**1 条 `/sync`**」；往返 780 → 60–120/h。

### 7.3 chatops bot（可选但很值）

`@hwb:<home>` 进控制房间：`/instances`、`/status <host>`、`/start|stop <host>`、
`/open <host> <session>`、`/quota`、`/theme dark`。全部复用现有 REST API——
「把 hwb 的按钮搬进聊天」，才是「IM 当界面」对工作台本身的完整应用。

### 7.4 手术台不变

- 实例卡片增加「在 Matrix 打开」深链（`matrix.to`）；不再默认把 iframe 当日常入口。
- iframe 仍按需懒建（现状已正确），只在「大 diff / 多文件编辑 / 深度排查」时用。
- `dsh-session-deeplink` 保留：Matrix 事件可带 `matrix.to` 链接回 dsh session。

### 7.5 可观测性（把「卡」变成数字）

每实例记录：`/sync` 游标延迟、事件处理延迟、出站 429 次数、审批超时次数、
每轮线上字节（客户端侧计数）、ACP `initialize` 协商的 caps/版本。
这些进 dashboard 与日志——与仓库「所有结论都要能复现」的风格一致。

### 7.6 安全边界

- 房间/用户白名单；默认只接受 owner；bot 账号最小权限；token 文件 0600；不把 token 发进房间。
- 入站限流：每房间每分钟 N 条、单条 prompt ≤ 8 KB；超限丢弃并审计。
- **bot 拥有 dsh 全部权限（含 shell）⇒ 消息通道 = RCE 面**。homeserver 暴露公网时必须
  E2EE + 强口令 + 设备验证；最坏情况 kill switch：撤销 token / 踢 bot / 停 dsh。
- 不把密钥、`.env`、凭据写进消息；工具输出默认截断，完整输出留远端。

---

## 8. 与现有资产的关系 + 立刻能做的

### 8.1 已有资产的位置

| 资产 | 新架构里的位置 |
|---|---|
| `scripts/dsh21.mjs` | P1 之前/之外的一次性通道；P2 之后仍是「运维/兜底/长任务」通道 |
| `dsh21 --detach/--status/--collect` | 长任务语义直接复用；IM 的「进度编辑」就是它的 UI |
| `dsh-static-cache` | web 手术台的止血（首屏缓存） |
| `dsh-history-delta` | 手术台的增量历史；IM 路径不需要 |
| `proxy-cache` / `proxy-history` | 同上，保留 |

### 8.2 两个必须修的问题

1. **`dsh-history-delta` 在 dsh 0.2.x 上静默失效**：它 `inject=['connection','apiProxy']`，
   而 `apiProxy` 在 0.2.x 已不存在（`research/dsh-host-extension-points.md` §1.0）。
   症状：插件永不激活、历史仍全量重搬。修法：改用 `connection` + `sessionController`/`session`
   Remote，或至少「不可用则显式告警」而不是静默。
2. **`master` 健康探测是合成往返**：360 次/h、占往返 46%、只占字节 0.5%。
   改为「真实请求 RTT 的 EWMA 采样」或 60 s 一次。

### 8.3 P0：不依赖 IM 的三条低风险改动（建议立刻做）

来自 `research/hwb-wire-audit.md` §F.5，合计可砍掉现状空闲字节 **70–80%**：

| # | 改动 | 省 |
|---|---|---|
| (a) | master 健康探测 10 s → 60 s（或改用真实请求 RTT） | 约 300 次往返/h |
| (b) | 索引器对「无变化」home 跳过全量 `cat`（先比 mtime/大小摘要） | 约 3 MB/h |
| (c) | 打开 `HWB_HISTORY_DELTA=1`（先修 §8.2-1 的 0.2.x 兼容） | 单次打开会话 0.5–0.9 MB → 0.03–0.1 MB |

这三条的意义：**即使 IM 方案暂缓，用户体感也会立刻改善**；而且它们不改变任何架构。

---

## 9. 分阶段计划与验收指标

### P0 — 止血（1 周）

- 交付：§8.3 三条 + `dsh-history-delta` 兼容性修复/显式告警 + 往返/字节计数指标。
- 验收：空闲字节 ≤ 3 MB/h（现状 7.1–10.7）；往返 ≤ 200/h（现状 780）；`npm test` 全绿。

### P1 — hwb 本地桥（2–3 周）

- 交付：`src/channel/matrix.js`（/sync + 队列 + 去重 + txnId）、`src/channel/acp.js`
  （spawn/协议/重连/resume）、房间与用户白名单、`com.hwb.turn` 状态、审批原语；
  `tests/channel-*.test.js`（假 homeserver + 假 ACP 服务器，零依赖）。
- 验收：
  1. 手机发「在 dgx21 上 `hostname; nproc`」，**30 s 内**收到答案；
  2. `net-shim` 限速 **2 KB/s** + 60% 连接重置：消息**不丢**、**不重复执行**；
  3. 单轮线上字节 p95 ≤ 20 KB（hwb 侧计数）；
  4. hwb 重启后 `/sync` 游标续上；ACP 子进程重连后 `session/resume` 成功；
  5. 审批：非白名单用户 `/approve` 无效；白名单 ✅ 后执行，审计可回放。

### P2 — 远端 sidecar（3–4 周）

- 交付：`hwb-channel.mjs`（单文件、零依赖、Node ≥22）、部署脚本（幂等，拒绝下载）、
  `systemd --user` unit、持久队列、崩溃恢复；E2EE 决策落地。
- 验收：
  1. **关掉笔记本**、只留远端：手机发指令，远端照常执行并回复；
  2. 远端 dsh 重启：队列不丢；`running` 轮次标 `unknown` 且**不重跑**；
  3. 断网 10 分钟恢复：`/sync` 一次补齐，无遗漏、无重复；
  4. sidecar 崩溃不拖垮 dsh（独立进程），重启后队列恢复。

### P3 — 舰队化（持续）

- 交付：`com.hwb.instance/heartbeat/session` 事件、hwb 单 `/sync` 订阅、chatops bot、
  dashboard 房间与链路指标、live-status/索引降级。
- 验收：
  1. 空闲 1 h 字节 **≤ 0.5 MB**（现状 10.7，-95%）；
  2. 往返 **≤ 120/h**（现状 780，-85%）；
  3. 一个 `/sync` 同时服务 3 个实例，事件到达 p95 **< 5 s**；
  4. `~/.hwb/hwb.log` 里该实例 `ssh 连接失败` / `实时会话同步失败` 降到个位数/天。

### 明确不做

- 不在 IM 里复刻 web UI（大 diff、多文件树、图谱）。
- 不为微信写非官方直连（用 mautrix 桥，且承认合规风险）。
- 不追求逐 token 打字机效果（低带宽下只会制造限流与重试）。
- P1 阶段不动远端 sshd / VPN / dsh 上游代码。

---

## 10. 风险与反面意见

| 风险 | 现实 | 缓解 |
|---|---|---|
| IM 是异步 UX，交互弱 | 真：审批、diff、多文件编辑都更难 | 定位为遥控器；手术台保留 web |
| ACP 是 automation-only | 真：无 plan/todo/diff/终端视图 | 需要富呈现时回 web；或 P4 用插件补 |
| 同一 session 不能双端驱动 | 真（「被占用」） | 明确「交接」语义：web 关掉后 IM 再 resume |
| SSH 断则 agent 中途死 | 真（P1） | 长任务走 `--detach`；P2 sidecar 根治 |
| E2EE 设备管理复杂 | 真 | 自建 homeserver + 强口令；或明文私有房（自担） |
| homeserver 单点 + 元数据 | 真（房间图/时间/大小） | 自建；E2EE；不把敏感正文放消息 |
| Matrix 限流 | 真（默认 0.2/s、burst 10） | 合并推送、429 退避、自建放宽 |
| 消息长度上限 | 真 | 分块/文件/摘要降级 |
| bot = RCE 面 | **最严重** | 白名单 + 审批 + E2EE/私有房 + kill switch |
| dsh 版本漂移 | 真（0.2.x 已删 `apiProxy`） | `initialize` 协商 caps；CI 兼容测试 |
| 远端装东西违反「少下载」 | ACP 实测零下载；sidecar 仅 1 个文件 | 部署脚本先预检、拒绝下载 |

**最关键的反面意见**：如果诉求只是「手机上看看进度 / 发个指令 / 收个报告」，
不做完整 Matrix 桥、只做 **Telegram Bot / ntfy 单向通知 + 简单指令** 也能解决 60% 的痛。
Matrix 方案的价值在**多轮 + 审批 + 多实例 + 桥接生态 + 自建可控**；如果不要这些，成本更低但天花板更低。

---

## 11. 待决问题（需要用户拍板）

1. **homeserver**：自建（推荐：可控、E2EE、可放宽限流）还是用现有账号？
2. ~~**E2EE**~~：**已决定不做**（2026-10-23）。只用明文私有房间；客户端对加密房间显式失败。
3. **账号粒度**：每实例一个 bot（隔离好、管理多）还是全局一个 bot + 每实例一房间（省事、爆炸半径大）？
4. **入口**：日常默认进 Matrix（web 降为手术台），还是双入口并存一段时间？
5. **范围**：先做「指令 + 进度 + 结果 + 审批」，还是一开始就做多轮/文件回传？
6. **P1 的在线依赖**：能接受「笔记本不在就跑不了」多久？若不能接受，直接跳 P2。

---

## 12. 复现与验证方法

- **限速/坏链路**：`scripts/soak/net-shim.mjs`（`--shim-rate-kbyte`、`--shim-reset-pct`）包裹
  homeserver 与 SSH 连接（`MATRIX_BASE_URL` 指到 shim 监听口）。
- **字节计数**：`net-shim --stats`，或适配器对 `/sync`/`send` 与 ACP 帧计数 `content-length`。
- **假 homeserver / 假 ACP**：`tests/` 里用 `node:http` + `node:readline` 起两个零依赖假服务，
  单测幂等、去重、断点、限流退避、审批白名单（与仓库零依赖测试风格一致）。
- **ACP 冒烟**（只读）：
  ```sh
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}' \
    | ssh -T dgx21.tun 'dsh --profile acp'
  ```
- **不重复执行**：沿用 `dsh21` 的标记文件思路 + Matrix 队列状态机，测试注入
  「写入 started 后被 kill」与「同一消息重复投递」。

---

## 13. 最小 Matrix client：hwb 自己当客户端（P1/P2 共用）

**能，而且这是推荐做法。** Matrix 的 Client-Server API 就是「HTTPS + JSON + Bearer token」，
不需要 `matrix-js-sdk`，也不需要浏览器。hwb 已经是零 npm 依赖的 Node 常驻进程，具备
`fetch`、`child_process`、定时器、日志、SSE/HTTP 服务与零依赖测试框架——做一个**只服务 bot 场景**
的最小客户端，比接 SDK 更符合本仓库的工程约束，也能同时被 P1（hwb 进程内）和 P2（远端 sidecar）复用。

### 13.1 需要的端点（MVP 共 11 个，全部 `/_matrix/client/v3`）

| 用途 | 端点 | 备注 |
|---|---|---|
| 验活 | `GET /account/whoami` | 启动/重连后确认 token 有效；`M_UNKNOWN_TOKEN` → 降级告警 |
| 版本 | `GET /_matrix/client/versions` | 可选，记录 homeserver 能力 |
| 增量同步 | `GET /sync?since=&timeout=30000&filter=` | 长轮询；`next_batch` 持久化；`limited:true` 用 `prev_batch` 回填 |
| 发消息 | `PUT /rooms/{roomId}/send/m.room.message/{txnId}` | txnId 幂等（丢包重试安全） |
| 编辑（进度/流式） | 同上 + `m.new_content` + `m.relates_to:{rel_type:"m.replace",event_id}` | 合并推送，≤5 次/轮 |
| 反应（审批/ack） | `PUT /rooms/{roomId}/send/m.reaction/{txnId}` + `m.annotation` | ✅/❌ 绑定审批首条事件 |
| 历史回填 | `GET /rooms/{roomId}/messages?from=&dir=b&limit=` | 仅在 `limited` 缺口或首次进房时用 |
| 入房 | `POST /join/{roomIdOrAlias}` | 连同 `m.room.member=invite` 的**白名单邀请**才自动 join |
| 房间列表 | `GET /joined_rooms` | 启动时校准本地房间表 |
| 建房（provisioning） | `POST /createRoom` | `hwb channel init` 一次性用 |
| 房间状态 | `GET /rooms/{roomId}/state/{type}/{stateKey}` | 读 `com.hwb.instance` 等元数据 |
| （可选）typing | `PUT /rooms/{roomId}/typing/{userId}` | 便宜的存在感信号，`{"typing":true,"timeout":30000}` |

**不需要**：`/sync` 的 `to_device`/`device_lists`（无 E2EE 时是空转）、推送规则、read markers、
threads 的额外 API（`m.thread` 只是 `m.relates_to` 的一个字段）、媒体上传（MVP 先只发文本/路径）。

### 13.2 状态机与持久化

```
starting ──whoami ok──► syncing ──(网络错)──► backoff ──► syncing
   │                       │
   │                       ├─(M_UNKNOWN_TOKEN)──► degraded（停止自动重试，告警）
   │                       └─(429)──► 按 retry_after_ms 退避（不丢事件）
   └──(shutdown)──► stopped（abort 长轮询、flush 队列）
```

每个 bot 账号一个状态文件（`~/.hwb/channel/<instanceId>.json`，0600）：

```jsonc
{
  "baseUrl": "https://matrix.example.org",
  "userId": "@dsh-dgx21:example.org",
  "since": "s1234_5678_...",          // 不透明字符串，只存不解析
  "rooms": { "!abc:example.org": { "sessionId": "session-…", "lastEventId": "$…" } },
  "dedupe": ["$evt1", "$evt2"],        // 最近 N 条已处理 event_id（环形）
  "outbox": [                          // 未确认发送（带 txnId，重启后原样重试）
    { "txnId": "hwb-…", "roomId": "!abc:…", "type": "m.room.message", "content": { … } }
  ]
}
```

### 13.3 必须写对的七个细节

1. **`since` 只当不透明串**：不解析、不比较大小；丢了就退回「无 since 的首同步」。
2. **`limited: true` 是缺口信号**：用 `prev_batch` 走 `/messages` 回填，或直接标记该房间
   「需重新对齐」——**不能假装没发生**（会造成静默消息空洞）。
3. **去重按 `event_id`**，不是按文本/时间；`/sync` 重放和长轮询超时都会造成重复投递。
4. **出站先落盘再发**：同一 `txnId` 重试返回原 `event_id`，所以「超时 ≠ 失败」。
5. **429 只看 `retry_after_ms`**，不要自己猜；默认 `rc_message` 是 0.2/s、burst 10。
6. **长轮询不能被业务超时误杀**：`/sync` 的 AbortSignal 只由 shutdown 触发；
   网络错误先立即重试一次，再指数退避（1→2→4…封顶 60 s，带抖动）。
7. **自动 join 只对白名单邀请生效**：否则任何人拉 bot 进房都等于给你开了一个 RCE 入口。

### 13.4 代码骨架（约 450–700 行 + 测试）

```js
// src/channel/matrix-min.js —— 不 import 任何 hwb 模块，P2 可直接复制成单文件 sidecar
export function createMatrixClient({ baseUrl, token, filter, persist, log }) {
  let since = persist.load()?.since ?? null;
  const outbox = new Map();            // txnId -> content
  async function req(method, path, body, { timeoutMs = 30_000, signal } = {}) {
    const res = await fetch(new URL('/_matrix/client/v3' + path, baseUrl), {
      method, signal: signal ?? AbortSignal.timeout(timeoutMs),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (res.status === 429) throw Object.assign(new Error('rate-limited'),
      { retryAfterMs: json.retry_after_ms ?? 5_000 });
    if (res.status === 401) throw Object.assign(new Error('token-invalid'), { fatal: true });
    if (!res.ok) throw new Error(`matrix ${res.status}: ${json.errcode ?? ''}`);
    return json;
  }
  async function syncOnce({ timeout = 30_000, signal } = {}) {
    const q = new URLSearchParams({ timeout: String(timeout) });
    if (since) q.set('since', since);
    if (filter) q.set('filter', JSON.stringify(filter));
    const r = await req('GET', `/sync?${q}`, undefined, { timeoutMs: timeout + 15_000, signal });
    since = r.next_batch; persist.save({ since });
    return r;                           // 调用方按 rooms.join[].timeline.events 处理
  }
  async function send(roomId, type, content) {   // txnId 由调用方生成并持久化
    const txnId = content.__txnId ?? `hwb-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return req('PUT', `/rooms/${encodeURIComponent(roomId)}/send/${type}/${txnId}`, content);
  }
  return { syncOnce, send, edit: (roomId, evId, text, txnId) => send(roomId, 'm.room.message', {
    msgtype: 'm.text', body: `* ${text}`,
    'm.new_content': { msgtype: 'm.text', body: text },
    'm.relates_to': { rel_type: 'm.replace', event_id: evId }, __txnId: txnId,
  }), react: (roomId, evId, key, txnId) => send(roomId, 'm.reaction', {
    'm.relates_to': { rel_type: 'm.annotation', event_id: evId, key }, __txnId: txnId,
  }) };
}
```

> 说明：真实实现还要把 `__txnId` 从发送体里剥掉（它只是本地入队键）；这里为了骨架简洁没有展开。
> `filter` 建议：`{"room":{"timeline":{"limit":20,"types":["m.room.message","m.reaction","m.room.member","com.hwb.*"]}}}`，
> 并关掉 `lazy_load_members`（小房间不需要，省去 member 事件噪音）。

### 13.5 明确不做（否则就不叫「最小」）

| 不做 | 原因 | 后果 |
|---|---|---|
| **E2EE（Olm/Megolm）** | 需要设备密钥、to-device、cross-signing、key backup——等于接整套 SDK | 只能用**非加密房间**；若必须 E2EE，改用 `matrix-js-sdk`/rust-sdk 单独进程 |
| **Application Service** | 需要 homeserver 向 bridge 发起 HTTP 回调（入站可达），且要注册 namespace | 远端在 NAT 后就别想；bot 客户端是出站模型，天然合适 |
| **媒体上传/缩略图** | MVP 只发文本/路径/摘要 | 大产物留远端，按 `com.hwb.artifact` 回引用 |
| **多设备/密钥备份/验证** | 这是 bot，不是人的客户端 | 设备管理面归 Element，hwb 只持一个 token |

### 13.6 测试矩阵（零依赖假 homeserver）

用 `node:http` 起一个 20–30 行的假服务，覆盖：
`since` 续传、`limited` 回填、重复 `event_id` 去重、同 `txnId` 重发只产生一条、
429 + `retry_after_ms` 退避、401 `M_UNKNOWN_TOKEN` 停止重试、长轮询 timeout 返回空、
abort 后干净退出、outbox 重启恢复、非白名单邀请不自动 join。
这些正是 P1/P2 的验收项，也符合仓库「零依赖 + 可复现」的测试风格。

### 13.7 实现状态（2026-10-23）

已落地，且刻意**零 hwb 依赖**（P2 可直接复制成单文件 sidecar）：

| 文件 | 内容 |
|---|---|
| [`src/channel/matrix-min.js`](../src/channel/matrix-min.js) | `/sync`（不自动推进 since）、commit、去重、outbox（先落盘再发）、`txnId` 幂等、429/401 分类、编辑/反应、房间/状态/消息/typing、邀请白名单、加密房间拒绝、`createFileStore`（原子写 + 0600） |
| [`tests/channel-matrix-min.test.js`](../tests/channel-matrix-min.test.js) | 14 项契约测试：`since` 语义、`limited/prev_batch`、txnId 幂等、outbox 重启恢复、429 退避、401 致命、邀请白名单、加密房拒绝、abort 退出、文件权限/损坏、退避抖动 |

**下一步（P1 剩余）**：`src/channel/acp.js`（spawn `ssh -T <host> 'dsh --profile acp'` + NDJSON JSON-RPC +
`session/update` → Matrix 编辑 + `request_permission` → 反应审批），以及 `src/channel/index.js` 的 supervisor。

### 13.8 放在哪

| 阶段 | 位置 | 复用方式 |
|---|---|---|
| P1 | `src/channel/matrix-min.js`（hwb 进程内 worker） | hwb 直接 import，配 `src/channel/acp.js` |
| P2 | 同一个文件 → 远端 `hwb-channel.mjs`（单文件 sidecar） | 复制/打包，无 import、无依赖 |
| P3 | hwb 自己也可以作为第二个 Matrix 客户端（`@hwb`） | 同一模块，不同 token |

> 结论：**「最小 Matrix client」不是妥协，而是 P1/P2 的正确工程形状**——它把
> 「协议复杂度」留在 11 个端点里，把「crypto 复杂度」留给一个显式决策（要不要 E2EE），
> 并且完全不引入 npm 依赖。

---

## 附录 A：为什么「把 web 压小」不是根治

- 服务端压缩：hwb 反代已做（`-C` + Caddy/nginx 配置），首屏 gzip 后 0.79 MB，仍要 30 s+。
- 静态缓存：`dsh-static-cache` 让第二次打开变快，但首访/清缓存/升级仍付 3.34 MB。
- 增量历史：`dsh-history-delta` 只解决「历史」一项，且目前在 0.2.x 上失效（§8.2）。
- 结论：这些是止血。根治只有两条：**不搬 UI（IM）**，或**不搬远端（本地 brain + 远端 hands）**。

## 附录 B：另一条正交路线

**本地 brain + 远端 hands**：agent 跑在本地 dsh，远端只提供工具执行（SSH/MCP）。
好处：没有 web 跨网、没有会话同步；坏处：本地必须在线、远端数据按需取、
失去「远端持续跑长任务」的能力（除非配合 `dsh21 --detach`）。
与 IM 不冲突：IM 是「人 ↔ 远端 agent」的通道，本地 brain 是「agent 放哪」的选择。
若日常是「远端大数据 + 长任务」，仍推荐远端 brain（P2）。

## 附录 C：证据索引（本文件引用的关键实测）

| 结论 | 证据 |
|---|---|
| 3.34 MB 首屏 / 46 bundle / gzip 4.28× | `dgx21-lowbandwidth-channel.md` §1、§6 |
| 冷 9.5–9.9 KB / 暖 0.5–0.7 KB | 同上 §2.2、§3.6 |
| ~1 Mbps 上限、2–4% 丢包、PMTU 断崖 | `dgx21-tun-access.md` 第三轮 |
| 空闲 7.1–10.7 MB/h、780 往返/h、session.list 240 次/h | `research/hwb-wire-audit.md` §A–B |
| ACP 握手/能力/零下载/远端 22 会话 2.5 KB | 本文件 §4.1（命令可复现） |
| `apiProxy` 在 0.2.x 不存在、插件异步异常致命 | `research/dsh-host-extension-points.md` §0、§1.0、§7 |
| Synapse 默认 `rc_message` 0.2/s、burst 10 | `synapse/config/ratelimiting.py:89-97` |
| openclaw streaming/审批/线程/会话路由 | `docs.openclaw.ai/channels/matrix/*`（见 §3） |
| Matrix `/sync` since+timeout、64 KiB 上限、txnId 幂等 | `spec.matrix.org/latest/client-server-api/#syncing` / `#size-limits` / `#transaction-identifiers` |
| 4000 字符事件 4263 B、空 /sync 196 B、单消息 /sync 1024 B | `research/im-channel-prior-art.md` §5.1（构造实测，可复现） |
| openclaw 无 token-delta 流式、chunk 4000 字符 | `docs.openclaw.ai/concepts/streaming`、`extensions/matrix/src/matrix/format-profile.ts` |
| pantalaimon archived（E2EE 逃生通道已死） | `github.com/matrix-org/pantalaimon`（2025-06-04 archived） |
