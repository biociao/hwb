# Changelog

All notable changes to **hwb** are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), this project adheres to
Semantic Versioning.

## [Unreleased]

> 本节原先只记了「文件预览上传」一件事，而 v0.1.1 之后其实落了 6 个功能性提交。
> 下面先把它们补记齐（按主题合并，不逐条 commit 罗列），再是后续的修复记录。

### 本轮全面回顾摘要（2026-09-12）

### 起床后先看这三件事

1. **代码在哪**：分支 `tmp-reorder2`，今晚新增 **139 个提交（本地，未 push）**；
   `main` 落后于本分支，**要不要合并/push 由你决定**。工作树是干净的、全套 **637 例（636 通过 / 1 skip / 0 失败）**。
2. **你现在这台机器上的服务还在跑旧代码**：真实库副本上验证过，重启后会自动完成迁移 ——
   `user_version 0 → 2`、补齐四个派生列、建好新索引 `idx_sessions_home_ws`，**耗时 3ms**，
   派生列求和与 `json_extract` 预言机**分毫不差**（3,937,139,946），迁移前后行数不变（553 会话 / 5 实例）。
   也就是说：`hwb restart` 即可，不需要任何手工动作。
   **另外三处「重启才生效」的安全收紧**（都是今晚早些轮次落的，你的运行中进程还没有）：
   · `~/.hwb/hwb.db` 现在是 **0644**，而它里面存着**你本机 dsh 的 token**（实测 43 字符）——
     重启后由 `server.js` chmod **0600**（这条性质今晚补了回归测试：先造一个 0644 的库，
     启动后必须变 0600）；
   · `~/.hwb` 目录现在是 **0755**（可被同机其它用户遍历）→ 重启后收 **0700**；
   · `hwb.log` / `service.log`：前者已在自己轮转（当前 845 KB，接近 1 MiB 阈值），
     后者现在也会在每次 `start` 前做 8 MiB 上限控制。
3. **会看到什么变化**：你那台机器的 dsh 实时列表有 500 条会话、projcache 文件里只有 179 条，所以
   重启后工作台仍是 500 条（179 条文件索引 + 321 条实时补插）；差异是 dsh 停掉后那 321 条会被清掉
   （旧代码把它们当普通行永久留着），dsh 再跑又回来。详见下面「新代码 vs 正在跑的旧服务」那一节。
4. **建议先看的东西**：搜 `### 已知残留`（每条都带实测数字、改法与「怎么证明改好了」）——
   其中三条是规模审查今晚才测出来的：实时轮询**部分变化**时仍是全量重写、上传单次 4.2× 内存、
   `/api/usage` 在真实形态夹具上 148ms@40k（memo 每 10s 仍会因实时写入而重算）。
   另外两个可复用的工具：`scripts/smoke-e2e.mjs`（一条命令跑完整条链路，19/19）与
   `scripts/render-check.mjs`（CDP 驱动真浏览器，含宽度扫描 18/18）。

> **这份 Unreleased 的导航**：本节是**本轮通宵回顾**的汇总；往下是逐个主题的 `### Added` /
> `### Fixed` 条目（新→旧）。想快速定位就用搜索：
> `### 已知残留`（未修项 + 实测数字 + 改法）、`### 变更说明（证据，不是猜测）`（用 dsh 自身的类型声明/真实库
> 副本定案的结论）、`### Security`、`### Notes`。


对 v0.1.1 之后的全库做了一轮系统回顾：**20 轮独立对抗式审查**（控制平面 ×2 / lib+api /
web+dshhome / 前端与 SSE ×2 / 文档一致性 / 服务生命周期 / 预览与静态缓存与远端索引 /
渲染壳与日志脚本 / 跨模块数据流 / 存储层 / 近两轮改动的回归审查 / 数据管线 / cli+service+lib 生命周期 /
**测试网自身** / **规模与长跑**）+ 1 轮纯函数对抗 fuzz + 2 轮敌意环境测试 +
多轮针对「我自己刚改的代码」的自审，共 **139 个提交、637 个用例**
（`npm test` 的输出为准；README 刻意不写死这个数字）。

后几轮开始把「不变量」本身当成审查对象，于是又挖出一类新问题：**守卫存在但没人守**。
审查的方式是「把守卫改坏，看套件会不会红」——一次就找出 7 处改坏后**套件仍然全绿**的守卫
（live-poller 的端点守卫、indexer 的两条实时新鲜度守卫、路由处理器抛错必须回 500、
`markHomeError` 必须吞掉自身失败、两条源码级断言其实挡不住它们声称的性质、`openTunnel` 的真实 argv），
以及 4 处「断言写成了实现细节」（`typeof === 'boolean'`、子串锚点、自比较）。
这一类比「某条路径没测」更危险：前者只是空白，后者会让人**以为**已经守住了。

到了最后两轮，审查开始从「功能对不对」转向「**规模上站不站得住**」，于是拿到了一批带数字的结论：
`/api/projects/recent` 在 400k 会话上单独就要 44.3s、期间整个服务停顿 9.8s（缺一个索引即可修到 1.2s）；
实时轮询每 3s 会把每个实例的**每一行**会话重写一遍（40k/10 实例 891ms/轮）——现在改成
「内容全等就跳过、只有已存在的行变化就只写那几行」（实测 338ms → 165ms/轮，另有差分测试守着）；
`service.log` 是唯一不进轮转的日志，失败形态下约 490 MB/天；上传没有并发上限（256 MiB 单次峰值
1.12 GiB）；SSE 触顶拒绝原先一声不响。也顺手得到一条**阴性**结论：给 store 加 prepared statement
缓存实测**没有收益**（4.4→4.2ms），因此没有采纳。

一条贯穿始终的教训写在这里：**后几轮总能发现前几轮漏掉的东西**，而且往往就在前几轮「已经审过」
的那些文件里 —— 第 5–8 轮找到「远端上传整条链路根本走不通」，第 9–10 轮又在同一个 store.js 里
找到「降级时会把历史用量洗掉 59% 并删会话」和「迁移失败会让历史永久显示 0」；
第 13–15 轮又在**同一天刚改过**的 launcher/store/web 里找到「停止只发信号不等待、界面却报已停止」、
「401 被当成已连接」、「实时 tokenUsage 部分对象整列覆盖」这些。一次审查通过不代表没有缺陷，
只代表那一轮的选题没碰到它。

**第 13–15 轮（同一晚的第三批）——「报成功而实际没做到」与「只在真实布局/真实进程里才暴露」**
- **停止实例只发信号不等待**：忽略 SIGTERM 的子进程仍在监听端口并返回 200，而 API 回
  `{ok:true,stopped:true}`、句柄已被丢弃（连重试的机会都没有）。现在 SIGTERM→3s→SIGKILL→2s，
  确认退出才算停掉，杀不掉就抛错并保留句柄。同理：退出时 `shutdown()` 会先 `await stopAll()`
  （否则孤儿进程占着端口活到没人管），`open()` 失败会收掉刚拉起的子进程（否则僵尸 LISTEN）。
- **连接从不验证鉴权**：心跳用的 `httpProbe` 口径是 `status < 500`，**401 也算活着**，于是 token
  填错/远端轮换 token 时界面一片绿、iframe 里是 401。新增 `probeAlive()`（401/403 判不可用）与
  `#assertAuthorized()`（三条连接路径都走一次真 token→cookie 交接），并用**真实 dsh web** 复验过。
- **实时 tokenUsage 只带部分计数器时会整列覆盖**：文件侧合计 109100 的会话被一个只带两项的实时对象
  覆盖后面板掉到 120（静默丢 99.9%）。改成按 key 合并。
- **上一轮刚加的「实时状态保护」把已消失会话的陈旧「运行中」永久钉死**（A/B 实测：保护前
  `s1=idle`、保护后 `s1=running`）。保护现在只认**本次实时列表里确实存在**的会话。
- **前端有一类缺陷只在真实布局里存在**：x 轴标签按序号等分、散点按时间（30 天/5 个非空桶时
  错位 61%）；空状态直接 return，把「放宽统计周期」的按钮一起挡在门外。为此补了
  `scripts/render-check.mjs`（CDP 驱动 headless Chrome，零依赖；`--dump-dom` 因常驻 SSE 永远超时）
  与宽度扫描（6 宽度 × 3 形态，18/18）。

**用户当下就能看到是错的**
- **179 个会话里 18 个被永久标成「运行中」**，全部空闲 7–28 天 —— 判据来自会冻结的投影缓存快照，
  且 `plan.active`（持久模式开关）被当成了活动信号。修复后真实分布变为 `{idle: 147, completed: 32}`。
- **分时用量图静默丢掉「当前这一小时」**：真实库 24h 窗口丢了 3.5% 的 token；且桶是倒序。
- **额度功能整个不工作**：只要有 provider 行但缺 key（很常见），刷新就抛 TypeError，
  整批 provider 一个都进不了缓存。
- **dsh 升级会静默清空该实例的整个索引**（版本不兼容 → 该域 degraded → 整表被清），
  且界面上完全不显示 degraded。

**会悄悄毁掉数据的（第 9–10 轮审查发现）**
- **降级 + 实时合并会把文件索引的会话「洗白」甚至删掉**：dsh 升级到不认识的 `unit.version` 时
  （降级路径存在的唯一理由），projcache 产出 0 条会话行 → 实时合并把每条会话都当成新会话
  （字段全 null + `liveOnly=1`）→ 与库里**刻意保留**的行相撞：实测用量 **1520550 → 620550**，
  且下一次「实时列表为空」的轮询会**直接删掉**那些会话。
- **迁移失败会让历史用量永久显示 0**：用**真实 SQLITE_FULL** 复现 —— 旧闸门「看列在不在」
  而回填在另一个事务里，失败后列已存在 ⇒ 再也不回填 ⇒ 所有历史用量为 0，无报错、无 degraded 标记
  （实测第二次启动 `totalTokens=0`，而独立预言机是 82000000）。

**会让整个工作台消失或卡死的**
- **数据库里一个坏 JSON 列** → 读路径裸 `JSON.parse` → 进程启动后 3 秒内 `exit 1`，
  且崩溃发生在 `listen()` 之前，用户只看到一句「启动失败 (1)」。
- **元数据文件是 FIFO** → 同步读取永久阻塞，端口都没 bind，`SIGTERM` 也无效，只能 `kill -9`。
- **两条「一次普通失败 = 整个工作台退出并杀掉所有 dsh 子进程」的路径**：
  `spawn('dsh')` 失败（PATH 里没有 dsh）、WebSocket 升级空窗内的 ECONNRESET。
- **SSH 重连退避用尽后实例永久卡死**，网络恢复也不会自愈。

**安全**
- **`~/.hwb/hwb.log` 是 0644 且含 44 处 dsh token**（持有它等于持有该实例的完整控制权）；
  现已三层脱敏 + 0600/0700。
- **存储型 XSS**：dsh 元数据里的 `approval` 未转义，可突破 `title` 属性注入任意标签。
- **DNS rebinding**：实测可读到明文 dsh token、读写工作区文件（同源检查挡不住，Host 校验才挡得住）。
- **13 个写路由里只有 3 个有跨站校验**；`text/plain` 的 POST 属 CORS 简单请求、不触发预检。
- **API key 会经错误消息泄漏**进未经鉴权的 `/api/quota`。
- 独立脚本 `dsh-remote-web.sh`：远端参数整体错位 → `pkill -f web` 杀远端无关进程；
  `/tmp` 固定 PID 文件可被构造成 `kill 0`。

**功能整条链路其实是坏的（第 5–8 轮审查发现）**
- **远端实例上传整条通道不可达**：路由用**本地** fs 校验**远端**路径 → 永远 400。
  那套加固过的远端分片上传（512 KiB 分片 / 远端 mktemp / realpath+commonpath 校验 / 失败清理）
  **一条路径都走不到**。原因是它从未被路由级测试覆盖 —— 现在 ssh 执行器可注入，这条链路第一次被走通。
- **0 字节文件在远端永远传不上去**（本机可以）：空文件不产生任何分片 → 远端判「没收到数据」。
- **`status`/`doctor` 把正在服务的前台 `hwb serve` 报成「已停止」**，`status` 还以退出码 1 结束
  （脚本 `set -e` 会据此判定服务挂了）。
- **一个实例的坏输出会让整份聚合索引一整轮作废**（旁边健康的实例也不刷新），
  而 JSON 模式失败时 **stdout 空、退出码 0** —— 下游拿到空文件却以为成功。
- **取会话头部时把整个 300 MB 会话读进内存**（峰值 RSS **44 MB → 360 MB**，脚本还跑在远端主机上）。

**会让服务消失的（第 5–8 轮审查发现）**
- **父进程（`hwb start`）提前退出会打死刚起来的后台服务**：`process.send` 失败是**异步**的
  （IPC channel 的 error 事件），`try/catch` 抓不到 —— 只加 try/catch 实测仍然崩。
- **主机名里的控制字符**（`\0` 不在 `\s` 的覆盖范围内）会一路走到 `spawn` 并**同步**抛错，
  让 `sshBash` 变成一次 rejection（所有调用方只检查返回值的 code）。
- **残留启停锁会让 start/stop/restart 全部失效**；而且只看 PID 活不活还会被 PID 回收再次卡住
  （现在用心跳 + 接管动作本身也做了竞态处理）。

**性能（第 8 轮审查，实测）**
- **`/api/usage` 是 8 个同步聚合**：40k 会话下合计 ~330ms，而 `node:sqlite` 是同步的 ——
  那段时间 HTTP/SSE/心跳全停（实测其后 2ms 发出的 `/api/homes` 从 9ms 变成 349ms），
  而前端原先**每次渲染**都取一次、渲染又由 SSE 每 3s 驱动。现在：服务端 10s TTL 记忆
  （连续 5 次 348→1/1/1/1ms）+ 客户端 15s 节流 + 派生整数列（等效 5 条聚合 175→76ms）。
- **取会话头部时把整个 300MB 会话读进内存**（峰值 RSS 44MB → 360MB）—— 那个脚本还跑在远端主机上。

**兼容**
- `engines.node` 从 `>=22` 收紧到 `>=22.5.0`（`node:sqlite` 自 22.5 才有）。
- 远端是 macOS/BSD 时端口检测恒为「未监听」→ 实例报 running 但 iframe 是 401。
- 旧版 dsh 不认识 `--no-open`：远端能用、本机连不上。
- **相对的 `HWB_DIR`** 下 CLI 与后台服务会指向两个不同的状态目录：`status` 说 stopped 而服务在
  返回 200、`stop` 永远停不掉，还会在仓库里落下一个状态目录。
- `intervalMs` / `--port` 没有上界：`setTimeout` 超过 2^31-1 会按 **1 ms** 处理（CPU 打满）；
  `--port abc` 会绑到随机端口，用户看到的端口号是假的。
- 没有 spawnSync 的 `maxBuffer`：索引 JSON 超过 1 MiB 的实例被永久判成「离线 · exit null」。

细节见下面各条（每条都写了现象、根因、修复与回归测试）。

### Added
#### 统一管理命令 `hwb`
- `hwb start | stop | restart | status | logs | config | doctor | upgrade | test`，以及 `hwb serve`
  等价于原来的 `node src/server.js`。后台运行经 `src/service.js` + 私有控制 socket
  （不用 PID 文件，避免 PID 复用误杀）；`doctor` 检查 Node 版本、配置与服务可达性。
- `~/.hwb/config.json` 集中配置（port / db / log / intervalMs / homes / verbose / silent），
  `hwb config set|update|show|path` 校验后原子落盘。

#### 实例多连接端点
- 实例身份（`homeId`）不再等同于「主机:端口」：端口成为实例下的一个**连接端点**，
  同一实例可保留多条通道（1–32 条）并按需切换；`switch` 先验证新端点再释放旧连接，
  失败时当前连接与实例身份不变。
- 远程实例的**本地接入端口可持久化**（`accessPort`），预览代理端口跨重启保持稳定；
  唯一性由数据库唯一索引兜底。

#### 实时会话状态（3s 独立轮询）
- 新增 `src/dshhome/live-poller.js`：3s 周期独立调度器，每个实例并发去重、进行中不重复发，
  只在实例仍为运行态且 `activeEndpointId` 未变时写库（避免切换端点后旧响应覆盖新状态）。
- `src/dshhome/live-status.js` 直接读运行中 dsh 的实时投影，以 dsh 的 `running` 布尔为权威信号
  （持久化投影可能过期）；认证/RPC 失败区分成因，且日志不含 token。

#### 浅色主题与外观切换
- 默认改为暖纸白浅色主题（墨蓝 accent、系统字体栈），深色主题随系统偏好；
  右上角「白天 / 黑夜 / 跟随系统」下拉，选择存 `localStorage` 并在 `<head>` 内联脚本里
  首帧前应用（避免刷新闪一下）。切换后重绘工作台——实例/项目 chip 配色是内联样式，
  深浅两套调色板需要重渲染才切换。
- favicon.svg / png / ico 与 apple-touch-icon 换成配套配色。

#### SSH 连接层统一（`src/control/ssh-opts.js`）
- **根因记录**：经 tun + EasyConnect 的远端建一条 SSH 会话实测需 11.7–14.0 s，而代码里硬编码
  `ConnectTimeout=10`，于是**所有**脚本化 ssh（抓 token / 建隧道 / 探测）必然 255 超时 ——
  表现为「终端手动 ssh 能连、hwb 连不上」。
- 连接层放宽 `ConnectTimeout`（默认 30s）、加保活（`ServerAliveInterval`/`CountMax`/`TCPKeepAlive`）
  与复用（`ControlMaster=auto` + `ControlPersist=300`）。复用套接字用 12 位短哈希而非 `%C`：
  macOS 的 unix socket 路径上限是 104 字节，`TMPDIR` 下的 `%C` 必然超限，故对最终路径长度做校验、
  超限就退回不复用。瞬时连接故障按退避重试，且只对「失败得很快」的错误重试。
- 隧道追加 `-C` 压缩；`ssh -G` 先解析 Host/Include/Match，再只删掉继承来的 forward 指令写进
  私有配置，不会把 hwb 自己的 `-L` 一起清掉。

#### 工作台 UI 与文件预览
- 文件预览侧栏（浏览目录 / 图片查看 / 下载 / 拖拽上传）、实例入口改用预览代理 URL
  （外部打开仍直连原始服务连接）、实例视图右上角浮层移除（停止改为设置里的明确确认流程）。
- 刷新加序列号防抖，迟到的响应不再覆盖新状态。

#### Node 版本门槛集中到单一事实来源（src/lib/node-version.js）
- 新增 `MIN_NODE = '22.5.0'`、`isNodeSupported()`、`nodeRequirementMessage()`、`enforceNodeVersion()`；
  `package.json` 的 `engines`、`hwb doctor`、`hwb` 启动预检、CLI `--help` 文案现在同源，不再各写一份。
- `hwb doctor` 原先把版本判断内联成 `major < 22 || (major === 22 && minor < 5)`，与新模块重复；
  改为复用同一判断，避免两处漂移。
- **端到端复验**（本轮）：本机另有一个 Node **20.11.0**（低于门槛、且没有 `node:sqlite`），
  用它真跑了一遍 —— `--version` 与 `--help` 照常可用（逃生口，便于在旧 Node 上诊断），
  `hwb start` 与直接 `node src/server.js` 都以退出码 1 给出可照做的说明
  （「需要 Node.js ≥ 22.5.0（当前 20.11.0）… 请升级后重试：nvm install 22」），
  而**不是**那句难懂的 `ERR_UNKNOWN_BUILTIN_MODULE: No such built-in module: node:sqlite`。

#### 文件预览侧栏支持拖拽上传（src/web/components/file-preview.js + src/lib/file-preview.js + src/api/routes.js）
- 浏览目录时侧栏显示上传区：拖拽文件到侧栏即上传到**当前预览目录**，也可点「选择文件上传」；
  多文件串行上传并显示整批进度，完成后自动刷新目录列表。单文件上限 256 MiB（前端先过滤超限文件）。
- 新增 `PUT /api/homes/{homeId}/upload`：只接受 multipart 文件字段，落盘位置完全由服务端依据
  已登记工作区 + 当前目录决定（只取文件名，`..`/符号链接/工作区外路径全部拒绝），跨站写入返回 403。
- **同名不覆盖**：已存在 `data.csv` 时新文件落为 `data(1).csv`（本机与远端一致）。
- 原子落盘：先写隐藏临时文件、写满后 `link`/`replace` 到最终名；中断只会留下隐藏临时文件，
  且 `stage`/`cleanup`/`commit` 都会清掉暂存目录，不在项目目录留副产物。

### Changed
- 索引层：实时会话状态双向合并（`store.applyLiveStatus` 只更新会话行，保留文件索引来的
  workspace/provider 数据），并引入**按实例的索引退避** —— 单个实例反复失败不再拖慢整批。
- **`engines.node` 从 `>=22` 收紧到 `>=22.5.0`**：索引依赖内置 `node:sqlite`，该模块自 22.5.0 起才提供。
  原先声明 `>=22` 会把 Node 22.0–22.4 的用户放进来，然后死在
  `ERR_UNKNOWN_BUILTIN_MODULE: No such built-in module: node:sqlite`——由于本项目零依赖，
  这个报错极易被误读成「忘了 npm install」。
- `src/server.js` 改为动态 `await import('./dshhome/store.js')`：静态 import 会先于模块体求值，
  让 `node:sqlite` 的加载早于版本预检，预检就永远来不及给提示。其余 import 不受影响。
- 本机**下载**不再经 base64 中转（`readLocalPreview` 直接交回 `Buffer`）。原先的链路上有三层同尺寸
  副本：原 buffer → base64 字符串（1.33×）→ `JSON.stringify` 的结果（又一份）→ 调用方再解一遍，
  实测 64 MiB 文件额外堆占用约 170 MiB（合计约 235 MB 峰值）。远端仍用 base64（ssh 传输需要），
  调用方按类型分别处理。实测本机 64 MiB 下载的 RSS 增量从 ~235 MB 降到 64 MB。

### Notes
- 远程实例的上传**内容经命令行参数按 512 KiB 分片传输**（远端先分片落盘到临时目录再合并）。
  实测把文件字节写到 `sshBash` 的 stdin 不可行：`bash -s` 会把脚本之后的字节当命令执行
  （表现为 `...: command not found`，Python 一个字节都读不到）；而「长度前缀」之类的 stdin 协议
  又会被 bash 的预读吞掉，无法保证字节边界。分片参数传输没有这个问题，也不受 macOS 单参数上限影响。
- 上传的 multipart **解析器**是流式的（`src/lib/multipart.js`）：边解析边把文件字节交给写入端，
  缓冲区只保留「可能是分隔符开头」的尾巴。缺失 `Content-Length` 时直接拒绝，以保证写盘前就能设限。
- **订正**：解析器是流式的，但**上传路由目前会把整份文件先攒在内存里**再交给写入端
  （`src/api/routes.js` 的 `onFileStart`/`write` 把每个 chunk 推进数组）。原因是解析器的
  `write(chunk)` 回调是同步契约，而落盘写入（`uploader.write`）是异步的，路由无法在回调里 await。
  实测（64 MiB 上传，同进程采样）进程 RSS 峰值 **+202 MiB（≈3× 文件大小）**：数组本身 1×，
  其余是 HTTP 层缓冲与 GC 尚未回收的页；上限 256 MiB 时按同一比例 ≈800 MiB 峰值。
  这是有界且短暂的开销（单机工具、单请求），但要改成真流式需要让解析器支持异步写入端 ——
  属于后续工作，不再声称「内存占用与文件大小无关」。

### Security
- **日志里的 dsh 启动 token 不再落盘**（`src/lib/logger.js`）。实测本机 `~/.hwb/hwb.log` 是
  `-rw-r--r--`（目录 `drwxr-xr-x`），里面有 **44 处** `http://127.0.0.1:<port>/?token=<launchToken>`
  —— monitor / launcher 会把带 token 的 URL 直接写进日志字段，而持有该 token 等于持有那个
  dsh 实例的完整控制权（dsh web 的工具能执行 shell、写文件），同机任何用户读到日志即可拿到。
  修复分三层：① 写入前对**最终日志行**做统一脱敏（`?token=` / `token=` / `"token": "…"` 各种形态，
  值不设长度下限 —— 宁可误脱敏也不能漏）；② 环缓冲条目与 SSE 推送同样脱敏（浏览器与 UI 也拿不到）；
  ③ 日志文件 `0600`、状态目录 `0700`，且打开已有文件时 `fchmod` 纠正历史权限（升级路径）。
  同时把 `hwb.db`（会话标题/路径）收紧到 `0600`，服务控制 socket 改为先保证**目录** `0700`
  再 bind（socket 在 bind 与 chmod 之间存在一个极短的 0755 窗口，期间同机用户可以连上去发 `stop`）。
- **回归测试**：`tests/logger-security.test.js` —— 覆盖各种 token 形态的脱敏、不误伤普通文本、
  token 既不落盘也不进环缓冲与控制台、目录/文件权限、以及「已存在的 0644 文件会被纠正」。

### Added
#### 路由级的路径围栏回归测试（tests/api-path-containment.test.js）
- preview / download 把 `?path=` 交给 file-preview 解析，围栏（realpath + commonpath、拒绝符号链接）
  是「项目目录之外一个字节都读不到」的唯一保证。**单元测试覆盖了解析函数，但路由的接线**
  （workspaceId 解析、400 的返回、正常 200、跨站头）只有真发 HTTP 才测得到。
- 本轮先用真实 HTTP 探了一遍（相对越界 / 绝对路径 / 符号链接文件 / 符号链接目录 / 内嵌 `..` /
  URL 编码的 `..%2F`）：download 与 preview 全部 400 且不回内容，正常文件 200 —— 然后把这份探针
  固化成测试（含 `sec-fetch-site: cross-site` → 403、未知 workspaceId 不泄内容两条对照）。

### 已知残留（规模审查的实测数字，本轮未修）
这几条是**测出来的**、有明确改法，但改动面比本轮剩余时间能安全验证的更大，
所以先记下数字与改法，留待后续（每条都注明了「怎么证明改好了」）：
- **实时轮询每 3s 重写每个实例的每一行会话**（**主体已修**）：`applyLiveStatus` 原来是 `SELECT *` +
  全量 upsert，代价正比于该实例的**总会话数**而不是「变了多少」。规模审查实测 40k/10 实例：
  **891ms/轮**（约占每轮 30% 的同步阻塞）；单个 home 有 200k 会话时**单次 3,494ms**。
  现在两级：①内容与库里**逐字节相同** ⇒ 整表写整个跳过；②只有已存在的行变了（没有新增/幽灵）⇒
  **只 UPDATE 变化的那几行**（`#updateLiveRows`），其余情况仍走原来的整表替换（语义完全不变）。
  实测（10 实例 × 4000 会话、每个实例只有 3 条变化）：**338ms → 165ms/轮**；有差分测试
  （优化路径 vs 整表替换，7 个场景逐行比对库状态）与变异验证守着。
  仍留着：每轮仍要 `SELECT *` 读该实例的全部会话并逐行做合并 —— 165ms 里的大头是这个；
  改法：只 SELECT `liveIds` 那几行（实时列表通常就是全部会话，所以收益取决于场景）。
  证明：400k 夹具上断言 `applyLiveStatus` 随 `live.length` 而不是 `sessionCount` 增长。
- ~~上传没有并发上限~~ **已修（并发闸门）**；剩下的部分是「单次上传的 4.4× 内存」：
  实测 256 MiB（`UPLOAD_BYTES` 上限）单次峰值 **1.12 GiB RSS**，4 个 32 MiB 并发 557 MB。
  现在同一时刻只允许一个上传（超出的立刻 503 + warn），最坏内存回到「一次上传的大小」；
  要再降一档需要让路由的 `write(chunk)` 直接喂给 uploader（它本身是有背压的流）——
  那要改解析器的同步写入契约，留待后续。证明方式：4 个 256 MiB 并发上传，峰值 RSS < 1.5 GiB。
  （闸门本身的第一个版本有个自伤 bug，自查时发现并修掉了：它的计数在若干条**提前返回**路径上
  不会回退 —— 一个非 multipart 的 400 请求就能让之后所有上传都 503，直到进程重启。）
- **`/api/usage` 的实测成本高于项目自己文档里的数字**（另附一条**阴性结论**：审查猜「每次调用都重新
  prepare 语句」，于是给 `store` 加了一层 prepared statement 缓存并实测 —— 40k 夹具上
  `usageSummary` 4.4→4.2ms、`usageTrendGrouped` 16.2→15.9ms、`recentProjects` 93.5→93.3ms、
  `listHomes` 8.1→8.0ms，**没有可测收益**，因此**没有采纳**（不留没有证据的优化）。所以 F6 的成本
  来自聚合本身，而不是重复编译。）：40k 夹具上 8 个聚合约 **148ms**
  （文档写的是「55ms 冷」）、100k 冷请求 **430ms**、400k **2,213ms**（5 个 trend 维度 × 400k 行）。
  记忆（memo）确实把重复请求压到 0.6–1.2ms，但 `dataVersion()` 每 3s 的实时写入都会变，
  于是在忙碌的仪表盘上每 10s 就会**重算一次**（400k 上是数秒级冻结）。
  改法：像 `#enrichHome` 那样缓存 prepared statement（现在每次调用都重新 prepare），
  并/或把 `usageTtlMs` 提到实时写入节奏之上。证明：用 CHANGELOG 里同一段 A/B 脚本在 400k 夹具上
  同时报「冷」与「TTL 过期 + 版本变化」两个数字。
- 顺带记一条**已清除**的担心：32 个空闲 SSE 客户端广播 14.2s，每客户端 263 B/s（全局广播、与视图无关），
  扇出量本身不是问题；单客户端的 4 MiB 背压上限也是有效的。

### Added
#### CI 里加上端到端冒烟这一步（.github/workflows/ci.yml）
- 起因：审查在报告里点了一句 —— `scripts/render-check*.js`、`scripts/smoke-e2e.mjs` 这些
  **不跑在 `npm test` 里**，所以「18/18 宽度通过」「19/19 冒烟通过」都只是手工结论、不是门禁。
  渲染检查需要 Chrome（CI 里不保证），但**冒烟不需要**：它只起一个隔离实例、用 fetch 打各 API。
- 现在 CI 在 `npm test` 之后多跑一步 `node scripts/smoke-e2e.mjs --port 4394`，
  于是「接线层」也有门禁了：注册/索引/用量/SSE/上传下载/移除实例/优雅退出。
  （本地实测 17/17 通过、约十几秒；端口用 4394 且脚本自带端口预检，CI 里不会撞。）

### Added
#### 端到端冒烟：scripts/smoke-e2e.mjs（+ scripts/README-smoke-e2e.md）
- 一条命令跑完整条链路并逐步断言：起**隔离**实例（显式 `--db/--log`）→ 造一个「更早用过」的假 dsh home
  → 注册/索引 → 列表/工作区/用量（含 24h 空窗口那条链）→ SSE 收到 `index:updated` → 真实 multipart
  上传与下载 → （`--with-chrome`）真浏览器加载工作台并断言用量卡 → 移除实例后用量立刻不含它 →
  `SIGTERM` 优雅退出。实测 **19/19** 通过。
  其中「降级实例」那一步是历史缺陷的守门测试：`unit.version` 越界的 home 必须照常入库、
  API 里 `status=degraded`、**界面上出现「⚠ projcache 降级」警示 chip**（真浏览器实测），
  而不是整个实例看起来「空了」。
- 起因：这一晚多轮审查反复证明**集成层**才有真问题（端口记账、用量记忆、降级窗口、渲染拟合），
  而此前只能靠手动验证。
- 两个防假绿措施（都是踩过才加的）：①目标端口上已经有东西在服务时**直接拒绝启动**（否则旧实例
  会替本次 spawn 的服务回答所有断言，而最后一条「SIGTERM 后自行退出」失败 —— 第一版就这么假绿过一次）；
  ②未连接实例时 `/api/sessions/recent`、`/api/projects/recent` **必须为空**（它们只列 `runtime=running`
  的实例），这一条顺带把「索引有数据但界面空」的两种原因区分开了。

### Added
#### 真浏览器渲染检查（scripts/render-check.mjs + scripts/README-render-check.md）
- 前端是「拼 HTML + innerHTML」，有一类缺陷**只在真实布局里存在**（坐标轴错位、空状态少按钮、
  标签压字/贴边裁切、拟合函数没被调用）。本项目的多轮审查里最有价值的前端发现全部来自真浏览器，
  而此前一直没有一个可复用的检查手段：`--dump-dom` 要等网络空闲，而前端有一条常驻 SSE ⇒
  实测 30s 超时、0 字节输出（另外 `--user-data-dir` 必须显式给，否则 headless 起不来）。
- 现在用 CDP 驱动 headless Chrome（Node 22 自带 WebSocket，**零依赖**）：`--url` +
  `--expr-file` 在页面里跑一段 async 代码，取回 JSON 结果，并收集 `console.error` 与未捕获异常；
  退出码区分「断言失败」与「启动/连接失败」。
