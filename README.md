# hwb — harness workbench

> 数据平面 over dsh homes（M1 + M2 已落地）
> 版本：**v0.1.0** ｜ Node.js 22+ ｜ 原生 ESM ｜ **零 npm 依赖**（用 `node:sqlite`）

`hwb`（harness workbench）是一个面向 `dsh`（DeepSeek Harness）的**本地工作台**：它读取
你的 dsh home 目录（项目、会话、模型 tier、provider 凭证），构建一份本地 SQLite 索引，
在一个纯元数据仪表盘里跨实例展示**最近项目 / 会话 / 实例状态 / Token 用量**，并通过一个
**控制平面**去启动、停止、重启 dsh web 进程（本机），或经 SSH 隧道接入**远端** dsh 实例。

它**只读** dsh 的元数据文件，**绝不修改**任何 dsh 文件，也**永不阅读** `.zstd` 会话正文。
它也不替代 dsh web——只托管它、显示它，让你在一处看全所有实例。

> 设计文档（三平面架构、数据模型、控制状态机、里程碑）见
> [`DSH_Workbench_Fusion_Architecture.md`](DSH_Workbench_Fusion_Architecture.md)。
> 变更记录见 [`CHANGELOG.md`](CHANGELOG.md)。

---

## 目录

- [它做什么 / 不做什么](#它做什么--不做什么)
- [核心能力](#核心能力)
- [环境要求](#环境要求)
- [快速开始](#快速开始)
- [工作台怎么用](#工作台怎么用)
- [读取的 dsh home 文件](#读取的-dsh-home-文件)
- [架构：三平面分离](#架构三平面分离)
- [REST API](#rest-api)
- [辅助工具包](#辅助工具包)
- [项目结构](#项目结构)
- [测试](#测试)
- [已知限制](#已知限制)
- [安全边界](#安全边界)
- [路线图](#路线图)
- [许可](#许可)

---

## 它做什么 / 不做什么

**做：**

- 读取多个 dsh home，聚合出**跨实例**的统一视图：最近项目、最近会话、各实例状态与额度。
- 为每个实例展示 **Token 用量**：总量、输入/输出、缓存命中/创建、缓存命中率，以及
  按 **维度**（合计 / 项目 / LLM provider / 实例）**堆叠**的分时趋势柱状图。
- **托管** dsh web：本机直接拉起子进程，远端经 `ssh -L` 按需隧道接入。
- 每个实例提供一个 **1:1 根路径反向代理** 入口，让 dsh web 的 `/plugins/*`、`/assets/*`、
  WebSocket 全部走通，浏览器无需直接暴露原始端口。

**不做（显式非目标，见架构文档 §12）：**

- 不重新实现 dsh web 本身，只托管与展示它。
- 不读取 `.zstd` 会话正文做仪表盘（只在钻入时交给 dsh web 自己处理）。
- 不充当 LLM 网关 / 代理请求——余额查询是只读的，key 永不出服务端。
- 不复制 dsh 的项目结构语义——Reader 适配它，不定义它。

---

## 核心能力

| 能力 | 说明 |
|------|------|
| **多实例聚合** | 一张工作台看全本机 + 所有 SSH 远程 dsh 实例的项目 / 会话 / 用量 |
| **零 I/O 读取层** | 只读投影缓存 `session_projcache.json`（`projection cache` 层），**不下探 `.zstd`** |
| **版本降级** | 每个文件按 `unit.version` 校验；主版本不兼容时该域标 `degraded`，其余照常，不白屏 |
| **进程管理** | 30s 心跳探测 + 状态机（stopped/running/degraded/gone）+ 退避重连 + 进程指纹防误杀 |
| **按需隧道** | 远端点「打开」才建 `ssh -L`，关闭后不复用长期隧道，省端口与连接 |
| **Token 用量面板** | 汇总 + 分时堆叠趋势（自适应桶粒度）+ 按项目拆分 |
| **会话深链** | 客户端装有 `dsh-session-deeplink` 插件时，可二段跳转直达单个会话，且有加载遮罩防白闪 |
| **SSH 远程生命周期** | 远端点按钮即可启动 / 重启 / 关闭远端 dsh web（把 `dsh-remote-web.sh` 算法搬进 Node） |

---

## 环境要求

- **Node.js ≥ 22**（需要 `node:sqlite`，Node 22.5+；建议 22.x 或更新，实测 v22.21.1）。
- 本机需可用 `dsh` 命令（起本地 dsh web 时；`--profile web` 写法兼容新旧版）。
- 远端实例需可通过 SSH 别名/密钥连接（`~/.ssh/config` 的 `Host` 或 `user@host`）。

---

## 快速开始

克隆后（项目无需构建，无 bundler）：

```bash
# 安装依赖：无（零 npm 依赖）。直接用 Node 运行即可。
node src/server.js --home ~/.dsh
# 默认监听 http://127.0.0.1:4310
```

命令行选项：

| 选项 | 默认 | 说明 |
|------|------|------|
| `--home <path>` | — | 注册一个 dsh home（可重复传，注册多个实例） |
| `--port <n>` | `4310` | hwb 监听端口（仅绑定 `127.0.0.1`） |
| `--db <path>` | `~/.hwb/hwb.db` | SQLite 索引库；传 `:memory:` 用内存库 |
| `--interval-ms <n>` | `60000` | 数据索引循环基线周期（毫秒） |

推荐用 npm 脚本：

```bash
npm start          # node src/server.js
npm test           # node --test tests/*.test.js
```

打开 `http://127.0.0.1:4310`，首次会看到一个 **onboarding 引导**：自动检测 `~/.dsh` 或手动添加。

---

## 工作台怎么用

顶部是一个 **tab 栏**：`◧ 工作台` + 每个实例一个可拖拽排序的 tab。视图切换只 show/hide，
**绝不销毁重建 iframe**（持久化、不重载）。

**工作台（仪表盘，纯元数据、零 iframe）** 分四块：

1. **Recent Projects** —— 近 7 天内活跃的项目，跨实例聚合；点击跳转到该项目最新会话所属实例。
2. **Recent Sessions** —— 最近会话，带 token 用量 chip、上下文压力条、状态 chip（运行中/已完成/空闲）。
3. **Instances** —— 每个 dsh 实例的实例卡：状态 chip、索引状态、workspace/会话数，以及
   open / stop / restart / reindex / remove 等操作按钮。
4. **Token 用量** —— 汇总卡 + 分时趋势堆叠柱状图（支持 24h / 3天 / 7天 / 14天 / 30天 周期，
   按 合计 / 项目 / LLM provider / 实例 维度切换）+ 按项目拆分。

> **项目 ↔ 会话联动高亮**：把鼠标悬停在某个项目（或会话）上，会在两栏间同步高亮同名项目。

**钻入某个实例 / 会话**：点实例 tab 或某项目/会话行，会懒创建一个持久 iframe 挂载该 dsh web
（本地直连端口，或远端经 SSH 隧道 + 反代）。退出时只隐藏，再次进入不重载。

**添加实例**（工作台 Instances 区块「＋ 添加」）：
- **本机**：填 dsh home 路径，如 `~/.dsh`。
- **SSH 远程**：填 SSH 主机（别名 / `user@host`）+ 远端 dsh web 监听端口（默认 `3080`），
  可选填远端 home 路径、远端启动命令、token 日志路径。hwb 会代管远端 dsh web 的启停。

---

## 读取的 dsh home 文件

Reader 只读取以下 **4 个文件**，均为 schema-versioned：

| 文件 | 内容 | 版本 | 关键规则 |
|------|------|------|---------|
| `storages/workspace.json` | 工作区列表、会话 ID 映射、归档状态 | 2 | 轻量，可频繁读 |
| `storages/session_projcache.json` | 会话投影缓存：tokenUsage、contextPressure、status | 3 | **零 I/O 读取层** |
| `model-tier.json` | 订阅方案、模型路由 tiers | 2 | 可选；缺失不判定 degraded |
| `.credentials.yaml` | provider 引用（只读 provider 名，**不读 key 值**） | — | 可选；缺失不判定 degraded |

**硬性规则：永不碰 `*.zstd`。** 工作台活在投影缓存（`projection cache`）第一层，绝不下探日志。

> 某个文件升级到未支持的主版本时，只把**该域**标记为 `degraded`，其余域照常索引，
> 前端显示「dsh 已升级 — 索引待适配」提示，而不是白屏。

---

## 架构：三平面分离

```
┌────────────────────────────────────────────────────────────────────┐
│  CONTROL PLANE 控制平面  实例发现 · 生命周期 · SSH 隧道 · 状态机     │
│  节奏: 30s 心跳，SSE 推送状态变更                                    │
├────────────────────────────────────────────────────────────────────┤
│  DATA PLANE 数据平面     读 dsh home → Normalizer → SQLite 索引      │
│  节奏: 60s debounce，失败退避，永不阻塞仪表盘                         │
├────────────────────────────────────────────────────────────────────┤
│  PRESENTATION PLANE 展示平面  工作台（零 iframe）+ 钻入（唯一 iframe）│
└────────────────────────────────────────────────────────────────────┘
```

- **控制平面**只回答三件事：实例在跑吗？dsh web 在哪个端口？远端隧道建好了吗？
  它**不参与**数据展示。
- **数据平面**是全新设计：Reader → Normalizer（纯函数）→ SQLite 索引。
  控制平面与数据平面**单向解耦**（Control → Data 只传递实例/隧道状态）。
- **展示平面**默认渲染本地索引元数据（O(索引行)），**绝不**同时挂 N 个 iframe；
  iframe 只在钻入单个会话时按需创建、退出销毁。

关键设计原则（详见架构文档）：

- 工作台仪表盘**绝不**挂载 N 个 iframe——它从本地 SQLite 读元数据。
- 每个实例的 iframe 统一走 hwb 的**根路径 1:1 反向代理**，因为它不重写路径，
  所以 `/plugins/*`、`/assets/*`、WebSocket 全部走通。
- 双循环刷新：控制循环 30s + 索引循环 60s（debounced），互不阻塞。

---

## REST API

`createServer` 仅绑定 `127.0.0.1`，**无鉴权**（§11 安全声明）。

| Method | Path | 说明 |
|--------|------|------|
| `GET` | `/api/events` | SSE 订阅（`index:updated` / `instance:status` / `quota:updated`） |
| `GET` | `/api/homes` | 全部实例（含 runtime 状态） |
| `GET` | `/api/homes/detect` | 检测默认 `~/.dsh` 是否存在 |
| `POST` | `/api/homes` | 注册实例（本机 `homePath`；远程 `host`+`remotePort`） |
| `PUT` | `/api/homes/{homeId}` | 编辑实例配置（alias / homePath / 远程参数） |
| `DELETE` | `/api/homes/{homeId}` | 移除实例（只删 hwb 索引，不碰 dsh 文件） |
| `POST` | `/api/homes/order` | 持久化拖拽排序 |
| `POST` | `/api/homes/{homeId}/reindex` | 强制重新索引 |
| `POST` | `/api/homes/{homeId}/open` | 打开实例（本机拉起 / 远端建隧道） |
| `POST` | `/api/homes/{homeId}/restart` | 重启实例 |
| `POST` | `/api/homes/{homeId}/stop` | 停止实例（远端同时停远端 dsh web） |
| `GET` | `/api/projects/recent` | 最近项目（`?days=7&limit=20`） |
| `GET` | `/api/sessions/recent` | 最近会话（`?homeId=&limit=50`） |
| `GET` | `/api/workspaces` | 工作区列表 |
| `GET` | `/api/usage` | 用量汇总 + 趋势 + 按项目（`?days=30&hours=24`） |
| `GET` | `/api/quota` | 额度列表（TTL 缓存；只读） |
| `POST` | `/api/quota/refresh` | 强制刷新额度 |

> 额度（§8）**只返回** `{ provider, remaining, currency }`；**API key 永不越界**——
> key 只在服务端内存（读 `.credentials.yaml` 后查余额），浏览器拿不到。

---

## 辅助工具包

仓库里除了主工作台，还带三组**运维 / 性能**辅助工具（各自带独立 README）：

### 1. `scripts/` — 远程 dsh web 冷启动与性能

| 文件 | 用途 |
|------|------|
| `dsh-web-cached.sh` | 替换 `nohup dsh web &` 的启动包装：`NODE_COMPILE_CACHE` + 关遥测 + `vmtouch` 预热 + `exec dsh` |
| `dsh-web-cached.service` | 可选 systemd 用户服务，托管 dsh web（开机自启 + 崩溃重启 + 预热） |
| `dsh-remote-web.sh` | 本地一键：SSH 到远端拉 dsh web、抓回流 token、建隧道、打 URL |
| `dsh-http-cache.Caddyfile` | 给 dsh web 前端静态资源加不可变缓存头的反代配置（Caddy） |
| `dsh-http-cache.nginx.conf` | 同上（nginx 版） |

详见 `scripts/README.md`、`scripts/README-dsh-remote-web.md`、`scripts/README-http-cache.md`。

### 2. `dsh-remote-index/` — 多实例会话总览（独立工具）

轻量索引器，把本机 + 远程主机的 dsh 会话合并成一份统一 projects/sessions 卡片列表，
**不读会话正文**（只读头部一行 + stat + 投影缓存）。可 `--html <out>` 生成自包含卡片页，
`--watch <sec>` 准实时刷新。详见 `dsh-remote-index/README.md`。

### 3. `dsh-static-cache/` — dsh 前端静态资源缓存插件（Cordis）

一个 `dsh` 插件（`bundle.patch` = `cordis.patch.yml`），在 webServer 上注册 `/assets/` 前缀路由，
给前端静态资源加 `Cache-Control: immutable` + ETag/Last-Modified → 304，解决远程打开页面/实例慢。
只接管 `/assets/*`，不影响 `/api`、WebSocket 与 index 注入。详见 `dsh-static-cache/README.md`。

---

## 项目结构

```
hwb/
├── package.json                 # type:module, engines:node>=22, 零依赖
├── src/
│   ├── server.js                # HTTP 入口 + 调度器启动 + 退出清理
│   ├── lib/                     # 纯内核（零副作用，可单测）
│   │   ├── schema.js            # 4 个文件的手写验证器（unit.version）
│   │   ├── normalize.js         # HomeSnapshot → IndexedRows（纯函数）
│   │   ├── read-home.js         # 本地读取 + 最小 YAML 解析（provider 名）
│   │   ├── balance.js           # Provider 额度适配器（readCredentials/queryBalance）
│   │   └── status.js            # 会话工作状态推导（纯函数）
│   ├── dshhome/                 # 数据平面
│   │   ├── reader.js            # 编排 read + normalize + store
│   │   ├── indexer.js           # 后台索引循环（60s debounce + 退避）
│   │   ├── store.js             # node:sqlite 封装 + 查询（用量/趋势/项目）
│   │   └── quota.js             # 额度服务（TTL 缓存 60s，单 flight）
│   ├── control/                 # 控制平面
│   │   ├── registry.js          # 实例注册表（状态机 + 退避）
│   │   ├── monitor.js           # 进程/端口探测（30s 循环）
│   │   ├── launcher.js          # dsh web 启动/停止/重启 + token 抓取 + 深链探测
│   │   ├── tunnel.js            # ssh -L 按需隧道
│   │   ├── proxy.js             # 根路径 1:1 反向代理（含 WebSocket 升级）
│   │   ├── remote.js            # 远端 dsh web 启停 + 抓 token
│   │   ├── prober.js            # HTTP/进程/SSH/远端路径探测（独立可测）
│   │   └── guard.js             # 进程指纹（防误杀）
│   ├── api/
│   │   ├── server.js            # Node HTTP 服务器 + 静态资源
│   │   ├── routes.js            # REST 路由
│   │   └── sse.js               # SSE 广播中心
│   └── web/                     # 展示平面（原生 ESM，无构建）
│       ├── index.html           # 布局 + 全部样式
│       ├── app.js               # 路由 + 状态管理 + 持久 iframe
│       ├── store.js             # 前端缓存（SSE 订阅 + 工具）
│       └── components/
│           ├── workbench.js         # 仪表盘布局
│           ├── recent-projects.js
│           ├── recent-sessions.js
│           ├── instance-grid.js
│           ├── usage-card.js        # 用量卡 + 堆叠趋势图 + 周期/维度切换
│           ├── quota-card.js        # 额度卡片（见「已知限制」）
│           └── add-home.js          # 添加/编辑实例表单 + onboarding
├── scripts/                     # 远程 dsh web 冷启动/缓存/隧道运维脚本
├── dsh-remote-index/            # 多实例会话索引（独立工具）
├── dsh-static-cache/            # dsh 前端静态缓存插件
├── tests/                       # 单元测试 + mock-home 夹具
└── DSH_Workbench_Fusion_Architecture.md   # 设计文档（三平面/数据模型/里程碑）
```

---

## 测试

```bash
npm test        # node --test tests/*.test.js
```

当前 **62 个用例全绿**，交叉覆盖：schema 校验 / normalize 纯函数 / read-home 读取 /
credentials 解析 / status 推导 / quota 适配器与 TTL 缓存 / store 查询与用量聚合 /
monitor 状态机 / proxy 反代与 WebSocket / launcher 的 token 抓取与深链探测。
`tests/mock-home/` 是真实 `~/.dsh` 形状的夹具（由 `tests/init-mock.js` 生成）。

---

## 已知限制

> 这些是 v0.1.0 已知的不完整/边界项，非缺陷即**尚未接线**的部分，提前说明以便透明发布。

- **额度卡片未接通仪表盘**：`src/web/components/quota-card.js` 的 `renderQuotaCards` 已实现，
  后端 `/api/quota` ✓、`/api/events` 的 `quota:updated` ✓、`QuotaService` + 各 provider 适配器 ✓、
  单测 ✓ —— 但仪表盘**尚未**把它渲染出来（前端目前用量卡里没有额度区块）。如需启用，把
  `renderQuotaCards` 挂到工作台即可；属**剩余 5% 接线**工作，不影响其余功能。
- **仅 `deepseek`/`kimi` 有公开余额 API**：`zai`/`minimax` 无公开 balance endpoint，
  API 显式降级为「余额不可用」，不会静默失败。
- **会话 deep-link 依赖客户端插件**：`dsh-session-deeplink` 需经
  `dsh plugin --profile web add dsh-session-deeplink` 安装；未装插件的 home 深链不触发
  （框架已保证「装了插件」能正确探测 + 保留 `?session=`）。
- **新 dsh 鉴权 token**（≥`0.1.2-rc.1`）：`dsh web` 每次启动打印带 `?token=` 的 URL，
  hwb 会抓取并拼进入口 URL；旧版 dsh（不打印 token）自动回退裸 URL。

---

## 安全边界

- hwb 仅监听 **127.0.0.1**，无鉴权，不暴露公网。
- **API key 永不越界**：`.credentials.yaml` 的 key 只用于服务端查余额，浏览器只收到
  `{ provider, remaining, currency }`（单测专门断言 key 不出现在列表里）。
- **远程读取只读**：SSH 单条命令只提取元数据，不注入密钥、不修改远端文件。
- **进程指纹**：`guard.js` 在 kill 前确认目标是我们拉起且仍存活的子进程，避免 pid 复用误杀。

---

## 路线图

架构文档定义了 **M1–M7** 里程碑。当前进度：

| 里程碑 | 状态 |
|--------|------|
| M1 — Read Pipeline | ✅ 完成 |
| M2 — SQLite + REST/SSE | ✅ 完成 |
| M3 — Instance Grid | ✅ 完成 |
| M4 — Quota Balancer | 🟡 后端 + 单测完成（UI 接线池） |
| M5 — Drill-in Pane | ✅ 完成 |
| M6 — Re-own Control | ✅ 完成 |
| M7 — Publish | 🎯 v0.1.0（本版） |

后续方向（见架构文档 §14 开放问题）：远程钻入方式、会话标题来源、首批额度 provider 的取舍等。

---

## 许可

[MIT](LICENSE)
