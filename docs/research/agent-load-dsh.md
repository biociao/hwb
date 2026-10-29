# dsh 侧：子智能体数 / 后台任务数的数据源、协议与 hwb 采集可行性

> 任务：共享任务板 `task-1`（teammate `dsh-protocol`）。范围：**只**回答 dsh（桌面版 **0.2.1-rc.3**）能否为 hwb 提供
> ①每会话**子智能体数**（总数 / 运行中）②每会话**后台任务数**（运行中 / 累计），采集走哪条协议、代价多大、哪些情况**不可得**。
> 产出边界：只写本文档；未改 `src/`、未改 `tests/`；未执行任何会改变 dsh 状态的命令（未 kill job、未发 prompt、未连任何实例）。
>
> 观测时刻：2026-10-28 13:40–14:05（Asia/Singapore）。全部结论来自**只读**读取桌面版 `app.asar` 里的已编译 JS 与随包 README。
> 行文约定：
> - **【源码】** = 归档条目里可直接复核的代码 / schema / JSDoc（含行号，见 §7 复现命令）；
> - **【推断】** = 由这些机制推出、但本次没有运行时观测的结论（本文**没有**真机抓包，原因见 §6）；
> - **【实测】** = 本次真的跑出来的数字（只用于字节估算，不含任何 dsh 运行时行为）。

---

## 0. 结论摘要（先看这里）

| 信号 | 能否拿到 | 数据源 | 代价 | 离线/只读实例 |
|---|---|---|---|---|
| 子智能体**总数** | **能，且 hwb 已有** | `session/list` 项的 `projections.values.subagentCatalog`（wire 是数组）、磁盘 projcache 同键 | 0（随现有 3s→30s 轮询） | **能**（projcache） |
| 子智能体**运行中** | **能，两条路都可行**（推荐 B） | A：`session/list` 项的 `running` + catalog id join；B：现有 `$events` 流上**已经在收**的 `api-session/status(sessionId, running)` emit 帧 | A：0 新增；B：0 新增订阅，~105 B/事件 | **不能**（无投影、无持久化） |
| 后台任务**运行中/累计** | **能，但只有一条路** | `/api/remote.mux` 上的 `job/list` 逻辑流（唯一的 roster；**无 unary、无投影、无转发事件**） | 每条 running 会话一次性 0.1–1.5 KB，之后**只在生命周期提交时**推整集；稳态 0 字节 | **不能**（registry 进程本地；只有会话日志里的历史 owner job 事件） |

**一句话**：dsh 这两类信号都在**已有可用通道**上：子智能体运行中甚至**不需要新订阅**（hwb 的 `$events` 观察器现在就收到 `api-session/status`，只是只用了 `running=false` 那一半）；后台任务则**必须**扩 `pending-interactions.js` 的 mux 客户端，从「一条 socket = 一条逻辑流」改成「一条 socket = N 条逻辑流」，然后在**只对 running 会话**开 `job/list` 流。

**三条最关键的结论/风险**（给 Lead）：

1. **`job/list` 的 open payload 是 `{args:{request:{sessionId}}}`，不是 `{args:{sessionId}}`**——参数 wire 名是 `request`（由 `parameter.wire ?? parameter.name` 机械推出）。写错只会在流上收到 `gateway/arguments-invalid` 一类的 error 帧，HTTP 层看不出来，排查会绕远路。
   > **对 Lead 简报的更正**：任务描述里写的 `{args:{sessionId}}` 与生成描述符不一致（`typert.host.js:108-111` 的参数 `name: 'request'`；`typert-protocol/lib/index.js:160` 的 `wire = parameter.wire ?? parameter.name`；客户端 `client.browser.js:1865-1877` 按 wire 名装 args）。
   > 本文按 `{args:{request:{sessionId}}}` 落笔，并把它列为 **【待验证】** 第 1 条（§6）：真机抓一帧即可定案——若对面回 `invalid Remote payload` / `arguments-invalid`，这就是第一嫌疑点。
2. **unowned job 出现在该实例每个会话的 roster 里**（`registry.list(caller)` 的过滤条件是 `owner === undefined || owner.id === caller`），而 **dsh 自己的 UI 不做 owner 过滤**——照抄 UI 的 `liveRows` 计数会让同一批无主 job 在每张会话卡上各算一次。hwb 必须自己按 `owner === sessionId` 过滤，无主 job 单独展示。
3. **已结束（settled）的 job 不会自己消失**：契约是「保留到 owner 销毁 / service 销毁 / 显式 remove」，所以 `total` 是「**本进程启动以来该会话可见的累计**」，Host 重启即清零。任何「历史任务数」语义都必须由 hwb 自己窗口化，不能指望 dsh。

**对 hwb 任务 board 的接口建议**（与 `docs/research/agent-load-hwb-integration.md` 的口径一致，见 §4.1）：
`status.subagents`（数字，总数，**保持现状**）+ 新增 `status.subagentsRunning`（数字）+ 内存覆盖层 `session.jobs = {live,total,observedAt}`；
**三条都遵守「键存在=有观测；缺键=未知，绝不写 0」**。

---

## 0.1 证据路径约定

```bash
ASAR="/Applications/DeepSeek Harness.app/Contents/Resources/app.asar"
PKG="dsh/node_modules/@deepseek-ai"        # asar 内条目前缀
node /tmp/asar.js "$ASAR" list             # 列条目
node /tmp/asar.js "$ASAR" cat "<条目路径>"  # 打印单个条目
```

本文所有 `包/文件:行号` 都指 **asar 条目内的行号**（解包副本与归档逐字节相同，见 §7）。
本次用到的解包副本：`/tmp/dshsrc`（jobs 系）、`/tmp/gw`（api-gateway / client-connection）、`/tmp/sc`（session-controller）、`/tmp/sub`+`/tmp/sess`（subagent / ui-subagent / ui-jobs）。

版本口径：桌面版 `app.asar` 里所有包 `version: 0.2.1-rc.3`（例：`dsh-api-job-controller/package.json`）。**该版本号是本文结论的边界**：旧版 dsh（0.1.x）没有 `job` 命名空间，`session/list` 的投影键集合也不同。

---

## 1. 后台任务（job）：精确契约

### 1.1 endpoint 字面量是 `job/list`（斜杠），不是 `job.list`

【源码】`dsh-api-job-controller/lib/typert.host.js:182`：

```js
    'job/list': {
      service: 'jobController',
      description: 'Stream the jobs one session can see — its own plus every unowned job —
                    as whole-set frames: one on open, then one after each coalesced burst
                    of lifecycle commits. The stream has no natural end; the carrier closes it.',
      mode: 'stream',
      invocation: { kind: 'direct' },
      parameters: [ { name: 'request', source: 'json', codec: {...JobListRequest...} } ],
      cancellation: { parameter: 'signal' },
      result: { mode: 'strict', typeSymbol: '...#JobListFrame', ... },
      sourceLocation: { file: 'packages/api/job-controller/src/index.ts', line: 76 },
    },
```

同一文件里整个命名空间只有 **3 个端点**（`:116` `job/follow`、`:150` `job/kill`、`:182` `job/list`），**没有**任何 unary 的「数一下有多少 job」端点。

【源码】生成描述符把第一个 `/` 之前当命名空间（`dsh-typert-protocol/lib/index.js:154-160`）：

```js
const separator = endpoint.indexOf("/");
const namespace = endpoint.slice(0, separator);
const method    = endpoint.slice(separator + 1);
const parameters = definition.parameters.map(p => ({ ...p, wire: p.wire ?? p.name }));
```

所以：**wire 端点是 `job/list`；客户端 API 是 `ctx.remote.job.list(...)`**（`dsh-api-job-controller/lib/typert.remote-client.js` 的 `TYPERT_REMOTE.methods['job/list']`）。
两条载体的 endpoint 都用这个字面量：unary 是 `POST /api/job/list`，流是 mux `open` 帧的 `endpoint` 字段。hwb 里已有同族先例：`session/list` 在 0.2.x 是 slash 形、0.1.x 是 dot 形（`src/dshhome/live-status.js:59` 的 `DEFAULT_ENDPOINTS`），**job 侧同样按字面量判，不要凭命名空间猜。**

