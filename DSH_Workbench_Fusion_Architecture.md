# DSH Workbench — 融合版架构设计

> 基于真实 `~/.dsh` 目录 inspection 的 greenfield 重建
> 技术栈: Node.js 22+ · 原生 ESM · `node:sqlite` · 零 npm 依赖
> 版本: v0.1.1 | 2026-09-04

---

## 1. 为什么 greenfield，以及旧项目做对了什么

旧项目 `Remote_DSH_Center` 在**进程管理**层面非常严谨：状态机转换、原子化状态写入、SSH 一次性探测、隧道退避自愈、前端 SSE 按 revision 顺序 reconcile。这些都没有问题。

但它**架构形状错误**——它是一个"管理器"，不是一个"工作台"：

- **从不读取 dsh home**。一个工作台的核心职责是"展示所有实例的项目、会话、额度"，但旧项目只维护 `phase/web/tunnel` 三元组，对 dsh 内部数据结构一无所知。
- **把聚合与远程访问耦合在一个循环里**。"最近项目"刷新被迫复用启动进程的 SSH 机制，两个不同职责被塞进同一节奏。

因此正确做法是**不是重写管理器，而是围绕两个平面重新架构**：
- **控制平面**（Control Plane）：继承旧项目的进程/隧道管理优良基因
- **数据平面**（Data Plane）：全新设计，读取 dsh home、构建索引、服务可读工作台

Greenfield 让你完全自主（解决 PR 被忽略问题），也让数据平面成为一等公民。

---

## 2. 核心架构：三平面分离

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        CONTROL PLANE  (控制平面)                             │
│  职责: 实例发现 · 生命周期 · SSH 隧道 · 额度查询(外部) · 实例注册表              │
│  状态: 继承旧项目的 manager/store/monitor/prober/launcher/tunnel 优良基因      │
│  节奏: 30s 心跳循环，SSE 推送状态变更                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│                              边界接口                                        │
│  Control → Data: instance + tunnel 状态 (谁在线、映射到哪个端口)              │
│  Data → Control: 无直接调用 (单向解耦)                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                         DATA PLANE  (数据平面)                               │
│  左侧: Workbench Store/Router (SSE 订阅者)                                   │
│  右侧: DSH Home Reader — 读取 4 个文件，标准化为 HomeSnapshot                 │
│  核心: Indexer → Normalizer → SQLite Cache                                   │
│  节奏: 60s debounce 循环，退避失败，永不阻塞仪表盘                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                              边界接口                                        │
│  Data → Presentation: REST (首屏) + SSE (增量补丁)                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                      PRESENTATION PLANE  (展示平面)                          │
│  默认: Workbench 仪表盘 — 纯元数据，零 iframe                                 │
│  钻入: Session Pane — 唯一挂载 iframe 的位置，按需创建/销毁                   │
│  原则: 仪表盘绝不同时挂载 N 个 iframe                                        │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.1 解决性能问题的关键规则

> **工作台仪表盘绝不挂载 N 个 iframe。** 它从本地索引渲染元数据。iframe 只在用户钻入**单个**会话时按需创建，退出时销毁。

旧设计的性能崩溃根因：
- 每个实例挂载完整 dsh SPA（iframe），每个 iframe 独立读取 home + WebSocket
- N 个实例 × 每个实例 M 个会话 = N×M 个活跃渲染进程
- 仪表盘被迫通过 iframe "透视"数据，无法直接访问 dsh 内部文件

新设计的修复：
- 元数据（项目名、会话列表、token 用量）从本地 SQLite 读取，渲染成本 O(索引行数)
- iframe 仅用于**交互**（实际使用 dsh web），不用于**展示**
- 数据平面独立循环，控制平面不阻塞它，反之亦然

---

## 3. 技术栈选型：为什么 Node.js 22

| 维度 | Node.js 22 + ESM | Rust + Tauri | 结论 |
|------|------------------|-------------|------|
| 安装负担 | 已安装（agent 生态） | 需额外安装 | **Node 胜出** |
| 包体积 | 无运行时捆绑 | 3-15 MB | 差距不大 |
| 内存 | ~50-100 MB | 20-100 MB | 可接受 |
| 开发速度 | 快 | 慢 | **Node 胜出** |
| 前端集成 | 浏览器打开 | WebView | 浏览器更熟悉 |
| 系统集成 | 弱（无托盘/快捷键） | 强 | 可后续加 wrapper |
| SQLite | `node:sqlite` 内置 | `rusqlite` | 都支持 |

**锁定 Node.js 22+ 的原因：**
1. 你的目标用户（AI agent 开发者）已经安装 Node 22
2. `node:sqlite`（Node 22.5+）提供同步 SQLite，零依赖
3. 原生 ESM + `node:fs` + `node:child_process` 足够完成所有工作
4. 开发迭代快，PR 被忽略的问题通过自主仓库解决

