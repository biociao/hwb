# DSH 宿主侧扩展点：能否在 dsh 进程内跑一个 IM channel 插件

日期：2026-10-23
作者：teammate `dsh-host`（调研，不做架构拍板）
范围：只回答「在 **dsh 宿主进程内** 用 Cordis 插件做一个 IM channel」在技术上是否成立、走哪些扩展点、部署与安全代价是什么。不评价 Matrix 选型本身、不评价 IM 侧实现。

---

## 0. 结论

**判定：【有保留的可行】。**

「在 dsh 进程内跑一个 channel 插件」需要的三件事，在 0.2.x 里**都有公开的、进程内的、非浏览器入口**：

1. **注入一轮 prompt**：`ctx.agents.create()/resume()` 拿 `AgentHandle`，`handle.agent.followup({content, source})` 就是「提交一轮用户输入」；`steer()` 是「插话」，`inject()` 是「只加上下文不唤醒」。
2. **订阅流式输出与工具调用**：`ctx.on('session/event', (session, event) => …, { global: true })` 拿到**所有会话**的**每一个** durable 事件（含 `tool/call`、`tool/result`、`assistant/message`、`turn/*`）；`ctx.on('agent/assistant-stream', ({agent, frame}) => …, { global: true })` 拿到**token 级**的 `start/chunk/end` 帧。
3. **读写会话/附件**：`ctx.sessionController`（web profile 才有）提供 create/fork/prompt/page/follow/list/search/rename/attachment/updateQueue/cancel；`ctx.attachments` 负责图片/文件落盘与 prompt 准入；`ctx.sessions` 负责 live 会话与 durable 追加。

**保留意见（四条，按严重度排）：**

- **R1｜进程内插件的异步错误是「全局致命」的。** 任何脱离 `apply()` 返回 Promise 的 unhandled rejection、或任何同步回调（socket `'data'`、timer）抛出的异常，会让 **整个 dsh 进程** dispose 并 exit 1——不是只挂掉这个插件。官方故障矩阵明确把这两行标成 `Fatal`，且「regardless of entry id」。见 Q7 与 `dsh-app-boot/README.md:109-110`。IM 长连接 + 重连 + 解析外部 JSON 的插件，必须把所有异步路径包在 try/catch 里，**没有豁免机制**。
- **R2｜现有 hwb Host 半插件用的 `apiProxy` 在 0.2.x 里已经不存在。** `dsh-history-delta/lib/index.js:41` 的 `inject = ['connection', 'apiProxy']` 在 0.2.1 上会让该条目**永远等不到服务、静默不激活**。0.2.x 的对应物是 `ctx.sessionController`（**由 `dsh-web-app` bundle 挂载，base 里没有**）与 `session` Remote 命名空间。channel 插件若照抄旧范本会踩空。证据：§1.0。
- **R3｜Matrix 的 E2EE 不是零依赖。** 明文房间可以用 Node 内建 `fetch` 直接打 Matrix Client-Server API；但 Megolm/Olm 端到端加密需要 libolm/vodozemac（native 或 WASM）。这会把「单文件零依赖插件」变成「需要 pnpm install + 编译产物」，直接抬高 Q6 的落地面。宿主侧本身**不需要**额外包，代价全在 channel 插件自己。
- **R4｜channel 插件替代的是「交互面」，不是「web profile」。** 若仍跑 `--profile web`，3.34 MB 首屏与 `/api` 全部照旧；真正的收益要来自**不挂 web-app**（见 §0.1）。这条是架构选择，不是宿主侧限制——但宿主侧数据支持它。

**替代方案（如果目标是「非浏览器传输」而不是「IM」）：**

- **零下载、已装在远端**：`dsh-headless`（一次性任务，`--json` 事件流）、`dsh-sdk-jsonrpc-server`（stdio JSON-RPC：`session/prompt` 入、`session.event`/`session.status` 出）、`dsh-acp`（ACP over stdio）。三者都已在远端 `@deepseek-ai/dsh` 的依赖树里（Q4 证据），profile 只需一个 JSON 文件。
- **不是替代方案**：`dsh-mcp-client` 是 dsh 作为 MCP **客户端**去连别人的 server，方向反了，不能用来从外部驱动 dsh；`dsh-experimental-agent-team` 是**同一进程内**的 Lead/teammate 协作，不提供跨进程传输。

### 0.1 一个反直觉但关键的发现：channel 不需要 web-app

`@deepseek-ai/dsh-api-session-controller` 是 **`dsh-web-app` bundle 挂载的**（`dsh-web-app/cordis.patch.yml:122`），不在 base 里。而 channel 真正需要的三件事在 **base** 里就齐了：

| 能力 | 服务 | 挂载位置 |
|---|---|---|
| live agent 创建/驱动 | `ctx.agents` + `ctx.agent-loop` | `dsh-base/cordis.patch.yml:83`、`:511-512` |
| durable 会话日志 | `ctx.sessions` | `dsh-base/cordis.patch.yml:41` |
| 会话持久化（重启不丢） | `dsh-session-persistence-jsonl` | `dsh-base/cordis.patch.yml:139` |
| 附件落盘 | `ctx.attachments` | `dsh-base/cordis.patch.yml:147` |
| 模型/凭据 | `dsh-llm` + `dsh-credentials-local` | `dsh-base/cordis.patch.yml:34`、`:125` |

也就是说存在这样一条组合：**`dsh-base` + 你的 channel 插件（+ 一个 model adapter）**，完全不挂 `webserver`/`web-app`/`client-modules`，浏览器首屏载荷为 0。`dsh-headless` 就是「base + 一个 runner」的先例（`dsh-headless/cordis.patch.yml` 头注释明说 "mounts no Host, HTTP server, Web runtime, or browser plugin"）。

代价：没有 `ctx.sessionController`，所以 create/resume/prompt 要自己用 `ctx.agents` + `ctx.sessions` 写（约 30 行，见 §2 骨架），冷会话恢复要走 `sessionPersistence`。这是「有保留」里最值得 Lead 权衡的一条。

---

## 1. 七个问题的逐条回答

