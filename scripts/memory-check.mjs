#!/usr/bin/env node
// hwb 前端内存对照检查：iframe 预算到底有没有把浏览器内存按住（headless Chrome + CDP）。
//
// 为什么需要它：实例面板的 iframe 是一整个 dsh web SPA，「切走只 hidden」的代价在单元测试里
// 完全看不见 —— 它只在**真浏览器**里表现为进程常驻内存。2026-09-12 实测本机 Safari 的一个
// WebKit WebContent 进程 2.3 GB / 26% CPU 常驻 7 小时，Safari 以「此网页使用了大量内存」重载页面。
// 这条脚本把「访问 N 个实例之后浏览器还占多少内存」变成可重复、可对照的数字。
//
// 做法：完全隔离地起一个 hwb（端口 4377-4399 的约定 + 临时 db/log），用 PATH 里的**假 dsh**
// 顶替真 dsh（每个实例页面都分配固定大小的常驻内存，模拟一个跑着长会话的 SPA），再用 headless
// Chrome 依次点开每个实例标签。同一批实例分别用「默认预算」与「预算 64（≈旧的无上限行为）」跑一遍。
//
// 量三件事，互相独立、互相佐证：
//   ① 工作台页面里的 iframe 数 + hwb 自己的预算记账（`__hwbFrameBudget()`）；
//   ② Chrome **进程树**的 RSS 之和（含 renderer/GPU/utility）—— Safari 那条警告看的就是这个；
//   ③ 服务端观测到的「活着的实例页面」数：每个假 SPA 每 2s 向自己的 origin 打一次心跳，
//      页面被卸载时再发一次 sendBeacon 注销。于是「释放 iframe 之后那个 SPA 是不是真没了」
//      是**服务端看到的事实**，而不是从 DOM 上推断出来的。
//
// 用法：
//   node scripts/memory-check.mjs                              # 5 个实例 × 2 组，96MB/SPA
//   node scripts/memory-check.mjs --instances 4 --spa-mb 64 --frames 2,64 --keep
//   node scripts/memory-check.mjs --dump                       # 打印 Chrome 进程树分解（排查用）
// 退出码：0 = 两组都跑完且断言通过；1 = 断言失败；2 = 环境/启动失败。
//
// 安全约定：只用显式 --db/--log 的隔离实例（默认 db 是 ~/.hwb/hwb.db，绝不能碰），
// 端口固定 4377-4399，结束（含失败）时一定 kill 掉自己起的所有子进程。

import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt;
};
const PORT = Number(arg('port', '4396'));
const INSTANCES = Number(arg('instances', '5'));
const SPA_MB = Number(arg('spa-mb', '96'));
const FRAME_BUDGETS = String(arg('frames', '3,64')).split(',').map((n) => Number(n.trim()));
const KEEP = process.argv.includes('--keep');
const DUMP = process.argv.includes('--dump'); // 排查用：打印 Chrome 目标清单与进程树分解
const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const chromePath = process.env.CHROME_PATH || DEFAULT_CHROME;

// 端口隔离是硬约定：越界的端口可能撞上用户正在跑的 hwb / dsh 实例（默认 4310）。
if (!(PORT >= 4377 && PORT <= 4399)) {
  console.error(`端口必须在 4377-4399（隔离约定），收到 ${PORT}`);
  process.exit(2);
}
if (!Number.isInteger(INSTANCES) || INSTANCES < 2 || INSTANCES > 12) {
  console.error(`--instances 必须是 2-12 的整数，收到 ${arg('instances', '')}`);
  process.exit(2);
}
if (FRAME_BUDGETS.some((n) => !Number.isInteger(n) || n < 1)) {
  console.error(`--frames 必须是 ≥1 的整数列表，收到 ${arg('frames', '')}`);
  process.exit(2);
}
// 第一组是「被预算管住」的那组、最后一组是「≈旧行为」的对照。两者相同 ⇒ 没有任何对照可言
// （实测过一次：--instances 2 --frames 2,64 会让 RSS 对照断言失败，而真正的问题是用例本身没意义）。
if (FRAME_BUDGETS[0] >= INSTANCES) {
  console.error(`第一组预算（${FRAME_BUDGETS[0]}）必须小于实例数（${INSTANCES}），否则两组没有区别；`
    + `例如 --instances ${INSTANCES} --frames ${Math.max(1, INSTANCES - 1)},64`);
  process.exit(2);
}
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
let failed = 0;
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) });
  if (!ok) failed++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = (kb) => Math.round(kb / 1024);

