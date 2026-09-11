# 前端「真浏览器」渲染检查（scripts/render-check.mjs）

前端是「拼 HTML 字符串 + `innerHTML`」，有一类缺陷**只在真实布局里存在**：坐标轴标签与散点错位、
空状态少渲染了按钮、标签互相压字、贴边被裁掉、`fitTrendLabels()` 没被调用……单元测试拿不到
字体度量与容器宽度，纯静态审查也只能靠猜。本项目的多轮审查里，最有价值的前端发现
（x 轴错位 61%、空状态点不到周期按钮）全部来自真浏览器。

## 为什么不用 `--dump-dom`

`--dump-dom` 要等页面**网络空闲**才输出，而 hwb 前端有一条常驻 SSE（`/api/events`）——
它永远不空闲，于是 `--dump-dom` 实测 30s 超时、输出 0 字节。另外 `--user-data-dir` 必须显式给
（默认目录在受限环境里创建失败：`Failed to create a unique user data directory for headless.`）。

本脚本改用 **CDP**（Chrome DevTools Protocol）：自己决定何时取值，还能顺带收集
`console.error` 与未捕获异常。Python/Node 之外**不需要任何依赖**（Node 22 自带 `WebSocket`）。

## 用法

```bash
# ① 直接检查一个真实页面（自带 Chrome，macOS 默认路径见脚本内 DEFAULT_CHROME，可用 CHROME_PATH 覆盖）
node scripts/render-check.mjs --url http://127.0.0.1:4310/ \
     --wait-ms 3000 --expr 'return document.title'

# ② 用仓库自带的渲染夹具（--serve 会把仓库根当静态站起在随机端口；组件是 /src/... 的 ESM，
#    file:// 下会被 CORS 挡掉，所以必须有 http 源）。宽度扫描是现成的例子：
node scripts/render-check.mjs --serve --url /scripts/render-harness.html \
     --wait-ms 3000 --expr-file scripts/render-check-widths.js
```

表达式在页面里以 async 函数体执行，`return` 的值会被 JSON 序列化后打印。

### 宽度扫描（scripts/render-check-widths.js）

把 6 种卡片宽度 × 3 种数据形态（满窗口 / 稀疏 / 末尾聚集）跑一遍，逐条量
「标签是否对齐散点、是否互相重叠、是否越出绘图区」。最近一次结果（修复后）：

| 形态 | 300px | 360px | 480px | 640px | 900px | 1200px |
|------|-------|-------|-------|-------|-------|--------|
| 满窗口（60 桶都有数据） | 3 标签 | 4 | 4 | 7 | 8 | 8 |
| 稀疏（5 个非空） | 1 | 1 | 2 | 2 | 3 | 3 |
| 末尾聚集（末尾 5 桶） | 1 | 1 | 1 | 1 | 1 | 1 |

18/18 通过：偏差全为 0.0px、无重叠、无越界。**这张表就是「为什么不能用静态常量」的证据**：
同一组数据在 242px 的绘图区与 1142px 的绘图区里，能放下的标签数差 3 倍。

输出：`{ ok, result, consoleErrors, exceptions }`；退出码 0 = 表达式执行成功且无
`console.error`/未捕获异常，1 = 有异常，2 = 启动或连接失败。

## 检查脚本的写法

```js
// /tmp/check.js —— 断言用「收集 + 汇总」的写法，把每一条的实测值都带出来（失败时才有线索）
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (name, pass, detail) => checks.push({ name, pass, detail });

document.querySelector('#usage-period-toggle button[data-period="30d"]')?.click();
await wait(2500);   // 点击会触发一次 fetch + 重渲染

const card = document.getElementById('usage-card');
const dots = [...card.querySelectorAll('.trend-dot')].map((d) => {
  const r = d.getBoundingClientRect();
  return r.left + r.width / 2;
});
check('有散点', dots.length > 0, `dots=${dots.length}`);
return { checks, ok: checks.every((c) => c.pass) };
```

## 已用它验证过的场景（回归清单）

| 场景 | 断言 | 依据 |
|------|------|------|
| 空窗口（默认 24h 无数据、30 天有数据） | `#usage-period-toggle button` 数量 = 5，文案含「这个窗口」 | 否则用户点不到任何周期按钮，永远放宽不了窗口 |
| 稀疏窗口（60 桶里 5 个非空） | 每个可见标签与某个散点对齐 <1.5px、互不重叠、不越出绘图区 | 标签按序号等分 vs 散点按时间 ⇒ 错位 61% |
| 拆维度（按项目） | 不存在 `data-tok="0"` 的散点 | 0 值点全叠在 0% 基线上 |
| 运行日志面板 | `#log-entries .log-row` > 0 | 首屏快照失败一次就永远空着 |
| 添加实例的 warning | 提交后与 **SSE 刷新之后**提示条都可见 | 普通提示会被成功刷新撤掉，粘性提示不该 |
| 6 种宽度 × 3 种数据形态 | 18/18：标签对齐 0.0px、不重叠、不越界 | 标签宽度取决于字体与卡片宽度，静态常量算不出来 |

## 准备数据（隔离实例，别碰用户的服务）

```bash
# 用显式 --db/--log 起一个隔离实例（注意：`node src/server.js` 的默认 db 是 ~/.hwb/hwb.db，
# HWB_DIR 只对 `hwb`/`hwb serve` 生效，直接跑 server.js 时必须自己传 --db）
node src/server.js --port 4397 --db /tmp/hwb-dash/hwb.db --log /tmp/hwb-dash/hwb.log

# 造一个「旧数据」的假 home（会话在 6 天前 ⇒ 默认 24h 窗口为空、30 天有数据），
# 然后 POST /api/homes { homePath } 让服务端索引它
```

清理：`kill <pid>`；临时目录都在 `/tmp`，不要用 `rm -rf` 碰 `~/.hwb`。