> **证据路径约定**
> - `ASAR = /Applications/DeepSeek Harness.app/Contents/Resources/app.asar`
> - `PKG  = $ASAR/dsh/node_modules/@deepseek-ai`（本地 App，**0.2.1-rc.2**）
> - 行号来自我把 asar 解包到 `/tmp/dsh-asar/x` 后的**逐字节相同副本**（`node ~/.npm/_npx/…/asar extract`）。可直接复核：`sed -n '1510p' /tmp/dsh-asar/x/dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js`。
> - 远端 `dgx21.tun` 的 dsh 是 **0.2.1-alpha.2**（`ssh dgx21.tun 'dsh --version'` → `0.2.1-alpha.2`），安装在 `~/.local/node-v22.23.2-linux-arm64/lib/node_modules/@deepseek-ai/dsh`。仓库旧文档里写的 `0.1.1-rc.2` **已过期**。
> - 远端行号来自 `ssh dgx21.tun 'grep -n …'`（只读），与本地 rc.2 的行号**不保证一致**，下文凡引用远端行号都单独标注。

### 1.0 先纠正一个前提：`apiProxy` 没了

```
$ grep -rn "apiProxy" /tmp/dsh-asar/x | wc -l
0
$ ssh dgx21.tun 'grep -rl apiProxy ~/.local/node-v22.23.2-linux-arm64/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai --include=*.js | head'
（空）
```

`apiProxy` 在 0.2.1-rc.2（本地）与 0.2.1-alpha.2（远端）里**都不存在**。取而代之：

- Host 侧服务：`ctx.sessionController` —— `dsh-api-session-controller/lib/index.js:2952`（`super(ctx, "sessionController", { namespace: "session" })`）
- Client 侧命名空间：`session` / `skills` / `fileReferences`（同上 README:9）

而 `connection` **仍然存在**，`rpc.handle` 也仍然存在（这一点容易误判，因为源码里它是对象属性而非 `.handle` 调用）：

- `dsh-client-connection/lib/index.js:710` `super(ctx, "connection")`
- `:724` `get rpc()`，`:727` `handle: (channel, handler) => this.register(owner, channel, handler)`
- 远端同文件：`:633` `super(ctx, "connection")`，`:644` `handle: (channel, handler) => this.register(...)`

**结论**：`dsh-history-delta` 的通道注册部分在 0.2.x 上依然可用，但 `inject` 里那个 `apiProxy` 会让整个条目一直处于「等待服务」状态。`dsh-static-cache`（只 inject `webServer`）不受影响。

---

### Q1｜插件能否注入一轮 prompt 到新会话 / 既有会话？

**能。两条等价路径，都是进程内公开 API。**

#### 路径 A（推荐，不需要 web-app）：`ctx.agents`

服务：`ctx.agents`（`dsh-agent/lib/index.js:332` `super(ctx, "agents")`）

| 方法 | 行号 | 作用 |
|---|---|---|
| `agents.create({sessionId, agentOptions, meta, setup})` | `dsh-agent/lib/index.js:453` | 建新 agent + session，返回 `AgentHandle` |
| `agents.resume({sessionId, …})` | `:466` | 从持久化恢复 agent |
| `agents.get(id)` | `:596` | 取 live `Agent`（不返回 handle） |

驱动的三个方法（`dsh-agent-loop/lib/index.js`，Agent 接口的实现）：

| 方法 | 行号 | 语义 |
|---|---|---|
| `followup(input)` | `:806` | 排队「下一轮」输入并唤醒 driver —— **这就是「提交一轮 prompt」** |
| `steer(input)` | `:809` | 排到 `next-step` 并唤醒 —— 插话 |
| `inject(input)` | `:812` | 排到 `next-step`、**不**唤醒 —— 只加模型可见上下文 |
| `send(message, target, wakeup)` | `:798` | 上面三个的公共实现：`inbox.splice(target, …)` |

签名（README 给的形态，`dsh-agent/README.md:45-60`）：

```js
handle.agent.followup({
  content: [{ type: 'text', text: 'Summarize this workspace.' }],
  source: { kind: 'user' },          // 或 { kind: 'my-plugin' }
})
handle.agent.steer({ content: [...], source: { kind: 'my-plugin' } })
await handle.agent.whenIdle()
```

**注意**：`followup/steer/inject` 收的是**一个 `Message` 对象**（`content` + `source`），不是裸字符串。文本就是 `content:[{type:'text',text}]`。

#### 路径 B（web profile 才有）：`ctx.sessionController.prompt`

- 服务：`dsh-api-session-controller/lib/index.js:2952`
- Remote 方法：`async prompt(request, signal)` —— `:3218`
- 实际执行：`commands.prompt(request, source)` —— `:925`；内部 `:950-951` 就是 `agent.steer(message)` / `agent.followup(message)`
- 前置：`resolveAgent(sessionId)` —— `:1068`，会 resume 冷会话；写锁冲突报 `session/writer-held`
- 入参形态（从实现反推，`:3218-3235` + `:925-955`）：
  `{ sessionId, content: Part[], mode?: 'steer', requestId?, clientTimeZone? }`
  `content` 至少含非空文本或附件（`:3221` `hasPromptContent`），否则 `gateway/bad-request`
- 建新会话：`async create(request)` —— `:755`，request 为 `{ sessionId?, cwd?, workspaceId?, agentPreset? }`（`:755-800`）；内部 `:511-522` 调 `ctx.agents.create({sessionId, agentOptions, meta:{cwd, agentPreset}, setup})`，`agentOptions` 来自 `ctx.agentDefaultModel.currentSelection()`（`:526-532`）

**对 channel 的含义**：一条 IM 消息 → 一个 sessionId 的映射由插件自己维护；首次消息走 `agents.create`（或 `sessionController.create`），后续走 `followup`。**并发/串行由 inbox 保证**：`followup` 只是 splice 进 durable inbox，driver 在 step 边界 claim，不会重入。

---

### Q2｜插件能否订阅流式输出与工具调用事件（delta / tool_use / tool_result 级）？

**能，而且有三档粒度。**

#### 档 1：durable 事件流（推荐给 IM —— 重连友好）

```js
ctx.on('session/event', (session, event) => { … }, { global: true })
```

- 官方自己就是这么用的：`dsh-api-session-controller/lib/index.js:1529`（`follow` 内部）、`:2997`（availability 投影）
- `{ global: true }` 是必须的：不加只收本 fiber 作用域内的事件
- payload：`(session, event)`；`event = { type, seq, time, data, surfaceOp?, sourceEventSeqs? }`

事件全集是生成物：`dsh-session/lib/index.js:85-146` 的 `KNOWN_SESSION_EVENT_TYPES`（共 ~60 个）。与 IM 展示直接相关的：

