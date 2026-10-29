# 审批态落盘：让「等待审批」在只读 / 离线 / 远程实例上也能看见

> 状态：**设计提案（dsh 侧改动）**，hwb 侧已按「观测盲区」做了诚实降级，但真正的修复需要 dsh 把
> 审批请求像 `userQuestions` 一样投影落盘。

## 1. 问题

hwb 的「待介入」有两种来源：

| 来源 | 覆盖 | 依赖 |
|---|---|---|
| 实时（`approval/request`、`user-questions/request` waterfall） | 审批 / 计划审阅 / 等待回答 | 运行中且**有实时通道**的 dsh 实例 |
| 投影（`userQuestions.questions.active`） | 只有「等待回答」 | 投影缓存落盘，离线/只读/远程都可见 |

**审批不落投影**，所以一旦实例没有实时通道，「等待审批」就是不可观测的：

- 本地只读实例（`readOnly:true`，Codex 式接入）：没有进程 / 端口 / token，观察器永远连不上；
- 当前不可达（SSH 断连、隧道挂掉）的远程实例：同样没有实时通道；
- hwb 离线期间被别处处理掉的审批：没有痕迹（dsh 自身语义如此）。

2026-10-27 实测事故：一条 3 小时会话在只读实例上弹 `danger-full-access` 审批，仪表盘显示
「空闲 / 待介入 0」，任务被晾 2 小时以上。hwb 侧本轮已做两件事止血：

1. 状态新鲜度改用**投影文件 mtime**，长任务不再翻「空闲」；
2. `/api/homes` 暴露 `liveIntervention`，UI 明确标注「N 个实例无实时通道」——「0」不再冒充「没事」。

但**审批本身仍然看不到**。要根治，需要 dsh 把审批态持久化。

## 2. 方案 A（推荐）：projcache 增加 `approvals` 投影行

与 `userQuestions` 完全同构：审批请求到来即写投影，结算即清除。hwb 侧不需要实时通道就能读到。

### 2.1 数据形状（建议）

```jsonc
// session_projcache 的 rows.approvals
{
  "ver": 1,
  "seq": 1027,
  "val": {
    // 仍挂起、等待用户决定的请求。空数组 = 没有待审批。
    "active": [
      {
        "id": "2360e003-a916-4c56-907d-3736aff8d57f", // 与 waterfall eventId 一致，便于对账
        "kind": "approval",                            // approval | plan-review
        "toolName": "bash",                            // 只存元数据
        "reason": "cargo 需要写入工作区外的全局 registry 缓存", // 已截断的纯文本摘要，≤160
        "requestedAt": 1793093909598,                  // ms
        "turnId": "01a17c0a-cff4-71d1-9c90-319face0125a"
      }
    ],
    // 最近结算的请求（环形，保留最近 N=8）。只用于 UI「刚刚已处理」与排障，不参与「待介入」。
    "settled": [
      { "id": "…", "decision": "approved", "decidedAt": 1793094000000 }
    ]
  }
}
```

要求：

- **只存元数据**：`toolName` + **截断后的**原因文本；绝不存工具参数、命令全文、文件内容。
  现有 hwb 渲染层已做 `esc()` + 长度截断，但落盘端也应先裁剪（隐私 + 单条记录体积）。
- **`active` 必须能清干净**：审批的结算信号在 dsh 内部是明确的（用户点允许/拒绝、自动审阅、
  turn 中止、会话关闭）。任何一条都必须把对应 `id` 从 `active` 移到 `settled`；进程启动时再按
  `requestedAt` 清理超龄项（建议 2 小时）。
- **写入频率低**：只在「审批弹出 / 结算」两个边沿写，不随 token 流刷新——不会放大 projcache 的
  写放大，也不会让 hwb 的 60s 索引多读大文件。

### 2.2 写入 / 清理时机（dsh 侧）

| 事件 | 动作 |
|---|---|
| `approval/request` 或 `user-questions/request`（kind=plan-review）到达 Host | push 到 `active`，`requestedAt=now` |
| 用户决定 / 自动审阅 / `cancel` 帧 / turn 结束 / 会话关闭 | 从 `active` 移除，写一条 `settled` |
| dsh 启动 | 清掉 `requestedAt > 2h` 的残留（进程被杀导致的僵尸） |
| 投影 schema 版本 | `session_projcache` 域版本 +1；`rows.approvals` 对老版本是未知行，天然忽略 |

### 2.3 hwb 侧消费（改动量小）

- `src/lib/schema.js`：把 `rows.approvals?.val` 传进 `deriveSessionStatus`。
- `src/lib/intervention.js`：`deriveProjectionIntervention()` 增加 `approvals.active` →
  `{kind:'approval'|'plan-review', label, source:'projection', tool, reason, since}`；
  与现有 `userQuestions` 合并规则（approval > plan-review > question）不变。
- `src/web/components/session-state.js`：**零改动**（intervention 形状已冻结，两个落点都会读）。
- 实时通道仍在：有实时通道时 `source:'live'` 覆盖投影（同 kind），审批的实时性不受影响。

### 2.4 验收标准

1. 只读实例（无实时通道）上弹审批后 **≤ 1 个索引周期（默认 60s）**，hwb 显示「等待审批」并进入
   「待介入」筛选/提示条；
2. 审批结算后 ≤ 1 个周期消失（不会留「幽灵等待审批」）；
3. dsh 被杀后重启，残留 `active` 不超过 2 小时且不影响其它会话；
4. 投影里不出现工具参数/命令全文（源码级断言 + 夹具检查）；
5. 老版本 hwb 读新投影不崩（未知行忽略）；老版本 dsh + 新 hwb 时回落实时通道，行为与本轮一致。

## 3. 方案 B（备选）：dsh 暴露本机只读审批接口

`GET http://127.0.0.1:<port>/api/approvals`（回环 + token）返回当前挂起审批。hwb 在 60s 索引时拉一次。

- 优点：不用改投影 schema；实时性略好于文件索引。
- 缺点：仍然要求 dsh 进程在跑（只读实例恰恰没有「hwb 能连的」进程），只解决「本机可连接实例」；
  需要处理鉴权/端口发现；与 hwb「只读元数据、不依赖实例在跑」的定位冲突。
- 结论：**不作为主路径**，可作为方案 A 落地前的过渡。

## 4. 方案 C（不推荐）：hwb 尾读 session 日志

审批事件确实在会话日志里（实测 `session.v4.jsonl.zstd` 的 `approval/asked`，seq 1027）。但：

- 与仓库「**永不碰 `*.zstd`**」的硬约定冲突（README/CHANGELOG/架构文档共 8 处），
  2026-09-13 曾实现过「解压日志取模型」并因此整体回退；
- 多帧 zstd：Node 的 `zstdDecompressSync` 只解第一帧，需要自建拼接解析；
- 日志格式是 dsh 内部细节，随版本漂移；尾部读取还要处理超长行（实测有 7MB 单行）。

只有在方案 A 长期无法落地时才考虑，且必须**先改约定再做**。

## 5. 发布顺序建议

1. dsh：投影 schema + 写入/清理 + 版本号（方案 A）；
2. hwb：`SUPPORTED_VERSIONS.projcache` 接受新版本、消费 `approvals`（约 30 行 + 测试）；
3. hwb：观察器仍然保留（实时优先），观测盲区的 UI 说明保留（老 dsh 上仍然需要）；
4. 文档：README「人工介入提示怎么来的」第 2 条改为「审批/等待回答都可能来自持久投影」，
   并把「已知限制」里「只读实例只有等待回答」一句删掉。
