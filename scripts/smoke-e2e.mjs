#!/usr/bin/env node
// hwb 端到端冒烟：一个命令跑完整条链路（起服务 → 造一个假 dsh home → 索引 → 各 API →
// 浏览器渲染 → 上传/下载 → SSE → 移除实例 → 停服务），每一步都断言，失败即非 0 退出。
//
// 为什么需要它：单元测试覆盖的是函数，而这一晚多轮审查反复证明**集成层**才有真问题
// （端口记账、用量记忆、降级窗口、渲染拟合……）。这个脚本把「手动验证」固化成一条命令，
// 也顺带保证「改完之后整个应用仍然能从零跑起来」。
//
// 用法：
//   node scripts/smoke-e2e.mjs                 # 起在 4397，用 /tmp 下的临时目录
//   node scripts/smoke-e2e.mjs --port 4398 --keep
//   node scripts/smoke-e2e.mjs --with-chrome   # 额外跑一次真浏览器渲染检查
//
// 安全约定：只用显式 --db/--log 的隔离实例（默认 db 是 ~/.hwb/hwb.db，绝不能碰），
// 端口固定 4377-4399，结束（含失败）时一定 kill 掉子进程。

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt;
};
const PORT = Number(arg('port', '4397'));
const KEEP = process.argv.includes('--keep');
const WITH_CHROME = process.argv.includes('--with-chrome');
if (!(PORT >= 4377 && PORT <= 4399)) {
  console.error(`端口必须在 4377-4399（隔离约定），收到 ${PORT}`);
  process.exit(2);
}
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
let failed = 0;
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail: String(detail).slice(0, 200) });
  if (!ok) failed++;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const j = async (p, init) => {
  const res = await fetch(BASE + p, init);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* 非 JSON（例如 SSE） */ }
  return { status: res.status, body, text };
};

const dir = mkdtempSync(path.join(tmpdir(), 'hwb-smoke-'));
const state = path.join(dir, 'state');
const home = path.join(dir, 'home');
const proj = path.join(dir, 'proj');
mkdirSync(state, { recursive: true });
mkdirSync(proj, { recursive: true });
mkdirSync(path.join(home, 'storages'), { recursive: true });
writeFileSync(path.join(proj, '.keep'), '');

// 一个「更早之前用过」的假 dsh home：默认 24h 窗口为空、30 天有数据（正好覆盖空状态那条链）
const days = (n) => new Date(Date.now() - n * 86400_000).toISOString();
const sessions = Object.fromEntries([6, 7, 11].map((d, i) => [`sess-${i}`, {
  identity: { createdAt: Date.parse(days(d + 1)), cwd: proj },
  rows: {
    title: { ver: 1, seq: 1, val: `会话 ${i}（${d} 天前）` },
    tokenUsage: { ver: 1, seq: 1, val: { totals: { uncachedInputTokens: 1000 * (i + 1), outputTokens: 100, cacheReadTokens: 10, cacheWriteTokens: 1 }, last: null } },
    sessionListMetadata: { ver: 1, seq: 1, val: { blank: false, lastPromptAt: Date.parse(days(d)) } },
  },
}]));
writeFileSync(path.join(home, 'storages', 'workspace.json'), JSON.stringify({
  unit: { name: 'workspace', version: 2 },
  global: { initialized: true, workspaceIds: ['ws-1'], archivedSessionIds: [] },
  tables: { workspaces: { 'ws-1': { title: '冒烟项目', path: proj, sessionIds: Object.keys(sessions), createdAt: 1, updatedAt: 2 } } },
}));
writeFileSync(path.join(home, 'storages', 'session_projcache.json'), JSON.stringify({
  unit: { name: 'session_projcache', version: 3 }, global: null, tables: { sessions },
}));

// 预检：端口上有东西在听就直接退出。否则会出现一种很坑的假绿 —— 上一次没退干净的实例仍在
// 服务，本次 spawn 的服务因 EADDRINUSE 立刻退出，而所有断言都打在**旧实例**上，
// 最后「SIGTERM 后自行退出」失败（我第一版就这么假绿过一次）。
const preExisting = await fetch(`${BASE}/api/homes`).then(() => true, () => false);
if (preExisting) {
  console.error(`端口 ${PORT} 上已经有东西在服务（很可能是上一次没退干净的 hwb）。换一个端口，或先停掉它。`);
  process.exit(2);
}

// 第二个假 home：projcache 的 unit.version 越出支持范围 → 该域 degraded。
// 真实形态就是「dsh 升级到 hwb 还不认识的版本」，而它是「实例整块变空」那条历史缺陷的触发条件。
const home2 = path.join(dir, 'home-degraded');
mkdirSync(path.join(home2, 'storages'), { recursive: true });
writeFileSync(path.join(home2, 'storages', 'workspace.json'), JSON.stringify({
  unit: { name: 'workspace', version: 2 },
  global: { initialized: true, workspaceIds: ['ws-x'], archivedSessionIds: [] },
  tables: { workspaces: { 'ws-x': { title: '降级项目', path: proj, sessionIds: [], createdAt: 1, updatedAt: 2 } } },
}));
writeFileSync(path.join(home2, 'storages', 'session_projcache.json'), JSON.stringify({
  unit: { name: 'session_projcache', version: 999 }, global: null, tables: { sessions: {} },
}));