**未来若需原生体验**（系统托盘、全局快捷键），可叠加一个轻量 Tauri/Electron wrapper，核心逻辑不变。

---

## 4. 数据平面：DSH Home Reader

### 4.1 读取的 4 个文件（真实 ~/.dsh 结构）

基于对真实 dsh home 的 inspection，Reader 只读取以下文件：

| 文件路径 | 内容 | 大小 | 关键规则 |
|---------|------|------|---------|
| `storages/workspace.json` | 工作区列表、会话 ID 映射、归档状态 | ~11 KB | 轻量，可频繁读取 |
| `storages/session_projcache.json` | 会话投影缓存：tokenUsage、contextPressure、contextBreakdown | ~268 KB | **零 I/O 读取层**，避免读 `.zstd` |
| `model-tier.json` | 订阅方案、模型路由 tiers | ~2 KB | 用于标记会话走哪个 provider |
| `.credentials.yaml` | API Key 引用（provider 名称，不读 key 值） | ~1 KB | 只读 provider 名，用于额度面板分组 |

**硬性规则：Reader 永远不碰 `*.zstd`。**

`session_projcache.json` 是 dsh 专门设计的"冷读优化层"（`dsh-session-projection-cache` 的 README 明确说明：*cached rows → restoreFloor → persistence*）。工作台必须活在**第一层**（projection cache），绝不下探到 `.zstd` 日志。

### 4.2 两种读取方式

```
┌─ local:  直接 fs.readFileSync 读取本地 ~/.dsh/...                     ┐
│  - 同步读取 4 个文件（schema-versioned）                                │
├─ remote: 单条 `ssh <host> bash -s`（脚本经 stdin）在远端 `cat` 出 4 个元数据文件                        │
│  - 在远端执行提取脚本，JSON 输出到 stdout                               │
│  - 脚本只读，不注入密钥，不修改任何文件                                 │
└─────────────────────────────────────────────────────────────────────────┘
          │  两种方式输出完全相同的 HomeSnapshot
          ▼
   Normalizer → validate schema → drop unknown versions → emit IndexedRows
```

### 4.3 标准化模型：HomeSnapshot

```typescript
type HomeSnapshot = {
  homeId: string;            // homePath 的 SHA256 前 16 位
  homePath: string;          // 绝对路径
  generatedAt: string;       // ISO 时间戳
  wsVersion: number;         // workspace.json.version (当前为 2)
  pcVersion: number;         // session_projcache.json.version (当前为 3)
  workspaces: Workspace[];
  sessions: SessionMeta[];
  modelTier: { activeId: string; tiers: Record<string, {provider, model}> } | null;
  providers: { ref: string; provider: string }[];   // 名称 only，无 key
};

type SessionMeta = {
  sessionId: string;
  workspaceId: string;
  tokenUsage: {
    uncachedInputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
  contextPressure?: {
    pressureTokens: number;
    projectedTokens: number;
    contextWindow: number;
  };
  lastActivity?: string;     // ISO 时间戳
};
```

**版本降级策略：**
- 每个文件内部携带 `unit.version`。Reader 验证版本号，不验证整个文件结构。
- 未知/主版本不兼容 ⇒ 该域标记为 `degraded`，跳过写入索引，但**不失败整个 home**。
- 前端显示 "dsh 已升级 — 索引待更新" 提示，而非白屏。

### 4.4 Normalizer：纯函数转换

```
HomeSnapshot → Normalizer → IndexedRows[] → SQLite upsert
```

Normalizer 是纯函数，无副作用：
- 将 `workspace.json` 的工作区与 `session_projcache.json` 的会话关联
- 推断 `project` 名（从 workspace path 的目录名提取）
- 将会话 tokenUsage / contextPressure 序列化为 JSON 存入 SQLite
- 输出统一行格式：`{ type: 'session'|'workspace'|'provider'|'modelTier', ... }`

### 4.5 IndexStore：SQLite 缓存

使用 `node:sqlite`（Node 22.5+ 内置）：

