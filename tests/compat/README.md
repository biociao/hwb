# dsh 版本兼容性测试模块

> **用途**：dsh 升级后，几分钟内判断 hwb 是否还兼容，并给出「要改哪一行」。
>
> ```sh
> npm run compat             # 一键结论（给人看；不兼容时退出码 1，可进 CI）
> npm run test:compat        # 逐条契约测试（秒级，失败信息说改哪一行）
> npm test                   # 契约 + 全量功能测试（`npm test` 已包含本模块）
> ```

---

## 为什么需要这个模块

hwb 不是一个独立的工具 —— 它是 **dsh 磁盘格式 + CLI 表面**的消费者：

| hwb 依赖的 dsh 契约 | hwb 里的位置 |
|---|---|
| `~/.dsh/storages/workspace.json` 的 `unit.version` | `src/lib/schema.js` `SUPPORTED_VERSIONS.workspace` |
| `~/.dsh/storages/session_projcache*` 的版本与**磁盘布局** | `src/lib/schema.js` / `src/lib/read-home.js` |
| `dsh web` 启动时打印的 `dsh web: http://…/?token=…` | `src/control/launcher.js` `captureDshToken` |
| `/api/session/list` 的 RPC 命名与响应信封 | `src/dshhome/live-status.js` |
| `dsh web --port / --no-open` 的 flag 集合 | `src/control/launcher.js` |
| 前端 bundle 里被打了补丁的字符串锚点 | `src/control/workspace-menu.js` |

这些契约**没有一个是 dsh 承诺稳定的公开 API**，而 dsh 的版本号也**不遵循 semver 承诺**
（0.1.x → 0.1.5 之间就改了存储布局）。更麻烦的是**漂移的失败方式是静默的**：

- 版本白名单漏一个 → 整个域被判 `degraded` → 该实例在仪表盘上「看起来空了」；
- 只认一种磁盘布局 → 只读到一半数据，**没有任何报错**。

### 真实事故（本模块的由来）

2026-09 用 dsh **0.1.5-rc.1** 实测本机 home：

```
hwb 读到 179 个会话，磁盘上实际有 476 个 → 漏 297 个（62%），degraded = []（静默）
```

两个原因叠加：

1. **版本白名单过窄**：dsh 声明 `session_projcache` 域 `version: 7`、
   `compatibleVersions: [3,4,5,6]`，而 hwb 只认 `[3,4,5]` → 6/7 会被判 degraded。
2. **磁盘布局迁移**：dsh 已从「单文件聚合」迁到 **per-record** 布局
   （`storages/session_projcache/sessions/<id>.json`，信封 `{version, record}`），
   而 hwb 只读那个**已被冻结**的聚合文件 `storages/session_projcache.json`
   （信封 `{unit, global, tables}`）。实测聚合文件停在旧日期，per-record 目录每天在写。

两处都已修复，本模块把那两条断言固定下来，防止回退与再次漂移。

---

## 七个维度

`tests/compat/dsh-compat.test.js` 分 A–G 七组：

| 组 | 检查什么 | 漂移后的症状 |
|---|---|---|
| **A. 存储域契约** | 域的 `version` / `compatibleVersions` / `tables` / `global` 是否被 hwb 的 `SUPPORTED_VERSIONS` 覆盖 | 整域 `degraded`，实例「看起来空了」 |
| **B. 磁盘布局契约** | dsh 声明 `layout: 'per-record'` 时，hwb 是否具备 per-record 读取能力；两种信封形状是否都被认 | 静默漏数据（可漏掉大半） |
| **C. CLI 契约** | `dsh web: ` 打印行、token query 名、`printUrl` 默认值、`--version` 形状；**C2** RPC 端点首选写法；**C3** profile 模板（`dsh21-deploy.sh` 写死的那份） | 抓不到 token → 退回裸 URL → 401；端点写错 → 每次白发 404；模板变了 → 远端 headless profile 起不来 |
| **D. 真实 home 端到端** | 直接拿本机 `~/.dsh` 比对「hwb 读到的」与「磁盘上有的」 | 与 A/B 同，但用真实数据兜底 |
| **E. 域发现** | 扫描 dsh 声明的**全部**存储域，找出 hwb 还不认识的 | 新增域里可能有工作台需要的数据，会静默少读一块 |
| **F. UI 注入锚点** | 真实 `dsh-client-ui-workspace/lib/client.js` 里两个锚点是否还在（并验证注入后仍是合法 JS） | 「在 Finder 中打开」菜单静默消失 |

