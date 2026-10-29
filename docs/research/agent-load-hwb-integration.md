# 会话卡「子智能体数 / 后台任务数」：hwb 集成面（落库 → API → SSE → 渲染）

> 范围：**hwb 侧的集成面**（不改 `src/`、不改 `tests/`）。目标是把「每个 agent 会话的子智能体数（含运行中）」与
> 「后台并行任务数（含运行状态）」放到「运行中」会话卡上、「上下文 N%」的右侧。
> dsh 侧数据源取证见 `docs/research/agent-load-dsh.md`（teammate `dsh-protocol`），Codex/WorkBuddy 见
> `docs/research/agent-load-local-harnesses.md`。本文只回答：数据怎么进来、落到哪、怎么暴露给前端、卡片怎么画、怎么降级、怎么测。

---

## 0. 结论（TL;DR）

1. **「子智能体数」已经落库了，只差显示。** `status.subagents` 这个键从两条读路径都一直写进
   `sessions.status`（`src/lib/status.js:101`、`src/dshhome/live-status.js:355`），但 UI 只在
   `showSubagents` 开关打开时才画一行 `N 子agent`（`src/web/components/recent-sessions.js:98`）。
   所以**最小改动只有 1 个文件**：把计数移出开关、放到上下文右侧（第 5 节 S0 → S1）。
2. **「其中几个在跑」也能只靠 hwb 已有数据算出来，不需要新通道、不需要迁移**：
   父会话的 `subagentCatalog` 给出子会话 id（磁盘 `head.values[].childId` / 线上 `[{id}]` 两种形状 hwb 都已认），
   子会话自己的行就在同一个 home 的索引里，`status.kind === 'running'` 即「在跑」。
   实测本机真实数据：父 `session-84fb9d81` 的 catalog 有 3 个 childId，三条子会话行全部 `kind=running`（见附录实测）。
3. **「后台任务数」没有投影、不能落库，只能走实时通道**（dsh 的 `job` registry 是进程本地的，`SessionSummary`
   里没有 job 字段、`SessionProjectionMap` 里也没有 jobs 投影）。唯一入口是 `/api/remote.mux` 上的 `job.list`
   流（详见 `agent-load-dsh.md`）。hwb 已有的「实时覆盖层 + API 投影」两层设计（intervention 就是这套）
   正是为这种数据准备的，建议照抄：内存 overlay → `routes.js` 合并 → 新 SSE 事件 → 前端重画。
4. **降级=未知，不是 0**：job 覆盖层断流即清空；子代理运行数在「子会话行找不到」时不写键。
   本机现状（很重要）：**当前 6 条 running 会话全部来自 `readOnly` 实例（没有实时通道）**，所以如果只做实时通道，
   用户最想看的那些卡片反而什么都拿不到 —— 这也是把「子代理运行数」做成投影 join（而不是实时-only）的理由。
5. **体积/广播都不是瓶颈**：实测 `sessions.status` 共 2691 行 / 233,876 B（均值 87 B），父会话行加
   `subagentsRunning` 约 +26 B；job 计数不落库，SSE payload 只有 `{homeId}`。

---

## 1. 现状：现有数据链路（逐跳，含行号）

### 1.1 实时读数：`session/list` → 状态覆盖

`src/dshhome/live-status.js`

| 位置 | 作用 |
|---|---|
| `:59` | `DEFAULT_ENDPOINTS = ['session/list','session.list']`，两代端点名 |
| `:317-384` | `toLiveRow(item)`：把 `SessionSummary` 折成 hwb 行；`:352` 用 `item.running` 作权威运行信号；`:355` `subagentStatus(values.subagent, values.subagentCatalog)` → `status.subagents`（总数）；`:371` `origin/parentSessionId` 只折成布尔 `isSubagent`（**父会话 id 被丢掉**，这是后文 join 方案的关键约束） |
| `:360` | `projectionReported`：**「键存在=这条 dsh 报了该投影，缺键=不知道」**的第一个范例 |
| `:387-395` | `extractLiveRows(result)`：`result.value.items` → `rows`（单次 map，无跨行后处理 → 加 join 的插入点） |
| `:451-503` | `LiveStatusReader.read()`：token→cookie 交接 + 4s/自适应超时；任何失败返回 `null`（调用方回退文件索引） |

### 1.2 轮询与写入

`src/dshhome/live-poller.js`

- `:24` 构造（`store / homes / read / broadcast / intervalMs=3000`，自适应节奏到 30s）。
- `:133-150` 单飞读取 → `store.applyLiveStatus(homeId, live)` → `broadcast('index:updated', {homeId, source:'live'})`。
  **这里是唯一能拿到「本轮实时行」的地方** —— 若 jobs 需要订阅目标，就应该在这里回调（第 5 节 S2 第 3 步）。