// —— 隔离目录：state（db/log）+ fakebin（假 dsh）+ 活页面登记目录 ——
const dir = mkdtempSync(path.join(tmpdir(), 'hwb-mem-'));
const state = path.join(dir, 'state');
const fakebin = path.join(dir, 'fakebin');
const liveDir = path.join(dir, 'live-spa');
mkdirSync(state, { recursive: true });
mkdirSync(fakebin, { recursive: true });
mkdirSync(liveDir, { recursive: true });

// 假 dsh：只做四件事 —— 打印带 token 的入口行（hwb 从 stdout 抓）、把页面发出去、
// 登记「哪个实例页面还活着」（心跳 + 卸载注销）、别的一律 404。
// 页面必须**真的占住常驻内存**（逐页写满的 Uint8Array）：只声明不触碰的内存不会体现在 RSS 上，
// 那会让整条测量失去意义。页面里那个 setInterval 也是刻意的：隐藏的 iframe 不是冻结的快照。
const fakeDsh = `#!/usr/bin/env node
const http = require('node:http');
const fs = require('node:fs');
const args = process.argv.slice(2);
const pi = args.indexOf('--port');
const port = pi >= 0 ? Number(args[pi + 1]) : 0;
const MB = Number(process.env.HWB_PROBE_SPA_MB || '${SPA_MB}');
const live = ${JSON.stringify(liveDir)};
const marker = live + '/' + port + '.json';
const token = 'probe-' + port;
const page = \`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>fake dsh web</title></head>
<body><div id="app">fake dsh web :\${port}</div>
<script>
const box = [];
for (let i = 0; i < \${MB}; i++) { const chunk = new Uint8Array(1048576); chunk.fill(i % 251); box.push(chunk); }
window.__spaHeapMB = \${MB};
const beat = () => fetch('/__hwb_probe_alive?mb=' + \${MB}, { cache: 'no-store' }).catch(() => {});
beat();
setInterval(() => { const el = document.getElementById('app'); if (el) el.textContent = 'fake dsh web :\${port} ' + Date.now(); beat(); }, 2000);
addEventListener('pagehide', () => navigator.sendBeacon('/__hwb_probe_gone'));
</script></body></html>\`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/__hwb_probe_alive') {
    try { fs.writeFileSync(marker, JSON.stringify({ port, mb: Number(url.searchParams.get('mb')), at: Date.now() })); } catch {}
    res.writeHead(204); res.end(); return;
  }
  if (url.pathname === '/__hwb_probe_gone') {
    try { fs.rmSync(marker, { force: true }); } catch {}
    res.writeHead(204); res.end(); return;
  }
  if (url.pathname === '/' && url.searchParams.get('token') === token) {
    res.writeHead(303, { location: '/', 'set-cookie': 'dsh_probe=1; Path=/; HttpOnly' }); res.end(); return;
  }
  if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(page); return; }
  res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found');
});
server.listen(port, '127.0.0.1', () => {
  console.log('dsh web: http://127.0.0.1:' + port + '/?token=' + token);
});
process.on('SIGTERM', () => process.exit(0));
`;
writeFileSync(path.join(fakebin, 'dsh'), fakeDsh);
chmodSync(path.join(fakebin, 'dsh'), 0o755);

// 假 dsh home：与 scripts/smoke-e2e.mjs 同构（一份能索引的 workspace.json + session_projcache.json）。
const homes = [];
for (let i = 0; i < INSTANCES; i++) {
  const home = path.join(dir, `home-${i}`);
  const proj = path.join(home, 'proj');
  mkdirSync(path.join(home, 'storages'), { recursive: true });
  mkdirSync(proj, { recursive: true });
  writeFileSync(path.join(proj, '.keep'), '');
  const sessionId = `sess-${i}`;
  writeFileSync(path.join(home, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: [`ws-${i}`], archivedSessionIds: [] },
    tables: { workspaces: { [`ws-${i}`]: { title: `内存检查项目 ${i}`, path: proj, sessionIds: [sessionId], createdAt: 1, updatedAt: 2 } } },
  }));
  writeFileSync(path.join(home, 'storages', 'session_projcache.json'), JSON.stringify({
    unit: { name: 'session_projcache', version: 3 },
    global: null,
    tables: { sessions: { [sessionId]: {
      identity: { createdAt: Date.now() - 3600_000, cwd: proj },
      rows: {
        title: { ver: 1, seq: 1, val: `内存检查会话 ${i}` },
        tokenUsage: { ver: 1, seq: 1, val: { totals: { uncachedInputTokens: 1000, outputTokens: 100, cacheReadTokens: 10, cacheWriteTokens: 1 }, last: null } },
        sessionListMetadata: { ver: 1, seq: 1, val: { blank: false, lastPromptAt: Date.now() } },
      },
    } } },
  }));
  homes.push({ home, alias: `mem-${i}` });
}