```sql
-- homes: 实例注册表（控制平面 + 数据平面共享）
CREATE TABLE homes (
  homeId TEXT PRIMARY KEY,
  homePath TEXT NOT NULL,
  alias TEXT,
  hostType TEXT CHECK(hostType IN ('local','remote')) DEFAULT 'local',
  status TEXT DEFAULT 'unknown',
  lastIndexedAt TEXT,
  degraded TEXT DEFAULT '[]'   -- JSON array of {domain, error, degraded}
);

-- sessions: 会话元数据（数据平面主表）
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  homeId TEXT NOT NULL,
  sessionId TEXT NOT NULL,
  workspaceId TEXT,
  workspaceTitle TEXT,
  project TEXT,
  tokenUsage TEXT,             -- JSON（真相）
  -- 派生列：tokenUsage 里四个计数的整数形式。由触发器从 tokenUsage 维护（见下），
  -- 存在的唯一理由是性能：用量面板要跑八个聚合，逐行 json_extract 在真实规模下很贵
  -- （40k 会话实测 ~330ms；而 node:sqlite 是同步的，那段时间整个服务停着）。
  tokInput INTEGER NOT NULL DEFAULT 0,
  tokOutput INTEGER NOT NULL DEFAULT 0,
  tokCacheRead INTEGER NOT NULL DEFAULT 0,
  tokCacheWrite INTEGER NOT NULL DEFAULT 0,
  contextPressure TEXT,        -- JSON
  lastActivity TEXT,
  generatedAt TEXT,
  UNIQUE(homeId, sessionId)
);

-- 派生列由触发器维护，而不是由应用代码写：这样任何写入者（裸 SQL、外部工具改库）都不会
-- 让两列与 tokenUsage 漂移。（当前实现只写 tokenUsage；触发器负责派生列。）
CREATE TRIGGER sessions_tok_ai AFTER INSERT ON sessions BEGIN ... END;
CREATE TRIGGER sessions_tok_au AFTER UPDATE OF tokenUsage ON sessions BEGIN ... END;

-- workspaces: 工作区（无会话的项目也展示）
CREATE TABLE workspaces (...);

-- providers: 额度 provider 引用
CREATE TABLE providers (...);

-- model_tiers: 模型路由配置
CREATE TABLE model_tiers (...);
```

**索引策略：**
- `idx_sessions_project` — 按项目聚合
- `idx_sessions_activity` — Recent 排序
- `idx_sessions_home` — 按实例过滤
- `homes_access_port` — 接入端口唯一（部分索引）

> 用量聚合现在 SUM 派生整数列，不再逐行 `json_extract`（同一份 40k 数据上等效 5 条聚合
> 175ms → 76ms；代价是每行插入多一次 UPDATE：20k 行 43ms → 172ms）。

### 4.6 远端只读索引（与本地共用同一套 schema）

远端实例不挂载、不同步，只经一次 `ssh <host> bash -s` 把同样的 4 个元数据文件 **cat 出来**：

```
ssh <host> bash -s -- <remoteHome>   # 脚本本体经 stdin 传入，参数走 argv
  └─ 远端依次 cat 4 个文件，用 __DSH_FILE_BEGIN__ / __DSH_FILE_END__ 分隔并标注文件名
     → Node 侧 parseCatOutput 切分 → buildSnapshot → 与本地完全相同的 validate/normalize
```

要点（`src/dshhome/remote-reader.js` + `src/control/remote.js`）：

- **不注入密钥、不修改任何远端文件**，只有 `cat` 与 `test -d` 两类只读命令。
- projcache 常超过启动日志用的 64 KiB，`sshBash` 的 stdout 上限因此提高到 32 MiB，
  超限**明确失败**而不是悄悄截断。
- 输出缺少文件分隔标记时判为**传输残缺**并保留已有索引 —— 而不是把「没传成功」误记成「文件缺失」。
- 远端路径一律整体加引号后再交给远端 shell（`test -d "$HOME"'/…'`），既防注入也防空格路径被拆成多个参数。

---

## 5. 控制平面：进程与隧道管理

### 5.1 职责边界

控制平面**不**参与数据展示，只回答三个问题：
1. 这个实例当前是运行中/已停止/崩溃？
2. 它的 dsh web 监听在哪个端口？
3. 如果是远端，SSH 隧道是否建立？

### 5.2 状态机（继承旧项目）

```
unknown → probing → running → degraded（对外呈现为 unreachable）→ stopped / gone
            ↓         ↓          ↓
          stopped   stopped   stopped
```

- **running**: dsh web 进程存活，**并且入口鉴权通过**。判据是 `prober.probeAlive()`
  （`status < 500` **且不是** 401/403）—— 401 栅栏页面说明 token 失效/填错，对用户来说和挂了没区别：
  原先心跳用 `httpProbe`（`status < 500`），于是 token 填错时界面一片绿、iframe 里是 401（实测）。
  注意 `httpProbe` 的口径**故意不同**：它服务的是「那个端口上有没有 dsh web 在听」这类判断，
  那里 401 恰恰是「在听」的证据（`Launcher.#connectRemote` 的端口探测继续用它）。
- **degraded**: 隧道断开、鉴权失败或进程无响应，退避重连中；对外 runtime 呈现为 `unreachable`
- **stopped**: 用户显式停止，或实例未连接
- **gone**: 本地 home 目录已不存在

