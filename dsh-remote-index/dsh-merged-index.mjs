#!/usr/bin/env node
// dsh-merged-index.mjs
// Merge the lightweight session index of every configured dsh instance (this
// host + any reachable remote hosts) into ONE unified project/session list,
// across all instances, ordered by recency. No session content is read on
// either side — the indexer uses only the session header line, file stat, and
// the projection cache (title / stats / goal / token usage).
//
//   node dsh-merged-index.mjs [--instances instances.json] [--html out.html] [--watch <sec>]
//
// Defaults: JSON on stdout. With --html, writes a self-contained card page.

import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const indexerPath = join(here, "dsh-instance-index.mjs");
// 一个实例的索引 JSON 上限。默认的 1 MiB 太小（大实例会被判成「离线: exit null」）。
const MAX_INDEX_BYTES = 256 * 1024 * 1024;

// 单个实例的采集超时。没有它时只有「错」被隔离、**「慢」不被隔离**：一台黑洞主机能让整轮采集
// 卡在系统 TCP 超时上（分钟级），而采集是串行的 —— 健康的实例也跟着不刷新。可用
// `--collect-timeout-ms` 调（测试用它把 60s 缩短）。
const COLLECT_TIMEOUT_MS = Number(arg("--collect-timeout-ms", "60000")) || 60000;

const indexerSource = await readFile(indexerPath, "utf8");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

// 远端命令的每个参数都必须过一遍 shell 引号：`ssh host cmd a b` 这一串会被**远端 shell 重新按空白
// 分段**（本项目的 dsh-remote-web.sh 里专门写明了这一点，那里用 printf '%q' 解决）。不引号的话：
//   · 路径里有空格 → `--root /a/My Sessions/x` 被拆成两段，实例静默变成「离线」且原因误导；
//   · 值里有 `;` 或 `$( )` → 直接在远端执行（instances.json 虽是本地配置，但没有理由留这个洞）。
function shQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

async function collectInstance(inst) {
  const args = ["--root", inst.sessionsRoot, "--cache", inst.cacheRoot, "--instance", inst.id];
  let res;
  if (!inst.host) {
    res = spawnSync(inst.nodeBin || "node", [indexerPath, ...args],
      { encoding: "utf8", maxBuffer: MAX_INDEX_BYTES, timeout: COLLECT_TIMEOUT_MS, killSignal: "SIGKILL" });
  } else {
    // Publish the indexer to the remote via stdin:  ssh host <nodeBin> - <args>  <script-source>
    // BatchMode/ConnectTimeout：没有它们时一台黑洞主机会让采集卡在系统的 TCP 超时上（分钟级），
    // 而采集是**串行**的，于是旁边所有实例都跟着不刷新。
    res = spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", inst.host,
      inst.nodeBin || "node", "-", ...args.map(shQuote)],
      { input: indexerSource, encoding: "utf8", maxBuffer: MAX_INDEX_BYTES, timeout: COLLECT_TIMEOUT_MS, killSignal: "SIGKILL" });
  }
  if (res.error?.code === "ETIMEDOUT" || res.signal === "SIGKILL") {
    // 「慢」也要隔离：只有错误被隔离是不够的，一台卡住的主机会让整轮采集停在系统超时上。
    return { instance: inst.id, error: `采集超时（超过 ${Math.round(COLLECT_TIMEOUT_MS / 1000)}s）` };
  }
  if (res.error) {
    // spawnSync 的默认 maxBuffer 只有 1 MiB：索引 JSON 约 350 B/会话，且会话在
    // 「扁平列表」与「按项目嵌套」里各出现一次 —— 大约 1.4k 个会话就越过上限，
    // 于是 ENOBUFS。此时 status 是 null、stderr 是空的，原先掉进下面的分支后
    // 界面上只显示「exit null」：既不说明原因，也看不出该改什么。
    return { instance: inst.id, error: `${res.error.code || res.error.message}`
      + (res.error.code === "ENOBUFS" ? "（索引输出超过 maxBuffer 上限）" : "") };
  }
  if (res.status !== 0) {
    // Mark the instance as unreachable rather than throwing: a transient SSH
    // drop must not kill the whole dashboard. The caller keeps the last good
    // snapshot for this instance and flags it offline.
    return { instance: inst.id, error: (res.stderr || "").trim().slice(0, 300) || `exit ${res.status}` };
  }
  let data;
  try {
    data = parseIndexOutput(res.stdout);
  } catch (error) {
    // 解析失败只让**这一个**实例离线。整个脚本的设计意图就是「单个实例的抖动不该拖垮看板」
    // （ssh 非零退出已经这么处理了），但 parse 失败原先会冒到 runOnce → tickGuarded：
    // 于是**一个**混进登录 banner 的实例会让旁边完全健康的实例也一整轮不刷新，
    // --watch 的 HTML 永远停在旧快照上。故障要隔离在实例粒度。
    return { instance: inst.id, error: String(error.message || error).slice(0, 300) };
  }
  return { instance: inst.id, ...data };
}