// 预检：端口上有东西在听就直接退出，否则断言会打在**别的**服务上（假绿）。
if (await fetch(`${BASE}/api/homes`).then(() => true, () => false)) {
  console.error(`端口 ${PORT} 上已经有东西在服务（很可能是上一次没退干净的 hwb）。换端口，或先停掉它。`);
  process.exit(2);
}

const children = [];
// 兜底清扫：假 dsh 是 hwb 的**子进程**，而 SIGKILL 不会级联到子进程 —— 只杀 hwb 会留下一堆
// 监听端口的孤儿（实测第一次跑完留下 35 个 × ~40MB ≈ 1.4GB，比它省下来的还多）。
// 所以：① hwb 以独立进程组启动（detached），收尾时按 -pid 杀整个组；
//       ② 再按临时目录路径扫一遍进程表兜底（组杀失败、或进程被重新挂到 launchd 时仍能收干净）。
function sweepOrphans() {
  const out = spawnSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout || '';
  let killed = 0;
  for (const line of out.split('\n')) {
    if (!line.includes(dir) || line.includes('memory-check.mjs')) continue;
    const pid = Number(line.trim().split(/\s+/, 1)[0]);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
    try { process.kill(pid, 'SIGKILL'); killed++; } catch { /* 已退出 */ }
  }
  return killed;
}

// 每次 Chrome 启动都会建一个 profile 目录；Chrome 退出时还握着里面的文件，
// 紧接着 rmSync 常常静默失败（被 catch 掉）——所以统一记下来，等进程杀干净后再带重试地删。
const chromeProfiles = [];
const leftoverProfiles = [];
function removeProfile(profile) {
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  catch { leftoverProfiles.push(profile); }
}

const cleanup = () => {
  for (const child of children) { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }
  try { process.kill(-server.pid, 'SIGKILL'); } catch { /* 组已空或已退出 */ }
  const killed = sweepOrphans();
  for (const profile of chromeProfiles) removeProfile(profile);
  if (killed) console.log(`（收尾：清扫了 ${killed} 个残留的假 dsh 子进程）`);
  if (leftoverProfiles.length) console.log(`（注意：${leftoverProfiles.length} 个 Chrome profile 目录删不掉，可手动清理：${leftoverProfiles[0]}）`);
  if (!KEEP) { try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 忽略 */ } }
  else console.log(`（--keep：隔离目录保留在 ${dir}）`);
};

const server = spawn(process.execPath, [path.join(ROOT, 'src/server.js'),
  '--port', String(PORT), '--db', path.join(state, 'hwb.db'), '--log', path.join(state, 'hwb.log')], {
  cwd: ROOT,
  env: { ...process.env, PATH: `${fakebin}:${process.env.PATH}`, HWB_PROBE_SPA_MB: String(SPA_MB) },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true, // 自己当进程组组长：收尾时 process.kill(-pid) 能一次带走它拉起的全部假 dsh
});
children.push(server);
let serverOut = '';
server.stdout.on('data', (d) => { serverOut += d; });
server.stderr.on('data', (d) => { serverOut += d; });
process.on('exit', cleanup);

// 服务端观测：现在还有哪些「实例页面」活着（心跳在 6s 内 = 活着；被卸载的页面会自己注销）。
function liveSpaPages() {
  let files = [];
  try { files = readdirSync(liveDir).filter((f) => f.endsWith('.json')); } catch { return []; }
  const now = Date.now();
  const out = [];
  for (const file of files) {
    try {
      const info = JSON.parse(readFileSync(path.join(liveDir, file), 'utf8'));
      if (now - info.at < 6000) out.push(info);
    } catch { /* 正在写，忽略 */ }
  }
  return out;
}