### 1.2 open 帧的 payload 精确形状

mux 的 `open` 帧被严格校验：`payload` 必须**恰好**是只有一个 `args` 字段、且 `args` 是 plain object 的 JSON（`dsh-api-gateway/lib/index.js:1460-1474`）：

```js
function remoteRequest(endpoint, payload, signal, peer) {
  assertPeerLive(peer, endpoint);
  const segments = endpoint.split("/");
  if (segments.length !== 2 || segments[0] === "" || segments[1] === "")
    throw new Error(`invalid Remote endpoint ${JSON.stringify(endpoint)}`);
  const [namespace, method] = segments;
  if (!isObject(payload) || !isPlainObject(payload) || Reflect.ownKeys(payload).length !== 1
      || !Object.hasOwn(payload, "args") || !isObject(payload.args) || !isPlainObject(payload.args))
    throw new Error("Remote payload must contain exactly one plain-object args field");
  return { namespace, method, args: payload.args, signal, peer };
}
```

`args` 的键名是**参数的 wire 名**。对 `job/list` 只有一个参数 `name: 'request'`，`wire` 缺省 = `name`（上引 `typert-protocol/lib/index.js:160`）；客户端编码同样按 wire 名塞（`dsh-api-gateway/lib/client.browser.js:1865-1877` 的 `args[parameter.wire] = value`，再 `:1849` 包成 `{ args: prepared.args }`）。

**因此一条 `job/list` 流的第一帧是：**

```json
{"type":"open","streamId":"<uuid>","endpoint":"job/list",
 "payload":{"args":{"request":{"sessionId":"session-…"}}}}
```

`JobListRequest` 的 strict codec 是 `z.strictObject({ sessionId: z.string() })`（`typert.host.js:108-111`）——**必填**，且 `additionalProperties:false`：多塞字段会失败。

字节数【实测，本次用 node 计算 JSON 长度】：**183 B**（sessionId 取 44 字符）。

### 1.3 服务端 item 帧的 value 形状与 job 行字段

【源码】`job/list` 的 result schema（`typert.host.js:77-94` 的 zod、`:182` 段落的 `jsonSchema`）：

```js
let _…_job_list_result$schema = () => z.object({
  'type': z.literal('rows').readonly(),
  'jobs': z.array(z.object({
    'id': z.string(),                    // registry 发行 id：<kind>-<16 hex>
    'kind': z.string(),                  // 开放字符串（JobKind 由各组合 merge）
    'label': z.string(),                 // 生产者一行标签（bash 工具 = 完整命令行，见下）
    'owner': z.string().optional(),      // 拥有会话；absent = unowned（任何调用方可见）
    'outputLimitBytes': z.number().optional(),
    'status': z.union([z.literal('failed'), z.literal('running'), z.literal('stopping'),
                       z.literal('completed'), z.literal('killed')]),
    'progress': z.string().optional(),   // 结算时清除
    'detail': z.string().optional(),     // 终态原因（exit code: 3 / signal: SIGKILL）
    'startedAt': z.number(),             // epoch ms
    'finishedAt': z.number().optional(), // 结算前 absent
    'output': z.object({ 'total': z.number(), 'earliest': z.number(),
                         'spillPaths': z.array(z.string()).optional() }),
  })).readonly(),
})
```

- **必填**：`id / kind / label / status / startedAt / output{total,earliest}`；其余可选（zod 的 `.optional()` + `additionalProperties:true` 在宽松面）。
- **status 枚举**（5 个，闭集）：`running` / `stopping` / `failed` / `completed` / `killed`。前两个是「活着」（客户端的 `isLive` 就是这么判的，`dsh-client-ui-jobs/lib/client.js:78-80`）。
- **`label` 可能很长**：bash 工具注册时 `label: args.command`（`dsh-tool-bash/lib/index.js:395-396`，整条命令行，无截断）——字节估算必须按「一条 job 行 200 B–1 KB+」而不是固定 200 B。

帧外形（`dsh-api-gateway/lib/types/stream-server.js:477-482`）：

```js
for await (const value of source) {
  await this.send({ type: 'item', streamId, value });
}
```

即 **`{"type":"item","streamId":"<uuid>","value":{"type":"rows","jobs":[…]}}`**。

### 1.4 刷新语义：整集替换、事件驱动、100 ms 合并

【源码】`dsh-api-job-controller/lib/types/rows.js`（全文 40 行）：

```js
const unsubscribe = registry.events.subscribe({ owners: 'all' }, (event) => {
  if (event.type === 'output') return;
  const owner = event.job.owner;
  if (owner === undefined || owner === request.sessionId) waiter.wake();
});
try {
  yield { type: 'rows', jobs: registry.list(request.sessionId) };   // 打开即一帧
  while (true) {
    await waiter.wait(signal);
    await sleep(options.flushMs, signal);                          // 合并窗（默认 100 ms）
    if (signal.aborted) return;
    yield { type: 'rows', jobs: registry.list(request.sessionId) }; // 每轮提交后整集重发
  }
}
```

- **什么会触发一帧**：该会话可见的 job 的**生命周期提交**——注册、进度行更新、进入 stopping、结算、移除（见 `dsh-api-job-controller/README.zh.md`「使用本包」第 1 段，以及 `event.type !== 'output'` 的过滤）。
- **什么不会触发**：**输出追加**（`type === 'output'` 直接 return）。结算后的投影已带最终字节数，所以「job 在狂刷 stdout」时 roster 是**安静**的。
- **合并窗**：`observeFlushMs` 默认 **100 ms**（`dsh-api-job-controller/lib/index.js:49,72`）。同一突发内的多次提交只发一帧。
- **没有周期心跳式数据帧**：稳态下这条流**一个字节都不发**（只有 WebSocket 协议层 ping，见 §2.3）。
- 实测（推断的推论）：bash 工具**不调用** `updateProgress`（`/tmp/dshsrc/toolbash.js` 全文 grep 无 `updateProgress`），所以典型 bash 任务只产生「注册 / 结算」两次提交 → **一条 job 的完整生命周期最多两三帧**。

### 1.5 已结束的 job 为什么会留在 roster 里 / 何时消失

【源码】`dsh-jobs/lib/index.js:96-98`（JobRegistry 契约注释，原文）：

> - A settled record stays listed until its **owner's disposal**, **service disposal**, or an explicit `remove` by a caller that collected the terminal state itself and never handed the id out.

【源码】`dsh-jobs-local/lib/index.js:503-505`（实现）：

```js
list(caller) {
  return [...this.store.values()]
    .filter((job) => job.owner === void 0 || job.owner.id === caller)
    .map((job) => this.view(job));     // 不按 status 过滤 —— 结算的也在
}
```

【源码】`drop()`（同文件 `:818-826`）是唯一的移除路径，并在 `:817` 注释里点明这是「唯一不随单 job 记录一起送出」的可见集变化：

```js
/** Drop settled records and announce each removal, the one visible-set change no per-job record carries. */
drop(jobs) {
  for (const job of jobs) { this.store.delete(job.id); this.emit({ type: 'removed', job: this.view(job) }, job.owner); }
}
```

三个触发：`disposeOwned(owner)`（`:812-816`，owner ctx 被销毁——会话/agent 生命周期结束）、`disposeAll()`（service 销毁 = **Host 进程退出**）、以及 `remove(id, caller)`（`:523-528`，仅终态可移除，要求调用方已自行收走终态）。
`remove` 的调用方：**本版本里 `dsh-tool-jobs` 没有调用它**（`/tmp/dshsrc/tooljobs.js` grep 无 `remove(`），所以实际路径只有「owner 销毁 / 进程退出」。