`src/dshhome/store.js`

- `:70-103` `sessions` 表：`status TEXT`（`:93`，存整块 status JSON）、`liveOnly`（`:98`）、`unread`（`:101`）。
  **没有、也不需要** parentSessionId 列 —— 全文的 join 都在内存里做。
- `:230` `LIVE_GRACE_MS = 10_000`：实时写入活跃窗口；窗口内文件索引的整表替换不能覆盖 `status/lastActivity`。
- `:276-285` `hydrateSessionRow`：`status` 等 JSON 列统一 `safeJsonParse` 降级（坏 JSON 不炸进程）。
- `:667-873` `upsertRows`：整表替换；`:700-721` 只回写「当前实时列表里确实存在」的会话（幽灵徽标防治）；
  `:734-736` 通道死了超过宽限期就收回 liveOnly 行。
- `:895-994` `applyLiveStatus`：空数组=「确实没有会话」（`:903-913`）；`:915-926` 幽灵清理；
  `:947-992` **逐行比对 `status/lastActivity/tokenUsage/title`，没变就跳过整表写**（`:961-965` 的 JSON 串比较
  → 新增字段会自然进入这个「是否变化」的判定）；`:996-1005` `#updateLiveRows` 只写变化行。
- `:1173-1183` `recentSessions()`、`:1266-1281` `searchAll()`：返回行形状**逐字段同构**，前端复用同一个渲染函数；
  都只 SELECT 固定列 + `hydrateSessionRow`（JSON 列出站时已是对象）。

`src/dshhome/reader.js`

- `:42-53` `mergeLiveStatusJson`：实时 `status` **整块覆盖**，唯一例外是 `intervention`（键存在=权威、缺键=保留文件侧）。
- `:64-107` `mergeLiveStatus`：覆盖 + 补插 liveOnly 行。
- `:6-33` `mergeTokenUsage`：按 key 合并的另一个先例（「没报的键保留旧值」）。

### 1.3 API 与 SSE

`src/api/routes.js`

- `:214` `createRouter({ ..., interventions = null, liveIntervention = null })` —— 可选依赖的注入点。
- `:229-243` `withInterventions(rows)`：**三层契约**（可选 / 不改形状 / 失败只降级），是新增覆盖层的模板。
- `:502-519` `/api/homes`：`liveIntervention` 三态（`true` 有通道 / `false` 无通道 / `null` 不适用，如 Codex），
  谓词在 `src/server.js:212-216` 与 LiveStatusPoller 同口径。
- `:1053-1072` `/api/sessions/recent`（`withInterventions(rawRows)` → 再切 limit）。
- `:1077-1088` `/api/search`（只覆盖 `sessions`，`projects/truncated` 原样透出）。

`src/api/sse.js:80-89`：`broadcast(event, data)` → `event: <name>\ndata: <json>`；4 MiB 背压（`:15`）+ 32 客户端上限。

现有事件名（`grep broadcast`）：`index:updated` / `instance:status` / `monitor:updated` / `quota:updated` /
`intervention:updated` / `log:event`。

### 1.4 前端

- `src/web/store.js:26-41` `subscribe()`：`EventSource('/api/events')` 逐个 `addEventListener` → `cb()`。
  **新增事件必须在这里挂一行，否则「实时变了但界面不动」**。
- `src/web/app.js:2006-2012` `scheduleRefresh()`：SSE 合并 120ms 只刷一次（避免一次索引连发多事件导致多次全量重建）。
- `src/web/app.js:419` `/api/sessions/recent`、`:414-420` `Promise.allSettled`（单端点失败不清空其他栏）。
- `src/web/app.js:567` `filterSessionState(agents.visible, sessionStatusFilter)`；`:573-580`
  `unobservedHomeNames`（「无实时通道」盲区，来自 `home.liveIntervention === false`）；`:613`
  `renderRecentSessions(shownSessions, lastHomes, { showSubagents })`；`:676` 状态筛选条；`:1311` 开关点击。

---

## 2. 数据从哪来、落到哪（推荐方案）

### 2.1 子智能体：**继续走 `status` JSON（持久层）**

```jsonc
// sessions.status（已有形状 + 一个新键）
{
  "kind": "running",
  "label": "运行中",
  "subagents": 3,              // 已有：catalog 条目总数（含已结算的 one-shot 子代理）
  "subagentsRunning": 3,       // 新增：其中当前在跑的（只在能判定时写）
  "isSubagent": true,          // 已有：这一行自己是不是子代理
  "approval": "ask",
  "observedAt": "2026-10-28T05:47:03.650Z"  // 文件侧已有；实时行没有（沿用现有形状，别加）
}
```