| 事件 | 何时 | `data` 形状（出处） |
|---|---|---|
| `turn/start` / `turn/end` | 一轮开始/结束 | `{turn}` / `{turn, reason}` |
| `step/start` / `step/end` | 一次模型请求 | `{turn, step}` |
| `assistant/message` | 一次 assistant 输出**落盘** | `{turn, step, message, stream, usage?, interrupted?}` —— `dsh-agent-loop/lib/index.js:1156-1170`；`stream` 是**紧凑的 token 流**（不是逐帧） |
| `tool/call` | 模型要调工具 | `{turn, step, callId, name, arguments}` —— `dsh-agent-loop/lib/index.js:682` |
| `tool/result` | 工具返回 | `{turn, step, message, error?, meta?}` —— `:693`；`message.content` / `isError` / `toolCallId` |
| `request/header` | 请求信封（**很大**） | `{header:{config, tools?, adapterDefaults?}, reason}` —— `:1214-1220` |
| `user/message` | 用户输入落盘 | `{message, …}` |
| `agent/inbox/*` | 队列增删 | `agent/inbox/spliced {target,start,inserted/removedCount}` |

`assistant/message` 与 `assistant/attempt` 的 `stream` 是「紧凑流」，要展开得用 `assistantStreamChunks()/expandAssistantStream()`（`dsh-llm` 导出，见 `dsh-llm/lib/index.js:1423`、`:2429` 的 export 列表）。IM 只需要最终文本时，直接读 `event.data.message.content` 即可。

#### 档 2：token 级流式帧（要「打字机」效果时用）

```js
ctx.on('agent/assistant-stream', ({ agent, frame }) => { … }, { global: true })
```

- 发射点：`dsh-agent-loop/lib/index.js:1080` `this.dispatch.emit("agent/assistant-stream", { frame })`
- 官方消费点：`dsh-api-session-controller/lib/index.js:1453`、`:1546`（都带 `{global:true}`）
- `frame` 三态（`dsh-agent-loop/lib/index.js:352` 起的 `lib/types/assistant-stream.js` 区段）：
  - `{ type:'start', attemptId, revision, turn, step }`（`:386`）
  - `{ type:'chunk', attemptId, revision, index, time, chunk }`（`:396`）—— `index` 从 0 密集递增
  - `{ type:'end', attemptId, revision, index, outcome:{kind:'committed', eventType, seq} | {kind:'abandoned'} }`（`:416`）
- `chunk` 是 LLM 原始 chunk，种类见 `dsh-llm/lib/index.js:966-984`：`block-start`、`text-delta`、`reasoning-delta`、`tool-call`、`usage`、`finish`（终止必有一个）。判定可见文本用 `chunkHasVisibleText()`。
- **进程内事件，不重放**：README 明确 `agent/assistant-stream` 是 "process-local Assistant attempt's ordered start, transient chunk, and end frames"（`dsh-agent/README.md:65-67`）。掉线期间的帧不会补，durable 兜底仍是 `assistant/message`。

#### 档 3：把 follow 当异步迭代器用（在进程内也能调）

`sessionController.follow(request, signal)` 是 `@Remote({mode:'stream'})` 的方法，但**它就是个 async generator**：

- 定义：`dsh-api-session-controller/lib/index.js:1510` `async *follow(request, signal)`
- Remote 包装：`:3272` `follow(request, signal) { return this.history.follow(request, signal) }`
- 产出：先一个 opening snapshot（`{type, header, cursor, records, hasMore, projections}`），然后 `{type:'event', event}` 与（`assistantStream:true` 时）`{type:'assistant-stream', frame, ordinal}`
- 内部就是 `ctx.on('session/event', …, {global:true})` + 缓冲 + `signal` 取消（`:1529`）

对 IM 的建议：**档 1 为主 + 档 2 只做「正在输入」提示**。理由：档 1 自带 `seq`，断线重连可以按 `seq` 续；档 2 的帧没有持久游标。

---

### Q3｜会话/附件读写入口（`apiProxy.sessions.*` 在 0.2.x 叫什么）

0.1.x 的 `apiProxy.sessions.*` 在 0.2.x 拆成两层：**Host 服务 `ctx.sessionController`** + **Client 命名空间 `session`**。

`ctx.sessionController` 的完整 Remote 方法表（装饰器处：`dsh-api-session-controller/lib/index.js:2676-2700`）：

| 端点 | 实现行 | 说明 |
|---|---|---|
| `list` | `:3061`（核心 `:1959`） | 列会话；**每行带 `projections.values`**（见 Q5） |
| `search` | `:3075`（核心 `:2010`） | 全文搜索 |
| `create` | `:755` | 新建/复用空白会话 |
| `fork` | `:849` | 从某 seq 复制前缀 |
| `rename` | 装饰器 `:2685` | 改标题 |
| `prompt` | `:3218` | 提交一轮 |
| `cancel` | 装饰器 `:2690` | 中止当前 turn |
| `updateQueue` | 装饰器 `:2690` | 改 pending inbox |
| `page` | 装饰器 `:2691`（`Remote({name:'page', resources:{session}})`） | 冷安全的历史分页 |
| `follow` | `:1510` | 流：快照 + 增量 |
| `projections` | 装饰器 `:2699` | 读投影 |
| `control` | 装饰器 `:2700`（stream） | 投影/状态流 |
| `attachment` | 装饰器 `:2688` | 读一张图（鉴权靠会话日志引用） |
| `selectModel` / `modelCatalog` / `openWorkspacePath` / `workspacePathApplications` / `initializeDefaultModel` | 装饰器 `:2677-2684` | 模型与本地打开 |

另有独立服务：

- `ctx.sessions`（`dsh-session/lib/index.js:1739`）：`create/get/list/fork`，`session.append(type,data,opts)`，`session.seq`（长度，O(1)），`session.deriveMessages()`
- `ctx.attachments`（`dsh-attachment/lib/index.js:207` `super(ctx,"attachments")`）：
  - `saveImages(inputs)` `:228`、`admitPromptContent(content)` `:242`（prompt 准入，把 image part 换成 durable ref）
  - `saveFile` `:299`、`saveFileStream` `:309`、`fileHostPath(ref)` `:330`、`readImageRequest` `:338`
  - 语义（README）：图片规范化后存；其它文件按字节存，模型只拿到一行「只读路径」
- 冷会话读：`ctx.sessionPersistence`（`stat/read`），`sessionController` 的 fork/attachment 里用它（如 `:3206` 附近）

**对 channel 的含义**：IM 发图 → `ctx.attachments.saveImages()` 拿 ref → 把 `{type:'image', attachment: ref}` 放进 `followup` 的 content；IM 发文件 → `saveFile`，content 里放 `{type:'file', attachment}`（模型看到路径）。**不要**自己 base64 塞进文本。

---

### Q4｜现有非浏览器传输：headless / sdk-jsonrpc / agent-team / MCP / ACP

