# dsh-remote-index

轻量级「多 dsh 实例会话总览」：把本机 + 远程主机（如 `c4g.tun`）的 dsh 会话**合并**成一份统一的 projects/sessions 卡片列表，按最近活动排序。**不会读取/传输会话正文**——只读会话头部一行 + 文件 stat + 投影缓存（title / 轮数步数 / 运行中 openStep / goal / token 用量）。

## 组成

- `dsh-instance-index.mjs` — 单个实例索引器。扫 `sessions` 根目录 → 项目目录 → 会话目录，解压会话头部第一帧拿 `id/cwd/createdAt`，`stat` 拿 `updatedAt/size`，再读投影缓存做富化。输出 JSON。
  ```
  node dsh-instance-index.mjs [--root <sessions>] [--cache <projcache/sessions>] [--instance <id>]
  ```
  需要带 `node:zlib` 的 zstd 的 Node（≥22.15）。mac 默认 PATH 的 `node` 可以；c4g.tun 默认 PATH 是 v20（无 zstd），需用 nvm node，见 `instances.json`。

- `instances.json` — 实例清单。`host:null` 走本地；`host` 非空走 `ssh <host> <nodeBin> - ...`（把索引器源码经 stdin 管道到远端执行，远端无需安装本工具）。
  ```json
  {
    "instances": [
      {"id":"mac","host":null,"sessionsRoot":"/Users/ciao/.dsh/sessions","cacheRoot":"/Users/ciao/.dsh/storages/session_projcache/sessions","nodeBin":"node"},
      {"id":"c4g.tun","host":"bot@c4g.tun","sessionsRoot":"/home/bot/.dsh/sessions","cacheRoot":"/home/bot/.dsh/storages/session_projcache/sessions","nodeBin":"/home/bot/.nvm/versions/node/v24.15.0/bin/node"}
    ]
  }
  ```

- `dsh-merged-index.mjs` — 聚合器。逐实例采集 → 合并 → 按 recency 排序（project 取本身会话最大 updatedAt，session 取自身 updatedAt）。默认输出 JSON 到 stdout；`--html <out.html>` 写一个自包含卡片页；`--watch <sec>` 每隔 N 秒重采集并重写 HTML（准实时）。
  ```
  node dsh-merged-index.mjs --instances instances.json --html dsh-sessions.html --watch 10
  ```

## 数据字段（每张卡片）

`id, title, cwd(项目路径), status(running|active|idle|new), createdAt, updatedAt, sizeBytes, turns, steps, lastTurn, llmMs, toolMs, tokens, goal, runningStep` + `instance`（来源实例）。

- `status = running`：投影缓存里 `sessionStats.openStep` 非空（会话正在跑）。
- `status = active`：updatedAt 在 `--active-tol`（默认 90s）内。
- 排序一律用 `updatedAt`。

## 说明

- 「不区分本地/远程」：本项目合并后**不按实例分组**，projects、sessions 各自按最近活动排序、并列展示。每张卡片带一个中性的 host 角标（仅非 mac 实例），需要纯并列可去掉（见 `renderHtml` 里 `hostLabel`）。
- 真正塞进原生工作台 projects/sessions 列表，需在客户端 session/workspace 渲染层把本合并索引作为外部只读源注入（改动 `dsh-client-ui-workspace` → 需要 `pnpm run dev:web` 重建并刷新本 GUI）。当前版本以独立卡片页 `--html --watch` 提供同等的轻量展示。
