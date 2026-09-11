#!/usr/bin/env node
// dsh-instance-index.mjs
// Lightweight per-instance dsh session index.
//
// Generates a compact index of one dsh instance's sessions: project (cwd) +
// per-session card metadata (id, title, createdAt, updatedAt, size, status,
// turn/step counters, goal, token usage). It reads ONLY the session header
// line + stat + the projection cache — it never decodes message content and
// never persists anything. Output is a JSON document on stdout.
//
//   node dsh-instance-index.mjs [--root <sessions>] [--cache <projcache/sessions>] [--instance <id>]
//
// Requires a Node with zstd in `node:zlib` (Node >= 22.15 / >= 21.2).

import { readdir, readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { createZstdDecompress } from "node:zlib";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const root = arg("--root", join(homedir(), ".dsh", "sessions"));
const cache = arg("--cache", join(homedir(), ".dsh", "storages", "session_projcache", "sessions"));
const instance = arg("--instance", basename(root) || "instance");
const activeTolMs = Number(arg("--active-tol", "90000")); // "recently active" window

// dsh session ids are `session-<uuid>` (all safe code units + `-`), so the
// path-encoded segment equals the raw id. Cache files are keyed by that same
// segment (legacy records may use the bare id; the loader normalizes both).

// 只读第一行 —— 但 zstd 是流式压缩，取一行必须先解压。
//
// 原生实现用 zstdDecompressSync(整个文件)：本文件自称「lightweight / 只读 session header」，
// 实际上一个 19 KB 的 session.jsonl.zstd（解压后 200 MB）会让峰值 RSS 到 480 MB ——
// 而这个脚本还会经 ssh 在**远端主机**上跑，大会话能把远端的 dsh 一起拖下水。
// 改成流式解压，拿到第一个换行就销毁流；并对 header 长度设硬上限（正常 header 只有几百字节）。
const HEADER_LIMIT = 64 * 1024;

async function readHeaderFirstLine(path, suffix) {
  if (suffix !== ".jsonl.zstd") {
    const buf = await readFile(path);
    const nl = buf.indexOf(0x0a);
    return buf.subarray(0, nl === -1 ? buf.length : nl).toString("utf8");
  }
  return new Promise((resolve, reject) => {
    const stream = createReadStream(path);
    const unzstd = createZstdDecompress();
    const chunks = [];
    let total = 0;
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      stream.destroy();
      unzstd.destroy();
      if (err) return reject(err);
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    unzstd.on("data", (chunk) => {
      // 换行不会跨 chunk，所以在单个 chunk 内找即可。
      const nl = chunk.indexOf(0x0a);
      if (nl !== -1) { chunks.push(chunk.subarray(0, nl)); return finish(null); }
      chunks.push(chunk);
      total += chunk.length;
      if (total > HEADER_LIMIT) return finish(null);
    });
    unzstd.on("end", () => finish(null));
    unzstd.on("error", finish);
    stream.on("error", finish);
    stream.pipe(unzstd);
  });
}

function parseHeader(line) {
  try {
    const v = JSON.parse(line);
    if (v && v.type === "session") return v;
  } catch {}
  return null;
}

// Load every projection cache record into a lookup: id -> enriched meta.
async function loadCache() {
  const found = new Map(); // id -> record rows
  let entries;
  try {
    entries = await readdir(cache, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".json")) continue;
    const base = e.name.slice(0, -".json".length);
    // The cache filename encodes the session id; normalize to the full id.
    const full = /^session-/.test(base) ? base : `session-${base}`;
    try {
      const doc = JSON.parse(await readFile(join(cache, e.name), "utf8"));
      const record = doc.record;
      if (record && record.rows) found.set(full, record.rows);
    } catch {}
  }
  return found;
}

function statusOf(stats, updatedAt) {
  if (!stats) return "idle";
  const openStep = stats.openStep;
  if (openStep && typeof openStep === "object") return "running";
  const turns = stats.turns || 0;
  const active = Date.now() - updatedAt <= activeTolMs;
  if (active) return "active";
  return turns > 0 ? "idle" : "new";
}