先给结论表（「已装」= 远端 `@deepseek-ai/dsh` 依赖树里已有，无需下载）：

| 方案 | 形态 | 入 | 出 | 远端已装 | 零下载可用 |
|---|---|---|---|---|---|
| `dsh-headless` | 一次性 CLI 任务 | 位置参数/stdin | stdout 最终答案；`--json` 事件流 | ✅ `dsh-headless` | ✅（dgx21 已部署 `~/.dsh/profiles/headless`） |
| `dsh-sdk-jsonrpc-server` | stdio JSON-RPC 2.0（NDJSON） | `session/prompt` | `session.event`（全量 durable）、`session.status` | ✅ `dsh-sdk-jsonrpc-server` / `-protocol` / `dsh-sdk-app` | ✅（只需一个 profile JSON） |
| `dsh-acp` | ACP over stdio JSON-RPC | ACP session/prompt | ACP 语义更新 | ✅ `dsh-acp` / `dsh-acp-app` | ✅ |
| `dsh-experimental-agent-team` | **同进程** Lead/teammate + 共享任务板 | 进程内 `send_message` | 进程内 inbox | ✅ | ✅ 但**不是跨进程传输** |
| `dsh-mcp-client` | dsh 作为 MCP **客户端** | — | — | ✅ | ❌ 方向反了 |
| Matrix channel 插件（本方案） | 进程内插件 + 出站 HTTPS 长连接 | IM 消息 | IM 消息 | —（自己写） | 宿主侧 ✅ / 加密库 ❌ |

**关键证据：**

- headless：`dsh-headless/README.md:12`（"no GUI, no server, no browser"）；`dsh-headless/cordis.patch.yml` 头注释 "mounts no Host, HTTP server, Web runtime, or browser plugin"
- sdk 协议方法表：`dsh-sdk-protocol/README.md:38-49`（7 个 client→server：`initialize`/`session/prompt`/`session/resume`/`session/wait`/`session/working-directory/get|set`/`shutdown`；4 个 server→client 通知，含 `session.event`、`session.status`）
- sdk 服务行为：`dsh-sdk-jsonrpc-server/README.md:52`（"streams every durable fact as `session.event` … immediately returns `{messageId}`"）
- ACP：`dsh-acp/README.md:12`（"Automation-only ACP … over JSON-RPC stdio"）
- agent-team：`dsh-experimental-agent-team/README.md:12`（"one session a Lead, named teammates … durable shared task board"）—— 同进程，不解决跨机
- MCP：`dsh-mcp-client/README.md:12`（"lets the model use tools and resources from external MCP servers"）—— 客户端方向

**远端安装核实**（只读 `ls`）：

```
$ ssh dgx21.tun 'ls .../dsh/node_modules/@deepseek-ai | grep -E "sdk|headless|acp|mcp|team"'
dsh-acp  dsh-acp-app  dsh-experimental-agent-team  dsh-experimental-agent-team-profile
dsh-experimental-tool-agent-team  dsh-headless  dsh-mcp-client  dsh-mcp-resources
dsh-sdk-app  dsh-sdk-jsonrpc-server  dsh-sdk-minimal  dsh-sdk-protocol
```

→ **「非浏览器传输」这条路已经是零下载现成的**；channel 插件要论证的是「比 sdk/headless 多带来什么」（双向、多用户、离线可达），而不是「能不能不装东西」。

---

### Q5｜3.34 MB 首屏 / `session.list` 129 KB / `session.history` 8–10 MiB 的出处

#### (a) 首屏 3.34 MB 的构成

机制（代码出处）：

1. **boot graph**：`dsh-client-modules` 扫描**已启用的 Loader 条目**里声明了 `dsh.client` 的包，合成启动图 —— `dsh-client-modules/README.md:12`（"the host half scans enabled Loader entries and composes the boot graph, an available Web carrier serves each bundle over `/plugins`"）
2. **每个插件一个 bundle URL**：`/plugins/<entryId>/client.js` —— `dsh-client-modules/lib/index.js:937`（`const prefix = \`/plugins/${record.entry.id}/\``）；批量合并用 combo URL `:205` `comboSearch()`、`:208` `comboUrl()`
3. **root 文档**：`webServer` 的 index injection 表 —— `dsh-host-webserver/README.md:67`（`collectIndexInjections()` 每次 emit 一次 `webserver/index-inject`，`renderIndex(html)` 把行渲染进 body）；代码 `dsh-host-webserver/lib/index.js:517-534`（`collectIndexInjections()` / `:524` `ctx.emit("webserver/index-inject", table)` / `:534` `renderIndexInjections(...)`）
4. **SPA dist**：`dsh-host-frontend-static` 占住 fallback 席位，负责 `index.html` + `assets/*`

数量与字节（**测量值，不是估算**，出处是本仓库自己的量具）：

- `docs/dgx21-lowbandwidth-channel.md:40-42`：

  ```
  46 个唯一的 /plugins/…/client.js   raw = 3 485 976 B (3.32 MB)
  root 文档                              =    15 214 B
  首屏（UI 可用前必须先到齐）             = 3 501 190 B (3.34 MB)
  ```
- 量法：`scripts/soak/bundle-weight.mjs` —— 在远端 loopback 上 `curl /` → 用 `grep -oE '/plugins/[^"'"'"' ]+'` 取唯一 URL → 逐个 `curl | wc -c`；顺带用 `gzip -9` 测压缩上限（813 796 B，4.28×）。
- **为什么「必须全到齐」**：模块系统在 boot 时注册所有 factory；任一 combo `<script>` 失败会触发重试与「单资源 combo」回退，但整页 boot 审计会把缺失行标错，UI 直接报 `Failed to load plugins`（`dsh-client-modules/README.md:38` 的失败/重试语义 + 仓库实测）。

**未验证项**：我**没有**在远端重新跑一遍这个测量（远端只允许只读，量具会写 `/tmp`）。数字引用自仓库 2026-09-14 的实测记录；远端 dsh 已从 0.1.1-rc.2 升到 0.2.1-alpha.2，插件数可能变化（web profile 现含 `dsh-passwords`、`dsh-science`、`dsh-drop-any-file`）。**若要写进对外文档，请让有写权限的人重跑 `node scripts/soak/bundle-weight.mjs --host dgx21.tun`。**

#### (b) `session.list` 129 KB 的出处

不是「会话多」这么简单：**每一行都带一整块 projection 快照**。