> `stop()` 是**确认式**的：SIGTERM → 等 3s → SIGKILL → 再等 2s；只有子进程确实退出才写
> `phase: 'stopped'` 并丢弃句柄。杀不掉就保留句柄、注册表保持 running，并向调用方抛错
> （API 回 500 带 pid 与端口）—— 「报 success 而进程还活着」是本项目明确要避免的一类缺陷。
> 退出路径同理：`shutdown()` 先 `await launcher.stopAll()` 再 `process.exit(0)`，
> 否则忽略 SIGTERM 的 dsh web 会变成孤儿（父进程没了、端口还占着）。

> 说明：`PHASES` 里保留了 `crashed` 这个名字，但 `Monitor.#runCheck` 只产出
> `running` / `degraded` / `stopped` / `gone`（见 `src/control/monitor.js`），代码从不设置 `crashed`。
> 与之对应，`Registry.PHASES` 缺少实际会产生的 `gone`。这里以实际行为为准。

### 5.3 隧道策略（按需 vs 长期）

旧项目采用"长期保持隧道"（建立后持续维持）。新项目改为**按需隧道**：

```
用户点击 "打开实例"
  → TunnelManager 检查隧道
    → 不存在: 启动 ssh -L 127.0.0.1:{local_port}:127.0.0.1:{remote_port} {host}
    → 存在但关闭: 自动重连（退避策略）
    → 存在且活跃: 直接复用
  → 返回映射 URL: http://127.0.0.1:{local_port}
  → 打开外部浏览器（shell.openExternal 或用户默认浏览器）
  → 实例关闭（关闭/移除实例）时立刻拆掉隧道（`Launcher.disconnect`）。当前**没有**空闲超时自动断开，隧道在接入期间一直保留（见 `src/control/tunnel.js`：只有 `-N -L`，无空闲定时器）
```

**为什么改按需：** 旧项目的长期隧道在实例多时会占用大量本地端口和 SSH 连接。按需策略把资源占用降到最小。

### 5.4 新版 dsh web 的鉴权 token（v0.1.2-rc.1+）

`dsh` ≥ `0.1.2-rc.1` 起,`dsh web` 每次启动都会在 **stdout** 打印一条**带鉴权 token 的访问 URL**:

```
dsh web: http://127.0.0.1:<port>/?token=<launchToken>
```

- `?token=` 是该进程的**启动令牌**（进程级随机、每次重启更换）。裸 URL `http://127.0.0.1:<port>/` 会被
  `dsh-web-app` 的 browser-auth 栅栏以 **401** 拒绝（"dsh web authentication required"）;
  带 token 的请求才会换发签名 cookie 并 `303` 跳转干净的 `/`。
- **本地 home**（`Launcher.#openLocal`）：`captureDshToken` 从子进程 stdout 抓取该行的 `?token=<x>`，
  把 `inst.url` 拼成 `http://127.0.0.1:<port>/?token=<x>` 交给 iframe;旧版 dsh 不打印 token 时退回裸 URL。
- **远程 home**（`#connectRemote`）：沿用 `ensureRemoteToken` 从远端日志 `grep '?token=[^ ]*'` 抓回，
  再拼到 ssh -L 隧道本地端口上——逻辑维持不变。
- 抓取与 `waitForHttp` **并行**:HTTP 就绪（401 也视为"已起来"）和 token 行出现互不阻塞；
  只解析**完整行**,避免把半截 token（`?to`）误判成旧版无 token。

#### 会话深链（`dsh-session-deeplink` 插件）与 token 的两层矛盾

hwb 的「钻入某会话」靠 `probeDeeplink`（检测 `?session=` 深链能力）+ 前端二段跳转,但**新版 token
鉴权会同时卡住这两层**:

1. **探测被 401 挡住**。`probeDeeplink` 之前用裸 `fetch` 读 `inst.url`,拿到的是 401 提示文本而非
   index.html → 永远 `false`。现已改用 `authFetch`：`redirect:'manual'` 拿到 `303 + set-cookie` 后,
   手动把 `set-cookie` 带回再请求指向的 `/`,读到真正的 index.html 再判断 `session-deeplink`。
2. **`?session=` 会在首次到达时被吞掉**。`?token=` 首次请求会 `303` 到 `/` 并**丢弃全部 query**,
   所以一步 `...?token=<x>&session=<id>` 到不了插件。前端改为**二段跳转**:iframe 先加载带 token 的
   入口（在浏览器种下 cookie）,`load` 后再导航到**无 token** 的 `/?session=<id>`（此时 cookie 已认证,
   `?session=` 才能保留给插件）。