// Chrome 进程树的 RSS 之和（含 renderer / GPU / utility 等全部后代进程）—— Safari 那条警告
// 看的就是这个。按**进程树**统计而不是按命令行里的 --user-data-dir 匹配：跨源 iframe 的
// renderer 不一定继承到那个参数，漏掉它们就等于把最该量的那部分（每个 SPA 一个进程）算没了。
function chromeTreeRss(userDataDir) {
  const out = spawnSync('ps', ['-Ao', 'pid=,ppid=,rss=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout || '';
  const rows = [];
  let root = null;
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const row = { pid: Number(m[1]), ppid: Number(m[2]), rss: Number(m[3]), command: m[4] };
    rows.push(row);
    if (row.command.includes(userDataDir) && !/--type=/.test(row.command) && /Chrome/.test(row.command)) root = row.pid;
  }
  if (root === null) return { totalKb: 0, processes: [] };
  const byParent = new Map();
  for (const row of rows) {
    if (!byParent.has(row.ppid)) byParent.set(row.ppid, []);
    byParent.get(row.ppid).push(row);
  }
  const tree = [];
  const queue = [root];
  const seen = new Set([root]);
  while (queue.length) {
    const pid = queue.shift();
    const self = rows.find((r) => r.pid === pid);
    if (self) tree.push(self);
    for (const child of byParent.get(pid) || []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      queue.push(child.pid);
    }
  }
  return { totalKb: tree.reduce((sum, r) => sum + r.rss, 0), processes: tree };
}
const chromeRssKb = (userDataDir) => chromeTreeRss(userDataDir).totalKb;

function debugProcTree(userDataDir) {
  const { processes, totalKb } = chromeTreeRss(userDataDir);
  console.log(`    [debug] Chrome 进程树 ${processes.length} 个进程，合计 ${mb(totalKb)} MB`);
  for (const p of processes) {
    const type = /--type=([a-z-]+)/.exec(p.command)?.[1] ?? 'browser';
    console.log(`      pid=${p.pid} rss=${mb(p.rss)}MB type=${type}`);
  }
}

async function startChrome(userDataDir) {
  const chrome = spawn(chromePath, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--disable-extensions',
    // 跨源 iframe 各占一个进程（桌面 Chrome/Safari 的默认行为），让「每个实例一个进程」成立。
    '--site-per-process',
    '--remote-debugging-port=0', `--user-data-dir=${userDataDir}`, 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(chrome);
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('启动 Chrome 超时')), 20_000);
    chrome.stderr.on('data', (d) => {
      buf += d;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    chrome.on('exit', (code) => reject(new Error(`Chrome 退出（code ${code}）`)));
  });

  const ws = new WebSocket(wsUrl);
  let nextId = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
    }
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('连接 DevTools WebSocket 失败')));
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

  await send('Target.setDiscoverTargets', { discover: true });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const pageSend = (method, params = {}) => send(method, params, sessionId);
  await pageSend('Runtime.enable');
  await pageSend('Page.enable');

  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await pageSend('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    return result?.value ?? null;
  };

  return {
    evaluate,
    targets: async () => (await send('Target.getTargets')).targetInfos,
    close: () => { try { ws.close(); } catch { /* 已关闭 */ } try { chrome.kill('SIGKILL'); } catch { /* 已退出 */ } },
  };
}

