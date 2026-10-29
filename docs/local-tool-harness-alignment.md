# 本地工具实例的统一处理（Codex / dsh 桌面 / WorkBuddy）

> 状态：实现契约（本文件先于代码落地，供后端 / 前端 / 测试按同一份口径实现）。
> 目标读者：改 `src/`、`src/web/`、`tests/` 的人。

## 1. 问题

Instances 里的「本地工具」此前各写各的：Codex 卡有 `[Codex]` 标识 + `已就绪` +
`打开 Codex`，却没有版本号；本地 dsh 只读卡有 `dsh 0.2.0-rc.2` 版本号，状态位却写着
`只读`（这是「类型」不是「状态」），也没有 `打开` 动作；两者的时间口径一个是
`检查 <runtime.checkedAt>`、一个是 `索引 <lastIndexedAt>`。同一类实例长成两张不同的卡，
用户无法用同一套心智去读。

Data plane 里也有同源问题：版本解析器把 **dsh 的版本号**塞进了 Codex 卡（`runtime.dshVersion`
对 Codex 也被填成 `0.2.0-rc.2`），而跳转/注册/设置/禁用标签页等分支散落在
`harness === 'codex'` 的硬编码里。

## 2. 统一语义

**本地工具实例（local tool）**：只读本地元数据、没有进程 / 端口 / token / 隧道的实例。当前集合：

| harness | home 默认值 | 哨兵文件 | 版本来源 | 打开方式 |
| --- | --- | --- | --- | --- |
| `codex` | `~/.codex` | `state_5.sqlite`、`.codex-global-state.json` | standalone current 软链 / `version.json` | `codex://threads/<id>` |
| `workbuddy` | `~/.workbuddy` | `workbuddy.db` | `startup-seed-version.json` | `workbuddy://chat/<id>` |
| `dsh` + `readOnly:true` | `~/.dsh` | `storages/workspace.json` | dsh 自己的版本（现有 `DshVersionResolver`） | `dsh-hwb-open-session` 插件；无会话/无插件时聚焦 DSH 桌面端 |

判定：`harness === 'codex' || harness === 'workbuddy' || (harness === 'dsh' && readOnly === true)`。
这个判定只允许存在于 `src/lib/harnesses.js`（后端）与 `src/web/store.js`（前端）各一处。

**状态**：只用两种，与 Codex 卡原有语义一致：

- `已就绪` —— `runtime.runtime === 'running'`（home 目录存在；索引成败不影响这一位，索引问题走 `⚠ <域> 降级`）
- `路径缺失` —— 其余（monitor 判定 `gone`）

「只读」不再占状态位：它是这类实例的**类型说明**，写在版本身份 chip 的 `title` 里。

**版本号**：所有本地工具都显示，取不到就不显示（不画占位符）。chip 文本 = `<label> <version>`：

- `Codex 0.153.4`
- `WorkBuddy 5.8.3`
- `dsh 0.2.0-rc.2`

**索引时间**：统一用 `lastIndexedAt`，文本 `索引 just now`；未索引过显示 `尚未索引`。
不再用 `runtime.checkedAt`（那是心跳时间，且 Codex/monitor 写的是毫秒数、连接型 dsh 写的是 ISO，
口径本来就不同）。

**动作**：`打开 <工具>（primary）`、`重新索引`、`⚙ 设置`。顺序与样式对所有本地工具一致。
`打开` 的语义 = 打开该工具并尽量落到最近一条会话；无会话时聚焦/启动应用。

## 3. 卡片规格（`src/web/components/instance-grid.js`）

对本地工具渲染同一段模板（不再有 `codexCard` / `readOnlyDshCard` 两套）：

```
name（alias || serverId || homePath）
  chips: [ <label> <version> ](chip harness-<id>) [ 已就绪 | 路径缺失 ](chip ok|bad) [ ⚠ 域降级 ]…
  meta:  <N> projects   <M> sessions   索引 <timeAgo(lastIndexedAt) | 尚未索引>
  actions: [ 打开 <label> ](primary, data-action="local-tool-open")
           [ 重新索引 ](data-action="reindex")
           [ ⚙ 设置 ](data-action="settings")
```

- 版本身份 chip 保留既有 class `chip harness-codex`，新增 `chip harness-workbuddy`、
  `chip harness-dsh`（`index.html` 用项目色，不用状态色）。`title` 说明「只读接入的
  <label> 本地实例（版本 <version|未知>）」。
- `data-action="local-tool-open"` 与 `data-home-id` 是 app.js 的契约；点击走统一
  `POST /api/harness/open`。

## 4. API 契约

### 4.1 `GET /api/homes`

本地工具实例的 `runtime` 新增两个**已归一化**字段，前端不再自己拼：