**推论（hwb 直接相关）**【推断】：
- `jobs.total` = **该会话自本进程启动以来可见的累计**（含早已结束的）。它不是「最近 N 分钟」。
- **Host 重启 → roster 从空开始**；`dsh-api-job-controller/README.zh.md`「已知限制」第 2 条原文："两条流都是进程本地的：Host 重启丢失全部环与名册"。
- 「移除」会发一帧新的整集（`removed` 事件也走 `rows.js` 的 subscribe），所以 hwb 侧表现为「某一帧里某行消失」，无需增量协议。

### 1.6 dsh UI 自己的计数口径（照抄前必须知道的三件事）

【源码】`dsh-client-ui-jobs/lib/client.js`：

```js
function isLive(job) { return job.status === "running" || job.status === "stopping"; }   // :78-80
const rows        = ordered(jobs);                                                    // 活在前、按 startedAt；结算的按 finishedAt 倒序（:172-182）
const liveRows    = rows.filter(isLive);                                              // :336
const settledRows = rows.filter(job => !isLive(job) && !clearedKeys.has(String(job.id)));// :337
const visibleCount = liveRows.length + settledRows.length;                            // :339
const countLabel = t(liveRows.length > 0 ? "count.live.*" : "count.idle.*",
                     { count: liveRows.length > 0 ? liveRows.length : visibleCount });// :408
```

文案（`:526-532` 中文 / `:569-575` 英文）：

| key | 中文 |
|---|---|
| `count.live.one/other` | `{count} 个后台任务运行中` |
| `count.idle.one/other` | `{count} 个后台任务` |
| `section.settledCount` | `已结束 {count}` |
| `status.running/stopping/completed/killed/failed` | 运行中 / 停止中 / 已完成 / 已停止 / 失败 |

三个坑【源码】：

1. **`countLabel` 有活的任务时只报活的数量**（`liveRows.length`），没有活任务时才报「活+已结束」（`visibleCount`）。所以「N 个后台任务」这个数字**不是一个稳定的总量**，随是否有活任务在「活数」与「总数」之间切换。
2. **「清空已结束」是纯客户端状态**（`:409-415` 的 `clearSettled` 只往本地 `Set clearedKeys` 里塞 id，**不发任何 RPC**）。Host 侧的 roster 不受影响。hwb 若自己实现「清空」，不要试图调 dsh。
3. **订阅时机**：`useEffect(() => watchRows(sessionId), [sessionId, watchRows])`（`:345`）——UI 是**会话头部组件挂载时**订阅、卸载时释放；引用计数在 client service 里（`dsh-api-job-controller/lib/client.js:243-263` 的 `watchRows`/`acquire`/`releaser`）。并且**流失败时 dsh 是把该会话的 roster 整个丢掉**（`ClientJobsModel.rowsDropped`，`dsh-api-job-controller/lib/client.js:64-71`，`startRows` 的 `catch` 调用它），不是保留旧值——这是「断流 = 未知」的官方先例，hwb 应对齐（§4.2）。

### 1.7 结论：没有替代通道

| 想法 | 结论 | 证据 |
|---|---|---|
| 用 HTTP unary 轮询「有几个 job」 | **不存在这种端点** | `typert.host.js` 仅有 `job/follow`、`job/kill`、`job/list` |
| 从 `session/list` 投影里读 | **没有 job 投影** | `session/list` 的 `projections.values` 键集合里无 job（见 §3.2 的 schema 摘录；`dsh-web-app/cordis.patch.yml:124-127` 也只把 job-controller 挂在 session-controller 旁边，注释写「roster rides the session control stream」但 `session/control` 的帧里只有 projection，见 §3.5） |
| 从会话日志/正文推导 | **只能得到历史、且只有 owner job** | `dsh-jobs-local/lib/index.js:610-627` 的 `recordSessionEvent` 往**拥有者会话**追加 `job/registered` / `job/settled`（`JobRegisteredData`/`JobSettledData` 见 `dsh-api-session-controller/lib/typert.host.js:2458-2478`）；unowned job 不记（`if (owner === void 0) return`） |
| 从转发事件（`$events`）拿 | **没有 job 事件** | 白名单 29 项里无 job（`dsh-api-remotes/lib/index.js:18-137`，详见 §3.5） |

→ **唯一入口就是 `job/list` 逻辑流**；它落在 `/api/remote.mux` WebSocket 上（`POST /api/job/list` 会 404/未注册）。

---

## 2. 连接与多路复用

### 2.1 两条鉴权路径（版本差异决定能不能开第二条 socket）

【源码】`dsh-client-connection/lib/index.js`：

| 路径 | 响应 | cookie 载荷 | 之后 `admit()` 落到哪个 Peer |
|---|---|---|---|
| `GET /?token=<launchToken>`（SPA 入口）| `303 Location: ./` + `Set-Cookie` | **version 1**（无 id，`:446-475`，`COOKIE_PAYLOAD_VERSION = 1` 在 `:278`） | 全进程**共享**的 `browserPeer`（`:746` `return { peer: this.browserPeer }`，`:714` 创建，`principal.kind='owner'`、`interactions` 默认 `'answer'`） |
| `GET /connect?token=<launchToken>&interactions=answer\|none` | `302 Location: ./api/remote.mux` + `Set-Cookie` | **version 2**（内含新 peer id，`:505-539`）| `peers` 表里那次 `publishPeer(interactions)` 新建的**独立 owner Peer**（`:781-791`） |

**「一条 socket 一个 Peer」的确切边界**（`:756-776`）：

```js
admitConnection(request) {
  const admission = this.admit(request);
  if ("rejection" in admission) return admission;
  const record = this.peers.get(admission.peer.id);
  if (record === void 0) return { ...admission, release: () => Promise.resolve() };  // ← v1 browserPeer 走这里
  if (record.ownsSocket) return { rejection: 409 };                                    // ← v2 才 409
  record.ownsSocket = true;
  ...
}
```

结论：

- **v2（`/connect`）路径**：一个 cookie ↔ 一个 Peer ↔ **最多一条** mux socket；同 cookie 第二次 upgrade → **HTTP 409**。所以走 `/connect` 的客户端**必须**多路复用，否则第二条流根本开不出来。
- **v1（`/?token=`）路径**（**hwb 现在用的就是这条**，`src/dshhome/live-status.js:116-147` 的 `acquireCookie` GET `origin/?token=`）：`browserPeer` 不在 `peers` 表里 → **不会 409，可以开多条 socket**；但它们**共享同一个 Peer**——没有隔离收益，每条 socket 都是一次隧道 TCP + WS 握手 + 一份内存。`bindPeer`（`dsh-api-gateway/lib/types/stream-server.js:381-389`）把 socket 关到 Peer 的 ctx effect 上：Peer 被 dispose 时该 socket 以 1001 关闭。
- 【修正一个易错点】「hwb 现有 probe 用第二条 socket 会被 409」——**不成立**（v1 路径没有 ownsSocket 检查）。真正的问题是**成本**：probe 每轮都是一次独立建连；且它完全可以改成同一 socket 上的第二条 `$events` 流（语义等价，见 §2.5 step 5）。

### 2.2 mux 帧协议（`/api/remote.mux`）

【源码】`dsh-api-gateway/lib/types/stream-protocol.js`（双向校验都是**精确键集**）：

客户端 → Host：

| 帧 | 精确形状 | 备注 |
|---|---|---|
| `open` | `{type:'open', streamId, endpoint, payload}` | `streamId`、`endpoint` 非空字符串；`payload` 由 `remoteRequest` 再校验为 `{args:{…}}` |
| `item` | `{type:'item', streamId}` 或 `{type:'item', streamId, value}` | 顶层 `undefined` 用「不带 value」表示（`isRemoteUplinkItem`） |
| `end` | `{type:'end', streamId}` | 半关闭上行 |
| `cancel` | `{type:'cancel', streamId}` | 取消该逻辑流 |

Host → 客户端：

| 帧 | 精确形状 |
|---|---|
| `item` | `{type:'item', streamId}` 或 `{type:'item', streamId, value}` |
| `end` | `{type:'end', streamId}` |
| `error` | `{type:'error', streamId, error:{code,message,details}}` —— `details` 必须是对象，三者都是必填 |

