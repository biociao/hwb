#!/usr/bin/env node
// warm-cache — 把某个 dsh 入口（经 hwb 代理）的前端资源预先灌进 hwb 的本地代理缓存。
//
// 为什么需要它：hwb 的代理缓存只在「第一次真的有人来取」时才填充，而这条链路（实测
// dgx21.tun ≈ 25–30 KB/s）把 3.3 MiB 的插件 bundle 拉一遍要两分钟。先跑这个脚本，
// 等它结束再打开页面，页面就是**本地**在回 —— 用户不必再等那两分钟。
//
// 用法：
//   node scripts/warm-cache.mjs --url http://127.0.0.1:49670/
//   node scripts/warm-cache.mjs --url http://127.0.0.1:49670/ --only plugins --concurrency 2
//   node scripts/warm-cache.mjs --url http://127.0.0.1:49670/ --history 5
//
// `--history N`：把**最近 N 个已结束的会话**的历史（`session.history`，UI 打开会话时拉的那一份）
// 也灌进缓存。这一份很大 —— 实测 dgx21 上一个会话 50 条消息的窗口 = 8–10 MiB 原始事件日志
// （gzip 后 ~0.5–0.9 MiB，25–30 KB/s 的链路上要 20–35 秒），所以「打开历史会话慢」的根治办法
// 就是先把它灌好：之后打开这些会话是本地回。正在跑的会话不预热（它的历史还在长，预热没有意义）。
//
// 说明：
//   · 只 GET 索引里出现的 `/plugins/**/client.js?rev=<hash>` 与 `/assets/**`（内容寻址的静态资源），
//     不发任何 /api 请求、不改远端状态、不需要登录凭据（入口 URL 自带 token 时原样沿用）。
//   · 串行是默认：链路的瓶颈是带宽不是并发，并发只会把 ssh 的 channel 名额挤掉（MaxSessions）。
//   · 输出里 `hit` 表示这一份已在缓存里（0 字节出网），`fill` 表示这次真的从远端取了一份。

import process from 'node:process';

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const url = arg('url');
if (!url) {
  console.error('用法: node scripts/warm-cache.mjs --url <dsh 入口 URL> [--only all|plugins|assets] [--concurrency 1]');
  process.exit(2);
}
const only = arg('only', 'all');
// `--history` 单独出现时按 3 个处理；`--history 0` 表示不预热历史。
const historyArg = process.argv.includes('--history') ? (arg('history', '3') || '3') : '0';
const historyCount = Math.max(0, Number(historyArg) || 0);
const maxMessages = Number(arg('max-messages', '50')) || 50;
const concurrency = Math.max(1, Number(arg('concurrency', '1')) || 1);
const timeoutMs = Number(arg('timeout-ms', '300000')) || 300_000;

const base = new URL(url);
const indexRes = await fetch(base, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
if (!indexRes.ok) {
  console.error(`索引请求失败: HTTP ${indexRes.status}`);
  process.exit(1);
}
const html = await indexRes.text();
const urls = new Set();
for (const m of html.matchAll(/(?:\/plugins\/[^\s"'<>()]+client\.js(?:\?[^\s"'<>()]*)?|\/assets\/[^\s"'<>()]+)/g)) {
  const u = m[1] ?? m[0];
  if (only === 'plugins' && !u.startsWith('/plugins/')) continue;
  if (only === 'assets' && !u.startsWith('/assets/')) continue;
  if (/token=/.test(u)) continue;              // 入口凭据不写进缓存
  urls.add(u.replace(/&amp;/g, '&'));
}
if (urls.size === 0) {
  console.error('索引里没有可预热的资源（是不是拿到的是登录页？）');
  process.exit(1);
}

const list = [...urls];
console.log(`warm-cache: ${list.length} 个资源（并发 ${concurrency}）→ ${base.origin}`);
let next = 0;
let bytes = 0;
let hits = 0;
let fails = 0;
const t0 = Date.now();

async function worker() {
  for (;;) {
    const i = next++;
    if (i >= list.length) return;
    const path = list[i];
    const started = Date.now();
    try {
      const res = await fetch(new URL(path, base), { signal: AbortSignal.timeout(timeoutMs) });
      const body = await res.arrayBuffer();
      const hit = res.headers.get('x-hwb-cache');
      const ms = Date.now() - started;
      if (hit) hits += 1;
      bytes += hit ? 0 : body.byteLength;
      const mark = hit ? hit : 'fill';
      console.log(`  [${String(i + 1).padStart(2)}/${list.length}] ${mark.padEnd(10)} ${String(body.byteLength).padStart(8)} B  ${String(ms).padStart(6)} ms  ${path.slice(0, 78)}`);
      if (!res.ok) fails += 1;
    } catch (error) {
      fails += 1;
      console.log(`  [${String(i + 1).padStart(2)}/${list.length}] FAIL       ${path.slice(0, 78)} — ${error.message}`);
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, worker));

// —— 会话历史预热（可选）——
if (historyCount > 0) {
  const rpc = async (method, payload) => {
    const res = await fetch(new URL(`/api/${method}`, base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: `warm-${Math.random().toString(16).slice(2)}`, method, payload }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const hit = res.headers.get('x-hwb-cache');
    return { hit, text: await res.text(), status: res.status };
  };
  const listRes = await rpc('session.list', {});
  let items = [];
  try {
    const j = JSON.parse(listRes.text);
    items = j?.result?.value?.items ?? j?.value?.items ?? j?.items ?? [];
  } catch { /* 解析失败就跳过历史预热，静态部分已经完成 */ }
  items.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const targets = items.filter((it) => it && it.running !== true && it.blank !== true).slice(0, historyCount);
  console.log(`warm-cache: 预热 ${targets.length} 个已结束会话的历史（maxMessages=${maxMessages}）`);
  for (const it of targets) {
    const started = Date.now();
    try {
      const r = await rpc('session.history', { sessionId: it.sessionId, maxMessages });
      const ms = Date.now() - started;
      const size = Buffer.byteLength(r.text);
      if (r.hit) hits += 1;
      else bytes += size;
      console.log(`  ${(r.hit ?? 'fill').padEnd(10)} ${String(size).padStart(9)} B  ${String(ms).padStart(6)} ms  ${String(it.sessionId).slice(0, 40)}`);
    } catch (error) {
      fails += 1;
      console.log(`  FAIL       ${String(it.sessionId).slice(0, 40)} — ${error.message}`);
    }
  }
}

const seconds = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`warm-cache: 完成 ${list.length} 项，出网 ${(bytes / 1048576).toFixed(2)} MiB，命中 ${hits}，失败 ${fails}，用时 ${seconds}s`);
if (fails) console.log('warm-cache: 有失败项 —— 再跑一次通常就能补齐（失败多半是这条链路瞬时抖动）。');
process.exit(fails && hits === 0 ? 1 : 0);