- 本轮用它端到端验证了下面几条前端修复（隔离实例 + 假 home，真实数据、真实 SSE）：
  空窗口仍有 5 个周期按钮、点击 30 天后标签与散点偏差 0.00px 且不重叠不越界、
  无 0 值散点、日志面板有历史行、添加实例的 warning 在 SSE 刷新后仍在。

### Added
#### 宽度扫描：scripts/render-harness.html + scripts/render-check-widths.js（render-check 增加 --serve）
- `render-check.mjs --serve` 把仓库根当静态站起在随机端口上，于是渲染夹具可以直接跑
  （组件的 ESM 在 `file://` 下会被 CORS 挡掉，必须有个 http 源）。
- 宽度扫描把 **6 种卡片宽度 × 3 种数据形态** 跑一遍，逐条量「对齐 / 重叠 / 越界」。
  修复后 18/18 通过（偏差全 0.0px）。这张表同时是「x 轴标签不能用静态常量收边」的证据：
  同一组数据在 242px 与 1142px 的绘图区里能放下的标签数差 3 倍。

### Fixed
#### 正文恰好是 JSON `null` 的 POST 会**得不到任何响应**（src/api/routes.js + src/api/server.js）
- **现象**（本轮真机 fuzz 发现）：`curl -d 'null' -H 'content-type: application/json' /api/homes`
  **既没有响应也不断开** —— curl 6s 超时后报 `HTTP 000`，连接与 socket 一直被服务端持有着；
  而同一条路径上 `{}` / `[]` / `"x"` / `5` / `true` 全部一瞬间 400（逐个跑过，`null` 是唯一挂死的）。
- **根因**：`readJsonBodyOr400()` 用 `null` 同时表达两件事 ——「解析失败、已回 400」与
  「正文解析出来就是 `null`」，而四个写路由统一写着 `if (body === null) return;`。
  `JSON.parse('null') === null` 一到就被当成「已响应」直接 return：没写响应头、也没 end。
- **修复**：哨兵换成专用 `Symbol('body-handled')`（`BODY_HANDLED`），不再与合法正文撞车；
  非对象正文（`null`/数字/字符串/布尔）显式回 400「正文必须是 JSON 对象」，而不是放过去、
  最后报一句与根因无关的 `homePath is required`；`open-workspace` 那条此前直接用 `readJsonBody`
  （正文 `null` 会变成 `Cannot read properties of null` 的 400）也统一走同一入口。
- **兜底网**：`src/api/server.js` 新增并导出 `ensureResponded()` —— 路由 return 之后若**一个字节都没写**，
  补 500 并记日志（带 method/path）。判据刻意是「没发过响应头」而不是「没 end」：
  SSE（`/api/events`）会立刻发头、然后长时间挂着连接，那种连接绝不能被补一个 500 掐掉。
- **回归测试**：`tests/api-server-hardening.test.js` 新增两条（修复前均红，实测）——
  ① 带 3s 超时的 fetch 打 `null`/`5`/`"x"`/`true` 四种正文，修复前以 TimeoutError 失败、修复后 400；
  ② `ensureResponded` 三态（没写→补 500+日志；已结束→什么都不做；已发头=SSE→什么都不做）
  外加接线结构断言；③ 真 socket 上的「兜底网不误伤真实流量」—— 跑 JSON / SSE / 文件预览三条真实路由，
  断言一次兜底网都没触发，因为 SSE 一旦被推迟到下一次事件循环再发头，兜底网就会给刚建立的长连接补 500。
  变异验证：删掉 `server.js` 里那句调用 → 结构断言变红；把兜底网判据改成「只看 writableEnded」
  → ②③ 两条一起变红（SSE 被误杀）。
- **真机复验**：新代码起在 4398 上，四种正文都是 ~1ms 的 400，日志里没有兜底网记录
  （说明是根因修好了，而不是被兜底网兜住）。

#### 文本字段里的 U+0000 会在写库时被静默截断（src/lib/normalize.js + src/dshhome/live-status.js）
- **现象**：`node:sqlite` 绑 TEXT 时按 C 字符串处理 —— 值里的 U+0000 会把**后面全部截掉**，
  而且没有报错、没有 degraded、界面上看不出少了什么。实测（审查）：`run('A\u0000B')` 读回 `'A'`，
  `run('\u0000leading')` 读回 `''`；实时通道里一个带 NUL 的长标题落库后只剩第一个字符。
- **修复**：在**产出侧**统一剥掉 NUL（`normalize.js` 的 `stripNul()`，会话/工作区/provider 的文本字段 +
  实时通道的 sessionId/cwd/title）。JSON 列不受影响（`JSON.stringify` 会把 NUL 转义成文本）。
- **回归测试**：`tests/normalize.test.js`（`A\0B` 必须落成 `AB`，开头是 NUL 也要保留其余部分）。修复前失败。

#### 脱敏在若干前缀标点前失效（src/lib/logger.js）
- **现象（审查实测）**：键名前缀字符类是 `[?&\s"']|^|[\w-]`，于是
  `(token=S)`、`a,b,token=S`、`x;token=S`、`{token=S}`、`[token=S]`、`err:token=S`、`a=token=S`、
  `path/token=S`、`#token=S` 这些形态**都不会被脱敏**；`{"Authorization":"Bearer <v>"}`（JSON 引号形态）
  同样漏掉。
- **可达性说明**：审查同时确认现有调用点里没有会产生这些形态的地方（主路径 `?token=` 是覆盖的），
  所以这是**加固**而不是已发生的泄漏 —— 但日志脱敏是「多一层就少一份凭据」的事，值得补齐。
- **修复**：前缀类放宽为「任意字符或行首」（单词后缀仍认），`AUTH_SCHEME` 容忍 JSON 引号。
  实测 15 种形态全部脱敏且保持幂等。
- **回归测试**：`tests/logger-security.test.js` 的 leaks 列表补上这 10 种形态（含幂等断言）。修复前失败。

### 变更说明（证据，不是猜测）
#### 用**真实 dsh** 复验了「本机连接」这条路（此前几轮只能对着假 dsh 验证）
- 起了一个**隔离**的真实 dsh（`DSH_HOME=/tmp/… dsh web --port 4393 --no-open`，用完即杀）：
  · stdout 行就是 `dsh web: http://127.0.0.1:4393/?token=<43 字符>` —— hwb 的 `captureDshToken`
    对这条真实行的解析实测得到 `?token=…` 片段，`localWebUrl()` 拼出的入口可直接打开；
  · `--no-open` 被当前 dsh 接受（此前只有「旧版不认 → 摘掉重试」的兼容路径被测过）；
  · 裸 URL → **401**，`probeAlive()` 判不可用（`httpProbe()` 判可用，两种口径如文档所述）；
  · `authFetch(带 token 的入口)` → **200**，拿到 24 KB 的真实 dsh 页面（token→cookie 交接成立）。
- 顺带用真实 home 复核了两个域的读取假设：`workspace.json`（`unit.version 2`、
  `global.{initialized,workspaceIds,archivedSessionIds}`、`tables.workspaces[id].{path,title,sessionIds,createdAt,updatedAt}`）
  与 `model-tier.json`（`schema 2`、`activeId`、`schemes[].tiers`）都与 hwb 的解析器逐字段吻合。

### 变更说明（证据，不是猜测）
#### 新代码 vs 正在跑的旧服务：同一份真实数据的对照（会话数、用量都对得上）
- 让**新代码**在一份隔离的临时库上索引同一个真实 home（`--home ~/.dsh`，只读），与正在 4310 上
  服务的**旧代码**对照：
  · 新代码：`~/.dsh` **179** 个会话，`totalTokens = 1,495,872,360`，`degraded: []`。
  · 旧服务：同一个 home 显示 **500** 个会话。差异**不是**回归 —— 逐 sessionId 比对确认：
    两者的 179 个**完全一致**，另外 **321 个只存在于库里、projcache 文件里根本没有**，
    也就是**只由实时通道支撑的行**（正在跑的 dsh 的 `/api/session/list` 报了 500 条）。
    这正是本轮 `liveOnly` 那套机制存在的理由。
- 对用户的实际含义（说明白，免得重启后觉得「少了一截」或「少了又回来」）：
  · **重启后仍然是 500 条**（179 条文件索引 + 321 条实时补插），与现在看到的一致；
  · 但 dsh 停止后，那 321 条会被清掉（它们只由实时通道支撑），下次 dsh 一跑又回来 ——
    这是有意的：旧代码把它们当普通行留着，于是「dsh 早就关了，工作台还挂着那些会话」。
  · 用量口径一致：新代码 179 条文件会话的合计与旧服务同一批会话的合计相同（差异全部来自那 321 条
    实时行是否计入）。

#### 在**用户真实库的副本**上验证了今晚的全部 schema 迁移（uv 0 → 2 + 新索引）
- 做法：把 `~/.hwb/hwb.db` **复制**到 `/tmp` 后用新代码打开（源库只读、不动），前后各用**裸 SQL**
  取独立预言机比对。真实数据形态：553 会话 / 5 实例 / 24 MB 级库，`user_version = 0`、
  **四个派生列一个都没有**（也就是说这台机器上的服务还是今晚之前的代码）。
- 结果（实测）：
  · 迁移：`user_version 0 → 2`；四个派生列补齐；`idx_sessions_home_ws` 建好；**耗时 3ms**。
  · 数字正确：派生列求和 **3,937,139,946** == 用 `json_extract` 直接算的预言机 **3,937,139,946**；
    `usageSummary({days:3650}).totalTokens` 也是同一个数。
  · 没有丢数据：迁移前后 `sessions` 553 / `homes` 5 不变。
  · 读路径全通：`recentProjects` 20 个项目（1ms）、`recentSessions` 20 条、`listHomes` 5 个实例。
- 结论：这个库重启后会自动完成迁移与新索引，历史用量分毫不差；用户不需要任何手工动作。
- **收尾前又用当时最新的代码复验了一遍**（此时已过了 20+ 个后续提交，包括 liveOnly 的保留策略与
  「只写变化行」的写入路径改动）：`user_version 0 → 2`、`idx_sessions_home_ws` 建好、553 会话不变、
  派生列求和 == `json_extract` 预言机 = **4,050,119,733**（比首次复核涨了，因为那台服务一直在跑）；
  用新代码重新索引真实的 `~/.dsh` 得到 **179** 个会话、`liveOnly = 0`、无 degraded 域 ——
  与改动前的行为完全一致，也就是说后面那些写入路径的优化没有改变文件索引的结果。

### 变更说明（证据，不是猜测）
#### projcache 的版本支持从「只认 3」放宽到「3/4/5」——否则新版 dsh 写过的 home 会被判降级
- **证据**：dsh 自己的域声明是
  `projectionCacheDomainSpec = { name: 'session_projcache', version: 5, compatibleVersions: [3, 4],
  layout: 'per-record', tables: { sessions: checkpointRecord } }`
  （`dsh-session-projection-cache/lib/index.js:86-90`），即 **dsh 自己就认为 3/4/5 都可读**；
  而记录形状在三个版本之间**对 hwb 用到的字段完全一致**：
  `{ identity: { createdAt, cwd? }, rows: { <key>: { ver, seq, val } } }`
  （同包 `lib/types/spec.d.ts:40-66`），4/5 只多了可选的 lineage 字段
  （`isSeeded` / `inheritedEventCount`），而 hwb 只读 `identity.cwd` / `identity.createdAt` / `rows[*].val`。
- **风险**：hwb 原先只认 3。一旦某个 home 的文件被新版 dsh 标成 4 或 5，hwb 会把该域判 `degraded`、
  **整块停止更新** —— 与「dsh 升级后实例看起来空了」同一类，只是这次不是版本未知，而是我们没列出来。
  （本机实测：当前用户 home 的 `session_projcache.json` 仍是 `version: 3`，但声明里的当前版本已是 5。）
- **修复**：`SUPPORTED_VERSIONS` 从「单一版本」改成「允许清单」：`projcache: [3,4,5]`、
  `workspace: [2]`（dsh-workspace 当前写 2，实测一致）、`modelTier: [2]`；
  错误信息里把清单连起来展示（`supported: 3/4/5`）。
- **回归测试**：`tests/schema.test.js` —— 3/4/5 都必须被接受且解析出同样的字段（含 4/5 才有的可选
  lineage 字段），0/1/2/6/99 必须拒绝。修复前失败。

### 变更说明（证据，不是猜测）
#### 实时 `/api/session/list` 的投影形状
#### 实时 `/api/session/list` 的投影形状：用 **dsh 自己的类型声明**定案（此前几轮一直写着「无法确定」）
- 前几轮的注释与审查都停在「`projections.values.*` 到底是解开值还是 `{ver,seq,val}` 包装，本项目
  没有可对照的 live dsh，无法确定」。这一轮直接读了本机安装的 dsh（`~/.nvm/.../node_modules/
  @deepseek-ai/dsh`）的类型声明，逐条落实：
  · item = `SessionSummary`：`sessionId`（branded string）、`updatedAt`、**`running: boolean`（恒为布尔）**、
    `blank`、`cwd?`、`projections?: SessionProjectionHints`
    —— `dsh-api-session-controller/lib/types/types.d.ts:138`。
  · `SessionProjectionHints = { values: SessionProjectionValues }`（同文件 :40-59）。
  · `values` 里是**投影值本身**、没有包装：`tokenUsage` = `TokenUsageProjection`（**扁平四键**，
    `dsh-token-meter/lib/types/projection.d.ts:10`）、`sessionListMetadata = {blank,lastPromptAt}`、
    `goal`/`plan`/`sessionStats`/`permissions`/`todos`/`title` 各自的原生形状。
  · 包装 `(sessionId, key, ver, seq, val)` 是**文件侧**的 durable 行：
    `dsh-session-projection/lib/types/index.d.ts:199`。
- 结论：hwb 原来的判断是对的（实时=解开、文件=包装）；`tokenUsage` 三形态兼容是兼容余量，
  不是「不知道形状」。`running` 恒为布尔也证实了 `typeof item.running === 'boolean'` 那条分支足够。
- 代码动作：把 `live-status.js` 里两处「无法确定」的注释换成带包路径与行号的权威说明；
  把上一轮加的 `unwrapProjection` **收窄**成「只有确实长得像包装（除 `val` 外只剩 `ver`/`seq`）才解」
  —— dsh 允许插件贡献任意 JSON 键，一个恰好带 `val` 字段的投影值不该被吃掉一层（有回归测试）。

### Fixed
#### 实时投影只接受「解开形态」：包装形态会把「已完成」判成「空闲」（src/dshhome/live-status.js）
- **风险（审查标记为最值得跟进的 UNVERIFIED）**：文件侧的投影值形状是**带版本包装**的
  `{ver,seq,val}`，而 `/api/session/list` 的 `projections.values.*` 究竟是哪一层，本项目没有
  可对照的实例可以确定（`normalizeLiveTokenUsage` 的注释自陈过这一点，所以 tokenUsage 三种形态都接受）。
  其余字段（goal / todos / plan / subagent / permissions / sessionListMetadata / title）当时只接受
  **解开形态** —— 若实际是包装形态，实时通道会把 goal.phase=complete 读不到 → 系统性把「已完成」
  降级成「空闲」、丢掉 in_progress todo，而且每 3s 重写一次、宽限期内赢过文件侧的正确值
  （与「实时 approval 绕过守卫」同一类不自愈缺陷）。
- **修复**：`unwrapProjection()` 统一解一层（对象且有 `val` 才解），逐字段应用；
  已经解开形态的载荷不受影响（测试里有对照组）。
- **回归测试**：`tests/live-status.test.js` —— 包装形态下 goal/todos/subagent/approval/title/
  lastPromptAt 都必须被正确识别。修复前失败。

#### 凭据里的 YAML 引号被当成 key 的一部分（src/lib/balance.js）
- **现象**：`deepseek_API_KEY: "sk-x"` 是完全合法的 YAML，但原实现只 trim 空白，
  于是把引号一起发出去 → 上游 401 → UI 显示「凭证被拒绝（401/403）」，用户以为自己的 key 失效
  （审查提出的 nit，但症状是误导性的）。
- **修复**：`yamlScalar()` 按 YAML 规则取值（配对引号去掉；普通标量里由**空白**引出的 `#` 之后是注释，
  紧跟内容的 `#` 属于值本身）。
- **回归测试**：`tests/quota.test.js`（双引号/单引号/行尾注释/值内 `#` 四种写法）。修复前失败。

