# Codex / WorkBuddy 侧：子智能体数与后台任务信号的本地可得性

> 调研任务：task-2（共享任务板）。范围：**只**回答「仅凭本机落盘元数据（只读、可降级）」，Codex 与 WorkBuddy 能否为 hwb 提供
> ①会话的**子智能体数**（总数 / 运行中）②**后台并行任务数**（含运行状态）。
> 产出边界：只写本文档；未改 `src/`、`tests/`；未写任何第三方库。
>
> 观测时刻：2026-10-28 13:40–13:50（Asia/Singapore，UTC 05:40–05:50）。本机 macOS，Node **v22.21.1**（`node:sqlite` 内置）。
> 行文约定：**[实测]** = 本次在本机真实库上跑出的表/列/取值/行数/耗时；**[推断]** = 由 schema、迁移脚本、日志或跨库一致性推出的结论，未经直接观测。
> 所有打开方式见 §2；下文 SQL 均可直接复跑（附录 §10 有复现命令）。

---

## 1. 结论摘要（先给答案）

| 信号 | Codex | WorkBuddy |
|---|---|---|
| 子智能体**总数**（按会话） | **能（推荐做）**。`thread_spawn_edges` 与 `threads.source` 的 `thread_spawn` JSON **一一对应，490/490 全覆盖**；可按父线程/会话聚合，可直接展示。 | **不能**。库里没有父子会话列、没有 agent 列；`group_id/group_title/expert_runtime_identity` 本机全为 NULL 且语义不是子代理（见 §4.2）。 |
| 子智能体**运行中** | **部分能**。需 join `thread_history_1.sqlite` 的 `thread_turns`，并用 `threads.updated_at_ms` 做 ≤180s 新鲜度门限；本机实测当前 **0 个运行中**（子线程侧 0 条 inProgress）。僵尸 inProgress 真实存在（15 条，44–107 天）。 | **不能**（没有子智能体，运行中无从谈起）。 |
| 后台**并行任务**（含运行状态） | **不能**（单靠落盘元数据）。全库遍历没有「background terminal / job / task / process」的会话级投影；唯一像 job 的是 Codex 内部**记忆抽取队列**（`memories_1/…` 的 `jobs` 表，以 done 为主、1 条 pending、1 条 error，当前无 running）与**定时心跳 automations**（5 条全 PAUSED、0 次 run）。真正的后台终端属于 app-server/进程侧。 | **部分能，但不是会话级并行任务**。`automation_runtime_state.running` 是可直接读的运行态（本机 0）；`automation_runs` 有 64 次历史运行（严格串行，0 重叠）。但每次 run **自己就是一个会话**（`is_background_automation=1`），不是某会话下并行的 N 个任务。 |
| 会话**运行态**（旁证） | 能（`thread_turns` + 3 分钟窗口，hwb 已有）。 | 弱。`sessions.status='working'` 本机 2 条，`last_activity_at` 停在 2026-09-12（46 天前）→ 无新鲜度门限会永久「运行中」。 |

**一句话**：Codex 的子智能体是**一等公民元数据**（可做、成本低、重启后仍可信）；Codex 的后台任务是**元数据黑洞**（必须 app-server/进程侧，别从库里猜）。WorkBuddy 的子智能体**不存在**，后台任务**只有单条 scheduled automation 的运行态**，且它产出的是独立会话而不是会话内并行任务。

---

## 2. 方法与可复现性

### 2.1 只读打开（两条路，与仓库现有实现一致）

```js
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

// 1) 常规只读：库在跑（-wal/-shm 存在）时一致性最好
new DatabaseSync(file, { readOnly: true });

// 2) 降级：WAL 恢复需要写权限，只读连接可能「能 open 但第一条查询报 attempt to write a readonly database」
//    或无 -shm 时直接 open 失败；此时用 immutable=1 读主文件快照（前提：当前无写者）
new DatabaseSync(`${pathToFileURL(file).href}?immutable=1`, { readOnly: true });
```

- [实测] `~/.codex/state_5.sqlite`、`~/.codex/thread_history_1.sqlite`、`~/.workbuddy/workbuddy.db` 本次均可走路径 1（观测时 `-wal` 均为 0 B）。
- [实测] `~/.codex/goals_1.sqlite`、`memories_1.sqlite`、`memories_v2_1.sqlite` 走路径 1 直接 **`unable to open database file`**（WAL 无 `-shm`），必须走 `immutable=1` 才能读到表。这**实证了 `src/codexhome/reader.js` 的 `withThreadsDb` 双路降级不是过度设计**；也说明「多库、多 journal 状态」是新读取器必须继承的模式。
- 全程未执行任何写语句；未触碰 `src/`、`tests/`。

### 2.2 扫描面（数据面清单）

| 位置 | 规模 [实测] | 内容 | 与本题关系 |
|---|---|---|---|
| `~/.codex/state_5.sqlite` | 24.5 MB；`threads` 2,347 行、`thread_spawn_edges` 490 行、`guardian_review_feedback` 23 行 | 会话投影 + spawn 父子边 | ★ 子智能体唯一权威源 |
| `~/.codex/thread_history_1.sqlite` | **1,102 MB**；`thread_turns` 12,215 行、`thread_items` 179,867 行 | turn 生命周期 / 会话正文投影 | ★ 运行态来源（只碰 `thread_turns`，不扫 `thread_items`） |
| `~/.codex/logs_2.sqlite` | 78 MB / 32,140 行 | 应用日志 | 用于排除「后台终端」存在性 |
| `~/.codex/queue_1.sqlite` | `queued_items` 0 行 | 待发消息队列（不是任务队列） | 排除 |
| `~/.codex/sqlite/codex-dev.db` | `automations` 5 行、`automation_runs` 0 行、`local_thread_catalog` 418 行 | 桌面端同步库 | 心跳调度（近似「后台任务」） |
| `~/.codex/memories_1.sqlite` / `memories_v2_1.sqlite` | `jobs` 299 / 166 行 | Codex 内部记忆抽取 job 队列 | ★ 唯一真正的 job 表（但语义不同，见 §3.6） |
| `~/.codex/goals_1.sqlite` | `thread_goals` | 目标续跑（goal continuation） | 旁证：不是任务 |
| `~/.codex/*.json`、`.codex-global-state.json`（1.1 MB） | — | 桌面端 UI 状态 | 无 background/terminal/job 键 |
| `~/.codex/sessions/**/*.jsonl` | **5.1 GB** / 361 个 | rollout 会话正文 | 只用首行 `session_meta` 做交叉验证（不扫正文） |
| `~/.workbuddy/workbuddy.db` | 9.1 MB；`sessions` 176 行、`automation_runs` 64 行 | WorkBuddy 元数据 | ★ 两个信号的全部来源 |
| `~/.workbuddy/tasks/<sessionId>/<n>.json` | 30 个会话 / 118 个 task 文件 | 会话内 plan/待办清单 | 辅助信号（不是子代理、不是后台任务） |

