# Changelog

All notable changes to **hwb** are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), this project adheres to
Semantic Versioning.

## [Unreleased]

### Added

#### 文件预览侧栏支持拖拽上传（src/web/components/file-preview.js + src/lib/file-preview.js + src/api/routes.js）
- 浏览目录时侧栏显示上传区：拖拽文件到侧栏即上传到**当前预览目录**，也可点「选择文件上传」；
  多文件串行上传并显示整批进度，完成后自动刷新目录列表。单文件上限 256 MiB（前端先过滤超限文件）。
- 新增 `PUT /api/homes/{homeId}/upload`：只接受 multipart 文件字段，落盘位置完全由服务端依据
  已登记工作区 + 当前目录决定（只取文件名，`..`/符号链接/工作区外路径全部拒绝），跨站写入返回 403。
- **同名不覆盖**：已存在 `data.csv` 时新文件落为 `data(1).csv`（本机与远端一致）。
- 原子落盘：先写隐藏临时文件、写满后 `link`/`replace` 到最终名；中断只会留下隐藏临时文件，
  且 `stage`/`cleanup`/`commit` 都会清掉暂存目录，不在项目目录留副产物。

### Notes

- 远程实例的上传**内容经命令行参数按 512 KiB 分片传输**（远端先分片落盘到临时目录再合并）。
  实测把文件字节写到 `sshBash` 的 stdin 不可行：`bash -s` 会把脚本之后的字节当命令执行
  （表现为 `...: command not found`，Python 一个字节都读不到）；而「长度前缀」之类的 stdin 协议
  又会被 bash 的预读吞掉，无法保证字节边界。分片参数传输没有这个问题，也不受 macOS 单参数上限影响。
- 上传的 multipart 解析是流式的（`src/lib/multipart.js`）：边解析边把文件字节交给写入端，
  内存占用与文件大小无关；缺失 `Content-Length` 时直接拒绝，以保证写盘前就能设限。

### Fixed

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

### Fixed

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

---

## Unreleased

（预留下一版本变更记录。）
