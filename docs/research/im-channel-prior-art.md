# 先例调研：IM/channel 作为 agent 远程界面的既有实现与协议事实

> 调研对象：openclaw（原 Clawdbot / Moltbot）的 channel/gateway 架构、Matrix Client-Server API 里与「低带宽 + 断线续传」直接相关的机制、同类「远程 coding agent 聊天界面」产品（Happy / Omnara / VibeTunnel / claude-code-telegram / Codex app-server）。
>
> 目的：为 hwb 的「用 IM（Matrix）替代/补充远端 dsh web」路线提供可引用的事实、可迁移点与最小协议要素。
>
> 证据分级（全文统一）：
> - **[官方]** = 项目官方文档站 / 规范正文
> - **[源码]** = 仓库源码或测试文件（本轮实际抓取 raw 文件）
> - **[元数据]** = GitHub API / 仓库元数据
> - **[实测-构造]** = 本轮在本机按规范字段构造 JSON 后测得的字节数（可复现，方法见 §5.1）
> - **[推断]** = 本文基于证据的判断，非原文结论
> - **[未验证]** = 未能找到一手来源，明确不做数字承诺
>
> 抓取时间：2026-10-23（Asia/Singapore）。远端链路条件按 hwb 已知实测：约 1 Mbps、2–4% 丢包；dsh web 首屏 3 501 190 B（46 个 client bundle），见仓库内 [`docs/dgx21-lowbandwidth-channel.md`](../dgx21-lowbandwidth-channel.md)。

---

## 0. 结论摘要（先读这 12 条）