### Fixed
#### 日志权限收紧漏了轮转代与「已存在的目录」（src/lib/logger.js）
- **现象（审查实测）**：先造出升级前的遗留状态（目录 0755、live/.1/.2 全 0644，`.1` 里有
  `?token=OLDTOKEN1`），再让日志轮转一次 —— 结果是 `live=0600`、**`.1=0600`、`.2 仍是 0644**，
  且 `.2` 里那份旧 token 仍对同机其它用户可读；目录也仍是 0755（能被遍历，
  等于泄露 `config.json` / `hwb.db` 的存在与名字）。
- **根因**：`mkdirSync(..., { mode: 0o700 })` 只对**新建**目录生效；权限收紧只作用于活文件的 fd
  （`fchmodSync`），被轮转到 `.2` 的那一代没人管。
- **修复**：`openFile()` 里显式 `chmodSync(dir, 0o700)`（沿用 `src/service.js` 的共享目录白名单：
  HWB_DIR 指向 `/`、`$HOME`、`os.tmpdir()` 时**不**动权限），并对 `.1`/`.2` 各 `chmodSync(0o600)`。
- **回归测试**：`tests/logger-security.test.js` —— 预置 0755 目录 + 三个 0644 文件（含旧 token），
  初始化后必须全部收紧到 0700/0600 且内容不变。修复前失败。

#### 上传被 kill -9 后在用户项目目录里留下永久暂存目录（src/lib/file-preview.js）
- **现象（审查实测）**：上传中途 `kill -9` → 项目目录里留下 `.hwb-upload-Zoj1DL/part`（32 MB），
  谁都不会清（`commit` 的 finally 只覆盖本进程内的失败路径，SIGKILL 不可捕获），
  而且它会出现在文件列表里 —— 用户看到一个叫 `part` 的目录，无从判断。
- **修复**：`sweepStaleStaging()` —— 构造上传器时扫同目录的 `.hwb-upload-*`，删掉 mtime 早于
  1 小时的（正常上传 ≤256 MiB 不可能写这么久，所以正在写的不会被误删）。
- **回归测试**：`tests/file-upload.test.js`（陈旧目录必须消失、正在写的必须留下）。修复前失败。

### Fixed
#### 降级窗口里「已不在实时列表」的会话永远挂着「运行中」（src/dshhome/store.js）
- **现象（审查实测）**：dsh 升级到 hwb 还不认识的 `unit.version` 时（代码自己写着这是「必然情形」），
  projcache 域降级、sessions 表的整表替换被跳过。此时在 dsh 里关掉一个会话 →
  它**永远**停在最后一次实时写入的「运行中」上。实测：又跑了 3 轮轮询 + 3 轮文件索引仍是 running；
  而 projcache 一恢复就立刻自愈 —— 窗口 = 直到 hwb 支持新版本（天到周）。
- **根因**：清状态的分支只在「实时列表**为空**」时执行，而只要 dsh 里还有任意一条会话活着列表就非空；
  从列表里消失的 file-backed 行既不会被幽灵清理删掉（那只删 `liveOnly=1`），也刷不动。
- **修复**：把「不在本次实时列表 ⇒ 清 status」推广到「sessions 域降级」的情形（清徽标、不删行，
  UI 退回「空闲」，等域恢复后由文件索引覆盖）。未降级时**不清** —— 那种窗口由下一轮文件索引负责纠正。
- **回归测试**：`tests/live-status-restore.test.js`（降级窗口必须清成 NULL、未降级仍由文件索引决定）。
  修复前失败。（写这条测试时踩过一次假绿：只加 degraded 标记而不把快照的 sessions 置空，
  索引会照常写文件值 —— 真实读取路径的产出形态是「置空 + 标记」两者都有。）

#### 实时 RPC 响应没有大小上限（src/dshhome/live-status.js）
- **现象（审查实测）**：文件侧有 64 MiB（read-home）与 32 MiB（remote-reader）的上限，实时通道却
  `res.json()` 照单全收。假 dsh 分块推送 200 MiB → 客户端 **RSS +844 MiB**、耗时 195ms，
  而且那个 200 MiB 的「标题」会原样落进 `sessions.title` 并发给浏览器。只受 4s 超时约束，
  在环回/高速隧道上等价于无上限；这条通道同样服务**远程**实例（对面可以是外来的 dsh）。
- **修复**：`readJsonBounded()` —— content-length 预检 + 流式字节计数 + 超限 `reader.cancel()`，
  默认 32 MiB（与文件侧同量级），构造函数可注入（`maxResponseBytes`）以便测试。
- **回归测试**：`tests/live-status.test.js`（声明超限、流式超限且必须 cancel、正常响应照旧）。
  修复前失败。

### Fixed
#### 未来的 lastActivity 会关掉「运行中」的陈旧闸门（src/lib/status.js）
- **现象**：`openStep` 还在、`lastActivity` 却是**未来**时刻的会话被判成「运行中」并永久挂着。
  实测（审查）：未来 6 小时 → running；写成公元 33658 年 → running；真实 projcache 连跑 3 遍索引仍是 running。
- **根因**：`isStale()` 的判据是 `Date.now() - at > RUNNING_STALE_MS`，而未来时刻的差值是**负数**，
  对负数恒为 false —— 闸门被整个关掉。而这条闸门正是为修「179 个会话里 18 个被永久标成运行中」
  而写的，而 CHANGELOG 里也记录过「远端实例时钟偏一点就会产生未来时间戳」的实测。
- **修复**：`age < 0 || age > RUNNING_STALE_MS`。本机时钟无法判断「未来的时刻有多新」，
  按本项目一贯的取舍降级 idle —— 真正在跑的实例另有实时通道（3s 轮询）覆盖状态。
  `lastActivity` 缺失/不可解析时不判断这条既有的取舍保持不变（测试锁定）。
- **回归测试**：`tests/status.test.js`（未来 6 小时 / 公元 33658 年 → idle；新鲜的 1 分钟前仍 running）。
  修复前失败。

#### 实时通道的 `permissions.approval` 绕过了守卫，而且赢过文件侧（src/dshhome/live-status.js）
- **现象**：对象形态的 approval 直接落库，界面显示「审批 [object Object]」；30 万字符的字符串会把
  `sessions.status` 这一列撑到 300KB 并每 3s 重写一次。而且实时值在宽限期内**赢过**文件侧被守卫过的值
  （审查实测 1→5 步：文件侧是 `"never"`，实时轮询一来就变回对象，且每次轮询重新赢，不自愈）。
- **根因**：`lib/status.js` 的 `normalizeApproval`（只留字符串、截断 64）是模块私有的，
  实时通道 `toLiveRow` 直接取 `values.permissions?.approval ?? null`。
- **修复**：导出 `normalizeApproval` 并在 `toLiveRow` 里使用。
- **回归测试**：`tests/live-status.test.js`（对象 → null、30 万字符 → 65 字符、正常字符串不变）。修复前失败。

#### 实时写入失败只记 debug，日志里只剩「同步成功」（src/dshhome/live-poller.js + live-status.js）
- **现象（审查实测）**：一行脏数据（`sessionId` 是 `true`/`{}`/`[]`）让**整批** upsert 抛
  `Provided value cannot be bound to SQLite parameter 2`，committed rows = 0 ——
  而失败记在 **debug** 上，默认 level（info）根本看不到：日志环里只有「实时会话同步成功」，
  库里一行都没写，界面继续显示上一轮的**错**状态，home 也不 degraded。
- **根因**：`toLiveRow` 是唯一没做类型校验的绑定点（文件侧的 sessionId 来自 JSON 对象键，必为字符串）；
  轮询器的 catch 用 `log.debug`；而 live-status 的 INFO「同步成功」只描述**读取**成功。
- **修复**：①`toLiveRow` 只接受非空**字符串** sessionId（数字虽能被 TEXT affinity 写进去，也不是 id）；
  ②轮询器写失败改 `log.warn`，并按「同 home 同原因」去重（成功即复位），避免每 3s 刷一条；
  ③把那句 INFO 改成「实时会话读取成功（写入由轮询器负责，失败会单独记 warn）」——原先它在写失败时是假的。
- **回归测试**：`tests/live-poller.test.js`（写失败必须留下 **warn** 且同因只一条）。修复前失败。

### Fixed
#### 切维度后趋势图标签又互相压字（src/web/app.js）
- **现象（真浏览器实测）**：点「30 天」标签是好的；再点「按项目」，两个标签叠在一起
  （`09-04 20:00|09-05 20:00` 重叠）。同一个图表、两条渲染路径两种表现。
- **根因**：趋势图有两条渲染路径 —— 周期切换（`refreshUsageCard`，整卡重绘）与切维度
  （`renderUsageTrend`，纯本地重绘）。上一轮把 `fitTrendLabels` 挂在了前者与 dashboard 渲染上，
  漏了后者。
- **修复**：收敛成 `renderTrendInto(el)`（写 innerHTML + 拟合），两条路径都走它；
  源码级测试同时禁止再出现绕过它的 `innerHTML = usageTrendHtml(...)`。
- **回归测试**：`tests/web-render-safety.test.js` 新增一致性断言；
  `scripts/render-check-dim-switch.js` 用真浏览器量两条路径（修复前「切维度后」失败）。

### Fixed
#### `verifyProcess` 的「安全默认」没人守（src/control/guard.js）
- 审查用变异证明过：把它的 `catch { return false }` 改成 `catch { return true }`（也就是**ps 不可用时
  反而当作「进程已验证」**）套件照样全绿 —— 因为原测试只断言「返回布尔」，而它在受限环境里恒为 false。
- 修复：给 `verifyProcess(pid, opts, run = pExecFile)` 加注入点，于是两个分支都能验证：
  ①ps 不可用（EACCES/沙箱禁止 spawn）必须 **false**（安全默认不能反）；②ps 正常但查不到该 pid → false；
  ③命令签名匹配 → true、不匹配 → false（ssh 签名不该匹配 dsh web 进程）；④非法 pid 直接 false。
- **回归测试**：`tests/helpers-untested.test.js`（4 组断言）；变异验证：把 catch 改成 `return true` 立刻红。

### Fixed
#### 一个长期不可达的远端会把日志刷成噪音（真实日志里占了大头）（src/dshhome/indexer.js + remote-reader.js）
- **现象（用户真实日志实测）**：`~/.hwb/hwb.log` 16,334 行里约 **700 次**
  `读取远程 dsh home 元数据失败` + 700 次 `索引该 home 失败(bot@cms.lo)`，每次都带**一整套 async 栈帧**
  （约 10 行/次 ⇒ 约 7,000 行），另有 `code=255` / `Connection closed` 的重复上下文。
  这台机器上的远端 `bot@cms.lo` 长期连不上，于是每一轮索引都重新记一遍**同一件事**。
- **修复**：同一实例（同一 host）的**同一失败原因**只在首次记全（含栈），之后 10 分钟内静默；
  窗口过后记一条摘要行；**原因变化或成功一次即复位**（`remote-reader` 与 `indexer` 两处都做，
  因为噪音是这两个调用点各记一条）。
- **回归测试**：`tests/indexer.test.js` —— 连跑 5 轮同样的失败，两处日志各只允许 1 条。
  （写这条时又抓到一次自己的空洞断言：第一版只匹配「索引该 home 失败」这一种文案，
  于是抑制被去掉后 5 条都变成「仍然失败…」而断言照样通过；现在两种形态都算。）

### Fixed
#### 自查又发现两处「本轮改动自己引入的过度行为」（都已修）
- **日志目录 chmod 会碰当前目录及其祖先**：为把状态目录收到 0700，我在 `openFile()` 里加了
  `chmodSync(dir, 0o700)`。但日志路径可以是**相对**的（`--log hwb.log`、`hwb config set log x`），
  那样 `path.dirname()` 就是 `.` 或 `..` —— 无条件 chmod 会把用户的工作目录（甚至家的上一级）
  改成 0700，比它想防的「目录可被遍历」严重得多。现在排除「解析后的目录 == cwd 或 cwd 的祖先」，
  日志**文件**本身的 0600 不受影响（回归测试：相对路径下目录权限不变、文件仍 0600）。
- **暂存目录清理只按名字匹配**：`sweepStaleStaging` 会删掉目标目录里名字匹配 `.hwb-upload-*`
  且 mtime 超过 1 小时的东西 —— 用户完全可能**自己**有一个这么命名的目录（而且放了很久），
  无条件删就是删他的数据。现在额外要求它**结构**上是我们的暂存目录（里面只有 `part`）。
  回归测试加了「名字像但不是我们建的目录必须留下」。

### Fixed
#### `stop()` 的返回值自相矛盾：一次成功的停止反而回 false（src/control/launcher.js）
- 返回值原先算的是 `fingerprint(inst.proc)`，即「子进程**是否还活着**」—— 而它在 kill 之后**永远**是
  false：于是「成功停掉」与「本来没有可停的」两种情况都回 false，谁读这个字段都会被误导
  （`/api/homes/{id}/stop` 响应里的 `stopped` 就是它；前端目前不读，但字段不该自相矛盾）。
- 修复：改成「这次确实停掉了一个受管子进程」⇒ true；直连已有实例（adopted-local，没有子进程）或
  它早就退出了 ⇒ false。README 的 API 表同步写明这个字段的含义。
- **回归测试**：`tests/launcher-terminate.test.js` —— 受管进程停掉后必须 true、adopted-local 必须 false。
  修复前后者为 false、前者也是 false（断言会红）。

### Fixed
#### 实时轮询每轮每实例多读一次实例（src/dshhome/live-poller.js）
- 相邻两行各调一次 `store.getHome(homeId)`：`if (!… || !this.store.getHome(homeId)) return;` 紧接着
  `if (this.store.getHome(homeId).activeEndpointId !== …) return;`。两行之间**没有 await**（getHome 是
  同步的），所以第二次读到的必然是同一个值 —— 纯多余。规模审查实测：单个 400k 会话的 home 上
  `getHome` 要 **32.6ms**，而这个函数**每轮每实例**都会跑。
- 修复：合并成一次点查。等价性是显然的（同一个 tick 内的同步调用之间不可能有写入）。
- **回归测试**：`tests/live-poller.test.js` —— 一次 refresh 只允许点查一次（用计数桩）。修复前失败。

### Fixed
#### 文件索引每 60s 把「纯实时行」删掉一次，几秒后再补插回来（真实数据上每分钟 321 行）
- **来源**：本轮用真实数据对照时发现的 —— 用户那台机器的 dsh 实时列表有 **500** 条会话，
  而 projcache 文件里只有 **179** 条（逐 sessionId 比对确认：179 条两边都有，另外 **321 条只在库里、
  文件里没有**，即只由实时通道支撑）。文件索引的「整表替换」会把这 321 行一起删掉，
  3s 后轮询器再补插回来：每分钟一次无谓的删除 + 重插，而且**中间那几秒工作台会少显示它们**。
- **修复**：sessions 的替换只作用于**文件快照该管的那部分**（`WHERE homeId = ? AND liveOnly = 0`），
  **但仅当实时通道还活着**（`Date.now() - liveStatusAt(homeId) < LIVE_GRACE_MS`，与状态保护同一个判据）。
  纯实时行的生命周期仍归 `applyLiveStatus`：不在实时列表里就删、被文件索引收录后由已有的
  `ON CONFLICT` 分支把 `liveOnly` 归零。
  「仅当通道还活着」这半句是**自查时补上的**：第一版无条件保护，于是「曾经连上、后来再没连上」的实例
  会把这些行永远留着 —— 它们带着最后一次实时写入的状态，可能一直显示「运行中」，正是本项目修过的
  那类幽灵徽标。现在通道停写超过宽限期后，下一次文件索引就把它们收回去。
- **回归测试**：`tests/live-empty-clear.test.js` —— ①通道活着时文件索引不删纯实时行；
  ②「实时列表变空 ⇒ 纯实时行必须被清掉」这条原有语义没被改坏；③**通道停写后必须被收回**。
  ①②在修复前失败、③在「无条件保护」的版本上失败。

### Fixed
#### SSE 触顶拒绝原先一声不响（规模审查指出）
- **现象**：客户端数达到上限（32）时，第 33 个连接收到 503，但服务端**日志里没有任何痕迹** ——
  客户端只显示 `reconnecting…`，而「谁的标签页被饿死了、是哪个脚本在刷」在运维侧无法判断。
- **修复**：首次触顶记一条 `warn`（含上限值与时间），并按 60s 节流 —— 节流正是为了不让那个
  跑飞的脚本把日志刷爆（它才是要防的对象）。
- **回归测试**：`tests/sse.test.js` —— 连开 3 个超限连接，断言恰好记一条 warn（并对照 503 与既有连接不受影响）。修复前失败。

### Fixed
#### `service.log` 无界增长（规模审查实测：失败形态下约 490 MB/天）
- **实测（规模审查）**：200 个实例、实时通道都不可达时，`service.log` 以 **349 KB/min**
  （≈21 MiB/h ≈ **490 MB/天**）增长 —— 它是子进程 stdout/stderr 的重定向目标，**唯一不进轮转**的日志
  （`hwb.log` 自己有 `rotateBytes`/`KEEP_ROTATED`，达到 1 MiB 就换）。健康状态其实很安静
  （8 分钟完整运行只写了 5,283 B），所以这是一条「只有出问题时才暴露」的写满磁盘路径。
- **修复**：`hwb start` 之前做一次上限控制 —— 超过 8 MiB 就把 `service.log` 轮转成 `.1`（`.1`→`.2`，
  丢弃更老的）。**边界写明白**：这不是「运行中按大小实时轮转」（那需要子进程自己管理 stdout，
  父进程退出后已不持有 fd），所以一个长期运行且持续大量输出的服务仍会增长；这条修复保证的是
  「重启即回收」，把无界增长变成有界增长。
- **回归测试**：`tests/cli.test.js` —— 预置 9 MiB 的 `service.log`（带可辨认头部），`hwb start` 后断言
  旧内容进了 `.1`、新日志很小。修复前失败。

### Fixed
#### 大库上 `recentProjects` 会让整个服务停几十秒：缺一个索引（规模审查实测）
- **实测（400k 会话 / 50k workspace）**：`recentProjects(7d,20)` 单独查询就要 **44,311ms**，
  其中「孤立 workspace」那一半 **35,340ms 却只产出 0 行**；HTTP 并发探针测到**整个服务停顿 9,758ms**
  （平时 p50 0.3ms）。而这两条路由**没有任何 memo**，前端每次 SSE `index:updated`（有实例在跑时每 3s）都会调它。
- **根因**：`sessions` 上只有 `idx_sessions_home(homeId)`，孤立 workspace 那一半只能 `SCAN workspaces`
  逐行关联（EXPLAIN 实测：BLOOM FILTER + 3× 相关标量子查询 + TEMP B-TREE FOR ORDER BY）。
- **修复**：SCHEMA 增加 `idx_sessions_home_ws ON sessions(homeId, workspaceId)`（新库一建就有；
  既有库在下一次打开时由 `CREATE INDEX IF NOT EXISTS` 自动补上）。实测：那一半 **35,340ms → 43ms**，
  整个查询 **44,311ms → 1,224ms**；测试规模的对照（20k/4k）368ms → 6ms。
- **回归测试**：`tests/store.test.js` —— **自校准 A/B**：同一份数据先量（带索引）再 `DROP INDEX` 量，
  断言去掉索引后至少慢 3 倍，且两次结果一致。不用绝对时间阈值（那在慢机器上会变假失败）。
  实测修复前该用例失败。

### Fixed
#### 测试网上的洞：7 条**存在但没人守**的守卫 + 1 条假失败（测试质量审查，全部按变异验证）
- 审查方式是「把守卫改坏，看套件会不会红」。以下每一条改坏之后**整个套件仍然全绿**（610/609/0），
  也就是说它们在生产里坏了也没人知道 —— 每一条都补了会红的回归测试（并把变异重跑一遍确认）：
  1. **`live-poller` 的端点守卫**（`live-poller.js:74`）：抓取期间用户切了连接端点，那份快照属于**旧端点**，
     写下去就是把 B 实例的状态记在 A 名下（无日志、无降级标记）。现在有测试断言 `applyLiveStatus` 一次都不许调用。
  2. **`indexer` 的两条实时新鲜度守卫**（`indexer.js:154/156`）：抓取期间轮询器写了更新的数据、
     或端点被切换 ⇒ 必须丢弃这份 live，否则索引器用更旧的快照把新状态覆盖回去（实测过「运行中 → 空闲」倒退）。
  3. **路由处理器抛错必须回 500**（`server.js:120-125`）：改成「吞掉 + 回 200」套件全绿 ——
     任何路由回归都会变成静默的空响应，前端错误分支永不触发。现在断言 500 + 响应里带真错误 + 日志有「API 请求处理失败」。
  4. **`store.markHomeError` 必须吞掉自身失败**（`store.js:548-550`）：它由 Indexer 的 catch 调用，
     再抛就会**中断整轮索引**里剩下的所有实例。原来套件里只有 hostile-env 注入的**桩**，
     真方法从没被失败路径调用过；现在直接关库再调它，断言不抛。
  5. **两条源码级断言其实挡不住它们声称的性质**：`renderTrendInto` 的「先写 innerHTML 再拟合」**顺序**
     与 `lastUsageKey` 的**位置**（必须在序号/周期校验之后）。两条都改成顺序敏感的正则，
     并实测「调换顺序 / 上移一行」现在会红。
  6. **`openTunnel` 的真实 argv 从没被测过**（launcher 测试全注入 tunnelFactory）：
     `-L` 的远端端口改成 9999、私有 ssh 配置快照 0600 改成 0644，两者套件都全绿。
     现在用 PATH 上的假 ssh + 读子进程 `spawnargs`，断言 `-L 127.0.0.1:<local>:127.0.0.1:<远端>` 与 0600。
- **同时修掉一条假失败**：`merged-index: 单个实例卡住时按超时隔离` 在 4 份套件并发跑时 1/4 次误报
  （健康夹具自身也是个要启动的进程，CPU 争抢下超过 800ms 就被判「采集超时」）。超时放宽到 2500ms、
  慢实例 sleep 5→12s、elapse 上限 4000→8000（判别力不变：隔离被回退时整轮要等满 12s）。
  单独跑 12 次 0 失败、8 个 CPU 占满也不失败 —— 只有并发套件时才现。
- 审查同时确认：**最近 9 个带源码改动的提交，其回归测试都真的会红**（16 次定向变异，全部被捕获）。
- 另外两条「断言写成了实现细节」的也顺手收紧（都属于审查点出的第 8 类）：
  `sshProbe` 原先只断言 `typeof === 'boolean'`（把 `catch { return true }` 注进去照样绿），
  现在断言连不上的主机必须是 `false`；workspace 菜单原先用 `match(/hwb-finder/)` ——
  而它是 `hwb:open-workspace-finder` 的子串，菜单项 id 被改成 `hwb-finder-typo`（点了没反应）
  照样绿；现在把「菜单项 id」与「handler 判断的 id」各自取出来做**逐字对比**。两条都重跑了变异。

### Fixed
#### 陈旧的 `service.port` 会让 `hwb stop` 报一个与 hwb 无关的占用错误（src/cli.js）
- **来源**：本轮自己复查上一条修复时发现的 —— 记录端口是**线索**，但 `stop` 把它与配置端口
  一视同仁地当成「用户打算给 hwb 用的端口」：前台 serve 退出后留下的陈旧记录文件，配上之后
  某个无关程序恰好占用那个端口，就会报「端口 X 被其它程序占用（不是 hwb）」而 X 与当前服务无关。
- **修复**：把两个端口分开用 —— 记录端口只用来找「hwb 自己」（`hwbOnPort`），
  「被其它程序占用」只对**配置端口**报；两种成功停止的路径都会清掉端口记录文件。
- **回归测试**：`tests/cli.test.js` —— 记录端口指向无关监听者时必须照常报「已停止」并清掉记录；
  配置端口被占用时仍必须明确报错（对照组）。修复前失败。

### Fixed
#### 前台 `hwb serve --port` 用了非配置端口时，`stop`/`status`/`doctor` 全部谎报（src/cli.js）
- **现象（审查端到端复现）**：配置端口 4378、`hwb serve --port 4399` 时 ——
  `hwb status` 打印 `stopped` 并以退出码 1 结束，`hwb stop` 打印「已停止」退出 0，
  而 4399 上的服务照常返回 200；紧接着 `hwb start` 会再起一个后台服务，
  **两个 hwb 进程共用同一个 `hwb.db` 与同一个 `hwb.log`**（`lsof` 可见两个 FD 指向同一文件）。
- **根因**：三个命令只探测**配置里**的端口，而 `server.js` 的解析顺序是「命令行 `--port` 覆盖配置」，
  CLI 的 help 也明确支持 `hwb serve [服务器选项]`。
- **修复**：前台 serve 启动前把**生效端口**写进 `<HWB_DIR>/service.port`（退出时删掉，后台 `start` 也写），
  `stop`/`status`/`doctor` 按「记录端口 → 配置端口」的顺序探测。端口文件只是线索：
  读它的地方仍用 `hwbOnPort()` 确认对面确实是 hwb，所以 kill -9 留下的陈旧文件不会造成误报。
- **回归测试**：`tests/cli.test.js` —— 真起一个 `serve --port <非配置端口>`，断言 `status` 报 running、
  `stop` 必须提示「前台运行/Ctrl-C」且服务仍在服务。修复前该用例失败。

#### 启动失败的诊断把整份 `service.log` 读进内存（src/cli.js）
- **现象（审查实测）**：`service.log` 是子进程 stdout/stderr 的重定向目标，append-only 且从不轮转，
  长到 433 MB 时 `hwb start` 的失败路径阻塞 **1.80s**、峰值 RSS **1.98 GB**（≈文件大小的 4.5 倍）
  —— 恰恰是最需要给出诊断的那条路径。
- **根因**：`failureDetail()` 用 `fs.readFileSync` 整份读取再 split/遍历。
- **修复**：只读尾部 64 KiB（`open`+`fstat`+`readSync`，被截断的首行丢掉）。
  语义不变：要的本来就是「**最后**一个 `hwb:` 提示块」。
- **回归测试**：`tests/cli.test.js` —— 100 MB 的日志 + `--max-old-space-size=128`（整份读会 OOM），
  断言仍能给出**本次**的真实原因，且日志开头那个陈旧提示块没有被当成原因。修复前该用例失败。

#### `hwb upgrade` 期间并发的 `hwb stop` 会被静默撤销（src/cli.js）
- **现象（审查端到端复现）**：`upgrade` 跑着（`git pull` + 整套测试，几十秒），用户执行 `hwb stop`
  成功并退出 0，升级结束后**服务又被拉起来了** —— 两条命令谁都不报冲突，用户的明确意图被静默撤销。
- **根因**：`upgrade` 不在取启停锁的命令列表里（于是 `touchLock()` 也是死代码、
  `LOCK_STALE_MS` 注释里「upgrade 持锁跑长命令」的理由与事实相反），且最后**无条件**
  `node src/cli.js restart`。
- **修复**：①`upgrade` 纳入持锁列表（并发的启停命令会被明确拒绝，而不是成功后又被撤销）；
  ②重启前复核运行状态 —— 升级期间服务若已被停掉就不再拉起，并明确打印说明；
  ③重启改为**进程内** `stop()+start()`（spawn 子 CLI 会去抢同一把锁，必然失败）；
  ④把 `LOCK_STALE_MS` 的注释与事实对齐（现在 upgrade 真的持锁，`touchLock()` 真的在用）。
- **回归测试**：`tests/cli.test.js` —— 仓库副本（含当前工作树）+ 一个 6 秒的慢用例拉开窗口，
  升级进行中执行 `stop` 必须被明确拒绝。修复前该用例失败（`stop` 会成功打印「已停止」）。

### Fixed
#### 空闲的仪表盘也在每 10s 白跑 330ms 的同步聚合（src/dshhome/store.js + src/api/routes.js）
- **现象**：`/api/usage` 的 8 个同步 SQLite 聚合在 40k 会话下合计约 330ms，而 `node:sqlite` 没有
  异步接口 —— 这期间 HTTP/SSE/心跳全停。原先的服务端记忆只按**时间**（10s TTL）失效，于是
  一个**空闲**的仪表盘（没有实例在跑 ⇒ 没有实时写入）一个字节都没变，却仍然每 10s 白跑一次。
- **修复**：给 `IndexStore` 加数据版本（`dataVersion()`，`upsertRows` 与 `removeHome` 成功提交后自增），
  memo 改成两级判据 —— ①版本没变 ⇒ 缓存**永远有效**；②版本变了但还在 TTL 内 ⇒ 仍然复用
  （实例在跑、每 3s 都有实时写入时，聚合频率仍压在 1/10s，节流没有丢）。
  `createApiServer` 新增 `usageTtlMs`（默认 10s）以便测试这个语义。
- **实测（同一个 4 万会话的库，A/B 跑同一段脚本）**：`GET /api/usage?days=30&hours=24`
  · 冷缓存真跑 8 个聚合：55ms（新）/ 55ms（旧，本来就一样）
    —— **夹具要说清楚**：这个 55ms 是当时那个**简化夹具**（40k 会话、全部 idle、单一 project）。
    规模审查用更真实的形态（10 实例 / 偏斜的活跃度分布 / 多 project）测到的是 **148ms**：
    两者差的是夹具，不是代码回归。引用这个数字时请连夹具一起说。
  · TTL 内命中：1–2ms
  · **TTL 过后、数据一个字节没变**：旧实现 95ms（又跑了一遍聚合）/ 新实现 **4ms**（直接复用）
- **回归测试**：`tests/usage-memo.test.js` —— 用 40ms 的 TTL 把语义钉住：数据不变 + 超过 TTL
  仍复用（`usageSummary` 调用次数不增）、数据一变 + 超过 TTL 必须重算、版本变了但在 TTL 内仍节流、
  以及 `upsertRows`/`removeHome` 都会抬高版本。修复前两条用例都失败。

### Fixed
#### 移除/新增/改名实例后，用量图还会带着旧实例（服务端 10s + 客户端 15s 两层记忆）（src/api/routes.js + src/web/app.js）
- **现象**：删掉一个实例之后，「按实例」维度的用量图里仍然挂着它，最长十几秒才消失（用户视角
  就是「我已经移除它了，图上还在」）。改别名同理：图上还显示旧名字。
- **根因**：两层记忆都只按「周期」做键（服务端 `USAGE_TTL_MS = 10s`，客户端 `createUsageCache(15s)`，
  为的是把 8 个同步聚合的尖峰压下去），却不知道**实例集合变了** —— 缓存里那份 body 已经不成立。
- **修复**：服务端加 `dropUsageMemo()`，在会改变用量数据集的三条写路由里清空（新增/移除/更新实例）；
  客户端 `dropUsageCache()` 在 addHome / remove-home / saveSettings 之后调用，让下一次渲染强制拉取。
- **回归测试**：`tests/api-token-exposure.test.js` —— 两个实例都在图里 → DELETE 其中一个 →
  同一个 `/api/usage` 请求必须立刻只剩一个（修复前返回缓存里的旧 body，实测失败）。

### Fixed
#### 数据库被另一个进程占用时，给的是「改名或换路径」这条错误建议（src/dshhome/store.js）
- **现象**：两个 hwb 用同一个 `hwb.db`（或外部工具持着写锁）时，第二个进程立刻报
  `database is locked`，而包装后的消息只教用户「改名或换一个路径」—— 那等于让他把库换掉。
- **根因**：`constructor` 的 catch 对所有失败给同一段补救建议。SCHEMA 里的
  `CREATE TABLE IF NOT EXISTS` 也要拿写锁，所以「另一个进程在用」这种最常见的失败也走这条路。
  （审查也确认：这条路径与本次改动无关，是既有行为。）
- **修复**：按底层错误分类 —— `locked/busy` ⇒ 提示先确认有没有第二个 hwb 在跑（`hwb status`）、
  瞬时锁会自动消失；其余沿用「权限/磁盘问题、幂等重试」的原建议。
- **回归测试**：`tests/store-token-columns.test.js` —— 同进程内先 `BEGIN IMMEDIATE` 持写锁，
  再打开同一个库：消息必须含「另一个进程」且**不含**「改名或换一个路径」。修复前该用例失败。

### Fixed
#### 迁移版本闸门被当成「列里的数据是对的」的证据（src/dshhome/store.js）
- **现象（潜在，非 hwb 自己能造出）**：一个四列都在、`PRAGMA user_version = 1`、
  但四列**全是 0** 的库（外部工具改过、或从别处拷来的 `hwb.db`）会被直接放行 ——
  历史用量**永久显示 0**，正是这套迁移本来要消灭的症状。审查实测：同一个库 `uv=0` 时能自愈，
  `uv=1` 时不自愈（`usageSummary` 与 `json_extract` 预言机不再一致）。
- **根因**：闸门是 `missing.length === 0 && user_version >= 1`。`user_version` 只能证明
  「我们这一版代码写过这个库」，证明不了「列里的值与 `tokenUsage` 一致」。
  审查也确认了 hwb 自身的失败路径**造不出**这种库（`PRAGMA user_version` 会随事务回滚，
  版本只在回填成功之后、同一个事务里抬高），所以这是留给外部改动的隐患。
- **修复**：迁移版本抬到 2。所有既有库会**再跑一次幂等回填**（触发器与表达式都共用同一段 SQL；
  40k 行实测约 60ms，一次性），列里的脏值随之被纠正，之后不再重复。
- **回归测试**：`tests/store-token-columns.test.js` 新增「四列为 0 + uv=1 的库必须被回填纠正」
  （断言用量与触发器都恢复）。修复前该用例失败（`totalTokens` 停在 0）。

### Fixed
#### 用量卡的空状态是个死胡同：周期按钮在早退之后，用户永远放宽不了窗口（src/web/components/usage-card.js）
- **现象**：默认 24h 窗口内没有数据、更早有数据的用户，卡片只显示一句「暂无 token 用量数据
  （需先有被索引的活跃会话）」，页面上**一个周期按钮都没有** —— 唯一能放宽窗口的入口点不到。
  文案本身也是错的：同一个 API 换个窗口就有数据。
- **实测（独立审查·真浏览器）**：某实例（最新会话 6 天前）`#usage-card` 只有那句空状态，
  `document.querySelectorAll('#usage-period-toggle button').length === 0`；
  而 `/api/usage?days=30&hours=720` 返回 `sessionCount: 5`、3 个非空桶。
- **根因**：`renderUsageCard` 在 `summary.sessionCount === 0` 时直接 `return`，
  而 `periodToggleHtml` / `dimToggleHtml` 在早退**之后**那一段里。
- **修复**：空状态也渲染周期切换（与正常状态同一套 DOM 结构），文案改为
  「这个窗口（最近 N 天）内没有 token 用量数据。若更早用过 dsh，可切换到更长的周期查看。」
- **回归测试**：`tests/web-render-safety.test.js` —— 空窗口必须出现 24h/3天/7天/14天/30天 五个按钮；
  `renderUsageCard(null)` 也不能抛。修复前该用例失败。

#### 趋势图 x 轴标签与散点错位：标签等分、散点按时间（src/web/components/usage-card.js + src/web/index.html）
- **现象**：稀疏窗口下读者会把用量算到错的日子。24h 周期里唯一的数据点画在 15.8%，
  而它上方的标签写着「09:00」。
- **实测（独立审查·真浏览器）**：30 天周期、60 桶里 5 个非空 —— 标签中心在
  9.9 / 29.9 / 50.0 / 70.1 / 90.1%，对应散点却在 72.9 / 86.4 / 96.6 / 98.3 / 100.0%：
  所有数据都堆在「09-11 20:00」底下，而「09-03 20:00」的标签悬在空白上。
- **根因**：散点用 `pxAt(ts)`（按时间），标签用 `n` 个 `flex:1` 的等分单元格（按序号）——
  只有「每个桶都非空」时两者才重合。
- **修复**：标签改成绝对定位在 `pxAt(ts)%`（与散点同一个函数、同一个坐标系），贴边时改为向内对齐
  （`.trend-xlabel-left/right`）避免被裁掉；`.trend-xcell` 等分样式删除。
- **回归测试**：`tests/web-render-safety.test.js` —— 60 桶里只有末尾 5 个非空时，
  每个标签的 `left` 必须等于某个散点的 `left`，且第一个标签 > 90%（等分的老实现在 0%），
  同时断言等分单元格不再出现。修复前该用例失败。

#### 按维度拆分时给每个 0 值都画了一个散点（src/web/components/usage-card.js）
- **现象**：0% 基线上叠着一排 8px 圆点，同一位置有多个不同 tooltip（悬停命中的是 DOM 顺序里最后一个）。
- **实测（独立审查·真浏览器）**：24h + 按项目，12 个点里 8 个 `data-tok="0"`，
  如「00:00 · proj-0 tok=0」与「00:00 · proj-1 tok=0」完全重叠。
- **修复**：`v > 0` 才画散点（曲线与断线逻辑不变；合计维度本来就只有非空桶，行为无变化）。
- **回归测试**：`tests/web-render-safety.test.js` —— 3 个分组的桶里只有 2 个非零值，
  断言散点里不出现 `data-tok="0"` 且数量为 2。修复前该用例失败。

#### 运行日志面板：首屏拉取失败一次就永远停在「暂无日志」（src/web/components/log-panel.js）
- **现象**：页面加载时那一次 `GET /api/logs` 失败（后端正在重启、瞬时 500），日志面板之后
  永远空着 —— SSE 的 `log:event` 只会追加新行，没有任何机制补上历史快照。
- **实测（独立审查）**：让 fetch 返回 500 并连调两次 `logInit()`，全程只有 **1** 次请求。
- **根因**：`loaded = true` 写在 try/catch **之外**，失败也算「已加载」；而 app.js 只调用一次 `logInit()`。
- **修复**：只在成功时置 `loaded`；并发调用合并成同一个 Promise；失败后设 10s 冷却；
  `appendLog`（每条 SSE 日志都说明后端是活的）在 `loaded` 仍为 false 时自动补拉一次 ——
  自动补拉受冷却限流，避免后端持续 5xx 时被日志流打成请求风暴。快照与已有条目**合并**而非覆盖。
- **回归测试**：`tests/log-panel-retry.test.js`（fetch 桩 + 最小 DOM 桩，驱动真实模块）：
  失败后必须还能重试、成功后才不再拉、自动补拉在冷却期内被限流。修复前第 1 条失败。

#### 「已添加，但注意：…」这类提示会被下一次刷新抹掉（约 3 秒）（src/web/app.js + src/web/components/note.js）
- **现象**：添加实例时服务端回的 warning（如「这个目录看起来不像 dsh home」）在页面上存在 ≤3s
  就消失了，用户根本来不及看 —— 而代码注释当时还写着它挂在一个「持久」的提示条上。
- **实测（独立审查·真浏览器，走真实的 addHome 路径）**：添加后立即可见（`hidden: false`），
  下一次 SSE 刷新后 `hidden: true`，文本没变。
- **根因**：`refresh()` 无条件 `note.hidden = true`（「这一轮成功了」）—— 对失败提示正确，
  对「需要用户处理的事实」错误；重连分支同样会清空。
- **修复**：抽出 `components/note.js`（`createNote`），区分**普通提示**（刷新失败/部分加载失败/
  断线，成功刷新即撤）与**粘性提示**（添加实例的 warning，刷新与重连都不撤，被普通提示覆盖时自动解除）。
- **回归测试**：`tests/note.test.js`（4 例：粘性不被撤、普通被撤、覆盖后按普通处理、无 DOM 不抛）。

#### 用量卡可能显示「新周期高亮 + 旧周期数字」（src/web/app.js）
- **现象**：点「30 天」→ 请求失败 → `handleAction` 的 catch 先 `alert` 再 `refresh()`，
  而渲染用的是用户刚点的 `usagePeriod.key` 配 `lastUsage`（上一个周期的数据）——
  卡片变成「30 天高亮 + 24 小时的数字」，读者无法察觉自己看的是哪个窗口。
- **修复**：单独记录 `lastUsageKey`（屏上数据所属周期），渲染时用它高亮；
  失败时自然回退到旧周期，与屏上的数字一致。
- **回归测试**：`tests/web-render-safety.test.js` 的源码级一致性断言（app.js 需要整套 DOM 才能 import，
  与 docs-consistency 的做法一致）：必须存在 `lastUsageKey`，且不得再出现
  `renderUsageCard(usage, usageDim, usagePeriod.key)`。

#### 「停止实例」只发信号不等待：忽略 SIGTERM 的子进程仍活着，界面却报已停止（src/control/launcher.js）
- **现象**：点「停止」后 API 回 `{ok:true,stopped:true}`、`/api/homes` 显示 `runtime: "stopped"`、
  pid/url 清空，而那个 dsh web 子进程**仍在监听端口并返回 200**。句柄已经不在 `procs` 里，
  UI 连重试的机会都没有，端口要等到 hwb 退出（'exit' 钩子）才释放。
- **根因**：`stop()` 在 `inst.proc.kill()`（SIGTERM）之后**无条件** `procs.delete()` +
  `registry.set({phase:'stopped'})`。`kill()` 只是投递信号，既没等 exit，也没有超时与 SIGKILL 升级。
  审查用忽略 SIGTERM 的假 dsh 端到端复现：`lsof` 显示同一个 pid 仍在 LISTEN，`curl` 返回 200。
- **修复**：`#terminate()` —— 先挂 'exit' 监听再发信号，SIGTERM 等 3s，未退出则升级 SIGKILL 再等 2s；
  最终仍活着就**如实失败**：抛错（API 回 500 带 pid 与端口）、**保留句柄**（用户可再点一次）、
  注册表**不写 stopped**（进程还在跑就是 running），只追加 `lastError`。
- **回归测试**：`tests/launcher-terminate.test.js` —— 真子进程 + 假 dsh（`process.on('SIGTERM')` 忽略）：
  stop() 返回时进程必须真的没了、`signalCode === 'SIGKILL'`、且至少等了 SIGTERM 的窗口；
  另有一个永不退出的假句柄，断言 `stop()` 必须 reject、句柄保留、phase 不被改写成 stopped。
  修复前两条都失败（第二条停在 `Missing expected rejection`）。

#### 父进程退出会留下孤儿 dsh web（src/control/launcher.js + src/server.js）
- **现象**：hwb 退出后子进程仍在监听端口并响应 200，没有任何人再管它（审查用忽略 SIGTERM 的假 dsh 复现：
  父进程的 `lsof -p` 已经空了，端口还在听）。
- **根因**：`shutdown()` 直接 `process.exit(0)`，兜底只有 `process.on('exit')` 里的 `proc.kill()` ——
  投递即返回，而 `process.exit()` 之后事件循环不再运行：启动中的 dsh（还没装信号处理器）或忽略
  SIGTERM 的 dsh 就活下来了。
- **修复**：`Launcher.stopAll()`（复用 `#terminate` 的 SIGTERM → 等 → SIGKILL → 等），
  `shutdown()` 改为 `async`，在 `process.exit(0)` 之前 `await launcher.stopAll()`；
  'exit' 钩子退化成最后一道保险。
- **回归测试**：`tests/launcher-terminate.test.js`（`stopAll()` 必须返回 0 个失败、子进程必须真的死）。

#### 预览代理建立失败会把实例变成僵尸（子进程活着、句柄没了）（src/control/launcher.js）
- **现象**：`open()` 失败后 `launcher.status()` 返回 null、注册表 `stopped`、监控报未运行，
  而子进程仍在监听端口（审查复现：pid 38693 仍 LISTEN 在 58316）。重连是唯一的出路。
- **根因**：`open()` 的失败分支调 `disconnect(home)`（`release=false`）—— 这条分支的语义是
  「本机受管进程保留所有权，只是撤销接入」，于是刚**为这次连接拉起**的子进程被标成 `detached` 留着。
- **修复**：失败分支改用 `disconnect(home, {release:true})`，把这次拉起的子进程一并收掉（等它真的退出）；
  收不掉时记 `log.error` 写明 pid 与端口（移除语义下无法保留句柄，至少要留痕）。
- **回归测试**：`tests/launcher-terminate.test.js` —— 注入一个必然 EADDRINUSE 的 proxyFactory，
  断言 open() 失败后那个 pid 已经不存在（修复前子进程仍活着）。

#### 连接不验证鉴权：token 错了也报「已连接」（src/control/launcher.js + prober.js + monitor.js）
- **现象**：token 填错、或远端 dsh web 轮换了 token 时，`open()` 照样成功、卡片显示已连接、
  监控每 30s 报 running，而 iframe 里是 401 栅栏页（审查实测：`monitor.refresh()` 对只有 401 的端点
  返回 `runtime: 'running'`、`latencyMs: 7`）。
- **根因**：连接路径上唯一的存活性判据是 `httpProbe`，它的口径是 `status < 500` ——
  **401 也算活着**（对「远端端口上有没有 dsh web 在听」这是对的，对「用户点开能不能用」是错的），
  而 `#connectRemote` / `#connectLocalExisting` / `#spawnLocalDsh` 都没有验证过鉴权。
- **修复**：①新增 `#assertAuthorized(url)`：用与 iframe **同一条入口**做一次 token→cookie 交接，
  401/403 直接失败并给出补救办法（重填 token / 重新连接），其它 4xx 也判失败；
  三条连接路径（含远端重连）在写 `phase:'running'` 之前都必须通过它。
  ②`prober.js` 拆出 `httpProbeStatus()` 并新增 `probeAlive()`（401/403 判为不可用），
  Monitor 的心跳默认改用 `probeAlive` —— httpProbe 的语义保持不变，供端口探测类判断继续使用。
- **对真实 dsh 的复验**（审查当时标为 UNVERIFIED 的那一条）：本机真实 dsh web（127.0.0.1:3080，
  只读探测）—— 裸 URL 与错 token 都返回 **401**，`httpProbe` 判 `true` 而 `probeAlive` 判 `false`，
  `authFetch` 两条也都拿到 401（不是 303）。也就是说这套判据在真实 dsh 上同样成立，
  而不是只在假栅栏上成立。
- **回归测试**：`tests/launcher-terminate.test.js` —— 假 dsh 带真 token 栅栏（裸 URL/错 token 401，
  对 token 303 + Set-Cookie 后 200）：错 token 的直连必须失败且不留「已连接」状态、对 token 必须照常连上；
  另断言 `httpProbe(裸 URL) === true` 而 `probeAlive(裸 URL) === false`，以及 Monitor 默认探测就是
  `probeAlive`。修复前「错 token 也连上」与「401 算可用」两条都失败。

#### 预览代理失败的真因被丢弃：报「本地端口 undefined 已被占用」（src/control/launcher.js）
- **现象**：任何 `EADDRINUSE` 都被改写成 `本地端口 ${home.accessPort} 已被占用…`，而本机实例的
  `accessPort` 是 undefined —— 用户看到「本地端口 undefined 已被占用」，既不知道是哪个端口，
  也丢掉了真正的错误（审查的复现日志里逐字出现过）。
- **修复**：只在 `home.accessPort` 确实存在时才给端口提示，否则说明「预览代理端口被占用（本机实例
  由系统分配）」，并把原始错误消息追加在后面。
- **回归测试**：`tests/launcher-terminate.test.js` 断言消息里不出现 `undefined` 且保留 `EADDRINUSE`。

#### 远端「停止」在没装 fuser 的机器上什么都没做，却返回成功（src/control/remote.js）
- **现象**：最小化的 Linux/容器镜像里没有 fuser，于是 hwb 报「已停止」、隧道也拆了，
  而远端 dsh web 仍占着 remotePort 与 DSH_HOME。
- **根因**：`stopRemote` 的脚本是 fuser-only：`command -v fuser … || echo "no-fuser"`，且**没有 fuser 也 exit 0**
  —— 而上层只看退出码。同文件的 `killport()`（启动脚本里）早就为此用了 lsof → ss/netstat。
- **修复**：`REMOTE_STOP` 与 `killport()` 同一套判据：lsof 优先 → fuser → 两者都没有就**明确失败**（非 0）；
  杀完复核，仍在监听就升级 `kill -9` 再复核，仍收不掉则以非 0 退出。端口本来就没在监听则算成功
  （输出 `not-listening`）。`launcher.stop()` 也改为把远端停止失败**上报给用户**
  （本地连接照常拆，但最后抛出「本地连接已断开，但远端 dsh web 未能停止」）。
- **回归测试**：`tests/remote-stop.test.js` —— 用真 bash 跑这段脚本：起一个真的监听进程 → 必须被杀掉且
  `kill -9` 复核无误；空端口 → `not-listening` 且退出 0；把 PATH 清空（既无 lsof 也无 fuser）→ 必须非 0。
  修复前 4 个用例全失败。

#### 实时 tokenUsage 只带一部分计数器时会整列覆盖，用量面板静默塌掉 99.9%（src/dshhome/reader.js）
- **现象**：用量面板上的历史合计突然从 109100 掉到 120，没有任何报错、没有 degraded 标记。
- **根因**：实时通道（3s 轮询 → `sessions.tokenUsage`）是**整列替换**语义：
  `row.tokenUsage = JSON.stringify(l.tokenUsage)`。`normalizeLiveTokenUsage` 的契约是
  「认得出来才返回对象」，但**部分**认得出来（少一两个键）同样返回对象 —— 而缺哪个键
  就等于把哪个键**清零**。实测：文件侧合计 109100 的会话（12400/3200/88100/5400）
  遇到只带 `{uncachedInputTokens:100, outputTokens:20}` 的实时对象后，合计变成 120（丢 99.9%）。
  正常路径下一轮文件索引会把累计值写回来，但 projcache 降级时实时值就是权威
  —— 那正是这套实时保护存在的场景，于是永久错下去。