> ✅ **前提与实测**：该深链依赖 `dsh-session-deeplink` **客户端插件**（`dsh.web` 的 profile 依赖,
> 通过 `dsh plugin --profile web add dsh-session-deeplink` 安装）。原厂 bundle 不打包它,但**装了插件**的
> home 里,`dsh-client-modules` 会把插件编进 `window.__DSH_BOOT__` 注入 `<head>`,所以 `authFetch` 读完
> 真实页面后 `probeDeeplink` 能识别（实测装了插件的真实 home 返回 `true`,裸 home 返回 `false`）。
> **未装该插件时深链不触发**——此时上面两处修复只是保证"装了插件"能正确探测 + 保留 `?session=`。

##### 跳转白闪（全量重载）+ 修复

二段跳转每次都要**整页重载 dsh web**（token 握手 → `/` 一次,`?session=` 又一次）——实测每个会话
跳转都是 **2 次 dsh web 全量加载**,每次启动都很重,肉眼就是「反复高频次白闪」。修复两处（`mountPane`）：

- **`_cookieReady` 直达**:同一实例 origin 种过鉴权 cookie 后（即已在跑/首次打开过）,切换会话
  直接导航到 `/?session=<id>`,只 **1 次加载**;
- **加载遮罩 `.frame-cover`**:覆盖在 iframe 上方（`z-index` 低于右上角浮层按钮）,在**整段**跳转序列
  （首次的 token 握手 → `/` → `?session=`,或切换的 1 次 `?session=`)全程保持,直到最终目标
  `iframe.src === 目标` 的 `load` 才收起——把白闪遮成面板色「连接会话…」加载态。

#### 连接机制原则：稳定第一 + 手填 token 直连

hwb 连接机制的核心原则（已落地）：**dsh 实例以稳定运行为第一优先**。

1. **绝不因 hwb 自身连接问题去打断实例**。隧道断连 / 探测失败 / 远端不可达只会让实例进入
   `degraded`（未达）并按退避重连**再探测**（见 §5.2），不会触发 killport / 重启远端 dsh web。
   `ensureRemoteToken` 的 `ensure` 模式在端口已监听时**直接复用**（日志有 token）或返回
   `__NO_TOKEN__`（旧版无 token），**不做 kill/restart**。
2. **「启停」是用户显式授权的最后手段**。前端对 `stop` / `stop-instance` / `restart`（远程）加
   `confirm()` 二次确认，文案注明会打断实例、建议改用 token 直连。
3. **可自服务时交给用户自行操作**。远端 dsh web 不可达 / home 不可访问时，报错文案自带
   `selfServiceHint(home)`——一组用户在远端可直接执行的 ssh 命令：启动 / 读最新 token / 确认
   home 存在。设置表单里也给出读 token 的 ssh 命令与「稳定第一」说明。
4. **手填 token 直连（最后手段的替代）**。实例设置 / 添加表单新增 `token` 栏。用户在远端自行更新
   dsh 并取到新 token 后填入，`#openRemote` 便**直接用该 token 建隧道接入，完全不在远端启动 /
   重启 / 杀进程**——避免「为拿新 token 而重启实例」。
   - 存储：`homes.token` 列（含迁移），`routes` POST/PUT 接受 `token`。
   - 规范化：`normalizeWebToken(input)` 兼容 `?token=x` / `token=x` / 裸 `x` / 完整 URL（含 LAN
     尾部），统一为 `?token=x`；空 / `__NO_TOKEN__` / 无法识别 → null（回退远端抓取兜底）。

### 5.5 反向代理（hwb 侧, 根路径 1:1）

> **变更（现状）**：本地 home 的**「在外部浏览器打开」**不再走反代 —— 本机 dsh web 与浏览器同机
> 可达，「外部打开」给的是**原始服务连接** `http://127.0.0.1:<dshPort>/?token=<x>`（token 可见、
> 不依赖 hwb 进程存活的反代入口）。
> 但**内嵌 iframe 仍然经过反代**：`Launcher.#withPreview` 对**所有**实例（本地与远程）
> 都会 `createProxy({ preview: true })`，本地实例自动分配端口，代理会注入 `preview-bridge.js`
> 以便工作区/文件点击与 parent 通信。只有「外部打开」这一条路径是直连。

```
本地 home:  外部打开 ──(直连原始服务连接)──► 127.0.0.1:<dshPort>      √ 主机直接可达
            内嵌 iframe ──► hwb 预览代理 127.0.0.1:<autoPort> ──► 127.0.0.1:<dshPort>
远程 home:  外部打开 / 内嵌 iframe ──► hwb 代理 127.0.0.1:<accessPort> ──(1:1 根路径)──► 127.0.0.1:<ssh -L 隧道端口>
```

远程 home 的反代端口可持久化（「本地接入端口」`accessPort`）；本地 home 的预览代理端口每次
自动分配，不保存（`src/control/launcher.js` 的 `#withPreview`）。