- `runtime.toolLabel`: `'Codex' | 'WorkBuddy' | 'dsh' | null`
- `runtime.toolVersion`: 干净版本字面量或 `null`

`runtime.dshVersion` 保留（兼容旧前端/测试），但**只对 `harness === 'dsh'` 赋值**；
其它 harness 一律 `null`（修掉 Codex 卡显示 dsh 版本的问题）。

### 4.2 `POST /api/harness/open`

统一本地工具跳转。body：`{ homeId: string, sessionId?: string, projectId?: string }`。

- 未知 home → 404；非本地工具实例 → 400。
- 目标解析：`sessionId` > `projectId` 的最近一条会话 > 该实例最近一条会话。
- `codex` → `codex://threads/<uuid>`；`workbuddy` → `workbuddy://chat/<uuid>`；
  `dsh`（只读）→ 插件触发器；无会话或插件缺失时聚焦/启动 DSH 桌面端并返回
  `{ok:true, code:'app-focused', note}`。
- 成功 200：`{ok:true, homeId, harness, sessionId, url, fallback?, code?}`；
  无法唤起 502：`{ok:false, ..., error, fallback?}`。
- 只接受合法 id（Codex/WorkBuddy 都是 UUID），非法 id 一律 400 —— 这是无鉴权本机接口，
  不能变成任意深链派发器。
- 既有 `POST /api/codex/open`、`POST /api/homes/{homeId}/open-session` 行为不变（前端改走统一入口）。

### 4.3 `POST /api/homes`（注册）

- 新增 `{ harness: 'workbuddy', homePath?, alias? }`：默认 `~/.workbuddy`（`WORKBUDDY_HOME` 可覆盖），
  目录不存在 400，注册后立即索引 + 刷新 runtime，返回
  `{homeId, harness:'workbuddy', warning, result}`；`warning` 在缺 `workbuddy.db` 时给出。
- Codex 分支改为由 harness 描述符驱动（行为不变）。
- `PUT /api/homes/{id}`：本地工具的配置面只有 `alias` + `homePath`。

### 4.4 `GET /api/homes/detect`

保留顶层 dsh 字段与 `codex`，新增 `workbuddy: { path, exists, looksLikeWorkbuddy }`。

## 5. 后端模块边界

- `src/lib/harnesses.js`（新）——本地工具描述符的唯一来源：
  - `LOCAL_TOOL_HARNESSES`（`['codex','workbuddy']`）
  - `isLocalToolHome(home)`、`localToolLabel(home)`（卡片/按钮用 `Codex|WorkBuddy|DSH`）
  - `localToolDefaultHome(harness)`、`localToolHomePlaceholder(harness)`
  - `detectLocalTool(harness)` → `{path, exists, looksLike…}`
  - `LOCAL_TOOL_SOURCES`：`{ harness: { label, readSnapshot({home}), indexRows(home, snapshot), resolveTarget(home, {sessionId, projectId}), open(sessionId) } }`，
    供 indexer / routes / server 使用。
- `src/lib/tool-version.js`（新）——`resolveToolVersion(home)` → `{label, version} | null`；
  本地文件读取、30 分钟缓存、版本号按 `/^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/` 白名单。
  dsh 不在这里（沿用 `DshVersionResolver`）。
- `src/workbuddyhome/reader.js`（新）——只读 `workbuddy.db`（WAL 安全：readOnly → immutable 回退），
  产出 `{generatedAt, workspaces, sessions, reasons}`。
- `src/workbuddyhome/index-rows.js`（新）——同构 workspace/session 行（与 `codexhome/index-rows.js` 同口径）。
- `src/workbuddyhome/open.js`（新）——UUID 校验 + `workbuddy://chat/<id>` + `open(1)` / 可复制回退命令。
- `src/dshhome/indexer.js` —— `harness !== 'dsh'` 一律走 `#indexLocalToolHome`（按 `LOCAL_TOOL_SOURCES`
  取 reader/indexRows；保留 `codex` 构造参数兼容一个版本）。
- `src/control/monitor.js` —— 本地工具统一按 home 目录存在与否标 running/gone（用 `isLocalToolHome`）。
- `src/dshhome/store.js` —— `registerHome` 接受 `workbuddy`（仅 local）；`readOnly` 标记仍只用于 dsh。
- `src/api/routes.js` / `src/server.js` —— 按 §4 接线；`runtimeOf` 注入 `toolLabel/toolVersion`；
  5xx/注册/设置/启停拒绝等分支改用 `isLocalToolHome`。
- `src/lib/open-session.js` —— 新增 `openDshApp()`（无会话时聚焦/启动 DSH，供 `app-focused` 用）。