口径：
- `subagents` = **历史子代理总数**（`subagentCatalog` 条目数），不是并发数。文案必须写成
  「子代理 3（3 运行）」，不能写成「3 个在跑」。
- `subagentsRunning` 的语义 = 子会话行 `status.kind === 'running'` 的个数（hwb 自己的状态口径）。
  dsh UI 的口径是「子会话在运行中的 session store 里」（见 `agent-load-dsh.md`）；两者正常情况一致，
  hwb 在投影陈旧时会更保守（`RUNNING_STALE_MS` 闸门会把它降成 idle，见 `src/lib/status.js:15,17-30,122-124`）。
- **只在 `status.kind === 'running'` 的父会话上写**：父会话空闲时子代理不可能在跑（dsh 语义：子代理运行在父 turn 内），
  这样也避免把上一次的数值冻在空闲卡上。
- 任一 catalog id 在本 home 找不到对应会话行 → **不写这个键**（未知），不要把缺失当 0。

为什么放 status 而不是 overlay：它和 `kind` 是同一份证据、同一个新鲜度闸门、同一个 lease（实时写入 10s 宽限，
之后文件索引重写；见 `store.js:230,700-721`）。放在同一个 JSON 里，「运行中」和「1 个在跑」不可能互相矛盾。

落库路径（无需改写入侧）：`src/lib/schema.js`（文件侧）与 `src/dshhome/live-status.js`（实时侧）各自算好 →
`reader.mergeLiveStatus` → `store.upsertRows/applyLiveStatus`（整块 status 覆盖）→ 读接口原样出站。

### 2.2 后台任务：**实时覆盖层（内存），不写库**

```jsonc
// GET /api/sessions/recent、/api/search 的 session 行上（新字段）
"jobs": { "running": 1, "total": 2, "observedAt": "2026-10-28T05:48:09.072Z" }
```

- **键存在 = 该会话此刻的 job roster 已被观察到；缺键 = 未知**（无实时通道 / 断流 / 非 dsh / 版本不支持）。
- `total` = roster 里 `job.owner === sessionId` 的条目数（roster 还会带 **unowned** job，必须过滤，见第 8 节）；
  `running` = `status ∈ {running, stopping}`。
- 为什么不塞进 `status`：
  1. job registry 是**进程本地**的（`dsh-jobs-local`），dsh 重启/实例停止后这些 job 根本不存在，
     一旦落库就会把「上一次的 2 个任务」永久冒充现状；
  2. 它跟文件索引的 60s 快照 / 10s 宽限没有关系，写库只会造成「又一类会冻结的徽标」；
  3. 落库还要为每帧 roster 触发一次 DB 写 + SSE，纯属放大。
- 这就是 intervention 的两层设计（`docs/intervention-approval-persistence.md`）：
  「数据只存在于运行时」→ 内存 overlay，API 输出时才合并；断流即清空（`src/dshhome/pending-interactions.js:20-60` 的三条边界）。

### 2.3 为什么不做「同一个 status JSON 装全部」

| | 子代理 | 后台任务 |
|---|---|---|
| 数据在哪 | 投影（持久）+ `session/list`（实时） | 仅进程内存（无投影） |
| 离线/只读可见 | ✅ | ❌（本质不可见） |
| 断流后的正确值 | 文件索引 60s 内重建，与 `kind` 同 lease | 未知（必须消失） |
| 结论 | 进 `status` JSON | 独立 overlay |

---

## 3. 展示面：卡片怎么画

### 3.1 插入点（唯一）

`src/web/components/recent-sessions.js:94-104` 的 meta 行，顺序是：
项目 chip → 实例 chip → 子代理身份 chip(:97) → 旧计数(:98) → 已保存 → 历史 → **上下文条(:101)** → 活跃时间(:102,
`margin-left:auto`，见 `src/web/index.html:390`) → sid。

「上下文右侧」= **紧跟 `:101` 的 `${pressureBar(s.contextPressure)}` 之后**（DOM 里紧邻；`active-time` 的
`margin-left:auto` 会自动把剩余空白吃掉，所以新元素不会被顶到最右，也不会挤掉活跃时间）。
`pressureBar` 在无 `contextPressure`（liveOnly / Codex 行）时返回 `''`，新元素自然前移 —— 可接受。

插入后的结构：