服务端行为【源码】`dsh-api-gateway/lib/types/stream-server.js`：

```js
streams = new Map();                       // :103 —— streamId → stream，天然多路
receive(text) {                            // :164-190
  const message = parseRemoteStreamClientMessage(text);
  switch (message.type) {
    case 'open':   this.openStream(message); return;
    case 'item':   this.streams.get(message.streamId)?.inbox.push(...); return; // 未知 id → 静默丢
    case 'end':    this.streams.get(message.streamId)?.inbox.end(); return;     // 未知 id → 静默丢
    case 'cancel': this.streams.get(message.streamId)?.stop(new Error('Remote stream cancelled')); return;
  }
}
openStream(message) {
  if (this.streams.has(message.streamId))
    throw new Error(`api gateway: duplicate Remote stream id …`);   // :178 → receive 抛 → socket.close(1008)
  ...
}
async run() {                              // :126-160
  await closed;
  for (const stream of active) stream.stop(new Error('Remote stream socket closed')); // socket 死 → 全部流死
  await Promise.all(active.map(s => s.done));
}
```

要点：

- **同一 socket 上开多条逻辑流是合法的**（`streams` 是 Map；`additive`、独立 cancel）；
- **`end`/`error` 只结束那一条流**，socket 继续活着；
- **未完成的 `item`/`end`/`cancel` 对未知 streamId 静默丢弃**（「已结束的流，客户端在途帧还在路上」的宽容设计），**唯一会杀掉整条 socket 的协议违规是重复 `open` 同一个 streamId** → `close(1008)`；
- **socket 关闭 → 该 socket 上所有流以 `Remote stream socket closed` 结束**（重连后必须**全部重开**）；
- 每条流有独立的上行 inbox 上限 `streamInboxBytes`（默认 **262144** B，`README.md` 第 43 段），`job/list` 不用上行，无影响。

### 2.3 心跳与存活判定

【源码】`stream-server.js:6,69-93`：Host 每 `websocketHeartbeatIntervalMs`（**默认 2 s**，`README.md` 第 39 段）发 Ping；**连续 2 个间隔**（`MAX_MISSED_HEARTBEATS = 2`）没有「对端活动」→ `socket.terminate()`。「对端活动」= 收到 Pong、收到任意帧、或写下行时**曾经排队**（`bufferedAmount > 0`）后完成——所以拥塞链路上不会误杀。

hwb 已经正确处理（`src/dshhome/pending-interactions.js:491`：`if (opcode === 0x9) { send(0xa, payload); continue; }`）——**多流改造不需要动心跳**。

### 2.4 一个 socket 上的流都属于同一个 Peer；哪些端点有额外门禁

- 【源码】`stream-server.js:318-334` 的 `handleUpgrade(req, socket, head, peer)`：`bindPeer` 之后 `const bound = (endpoint, payload, uplink, control, window) => this.open(endpoint, payload, uplink, peer, ...)`——**每条流都继承 upgrade 时的那个 Peer**。
- `$events`：要求 `peer.interactions === 'answer'`（`dsh-api-gateway/lib/index.js:1454` `requireInteractions`），并且会对**每个新开的 `$events` 流全量重放当前挂起的 waterfall**（`:1014`；hwb 的主动对账就靠这个语义，`pending-interactions.js:1103-1110` 的注释已记录）。
- `job/list`：**没有额外门禁**。`prepareInvocation` 只对**非 owner** principal 走 `remoteAccess.decide`（`index.js:1177-1194`），hwb 的 Peer 是 `principal.kind === 'owner'` → 直接放行。
- 服务缺失时的错误码（hwb 要按 unknown 处理，别当 0）：端点没被任何活跃 Service 导出 → `gateway/invocation-unavailable`（`dsh-api-gateway/lib/types/index.js:645-647`）；Service 不在 → `gateway/service-unavailable`（`index.js:1196-1197`）。

### 2.5 hwb `pending-interactions.js` 扩成多流：函数级清单

现状（`src/dshhome/pending-interactions.js`，1377 行）：**一条 socket = 一条逻辑流**，且 streamId 在 `connect()` 里生成、闭包里硬编码。

| 位置 | 现状 | 需要改成 |
|---|---|---|
| `:334` | `const streamId = \`hwb-${crypto.randomUUID()}\``（每次 connect 一个） | **每条逻辑流一个** streamId；socket 级只保留连接句柄 |
| `:319 createRemoteMuxTransport().connect({origin,cookie,timeoutMs,onValue,onClose})` | 返回 `{close()}`，onValue 只喂那一条流 | 返回 `{openStream(endpoint, payload, {onValue,onClose}) → {close()}, close()}`；`openStream` 可同步调用（连上前的 `open` 帧入队） |
| `:434` `if (!isRecord(message) \|\| message.streamId !== streamId) return;` | 只认自己的 id，其它流帧被丢 | `const stream = streams.get(message.streamId); if (!stream) return;`（与 Host 对称：未知 id 静默丢） |
| `:441-450` `end` / `error` → `shutdown(...)` | **结束整条 socket** | 只结束该条流并回调该流 `onClose(reason)`；socket 不动 |
| `:549` `open` 帧发送（在 upgrade 回调里直接 send） | 单流所以无需排队 | 需要「连接未就绪时的 open 队列」（多流后调用次序与握手顺序解耦） |
| 新增 | — | `cancelStream(streamId)` 发 `{type:'cancel',streamId}`（**71 B**【实测】），走 Host 的 cancel 语义（`inbox.fail` + abort） |
| `:557-563` `close()` | 发 1000 close 帧 + shutdown | 保持（socket 级）；单流释放用 `cancelStream` |
| `:796 #start` 的 `state`（`:798-819`） | `handle / ready / clientId / pending / byEvent / probe` | 增加 `streams: Map<streamId, {kind, sessionId, onValue, onClose}>` 与 `generation` 的流级版本（现在只有连接级 `generation`） |
| `:871 #fail(state, generation, reason)` | 任一异常 → **整条 home 重连 + 清 overlay** | 拆两层：`#failStream(kind, streamId, reason)`（`$events` 断 → 清 overlay；`job` 断 → 只把该会话 jobs 标 unknown）与 `#failSocket`（现有 `#fail`，整条重连）；**只有 socket 级失败才清 overlay** |
| `:922 #onValue(state, generation, value)` | 首帧必须是 `ready` 并取 clientId | 按流分派：`$events` 保持「首帧 ready」；`job/list` 的**首帧必须是 `value.type === 'rows'`**（没有 ready 帧），否则按协议错误关流并标 unknown |
| `:1111-1200 #reconcileHome`（probe） | `this.transport.connect(...)` **新开第二条 socket** | 改为 `state.handle.openStream('$events', EVENTS_OPEN_PAYLOAD, {onValue: probeOnValue, onClose: probeOnClose})`；删除 `probe.handle`；`ready` 窗口、`probe.clientId`、`#answer(state, frame, probe.clientId)` 全部保留（语义不变：新流 = 新 clientId = 新 generation = Host 重放挂起 waterfall） |
| `:1323 #drop(state)` | 关 socket 一次 | 保持；同时 `state.streams.clear()`（socket 关闭已让所有流结束，不要逐流 cancel） |
| 新增 `watchJobRoster(homeId, sessionId, listener)` | — | 引用计数：首个观察者 → `openStream('job/list', {args:{request:{sessionId}}}, …)`；最后一个释放 → `cancelStream`。首帧写入 roster；之后每帧整集替换；断流 → 回调 unknown（**不是空集**） |
| `:313` 文件头的 transport 契约注释 | 「connect({...onValue,onClose})」 | 同步更新注释；**保留 `connect()` 作为薄封装**（首条流固定为 `$events`）以兼容现有测试注入形状（`tests/pending-interactions.test.js` 的假 transport） |