## 6. WorkBuddy 数据口径

只读 `<home>/workbuddy.db`（不读会话正文、不写库）：

- `workspaces(path, last_opened_at)` → 项目；`sessions(id, cwd, title, custom_title, status,
  created_at, updated_at, last_activity_at, model, project_id)`，`deleted_at IS NULL`。
- 项目归属：session 的 `cwd` 按**最长前缀**匹配 `workspaces.path`；匹配不到时按
  `basename(cwd)` 归一化（与 dsh/codex 对未归属会话的口径一致）。
- 时间：`last_activity_at`（毫秒）优先，回退 `updated_at`；ISO 输出。
- 状态：`completed` → `{kind:'completed', label:'已完成'}`；其余（terminated/error/failed）→
  `{kind:'idle', label:'已保存'}`。WorkBuddy 的元数据里没有运行态，**不对它推断运行中**。
  （注意 Codex 已不再与之一致：它从 `thread_history_<N>.sqlite` 的 `thread_turns` 推出了
  运行中/空闲 + 未读，见 README「Codex 作为实例接入」。）
- token：`session_usage.used/size` 语义是上下文用量，**不**伪装成 input/output；本期
  `tokenUsage`/`contextPressure` 先留 `null`（后续确认口径再加）。
- 版本：`startup-seed-version.json.appVersion`，回退 `app/renderer-version.json.version`。
- 降级：库缺失/损坏 → 该实例 `⚠ workbuddy 降级`（`reasons` 进 home 行），不影响其它实例。

## 7. 非目标

- 不写 WorkBuddy/Codex/dsh 的任何状态库；不读会话正文。
- 不改 dsh 可连接实例的既有语义（`已连接 / 连接不可达 / 未连接`、iframe、端点、token）。
- 不新增 WorkBuddy 的 Token 用量拆分（口径未确认）。
- 不为本地工具恢复 iframe / 标签页（它们没有 Web 页面）。

## 8. 验收

- 新增/更新的测试：
  - `tests/workbuddy-reader.test.js`、`tests/workbuddy-index.test.js`、`tests/tool-version.test.js`
  - `tests/harness-open.test.js`、`tests/workbuddy-api.test.js`
  - `tests/local-tool-cards.test.js`（统一卡 HTML 契约）
  - 更新 `tests/codex-instance-ui.test.js`、`tests/local-dsh-readonly.test.js`、`tests/codex-index.test.js`
- `node --test tests/*.test.js` 除既有环境性失败外全绿（基线见交接说明）。
- 手工：`curl /api/homes` 看到三个本地工具的 `toolLabel/toolVersion` 一致；点「打开」落到最近会话。

---

## 9. 实现验收记录（2026-10-25）

状态：**已实现并独立验收**。契约主体达成；1 处口径偏差 + 2 处契约未写明处记录在 §9.4。

### 9.1 自动化测试

`npm test`（= `node --test tests/*.test.js tests/compat/*.test.js`），验收环境 Node v22.21.1 / macOS：

| 运行 | tests | pass | fail | skipped |
|---|---|---|---|---|
| 验收前（只有三条实现任务的代码，文档未补） | 1175 | 1170 | 4 | 1 |
| 文档收尾后（最终） | 1175 | 1171 | 3 | 1 |

- 最终的 3 条 `not ok` 全部是**已知环境性基线**（与本次实现无关）：
  1. `tests/compat/dsh-compat.test.js` →「E. 域发现」的子用例「没有 hwb 还不认识的新域」：
     已安装 dsh 0.2.1-alpha.2 多声明了 `schedule` 域，需人工评估是否该读（基线 1）。
  2. `tests/file-upload-inject.test.js` →「针对真实安装的 dsh bundle 注入」：上游 `client.js`
     的注入锚点变了，注入按设计 fail-closed（基线 2）。
- 验收前多出的第 4 条是**纯文档问题**：`tests/docs-consistency.test.js` 提示 README 的 REST API
  表缺少已实现的 `POST /api/harness/open`。已在 README 补表，复跑转绿（未改 `src/**`、`tests/**`）。
- 本次相关用例全绿：`tests/harnesses.test.js`、`tests/tool-version.test.js`、
  `tests/harness-open.test.js`、`tests/workbuddy-reader.test.js`、`tests/workbuddy-index.test.js`、
  `tests/workbuddy-index-rows.test.js`、`tests/workbuddy-api.test.js`、`tests/local-tool-cards.test.js`、
  `tests/codex-index.test.js`、`tests/codex-instance-ui.test.js`、`tests/local-dsh-readonly.test.js`。
- 文档自校验：`node --test tests/docs-consistency.test.js tests/docs-references.test.js
  tests/docs-flags.test.js` → 16 项全绿。