```html
<div class="meta session-meta">
  …chips…
  <div class="context-usage …"><span>上下文 45%</span><div class="pressure" …>…</div></div>
  <span class="session-secondary agent-load" data-agent-load="running"
        title="子代理 3 个（3 个正在运行）；后台任务 2 个（1 个运行中）">
    子代理 3（3 运行） · 后台任务 2（1 运行）
  </span>
  <span class="active-time" …>2m ago</span> …
</div>
```

### 3.2 显示规则

- **只在 `sessionState(s).kind === 'running'` 时画**（与 `data-status="running"` 同一判定，`recent-sessions.js:81`；
  `sessionState` 见 `src/web/components/session-state.js:8-22`）。空闲/已完成卡片不画 —— 避免把历史计数当现状。
- **计数与 `showSubagents` 开关解耦**：开关是「是否列出子代理会话卡」（`subagent-visibility.js`），不是
  「是否说明父会话有几个子代理」。因此：
  - 保留 `:97` 的子代理**身份** chip（`子代理`）；
  - **删除** `:98` 的旧计数 `${showSubagents && status.subagents > 0 ? … 'N 子agent' …}`（避免同一张卡出现两次）；
  - 同步把开关 title 里的「及子代理数量提示」删掉（`src/web/components/session-state.js:180` 的
    `title="显示或隐藏已索引的子代理会话及子代理数量提示"` → 「显示或隐藏已索引的子代理会话」）。
- **没有数据就不画**，绝不画 0：
  - 只有总数 → `子代理 3`；只有运行数（防御性：例如将来只从实时覆盖层拿到 running）→ `子代理 3 运行`；两者都有 → `子代理 3（3 运行）`；
  - jobs 同理：`后台任务 2（1 运行）` / `后台任务 1 运行`；
  - 两个分量都没有 → `return ''`（整个 span 不出现，连 `·` 也不出现）。
- **数字归一**：沿用 `session-state.js:20` 的写法
  `Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : null`。
  数字来自库/外部 dsh，虽然「本来就是个数字」，但仍要守卫（`web-session-state.test.js:34` 已经用
  `subagents: '"><img src=x>'` 锁过这条底线）。
- `title` 是**纯文本**：固定模板 + 数字；v1 **不要**把 job 的 `label/progress/kind` 放进 title
  （producer 自由文本，属于存储型 XSS 面）；若将来要放，必须 `esc()`（渲染端约定见
  `session-state.js:38,136`，`web-render-safety.test.js` 会盯着）。
- 文案里带「运行中/正在运行」字样，避免被读成并发数；无实时通道时 title 可加
  「后台任务需要实时通道，只读/离线实例看不到」（与 `sessionStatusChip` 的 `unobserved` 文案同风格，
  `session-state.js:185-197`）。

### 3.3 CSS

- 复用 `src/web/index.html:312` 的 `.session-secondary { color: var(--dim); font-size: 11px; }`，
  与 `.context-usage`（`:308-311`）相邻，视觉一致。
- 可选（非必需）：`:312` 后加一行 `.agent-load { font-variant-numeric: tabular-nums; }`，
  避免 3s 级更新时「1 → 10」抖动宽度。
- **不需要**新 chip 样式、不需要改 `.session-meta` 布局（meta 行本身 `flex-wrap: wrap`）。

---

## 4. 契约与降级

### 4.1 已确立的模式：键存在=已观测，缺键=未知

| 先例 | 位置 | 表达 |
|---|---|---|
| intervention 投影 | `src/dshhome/live-status.js:356-378` | 实时 status 里**有 `intervention` 键（含显式 null）**=实时确认；缺键=旧版 dsh 没报，保留文件侧值 |
| 未读跃迁 | `src/dshhome/store.js:287-302` | `observedAt` 有/无决定「真完成」还是「冻结降级」 |
| 新鲜度 | `src/lib/status.js:15-30` | `observedAt` 缺失 → 退回只看 lastActivity（不做无根据的断言） |
| 观测盲区 | `src/server.js:206-216` + `/api/homes` `:505-519` | `false`=看不到，`null`=不适用；前端明确写「无实时通道」而不是显示 0 |
| 实时保护 | `src/dshhome/store.js:698-721` | 只有通道活着（`LIVE_GRACE_MS`）才让步 |

新增字段必须完全遵守这套语义：**能判定的会话才有键，不能判定的会话没有键**。

### 4.2 为什么 job 计数不能写 0、也不能落库

- 0 是**断言**（「现在没有后台任务在跑」），而「看不见」不是 0。把「无实时通道」写成 0 就是
  `docs/intervention-approval-persistence.md` 里记录的那类事故（只读实例上在等审批，界面写「待介入 0」）。