- **修复**：`mergeLiveStatus` 改为**按 key 合并**（`mergeTokenUsage`）：实时报了哪个键就更新哪个键，
  没报的保持投影缓存的值；实时对象四个键齐全时（dsh 的常规情形）结果与整列替换完全一致，
  所以不会因为「保守」而丢掉实时确实报了的键。认不出来的形状（如 `{last:{…}}`）继续不动这一列。
- **回归测试**：`tests/live-merge.test.js`（3 个新用例：部分计数、四键齐全、认不出的形状）与
  `tests/store-token-columns.test.js`（端到端 `applyLiveStatus` → `usageSummary` 断言 93620 而不是 120）。
  修复前两条失败。

#### 实时状态保护把「已从实时列表消失的会话」永久钉在「运行中」（src/dshhome/store.js）
- **现象**：某个会话在 dsh 里被归档/关掉之后，工作台上会一直显示它是「运行中」，而且**永不纠正**
  （直到 dsh 停止）。`/api/sessions/recent` 里它的 `status` 是 `running 运行中`、活跃时间冻在最后一次，
  排序也跟着错位；`sessionCount`/运行中计数一并虚高。
- **根因（A/B 复现，3/3 一致）**：上一轮为「索引器把实时徽标打回陈旧值」加的保护是
  「替换前记下该 home 所有非 NULL 的 status，替换后写回」。而轮询器每 3s 写一次，只要 dsh 里
  **还有任意一个**会话活着，`LIVE_GRACE_MS`（10s）就永远成立 —— 于是这层保护会把该 home
  **每一条**会话的 status 都写回，包括实时列表里**已经不存在**的那些。文件索引从此再也清不掉它，
  幽灵行清理只删 `liveOnly=1` 的行也救不了，`RUNNING_STALE_MS` 的陈旧度闸门同样被绕过。
  实测（同一夹具，只换代码版本）：修复前 `s2=running s1=running`，修复后 `s2=running s1=idle`（期望值）。
  这正是本项目已声明修过的「18/179 个会话永久标成运行中」那个缺陷类。
- **修复**：`applyLiveStatus` 额外记账「**这次**实时列表里的 sessionId 集合」（`#liveIds`，按 home），
  `upsertRows` 回写 status/lastActivity 时只认集合内的会话；不在集合里的退回文件索引推导值。
  空列表也记成**空集合**（「dsh 当前没有会话」是有效信息），而读取失败（非数组）不动账本
  —— 那是「不知道」，不是「没有」。
- **回归测试**：`tests/live-status-restore.test.js`（3 个用例：实时列表缩小、列表变空、读取失败）。
  前两个用例在修复前失败（`not ok`），修复后通过。

#### SSH 主机名里的控制字符能一路走到 spawn，并让 sshBash 变成 rejection（src/lib/endpoints.js + src/control/remote.js）
- **现象**：主机名校验用的是 `\s`，而 `\s` **不匹配** `\0`（也不匹配 `\x01` 之类），
  于是 `"bot@x\0y"` 能通过校验并落库。等它被用于 ssh 时，Node 的 `spawn` 因为「参数不能含 NUL」
  **同步抛** `ERR_INVALID_ARG_VALUE` —— 而 `sshBash` 里只处理了**异步**的 `proc.on('error')`，
  同步这条会变成一次 **rejection**。所有调用方都只检查返回值里的 `code`，没人接这个 rejection，
  于是它冒成未处理拒绝（crash handler 记成 fatal 并退出）。
  实测：`await sshBash('bot@x\u0000y', 'echo hi')` → 抛出 `ERR_INVALID_ARG_VALUE`；
  作为对照，异步的 ENOENT（没有 ssh 可执行文件）一直是走返回值 -2 的。
- **修复**：①校验层显式拒绝控制字符（`[\s\u0000-\u001f\u007f]`）—— 主机名里出现控制字符
  没有任何正当理由，挡在最前面最省事；②`sshBash` 把 `spawnProcess` 包进 try/catch，
  同步抛错统一成返回值（`code: -2`，与异步 spawn 失败同码），保持「失败也用返回值表达」的约定。
- **回归测试**：`tests/endpoints.test.js`（NUL/\x01/\x7f/制表符都必须被拒，正常主机名不受影响）
  与 `tests/remote.test.js`（含 NUL 的主机必须**返回** -2 而不是 reject）。修复前两条都失败。

#### `GET /api/homes` 会把每个实例的 dsh token 回给客户端（src/api/routes.js）
- **现象**：浏览器（以及任何能连到该端口的东西）请求 `/api/homes` 就能拿到实例的 dsh token 明文。
  实测：注册一个带 token 的实例后，响应里直接出现 `token = "SUPER-SECRET-LAUNCH-TOKEN"`。
  token 是**控制凭据**（持有它 = 持有那个 dsh 实例：能执行 shell、写文件），而这个 API 在回环上
  没有鉴权，且端口绑在回环上**不代表只有本用户能连**。
- **修复（有边界，写清楚）**：读接口不再回传实例级 `token`。界面本来就不需要它 —— 带 token 的
  iframe 入口由 `POST /homes/{id}/open` 现取现用；`PATCH` 也只在客户端**显式**传 token 时才改它，
  所以局部更新不会被这次收窄弄坏（测试里专门断言「不传 token 时保留原值、传空串才清除」）。
- **没有关闭的部分**：`endpoints[].token` 仍在响应里，因为连接端点编辑器需要它做预填，
  而它保存时会把输入框的值原样回传 —— 预填为空就等于保存时把 token 抹掉。要收掉必须同步改
  编辑器的预填与「清除」语义，不是一行 `delete` 能解决的事。测试里对**现状**有显式断言
  （改的人会看到「端点 token 目前仍需回传」这条信息），避免以后误以为已经关死了。
- **README**：在「安全边界」里补了两条 —— ①回环不是访问控制，同机其它用户能读能写（curl 不带
  同站头，照常可用），不要把端口暴露到回环之外；②dsh token 的暴露面说清楚（`/open` 必然返回
  带 token 的入口 URL，所以边界是「谁能访问端口」而不是「响应里有没有这个字段」）。
- **回归测试**：`tests/api-token-exposure.test.js`（真 HTTP + 真 store）。

#### 启停锁的心跳阈值取错了（自己上一条修复引入的）（src/cli.js）
- **问题**：心跳阈值原先按「心跳间隔的 4 倍」取 20s。但持有者最长的一次**阻塞调用**才是真正的约束：
  `hwb upgrade` 依次执行 `git pull` 与**整套测试**，两者都走 `spawnSync` —— 事件循环被整个阻塞，
  心跳定时器**根本不会触发**。于是 upgrade 跑到一半就会被另一个 `hwb stop`/`start` 判成残留并接管：
  锁恰好在它最该生效的场合失效（最坏情况是重启服务打断正在进行的升级）。
- **来源**：这一条是**我自己复查上一轮改动时发现的**，不是外部审查提出的。
- **修复**：阈值改为 120s，并在注释里写明「取值不是心跳的倍数，而是必须大于最长的一次阻塞调用」；
  `run()`（spawnSync 包装）在进入与返回时各摸一次锁，让阻塞期间 mtime 尽量新；
  拒绝信息里补上「多少秒前还有更新」与「最迟多久会自动接管」。
- **回归测试**：`tests/cli.test.js` —— 「PID 活着 + 60s 没有心跳」（代表正卡在阻塞命令里的持有者）
  必须仍然被尊重、不得被抢；真过期（10 分钟）才接管。把阈值改回 20s 后该用例立刻失败。

#### 启停锁：接管动作本身有两个竞态（src/cli.js）
- **问题**（审查提出，未能复现，但窗口确实存在）：
  · 接管用 `rmSync` + 重试 `wx`。并发接管者 B 若在 A 删除旧锁之后、A 创建新锁之前执行它那一记
    `rm`，就会删掉**A 的新锁**，然后自己也 `wx` 成功 —— 两个持有者。
  · 锁文件是 `openSync('wx')` 与 `writeFileSync` **两步**创建的，中间存在「文件已存在但内容为空」
    的窗口；空锁原先一律判为残留，于是并发命令会互相抢。
- **修复**：①接管改为 `rename` 把旧锁原子移到一边，再读回来**比对内容**是否就是刚才读到的那把；
  不是就还回去并放弃接管（不碰别人的新锁）；②锁内容用一次
  `writeFileSync(lock, body, { flag:'wx' })` 写入，并把「空锁」按**新鲜度**判定：新鲜的算被持有
  （可能就是并发命令刚创建的那一瞬），只有空且已停止更新才当残留。
- **回归测试**：`tests/cli.test.js` —— 刚创建的空锁必须拒（视为被持有），过期空锁必须接管；
  另外「持有者已死」与「PID 存活但心跳过期」两条照旧覆盖。修复前新用例失败。

#### 本地上传会在用户项目目录里留下装着整份文件副本的隐藏目录（src/lib/file-preview.js）
- **现象**：上传中途失败后，项目目录里留下 `.hwb-upload-xxxxxx/part` —— 每个残留都装着**整份文件**。
  两个触发路径都实测复现：①批量上传时第二个文件失败（前面已 stage 的目录谁都不管）；
  ②`commit()` 的 `link` 报非 EEXIST 错误（EACCES/ENOSPC/EMFILE）时清理被跳过。
  `ls -a`/`git status` 里都是垃圾，磁盘也会持续增长。
- **根因**：`stage()` 把已写好的临时目录交给 `commit` 闭包并把 `temp` 置空，而 `cleanup()` 只清
  「当前那个」；`commit()` 的 `rm(staging)` 写在 link 循环**之后**，link 一抛就被跳过。
- **修复**：uploader 记录所有已 stage 的目录，`cleanup()` 全部清掉；`commit()` 的清理改成
  `try/finally` 包住**整个** link 循环（只包 `return` 是不够的 —— 我第一版就是这么写的，
  实测仍然残留，因为抛错发生在循环里）。
- **回归测试**：`tests/file-upload.test.js` 两条 —— 中途失败时已 stage 的目录也要清掉；
  commit 失败（故障注入让 part 消失 → link 报 ENOENT）也要清掉自己的暂存目录。
  说明：故障注入刻意不用「把目录设为不可写」——那种情况下连 `rm` 本身都没权限，
  残留是夹具问题而非缺陷。两条修复前都失败。
- **顺带**删掉 `localUploader.finish`：没有任何调用方（只用 `stage`/`commit`），
  而且它读的是模块级的 `active`，被 `stage()` 置空后行为已经不对。

#### 静态缓存：stat 成功但 readFile 失败会以异常结束（dsh-static-cache/lib/index.js）
- **现象**：资源在 `stat` 与 `readFile` 之间消失/权限不足/IO 错误时，处理器拒绝 → dsh 的
  webserver 兜住后回 **400** 并往日志里写一段 warn+堆栈，而正确答案是 404。
  与「目录请求」是同一类问题，当时只修了目录那一条。
- **修复**：`readFile` 包 try/catch，`ENOENT`/`EACCES`/`EISDIR`/`EIO` 一律 404。
- **回归测试**：`tests/dsh-static-cache.test.js` —— chmod 000 的文件请求必须 404 且不再抛。

#### 本地预览的 realpath→open 窗口（TOCTOU，加固）（src/lib/file-preview.js）
- **问题**：`readLocalPreview` 先 `realpath` 做越界判断，再用**路径**去 `open` —— 两步之间把
  target 换成符号链接，就能读到工作区之外的文件（越界检查查的是 realpath 那一刻的路径）。
  独立审查用两个进程做符号链接/rename 翻转 + 129,576 次竞态读：**0 次逃逸**（窗口在同一个宏任务内，
  要精确调度才能赢）。所以这条是**加固**，不是已发生的缺陷。
- **修复**：以**已打开的 fd** 为准复核「打开的就是刚才 realpath 解析出的那个对象」（dev+ino 相同），
  不一致就报「文件在预览期间被替换，请刷新后重试」。刻意**不**用 `O_NOFOLLOW`：指向工作区**内**的
  目录符号链接是允许的（既有用例明确覆盖），加了会误伤。彻底的做法是 `openat()` 从 root 的 dirfd
  逐段走 —— 那需要更多代码，这一步把窗口从「很容易赢」缩到「必须竞态才能赢」。
- **回归测试**：这个窗口无法写成「必定失败」的用例（要精确控制时序），所以用一条**结构断言**
  钉住加固本身（必须有 `handle.stat()` 与 dev+ino 比对），正路径的越界/符号链接用例照旧守着不误伤。
  与 `readMetadataFile` 的 TOCTOU 加固采用同一套做法（那条也是结构断言）。

#### 静态缓存：`/assets//a.js` 被误判成越界（dsh-static-cache/lib/index.js）
- **现象**：`GET /assets//a.js`（多一个斜杠）拿到 **403**，而那个文件确实存在。
- **根因**：rel 取到 `/a.js`，`resolve(assetRoot, '/a.js')` 把它当成**绝对路径**，于是越界检查拒绝。
  这是**误拒**而非逃逸（正常的浏览器不会发这种 URL，但手工拼接出来的地址会出现）。
- **修复**：先收掉多余的前导斜杠再解析；越界防护本身不变。
- **回归测试**：`tests/dsh-static-cache.test.js` —— 双斜杠必须 200，同时 `%2e%2e/` 的越界尝试照旧被拒。

#### 「在 Finder 中打开工作区」把裸 errno 抛给界面（src/lib/open-workspace.js）
- **现象**：工作区目录被移动/删除后点「在 Finder 中打开」，界面上显示
  `ENOENT: no such file or directory, stat '/x/y'` —— 与预览/下载那条同源的问题
  （同一轮里修了预览，这处漏了）。
- **修复**：`stat` 包 try/catch，`ENOENT` → 「工作区目录不存在，可能已被移动或删除」、
  `EACCES`/`EPERM` → 「没有访问该目录的权限」，其它错误照旧抛出。
- **回归测试**：`tests/open-workspace.test.js` —— 不存在的目录必须给出中文说明且不含 `ENOENT`。

#### 预览路径把裸 errno 抛给界面（src/lib/file-preview.js）
- **现象**：文件被删掉后点预览，界面上显示
  `ENOENT: no such file or directory, realpath '/private/var/.../nope.txt'` —— 一句英文系统错误，
  既没说是哪个文件也没说该怎么办。
- **修复**：新增 `mapPreviewError`（与上传路径的 `mapUploadError` 同源），把
  ENOENT/EACCES/EPERM/EISDIR/ENOTDIR/ELOOP/ENAMETOOLONG 翻成人话；`realpath` 与 `open` 两处都包。
- **回归测试**：`tests/file-preview.test.js` —— 不存在的文件必须给出中文说明且**不含** `ENOENT`。

#### CLI 与服务：三条「谎报 / 自杀 / 永久卡住」的问题（src/cli.js + src/service.js）
- **`status`/`doctor` 把正在服务的前台 `hwb serve` 报成「已停止」**（MEDIUM）。前台 serve 不创建
  控制 socket，而这两个命令只看 socket：看板明明在返回 200，`status` 却打印 `stopped` 并**以退出码 1
  结束**（脚本里 `set -e` 会据此认为服务挂了），`doctor` 则报「服务 未运行」还退出 0。
  修复：没有 socket 时补一次探测，并且**确认对面真的是 hwb**（请求 `/api/homes`，只有 hwb 会回
  `{homes:[...]}`）—— 只探测「端口有人听」是不够的：随便一个程序占了配置端口就会被说成
  「前台运行的 hwb serve」，那是另一个方向的谎报。`stop` 的措辞也据此变精确：确认是 hwb 才说
  「多半是前台 serve」，否则明说「被**其它程序**占用（不是 hwb）」并给出换端口/lsof 的命令。
- **父进程（`hwb start`）提前退出会把刚起来的后台服务打死**（MEDIUM）。CLI 在子进程报到之前就消失
  （Ctrl-C、关终端、supervisor/timeout 杀掉）时，子进程其实**已经监听成功**，却因 `process.send`
  失败而死于未捕获的 EPIPE（crash handler → exit 1）。
  注意这个失败是**异步**的：错误从 IPC channel 的 `'error'` 事件冒出来，`try/catch` 抓不到 ——
  只加 try/catch 实测仍然崩（父进程 30ms 退出 → 端口连不上 + 日志一条 FATAL）。
  修复：`process.on('error')` 忽略 EPIPE / `ERR_IPC_CHANNEL_CLOSED` / `ERR_IPC_DISCONNECTED`
  （其它错误照旧抛出，不在这里变成静默），并在 send 前检查 `process.connected`。
- **残留启停锁的接管只看 PID 活不活，遇到 PID 复用就再次卡死**（MEDIUM）。PID 会被回收
  （macOS 上限约 99998）：一个被 `kill -9` 的启停命令留下的锁，其 PID 被任何无关进程复用之后，
  锁就永远「被持有」，start/stop/restart 全部退出码 1 —— 正是上一个提交想消掉的症状。
  修复：加一路**心跳** —— 持有者每 5s 更新锁文件 mtime，20s 没有心跳即视为残留（无论 PID 是否活着），
  接管时说明原因（「PID 虽在运行，但已 Ns 没有心跳（很可能是 PID 被回收了）」）。正常的长操作
  （`hwb upgrade` 会跑一整套测试）一直在心跳，不会被误抢；代价是持有者被 SIGSTOP/整机休眠
  超过 20s 时也会被判为残留 —— 那种情况下另一个命令接管更符合用户期待，已在注释里写明。
- **service.js 两处小加固**：`'exit'` 清理改为**先**注册再 chmod（监听回调是 async，chmod 抛错会
  变成 unhandledRejection，而 crash handler 要等 `await import` 才装好，此时没人接得住）；
  `HWB_DIR` 指向共享目录（`/`、`$HOME`、系统临时目录）时不再 chmod 0700 —— 那会把不属于 hwb 的
  目录重新授权（`/tmp` 的 sticky/world 位会掉），socket 自身的 0600 不受影响。
- **回归测试**：`tests/cli.test.js` 新增/更新四条 —— 前台 serve 下 `status` 必须报 running 且
  `doctor` 报 HTTP 正常；PID 存活但心跳过期时（PID 复用）必须接管、心跳新鲜时必须拦住；
  端口被非 hwb 程序占用时消息必须点明「其它程序」；父进程 30ms 后退出后服务必须仍在监听且日志无 EPIPE。
  逐条验证过回退后失败。**顺带修掉测试自身的一个坑**：假监听器用 `s.end()` 只做半关闭，
  客户端（CLI 子进程）已退出时 `server.close()` 永不回调，测试钩子悬住 → 整条用例被判
  `cancelledByParent`（`net.Server` 也没有 `closeAllConnections`）；改用 `s.destroy()`。

#### dsh-remote-index：取一行的非 zstd 分支会把整个会话读进内存（dsh-remote-index/dsh-instance-index.mjs）
- **现象**：脚本自称「lightweight / 只读 session header」，但非 zstd 分支用 `readFile` 把整个
  `session.jsonl` 读进内存再取第一行。实测一个 300 MB 的 `session.jsonl`：峰值 RSS
  **44 MB → 360 MB**（同一台机器、同一条命令，只换这个文件）。而这个脚本是经 ssh 在**远端主机**
  上跑的 —— 大会话足以把远端的 dsh 一起拖下水。
- **根因**：同一个故障模式此前只在 zstd 分支上修过（那份注释还写着「改成流式解压」），
  并列的 `if (suffix !== ".jsonl.zstd")` 分支漏掉了。
- **修复**：两条分支统一走 `createReadStream`（zstd 分支再套一层解压流），拿到第一个换行或
  超过 64 KiB 就销毁所有流。修复后同样的 300 MB 文件：峰值 RSS **44 MB**（与空目录基线相同）。
- **回归测试**：`tests/dsh-remote-index.test.js` —— 8 MiB 的 session 文件仍能正确解析头部；
  并对实现做一条结构断言：取头部的函数里**不许出现 `readFile(`**、必须用 `createReadStream`。
  回退修复后该用例失败。（内存数字本身不写成断言：GC/平台差异会抖。）

#### `dsh-remote-web.sh`：文档承诺的选项不存在、拒绝 kill 时还删记录、共享目录被改权限（scripts/dsh-remote-web.sh）
- **现象**（独立审查第 7 轮，四条都实测复现）：
  · **`--kill-pattern` 从来不存在**：文档（`README-dsh-remote-web.md:55,:78`）一直写着它，
    但解析器里只有环境变量 `KILL_PATTERN` —— 「远端没有 fuser」时的兜底完全用不了，
    `--kill-pattern …` 直接 `Unknown option` + rc=2。
  · **`--kill-tunnel` 在「拒绝 kill」时把 PID 记录删掉还返回 0**：那条隧道仍在跑，却从此再也
    管不到（记录没了），而命令说成功。删除发生在校验之前是无条件的。
  · **PID 记录写失败会让隧道变孤儿**：`set -e` 下写文件失败直接退出，而 ssh 已经在后台跑起来了 ——
    没有记录、没有 URL、只剩一条占着端口的隧道。
  · **运行目录被无条件 `chmod 700`**：`DSH_REMOTE_WEB_DIR` 允许指向任意路径（文档还鼓励覆盖），
    指向一个共享目录就会把它锁死成 0700（实测 0755 → 0700）。
- **修复**：补上 `--kill-pattern`（与 `KILL_PATTERN` 同源）；`stop_tunnel` 只在**确实 kill 成功**
  后删记录，其余分支返回 1；`--kill-tunnel` 据此以非零码退出；PID 记录写不进去时立刻回收刚起的
  隧道并退出 1；运行目录只在自己**新建**时收 0700（预存在的目录一律不动）。
- **回归测试**：新增 `tests/dsh-remote-web.test.js`（跑真脚本的提前退出路径，不碰 ssh）——
  `--kill-pattern` 不得被当成未知选项；PID 记录为 `0`/`abc`/空时必须非零退出**且记录保留**；
  预存在的 0755 目录跑完仍是 0755，而自己新建的目录是 0700。修复前三条全失败。

#### 反代配置：入口 URL 是 `/`，但只有 `/index.html` 发了 no-cache（scripts/dsh-http-cache.nginx.conf + Caddyfile）
- **现象**：`README-http-cache.md` 说入口文档不缓存以避免「旧注入残留」，而 nginx 只给
  `/index.html`、`/favicon.svg`、`/manifest.webmanifest` 发了 `Cache-Control: no-cache`；
  用户实际打开的是 `http://<host>:3081/`，它落到通用 location，一条 Cache-Control 都没有 ——
  声称的防护对真正被加载的地址不生效。
- **修复**：nginx 加 `location = /`、Caddy 加 `header /`，都发 `no-cache`。
- **顺带修文档**：`README-dsh-remote-web.md` 里两处仍写着隧道状态文件在 `/tmp/.dsh-remote-web.*`，
  而代码早已迁到 `${XDG_RUNTIME_DIR:-$HOME/.dsh}/dsh-remote-web/`（同一文档后面自己还写着「已从 /tmp 迁出」）。

#### 端点 token 仍然会回传到浏览器（src/api/routes.js + src/web/components/endpoint-editor.js）
- **现象**（独立审查第 8 轮）：上一轮只收掉了实例级 `token`，`endpoints[].token` 照旧明文回传
  （实测 `grep SECRET-EP-TOKEN` 命中两个端点）。当时留它的理由是「端点编辑器要预填，否则保存会抹掉」——
  理由成立，但结论不该是「那就继续交出去」。
- **修复**：出站把端点 token 换成 `tokenSet: true`（界面据此提示「已配置」），同时把「留空」的语义
  从「清空」改成「保持不变」：服务端按端点 id 合并，客户端不传 `token` 字段就沿用已存值，
  要清除必须显式 `tokenClear: true`（编辑器里对应一个「清除 token」按钮）。
  这样凭据不再交给浏览器，而「打开设置 → 直接保存」也不会静默清掉 token。
- **回归测试**：`tests/api-token-exposure.test.js` 新增一条（真 HTTP + 真 store）：响应里不得出现
  端点 token、必须给 `tokenSet`；留空保存保留原值（并确认 label 改动生效）、`tokenClear` 只清被标记
  的那一个、显式传新值能设置。`tests/form-draft.test.js` 断言编辑器的读写语义（留空不带字段、
  填了才传、点清除才传 `tokenClear`）。修复前三条相关用例都失败。
- **README**：「安全边界」里那条「端点 token 仍会回传」的说明随之更新为现在的语义。

#### 日志脱敏的「值」只吃前缀；`getLogs({limit:0})` 会倒出整个环缓冲（src/lib/logger.js）
- **现象**（独立审查第 7 轮）：
  · 值字符集写的是 `[A-Za-z0-9_-]`，于是 `token=abc+DEF/ghi==` 只被脱敏成
    `token=[已脱敏]+DEF/ghi==` —— **值的一半还在日志里**；键名也只认 `token`，
    `Authorization: Bearer …`、`api_key=…`、`DCS_PAT=…`、`token: …` 一律漏。
    真实 dsh token 是 base64url（今天的形态本来就被覆盖，审查也确认没有现成的泄漏调用点），
    所以这是**加固**而不是已发生的泄漏 —— 但这里已经是唯一收口，没有理由只认一种键名。
  · `getLogs({limit: 0})` 会返回**整个环缓冲**：`slice(-Math.max(0, limit))` 在 limit=0 时
    算的是 `slice(-0)`，而 `-0 === 0` → `slice(0)`。HTTP 路径把 limit 夹在 [1,1000] 所以没暴露，
    但这是个等着被踩的陷阱。
- **修复**：值改成「分隔符取反」（一次吃掉整个值，又不会溢出到下一个字段）；
  键名扩到 `token/access_token/refresh_token/pat/api[-_]?key/secret/password/passwd` 且允许单词后缀
  （`DCS_PAT`、`MY_API_KEY` 都要命中）；`Authorization` 单独一条规则，且**必须**把 scheme 放进前缀
  一起吃掉 —— 否则会「脱敏 Bearer、留下真 token」。`limit <= 0`（含 NaN）直接返回空数组。
- **两个自己踩出来的坑**（都写进注释与测试）：①值里必须同时排除 `[` 与 `]`，否则标记
  `[已脱敏]` 会被第二次替换吃掉一半，留下一个多余的 `]`（`--token [已脱敏]]`）——
  现在断言**幂等**；②`bearer` 不能无条件当分隔符，否则散文「the bearer of bad news」也被脱敏，
  裸 `Bearer <值>` 改成「值至少 16 个凭据字符」才匹配。
- **回归测试**：`tests/logger-security.test.js` —— 11 种泄漏形态（含幂等断言）+ 3 种不该动的普通文本
  + `limit` 为 0/负数/NaN 必须为空。修复前两条用例都失败。

#### `/api/*` 的响应头（src/api/server.js）
- **现象**（独立审查第 8 轮）：`/api/*` 的响应**一条 Cache-Control 都没有**（preview/download 单独设了
  `no-store`，其余没有）；`curl -I /api/homes`（HEAD）返回 **404** —— 路由只匹配 `method === 'GET'`，
  于是任何基于 HEAD 的健康检查都会认为 API 挂了；静态 403/404 与 500 缺 Content-Type/charset。
- **修复**：`/api/*` 统一加 `Cache-Control: no-store` 与 `X-Content-Type-Options: nosniff`
  （这是个无鉴权 API，响应里有实例元数据与会话标题，不该进浏览器缓存或中间代理）；
  HEAD 映射到 GET 交给同一套逻辑（Node 对 HEAD 本来就不写 body）；错误响应补 content-type。
- **回归测试**：`tests/api-server-hardening.test.js` —— HEAD 必须 200 且无 body、`/api/*` 必须
  `no-store` + nosniff、404 也要带 JSON content-type 与 no-store。修复前失败。

#### `hwb upgrade` 在没有上游分支时只抛 git 的英文报错（src/cli.js）
- **现象**：在一条没有 upstream 的分支上跑 `hwb upgrade`（本仓库的 `tmp-reorder2` 就是），
  终端只有一句 `hwb: git 失败 (128): fatal: no upstream configured for branch 'tmp-reorder2'` ——
  用户得自己知道 upstream 是什么、该怎么建。而 `upgrade` 是 README 里明确提供的命令。
- **修复**：显式接住这个失败，给出可照做的说明（带上分支名）：
  「当前分支 X 没有上游分支，无法快进更新。先建立上游（`git push -u origin X`）后重试，
  或切到已有上游的分支（如 main）。」检查顺序不变（仍然在 `git pull` 之前中止，不会动工作区）。
- **回归测试**：`tests/cli.test.js` —— 把 `cli.js` + `src/lib` 复制进一个独立临时仓库（`upgrade`
  作用在**它自己所在的仓库**上，必须在隔离仓库里测，否则测的是 hwb 自己的工作区），
  init 一个没有上游的分支后断言提示含分支名与 `git push -u`、且不再出现 `git 失败 (128)`。
  修复前失败。

#### SSE 连接数没有上限（src/api/sse.js）
- **问题**（独立审查第 8 轮的 LOW）：背压上限（4 MiB）管的是「一个卡住的客户端」，
  但没管「有多少个客户端」——一个跑飞的脚本或狂刷页面可以开成百上千条 `EventSource`，
  每条占一个 fd 与一份连接状态。单进程工作台里这是可以耗尽资源的。
- **修复**：加客户端数上限（默认 32）。超过时**拒绝新连接**并回 503（浏览器 EventSource 会自己
  退避重连），而不是踢掉正在工作的标签页 —— 后者会让用户当前看着的页面突然静默停止刷新，
  比拒绝新连接更难理解。
- **回归测试**：`tests/sse.test.js` —— 上限内 3 条都 200、第 4 条 503 且不计入、已有连接照旧收到
  广播、关掉一条后新连接又能进。修复前失败。
- **顺带**修掉测试夹具的一个缺陷：假的 `res` 没有 `end()`，于是「拒绝时回一句话」这种代码
  会被 try/catch 吞掉，测出来是假象。

#### 连接中的实例无法新增连接端点；两处「输入」口径没写明（第 10 轮审查）
- **409 挡住了唯一可行的操作**（LOW，但用户会直接撞上）：判定「正在使用的端点被改动」时，
  原先把「没有 active 端点 + 提交了端点」也算进去 —— 而「没有 active 端点」正是**拉起模式**
  （实例由 hwb 自己启动、还没配置任何连接端点）的常态。于是用户在设置里补第一个端点每次都 409，
  而提示还建议「添加其他端点并切换后再修改」——**切换 UI 需要 ≥2 个端点**，那句建议在这条路径上
  无法执行（实测：同一请求先断开就 200）。修复：只有真的修改/删除**当前**端点才拒绝，
  新增无关端点照常；提示也按有无 current 分开措辞。
  **回归测试**：`tests/instance-connection.test.js` —— 拉起模式下新增端点必须 200、
  改动当前端点仍必须 409、再加一个无关端点仍 200。修复前第一条就是 409。
- **两处「输入」口径不同却都没写明**：`usageSummary/usageTrend…` 的 `inputTokens` 是**新增输入**
  （不含缓存），而 `recentProjects` 的 `inputTokens` 是**总输入**（新增 + 缓存读 + 缓存写）——
  同一条会话实测 1000 vs 1950。两个数字各自都对（项目卡片是按总消耗排序的），但只写 in/out
  会让人以为两处该相等。修复：store 里把两个口径并列写明；项目卡片的 `in` 加上
  `title="新增输入 + 缓存读 + 缓存写"`（数字不变）。

#### 三条 LOW 的健壮性（src/dshhome/store.js）
- **重复接入端口让每次启动都失败**：`CREATE UNIQUE INDEX homes_access_port` 在库里有重复值时失败，
  而它在启动路径上 → 用户只能自己拿 sqlite 改库。重复值只可能来自手改库/早期版本
  （列、索引、`#checkAccessPort` 与 API 409 是同一批加的）。修复：建索引前先去掉重复
  （保留 `sortIndex` 最小的那条，其余置空并记一条 warn）。测试：`tests/store-degraded.test.js`
  用远端实例造重复端口 → 重开必须成功且只剩一个（修复前抛 `UNIQUE constraint failed`）。
- **一行缺字段拖垮该 home 的整批写入**：node:sqlite 拒绝绑定 `undefined`，抛
  「Provided value cannot be bound to SQLite parameter N」，而它在 `upsertRows` 的事务里 ——
  一行缺字段就让该实例这一轮什么都写不进去。修复：每个绑定点显式 `?? null`。
  **注意**：我第一版是「遍历键把 undefined 换成 null」，那是错的 —— 字段**整个缺失**时键根本不出现，
  所以那种做法兜不住（我自己的测试立刻证明了这一点）。测试：三行里有一行缺字段，三行都必须写入。