// 一组预算下的完整流程：开浏览器 → 依次点开每个实例标签 → 每步量一次。
async function runWithBudget(frames) {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'hwb-mem-chrome-'));
  chromeProfiles.push(userDataDir);
  const steps = [];
  const chrome = await startChrome(userDataDir);
  try {
    await chrome.evaluate(`location.href = ${JSON.stringify(`${BASE}/?frames=${frames}`)}; return true;`)
      .catch(() => { /* 导航会让该 evaluate 的 promise 被丢弃，属正常 */ });
    // 等标签出现（boot() 走 /api/homes）
    let tabs = 0;
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      tabs = (await chrome.evaluate('return document.querySelectorAll(".tab[data-home-id]").length').catch(() => 0)) || 0;
      if (tabs >= INSTANCES) break;
    }
    if (DUMP) {
      console.log('    [debug] targets:');
      for (const info of await chrome.targets()) console.log(`      type=${info.type} url=${(info.url || '').slice(0, 90)}`);
    }
    check(`预算 ${frames}：工作台渲染出 ${INSTANCES} 个实例标签`, tabs >= INSTANCES, `实际 ${tabs}`);
    await sleep(1500); // 让首屏稳定（SSE + 一次 dashboard 渲染）
    const baselineRss = chromeRssKb(userDataDir);
    if (DUMP) debugProcTree(userDataDir);
    console.log(`  基线（工作台，零实例面板）：Chrome 进程树 RSS ${mb(baselineRss)} MB`);

    for (const { homeId, alias } of opened) {
      // 点到该实例标签：一次真实导航（enterInstance → /open → mountPane）
      await chrome.evaluate(`document.querySelector('.tab[data-home-id="${homeId}"]')?.click(); return true;`);
      // 等 iframe 挂上并 load（cover 收起 = onFrameLoad 走完）
      let mounted = false;
      for (let i = 0; i < 80; i++) {
        await sleep(250);
        mounted = (await chrome.evaluate(`const el = document.querySelector('.iframe-pane[data-home-id="${homeId}"]');
          return !!(el && el.querySelector('iframe') && el.querySelector('.frame-cover')?.hidden);`)) || false;
        if (mounted) break;
      }
      await sleep(3000); // 让假 SPA 分配完常驻内存并打满一轮心跳
      const state = await chrome.evaluate(`return { iframes: document.querySelectorAll('iframe').length, budget: window.__hwbFrameBudget?.() ?? null };`);
      const pages = liveSpaPages();
      const step = {
        alias,
        iframes: state?.iframes ?? -1,
        live: state?.budget?.live ?? -1,
        released: state?.budget?.released ?? -1,
        limit: state?.budget?.limit ?? -1,
        mounted,
        rss: chromeRssKb(userDataDir),
        spaPages: pages.length,
        spaMB: pages.reduce((sum, p) => sum + (p.mb || 0), 0),
      };
      steps.push(step);
      console.log(`  访问 ${steps.length}/${INSTANCES}（${alias}）：iframe=${step.iframes} 活跃记账=${step.live}/${step.limit} `
        + `已释放=${step.released} 活着的实例页面=${step.spaPages}(${step.spaMB}MB) RSS ${mb(step.rss)} MB${mounted ? '' : ' ⚠ 面板未挂载'}`);
      if (DUMP) debugProcTree(userDataDir);
    }
    const final = steps.at(-1) ?? { rss: baselineRss, iframes: 0, live: 0, released: 0, spaPages: 0, spaMB: 0 };

    // 回访：被预算释放过的那个实例必须还能打开 —— 否则「省内存」就变成了「打不开」。
    // 这里点第一个实例（预算小于实例数时它早就被释放了），验证重新挂载 + 它的 SPA 页面重新活过来。
    let revisit = null;
    if (INSTANCES > frames) {
      const first = opened[0];
      const port = portByHome.get(first.homeId);
      await chrome.evaluate(`document.querySelector('.tab[data-home-id="${first.homeId}"]')?.click(); return true;`);
      let remounted = false;
      for (let i = 0; i < 80; i++) {
        await sleep(250);
        remounted = (await chrome.evaluate(`const el = document.querySelector('.iframe-pane[data-home-id="${first.homeId}"]');
          return !!(el && el.querySelector('iframe') && el.querySelector('.frame-cover')?.hidden);`)) || false;
        if (remounted) break;
      }
      await sleep(3000);
      const state = await chrome.evaluate(`return { iframes: document.querySelectorAll('iframe').length, budget: window.__hwbFrameBudget?.() ?? null };`);
      const alive = liveSpaPages().some((p) => p.port === port);
      revisit = { alias: first.alias, mounted: remounted, alive, live: state?.budget?.live ?? -1, iframes: state?.iframes ?? -1 };
      check(`预算 ${frames}：回访被释放的实例能重新挂载并重新加载（${first.alias}）`,
        remounted && alive, `重新挂载=${remounted} 页面重新活着=${alive}`);
      check(`预算 ${frames}：回访后活跃数仍不超预算`, revisit.live <= frames, `live=${revisit.live} 预算=${frames}`);
      console.log(`  回访 ${first.alias}（此前已被释放）：重新挂载=${remounted} 页面重新活着=${alive} 活跃=${revisit.live} RSS ${mb(chromeRssKb(userDataDir))} MB`);
    }
    return { frames, baselineRss, steps, final, revisit, budget: final.limit };
  } finally {
    chrome.close();
    await sleep(500);           // 等 SIGKILL 的 Chrome 真正退出，否则它的 profile 目录删不掉
    removeProfile(userDataDir);
  }
}