---

## 3. Codex

### 3.1 `threads.source` 与 `thread_source` 是两个不同维度（必须分清）

[实测] 2,347 条线程的分布：

| `thread_source` | 行数 |
|---|---|
| `guardian_review` | 1,396 |
| `subagent` | **514** |
| `user` | 416 |
| `NULL` | 19（`source='vscode'`，老版本没写 `thread_source`） |
| `voice_chat` | 2 |

而 `threads.source` 是**原始来源 JSON**，三种形态：

```jsonc
// A. 真实 spawn 子线程（490 条）：parent/depth/agent_path/agent_nickname 全在里面
{"subagent":{"thread_spawn":{"parent_thread_id":"01a13f00-58f1-7273-bc07-adcfc008dc2b",
 "depth":1,"agent_path":"/root/source_audit","agent_nickname":"Pascal","agent_role":null}}}

// B. Guardian 自动安全审查（1,420 条）：只有 other:'guardian'，没有父线程
{"subagent":{"other":"guardian"}}

// C. 普通用户来源：'vscode'（411）/ 'exec'（20）/ 'cli'（6）
```

**关键陷阱 [实测]**：`thread_source='subagent'` 的 514 条 = 490 条真 spawn + **24 条 guardian**（`source` 仍是 `other:'guardian'`）。所以：

- 用 `thread_source='subagent'` 当「子智能体总数」→ **514，虚高 24**；
- 用 `thread_source='guardian_review'` 当「自动审查总数」→ **1,396，漏 24**；
- 正确口径只有两个：`thread_spawn_edges`（490）或 `threads.source LIKE '%thread_spawn%'`（490）。

[实测] 两者完全等价（详情见 3.2）。且 2,347 条线程里 `agent_role` **全为 NULL**，`agent_nickname/agent_path` 只在 490 条 spawn 线程上非空 —— 不能指望用 `agent_role` 区分。

### 3.2 spawn 覆盖验证：`thread_spawn_edges` 就是完整答案

[实测] `thread_spawn_edges` 只有三列 `(parent_thread_id, child_thread_id, status)`，490 行：

| 校验项 | 结果 |
|---|---|
| `child_thread_id` 全部存在于 `threads` | 是（490/490） |
| `parent_thread_id` 全部存在于 `threads` | 是（490/490） |
| `source` JSON 里的 `thread_spawn` 线程数 | 490 |
| 「spawn JSON 有、edges 没有」 | **0** |
| 「edges 有、spawn JSON 没有」 | **0** |
| rollout 首行 `session_meta.parent_thread_id` 与 edges 一致（能读到 rollout 的 49 条样本） | 49/49 一致，0 不一致 |

→ **edges 是 spawn 关系的权威投影，无缺行、无孤儿**。`threads.source` JSON 可作为等价校验源（也能拿到 `depth`/`agent_nickname`/`agent_path`，edges 没有这些）。

[实测] 结构：

- 父线程 100 个：87 个 `thread_source='user'`（用户会话）+ **13 个 `subagent`**（嵌套 spawn）。
- 深度：`depth=1` 471 条，`depth=2` 19 条；最大深度 2。
- `thread_spawn_edges.status` **490 行全部是 `'open'`**，无 `closed`/其它取值；最老的一批（43 天前）仍是 `open`。
  → **[推断] `status` 不是生命周期，不能拿它判断「子代理是否结束/存活」**；同理不能用 `COUNT(status='open')` 当运行中。
- 子线程 `project_id` **全为 NULL**（490/490），父线程也全 NULL（`threads.project_id` 整表 0 条非空）→ 项目归属只能走 cwd / 桌面端 `thread-project-assignments`；好在**子线程 cwd 与父线程 100% 相同**（490/490），所以按父线程归项目是安全的。
- 归档：8 条 spawn 子线程 `archived=1`，3 个用户父线程 `archived=1` —— 计数时要明确「是否含已归档」。

[实测] 每父直接子数 Top（`state_5`，0.86 ms）：

| 父线程 | 名称 | 直接子 | 子树（含 depth=2） |
|---|---|---|---|
| `01a13b38-…2309` | 比较不同基座模型性能 | 59 | **71** |
| `01a0fd38-…fda8` | 构建病原复核 Web UI | 42 | 44 |
| `01a114e1-…46f4` | 分析4710 checkpoint评准确 | 35 | 35 |
| `01a128ad-…1d0d` | 试试微调模型的学习总结 | 24 | 26 |
| `01a0b7eb-…b266` | 评估文章投稿准备度 | 22 | 22 |

口径差异很实在：同一会话「**直接 59**」vs「**含嵌套 71**」——展示必须注明 `countScope`。87 个 user 根会话的子树求和 = **490**（与 edges 总数一致，无重复计入）。

### 3.3 运行中子智能体：必须 join `thread_turns`，且必须带新鲜度门限

`threads` 表没有运行态。运行态在 `thread_history_<N>.sqlite` 的 `thread_turns`
（列：`thread_id, turn_id, rollout_ordinal, status, started_at, completed_at, duration_ms, root_turn_id …`；`status ∈ inProgress / completed / interrupted / failed`，本机 12,215 行）。

- 有 `CREATE UNIQUE INDEX idx_thread_turns_page ON thread_turns(thread_id, rollout_ordinal)` → 「每线程最新 turn」可走索引（实测 15.5–23.6 ms / 12,215 行，3 次观测）。
- hwb 现行判据（`src/codexhome/reader.js` + `src/codexhome/index-rows.js`）：
  **最新 turn = `inProgress` 且 `threads.updated_at_ms` 在 180 s 内** → `running`；无 turn / 陈旧 → 未知。
- [实测] 这个 180 s 窗口是**宽裕的**：对 1,643 条「最新 turn 已收尾」的线程，`threads.updated_at_ms - completed_at` 的差值：
  **1,467 条 ≤1 s**、19 条 1–10 s、13 条 10–30 s、43 条 30–180 s、101 条 >180 s。
  按来源拆：`guardian_review` 730 条最大差值 0.995 s；`subagent` 490 条里只有 4 条 >180 s（多为被 resume 续跑的线程）；`user` 线程有 148 条 >180 s（标题生成 / 恢复 / 读回执都会刷新 `updated_at`）。
  → **[推断] 对子线程而言 `updated_at_ms` ≈ 最后活动时间，180 s 门限不会误杀掉真正在跑的 turn；对用户线程则更保守。**