- **悬空的工作区归属**：projcache 降级（会话行被保留）+ workspace.json 刷新后删掉了某个 workspace
  时，被保留的行还留着它的 id → `sessionWorkspace()` 返回 null，preview/upload 对一个完全正常的
  会话报「尚未关联可用的 project 工作区」。修复：保留行为存在时清理指向不存在 workspace 的归属。
  关键细节：加 `EXISTS (SELECT 1 FROM workspaces ...)` 这半句 —— workspace.json 缺失/降级时一条
  workspace 行都没有，那种情况下我们**不掌握**清单，不能凭子查询为空就断定链接悬空
  （第一版没有这半句，立刻把另一个测试里正确的归属清掉了）。
  测试：projcache 降级 + 工作区表刷新后，会话归属被清成 NULL，而工作区表本身按新快照刷新。

#### 子进程死后 API 仍报「已连接」；同名实例在图上被合并；未来时间戳只算进汇总（第 10 轮审查）
- **hwb 自己拉起的 `dsh web` 子进程死掉时，共享注册表不更新**（MEDIUM）：卡片显示「已连接」、
  标签页圆点是绿的、iframe 指向一个已经没人监听的端口，服务端「已连接实例」的过滤也照样把它算进去 ——
  直到下一轮心跳（最多 30s）。对照：ssh 隧道退出那条路径早就会把 phase 置为 degraded 并调度恢复。
  修复：子进程 `exit` 时（且仍是当前实例、未 detached）把注册表置为 `stopped` 并清空 pid/url。
  **回归测试**：`tests/launcher-spawn-failure.test.js` —— 起一个长期运行的假 dsh，`SIGKILL` 它之后
  注册表必须立刻是 `stopped`。修复前仍是 `running`。
  （夹具要用「活着等被杀」的假 dsh：让子进程自己退出会触发恢复定时器，测试进程永远等事件循环 ——
  第一版就是这么卡住的。）
- **`usageTrendGrouped('instance')` 会把同名实例合并成一条**（MEDIUM）：标签取
  `basename(homePath)`，而 dsh 的默认 home 目录就叫 `.dsh`，两个实例于是同名 —— 实测
  1000 + 7000 被画成一条 `.dsh: 8000`。修复：标签撞名时补 `homeId` 前缀（`".dsh (6d6d7a)"`）。
- **未来的 `lastActivity` 只算进汇总、被趋势图整条丢掉**（MEDIUM）：桶号会超出
  `[startHour, endHour]`。远端实例时钟偏一点就会触发。实测 `summary=6000 / trend=0`。
  修复：两条趋势查询都用 `MIN(桶号, 末桶)` 夹取（`STRFTIME` 解析不出来时也兜到末桶）。
  实测修复后 summary/trend/grouped 三口径一致。
- **回归测试**：`tests/store.test.js` 各一条；`tests/audit-fixes.test.js` 里那条「SQL 窗口起点」
  不变量断言也要跟着改 —— 它原先取 `args[0]`，而现在查询多了两个参数（夹取用的末桶号），
  改成取参数里的 ISO 时间戳（它拦的是「趋势查询的窗口起点」，不是「第一个参数」）。

#### 迁移失败会让历史用量永久显示 0（src/dshhome/store.js，HIGH）
- **现象**（独立审查第 10 轮，用**真实的 SQLITE_FULL** 复现，不是注入）：旧的迁移闸门是
  「看 `tokInput` 列在不在」，而四个 `ALTER` 各自自动提交（DDL 不在事务里）、回填另起一个事务。
  回填一旦失败（磁盘满、进程被杀 —— 4 万行回填约 60ms，窗口真实存在），列已经存在 ⇒ 下次启动
  那个闸门不会再回填 ⇒ **所有历史用量永久为 0**，没有任何报错、没有 degraded 标记。
  实测：第二次启动 `usageSummary.totalTokens = 0`，而直接对 JSON 跑 `json_extract` 的预言机是
  **82000000**。用户看到的是「总 Tokens / 输入 / 输出 / 缓存命中率」整片归零。
- **修复**：补列 + 回填放进**同一个事务**，用 `PRAGMA user_version` 记录「回填成功」——
  没抬上去就说明没成功，下次启动**幂等重试**；逐列判断缺哪补哪（SQLite 的多语句 `exec` 中途失败时
  **前面成功的语句是保留的**，于是可能出现「四列只加了一两列」的库，那种库会让每个用量查询报
  `no such column`，审查也复现了）；回填表达式与触发器共用同一段 SQL（`TOKEN_COLUMNS_SET`），
  从此不存在「两套算法漂移」（审查实测出 `true`、重复键、十六进制字符串三种输入下结果不同）。
  失败时抛明确错误并退出：**宁可启动失败并说清楚，也不要静默把整段历史显示成 0**；
  报错信息写明「修好权限/磁盘后重启会自动重试（幂等）」。
- **顺带**：`#backfillTokenTotals`（JS 逐行回填）与它那个只用于它的 `tokenTotals()`、以及没有调用方的
  `tokOf(alias)` 一起删掉 —— 「同一件事有两套实现」正是漂移的来源；`upsertRows`/其它几处的
  `ROLLBACK` 也包了 try/catch（磁盘满时 SQLite 已自动回滚，再 ROLLBACK 会抛
  「cannot rollback - no transaction is active」，把真正的错误盖掉）。
- **回归测试**：`tests/store-token-columns.test.js` 两条 —— ①只读库上迁移必须**明确失败**并说明会
  自动重试，修好后重启必须自愈且数字分毫不差（2,222,000）；②「四列只加了一部分」的库必须补全且
  用量查询可用。修复前两条都失败。

#### 上传路径的内存说法与实现不一致（src/lib/multipart.js + src/api/routes.js）
- **问题**（独立审查第 9 轮的旁注，只读观察未测量）：`multipart.js` 头部写着「边解析边写盘，
  内存里只保留可能是分隔符开头的尾巴」，而**路由**把每个 chunk 先推进数组（解析器的 `write(chunk)`
  是同步契约，落盘是异步的，回调里没法 await）。端到端内存因此**不是恒定的**。
  CHANGELOG 的 Notes 里早有一条订正，但**代码注释仍在暗示恒定内存** —— 下一个人读到注释
  会照着它做设计决定。
- **修复**：在 `multipart.js` 头部与路由的解析调用处都写明这一条（含实测数字 64 MiB / 上限 256 MiB），
  并指出「要改成真流式需要让解析器支持异步写入端」。数字不变、行为不变，只是让注释与实现一致。

#### 索引器缺少端点守卫（src/dshhome/indexer.js）
- **问题**：`live-poller` 早有「端点变了就放弃本次实时数据」的守卫
  （`getHome(homeId).activeEndpointId !== home.activeEndpointId`），而索引器这条路径没有。
  用户在索引跑动期间**切换连接端点**时，索引器会把**上一个端点**读到的实时数据写进库 ——
  同一个实例 id、却是另一个 dsh 进程的会话与状态。审查把它标为「机制成立但未在 HTTP 上复现」。
- **修复**：抓取前后各读一次 `activeEndpointId`，变了就丢弃这份实时数据（文件快照来自磁盘，
  与端点无关，照常使用）。与轮询器的守卫保持同一套语义。
- **回归测试**：`tests/indexer.test.js` —— 让实时抓取挂住，期间改写 `activeEndpointId`，
  放行后库里**不得**出现那个 running 状态。修复前失败。

#### 降级 + 实时合并会把文件索引撑起来的会话「洗白」甚至删掉（src/dshhome/store.js，CRITICAL）
- **现象**（独立审查第 9 轮，实测复现）：projcache 域降级时（dsh 升级到不认识的 `unit.version`，
  正是降级路径存在的原因），`normalize()` 产出 0 条会话行，于是 `mergeLiveStatus` 把**每一条**
  实时会话都当成「文件里还没有的新会话」（`liveOnly=1`、title/workspaceId/tokenUsage 全 null），
  与库里**被刻意保留**的那行相撞时把文件值覆盖成空，并把 `liveOnly` 从 0 翻成 1。
  实测：用量统计 1520550 → 620550（**丢 59% 的历史**），会话丢掉标题与工作区归属；
  更要命的是翻成 1 之后，下一次「实时列表为空」的轮询会**把它删掉**（那一分支专门删 liveOnly=1），
  workspace 的 sessionCount 也归零。
- **修复**：`ON CONFLICT` 里做「文件行不被纯实时行覆盖」的条件更新（title/workspaceId/project/
  tokenUsage/contextPressure 保留旧值，`liveOnly` 保持 0），只让 status/lastActivity 照旧取实时值。
- **回归测试**：`tests/store-degraded.test.js` 两条 —— 降级 + 实时合并后标题/工作区/token 历史仍在、
  `liveOnly` 仍是 0、用量统计一分不少；随后「空实时列表」也不得删掉这行。

#### 幽灵会话：实时列表非空时，消失的纯实时行永远不清（src/dshhome/store.js，HIGH）
- **现象**：`liveOnly=1` 的行只由实时列表支撑，但清理只写在「列表**完全为空**」那一分支。
  只要还有任意一条会话活着，先前消失的会话就会一直留着：永远显示「运行中」、占着计数、
  还造出一个幻影项目 —— 实测 70 秒（直到下一轮文件索引），在 projcache 降级时是**永久**的。
- **修复**：非空分支里先把不在本次实时列表中的 `liveOnly=1` 行删掉（逐行删，避免 SQL 变量数上限）。
- **回归测试**：`tests/store-degraded.test.js` —— 两条实时会话 → 移除其中一条 → 库里只剩活着的那条，
  计数同步下降。修复前失败。

#### 索引器用陈旧快照盖掉轮询器刚写的实时状态（src/dshhome/store.js + src/dshhome/indexer.js，MEDIUM）
- **现象**：索引器在读文件之后 `await liveStatus()`（一次 RPC），期间轮询器可能已写入更新鲜的状态。
  实测：dsh 报 running、轮询器刚写「运行中」，索引器随后把它打回「空闲」；整表替换还会删掉窗口内
  新出现的会话（直到下一次轮询才回来）。
- **修复（两处，第一版是错的，值得记下来）**：
  · 先加一层守卫：抓实时状态前记下时间，抓完若发现这期间有实时写入，就丢弃自己这份。
  · 但真正把徽标打回去的是**文件快照**（projcache 的冻结状态，非 null 的陈旧值）——
    而且它走的是「先 DELETE 整表再 INSERT」，`ON CONFLICT` 分支**根本不会执行**，
    我第一版把保留逻辑加在 `ON CONFLICT` 里是**死代码**（实测确认，已删）。正确做法是
    替换前捕获 `status/lastActivity`、替换后写回，且只在「该 home 最近有实时写入」的窗口内这么做
    （通道停了就恢复文件权威，避免退化成「会话永远挂着旧徽标」那个已修缺陷）。
- **回归测试**：`tests/indexer.test.js` —— 索引器的实时抓取挂住 → 期间轮询器写「运行中」 →
  放行索引器那份过期快照 → 状态必须仍是「运行中」。修复前失败。

#### 实时 tokenUsage 的形态没有归一（src/dshhome/live-status.js）
- **问题**：文件侧是带版本包装的 `{ver,seq,val:{totals:{…}}}`，而实时侧把 `values.tokenUsage`
  **原样**透传。若 dsh 给的是同一层包装，我们就会把嵌套结构存进 `sessions.tokenUsage`：
  用量聚合按 `$.uncachedInputTokens` 取值只会得到 0，而且这次实时写入会**覆盖掉文件索引里正确的值**
  —— 正在跑的会话历史用量突然归零。审查把它标为 UNVERIFIED（没有可对照的实例），两种形态都防才是对的。
- **修复**：新增 `normalizeLiveTokenUsage`，三种形态（扁平 / `{totals}` / `{val:{totals}}`）都归一，
  认不出来就返回 null（宁可没有，也不要存一个自己解析不出来的结构）。
- **回归测试**：`tests/live-status.test.js`（新文件）—— 三种形态 + 字符串数字 + 六种垃圾输入。

#### 两处「原因存在但用户看不到」的静默（src/lib/logger.js + src/lib/balance.js）
- **日志轮转失败完全静默**：`rotate()` 里三处 `rename` 各自 `catch {}` —— 轮转失败意味着日志文件
  **无上限增长**，而没有任何人知道。修复：失败时用 `console.error` 提示一次（这里在日志写入通道
  内部，回调结构化 logger 会递归，所以刻意用它），并说明「文件会继续增长」。
- **「凭据文件读不出来」与「没配 key」在界面上长得一样**：`readCredentials` 的 catch 直接
  `return []`，于是权限不足 / 是符号链接 / 超过上限 / 是 FIFO 或目录，全都表现为额度卡片上的
  `key not found`。修复：非 `ENOENT` 的原因记一条结构化 warn（只带相对路径与原因，不带文件内容），
  ENOENT 保持安静（那是正常状态）。
- **回归测试**：`tests/logger.test.js`（把日志目录改成不可写触发轮转失败，断言恰好提示一次且写入
  本身仍成功）、`tests/quota.test.js`（目录当凭据文件 → 一条 warn 且原因写着「不是普通文件」；
  文件不存在 → 一条日志都没有）。修复前两条都失败。

#### 额度失败的原因永远进不了日志（src/dshhome/quota.js + src/lib/balance.js）
- **现象**（我自己复查 `quota.js` 时发现，实测复现）：`logger(scope)` 返回的是**对象**
  （`.warn`/`.error`/…），而 `quota.js` 里两处写成了 `log('...', {...})` 当函数调用 ——
  那会抛 `TypeError: log is not a function`：一处会**打断整批额度的异常处理**（正是那段注释声称
  要隔离的东西），另一处在 per-provider 的 rejection 里，被 `Promise.allSettled` 吞掉。
  实测结果：provider 查询失败时，UI 只看到「余额查询失败」，日志里**一条都没有**。
  更深一层：`balance.js` 的 `logBalanceFailure` 用的是 `process.emitWarning` ——
  它**绕过脱敏管线**（logger 只在自己的写入通道上脱敏），也不进环缓冲/SSE，
  所以界面上的「日志区域」看不到任何原因，用户只能去翻 `service.log`。
- **修复**：两处改成 `log.warn(...)`；`logBalanceFailure` 改走结构化日志（脱敏 + 进 UI），
  并且**只记分类结果**而不是原始消息 —— 分类函数存在的理由就是「技术消息可能带上请求内容」
  （我自己把带 key 的错误消息喂进去，它确实原样进了日志）；`quota.js` 另外记一条带
  `homeId/ref/provider` 上下文的失败日志，并对「没公开余额 API」「还没配 key」两种预期内空状态
  不记（否则每轮刷新都刷屏）。
- **顺带加固**：脱敏原先只认「键名 + 值」两种形态，裸的凭据**形状**（没有 `token=` 前缀）
  认不出来 —— 新增按形状的规则（`sk-` / `sk-ant-` / `ghp_` / `xox*-` / `AKIA` / `dcs_pat_`），
  并断言幂等与不误伤普通文本（`sk- 后面什么都没有` 不动）。
- **回归测试**：`tests/quota.test.js`（失败进结构化日志、带上下文、**不含 key 原文**、
  「还没配 key」不刷屏）、`tests/logger-security.test.js`（裸凭据形状脱敏 + 一条**结构断言**：
  任何从 `logger()` 取到的日志对象都不得被当成函数调用 —— 防的是整类错误；扫描时跳过注释行，
  否则说明这个坏写法的注释本身会被当成违规）。

#### 用量聚合改为派生整数列（src/dshhome/store.js）
- **背景**：上一节用 10s TTL 记忆把「每 3 秒一次」压成「每 10 秒一次」，但**尖峰本身**还在
  （40k 会话一次 ~330ms，而 `node:sqlite` 是同步的，那段时间整个服务停着）。根因是逐行
  `json_extract`：索引层早就是覆盖索引了，慢在解析 JSON。
- **做法**：`sessions` 增加四个派生整数列（`tokInput/tokOutput/tokCacheRead/tokCacheWrite`），
  由 **SQLite 触发器**（`sessions_tok_ai`/`sessions_tok_au`）从 `tokenUsage` 维护 ——
  而不是由 JS 写入。这一点是刻意的：我第一版让 `upsertRows` 负责派生，结果 **6 个既有测试**
  立刻挂了（它们直接裸 SQL 插 sessions，派生列全是 0）—— 那正是「外部工具改库」这个真实场景的
  预演。改成触发器之后，任何写入者（裸 SQL、外部工具）都不会让两列漂移。
- **实测（同一份数据直接 A/B）**：
  · 读：等效 5 条聚合 **175ms → 76ms（2.3×）**；此前按 8 条统计的 40k 场景是 ~330ms。
  · 写：20k 行插入 **43ms → 172ms（4×）**，即每行多一次 UPDATE。
  · 按「每秒阻塞事件循环多少毫秒」算仍是净赚：读侧每 10s 省 ~220ms，写侧每分钟多 ~130ms。
  · 老库升级：`migrate()` 加列后一次性回填（包在事务里），实测 4 万行的库也能在启动时完成。
- **回归测试**：`tests/store-token-columns.test.js` —— ①派生列与 JSON **逐项对拍**，且聚合结果与
  「在测试里现写的旧式 `json_valid`/`json_extract` SQL」**逐项相等**（独立预言机，不是自己对自己）；
  ②老库（删掉派生列）重新打开后必须自动回填且数字与升级前完全一致；③裸 SQL 插入与 UPDATE 之后
  派生列都要跟上，非法 JSON 按 0。修复前三条全失败。
- **顺带**：读路径不再需要 `json_valid` 守卫（`json_extract` 只剩触发器里那几处），
  `tests/bad-json-sql.test.js` 的结构断言阈值随之从 24 降到 8（并注明原因）。

#### `/api/usage` 的 8 个同步聚合把整个服务冻住（src/api/routes.js + src/web/app.js）
- **现象**（独立审查第 8 轮，HIGH）：`node:sqlite` 是同步的，`/api/usage` 一次要跑**八个**聚合；
  用 40k 会话的真实库实测：合计 **~330ms**（summary 38.6 / trend 35.2 / byProject 28.7 /
  grouped 五档 41–51ms）。这段时间里所有 HTTP 请求、SSE 推送、30s 心跳全部停住 ——
  实测在 `/api/usage` 之后 2ms 发出 `/api/homes`，耗时从 9ms 变成 **349ms**（完全被拖住）。
  而前端原先**每次渲染都取一次用量**，渲染又由 SSE 驱动（每 3s 一次），
  于是一个大库的工作台就是「每 3 秒冻一次」。索引层本身已经是覆盖索引
  （`SEARCH sessions USING COVERING INDEX idx_sessions_activity`），慢在逐行 `json_extract`。
- **修复**：
  · 服务端加一层 **10s TTL 记忆**（按 `days:hours` 键，多客户端共享）：实测连续 5 次请求
    **348ms → 1ms,1ms,1ms,1ms**；换一组参数仍会真算（265ms），命中缓存后 `/api/homes` 回到 9ms。
  · 客户端加**15s 节流**（`src/web/components/usage-cache.js`，抽成独立模块以便直测）：
    渲染路径同一周期内复用拿到的数据，只有首次渲染 / 切换周期 / 超出窗口才真正请求。
  · 周期切换补**序号守卫**：`/api/usage` 的耗时随周期变化（30 天比 24h 重得多），
    「先点 30 天、再快点 24h」会让响应乱序返回 —— 原先会把 30 天的数字配着「24h」的高亮画出来
    并污染 `lastUsage`（后续切维度时画出与周期不符的趋势）。
  · 彻底消除尖峰需要把 token 总量落成列（去掉逐行 `json_extract`），那是一次 schema 迁移，
    本轮先把它从「常态卡顿」降为「每 10s 一次且仅当缓存冷时」。
- **回归测试**：`tests/form-draft.test.js` 里的 `usage-cache` 用例（窗口内复用 / 换周期不复用 /
  过期重取 / 主动切换时丢弃）。

#### 趋势图 x 轴按「第几个非空桶」定位（src/web/components/usage-card.js）
- **现象**（独立审查第 8 轮）：空桶被过滤掉之后，23 小时的空白与相邻两小时在图上长得一模一样 ——
  实测数据只在第 1 与第 24 个桶时，两个点被画在 0% 与 100%，中间还被一条平滑曲线连起来，
  读者会以为这段时间是逐步衰减的。
- **修复**：x 按**时间**插值（以整段窗口的首尾桶时间戳为端点），相邻非空桶之间若跨了空桶
  （>1.5 个桶宽）就**断开**折线 —— 不替用户编造中间那段。
- **回归测试**：`tests/web-render-safety.test.js` —— 第 2 个桶必须画在约 4.3%（而非按序号的 50%），
  且跨 21 个空桶处的折线必须断成两条 path。修复前第二个数据点被画在 50%。

#### 前端三处「看不到 / 不清掉 / 被覆盖」的小问题（src/web/app.js + components/log-panel.js）
- **添加实例的告警永远看不到**：`POST /api/homes` 返回的 `warning`（「这个目录看起来不像 dsh home」）
  原先写进表单，而紧接着 `showAddForm = false; refresh()` 会重建整个 dashboard 的 innerHTML ——
  消息被直接抹掉。改挂在持久提示条上。
- **实时通道恢复后断线提示不清**：顶栏写着 `live`、下面还挂着「实时通道已断开，正在重连」，
  而且不补刷新 —— 断线期间错过的 `index:updated` 不会重发，最长要等 30s 心跳。现在恢复时清提示 + 补一次刷新。
- **日志去重键会吞掉不同的日志**：键只有 `ts|level|message`，同一毫秒里「索引该 home 失败」的两条
  （不同 homeId）会被当成重复丢掉一条 —— 用户看到的失败实例少一个。键里加入 `scope` 与 `fields`。
- **新手引导的表单草稿捕获时机**：原先先捕获再 `await /api/homes/detect`，这期间敲的字会被随后的
  重建覆盖 —— 而「不让输入丢失」正是这个模块存在的理由。改为 await 之后、重建之前捕获。

#### 聚合索引页：渲染期没有故障隔离、远端参数没有引号、慢实例会拖住所有实例（dsh-remote-index/dsh-merged-index.mjs）
- **现象**（独立审查第 7 轮，三条都实测复现）：
  · **渲染期会把整页打死**：`card()` 直接用 `s.id.slice(...)`，所以一个数字型 `id`
    （或 `sessions:[null]`）就让 `renderHtml` 抛错 → **整页不写、退出码 1**，
    连旁边健康实例的卡片也一起消失。采集期早就做了隔离，渲染期漏了 —— 与文件自己写的
    「单个实例的抖动不该拖垮看板」直接冲突。
  · **远端参数没引号**：`ssh host cmd a b` 会被远端 shell 重新按空白分段。路径里一个空格就能
    让 `--root` 被拆开（实例静默变「离线」且原因误导），值里有 `;`/`$()` 就直接在远端执行。
    隔壁 `dsh-remote-web.sh` 早就用 `printf '%q'` 处理了同一件事。
  · **「慢」不被隔离**：采集是串行的，而 `spawnSync` 没有 `timeout` —— 一台黑洞主机能让整轮
    卡在系统 TCP 超时上（分钟级），旁边所有实例都不刷新（实测 `--watch 2` 的节奏被一台 6s 的机器拖住）。
- **修复**：①在 `merge()` 这个唯一入口规范化会话条目（`id` 一律转字符串、非对象条目丢掉），
  渲染期不再可能因为一个坏字段整页失败；②远端每个参数过 shell 引号（`shQuote`），
  并补 `-o BatchMode=yes -o ConnectTimeout=10`；③`spawnSync` 加 `timeout` + `killSignal: SIGKILL`
  （可用 `--collect-timeout-ms` 调，默认 60s），超时按该实例的离线原因呈现。
- **回归测试**：`tests/dsh-remote-index.test.js` 三条 —— 坏条目+健康实例必须出图且健康卡片在位；
  慢实例按超时隔离（`sleep 5` 的实例不该拖满 5s）且健康实例仍出图；
  用 PATH 前置的假 ssh 记录远端命令，断言含空格与 `;` 的路径被整体引号包住、且带 BatchMode。
  修复前三条全部失败。

#### dsh-remote-index：一个实例的坏输出会让整轮刷新作废、JSON 模式静默空输出（dsh-remote-index/dsh-merged-index.mjs）
- **现象**：三个独立缺陷，实测复现：
  · 某个实例的 stdout 混入带 `{` 的登录 banner（如 `Welcome to {buildhost} - node 22`）时，
    `parseIndexOutput` 的「从第一个 `{` 开始」兜底也被打穿 → 异常冒到 `tickGuarded` →
    **整轮刷新被丢弃**：旁边完全健康的实例也一整轮不刷新，`--watch` 的 HTML 永远停在旧快照。
  · JSON 模式（无 `--html`）下失败时 **stdout 什么都不输出、退出码却是 0** ——
    `hwb-index > index.json` 的下游得到一个**空的** index.json 且毫不知情。
  · `spawnSync` 默认 `maxBuffer` 只有 1 MiB，而索引 JSON 约 350 B/会话（会话在扁平列表与
    按项目嵌套里各出现一次），约 1.4k 会话就越过上限；ENOBUFS 时 `status` 为 null、`stderr`
    为空，界面上只显示「离线 · **exit null**」——既不说明原因也看不出该改什么。
- **修复**：①`collectInstance` 把解析失败收敛成该实例的 `error`（与 ssh 非零退出同一条路），
  故障隔离在实例粒度；②JSON 模式失败时输出结构化失败文档（`{error, offline, projects, sessions,
  resources}`）并置退出码 1，让「空文件 + 成功」不再可能；③显式给 `maxBuffer` 256 MiB，
  并把 `res.error` 单独处理（ENOBUFS 时说明「索引输出超过 maxBuffer 上限」）。
  另外顺手处理 stdout 的 EPIPE（`… | head` 是正常用法，不该崩在未捕获异常上）。
- **回归测试**：`tests/dsh-remote-index.test.js` 三条 —— 坏实例与健康实例并存时健康实例必须在
  `resources` 里、坏实例单独进 `offline`；>1 MiB 的索引实例必须在线（用例里先断言夹具输出
  确实超过 1 MiB，避免这条测试自己变成空测试）；instances.json 缺失时必须非零退出且
  stdout 是可解析的失败文档。回退后三条全部失败（第二条的错误信息正是 `exit null`）。

#### 远端实例的上传整条通道不可达（src/api/routes.js + src/lib/file-preview.js）
- **现象**：远端实例上传**永远 400**，而本机实例正常。实测：本机 `200` / 远端
  `400 {"error":"ENOENT: no such file or directory, realpath '/home/bot/projects/remote-project'"}`。
  也就是说 v0.1.1 里那套花了大力气加固的远端上传（512 KiB 分片、远端 mktemp、
  `realpath+commonpath` 校验、失败清理）**没有任何一条路径能走到** —— 前端传多少文件都进不来。
- **根因**（两处，都要修才算真的通）：
  ① 路由在读完请求体之前无条件调用 `resolveUploadDir(workspace.path, dir)`，而它做的是**本地**
     `fs.realpath`；远端实例的 `workspace.path` 是**远端主机上**的路径（由 `indexRemoteHome`
     通过 ssh 读回来），拿它本地 realpath 必然 ENOENT。
  ② 远端分支最后还有一句 `await resolveUploadDir(root, dir)`：即使预检过了，分片全部传完之后
     仍会在这一步失败 —— 失败点推到最后，用户看到的是「传完了但报错」。
- **修复**：预检只对本地实例做（`if (home.hostType !== 'remote')`）；远端的目标目录校验完全交给
  `REMOTE_FINISH_PY` 在**远端主机上**用 `realpath+commonpath` 完成（那才是有效校验），
  返回的 `dir` 由远端返回的绝对路径取父目录得到。同时把 ssh 执行器抽成 `createRouter`/`createApiServer`
  的 `remoteExec` 依赖 —— 让这条链路第一次能在路由级测试里被真正走一遍。
- **回归测试**：`tests/file-upload.test.js` 两条：①远端路径**在本机不存在**时（审查给出的原始场景）
  配按协议应答的假执行器，必须 200 且调用过远端 `mktemp`；②用真实 bash 充当远端，断言文件真的
  落盘、返回的 `dir` 来自远端解析。只回退「预检」这一行，用例①立刻复现审查给出的那条 ENOENT。

#### 0 字节文件在远端永远传不上去（src/lib/file-preview.js）
- **现象**：本机能传空文件（`.gitkeep`、空 csv），远端固定 400「没有收到上传数据」。
  批量上传时更糟：前面几个文件已经落到远端目录里了，这个空文件把整批打断。
- **根因**：multipart 解析器对一个空文件**不会产出任何 chunk**，于是分片阶段一个字节都不发，
  远端 `merged` 目录为空 → `REMOTE_FINISH_PY` 的 `if not parts: raise` 判定为「没收到数据」。
  而 `if not parts` 这条检查本身是必要的（分片真的丢了必须报错），所以不能直接删。
- **修复**：把期望字节数一并传给远端（`total`），0 字节时创建空文件；
  期望非 0 却仍无分片时才报错。区分了「这就是个空文件」与「分片丢了」。
- **回归测试**：`tests/file-upload.test.js` —— 空文件在远端与本机行为一致（size 0、落盘为空），
  同时用「吞掉分片」的假执行器确认「期望 5 字节却零分片」仍然报错。回退该修复后用例失败。

#### 相对的 `HWB_DIR` 下 `status`/`stop` 找不到服务，还在仓库里落下状态目录（src/cli.js）
- **现象**（独立审查提出，实测复现）：`HWB_DIR=relstate hwb start` 之后，`status` 输出 `stopped`
  （退出码 1）而服务其实在 4399 上正常返回 200；`stop` **永远停不掉它**，还会误报
  「很可能是前台运行的 `hwb serve`」。同时仓库根下多出一个 `relstate/` 目录，里面有
  `service.sock` —— 一台机器上就这么出现了一个谁也管不着的后台服务。
- **根因**：`serviceDir` 是**各进程自己**用 `path.resolve(process.env.HWB_DIR || …)` 算的，
  而后台服务由 `spawn(..., { cwd: root })` 拉起：CLI 解析成 `<当前目录>/relstate`，
  子进程解析成 `<仓库根>/relstate`。两个目录各有各的 socket，于是 CLI 与服务的「世界」分开了。
- **修复**：`start()` 把**解析后的绝对路径**作为 `HWB_DIR` 传给子进程，两边永远指向同一个目录，
  与 cwd 无关。
- **回归测试**：`tests/cli.test.js` —— `cwd` 设在临时目录、`HWB_DIR=relstate` 时，
  `start` 后 `status` 必须报 running、`stop` 必须真的停掉，并且仓库根下**不得**出现 `relstate`。

#### 间隔与端口没有上界，可以被悄悄退化成 1ms 空转（src/lib/service-config.js + src/server.js）
- **现象**：`hwb config set intervalMs 9999999999999999` 原样通过校验（它确实是个整数值）。
  而 `setTimeout` 的延时上限是 `2^31-1`：**超过它不报错**，只打印一行 `TimeoutOverflowWarning`
  然后按 **1ms** 处理 —— 于是「把间隔调大」变成「每毫秒跑一轮索引与心跳」，CPU 打满。
  命令行那条门更松：`hwb serve --interval-ms abc` 根本不校验，`Number('abc')` → NaN → 同样 1ms；
  `--port abc` → `listen(NaN)` 在部分平台会绑到随机端口，用户看到的端口号就成了假的。
- **修复**：新增 `src/lib/timers.js` 导出 `MAX_TIMER_MS = 2^31-1`；配置校验与 `parseArgs`
  都用它设上界（`--port` 上界 65535），越界时明确报出「收到什么」并以退出码 2 结束。
- **回归测试**：`tests/cli.test.js` —— 超大的 `intervalMs` 必须被拒绝**且不写进配置**，
  `serve --interval-ms abc` / `--interval-ms 1e16` / `--port abc` 都必须以非零码退出并说明原因。
- **顺带**：`tests/cli.test.js` 的 upgrade 夹具改为整个 `src/lib` 目录一起复制 —— 它原先逐个列
  文件名（`service-config.js` + `node-version.js`），这次新增 `timers.js` 又把它打破了一次
  （`ERR_MODULE_NOT_FOUND`）。复制目录后新增依赖不会再来一次。

#### 启动失败会报「上一次」的原因（src/cli.js）
- **现象**：上一条修复引入的 `failureDetail()` 从日志**开头**往后找第一条 `hwb:` 提示就收工，
  而 `service.log` 是 append-only 的、历次启动的提示都留在里面 —— 于是本次死于端口占用时，
  终端会打出**上一次**数据库损坏的提示，让用户去改一个跟当前问题毫无关系的路径。
  独立审查给出的复现：日志开头塞一条旧的 `无法打开数据库（/tmp/OLD-backup/hwb.db）`，
  再用假监听占住端口启动 —— 终端显示的是数据库那条，真实原因（端口占用）4 行之后才出现在文件里。