- job registry 进程本地：hwb 重启、dsh 重启、SSE 断流后，覆盖层必须**整体消失**而不是保留最后值。
  intervention 的注释把这条写成硬约束（`pending-interactions.js:44-55`「断流即清空」）：
  「否则界面上会挂着幽灵等待审批（人已经批过了，标记还在）」。job 同样成立（任务早跑完了，徽标还挂着）。

### 4.3 场景矩阵

| 场景 | 子代理总数 | 子代理运行中 | 后台任务 | UI |
|---|---|---|---|---|
| 普通 dsh（有实时通道） | ✅ 投影/实时 | ✅ 实时 `running` join | ✅ overlay | 全量 |
| 本地只读 dsh（`readOnly:1`，本机主场景） | ✅ 投影 | ✅ 投影 join（实测有效，见附录） | ❌ 未知 | 只画子代理 |
| 远端实例、通道可达 | ✅ | ✅（同 dsh） | ✅（job 流；带宽见风险 8） | 全量 |
| 远端实例、SSH/隧道断 | ✅ 上次索引 | ✅ 上次索引（受 30min 闸门） | ❌ 未知（overlay 清空） | 只画子代理 |
| dsh 版本 < job API | ✅ | ✅ | ❌（流打开失败→静默） | 只画子代理 |
| Codex / WorkBuddy | ❌ 无该投影 | ❌ | ❌ | 不画（不是「盲区」，`liveAgentLoad:null`） |
| liveOnly 行（只在实时列表里） | ✅ 实时 | ✅ 实时 | ✅（若有流） | 全量；幽灵清理后一起消失 |
| 子会话被归档/未索引 | ✅ 总数 | ❌ 不写键（未知） | — | 只画总数 |

### 4.4 体积 / 写入 / 广播预算（实测）

本机 `~/.hwb/hwb.db`（只读查询，2026-10-28）：

- `sessions` 总行数 2691；`status` 非空行 2691，合计 **233,876 B，均值 87 B，最大 125 B**。
- `subagents > 0` 的父会话当前 **5 行**；`kind=running` 的 **6 行（全部来自 readOnly 实例）**。
- `subagentsRunning` ≈ `"subagentsRunning":3,` = 21–23 B/父会话。即使 1000 个父会话，也只 +23 KB（占 status 总量 10%）。
- 写入放大：`applyLiveStatus` 逐行比较（`store.js:961-965`）→ 计数不变就**不写**；`#updateLiveRows`
  只 `UPDATE` 变化行（`:996-1005`）。父会话是「个位数」量级，每轮最多几条 UPDATE。
- **反面**：不要把 job 列表（id/label/progress/status）塞进 status JSON —— 每个 job 几十到几百 B，
  且 status 在运行期间每 3s 可能被重写，属于「用 DB 写放大换一个进程本地状态」。
- SSE：`agent-load:updated` 的 payload 只放 `{homeId}`（~20 B），前端收到后合并刷新（120ms 去抖，
  `app.js:2006-2012`）。若把计数直接塞进 payload，就得在断线重连时处理「错过事件」——而覆盖层断流即清空，
  重连后必须重新取数，反而更复杂。

---

## 5. 最小改动清单

### S0 —— 真正的 MVP：**只改 1 个前端文件**

`src/web/components/recent-sessions.js`：删除 `:98` 的旧计数，在 `:101` 之后插入一个只读 `status.subagents`
的 span（运行中卡片始终显示）。**后端零改动**（字段早就在库里/接口里，已验证：`/api/sessions/recent` 返回
`status.subagents`）。适合先上线验证视觉与文案。

### S1 —— 子代理「运行中」计数（2 个数据点 + 1 个渲染点，零新通道 / 零迁移）

1. **`src/lib/status.js`**（`subagentStatus` 旁，`:56-81` 之后）
   - `export function subagentCatalogIds(raw)`：两种形状都收
     （wire `[{id,...}]`；磁盘 `{head:{values:[{childId,...}],previous}}`，见 `:64-79` 现有处理），
     去重、只收非空字符串、上限 64（超出不计数并在调用方视为未知）。
   - `export function annotateSubagentRunning(sessions)`：输入 `[{sessionId, status, childSessionIds?}]`
     （`status` 已由 `deriveSessionStatus` 算好）。实现口径（**可判定才写**）：
     1. `byId = Map(sessionId → status)`；
     2. 若父行 `status.kind !== 'running'` → 跳过（不写键）；
     3. 若 `childSessionIds` 为空/未提供 → 跳过；
     4. 若 **任一** childId 不在 `byId` 里（子会话没被索引/已归档）→ 跳过（**未知，不当 0**）；
     5. 否则写 `status.subagentsRunning = childSessionIds.filter(id => byId.get(id).kind === 'running').length`
        （全部找到但一个都没跑 → 写 0，这是**已观测的 0**）。
     原地修改并返回同一数组（与 `mergeLiveStatus` 的风格一致）。
   - ⚠️ **不要改 `subagentStatus` 的返回形状**：`tests/subagent-visibility.test.js:15-28` 用 `deepEqual` 锁死了它。