**为什么必须根路径**（远程代理）：dsh web 的 `index.html` 用**根绝对路径**（`<base href="/">`、
`<script src="/plugins/...">`、`/assets/...`、`/api/...`）。若挂在 hwb 的子路径（`/proxy/<id>/`）下,
这些绝对路径会解析到 hwb 自己的根而 404。因此代理独立监听一个本地端口,把根路径**原样 1:1 转发**
（不重写路径）,让资源/插件/API/WebSocket 全部走通。

**代理职责**（`createProxy`, 远程分支）:
- `Host` 头**原样透传**（浏览器访问代理的 Host）——dsh 的鉴权 cookie 按 `authority=Host` 绑定,
  这样 cookie 在「代理 origin」上稳定有效;
- 透传所有方法 + 请求体,流式回传（含 SSE 分块）;
- 处理 `upgrade`（WebSocket）升级,让实时通道也走代理;
- 与实例同生命周期: `Launcher.#connectRemote` 在拿到 token 后创建代理, `stop` 时一并关闭。

> ⚠️ **同源边界**：远程代理在**独立本地端口**(差异化 origin),所以代理后的 dsh web 与 hwb 自己的 UI
> 页面（4310）**不同源**。因此代理本身并不直接实现「hwb 同源驱动 SPA」——它提供的是统一、干净的入口
> 与稳健的传输（+ 为后续 hwb 侧注入做铺垫）。若要做到「会话在当前页原地打开、零重载」,仍需一个跨源
> 机制（`postMessage`）去驱动已加载的 SPA——可在此代理基础上再接入。
---

## 6. 双循环刷新架构

```
┌────────────────────────────────────────────────────────────────────┐
│  Control SSE Loop  (控制循环)                                      │
│  周期: 30s                                                        │
│  内容: 探测进程存活、端口响应、隧道健康                             │
│  输出: SSE event: "instance:status"                                │
│  阻塞: 绝不阻塞数据平面                                            │
├────────────────────────────────────────────────────────────────────┤
│  Data Index Loop  (索引循环)                                       │
│  周期: 60s (debounced，成功则降频，失败则退避)                     │
│  内容: 读取 dsh home 4 文件 → Normalizer → SQLite upsert           │
│  输出: SSE event: "index:updated" + REST 增量补丁                  │
│  阻塞: 绝不阻塞仪表盘渲染（SQLite 本地读取 <10ms）                 │
└────────────────────────────────────────────────────────────────────┘
```

**退避策略（按实例独立计算）：**
- 索引失败 → 该实例间隔 ×2，封顶 5min
- 连续成功 → 该实例间隔 ÷1.5，恢复 60s 基线
- 单个 home 失败 → 标记 `degraded`，保留上次有效数据；退避只拖慢该实例自己的节奏，不影响其他 home 的 60s 基线

---

## 7. 展示平面：Workbench UI

### 7.1 两个导航模式

**模式 A: Workbench（默认仪表盘）**
- 读取本地 SQLite 索引，零 iframe
- 展示三栏：
  1. **Recent Projects**（跨实例聚合，最近 7 天活跃，按最后活动时间降序）
  2. **Recent Sessions**（最近 50 个，带 token 用量 chip、上下文压力指示器）
  3. **Instance Grid**（每个 dsh 实例：状态 chip、项目数、会话数；额度卡片由 `renderQuotaCards` 实现但**尚未接线**，见 README「已知限制」）

**模式 B: Drill-in（单会话）**
- 唯一挂载 iframe 的位置
- 点击实例/会话后，懒创建 iframe（本地直连端口或 ssh -L 隧道）
- 退出时销毁 iframe，释放资源
- 绝不同时存在多个 drill-in iframe

### 7.2 前端技术：原生 ESM SPA

- 无构建步骤，无 bundler
- 使用原生 Web Components 或轻量框架（可选 Svelte 5，编译为纯 JS）
- 数据流：REST 首屏加载 + SSE 增量补丁
- DOM 更新：只更新变更节点（手写 diff 或框架响应式）

---

## 8. Quota 额度管理（参考 cc-switch + quota-axi）

### 8.1 设计原则

- **只读查询**：从各 provider 的 balance API 读取剩余额度，不修改、不转发凭证
- **凭证不暴露**：API key 只存在于服务端内存（读取 `~/.dsh/.credentials.yaml` 后查余额，key 不传给浏览器）
- **后台异步**：额度查询 TTL 缓存（60s），批量请求，绝不阻塞仪表盘渲染
- **失败降级**：provider 不可用 → 卡片显示 "余额不可用"，不报错

### 8.2 Provider 适配器

```typescript
interface QuotaProvider {
  name: string;                    // "deepseek", "zai", "kimi"...
  detect(auth: { ref, key }): boolean;  // 是否支持该凭证
  fetchBalance(key: string): Promise<{
    remaining: number;
    currency: string;
    expireAt?: string;
    error?: string;
  }>;
}
```