- 行构造：`ApiSessionList.summaryFor()` —— `dsh-api-session-controller/lib/index.js:1940-1952`
  ```js
  return {
    sessionId, updatedAt, agentAvailable, formatStatus, running, blank,
    ...listFields(session.header),
    ...(projections === undefined ? {} : { projections }),
  }
  ```
- `projections.values` 的字段（生成 schema 在 `dsh-api-session-controller/lib/typert.host.js`，单行 JSON Schema，可用 `grep -o '"inbox":{"type":"object"' …` 定位）：`inbox`（next-turn/next-step **全文**）、`workingDirectory`、`agentPreset`、`title`、`todos`、`sessionListMetadata`、`imageLimits`、`modelSelection`、`permissions`、`subagentCatalog`、`subagentTiming`、`subagent`、`tokenUsage`、`contextPressure`、`contextBreakdown`、`agentTeam`（含**整块 task board**）、`userQuestions`（含完整问题与选项）、`goal`、`plan`
- 所以 129 KB ≈ `Σ(每个会话的 inbox 待办 + todos + team 任务板 + userQuestions)`。会话越多、待办/问题越多，线性增长。
- 设计上它是**故意的**：`list` 的语义是「冷安全 + 不激活 agent」（README:13 "List reads only stored headers and projection-cache rows"），换来的是一次调用就把侧边栏所有状态补齐。

**对 channel 的含义**：**不要**用 `list` 当「会话列表」用。要列会话就用 `ctx.sessions.list()`（live）或直接读持久化目录；要展示状态就自己挑 projection 键。

#### (c) `session.history` 8–10 MiB 的出处（已用本地数据复现机制）

两个叠加的原因：

1. **分页只按「消息条数」计数，却切片返回中间所有事件。**
   `paginate(events, beforeSeq, maxMessages, throughSeq, turnWindow)` —— `dsh-api-session-controller/lib/index.js:1717`：
   ```js
   for (let index = end - 1; index >= 0; index--) {
     const event = events[index]
     if (!MESSAGE_TYPES$1.has(event.type) || !isAppendSurfaceEvent(event)) continue   // 只数 user/message、assistant/message
     count++
     …
     if (count >= maxMessages) { cut = groupStart; break }
   }
   return { events: events.slice(cut, end), hasMore: cut > 0 }   // ← 中间所有 tool/*、step/*、request/header 全带上
   ```
   `DEFAULT_MAX_MESSAGES = 50` —— `:1438`。`pageRecords()` 只是 `events.map(entryFor)`，`entryFor` 把**整个 event** 原样返回（`:1759`、`:1744-1749`）。
2. **单个事件本身就很大。** 两个大户：
   - `assistant/message` 内嵌**紧凑 token 流**：`dsh-agent-loop/lib/index.js:1156-1170`（`stream: live.stream`）
   - `request/header` 内嵌**完整 tool JSON schema**：`dsh-agent-loop/lib/index.js:1214-1220`（`canonicalHeader({config, adapterDefaults, tools})`），`tools` 就是每个工具的完整 schema

**实测（本地 `~/.dsh/sessions`，只读，用 zstd -dc 流式统计）**：

```
# v4 当前格式，13.25 MiB 解压后
$ node /tmp/sess-analyze.mjs ~/.dsh/sessions/--Volumes-repo-ciao-FAHZU-PMAID--/session-1b215296-…/session.v4.jsonl.zstd
events=3830 totalBytes=13888766 (13.25 MiB)
--- top event types by bytes
assistant/message  9701482  69.9%  avg=20339
tool/result        1412436  10.2%  avg=2894
tool/call           834809   6.0%  avg=1757
job/settled         625538   4.5%
request/header      365751   2.6%  avg=91438     ← 单个 91 KB
--- paginate(maxMessages=50) tail window: events=330 bytes=701469 (0.67 MiB)
    win assistant/message 77.4% / tool/result 5.0% / tool/call 4.1%

# 一个更老的 v0 会话（46.08 MiB 解压后）
events=68094 totalBytes=48320223
request/header 5145986 10.6% avg=151353        ← 34 个 header 就 5.1 MB
--- paginate(maxMessages=50) tail window: events=1315 bytes=909417 (0.87 MiB)
```

- `assistant/message` 平均 **20 KB**、`request/header` 平均 **91–151 KB** —— 这就是「50 条消息」能膨胀到 MiB 级的原因。
- 仓库记录里远端那个会话是 **42 088 条事件 / 8.33 MiB**（`dsh-history-delta/lib/index.js:8`、`docs/dgx21-lowbandwidth-channel.md` §1），比本地样本更密，量级一致。
- **注意**：`assistant/message` 的 20 KB 不是「消息正文 20 KB」，而是**内嵌的 token 流**（每个 token 的 delta + 时间戳）。IM 只需要 `data.message.content`，可以只取这几百字节。

**对 channel 的含义**：channel 插件**天然绕开**这两个大包 —— 它订阅的是增量事件（每帧几百字节），而不是整窗重传。这正是这条路在带宽上成立的根本原因。

---

### Q6｜部署约束：`dsh plugin --profile X add link:<dir>` 是否需要联网？最小落地面几个文件？

#### `dsh plugin add` 的真实行为

- CLI 实现：`dsh/lib/plugin-BiveYA7h.js:63-99`（`runPlugin`）→ `runPluginCommand()`（`dsh-plugin-manager/lib/types/operations.js:591`）→ `runProfilePnpm()`（同文件 `:525`）→ 直接 `execa('pnpm', args)`。`:94` 的报错文案就是 "pnpm was not found"。
- **没有 `--offline` / `--prefer-offline`**：`grep -o "\-\-offline\|--prefer-offline" dsh-plugin-manager/lib/index.js` → 0 命中。出现的 pnpm flag 只有 `--config.fetch-retries`、`--config.registry`、`--frozen-lockfile`、`--config.lockfile`。
- 版本兼容检查**不联网**：`dsh-plugin-manager/README.md` 明说「a local path is read from its own `package.json`」，`link:`/绝对路径走本地读取；只有 registry spec 才 `pnpm view`。

**判定**：
- 「`link:` 这个 spec 本身」不需要 registry；
- 但 `pnpm add` 会**跑一次完整 install**（解析 lockfile、对齐整棵依赖图、校验 store）。锁文件齐全 + `node_modules` 已存在时通常不联网；**不能承诺零联网**，尤其当 profile 里还有 `github:` 依赖（远端 web profile 就有 `dsh-drop-any-file: github:Zenjibad/dsh-drop-any-file`）。
- 所以：**能用，但不是「零下载」的证明点**。

#### 严格零联网的最小落地面（推荐）