// 远端的 stdout 不干净：登录 shell 的 banner（`.bashrc`/profile 里的 echo、motd）、
// ssh 的告警都会混在 JSON 前面。原生实现直接 JSON.parse(res.stdout)，于是远端一句
// "Welcome to ..." 就让整份合并索引报 SyntaxError（--watch 模式下每轮都死，HTML 一直是旧的，
// 而错误信息完全没提到 banner 这个真实原因）。
// 这里从第一个 `{` 开始解析；仍然失败时把原始输出片段带上，让原因可见。
function parseIndexOutput(stdout) {
  const text = String(stdout ?? "");
  const start = text.indexOf("{");
  const candidate = start === -1 ? text : text.slice(start);
  try {
    return JSON.parse(candidate);
  } catch (error) {
    const preview = text.trim().split("\n").slice(0, 3).join(" ⏎ ").slice(0, 300);
    throw new Error(`远端索引输出不是 JSON（可能混入了登录 banner）: ${error.message} — 实际输出开头: ${preview || "(空)"}`);
  }
}

// 一条会话条目的规范化。渲染层直接用了 `s.id.slice(...)`，所以 `id` 是数字（或整个条目是 null）时，
// 一次渲染就抛错 → **整页不写、退出码 1**：一个实例的一个坏字段足以让旁边健康实例的卡片也一起消失。
// 这与本文件反复强调的「单个实例的抖动不该拖垮看板」直接冲突 —— 采集期做了隔离，渲染期又漏了。
// 归一化放在 merge 这个唯一入口：`id` 一律转成字符串，非对象条目整条丢掉。
function normalizeSession(s, instance) {
  if (!s || typeof s !== "object") return null;
  const id = s.id == null ? "" : String(s.id);
  return { instance, ...s, id };
}

function merge(raws) {
  const projects = [];
  const sessions = [];
  for (const raw of raws) {
    for (const s of raw.sessions || []) {
      const row = normalizeSession(s, raw.instance);
      if (row) sessions.push(row);
    }
    for (const p of raw.projects || []) {
      if (!p || typeof p !== "object") continue;
      projects.push({
        instance: raw.instance,
        key: p.key,
        path: p.path,
        sessions: (p.sessions || []).map((s) => normalizeSession(s, raw.instance)).filter(Boolean),
      });
    }
  }
  const byUp = (a, b) => b.updatedAt - a.updatedAt;
  sessions.sort(byUp);
  for (const p of projects) p.sessions.sort(byUp);
  projects.sort((a, b) => Math.max(...b.sessions.map((s) => s.updatedAt), 0) - Math.max(...a.sessions.map((s) => s.updatedAt), 0));
  return { mergedAt: Date.now(), resources: raws.map((r) => r.instance), projects, sessions, offline: raws.filter((r) => r.error).map((r) => ({ instance: r.instance, error: r.error })) };
}