let summary = null;
// 已注册并连接的实例（runWithBudget 要用它决定点哪些标签）——放在模块作用域，别塞进 try 里。
const opened = [];
// homeId → 该实例的假 dsh 端口：用来把「服务端观测到的活页面」对到具体实例上。
const portByHome = new Map();
try {
  // ① 服务起来
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await sleep(250);
    up = await fetch(`${BASE}/api/homes`).then((r) => r.ok, () => false);
  }
  check('隔离的 hwb 服务已启动', up, BASE);
  if (!up) throw new Error(`服务没起来：${serverOut.slice(-300)}`);

  // ② 注册假 home
  for (const { home, alias } of homes) {
    const res = await fetch(`${BASE}/api/homes`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ homePath: home, alias }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.homeId) throw new Error(`注册 ${alias} 失败：${res.status} ${JSON.stringify(body).slice(0, 200)}`);
    opened.push({ homeId: body.homeId, alias });
  }
  check(`注册 ${INSTANCES} 个假实例`, opened.length === INSTANCES);

  // ③ 逐个连接（hwb 会用 PATH 里的假 dsh 起一个「dsh web」），标签出现的前提是实例 running
  for (const item of opened) {
    const res = await fetch(`${BASE}/api/homes/${item.homeId}/open`, { method: 'POST' });
    if (!res.ok) throw new Error(`连接 ${item.alias} 失败：${res.status} ${JSON.stringify(await res.json().catch(() => ({}))).slice(0, 300)}`);
  }
  const running = await fetch(`${BASE}/api/homes`).then((r) => r.json());
  check('全部实例进入 running（标签页会出现）',
    running.homes.filter((h) => h.runtime?.runtime === 'running').length === INSTANCES,
    running.homes.map((h) => `${h.alias}=${h.runtime?.runtime}`).join(' '));
  for (const home of running.homes) {
    if (home.runtime?.port) portByHome.set(home.homeId, home.runtime.port);
  }

  // ④ 两组预算各跑一遍（同一批实例、同一批 SPA）
  const runs = [];
  for (const frames of FRAME_BUDGETS) {
    console.log(`\n▶ 预算 frames=${frames}${frames >= INSTANCES ? '（≥实例数 ⇒ 等价于旧的无上限行为）' : ''}`);
    runs.push(await runWithBudget(frames));
  }
  summary = runs;

  // ⑤ 断言：这一版修的正是「访问过的实例都会常驻」
  const bounded = runs[0];
  const unbounded = runs.at(-1);
  check('有预算时活跃 iframe 数被按住（≤ 预算）', bounded.final.live <= bounded.budget,
    `live=${bounded.final.live} limit=${bounded.budget}`);
  check('有预算时确实释放过面板（访问数 > 预算）', bounded.final.released >= INSTANCES - bounded.budget,
    `released=${bounded.final.released} 期望 ≥ ${Math.max(0, INSTANCES - bounded.budget)}`);
  check('无预算（对照）时所有实例都常驻', unbounded.final.live === INSTANCES, `live=${unbounded.final.live}`);
  // 服务端看到的事实：被释放的实例页面真的卸载了，而不只是从 DOM 上摘掉一个节点
  check('有预算时活着的实例页面数同样被按住（服务端观测，不靠 DOM 推断）',
    bounded.final.spaPages <= bounded.budget, `活着的页面=${bounded.final.spaPages} 预算=${bounded.budget}`);
  check('无预算时所有实例页面都活着，且内存按实例数增长',
    unbounded.final.spaPages === INSTANCES && unbounded.final.spaMB === INSTANCES * SPA_MB,
    `页面=${unbounded.final.spaPages} 合计=${unbounded.final.spaMB}MB 期望 ${INSTANCES}×${SPA_MB}MB`);
  const boundedDelta = bounded.final.rss - bounded.baselineRss;
  const unboundedDelta = unbounded.final.rss - unbounded.baselineRss;
  check('有预算时浏览器 RSS 增量明显小于无预算（这就是 Safari 那条警告的成因）',
    boundedDelta < unboundedDelta * 0.75,
    `有预算 +${mb(boundedDelta)}MB vs 无预算 +${mb(unboundedDelta)}MB`);

  console.log('\n—— 对照 ——');
  for (const run of runs) {
    const delta = mb(run.final.rss - run.baselineRss);
    console.log(`  frames=${run.frames}: 访问 ${INSTANCES} 个实例后活跃 iframe=${run.final.iframes}、活着的实例页面=${run.final.spaPages}，`
      + `Chrome 进程树 RSS ${mb(run.final.rss)} MB（+${delta} MB vs 基线 ${mb(run.baselineRss)} MB）`);
  }
} catch (error) {
  console.error(`\n内存检查失败: ${error.message}`);
  failed++;
} finally {
  cleanup();
}

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项未通过`}（${results.length} 项断言）`);
if (process.argv.includes('--json')) console.log(JSON.stringify({ results, summary }, null, 1));
process.exit(failed === 0 ? 0 : 1);
