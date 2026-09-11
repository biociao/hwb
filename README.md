![hwb](images/hwb.png)

# hwb — harness workbench

> 版本：**v0.1.1** ｜ Node.js 22.5+ ｜ 原生 ESM ｜ **零 npm 依赖**（用 `node:sqlite`）


[![CI](https://github.com/biociao/hwb/actions/workflows/ci.yml/badge.svg)](https://github.com/biociao/hwb/actions/workflows/ci.yml)
[![version](https://img.shields.io/badge/version-v0.1.1-blue)](CHANGELOG.md)
[![milestones](https://img.shields.io/badge/milestones-M1%E2%80%93M7-brightgreen)](DSH_Workbench_Fusion_Architecture.md)
[![node](https://img.shields.io/badge/node-%E2%89%A522-blue)](package.json)
[![npm deps](https://img.shields.io/badge/npm_deps-0-blue)](package.json)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

`hwb`（harness workbench）是一个面向 harness工具（目前主要支持的是DeepSeek Harness，即dsh）的**本地工作台**，用于应付需要开启多个dsh实例：它会构建一份本地 SQLite 索引，
在一个纯元数据仪表盘里跨实例展示**最近项目 / 会话 / 实例状态 / Token 用量**，并通过一个
**控制平面**去启动、停止、重启 dsh web 进程（本机），或经 SSH 隧道接入**远端** dsh 实例。

它**只读** dsh 的元数据文件，**绝不修改**任何 dsh 文件，也**永不阅读** `.zstd` 会话正文。
它也不替代 dsh web——只托管它、显示它，让你在一处看全所有实例。

> 设计文档（三平面架构、数据模型、控制状态机、里程碑）见
> [`DSH_Workbench_Fusion_Architecture.md`](DSH_Workbench_Fusion_Architecture.md)；
> 拓扑可视化附录见 [`docs/topology.md`](docs/topology.md)。
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
  按 **维度**（合计 / 项目 / LLM provider / 按 Model / 实例）**堆叠**的分时趋势柱状图。
- **托管** dsh web：本机直接拉起子进程，远端经 `ssh -L` 按需隧道接入。
- 每个实例给浏览器一个**直接可寻址**的入口：**本地** home 用原始服务连接
  `http://127.0.0.1:<port>/?token=<x>`（同机直连，无需转发）；**远程** home 经 hwb 的
  **1:1 根路径反向代理** 提供（`/plugins/*`、`/assets/*`、WebSocket 全部走通，不暴露隧道端口）。

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
| **当前项目 / 当前会话** | 每个实例（本地 + 远程）缓存「最近活跃会话 + 其所属项目」的元数据与状态（标题 / 状态 chip / token / 上下文 / 最近活动），并在 Recent Projects / Recent Sessions 中跨实例聚合展示 |
| **零 I/O 读取层** | 只读投影缓存 `session_projcache.json`（`projection cache` 层），**不下探 `.zstd`** |
| **远程只读索引** | 经一次 `ssh host bash -s` 在远端 cat 出 dsh home 的 4 个元数据文件，与本地共用同一套 schema 验证 / 域降级——远程实例的当前项目/会话与本地同构 |
| **版本降级** | 每个文件按 `unit.version` 校验；主版本不兼容时该域标 `degraded`，其余照常，不白屏 |
| **进程管理** | 30s 心跳探测 + 状态机（stopped/running/degraded/gone）+ 退避重连 + 进程指纹防误杀；**稳定第一**——连接问题只降级重探测，不重启/杀实例，启停需确认 |
| **按需隧道** | 远端点「打开」才建 `ssh -L`，关闭后不复用长期隧道，省端口与连接 |
| **手填 token 直连** | 实例设置/添加表单 `token` 栏——远端自行更新 dsh 后填入新 token 即直连，**不重启实例**；不可达时自带可自行执行的 ssh 命令提示 |
| **Token 用量面板** | 汇总 + 分时堆叠趋势（自适应桶粒度）+ 按项目拆分 |
| **会话深链** | 客户端装有 `dsh-session-deeplink` 插件时，可二段跳转直达单个会话，且有加载遮罩防白闪 |
| **SSH 远程生命周期** | 远端点按钮即可启动 / 重启 / 关闭远端 dsh web（把 `dsh-remote-web.sh` 算法搬进 Node） |

---

## 环境要求

- **Node.js ≥ 22**（需要 `node:sqlite`，Node 22.5+；建议 22.x 或更新，实测 v22.21.1）。
- 本机需可用 `dsh` 命令（起本地 dsh web 时；用**裸 `dsh web --port <n> [--no-open]`**，新旧版 dsh 均兼容）。
- 远端实例需可通过 SSH 别名/密钥连接（`~/.ssh/config` 的 `Host` 或 `user@host`）。

---

## 快速开始

克隆后（项目无需构建，无 bundler）：

```bash
# 安装依赖：无（零 npm 依赖）。直接用 Node 运行即可。
node src/server.js
# 默认监听 http://127.0.0.1:4310
```

> **不需要 `--home`**：实例（本机 dsh home / SSH 远程）统一在**工作台 UI** 里添加、管理
> （见下文「添加实例」），首次启动的 onboarding 会自动检测 `~/.dsh` 并提示添加。
> `--home` 只是**可选**的启动时预注册捷径，不传完全正常。

### 统一管理命令

在仓库目录执行一次 `npm link`，即可在任意目录使用 `hwb`（Node.js 22.5+，macOS / Linux）。

```bash
hwb start                  # 后台启动，等待 HTTP 监听成功
hwb status                 # 状态、PID、启动时间、实际监听端口
hwb stop                   # 优雅停止
hwb restart                # 重启并应用新配置
hwb logs -n 100             # 最近 100 行日志
hwb logs -f                # 持续跟随日志（支持轮转）
hwb config show            # 查看完整配置
hwb config set port 4320
hwb config set verbose true
hwb config set homes '["~/.dsh"]'
hwb config update ./hwb.json # 合并 JSON 文件；校验成功后原子保存
hwb restart                # 更新配置后执行
hwb doctor                 # Node、配置与运行服务 HTTP 检查
hwb test                   # 全部测试
hwb test --test-name-pattern=CLI
hwb upgrade                # Git 快进更新 → 测试 → 原在运行则重启
hwb --help
```

`hwb` / `hwb serve` 保留前台运行方式，并读取同一份配置；原有 `--port` 等选项可覆盖配置。
`node src/server.js` 和 `npm start` 仍是原来的直接启动方式，不读取新配置文件，也不受后台管理命令控制。

配置保存在 `~/.hwb/config.json`，支持 `port`、`db`、`intervalMs`、`homes`、`log`、`verbose`、`silent`；
`log: false` 禁用结构化文件日志。`hwb config path` 显示配置位置。相对路径在保存时转为绝对路径。
设置 `HWB_DIR=/其他目录 hwb ...` 可隔离一套服务的配置、数据库和运行文件（多服务需配置不同端口）。
实例及连接端点继续通过工作台管理，保存在数据库中。

后台服务不依赖终端，但不提供开机自启或崩溃自动拉起。它通过权限为 `0600` 的本地套接字管理自身，
不会按端口或 PID 文件杀进程。启动失败可查看 `~/.hwb/service.log`；`status` 在服务未就绪时返回退出码 1。
启停命令通过锁文件串行执行；若管理命令被强制终止，确认没有启停操作后可删除 `~/.hwb/service.lock` 再试。
停止、重启会关闭 hwb 托管的 dsh 子进程，应在相关会话空闲时操作。

`upgrade` 仅用于 Git 安装：要求工作区干净且当前分支有 upstream，只执行 `git pull --ff-only`。
测试失败时不会重启服务，也不会自动回滚已更新的源码；修复后重新测试并重启。
npm 安装可使用 `npm install -g hwb@latest` 后执行 `hwb restart`。

命令用 npm 脚本：

```bash
npm start          # node src/server.js
npm test           # node --test tests/*.test.js
```

命令行选项：

| 选项 | 默认 | 说明 |
|------|------|------|
| `--home <path>` | — | **可选**：启动时预注册一个 dsh home（可重复传，注册多个实例）。缺省不传，靠 onboarding 自动检测 `~/.dsh` 或经 UI 添加 |
| `--port <n>` | `4310` | hwb 监听端口（仅绑定 `127.0.0.1`） |
| `--db <path>` | `~/.hwb/hwb.db` | SQLite 索引库；传 `:memory:` 用内存库 |
| `--interval-ms <n>` | `60000` | 数据索引循环基线周期（毫秒） |
| `-v` / `--verbose` | `info` | 输出调试级日志（含每个实例状态迁移、子进程生命周期等细节） |
| `--silent` | 关 | 完全不输出到终端，仅写日志文件（适合作为服务跑） |
| `--log <file>` | `~/.hwb/hwb.log` | 日志文件路径；出错时排查用 |
| `--no-log` | — | 不落盘，只输出到终端 |

> **日志与排查**：所有输出走同一套结构化日志（`src/lib/logger.js`），分级（debug/info/warn/error/fatal）、
> 带时间戳与作用域（如 `[launcher]`、`[monitor]`），出错时把**上下文字段**（homeId / host / 端口 /
> 子进程 stderr 尾部 / 退出码）一并带上，Error 对象打印完整堆栈。日志文件默认 `~/.hwb/hwb.log`，
> 超过 1MiB 自动轮转保留 `.1/.2` 两代。当 dsh web 启动失败、SSH 隧道断连、远端 home 不可达时，
> 查看该文件即可定位根因。

打开 `http://127.0.0.1:4310`，首次会看到一个 **onboarding 引导**：自动检测 `~/.dsh` 或手动添加。

---

## 工作台怎么用

顶部是一个 **tab 栏**：`◧ 工作台` + 每个实例一个可拖拽排序的 tab。视图切换只 show/hide，
**绝不销毁重建 iframe**（持久化、不重载）。

**工作台（仪表盘，纯元数据、零 iframe）** 分五块：

1. **Recent Projects** —— 近 7 天内活跃的项目，跨实例聚合；点击跳转到该项目最新会话所属实例。
2. **Recent Sessions** —— 最近会话，带 token 用量 chip、上下文压力条、状态 chip（运行中/已完成/空闲）。
3. **Instances** —— 每个 dsh 实例的实例卡：状态 chip（已连接 / 连接不可达 / 未连接，域降级时另加
   「⚠ <域> 降级」chip）、workspace/会话数，以及 **连接（连接到 / 必要时拉起 dsh web）** / **断开** /
   **切换**（配置了多个连接端点时）/ **⚙ 设置** 按钮。
   重启 / 停止 / 重新索引 / 移除 在 **⚙ 设置** 弹窗内（不在卡片上，避免误点）。
   远程实例经 SSH 只读索引入库后同样显示。
   （实例卡不再重复展示「当前项目/当前会话」——该信息已由 Recent Projects / Recent Sessions 聚合呈现。）
4. **Token 用量** —— 汇总卡 + 分时趋势堆叠柱状图（支持 24h / 3天 / 7天 / 14天 / 30天 周期，
   按 合计 / 项目 / LLM provider / 按 Model / 实例 维度切换）+ 按项目拆分。
5. **运行日志** —— 后端结构化日志实时面板：分级着色（debug/info/warn/error）、按级别过滤、
   自动跟随（滚动到底部）、点击某行展开完整堆栈、清空视图。启动即回填环缓冲历史
   （分不清级别时可用 `-v` 开启 debug 级；查看磁盘日志见 `--log` 文件）。

> **项目 ↔ 会话联动高亮**：把鼠标悬停在某个项目（或会话）上，会在两栏间同步高亮同名项目。

**钻入某个实例 / 会话**：点实例 tab 或某项目/会话行，会懒创建一个持久 iframe 挂载该 dsh web
（本地经预览代理，远端经 SSH 隧道 + 反代）。退出时只隐藏，再次进入不重载。

**添加实例**（工作台 Instances 区块「＋ 添加」）：
- **本机**：填 dsh home 路径，如 `~/.dsh`；可选填「本机 dsh web 端口」+「鉴权 token」直接接入
  已在跑的那台实例（**同机直连、无端口转发、不新拉起**；端口留空则按需拉起一台）。
- **SSH 远程**：填 SSH 主机（别名 / `user@host`）+ 远端 dsh web 监听端口（**必填**；
  常见值是 `3080`，但以远端实际监听端口为准，留空会被服务端拒绝），
  可选填远端 home 路径、远端启动命令、token 日志路径，以及**鉴权 token**（填入则跳过远端抓取）。
  远程实例经 hwb 的 1:1 根路径反代接入（浏览器无法直达 ssh 隧道）。

> **打开 = 连接（稳定第一）**：实例卡的默认动作是**连接**到已有实例——本地复用已在跑的进程，
> 远程重建一条 ssh 隧道接入**已运行**的 dsh web；**绝不**因连接问题重启或杀掉一个健康实例。
> `stop / restart` 是需二次确认的最后手段，远端自更新 dsh 后填入新 token 即可直连。

远程隧道启用 SSH 压缩；代理为带内容指纹的静态资源补充浏览器缓存，减少重复刷新时的下载。
远程探活等待最多 10 秒，已成功探测的连接连续失败 3 次才显示不可达；临时不可达时保留实例页面。
SSH 意外退出后按 1/2/4/8/16 秒退避，最多重连 5 次，只重建到已有服务的隧道；仍失败时可手动点「连接」重试。
连接恢复后，页面会重新认证并恢复所选会话。主动断开、停止或移除会取消重连。

**本地接入端口（仅 SSH 远程实例）**：添加远程实例或在其设置中填写 hwb 页面接入端口；留空时首次连接自动分配并保存。
重连、切换远端端点和重启 hwb 后均复用该端口，便于浏览器继续使用静态资源缓存。
它与「连接端点」中的 dsh 服务端口独立；外部打开仍沿用原服务入口。需要更换时先断开实例，
清空后保存可重新自动分配。保存的端口若被占用会报错，不会自动换成其他端口。
本机实例的外部打开直连 dsh 服务端口；内嵌页面使用自动分配端口的预览代理，注入工作区与文件点击通信脚本。本机无需配置或保存接入端口。

---

## 文件预览侧边栏

在 hwb 内打开本机或 SSH 远程 dsh 实例后，单击会话中的文件路径或“产物”文件按钮，即可在右侧预览；单击目录可浏览其内容。也可以点击右上角主题切换按钮左侧的 **文件预览** 按钮，直接浏览当前会话的 project 工作区，或输入项目内的相对／绝对路径。侧栏自动跟随会话切换；若内嵌页没有上报会话，用标题栏下拉手选工作区（见下节）。侧栏提供上级、项目根目录、刷新和关闭操作。拖动侧栏左边缘可调整宽度（按实例记忆），双击分隔条恢复默认；聚焦分隔条后也可用左右方向键微调。Cmd/Ctrl 等组合点击保留原有行为。在外部浏览器直连本机 dsh 时，文件打开沿用 dsh 原有行为。

首次更新此功能需要重启 **hwb 服务**，然后刷新整个 hwb 页面；仅切换实例标签不会重建持久 iframe。重启 hwb 会终止它管理的 dsh 子进程，应等相关会话空闲后再操作；手填端口接入的已有本地 dsh 进程不由 hwb 终止。

文件范围限制在已登记的项目目录内。文本显示行号，最多预览前 24 KiB；目录最多显示 200 项；SVG、PNG、ICO、JPEG、GIF、WebP 显示图片（最多 2 MiB）；其他二进制文件暂不展示正文。图片工具栏支持放大、缩小、100% 原尺寸、适应窗口和全屏预览，按 Esc 或点击“退出全屏”返回侧栏。点击“下载文件”可将完整原文件保存到本地（单文件最多 64 MiB，暂不打包目录），不受文本预览截断限制；不支持预览的文件也可下载。远程实例通过 SSH 在远端读取，需要 Python 3。会话缺少 workspaceId 时，按 project 匹配唯一的已登记工作区；无法确定时显示关联错误，不猜测其他项目。外部浏览器直接打开 dsh 的页面仍使用 dsh 原有文件打开行为。

### 两种绑定方式：跟随会话 / 手选工作区

侧栏有两条并存的入口，任一条可用即可浏览、下载与上传：

1. **跟随 dsh 会话（首选）**：内嵌页里的会话会通过 `hwb:preview-context` 上报会话 ID，侧栏据此解析出该会话的 project 工作区——这是「点会话里的文件路径就能预览」的来源。
2. **手选工作区（兜底）**：侧栏标题栏的下拉列出该实例在 hwb 索引里的**全部工作区**（含远端路径）。内嵌页没有上报会话时（例如该 dsh 版本的 URL 不带 `?session=`、会话是文档内新建的、或上报链路被代理/浏览器策略打断），直接在下拉里选一个工作区即可；首次打开面板时若尚无会话上下文，会**自动绑定最近活跃会话所在的工作区**。

> 兜底存在的意义：会话上下文依赖内嵌页与侧栏的 postMessage 握手，任何一环（代理未注入桥接脚本、dsh 不用 `?session=` 导航）都会让它失效；工作区列表来自 hwb 自己的索引，不受该链路影响，因此文件预览不会因为握手失败而完全不可用。下拉选「（跟随 dsh 会话）」可随时切回自动跟随。

### 上传文件（拖拽）

浏览到某个目录时，侧栏会显示上传区：把文件**拖到侧栏**即上传到**当前所在目录**，也可以点「选择文件上传」或直接拖到目录内容区域。多文件会逐个串行上传，进度条显示整批进度与当前文件名，完成后自动刷新目录列表（想传到子目录，先点进那个目录再拖）。

- 单文件上限 **256 MiB**；超限文件在拖入时就被跳过并提示，不会白传一遍。
- **同名不覆盖**：已存在 `data.csv` 时新文件自动落为 `data(1).csv`，上传完成后明确提示改名结果。
- 先写隐藏临时文件、写满后才原子落名：中断只留下隐藏临时文件，不会出现“半截但看起来正常”的结果文件或临时残留。
- 只接受「文件名」，落盘位置完全由服务端依据已登记工作区与当前目录决定；`..`、符号链接、工作区外路径一律拒绝，写请求校验同源（跨站写入返回 403）。
- 远程实例经 SSH 在**远端**同名目录写入（同样需要 Python 3）：内容按 512 KiB 分片经命令行参数传输、远端先分片落盘到临时目录再合并，避开 stdin 与命令行长度限制；速度受链路带宽限制，大文件会比本机慢。


## 读取的 dsh home 文件

Reader 只读取以下 **4 个文件**，均为 schema-versioned：

| 文件 | 内容 | 版本 | 关键规则 |
|------|------|------|---------|
| `storages/workspace.json` | 工作区列表、会话 ID 映射、归档状态 | 2 | 轻量，可频繁读 |
| `storages/session_projcache.json` | 会话投影缓存：tokenUsage、contextPressure、status | 3 | **零 I/O 读取层** |
| `model-tier.json` | 订阅方案、模型路由 tiers | 2 | 可选；缺失不判定 degraded |
| `.credentials.yaml` | provider 引用（只读 provider 名，**不读 key 值**） | — | 可选；缺失不判定 degraded |

**硬性规则：永不碰 `*.zstd`。** 工作台活在投影缓存（`projection cache`）第一层，绝不下探日志。
远程实例读取同样的 4 个文件，只是经一次 `ssh host bash -s`（`remote-reader`）在远端 `cat` 抓回再解析——**只读**，
且与本地共用同一套 schema 验证与域降级，因此远程实例的「当前项目/当前会话」与本地同构。

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
  Reader 统一抽象了 `readText/exists`：本地走 fs，远程经一次 SSH cat（`remote-reader`），
  两者共用同一套 schema 验证与域降级语义。控制平面与数据平面**单向解耦**（Control → Data 只传递实例/隧道状态）。
- **展示平面**默认渲染本地索引元数据（O(索引行)），**绝不**同时挂 N 个 iframe；
  iframe 只在钻入单个会话时按需创建、退出销毁。

关键设计原则（详见架构文档）：

- 工作台仪表盘**绝不**挂载 N 个 iframe——它从本地 SQLite 读元数据。
- 每个实例的 iframe 使用预览代理注入通信脚本；**本地**外部打开仍直连服务，**远程**经 hwb 的
  **根路径 1:1 反向代理**，因为它不重写路径，所以 `/plugins/*`、`/assets/*`、WebSocket 全部走通。
- 状态刷新：控制循环 30s + 文件索引循环 60s（失败退避）；运行中实例的会话状态另以 3s 周期独立读取，不受 SSH 文件索引退避影响。连接后的定向索引会排队执行，不会被正在运行的批次吞掉。

---

## REST API

`createServer` 仅绑定 `127.0.0.1`，**无鉴权**（§11 安全声明）。但**无鉴权 ≠ 任意来源可用**：
`/api/*` 只接受回环 Host（DNS rebinding 防护），且所有写方法要求同站来源（详见「安全边界」）。

| Method | Path | 说明 |
|--------|------|------|
| `GET` | `/api/events` | SSE 订阅（`index:updated` / `instance:status` / `monitor:updated` / `quota:updated` / `log:event`） |
| `GET` | `/api/homes/{homeId}/preview` | 预览文件/目录（`?sessionId=` 或 `?workspaceId=`，`&path=`），只读 |
| `GET` | `/api/homes/{homeId}/download` | 下载单个文件（≤64 MiB，不打包目录） |
| `PUT` | `/api/homes/{homeId}/upload` | 上传文件到当前目录（multipart；`?sessionId=`+`&dir=`，≤256 MiB/文件，同名自动改名，跨站拒绝） |
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
| `POST` | `/api/homes/{homeId}/open-workspace` | 在本机 Finder 中打开该实例的工作区目录（仅本机实例、仅 macOS） |
| `POST` | `/api/homes/{homeId}/switch` | 切换到另一个连接端点（body `{endpointId}`）；先验证新端点再释放旧连接 |
| `POST` | `/api/homes/{homeId}/disconnect` | 仅断开 hwb 接入（不停止远端 dsh web，也不回收本机受管进程） |
| `GET` | `/api/logs` | 后端结构化日志环缓冲快照（`?level=&limit=`，limit ≤ 1000） |

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
├── package.json                 # type:module, engines:node>=22.5.0, 零 npm 依赖
├── src/
│   ├── cli.js                   # hwb 统一管理命令（start/stop/status/logs/config/doctor/upgrade）
│   ├── server.js                # HTTP 入口 + 调度器启动 + 退出清理
│   ├── service.js               # 后台服务进程（私有控制 socket，不用 PID 文件）
│   ├── lib/                     # 纯内核（零副作用，可单测）
│   │   ├── logger.js            # 结构化日志（分级/时间戳/作用域/上下文/轮转落盘/crash handler）
│   │   ├── schema.js            # 4 个文件的手写验证器（unit.version）
│   │   ├── normalize.js         # HomeSnapshot → IndexedRows（纯函数）
│   │   ├── read-home.js         # 本地读取 + 最小 YAML 解析（provider 名）
│   │   ├── balance.js           # Provider 额度适配器（readCredentials/queryBalance）
│   │   ├── status.js            # 会话工作状态推导（纯函数）
│   │   ├── time.js              # 毫秒时间戳 → ISO（越界降级为 null）
│   │   ├── node-version.js      # Node 版本门槛（engines / doctor / 启动预检 同源）
│   │   ├── file-preview.js      # 预览/下载/上传（本机 fs + 远端 python，含路径围栏）
│   │   ├── multipart.js         # 流式 multipart 解析（线性扫描 + 边界保持）
│   │   ├── endpoints.js         # 连接端点规范化（host/port/唯一 id）
│   │   ├── access-port.js       # 本地接入端口校验
│   │   ├── open-workspace.js    # 在 Finder 中打开工作区（仅 macOS）
│   │   └── service-config.js    # ~/.hwb/config.json 的读写与校验
│   ├── dshhome/                 # 数据平面
│   │   ├── reader.js            # 编排 read + normalize + store
│   │   ├── remote-reader.js     # 远端只读索引（一次 ssh bash -s cat 4 个元数据文件）
│   │   ├── indexer.js           # 后台索引循环（60s debounce + 按实例退避）
│   │   ├── live-status.js       # 直接读运行中 dsh 的实时会话状态（RPC）
│   │   ├── live-poller.js       # 实时状态轮询（3s，仅运行中的本机实例）
│   │   ├── store.js             # node:sqlite 封装 + 查询（用量/趋势/项目）
│   │   └── quota.js             # 额度服务（TTL 缓存 60s，单 flight）
│   ├── control/                 # 控制平面
│   │   ├── registry.js          # 实例注册表（状态机 + 退避）
│   │   ├── monitor.js           # 进程/端口探测（30s 循环）
│   │   ├── launcher.js          # dsh web 启动/停止/重启 + token 抓取 + 深链探测 + 端点切换
│   │   ├── tunnel.js            # ssh -L 按需隧道
│   │   ├── ssh-opts.js          # SSH 参数统一（连接复用/压缩/跳板机）
│   │   ├── proxy.js             # 根路径 1:1 反向代理（含 WebSocket 升级 + 预览注入）
│   │   ├── remote.js            # 远端 dsh web 启停 + 抓 token
│   │   ├── prober.js            # HTTP/进程/SSH/远端路径探测（独立可测）
│   │   ├── guard.js             # 进程指纹（防误杀）
│   │   └── workspace-menu.js    # 预览页的工作区下拉菜单注入
│   ├── api/
│   │   ├── server.js            # Node HTTP 服务器 + 静态资源 + /api 来源校验
│   │   ├── routes.js            # REST 路由 + 跨站写保护 + 请求体上限
│   │   └── sse.js               # SSE 广播中心（背压上限 + 心跳）
│   └── web/                     # 展示平面（原生 ESM，无构建）
│       ├── index.html           # 布局 + 全部样式
│       ├── app.js               # 路由 + 状态管理 + 持久 iframe
│       ├── store.js             # 前端缓存（SSE 订阅 + 工具）
│       ├── instance-navigation.js / instance-state.js   # 实例入口与实例键
│       ├── preview-bridge.js    # 内嵌页 → 父页的工作区/会话上报
│       ├── file-preview.css
│       └── components/
│           ├── workbench.js         # 仪表盘布局
│           ├── recent-projects.js / recent-sessions.js / instance-grid.js
│           ├── usage-card.js        # 用量卡 + 堆叠趋势图 + 周期/维度切换
│           ├── quota-card.js        # 额度卡片（见「已知限制」）
│           ├── add-home.js          # 添加/编辑实例表单 + onboarding
│           ├── endpoint-editor.js   # 连接端点编辑器
│           ├── file-preview.js      # 文件预览/下载/拖拽上传侧栏
│           ├── preview-image.js / preview-resize.js  # 图片查看与侧栏拖拽
│           ├── log-panel.js         # 运行日志面板
│           └── form-draft.js        # 表单草稿存取（跨 SSE 重建保活）
├── scripts/                     # 远程 dsh web 冷启动/缓存/隧道运维脚本
├── dsh-remote-index/            # 多实例会话索引（独立工具）
├── dsh-static-cache/            # dsh 前端静态缓存插件
├── docs/topology.md             # 拓扑可视化附录（README/设计文档的可视化补充）
├── tests/                       # 单元测试 + mock-home 夹具
├── images/                      # README 头图
└── DSH_Workbench_Fusion_Architecture.md   # 设计文档（三平面/数据模型/里程碑）
```

> 完整文件清单以 `git ls-files` 为准（上面只列主线，测试文件未逐个展开）。

---

## 测试

```bash
npm test        # node --test tests/*.test.js
```

当前 **359 个用例（45 个测试文件）全绿**，交叉覆盖：schema 校验 / normalize 纯函数 / read-home 读取 /
credentials 解析 / status 推导 / quota 适配器与 TTL 缓存 / store 查询与用量聚合 /
monitor 状态机 / proxy 反代与 WebSocket / launcher 的 token 抓取与深链探测 /
API 层（跨站写保护、DNS rebinding、请求体上限、UTF-8 分片解码）/ multipart 解析与上传 /
SSH 重连与恢复 / 前端渲染转义与表单草稿 / Node 版本门槛与时间戳边界。
`tests/mock-home/` 是真实 `~/.dsh` 形状的夹具（由 `tests/init-mock.js` 生成）。

部分测试直接打真实 socket / 真 bash / 真 HTTP 服务（而不是只喂假对象），
因为有些行为只有在真实分片、真实 shell 引号语义下才暴露得出来。

---

## 已知限制

> 这些是 v0.1.1 已知的不完整/边界项，非缺陷即**尚未接线**的部分，提前说明以便透明发布。

- **额度卡片未接通仪表盘**：`src/web/components/quota-card.js` 的 `renderQuotaCards` 已实现，
  后端 `/api/quota` ✓、`/api/events` 的 `quota:updated` ✓、`QuotaService` + 各 provider 适配器 ✓、
  单测 ✓ —— 但仪表盘**尚未**把它渲染出来（前端目前用量卡里没有额度区块）。如需启用，把
  `renderQuotaCards` 挂到工作台即可；属**剩余 5% 接线**工作，不影响其余功能。
- **远程索引读整份 projcache 走 SSH**：远程实例每次索引周期（60s 基线）经一次 `ssh cat` 抓回
  `session_projcache.json`（可能数百 KB）+ 其余元数据。这是为拿到「当前项目/会话」所必需的只读读；
  远程不可达时该实例降级（`markHomeError`），**不会**阻塞其它实例索引，也不会去重启/杀实例。
- **仅 `deepseek`/`kimi` 有公开余额 API**：`zai`/`minimax` 无公开 balance endpoint，
  API 显式降级为「余额不可用」，不会静默失败。
- **会话 deep-link 依赖客户端插件**：`dsh-session-deeplink` 需经
  `dsh plugin --profile web add dsh-session-deeplink` 安装；未装插件的 home 深链不触发
  （框架已保证「装了插件」能正确探测 + 保留 `?session=`）。
- **新 dsh 鉴权 token**（≥`0.1.2-rc.1`）：`dsh web` 每次启动打印带 `?token=` 的 URL，
  hwb 会抓取并拼进入口 URL；**旧版 dsh（不打印 token，如 `v0.1.0`）自动回退裸 URL**。
  向下兼容做得足够稳：远端「ensure」对已在监听但没有 token 的旧版实例**绝不 killport/重启**
  （避免打断一个健康的旧版 web）；启动后一出现不带 token 的 URL 行就**立即**用裸 URL 兜底，
  而不是白等满 40s 的 poll 窗口；默认远端启动命令用**裸 `dsh web --port <n>`**
  （不传新版才有的 `--profile web`/`--no-open`，旧版会因未知选项起不来 → 不可达）。

---

## 安全边界

- hwb 仅监听 **127.0.0.1**，无鉴权，不暴露公网。
- **跨站写保护**：因为无鉴权，浏览器里的任意页面理论上都能向本机端口发请求，所以所有改变状态的
  方法（`POST`/`PUT`/`PATCH`/`DELETE`）统一要求同站来源——`Sec-Fetch-Site: cross-site` 或
  `Origin` 与本机 `Host` 不一致的请求一律 403。这不能只依赖 CORS：`Content-Type: text/plain`
  之类的请求属于 **CORS 简单请求**，不触发预检，浏览器不会替你拦。非浏览器客户端（curl 等）不带
  这两个头，照常可用。
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
| M7 — Publish | 🎯 v0.1.1（本版） |

后续方向（见架构文档 §14 开放问题）：远程钻入方式、会话标题来源、首批额度 provider 的取舍等。

---

## 许可

[MIT](LICENSE)


### 一个实例配置多个连接端点

实例使用固定的 `homeId`，连接地址和端口属于实例下的 `endpoints`，不再用端口来区分它的身份。每个端点包含 SSH 主机（远程实例）、dsh web 端口和可选 token，以主机和端口区分，不单独设置别名；`activeEndpointId` 记录当前选用的端点。不同 token 可分别保存在各端点中。本机实例也支持多个直连端口。

在实例卡片的「设置 → 连接端点」中添加端点并保存，在设置内选择目标并点击「切换连接」。多 IP／端口在设置中维护；配置多个端点后，实例卡片会增加「切换」按钮，点击后选择通道。可以在连接中添加或编辑备用端点；修改正在使用的端点前需先切换或断开。切换会先连接并验证新端点，成功后释放旧接入，失败保留原连接。远程切换不会启动、重启或停止 dsh web；目标服务需已运行。hwb 自己启动的本机进程需先停止，才能改用其他直连端口。

首次升级会将同一服务器标识、同一远端 home 的旧通道配置合并为一个实例的多个端点（相对 home 还区分显式 SSH 用户）。已确认的 `cms.lo` / `cms.tun` 包括 `bot@` 前缀会归到 `cms`。保留首个实例 ID，合并唯一的索引记录并消除重复记录。以后请直接在一个实例中维护端点列表，界面只保留「实例名称」用于显示，不会因改名或切换端口生成新的实例。

Instances 直接显示全部实例卡片，没有折叠层：未连接时显示「连接」，连接后显示「断开」，仅配置多个通道时增加「切换」按钮，用于选择连接通道。「连接」留在工作台；点击顶部选项卡进入实例页面。仅 Instances 区域的实例卡片显示当前连接通道，不默认展开其他通道列表；顶部导航栏只显示实例名称。连接状态每 30 秒检查。Projects 和 Sessions 仅查询已连接且可达的实例，过滤发生在汇总、跳转目标选择和分页之前；断开后隐藏其数据，保留索引供重新连接后展示。

API：`PUT /api/homes/:homeId` 支持 `endpoints` 数组；`POST /api/homes/:homeId/switch` 接收 `{ "endpointId": "目标端点 ID" }`。切换成功后 `homeId`、会话及项目索引不变。旧的单主机／端口配置仍兼容。后端更改需重启 hwb 生效。
