# 端到端冒烟（scripts/smoke-e2e.mjs）

一条命令跑完整条链路，把「手动验证」固化成可重复的检查：

```bash
node scripts/smoke-e2e.mjs                    # 起在 4397，用 /tmp 下的临时目录（17 条断言）
node scripts/smoke-e2e.mjs --with-chrome      # 额外用真浏览器加载工作台并断言用量卡（19 条）
node scripts/smoke-e2e.mjs --port 4398 --keep # 换端口、保留临时目录便于排查
```

覆盖的步骤（每步都断言，失败即非 0 退出）：

| # | 步骤 | 断言要点 |
|---|------|----------|
| ① | 起一个**隔离**实例（显式 `--db/--log`） | `/api/homes` 返回 200 |
| ② | 造一个「更早用过」的假 dsh home 并注册 | 200 + 索引到 3 个会话 |
| ③ | 列表 / 工作区 | `runtime` 存在；`/api/workspaces` 有项目与 sessionCount |
| ④ | recent 两条路由 | **未连接实例时必须为空**（它们只列 `runtime=running` 的实例，界面文案写的就是这个） |
| ⑤ | 用量 | 24h 窗口为空、30 天有数据（空状态那条链）；「按实例」维度带别名 |
| ⑥ | SSE | 一次重索引必须收到 `index:updated` |
| ⑦ | 上传 / 下载 | 真实 multipart 落盘 + 内容一致 |
| ⑧ | 降级实例 | 注册一个 `unit.version` 越界的 home：必须**照常入库并标出 degraded 域**，而不是看起来「空了」（历史缺陷） |
| ⑨ | 真浏览器（`--with-chrome`） | 工作台无 console.error/未捕获异常，用量卡与 5 个周期按钮都在，且**能看到降级实例的警示 chip** |
| ⑩ | 移除实例 | 同一个 `/api/usage` 立刻不再含它（缓存不得滞后） |
| ⑪ | 优雅退出 | `SIGTERM` 后自行退出（含收子进程） |

## 注意

- **端口预检**：若目标端口上已经有东西在服务，脚本会直接拒绝启动。否则会出现一种很坑的假绿：
  上一次没退干净的实例仍在服务，本次 spawn 的服务因 EADDRINUSE 立刻退出，所有断言却打在旧实例上，
  而最后一条「SIGTERM 后自行退出」失败（第一版就这么假绿过一次）。
- 只碰隔离状态：临时目录在 `/tmp`，端口限定 4377-4399，结束（含失败）一定 kill 掉服务子进程。
- `--with-chrome` 依赖 `scripts/render-check.mjs` 能启动 Chrome（`CHROME_PATH` 可覆盖）。
