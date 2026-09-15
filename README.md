![hwb](images/hwb.png)

# hwb — harness workbench

[![CI](https://github.com/biociao/hwb/actions/workflows/ci.yml/badge.svg)](https://github.com/biociao/hwb/actions/workflows/ci.yml)
[![version](https://img.shields.io/badge/version-v0.1.5-blue)](CHANGELOG.md)
[![milestones](https://img.shields.io/badge/milestones-M1%E2%80%93M7-brightgreen)](DSH_Workbench_Fusion_Architecture.md)
[![node](https://img.shields.io/badge/node-%E2%89%A522-blue)](package.json)
[![npm deps](https://img.shields.io/badge/npm_deps-0-blue)](package.json)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

`hwb`（harness workbench）是一个面向 harness工具（目前主要支持的是DeepSeek Harness，即dsh）的**本地工作台**，用于应付需要开启多个dsh实例的情况——当前dsh在项目和任务数增多后会变得难以管理和跟踪。
`hwb`会构建一份本地 SQLite 索引，在一个纯元数据仪表盘里跨实例展示**最近项目 / 会话 / 实例状态 / Token 用量**，并通过一个**控制平面**去启动、停止、重启 dsh web 进程（本机），或经 SSH 隧道接入**远端** dsh 实例。

它**只读** dsh 的元数据文件，保持dsh独立运行，也**不会读取** `.zstd` 会话正文。
它也不会替代 dsh web——只一站式托管它、快速找到它、直达会话，让你在一处总揽所有实例的工作状态。

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
- [dsh 版本兼容性](#dsh-版本兼容性)
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
- **主题一致性**：切换 hwb 的界面外观时，把同一个偏好单向下发给各已连接的 dsh 实例
  （写它们的 `settings.yaml` + 让已打开的页面即时换肤），并带一个可关闭的开关。

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
| **主题同步** | hwb 切主题单向下发给已连接的 dsh 实例：写其 `settings.yaml`（持久）+ 注入脚本即时换肤；逐实例报成功/失败，可在主题菜单里关闭 |

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

> **如果 `hwb` 报 `zsh: permission denied: hwb`（而 `which hwb` 找得到它）**：
> 全局 bin 是个软链（`~/.nvm/.../bin/hwb -> …/hwb/src/cli.js`），症状说明**目标文件**丢了可执行位。
> `chmod +x src/cli.js` 即可恢复；仓库现在把 `src/cli.js` 记为 **100755**，所以正常 clone 不会再遇到。
> 之所以要写在这里：这种丢失 `git status` **不会提示**（索引原本就是 0644），只能靠症状认出来。

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
hwb doctor                 # Node、配置、运行服务 HTTP 检查 + dsh 版本兼容性自检
hwb test                   # 全部测试
hwb test --test-name-pattern=CLI
hwb upgrade                # Git 快进更新 → 测试 → 原在运行则重启
hwb --help
```

`hwb` / `hwb serve` 保留前台运行方式，并读取同一份配置；原有 `--port` 等选项可覆盖配置。
`node src/server.js` 和 `npm start` 仍是原来的直接启动方式，不读取新配置文件，也不受后台管理命令控制。

配置保存在 `~/.hwb/config.json`，支持 `port`、`db`、`intervalMs`、`homes`、`log`、`verbose`、`silent`、`theme`；
`log: false` 禁用结构化文件日志。`theme`（`light` / `dark` / `system`）是界面外观偏好，也是**下发给 dsh 实例**的那个值。
`hwb config path` 显示配置位置。相对路径在保存时转为绝对路径。
设置 `HWB_DIR=/其他目录 hwb ...` 可隔离一套服务的配置、数据库和运行文件（多服务需配置不同端口）。
实例及连接端点继续通过工作台管理，保存在数据库中。

后台服务不依赖终端，但不提供开机自启或崩溃自动拉起。它通过权限为 `0600` 的本地套接字管理自身，
不会按端口或 PID 文件杀进程。启动失败会把原因（以及完整日志的位置）直接打在终端上，
完整的 `~/.hwb/service.log` 仍然是权威记录。

`status` 的退出码可以直接用于脚本：服务在运行 → 0，未运行 → 1。
前台运行的 `hwb serve` **不创建控制套接字**，所以 `status`/`doctor` 会额外探测配置端口，
并且**确认对面确实是 hwb**（只有 hwb 才会以 `{"homes":[...]}` 回应 `/api/homes`）：
真的在服务就报 `running`（并注明是前台运行），端口被**别的程序**占用则如实说明，不会说成「已停止」，
也不会把别人的服务认成 hwb。

启停命令通过锁文件串行执行：锁里记着持有者 PID 并且持有者持续心跳，
被 `kill -9`（甚至 PID 之后被系统回收）留下的残留锁会被自动接管并提示；只有在锁**确实被活着**的
启停命令持有时才会拒绝，此时按提示确认后可删除 `~/.hwb/service.lock`。
停止、重启会关闭 hwb 托管的 dsh 子进程，应在相关会话空闲时操作。

`upgrade` 仅用于 Git 安装：要求工作区干净且当前分支有 upstream，只执行 `git pull --ff-only`。
测试失败时不会重启服务，也不会自动回滚已更新的源码；修复后重新测试并重启。
npm 安装可使用 `npm install -g hwb@latest` 后执行 `hwb restart`。

命令用 npm 脚本：

```bash
npm start          # node src/server.js
npm test           # 全量（含 tests/compat 版本兼容性契约）
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
> 子进程 stderr 尾部 / 退出码）一并带上。日志文件默认 `~/.hwb/hwb.log`，超过 1MiB 自动轮转保留
> `.1/.2` 两代（同样是 0600）；`service.log`（子进程 stdout/stderr 的重定向目标，只增不减）
> 在每次 `hwb start` 之前做一次性上限控制：超过 8MiB 就轮转成 `.1`（**不是**运行中实时轮转 ——
> fd 已经交给子进程，父进程退出后不再持有）。
> **同一实例的同一失败原因不会刷屏**：首次记全（含 Error 完整堆栈），之后 10 分钟内静默、
> 窗口过后记一条摘要行；原因变化或成功一次即复位。这条是为「一个长期不可达的远端每轮索引都重记
> 同一件事」准备的 —— 实测那会让日志里 16,000 行里有 7,000 行是同一句话 + 一整套 async 栈帧。
> 当 dsh web 启动失败、SSH 隧道断连、远端 home 不可达时，查看该文件即可定位根因。

打开 `http://127.0.0.1:4310`，首次会看到一个 **onboarding 引导**：自动检测 `~/.dsh` 或手动添加。

---

## 工作台怎么用

顶部是一个 **tab 栏**：`◧ 工作台` + 每个实例一个可拖拽排序的 tab。视图切换只 show/hide，
**不重建热 iframe**（切回是瞬时的）—— 但「热」有上限：见下面的 **iframe 预算**。

**工作台（仪表盘，纯元数据、零 iframe）** 分五块：

1. **Recent Projects** —— 近 7 天内活跃的项目，跨实例聚合；点击跳转到该项目最新会话所属实例。
2. **Recent Sessions** —— 最近会话，带 token 用量 chip、上下文压力条、状态 chip（运行中/已完成/空闲）。
3. **Instances** —— 每个 dsh 实例的实例卡：状态 chip（已连接 / 连接不可达 / 未连接，域降级时另加
   「⚠ <域> 降级」chip）、**该实例上 dsh 的版本号**（`dsh 0.1.5-rc.1`；本地实例读本机安装、
   远程实例经 SSH `dsh --version` 探测，与远端启动共用同一份 PATH 补齐；取不到时不显示）、
   workspace/会话数，以及 **连接（连接到 / 必要时拉起 dsh web）** / **断开** /
   **切换**（配置了多个连接端点时）/ **⚙ 设置** 按钮。
   版本号在**未连接**的实例卡上也显示 —— 「这台上跑的是哪个 dsh」正是排查「连不上 / 数据变少 /
   域降级」时最先要看的一项；远程探测是后台做的，不拖慢仪表盘渲染。
   重启 / 停止 / 重新索引 / 移除 在 **⚙ 设置** 弹窗内（不在卡片上，避免误点）。
   远程实例经 SSH 只读索引入库后同样显示。
   （实例卡不再重复展示「当前项目/当前会话」——该信息已由 Recent Projects / Recent Sessions 聚合呈现。）
4. **Token 用量** —— 汇总卡 + 分时趋势堆叠柱状图（支持 24h / 3天 / 7天 / 14天 / 30天 周期，
   按 合计 / 项目 / LLM provider / 按 Model / 实例 维度切换）+ 按项目拆分。
5. **运行日志** —— 后端结构化日志实时面板：分级着色（debug/info/warn/error）、按级别过滤、
   自动跟随（滚动到底部）、点击某行展开完整堆栈、清空视图。启动即回填环缓冲历史
   （分不清级别时可用 `-v` 开启 debug 级；查看磁盘日志见 `--log` 文件）。

> **项目 ↔ 会话联动高亮**：把鼠标悬停在某个项目（或会话）上，会在两栏间同步高亮同名项目。

**钻入某个实例 / 会话**：点实例 tab 或某项目/会话行，会懒创建一个 iframe 挂载该 dsh web
（本地经预览代理，远端经 SSH 隧道 + 反代）。切走只隐藏；被预算释放过的实例再次进入时重新加载
（dsh 支持会话深链时会回到同一个会话）。

> **iframe 预算（前端内存的上界）**：每个实例 iframe 都是一整个 dsh web SPA（自己的实时通道、
> 会话 DOM、插件脚本），隐藏的 iframe 并不会被冻结。原先「切走只 hidden、永不销毁」的代价是
> 浏览器内存随**访问过的实例数**单调增长、且永不归还——2026-09-12 实测 Safari 的一个 WebKit
> WebContent 进程 2.3 GB / 26% CPU 常驻 7 小时，Safari 以「此网页使用了大量内存」把页面重载。
> 现在最多保留 **3** 个热 iframe（最近用过的），超出的按 LRU 释放：只拆 iframe 与预览侧栏，
> 标签页、入口 URL、会话 id 全部保留，重新进入时按会话深链恢复；正在看的那个永不释放。
> 释放过的标签在悬停提示里标出「已释放内存（重新进入时重新加载）」。
> 用 `http://127.0.0.1:4310/?frames=N` 可以临时调整预算（N ≥ 1；低内存机器可调小，
> `scripts/memory-check.mjs` 用它做对照实验）。

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

## 主题同步（hwb → dsh）

右上角的 🌓 菜单除了「白天 / 黑夜 / 跟随系统」，还带一个 **「同步到 dsh 实例」** 开关（默认开）。
开启后，hwb 每次切主题都会**单向下发**给各个已连接的 dsh 实例 —— hwb 是权威，dsh 跟随，
dsh 自己设置里的主题改动不会回流到 hwb。

下发分两条腿，缺一不可：

| | 作用 | 机制 |
|---|---|---|
| **落盘** | 重启 dsh / 重开浏览器后依然一致 | 写该实例 dsh home 下的 `settings.yaml`（`ui-theme.preference`）。本机直接写文件；SSH 远程实例经远端 shell 写入 |
| **即时** | 已打开的 dsh 页面**立刻**换肤 | 预览代理往 dsh 页面注入 `dsh-theme.js`，hwb 通过 `postMessage` 把主题推给它 |

只做「即时」会是假同步（刷新即失效），只做「落盘」则要等 dsh 自己的 settings watcher 热重载
（有数百毫秒延迟、后台标签页更慢），所以两者都做。

几个刻意的取舍：

- **只写自己那一节**。`settings.yaml` 里有 API key、模型白名单、locale —— 写入走「手写 YAML 编辑器」
  而非「解析后重序列化」，除 `ui-theme.preference` 那一行之外整份文档逐字节不变（注释、引号风格、
  缩进都保住），同节内 dsh 自己写的 `fontSize` 也不会被顺手删掉。
- **原子替换**。dsh 用 chokidar watcher 热重载这份文件，原地写会让它读到半截 YAML 并整份丢弃
  （只留一句 warn）。因此先写临时文件再 `rename`，并保持 0600 权限。
- **失败不拖垮连接**。主题同步是**附加**能力：某实例 ssh 不通时只影响它自己，连接本身照常成功；
  接口逐实例返回成功/失败，部分失败仍是 200（用 5xx 概括会让「3 个实例里 1 个不通」看起来像整个功能坏了，
  也丢掉另外 2 个的成功事实）。
- **新连接的实例自动补齐**。连接成功后会立刻把当前主题写进这个实例，避免「hwb 早改了主题、
  但这个实例是后来才连上的」留下不一致；某次下发失败的实例，重新连接时也会被补齐。
- **`system` 不重复下发**。系统亮暗翻转时偏好值本身没变（仍是 `system`），不应触发写盘；
  已打开的 dsh 页面由注入脚本自己的 `prefers-color-scheme` 跟随 —— 两边解析同一个查询，结果必然一致。
- **可关**。关掉开关后 hwb 只改自己的界面，不再碰任何实例的 `settings.yaml`（给「我就是想让两边不一样」留出口）。
- **偏好存在服务端**（`~/.hwb/config.json` 的 `theme`，也可 `hwb config set theme dark`），
  不只是浏览器 localStorage —— 它是「下发给 dsh 的那个值」，hwb 重启或换个浏览器打开时都必须还是同一个。

> 远程实例的主题下发经 SSH 执行一小段 shell（`awk` 维护节边界 + 临时文件 + `mv` 原子替换），
> 需要远端有 `awk`（POSIX 环境默认都有）。远端写入失败时错误信息里会带上 ssh 的退出码与 stderr 尾部。

---

## 文件预览侧边栏

在 hwb 内打开本机或 SSH 远程 dsh 实例后，单击会话中的文件路径或“产物”文件按钮，即可在右侧预览（点击由注入的桥接脚本拦截，因此不会触发 dsh 原生「用宿主系统应用打开」——远端无 GUI 时那条路必然失败并提示 `xdg-open: no method available`；若某次点击仍漏过桥接，iframe 右下角会浮出一条会自动消失的小提示（不在会话正文里插入任何控件），提供「在 hwb 文件预览里打开」的动作）；单击目录可浏览其内容。也可以点击右上角主题切换按钮左侧的 **文件预览** 按钮，直接浏览当前会话的 project 工作区，或输入项目内的相对／绝对路径。侧栏自动跟随会话切换；若内嵌页没有上报会话，用标题栏下拉手选工作区（见下节）。侧栏提供上级、项目根目录、刷新和关闭操作。拖动侧栏左边缘可调整宽度（按实例记忆），双击分隔条恢复默认；聚焦分隔条后也可用左右方向键微调。Cmd/Ctrl 等组合点击保留原有行为。在外部浏览器直连本机 dsh 时，文件打开沿用 dsh 原有行为。

首次更新此功能需要重启 **hwb 服务**，然后刷新整个 hwb 页面；仅切换实例标签不会重建热 iframe（超出预算的被释放后会在重新进入时加载，见上文的 **iframe 预算**）。重启 hwb 会终止它管理的 dsh 子进程，应等相关会话空闲后再操作；手填端口接入的已有本地 dsh 进程不由 hwb 终止。

文件范围限制在已登记的项目目录内。文本显示行号，最多预览前 24 KiB；目录最多显示 200 项；SVG、PNG、ICO、JPEG、GIF、WebP 显示图片（最多 2 MiB）；其他二进制文件暂不展示正文。图片工具栏支持放大、缩小、100% 原尺寸、适应窗口和全屏预览，按 Esc 或点击“退出全屏”返回侧栏。**HTML 文件默认渲染显示**（按浏览器方式排版，最大 32 MiB），工具栏可切到「源码」（前 24 KiB，带行号）、在浏览器里打开或下载完整文件；渲染走 `/asset` 原字节，因此内联图表的报告不必再受文本预览 24 KiB 截断。为安全起见，渲染时不执行页面里的脚本与表单（服务端 CSP `sandbox` + 前端 iframe `sandbox`），静态排版、内联样式与图片正常显示。点击“下载文件”可将完整原文件保存到本地（单文件最多 64 MiB，暂不打包目录），不受文本预览截断限制；不支持预览的文件也可下载。远程实例通过 SSH 在远端读取，需要 Python 3。会话缺少 workspaceId 时，按 project 匹配唯一的已登记工作区；无法确定时显示关联错误，不猜测其他项目。外部浏览器直接打开 dsh 的页面仍使用 dsh 原有文件打开行为。

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

Reader 读取以下文件，均为 schema-versioned：

| 文件 | 内容 | 版本 | 关键规则 |
|------|------|------|---------|
| `storages/workspace.json` | 工作区列表、会话 ID 映射、归档状态 | 2 | 轻量，可频繁读 |
| `storages/session_projcache/sessions/*.json` | 会话投影缓存（**per-record 布局**）：tokenUsage、contextPressure、status | 3–7 | **当前 dsh 的权威来源**；每个会话一个文件 |
| `storages/session_projcache.json` | 同上，但是**单文件聚合**（遗留布局） | 3–7 | 只用于补齐 per-record 尚未覆盖的会话；dsh 已不再更新它 |
| `model-tier.json` | 订阅方案、模型路由 tiers | 2 | 可选；缺失不判定 degraded |
| `.credentials.yaml` | provider 引用（只读 provider 名，**不读 key 值**） | — | 可选；缺失不判定 degraded |

**projcache 有两种磁盘布局，必须都认。** dsh 声明该域 `layout: 'per-record'`，把会话写进
`storages/session_projcache/sessions/<id>.json`（信封 `{version, record}`）；早期版本写单个聚合文件
`storages/session_projcache.json`（信封 `{unit, global, tables}`），新版只在首次发现时用它做一次
bootstrap，之后**不再更新**。hwb 以 **per-record 为准、聚合为补充**（同 id 冲突以 per-record 为准）。

> 这里踩过一次真实的坑（2026-09，dsh 0.1.5-rc.1）：hwb 只读聚合文件 → 真实 home 上
> **476 个会话只看到 179 个（漏 62%），且 `degraded` 为空**（聚合文件本身合法，只是过期）。
> 修复后覆盖 100%。回归测试见 `tests/compat/`。

**硬性规则：永不碰 `*.zstd`。** 工作台活在投影缓存（`projection cache`）第一层，绝不下探日志。
远程实例读取同样的文件（外加 per-record 目录），只是经一次 `ssh host bash -s`（`remote-reader`）
在远端 `cat` 抓回再解析——**只读**，且与本地共用同一套 schema 验证与域降级，
因此远程实例的「当前项目/当前会话」与本地同构。

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
  iframe 只在钻入实例时按需创建，且活跃 iframe 数由预算上限兜住（默认 3，LRU 释放，见
  「iframe 预算」）—— 因为每个 iframe 都是一整个 dsh web SPA，隐藏不等于不占内存。

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
| `GET` | `/api/homes/{homeId}/asset` | 按真实 MIME 返回文件原字节（HTML 渲染预览用；带 CSP `sandbox`，只读、只限工作区内） |
| `GET` | `/api/homes/{homeId}/download` | 下载单个文件（≤64 MiB，不打包目录） |
| `PUT` | `/api/homes/{homeId}/upload` | 上传文件到当前目录（multipart；`?sessionId=`+`&dir=`，≤256 MiB/文件，同名自动改名，跨站拒绝） |
| `GET` | `/api/homes` | 全部实例（含 runtime 状态） |
| `GET` | `/api/homes/detect` | 检测默认 `~/.dsh` 是否存在 |
| `POST` | `/api/homes` | 注册实例（本机 `homePath`；远程 `host`+`remotePort`） |
| `PUT` | `/api/homes/{homeId}` | 编辑实例配置（alias / homePath / 远程参数） |
| `DELETE` | `/api/homes/{homeId}` | 移除实例（只删 hwb 索引，不碰 dsh 文件） |
| `POST` | `/api/homes/order` | 持久化拖拽排序 |
| `POST` | `/api/homes/{homeId}/reindex` | 强制重新索引 |
| `POST` | `/api/homes/{homeId}/open` | 打开实例（本机拉起 / 远端建隧道）。**连接前会验证入口鉴权**：token 失效/填错时返回 500 并说明补救办法，而不是把 401 栅栏页记成「已连接」 |
| `POST` | `/api/homes/{homeId}/restart` | 重启实例 |
| `POST` | `/api/homes/{homeId}/stop` | 停止实例（远端同时停远端 dsh web）。**确认式**：SIGTERM→3s→SIGKILL→2s，只有进程真的退出才回 `{ok:true}`；收不掉则回 500（带 pid/端口）且保留句柄。远端停止失败时也会以 500 上报（本地连接仍已断开）。响应里的 `stopped` 表示**这次是否确实停掉了一个受管子进程**（直连已有实例时为 false） |
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
| `GET` | `/api/theme` | 当前主题偏好 + 各实例 dsh 侧的实际值（`dshPreference`；远程实例不读盘，为 `null`） |
| `POST` | `/api/theme` | 把主题下发给已连接的实例（body `{preference, homeIds?}`）；逐实例返回成功/失败，部分失败仍为 200 |

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
| `warm-cache.mjs` | 预热 hwb 代理缓存：按 dsh 索引里的清单把插件 bundle / 前端资源灌进本地缓存（`--history N` 还会预热最近 N 个已结束会话的历史），之后打开页面/历史会话就是本地回 |

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
│   │   ├── dsh-compat.js        # dsh 存储契约自检（doctor 用；从安装的 dsh 提取域版本）
│   │   ├── dsh-version.js       # 每个实例的 dsh 版本号（本地读安装 / 远程 ssh --version，带 TTL 缓存）
│   │   ├── file-preview.js      # 预览/下载/上传（本机 fs + 远端 python，含路径围栏）
│   │   ├── multipart.js         # 流式 multipart 解析（线性扫描 + 边界保持）
│   │   ├── endpoints.js         # 连接端点规范化（host/port/唯一 id）
│   │   ├── access-port.js       # 本地接入端口校验
│   │   ├── open-workspace.js    # 在 Finder 中打开工作区（仅 macOS）
│   │   ├── dsh-theme.js         # 主题同步：dsh settings.yaml 的节级读写（本机 fs / 远端 shell）
│   │   └── service-config.js    # ~/.hwb/config.json 的读写与校验
│   ├── dshhome/                 # 数据平面
│   │   ├── reader.js            # 编排 read + normalize + store
│   │   ├── remote-reader.js     # 远端只读索引（一次 ssh bash -s cat 元数据文件 + per-record 目录）
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
│       ├── dsh-theme-live.js    # 内嵌页主题即时换肤（接收父页 postMessage）
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
npm test            # 全量：功能测试 + dsh 版本兼容性契约（tests/compat）
npm run test:unit   # 只跑功能测试
npm run test:compat # 只跑兼容性契约（升级 dsh 后先跑这个）
```

当前**全套用例全绿**。确切条数与文件数以 `npm test` 的输出为准 —— 这里刻意不写死任何数字，
因为那种数字每加一个用例/文件就会过期一次（历史上它从 62 漂到 359 再到 419 都没人发现）。
`tests/docs-consistency.test.js` 会守住这条「文档不自带会过期的计数」的约定。交叉覆盖：schema 校验 / normalize 纯函数 / read-home 读取 /
credentials 解析 / status 推导 / quota 适配器与 TTL 缓存 / store 查询与用量聚合 /
monitor 状态机 / proxy 反代与 WebSocket / launcher 的 token 抓取与深链探测 /
API 层（跨站写保护、DNS rebinding、请求体上限、UTF-8 分片解码）/ multipart 解析与上传 /
SSH 重连与恢复 / 前端渲染转义与表单草稿 / Node 版本门槛与时间戳边界。
`tests/mock-home/` 是真实 `~/.dsh` 形状的夹具（由 `tests/init-mock.js` 生成）。

部分测试直接打真实 socket / 真 bash / 真 HTTP 服务（而不是只喂假对象），
因为有些行为只有在真实分片、真实 shell 引号语义下才暴露得出来。

---

## dsh 版本兼容性

hwb 消费 dsh 的**磁盘格式**与 **CLI 表面**，而这些都不是 dsh 承诺稳定的公开 API，
dsh 的版本号也不遵循 semver 承诺（0.1.x → 0.1.5 之间就改过存储布局）。
**漂移的失败方式通常是静默的**：整块域被判 degraded，或只读到一部分数据而界面毫无提示。

**已验证**：dsh **0.1.5-rc.1**（本机实测）。契约：

| 契约 | dsh 声明 | hwb 的处理 |
|---|---|---|
| `workspace` 域 | `version: 2`，single 布局，`global.workspaceIds` | 接受 2 |
| `session_projcache` 域 | `version: 7`，`compatibleVersions: [3,4,5,6]`，**per-record** 布局 | 接受 3–7；**两种布局都读**（per-record 为准、聚合为补充） |
| `dsh web` 启动打印 | `dsh web: http://127.0.0.1:<port>/?token=<t>` | 抓 `?token=`（抓不到则退回裸 URL） |
| RPC 端点 | `POST /api/session/list`（slash 形） | 先试 slash，404 回退 dot 形 |

> **实例卡上的版本号**也是按同一口径取的，而且**每个实例各取各的**：本机实例读本机安装的 dsh
> （与 `hwb doctor` 同一份代码），远程实例经 SSH `dsh --version`（与启动远端 dsh web 共用同一份
> PATH 补齐，且优先用你在实例配置里填的那个 dsh 路径）。所以「工作台上写着 0.1.5-rc.1、
> 远端其实是 0.1.1-rc.2」这种会让人查错方向的情形不会发生 —— 版本不同只可能因为两台机器上的
> dsh 本来就不同。注意域版本（上表的 2 / 7）与 dsh 版本号是两件事：老版本 dsh 写出的 home
> 里域版本也可能很新，反之亦然（详见 `hwb doctor` 的两项独立检查）。

**升级 dsh 后怎么办**：

```sh
npm run compat          # 一键结论：兼容 / 不兼容 + 改哪里（不兼容时退出码 1，可进 CI）
npm run test:compat     # 完整契约测试：逐条检查与「改哪一行」的指引
hwb doctor              # 运行时体检：Node / 配置 / 服务 / 契约 / 本机 home 可读性
```

契约测试在**没装 dsh 的 CI 上也能跑**：整组按「无法判定」跳过（跳过项名字里写明原因），
不会假装通过、也不会让构建失败。

`hwb doctor` 会同时报告**两个互相独立**的检查 —— 只做其中一个会漏掉另一半
（dsh 二进制可以很新而 home 是旧格式，反之亦然）：

```
dsh 0.1.5-rc.1 兼容 ✓
本机 home（2 个）：
  · MBP：476 会话 / 28 工作区 | 布局 per-record=476 | 版本 7
  · bee：8 会话 / 2 工作区 | 布局 per-record=8 | 版本 5
```

契约测试是**从实际安装的 dsh 里提取**契约再比对的（不是抄进常量），
所以 dsh 一升级它就报「dsh 现在声明了什么」。完整说明见
[`tests/compat/README.md`](tests/compat/README.md)。

**已知的兼容性风险**（有意保留的边界）：

- 远程 dsh 的两个可选插件（`dsh-static-cache` / `dsh-history-delta`）依赖 dsh 内部服务名
  （`webServer` / `connection` / `apiProxy`）。这些是运行时字符串，无法自动做契约测试。
  实测 dsh 0.1.5-rc.1 里 `webServer` 存在、而 **`apiProxy` 不存在** ——
  即 `dsh-history-delta`（低带宽增量历史，**默认关闭**）在当前版本会走「不打补丁」分支。
  后果仅性能（代理层整段回退读取），不会错也不会崩。
- **前端 bundle 注入锚点**（`workspace-menu.js` 给 dsh 的 workspace 菜单打补丁）
  依赖压缩后的字面量子串。已纳入契约测试 F 组（拿真实 bundle 验证），但注入后的**浏览器行为**
  无法在无浏览器环境断言。

## 已知限制

> 这些是 v0.1.5 已知的不完整/边界项，非缺陷即**尚未接线**的部分，提前说明以便透明发布。

- **上传的内存占用有界但不为零**：multipart 解析器是流式的，但上传路由目前会把整份文件先攒在内存
  再落盘（解析器的 `write` 回调是同步契约，而落盘写入是异步的）。单文件上限 256 MiB，
  因此峰值是同量级的一次性开销，不会随并发累积（上传是串行处理的）。改成真流式需要让解析器
  支持异步写入端。
- **额度卡片未接通仪表盘**：`src/web/components/quota-card.js` 的 `renderQuotaCards` 已实现，
  后端 `/api/quota` ✓、`/api/events` 的 `quota:updated` ✓、`QuotaService` + 各 provider 适配器 ✓、
  单测 ✓ —— 但仪表盘**尚未**把它渲染出来（前端目前用量卡里没有额度区块）。如需启用，把
  `renderQuotaCards` 挂到工作台即可；属**剩余 5% 接线**工作，不影响其余功能。
- **远程索引读整份 projcache 走 SSH**：远程实例每次索引周期（60s 基线）经一次 `ssh cat` 抓回
  元数据文件 + **per-record projcache 目录**（每个会话一个文件）。
  per-record 是全量文件，所以远端会先做一次**投影**：只保留 hwb 用到的
  ~10 个 projection（`title` / `tokenUsage` / `contextPressure` / `sessionStats` /
  `goal` / `todos` / `subagent` / `plan` / `permissions` / `sessionListMetadata`），
  丢掉 `titleInput` / `turnOutline` / `contextBreakdown` 等大头 ——
  实测本机 476 个会话 **4.07 MiB → 1.28 MiB（省 69%）**。
  投影任一步失败（远端没有 python3、JSON 坏了）都**原文回退**，宁可多传也不少读；
  传输体积超过 2 MiB 时记一条 warn（低带宽链路上有 90 s ssh 超时风险）。
  远程不可达时该实例降级（`markHomeError`），**不会**阻塞其它实例索引，也不会去重启/杀实例。
- **代理层本地缓存（`src/control/proxy-cache.js`）有 TTL，不是「永远最新」**：远程实例的插件 bundle、
  前端资源、以及只读 RPC（会话列表/历史/描述类）会缓存在 `<HWB_DIR>/proxy-cache`，命中直接本地回。
  实测依据：远端 dsh 对插件 bundle 回 `no-cache` 且无校验器、会话列表走 POST RPC，浏览器侧**根本无法缓存**，
  于是每次打开页面都要在 25–30 KB/s 的链路上重下 3.3 MiB（≈2 分钟）。
  代价是「上游在同一 URL 下改了内容」时最多陈旧一个 TTL（默认静态 600 s、只读 RPC 3 s / 宽限 60 s）；
  内容寻址的 URL（`?rev=<hash>`、`-<hash8>.js`）本身不会原地变，所以这个窗口在实践中是空的。
  写/控制类 RPC（prompt/create/cancel/updateQueue/respond/upload…）、带 `set-cookie` 的响应、
  带 token 的 URL 一律不缓存。要关掉：`HWB_PROXY_CACHE=0`；换落盘位置：`HWB_PROXY_CACHE_DIR`。
- **会话历史（`session.history`）按「会话是否在跑」分档**：它是**原始事件日志**，实测一个大会话
  50 条消息的窗口就有 8–10 MiB（经隧道首次 43 s）。已结束的会话历史不可变 → 长 TTL
  （默认 30 分钟新鲜 / 7 天宽限）；正在跑的会话仍用短窗口（3 s / 60 s），
  且已写下的长副本会在读取时被降级 —— 界面不会停在旧快照上。
  旋钮：`HWB_PROXY_CACHE_HISTORY_TTL_MS`、`HWB_PROXY_CACHE_HISTORY_STALE_MS`。
  想连「第一次打开」都不等：`node scripts/warm-cache.mjs --url <入口> --history 5`。
  **运行中的会话连陈旧副本也不供**（默认 `HWB_PROXY_CACHE_RUNNING_STALE_MS=0`）：dsh 的
  `session.history` 只有 `beforeSeq`（往回翻）而没有 `afterSeq`（向前增量），事件流订阅也不带游标，
  所以一份陈旧窗口中间缺的那段事件补不回来。运行状态未知（没观测到 / 观测超过
  `HWB_PROXY_CACHE_RUNNING_TRUST_MS`，默认 5 分钟）同样按保守档处理。
- **dsh 的 RPC 端点有两代命名**：0.1.2 是 `session/list`，0.1.1-rc.2 是 `session.list`。
  实时会话同步（`src/dshhome/live-status.js`）与代理缓存都按形态/候选两种写法兼容；
  只写死一种时，旧版远端的表现是「实时状态从未生效」（每 3 秒一条 `rpc http 404`）。
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
- **DNS rebinding 防护**：`/api/*` 只接受回环 Host（`127.0.0.1` / `localhost` / `::1`）。
  只靠 Origin/Host 比较挡不住 rebinding——那两个值在攻击场景下都由攻击者控制；
  Host 是否指向回环地址才是唯一能区分「本机页面」与「rebinding 页面」的信号。
  **逃生口**：如果你通过 `/etc/hosts` 别名、devcontainer/Codespaces 的转发域名、或保留
  浏览器 authority 的反代访问，把该主机名加进 `HWB_ALLOWED_HOSTS`（逗号分隔）即可，
  例如 `HWB_ALLOWED_HOSTS=hwb.local hwb start`。放行等于允许该来源的页面访问本地 API，
  请只填自己控制的名字。
- **API key 永不越界**：`.credentials.yaml` 的 key 只用于服务端查余额，浏览器只收到
  `{ provider, remaining, currency }`（单测专门断言 key 不出现在列表里）。
- **无鉴权 ≠ 只有你自己能用**：端口绑在回环上，但**同机的其他用户也能连**（回环不是访问控制）。
  凡是能读到 `/api/*` 的人都能看到实例元数据与会话标题，非浏览器客户端（curl）还带着写权限
  （见上面「跨站写保护」：那两个头本来就不是给 curl 用的）。它是单人本机工具——不要把端口暴露到
  回环之外；同机有不受信任的用户时，请用独立用户或容器运行。
- **dsh token 的暴露面**：读接口（`GET /api/homes`、更新响应）**不再回传 token** —— 实例级与
  连接端点级都不回传，端点只给 `tokenSet: true` 表示「已配置」。因此端点编辑器把输入框留空显示为
  「已配置，留空保持不变」：留空 = 不传该字段 = 沿用已存的值，要清除必须点「清除 token」
  （服务端按端点 id 合并，留空绝不会静默清除）。
  唯一的例外是打开实例必经的 `POST /homes/{id}/open`：它返回**带 token 的 iframe 入口 URL**
  （dsh 的入口就是靠它认证的）。也就是说 token 迟早要交给浏览器，这一条的边界是
  **「谁能访问这个端口」**，而不是「响应里有没有这个字段」。
- **落盘文件的权限**（同机其它用户能读日志/库就等于能读走 dsh token）：
  `hwb.log`（及 `.1/.2`）**0600**、`service.log` **0600**、状态目录 `~/.hwb` **0700**、
  控制套接字 **0600**、`hwb.db` **0600**（SQLite 按 umask 建文件，所以服务启动时显式收一次 ——
  库里存着实例与端点的 token）。日志目录的 chmod **不会**碰当前目录及其祖先
  （日志路径可以是相对的），也不会碰 `HWB_DIR` 被误设成的共享位置（`/tmp`、`$HOME`、`/`）。
- **`/api/*` 一律 `Cache-Control: no-store`**：这些 JSON 里有实例元数据、会话标题与错误上下文，
  不该留在浏览器缓存或中间反代里；同时带 `X-Content-Type-Options: nosniff`。
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
| M7 — Publish | 🎯 v0.1.5（本版） |

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