绕过 pnpm，直接写 patch 行 + 绝对路径。机制已确认：

- 插入行的 `name` **可以是绝对路径 / file URL**，patch 加载时转成 file URL：
  `dsh-app-boot/lib/index.js:3974`
  ```js
  if (typeof entry.name === 'string' && (isAbsolute(entry.name) || entry.name.startsWith('./') || entry.name.startsWith('../')))
    entry.name = pathToFileURL(resolve(base, entry.name)).href
  ```
- 兼容性准入对绝对路径会**向上找最近的 `package.json`**，找不到就**不做约束**（把 import 失败留给 Loader）：
  `dsh-app-boot/lib/index.js:2263-2295`（`manifestOf`：`while (true) try { return readManifest(join(dir,'package.json')) } catch …`）
  准入规则见 `dsh-app-boot/README.md:52`（`engines.dsh` 优先；两者都没有 = 无约束）

**最小落地面 = 2 个文件（改 1 个已有文件 + 加 1 个新文件）：**

```
~/.dsh/profiles/web/cordis.patch.yml      # 追加一个 insert 行（已有文件，追加 ~5 行）
~/dsh-im-channel.mjs                      # 插件本体（单文件 ESM，零 npm 依赖）
```

patch 片段：

```yaml
- insert:
    - id: dsh-im-channel
      name: /home/bot/dsh-im-channel.mjs     # 绝对路径，无需 package.json
      config:
        homeserver: https://matrix.example.org
```

要点：
- 用 **`.mjs`**：文件不在任何 `package.json` 的 `"type":"module"` 作用域下时，`.js` 会被当 CJS，`import` 语法直接失败。
- 插件内部**不要** `import '@deepseek-ai/*'`：解析基准是文件 URL，裸包名不一定可解析。只用 `node:` 内建 + `ctx` 上的服务。
- 若要 `dsh plugin` 管理/可卸载，再升级成「目录 + package.json + `link:`」，落地面 3 个文件 + 一次 pnpm。
- HMR：web profile 的模板是 live reload（`dsh-app-boot/README.md:50`），改 patch 会热重载；其它 profile 是 `patchReload: startup`，要重启。

**风险**：绝对路径行不在 `dsh plugin` 的管理面里（`listBundles` 看不到），升级/迁移时容易变成孤儿。生产上建议最终还是 `link:`。

---

### Q7｜生命周期与安全

#### (a) 插件异常会不会拖垮 dsh？—— **分两类，第二类是致命的**

官方故障矩阵：`dsh-app-boot/README.md:100-112`（表）。与本问题直接相关的四行：

| 失败形态 | 启动时（非必需条目） | 运行中 HMR |
|---|---|---|
| 同步 `apply()` 抛 | Warn，继续 | 报错，保留其它兄弟 |
| 异步 `apply()` 抛 | settlement 后 Warn，继续 | 报错，保留其它兄弟 |
| **脱离 `apply()` 的 unhandled rejection** | **Fatal：dispose 整个 app，exit 非零** | **Fatal，regardless of entry id** |
| **同步回调（socket `'data'`、timer）抛 uncaught exception** | **Fatal：dispose 整个 app，exit 非零；失败操作不恢复** | 同左 |

实现：`installFailLoud()` —— `dsh-app-boot/lib/index.js:4216-4258`（挂 `unhandledRejection` / `uncaughtException` → 写诊断 → `proc.exit(1)`）。必需条目集合 `requiredStartupEntryIds` 在 `:4270`（`agent-loop`/`webserver`/`web-runtime`/`modules`/`connection`/`headless-runner`/`acp`/`sdk-jsonrpc-server`）——**channel 插件不在其中，所以它启动失败只是 warn；但运行期异步崩溃一样致命。**

**工程含义（必须写进实现规范）**：
- 所有 socket/长连接回调体包 `try/catch`；`process.on('unhandledRejection')` 之类**不要**自己挂（会抢 fail-loud 的语义，且不该由插件接管全局）。
- 用 `ctx.effect()` 注册清理（`dsh-static-cache/lib/index.js:204-211` 是范例），保证 dispose 时停掉同步循环。
- 重连循环用 `await sleep()` 而不是 `setInterval` 裸回调（timer 回调抛 = fatal）。

#### (b) 多会话并发

- 一个 sessionId 一个 live `Agent`（`AgentRegistry`）；`agents.get(id)` 是 O(1)。
- `followup/steer/inject` 只是往 durable inbox splice，**不会重入 driver**；driver 在 step 边界 claim。
- 同一个会话**写锁**：冷恢复时若已有 writer，`sessionController` 报 `session/writer-held`（`dsh-api-session-controller/lib/index.js:1068` 的 `resolve()` 分支）。
- 多会话并发 = 多个 agent 各自跑，互不影响；**但同一 profile 内的工具调用共享进程资源**（shell、jobs）。
- channel 插件要做的是：**IM 房间 ↔ sessionId 的持久映射**（建议存在自己的 storage 或 `ctx.storage`），并给每个 session 独立的出站队列（避免一个大会话把 IM 侧限速拖死）。

#### (c) 插件有没有 shell 权限？—— **有，而且是最高的那一档**

- Host 插件**在 dsh 进程内、以 dsh 的运行用户身份执行**，不受工作区沙箱约束：`dsh-plugin-manager/README.md:31` —— "installed Host code executes in-process outside the workspace sandbox"。
- dsh 自身的 bash 工具（`dsh-bash-local` / `dsh-tool-bash`）本来就能跑任意命令；插件要 shell 甚至不需要工具，直接 `node:child_process` 即可。
- 对比：`plugin_manager` 工具的沙箱检查（`danger-full-access`/approval）管的是**模型**，不是插件代码。**安装一个 Host 插件 ≈ 给这个用户加了一个后门。**
- 因此：channel 插件必须把「IM 侧谁能触发 prompt」做成显式白名单（roomId/userId），否则任何能给 bot 发消息的人就等于能在这台机器上跑 agent（进而跑 shell）。**这不是 dsh 的缺陷，是 Host 插件的固有权限模型。**

#### (d) dsh 重启

- base 挂 `dsh-session-persistence-jsonl`（`dsh-base/cordis.patch.yml:139`），会话 durable；重启后 `agents.resume()` / `sessionController` 的 `resolve()` 会恢复。
- channel 插件自己**不持久**：重启后要重新连 Matrix、重新建立 room→session 映射（映射要自己存盘）。恢复会话时**不要**重放历史消息到 IM（`follow` 的 opening snapshot 会带全窗，见 Q5c）。
- web profile 的 HMR 是 live reload：改 patch 会**重载插件**，`ctx.effect` 的清理必须幂等。