**首批支持：**
| Provider | Balance API | 凭证来源 |
|---------|------------|---------|
| DeepSeek | `GET /user/balance` | `.credentials.yaml` DEEPSEEK_API_KEY |
| Z.AI | 无公开余额 API（显式降级为「余额不可用」） | `.credentials.yaml` ZAI_API_KEY |
| Kimi | 官方 usage endpoint | `.credentials.yaml` KIMI_CODE_API_KEY |
| MiniMax | 无公开余额 API（显式降级为「余额不可用」） | `.credentials.yaml` MINIMAX_CN_API_KEY |

**UI 展示：**
```
┌─────────────────────────────────────────────┐
│  LLM 订阅额度                    [刷新] [+]  │
├─────────────────────────────────────────────┤
│  🤖 DeepSeek            ████████░░  ¥42.50  │
│     重置: 3天后                余额: ¥200.00 │
├─────────────────────────────────────────────┤
│  🎯 Z.AI                ██████░░░░  $12.30   │
│     重置: 12天后               余额: $50.00   │
├─────────────────────────────────────────────┤
│  💻 Kimi                █████████░  ¥8.90 ⚠️│
│     重置: 1天内                余额: ¥10.00   │
└─────────────────────────────────────────────┘
```

---

## 9. 项目结构

```
hwb/
├── package.json              # type: "module", engines: {node: ">=22.5.0", 零 npm 依赖}
├── src/
│   ├── cli.js                # hwb 统一管理命令（start/stop/status/logs/config/doctor/upgrade）
│   ├── server.js             # HTTP 服务器入口 + 调度器启动
│   ├── service.js            # 后台服务进程（私有控制 socket）
│   ├── lib/                  # 纯内核（零副作用，可单元测试）
│   │   ├── schema.js         # 4 个文件的手写验证器
│   │   ├── normalize.js      # HomeSnapshot → IndexedRows（纯函数）
│   │   ├── read-home.js      # 本地 fs 读取 + 最小 YAML 解析器
│   │   ├── balance.js        # Provider 额度适配器
│   │   ├── status.js         # 会话状态推导（纯函数）
│   │   ├── time.js           # 毫秒时间戳 → ISO（越界降级）
│   │   ├── node-version.js   # Node 版本门槛（单一事实来源）
│   │   ├── file-preview.js   # 预览/下载/上传
│   │   ├── multipart.js      # 流式 multipart 解析
│   │   ├── endpoints.js      # 连接端点规范化
│   │   ├── access-port.js    # 本地接入端口校验
│   │   ├── open-workspace.js # Finder 打开工作区（macOS）
│   │   └── service-config.js # ~/.hwb/config.json
│   ├── dshhome/              # 数据平面
│   │   ├── reader.js         # 编排 read + normalize + store
│   │   ├── remote-reader.js  # 远端只读索引（ssh bash -s cat 4 个元数据文件）
│   │   ├── indexer.js        # 后台索引循环（60s debounce + 按实例退避）
│   │   ├── live-status.js    # 直接读运行中 dsh 的实时会话状态
│   │   ├── live-poller.js    # 实时状态轮询（3s）
│   │   └── store.js          # node:sqlite 封装 + 查询方法
│   ├── control/              # 控制平面（继承优良基因，重新拥有）
│   │   ├── registry.js       # 实例注册表
│   │   ├── monitor.js        # 进程/端口探测（30s 循环）
│   │   ├── prober.js         # HTTP/进程/SSH/远端路径探测
│   │   ├── launcher.js       # dsh web 启动/停止 + token 抓取 + 端点切换
│   │   ├── tunnel.js         # ssh -L 隧道管理
│   │   ├── ssh-opts.js       # SSH 参数统一
│   │   ├── proxy.js          # 根路径 1:1 反代 + WebSocket 升级 + 预览注入
│   │   ├── remote.js         # 远端 dsh web 启停 + 抓 token
│   │   ├── workspace-menu.js # 预览页工作区下拉注入
│   │   └── guard.js          # 进程指纹校验（防误杀）
│   ├── api/                  # 通信层
│   │   ├── server.js         # Node HTTP 服务器 + /api 来源校验
│   │   ├── routes.js         # REST 路由
│   │   └── sse.js            # SSE 广播中心
│   └── web/                  # 展示平面（原生 ESM，无构建）
│       ├── index.html
│       ├── app.js            # 路由 + 状态管理
│       ├── store.js          # 前端数据缓存（SSE 订阅）
│       └── components/
│           ├── workbench.js      # 仪表盘布局
│           ├── recent-projects.js / recent-sessions.js / instance-grid.js
│           ├── usage-card.js
│           ├── add-home.js       # 添加/编辑实例表单
│           ├── endpoint-editor.js
│           ├── file-preview.js   # 预览/下载/上传侧栏
│           ├── log-panel.js
│           ├── form-draft.js     # 表单草稿存取
│           ├── quota-card.js
│           └── preview-image.js / preview-resize.js
├── scripts/                  # 远程 dsh web 冷启动/缓存/隧道脚本
├── dsh-remote-index/         # 多实例会话索引（独立工具）
├── dsh-static-cache/         # dsh 前端静态缓存插件
├── tests/
│   ├── mock-home/            # 模拟 dsh home 目录（用于本地测试）
│   ├── init-mock.js          # 生成 mock 数据脚本
│   └── *.test.js             # 单元测试
├── docs/topology.md          # 拓扑可视化附录
└── DSH_Workbench_Fusion_Architecture.md   # 本文件
```