- [实测] 僵尸 turn 真实存在：`inProgress` 15 条，`updated_at_ms` 距观测时刻 **44.5–106.8 天**，全部是 `user` 线程（与 reader.js 注释一致）。子线程侧当前 **0 条 inProgress**。
- [实测] 当前「运行中子智能体」= **0 / 490**（按 3 分钟窗口；父线程维度也是 0 个父线程有运行中子代理）。

**可执行 SQL（跨两个库，两步 + JS join；不要试图一条 SQL 跨库）**

```sql
-- ① state_5.sqlite：全部 spawn 边 + 子线程新鲜度（走 idx_thread_spawn_edges_parent_status）0.86 ms / 490 行
SELECT e.parent_thread_id AS p, e.child_thread_id AS c, t.updated_at_ms
FROM thread_spawn_edges e JOIN threads t ON t.id = e.child_thread_id;

-- ② thread_history_1.sqlite：每线程最新 turn（走 idx_thread_turns_page）≈16–24 ms / 12,215 行 → 1,677 行
SELECT t.thread_id, t.status, t.started_at, t.completed_at
FROM thread_turns t
JOIN (SELECT thread_id, MAX(rollout_ordinal) AS m FROM thread_turns GROUP BY thread_id) x
  ON x.thread_id = t.thread_id AND x.m = t.rollout_ordinal;
-- 定向优化：若只为子代理徽标，可加 WHERE thread_id IN (<490 个 child_id>) → 13.8 ms
```

```js
// ③ JS 侧聚合（实测 4.4 ms）
const now = Date.now(), STALE = 180_000;
const turn = new Map(turnRows.map(r => [r.thread_id, r.status]));
const agg = new Map(); // parentThreadId -> { total, running }
for (const e of edgeRows) {
  const a = agg.get(e.p) ?? { total: 0, running: 0 };
  a.total++;
  const fresh = Number.isFinite(e.updated_at_ms) && now - e.updated_at_ms >= 0 && now - e.updated_at_ms <= STALE;
  if (turn.get(e.c) === 'inProgress' && fresh) a.running++;
  agg.set(e.p, a);
}
```

会话（user 根）维度再加一步递归（子树口径，实测 24 ms）：

```sql
WITH RECURSIVE roots(id) AS (SELECT id FROM threads WHERE thread_source = 'user'),
tree(root_id, child_id, depth) AS (
  SELECT r.id, e.child_thread_id, 1 FROM roots r JOIN thread_spawn_edges e ON e.parent_thread_id = r.id
  UNION ALL
  SELECT t.root_id, e.child_thread_id, t.depth + 1
    FROM tree t JOIN thread_spawn_edges e ON e.parent_thread_id = t.child_id
)
SELECT root_id, COUNT(*) AS total, MAX(depth) AS max_depth FROM tree GROUP BY root_id;
-- 87 个 root 命中，合计 490，最大 depth=2
```

### 3.4 `guardian_review`：为什么它必须被排除（用户看到的「1 个子智能体 vs 1396 个自动审查」）

[实测] guardian 线程 1,420 条（`source` JSON 口径；`thread_source` 口径 1,396 + 24 条错标为 `subagent`）：

| 事实 | 数值 |
|---|---|
| 时间范围 | 2026-07-19 → 2026-10-28；最近 7 天 160 条、最近 24 h 10 条 |
| 是否出现在 `thread_spawn_edges` | **0 / 1,420** |
| 是否被父线程的 `subAgentActivity` 引用 | **0** |
| `thread_turns` 总数 | 7,706 completed / 43 interrupted / 33 failed（**是真实运行活动，不是空壳**） |
| 能否归因到父会话 | 只能间接、且残缺：`guardian_review_feedback`（23 行）的 `record.reviewed_thread_id` 可归因 14 个会话；rollout 首行 `session_meta.parent_thread_id` 可归因 74 条（仅存活的 rollout 文件）。对全部 1,420 条**没有**完整父子表 |
| 单会话最多 guardian | 53 条（`01a13b38…`，该会话真 spawn 59 条） |

结论：**guardian 是「对某个动作做安全评估」的自动审查会话，不是用户会话的子智能体**。

- 若把 guardian 计进子智能体：全局 490 → **1,910**（×3.9）；头部会话会从「71 个子代理」变成「71 + 53 个 guardian」，卡片语义直接失真。
- 若用 `thread_source IN ('guardian_review','subagent')` 做「自动会话」排除（hwb 现行 `AUTOMATED_SOURCES`）：对**隐藏会话列表**是对的；但**不能用它来数子智能体**（口径混了）。
- 若想展示「自动审查次数」：可以，但应作为**独立的全局指标**（不挂会话卡），且必须能接受「1,396 vs 1,420」这种 `thread_source` 漏标。

### 3.5 「后台任务」排查：逐处负证据（结论：不可得）

题目要求「遍历 `~/.codex` 下 SQLite 表与 app 状态文件，找 background/job/task/process/terminal」。逐处结果：