- **修复**：改为**从后往前**找最后一个 `hwb:` 提示块。
- **回归测试**：`tests/cli.test.js` —— 先写入历史提示、再制造端口占用失败，断言终端报的是
  「已被占用」且**不含** `OLD-backup` / 「无法打开数据库」。修复前该用例失败。
- **注**：这条 bug 是我上一条修复自己引入的，由独立审查在它被提交后几分钟内发现。
  教训写进注释：这类「从日志里挑一句给用户看」的逻辑，取哪一条本身就是语义的一部分。

#### 启动失败时终端只说「启动失败 (N)」，原因埋在日志里（src/cli.js + src/server.js）
- **现象**：数据库损坏时终端只得到「`hwb: 启动失败 (2)，查看 …/service.log`」；端口被占用时
  同样只有「启动失败 (1)」。用户必须去打开那个文件才知道到底怎么了。
  更糟的是端口这一种：日志尾部是 **4 行栈帧**，真正的原因
  （`Error: listen EADDRINUSE: address already in use 127.0.0.1:4393`）在栈帧**上一行**，
  照「只截尾几行」的直觉刚好被挡在外面 —— 实测就是这个输出。
- **根因**：① `server.js` 只在数据库路径上写了可照做的 `hwb:` 提示，端口占用走的是裸
  `error` 事件；② `start()` 只把日志文件路径告诉用户，从不把内容带回终端。
- **修复**：
  · `server.js` 增加 `server.on('error')`：`EADDRINUSE` 时打出可照做的提示
    （说出端口、可能是另一个实例、`hwb config set port <新端口>`、`lsof -i :<port>`），
    并以退出码 3 结束（原来冒成裸异常、退出码 1）。
  · `cli.js` 在启动失败/超时时把日志里的 `hwb:` 提示块（含缩进续行）直接带回终端；
    没有提示块时退回日志尾部，但**先丢掉栈帧**再取最后几行，并按 300 字符截断超长行。
    两条路径都仍然指出完整日志的位置。
- **回归测试**：`tests/cli.test.js` —— ①占用端口启动失败时，终端输出必须含端口号与
  「已被占用」，且**不得只有栈帧**②数据库损坏时终端输出必须含路径与「无法打开数据库」。
  修复前这两条都失败。

#### 残留的启停锁会让 `hwb start/stop/restart` 全部失效（src/cli.js）
- **现象**：一条启停命令被 `kill -9`（或机器断电）之后，`service.lock` 留在原地，
  此后 **start / stop / restart 全部失败**，只留一句「另一个启停命令持有 …/service.lock；
  若命令曾异常退出，请确认没有启停操作后删除此锁文件」。用户得自己找到那个隐藏文件才能把服务救回来。
  实测复现：写入一个残留锁 → `hwb start` 退出码 1、服务起不来。
- **根因**：锁用 `wx` 独占创建、`finally` 删除，但**只判断「文件存在」，不判断「持有者还活着」** ——
  而锁文件里本来就写着持有者的 PID（`writeFileSync(fd, String(process.pid))`），信息一直有，只是没用。
- **修复**：`wx` 失败时读锁里的 PID，用 `process.kill(pid, 0)` 判断存在性（`EPERM` 算活着，
  只有 `ESRCH` 才算死），确认持有者已不存在才接管：删掉这一个锁文件后重试一次 `wx`。
  判定方向刻意保守 —— 把「活着」误判成「死了」才会去抢锁，所以宁可误判为活着。
  空锁文件（上次在 `openSync` 与 `writeFileSync` 之间被杀）同样算残留。接管时会打印一行
  `warn` 说明「发现残留启停锁（PID … 已不存在），已接管」，不做静默接管。
  两个并发接管者仍只有一个能 `wx` 成功，另一个如实报「被占用」。
- **回归测试**：`tests/cli.test.js` —— ①持有者已死的残留锁应能自动接管并成功启动
  ②空锁文件同样接管 ③持有者**活着**（用测试进程自己的 PID）时必须照旧拦住，
  防止新逻辑变成「谁都能抢锁」。修复前①失败。

#### 实时轮询里**第二次**读实例列表抛错会直接弄崩进程（src/dshhome/live-poller.js）
- **现象**：`listHomes()` 一旦抛错（例如数据库里某行 JSON 列坏了），整个工作台消失 ——
  crash handler 走 `process.exit(1)`。
- **根因**：`tick()` 只给**第一次** `this.homes()` 套了 try/catch，而 `refresh(homeId)` 内部
  **还会再读一次**（取 `activeEndpointId`）。那次同步抛错落在同一个 `setInterval` 回调的
  同步段里，绕过了唯一的保护。实测：让 `homes()` 第二次调用抛错，`start()` 直接抛出。
- **修复**：逐个 `refresh` 也兜住（失败只跳过该实例，并记录 homeId）；`refresh` 内部自己
  兜住 `homes()`，保持「返回 promise」的契约；顺带拒绝非数组返回值
  （原实现 `for (const home of null)` 会抛 TypeError，同样是致命路径）。
- **回归测试**：`tests/live-poller.test.js` 两条 —— `homes()` 第二次调用抛错、`homes()`
  返回 `null`。修复前两条都失败（`start()` 抛出）。

#### 元数据读取的 lstat→open 窗口（TOCTOU）（src/lib/read-home.js）
- **问题**：`readMetadataFile` 先 `lstatSync` 判身份、再 `openSync` 打开 —— 查的是**路径**，
  打开的却是**另一个瞬间的对象**。窗口内被换成符号链接就能把 home 之外的文件读进来
  （持久化进 hwb.db 并展示给浏览器），被换成 FIFO 就能把进程永久卡住。
  现实中这个窗口没有复现出来（272,889 次尝试 0 泄漏），但它是真实存在的。
- **修复**：三道防线叠加 —— `O_NOFOLLOW`（换成符号链接直接 ELOOP）、`O_NONBLOCK`
  （换成 FIFO 也不会挂住）、以及**以 fd 为准**的 `fstatSync(fd)` 复核身份与大小。
  最后一步没有竞态，是唯一能真正关掉窗口的检查。
- **回归测试**：`tests/read-home.test.js`。**说实话**：这个窗口没法在测试里稳定撞上（要精确
  控制时序），所以测的是①不被误伤（硬链接仍是普通文件、照常读）②**加固代码本身不被悄悄
  删掉** —— 一条源码级不变量断言：`openSync` 必须带 `O_NOFOLLOW`，且 `fstatSync(fd)`
  必须发生在 `readFileSync(fd)` 之前。删掉加固该用例立即失败。

#### README 路由双向校验漏掉「非 homes 族」的参数化路由（tests/docs-consistency.test.js）
- **问题**：解析器写死了 `pathname.match(/^\/api\/homes\/([0-9a-f]{16})` 这一族。
  今天确实所有参数化路由都在这一族里，但只要以后新增别的族（如
  `/api/sessions/([0-9a-f]{16})/xxx`），它会被**静默漏掉双向检查**：README 不写它不报错，
  写了也不校验。
- **修复**：改成通用解析所有 `pathname.match(/^...$/)`：`([0-9a-f]{16})` → 占位符
  （homes 族叫 `{homeId}`，其它族叫 `{id}`，免得逼着 README 把会话 id 写成 homeId）、
  `(a|b)` 展开成多条、其它捕获组显式标成 `{...}`（宁可让 README 对不上而报错，也不静默跳过）。
  并新增一条**反向校验**：源码里每个 `/api` 匹配器都必须能被某条解析结果的具体化实例匹配上 ——
  新增一族而解析器漏掉时立即失败。
- **顺带修掉一个自造的假测试**：第一版通用解析把 `api/` 判断写在了反转义**之前**，
  转义后的文本里只有 `api\/`，于是永远匹配不上、提取出 0 条，测试恒过。已在注释里写明。
- **回归测试**：临时往 `routes.js` 插一个 `/api/sessions/([0-9a-f]{16})/close`，
  该用例确实报「README 缺少已实现的路由」；而旧的解析器对这条路由完全无感。

#### 两处「看起来在测、其实测不到」的测试（tests/hostile-env.test.js）
- **并发上限**：原测试只断言 `new Indexer({concurrency: 99}).concurrency === 8`（构造函数里的
  clamp），完全没碰线程池 —— 把 `#runAll` 的 `Math.min(this.concurrency, due.length)` 改成
  `due.length` 照样通过。现改为用可注入的 `remoteExec` 真正量一次同时在飞的实例数
  （峰值必须恰好为 3；去掉上限则实测峰值 9）。
- **索引顺序**：原测试断言「实时状态生效」，但状态字段上实时值**总会**赢，两种顺序都能通过。
  现改为让 `liveStatus` 被调用时把 projcache 里的**标题**改掉，再用只有文件能提供的 `title`
  作判据：正确顺序入库 `FILE-OLD`，反序入库 `FILE-NEW`。把顺序改回去该用例确实失败。
- 同时修正 CHANGELOG 与两处源码注释里「窗口收敛到 0」的过度声称：改进是确定的（那段本该最短的
  间隔里不再夹着一次完整的文件读取），但**不是**严格的 0 —— 实时抓取本身要等一次 RPC，
  若另一个更早发起的抓取恰好在这期间返回并写库仍可能被覆盖，根治需要版本号/时间戳。

#### CHANGELOG 的结构完整性（tests/docs-consistency.test.js）
- 一次替换把 `#### 预览代理的建立竞态…` 的**标题行**连同空行一起删掉了，于是那条修复的正文
  变成挂在上一篇末尾的孤儿 —— 读起来像「上一条的附带说明」，而且没有任何测试会红。
  新增结构测试：`[Unreleased]` 段内**连续两个空行之后直接跟列表项**即失败
  （正常排版不会这样，而「标题被删」恰好留下这个形状）。写出来立刻又抓到第二处同类断裂。
  重新制造该损坏可复现失败。

#### 死代码：multipart.js 里两个没人用的常量（src/lib/multipart.js）
- `close`（= delimiter）与 `end`（= `${delimiter}--`）自重构后就没有任何引用，注释还写着
  「field 状态用它找 part 尾巴」（已经不成立）。删除，免得下一个人照着不存在的用法改。

#### 一行坏 JSON 就让整个用量面板 500（src/dshhome/store.js）
- **现象**：`sessions.tokenUsage` 只要有一行不是合法 JSON（外部工具改过库、或写入中途断电），
  `GET /api/usage` 与 `GET /api/projects/recent` 直接 500，前端整块用量面板与项目列表一起空掉；
  而**同一个坏值**在会话列表里是正常降级的（`safeJsonParse`）。
- **根因**：`json_extract` 遇到非法 JSON 会让**整条 SQL** 报 `malformed JSON`。读路径上的
  `safeJsonParse` 只保护「行 → 对象」的映射，管不到 SQL 聚合这一层 —— 一层保护，两处入口。
  实测：插入一行 `'not json at all'` 后，`usageSummary` 立刻抛错。
- **修复**：`store.js` 里全部 24 处取值统一写成
  `CASE WHEN json_valid(x) THEN json_extract(x,'$.k') ELSE NULL END`（外层再 COALESCE 成 0）：
  非法 JSON 视同「该字段不存在」，按 0 计入，而不是让整块面板不可用。
- **回归测试**：`tests/bad-json-sql.test.js` —— 用**真 HTTP 服务端 + 真 IndexStore** 造一行坏
  JSON，断言 `/api/usage` 与 `/api/projects/recent` 都 200，且坏行按 0 计入、好行照常统计。
  修复前这 4 个用例全部失败。另加一条**结构测试**：扫描 `src/**/*.js`，任何一处
  `json_extract(` 若同行没有 `json_valid(` 就报错 —— 防止以后再漏一处入口。

#### 分组趋势图把「只记了部分 token 字段」的会话整行丢掉（src/dshhome/store.js）
- **现象**：`usageTrendGrouped` 的合计比 `usageSummary` 少。实测同一份数据：
  summary/byProject = 333，分组趋势 = 113（少了 220）。
- **根因**：分组趋势的桶值是 `SUM(a + b + c + d)`，四个加数**没有逐项 COALESCE**。
  dsh 写 tokenUsage 时不一定带全部四个键，缺一个键 → 整个相加为 NULL → `SUM` 忽略该行 →
  这行的 220 个 token **静默消失**（不报错，只是数字不对，最难发现的那类）。
- **修复**：与其他四处查询统一为逐项 `COALESCE(..., 0)`。
- **回归测试**：`tests/bad-json-sql.test.js` 的「四套口径一致」用例 —— 造一行完整、一行缺两个
  键、一行坏 JSON，断言 summary / trend / trendGrouped / byProject 四者总量全部相等（均为 333），
  且 `totalTokens` 恒等于四项之和。修复前该用例失败（113 ≠ 333）。

#### 分时趋势的查询窗口比它的桶更宽，边界段被「查出来又丢掉」（src/dshhome/store.js）
- **现象**：`usageTrend` 只产出整点对齐的桶，但 SQL 窗口从 `now - hours*3600_000` 起，
  比首个桶的起点早 `H - (now mod H)`。落在这段里的行被查出来、却没有任何桶能放它，
  于是被静默丢弃 —— 白查一趟，而且与 `usageTrendGrouped`（窗口与桶严格对齐）在同一条
  边界上口径不一致。
- **根因**：窗口起点与桶范围各自计算，没有共用同一个对齐基点。
- **修复**：先算 `startHour`，SQL 窗口起点直接取 `startHour * 3600_000`，与桶范围完全重合
  （取出的每一行都必定有桶）。这是**无行为变化**的修正：那段行本来也没出现在返回值里。
- **回归测试**：`tests/audit-fixes.test.js` 的「SQL 窗口起点与首个桶重合」用例。
  这个错位在输出上根本看不出来（桶本来就是那个样子），所以用一条**不变量**测试钉住查询参数：
  拦截 `db.prepare`，断言传给分桶查询的起点参数 `=== trend[0].ts`。修复前该用例失败。

#### 凭据文件是 FIFO 时整个工作台永久卡死（src/lib/balance.js）
- **现象**：`~/.dsh/.credentials.yaml` 若是 FIFO（命名管道），进程会永久阻塞：端口根本没 bind、
  `SIGTERM` 无效，只能 `kill -9`。与 `read-home.js` 修过的是同一个故障模式，但凭据这条路径漏了。
- **根因**：`readCredentials` 用裸 `readFileSync`。致命之处在于它的调用链
  `GET /api/quota` → `QuotaService.#hasStale()` → `refresh()` → `readCredentials()`
  **一路没有 await**，所以这是一个同步阻塞整个事件循环的操作 —— 连日志都写不出去。
  实测：同款读取路径在修复前的最坏同步阻塞是 5725 ms（`read-home.js` 那条，可见）而凭据这条
  从不返回；修复后探针里 `readCredentials` 0 ms、`QuotaService.refresh()` 1 ms 即降级返回。
- **修复**：改用 `read-home.js` 的 `readMetadataFile`（`lstat` 拒绝非普通文件/符号链接、
  `64 MiB` 上限、`O_NONBLOCK` 打开），顺带获得与元数据读取一致的加固。
- **回归测试**：`tests/hostile-env.test.js` 用真 `mkfifo` 造 FIFO，断言 `readCredentials` 与
  真实调用链 `QuotaService.refresh()` 都在 2s 内返回并降级。修复前该用例**永久挂住**
  （只能被 `timeout` 杀掉）—— 这本身就是那条 bug 的直接证据。

#### 带 BOM 的凭据文件会被解析成「一个 key 都没有」（src/lib/balance.js）
- **现象**：把 `.credentials.yaml` 存成带 BOM 的 UTF-8（Windows 编辑器、部分脚本的默认行为），
  配额面板整块变空 —— 实例明明配了 key，界面显示没有。
- **根因**：JS 的 `\s` 匹配 U+FEFF，于是 `\uFEFFrefs:` 走错分支、`inRefs` 永远为 `false`。
  `read-home.js` 的 `parseCredentialsYaml` 已经剥过 BOM，两条解析路径因此结论不一致。
- **修复**：`readCredentials` 读入后剥掉前导 BOM，与 `parseCredentialsYaml` 保持一致。
- **回归测试**：`tests/hostile-env.test.js` —— 同一份内容带/不带 BOM 各解析一次，
  断言两条路径给出的 ref 列表完全相同。

#### 预览代理的建立竞态会留下孤儿监听端口（src/control/launcher.js）
- `#withPreview` 会 `await createProxy(...)`，而 `disconnect` 只能关掉「当时已经存在」的
  `inst.previewProxy`；`previewPending` 只是作废了一个引用，管不到那个已经跑起来的 Promise。
  于是「代理还没就绪时实例被断开/移除」会让刚 bind 成功的端口没人持有，一直留到进程退出。
  API 层的 `connecting` 集合挡住了大部分并发，但 Monitor 的移除清理与端点切换不走它。
- **修复**：代理就绪后检查实例是否已失效（`detached`/`cancelled`/已不在 `procs` 里），是则自己关掉。
  同时把 `createProxy` 做成可注入的 `proxyFactory`（与既有的 `tunnelFactory`/`waitHttp` 一致），
  否则这个竞态窗口无法在测试里复现。
- **回归测试**：`tests/launcher-release.test.js` —— 注入一个「挂着不返回」的工厂，在挂起期间断开实例，
  再放行工厂，断言新代理被关闭且不会挂到已断开的实例上（移除该保护后测试会失败）。

#### 后台索引路径上的两处未处理拒绝（src/dshhome/indexer.js + src/api/routes.js）
- `Indexer.#tick()` 只用 `.finally()` 收尾（与 Monitor 心跳同款问题）：`#runAll` 一旦抛错就变成
  每轮一次的 unhandledRejection，被 crash handler 记成 fatal 并掩盖真因。补 `catch` + warn。
- 4 处 `indexer.reindexNow(...)` 是刻意的 fire-and-forget（远程要等 SSH 超时，不能阻塞响应），
  但「不 await」不等于「不管」：返回的 promise 一旦拒绝同样产生未处理拒绝。
  统一走 `reindexInBackground()`，并容忍「同步抛出」与「返回 undefined」两种实现。


#### 拖拽排序提交的是「部分顺序」，会把刚排好的顺序打乱（src/web/app.js）
- `handleDragEnd` 只从 DOM 里读 `tab[draggable=true]` 的顺序，而 DOM 里只有 `tabHomes`
  （运行中 / 仍持有入口的实例）—— 未连接的实例不在其中，但 `sortIndex` 是**全局**的。
  于是 `setHomeOrder` 只给可见的那批写 0..k-1，隐藏实例保留旧索引并与新索引撞车，
  刷新后 `ORDER BY sortIndex` 把用户刚排好的标签页再次打乱；同时 `lastHomes` 被裁成可见子集，
  Instances 栏里的其余实例要等下一次刷新才回来。
- **修复**：提交全量顺序 —— 可见的按 DOM 顺序在前，其余保持原有相对顺序跟在后面。

#### 实例/会话行只能鼠标点击，键盘用户无法钻入（src/web/app.js + recent-*.js）
- Recent Projects / Recent Sessions 的行是 `<div class="row clickable">` 配一个委托到 `body`
  的 click 处理器：没有 `tabindex`、没有 `role`，Tab 键够不到，也没有 Enter/Space 激活路径。
- **修复**：行上补 `role="button" tabindex="0"`，并在 `app.js` 里对同一批 `[data-action]` 元素
  加 Enter/Space 委托（只处理焦点就在该元素上的情况，不劫持内部控件的按键）。

#### 我自己引入的重复方法定义（src/dshhome/store.js）
- 第 4 轮把 `getHome` 从 `listHomes().find(...)` 改成点查时，新实现被插到 `listHomes` 旁边，
  **旧的那份留在原处没删**。JS 里后定义会静默覆盖先定义：行为是对的（测试全绿），
  但文件里躺着一份永不执行的旧实现 —— 下次有人改上面那份，会以为改的就是真正生效的那个。
- **修复**：删掉死代码。**并补一条结构性测试** `tests/no-duplicate-methods.test.js`：
  扫描 `src/**/*.js`，同一个类里出现重复方法名即失败（同时自带扫描器自身的正/反向用例，
  避免它退化成永远通过的假测试）。

#### 实时列表变空时工作台仍显示上一个会话的「运行中」（src/dshhome/store.js + reader.js）
- 一次**成功**的实时读取返回空数组，含义是「dsh 当前没有会话」——这与读取失败（poller 传 `null`，
  根本不会调到 `applyLiveStatus`）是两回事。原先空数组被直接 `return`，于是**纯实时行**
  （文件索引里还没有它、只有 RPC 支撑的那些）会一直留着：用户在 dsh 里关掉全部会话后，
  工作台仍显示上一个会话的「运行中」徽标，要等 60s 后的文件索引才纠正。
- **修复**：给 `sessions` 加 `liveOnly` 标记（`mergeLiveStatus` 补插的行置 1，文件索引的行置 0），
  空实时列表时只删 `liveOnly = 1` 的行 —— 有文件索引支撑的会话不受影响，它们的权威来源是文件索引，
  不该被实时列表的缺失误删。已有库通过 `ALTER TABLE` 补列，历史行默认 0（最保守）。
- **回归测试**：`tests/live-empty-clear.test.js` —— 空列表清掉纯实时行但保留文件会话、
  读取失败（非数组）不产生任何清理、dsh 再次报告时能重新补插、文件索引正式收录后不再被删。

#### 远端是 macOS/BSD 时端口检测恒为「未监听」，实例却报 running（src/control/remote.js）
- **现象**：`listening()` 只用 `ss -tln` / `netstat -tln`，`killport()` 只用 `fuser` —— 三者都是
  Linux 专有。远端若是 macOS，检测恒为 false、回收是空操作：`ensure` 模式于是跳过「复用已在跑的服务」
  又去起一个新 dsh（端口被占起不来），日志轮询等满 40s 拿到 `__NO_TOKEN__`，最后 hwb 把这个实例
  报成 `running` —— **仪表盘一片绿，iframe 里是 401**。
- **实测复现**（本机 macOS，起一个真实监听后对比）：
  `{ ss || netstat -tln; } | grep :<port>` → NOT_DETECTED，`lsof -nP -iTCP:<port> -sTCP:LISTEN` → DETECTED。
- **修复**：`lsof` 在 macOS 与 Linux 上都有、输出形态一致，改为首选分支；缺失时才退回 ss/netstat。
  `killport` 同样先用 `lsof -t` 取 pid 再逐个 `kill`（不用 `xargs -r` —— BSD 的 xargs 没有这个 flag）。
  旧脚本 `scripts/dsh-remote-web.sh` 早就因为同样的原因用了 lsof。
- **回归测试**：`tests/remote-port-detect.test.js` —— 把脚本里的 `listening()`/`killport()` 抽出来在
  真 bash 里跑：真实监听 → DETECTED、空闲端口 → NOT_DETECTED、缺工具环境 → 如实退化、
  `killport` 真的回收端口（起一个独立子进程当靶子）。

#### 旧版 dsh 能远端连、本机连不上（`--no-open`，src/control/launcher.js）
- `--no-open` 是**新版** dsh 才有的参数。`remote.js` 早就为此在远端路径里刻意不发它，
  但本机路径一直硬发 —— 同一台旧版 dsh 于是「远端能用、本机报 unknown option '--no-open'」。
- **修复**：识别到该错误时摘掉参数重试一次（不带 `--no-open` 最多多弹一个浏览器标签，远比连不上好）；
  与 `--no-open` 无关的启动失败**不**重试。
- **回归测试**：`tests/launcher-no-open-compat.test.js` —— 假 dsh 见到 `--no-open` 就退出 2、
  否则正常起服务并打印 token 行；断言旧版路径重试成功后拿到 token、新版路径只被调用一次、
  其它错误不触发重试。

#### nginx 缓存配置给每个普通请求都强加 `Connection: upgrade`（scripts/dsh-http-cache.nginx.conf）
- 原先在 `location /` 里无条件 `proxy_set_header Connection "upgrade"`：页面、JSON、SSE 等普通
  请求全都带着 `Connection: upgrade` 发给上游，既不符合 HTTP 语义，也让 nginx 无法对上游做
  keep-alive（每个请求新建连接）。改为 `map $http_upgrade $connection_upgrade`，按请求决定。
- 同时把那两个配置脚本补齐到 `scripts/README.md` 的文件表里（原先只列了 2 个，实际 5 个），
  并在 `README-http-cache.md` 说明 nginx 版的 `map` 块属于 http 上下文、放错层级会报
  `"map" directive is not allowed here`。

#### 测试自身的脆弱点：`withListening` 匹配单行字面量（tests/remote.test.js）
- 它用一行字面量替换脚本里的 `listening()`；该函数一旦改成多行（本次就是），替换会**静默失配** ——
  stub 没生效、真实检测照跑，测试仍然跑但测的已不是它以为的东西。这恰好在本机暴露为失败
  （真实 lsof 检测到 3080 上确实有服务在跑）。改为整段正则替换。

#### SSE 刷新会清空「添加实例」表单并抢走焦点（src/web/app.js + src/web/components/form-draft.js）
- **现象**：dashboard 每轮刷新都整块重建 `innerHTML`；有实例在跑时 live-poller 约每 3s 广播一次
  `index:updated`，于是重建后插入的是一个**全新的空表单**，且无条件 `.focus()` 到 `homePath`。
  用户输入的路径/别名每 3s 被清空一次，这个表单实际上填不完。
- **修复**：抽出 `src/web/components/form-draft.js`，在重建前记下各控件值 + 焦点 + 光标位置，
  重建后原样恢复（只在「本来就没在表单里输入」时才回落到旧的聚焦行为）。光标位置一并还原，
  否则每 3s 光标就跳到末尾，「在中间补字」依然不可能。
- **顺带减少重建次数**：SSE 事件合并到 120ms 窗口内只刷一次（一次索引更新会连着广播
  `index:updated`/`instance:status`/`monitor:updated`）。
- **回归测试**：`tests/form-draft.test.js`（值/焦点/光标还原、复选框、未出现字段保持默认值、
  `setSelectionRange` 对 number 输入框抛错不影响恢复）。

#### 单个接口失败会清空整个工作台且没有任何提示（src/web/app.js + src/web/index.html）
- `renderDashboard` 用了 `Promise.all`：`/api/usage` 一个 500 就会让 `Promise.all` 拒绝，
  于是**项目 / 会话 / 实例 / 日志四栏一起变空**，而且屏幕上不会出现任何错误信息；
  `subscribe(() => refresh())` 与 `goDashboard()` 里的 `refresh()` 都没有 catch，
  每次失败还会产生一个未处理的拒绝。
- **修复**：改为 `Promise.allSettled`，失败的栏目退化为空态、其余照常渲染；
  顶部新增 `#note` 提示条（挂在 dashboard 之外，不会被每轮重建清掉）说明具体哪个接口失败；
  所有 fire-and-forget 的 `refresh()` 都接上 `catch`。

#### getHome 是 listHomes().find(...)，实时轮询因此有 O(N²) 的同步阻塞（src/dshhome/store.js）
- `listHomes()` 对每个实例都要跑 providers / activeTier / currentSession 三条语句加两次
  `JSON.parse`；而 live-poller 每约 3s 会对每个实例调用多次 `getHome`。实测 12 实例：
  `getHome` 0.294 ms（与 `listHomes` 同价）、一次轮询 tick 约 13.9 ms 的**同步**阻塞
  （node:sqlite 是同步 API，直接卡住事件循环：SSE、HTTP、监控心跳一起等）。
- **修复**：`getHome` 改为真正的点查（复用同一段 SELECT，只多一个 `WHERE homeId = ?`），
  预编译语句挂到实例上复用。实测 `getHome` 0.029 ms（约 10×），一次轮询 tick 降到 1.1 ms。
- **回归测试**：把 `listHomes` 换成一调用就抛，断言 `getHome` 仍然可用且派生字段一致。

#### dsh 版本升级会静默清空该实例的整个索引（src/dshhome/store.js + src/web/components/instance-grid.js）
- **现象**：`upsertRows` 是「整表替换」语义 —— 先把该 home 的 `sessions`/`workspaces`/`providers`/
  `model_tiers` 全删，再按本次快照插入。而某个元数据文件的 `unit.version` 超出 `SUPPORTED_VERSIONS`
  时（dsh 升级后的必然情形），该域被判 degraded、产出 **0 行**，于是上一次成功索引的内容被删光。
  实测：projcache 版本 3 → 1 条会话、状态 ok；版本 4 → **0 条会话**、状态 degraded。
- **更糟的是不可见**：`homes.degraded` 只写进数据库，界面上任何地方都不渲染，
  用户看到的是「这个实例的会话和项目全没了」，没有任何线索指向「元数据格式不兼容」。
- **修复**：降级域对应的表**跳过 DELETE**，保留上次成功的行（其余域照常刷新）；恢复后降级标记自动清空。
  并在实例卡上渲染降级 chip（带具体原因与「已沿用上一次索引的数据」的解释）。
- **回归测试**：`tests/store-degraded.test.js` 逐域覆盖（projcache / workspace / credentials / modelTier /
  全降级 / 恢复后清标记），并在 `tests/web-render-safety.test.js` 断言 chip 文案与转义。

#### 移除实例会留下占着端口的孤儿 dsh 进程（src/control/launcher.js + src/api/routes.js）
- `disconnect()` 对 hwb 自己拉起的本机 `dsh web` 只做 `detached = true`（对「暂时断开后重连」是对的），
  但删除路径用的是同一个 `disconnect()`：`store.removeHome()` 之后该条目在任何 API/UI 里都不再可达，
  而进程会一直占着端口和 `DSH_HOME`，直到 hwb 本身退出（只有 `process 'exit'` 钩子兜底回收）。
- **修复**：`disconnect(home, { release: true })`。删除 API 与 Monitor 的孤儿清理都传 `release: true`，
  真正回收受管进程；普通「断开」行为完全不变，仍可一键重连。

#### SSH 重连退避用尽后实例永久卡死，无法自愈（src/control/launcher.js）
- `#scheduleRecovery` 在预算用尽时**直接 return，什么状态都不清**：`recovering` 永远为真，于是
  `status()` 跳过「进程已死」判断、持续吐出早就失效的 URL；Monitor 走 `recovering` 分支既不探测也
  不安排重连 —— 网络恢复后实例永远回不来。其次生影响同样实在：`routes.js` 会把「换一条通道连同一
  实例」判成「已被占用」并返回 409，用户连绕过去都做不到。
- **修复**：快退避（1/2/4/8/16s）用尽后转入慢速常驻重试（`recoveryCooldownMs`，默认 30s），
  既保留「预算内快速自救」的设计，又不再永久卡死。`disconnect`/`stop` 仍会彻底取消重试。
- **回归测试**：`tests/ssh-recovery.test.js` 新增「预算用尽 + 网络恢复 ⇒ 自愈为 running」与
  「取消后不得再建隧道」两条；原有「保留旧入口不白屏」的断言全部保持通过。

#### fingerprint 把「被信号杀掉的子进程」当成存活（src/control/guard.js）
- 判据只看了 `exitCode`。被 SIGKILL / OOM killer 收掉的句柄 `exitCode` 仍为 `null`，只设 `signalCode`，
  于是 guard 认为它还在跑 —— 与 `Launcher.status()` 的判据（两个字段都看）不一致，
  也让 `stop()` 的返回值对这种情况说谎。改为两个字段都判。

#### 心跳检查抛错会变成每 30s 一次的未处理拒绝（src/control/monitor.js）
- `#tick()` 只用 `.finally()` 链式收尾，`#checkAll()` 里任何一处抛错（store 查询 / launcher 状态 /
  broadcast）都会产生 unhandledRejection，被 crash handler 记成 fatal，掩盖真正原因。
  补上 `catch` 并记 warn；心跳本身照常继续。

#### 远端上传的临时目录：命令注入面 + 失败时不清理（src/lib/file-preview.js）
- `rm -rf '${tmp}'` 里的 `tmp` 来自**远端 stdout**，单引号未转义：远端 `TMPDIR` 里有一个 `'`
  就能闭合引号、把后面的内容变成要执行的命令。改为 POSIX 单引号引用，
  并且 `remoteTempDir` 收紧为「只取 stdout 最后一行 + 只允许 `[A-Za-z0-9._/-]` 的绝对路径」
  （原先整段 `trim()` 会把远端 profile 噪声当成目录名；本文件其它远端消费点早已用 `lastLine`）。
- **失败时不清理**：`finishRemoteUpload` 只在合并阶段清临时目录，分片阶段失败（SSH 断、超时、超限）
  时没人清 —— 每次重试都在远端留一份残留，`TMPDIR` 不可用时 `mktemp` 的兜底还会把它建到用户家目录。
  失败路径现在补一次 best-effort `rm -rf`。
- **回归测试**：`tests/remote-upload-tmp.test.js`（profile 噪声、恶意目录名被拒、分片失败后确实发起了清理）。