---

## 2. 最小 channel 插件骨架（伪代码）

> 目标：单文件、零 npm 依赖、在 **base-only profile**（无 web-app）里也能跑；若挂 web profile 则自动用 `sessionController` 的能力。
> 所有 `ctx.on(...)` 都必须 `{ global: true }`，否则收不到别的 fiber 的事件。

```js
// dsh-im-channel.mjs —— Host 半，单文件 ESM，只用 node: 内建
export const name = 'dsh-im-channel'
// 只硬依赖 base 里就有的服务；sessionController 是可选增强
export const inject = ['agents', 'sessions']

export function apply(ctx, config) {
  const agents = ctx.agents            // dsh-agent/lib/index.js:332
  const sessions = ctx.sessions        // dsh-session/lib/index.js:1739
  const log = ctx.logger ?? console

  // ── 0. 状态：roomId ↔ sessionId 的持久映射（自己存，重启后要能恢复）
  const roomToSession = new Map()      // 生产上换成 ctx.storage / 一个 JSON 文件
  const outbox = new Map()             // roomId -> 串行发送队列（防 IM 侧限速）

  // ── 1. 入站：IM 消息 → 一轮 prompt
  async function onImMessage(roomId, userId, text, parts = []) {
    if (!isAllowed(roomId, userId)) return          // ← 权限闸门，见 Q7(c)
    try {
      const sessionId = roomToSession.get(roomId) ?? await createSession(roomId)
      let agent = agents.get(sessionId)             // dsh-agent/lib/index.js:596
      if (agent === undefined) {
        // 冷会话：有 sessionController 用它（会 resume + 写锁检查），否则用 agents.resume
        const sc = ctx.get('sessionController')
        if (sc !== undefined) await sc.prompt({ sessionId, content: buildContent(text, parts), requestId: uuid() }, new AbortController().signal)
        else { agent = (await agents.resume({ sessionId, agentOptions: defaultModel() })).agent }
      }
      if (agent !== undefined && ctx.get('sessionController') === undefined) {
        // 路径 A：直接进 inbox。content 是 Message 对象，不是字符串
        agent.followup({ content: buildContent(text, parts), source: { kind: 'user' } })
        // 打断当前 turn 用 steer()；只想加背景信息不唤醒用 inject()
      }
    } catch (err) {
      log.warn(`[im] inbound failed room=${roomId}: ${String(err)}`)   // ← 绝不让它变成 unhandled rejection
    }
  }

  async function createSession(roomId) {
    const sessionId = `session-${crypto.randomUUID()}`
    // base-only：直接用 agents.create；web profile：sessionController.create 更完整（workspace/preset）
    const sc = ctx.get('sessionController')
    if (sc !== undefined) {
      const { sessionId: id } = await sc.create({ cwd: config.cwd, agentPreset: config.agentPreset })
      roomToSession.set(roomId, id); return id
    }
    await agents.create({
      sessionId,
      agentOptions: defaultModel(),                    // {provider, model}
      meta: { cwd: config.cwd },
    })
    roomToSession.set(roomId, sessionId)
    return sessionId
  }

  function buildContent(text, parts) {
    const content = []
    if (text) content.push({ type: 'text', text })
    // 附件：图片走 attachments.saveImages → {type:'image', attachment: ref}
    //       文件走 attachments.saveFile   → {type:'file',  attachment: ref}
    content.push(...parts)
    return content
  }

  // ── 2. 出站：durable 事件（推荐主通道；带 seq，可续传）
  ctx.on('session/event', (session, event) => {
    try {
      const roomId = roomOf(session.id)                 // 反查映射；没有就忽略
      if (roomId === undefined) return
      switch (event.type) {
        case 'assistant/message':
          // event.data.message.content → 最终文本；event.data.stream 是紧凑 token 流，别直接发
          enqueue(roomId, { kind: 'final', seq: event.seq, text: textOf(event.data.message) })
          break
        case 'tool/call':
          enqueue(roomId, { kind: 'tool_use', seq: event.seq, id: event.data.callId, name: event.data.name, args: event.data.arguments })
          break
        case 'tool/result':
          enqueue(roomId, { kind: 'tool_result', seq: event.seq, id: event.data.message.toolCallId, isError: event.data.message.isError, text: textOf(event.data.message) })
          break
        case 'turn/start':  enqueue(roomId, { kind: 'typing', on: true }); break
        case 'turn/end':    enqueue(roomId, { kind: 'typing', off: true, reason: event.data.reason }); break
        // 注意：request/header（平均 91–151 KB）与 assistant/message 的 stream 一律不要外发
      }
    } catch (err) { log.warn(`[im] outbound failed: ${String(err)}`) }
  }, { global: true })                                  // dsh-api-session-controller/lib/index.js:1529 同款

  // ── 3. 可选的 token 级「打字机」（进程内、不重放；只做 typing 提示，别当真相）
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    try {
      if (frame.type !== 'chunk') return
      const chunk = frame.chunk
      if (chunk.type !== 'text-delta') return          // dsh-llm/lib/index.js:976
      const roomId = roomOf(agent.session.id)
      if (roomId !== undefined) enqueue(roomId, { kind: 'delta', text: chunk.text, index: frame.index })
    } catch (err) { log.warn(`[im] stream failed: ${String(err)}`) }
  }, { global: true })                                  // dsh-api-session-controller/lib/index.js:1546 同款

  // ── 4. 生命周期：所有清理都进 ctx.effect，dispose 时自动跑（且必须幂等）
  ctx.effect(() => {
    const stop = startMatrixSync({                     // 出站 HTTPS 长连接（node:https / fetch）
      onMessage: (m) => { void onImMessage(m.roomId, m.userId, m.text, m.parts) },
    })
    return () => stop()
  }, 'dsh-im-channel: matrix sync')

  function enqueue(roomId, msg) { /* 串行队列 + 失败重试 + 背压；绝不能裸 promise 悬空 */ }
  function isAllowed(roomId, userId) { /* 白名单；默认拒绝 */ }
  function roomOf(sessionId) { /* 反查 */ }
  function defaultModel() { /* 从 config 或 ctx.agentDefaultModel.currentSelection() */ }
  function textOf(message) { return (message.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('') }
}
```

**骨架里刻意体现的四个「坑」：**

1. **`inject` 只列 base 就有的服务**（`agents`/`sessions`）；`sessionController` 用 `ctx.get()` 软取，否则在 base-only profile 里永远不激活（R2 的同类错误）。
2. **每个回调都 try/catch**（R1）。
3. **`{ global: true }`**，否则收不到事件。
4. **出站只用 `assistant/message`/`tool/*` 的摘要**，绝不转发 `request/header` 或 `stream`（Q5c）。