### 9.2 黑盒检查（读测试 + 复核实现，未改 `src/**`）

- `POST /api/harness/open`：未知 home → 404、非本地工具 → 400、跨站写 → 403、数据面未启用 → 503、
  非法会话 id → 400（且**绝不调用 open**）、唤起失败 → 502（带可复制回退）——
  `tests/harness-open.test.js` 全部覆盖。
- dsh 只读：有会话走插件触发器（in-app）、按 `projectId` 找该工作区最近会话、无会话/插件缺失 →
  200 `code:"app-focused"`、非法 id → 400 不退化成聚焦 App、App 也唤不起 → 502。
- WorkBuddy reader：以 `readOnly` 打开（`DatabaseSync(..., { readOnly: true })`，失败再试
  `?immutable=1`），只有 `SELECT`、没有写语句。测试断言「只读打开：不创建 `-wal`/`-shm`，
  库文件字节/mtime 不变」（`tests/workbuddy-reader.test.js`、`tests/workbuddy-index.test.js`）。

### 9.3 安全复核（只读）

- **深链白名单**：`POST /api/harness/open` 只接受 store 里已注册的本地工具实例；Codex/WorkBuddy
  的会话 id 必须过 UUID 正则（`isThreadId` / `isWorkbuddySessionId`），非法一律 400，不把任意
  输入拼进 `codex://` / `workbuddy://`。dsh 只读的 `sessionId` 仍过 `SESSION_ID_RE`
  （`^[A-Za-z0-9._:-]{1,200}$`）；`projectId` 只用于在 store 索引里查表，不进入 URL/命令。
- **命令注入**：唤起桌面端统一 `execFile('/usr/bin/open', [url], { timeout })` —— 固定可执行文件、
  argv 数组、不经 shell；URL 由已校验的 UUID 构造。非 macOS 不猜 `xdg-open`/`start`，直接返回
  可复制命令。
- **HTML 转义**：本地工具卡的 `alias` / `homePath` / `toolLabel` / `toolVersion` / 降级原因全部过
  `esc()`；版本 chip 的 `class` 由 harness 白名单（`harness-codex|workbuddy|dsh`）决定，不从 label 拼。
  WorkBuddy 的项目/会话标题走与 dsh/Codex 相同的 `recent-projects.js` / `recent-sessions.js` 渲染，
  逐字段 `esc()`（reader 另外把控制字符压成单行并截断）。
- **数据面只读**：`src/workbuddyhome/reader.js` 只读 `<homePath>/workbuddy.db`，路径由已注册 home
  拼接（注册时校验目录存在），没有「读之外」的写路径；不读会话正文。
- **残留硬编码**：`src/` 里剩余的 `harness === 'codex'` 只在兼容路由 `POST /api/codex/open`
  （旧入口，行为不变）与前端表单传输/白名单校验（`app.js` 的 `addHome` / `add-detected`、
  `add-home.js` 的 form mode）里；本地工具**判定**只有 `lib/harnesses.js` 与 `web/store.js` 各一处。

### 9.4 偏差 / 契约未写明处

1. **dsh 的 label 用小写 `dsh`**：§2 的 chip 文本与 §4.1 的 `runtime.toolLabel` 都写 `dsh`，
   §5 散文里写成 `Codex|WorkBuddy|DSH` 是笔误；实现按 §2/§4.1（`localToolLabel` 返回 `'dsh'`）。
2. **Codex/WorkBuddy 解析不到目标会话时的状态码**：§4.2 只写了 dsh 的 `app-focused` 回退；
   实现里 Codex/WorkBuddy 没有可跳转会话时回 400（它们只能落到具体会话的深链）。
3. **`detectLocalTool(harness, homePath?)` 多了可选第二参**：注册/设置表单要探测用户填的路径，
   缺省仍是 `localToolDefaultHome(harness)`，与 §5 的单参形状兼容。

### 9.5 建议的手工验证

```bash
curl -s 'http://127.0.0.1:4310/api/homes' | head -c 1200        # 三个本地工具的 runtime.toolLabel/toolVersion 一致
curl -s 'http://127.0.0.1:4310/api/homes/detect' | head -c 600  # codex / workbuddy 段
curl -s -X POST 'http://127.0.0.1:4310/api/harness/open' \
  -H 'Content-Type: application/json' -d '{"homeId":"<workbuddy homeId>"}'
# 反例（应 400）：非法会话 id 不得派发深链
curl -s -X POST 'http://127.0.0.1:4310/api/harness/open' \
  -H 'Content-Type: application/json' -d '{"homeId":"<codex homeId>","sessionId":"javascript:alert(1)"}'
```

