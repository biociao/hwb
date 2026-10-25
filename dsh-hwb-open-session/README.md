# dsh-hwb-open-session

让 **hwb** 能让运行中的 **DSH（桌面 App 或 Web UI）切换到一个指定会话** —— 不改 dsh 上游，
纯插件实现。

## 为什么需要它

DSH 桌面端注册了 `dsh://`，但 `app.on('open-url')` 只处理精确的 `dsh://open` / `dsh://open/`
（仅聚焦窗口），没有「打开某个会话」的外部入口；`dsh web` 也没有 `--session` 启动参数。
于是外部进程（hwb）无法让 DSH 定位到某个会话。

本插件补一条**信使通道**：

```
hwb  ──写文件──►  <DSH_HOME>/hwb/open-session.json
                         │
DSH 进程内 Host 半 ──只读路由──►  GET /api/hwb-open-session
                         │
DSH 浏览器端 Client 半 ──轮询 + ctx.sessions.open(id)──►  UI 切到该会话
```

- **Host 半**（`lib/index.js`）：在 webServer 上注册只读路由，返回未过期的触发器。
- **Client 半**（`lib/client.js`）：每 ~1s 轮询，发现新触发器后切到该会话。
  dsh 0.2.x 把「视图选择」从 `sessions` 移到了 `uiWorkspace` 服务：
  **`ctx.uiWorkspace.openSession(sessionId)`** 才是当前正确入口
  （`ctx.sessions` 只负责 Host 目录/引用分配，**没有** `open()`；旧的
  `dsh-session-deeplink` 插件在 0.2.x 上正是因此失效）。插件同时保留
  0.1.x 的 `sessions.open()` 回退。

## 安装

**桌面 App（desktop profile）不能用 `dsh plugin --profile desktop add`** —— dsh CLI 对该 profile
有硬性保护（`profile "desktop" is managed exclusively by the Electron application`），会直接拒绝。

改用 hwb 仓库里的安装脚本（等价于一次 link 安装：编辑 profile 的 `package.json` +
建 `node_modules` 软链，写前备份）：

```sh
# 安装到桌面 App（默认 ~/.dsh/profiles/desktop）
node scripts/install-dsh-open-session.mjs

# 只预览、不写盘
node scripts/install-dsh-open-session.mjs --dry-run

# 自定义 DSH home
node scripts/install-dsh-open-session.mjs --home /path/to/.dsh

# 完全退出并重新打开 DeepSeek Harness（App 启动时加载插件）
```

安装后 hwb 的实例卡片/会话行会自动检测到插件；点击会话时 hwb 写触发器并唤起/聚焦 DSH。

> 手动安装（脚本不方便时）等价操作：在 profile 的 `package.json` 的 `dependencies` 加
> `"dsh-hwb-open-session": "link:/path/to/hwb/dsh-hwb-open-session"`，在
> `dsh.profile.bundles` 末尾加 `"dsh-hwb-open-session"`，并建
> `node_modules/dsh-hwb-open-session` → 插件目录的软链。

## 触发器文件

默认路径：`$DSH_HOME/hwb/open-session.json`（未设 `DSH_HOME` 时 `~/.dsh/hwb/open-session.json`）。
自定义 home 时在 `cordis.patch.yml` 的插件 config 里覆盖：

```yaml
- insert:
    - id: dsh-hwb-open-session
      name: dsh-hwb-open-session
      config:
        triggerPath: /your/home/.dsh/hwb/open-session.json
```

内容由 hwb 原子写入（0600）：

```json
{
  "id": "9f2c…",                       // 每次点击一个新 id（去重/防重复打开）
  "sessionId": "session-…",
  "createdAt": 1760000000000,
  "expiresAt": 1760000120000           // 默认 120s；过期后不再打开
}
```

## 安全边界

- 路由**只读**，不接受写操作；触发器路径来自部署配置，不来自请求。
- `sessionId` 只接受 `[A-Za-z0-9._:-]{1,200}`；损坏/过期/缺字段一律当作「没有触发器」。
- 触发器位于用户自己的 home（目录 0700），同机其他用户不可写；文件 0600。
- 不做任何网络外发；轮询请求与 UI 同源，走 dsh 自己的鉴权 cookie。
- 插件跑在 dsh 进程内：所有异步异常都被捕获（dsh 对插件未处理 rejection 是**整进程致命**）。

## 卸载

```sh
node scripts/install-dsh-open-session.mjs --uninstall
```

并重启 DSH。hwb 侧检测不到插件时会自动回退到原来的内嵌 iframe 打开方式。

## 开发/验证

```sh
node --check lib/index.js lib/client.js
node --test <hwb 仓库>/tests/dsh-open-session-plugin.test.js
```

Host 半的 `readTrigger()` 是纯函数；Client 半可在测试里用假的 `window.__ModuleLoader__` +
假 `ctx.sessions` + 假 `fetch` 驱动，不需要真实浏览器。