---

## 3. 不确定项 / 需要上游确认

按「会不会改变结论」排序：

1. **`agent/assistant-stream` 的 `chunk` 具体形状**我只读到 `dsh-llm` 的消费分支（`:966-984`）与 README 的 chunk 列表，**没有实机抓一帧**。若 channel 要依赖 token 级增量，需要先跑一个最小插件 `console.log(JSON.stringify(frame))` 确认字段名（`chunk.type` vs `chunk.kind`）。
2. **远端 0.2.1-alpha.2 与本地 0.2.1-rc.2 的 API 差异未逐项比对。** 已核对存在的：`ctx.connection.rpc.handle`（远端 `dsh-client-connection/lib/index.js:644`）、`sessionController`（远端 `dsh-schedule` 引用到）。**未核对**：`ctx.agents` 的 `followup/steer/inject` 是否同名同签名、`session/event` 的 payload 是否有字段变动。建议在远端 `grep -n "followup(" …/dsh-agent-loop/lib/index.js` 复核一次。
3. **`agents.resume()` 在 base-only profile 里的完整前置**（是否需要 `sessionPersistence` 的 stat/read 先做格式迁移）没验证。web profile 走 `sessionController.resolve()` 已经处理了 `migration-required`；base-only 自己写要处理 `dsh-session-format-v*` 迁移。
4. **Matrix E2EE 的库选型与体积**（libolm/vodozemac/wasm）未评估。这决定 R3 是「多一个 npm 依赖」还是「多一个 native 编译链」。
5. **`link:` 安装的联网行为没有实测**（远端禁止写、本机 `~/.dsh` 不在可写范围）。结论基于「pnpm 无 `--offline`」+「本地路径不查 registry」的代码阅读。要确证请在有写权限的环境里用 `strace`/代理日志跑一次 `dsh plugin --profile X add link:<dir>`。
6. **3.34 MB / 46 bundles 是 2026-09-14 的测量值**，远端已升级到 0.2.1-alpha.2 且 web profile 多了 3 个插件。**数字需要重测**（`scripts/soak/bundle-weight.mjs`）。
7. **`session.list` 129 KB 是仓库记录值**，我没有在 0.2.1 上重测；但「每行带整块 projections」的机制已从代码确认，量级可解释。
8. **`webServer` 的 index injection 在 base-only profile 里不存在**——如果 channel 想暴露一个健康检查 HTTP 端点，需要自己 `node:http` 或挂 `dsh-host-webserver`（那会引入 webserver 依赖，但**不会**引入前端 bundle）。
9. **多用户隔离**：dsh 的 `Peer`/`remoteAccess` 模型是为「浏览器 owner vs 非 owner」设计的（`dsh-client-connection/README.md:49`）；IM 侧多用户 → 多 peer 的映射能否复用 `remoteAccess`，未评估。最保守做法是 channel 自己做授权，全部以 owner 身份驱动 agent（= 所有 IM 用户共享一个权限域）。

---

## 4. 复现命令（只读，任何人可跑）

```sh
# 0) 解包已安装的 dsh（一次性；--yes 会联网装 @electron/asar，本机已有缓存）
ASAR="/Applications/DeepSeek Harness.app/Contents/Resources/app.asar"
node ~/.npm/_npx/*/node_modules/asar/bin/asar.js extract "$ASAR" /tmp/dsh-asar/x

# 1) 关键服务/方法是否还在（本地 rc.2）
P=/tmp/dsh-asar/x/dsh/node_modules/@deepseek-ai
grep -n 'super(ctx, "agents")'            $P/dsh-agent/lib/index.js
grep -n 'followup(input)\|steer(input)\|inject(input)' $P/dsh-agent-loop/lib/index.js
grep -n 'super(ctx, "sessionController"'  $P/dsh-api-session-controller/lib/index.js
grep -n 'async \*follow(request, signal)' $P/dsh-api-session-controller/lib/index.js
grep -n 'ctx.on("session/event"\|ctx.on("agent/assistant-stream"' $P/dsh-api-session-controller/lib/index.js
grep -rn 'apiProxy' /tmp/dsh-asar/x | wc -l          # 期望 0
grep -n 'handle: (channel, handler)'      $P/dsh-client-connection/lib/index.js

# 2) 远端版本与已装包（只读）
ssh dgx21.tun 'export PATH=$HOME/.local/node/bin:$PATH; dsh --version'
ssh dgx21.tun 'ls ~/.local/node-v22.23.2-linux-arm64/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai | grep -E "sdk|headless|acp|mcp|team"'

# 3) 历史窗口为什么大（本地只读）
cat > /tmp/sess-analyze.mjs <<'EOF'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
const f = process.argv[2]
const rl = createInterface({ input: spawn('zstd',['-dc',f],{stdio:['ignore','pipe','ignore']}).stdout, crlfDelay: Infinity })
const lens = []; let total = 0
for await (const line of rl) { if (!line) continue; total += Buffer.byteLength(line)+1
  let e; try { e = JSON.parse(line) } catch { continue }
  if (e.type !== 'session') lens.push([e.type, Buffer.byteLength(line)+1]) }
const M = new Set(['user/message','assistant/message']); let n = 0, cut = 0
for (let i = lens.length-1; i >= 0; i--) { if (!M.has(lens[i][0])) continue; if (++n >= 50) { cut = i; break } }
const w = lens.slice(cut).reduce((a,x)=>a+x[1],0)
console.log(`total=${total} window50=${w} (${(w/total*100).toFixed(1)}%)`)
EOF
node /tmp/sess-analyze.mjs "$(ls -S ~/.dsh/sessions/*/*/session.v4.jsonl.zstd | head -1)"
```

---

## 5. 一句话交接

宿主侧**不缺入口**：`ctx.agents`（prompt 注入）、`ctx.on('session/event'|'agent/assistant-stream')`（流式/工具事件）、`ctx.sessionController`/`ctx.sessions`/`ctx.attachments`（会话与附件）都在 0.2.x 的公开 API 里，且一个 **`.mjs` + 一行 patch** 就能挂上（零 npm、零 pnpm、零浏览器载荷——若挂 base-only profile）。
真正的风险不是「能不能」，而是 **R1（插件异步崩溃 = 整进程致命）** 与 **R2（旧范本的 `apiProxy` 已死）**；以及 **R3（Matrix E2EE 必然引入非零依赖）**。