| 位置 | 检索 | 结果 |
|---|---|---|
| `state_5.sqlite` 全部 17 张表 | 表名/列名含 background/job/task/process/terminal | **没有任何 job/terminal/background 专用表**；关键词只命中泛化的 `status` 列（如 `thread_spawn_edges.status`、`backfill_state.status`），与后台任务无关 |
| `thread_history_1.sqlite` | `thread_items.item_type` 全量分布 | 16 个类型：`reasoning`/`commandExecution`/`agentMessage`/`subAgentActivity`/`mcpToolCall`/`fileChange`/`webSearch`/`collabAgentToolCall`/`sleep`…… **无 background/terminal/job 类型**；`item_json` 里 `"background"` 作为 JSON 键**只有 1 条**（命令文本/输出里的字面词） |
| `logs_2.sqlite`（32,140 行） | `background terminal` / `background_terminal` / `process_manager` | **0 命中**；命中的 1,625 条 `background` 全是 `feedback_tags` 的 span 文本与 `codex_guardian_v2::async_scorer`（「guardian_background_scoring」是**同步打分的 span 名**，不是任务） |
| app-server 方法面 | 从日志抽 `rpc.method=` | 只有 `thread/resume, config/read, plugin/installed, getAuthStatus, configRequirements/read, thread/fork, thread/start, model/list, experimentalFeature/list, account/read, permissionProfile/list` —— **没有 background/job/terminal 类 RPC** |
| `.codex-global-state.json`（1.1 MB） | 键名/值含 background/job/terminal/spawn | `background` **0** 次、`terminal` **0** 次、`spawn` **0** 次；`subagent` 38 次全是 UI 状态 `thread-tab-routes-v1:<threadId>.routes[].kind="subagents"`（**有没有「子代理」标签页的界面记忆，不是数量**） |
| `process_manager/chat_processes.json` | 4 条记录 | 字段 `conversationId/turnId/itemId/processId/osPid/command/startedAtMs`，**像**「在跑命令登记表」；但 `startedAtMs` 全是 2026-07-25 前后，文件 mtime 2026-08-02 —— **陈旧且无清理机制**，不能当实时信号 |
| `queue_1.sqlite.queued_items` | 0 行 | 待发送消息队列，不是任务队列 |
| `sqlite/codex-dev.db` | `automations` 5 行 / `automation_runs` **0 行** / `local_thread_catalog.chatgpt_async_status` 全 NULL | `automations` 是 **heartbeat 定时回访**（`kind='heartbeat'`、`target_thread_id` 指向某会话、rrule 如 `FREQ=MINUTELY;INTERVAL=5`），**5 条全部 `PAUSED`**；`automation_runs` 空表 → 没有可展示的运行实例 |
| `memories_1.sqlite` / `memories_v2_1.sqlite` | `jobs` 表 | **有真 job 队列**：`jobs(kind, job_key, status, worker_id, started_at, finished_at, lease_until, retry_at, retry_remaining, last_error, …)`；两库分别 299 / 166 行；`kind ∈ memory_stage1 / memory_consolidate_global`；`job_key` = 线程 id（`memories_1` 的 298 个 stage1 job_key 全部在 `threads` 里）或 `'global'`；状态几乎全是 `done`，仅 1 条 `pending`（`memory_consolidate_global`）与 1 条 `error`，**当前无 running/leased**。这是 **Codex 内部记忆抽取**，与会话里的「后台终端/后台任务」不是一回事。 |
| `sessions/**/*.jsonl` 首行 `session_meta` | `threads.rollout_path` 指向的文件 | 1,910 条 spawn/guardian 线程中**只有 299 条 rollout 文件还在**（1,611 条路径已失效）；[推断] 失效原因是 rollout migration 之后旧 rollout 被清理（`state_5.rollout_migration_state` 有迁移水位，`archived_sessions/` 里大量 `.jsonl.zst`）。**不能把 rollout 当稳定数据源** |

**结论 [实测+推断]**：Codex 的「会话内后台终端 / 并行后台任务」**没有落盘元数据投影**。

- 要拿到它只能：① 通过 app-server（JSON-RPC）实时订阅/查询执行器状态；② 读进程侧（`ps` / 进程树）+ 会话 cwd 归因；③ 读 rollout 正文里的 `commandExecution` 事件（违反 hwb「不读会话正文」边界，且 5.1 GB）。
- 库里能命中的 `memories_1.sqlite.jobs` 与 `automations` 只能作为「**系统级后台作业**」的旁证，**不能**冒充「这个会话正在并行跑 N 个后台任务」。建议在 hwb 里对该信号显式输出 `unavailable`（带 `reason: 'no-local-projection'`），而不是给 0。

---

## 4. WorkBuddy

### 4.1 数据面

`~/.workbuddy/workbuddy.db`（9.1 MB，11 张表）：

| 表 | 行数 [实测] | 相关列 |
|---|---|---|
| `sessions` | 176 | `status/source_mode/conversation_origin/transport/is_background_automation/group_id/group_title/expert_runtime_identity/unread/deleted_at/last_activity_at/project_id` |
| `automations` | **1** | `id='ai'`、`status='ACTIVE'`、`rrule=FREQ=DAILY;BYHOUR=9;BYMINUTE=0`、`next_run_at`、`deleted_at` |
| `automation_runs` | **64** | `thread_id(PK)`、`automation_id`、`status`、`result_success`、`created_at/updated_at`、`runs_json`、`failure_code` |
| `automation_runtime_state` | **1** | `automation_id(PK)`、`running`、`running_started_at`、`running_conversation_id`、`last_run_at` |
| `automation_delivery_outbox` | 0 | 投递队列（本机空） |
| `session_usage` | 123 | `used/size`（上下文占用，hwb 已读但未展示） |
| `buddy_snapshots` / `workspaces` / `workspace_trust_decisions` | 0 / 18 / 5 | 与本题无关 |

### 4.2 WorkBuddy 有没有「子智能体」概念？—— 没有

[实测] 逐列验证：

| 候选 | 实测取值 | 判定 |
|---|---|---|
| `group_id` | **全部 NULL**（176/176） | 不是子代理分组 |
| `group_title` | **全部 NULL** | 同上 |
| `expert_runtime_identity` | **全部 NULL / 空**（0 非空） | 无「专家运行时身份」在用 |
| `expert_id` / `expert_locale` / `expert_marketplace` | 全 0 非空 | 无专家/子代理实例 |
| `conversation_origin` | `NULL` 169、`openapi` 6、`workbuddy-mp` 1 | 是**入口来源**（API / 小程序），不是父子关系 |
| `source_mode` | `craft` 59、`working` 18、`work` 12、`NULL` 87 | 是**工作模式**（craft/working/work），不是子代理 |
| `status` | `completed` 124、`terminated` 28、`error` 9、`Completed` 7、`failed` 3、`Terminated` 3、`working` **2** | 大小写混用（与 `workbuddyhome/index-rows.js` 注释一致） |
| 父子列 | `PRAGMA table_info(sessions)` 中**没有任何 `parent_*` / `child_*` / `agent_*` 会话关联列** | **无子会话关系** |
| schema 语义 | 迁移 `0012_unify_sessions_cloud.sql` 给 `group_id/group_title/agent_dirty/transport/conversation_origin` 加列，并把索引限定在 `WHERE transport='cloud' AND deleted_at=-1` | `group_id` 是**云端会话的分组**（把云端会话并进同一列表），不是子代理 |
| 应用侧文件 | `~/.workbuddy/app/sessions.json`（最近 10 个会话 + `resumedAt`）、`tasks/<sessionId>/<n>.json`（plan 清单） | 无子代理记录 |

