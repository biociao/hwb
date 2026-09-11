# Changelog

All notable changes to **hwb** are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), this project adheres to
Semantic Versioning.

## [Unreleased]

> 本节原先只记了「文件预览上传」一件事，而 v0.1.1 之后其实落了 6 个功能性提交。
> 下面先把它们补记齐（按主题合并，不逐条 commit 罗列），再是后续的修复记录。

### 本轮全面回顾摘要（2026-09-12）

对 v0.1.1 之后的全库做了一轮系统回顾（4 个独立审查 + 1 轮纯函数对抗测试 + 1 轮敌意环境测试 +
1 轮针对「我自己刚改的代码」的自审），共 30+ 个提交。**最高影响**的几条（都有实测复现与回归测试）：

**用户当下就能看到是错的**
- **179 个会话里 18 个被永久标成「运行中」**，全部空闲 7–28 天 —— 判据来自会冻结的投影缓存快照，
  且 `plan.active`（持久模式开关）被当成了活动信号。修复后真实分布变为 `{idle: 147, completed: 32}`。
- **分时用量图静默丢掉「当前这一小时」**：真实库 24h 窗口丢了 3.5% 的 token；且桶是倒序。
- **额度功能整个不工作**：只要有 provider 行但缺 key（很常见），刷新就抛 TypeError，
  整批 provider 一个都进不了缓存。
- **dsh 升级会静默清空该实例的整个索引**（版本不兼容 → 该域 degraded → 整表被清），
  且界面上完全不显示 degraded。

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

**兼容**
- `engines.node` 从 `>=22` 收紧到 `>=22.5.0`（`node:sqlite` 自 22.5 才有）。
- 远端是 macOS/BSD 时端口检测恒为「未监听」→ 实例报 running 但 iframe 是 401。
- 旧版 dsh 不认识 `--no-open`：远端能用、本机连不上。

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
  实测 64 MiB 上传会在解析期间保留约 64 MiB 的 chunk 数组；上限 256 MiB 时是同一个量级。
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

### Fixed
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