**为什么必须做而不是「再开一条 socket」**【推断，基于 §2.1/§2.2】：v1 路径虽然允许多 socket，但（a）每条 socket 都要在隧道路径上重做一次 TCP + WS 握手（wire-audit 的冷 SSH 握手地板价 9.5 KB / 暖 exec 539 B 是同一量级的教训）；（b）probe 与 roster 都是**短生命周期、可能并发**的流，socket 数量会随「running 会话数」线性膨胀；（c）dsh 自己的浏览器全程只用**一条** socket 承载所有流（`README.md` 第 43 段："Independently cancellable logical streams share that socket"）——照抄它的拓扑最稳。

---

## 3. 子智能体计数

### 3.1 dsh UI 口径：「N 个子智能体」= 直接子会话的 catalog 条目数；「运行中」= join 会话状态

【源码】`dsh-client-ui-subagent/lib/client.js`：

```js
const catalogs = Object.fromEntries(Object.entries(projections).map(([id, snapshot]) => {
  const projected = snapshot.values.subagentCatalog;
  return [id, { …, entries: (projected ?? []).map(entry => ({
    ...entry,
    activity: (statuses.get(entry.id)?.running ?? summaries[entry.id]?.running) === true
      ? 'running' : 'inactive',                                   // :366-369
  })) }];
}));
const directChildren = catalog?.entries ?? [];                     // :388
const directCount    = directChildren.length;                      // :389 —— 「N 个子智能体」
const runningCount   = directChildren.filter(e => e.activity === 'running').length; // :390
```

渲染（`:543` aria-label 与 `:565-571` 孩子节点）：

- 标题按钮上**永远显示总数**：`t(totalCountKey, {count: directCount})` → 中文 `{count} 个子智能体`（`:875-878`）；
- 有在跑的子会话时才额外加一个 **ongoing 圆点**，`aria-label` 才切到「正在运行」文案；
- 只有**根会话**显示这个计数（`SubagentCatalogAction` 开头：`if (origin === 'subagent') return null`，`:612`）；子会话头部显示的是**它自己**的子会话数（`SubagentHeaderLineage` 里的 `children:` 变体，`:646-657`）。

### 3.2 `session/list` 的 wire item 已经足够做 join

【源码】`dsh-api-session-controller/lib/typert.host.js:1635` 的 `session/list` 描述符（参数 JSON Schema）：

```json
{"type":"object","properties":{"cursor":{"type":"string"}},"required":[],"additionalProperties":false}
```

→ 参数 wire 名 `_request`，可选 `cursor`（hwb 现在发的 `{args:{_request:{}}}` 正确，`src/dshhome/live-status.js:450` 的注释也记了这一点）。

【源码】返回值 item（同段 `jsonSchema`，节选，`required: ["agentAvailable","sessionId","updatedAt","running","blank"]`）：

| 字段 | 类型 | 语义 |
|---|---|---|
| `sessionId` | string | 会话 id |
| `running` | **boolean（必填）** | `this.ctx.agents.get(session.id)?.status === 'running'`（`lib/types/list.js:101`）；**冷会话恒 `false`**（`lib/types/list.js:155` 的 `summarizeCold`） |
| `agentAvailable` | boolean | 是否持有活 agent |
| `parentSessionId` | string? | **子会话才有**（`lib/types/list.js:319-325` 的 `listFields(header)`） |
| `origin` | const `'subagent'`? | 子会话才有 |
| `cwd` | string? | 有 cwd 的持久会话才进 list（`list()` 的 `else if (record.header.cwd !== undefined)`，`:120-128`） |
| `projections.values.subagentCatalog` | array | **直接子会话**（排除 fork 继承的事实），元素 `{id, createdAt, mode, label?}`，`mode ∈ one-shot \| continuable \| external \| unknown` |

【源码】`dsh-session-query/lib/index.js:95-124` 的 `listSessions()`：**持久库全量 + live 会话**合并，**没有任何按 origin/parentSession 的过滤** → 子会话**一定在** `session/list` 里，因此「catalog id → 该行 running」的 join 成立。

【源码】磁盘侧（离线）：`subagentCatalog` 投影的 state 是 `{inheritedEventCount, head?: chunkedList}`，`head.values[].childId`；wire 视图才是带 `id` 的数组（`dsh-subagent/lib/types/catalog.js` 的 `stateSchema` / `viewSchema` / `subagentCatalogEntries`）。hwb 的 `subagentStatus` 已经同时认这两种形状（`src/lib/status.js:64-79`），磁盘路径 `storages/session_projcache/sessions/<key>.json`（`src/lib/read-home.js:28`）。

**join 伪代码（hwb 可直接落在现有轮询里）**：

> **已有实测锚点（引用 teammate `hwb-integration` 的观测，非本次实测）**：本机真实数据里父会话 `session-84fb9d81` 的 `subagentCatalog` 有 3 个子会话 id，其中 `…0d33277e` 这一条子会话行 `kind === 'running'` → `{total: 3, running: 1}`。这证明「catalog × 子会话行」的 join 在 hwb 现有索引数据上就成立（见 `docs/research/agent-load-hwb-integration.md` §0.2 与附录）。本次**未**复制该实验（无 token、不连实例），故仍按【源码】+【引用实测】标注。

```js
const catalog  = statusSubagentCatalog;            // 数组，元素 {id, mode, …}
const rowsById = new Map(items.map(it => [it.sessionId, it]));
let total = catalog.length;                        // 与 status.subagents 一致
let running = 0, joinable = 0;
for (const entry of catalog) {
  if (entry.mode === 'external' || entry.mode === 'unknown') continue; // 见 §3.3 坑 2：无本地子会话
  const row = rowsById.get(entry.id);
  if (!row) continue;                              // 子会话行找不到 → 未知，不计数、也不当 false
  joinable += 1;
  if (row.running === true) running += 1;
}
// subagentsRunning 只在「所有可 join 的条目都拿到了行」时才写：
//   joinable === catalog.filter(e => e.mode === 'one-shot' || e.mode === 'continuable').length
```

### 3.3 更便宜、更实时的路：`$events` 上已经在收 `api-session/status`

**这是本次调研最省事的一条发现**【源码】：

1. Host 在 agent 状态变化时 emit（`dsh-api-session-controller/lib/index.js:2992`）：

   ```js
   ctx.emit("api-session/status", agent.id, status === "running");
   ```

2. 该事件在转发白名单里，模式 `emit`（`dsh-api-remotes/lib/index.js:51-55`）：

   ```js
   { event: "api-session/status", mode: "emit", resources: { session: (sessionId) => sessionId } },
   ```

   → 以 `{"type":"emit","event":"api-session/status","args":[sessionId, running]}` 帧下发（`dsh-api-gateway/lib/index.js:1037-1045` 的 `broadcastRemoteEvent`）。**`answers` 客户端（含 owner Peer）不做 remoteAccess 过滤，全量收**（`:1046-1057`：只有 `!client.answers` 才 `decide`）。

3. **hwb 现在就在收这个帧，而且只用了 `running === false` 那一半**（`src/dshhome/pending-interactions.js:989-1000`）：

   ```js
   #handleEmit(state, frame) {
     if (frame.event === 'api-session/status') {
       const [sessionId, running] = frame.args;
       if (typeof sessionId === 'string' && sessionId && running === false) this.#clearSession(state, sessionId);
       return;
     }
     ...
   ```

   只要把 `running === true` 也记进 `state.runningBySession`（Map<sessionId, bool>），hwb 就有了**实时**的「哪些会话在跑」——subagent 运行数 = catalog ids ∩ runningBySession。

**重要限制【源码】**：emit 帧**没有重放**。`$events` 开流时 Host 只重放**挂起的 waterfall**（`index.js:1014`），emit 是 fire-and-forget。所以：

- 连接/重连后必须用 `session/list` 的 `running` 字段做 **baseline**，之后用 emit 做 delta（这正是 dsh 自己客户端的做法：`dsh-api-session-controller/lib/types/client/index.js` 先 `ctx.remote.$on('api-session/status', …)`，roster 的 running 由 list snapshot 同步进 session 对象，`manager.js:169-175` `session.handleRunning(summary.running)`）；
- 漏帧（断流窗口内）也要靠下一轮 `session/list` 纠正。