**结论**：WorkBuddy 在本机**不存在可读的「子智能体」概念**——不是「有但没数据」，而是**schema 里就没有关系列**。任务卡上不应为 WorkBuddy 显示子代理数（连 `0` 都不该显示，因为无观测 ≠ 0）。

### 4.3 「后台任务」：`automation_runs` 是唯一候选，但语义是「定时任务产出会话」

[实测] 这台机器上的全部事实：

- `automations`：**1 条**，`id='ai'`、名称「每日 AI 新闻推送」、`status='ACTIVE'`、`schedule_type='recurring'`、`rrule=FREQ=DAILY;BYHOUR=9;BYMINUTE=0`、`next_run_at=2026-10-29T01:00:00Z`（≈ 09:00 SGT 次日）、`owner_source='history_unique'`。
- `automation_runtime_state`：1 行，`running=0`、`running_started_at=NULL`、`running_conversation_id=NULL`、`last_run_at=2026-10-28T01:04:59.598Z`。
  → **运行态可直接得**：`running` 是 0/1；为 1 时 `running_conversation_id` 指向正在跑的会话。本机当前 **0**。
- `automation_runs`：**64 行**（2026-04-16 → 2026-10-28，约每天一次）；`status`：`ACCEPTED` 47 / `PENDING_REVIEW` 17（[推断] 这是**通知投递/待复核状态**，不是运行状态 —— run 的运行结果在 `runs_json[].success/startedAt/finishedAt`，`status` 只是投递去向）；`result_success` 1 有 52 次、0 有 12 次（含 `automation-rate-limited`、`error`）。
  每条 `runs_json` 是数组，本机**每条只含 1 个 run**，run 字段：`{cwd, success, startedAt, finishedAt, conversationId, resultTitle, output, runResult}`。
- **串行，不并行 [实测]**：64 个 run 的时间区间**重叠对数 = 0**；单次耗时中位数 269 s；最长 1,469,674 s（17 天，2026-05-09 起、失败，属异常残留）。
- **归因 [实测]**：64 个 `runs_json[].conversationId` **全部能在 `sessions` 里找到**，且全部 `is_background_automation=1`；其中 31 个已软删。`automation_runs.thread_id` 多数是合成 id（`ai:<epoch_ms>`，47 个），少数直接是会话 id（3 个）。
- **重复计数风险 [实测]**：这 64 个 run 既在 `automation_runs`，又是 `sessions` 里的独立会话 → 若「后台任务数」与「会话数」都从各自来源数，会**双计**。当前 `deleted_at IS NULL AND is_background_automation=1` 的会话有 **33 条**，会被 hwb 当普通会话展示（`workbuddyhome/index-rows.js` 未过滤该列）。

**结论**：WorkBuddy 的「后台任务」= **1 条每日定时任务**，运行态可读、但**不是「某会话下并行的 N 个后台任务」**。对会话卡的正确映射只有两种：
1. **全局**：`运行中的自动化 = COUNT(*) FROM automation_runtime_state WHERE running=1`（本机 0/1）；
2. **会话身份**：该会话 `is_background_automation=1` → 标「自动化产出」，而不是给它挂「后台任务 N」。

### 4.4 会话运行态与数据新鲜度（影响展示可信度）

- [实测] `status='working'` 只有 2 条，且都是 `transport='cloud'`、`deleted_at=-1`，`last_activity_at=2026-09-12/09-13`（**46 天前**），`verified_at` 却是 2026-10-28 —— **`working` 不会被本地自动复位**。→ 任何「运行中」都必须叠新鲜度门限（hwb `lib/status.js` 的 30 min 门限同理）。
- [实测] 删除标记有**两套语义**（迁移脚本明确）：
  - `transport='local'`：`deleted_at IS NULL` = 未删；`deleted_at` 正数 = 软删（37 条）。
  - `transport='cloud'`：`deleted_at = -1` = **未删**（索引谓词 `deleted_at = -1`）；7 条 cloud 会话全是 `-1`。
  - hwb 现行 `WHERE deleted_at IS NULL` 会**把 7 条云会话全部丢掉**（它们是 `conversation_origin='openapi'|'workbuddy-mp'` 的 API/小程序会话）。→ 若要做全量口径，谓词应为 `deleted_at IS NULL OR deleted_at < 0`。
- [实测] 活跃度：未删会话里 `last_activity_at` 在 1 天内的只有 3 条，>1 天 101 条，NULL 28 条。→ 这台机器上 WorkBuddy 基本闲置，**任何「后台任务」数字都天然接近 0**，展示价值有限。
- [推断] WorkBuddy 不在运行时，`automation_runtime_state.running` 可能冻结为 1（无心跳复位），所以运行态也要带「观测时间 + 陈旧则未知」。可用 `MAX(sessions.updated_at, automation_runtime_state.last_run_at, db 文件 mtime)` 作为观测时刻。

### 4.5 辅助信号（明确不算子代理 / 后台任务）

- `~/.workbuddy/tasks/<sessionId>/<n>.json`：会话内 **plan/待办**（`subject/description/status/id/createdAt/updatedAt`）。[实测] 30 个会话、118 个文件，状态 `completed 87 / pending 26 / in_progress 5`；`in_progress` 全部停在 2026-09（**陈旧不会复位**）。→ 可做「会话内进行中步骤数」旁证，但**不是**子智能体、也不是后台并行任务；且是文件树扫描（30 目录/118 文件，25.5 ms），需单独降级处理。
- `sessions.unread`：174 条 0 / 2 条 1，与 hwb 已有 unread 口径一致，不展开。

---

## 5. 横向对照表

### 5.1 结论矩阵（信号 × harness）

| 信号 | dsh | Codex | WorkBuddy |
|---|---|---|---|
| 子智能体**总数** | **能**（`projcache` 的 `subagentCatalog`；`src/lib/status.js:subagentStatus`）［据仓库源码，未在本任务实测］ | **能**（`thread_spawn_edges`，490/490；`threads.source` JSON 等价） | **不能**（无父子列、`group_id/expert_*` 全 NULL；schema 无概念） |
| 子智能体**运行中** | **能/较能**（投影 + 3 s 实时通道覆盖）［据源码］ | **部分能**（join `thread_turns` + 180 s 门限；僵尸 15 条） | **不能** |
| 后台**并行任务数** | **无独立投影**（只有 `todos/plan/goal`；「后台任务」需另立口径）［据源码］ | **不能**（无表/无 RPC/无状态文件；只有内部 memory jobs + heartbeat automations） | **部分**（`automation_runtime_state.running`：本机 0/1；串行、非会话级） |
| 后台任务**运行状态** | 见 task-1 | 不能（同上；`process_manager/*.json` 陈旧） | **能读**（`running / running_started_at / running_conversation_id`），需陈旧门限 |
| 会话**运行态**（旁证） | 能（projcache + 实时） | 能（`thread_turns` + 180 s） | **弱**（`status='working'` 46 天未复位） |