D 组是**唯一**能抓住「读了但读少了」这类静默故障的：A/B 查的是代码假设，D 查的是实际结果。
E 组防的是「dsh 新增了一个域、而 hwb 连它存在都不知道」——那连降级都不会有。

### 新增域时怎么办

E 组会因新域名而红，提示你评估。两条路：

- **该读**：在 `src/lib/schema.js` 加一个 `validateXxxJson`（参照 `validateWorkspaceJson`）、
  在 `src/lib/read-home.js` 的 `buildSnapshot` 里加一个 `try/catch` 块、
  在 `src/dshhome/store.js` 的 `DOMAINS` / `degradedTables` 里登记表名，
  最后把域名加进 E 组 `KNOWN` 白名单并补 A/B 组的契约断言。
- **有意不读**：把域名加进 E 组 `KNOWN` 白名单即可（表示「已知，且评估过不需要」）。
  注释里写清为什么不需要。

---

## 设计要点

### 1. 契约是**提取**出来的，不是抄的

`tests/compat/dsh-contract.mjs` 从**实际安装的 dsh** 里读权威契约：

- 定位安装根：`$DSH_INSTALL_ROOT` → PATH 上的 `dsh` → nvm 各版本 → 常见全局布局；
  兼容 **flat**（`<root>/@deepseek-ai/dsh/…`）与 **nested**
  （`<root>/@deepseek-ai/dsh/node_modules/@deepseek-ai/…`）两种布局。
- 提取 `defineDomain({...})`：**括号配平**切出对象字面量（跳过字符串与注释里的假 `defineDomain`），
  再用受限解析器取 `name/version/compatibleVersions/layout/tables` 等纯字面量字段。
- **不 `eval`、不 `import`** —— 只做文本解析，无副作用。

这样 dsh 升级后，测试报的是「dsh 现在声明了什么」而不是「我以为它声明什么」。

### 2. 测试常量**来自源码**，不是复制品

A 组直接 `import { SUPPORTED_VERSIONS } from '../../src/lib/schema.js'`。
测的是**真常量**，所以「改了源码忘了改测试」和「dsh 变了没改源码」都会红。

### 3. 找不到 dsh → `skip`，**不假装通过**

CI 上可能没装 dsh。此时整组 `skip` 并打印原因，而不是「0 个失败 = 通过」。
同理，提取不到的字段留 `undefined` 按「未知」处理，不猜。

### 4. 失败信息必须可执行

```
dsh 的 session_projcache 域接受 [7,3,4,5,6]，hwb 只允许 [3,4,5]；缺 [7,6]。
→ 需要改：src/lib/schema.js 的 SUPPORTED_VERSIONS.projcache
```

---

## dsh 升级后的操作流程

1. **升级 dsh**（换 `dsh` 二进制 / npm 包）。

2. **跑契约测试**：

   ```sh
   npm run test:compat
   ```

3. **按失败信息修**。常见三种：

   | 失败 | 改哪里 |
   |---|---|
   | `缺 [N]`（版本白名单） | `src/lib/schema.js` 的 `SUPPORTED_VERSIONS.<域>` 加上缺的版本 |
   | 布局从 `single` 变 `per-record`（或反过来） | `src/lib/read-home.js` 的 projcache 读取分支 |
   | CLI 打印行 / token 名变了 | `src/control/launcher.js` 的 `captureDshToken`、`src/control/remote.js` 的 grep |

   > 加版本前先确认**记录形状对新版仍然兼容** —— 去读 dsh 的
   > `dsh-session-projection-cache/lib/index.js` 里的 `checkpointRecord` / `checkpointIdentity`，
   > 确认新版没有删掉 hwb 要用的字段（`identity.cwd` / `identity.createdAt` / `rows[*].val`）
   > 或改变其语义。**只因为版本号变了就加白名单，是错的。**