**收益**【实测字节 + 换算】：每事件 **105 B JSON** → 按 wire-audit 的保守压缩比 4.3 折算 **≈ 26 B wire**。对比 `session/list` 每轮 **129 KB**（179 会话，`docs/research/hwb-wire-audit.md` §0/§A.2，实测锚点）——实时性从「3–30 s」升级到「事件即时」，而成本是噪声级。

**两个坑**：

1. **`api-session/status` 的 `running` 是「该会话的 agent 状态」**，不是「任务完成度」：`stopping`/结算中仍可能是 true；hwb 侧只应把它当 running 信号，不要用它推导 completed。
2. **`mode:'external'` / `mode:'unknown'` 的 catalog 条目没有本地子会话**（`dsh-subagent/lib/types/catalog.js:19-26`：external 记录的是「外部执行返回的身份」，`childId` 由外部 provider 给，`childCreatedAt` 用 `Date.now()` 伪造）→ **不可 join**。这类条目必须计入 `total`，但在 running join 里只能是「未知」，不能当「未运行」。

### 3.4 离线 / 只读实例：只有总数，没有运行中

- 磁盘 projcache 只有 `subagentCatalog`（总数）+ `subagentTiming`（最近一轮时长、`lastTurnCompleted`）等**投影**；`running` **不是投影**，它来自 `ctx.agents` 的运行时状态（`lib/types/list.js:101`），**不落盘**（`SessionSummary` 里也没有持久形态）。
- 所以 hwb 的「只读实例 / 无实时通道实例」上：`status.subagents`（总数）可信；`subagentsRunning` **必须缺键**。这与 `docs/research/agent-load-hwb-integration.md` §0.4 的实测现状一致（本机 6 条 running 会话全部来自 readOnly 实例）。
- `subagentTiming.lastTurnCompleted` 只能回答「上一轮是否正常结束」，**不能**回答「现在是否在跑」；用它猜 running 会把「刚结束」和「从未启动」混起来（dsh 自己的 UI 用它的方式见 `ui-subagent/lib/client.js:203-204`：只用来把 `inactive` 细分成「已完成 / 当前未运行」）。

### 3.5 dsh 侧**没有**任何投影/事件能给 job 计数

逐项排除【源码】：

| 候选 | 结论 |
|---|---|
| `session/list` 的 `projections.values` | 键集合：`inbox / workingDirectory / agentPreset / title / todos / sessionListMetadata / imageLimits / modelSelection / permissions / subagentCatalog / subagentTiming / subagent / tokenUsage / contextPressure / contextBreakdown / agentTeam / userQuestions / goal / plan`（`dsh-api-session-controller/lib/typert.host.js:1635` 段的枚举）——**无 job** |
| `session/control` 流 | 只有 projection：首帧 `{type:'baseline', value:{projections:{<sid>:{asOfSeq,values}}}}`，之后 `{type:'projection', sessionId, key, value, seq}`（`dsh-api-session-controller/lib/types/control.js:13-45`）。**不含 running，也不含 job** |
| 转发事件白名单 | 29 项，`api-session/{added,removed,status,activity,error}` + approval/user-questions waterfall + 若干设置类；**无 job 事件**（`dsh-api-remotes/lib/index.js:18-137`） |
| 会话日志 | 有 `job/registered` / `job/settled`（`JobRegisteredData`/`JobSettledData`，`dsh-api-session-controller/lib/typert.host.js:2458-2478`；写入点 `dsh-jobs-local/lib/index.js:610-627`）——**只对 owner job**、**只有历史**、**没有当前状态**；且 hwb 的索引只读 projcache，不读日志正文（`src/dshhome/remote-reader.js:17-21, 48-60`） |

---

## 4. hwb 最小数据契约、订阅生命周期、带宽

### 4.1 数据契约（与 `agent-load-hwb-integration.md` 对齐）

**落库层**（`sessions.status` JSON，可持久、离线可读）：

```jsonc
{
  "subagents": 3,            // 已有：catalog 总数（数字，保持！）
  "subagentsRunning": 2      // 新增：键存在 = 本轮实时行给出了完整 join；缺键 = 未知
}
```

> **不要**把 `status.subagents` 改成对象 `{total, running}`。证据：`src/web/components/session-state.js:20` 用 `Number(status?.subagents)` 归一、`src/web/components/recent-sessions.js:98` 直接比较 `status.subagents > 0` 且拼成文本——改成对象会静默变成 `0`/`[object Object]`，属于「不报错但显示错」的坏降级。

**内存覆盖层**（不落库，路由合并，照抄 intervention 的两层模式）：

```jsonc
// session.jobs —— 每条 running 会话一个，断流即删（= 未知）
{ "live": 2, "total": 5, "observedAt": "2026-10-28T05:52:00.000Z" }
```

- `live` = roster 里 `status ∈ {running, stopping}` 且 **`owner === sessionId`** 的行数；
- `total` = roster 里 `owner === sessionId` 的行数（含已结束）；
- **unowned job**（`owner` 缺失）**不并入任何会话**，建议另立实例级字段（如 `instance.unownedJobs = {live,total}`）或干脆不显示——**绝不能每个会话都加一遍**（§1.5、§5-R1）。

**通用规则**（照 `projectionReported` 模式，`src/dshhome/live-status.js:359-361, 376-378`）：
「**键存在 = 有观测；缺键 = 未知，不可写成 0**」。三条落地检查：

1. 流未订阅（会话不 running）→ 缺键（不是 0）；
2. 流断/订阅失败 → **删键**（不是保留旧值，也不是写 0）——dsh 自己就是这么做的（`ClientJobsModel.rowsDropped`，`dsh-api-job-controller/lib/client.js:64-71, 289-293`）；
3. `total === 0 且 live === 0` 只有在**确实收到过至少一帧 `rows`** 时才能写（空 roster 与「不知道」在帧层面可区分：空集帧也是 103 B 的合法 `rows`）。

### 4.2 订阅生命周期（建议）

```
每 home（dsh 实例）：
  └─ 1 条 mux socket（与现有 $events 共用；v1 cookie；断线指数退避 —— 现有 #scheduleReconnect 复用）
       ├─ stream#1  $events              （现有；顺带记 api-session/status 的 running=true/false）
       ├─ stream#2  $events（probe）      （现有语义，改成同 socket 第二条流）
       └─ stream#N  job/list(sessionId)   （新增，仅对 kind==='running' 且可见的会话）
```

| 环节 | 规则 | 理由 |
|---|---|---|
| baseline | 沿用 `session/list`（3 s→30 s 自适应，`src/dshhome/live-poller.js`）；从 `running` 字段建 `runningBySession`，从 `subagentCatalog` 建 catalog | emit 无重放，必须 seed |
| delta | `api-session/status` emit → 更新 `runningBySession`；`api-session/removed` → 删会话并回收其 job 流 | 0 新增订阅 |
| 开 roster | 只在 `kind === 'running'`（或 `runningBySession.get(sid) === true`）**且**该会话在当前视图/最近 N 条里时开流 | 冷会话的 roster 只会有 unowned job，开了也是浪费 |
| 并发上限 | 建议**每 home ≤ 8–16 条** `job/list`（按 `startedAt`/最近活动取前 N） | 每条流在 Host 侧是一次 `registry.events.subscribe` + 一个 Map 条目，成本低但没必要无限开；上限主要是保护 hwb 自己与隧道 |
| 关闭 | 会话转 idle 后**延迟 10–30 s** 再 `cancel`（抖动保护）；会话被移除/实例停 → 立即 `cancel` | 短任务结束马上又启动很常见，避免开关抖动 |
| 断连 | socket 断 → 全部 roster 标 unknown（删键）+ 重连后按当前 running 集合重开 | `job/list` 首帧是整集，重开即恢复，无需补帧/游标 |
| 错误分类 | `gateway/invocation-unavailable` / `gateway/service-unavailable`（该 dsh 没装 job 能力）→ 该 home **标记 jobs 不可观测**、停止重试；`gateway/arguments-invalid` → 记 bug（payload 写错）；其它 → 退避重试 | 前两者重试 100 次也不会成功 |
| 去抖/广播 | roster 帧先落内存 map，**1–3 s 合并**（可与 LiveStatusPoller 同拍）后 `broadcast('agent-load:updated', {homeId})`；payload 只带 homeId，前端重拉（与 intervention 的 `#notify` 同款，`pending-interactions.js:1296-1320`，`NOTIFY_DEBOUNCE_MS` 去抖） | Host 侧 100 ms 合并窗内仍可能连发多帧（多个 job 同时结算），不要一帧一次 SSE |
| 只读实例 | 没有 mux → 不订阅、不写键 | 见 §3.4 / §5-R4 |