### 5.2 明细矩阵（粒度 / 归因 / 实时性 / 重启后可信度 / 建议）

| 信号 | harness | 数据源（表/列） | 粒度 | 归因难度 | 是否实时 | 重启/离线后可信度 | 建议 |
|---|---|---|---|---|---|---|---|
| 子智能体总数 | Codex | `state_5.thread_spawn_edges(parent,child,status)`；`threads.source` JSON | 会话（经 parent）/ 父线程 | **易**（直接 parent） | 近实时（spawn 即写，hwb 60 s 索引） | **高**（持久表，490 条全在；`status` 恒 open 但总数仍对） | **展示**：`total`；注明直接/子树口径；排除 guardian |
| 子智能体运行中 | Codex | `thread_history_1.thread_turns` + `threads.updated_at_ms` | 会话 | 中（需两库 join + 新鲜度） | 近实时（turn 写入延迟 ~1 s，索引 60 s） | **中高**：库停写后 → 必须输出「未知」而非 0；180 s 窗口实测可靠 | **展示（带未知态）**：`running` + `observedAt`；仅当 child 最新 turn=inProgress 且新鲜 |
| 子智能体 | WorkBuddy | 无 | — | — | — | — | **不展示**（无观测；不要填 0） |
| 后台并行任务 | Codex | 无（负证据见 §3.5） | — | — | — | — | **不展示**，标 `unavailable/needs-app-server`；若将来做，走 app-server 或进程侧 |
| 后台并行任务 | WorkBuddy | `automation_runtime_state(running,…)`；`automation_runs` | **全局**（每 automation 一行）/ run 历史 | 中（run 自己的会话，不是父会话的子任务） | 仅定时触发时变化（日级） | 中：`running` 可能冻结，需时间门限；`last_run_at` 有两份且会分叉 | **全局小徽标展示**；**不要**挂到某用户会话卡上；自动化会话加「自动化」标签 |
| 自动化会话身份 | WorkBuddy | `sessions.is_background_automation`；`automation_runs.thread_id` | 会话 | 易 | 静态 | 高 | **展示**：给会话加 badge；当前 33 条活信号会被当普通会话，建议区分 |
| 自动审查次数 | Codex | `threads.thread_source='guardian_review'`（1,396，漏标 24） | 全局 | n/a | 近实时 | 高 | **可选全局指标**；**绝不进会话子代理数** |
| 会话运行态 | WorkBuddy | `sessions.status` + `last_activity_at` | 会话 | 易 | 否（无心跳） | **低**（46 天未复位） | 需 30 min 级新鲜度门限；或不用 |

---

## 6. hwb 侧建议的数据结构 + 降级语义

### 6.1 现状约束（读代码得到的事实）

- 会话行 `status` 是 JSON 字符串，`index-rows.js` 目前**硬编码 `subagents: 0`**（`src/codexhome/index-rows.js:29-31`、`src/workbuddyhome/index-rows.js:40-41`）→ 现状把「没有观测」写成了「0」，违反本任务要立的降级语义。
- 前端 `src/web/components/session-state.js:20` 又做了一次 `Number(status?.subagents) → 0` 兜底；`recent-sessions.js:98` 只在 `status.subagents > 0` 时渲染「N 子agent」，`:101` 渲染「上下文 N%」。所以**只改服务端不改前端，未知仍会显示成 0**。
- dsh 侧已有完整的 `subagents`（`src/lib/status.js:subagentStatus`）→ 新字段必须与 dsh 同构，否则三种 harness 语义会分叉。

### 6.2 建议形状（向后兼容 + 未知可表达）

```jsonc
// sessions.status（JSON）
{
  "kind": "running", "label": "运行中",          // 不变
  "subagents": 3,                                // 保留：= total，兼容旧前端
  "subagentsDetail": {                           // 新增：仅在「有观测」时出现
    "total": 3,                                  //   累计 spawn 数（不含 guardian_review）
    "running": 1,                                //   当前运行中
    "totalKnown": true,                          //   false = 只有部分观测（如库只读到一半）
    "runningKnown": true,                        //   false = 运行态不可判（库停写/无 turn 表）
    "countScope": "subtree",                     //   "direct" | "subtree"（必须明示）
    "source": "codex.thread_spawn_edges",        //   口径来源，便于排障
    "observedAt": "2026-10-28T05:40:09.000Z",    //   观测时刻（服务端时钟）
    "staleAfterMs": 180000                       //   运行态有效期（Codex 180s；WorkBuddy 用 30min）
  },
  "backgroundTasks": {                           // 新增；**缺键 = 无观测/不适用**
    "total": 1, "running": 0,
    "known": true,
    "scope": "global",                           //   "global" | "session"
    "source": "workbuddy.automation_runtime_state",
    "observedAt": "2026-10-28T05:42:47.000Z"
  }
}
```

**降级语义（铁律）**：

1. **键存在 = 有观测**（数值可以是 0）；**缺键 = 未知/不适用**；**禁止把未知写成 0**。
   - WorkBuddy 子代理：**不写** `subagentsDetail`（连 `subagents: 0` 都不该写；若要保留旧字段，配 `subagents: null` 并在前端按「未知」渲染）。
   - Codex 运行态：库陈旧/无 `thread_turns` 表 → `subagentsDetail.runningKnown=false`（而不是 `running:0`）。
2. **每个数值带 `observedAt` + `source` + `staleAfterMs`**；前端超过 `observedAt + staleAfterMs` 时降级为「—」，不显示旧数字。
3. **`countScope` 必须落在数据里**，而不是只写在文档：同一会话「直接 59 / 子树 71」都正确，但 UI 文案要能区分（建议默认子树，tooltip 写「含嵌套子代理」）。
4. **`total` 与 `running` 独立降级**：总数来自持久表（重启仍可信），运行中来自瞬时表（可能未知）。二者不要绑成一个「可展示/不可展示」开关。
5. **排除项写进数据**（可选字段 `excluded.guardianReview`）——只给排障用，不必下发前端；但服务端必须有这条注释/字段，防止后来人把 guardian 加回去。
6. **前端渲染**（`recent-sessions.js`，紧挨「上下文 N%」右侧）：
   - `subagentsDetail.total > 0` → `子代理 71（运行 1）`；`runningKnown=false` → `子代理 71（运行 —）`；
   - 无 `subagentsDetail` → **不渲染**（不要渲染 `0 子agent`）；
   - `backgroundTasks.scope='global'` 的数值不要挂在单会话卡上（WorkBuddy 的自动化是全局的）。
