# Changelog

All notable changes to **hwb** are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), this project adheres to
Semantic Versioning.

## [0.1.0] — 2026-09-04

**初版发布。** `hwb`（harness workbench）是一个面向 dsh home 的**数据平面工作台**：
读取 dsh 的项目 / 会话 / 模型 tier / provider 凭证，构建 SQLite 索引，并在一个纯元数据
仪表盘里跨实例展示「最近项目 / 会话 / 实例状态 / Token 用量」；同时用控制平面代为
启动 / 停止 / 重启本机 dsh web，或经 SSH 按需隧道接入远端 dsh 实例。

### Added

#### 数据平面（DSH Home Reader）
- 读取 4 个 schema-versioned 文件：`workspace.json`(v2)、`session_projcache.json`(v3)、
  `model-tier.json`(v2, 可选)、`.credentials.yaml`(可选)。
- **零 I/O 读取层**：只读投影缓存（`projection cache`），**永不触碰 `.zstd`**。
- 最小 YAML 解析器：只提取 provider 名，**不读 key 值**。
- `HomeSnapshot → Normalizer（纯函数）→ IndexedRows → SQLite upsert` 全链路。
- 版本降级策略：主版本不兼容时只把该域标 `degraded`，其余域照常索引，前端提示而非白屏。
- 会话工作状态推导：把 `sessionStats / goal / todos / subagent / plan / permissions`
  等状态类投影折叠成 `running / completed / idle` 三态（纯函数，可单测）。

#### 索引与查询（SQLite）
- `node:sqlite`（Node 22.5+）零依赖存储 + 迁移逻辑。
- 后台索引循环：60s 基线，失败 ×2 封顶 5min，连续成功 ÷1.5 回落基线。
- 跨实例查询：`recentProjects` / `recentSessions` / `listWorkspaces` / `usageSummary` /
  `usageTrend` / `usageByProject` / `usageTrendGrouped`。
- **用量趋势堆叠柱状图**：按 合计 / 项目 / LLM provider / 实例 维度分组；桶粒度随统计周期
  自适应（24h=30min、3d=1h、7d=3h、14d=6h、30d=12h），保证柱数在合理范围。

#### 控制平面（进程与隧道）
- 实例注册表 + 状态机（`unknown/probing/running/degraded/crashed/stopped/gone`），
  degraded 退避重连（1/2/4/8/16/30s）。
- 30s 心跳探测（HTTP 端口 / 进程 / SSH 连通 / 远端路径），状态变更经 SSE 广播。
- `Launcher`：本机 `dsh --profile web` 拉起；远端经 `ssh -L` 按需隧道接入。
- **进程指纹防误杀**：kill 前确认是我们拉起且仍存活（非 pid 复用）。
- **根路径 1:1 反向代理**：为每个实例提供独立本地端口，透传 Host、SSE 分块、
  处理 `upgrade`(WebSocket)，让 dsh web 的 `/plugins/*`、`/assets/*`、实时通道全走通。
- **新版 dsh 鉴权 token**（≥0.1.2-rc.1）：抓取 stdout 的 `?token=`，旧版自动回退裸 URL。
- **会话深链探测**：`authFetch`（手动处理 303+set-cookie）+ `probeDeeplink`
  （识别 `session-deeplink` 插件）；前端二段跳转 + 加载遮罩，避免白闪。

#### 远程 dsh 生命周期（SSH）
- `remote.js`：把 `dsh-remote-web.sh` 的「远端拉起 + 抓 token」算法搬进 Node。
- 远端实例按钮按运行态显示：stop→**启动**、runing→**重启/关闭**。
- 修复三个高频坑：SSH 会话 PATH 缺 `dsh`、含空格命令被 `ssh` 按空白拆开、
  新版要求显式 `--profile web`。

#### 展示平面（原生 ESM SPA，零构建）
- 工作台仪表盘（零 iframe）：Recent Projects / Recent Sessions / Instances / Token 用量。
- 项目↔会话**联动高亮**；实例 tab **拖拽排序**并持久化。
- 持久 iframe：切换视图只 show/hide，不销毁重建；懒创建、退出隐藏。
- onboarding 空态引导 + 添加/编辑实例表单（本机 / SSH 远程字段显隐切换）。
- 实例设置为弹层。

#### 辅助工具
- `scripts/`：`dsh-web-cached.sh`（NODE_COMPILE_CACHE + 关遥测 + vmtouch 预热）、
  `dsh-web-cached.service`（systemd 托管）、`dsh-remote-web.sh`（一键远端拉起/抓token/建隧道）、
  `dsh-http-cache.Caddyfile` 与 `dsh-http-cache.nginx.conf`（静态资源反代缓存）。
- `dsh-remote-index/`：多实例会话索引器（`dsh-instance-index.mjs` + `dsh-merged-index.mjs`），
  生成自包含卡片页（`--html --watch`）。
- `dsh-static-cache/`：dsh Cordis 插件，给 `/assets/*` 加 immutable 缓存头，解决远程打开慢。

#### 测试
- 62 个单元测试全绿，覆盖 schema / normalize / read-home / credentials / status /
  quota / store / monitor / proxy / launcher。
- `tests/mock-home/` 夹具（由 `tests/init-mock.js` 生成）。

### Known Limitations

- **额度卡片未接线**：`quota-card.js` 与后端 `/api/quota`、`quota:updated` SSE 均已实现，
  但仪表盘尚未渲染额度区块（剩余 5% 接线工作）。
- 仅 `deepseek`/`kimi` 有公开余额 API；`zai`/`minimax` 显式降级为「余额不可用」。
- 会话深链依赖客户端 `dsh-session-deeplink` 插件；未装插件时深链不触发。

---

## Unreleased

（预留下一版本变更记录。）
