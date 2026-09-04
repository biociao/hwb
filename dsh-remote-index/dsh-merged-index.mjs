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
const indexerSource = await readFile(indexerPath, "utf8");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

async function collectInstance(inst) {
  const args = ["--root", inst.sessionsRoot, "--cache", inst.cacheRoot, "--instance", inst.id];
  let res;
  if (!inst.host) {
    res = spawnSync(inst.nodeBin || "node", [indexerPath, ...args], { encoding: "utf8" });
  } else {
    // Publish the indexer to the remote via stdin:  ssh host <nodeBin> - <args>  <script-source>
    res = spawnSync("ssh", [inst.host, inst.nodeBin || "node", "-", ...args], { input: indexerSource, encoding: "utf8" });
  }
  if (res.status !== 0) {
    throw new Error(`[${inst.id}] indexer failed (${res.status}): ${(res.stderr || "").trim().slice(0, 500)}`);
  }
  const data = JSON.parse(res.stdout);
  return { instance: inst.id, ...data };
}

function merge(raws) {
  const projects = [];
  const sessions = [];
  for (const raw of raws) {
    for (const s of raw.sessions || []) sessions.push({ instance: raw.instance, ...s });
    for (const p of raw.projects || []) {
      projects.push({
        instance: raw.instance,
        key: p.key,
        path: p.path,
        sessions: (p.sessions || []).map((s) => ({ instance: raw.instance, ...s })),
      });
    }
  }
  const byUp = (a, b) => b.updatedAt - a.updatedAt;
  sessions.sort(byUp);
  for (const p of projects) p.sessions.sort(byUp);
  projects.sort((a, b) => Math.max(...b.sessions.map((s) => s.updatedAt), 0) - Math.max(...a.sessions.map((s) => s.updatedAt), 0));
  return { mergedAt: Date.now(), resources: raws.map((r) => r.instance), projects, sessions };
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
        <span class="turns">${s.turns ?? 0} 轮 / ${s.steps ?? 0} 步</span>
        ${s.llmMs ? `<span>LLM ${(s.llmMs / 1000).toFixed(1)}s</span>` : ""}
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
</style></head><body>
<h1>DSh 实例会话总览 <small>全部实例 · 按最近活动排序</small></h1>
<div class="sub">资源：${data.resources.map(esc).join(" / ")} · 生成于 ${when(data.mergedAt)}</div>
${sections}
</body></html>`;
}

async function runOnce() {
  const cfg = JSON.parse(await readFile(arg("--instances", join(here, "instances.json")), "utf8"));
  const raws = [];
  for (const inst of cfg.instances) raws.push(await collectInstance(inst));
  return merge(raws);
}

const htmlPath = arg("--html", null);
const watchSec = Number(arg("--watch", "0"));
const showHost = process.argv.includes("--host-chip");

async function tick() {
  const data = await runOnce();
  if (htmlPath) {
    await writeFile(htmlPath, renderHtml(data, showHost), "utf8");
    process.stdout.write(`[${when(data.mergedAt)}] ${data.resources.join("+")}: ${data.projects.length} projects / ${data.sessions.length} sessions -> ${htmlPath}\n`);
  } else {
    process.stdout.write(JSON.stringify(data));
  }
}

await tick();
if (watchSec > 0) {
  setInterval(tick, watchSec * 1000);
}
