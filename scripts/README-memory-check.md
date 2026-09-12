# 前端内存对照检查（scripts/memory-check.mjs）

**为什么需要它**：实例面板里的 iframe 是一整个 dsh web SPA（自己的实时通道、会话 DOM、
插件脚本、图片缓存）。原实现「切走只 hidden、永不销毁」——切换快，代价是浏览器内存随
**访问过的实例数**单调增长、且永不归还（隐藏的 iframe 不是冻结的快照，它照旧跑定时器与动画）。

2026-09-12 在一台 MacBook 上实测到这件事的终点：Safari 的一个 WebKit WebContent 进程
**2.3 GB / 26% CPU 常驻 7 小时**（`ps -Ao pid,rss,pcpu,etime,command` 定位），
Safari 以「此网页使用了大量内存」把页面直接重载——用户看到的是工作台莫名刷新。

这类问题**单元测试看不见**：它不在函数里，而在「一个页面里同时活着几个 SPA」这个事实里。
所以需要一条真浏览器 + 真服务的对照检查。

## 它量什么

一次运行会**完全隔离地**起一个 hwb（端口 4377-4399 的约定 + `--db/--log` 都指向临时目录），
把 `PATH` 里的 `dsh` 换成一个假 dsh（每个实例页面分配固定大小的常驻内存，模拟一个跑着长会话的
SPA），再用 headless Chrome（CDP 驱动）依次点开每个实例标签。同一批实例分别用
**默认预算**与 **预算 64（≈旧的无上限行为）** 跑一遍。

三个指标互相独立、互相佐证：

| 指标 | 来源 | 为什么可信 |
|------|------|-----------|
| 活跃 iframe 数 + 预算记账 | 工作台页面里的 `document.querySelectorAll('iframe')` 与 `window.__hwbFrameBudget()` | 直接读 DOM 与前端自己的记账 |
| Chrome **进程树** RSS 之和 | 从 Chrome 主进程按 `ppid` 递归求和的全部后代（renderer/GPU/utility） | Safari 那条警告看的就是这个；按进程树而不是按命令行匹配（跨源 iframe 的 renderer 不一定继承 `--user-data-dir`） |
| **活着的实例页面**数 | 假 SPA 每 2s 向自己的 origin 打一次心跳，页面卸载时 `navigator.sendBeacon` 注销 | 服务端观测到的事实：「释放 iframe 之后那个 SPA 是不是真没了」不靠 DOM 推断 |

## 用法

```bash
node scripts/memory-check.mjs                                   # 5 个实例 × 2 组，96MB/SPA
node scripts/memory-check.mjs --instances 4 --spa-mb 64 --frames 2,64 --keep
node scripts/memory-check.mjs --dump                            # 打印 Chrome 进程树分解（排查用）
node scripts/memory-check.mjs --json                            # 末尾附 JSON（供脚本消费）
```

退出码：0 = 两组都跑完且断言通过；1 = 断言失败；2 = 环境/启动失败（端口被占、Chrome 起不来等）。

## 一次真实结果（4 实例 × 96MB/SPA）

```
▶ 预算 frames=2
  基线（工作台，零实例面板）：Chrome 进程树 RSS 1310 MB
  访问 1/4：iframe=1 活跃记账=1/2  已释放=0 活着的实例页面=1(96MB)  RSS 1433 MB
  访问 2/4：iframe=2 活跃记账=2/2  已释放=0 活着的实例页面=2(192MB) RSS 1528 MB
  访问 3/4：iframe=2 活跃记账=2/2  已释放=1 活着的实例页面=2(192MB) RSS 1545 MB
  访问 4/4：iframe=2 活跃记账=2/2  已释放=2 活着的实例页面=2(192MB) RSS 1519 MB
  ✓ 回访被释放的实例能重新挂载并重新加载（mem-0）— 重新挂载=true 页面重新活着=true

▶ 预算 frames=64（≥实例数 ⇒ 等价于旧的无上限行为）
  访问 4/4：iframe=4 活跃记账=4/64 已释放=0 活着的实例页面=4(384MB) RSS 1728 MB
```

对照：**有预算 +210 MB vs 无预算 +422 MB**（RSS 会随 Chrome 进程调度抖动，±数十 MB 属正常；
真正稳定可比的是「活着的实例页面数」与 iframe 数：2 vs 4）。

## 断言覆盖的回归点

- 有预算时活跃 iframe 数 ≤ 预算，且确实发生过释放；
- 无预算（对照）时所有实例常驻（证明对照有效，否则两组都恒过）；
- 被释放的实例页面**真的卸载了**（服务端心跳消失，而不是只摘掉一个 DOM 节点）；
- **回访**被释放的实例能重新挂载并重新加载（否则「省内存」就变成了「打不开」）；
- 有预算时浏览器 RSS 增量显著小于无预算。

## 注意

- 只碰显式 `--db/--log` 的隔离实例；默认 db 是 `~/.hwb/hwb.db`（存着你本机 dsh 的 token），
  这条脚本**绝不会**碰它。端口固定 4377-4399。
- **第一组预算必须小于实例数**（否则两组没有区别，对照实验失去意义）——脚本会直接拒绝并给出
  正确用法。默认 `--instances 5 --frames 3,64` 就是合法的。
- 收尾一定会把自己起的东西收干净：hwb 以独立进程组启动（`detached`），收尾按 `-pid` 杀整个组，
  再按临时目录路径扫一遍进程表兜底，最后删临时目录与 Chrome profile。
  **这条不是可选项**：SIGKILL 不会级联到子进程，第一版只杀 hwb，跑完留下了 33 个孤儿假 dsh
  （约 1.3 GB），比它想省的内存还多 —— 所以现在收尾会打印清扫数量。
- 需要 `CHROME_PATH` 或 macOS 默认路径下的 Chrome；不需要任何 npm 依赖（Node 22 自带 `WebSocket`）。
- `--keep` 会保留临时目录（含生成的假 dsh 与假 home），排查时有用；用完自己删。
- RSS 会随 Chrome 进程调度抖动（±数十 MB 属正常）。要判断「有没有被按住」，看**活着的实例页面数**
  与 iframe 数（确定性指标），RSS 只作旁证。