1. **openclaw 的核心选择不是「用 IM」，而是「一个长期存活的 Gateway 拥有全部 channel 与 session，客户端只是外设」**。控制面（macOS app / CLI / WebChat）也统一走 Gateway 的 WebSocket，默认只绑 `127.0.0.1:18789`。[官方](https://docs.openclaw.ai/concepts/architecture)
2. **openclaw 的远程模型是「隧道 + IM」，不是「公网暴露 web UI」**：官方远程文档明确给了三条路——Tailscale Serve / 受信局域网-Tailnet 直连 / SSH 隧道兜底；WebChat 在远程场景「走与其他客户端相同的 SSH/Tailscale 隧道」。[官方](https://docs.openclaw.ai/gateway/remote)、[官方](https://docs.openclaw.ai/concepts/architecture) → **与 hwb 的动机同构**：低带宽下不要传 3.34 MB 的 UI，只传文本增量。[推断]
3. **openclaw 没有真正的 token-delta 流式**：官方原文是「there is **no true token-delta streaming** to channel messages」，只有 (a) block streaming（按段发消息）与 (b) preview streaming（发一条消息再反复 edit）。[官方](https://docs.openclaw.ai/concepts/streaming)
4. **Matrix 通道的流式有四种模式**：`off`（默认）/`partial`/`quiet`/`progress`；预览超过 Matrix 单事件大小上限时**自动退回 final-only**（不再流式）。[官方](https://docs.openclaw.ai/channels/matrix/messaging)
5. **长消息分块：Matrix 与 Telegram 的默认 chunk 上限都是 4000 字符**（Matrix 源码 `chunk: { limit: 4_000, unit: "chars" }`；Telegram `TELEGRAM_TEXT_CHUNK_LIMIT = 4000`）。[源码](https://github.com/openclaw/openclaw/blob/main/extensions/matrix/src/matrix/format-profile.ts)、[源码](https://github.com/openclaw/openclaw/blob/main/extensions/telegram/src/text-chunk-limit.ts)
6. **Matrix 的断线续传原语就是 `/sync` 的 `since` + `timeout` 长轮询**：先无 `since` 拿 `next_batch`/`prev_batch`，之后带 `since=next_batch&timeout=30000` 长轮询增量；服务端「hold open the HTTP connection for a short period of time waiting for new events, returning early if an event occurs」。[官方](https://spec.matrix.org/latest/client-server-api/#syncing)
7. **Matrix 事件有 64 KiB 硬上限**：「The complete event MUST NOT be larger than 65536 bytes, when formatted with the federation event format, including any signatures, and encoded as Canonical JSON」。[官方](https://spec.matrix.org/latest/client-server-api/#size-limits)
8. **发送幂等由 `txnId` 保证**：同一 device、同一 endpoint、同一 txnId 的重传必须返回原始响应（含原始 `event_id`）。这正好覆盖 2–4% 丢包下的重试。[官方](https://spec.matrix.org/latest/client-server-api/#transaction-identifiers)
9. **sliding sync 仍未进入已发布规范**：MSC4186（Simplified Sliding Sync，2026-06-29 merged）取代 MSC3575（已标 `obsolete`），但最新规范 v1.19 的 C-S 页面里搜不到 sliding sync，MSC4186 PR 标签含 `spec-pr-missing`；实现侧以 matrix-rust-sdk 的 `sliding_sync` 模块为先。[元数据](https://github.com/matrix-org/matrix-spec-proposals/pull/4186)、[官方](https://spec.matrix.org/latest/client-server-api/)、[官方](https://docs.rs/matrix-sdk/latest/matrix_sdk/sliding_sync/index.html)
10. **「纯 HTTP 无 SDK 客户端」在非加密房间完全可行，加密房间基本不可行（成本极高）**：E2EE 涉及 Olm/Megolm、设备/一次性密钥、to-device、cross-signing、key backup 等一整套（规范用整章描述）；官方曾用 pantalaimon 这种「代理解密」守护进程规避，但该仓库 **2025-06-04 已 archived**。[官方](https://spec.matrix.org/latest/client-server-api/#end-to-end-encryption)、[官方](https://spec.matrix.org/latest/olm-megolm/megolm/)、[元数据](https://github.com/matrix-org/pantalaimon)
11. **同类产品几乎都不走「IM 协议」**：Happy 用自建 relay + Socket.IO + 自研 E2EE（AES-256 session DEK）；VibeTunnel 直接代理 PTY 的 WebSocket 二进制帧；Omnara 是 Web SPA + Go API + 无状态 worker + 机器 daemon；claude-code-telegram 是 Telegram Bot API + 本地进程。**「用现成 IM 当界面」只有 openclaw 这一条成熟先例**。[官方](https://happy.engineering/docs/how-it-works/)、[官方](https://docs.vibetunnel.sh/docs/spec)、[官方](https://docs.omnara.com/self-hosting/architecture)、[官方](https://github.com/seedprod/claude-code-telegram)
12. **IM 路线的硬缺点是可量化的**：Matrix 单事件 64 KiB（E2EE 后有效明文更少）、Synapse 默认 `rc_message: {per_second: 0.2, burst_count: 10}`（≈ 12 条/分钟持续）、无富交互（stock 客户端只渲染文本，openclaw 的按钮/审批元数据需自家客户端才认）、E2EE 设备管理是一整个运维面。[官方](https://spec.matrix.org/latest/client-server-api/#size-limits)、[官方](https://element-hq.github.io/synapse/latest/usage/configuration/config_documentation.html#rc_message)、[官方](https://docs.openclaw.ai/channels/matrix/rich-messages)、[官方](https://docs.openclaw.ai/channels/matrix/encryption)

---

## 1. 方法与证据边界

- 官方文档站 `docs.openclaw.ai/*` 支持直接取 `.md`（如 `https://docs.openclaw.ai/channels/matrix.md`），本轮以 `.md` 原文为引用依据，避免 HTML 噪音。
- 源码引用一律给 `github.com/openclaw/openclaw/blob/main/...` 的**真实路径**（本轮通过 GitHub tree API 枚举 60 777 个 blobs 后定位，再 raw 拉取正文）。
- Matrix 规范引用 `spec.matrix.org/latest/client-server-api/`（本轮抓到的版本为 **v1.19**，HTML 内 `v1.19` 出现 1357 次），锚点已逐个在 HTML 中验证存在。
- 本文所有「字节数」若来自构造测量，均在 §5.1 给构造方法与可复现命令；**没有精确来源的数字不写成精确值**。
- 二手来源（博客/媒体）在正文中显式标注；本轮结论尽量不依赖二手来源。

---

## 2. openclaw 拆解

### 2.1 它到底是什么（元数据）

| 项 | 值 | 来源 |
| --- | --- | --- |
| 仓库 | `openclaw/openclaw`，MIT | [元数据](https://github.com/openclaw/openclaw) |
| 创建 / 最近 push | 2025-11-24 / 2026-10-23 | GitHub API |
| 规模 | 60 777 个文件（tree API 枚举），`src/` 27 693、`extensions/` 12 204、`ui/` 6 756 | [元数据](https://github.com/openclaw/openclaw) |
| 文档站 | `docs.openclaw.ai`（含多语言前缀，本页只取英文路径） | — |
| 自述 | 「The AI that really does things. Any OS. Any Platform.」 | GitHub API |

> 规模提示：仓库约 10 GB（GitHub API `size` 字段 10 153 630 KB），**不要整仓 clone**；按 tree API + raw 单文件取用。

### 2.2 架构总览：一个 Gateway 拥有所有 channel 与 session

官方架构文档的关键句（[官方](https://docs.openclaw.ai/concepts/architecture)）：

- 「A single long-lived **Gateway** owns all messaging surfaces (WhatsApp via Baileys, Telegram via grammY, Slack, Discord, Signal, iMessage, WebChat).」
- 「Control-plane clients (macOS app, CLI, web UI, automations) connect to the Gateway over **WebSocket** on the configured bind host (default `127.0.0.1:18789`).」
- 「**Nodes** (macOS/iOS/Android/headless) also connect over WebSocket, but declare `role: node` with explicit caps/commands.」
- 「One Gateway per host. It is the only place that opens a WhatsApp session.」

Wire protocol（[官方](https://docs.openclaw.ai/concepts/architecture)）：

- 传输：WebSocket，文本帧 JSON；首帧必须是 `connect`。
- 请求：`{type:"req", id, method, params}` → `{type:"res", id, ok, payload|error}`。
- 事件：`{type:"event", event, payload, seq?, stateVersion?}`（带 `seq` —— 这就是可在断线后判断「漏了没有」的序号）。
- 「**Idempotency keys are required for side-effecting methods (`send`, `agent`) to safely retry. The server keeps a short-lived dedupe cache.**」→ 与 Matrix 的 `txnId` 是同一模式。
- 「All connects must sign the `connect.challenge` nonce.」+ 设备配对 + 设备 token。

**这条架构给 hwb 的直接启示**：把「会话/状态」放在一个常驻 daemon（= hwb 的远端 dsh 进程），把「呈现」做成可替换的前端（web / IM / CLI）。hwb 现在的 `dsh web` 是「前端自带 3.34 MB 资源和渲染逻辑」，IM 路线则是「前端退化成纯文本 channel adapter」。[推断]

### 2.3 为什么是 IM 而不是远程 Web UI（证据 + 边界）

**证据链**：

1. 官方远程文档把 remote access 定义为 **Gateway WS over Tailscale/SSH**，并明确「For the always-on and laptop setups, prefer keeping `gateway.bind: "loopback"`」。[官方](https://docs.openclaw.ai/gateway/remote)
2. WebChat 被定义为「Static UI that uses the Gateway WS API for chat history and sends. **In remote setups, connects through the same SSH/Tailscale tunnel as other clients.**」[官方](https://docs.openclaw.ai/concepts/architecture)
3. 频道总览的开篇是「OpenClaw can talk to you on **any chat app you already use**. Each channel connects via the Gateway.」[官方](https://docs.openclaw.ai/channels)
4. 官方远程文档给「always-on Gateway in your tailnet」列为「Best for: Laptops that sleep often but need the agent always-on」——即**日常交互入口默认不是 web**。[官方](https://docs.openclaw.ai/gateway/remote)

**因此，openclaw 的组合是**：公网/跨网远程 = 隧道（Tailscale/SSH）；「人不在电脑前」的日常交互 = IM channel；web UI 只是本地/隧道内的控制面。[推断]

> 注意：openclaw 官方**没有**一篇「为什么我们不用远程 web UI」的论证；上述是文档行为模式的归纳，不要把它当作项目自述。[推断]

### 2.4 channel 插件模型与 session 路由

**channel 种类**（[官方](https://docs.openclaw.ai/channels)，页内自动生成目录）：Telegram（bundled）、Discord / Slack / Signal / WhatsApp / Matrix / Mattermost / MS Teams / Feishu / Google Chat / iMessage / IRC / LINE / Nextcloud Talk / Nostr / QQ / SMS / Twitch / WeCom / Zalo…；WeChat 是 **external plugin**（见 §6.8）。

**路由规则**（[官方](https://docs.openclaw.ai/channels/channel-routing)）：

- 术语：Channel → AccountId → AgentId（隔离的 workspace + session store）→ **SessionKey**（存上下文与控制并发的桶）。
- 默认 DM 折叠：`agent:<agentId>:main`（`session.dmScope: "main"` 默认）；可切 `per-peer` / `per-channel-peer` / `per-account-channel-peer`。
- 群/房间：默认 `session.groupScope: "per-group"` → `agent:<agentId>:<channel>:group:<id>` 或 `…:channel:<id>`。
- 线程：Slack/Discord 追加 `:thread:<threadId>`；Telegram forum topic 内嵌 `:topic:<topicId>`。
- 路由优先级 9 条：精确 peer → 父 peer（线程继承）→ peer 通配 → Discord guild+roles → guild → Slack team → account → channel → fallback owner。
- 「OpenClaw routes replies **back to the channel where a message came from**. The model does not choose a channel.」

**Matrix 专属的 session 语义**（[官方](https://docs.openclaw.ai/channels/matrix/threads-and-sessions)）：

- `dm.sessionScope`：`"per-user"`（默认，同一 peer 的所有 DM 房间共享一个 session）/ `"per-room"`（每个 DM 房间独立 session key）。
- `threadReplies`：`"off"` / `"inbound"`（默认，只有入站消息已在线程里才在线程内回复）/ `"always"`（以触发消息为根在线程里回复）。
- 显式 conversation binding 永远压过 `sessionScope`；`/acp spawn --bind here` 可把 Matrix 房间/线程变成持久的 ACP 工作区。
- 入站线程消息会把 thread root 作为额外上下文注入 agent。

### 2.5 流式输出：没有 token delta，只有 block + preview

**官方定义**（[官方](https://docs.openclaw.ai/concepts/streaming)）：

> 「OpenClaw has two independent streaming layers, and there is **no true token-delta streaming** to channel messages:
> - **Block streaming (channels):** emit completed **blocks** as the assistant …
> - **Preview streaming (Telegram/Discord/Slack/Matrix/Mattermost/MS Teams):** update a temporary **preview message** while generating (send + edits/appends).
>
> Rapid provider deltas are **coalesced** before channel preview callbacks and worker …」

**关键参数**（同上）：

| 参数 | 取值 | 默认 |
| --- | --- | --- |
| `blockStreamingDefault` | `"on"` / `"off"` | `"off"` |
| `blockStreamingBreak` | `"text_end"` / `"message_end"` | — |
| `blockStreamingChunk` | `{ minChars, maxChars, breakPreference? }` | — |
| `blockStreamingCoalesce` | `{ minChars?, maxChars?, idleMs? }` | — |
| `*.streaming.chunkMode` | `"length"` / `"newline"` | `"length"` |

- 实现：`EmbeddedBlockChunker`（min/max 边界 + break preference）；表格若能在 `maxChars` 内放下就整块保留（[官方](https://docs.openclaw.ai/concepts/streaming)）。
- 合并（coalesce）：Discord、Signal、Slack 默认 `{ minChars: 1500, idleMs: 1000 }`（[官方](https://docs.openclaw.ai/concepts/streaming)）。
- block streaming 开启后还有「拟人化间隔」（`humanDelay`），避免多气泡刷屏（[官方](https://docs.openclaw.ai/concepts/streaming)）。

**Matrix 的四种 preview 模式**（[官方](https://docs.openclaw.ai/channels/matrix/messaging)）：

| `streaming.mode` | 行为 |
| --- | --- |
| `"off"`（默认） | 等完整回复，发一次 |
| `"partial"` | 就同一条文本消息反复 edit；「Stock clients may notify on the first preview, not the final edit」 |
| `"quiet"` | 同 partial，但用非通知 notice；需自带 push rule 才在 finalize 时通知 |
| `"progress"` | 用 progress draft 发紧凑进度行（`maxLines` 默认 8、`maxLineChars` 默认 120） |

- **超限回退**：「If a preview grows past Matrix's per-event size limit, OpenClaw stops preview streaming and falls back to final-only delivery.」
- **成本**：「Preview edits cost extra Matrix API calls. Leave `streaming.mode: "off"` for the most conservative rate-limit profile.」

> 对 hwb：IM 上的「流式」只能是「**同一条消息反复 edit + 合并节流**」，不可能是 token 级；且必须在超过事件上限时降级。[推断]

### 2.6 长消息分块（真实阈值在源码里）

| 通道 | 阈值 | 证据 |
| --- | --- | --- |
| Matrix | 4 000 chars（`eventTextLength > singleEventLimit` 才切；`chunkMode` 可为 `length`/`newline`） | [源码 format-profile.ts](https://github.com/openclaw/openclaw/blob/main/extensions/matrix/src/matrix/format-profile.ts)（`chunk: { limit: 4_000, unit: "chars" }`）、[文档](https://docs.openclaw.ai/channels/matrix)（`textChunkLimit` 默认 4000） |
| Telegram | 4 000 chars（rich text 模式另有 `TELEGRAM_RICH_TEXT_LIMIT`，取 min） | [源码 text-chunk-limit.ts](https://github.com/openclaw/openclaw/blob/main/extensions/telegram/src/text-chunk-limit.ts) |
| Discord | 通道自带 2 000 字符平台限制，插件有独立 `chunk.ts` | [源码目录（tree 中存在 `extensions/discord/src/chunk.ts`）](https://github.com/openclaw/openclaw/tree/main/extensions/discord/src) |

Matrix 分块不是 naive `slice`：`extensions/matrix/src/matrix/send/chunking.ts` 会（[源码](https://github.com/openclaw/openclaw/blob/main/extensions/matrix/src/matrix/send/chunking.ts)）：

1. 先 `renderMatrixMarkdownTables` 处理表格；
2. 用 `chunkMarkdownTextWithMode` 按 mode（length/newline）切；
3. 处理 `||spoiler||`、`<u>` 这类跨 chunk 的格式标签（重新补开/闭标签，`restoreMatrixStyleChunks`）；
4. 计算 `resolveMatrixChunkOverflow`（比较 source 与渲染后 body 长度）迭代加大保留量，避免「切完又超限」；
5. 实在放不下就抛错 `Matrix text chunk limit is too small for formatted content`。

> **可迁移**：分块要「格式感知 + 渲染后复检」，而不是按字符数硬切。hwb 若发 markdown/diff，必须做同样的事。[推断]

### 2.7 ack reaction / typing / 去重 / 幂等

**ack reaction**（[源码 ack-reactions.ts](https://github.com/openclaw/openclaw/blob/main/src/channels/ack-reactions.ts)、[文档](https://docs.openclaw.ai/channels/matrix/messaging)）：

- `shouldAckReaction()` 的 scope 枚举：`"all" | "direct" | "group-all" | "group-mentions" | "off" | "none"`，默认 `"group-mentions"`。
- 语义：组里「被 @ 到」才 ack；「a group that answers everything still acks the messages that address the agent」；ambient room event 默认静默（除非显式 `all`）。
- `createAckReactionHandle()`：**发送是 eager 的**（`sendPromise = params.send()` 先发，调用方继续处理），失败走 `onSendError`，`remove()` 用于清理。→ 这是「先用一个 reaction 表示收到，再异步跑 agent」的 UX 原型。
- Matrix 配置：`ackReaction`、`ackReactionScope`、`reactionNotifications`（默认 `"own"`：只转发打在 bot 自己消息上的 `m.reaction`）。[官方](https://docs.openclaw.ai/channels/matrix)

**去重与重放**（[官方](https://docs.openclaw.ai/channels/matrix/messaging)）：

> 「Matrix saves inbound messages to the shared SQLite ingress spool **before advancing its sync cursor**. Messages remain queued until an agent turn adopts them; a Gateway restart resumes any unadopted messages. **Matrix event IDs prevent sync replay from delivering the same event twice within the retained replay window.** Messages keep their sync timeline order within each room across restarts.」

以及：「On a first login without a saved cursor, Matrix **ignores pre-startup history** for the entire sync session, including rooms joined later.」

仓库里还有对应的回归场景文件（tree 中实存）：
`qa/scenarios/channels/matrix-restart-replay-dedupe.yaml`、`qa/scenarios/channels/matrix-stale-sync-replay-dedupe.yaml`、`qa/scenarios/channels/matrix-e2ee-cli-encryption-setup-idempotent.yaml`（[目录](https://github.com/openclaw/openclaw/tree/main/qa/scenarios/channels)）。

> **这是本调研最重要的工程模式**：**先落盘 spool，再推进 cursor**。低带宽 + 丢包场景下，顺序反过来就一定会丢消息。[推断]

### 2.8 allowlist / dmPolicy / pairing / autoJoin

Matrix 配置里的策略默认值（[官方](https://docs.openclaw.ai/channels/matrix)）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `groupPolicy` | `"allowlist"` | 房间流量默认只允许白名单 |
| `dm.policy` | `"pairing"` | 私聊默认需要配对（另有 `allowlist`/`open`/`disabled`） |
| `dm.allowFrom` | — | 私聊用户 ID 白名单 |
| `groupAllowFrom` | — | 房间用户 ID 白名单 |
| `allowlistOnly` | — | 强制把 `"open"` 降级为 `"allowlist"` |
| `autoJoin` | `"off"` | 是否自动接受邀请（`always`/`allowlist`/`off`） |
| `allowBots` | — | `true` 或 `"mentions"`，允许其他 bot 账号发言 |
| `dangerouslyAllowNameMatching` | false | 默认只认 `@user:server` / room id/alias，不认显示名 |
| `network.dangerouslyAllowPrivateNetwork` | false | 默认不允许连 LAN/Tailscale/localhost |
| `contextVisibility` | `"all"` | 另有 `allowlist`/`allowlist_quote` |
| `execApprovals.approvers` | 回退 `dm.allowFrom` | 审批人白名单 |

> 设计取向很清楚：**默认拒绝 + 显式白名单 + 不按显示名匹配**。hwb 如果做 IM 入口，这套默认值可以直接抄。[推断]

### 2.9 Matrix E2EE 在 openclaw 里的真实状态

- 「Matrix is a downloadable channel plugin (`@openclaw/matrix`) built on the official `matrix-js-sdk`. It supports DMs, rooms, threads, media, reactions, polls, location, **and E2EE**.」[官方](https://docs.openclaw.ai/channels/matrix)
- **默认关闭**：配置项 `encryption` 默认 `false`；开启后 `startupVerification` 默认 `"if-unverified"`（未验证设备会在其他 Matrix 客户端发起自验证，冷却 24h）。[官方](https://docs.openclaw.ai/channels/matrix)
- 实现路径：「Matrix E2EE uses the official `matrix-js-sdk` **Rust crypto path** with `fake-indexeddb` as the IndexedDB shim. Crypto state persists in the account's `state/openclaw.sqlite`」。且「E2EE requires the Matrix SDK's **native crypto bindings** to be available for your platform」。[官方](https://docs.openclaw.ai/channels/matrix/encryption)、[官方](https://docs.openclaw.ai/channels/matrix)
- 运维面（这一节特别值得读，因为它量化了「E2EE 设备管理」的成本）[官方](https://docs.openclaw.ai/channels/matrix/encryption)：
  - `verify status` 报三个独立信任信号：`Locally trusted` / `Cross-signing verified` / `Verified by owner`；只有 cross-signing verified 才算 owner 验证。
  - 恢复键流程：`verify device --recovery-key-stdin` → 输出 `Recovery key accepted` / `Backup usable` / `Device verified by owner`，三者不全时退出码非 0。
  - `verify bootstrap` 是一个「修复/建链」复合命令（顺序执行：标记并 cross-sign 当前设备等）。
  - `verify backup status|restore|reset` 管 room-key backup。
  - 设备卫生：`openclaw matrix devices list|prune-stale`。
  - **crypto owner 锁**：`state/openclaw.sqlite` 快照 + `.owner.poisoned` guard；异常退出后「refuse another crypto owner」，需要显式恢复。→ E2EE 状态是有状态、会腐化、需要运维的资产。
  - 入站语音在加密房间也要「先解密 media 再转写」。

### 2.10 审批交互（IM 上能做到什么程度）

- Matrix 原生审批是**普通 `m.room.message`** + 自定义 content key `com.openclaw.approval`；stock 客户端只显示文本 body，OpenClaw 客户端才读结构化字段。[官方](https://docs.openclaw.ai/channels/matrix/rich-messages)
- 长 prompt 跨事件时：文本分块，**`com.openclaw.approval` 只挂在第一个 chunk**；allow/deny reaction 绑定第一个事件。[官方](https://docs.openclaw.ai/channels/matrix/rich-messages)
- 反应快捷键：✅ allow once / ❌ deny / ♾️ allow always（受 exec 策略限制）；命令兜底 `/approve <id> allow-once|allow-always|deny`。[官方](https://docs.openclaw.ai/channels/matrix/rich-messages)
- 送达位置：`execApprovals.target` = `"dm"`（默认）/`"channel"`/`"both"`；channel 模式会把命令文本发进房间，官方明确提醒只在受信房间开。[官方](https://docs.openclaw.ai/channels/matrix/rich-messages)
- 按钮/选择列表走 `com.openclaw.presentation`（同样只有自家客户端渲染）。[官方](https://docs.openclaw.ai/channels/matrix/rich-messages)

> **结论**：IM 上的审批 = 文本 + 表情 + 斜杠命令；**没有原生 modal，也没有「不可误触」的强约束**。这是 hwb 不可迁移损失的一部分。[推断]

### 2.11 关键源码路径表（用于二次核对）

| 关注点 | 路径 |
| --- | --- |
| Gateway 架构 / WS 协议 | `docs/concepts/architecture.md`（[链接](https://docs.openclaw.ai/concepts/architecture)） |
| 远程访问拓扑 | `docs/gateway/remote.md`（[链接](https://docs.openclaw.ai/gateway/remote)） |
| channel 目录 | `docs/channels/*.md`（[链接](https://docs.openclaw.ai/channels)） |
| channel 路由 | `src/channels/*`（account/allowlist/mention/ack 等） |
| ack reaction | [`src/channels/ack-reactions.ts`](https://github.com/openclaw/openclaw/blob/main/src/channels/ack-reactions.ts) |
| Matrix 发送/分块 | [`extensions/matrix/src/matrix/send/`](https://github.com/openclaw/openclaw/tree/main/extensions/matrix/src/matrix/send)（`send.ts`、`chunking.ts`、`edit-content.ts`、`media.ts`） |
| Matrix 事件接收/去重 | [`extensions/matrix/src/matrix/monitor/`](https://github.com/openclaw/openclaw/tree/main/extensions/matrix/src/matrix/monitor)（`events.ts`、`inbound-dedupe-migration.ts`、`handler-*.ts`） |
| Matrix sync 状态 | `extensions/matrix/src/matrix/sync-state.ts`、`client/file-sync-store.ts`、`client/sync-cache-state.ts` |
| Telegram chunk | [`extensions/telegram/src/text-chunk-limit.ts`](https://github.com/openclaw/openclaw/blob/main/extensions/telegram/src/text-chunk-limit.ts)、`chunk-delivery.ts` |
| 去重运行时 | `packages/plugin-sdk/src/dedupe-runtime.ts`（薄封装，真实逻辑在各 channel） |

---

## 3. Matrix Client-Server API：与「低带宽 + 断线续传」相关的机制

### 3.1 `/sync` 的 since + timeout 长轮询（核心）

规范原文（[#syncing](https://spec.matrix.org/latest/client-server-api/#syncing)）：

> 「To read events, the intended flow of operation is for clients to first call the `/sync` API **without a since parameter**. This returns the most recent message events for each room, as well as the state of the room at the start of the returned timeline. The response also includes a `next_batch` field, which should be used as the value of the `since` parameter in the next call to `/sync`. Finally, the response includes, for each room, a `prev_batch` field, which can be passed as a `from`/`to` parameter to the `/rooms/{roomId}/messages` API to retrieve earlier messages.」

> 「Clients then receive new events by **“long-polling” the homeserver via the `/sync` API**, passing the value of the `next_batch` field from the response to the previous call as the `since` parameter. The client should also pass a `timeout` parameter. The server will then **hold open the HTTP connection for a short period of time waiting for new events, returning early if an event occurs**. **Only the `/sync` API (and the deprecated `/events` API) support long-polling in this way.**」

请求参数（规范 endpoint 表，[同页](https://spec.matrix.org/latest/client-server-api/#get_matrixclientv3sync)）：

| 参数 | 规范描述 |
| --- | --- |
| `since` | 「A point in time to continue a sync from. This should be the `next_batch` token returned by an earlier call to this endpoint.」 |
| `timeout` | 「The maximum time to wait, in milliseconds, before returning this request. If no events (or other data) become available before this time elapses, the server will return a response with **empty fields**.」 |
| `filter` | filter id 或内联 JSON（首字符 `{` 判定）；「Creating a filter … is recommended for clients that reuse the same filter multiple times, for example **in long poll requests**」 |
| `full_state` | 为 true 时忽略 `timeout` 立即返回（用于强制全量 state） |

**增量语义**（[#syncing](https://spec.matrix.org/latest/client-server-api/#syncing)）：

- 初始（无 since）sync 的 `state` 列表 = timeline 起点处的**完整**房间状态。
- 增量 sync 的 `state` 列表 = `since` 到 timeline 起点之间的**增量**（因此通常为空，除非 timeline 被截断）。
- **gap / limited**：「the server knows about four new events … but decides this is too many to report at once. Instead, the server sends a limited response … This forms a **gap**」；此时客户端用 `prev_batch` 调 `/messages` 回填。
- 截断时服务端 **MUST** 返回 gap 内成员的 membership 事件（「so that joins/leaves and profile changes which occur during the gap are not lost」）。
- `since` token 失效的语义：规范未承诺永久有效；MSC4186 的目标里明确写了「Servers should not need to store all past since tokens. **If a since token has been discarded we should gracefully degrade to initial sync.**」（[MSC4186](https://github.com/matrix-org/matrix-spec-proposals/pull/4186)）

**对 hwb 的含义**：`/sync` 就是天然的「断线续传 + 增量推送」通道；只要持久化 `next_batch`，重连后不会丢事件（在 homeserver 保留窗口内）；窗口外退化为全量（需要客户端能处理 limited）。[推断]

### 3.2 空 `/sync` 的开销（构造测量）

规范没有承诺空 sync 的响应体大小；服务端实现决定字段省略程度。按规范字段构造的最小响应体见 §5.1：**196 B**（含 `next_batch` + 各空字段）；只保留 `next_batch` 的 33 B 是理论下界（真实 homeserver 不会这样裁）。[实测-构造]

在 1 Mbps 链路上：每 30 s 一次空轮询 ≈ 196 B / 30 s ≈ **52 bit/s**，可以忽略；真正吃带宽的是 timeline 事件本体与 E2EE 的 to-device/key 流量。[推断]

### 3.3 事件大小上限：64 KiB（含签名）

规范（[#size-limits](https://spec.matrix.org/latest/client-server-api/#size-limits)）：

> 「The complete event **MUST NOT be larger than 65536 bytes**, when formatted with the **federation event format, including any signatures**, and encoded as **Canonical JSON**.」
>
> 「Some event types have additional size restrictions … Additional keys have no limit other than that implied by the total 64 KiB limit on events.」

要点：

- 上限针对**联邦格式**（含签名、canonical JSON），不是「你 POST 的 content 大小」。C-S 发送时服务器会补 `event_id`/`sender`/`origin_server_ts`/`unsigned`/hash/signature，还有 E2EE 的 `m.room.encrypted` 包装。[推断]
- 因此**业务可用的明文字节数 < 64 KiB**，E2EE 房间还要扣掉 base64 膨胀（约 4/3）与密钥/签名开销。openclaw 选 4 000 字符（≈ 4–12 KB UTF-8）是留了大余量的保守值。[推断]
- 媒体不走事件体：`m.image`/`m.file` 里只放 `mxc://` URI（[规范 media repo 章节](https://spec.matrix.org/latest/client-server-api/#content-repository)）。→ **大 diff / 长日志应当上传 media repo 或走别的 HTTP，而不是塞事件**。[推断]

### 3.4 `txnId` 幂等（丢包重试的正确姿势）

规范（[#transaction-identifiers](https://spec.matrix.org/latest/client-server-api/#transaction-identifiers)）：

- 客户端用 `PUT /_matrix/client/v3/rooms/{roomId}/send/{eventType}/{txnId}` 提交；txnId 用于「distinguish a new request from a retransmission … so that it can make the request idempotent」。
- 「Where a retransmission has been identified, the homeserver should **return the same HTTP response code and content as the original request**. For example … would return a 200 OK with the `event_id` of the original request」。
- 作用域：「The scope of a transaction ID is for a **single device, and a single HTTP endpoint**.」→ 同一 txnId 在 `send` 与 `sendToDevice` 互不冲突；重新登录换 device 后视为新请求。
- 推荐生成方式：「version 4 UUIDs or a concatenation of the current timestamp and a monotonically increasing integer」。

> 这是 2–4% 丢包下最关键的机制：**HTTP 超时不等于失败**，用同一 txnId 重试即可，不会产生重复消息。[推断]

### 3.5 `m.replace` 编辑事件（流式预览的实现基础）

规范模块：[`#event-replacements`](https://spec.matrix.org/latest/client-server-api/#event-replacements)。核心结构（规范定义）：

- 编辑是一条**新事件**，`content["m.new_content"]` 放新内容，`content["m.relates_to"] = {"rel_type": "m.replace", "event_id": "<被编辑事件>"}`，并且原 `body` 放 fallback 文本（老客户端显示）。
- 服务端做 **server-side aggregation**：`unsigned.m.relations["m.replace"]` 汇总（[#server-side-aggregation-of-mreplace-relationships](https://spec.matrix.org/latest/client-server-api/#server-side-aggregation-of-mreplace-relationships)）。
- 加密房间里，`m.relates_to` **必须放在明文部分**：「To allow the server to aggregate and find child events for a parent, the `m.relates_to` key of an event MUST be included in the **cleartext** portion of the event. It cannot be exclusively recorded in the encrypted payload as the server cannot decrypt the event for processing.」（[#forming-relationships-between-events](https://spec.matrix.org/latest/client-server-api/#forming-relationships-between-events)）

**工程含义**：

| 事实 | 对 hwb 的含义 |
| --- | --- |
| 每次 edit 都是一条完整新事件（含 body 全文） | 流式预览的成本 ≈ 每次全量重发当前文本 → 必须节流/合并（openclaw 用 coalesce + 模式开关）[推断] |
| 编辑以「新事件 + relates_to」表达，不是原地改 | 断线重放时可能收到同一目标的多次 edit，客户端需按 event_id/ts 取最后一条 [推断] |
| `m.relates_to` 在 E2EE 下是明文 | 「这条消息在回复/编辑哪条」对 homeserver 可见 → 元数据泄露面 [官方](https://spec.matrix.org/latest/client-server-api/#forming-relationships-between-events) |

### 3.6 `m.relates_to`：thread / reaction / 引用

- 关系模型：子事件 `content["m.relates_to"] = { rel_type, event_id, ... }`；`rel_type` 用 namespaced identifier（[#forming-relationships-between-events](https://spec.matrix.org/latest/client-server-api/#forming-relationships-between-events)）。
- 线程：`rel_type: "m.thread"`，「denotes that the event is part of a “thread” of messages and should be rendered as such」（同上）；线程规范见 [#threading](https://spec.matrix.org/latest/client-server-api/#threading)。
- 反应：`rel_type: "m.annotation"`，`key` 是 emoji；服务端聚合为 `unsigned.m.relations["m.annotation"]` 的计数（[#event-annotations-and-reactions](https://spec.matrix.org/latest/client-server-api/#event-annotations-and-reactions)）。
- 富回复（quote）**不用** `rel_type`：「Rich replies (Note: does not use `rel_type`)」（[#rich-replies](https://spec.matrix.org/latest/client-server-api/#rich-replies)）。
- 聚合是「bundled aggregation」：`unsigned.m.relations` 里带汇总，客户端不必逐条拉子事件（[#relationships](https://spec.matrix.org/latest/client-server-api/#forming-relationships-between-events)）。
- 已知限制（规范明说）：用 `rel_type=m.thread` 过滤 `/relations` **不适合**拿整条线程（「relations to the threaded events would be filtered out」），要自己客户端侧过滤（[#relationships-api](https://spec.matrix.org/latest/client-server-api/#relationships-api)）。

> **对 hwb 的用法**：把「一次 agent turn」映射成一条 thread root，把 tool 调用/中间输出挂在 `m.thread` 下，天然获得「按 turn 折叠」的 UI 结构；reaction 用于 ack / 审批。[推断]

### 3.7 限流（spec + Synapse 默认值）

规范（[#rate-limiting](https://spec.matrix.org/latest/client-server-api/#rate-limiting)）：

- 拒绝时返回 429 + `{"errcode": "M_LIMIT_EXCEEDED", "error": "..."}`；`retry_after_ms` **自 v1.10 起 deprecated**，改用 `Retry-After` header。
- 「Homeservers SHOULD implement rate limiting to reduce the risk of being overloaded.」

Synapse 默认值（官方配置文档，[#rc_message](https://element-hq.github.io/synapse/latest/usage/configuration/config_documentation.html#rc_message)）：

```yaml
rc_message:
  per_second: 0.2
  burst_count: 10.0
```

- ≈ **0.2 条/秒持续 + 10 条突发** ≈ 持续 12 条/分钟。这就是 openclaw 警告「preview edits cost extra Matrix API calls」的原因。[官方](https://docs.openclaw.ai/channels/matrix/messaging)
- 其它相关默认：`rc_registration: {per_second: 0.17, burst_count: 3.0}`（[同页](https://element-hq.github.io/synapse/latest/usage/configuration/config_documentation.html#rc_registration)）。

> **对 hwb 的硬约束**：如果 agent 每 200 ms 输出一次编辑，会立刻撞限流。必须「合并 + 最小间隔（≥1–2 s）+ 429 退避」。[推断]

### 3.8 sliding sync 现状（MSC4186 / MSC3575）

| 项 | 事实 | 来源 |
| --- | --- | --- |
| MSC3575（Sync v3） | 状态 closed，`merged: false`，标签含 **`obsolete`** | [PR #3575](https://github.com/matrix-org/matrix-spec-proposals/pull/3575) |
| MSC4186（Simplified Sliding Sync） | 状态 closed，**merged 2026-06-29**，标签 `T-Feature` / `matrix-2.0` / **`spec-pr-missing`** | [PR #4186](https://github.com/matrix-org/matrix-spec-proposals/pull/4186) |
| 是否已进规范 | 抓取的 spec v1.19 C-S 页面全文 grep `sliding` **0 命中**；无 `#sliding-sync` 锚点 | [spec v1.19](https://spec.matrix.org/latest/client-server-api/)（本轮实测） |
| 实现现状 | matrix-rust-sdk 有 `sliding_sync` 模块（文档自称「MSC3575 & extensions」），走 HTTP 长轮询 | [docs.rs](https://docs.rs/matrix-sdk/latest/matrix_sdk/sliding_sync/index.html) |

MSC4186 的动机（原文，[PR #4186](https://github.com/matrix-org/matrix-spec-proposals/pull/4186)）：

> 「The current `/sync` endpoint **scales badly as the number of rooms on an account increases**. … incremental syncs are **unbounded** and slow down based on how long the user has been offline. On large accounts with thousands of rooms, the **initial sync operation can take tens of minutes**.」

Goals（节选）：`Bandwidth should be minimized`、`Incremental sync responses should only include rooms that the user cares about`、`Servers should not need to store all past since tokens`。

> **对 hwb 的判断**：hwb 是「单用户、少量房间」场景，**`/sync` v2 完全够用**；sliding sync 的价值（房间数大、离线久）在这里不成立，且它尚未进规范、客户端生态不一致。→ **明确建议不用 sliding sync**。[推断]

### 3.9 E2EE：Olm/Megolm 现状与生态

规范章节：

- 总述：[#end-to-end-encryption](https://spec.matrix.org/latest/client-server-api/#end-to-end-encryption)
- 算法：Olm（1:1，Double Ratchet）[`olm-megolm/olm`](https://spec.matrix.org/latest/olm-megolm/olm/)；Megolm（群组，ratchet + Ed25519 签名）[`olm-megolm/megolm`](https://spec.matrix.org/latest/olm-megolm/megolm/)
- 设备与密钥：`device_lists` / `device_one_time_keys_count` 都在 `/sync` 响应里（[#syncing 响应字段](https://spec.matrix.org/latest/client-server-api/#get_matrixclientv3sync)）；设备验证/cross-signing 见 `#cross-signing`；密钥备份见 [#server-side-key-backups](https://spec.matrix.org/latest/client-server-api/#server-side-key-backups)；密钥请求见 `#key-requests`。

生态现状（本轮核实的仓库元数据）：

| 组件 | 状态（2026-10-23） | 来源 |
| --- | --- | --- |
| `matrix-org/vodozemac` | 活跃，纯 Rust 的 Olm/Megolm 实现（408 stars，最近 push 2026-10-20） | [GitHub](https://github.com/matrix-org/vodozemac) |
| `matrix-org/matrix-rust-sdk` | 活跃（2 336 stars，最近 push 2026-10-22） | [GitHub](https://github.com/matrix-org/matrix-rust-sdk) |
| `matrix-org/matrix-js-sdk` | 活跃（2 191 stars，最近 push 2026-10-22），openclaw 的 Matrix channel 就用它 | [GitHub](https://github.com/matrix-org/matrix-js-sdk) |
| `matrix-org/pantalaimon` | **已 archived**（2025-06-04），README 仍自述为「good man in the middle」解密代理，依赖 libolm | [GitHub](https://github.com/matrix-org/pantalaimon) |

E2EE 的运维复杂度，openclaw 文档给了完整的「失败模式清单」（[官方](https://docs.openclaw.ai/channels/matrix/encryption)）：设备被删/失效要重建 device；恢复键可能只解开 backup 但没有 cross-signing 信任（`verify device` 非 0 退出）；crypto store 有 owner 锁与 doom 场景；启动时会自动尝试 bootstrap/repair，UIA 失败则只是 warning。→ **这不是「加个 flag」级别的功能**。

规范还明确提示了「管理员可以给用户加设备」这一类信任问题：

> 「Non-cross-signed devices don't provide any assurance that the device belongs to the user, and **server admins can trivially create new devices for users**.」（[#end-to-end-encryption 章节的客户端建议](https://spec.matrix.org/latest/client-server-api/#end-to-end-encryption)）

> **结论**：E2EE 是「要么用成熟 SDK 全量接，要么不做」的二选一；不存在「纯 HTTP 自己拼一个够用的 E2EE」这种中间态。[推断]

### 3.10 「纯 HTTP 无 SDK 客户端」的可行性边界

**能跑（非加密房间 / 只做文本 bot）**——全部是普通 JSON over HTTPS：

1. `POST /_matrix/client/v3/login`（拿 `access_token` + `device_id`）
2. `GET /_matrix/client/v3/sync?since=...&timeout=30000`（长轮询增量）
3. `PUT /_matrix/client/v3/rooms/{roomId}/send/m.room.message/{txnId}`（发消息，幂等）
4. `PUT /_matrix/client/v3/rooms/{roomId}/send/m.reaction/{txnId}`（ack reaction）
5. `PUT /_matrix/client/v3/rooms/{roomId}/typing/{userId}`（typing）
6. `POST /_matrix/media/v3/upload`（大文件/长文本走 media，事件里放 `mxc://`）
7. 429 处理：读 `Retry-After` 退避

以上端点均在本轮抓取的规范页面中（[C-S API](https://spec.matrix.org/latest/client-server-api/)）。

**跑不了 / 极难（加密房间）**：

- 需要实现 Olm + Megolm（ratchet、签名、session 管理）；仅 Megolm 规范就包含 session key 分发、message format、ratchet 推进等（[megolm 规范](https://spec.matrix.org/latest/olm-megolm/megolm/)）。
- 需要设备密钥生命周期：上传 device keys、一次性密钥补充（`device_one_time_keys_count` 在 `/sync` 里催你补）、`/keys/query`、`/keys/claim`（[#end-to-end-encryption](https://spec.matrix.org/latest/client-server-api/#end-to-end-encryption)）。
- 需要 to-device 消息通道（`/sync` 的 `to_device` + `/sendToDevice`）来收 room key（[#syncing](https://spec.matrix.org/latest/client-server-api/#syncing)）。
- 需要 cross-signing / 设备验证 / key backup / secret storage（[#server-side-key-backups](https://spec.matrix.org/latest/client-server-api/#server-side-key-backups)、`#secret-storage`）。
- 媒体加密（`thumbnail_file` vs `thumbnail_url` 的选择都要跟 E2EE 状态联动——openclaw 文档的原话是「the plugin detects E2EE state automatically」，[官方](https://docs.openclaw.ai/channels/matrix/encryption)）。

**历史证据**：pantalaimon 的存在本身就说明「让简单客户端不实现 E2EE」是个真实需求——它作为本地代理替客户端加解密；但该仓库 **2025-06-04 archived**，README 仍要求 libolm。[GitHub](https://github.com/matrix-org/pantalaimon)

> **给 hwb 的实际建议**：要么 (a) 只用**非加密房间**做 IM 入口（内网/Tailscale 场景可接受），要么 (b) 直接用 matrix-js-sdk / matrix-rust-sdk 的 crypto 栈（Node 侧可行，openclaw 就是 matrix-js-sdk）。**不要自己写 crypto**。[推断]

### 3.11 桥接（把 Telegram/微信等接进 Matrix）

- Matrix 官方生态页列出 Discord / Slack / Signal / Telegram / WhatsApp / Messenger / iMessage 的桥（[matrix.org/ecosystem/bridges](https://matrix.org/ecosystem/bridges/)）。
- 桥的语义是「在 Matrix 侧表现为一个 bot/ghost 用户」；**桥进程必须能看到明文**才能转发到对端。→ 端到端保证在桥处终止（这是桥的固有性质，不是实现缺陷）。[推断，桥文档本轮未逐一核对]
- 微信：openclaw **没有**走「通用桥」，而是接腾讯官方的 external plugin `@tencent-weixin/openclaw-weixin`（[官方](https://docs.openclaw.ai/channels/wechat)），见 §6.8。

> 本节的桥实现细节（mautrix 家族各仓库的 E2EE 支持矩阵）**未经本轮逐一核实**，标为 [未验证]。

---

## 4. 同类「远程 coding agent 聊天界面」对照

### 4.1 对照表

| 产品 | 传输层 | 断线续传模型 | E2EE | 单条消息量级 | 是否自建服务 |
| --- | --- | --- | --- | --- | --- |
| **openclaw** | Gateway WebSocket（控制面）+ 各 IM 原生 API（对话面）；远程靠 Tailscale/SSH | Gateway `seq` + 幂等键去重；Matrix 侧 `since` + ingress spool | Matrix 通道可选 E2EE（默认关） | 4 000 字符 chunk（Matrix/Telegram） | 自托管 daemon；IM 侧依赖外部平台 |
| **Happy** | 自建 relay + **Socket.IO 单端点 `/v1/updates`**（user/session/machine 三种 scope） | 「On reconnect, clients can **re-fetch state** if they missed anything while offline」→ 无游标增量，靠重拉 | **自研 E2EE**：master secret → content keypair → session DEK(AES-256)；服务端只存密文 | 未验证（协议文档未给 payload 上限） | 是（官方云 + 可自托管 relay，~12k 行 TS） |
| **Omnara** | Web SPA + Go API + 无状态 worker + 机器 daemon（`omnarad`）；SSE 推流（Redis 承载 SSE 与限流） | 服务端持久化（Postgres）事件；客户端重连走 API/SSE | 未在自托管架构页声明 | 未验证 | 是（Docker Compose 自托管，Apache-2.0） |
| **VibeTunnel** | 浏览器 ↔ 本地 server 的 **WebSocket `/ws` v3 二进制帧**（INPUT_TEXT/STDOUT/SNAPSHOT_VT），PTY 直通 | 「VT snapshot v1 for previews/**resync**」；会话列表 3 s 轮询 | 未见 E2EE；靠 Basic Auth + localhost 模式 / Tailscale / ngrok | 二进制 PTY 帧，非「消息」概念 | 是（本地 server + 可选隧道） |
| **claude-code-telegram** | Telegram Bot API（HTTPS）+ 本地 Python 进程 | 会话按 user/project 持久化；Telegram 侧 offset 轮询 | 无（Telegram 平台负责传输加密） | 受 Telegram 4 096 字符限制 | 不需要 relay；只需 bot token |
| **Codex（app-server）** | JSON-RPC；本地 stdio / `--remote` 端点；`codex-app-server-daemon` 供 desktop/mobile 远程管理 | 服务端 thread/read state + cursor 分页 + revision CAS | 由底层传输/设备认证负责（文档提到 WebSocket 与 remote-control peers 需自己的 device authenticator） | JSON-RPC 消息，非聊天消息 | 是（daemon 跑在 agent 机器上） |

### 4.2 Happy（slopus/happy）

- 定位：「Orchestrate Claude, Codex and Grok in one app」，MIT，24 266 stars，TypeScript；官方把移动 app、CLI、relay server 放在同一仓库。[元数据](https://github.com/slopus/happy)
- 三部件模型：「CLI Program（加密后发）/ Mobile App（解密显示）/ **Relay Server**（只转发加密 blob，不能读）」。[官方](https://happy.engineering/docs/how-it-works/)
- 为什么需要 relay（原文）：「Both your phone and computer connect out to the server. This works because firewalls usually allow outgoing connections. **The server stores messages until both devices are ready.**」→ 与「homeserver 存在」是同一类拓扑约束。[官方](https://happy.engineering/docs/how-it-works/)
- 实时传输：**Socket.IO 单端点 `/v1/updates`**，三种 scope（user-scoped / session-scoped / machine-scoped），room 模型 `user:<id>:session:<sid>` / `user:<id>:machine:<mid>`；RPC 复用同一传输（`rpc-call` → `rpc-request` → ack）。[源码文档](https://github.com/slopus/happy/blob/main/docs/realtime-sync-and-rpc.md)
- 续传模型（原文）：「**On reconnect, clients can re-fetch state if they missed anything while offline.**」→ 没有 `since` 游标式的增量保证，靠「重拉状态」；对 hwb 意味着「如果自研，就必须自己设计 cursor」，不能指望 Socket.IO 自带。[源码文档](https://github.com/slopus/happy/blob/main/docs/realtime-sync-and-rpc.md)
- E2EE 设计（可量化的部分）[官方](https://happy.engineering/docs/security/)：
  - master secret → 派生 content keypair；每个 session 一个 **AES-256 session DEK**；每个 machine 一个 machine DEK（存 `~/.happy/access.key`）。
  - 分享给朋友时**只重加密 32 字节的 DEK**，内容不重加密：「Only the small DEK (32 bytes) is re-encrypted for friend. Original encrypted content stays exactly the same on server.」
  - 服务端只存「encrypted DEKs + encrypted content + metadata」；被攻破也拿不到明文。
- 自托管：Docker 镜像 + PGlite + `HANDY_MASTER_SECRET`，端口 3005；「The server is about 12,000 lines of TypeScript. You can read it yourself to verify it just forwards encrypted messages.」[官方](https://happy.engineering/docs/guides/self-hosting/)

> **对 hwb 的可借鉴点**：把「relay 只转发密文」作为安全边界；把「分享/多端」建模为「重加密小 key」而不是重传内容。[推断]

### 4.3 Omnara（omnara-ai/omnara）

- 自述：「The open-source managed agent platform. A self-hostable alternative to Claude Managed Agents and OpenAI's Agents API.」Go 实现，3 176 stars，Apache-2.0。[元数据](https://github.com/omnara-ai/omnara)
- 架构（自托管文档）[官方](https://docs.omnara.com/self-hosting/architecture)：
  - `web`：编译后的 SPA；`api`：公共 API；`worker`：**无状态**执行 agent turn（取任务、建上下文、调模型、跑工具），可水平扩；`maintenance`：回收锁/超时/机器池；`migrate`；`omnarad`：装在被控机器上的 daemon，装成 systemd/launchd，自更新。
  - 存储：Postgres（org/project/agent/events/machines/secrets）、Redis（通知与限流，主要承载 **SSE streaming**）、blob（附件/工具输出）、memory filesystem。
- 控制入口：Web、移动端、Slack、GitHub、schedule、MCP（README 列了多种启动方式）。[官方](https://github.com/omnara-ai/omnara)
- **没有采用 IM 协议**，而是自建 Web/API 前端 + SSE；IM 只是「入口之一」。

> **对 hwb**：Omnara 的「worker 无状态 + 事件表 + SSE」是另一种「低带宽增量推送」参考，但它要求客户端仍是 web app；不解决「不传 UI」的问题。[推断]

### 4.4 VibeTunnel（amantus-ai/vibetunnel）

- 定位：「Turn any browser into your terminal; command agents from the road」，4 696 stars，TypeScript。[元数据](https://github.com/amantus-ai/vibetunnel)
- 传输（官方 spec）[官方](https://docs.vibetunnel.sh/docs/spec)：
  - 「WebSocket Upgrade: Client establishes `/ws` connection (**v3 framing**)」；「Terminal Transport: **Multiplexed binary frames** (STDOUT + SNAPSHOT_VT)」。
  - 帧类型含 `INPUT_TEXT` / `INPUT_KEY` / `STDOUT` / `SNAPSHOT_VT`（用于 previews/**resync**）。
  - 暴露方式：「NgrokService or Tailscale can expose a secure public URL」；认证是 Basic Auth middleware。
  - 会话列表「Real-time session listing with **3-second polling**」。
- **本质是 PTY 代理**，不是消息系统：它传输的是终端字节流，因此无法在「无富交互的 IM」里复现（TUI 需要按键级交互）。[推断]

### 4.5 claude-code-telegram（seedprod/claude-code-telegram，原 RichardAtCT）

- Python 3.11+ 的 Telegram bot，「Connects Telegram to Claude Code」；README 列的能力：per-project session persistence、`APPROVED_DIRECTORY` 目录沙箱、`ALLOWED_USERS` 白名单、token bucket 限流、webhook API server（GitHub HMAC-SHA256 / Bearer）、`CLAUDE_MAX_COST_PER_USER` 成本上限、Markdown/HTML/JSON 会话导出。[官方](https://github.com/seedprod/claude-code-telegram)
- 注意：原链接 `RichardAtCT/claude-code-telegram` 现在 GitHub API 返回 **Moved Permanently**，raw 会重定向到新仓库（本轮实测）。引用请用新仓库。[元数据]
- 传输 = Telegram Bot API（HTTPS 轮询/Webhook）；**没有自建 relay**，也没有 E2EE 设计（依赖平台 TLS）。单条消息受 Telegram 平台上限约束（4 096 字符，见 §6.1）。

> 这是「最省事版 IM 路线」的样本：一个进程 + bot token 就能工作；代价是完全没有续传/增量协议设计，全靠平台。[推断]

### 4.6 Codex 的远程方案（openai/codex）

- 仓库：`openai/codex`，Rust，130 484 stars，最近 push 2026-10-23。[元数据](https://github.com/openai/codex)
- 远程/嵌入的核心是 **app-server（JSON-RPC）**：`codex-rs/app-server-daemon/README.md` 明确其定位——
  > 「`codex-app-server-daemon` backs the machine-readable `codex app-server` lifecycle commands used by **remote clients such as the desktop and mobile apps**. It is intended for Codex instances launched over **SSH** … expose app-server with `remote_control` enabled.」
  并提供 `codex app-server daemon enable-remote-control`、`… bootstrap --remote-control`、`--remote` 显式端点。[源码](https://github.com/openai/codex/blob/main/codex-rs/app-server-daemon/README.md)
- app-server 是 **JSON-RPC**：文档里大量 `-32602/-32603/-32600` 错误码；thread 分页用 cursor（`nextCursor`），read state 用 `{firstUnread, revision}` 做 CAS（`thread/readState/update` 要 `expectedRevision`）。[源码](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- 文档还提到「WebSocket and remote-control peers must use their own device authenticator」。[源码](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)

> **对 hwb 的启示**：Codex 的做法是「**本地进程暴露 RPC，远程客户端连它**」——不重新发明消息语义，而是把「会话/thread/游标」做进协议。hwb 若做 IM 入口，真正要设计的是「hwb 侧的 turn/thread 游标」，而不是 IM 侧。[推断]

---

## 5. 数字证据

### 5.1 构造测量（可复现）

**方法**：用 Python `json.dumps(..., separators=(',',':'), ensure_ascii=False)` 生成 canonical-ish 紧凑 JSON，UTF-8 编码后取 `len(bytes)`。字段取自规范 `/sync` 响应与 `m.room.message` 定义（[规范](https://spec.matrix.org/latest/client-server-api/#get_matrixclientv3sync)、[`m.room.message`](https://spec.matrix.org/latest/client-server-api/#mroommessage)）。

复现脚本（本轮实际执行）：

```python
import json
def size(o): return len(json.dumps(o, separators=(',',':'), ensure_ascii=False).encode())

text = "好的，我先把 dsh web 的首屏拆开看：46 个 client bundle 里最大的是 xterm 和 shiki 的语法高亮资源，这两块占了一半以上。" * 2  # 158 chars
ev = {
  "type": "m.room.message",
  "room_id": "!AbCdEfGhIjKlMnOp:matrix.example.org",
  "sender": "@hwb-agent:matrix.example.org",
  "content": {"msgtype": "m.text", "body": text},
  "event_id": "$3Q4r5T6y7U8i9O0p:matrix.example.org",
  "origin_server_ts": 1761200000000,
  "unsigned": {"age": 1234},
}
# 158 字符中文文本 → 573 B
# body 换成 4000 个 'x' → 4 263 B
sync_min = {"next_batch":"s72595_4483_1934","rooms":{},"presence":{"events":[]},
            "account_data":{"events":[]},"to_device":{"events":[]},
            "device_lists":{"changed":[],"left":[]},"device_one_time_keys_count":{}}  # 196 B
sync_one = {**sync_min, "rooms": {"join": {"!AbCd…": {
            "timeline": {"events":[ev],"limited":False,"prev_batch":"t1-2"},
            "state":{"events":[]},"ephemeral":{"events":[]},"account_data":{"events":[]},
            "unread_notifications":{"notification_count":1,"highlight_count":1}}}}}  # 1 024 B
```

| 测量对象 | 字节数 | 说明 |
| --- | --- | --- |
| 典型 `m.room.message` 事件（158 字符中文正文，含 `event_id`/`sender`/`room_id`/`ts`/`unsigned.age`） | **573 B** | [实测-构造] |
| 同一事件、正文 4 000 字符 | **4 263 B** | [实测-构造]；对应 openclaw 的 chunk 上限 |
| 最小空 `/sync` 响应（`next_batch` + 全部空字段） | **196 B** | [实测-构造]；理论下界（只留 `next_batch`）= 33 B |
| 单房间 + 单条 158 字符消息的 `/sync` 响应 | **1 024 B** | [实测-构造] |
| E2EE 房间中 4 000 字符明文的 Megolm 密文粗估 | ≈ **5.4 KB**（base64 后）+ 事件信封 | 估算：`ceil(4000/16)*16+16` 字节密文 → base64 ≈ 5 356 B；**标 [未验证]**，真实值取决于 padding/算法版本 |

**推算**（1 Mbps ≈ 125 KB/s 理论；hwb 实测 3.34 MB 首屏约 140 s，见 [`docs/dgx21-lowbandwidth-channel.md`](../dgx21-lowbandwidth-channel.md)）：

- 一次 4 000 字符回复 ≈ **4.3 KB JSON**（E2EE 约 5.5–6 KB）→ 在 1 Mbps 上 ≈ **0.04 s** 理论传输；即使按 2–4% 丢包 + RTT 放大，也是秒级。
- 3 501 190 B / 4 263 B ≈ **821×**：IM 一条满长度回复 vs dsh web 首屏的字节比。这就是「IM 路线在低带宽下可行」的核心算术。[实测-构造 + 仓库实测]
- 空 `/sync` 每 30 s 一次 ≈ 196 B → **≈ 52 bit/s**，可忽略。[实测-构造 + 推断]

### 5.2 其它可引用阈值

| 阈值 | 值 | 来源 |
| --- | --- | --- |
| Matrix 事件上限 | 65 536 B（联邦格式，含签名，canonical JSON） | [spec #size-limits](https://spec.matrix.org/latest/client-server-api/#size-limits) |
| openclaw Matrix chunk | 4 000 chars | [源码](https://github.com/openclaw/openclaw/blob/main/extensions/matrix/src/matrix/format-profile.ts) |
| openclaw Telegram chunk | 4 000 chars | [源码](https://github.com/openclaw/openclaw/blob/main/extensions/telegram/src/text-chunk-limit.ts) |
| Telegram `sendMessage` 文本 | 1–4 096 字符（entities 解析后） | [官方](https://core.telegram.org/bots/api#sendmessage) |
| Telegram bot 广播 | 默认 30 条/秒 | [官方](https://core.telegram.org/bots/api#sendmessage)（同页说明） |
| Synapse `rc_message` | 0.2/s，burst 10 | [官方](https://element-hq.github.io/synapse/latest/usage/configuration/config_documentation.html#rc_message) |
| Discord message content | 2 000 字符 | [官方](https://discord.com/developers/docs/resources/message) |
| openclaw preview 进度行 | `maxLines` 8、`maxLineChars` 120 | [官方](https://docs.openclaw.ai/channels/matrix/messaging) |
| openclaw coalesce（Discord/Signal/Slack） | `{minChars: 1500, idleMs: 1000}` | [官方](https://docs.openclaw.ai/concepts/streaming) |

### 5.3 明确「未验证」的项

以下数字本轮**没有**找到一手来源，不要写进对外材料当事实：

- Synapse/Conduit **空 `/sync` 的实际线上字节数**（与实现裁剪、`device_lists`、`to_device`、presence/typing EDU 有关）——本文只给规范字段构造值。
- openclaw/Matrix **preview edit 的实际 API 调用频率**（是否节流、间隔多少）——文档只说「cost extra」「coalesce」，未给具体间隔。
- Happy 的**单条消息 payload 上限**与 Socket.IO 配置（`maxHttpBufferSize` 等）——仓库协议文档未给数值。
- Omnara 的**单事件字节量级**（SSE payload 上限）——架构页未给。
- Matrix **E2EE 后 4 000 字符明文的精确密文字节数**——取决于 Megolm 版本、padding、签名，本文只给估算区间。
- 微信桥接的**合规风险等级**——本轮只核实 openclaw 走的是腾讯官方插件；unofficial personal-WeChat 自动化是否违 ToS **未验证**。

---

## 6. 反面证据：IM 路线的缺点（逐条带证据）

### 6.1 消息长度限制是硬的

- Matrix：单事件 64 KiB（含签名）→ 明文预算更小（§3.3）。[官方](https://spec.matrix.org/latest/client-server-api/#size-limits)
- Telegram：4 096 字符；Discord：2 000 字符。[官方](https://core.telegram.org/bots/api#sendmessage)、[官方](https://discord.com/developers/docs/resources/message)
- 后果：**任何长输出都要分块**，分块就要处理「代码块跨块」「markdown 表格跨块」「diff 跨块」；openclaw 为此写了 299 行的 `chunking.ts`（[源码](https://github.com/openclaw/openclaw/blob/main/extensions/matrix/src/matrix/send/chunking.ts)）。[推断]

### 6.2 没有富交互（diff / 按钮 / 树状视图）

- stock Matrix 客户端只渲染文本；openclaw 的按钮/选择列表放在 `com.openclaw.presentation`，官方明说「Stock Matrix clients show the text; **OpenClaw-aware clients** can render the structured controls」。[官方](https://docs.openclaw.ai/channels/matrix/rich-messages)
- 审批同理：`com.openclaw.approval` 是自定义 content，stock 客户端只看到文本。[官方](https://docs.openclaw.ai/channels/matrix/rich-messages)
- **diff 没有原生表达**：只能塞进 ` ```diff ` 代码块或发图片/文件；无法做折叠、逐 hunk 接受/拒绝。[推断]

### 6.3 审批交互弱且可误触

- 审批 = 表情反应（✅/❌/♾️）+ `/approve` 命令；长 prompt 时 reaction 绑定「第一个 chunk」。[官方](https://docs.openclaw.ai/channels/matrix/rich-messages)
- 没有任何「二次确认/不能被误触」的 UI 原语；`channel` 模式还会把命令文本发进房间（官方警告只在受信房间开）。[官方](https://docs.openclaw.ai/channels/matrix/rich-messages)
- 对比 web 端：可以做 modal、可以做 diff 预览 + 按钮、可以要求输入确认串。[推断]

### 6.4 E2EE 设备管理是一整个运维面

- 见 §3.9 与 §2.9：cross-signing、recovery key、key backup、device pruning、crypto store owner 锁、启动自动修复、UIA 失败降级。[官方](https://docs.openclaw.ai/channels/matrix/encryption)
- 规范还提醒：服务端管理员可以给用户加设备，非 cross-sign 设备没有身份保证。[官方](https://spec.matrix.org/latest/client-server-api/#end-to-end-encryption)
- pantalaimon（代理式解密）已 archived → 「绕过 E2EE 复杂度」的老路已经没人维护。[GitHub](https://github.com/matrix-org/pantalaimon)

### 6.5 homeserver 是外部依赖

- 必须有可达的 homeserver；openclaw 甚至为此专门写了「private/LAN homeservers」「proxying Matrix traffic」「network.dangerouslyAllowPrivateNetwork」这些配置项。[官方](https://docs.openclaw.ai/channels/matrix)
- 用公共 homeserver（matrix.org）要接受其限流与可用性；自建 Synapse 则是另一份运维（Postgres/Redis/反向代理/联邦端口）。[推断]
- 限流默认值见 §3.7（0.2/s + burst 10）。[官方](https://element-hq.github.io/synapse/latest/usage/configuration/config_documentation.html#rc_message)

### 6.6 顺序 / 重放 / 重复

- Matrix 的 timeline 顺序由 homeserver 维护；**断线重放**靠 event_id 去重，且只在「retained replay window」内保证不重复投递。[官方](https://docs.openclaw.ai/channels/matrix/messaging)
- limited sync 会产生 **gap**（规范明说），需要 `/messages` + `prev_batch` 回填。[官方](https://spec.matrix.org/latest/client-server-api/#syncing)
- `since` token 可能被服务端丢弃（MSC4186 目标明确要求 graceful degrade 到 initial sync）→ 客户端必须能处理「突然全量」。[MSC4186](https://github.com/matrix-org/matrix-spec-proposals/pull/4186)
- openclaw 为此把「先 spool 再推进 cursor」写进文档，并保留 restart-replay / stale-sync-replay 的 QA 场景。[官方](https://docs.openclaw.ai/channels/matrix/messaging)、[目录](https://github.com/openclaw/openclaw/tree/main/qa/scenarios/channels)

### 6.7 隐私与审计

- E2EE 下 `m.relates_to` 仍在明文（服务端要聚合）→ 「谁在回复/编辑谁」对 homeserver 可见。[官方](https://spec.matrix.org/latest/client-server-api/#forming-relationships-between-events)
- 房间成员、sender、时间戳、事件大小等元数据对 homeserver 天然可见。[推断]
- 审计需求（谁批准了什么命令）需要应用层自己记：openclaw 把审批状态存在自己的 session/persisted state 里（「reaction targets recovered from persisted state」）。[官方](https://docs.openclaw.ai/channels/matrix/rich-messages)

### 6.8 微信桥接的特殊性（不是「合规风险」那么简单）

- openclaw 的微信**不是**通用桥，而是腾讯 Weixin 团队维护的 external plugin `@tencent-weixin/openclaw-weixin`，走「Tencent iLink API」；**只声明支持 direct chats，不支持群聊**。[官方](https://docs.openclaw.ai/channels/wechat)
- 含义：(a) 官方插件 = 合规风险相对低，但能力受平台约束（无群）；(b) 「微信接入」在 hwb 场景里不是「选个桥」的问题，而是「腾讯是否开放该能力」的问题。[推断]
- 非官方个人微信自动化（hook/逆向）的 ToS 风险：本轮**未验证**具体条款，标 [未验证]。

### 6.9 `/sync` 在大账号上会退化（对 hwb 不构成问题）

- MSC4186 原文：账号房间数上千时 initial sync 可能要「tens of minutes」，增量 sync 随离线时长无界增长。[MSC4186](https://github.com/matrix-org/matrix-spec-proposals/pull/4186)
- hwb 是单用户、少量房间 → 不触发；但也说明「不要指望 `/sync` 在任意规模下都便宜」。[推断]

### 6.10 IM 不是终端

- 无法传 PTY 字节流：VibeTunnel 需要 `INPUT_KEY`/`STDOUT` 二进制帧 + `SNAPSHOT_VT` resync（[官方](https://docs.vibetunnel.sh/docs/spec)）。
- 无法做 TUI 交互、无法传 ANSI 光标控制、无法传按键级事件。[推断]

---

## 7. 对 hwb 的可迁移点 / 不可迁移点

### 7.1 可迁移（建议抄的）

1. **「一个 daemon 拥有 session，channel 只是 adapter」的分层**：hwb 已有远端 dsh 进程；把「呈现」抽成 channel adapter，web 只是其中一种前端。openclaw 的 Gateway 就是这个形状。[官方](https://docs.openclaw.ai/concepts/architecture)
2. **远程不传 UI，只传文本增量**：openclaw 用隧道 + IM；hwb 的 3.34 MB 首屏在 1 Mbps 下要 140 s，IM 一条 4 KB 回复只要秒级（§5.1）。[推断 + 仓库实测]
3. **`since` + `timeout` 长轮询 + 持久化游标**：Matrix `/sync` 的语义可以照抄到 hwb 自己的远端协议（hwb 已有 `dsh-history-delta`/`dsh-remote-index` 之类目录，方向一致）。[官方](https://spec.matrix.org/latest/client-server-api/#syncing) + 仓库内 [`docs/dgx21-lowbandwidth-channel.md`](../dgx21-lowbandwidth-channel.md)
4. **先 spool 再推进 cursor**（顺序不能反）：openclaw 的 ingress spool + event_id 去重是断线不丢的标准答案。[官方](https://docs.openclaw.ai/channels/matrix/messaging)
5. **幂等发送**：txnId/UUID + 重试返回原结果；HTTP 超时不等于失败。[官方](https://spec.matrix.org/latest/client-server-api/#transaction-identifiers)
6. **流式 = 单消息反复 edit + 合并节流 + 超限降级**：openclaw 的 partial/quiet/progress + coalesce + 「超限退 final-only」是完整配方。[官方](https://docs.openclaw.ai/channels/matrix/messaging)、[官方](https://docs.openclaw.ai/concepts/streaming)
7. **格式感知分块**：4 000 字符 + newline 优先 + 代码块/表格保护 + 渲染后复检。[源码](https://github.com/openclaw/openclaw/blob/main/extensions/matrix/src/matrix/send/chunking.ts)
8. **ack reaction 当「已收到」信号**（eager send，失败不阻塞主流程）。[源码](https://github.com/openclaw/openclaw/blob/main/src/channels/ack-reactions.ts)
9. **默认拒绝的 allowlist + pairing + 不按显示名匹配**。[官方](https://docs.openclaw.ai/channels/matrix)
10. **按 turn 建 thread**（`m.thread` root = 一次 turn），天然获得折叠结构。[官方](https://spec.matrix.org/latest/client-server-api/#threading)
11. **审批用「自定义 content + 反应快捷键 + 斜杠命令兜底」三级降级**，并记录 approver 白名单。[官方](https://docs.openclaw.ai/channels/matrix/rich-messages)
12. **多端安全模型参考 Happy**：服务端只存密文；分享 = 重加密小 DEK。若 hwb 要做多设备，这是低成本路径。[官方](https://happy.engineering/docs/security/)

### 7.2 不可迁移（必须接受的损失）

| 能力 | 为什么不可迁移 | 证据 |
| --- | --- | --- |
| 3.34 MB 的 web UI（diff 视图、A2UI、画布） | IM 客户端只渲染文本；自定义 content 需要自家客户端 | [官方](https://docs.openclaw.ai/channels/matrix/rich-messages) |
| 富审批 modal / 逐 hunk 接受 | 只有 reaction + 命令，无 modal 原语 | [官方](https://docs.openclaw.ai/channels/matrix/rich-messages) |
| PTY/TUI 交互 | IM 无按键/字节流语义；VibeTunnel 必须自带 WS 二进制协议 | [官方](https://docs.vibetunnel.sh/docs/spec) |
| 高频 token 级流式 | 没有 token-delta streaming；且受 Matrix 限流（0.2/s） | [官方](https://docs.openclaw.ai/concepts/streaming)、[官方](https://element-hq.github.io/synapse/latest/usage/configuration/config_documentation.html#rc_message) |
| 单条大 payload（>64 KiB） | 事件硬上限 64 KiB（含签名） | [官方](https://spec.matrix.org/latest/client-server-api/#size-limits) |
| E2EE 的「开箱即用」 | 需要完整 SDK + 设备管理；自研不现实 | [官方](https://spec.matrix.org/latest/client-server-api/#end-to-end-encryption) |
| homeserver 可用性/限流控制权 | 外部依赖；自建 Synapse 是另一份运维 | [官方](https://docs.openclaw.ai/channels/matrix) |
| 审计与合规闭环 | 元数据在 homeserver，审计需应用层自记 | §6.7 |
| 微信全能力接入 | 官方插件只支持 direct chats | [官方](https://docs.openclaw.ai/channels/wechat) |

---

## 8. 如果用 Matrix 做：最小可用协议要素（MVP checklist）

> 目标：**单用户、单/少数房间、文本 + 审批 + 断线续传**，不做 E2EE 或只用成熟 SDK。以下每条都是「不做就会坏」的项。

### 8.1 连接与会话

- [ ] `POST /_matrix/client/v3/login` → 持久化 `access_token` + `device_id`（不要每次重登，否则 txnId scope 变化）。[规范](https://spec.matrix.org/latest/client-server-api/#login)
- [ ] `GET /_matrix/client/v3/sync`（首次不带 `since`，带最小 filter：限制 timeline 条数、关 presence）→ 存 `next_batch`。[规范](https://spec.matrix.org/latest/client-server-api/#syncing)
- [ ] 之后 `GET /sync?since=<token>&timeout=30000` 长轮询；超时返回空字段是正常的，**不要当成断线**。[规范](https://spec.matrix.org/latest/client-server-api/#syncing)

### 8.2 断线续传与去重

- [ ] `next_batch` 持久化（文件/DB），重启后从该 token 继续；**先写 ingress spool，再推进 cursor**。[openclaw 做法](https://docs.openclaw.ai/channels/matrix/messaging)
- [ ] 维护 `event_id` 去重集合（至少覆盖 replay window）；忽略自己发出的事件（`sender == self`）。[推断自 openclaw]
- [ ] 处理 `timeline.limited == true`：用 `prev_batch` 调 `/rooms/{roomId}/messages?dir=b` 回填 gap。[规范](https://spec.matrix.org/latest/client-server-api/#syncing)
- [ ] 处理「`since` 被服务端丢弃」→ 退化为 initial sync（重新拿全量 state）。[MSC4186 目标](https://github.com/matrix-org/matrix-spec-proposals/pull/4186)

### 8.3 发送与幂等

- [ ] `PUT /_matrix/client/v3/rooms/{roomId}/send/m.room.message/{txnId}`，txnId 用 UUIDv4；超时/5xx 用**同一 txnId** 重试。[规范](https://spec.matrix.org/latest/client-server-api/#transaction-identifiers)
- [ ] 429 处理：读 `Retry-After`，指数退避；`retry_after_ms` 已 deprecated。[规范](https://spec.matrix.org/latest/client-server-api/#rate-limiting)
- [ ] 发送队列串行化（单房间单 worker），避免并发撞限流。[推断]

### 8.4 流式（可选但推荐）

- [ ] 先发一条占位消息拿 `event_id`，再用 `m.replace` 反复编辑（`m.new_content` + `m.relates_to{rel_type:"m.replace"}`），**编辑节流 ≥1–2 s**。[规范](https://spec.matrix.org/latest/client-server-api/#event-replacements)
- [ ] 接近 64 KiB / 4 000 字符阈值时**停止流式，退 final-only**（openclaw 的降级策略）。[官方](https://docs.openclaw.ai/channels/matrix/messaging)
- [ ] E2EE 房间注意：`m.relates_to` 必须在明文部分。[规范](https://spec.matrix.org/latest/client-server-api/#forming-relationships-between-events)

### 8.5 分块

- [ ] 4 000 字符上限；优先在换行/段落边界切。[源码](https://github.com/openclaw/openclaw/blob/main/extensions/matrix/src/matrix/format-profile.ts)、[文档](https://docs.openclaw.ai/channels/matrix)
- [ ] 代码块（```）与表格不跨块；跨块时补齐 fence / 表头。[推断自 openclaw chunking.ts]
- [ ] 每块独立可读（带 `(1/3)` 之类序号）以避免乱序阅读。[推断]

### 8.6 交互信号

- [ ] ack reaction（如 ✅）在「收到并开始处理」时立刻发；失败不阻塞主流程。[源码](https://github.com/openclaw/openclaw/blob/main/src/channels/ack-reactions.ts)
- [ ] `PUT /rooms/{roomId}/typing/{userId}` 表示正在生成；结束/失败时停。[规范](https://spec.matrix.org/latest/client-server-api/#typing-notifications)
- [ ] 审批：自定义 content（如 `com.hwb.approval`）+ ✅/❌/♾️ 反应 + `/approve <id> ...` 命令兜底；approver 白名单校验。[官方](https://docs.openclaw.ai/channels/matrix/rich-messages)

### 8.7 大内容

- [ ] 长日志/diff/文件走 `POST /_matrix/media/v3/upload` → 事件里放 `mxc://`（`m.file`/`m.image`）；**不要塞进事件体**。[规范](https://spec.matrix.org/latest/client-server-api/#content-repository)
- [ ] 若必须内联，硬上限按 64 KiB 事件总量倒推（含 E2EE 膨胀）。[规范](https://spec.matrix.org/latest/client-server-api/#size-limits)

### 8.8 访问控制

- [ ] DM allowlist（`@user:server` 精确匹配）+ 群/房间 allowlist（room id/alias）；默认拒绝。[官方](https://docs.openclaw.ai/channels/matrix)
- [ ] invite 策略默认 off（`autoJoin: "off"`），只接受白名单邀请。[官方](https://docs.openclaw.ai/channels/matrix)
- [ ] 不按显示名匹配（`dangerouslyAllowNameMatching` 默认 false）。[官方](https://docs.openclaw.ai/channels/matrix)
- [ ] 按房间/用户分 session（`dm.sessionScope` per-user vs per-room；`threadReplies` inbound/always）。[官方](https://docs.openclaw.ai/channels/matrix/threads-and-sessions)

### 8.9 E2EE（二选一，不要中间态）

- [ ] 不做 E2EE：只允许非加密房间；在房间里检查 `m.room.encryption` state，若是加密房间则拒绝/降级并提示。[推断]
- [ ] 做 E2EE：用 matrix-js-sdk（Node，openclaw 同款）或 matrix-rust-sdk；实现设备验证 + key backup + recovery key；不要自研 Olm/Megolm。[官方](https://docs.openclaw.ai/channels/matrix/encryption)、[GitHub](https://github.com/matrix-org/matrix-rust-sdk)

### 8.10 可观测性

- [ ] 记录：发送耗时、429 次数、chunk 数、edit 次数、`limited` 次数、重连次数、`since` 回退次数。[推断]
- [ ] 明确「消息未确认」状态（txnId 未拿到 200）→ 显示给用户，不要静默丢。[推断]

---

## 9. 参考链接（全部可点）

### 9.1 openclaw 官方文档

- 架构：https://docs.openclaw.ai/concepts/architecture
- 远程访问：https://docs.openclaw.ai/gateway/remote
- 频道总览：https://docs.openclaw.ai/channels
- 频道路由：https://docs.openclaw.ai/channels/channel-routing
- Matrix 主文档（配置全表）：https://docs.openclaw.ai/channels/matrix
- Matrix 消息行为（流式/语音/反应/重启恢复）：https://docs.openclaw.ai/channels/matrix/messaging
- Matrix 富消息与审批：https://docs.openclaw.ai/channels/matrix/rich-messages
- Matrix 加密与验证：https://docs.openclaw.ai/channels/matrix/encryption
- Matrix 线程与 session：https://docs.openclaw.ai/channels/matrix/threads-and-sessions
- Matrix 访问控制：https://docs.openclaw.ai/channels/matrix/access-control
- 流式与分块（概念）：https://docs.openclaw.ai/concepts/streaming
- Gateway 协议：https://docs.openclaw.ai/gateway/protocol
- 微信 channel（external plugin）：https://docs.openclaw.ai/channels/wechat

### 9.2 openclaw 源码（关键文件）

- 仓库：https://github.com/openclaw/openclaw
- Matrix 分块阈值：https://github.com/openclaw/openclaw/blob/main/extensions/matrix/src/matrix/format-profile.ts
- Matrix 分块实现：https://github.com/openclaw/openclaw/blob/main/extensions/matrix/src/matrix/send/chunking.ts
- Matrix 编辑内容：https://github.com/openclaw/openclaw/blob/main/extensions/matrix/src/matrix/send/edit-content.ts
- Matrix 入站去重：https://github.com/openclaw/openclaw/blob/main/extensions/matrix/src/matrix/monitor/inbound-dedupe-migration.ts
- Matrix 事件处理：https://github.com/openclaw/openclaw/blob/main/extensions/matrix/src/matrix/monitor/events.ts
- Matrix sync state：https://github.com/openclaw/openclaw/blob/main/extensions/matrix/src/matrix/sync-state.ts
- ack reaction：https://github.com/openclaw/openclaw/blob/main/src/channels/ack-reactions.ts
- Telegram chunk：https://github.com/openclaw/openclaw/blob/main/extensions/telegram/src/text-chunk-limit.ts
- QA 场景目录（含 restart-replay-dedupe）：https://github.com/openclaw/openclaw/tree/main/qa/scenarios/channels

### 9.3 Matrix 规范

- Client-Server API（v1.19）：https://spec.matrix.org/latest/client-server-api/
- Syncing（since/timeout/长轮询）：https://spec.matrix.org/latest/client-server-api/#syncing
- txnId 幂等：https://spec.matrix.org/latest/client-server-api/#transaction-identifiers
- 限流：https://spec.matrix.org/latest/client-server-api/#rate-limiting
- 事件大小上限：https://spec.matrix.org/latest/client-server-api/#size-limits
- 编辑事件（m.replace）：https://spec.matrix.org/latest/client-server-api/#event-replacements
- 反应/注解：https://spec.matrix.org/latest/client-server-api/#event-annotations-and-reactions
- 线程：https://spec.matrix.org/latest/client-server-api/#threading
- 关系模型（m.relates_to）：https://spec.matrix.org/latest/client-server-api/#forming-relationships-between-events
- 端到端加密：https://spec.matrix.org/latest/client-server-api/#end-to-end-encryption
- Olm：https://spec.matrix.org/latest/olm-megolm/olm/
- Megolm：https://spec.matrix.org/latest/olm-megolm/megolm/
- 服务端密钥备份：https://spec.matrix.org/latest/client-server-api/#server-side-key-backups

### 9.4 MSC 与实现

- MSC4186（Simplified Sliding Sync）：https://github.com/matrix-org/matrix-spec-proposals/pull/4186
- MSC3575（Sliding Sync / Sync v3，obsolete）：https://github.com/matrix-org/matrix-spec-proposals/pull/3575
- matrix-rust-sdk：https://github.com/matrix-org/matrix-rust-sdk
- matrix-rust-sdk sliding sync 文档：https://docs.rs/matrix-sdk/latest/matrix_sdk/sliding_sync/index.html
- matrix-js-sdk：https://github.com/matrix-org/matrix-js-sdk
- vodozemac（Rust Olm/Megolm）：https://github.com/matrix-org/vodozemac
- pantalaimon（已 archived）：https://github.com/matrix-org/pantalaimon
- Synapse 配置文档（rc_message 等）：https://element-hq.github.io/synapse/latest/usage/configuration/config_documentation.html#rc_message
- Matrix 桥生态：https://matrix.org/ecosystem/bridges/

### 9.5 同类产品

- Happy 仓库：https://github.com/slopus/happy
- Happy 工作原理：https://happy.engineering/docs/how-it-works/
- Happy 安全模型：https://happy.engineering/docs/security/
- Happy 自托管：https://happy.engineering/docs/guides/self-hosting/
- Happy 实时同步与 RPC（Socket.IO）：https://github.com/slopus/happy/blob/main/docs/realtime-sync-and-rpc.md
- Happy 加密设计：https://github.com/slopus/happy/blob/main/docs/encryption.md
- Omnara 仓库：https://github.com/omnara-ai/omnara
- Omnara 自托管架构：https://docs.omnara.com/self-hosting/architecture
- VibeTunnel 仓库：https://github.com/amantus-ai/vibetunnel
- VibeTunnel 技术规格（WS v3/二进制帧）：https://docs.vibetunnel.sh/docs/spec
- claude-code-telegram：https://github.com/seedprod/claude-code-telegram
- Codex 仓库：https://github.com/openai/codex
- Codex app-server daemon（远程管理）：https://github.com/openai/codex/blob/main/codex-rs/app-server-daemon/README.md
- Codex app-server（JSON-RPC）：https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md

### 9.6 平台限制

- Telegram Bot API（4096 字符 / 30 msg·s⁻¹）：https://core.telegram.org/bots/api#sendmessage
- Discord message（2000 字符）：https://discord.com/developers/docs/resources/message

### 9.7 本仓库相关

- 低带宽通道实测与 bundle 称重：[`docs/dgx21-lowbandwidth-channel.md`](../dgx21-lowbandwidth-channel.md)
- Tunnel 访问：[`docs/dgx21-tun-access.md`](../dgx21-tun-access.md)
- 拓扑：[`docs/topology.md`](../topology.md)

---

## 10. 附录：本轮抓取方式（可复现）

```bash
# openclaw 文档（官方站支持 .md）
curl -sSL https://docs.openclaw.ai/channels/matrix.md
curl -sSL https://docs.openclaw.ai/channels/matrix/messaging.md
curl -sSL https://docs.openclaw.ai/concepts/streaming.md
curl -sSL https://docs.openclaw.ai/gateway/remote.md
curl -sSL https://docs.openclaw.ai/sitemap.xml            # 15 510 个 URL，用于定位页面

# openclaw 源码（按 tree API 定位后取 raw）
curl -sS "https://api.github.com/repos/openclaw/openclaw/git/trees/main?recursive=1"
curl -sSL https://raw.githubusercontent.com/openclaw/openclaw/main/extensions/matrix/src/matrix/format-profile.ts
curl -sSL https://raw.githubusercontent.com/openclaw/openclaw/main/src/channels/ack-reactions.ts

# Matrix 规范（v1.19 单页 HTML，grep 锚点/正文）
curl -sSL --compressed https://spec.matrix.org/latest/client-server-api/ -o spec_cs.html
pandoc -f html -t plain --wrap=none spec_cs.html -o spec_cs.txt
grep -n 'MUST NOT be larger than 65536' spec_cs.txt

# MSC 状态（GitHub API）
curl -sS https://api.github.com/repos/matrix-org/matrix-spec-proposals/pulls/4186

# Synapse 默认限流
curl -sSL https://element-hq.github.io/synapse/latest/usage/configuration/config_documentation.html
grep -A3 '^rc_message' <(pandoc -f html -t plain config_documentation.html)

# 同类产品
curl -sSL https://raw.githubusercontent.com/slopus/happy/main/docs/realtime-sync-and-rpc.md
curl -sSL https://docs.vibetunnel.sh/docs/spec
curl -sSL https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server-daemon/README.md
```

**已知抓取障碍**（供后续复现参考）：本机 DNS 对部分域名返回 `198.18.0.0/15` 的 fake-IP（如 `docs.openclaw.ai`），`web_fetch` 会拒绝，但 `curl` 正常；对 `docs.openclaw.ai` / `raw.githubusercontent.com` / `spec.matrix.org` 偶发 `SSL_ERROR_SYSCALL`，需 `--retry` 与串行重试。

---

## 11. 一页纸版（给设计文档引用）

> **事实**：openclaw 用「单 Gateway + 多 channel + 隧道远程」；IM 侧只有 block/preview 两种流式，Matrix 默认 chunk 4 000 字符，E2EE 默认关；Matrix 的 /sync（since+timeout）天然是增量长轮询，事件上限 64 KiB，txnId 保证重试幂等，Synapse 默认 0.2 条/秒；sliding sync 尚未进规范（MSC4186 merged 但 spec-pr-missing）。
>
> **算术**：一条 4 000 字符回复 ≈ 4.3 KB；dsh web 首屏 3.34 MB ≈ 821 条满长度回复。
>
> **建议**：hwb 应做「daemon 拥有 session + IM adapter 只传增量」；抄 spool-before-cursor、txnId、edit 流式 + 节流 + 超限降级、格式感知分块、ack reaction、默认拒绝白名单、thread-per-turn、审批三级降级。不要试图在 IM 上复刻 diff/A2UI/PTY；E2EE 要么用成熟 SDK，要么明确只做非加密房间。

---

*文档版本：v1（2026-10-23）。后续补充建议：mautrix 各桥的 E2EE 支持矩阵、Element X 的 sliding sync 实际部署状态、dsh 侧现有 `dsh-history-delta` 与 Matrix `/sync` 的字段级映射。*