// 数值字段同样来自**远端**投影缓存（sessionStats.val），不是本地可信数据：
// 直接 `\${s.turns}` 插进模板就是一个 HTML 注入面（构造缓存即可产出
// `class="turns"><img src=x onerror=...>`）。这个页面聚合了所有实例的标题与路径，
// 一旦注入成功就能读走全部内容。统一走数值规范化。
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function when(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function rel(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return `${Math.floor(diff / 1000)}s`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
  return `${Math.floor(diff / 86400000)}d`;
}

function renderHtml(data, showHost) {
  const p = (n) => esc(n);
  const statusClass = (s) => (s === "running" ? "run" : s === "active" ? "act" : s === "idle" ? "idle" : "new");
  const statusDot = (s) => {
    const label = { running: "运行中", active: "活跃", idle: "空闲", new: "新建" }[s] || s;
    return `<span class="dot ${statusClass(s)}"></span><span class="st">${p(label)}</span>`;
  };
  const hostLabel = (inst) => (showHost && inst !== "mac" ? `<span class="host" title="host">${p(inst)}</span>` : "");
  const card = (s) => `
    <div class="card">
      <div class="top">
        ${statusDot(s.status)}
        <span class="title">${p(s.title || "(未命名)")}</span>
      </div>
      <div class="meta">
        <span>${when(s.updatedAt)}</span>
        <span class="ago">${rel(s.updatedAt)}</span>
        <span class="turns">${num(s.turns)} 轮 / ${num(s.steps)} 步</span>
        ${num(s.llmMs) ? `<span>LLM ${(num(s.llmMs) / 1000).toFixed(1)}s</span>` : ""}
      </div>
      <div class="foot">
        <span class="path">${p(s.cwd)}</span>
        <span class="id">${p(s.id.slice(0, 13))}…</span>
        ${hostLabel(s.instance)}
      </div>
    </div>`;

  const sections = data.projects
    .map(
      (pr) => `
    <section class="proj">
      <header>
        <span class="pcount">${pr.sessions.length}</span>
        <div>
          <div class="ppath">${p(pr.path)}</div>
          <div class="pk">${p(pr.key)}${hostLabel(pr.instance)}</div>
        </div>
      </header>
      <div class="cards">${pr.sessions.map(card).join("")}</div>
    </section>`
    )
    .join("");

  const offNote = data.offline && data.offline.length
  ? ` · <span class="off">离线实例：${data.offline.map((o) => `${esc(o.instance)}${o.staleSince ? "（上次快照 " + when(o.staleSince) + "）" : "（无可展示快照）"}`).join("；")}</span>`
  : "";
const sub = `资源：${data.resources.map(esc).join(" / ")} · 生成于 ${when(data.mergedAt)}${offNote}`;
return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DSh 实例会话总览</title>
<style>
:root{--bg:#0f1216;--panel:#171b21;--line:#242a33;--fg:#e6e9ed;--mut:#8a94a2;--run:#4ecb71;--act:#e8c34a;--idle:#5f6d7c;--new:#8a94a2}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,"PingFang SC",sans-serif;padding:24px}
h1{font-size:16px;margin:0 0 4px}h1 small{color:var(--mut);font-weight:400}.sub{color:var(--mut);margin-bottom:20px;font-size:12px}
.proj{background:var(--panel);border:1px solid var(--line);border-radius:10px;margin-bottom:14px;overflow:hidden}
.proj>header{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid var(--line)}
.pcount{background:var(--line);color:var(--fg);border-radius:999px;min-width:22px;text-align:center;font-size:12px;padding:2px 7px}
.ppath{font-weight:600}.pk{color:var(--mut);font-size:11px}
.host{margin-left:6px;color:var(--mut);font-size:11px;background:var(--line);border-radius:4px;padding:1px 5px}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px;padding:12px}
.card{background:#11151a;border:1px solid var(--line);border-radius:8px;padding:10px 12px}
.card .top{display:flex;align-items:center;gap:7px;margin-bottom:6px}
.dot{width:9px;height:9px;border-radius:50%;flex:none}.dot.run{background:var(--run);box-shadow:0 0 0 3px rgba(78,203,113,.15)}.dot.act{background:var(--act)}.dot.idle{background:var(--idle)}.dot.new{background:var(--new)}
.st{font-size:11px;color:var(--mut)}.title{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.meta{display:flex;gap:10px;color:var(--mut);font-size:11px;flex-wrap:wrap}.meta .ago{color:#b7c1cc}
.foot{display:flex;gap:8px;color:var(--mut);font-size:11px;margin-top:6px;flex-wrap:wrap}
.path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60%}
.off{color:#e06c6c}
</style></head><body>
<h1>DSh 实例会话总览 <small>全部实例 · 按最近活动排序</small></h1>
<div class="sub">${sub}</div>
${sections}
</body></html>`;
}

const htmlPath = arg("--html", null);
const watchSec = Number(arg("--watch", "0"));
const showHost = process.argv.includes("--host-chip");

// Retain the last good index per instance across ticks, so a transient SSH
// drop keeps the previous snapshot on screen (flagged offline) instead of
// wiping the dashboard; recovery is automatic once the host is reachable.
const lastGood = new Map();

async function runOnce(cfg) {
  const raws = [];
  const offline = [];
  for (const inst of cfg.instances) {
    const res = await collectInstance(inst);
    if (res.error) {
      const prev = lastGood.get(inst.id);
      if (prev) raws.push({ instance: inst.id, ...prev });
      offline.push({ instance: inst.id, error: res.error, staleSince: prev ? prev.generatedAt : null });
      continue;
    }
    lastGood.set(inst.id, res);
    raws.push(res);
  }
  const data = merge(raws);
  data.offline = offline;
  return data;
}

async function tick() {
  const cfg = JSON.parse(await readFile(arg("--instances", join(here, "instances.json")), "utf8"));
  const data = await runOnce(cfg);
  if (htmlPath) {
    await writeFile(htmlPath, renderHtml(data, showHost), "utf8");
    const off = data.offline.length ? ` (离线: ${data.offline.map((o) => o.instance).join(",")})` : "";
    process.stdout.write(`[${when(data.mergedAt)}] ${data.resources.join("+")}: ${data.projects.length} projects / ${data.sessions.length} sessions${off} -> ${htmlPath}\n`);
  } else {
    process.stdout.write(JSON.stringify(data));
  }
}

// 单轮失败（远端 banner / SSH 抖动 / 临时读不到 instances.json）不该让整个 watch 进程退出 ——
// 那会让 HTML 永远停在旧快照上，而且用户看不到任何提示。记录并等下一轮。
async function tickGuarded() {
  try {
    await tick();
    return true;
  } catch (error) {
    process.stderr.write(`[${when(Date.now())}] 本轮刷新失败，等下一轮：${error.message}\n`);
    // JSON 模式（没有 --html）下 stdout 是给机器消费的（`hwb-index > index.json`）。
    // 原先失败时**什么都不输出**、命令却以 0 退出 —— 下游拿到一个空的 index.json 且毫不知情，
    // 而「空文件 + 成功退出」是最难排查的一种失败。现在给出结构化的失败文档 + 非零退出码。
    if (!htmlPath) {
      process.stdout.write(JSON.stringify({
        error: String(error.message || error).slice(0, 300), offline: [], projects: [], sessions: [], resources: [],
      }));
    }
    return false;
  }
}

// stdout 被下游提前关闭是**正常用法**（`hwb-index | head`、`| grep -q`），
// 默认行为却是未捕获的 EPIPE 异常 + 一堆栈帧。EPIPE 安静退出，其它错误照常抛。
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

if (!await tickGuarded()) process.exitCode = 1;
if (watchSec > 0) {
  setInterval(tickGuarded, watchSec * 1000);
}