7. **更新 `sessionState()`**：`subagents` 保留数字兜底没问题，但请改为「缺键返回 `null`」，并新增 `subagentsKnown/subagentsRunning` 的读取；否则服务端再准确也会被前端压成 0。

---

## 7. 最小 SQL 与代价

> 代价 = 本机实测（Node 22 / `node:sqlite`，冷热混合，取 3 次中位数近似）。hwb 现有索引循环是 **60 s baseline**（`src/dshhome/indexer.js`：`baseMs=60_000`，失败退避到 5 min），下列查询可直接挂进现有 reader 的 snapshot 读取，不需要新增轮询。

### 7.1 Codex

| # | 信号 | SQL（库） | 行数 | 耗时 | 索引 | 频率建议 |
|---|---|---|---|---|---|---|
| C1 | 子代理总数（按父） | `SELECT parent_thread_id, COUNT(*) FROM thread_spawn_edges GROUP BY parent_thread_id`（`state_5`） | 490 → 100 组 | **0.86 ms**（全表 490 行取数；GROUP BY 同量级） | `idx_thread_spawn_edges_parent_status(parent_thread_id,status)` | 随 60 s 索引 |
| C2 | 总数（含嵌套，按会话） | §3.2 递归 CTE（`state_5`） | 中间树 490 行 → 87 组 | **24 ms** | 同上（`parent_thread_id` 前缀） | 60 s；或缓存「父子树」仅在 edges 变化时重算（可选 `SELECT COUNT(*)` 做变更探测） |
| C3 | 每线程最新 turn | §3.3 ②（`thread_history_1`） | 12,215 → 1,677 | **15.5–23.6 ms**（全量，3 次观测）/ **13.8 ms**（`WHERE thread_id IN (490)`） | `idx_thread_turns_page(thread_id, rollout_ordinal)` | 60 s（hwb 已在读，无新增） |
| C4 | 运行中子代理（聚合） | C1 + C3 + JS join | 490 + 1,677 | **4.4 ms**（join 部分） | 无（内存 Map） | 60 s |
| C5 | guardian 排除校验（自检） | `SELECT thread_source,COUNT(*) FROM threads GROUP BY thread_source` | 2,347 | ~2 ms | 无（全表扫） | 仅测试/诊断 |
| C6 | 磁盘成本 | `thread_history_1.sqlite` **1,102 MB**，`thread_items` 179,867 行 | — | — | — | **绝对不要**在子代理徽标路径上碰 `thread_items` / 正文 |

### 7.2 WorkBuddy

| # | 信号 | SQL（`workbuddy.db`） | 行数 | 耗时 | 索引 | 频率建议 |
|---|---|---|---|---|---|---|
| W1 | 运行中的后台自动化 | `SELECT automation_id, running, running_started_at, running_conversation_id, last_run_at FROM automation_runtime_state WHERE running=1` | 1（表仅 1 行） | **0.05 ms** | 主键 | 60 s（可更懒：日级任务，5 min 足矣） |
| W2 | run 历史/成败 | `SELECT thread_id, automation_id, status, result_success, created_at, updated_at FROM automation_runs ORDER BY created_at DESC LIMIT 50` | 64 | **2.7 ms** | `idx_automation_runs_created_at` | 60 s，仅取近 N |
| W3 | 会话（含云删除口径） | `SELECT id,status,is_background_automation,transport,deleted_at,last_activity_at FROM sessions WHERE deleted_at IS NULL OR deleted_at < 0` | 176 | **0.78 ms** | 主键；`idx_sessions_cloud_*` 是部分索引，本查询走全表更实际 | 60 s（hwb 已在读） |
| W4 | 运行态候选（需门限） | `SELECT id FROM sessions WHERE lower(status)='working' AND (deleted_at IS NULL OR deleted_at<0)` | 0 | <0.1 ms | 无 | 60 s；**必须**叠 `last_activity_at/updated_at` 新鲜度 |
| W5 | 会话内 plan 进度（辅助） | 文件树 `tasks/<id>/*.json`（无 SQL） | 30 目录 / 118 文件 | **25.5 ms**（fs + JSON.parse） | — | 60 s 可接受；缺目录=无观测（不是 0 步） |

### 7.3 组合建议

- **一次 snapshot 内完成**：Codex = C1+C3（+C4 JS 聚合，约 20 ms/60 s）；WorkBuddy = W1+W2（约 3 ms/60 s）+ 已有 W3。
- **不要新增轮询**：60 s 索引节奏对「子代理数」足够；「运行中」的 180 s 门限 > 60 s 索引间隔，不会因索引慢而误判。
- **成本大头是打开库**（`thread_history_1.sqlite` 1.1 GB，首次 open + 读页）；hwb 已经在打开它，因此新增计数是**边际成本**。

---

## 8. 建议落地顺序

1. **Codex 子代理总数（低风险、高价值）**：`thread_spawn_edges` → 父会话聚合；只填 `subagentsDetail.total`，`runningKnown=false`。先不做运行中，验证 UI 与口径。
2. **Codex 运行中（第二步）**：复用 reader 已有的 turn states，做 180 s 门限；同时把「库停写 → 未知」写死。
3. **WorkBuddy 自动化 badge + 全局运行态**：只加 `is_background_automation` badge 与全局 `背景任务 运行中 0/1`，**不给用户会话挂后台任务数**。
4. **WorkBuddy 子代理：不做**（无数据源）；文档与 UI 文案都明确「不支持」，避免用户以为漏读。
5. **Codex 后台任务：标记 `unavailable`**，等 app-server/进程侧方案（这是另一个量级的工程：要连 Codex 的 JSON-RPC 或做进程树归因）。

---

## 9. 风险与未验证项（诚实边界）