const server = spawn(process.execPath, [path.join(ROOT, 'src/server.js'),
  '--port', String(PORT), '--db', path.join(state, 'hwb.db'), '--log', path.join(state, 'hwb.log')],
{ cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let serverOut = '';
server.stdout.on('data', (d) => { serverOut += d; });
server.stderr.on('data', (d) => { serverOut += d; });
const cleanup = () => { try { server.kill('SIGKILL'); } catch { /* 已退出 */ } };
process.on('exit', cleanup);

try {
  // ① 服务起来
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await new Promise((r) => setTimeout(r, 250));
    up = await fetch(`${BASE}/api/homes`).then((r) => r.ok, () => false);
  }
  check('服务启动并响应 /api/homes', up, BASE);
  if (!up) throw new Error(`服务没起来：${serverOut.slice(-300)}`);

  // ② 注册 + 索引假 home
  const added = await j('/api/homes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ homePath: home, alias: '冒烟实例' }) });
  check('POST /api/homes 注册实例', added.status === 200 && added.body?.homeId, `status=${added.status} sessions=${added.body?.result?.sessionCount}`);
  const homeId = added.body?.homeId;

  // ③ 列表 / 会话 / 项目
  const homes = await j('/api/homes');
  check('GET /api/homes 只回一个实例且带 runtime', homes.body?.homes?.length === 1 && !!homes.body.homes[0].runtime, JSON.stringify(homes.body?.homes?.[0]?.runtime ?? null).slice(0, 80));
  // 注意：recent 两条路由**只列出 runtime=running 的实例**（界面文案就是「连接实例后显示…」），
  // 而这里没有真的 dsh 在跑 —— 所以它们必须为空。想看会话内容要走 /api/workspaces 与 /api/usage。
  const sess = await j(`/api/sessions/recent?homeId=${homeId}`);
  check('未连接实例时 /api/sessions/recent 为空（按设计）', sess.body?.sessions?.length === 0, `count=${sess.body?.sessions?.length}`);
  const projs = await j('/api/projects/recent');
  check('未连接实例时 /api/projects/recent 为空（按设计）', projs.body?.projects?.length === 0, `count=${projs.body?.projects?.length}`);
  const wss = await j(`/api/workspaces?homeId=${homeId}`);
  const ws = wss.body?.workspaces?.[0];
  // title 来自 workspace.json；project 是 path 的 basename（normalize 反查得到），两者不同名很正常
  check('GET /api/workspaces 有冒烟项目与会话数', ws?.title === '冒烟项目' && ws?.project === 'proj' && ws?.sessionCount === 3,
    JSON.stringify(ws ?? null).slice(0, 140));

  // ④ 用量：默认窗口为空、更宽窗口有数据（空状态那条链）
  const u24 = await j('/api/usage?days=1&hours=24');
  const u30 = await j('/api/usage?days=30&hours=720');
  check('GET /api/usage 24h 为空、30 天有数据', u24.body?.summary?.sessionCount === 0 && u30.body?.summary?.sessionCount === 3,
    `24h=${u24.body?.summary?.sessionCount} 30d=${u30.body?.summary?.sessionCount} total=${u30.body?.summary?.totalTokens}`);
  check('用量「按实例」维度带别名', Object.keys(u30.body?.trendBy?.instance?.buckets?.flatMap((b) => b.groups)?.reduce((a, g) => ({ ...a, ...g }), {}) ?? {}).includes('冒烟实例'));

  // ⑤ SSE：一次重索引应触发 index:updated
  const controller = new AbortController();
  const sse = fetch(`${BASE}/api/events`, { signal: controller.signal }).then(async (r) => {
    const reader = r.body.getReader();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) return buf;
      buf += new TextDecoder().decode(value);
      if (buf.includes('index:updated')) return buf;
    }
  }).catch(() => '');
  await new Promise((r) => setTimeout(r, 300));
  await j(`/api/homes/${homeId}/reindex`, { method: 'POST' });
  const sseText = await Promise.race([sse, new Promise((r) => setTimeout(() => r(''), 5000))]);
  controller.abort();
  check('SSE 收到 index:updated', sseText.includes('index:updated'), sseText.slice(0, 80).replace(/\n/g, '\\n'));

  // ⑥ 上传 / 预览 / 下载（真实 multipart）
  const body = new FormData();
  body.append('file', new Blob([Buffer.from('hwb smoke 内容\n')]), 'smoke.txt');
  const up2 = await fetch(`${BASE}/api/homes/${homeId}/upload?workspaceId=ws-1&dir=.`, { method: 'PUT', body });
  const upBody = await up2.json().catch(() => null);
  check('PUT upload 成功且文件落盘', up2.status === 200 && existsSync(path.join(proj, 'smoke.txt')), `status=${up2.status} ${JSON.stringify(upBody).slice(0, 120)}`);
  const dl = await fetch(`${BASE}/api/homes/${homeId}/download?workspaceId=ws-1&path=smoke.txt`);
  const dlText = await dl.text();
  check('GET download 内容一致', dl.status === 200 && dlText === 'hwb smoke 内容\n', `status=${dl.status} len=${dlText.length}`);

  // ⑦ 日志 / 额度
  const logs = await j('/api/logs?limit=20');
  check('GET /api/logs 有结构化日志', Array.isArray(logs.body?.logs) && logs.body.logs.length > 0, `count=${logs.body?.logs?.length}`);
  const quota = await j('/api/quota');
  check('GET /api/quota 不泄漏 key', quota.status === 200 && !/sk-[A-Za-z0-9]|SECRET/.test(quota.text), `status=${quota.status}`);

  // ⑧ 降级实例：注册一个 unit.version 越界的 home —— 必须**照常出现在界面上并标出降级**，
  //    而不是让整个实例看起来「空了」（那是历史缺陷，界面上完全不显示 degraded）。
  const added2 = await j('/api/homes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ homePath: home2, alias: '降级实例' }) });
  const degradedDomains = (added2.body?.result?.degraded ?? []).map((d) => d.domain);
  check('降级实例仍然被索引入库并标出 degraded 域', degradedDomains.includes('projcache'), JSON.stringify(degradedDomains));
  const homesAfter = await j('/api/homes');
  const degradedHome = homesAfter.body?.homes?.find((h) => h.homeId === added2.body?.homeId);
  check('/api/homes 里该实例为 degraded 且可辨认', degradedHome?.status === 'degraded' && degradedDomains.includes('projcache'),
    `status=${degradedHome?.status}`);

  // ⑨ 真浏览器渲染（可选）—— 必须在移除实例**之前**跑：那时仪表盘上才用得着用量卡
  if (WITH_CHROME) {
    const script = `return {
      title: document.title,
      cards: document.querySelectorAll("#usage-card").length,
      buttons: document.querySelectorAll("#usage-period-toggle button").length,
      warnChips: [...document.querySelectorAll("#dashboard .chip.warn")].map((c) => c.textContent.trim()),
    }`;
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/render-check.mjs'), '--url', `${BASE}/`, '--wait-ms', '4000',
      '--expr', script], { encoding: 'utf8', timeout: 60_000 });
    let parsed = null;
    try { parsed = JSON.parse(r.stdout); } catch { /* 解析失败即失败 */ }
    check('真浏览器加载工作台且用量卡已渲染（无 console.error / 未捕获异常）',
      parsed?.ok === true && parsed?.result?.cards === 1 && parsed?.result?.buttons === 5,
      JSON.stringify(parsed?.result ?? r.stdout?.slice(0, 120)));
    check('界面里能看到降级实例的警示 chip', parsed?.result?.warnChips?.some((t) => t.includes('降级')), JSON.stringify(parsed?.result?.warnChips ?? null));
  }

  // ⑩ 移除实例：用量「按实例」维度必须立刻不再包含它（缓存不得滞后）
  const del = await j(`/api/homes/${homeId}`, { method: 'DELETE' });
  const after = await j('/api/usage?days=30&hours=720');
  const instances = Object.keys(after.body?.trendBy?.instance?.buckets?.flatMap((b) => b.groups)?.reduce((a, g) => ({ ...a, ...g }), {}) ?? {});
  check('DELETE 实例后同一 /api/usage 立刻不再含它', del.status === 200 && !instances.includes('冒烟实例'), `instances=${JSON.stringify(instances)}`);

  // ⑪ 优雅退出：SIGTERM 后必须自己退出（含 stopAll 收子进程）
  const exited = new Promise((r) => server.on('exit', (code, signal) => r({ code, signal })));
  const t0 = Date.now();
  server.kill('SIGTERM');
  const how = await Promise.race([exited, new Promise((r) => setTimeout(() => r(null), 12_000))]);
  check('SIGTERM 后服务自行退出（≤12s）', !!how && how.code === 0, how ? `code=${how.code} ${Date.now() - t0}ms` : '超时未退出');
} catch (error) {
  check('冒烟未抛异常', false, error.message);
} finally {
  cleanup();
  await new Promise((r) => setTimeout(r, 300));
  const failedList = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed} / ${results.length} 通过`);
  if (failedList.length) console.log(`失败：${failedList.map((f) => f.name).join('；')}`);
  if (!KEEP) rmSync(dir, { recursive: true, force: true });
  else console.log(`保留临时目录：${dir}`);
  process.exit(failed ? 1 : 0);
}