### 4.3 带宽估算（对照 `docs/research/hwb-wire-audit.md`）

**本次用 node 计算的 JSON 字节**【实测，`JSON.stringify(...).length`，`streamId` 取 41 字符 uuid 形，`sessionId` 取 44 字符，job 行取「bash 类真实字段」：`id/kind/label(≈60 字符)/owner/outputLimitBytes/status/progress|detail/startedAt/finishedAt/output`】：

| 帧 | payload 字节 | 说明 |
|---|---:|---|
| `open`（job/list） | **183** | 一次性 |
| `item` rows，**0 个 job** | **103** | 空集也是合法基线 |
| `item` rows，1 个 job（1 live） | **409** | |
| `item` rows，2 个 job | **741** | |
| `item` rows，3 个 job | **1 073** | |
| `item` rows，5 个 job（2 live） | **1 712** | |
| `item` rows，10 个 job | **3 373** | |
| `item` rows，30 个 job（全 settled） | **10 083** | label 更长（完整 bash 命令行）时会更大 |
| `cancel` | **71** | 关流 |
| `emit` `api-session/status` | **105** | 折 wire ≈ **26 B**（÷4.3，见 wire-audit A2） |
| `emit` `api-session/added`（带 summary + projections） | **526** | 仅会话创建/resume 时 |

**对照组**（wire-audit §0 与 §A.2 的实测/估算）：`session.list` **P = 129 KB / 轮**（179 会话，实测），hwb 现在按 3 s→30 s 自适应在轮询；远端隧道有效吞吐 **≈9.9 KB/s**（A1），压缩比 **4.3×**（A2）。

**结论（估算）**：

- 订阅 3 条 running 会话的 roster：**一次性 ≈ 0.2–1.5 KB**（open + 首帧），之后**只在 job 注册/结算时**各推一帧（0.4–3.4 KB），**稳态 0 B/s**。
- 即使一个会话有 10 个 job 且每分钟结算两个 → ≈ 6.7 KB/min ≈ **0.1 KB/s**，相对 9.9 KB/s 的链路是 1% 量级。
- 真正的成本仍是**现有的 `session/list` 轮询**（129 KB/轮）与 projcache 全量 `cat`；job roster 是**噪声级增量**。若后续要压带宽，优先级高于 job roster 的是：`session/control` 流替代 `session/list` 轮询（它只推 projection 增量，但**不含 running**，不能完全替代）。
- 「每 3 s 重搬大帧」的风险**不存在**于 `job/list`：它没有周期帧（§1.4）。唯一周期帧是 WebSocket ping（2 s，几十字节级）。

---

## 5. 限制、反例与「不可得」清单

| # | 限制 | 证据 | 对 hwb 的含义 |
|---|---|---|---|
| R1 | **unowned job 出现在该实例每个会话的 roster 里** | `dsh-jobs-local/lib/index.js:503-505`（`owner === undefined \|\| owner.id === caller`）；`job/list` 描述符原文 "its own plus every unowned job" | 必须按 `owner` 过滤；否则 N 张卡各+1。dsh UI **不**过滤（所以它自己的计数含无主 job）——不要照抄 |
| R2 | **settled 不自动消失** | §1.5；`dsh-jobs/lib/index.js:96-98` | `total` = 进程内累计；「最近任务」需要 hwb 自己按 `finishedAt` 窗口化 |
| R3 | **Host 重启 → roster 全空**，`job/follow` 的环也丢 | `dsh-api-job-controller/README.zh.md` 已知限制第 2 条；`dsh-jobs-local` 的 README「由随附的进程内注册表管理的任务会随 harness 进程终止而消失」 | 重启后第一帧 `rows` 是空集——**不能**据此断言「这个会话从来没有后台任务」；要区分「重启后未观测到」与「观测到 0」 |
| R4 | **离线/只读实例不可观测 job** | 唯一入口是 mux 流（§1.7）；远程只读索引只有 projcache（`src/dshhome/remote-reader.js:17-21`），无 job 投影 | 只读实例：`session.jobs` **缺键**；UI 必须什么都不显示（不能写 0） |
| R5 | **不存在的 sessionId 不报错** | `streamJobRows` 直接 `registry.list(sessionId)`，冷/未知 id 得到「unowned 集合」 | 传错 id 不会有 error 帧，只会拿到一堆无主 job；hwb 侧要自己保证 id 来自 live 行 |
| R6 | **job registry 是进程本地的** | §2.5 / §3.5 | 多 home 各自独立，互不可见；不能跨实例聚合 |
| R7 | **多个 hwb 客户端互不影响，但 hwb 会被算作「有人在看」** | `$events` 是 owner + `answers` 的流 → `hasLiveClient()` 为 true（`README.md` 第 49 段）；waterfall 会投给**所有** answer 客户端 | hwb 必须继续对每个 waterfall 回 `next`（现状已做，`#answer`），否则会挡住真实 UI 的审批链 |
| R8 | **`job.list` 是 Remote 流，不是投影** | §1.7 / §3.5 | 不能从 projcache / 会话正文推导；离线/历史视图里「后台任务」只能是「未知」 |
| R9 | **版本边界** | 0.2.1-rc.3 才有 `job` 命名空间；旧版无 | 对面是 0.1.x 时 `job/list` 会得到 `gateway/invocation-unavailable` → 标 jobs 不可观测（不是 0）；session/list 的双写法先例见 `live-status.js:59` |
| R10 | **`running` 的语义是 agent 状态，不是「有活干」** | `lib/types/list.js:101`；`api-session/status` 由 agent 状态 emit（`lib/index.js:2992`） | 子智能体「运行中」与 hwb 自己推导的 `kind==='running'` 可能短暂不一致（hwb 有新鲜度门限，dsh 没有）；展示层以「观测来源」标注更诚实 |
| R11 | **`mode:'external'/'unknown'` 的 catalog 条目无本地子会话** | `dsh-subagent/lib/types/catalog.js:19-26` | 计入 `total`，但在 running join 里是「未知」，不能算「未运行」 |
| R12 | **归档会话**仍可出现在 corpus / catalog | `archived-session-gate.js`（归档只是禁止起 step，不删会话）；catalog 是父会话日志里的事实 | 归档子会话不会 running（恒 false），计数不受影响；但 hwb 若按「可见会话」过滤，注意父/子可见性可能不同 |

**明确「不可得」的三件事**：

1. **离线/只读实例上的 job 计数** —— 无投影、无持久化（R4/R8）。
2. **dsh 侧的 job 历史时间线（窗口化）** —— registry 不保留「任务开始/结束的查询接口」，只有 roster 的当前投影 + 会话日志里 owner job 的事件；`job/follow` 只给单个 job 的保留输出环。
3. **`stopping` 与 `running` 之外的中态** —— 没有「排队中」状态；`status` 是 5 元闭集。

---

## 6. 待验证（未实测项）——本文没有真机抓包/连接，原因与验证步骤

本文**没有**真机抓包/连接（遵守「不改变 dsh 状态」约束，且本机没有可用的 launch token：`~/.hwb/config.json` 的 `homes` 为空）。以下 4 条建议在真正接线时各花 1 分钟验证：