| 项 | 状态 | 说明 |
|---|---|---|
| `thread_spawn_edges.status` 语义 | 未验证（无 closed 样本） | 490 条全 `open`，无法证明「closed 会被删除」还是「从不关闭」；**不要依赖它** |
| spawn 是否可能在子线程首个 turn 前缺失 | 未验证 | 本机 490/490 齐全；极端并发下 edges 与 threads 的写入顺序未见源码，建议读取时用 `source LIKE '%thread_spawn%'` 做兜底并集（两源实测等价） |
| Codex 未来版本 schema 漂移 | 已知风险 | `state_5` 文件名带版本号；`thread_history_<N>` 已出现 `_1`，必须沿用 reader 的「取最大 N」逻辑 |
| 180 s 门限是否够所有情况 | 部分验证 | 1,467/1,643 ≤1 s，subagent 仅 4 条 >180 s（resume 场景）；**长 turn 中途无 updated_at 刷新**的假设未被本机数据反驳（样本里 turn 进行中 `updated_at` 仍会刷新） |
| WorkBuddy `runs_json` 与 `automation_runs.thread_id` 双主键 | 已实测 | 64/64 conversationId 能在 sessions 找到；但 `thread_id` 47/64 是合成 id，**只有 runs_json 才是可靠归因** |
| WorkBuddy 多 automation 并行 | 未观测 | 本机仅 1 个 automation；schema 支持多行 `automation_runtime_state`（每 automation 一行），并行语义需另机验证 |
| `guardian_review_feedback` 是否全量 | 已判定否 | 23 行 vs 1,420 个 guardian 会话 → 只能算抽样反馈，不是归因表 |
| dsh 列 | 未本任务实测 | 表中 dsh 结论来自 `src/lib/status.js`、`src/dshhome/live-status.js` 源码；最终以 task-1/Lead 为准 |

---

## 10. 复现命令（只读）

```bash
cd /Volumes/repo/ciao/github.com/hwb

# 0) 环境
node -v   # v22.21.1

# 1) Codex 分布与 edges 覆盖（state_5）
node --input-type=module -e '
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.env.HOME + "/.codex/state_5.sqlite", { readOnly: true });
const q = (s) => db.prepare(s).all();
console.table(q("SELECT thread_source, COUNT(*) n FROM threads GROUP BY thread_source"));
console.table(q("SELECT status, COUNT(*) n FROM thread_spawn_edges GROUP BY status"));
console.table(q("SELECT COUNT(*) n FROM thread_spawn_edges"));
console.table(q("SELECT COUNT(DISTINCT parent_thread_id) parents FROM thread_spawn_edges"));
'
# → guardian_review 1396 / subagent 514 / user 416 / null 19 / voice_chat 2
# → edges: open 490；parents 100

# 2) 子代理按父聚合 + 递归子树（见 §3.2、§7.1 C1/C2）

# 3) 运行中（两库 join，见 §3.3 / §7.1 C3/C4）

# 4) WorkBuddy 运行态与 runs
node --input-type=module -e '
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.env.HOME + "/.workbuddy/workbuddy.db", { readOnly: true });
const q = (s) => db.prepare(s).all();
console.log(q("SELECT * FROM automation_runtime_state"));
console.table(q("SELECT status, result_success, COUNT(*) n FROM automation_runs GROUP BY status, result_success"));
console.table(q("SELECT CASE WHEN deleted_at IS NULL THEN \"NULL\" WHEN deleted_at<0 THEN \"负数\" ELSE \"正数\" END d, transport, COUNT(*) n FROM sessions GROUP BY d, transport"));
'
# → runtime_state: running 0 / last_run_at 2026-10-28T01:04:59Z
# → runs: ACCEPTED 47(41 ok/6 fail) / PENDING_REVIEW 17(11 ok/6 fail)
# → sessions: local NULL 132 / local 正数 37 / cloud 负数 7

# 5) WorkBuddy 无子代理列（schema 证据）
node --input-type=module -e '
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.env.HOME + "/.workbuddy/workbuddy.db", { readOnly: true });
const cols = db.prepare("PRAGMA table_info(sessions)").all().map(c => c.name);
console.log(cols.filter(n => /parent|child|agent|group|expert/i.test(n)));
'
# → [ "expert_id", "expert_locale", "expert_runtime_identity", "expert_marketplace",
#     "group_id", "group_title", "agent_dirty", "agent_dirty_at", "agent_last_synced" ]
#   其中 parent/child 一个都没有；group_* 为 cloud 会话分组，本机全 NULL
```

---

## 附录 A：关键样例（可直接对照）

**A1. 一条真实 spawn 子线程（`~/.codex/state_5.sqlite`）**

```
id              = 01a13f00-c7ab-7790-a7d1-028c30bd2f8b
source          = {"subagent":{"thread_spawn":{"parent_thread_id":"01a13f00-58f1-7273-bc07-adcfc008dc2b",
                  "depth":1,"agent_path":"/root/source_audit","agent_nickname":"Pascal","agent_role":null}}}
thread_source   = subagent
agent_nickname  = Pascal        agent_path = /root/source_audit     agent_role = NULL
project_id      = NULL          archived = 0
```

**A2. 一条 guardian（不参与子代理计数）**

```
id              = 01a180de-73df-7cf2-9f27-97262d18e74f
source          = {"subagent":{"other":"guardian"}}
thread_source   = guardian_review
cwd             = /Volumes/repo/ciao/PMSEQ/PMAID-PUMCH
（rollout 首行 session_meta 里有 parent_thread_id = 01a160bb-… → 可归因，但仅 74/1420 条 rollout 还在）
```

**A3. WorkBuddy 自动化运行态（本机当前）**

```
automation_runtime_state = {automation_id:'ai', running:0, running_started_at:NULL,
                            running_conversation_id:NULL, last_run_at:1793149689598 → 2026-10-28T01:04:59.598Z}
automations              = {id:'ai', status:'ACTIVE', rrule:'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
                            next_run_at:1793235600000 → 2026-10-29T01:00:00Z}
automation_runs          = 64 行，最近一条 thread_id='ai:1793149481987'，status='ACCEPTED'，result_success=1，
                           runs_json[0].conversationId='e919387b-…'（sessions 中 is_background_automation=1）
```

**A4. WorkBuddy 两套删除语义（迁移脚本 + 实测）**

```
0012_unify_sessions_cloud.sql:
  CREATE INDEX idx_sessions_cloud_sort ON sessions(user_id,last_activity_at,created_at)
    WHERE transport='cloud' AND deleted_at = -1;     -- cloud：-1 = 未删
实测：local → deleted_at NULL 132 / 正数 37；cloud → deleted_at -1  7
hwb 现行 reader：WHERE deleted_at IS NULL → 7 条 cloud 会话被静默丢弃
```