#### 两条「一次失败 = 整个工作台退出」的进程级崩溃路径（src/control/launcher.js + src/control/proxy.js）
- **本机拉起 dsh 时 spawn 失败**：`spawn('dsh', …)` 的失败（PATH 里没有 dsh、dsh 不可执行）是
  **异步**通过 `'error'` 事件上报的，而且**不触发 `'exit'`**。原先没有 `'error'` 监听，Node 把它
  当 uncaughtException 抛出 → `installCrashHandlers` 直接 `process.exit(1)` → Launcher 的
  `process.on('exit')` 钩子再 SIGTERM 掉**所有**已托管的 dsh web 子进程。
  也就是说「dsh 不在 PATH 里」（nvm/local-bin 路径不一致时的常见情况）会让整个工作台连同其它实例一起消失，
  而不是显示一句「连接失败」。挂上 `'error'` 后 Node 会把 `exitCode` 置为 -2，既有的等待逻辑据此
  立即失败并给出 `dsh web did not come up`；`captureDshToken` 也补了同样的监听（原先只等 `'exit'`，
  失败时要空等满 20s 超时）。
- **WebSocket 升级握手空窗内的 ECONNRESET**：从客户端发出 Upgrade 到上游回 101 之间有一段空窗
  （经 ssh -L 隧道可达数百毫秒）。原先 `socket.on('error', noop)` 写在 upstream 的 `'upgrade'`
  回调**内部**，覆盖不到这段空窗，空窗里关标签页就在 `TCP.onStreamRead` 抛 ECONNRESET → 同样打穿进程。
  监听改到 `forwardUpgrade` 开头。**顺带修掉一个泄漏**：空窗内客户端离开时，挂起中的 upstream 请求
  没有任何人中止，会连着自己的 socket 一直挂着（会让持有它的进程无法干净退出）。
- **回归测试**：`tests/launcher-spawn-failure.test.js`（把 PATH 指向空目录后真的点一次「连接」）、
  `tests/proxy-upgrade.test.js`（上游「接受连接但永不回应」以拉长空窗，再在空窗内 `resetAndDestroy`）。
  两者在还原修复前都复现出 `uncaughtException`（`spawn dsh ENOENT` / `read ECONNRESET`）。

#### multipart 分隔符扫描退化成 O(n²)：合法的大文件上传会冻住整个工作台（src/lib/multipart.js）
- **现象**：扫描写成 `for (cursor = 0; …; cursor++) if (buffer.indexOf(delimiter, cursor) !== cursor) continue;`
  ——每前进一步就把剩余缓冲区整段重扫一次，而「缓冲区里没有分隔符」恰好是文件内容的常态。
  实测每 64 KiB 内容块 36 ms，64 MiB 上传约 41 s；允许上限 256 MiB 时约 3 分钟。
  hwb 是单进程单线程，这段时间里 SSE、监控心跳、索引、所有 API 全部停止响应。
- **修复**：改成「一次 `indexOf` 取下一个出现位置，不是完整分隔符就继续往后找」，总代价与缓冲区长度线性。
  实测同一数据量从 41 s 降到毫秒级；16 KiB/64 KiB/256 KiB 单块扫描从 3.6/35.8/537 ms 降到
  0.014/0.003/0.009 ms，且结果完全一致。
- **回归测试**：`tests/multipart-hardening.test.js`——8 MiB 上传必须 < 1500 ms（修复后约 5 ms），
  并断言「数据翻 4 倍耗时不得接近翻 16 倍」以直接捕捉二次增长特征。

#### 浏览器发来的文件名含裸 `%` 时整个上传被拒（src/lib/multipart.js）
- 浏览器发的 `filename=` 是**原样**的（只转义 `"`），并不做百分号编码。原先无条件
  `decodeURIComponent(filename)`，于是 `100% done.csv`、`R&D 100% x.csv`、`a%zz.txt` 这类合法文件名
  会抛 `URIError: URI malformed`，整个上传被拒并报一句「上传请求格式无效」。
  （测试夹具里对名字做了 `encodeURIComponent`，所以 CI 一直看不到。）
- **修复**：解码失败就按原样使用（`writeUpload` 还会再规范化一次文件名）；旧客户端传来的
  已编码名字仍然照常解码。回归测试同时覆盖这两种输入。

#### 远端 `test -d` 路径未加引号：正常路径被误判不可访问，且可注入远端命令（src/control/prober.js）
- **现象**：`~` 开头的 `remoteHome` 是裸拼进 `ssh host "<cmd>"` 的。该字符串由**远端登录 shell**
  解释，于是 `~/my dsh` 会让 `test -d` 收到多个参数、以 exit 2 失败，一个完全正常的路径被判成
  「远端 dsh home 不可访问」而拒绝连接；`;` / `$()` 更会被远端直接执行
  （`remoteHome` 只经过 `trim()` 校验，不像 `host` 那样有字符白名单）。
- **修复**：`~` 与 `~user` 之外一律单引号引用；`~` 需要展开，所以用 `"$HOME"` + 单引号字面量**拼接**
  （实测 `"$HOME"'/x'` 正确展开）。**不能用双引号**：双引号里 `$(...)` 仍会执行，
  实测 `"$HOME/a$(echo LEAKED)"` 会真的产生 `LEAKED`。
- 说明：`~user/x` 现在按字面量处理，与 `remote.js` / `dshhome/remote-reader.js` 的 `expandHome`
  行为一致（它们同样只把开头的 `~` 换成 `$HOME`）；跨用户路径请写绝对路径。
- **回归测试**：`tests/prober-ssh-path.test.js`——直接断言生成的远端命令，并在真 bash 下验证
  `~` 仍展开、`$(echo PWNED)` 原样保留。

#### SSE 没有背压：一个不读数据的标签页就能把进程拖到 OOM（src/api/sse.js + src/server.js）
- `broadcast` 原先只做 `res.write(payload)` 且忽略返回值。客户端**连着但不再读**（合盖的笔记本、
  被节流的标签页、NAT 半开、只连不读的 curl）时 socket 不报错也不关闭，每次广播都堆进它的写队列。
  实测一个卡住的客户端 + 40 次 256 KiB 广播 ⇒ `writableLength` 涨到 10 MiB 且永不回落。
- **修复**：广播前检查 `writableLength`，超过上限（4 MiB）的客户端直接 `destroy` 并移出；
  另外加 30s 心跳（写入失败或已销毁也一并清理）。被断开的是浏览器 EventSource，它会自动重连，
  重连后重新拉全量状态，不丢数据。`hub.close()` 在 shutdown 时清理定时器与客户端。
- **回归测试**：`tests/sse.test.js`（卡住客户端被移除且写队列被限制在上限附近；正常客户端不受影响；
  心跳剔除已销毁客户端；写抛错不再二次抛出）。

#### 存储型 XSS：会话状态的 approval 未转义，可突破 title 属性（src/web/components/recent-sessions.js）
- **现象**：状态 chip 把 `permissions.approval` 直接拼进 `title="状态: … ${approve} …"`，而同一个表达式
  里 `label` 是转义的、`approval` 不是。值里带 `">` 就能提前闭合属性并注入任意标签，例如
  `x"><img src=x onerror=alert(1)>` 会渲染出真实可执行的 `<img>`（已用真实渲染链路复现）。
- **为什么是「存储型」**：`approval` 来自 dsh home 的元数据——`storages/session_projcache.json` 的
  `rows.permissions.val.approval`，或实时 RPC 的 `values.permissions.approval`（两条路径都只做
  null 兜底、不做内容校验）。也就是说**任何被登记过的实例（含 SSH 远程）都能把内容送进工作台页面**，
  而工作台页面同源可调用全部本地 API（读写工作区文件、登记 SSH 主机等），危害远超「弹个窗」。
- **修复**：对整段（含 ` · 审批 ` 前缀）做 `esc()`，避免以后改前缀时又漏一次。
  同时修掉 `app.js` 启动失败分支里 `${e.message}` 的同类问题（`api()` 会把服务端 `{error}` 当消息抛出）。
- **回归测试**：`tests/web-render-safety.test.js`——用最小 globals 跑真实渲染函数，断言注入内容以
  `&lt;img` 转义文本出现、且输出中不含任何真实注入标签；另逐字段覆盖 title/project/sessionId/别名/路径。

#### 时间戳越界把整个 projcache 域拖成 degraded，实例会话凭空消失（src/lib/time.js + schema/live-status）
- **现象**：`msToIso` 只检查 `Number.isFinite(v)`，但 ECMAScript 的日期时间戳上界是 ±8.64e15 毫秒
  （±275760 年）。`Number.isFinite(1e300)` 为真而 `new Date(1e300).toISOString()` **抛
  `RangeError: Invalid time value`**。该异常沿调用栈冒到域级校验，于是整个 projcache 域被判 `degraded`、
  一条会话行都不产出——用户看到的是这个实例的项目/会话在仪表盘上凭空消失，且日志只说了一句
  「Invalid time value」。触发条件很现实：dsh 侧时间戳单位变化（纳秒/微秒当毫秒）即可产生这种值。
- **修复**：抽出 `src/lib/time.js` 的 `msToIso`（同时约束上下界），`schema.js` 与
  `dshhome/live-status.js` 共用一份实现（后者原先也直接 `new Date(…).toISOString()`）。
  超范围时降级为 `null`，由调用方回落（如 `identity.createdAt`）。
- **回归测试**：`tests/time.test.js` 覆盖边界值、越界值、非数字，以及「脏时间戳不再拖垮整个域」。

#### 日志面板去重集合无上限增长（src/web/components/log-panel.js）
- `entries` 截断到 `MAX_VIEW=500`，但去重用的 `seen` 只增不减：长时间打开的页面（尤其 `-v`
  级别日志）会持续累积字符串键，而视图本身是有界的。截断时同步重建 `seen`，保证 `seen.size ≤ MAX_VIEW`。

#### npm 发布包缺 images/，README 头图在已发布版本里是坏链（package.json）
- `README.md` 第一行就是 `![hwb](images/hwb.png)`，但 `files` 白名单里没有 `images/`（`docs/` 同样漏了），
  `npm install -g hwb` 装到的包里没有这张图。补上 `images` 与 `docs`。
- `package-lock.json` 里 root 包的 `engines` 仍是旧的 `>=22`，与 manifest 不一致；同步为 `>=22.5.0`。

#### 写接口的跨站保护存在缺口：13 个写路由里只有 3 个有来源校验（src/api/routes.js）
- **现象**：`open-workspace`、`upload` 两条路由各自内联了一份「拒绝跨站」检查，其余写路由
  （`POST /api/homes`、`POST /api/homes/order`、`POST /api/homes/{id}/{reindex,open,stop,restart,disconnect,switch}`、
  `POST /api/quota/refresh`、`PUT/DELETE /api/homes/{id}`）**完全没有校验**。
- **为什么浏览器不会替你拦**：hwb 无鉴权且只监听 127.0.0.1，任意网页都能向本机端口发请求。带 JSON
  `Content-Type` 的请求会触发 CORS 预检（服务端不答预检，所以被拦），但 `Content-Type: text/plain`
  的 POST 属于 **CORS 简单请求**——不预检、直接发出，响应虽读不到，**副作用已经发生**：
  可被注册一个指向攻击者的远程实例、或把用户正在用的 dsh 实例 stop/restart。
- **修复**：把校验上提到 `route()` 入口，对 `POST`/`PUT`/`PATCH`/`DELETE` 统一生效——
  `Sec-Fetch-Site: cross-site` 一律拒绝；带 `Origin` 时必须等于 `http://{Host}`；
  非浏览器客户端（两个头都不带）照常放行。两处内联的重复校验同时删除。
- **回归测试**：`tests/api-csrf.test.js` 对 10 条写路由逐一断言「跨站 → 403 且不触达 store/launcher」，
  并断言同源请求与非浏览器请求仍然通过。

#### JSON 请求体上限形同虚设：超限必须读完整包才报错（src/api/routes.js）
- `readJsonBody` 先把整个请求体累加进字符串，读完之后才判断 `> 64 KiB`；也就是说 64 KiB 的
  「上限」不提供任何内存保护，一个超大 body 仍会被完整缓冲。
- 改为**边收边计**：先看 `Content-Length`（能不读一个字节就拒），没有时按实际累计字节在超限处停下；
  测试用 100 个 1 KiB 分片断言实际只读了 ≤66 个分片。
- **不要 `req.destroy()`**：第一版修复在超限时 destroy 了 socket，结果调用方随后的 400 响应
  根本写不出去，客户端只能看到 EPIPE —— 反而分不清「包太大」和「服务已死」。现在只停止读取，
  由 Node 在响应写完后关闭这条 keep-alive 连接；`tests/api-server-hardening.test.js` 用真实
  socket 断言能收到 `400 {"error":"body too large"}`。
- 同时修掉一个只在真实分片下才暴露的静默错误：`raw += chunk` 会对**每个 TCP 分片**单独
  `toString('utf8')`，多字节字符（中文、emoji）正好被切开就变成 U+FFFD，而结果仍是合法 JSON，
  于是乱码被静默存进别名 / host。改为 `req.setEncoding('utf8')`，由 `StringDecoder` 跨分片拼接。

#### DNS rebinding：跨站写保护看不到的一种攻击（src/api/server.js）
- 上一节加的同源检查比较的是 `Origin` 与 `Host` —— 这两个值在 DNS rebinding 下**都由攻击者控制**：
  攻击者把域名解析到 127.0.0.1，浏览器就会带着 `Host: evil.example:4310`、
  `Origin: http://evil.example:4310`、`Sec-Fetch-Site: same-origin` 直连本机端口，三项检查全部通过。
  实测（未加校验时）：跨站页面可以读到 `GET /api/homes` 里明文返回的 dsh token 与本地路径、
  经 `preview`/`download` 读工作区文件、经 `upload` 写入文件。
- **修复**：`/api/*` 只接受回环地址的 Host（`127.0.0.1` / `localhost` / `::1`，含端口与 IPv6 方括号形式），
  否则 403 并记一条 warn 日志。这是唯一能区分「本机页面」与「rebinding 页面」的信号。
- **回归测试**：`tests/api-server-hardening.test.js` 起真实 HTTP 服务，断言伪造 Host 的读写请求都是 403
  且响应里不含 token，回环 Host 正常。

#### 文件预览不再依赖「内嵌页上报会话」这一条链路（src/web/components/file-preview.js）
- **现象**：侧栏能打开，但一直显示「请先在 dsh 中打开项目会话，预览会自动绑定其工作区」，
  该实例的文件与目录在预览区完全打不开。
- **定位**：服务端与索引都是好的——直接请求
  `GET /api/homes/{homeId}/preview?sessionId=session-085baaae-…` 正常返回 PMAID 的工作区与目录内容，
  `sessions`/`workspaces` 表里该会话的 `workspaceId` 也齐全。失效点在前端握手：侧栏的绑定只来自
  内嵌页 `preview-bridge.js` 上报的 `hwb:preview-context`，一旦该上报没有到达（dsh 不使用
  `?session=` 做 SPA 导航、上报被代理/浏览器策略打断等），面板就只剩一句提示，
  而浏览/下载/上传全部不可用。
- **修复**：让侧栏有第二条入口——标题栏新增工作区下拉，直接列出 hwb 索引里该实例的全部工作区
  （含远端路径），选中即用 `workspaceId` 绑定；首次打开面板若尚无会话上下文，会自动绑定**最近活跃
  会话所在的工作区**。会话上下文到达时仍然优先跟随，会话消失则退回手选模式。
- **回归测试**：`tests/file-preview-ui.test.js`（最小假 DOM + 假 fetch）覆盖三种情形：
  未上报会话时按工作区兜底、上报会话时优先跟随会话、实例没有任何工作区时给明确提示而不崩。


#### 根因记录：「跟随 dsh 会话」为何会失效（证据）
该 dsh 客户端的全部客户端 bundle（主 bundle + 40 余个 `plugins/@deepseek-ai/*/client.js`）里
`pushState` / `replaceState` / `location.hash` / `location.assign` / `location.replace` 出现次数**均为 0**；
唯一读 `location.search` 的地方是 `dsh-client-connection.js` 的测试 fixture（`?fixture=`，与会话无关）。
因此：页面加载时的 `?session=` 只是 hwb 自己拼的 iframe URL（dsh 不读也不写），用户在 dsh 界面里
切换/新建会话时 **URL 完全不变**，桥接脚本拿不到新会话，上报的 `sessionId` 始终为空——这正是在实例内
切换会话后侧栏一直提示「请先打开项目会话」的直接原因。桥接现在会把完整 `href` 一并上报，父页优先
从 URL 解析会话（`src/web/app.js`），未来 dsh 若支持 URL 会话导航即可自动接上。

#### 流式解析与写入的三处可靠性问题（src/lib/multipart.js + src/lib/file-preview.js）
- **自引用生成器**：路由曾把解析器攒下的数组写成
  `part.chunks = (async function* () { yield* part.chunks; })()`——属性被覆盖后 `yield* part.chunks`
  指向生成器自身，`for await` 会**永久挂起**（上传请求永不返回）。改为不覆盖属性的 `asChunks()`。
- **header 结束空行未消费**：part 头部结束的 CRLF 残留在缓冲区，被 body 状态当成文件内容的开头，
  导致每个 part 落盘内容整体多出 `\r\n`。
- **分隔符匹配取最后一个**：改用「最早出现的完整分隔符」，避免一个分片里含多个 part 时后一个
  part 被并入前一个文件；缓冲尾部保留 hold 字节继续等数据，恒定内存。
- 本机写入不再依赖 `stream.write` 返回 false 后的 `drain` 事件，改用写回调作为落盘边界
  （`drain` 与 `await` 组合会出现回调永不到达）。

## [0.1.1] — 2026-09-06

**第一个补丁版本。** 修复/增强工作台 UI 与静态资源服务，去掉实例 tab 上的「本机/远程」标签。

### Changed

#### 工作台静态资源补上缓存头：no-cache + ETag/Last-Modified 强 revalidate（src/api/server.js）
- **根因**：工作台（`index.html` / `app.js` / 组件模块）由 `serveStatic` 直接提供，只设 `Content-Type`，
  没有 `Cache-Control`/`ETag`/`Last-Modified`。这与反代（`proxy.js`）无关——反代只是把 dsh web 的
  上游响应头**原样透传**（`res.writeHead(upRes.statusCode, upRes.headers)`），本身不添加任何缓存头，
  且只服务内嵌的 dsh web 实例，不服务工作台页面。因此改完源码后刷新是否存在缓存陈旧不可控。
- **修复**：`serveStatic` 为每个静态响应补 `Cache-Control: no-cache` + 弱 `ETag`(size-mtime) + `Last-Modified`，
  并支持 `If-None-Match` / `If-Modified-Since` 条件请求（命中回 `304` 空响应）。
  因资源路径不带内容哈希，故不宜用 `max-age` 长缓存（否则改源码后浏览器拿陈旧副本）；
  `no-cache` 每次仅做一次轻量 revalidate，未变 304、变了立即回全新内容——刷新即见改动、不重复传输。
- **验证**：`node --test tests/*.test.js` 全量 102 例通过；另做了端到端探测——首次 200(no-cache/etag) →
  带 `If-None-Match` 命中 304 → 文件改后 etag 变化返回 200 新内容 → `If-Modified-Since` 同秒命中 304。

#### 运行日志面板高度翻倍（src/web/index.html）
- **背景**：日志区 `max-height: 260px` 一次只能看到约 10 行，信息量偏少。
- **修复**：`.log-body` 的 `max-height` 由 `260px` 提升到 `520px`，一次可见行数约翻倍；仍 `overflow-y: auto`
  内部滚动，配合「跟随到底」+ 级别过滤，长日志不必频繁滚动。

### Added

- `tests/docs-consistency.test.js`：把「文档与代码不一致」这类问题变成**会失败的测试**，而不是靠人记得同步。
  覆盖：README 的 REST API 表 vs `routes.js` 里的路由、SSE 事件清单 vs `store.js` 的订阅、
  Node 门槛 vs `package.json` / `node-version.js`、`package.json` 的 `files` vs README 引用的本地资源，
  以及「README 不得写死会过期的计数」。README 里原本的「当前 62 个用例」已经漂到 359、又到 419 都没人发现，
  现在改为不写数字并由此测试守住。

### Tests

- 补上「导出但主流程从未调用、且没有测试」的几个探测/校验函数的用例
  （`prober.isAlive` / `sshProbe` / `httpProbe`、`guard.verifyProcess` / `expectedCommand`、
  `logger.setLevel` / `getLevel`）。这几个模块的头部都写着「均为独立可测函数」，但此前既没被接线
  也没被测试 —— 那是最差的组合：既占维护成本，又让人以为主流程真的走了 ps 校验 / PID 存活探测。
  依赖外部 `ps` 的用例在沙箱里会自动跳过（`spawn ps` 被拒是环境限制，不是缺陷）。


- 前端插值面的转义固化为回归测试（`tests/web-render-safety.test.js`）：端点编辑器（host/id/homeId）、
  实例设置表单与添加表单、日志面板的**每个字段**都按「不可信输入」喂一遍，断言不产出真实标签。
  这些数据来自 dsh 元数据与远端实例；此前只做过手工审计，而没有测试意味着下次改动又会悄悄开个口子。

### Fixed

#### 数据库里一个坏 JSON 列会让整个工作台退出（src/dshhome/store.js + dshhome/live-poller.js）
- **实测**：`homes.endpoints` / `homes.degraded` / `sessions.status` / `sessions.tokenUsage` 里
  只要有一个不是合法 JSON，进程启动后 **3 秒内必定 `exit 1`**。原因是读路径上的裸 `JSON.parse`
  抛 SyntaxError，而 `#enrichHome` 会被 LiveStatusPoller 的定时器**同步**调用 → uncaughtException
  → crash handler → `process.exit(1)`。更糟的是启动路径上这个崩溃发生在 `listen()` 之前，
  所以 `hwb start` 只打印一句「启动失败 (1)，查看 service.log」，用户完全不知道哪一行坏了。
- **修复**：新增 `safeJsonParse`（降级为默认值 + 每个字段只记一次 warn，指明是哪一列）；
  `LiveStatusPoller` 的 tick 也包了 try/catch（轮询失败只跳过本轮）。
  修复后同样的库能正常启动，`/api/homes`、`/api/sessions/recent` 都返回 200，
  日志明确写出 `column=homes.endpoints`。

#### 元数据文件是 FIFO 时进程会永久卡死（src/lib/read-home.js）
- **实测**：把 `storages/session_projcache.json` 换成 `mkfifo`，同步的 `readFileSync` 会永远等待
  写入端。因为 Node 把 `listen()` 的实际 bind 推迟到下一个事件循环轮次，**阻塞发生在 HTTP 端口
  存在之前**：表现为「端口连不上、日志里什么都没有、`kill -TERM` 也无效（进程卡在同步读里，
  信号处理函数没机会跑）」，只能 `kill -9`，没有任何诊断。
  同一个缺陷的温和版本是「一个 500 MB 的元数据文件」：首次 HTTP 200 要等 **5.7 秒**，RSS ~2 GB。
- **修复**：`readMetadataFile()` 先 `lstat` 确认是**普通文件**（同时拒掉符号链接），
  按 64 MiB 设上限，再用 `O_NONBLOCK` 打开（与 `file-preview.js` 同一套做法）。
  FIFO 现在 1 ms 内降级；最坏情况的同步阻塞从 5725 ms 降到 **78 ms**。

#### 符号链接把 home 之外的文件读进索引，并把内容泄漏到界面（src/lib/read-home.js）
- 元数据文件若是符号链接，`readFileSync` 会跟随它 —— 任意文件的内容会被解析、写进 `hwb.db`、
  并经 API 展示给浏览器（实测把外部 JSON 的会话标题完整读了进来）。另一条泄漏路径是
  **JSON 解析错误消息会带出文件开头的原始字节**，而那条消息会存进 `homes.degraded`、
  经 SSE 广播、渲染到实例卡上（例如一个指向 `/etc/passwd` 的符号链接会把文件开头回显出来）。
- **修复**：`lstat` + 拒绝符号链接；解析错误统一改为固定的「不是合法的 JSON」。

#### 索引失败的记录动作会顶掉原始错误、并中断整批（src/dshhome/store.js + dshhome/indexer.js）
- `markHomeError` 是从 indexer 的 `catch` 里调用的，而它自己也写库：数据库不可写时
  （文件被删、目录只读、磁盘满）二次异常会替换掉原始错误，并且直接从 catch 冒出去，
  让 `#runAll` 的循环半途而废 —— 后面的实例这一轮完全不刷新。
- **修复**：`markHomeError` 内部 try/catch（只记日志），indexer 的调用点也再包一层。

#### 索引器串行执行，一个慢实例拖住所有实例（src/dshhome/indexer.js）
- 远程实例的索引要走 SSH（几秒到几十秒），串行时一个慢实例会把后面所有实例的刷新一起拖住。
- **修复**：把「到点的实例」用**有限并发**（默认 3，上限 8）跑，结果顺序按实例列表还原，
  per-home 退避与错误隔离都保持不变。

#### 实时状态可能被更旧的快照覆盖（src/dshhome/indexer.js + dshhome/reader.js）
- indexer 原先**先**抓实时状态、**再**读文件，于是「抓快照」与「落库」之间夹着整个文件读取
  （远程实例是 SSH，几秒到几十秒）：期间 live-poller 写进更新的状态后，会被这边更旧的快照覆盖，
  界面上的状态徽标倒退一拍。改为读完文件**之后**再抓实时状态。
- 改完后的窗口是「实时快照被取到 → 落库」这一步。本机实例中间不再有事件循环轮次
  （读文件是同步的，落库也是同步的），所以定时器驱动的写入无法插进来；**不是**严格意义的
  「窗口 0」—— 实时抓取本身要等一次 RPC，若同一时刻还有另一个在飞的抓取更早返回并写库，
  仍可能被覆盖（这是两个读-写者共有的问题，靠排序消不掉，需要版本号/时间戳才能根治）。
  相对原来的改进是确定的：那段本该「最短」的间隔不再包含一次完整的文件读取。
  顺带把 `reader.js` 的「读文件」与「按快照落库」拆成两个导出，供这里组合。
- **回归测试**：`tests/hostile-env.test.js`。注意**只看「实时状态生效了没有」是测不出顺序的**
  （状态字段上实时值总会赢）—— 所以测试改为让 `liveStatus` 被调用时把 projcache 里的**标题**
  改掉，再用只有文件能提供的 `title` 作判据：正确顺序入库 `FILE-OLD`，反序入库 `FILE-NEW`。
  把顺序改回去（先抓实时、再读文件）该用例确实失败。

#### 数据库路径不可用、日志文件被删时的可诊断性（src/server.js + src/lib/logger.js）
- `new IndexStore()` 失败时只抛一句 `unable to open database file`，并冒成
  uncaughtException → exit(1)，CLI 那边只有「启动失败 (1)」。现在会明确说出**哪个路径**、
  以及「该路径已被目录占用 / 父目录不可写 / 不是 SQLite 文件」这几种常见原因。
- 日志文件被 `rm`/`mv` 或被换成目录之后，写入会继续落到**已 unlink 的 inode** 上：
  进程看起来一切正常、`/api/logs` 也照常有内容，但磁盘上的日志永远不会再增长
  （`hwb logs` 会说「日志尚不存在」）—— 恰恰是最需要日志的时候失去磁盘线索。
  现在每 5 秒比对一次 fd 与路径的 inode，不一致就重开。

- **回归测试**：新增 `tests/hostile-env.test.js`（10 例）：坏 JSON 列不再带崩进程、
  轮询抛错只跳过本轮、FIFO 立即降级、符号链接被拒且不泄漏外部内容、解析错误不回显文件字节、
  超限文件被拒、记录失败状态抛错时整批仍继续、并发不打乱顺序且有上限、
  实时状态不被旧快照覆盖、日志文件被删后自动重建。

#### multipart：非文件字段在前时，后面的文件被整个吞掉（src/lib/multipart.js）
- `field` 状态找的是**收尾**分隔符 `\r\n--boundary--`，于是在遇到第一个普通字段后就直接跳到
  `done` —— 「字段在前、文件在后」的请求里那个文件根本没被解析。表现为解析成功、零文件，
  调用方只报一句令人费解的「没有收到文件内容」（既不是数据丢失也不是明确的格式错误）。
- **修复**：`field` 改为停在**普通** part 分隔符上并回到 `afterBoundary`（与 `body` 状态一致），
  同时保持恒定内存（确认不可能再是分隔符前缀的部分立刻丢弃）。顺带把「找最早的完整分隔符」
  抽成 `findBoundary()` 给两个状态共用。回归测试覆盖「字段在前 / 文件在前 / 只要文件 / 只要字段」
  四种组合，且每种都在 7 字节与 **1 字节**分片下验证。

#### 仪表盘一直在撒谎：18/179 个会话被永久标成「运行中」（src/lib/status.js + dshhome/live-status.js）
- **实测真实 home**：179 个会话里 18 个被判 `running`，**全部空闲 7–28 天，0 个在 10 分钟内**。
  原因有两层：
  ① 判据里的信号（`sessionStats.openStep` / `pendingCalls` / `todos.in_progress` /
  `goal.phase==='active'` / `plan.running`）全部来自**投影缓存快照** —— 进程被杀、机器休眠、
  会话被放弃之后，这些「进行中」标记会永久冻结在缓存里，而代码从不断言新鲜度。
  ② `plan.active` 被当成了活动信号，但它是**持久模式开关**（`plan/mode` 设置、空闲不复位），
  真正表示在跑的是 `plan.running`（进行中的 /plan 命令）。也就是说任何开过 plan 模式的会话
  都会永久显示「运行中」。
- **修复**：`planRunning` 只看 `plan.running`（两处同改）；并加新鲜度门限 —— `running` 之外
  30 分钟没有任何活动就降级为 `idle`。本机实例另有 3s 的实时通道（`item.running` 布尔是权威信号）
  会覆盖这个结论；远端/离线实例只能靠文件索引，宁可保守显示「空闲」。
- **修复后真实 home 的分布**：`{idle: 147, completed: 32}`（不再有任何虚假的 running）。

#### 分时用量图静默丢掉「当前这一小时」（src/dshhome/store.js）
- SQL 的窗口是 `lastActivity >= now - hours`，但桶只列到 `floor(now/H) - 1` ——
  当前这一小时的数据被 SQL 选出来了却没有桶可放，直接丢掉。实测真实库 24h 窗口里
  **丢了 3.5% 的 token，全部落在当前小时**。顺带发现桶数组是**倒序**（与 `usageTrendGrouped` 相反）。
- **修复**：范围改为 `endHour - hours + 1 .. endHour`（含当前小时），并按从旧到新输出。

#### 缺少任一 token 字段时总用量算成 0（src/dshhome/store.js）
- `COALESCE(SUM(a + b + c + d), 0)`：COALESCE 只包住 SUM，而 `1000 + NULL + …` 整个相加是 NULL、
  SUM 又忽略 NULL → **totalTokens 变成 0**。只要 dsh 的 `tokenUsage` 少任何一个键就会中招。
  改为逐项 `COALESCE(json_extract(...), 0)`（`recentProjects` 本来就是这个写法，另两处漏了）。

#### 缺少凭据 key 时整个额度刷新崩掉（src/dshhome/quota.js）
- `(key ? queryBalance(...) : { provider, error: 'key not found' }).then(...)` ——
  右侧是**普通对象**、没有 `.then`，于是同步抛 TypeError；而它在循环里抛，**所有** provider
  （含其它实例）一个都进不了缓存、`quota:updated` 也不广播。而「有 provider 行但缺对应 key」
  是很常见的状态（key 还没配、ref 改过名）。改为 `Promise.resolve(...)` 包一层，
  并给单个 provider / 单个实例的凭据读取各加一层隔离。

#### 额度：缓存为空被当成「永远 stale」+ 已删实例的额度一直返回（src/dshhome/quota.js）
- `#hasStale()` 里 `cache.size === 0 && 有实例` 恒为真：只要实例在但一个 provider 都没有，
  **每一次** `GET /api/quota` 都会再触发一轮刷新 + `quota:updated` 广播（客户端把它映射回
  `/api/quota` 就是死循环）。改为记录独立的 `lastRefreshAt`。
- 实例被删除后其缓存条目无人清理：会一直返回给客户端，且时间戳永远是旧的 → 每次 `list()`
  都再刷一轮。现在按 `store.listHomes()` 清掉已消失实例的条目。

#### 凭据里的 API key 会经错误消息泄漏到 /api/quota 响应（src/lib/balance.js）
- `/api/quota` 是**未经鉴权**的 GET，任何本地进程都能读。而 Node 的 fetch 在 header 值非法时
  抛的消息里带着值本身（`Headers.append: "Bearer sk-…" is an invalid header value.`）——
  原实现把 `e.message` 原样转发，于是一个含控制字符的 key 会把明文 key 送进响应，
  直接破坏本文件开头写下的不变量（§8.1「key NEVER 传给浏览器」）。实测复现过。
