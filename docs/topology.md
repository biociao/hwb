# hwb 多 dsh 管理拓扑图

> 本文档固化了 hwb 实现「多 dsh 实例统一管理」的拓扑结构，作为 `README.md` 与
> `DSH_Workbench_Fusion_Architecture.md` 的可视化附录。
> 版本：v0.1.0 ｜ 2026-09-05

## 1. 总览拓扑

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              BROWSER   (127.0.0.1:4310 页面)                  │
│  ┌─────────────── 工作台仪表盘（零 iframe，纯元数据）─────────────┐            │
│  │ Recent Projects │ Recent Sessions │ Instances │ Token 用量 │ 日志 │        │
│  └───────────────────────────┬───────────────────────┬─────────┘            │
│        REST 首屏 / SSE 增量    │                       │  钻入（唯一 iframe）   │
└───────────────────────────────┼───────────────────────┼──────────────────────┘
                                │                       │
        ┌───────────────────────┴───────────────────────┴─────────────────────┐
        │                hwb SERVER  = 管理平面总控 (src/server.js)              │
        │  ────────────────────────────────────────────────────────────────    │
        │  ①  PRESENTATION PLANE 展示平面 (src/api + src/web)                   │
        │     app.js / store.js / components/*  ──► REST routes.js + sse.js     │
        │  ────────────────────────────────────────────────────────────────    │
        │  ②  DATA PLANE 数据平面 (src/dshhome)     60s debounce 索引循环        │
        │     Reader(本地fs) ─┐                                                 │
        │     remote-reader ──┴─► buildSnapshot ─► normalize ─► SQLite 索引      │
        │     (ssh host bash -s cat 4 文件)            (node:sqlite)            │
        │     配额 quota: balance.js ← .credentials.yaml → Provider balance API │
        │  ────────────────────────────────────────────────────────────────    │
        │  ③  CONTROL PLANE 控制平面 (src/control)     30s 心跳循环              │
        │     registry(状态机) · monitor(进程/端口) · launcher · guard           │
        │     tunnel(ssh -L) · proxy(根路径1:1) · remote · prober                │
        └───┬──────────────┬──────────────────────────────┬────────────────────┘
            │              │                              │
    ┌───────┴──────┐  ┌────┴──────────────────────────────┴─────┐
    │  本机实例     │  │        远程 dsh 实例（多个，经 SSH）        │
    │  (local)     │  │  Host A:  ◄──ssh──┐                      │
    │              │  │  Host B:  ◄──ssh──┤                      │
    │  ~/.dsh      │  │  Host …:  ◄──ssh──┘                      │
    │  dsh web     │  │  每台远端 = ~/.dsh + dsh web(:3080)       │
    │  :<port>     │  │                                          │
    └──────┬───────┘  └──────┬──────────────────────────────┬────┘
           │                 │                              │
           │ 数据:fs 只读      │ 数据: 一次 ssh cat 4 文件(只读)│
           │                 │                              │
           │ 访问: 直连        │ 访问: ssh -L 隧道 + hwb 反代   │
           ▼                 ▼                              ▼
   ┌───────────────┐   ┌──────────────────┐      ┌────────────────┐
   │ http://127.0. │   │ hwb 代理          │      │ 远端 dsh web    │
   │ 0.1:<dshPort>/│   │ 127.0.0.1:<proxy> │ ───► │ 127.0.0.1:     │
   │   ?token=<x>  │   │  (根路径1:1透传)    │      │ <remotePort>   │
   └───────────────┘   └──────────────────┘      └────────────────┘
```

## 2. 三平面分离（核心架构）

| 平面 | 目录 | 节奏 | 职责 |
|------|------|------|------|
| 控制平面 Control Plane | `src/control/` | 30s 心跳 | 实例发现 · 生命周期 · SSH 隧道 · 反向代理 · 状态机 |
| 数据平面 Data Plane | `src/dshhome/` + `src/lib/` | 60s debounce | 读 dsh home → Normalizer → SQLite 索引 · 额度 |
| 展示平面 Presentation Plane | `src/web/` + `src/api/` | 事件驱动 | 工作台（零 iframe）+ 钻入（唯一 iframe）|

单向解耦：`Control → Data` 只传实例/隧道状态；`Data → Presentation` 走 REST + SSE；控制平面不参与数据展示。

## 3. 关键拓扑关系

### 3.1 实例发现与生命周期（控制平面）
- `registry`：状态机 `unknown → probing → running/degraded/crashed/stopped`，失败退避重连。
- `monitor`：探测本机进程存活、HTTP 端口响应、隧道健康。
- `prober`：SSH 连通性、远端路径、远端 dsh web 可用性探测。
- `launcher` / `remote`：本机 / 远端 dsh web 的拉起·停止·重启 + 抓取鉴权 token。
- `guard`：进程指纹校验，防 pid 复用误杀。
- **稳定第一**：连接问题只降级重探测，不重启/杀健康实例；`stop/restart` 需二次确认。

### 3.2 数据聚合（数据平面）
- 统一 Reader：本机走 `fs`，远程经一次 `ssh host bash -s` `cat` 4 个文件（`remote-reader`）。
- 共用同一套 `buildSnapshot → schema 校验 → normalize → SQLite upsert`。
- 只读投影缓存 `session_projcache.json`，**永不碰 `*.zstd`**。
- 版本不兼容只将该域标记 `degraded`，其余域照常，不白屏。
- 配额只读：`.credentials.yaml` 仅取 provider 名 → `balance.js` 查余额 → TTL 缓存 → SSE，key 永不出服务端。

### 3.3 访问 / 钻入（展示平面）
- 工作台仪表盘**零 iframe**，从本地 SQLite 读元数据，渲染成本 O(索引行)。
- 钻入单个实例/会话才懒建**唯一** iframe：
  - **本机**：浏览器 → `http://127.0.0.1:<dshPort>/?token=<x>`（同机直连，无代理）。
  - **远程**：浏览器 → hwb 根路径 1:1 反代 `127.0.0.1:<proxyPort>` → `ssh -L` 隧道 → 远端 `:<remotePort>`。
    （代理不重写路径，`/plugins/*`、`/assets/*`、/api、WebSocket 全走通；鉴权 cookie 按 authority=Host 绑定。）

## 4. 数据流时序

1. 控制循环（30s）→ 实例状态变更 → SSE `instance:status`。
2. 索引循环（60s，成功降频 / 失败退避 ×2 封顶 5min）→ 读 home → 索引更新 → SSE `index:updated`。
3. 配额查询（TTL 60s，单 flight）→ SSE `quota:updated`。
4. 前端：REST 首屏加载 + SSE 增量补丁，只更新变更节点。

## 5. 周边配套（独立子工具）

| 工具 | 作用 |
|------|------|
| `scripts/` | 远程 dsh web 冷启动（`NODE_COMPILE_CACHE` + `vmtouch` 预热）、systemd 托管、Http 缓存反代配置 |
| `dsh-remote-index/` | 只读索引器，合并本机 + 远程会话成统一卡片 / session 列表，不读 `.zstd` |
| `dsh-static-cache/` | dsh 前端静态资源 `immutable` 缓存插件（Cordis），解远程页面慢 |

## 6. 安全边界

- hwb 仅监听 `127.0.0.1`，无鉴权，不暴露公网。
- API key 永不越界：浏览器只收到 `{ provider, remaining, currency }`。
- 远程读取只读：SSH 单条命令只提取元数据，不注入密钥、不修改远端文件。
- 进程指纹：kill 前确认目标是 hwb 拉起且仍存活的子进程。