1. **【待验证 · 最关键】`job/list` 的 open payload**：抓一帧确认是 `{args:{request:{sessionId}}}`（本文结论，与 Lead 简报的 `{args:{sessionId}}` 不同；若对面返回 `gateway/arguments-invalid` / `invalid Remote payload`，先怀疑这里，§1.2）。
2. **【待验证】settled 留存**：开一条 roster 跑一个 `bash` 后台任务，等它结束，确认**仍有一帧 `rows` 带 `finishedAt`**，且长时间不掉（§1.5 的推断）。
3. **【待验证】同 socket 多流**：一条 socket 上同时开 `$events` + 2 条 `job/list`，确认帧按 `streamId` 分流、某条 `cancel` 后其它两条照常（§2.2）。
4. **【待验证】帧大小分布**：真实 bash job 的 `label` 是完整命令行（`dsh-tool-bash/lib/index.js:395-396`），统计一下实际 rows 帧的 P50/P95，校准 §4.3 的表。

---

## 7. 复现命令（只读）

```bash
ASAR="/Applications/DeepSeek Harness.app/Contents/Resources/app.asar"

# job 端点 / 字段 / 枚举
node /tmp/asar.js "$ASAR" cat dsh/node_modules/@deepseek-ai/dsh-api-job-controller/lib/typert.host.js \
  | sed -n '108,230p'                      # 三个端点 + JobListFrame schema + status 枚举

# roster 刷新语义（整集、事件驱动、output 不刷新）
node /tmp/asar.js "$ASAR" cat dsh/node_modules/@deepseek-ai/dsh-api-job-controller/lib/types/rows.js

# 注册表 list()/drop()/会话事件
node /tmp/asar.js "$ASAR" cat dsh/node_modules/@deepseek-ai/dsh-jobs-local/lib/index.js \
  | sed -n '500,530p;605,630p;805,830p'

# 契约注释（settled 留存）
node /tmp/asar.js "$ASAR" cat dsh/node_modules/@deepseek-ai/dsh-jobs/lib/index.js | sed -n '90,130p'

# UI 计数口径 / 文案 / watchRows 引用计数
node /tmp/asar.js "$ASAR" cat dsh/node_modules/@deepseek-ai/dsh-client-ui-jobs/lib/client.js \
  | sed -n '76,90p;330,345p;400,416p;520,535p'
node /tmp/asar.js "$ASAR" cat dsh/node_modules/@deepseek-ai/dsh-api-job-controller/lib/client.js \
  | sed -n '225,300p'

# mux 协议 / 多流 / 心跳
node /tmp/asar.js "$ASAR" cat dsh/node_modules/@deepseek-ai/dsh-api-gateway/lib/types/stream-protocol.js
node /tmp/asar.js "$ASAR" cat dsh/node_modules/@deepseek-ai/dsh-api-gateway/lib/types/stream-server.js

# 鉴权两条路径 + ownsSocket
node /tmp/asar.js "$ASAR" cat dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js \
  | sed -n '440,545p;700,800p'

# session/list 的 wire item + 参数名 _request
node /tmp/asar.js "$ASAR" cat dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/typert.host.js \
  | sed -n '1635,1640p'

# 子智能体 catalog 投影（磁盘 head.values[].childId / wire 数组）
node /tmp/asar.js "$ASAR" cat dsh/node_modules/@deepseek-ai/dsh-subagent/lib/types/catalog.js

# 子智能体 UI 的 total / running join / 文案
node /tmp/asar.js "$ASAR" cat dsh/node_modules/@deepseek-ai/dsh-client-ui-subagent/lib/client.js \
  | sed -n '356,400p;540,575p;870,880p'

# 转发事件白名单（确认无 job 事件、有 api-session/status）
node /tmp/asar.js "$ASAR" cat dsh/node_modules/@deepseek-ai/dsh-api-remotes/lib/index.js | sed -n '15,140p'

# session/control 只带 projection
node /tmp/asar.js "$ASAR" cat dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/control.js
```

**本文引用的 dsh 侧代码行号索引**（速查）：

| 断言 | 位置 |
|---|---|
| `job/list` 端点 / stream / 参数 `request` / 结果 `rows` | `dsh-api-job-controller/lib/typert.host.js:182`（另 `:116`、`:150`） |
| job 行字段 + `status` 5 元枚举 | 同文件 `:21`/`:51`/`:85`（status 行）、`:77-94`（list 结果 schema） |
| open payload 必须恰好 `{args:{plain object}}` | `dsh-api-gateway/lib/index.js:1460-1474` |
| `wire = parameter.wire ?? parameter.name` | `dsh-typert-protocol/lib/index.js:154-160` |
| 客户端按 wire 名装 args | `dsh-api-gateway/lib/client.browser.js:1865-1877`、`:1849` |
| roster：整集 / 100 ms 合并 / output 不刷新 | `dsh-api-job-controller/lib/types/rows.js` 全文件；flush 默认 `lib/index.js:49,72` |
| `list(caller)` 含 unowned + 含 settled | `dsh-jobs-local/lib/index.js:503-505` |
| settled 留存契约 | `dsh-jobs/lib/index.js:96-98`；移除路径 `dsh-jobs-local/lib/index.js:818-826` |
| owner job 写会话事件 | `dsh-jobs-local/lib/index.js:610-627` |
| UI：isLive / liveRows / visibleCount / 文案 / 本地清空 | `dsh-client-ui-jobs/lib/client.js:78-80, 336-339, 408, 409-415, 526-532` |
| 客户端 watchRows 引用计数 + 断流丢 roster | `dsh-api-job-controller/lib/client.js:232-300` |
| mux：`streams` Map / 重复 open 关 socket / 未知 id 丢弃 / socket 死全部流死 | `dsh-api-gateway/lib/types/stream-server.js:103, 164-190, 178, 126-160` |
| 心跳 2 s × 2 次 | 同文件 `:6, 69-93` |
| `$events` 需 interactions=answer；新流重放挂起 waterfall | `dsh-api-gateway/lib/index.js:1454, 1014` |
| `/connect` v2 cookie + 302 → `./api/remote.mux` | `dsh-client-connection/lib/index.js:505-539` |
| `/?token=` v1 cookie（共享 browserPeer） | 同文件 `:446-475`、`:714`、`:746` |
| `ownsSocket` → 409（仅 v2）/ v1 不限制 | 同文件 `:756-776` |
| `session/list` 参数 `_request` + item 字段（running/parentSessionId/origin/subagentCatalog） | `dsh-api-session-controller/lib/typert.host.js:1635` |
| `running` = agent 状态；冷会话恒 false | `.../lib/types/list.js:101, 155` |
| corpus 不按 origin 过滤 | `dsh-session-query/lib/index.js:95-124` |
| catalog 磁盘 state / wire view | `dsh-subagent/lib/types/catalog.js` |
| 子智能体 total/running join + 文案 | `dsh-client-ui-subagent/lib/client.js:366-369, 388-394, 543, 565-571, 875-878` |
| `api-session/status` emit + 白名单 | `dsh-api-session-controller/lib/index.js:2992`；`dsh-api-remotes/lib/index.js:51-55` |
| emit 对 answer 客户端不过滤 | `dsh-api-gateway/lib/index.js:1037-1057` |
| `session/control` 只推 projection | `dsh-api-session-controller/lib/types/control.js:13-45` |
| owner principal 跳过 remoteAccess | `dsh-api-gateway/lib/index.js:1177-1194` |
| job 能力未挂载时的错误码 | `dsh-api-gateway/lib/types/index.js:645-647`、`lib/index.js:1196-1197` |

**hwb 侧被引用位置**：`src/dshhome/pending-interactions.js:313-320/334/434/441-450/491/549/796/871/922/992-1000/1111-1200/1296-1320/1323`、`src/dshhome/live-status.js:59/116-147/204-211/352-361/376-378/387-395/450`、`src/dshhome/live-poller.js:24/43-60`、`src/lib/status.js:56-81`、`src/lib/read-home.js:23-28`、`src/web/components/recent-sessions.js:5-11,98`、`src/web/components/session-state.js:20`、`docs/research/hwb-wire-audit.md` §0/§A.1/§A.2。