- **修复**：技术性错误改为**分类后的短文案**（凭证格式无效 / 被拒绝 / 上游错误 / 超时），
  细节只记服务端日志；适配器主动抛出的、本身就是给用户看的原因（如「无公开余额 API」）原样保留。

#### `.credentials.yaml` 的解析问题（src/lib/read-home.js）
- **UTF-8 BOM**：JS 的 `\s` 匹配 U+FEFF，于是带 BOM 的 `\uFEFFrefs:` 会走错分支、`inRefs`
  永远为 false，缩进的所有 key 全被跳过 —— 一个被 BOM-adding 编辑器重存过的凭据文件会表现为
  「这个 home 没有任何 provider」。现在切行之前先剥 BOM。
- **重复的 `*_API_KEY`**：providers 表是 `UNIQUE(homeId, ref)` 且用普通 INSERT，重复一行就会让
  整个 `upsertRows` 事务回滚 —— 该实例的会话/工作区一行都提交不了、状态永久 degraded、
  每 60s 重试一次同样失败。现在解析时按 ref 去重（取最后一条），并把 INSERT 改为
  `ON CONFLICT(homeId, ref) DO UPDATE` 作为第二道保险。

#### 查询参数越界把接口打成 500（src/api/routes.js + src/dshhome/store.js）
- `Number(x) || fallback` 只挡得住 0/NaN/'abc'，挡不住 `?days=1e9`：它会一路传到
  `new Date(Date.now() - days * 86400000).toISOString()`，超出 ECMAScript 日期范围后
  toISOString 抛 RangeError → **实测 `GET /api/projects/recent?days=1e9` 返回 500**。
- **修复**：统一的 `numParam()` 带上下界解析（并正确区分「参数缺失」与「参数非法」——
  第一版把缺失当成 0 再夹到 min，等于把默认 7 天窗口悄悄改成 1 天）；
  store 侧的「N 天前」也改用带 100 年上限的安全计算。

#### 其它（一轮对抗式纯函数审查）
- `schema.validateModelTierJson`：tierId 直接来自文件，`tiers['__proto__'] = …` 会走原型 setter ——
  该 tier 从 `Object.entries` 里凭空消失（normalize 于是不产出 modelTier 行），同时返回对象的
  原型被文件内容控制。改用 `Object.create(null)`。
- `multipart`：正文允许前导 CRLF，但偏函数判定只认「`--boundary` 的前缀」——
  同一个正文会因 TCP 分段不同而被拒（实测首个分片 2 或 6 字节时必拒、整包一次给就通过）。
  现在把 CRLF 变体也算进合法前缀（方向别写反），并穷举验证了两种正文在所有 2 段切分位置 + 1 字节切分下都能解析。
- `endpoints.normalizeEndpoints`：端口接受 `Number()` 的强制转换结果 —— `true→1`、`[22]→22`、
  `'0x50'→80`、`'1e3'→1000` 都会被静默接受并落库；host 也没有长度上限（id/label 本来就有）。
  改为只接受数字或纯数字字符串，host 上限 255。
- `normalize`：导出函数，缺字段/类型不对时会抛 TypeError（等于整个 home 的索引失败）。
  改为逐字段兜底，坏字段降级而不是炸掉整批。
- `routes`：旧 `host` 字段在**入库之后**才校验 → 恶意/非法 host（如前导 `-`）返回 500
  却把实例建好了，用户只能手工删。现在在 registerHome 之前校验，返回 400 且不留残行。

#### 源码注释引用了设计文档里不存在的章节（DSH_Workbench_Fusion_Architecture.md）
- 三个文件（`reader.js` / `remote-reader.js` / `server.js`）都在注释里指向「§4.6」，而设计文档的
  第 4 节只到 §4.5 —— 顺着引用去查的人会一无所获。补上真正的 §4.6「远端只读索引」小节
  （`ssh host bash -s` + 分隔标记、32 MiB 上限、残缺判定、路径引用规则），
  并新增测试：扫描 `src/**` 里的 `§N.M` 引用，逐个到文档里核对章节号存在。

#### registry.applyProbe 在恢复成功后仍挂着旧错误（src/control/registry.js）
- `if (cur.lastError) next.lastError = cur.lastError;` 是**无条件**覆盖的：成功分支明明写了
  `lastError: null`，却又被旧值盖回去。于是会出现「phase=running、attempts 归零，却还挂着一条
  『SSH 连接已断开』」的自相矛盾状态（这条错误会被 Monitor 的降级日志打出来，误导排查）。
  改为只在**新状态没有显式给出** lastError 时沿用 —— 失败分支只写 phase/attempts，沿用上一条
  有助于排查；成功分支显式清空，必须生效。
- 顺带修掉 registry 头注释里仍写着 `crashed`（该阶段已被移除）与「持续失败封顶 crashed」的旧描述。
- **回归测试**：`tests/monitor.test.js` 新增「失败沿用 / 恢复清空 / 显式新错误优先」三条断言。

#### 格式化辅助函数是非数值文本进入 innerHTML 的通道（src/web/store.js + components/usage-card.js）
- `fmtTokens` 的最后一个分支是 `String(n)`：只要调用方传进非数字，任意文本就会**原样**进入页面 ——
  而它在用量卡与项目栏里都是**不转义**的插值点（因为「这个值就是个数字」）。
  与第 1 轮修的 `approval` 是同一类问题：值来自 dsh 元数据经 SQL 聚合，正常情况下必然是数字，
  但「正常情况下」不该是唯一的防线。
- **修复**：`fmtTokens` 只接受可转成有限数的输入，否则返回占位符；`fmtPct` 同样（非数字时
  `toFixed` 会直接抛，整卡渲染失败）；`summary.days` / `sessionCount` 两处插值补 `esc` 兜底。
- **回归测试**：`tests/web-render-safety.test.js` 新增 `fmtTokens` 的各种非数值输入，
  以及「被污染的用量字段渲染后不出现真实注入标签」。

#### dsh-remote-index / dsh-merged-index 两个独立工具（此前完全没有测试覆盖）
- **`dsh-instance-index.mjs` 整包解压只为读一行**：`zstdDecompressSync(整个文件)` 与本文件自称的
  「lightweight / 只读 session header」完全不符。实测一个 19 KB 的 `session.jsonl.zstd`
  （解压后 200 MB）让峰值内存到 **445 MB / 最大 RSS 495 MB** —— 而这个脚本会经 ssh 在**远端主机**
  上跑，大会话能把远端 dsh 一起拖下水。改为流式解压、拿到第一个换行就销毁流，并对 header 设 64 KiB
  硬上限：同一夹具的峰值降到 **19.6 MB**（22×）。
- **`dsh-instance-index.mjs` 每个项目目录都重读整个投影缓存**：`loadCache()` 写在项目循环里，
  每个目录都重扫缓存目录并 `JSON.parse` 全部 json（30 项目 × 100 文件 = 3000 次读取；
  真实 home 214 项目 × 428 文件约 9.1 万次）。缓存是**全局**的，提到循环外只读一次；
  富化语义不变（回归测试断言 30/30 会话仍被正确富化）。
- **`dsh-merged-index.mjs` 容忍远端 stdout 噪声**：远端登录 shell 的 banner（`.bashrc` 里的 echo、
  motd）会让 `JSON.parse(res.stdout)` 直接抛 `SyntaxError: Unexpected token 'W'`，
  `--watch` 模式下每轮都死、HTML 永远停在旧快照，而错误信息完全没提 banner 这个真实原因。
  改为从第一个 `{` 开始解析，失败时把输出开头片段带进错误。`--watch` 的单轮失败也改为记录并继续。
- **`dsh-merged-index.mjs` 数值字段的 HTML 注入**：`${s.turns}` / `${s.steps}` 直接插进模板，
  而它们来自**远端**投影缓存（`sessionStats.val`），构造缓存即可产出真实标签
  （`class="turns"><img src=x onerror=…>`）；这个页面聚合了所有实例的标题与路径，
  注入成功就能读走全部内容。改为数值规范化（无法解析 → 0）。
- **新增回归测试** `tests/dsh-remote-index.test.js`（7 例）：压缩文件只读第一行（64 MiB 解压量仍在毫秒级）、
  缓存 hoist 后富化仍生效、header 不可解析时不崩、banner 容忍、数值注入、`--watch` 单轮失败不退出。

#### `hwb stop` 在前台 `hwb serve` 占用端口时谎报「已停止」（src/cli.js）
- `request('stop')` 在 ENOENT/ECONNREFUSED 时返回 null，而前台 `hwb serve` **不创建**控制 socket，
  于是 `hwb stop` 打印「已停止」并返回 0；下一次 `hwb start` 只报一句难懂的「启动失败 (1)」
  （真实原因 EADDRINUSE）。现在会探测配置端口：仍被占用时明确报错并退出 1，并指出「很可能是前台
  `hwb serve`，请到该终端按 Ctrl-C」。

#### 日志文件打开失败一次后永久静默（src/lib/logger.js）
- `openFile()` 只在 `initLogger` 与 `rotate()` 里被调用，而 `rotate()` 只在 `writeFileLine()` 里可达 ——
  后者在 `fileFd === null` 时直接 return。于是**瞬时**失败（EACCES/ENOSPC、日志目录被临时改名）
  之后，文件日志在整个进程生命周期里静默停掉，只留 console 上一行提示，
  而 help 文案恰恰叫用户去看那个文件。现在按节流（默认 30s）重试打开，故障恢复即续写。

#### workspace-menu 给「未分组」行也插了一个点了没反应的菜单项（src/control/workspace-menu.js）
- 注入的菜单数组同时被「未分组」那一行复用，而该行 `row.workspaceId === void 0`
  （`groupByWorkspace` 里 `buildGroup("", void 0, …)`）。点击时 dispatch 的 `detail` 是 undefined，
  桥接层按「必须是 string」丢弃 —— 用户看到菜单项但点了没反应。改为按 `row.workspaceId` 条件展开。
  新增 `tests/workspace-menu.test.js`：含注入锚点、条件展开、注入后仍是合法 JS、锚点缺失时
  fail-closed，以及**针对本机真实安装的 dsh bundle** 跑一遍（锚点失配会立刻暴露）。

#### docs/topology.md 的两处说法与代码不符
- §3.1 列了 `crashed` 状态（`Monitor.#runCheck` 从不设置它），且漏了实际会产出的 `gone`。
- §3.3 说本机「同机直连，无代理」—— 只有「外部打开」是直连；**钻入 iframe 走 hwb 的预览反代**
  （`Launcher.#withPreview` 对本地实例同样建代理，正是这样才能注入 `preview-bridge.js`）。

#### 回归：草稿恢复后 SSH 表单提交不了（src/web/app.js + components/add-home.js + components/form-draft.js）
- **现象**（对抗式自审发现）：显隐/必填是**值之外**的状态，只在 `change` 处理器里设置，而
  dashboard 每次 SSE 重建（有实例在跑时约 3s 一次）都会生成一个「本机」布局的新表单。
  只恢复 `value` 的结果是：select 显示「SSH 远程」、host/remotePort 仍 `hidden`（输入的内容看不见
  也改不了），而可见的空 `homePath` 仍是 `required` → 原生校验直接拦下提交，**submit 事件根本不触发**。
  只能来回切两次模式才能恢复 —— 比修复前更糟。
- **修复**：把模式切换抽成可复用的 `applyHomeMode(form, mode)`（移到 `components/add-home.js` 以便单测），
  恢复草稿后重放它。测试同时断言「表单默认标记就是本机布局」与「重放后各字段显隐/必填正确」。
- **同处的第二个缺口**：草稿逻辑原先只接在 grid 布局上，**onboarding 路径没接** ——
  而首装时那个表单是唯一出口，`monitor` 每 30s 无条件广播一次就会重建它。现在两条路径共用
  `captureAddFormDraft` / `restoreAddFormDraft`。

#### `--no-open` 兼容重试在真实错误输出下从不触发（src/control/launcher.js）
- 重试判据读的是错误消息，而消息只带 stderr 的**最后一行**；commander 在选项名相近时会把
  `(Did you mean --open?)` 另起一行输出，于是最后一行不含 `--no-open` → 重试永远不触发，
  用户看到的仍是一句「启动失败」。上一轮的测试用单行假输出，恰好掩盖了这一点。
- **修复**：消息改为带 stderr 最后三行，并把完整 stderr 挂到 `error.stderr`；判据同时匹配两者。
  测试改为复现 commander 的多行输出，并断言错误消息里保留 `unknown option` 那一行。

#### 降级域的跨表牵连：会话变孤儿 / 幽灵「运行中」（src/dshhome/store.js）
- 对抗式自审发现前两轮的两个修复会互相干扰：
  ① **workspace 域降级**时 `normalize` 拿不到工作区（`snapshot.workspaces` 为空），产出的会话行
  `workspaceId/workspaceTitle` 全是 null、`project` 退化成 `basename(cwd)`；而 `workspaces` 表保留着
  旧行 → 会话与工作区断开，`sessionWorkspace()` 返回 null，`preview`/`download`/`upload` 对一个
  完全正常的会话报「当前会话尚未关联可用的 project 工作区」，保留的 workspace 也变成孤儿。
  **修复**：workspace 域受保护时，**在 DELETE 之前**抓一份「会话 → 工作区归属」映射并回填到新行上
  （必须在 DELETE 之前 —— 此时 sessions 表本身仍会被替换）。恢复后由新数据自然覆盖。
  ② **projcache 域降级 + 实时列表为空**：整表替换被跳过，谁也无法刷新那些行，于是陈旧的
  `status = running` 会永久留在 dsh 明确报告「没有会话」的实例上 —— 正是上一轮想消除的症状，
  却从「最多 60s」变成了「永久」。**修复**：这种情况清掉 `status`（而不是删行）：数据仍在、
  UI 退回「空闲」，projcache 恢复后被文件索引覆盖。projcache 正常时不动文件索引的 status。

#### 回环 Host 限制缺少逃生口（src/api/server.js + README）
- DNS rebinding 防护要求 `/api/*` 只接受回环 Host，但 `/etc/hosts` 别名、devcontainer/Codespaces 的
  转发域名、以及保留浏览器 authority 的反代都会让 Host 不是回环名 —— 那时 SPA 能加载、
  每个 `/api/*` 却 403，且无法自证。新增 `HWB_ALLOWED_HOSTS`（逗号分隔）显式放行，
  默认空即「只允许回环」；README 的安全边界一节说明放行意味着什么。

#### dsh-static-cache：请求一个真实存在的目录会抛 EISDIR（dsh-static-cache/lib/index.js）
- 越界检查用的是 `stat()`，而 `stat` 对目录是成功的（所以 `err.code === 'EISDIR'` 那个分支永远不会
  命中），真正抛 EISDIR 的是随后的 `readFile`。`dist/assets` 下确实有目录（`assets/langs`、
  `assets/fonts`），于是 `GET /assets/langs` 让处理器 promise 拒绝：dsh 的 webserver 兜住它，
  用户拿到 400 而不是 404，每次命中还往 dsh 日志写一段 warn+堆栈。
  **修复**：readFile 前显式 `if (!st.isFile()) 404`。

#### 实例卡不再展示「当前项目/当前会话」块（src/web/components/instance-grid.js）
- **根因**：实例卡里的 `currentBlock`（当前项目 / 当前会话 + 状态 chip / token / 最近活动）与
  Recent Projects / Recent Sessions 两栏所呈现的信息重复——这两栏已把实例的当前项目与最近会话
  跨实例聚合展示，实例卡再放一份属冗余，且让卡片纵向堆叠、更显拥挤。
- **修复**：删除 `instance-grid.js` 的 `statusChip` / `currentBlock` 两个函数及其在卡片中的调用，
  卡片恢复为「名称 + 运行态 chip + 索引/类型/workspace/会话数 + 操作按钮」。顺带清理
  `index.html` 中不再使用的 `.current-block` 样式；`store.listHomes()` 仍保留每实例的
  `current` 字段（数据层语义不变，Recent Projects / Recent Sessions 消费同一会话元数据）。
- **验证**：`node --test tests/*.test.js` 通过（`current` 字段断言在 store/remote-reader 层，未受影响）。

#### 本地实例「在外部浏览器打开」改走原始服务连接，不再经 hwb 反代（src/control/launcher.js）
- **根因**：`Launcher.#openLocal` 在拿到 `dsh web` 的 token 后，又包了一层 hwb 自己的**反向代理**
  （`createProxy`），把 `inst.url` 拼成 `http://127.0.0.1:<proxyPort>/?token=<x>`；iframe 与
  「在外部浏览器打开」因此都拿到的是**经过端口转发/反代的 URL**，而不是本机 dsh web 的原始端口。
  对本机实例来说这是完全多余的转发：
  - 端口转发只对**远程**有用（ssh -L 隧道本身不可被浏览器直达）；本机 dsh web 与浏览器同机可达。
  - 反代入口依赖 **hwb 进程存活**：hwb 一旦崩溃，入口随之失效，而真实端口与 token 又未暴露，
    导致实例「连不上」且「不知道 token」。
- **修复**：本地实例**不再创建反代**，`inst.url` 直接使用原始服务连接
  `http://127.0.0.1:<dshPort>/?token=<x>`（旧版 dsh 无 token 则回退裸 URL）。iframe 与
  「在外部浏览器打开」同一 URL：根绝对路径 `/plugins`、`/assets` 在 dsh web 自带根下原本就可解析，
  token→cookie 握手也由 dsh web 自身完成，无需代理层。这样 URL 才是真实的 dsh 端点——token 可见、
  不依赖 hwb 进程存活的反代入口。远程实例（`#connectRemote`）仍保留反代（浏览器无法直达 ssh -L 隧道）。
- **验证**：`node --test tests/*.test.js` 全量 90 例通过（launcher 本地分支无针对 proxy URL 的断言，
  `proxy.test.js` 单测的是 `createProxy` 本身，用于远程保持不变）。

#### 工作台内容超过窗口高度时提供页面滚动（src/web/index.html）
- **根因**：`html, body { height: 100% }` 把文档高度锁死在视口内，配合 `#main { overflow: hidden }`
  使工作台网格在内容超过浏览器窗口高度时被整体裁剪，只能在内部 `overflow-y: auto` 里滚动
  （或直接溢出不可见），无法用页面滚动查看整屏内容。
- **修复**：将 `html, body { height: 100% }` 改为 `body { min-height: 100vh }`，文档高度随内容自然
  生长，内容超过窗口高度时页面整体滚动；顶栏仍 `sticky` 贴合，实例与工作台视图切换逻辑不受影响。
- **验证**：无头 Chrome（1280×600）实测——改前 `docScrollH == innerH`（页面不可滚动、内容被裁剪），
  改后工作台 `docScrollH > innerH`（可滚动），实例 iframe 视图 `docScrollH == innerH`（仍整屏贴合）。

#### 远程连接对「旧版 dsh（不生成 token）」的向下兼容（remote.js + launcher.js）
- **根因**：新版鉴权 token 逻辑上线后，远端 `ensure` 会对一个**已在监听但没有 token 的旧版
  dsh web** 执行 `killport` 再重启——这既打断一个健康的旧版实例，又因重启后可能起不来直接导致
  「远程连 v0.1.1 反而报错」。同时启动后的 poll 循环只认 `?token=`，对旧版打印的裸 URL 会白等
  满 40s（前端若设了更短的 timeout 就直接报错）。
- **修复**：
  - `ensure` + 端口已在监听 + 日志无 token → 直接返回 `__NO_TOKEN__` 哨兵（上层用裸 URL 兜底），
    **不再 killport/重启**；
  - 启动后若日志出现「含 `http` 但不含 `?token=`」的 URL 行 → 判定为旧版，**立即**返回
    `__NO_TOKEN__`，不再干等满整个 poll 窗口；
  - token 正则与本地 `captureDshToken` 对齐为 `\?token=[A-Za-z0-9_-]+`（修掉旧 `?token=[^ ]*`
    把行尾右括号等标点误并进 token 的问题，如 `?token=xxx)`）；
  - **默认远端安装命令改为向下兼容的 `dsh web --port <n>`**（去掉 `--profile web` 与 `--no-open`）：
    `--profile web` 与 `--no-open` 是 ≥0.1.2-rc.1 的新旗标，旧版 v0.1.1 会把它们当成未知选项
    直接退场，导致 web 根本起不来 → `远程 dsh web 不可达 / waitForHttp timeout`
    （这是「连不上」的直接原因）。裸 `dsh web` 别名新版等价、旧版原生支持；`--port` 显式绑定到
    隧道目标端口。本机 `#openLocal` 也改用 `dsh web ...`（保留 `--no-open`）。
  - `#connectRemote` 不可达时把 **SSH 隧道 stderr** 一并记入日志并拼进报错，便于区分
    「隧道没建通」vs「远端 web 没起来」。
- **回归测试**：新增 `tests/remote.test.js`（直接跑真实 `REMOTE_START` 脚本，桩定端口探测），
  覆盖「旧版裸 URL 快速兜底 / 新版返回 token / ensure 在监听不重启 / 日志有 token 复用」，
  并新增 `defaultRemoteCmd` 用例（默认命令不带 `--profile`/`--no-open`）；
  `tests/launcher.test.js` 新增 `isTokenFragment` 判定用例（真 token → true，
  `__NO_TOKEN__`/null/空串 → 回退裸 URL）。

### Added

#### 本机实例支持「直连已运行的 dsh web」（本地端口 + token）
- **场景**：用户已在本机手动起了一台 `dsh web`（如 `http://127.0.0.1:3080`），希望 hwb 「打开」该
  实例时**直接接入这台**，而不是每次都在随机空闲端口**新拉起一台**（旧行为：`#openLocal` 永远
  `freePort()` + `spawn('dsh', ['web', ...])`，且曾因「本地无谓反代」被诟病）。
- **实现**（`store.js` / `routes.js` / `launcher.js` / `web/components/add-home.js` / `web/app.js`）：
  - `homes` 新增 `localPort` 列（迁移 + `registerHome`/`updateHomeConfig`/`listHomes` 全链路读写）；
  - `POST /api/homes` 与 `PUT /api/homes/:id` 对本地实例接受 `localPort`（可选）+ `token`（手填）；
  - `Launcher.#openLocal` 开头检测 `home.localPort>0` → 走新增 `#connectLocalExisting`：
    **同机直连**（`localWebUrl` 拼 `http://127.0.0.1:<localPort>/?token=<x>`，**不建 hwb 反代**）、
    `inst.proc=null`（hwb 不持有/不 `kill` 该进程，`stop/status/exit` 均已兼容 null proc）；
  - 前端设置表单为本机实例增加「本机 dsh web 端口 + 鉴权 token」输入；新增实例表单同样支持
    （端口留空则回退到原「新拉起」逻辑）。
- **回归测试**：`node --test tests/*.test.js` 全量 102 例通过。新增 `store.test.js` 的 `localPort`
  round-trip 用例，与 `launcher.test.js` 的「connect-existing → 直连 URL、无反代、无子进程、stop 不 kill」
  用例，锁定「URL host 即 dsh 本体端口、绝不出现第二代理端口」的关键回归。
- **附带修复**：`src/control/proxy.js` 的 WebSocket 升级路径不再让已断开 socket 的写入（`write EPIPE`）
  以 `uncaughtException` 打死整个 hwb 进程——给两侧 socket 挂 error 监听 + `safeWrite` 守卫，EPIPE
  时静默拆除（曾 `@proxy.js:103` 触发并连带杀掉本地 dsh web 子进程，见 hwb.log 14:53:26）。

#### 远程活动 dsh 实例的「当前项目/当前会话」也缓存进工作台
- **新增远程只读索引（§4.6）**：数据平面不再只索引本地实例——索引器现在遍历**全部**实例
  （`store.listHomes()`,含 `hostType='remote'`），远程实例经一次 `ssh host bash -s` 在远端
  `cat` 出 4 个元数据文件（`workspace.json` / `session_projcache.json` / `model-tier.json` /
  `.credentials.yaml`），由 `dshhome/remote-reader.js` 解析回文件文本后，走与本地**同一套**
  `buildSnapshot`（重构自 `readHome`）+ schema 验证 / 域降级语义。**只读**，绝不修改远端文件。
- **「当前项目/当前会话」入库（§7）**：`store.listHomes()` 新增 `current` 字段——取每个实例
  **最近活跃**（lastActivity 最大）的会话及其所属 workspace，带 title / project / status chip /
  tokenUsage / contextPressure / lastActivity。这是「当前」语义：不同于 recentProjects/recentSessions
  （时间窗内聚合），它是每个实例的**单一当前项**。
- **工作台实例卡展示**：`instance-grid.js` 为每个实例卡渲染「当前项目 / 当前会话」块；远程实例
  现在也会显示 workspace/会话数（此前只显示 `remote` chip，无计数）。新增 `.current-block` 样式。
- **管线重构（向后兼容）**：
  - `lib/read-home.js`：把 `readHome` 的核心抽成 `buildSnapshot({ homePath, readText, exists })`，
    `readHome` 作为本地 fs 实现；`homeIdOf` / `parseCredentialsYaml` 签名不变。
  - `control/remote.js`：导出 `sshBash`（供远程只读读取复用），REMOTE_START 等既有导出不变。
  - `dshhome/reader.js`：新增 `indexRemoteHome`；`indexHome` 不变。
  - `dshhome/indexer.js`：构造由 `homePaths(=listLocalHomePaths)` 改为 `homes(=listHomes)` +
    可选 `remoteExec`（测试可注入假 SSH）；按 `hostType` 分流本地/远程。
  - `server.js`：索引器改用 `homes: () => store.listHomes()`。
- **测试**：新增 `tests/remote-reader.test.js`（cat 脚本标记 / parseCatOutput 缺失→null /
  `readHomeRemote` 假 ssh 产出快照并喂入 store.current / ssh 非零抛错 / 必需文件缺失降级）；
  `tests/read-home.test.js` 增 `buildSnapshot`（可插拔 readText/exists 与降级）用例；
  `tests/store.test.js` 增 `listHomes().current` 断言。共 100 用例全绿。

#### 「启动」→「连接」：默认连接到已有 dsh 实例
- 实例卡片动作按钮由「启动」改为「连接」（本机原先的 `open`/`open ↗` 统一为「连接」/「连接 ↗」），
  面板加载/失败文案由「dsh web 启动中…/启动失败」改为「连接 dsh web…/连接失败」。
- **默认行为 = 连接到已有的 dsh 实例**：
  - **远程（关键）**：`#openRemote` 默认路径是【重建一条 ssh -L 转发】接入**已在运行**的远端
    dsh web（`ensureRemoteToken` 的 ensure 模式在端口已监听时复用日志 token 或返回 `__NO_TOKEN__`，
    不做 kill/restart）；有手填 token 时直接连；仅当远端确实没在监听时才把它拉起——绝不为「连接」
    而打断一个健康实例。
  - **本地**：hwb 需持有子进程抓 token，故「连接」=「确保本地 dsh web 在跑并连入」；进程仍在则直接复用。
- `launcher.open` / `#openRemote` / `#openLocal` 注释与日志统一为「连接」语义；远端「重启/关闭」
  仍为最后手段并保留二次确认（见上文稳定第一）。

#### 连接机制原则：体验「稳定第一」+ 实例配置新增 token 直连（commit focus）
确定并落地 hwb 连接机制的核心原则：**dsh 实例以稳定运行为第一优先**——hwb 绝不因自身连接问题
（隧道断连 / 探测失败 / 远端不可达）去频繁重启或 kill 远端实例，而是把「启停」作为**用户显式授权
的最后手段**，并把「在远端自行更新 / 检查实例」的命令与提示交给用户自服务。

- **手填 token 直连（`token` 配置项）**：实例设置 / 添加表单新增 `token` 栏。用户在远端自行更新
  dsh 并读取新鉴权 token 后填入，hwb 便**直接用该 token 建隧道接入，完全不在远端启动 / 重启 /
  杀进程**——把「打断实例」的代价降到零，替代「通过重启拿 token」这一最后手段。
  - `store`（`homes.token` 列 + 迁移）、`routes`（POST/PUT 接受 `token`）、`launcher#openRemote`
    （有手填 token 则跳过 `ensureRemoteToken`）、`add-home` UI（token 输入 + 提示）全链路打通。
  - `remote.js` 新增 `normalizeWebToken(input)`：兼容 `?token=xyz` / `token=xyz` / 裸 `xyz` / 完整
    URL（含 LAN 尾部）四种粘贴形态，统一为 `?token=...` 片段；空 / `__NO_TOKEN__` / 无法识别 → null
    （回退远端抓取兜底）。
- **自服务命令提示（`selfServiceHint`）**：远端 dsh web 不可达 / 远端 home 不可访问时，报错文案
  追加「可自行在远端执行」的 ssh 命令（启动 / 读最新 token / 确认 home 存在），提示不会主动打断
  实例。设置表单里也给出读取 token 的 ssh 命令与「稳定第一」说明。
- **启停需显式授权**：前端对 `stop` / `stop-instance` / `restart`（远程）追加 `confirm()` 二次确认，
  并注明「会打断实例，仅作最后手段 / 填 token 直连更优」。

#### 结构化日志模块（`src/lib/logger.js`）
- **分级**（`debug/info/warn/error/fatal`）+ **时间戳** + **作用域**（`[server]`、`[launcher]`、
  `[monitor]`、`[indexer]`、`[proxy]`、`[remote]`、`[tunnel]`、`[api]`、`[process]`），
  一眼区分严重程度与被调用方。
- **结构化上下文**：出错时把 `homeId` / `host` / `remotePort` / 端口 / 子进程 `stderr` 尾部 /
  退出码等字段一并带上；`Error` 对象自动打印**完整堆栈**。
- **可落盘 + 轮转**：默认 `~/.hwb/hwb.log`，超过 1MiB 自动轮转保留 `.1/.2` 两代；无需盯终端
  即可查历史错误。`--no-log` 关闭落盘。
- **进程级 crash handler**：`uncaughtException` / `unhandledRejection` 统一记录（含 stack），
  避免静默吞掉异常。
- 新增 CLI 选项：`-v/--verbose`（debug 级）、`--silent`（仅落盘）、`--log <file>`、`--no-log`。

#### 出错即排查（关键路径补日志）
- **Launcher**：本地 `dsh web` 拉起失败记录完整 stderr + 端口/URL；子进程**非 0 退出（崩溃）**
  记录退出码 + stderr 尾部；`stop` 经 guard 拒绝时记录 homeId/pid；远端 `ssh` 隧道建立失败 /
  远程 dsh home 不可达记录 host + 端口 + 完整 stderr。
- **Monitor**：实例状态迁移（`degraded` → warn、恢复 → info、其余 → debug），
  degraded 记录退避秒数 + 重连次数 + lastError。
- **Proxy**：上游不可达 / 创建失败记录 target 与错误；**API** 处理抛错记录 `method + path + stack`。
- **Remote**：`ssh` 命令失败记录 `host` + 完整 `stderr/stdout` + 退出码。
- **Tunnel**：非法远程实例参数记录 host/remotePort。
- **Indexer**：单 home 索引失败 / 全域降级记录 `homeId + homePath + degraded 域`。

### Tests
- `tests/remote.test.js` 新增 `normalizeWebToken`（完整 URL / token= / 裸值 → `?token=...`；
  空 / `__NO_TOKEN__` / 非法 → null）与 `selfServiceHint`（host 缺失为 ''；给出可自行在远端
  执行的启动 / 读 token / 查 home 命令；尊重自定义 remoteCmd/remoteLog）用例。
- `tests/store.test.js` 新增 token 持久化用例：注册远程 home 记录 token、改其它字段不丢 token、
  显式清空 token（→ null）。
- 新增 `tests/logger.test.js`：分级过滤、作用域/级别标签、`Error` stack + 上下文、多行
  stderr 渲染、silent 只落盘、**文件轮转**（`.1/.2` 备份）、crash handler 注册/注销、
  **日志环缓冲**（`onLog` 订阅 / `getLogs` 级别过滤与 limit / `initLogger` 从文件尾部回填）。

---

#### 工作台「运行日志」面板（前端 + API）
- **`GET /api/logs`**：返回后端日志内存环缓冲（最近 500 条结构化条目），支持 `?level=` 按
  最低级别过滤、`?limit=` 限制条数。
- **SSE `log:event`**：每条通过阈值的新日志实时广播给前端（含上下文字段与完整堆栈）。
- **前端 `log-panel`**：工作台底部新增「运行日志」面板——分级着色
  （debug/info/warn/error）、按级别过滤（全部/错误/警告/信息/调试）、自动跟随（滚到底部恢复，
  上滚暂停）、点击某行展开/收起完整堆栈、清空视图；打开即以环缓冲历史回填，并实时追加。
- `subscribe` 扩展第三个参数 `onLog` 订阅实时日志事件；`workbench` 布局加入 `logs` 区块。

---

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