2. **`src/lib/schema.js`**：`projcacheRecordToSession`（`:100-134`）把 `childSessionIds` 挂到返回的 meta 上
   （`normalize()` 只拷贝已知字段，见 `src/lib/normalize.js:96-112`，临时字段不会入库）；
   `validateProjcacheJson`（`:135-160`）组装完 `sessions` 后调用 `annotateSubagentRunning`。
3. **`src/lib/read-home.js:225-240`**：per-record 合并后
   `snapshot.sessions = annotateSubagentRunning([...projSessions.values()])`（聚合路径已在 schema 做）。
   远端路径 `remote-reader.js` 复用 `buildSnapshot`，自动生效。
4. **`src/dshhome/live-status.js:387-395`** `extractLiveRows`：两遍扫描 ——
   第一遍 `toLiveRow(item)` 得到 `rows`，同时用 `item.running === true ? 'running'`
   （回退 `toLiveRow` 推导出的 `kind`，见 `:352-353`）建 `Map(sessionId → kind)`；
   第二遍对每个 item 取 `subagentCatalogIds(item.projections.values.subagentCatalog)`，
   按上面同一口径给父行补 `status.subagentsRunning`（复用第 1 步的 `annotateSubagentRunning`，
   把「子会话是否在 list 里」换成「是否在上面那张 Map 里」即可；实时 list 里没有的子会话 = 未知）。
   这样两条读路径共用同一套判定，只有「子会话运行信号」的来源不同（`kind` vs `item.running`）。
5. **`src/web/components/session-state.js:20`**：`sessionState()` 增加 `subagentsRunning`（同一 Number 守卫）；
   **`src/web/components/recent-sessions.js:101` 之后**插入 `agentLoadSlot(s)`（第 3.2 节规则）。
6. （可选）`src/web/index.html:312` 后加 `.agent-load { font-variant-numeric: tabular-nums; }`。

### S2 —— 后台任务数（新实时覆盖层；依赖 `agent-load-dsh.md` 的 wire 结论）

1. **`src/dshhome/pending-interactions.js`**：把 `createRemoteMuxTransport`（`:313-317` 契约注释、`:319` 起）
   参数化 `endpoint/payload`（默认值保持 `$events`），供第二个观察者复用 —— **不要写第二份 WebSocket/mux 实现**。
2. **新文件 `src/dshhome/agent-load.js`**：`AgentLoadWatcher`
   - 覆盖层 `homeId → Map<sessionId, { jobs, at }>`；
   - `update(homeId, runningSessionIds)`（由 poller 回调喂，不读 DB）；只对 running 会话开流，
     每 home ≤8 / 全局 ≤32，超出不订阅（该会话 `jobs` 未知，不冒充全量）；
   - 每会话一条 `job.list` 逻辑流，args `{sessionId}`（端点名以 `agent-load-dsh.md` 实测为准）；
     帧形状 `{type:'rows', jobs:[…]}`；
   - **只统计 `job.owner === sessionId`**（roster 含 unowned job，否则每个会话都会数进同一批全局任务）；
     `running` = `status ∈ {running, stopping}`；
   - 流 `end/error/close`、home 移除、`stop()` → **删除覆盖层条目**（不是写 0）；
   - 计数变化才广播 `agent-load:updated`，去抖 50–200ms（参考 `pending-interactions.js:88,1296-1319`）；
   - `apply(rows)`：与 `withInterventions` 同契约（不注入时行为逐字节不变、不改形状、异常返回原行）；
     合并键必须是 `(homeId, sessionId)` 二元组（多 home 同名会话），照抄 `pending-interactions.js:708-735`。
3. **`src/server.js`**：构造 watcher；`livePoller` 增加 `onLive(homeId, live)` 回调
   （`live-poller.js:148-150` 旁，`applyLiveStatus` 成功后调用）；`/api/homes` 增加
   `liveAgentLoad`（谓词同 `liveInterventionUrl`，`:212-216`）；shutdown 时 `stop()`（`server.js:335-345` 的 shutdown 序列）。