4. **跑全量**确认没伤到功能：

   ```sh
   npm test
   ```

5. 若 dsh 的**记录形状**真的变了（不只是版本号），要同步改
   `src/lib/schema.js` 的 `projcacheRecordToSession()` —— 那是两种布局共用的字段映射。

---

## 文件

| 文件 | 作用 |
|---|---|
| `dsh-contract.mjs` | 从安装的 dsh 提取契约（存储域 / 域发现 / CLI）。可单独当调试工具用。 |
| `dsh-compat.test.js` | A–G 七组契约测试。 |
| `dsh-compat-doctor.test.js` | 生产侧自检 `src/lib/dsh-compat.js`（`hwb doctor` 用的那份）的测试。 |

单独看 dsh 当前声明了什么：

```sh
# 已知两个域的详细规格
node -e "import('./tests/compat/dsh-contract.mjs').then(m=>console.log(JSON.stringify(m.extractAllDomains(),null,1)))"

# dsh 声明的**全部**存储域（找有没有新域）
node -e "import('./tests/compat/dsh-contract.mjs').then(m=>{for(const d of m.discoverDomains().domains)console.log(d.name,'v'+d.version,d.layout||'single')})"

# hwb doctor 视角的兼容性结论
node src/cli.js doctor
```

---

## 已知的、**故意不**测的东西

诚实标注边界，避免给出虚假的安全感：

- **前端 bundle 的注入锚点**（`src/control/workspace-menu.js`）**已纳入 F 组**：
  它确实是最脆的一处（dsh 重新 minify 就失效，且 fail-closed = 静默不注入），
  现在直接拿**真实安装的 bundle** 跑注入，并验证产出是合法 JS
  （注入出语法错误比不注入严重得多 —— 会炸掉整个 dsh 前端）。
  仍未覆盖的是**注入后浏览器里的实际行为**（要有浏览器才能测），靠 `tests/workspace-menu.test.js`
  的单测兜底。
- **`/api/session/list` 的实际可用性**。测试只验证「hwb 试的顺序与 dsh 的命名不冲突」
  （两种命名都被 dsh 支持），没有真的起一个 dsh web 去发 RPC —— 那需要端口与 token，
  不适合放进单元测试。手动核对见 `src/dshhome/live-status.js` 的 `DEFAULT_ENDPOINTS`。
- **`model-tier.json`**：这是**第三方插件**（模型分层）写的文件，不是 dsh 核心。
  它的 `schema: 2` 漂移不会从 dsh 安装里提取到，只能等真实文件出现异常时才发现。
- **两个 dsh 插件**（`dsh-static-cache` / `dsh-history-delta`）依赖 dsh 内部服务名
  （`webServer` / `connection` / `apiProxy`）。这些名字**无法**从 dsh 源码可靠提取
  （服务名是运行时字符串），因此没有自动契约测试。它们的设计都是「服务缺失 → 只记一行日志、
  不阻塞启动」，所以漂移的后果是功能降级而非崩溃。

  > **已核实的风险（2026-09，dsh 0.1.5-rc.1）**：在整个 dsh 安装树里
  > `grep -r apiProxy` **零命中** —— 即 `dsh-history-delta` 依赖的服务名在当前版本里不存在，
  > 它的 `ctx.get('apiProxy')` 会拿到 undefined，走「不打补丁」分支。
  > 后果**仅限性能**：`hwb` 的代理层会退回整段重取历史（在低带宽链路上就是慢），
  > 不会错、不会崩（代理层遇到 404 会负缓存 10 分钟并整段回退，见 `src/control/proxy.js`）；
  > 且该特性**默认关闭**（`HWB_HISTORY_DELTA=1` 才启用）。
  > 换用该插件前，先在目标 dsh 上确认服务名：`grep -r apiProxy <dsh>/node_modules/@deepseek-ai/`。
  > `dsh-static-cache` 依赖的 `webServer` 在 rc.1 里**存在**，暂无此问题。