function fmtBytes(n) {
  if (n == null) return 0;
  if (n >= 1048576) return +(n / 1048576).toFixed(2);
  if (n >= 1024) return +(n / 1024).toFixed(1);
  return n;
}

async function main() {
  const now = Date.now();
  const projects = [];
  const flat = [];

  let rootDirs;
  try {
    rootDirs = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory());
  } catch {
    rootDirs = [];
  }

  // 缓存目录是**全局**的（会按 sessionId 对上下面的每个项目），所以只读一次。
  // 原先它放在 for 里，每个项目目录都重扫一遍缓存目录并解析全部 json：
  // 30 个项目 × 100 个缓存文件 = 3000 次 readFile；真实 home（214 项目 × 428 文件）约 91k 次。
  const cacheRows = await loadCache();

  for (const p of rootDirs) {
    const projDir = join(root, p.name);
    const sessions = [];
    let sessionDirs;
    try {
      sessionDirs = (await readdir(projDir, { withFileTypes: true })).filter((d) => d.isDirectory());
    } catch {
      continue;
    }
    for (const s of sessionDirs) {
      const sessDir = join(projDir, s.name);
      const zpath = join(sessDir, "session.jsonl.zstd");
      const ppath = join(sessDir, "session.jsonl");
      let path = zpath, suffix = ".jsonl.zstd";
      try {
        await stat(zpath);
      } catch {
        path = ppath; suffix = ".jsonl";
      }
      let header = null;
      try {
        header = parseHeader(await readHeaderFirstLine(path, suffix));
      } catch {}
      const id = header?.id || s.name;
      let updatedAt = now, size = 0;
      try {
        const st = await stat(path);
        updatedAt = st.mtimeMs;
        size = st.size;
      } catch {}
      const createdAt = header?.createdAt ?? updatedAt;

      sessions.push({
        id,
        title: null,
        cwd: header?.cwd ?? projDir,
        status: "idle",
        createdAt,
        updatedAt,
        sizeBytes: fmtBytes(size),
        turns: 0,
        steps: 0,
        lastTurn: 0,
        llmMs: 0,
        toolMs: 0,
        tokens: 0,
        goal: null,
        runningStep: null,
      });
    }

    // Enrich with projection-cache metadata (title/stats/goal/tokens).
    const byId = new Map(sessions.map((s) => [s.id, s]));
    for (const [id, rows] of cacheRows) {
      const s = byId.get(id);
      if (!s) continue;
      const title = rows.title?.val;
      if (typeof title === "string") s.title = title;
      const stats = rows.sessionStats?.val;
      if (stats) {
        s.turns = stats.turns ?? 0;
        s.steps = stats.steps ?? 0;
        s.lastTurn = stats.lastTurn ?? 0;
        s.llmMs = stats.llmMs ?? 0;
        s.toolMs = stats.toolMs ?? 0;
        s.runningStep = stats.openStep ?? null;
      }
      const tu = rows.tokenUsage?.val;
      if (tu && typeof tu === "object") {
        s.tokens = tu.total ?? tu.input ?? 0;
      }
      s.goal = rows.goal?.val ?? null;
      s.status = statusOf(stats, s.updatedAt);
    }

    for (const s of sessions) flat.push(s);
    if (sessions.length) projects.push({ key: p.name, path: sessions[0].cwd, sessions });
  }

  // Sort sessions by recency (updatedAt desc); sort projects by most recent session.
  flat.sort((a, b) => b.updatedAt - a.updatedAt);
  const maxUp = (arr) => arr.reduce((m, s) => Math.max(m, s.updatedAt), 0);
  for (const pr of projects) pr.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  projects.sort((a, b) => maxUp(b.sessions) - maxUp(a.sessions));

  const out = { instance, generatedAt: now, root, cache, projects, sessions: flat };
  process.stdout.write(JSON.stringify(out));
}

main().catch((err) => {
  process.stderr.write(String(err && err.stack || err) + "\n");
  process.exit(1);
});