4. **`src/api/routes.js`**：`createRouter` 参数 `agentLoad = null`（`:214`）；新增 `withJobs`
   紧邻 `:229-243`；`/api/sessions/recent`（`:1064`）与 `/api/search`（`:1086`）各串联一次。
   **不新增路由** → README 的 REST API 表不用改（`tests/docs-consistency.test.js` 会双向校验 routes.js 与 README）。
5. **`src/web/store.js:26-41`**：加 `es.addEventListener('agent-load:updated', () => cb())`。
6. **`src/web/components/recent-sessions.js`**：同一 slot 里渲染 `s.jobs` 分量（3.2）。
7. （可选）`/api/homes` 的 `liveAgentLoad=false` 用于在筛选条/提示条补一句「N 个实例无实时通道，后台任务看不到」，
   复用 `renderInterventionBanner` 的 coverage 样式（`src/web/components/workbench.js:16-20`）或 `instance-grid.js:52-53`。

---

## 6. 测试

### 新增

| 文件 | 覆盖 |
|---|---|
| `tests/agent-load.test.js` | `subagentCatalogIds` 两形状/去重/上限；`annotateSubagentRunning`（缺失子行→不写键、非 running 父→不写、正常计数）；渲染 slot（只在 running、无 0、`'"><img src=x>'` 不落 DOM、旧 `N 子agent` 不再出现） |
| `tests/schema-agent-load.test.js`（或并入 `tests/schema.test.js`） | projcache（聚合 + per-record）→ `status.subagentsRunning`；`read-home` 端到端（用 `tests/mock-home` 的真实目录形状） |
| `tests/agent-load-ws.test.js`（S2，仿 `tests/pending-interactions-ws.test.js`） | 假 transport 推 `rows` 帧 → 覆盖层计数；断流清空；unowned job 不计入；debounce 只广播一次；超并发上限不订阅 |
| `tests/api-agent-load.test.js`（S2） | `withJobs` 契约：不注入时响应逐字节不变、注入时只加 `jobs` 键、抛错降级为原行；`/api/homes` 的 `liveAgentLoad` 三态 |
| `tests/web-agent-load.test.js` 或并入既有 | title/文案/转义/百分比条并存不互相顶掉 |

### 修改（行为变化，必须同步）

- `tests/web-session-state.test.js:28-35`：`renderRecentSessions(..., {showSubagents:true})` 不再出现
  `class="session-secondary">3 子agent`，改为断言新 slot；`doesNotMatch(/3 子agent/)` 那行保留（旧文案确实不该再有）。
- `tests/subagent-visibility.test.js`：`开关同时恢复子代理卡和数量提示` 用例改写为「开关只影响子代理卡」。
- `tests/live-status.test.js`：`session/list` fixture 增加子会话 + 父 `subagentCatalog`，断言
  `subagentsRunning`；失败路径仍返回 null（不因新字段抛错）。
- `tests/live-merge.test.js`：status 整块合并后新键保留；实时缺键时文件侧值不被清掉（与 intervention 同一套断言）。
- `tests/live-empty-clear.test.js` / `tests/store.test.js`：作为回归（幽灵清理、逐行写、skip-write 判定仍成立）。
- `tests/live-channel-coverage.test.js`：若新增 `liveAgentLoad`，补 `/api/homes` 三态断言 + 前端盲区文案。
- `tests/dashboard-card-distinction.test.js`：若断言了 meta 行内容，补 `data-agent-load`。
- `tests/status.test.js`：`deriveSessionStatus` 的返回值**不应**因此变化（annotate 是后处理）；加一条「不污染」断言。

---

## 7. 风险清单

1. **XSS**：只渲染数字，但数字也要 `Number` 守卫 + 取整（`session-state.js:20` 的既有做法）；
   job 的 `label/progress/kind` 是上游自由文本，v1 不进 DOM；将来进 title 必须 `esc()`。
   测试用 `'"><img src=x>'` 复盘（已有先例 `web-session-state.test.js:34`）。
2. **筛选 / 排序**：计数不参与 `sortPriority`（`session-state.js:148-155`）、不新增 `SESSION_FILTERS`、
   不改 `data-status` → 顺序、筛选项、CSS 全部不变。**明确不要**顺手加「有子代理」排序/筛选（会让「待介入优先」失效）。
3. **子代理会话默认隐藏**：计数与开关解耦后，总数包含被隐藏的子代理会话（这正是「这个父会话有几个子代理」的语义）；
   旧 `N 子agent` 提示删除后必须改 toggle 的 title，否则「承诺与行为不符」。
4. **SSE 重连**：断流 → overlay 清空 → `jobs` 键消失 → 前端隐藏（不是 0）。`subscribe` 的重连回调会补一次全量刷新
   （`app.js:2021-2034`），不需要事件重放；payload 因此只放 `{homeId}`。