---

## 10. 里程碑（M1–M7，每个独立可交付）

| 里程碑 | 目标 | 解锁能力 |
|--------|------|---------|
| **M1** — Read Pipeline | `read-home` 读取 4 个文件 → `normalize` → 输出验证 | 整个数据平面基础 |
| **M2** — SQLite + REST/SSE | IndexStore + 查询 API + SSE 推送 | **第一个可见的 Workbench** |
| **M3** — Instance Grid | 实例状态展示 + degraded/drift 处理 | 多实例管理视图 |
| **M4** — Quota Balancer | DeepSeek 额度查询 → 多 Provider → TTL 缓存 | 额度面板 |
| **M5** — Drill-in Pane | 懒 iframe（本地端口/ssh -L）+ 销毁 | 完整使用闭环 |
| **M6** — Re-own Control | 注册表/监控/探测/隧道作为独立模块 | 生产级进程管理 |
| **M7** — Publish | Git tag / release notes / 安装脚本 | 自主维护，PR 不再是 blocker |

---

## 11. 安全与数据卫生

- **Manager 监听 127.0.0.1**，无鉴权，不暴露公网（同旧项目）。
  但**回环不是访问控制**：同机其它用户也能连上这个端口，因此不要把端口暴露到回环之外。
  写方法统一要求同站来源、`/api/*` 只接受回环 Host（DNS rebinding 防护），非浏览器客户端
  （curl）不带这两个头，照常可用 —— 这是单人本机工具的定位，不是多用户服务。
- **API Key 永不越界**：`.credentials.yaml` 中的 key 只用于服务端查余额，浏览器只收到 `{ provider, remaining, currency }`；
  分类错误也**只给分类结果**（原始错误消息可能带请求内容），且日志侧已按「键名」与「凭据形状」双层脱敏。
- **dsh token 的暴露面**：读接口（`GET /api/homes` 与更新响应）都不回传 token —— 实例级与连接端点级
  都不回传，端点只给 `tokenSet: true`（端点编辑器因此把输入框留空显示为「已配置」，留空 = 保持不变，
  清除要显式表达）。唯一的例外是打开实例必经的 `POST /homes/{id}/open`：它必须返回带 token 的
  iframe 入口 URL。也就是说边界是「谁能访问这个端口」，而不是「响应里有没有这个字段」。
- **远程读取只读**：SSH 单条命令只提取元数据，不注入密钥，不修改远程文件
- **进程指纹**：若保留 guard，作为**自主选择**而非继承法则，明确写入文档

---

## 12. 显式非目标（主动排除）

- **不**重新实现 dsh web 本身 —— 我们只托管它，不替代它
- **不**读取 `.zstd` 会话日志做仪表盘展示 —— 只在钻入时由 dsh web 自身处理
- **不**充当 LLM 网关或代理请求 —— 余额查询是只读的
- **不**复制 dsh 的项目结构语义 —— Reader 适配它，不定义它

---

## 13. 与参考项目的借鉴关系

| 项目 | 借鉴点 | 改进/差异 |
|------|--------|----------|
| **Remote_DSH_Center** | 隧道自愈、进程指纹、SSH Config 解析、零远端 Agent | 分离 Data Plane，改为按需隧道，不嵌入 iframe |
| **cc-switch** | 多 Provider 额度查询、Auto Query 机制、额度面板 UI | 集成到工作台，凭证自动发现，后台异步 |
| **quota-axi** | 凭证存储路径、只读安全边界、委托刷新 | 适配器框架，TTL 缓存 |
| **dsh runtime** | `workspace.json` / `session_projcache.json` / `model-tier.json` 结构 | 零 I/O 读取层策略 |

---

## 14. 开放问题（M5 前需确认）

1. **远程钻入方式**：保持 `ssh -L` 隧道，还是改用 WebSocket 代理？
2. **会话标题来源**：`session_projcache` 的 title unit 是否足够，还是需要从 `.zstd` 提取第一行 user message？
3. **首批额度 Provider**：仅 DeepSeek，还是 `.credentials.yaml` 中所有列出的 provider？