5. **广播放大**：一个 job 生命周期提交 = 1 条 SSE + 前端 1–2 个 GET；必须「计数变了才发」+ 去抖。
   子代理计数的变化走已有 `index:updated`（120ms 合并），不需要新事件。
6. **DB 膨胀**：`subagentsRunning` ≈ +22 B/父会话（实测 status 均值 87 B、全量 233 KB）；**绝不能**把 job 列表写进 status。
7. **性能**：annotate 是 O(会话数 + 子代理数) 的内存操作；`read-home` 本来就要遍历全部会话；
   live 侧多一遍 map，无额外 I/O。job 流数量由「running 会话数」约束（本机实测 running=6）。
8. **远端低带宽**：job 流只在 running 会话、只在生命周期边沿推帧（每帧 ~1–2 KB），对比 `session.list`
   129 KB/3s（`docs/research/hwb-wire-audit.md` §A.2）可忽略；但 running 会话多时要截断且**不冒充全量**。
9. **只读 / 无实时通道实例**：本机 6 条 running 全部来自 `readOnly` 实例（`liveIntervention:false`）——
   所以「子代理运行数」必须能用投影算（S1），否则最需要它的卡片反而没有。jobs 在这类实例上永远未知，
   UI 不能暗示「没有任务」。
10. **多 home 同名会话**：overlay 按 `homeId` 分 Map，合并必须 `(homeId, sessionId)` 双键匹配；按 sessionId 单键会串实例。
11. **Codex / WorkBuddy**：没有 `subagents` 投影 → 不画；`liveAgentLoad` 用 `null`（不适用），
    不能算进「N 个实例无实时通道」的盲区文案（与 `liveIntervention` 三态同理，`routes.js:505-519`）。
12. **语义误读**：「子代理 3」是历史总数，不是 3 个并发；文案必须带「（N 运行）」或明确写「子代理 3」，
    title 里解释「含已完成的子代理」。

---

## 8. 依赖 / 待验证（不阻塞 S0/S1）

- **job 的远程端点名与 open payload**：dsh FaceModel 是 `job/list`（`@deepseek-ai/dsh-api-job-controller`，
  `JobListRequest{sessionId}` / `JobListFrame{type:'rows',jobs:JobView[]}`），远程端点可能是 `job.list`；
  需 `agent-load-dsh.md` 的实测确认。另见 `src/control/proxy-cache.js:175` 已把 `jobs` 列入只读命名空间白名单。
- **一条 mux socket 是否允许多条逻辑流**：现有 transport 一个连接一条流（`pending-interactions.js:313-317,319`）；
  若允许，S2 可与 intervention 共用 socket 降连接数（否则每 home 多一条 WS）。
- **job roster 是否保留已结算 job**：决定 `total` 的语义。若不保留，`total ≈ running`，
  UI 就只画 `后台任务 N 运行`（别画括号）。
- **unowned job 会出现在每个会话的 roster 里**（dsh-jobs 的 archive-admission 描述：`registry.list(owner)` 返回
  「own + unowned」），必须 `owner===sessionId` 过滤，否则所有会话显示同一批全局任务。
- **旧版 dsh**：`job.list` 不存在时流会 `error/end`，必须静默清空覆盖层（不能把 home 标 degraded，
  与 `live-poller.js:143-150` 的降级语义一致）。

---

## 附录：本文用到的实测数据（2026-10-28，只读）

```
# 本机 ~/.hwb/hwb.db（node:sqlite readOnly）
status 非空行 2691，SUM(LENGTH(status)) = 233,876 B，均值 86.9 B，MAX 125 B
status.kind 分布：idle 2513 / completed 172 / running 6
running 6 行全部来自 homeId=260a7a19（别名「大肥鱼桌面版」，readOnly=1，liveIntervention=false）
subagents>0 的父会话 5 行；示例：{"kind":"running","label":"运行中","subagents":3,…,"approval":"ask"}

# 投影 join 实测（~/.dsh/storages/session_projcache/sessions + hwb.db）
父 session-84fb9d81：catalog childId = [0d33277e…, d0404ca3…, 62a902f3…]
  → 三条子会话行均存在且 kind=running（isSubagent=true）  ⇒ subagentsRunning = 3
父 session-43cc398b：catalog childId = [cbe6f3da…]
  → 子会话行 kind=running                                ⇒ subagentsRunning = 1
（两个父行都来自没有实时通道的只读实例 —— S1 的投影 join 不是可选优化，而是本机唯一可行路径）
```
