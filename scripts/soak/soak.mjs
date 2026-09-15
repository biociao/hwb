#!/usr/bin/env node
/**
 * soak.mjs — the overnight stability harness for the dsh21 channel.
 *
 * Every `--interval` seconds (default 30 min) it runs one round against the
 * remote dsh and appends a JSONL record. The point is not to prove the link is
 * good: it is to learn *how* it fails, so the wrapper can be tuned for the
 * failures that actually happen rather than the ones we imagine.
 *
 * Per round:
 *   probe  link health + remote facts                       (no LLM call)
 *   cold   one task on a fresh SSH connection, byte-measured  (LLM call)
 *   warm   the same task reusing the mux master               (LLM call)
 *
 * Each task also records `attemptsUsed`. That field is the point: "succeeded on
 * the first try" and "succeeded on the third" are different evidence about a
 * link, and with only ok/fail in the record they look identical.
 *
 * Read the results with section 8's caveat in mind -- another ssh consumer (hwb)
 * shares this host, so a failure may be contention rather than the link.
 *
 * Reports:  node scripts/soak/soak.mjs --report [--out FILE]
 * Exits on its own after --rounds rounds; never exits early on a failed round.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const DSH21 = new URL('../dsh21.mjs', import.meta.url).pathname;
const TASK = 'Reply with exactly the single word PONG and nothing else.';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const o = {
    interval: 1800,
    rounds: 16,
    startRound: 1,
    host: 'dgx21.tun',
    out: '',
    measureEvery: 1,
    report: false,
    markdown: false,
    timeout: 420,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} needs a value`); return v; };
    switch (a) {
      case '--interval': o.interval = Number(val()); break;
      case '--rounds': o.rounds = Number(val()); break;
      case '--start-round': o.startRound = Number(val()); break;
      case '--host': o.host = val(); break;
      case '--out': o.out = val(); break;
      case '--measure-every': o.measureEvery = Number(val()); break;
      case '--timeout': o.timeout = Number(val()); break;
      case '--report': o.report = true; break;
      case '--markdown': o.markdown = true; break;
      case '-h': case '--help':
        process.stdout.write('soak.mjs [--interval S] [--rounds N] [--host H] [--out FILE] [--measure-every N] [--report [--markdown]]\n');
        process.exit(0);
        break;
      default: throw new Error(`unknown option: ${a}`);
    }
  }
  if (!o.out) {
    const stamp = new Date().toISOString().slice(0, 10);
    o.out = path.join(HERE, 'results', `soak-${o.host.replace(/[^\w.-]/g, '_')}-${stamp}.jsonl`);
  }
  return o;
}

/**
 * Run a command, capturing stdout/stderr and exit code; never throws.
 *
 * Settles on `exit`, not only on `close`. `close` waits for every holder of the
 * stdio pipes to release them, and a process that forks a lingering child can
 * hold them well past its own death -- which would leave this round waiting
 * forever and end the overnight run silently. A stalled soak is worse than a
 * failed round, so there is also a hard bound after the kill deadline.
 */
/**
 * Record shape version.
 *
 * Bumped whenever the per-round fields change, because editing the harness while
 * a run is in flight is easy to do and produces a file whose rows are NOT
 * comparable: a consumer cannot tell "no retry data" from "retry data collected
 * before that field existed". Recording the version makes a mixed file
 * interpretable instead of quietly misleading.
 *   v1  probe / cold / warm
 *   v2  + cold.attemptsUsed, warm.attemptsUsed, cold.remoteStarted
 */
const RECORD_VERSION = 2;

/**
 * Sleep until an absolute wall-clock deadline, in short chunks.
 *
 * A single `setTimeout(interval)` is fragile for an unattended overnight run:
 * macOS App Nap (and timer coalescing generally) can delay or swallow a long
 * timer, and then the round is LOST, not merely late. This actually happened --
 * the harness sat alive, with no child process and no write for 41 minutes,
 * silently skipping round 10.
 *
 * Re-checking the wall clock each chunk means a delayed timer produces a late
 * round instead of a missing one, and the lateness is reported, not hidden.
 */
async function sleepUntil(deadlineMs) {
  for (;;) {
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) return;
    await sleep(Math.min(remaining, 30_000));
  }
}

function run(argv, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timer;
    let grace;

    const settle = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      resolve({ code, stdout, stderr, ms: Date.now() - t0, timedOut });
    };

    timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      // Whatever the pipes are doing, this round ends and the soak continues.
      setTimeout(() => settle(255), 5000);
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { stderr += err.message; settle(127); });
    child.on('exit', (code) => {
      grace = setTimeout(() => settle(code ?? 255), 300);
    });
    child.on('close', (code) => settle(code ?? 255));
  });
}

/** Last meaningful lines of captured output, for the record. */
function tailLines(text) {
  return String(text ?? '')
    .trim()
    .split('\n')
    .filter((l) => l && !/^debug\d+:/.test(l) && !/^dsh21: attempt /.test(l))
    .slice(-3)
    .join(' | ');
}

function parseJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

/** One round: probe, cold (measured) task, warm (mux) task. */
async function oneRound(o, index) {
  const rec = { v: RECORD_VERSION, round: index, startedAt: new Date().toISOString(), host: o.host };

  // The harness budget must EXCEED the child's own deadline, or a slow probe is
  // SIGKILLed at exactly the moment dsh21 would have reported its structured
  // timeout -- losing the diagnosis in precisely the case that needs it. The
  // cold/warm calls already carry a 120s margin; the probe had none and this
  // makes the relationship explicit on both sides instead of relying on a hidden
  // cap inside dsh21.
  const PROBE_DEADLINE_S = 120;
  const probe = await run(
    ['node', DSH21, '--host', o.host, '--probe', '--json', '--timeout', String(PROBE_DEADLINE_S)],
    (PROBE_DEADLINE_S + 30) * 1000,
  );
  // dsh21 emits JSON even when the probe FAILS, so parse it either way: taking
  // the last raw lines instead records a JSON fragment as the "error" and makes
  // the morning report's distinct-error list unreadable.
  const probeJson = parseJson(probe.stdout);
  rec.probe = probeJson ?? null;
  rec.probeOk = probeJson ? probeJson.ok === true : probe.code === 0;
  if (!rec.probeOk) {
    rec.probeError = probeJson?.error || tailLines(probe.stderr) || tailLines(probe.stdout)
      || `probe exited ${probe.code}`;
  }

  const measure = o.measureEvery > 0 && (index - 1) % o.measureEvery === 0;
  const coldArgs = ['node', DSH21, '--host', o.host, '--json', '--timeout', String(o.timeout)];
  if (measure) coldArgs.push('--measure');
  coldArgs.push(TASK);
  const cold = await run(coldArgs, (o.timeout + 120) * 1000);
  const coldJson = parseJson(cold.stdout);
  rec.cold = {
    ok: cold.code === 0,
    ms: coldJson?.ms ?? cold.ms,
    // How many connections this one task needed. A task that succeeded on its
    // third attempt is NOT the same evidence as one that succeeded first try --
    // without this the two are indistinguishable and the soak throws away its
    // most sensitive measure of link quality.
    attemptsUsed: coldJson?.attemptsUsed ?? null,
    remoteStarted: coldJson?.remoteStarted ?? null,
    exitCode: cold.code,
    phase: coldJson?.phase ?? (cold.timedOut ? 'timeout' : 'unknown'),
    wire: coldJson?.wire ?? null,
    answer: coldJson?.answer ?? '',
    // Prefer dsh21's own error field; fall back to stderr with its retry chatter
    // stripped, so the record shows the CAUSE rather than "reconnecting in 2s".
    error: cold.code === 0 ? '' : (coldJson?.error || tailLines(cold.stderr)),
  };

  const warm = await run(
    ['node', DSH21, '--host', o.host, '--json', '--timeout', String(o.timeout), TASK],
    (o.timeout + 120) * 1000,
  );
  const warmJson = parseJson(warm.stdout);
  rec.warm = {
    ok: warm.code === 0,
    ms: warmJson?.ms ?? warm.ms,
    attemptsUsed: warmJson?.attemptsUsed ?? null,
    exitCode: warm.code,
    phase: warmJson?.phase ?? (warm.timedOut ? 'timeout' : 'unknown'),
    answer: warmJson?.answer ?? '',
    error: warm.code === 0 ? '' : (warmJson?.error || tailLines(warm.stderr)),
  };

  rec.finishedAt = new Date().toISOString();
  return rec;
}

function append(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

function pct(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}

/**
 * Render the run as a markdown block for the deliverable document.
 *
 * Deliberately states the confounding factor (another ssh consumer on the same
 * host) alongside the numbers: a success rate quoted without it invites the
 * reader to attribute every failure to the link, which the data cannot support.
 */
function reportMarkdown(file, rows, s) {
  const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : 'n/a');
  const out = [];
  out.push('### 通宵 soak 结果\n');
  out.push(`窗口：${rows[0]?.startedAt ?? '?'} → ${rows[rows.length - 1]?.finishedAt ?? '?'}，`
    + `共 **${rows.length}** 轮，每 30 分钟一轮。\n`);
  out.push('| 指标 | 结果 |');
  out.push('|---|---|');
  out.push(`| probe 可达 | ${s.probeOk}/${rows.length}（${pct(s.probeOk, rows.length)}） |`);
  out.push(`| 冷启动任务成功 | ${s.coldOk}/${rows.length}（${pct(s.coldOk, rows.length)}） |`);
  out.push(`| 暖启动任务成功 | ${s.warmOk}/${rows.length}（${pct(s.warmOk, rows.length)}） |`);
  out.push(`| 冷启动延迟 | p50 ${s.coldP50} · p90 ${s.coldP90} · max ${s.coldMax} ms |`);
  out.push(`| 暖启动延迟 | p50 ${s.warmP50} · p90 ${s.warmP90} · max ${s.warmMax} ms |`);
  if (s.wireN) out.push(`| 冷启动线上字节（仅成功轮） | p50 ${s.wireP50} B（n=${s.wireN}） |`);
  out.push(`| 重试分布（冷） | ${s.attemptsCold} |`);
  out.push(`| 重试分布（暖） | ${s.attemptsWarm} |`);
  out.push('');
  const phases = Object.entries(s.phases);
  out.push(phases.length
    ? `失败阶段分布：${phases.map(([k, v]) => `\`${k}\`×${v}`).join(' · ')}\n`
    : '失败阶段分布：无失败\n');
  if (s.errors.length) {
    out.push('去重后的错误原文：\n');
    for (const e of s.errors) out.push(`- ${e}`);
    out.push('');
  }
  out.push('> **读这份数据前必读**：同一台机器上还有 **hwb 工作台**在跑，它自己也对 dgx21 持有'
    + '多条 ssh 进程与 mux master，两边在抢同一个 sshd 的未认证连接窗口（`MaxStartups 10:30:100`）。'
    + '因此这里的失败应读作「该链路**在有竞争**时的表现」，不能直接归因为链路本身；'
    + '要归因需要停掉 hwb 再跑一轮对照。');
  return out.join('\n') + '\n';
}

/**
 * Byte costs to report, drawn from successful rounds only.
 *
 * A failed round records wire=0 because the shim spawned and transferred
 * nothing. Averaging those zeroes in collapses the median to 0 and misstates the
 * cost of the thing being measured -- one healthy round plus one failure would
 * report p50 = 0 B.
 */
function wireBytesFrom(rows) {
  return rows
    .filter((r) => r.cold?.ok)
    .map((r) => r.cold.wire?.total)
    .filter((n) => typeof n === 'number' && n > 0);
}

function report(file, asMarkdown = false) {
  if (!fs.existsSync(file)) {
    process.stdout.write(`soak: no results at ${file}\n`);
    return 1;
  }
  const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const coldMs = rows.filter((r) => r.cold.ok).map((r) => r.cold.ms);
  const warmMs = rows.filter((r) => r.warm.ok).map((r) => r.warm.ms);
  const wire = wireBytesFrom(rows);

  const attempts = { cold: {}, warm: {} };
  for (const r of rows) {
    for (const side of ['cold', 'warm']) {
      const n = r[side]?.attemptsUsed;
      if (typeof n === 'number') attempts[side][n] = (attempts[side][n] ?? 0) + 1;
    }
  }
  const fmtAttempts = (m) => {
    const keys = Object.keys(m).map(Number).sort((a, b) => a - b);
    if (!keys.length) return 'n/a (field absent in these rounds)';
    return keys.map((k) => (k === 1 ? `${m[k]} first-try` : `${m[k]} after ${k - 1} retr${k - 1 === 1 ? 'y' : 'ies'}`)).join(' · ');
  };

  const phases = {};
  for (const r of rows) {
    if (!r.cold.ok) phases[r.cold.phase] = (phases[r.cold.phase] ?? 0) + 1;
  }
  const errors = [...new Set(rows.filter((r) => r.cold.error).map((r) => r.cold.error))].slice(0, 5);

  const s = {
    probeOk: rows.filter((r) => r.probeOk).length,
    coldOk: rows.filter((r) => r.cold.ok).length,
    warmOk: rows.filter((r) => r.warm.ok).length,
    coldP50: pct(coldMs, 50), coldP90: pct(coldMs, 90), coldMax: pct(coldMs, 100),
    warmP50: pct(warmMs, 50), warmP90: pct(warmMs, 90), warmMax: pct(warmMs, 100),
    wireP50: pct(wire, 50), wireN: wire.length,
    attemptsCold: fmtAttempts(attempts.cold),
    attemptsWarm: fmtAttempts(attempts.warm),
    phases, errors,
  };

  if (asMarkdown) {
    process.stdout.write(reportMarkdown(file, rows, s));
    return 0;
  }

  process.stdout.write(`soak report — ${file}\n`);
  process.stdout.write(`rounds            ${rows.length}   ${rows[0]?.startedAt ?? ''} → ${rows[rows.length - 1]?.finishedAt ?? ''}\n`);
  process.stdout.write(`probe reachable   ${s.probeOk}/${rows.length}\n`);
  process.stdout.write(`cold task ok      ${s.coldOk}/${rows.length}\n`);
  process.stdout.write(`warm task ok      ${s.warmOk}/${rows.length}\n`);
  process.stdout.write(`cold latency ms   p50 ${s.coldP50} · p90 ${s.coldP90} · max ${s.coldMax}\n`);
  process.stdout.write(`warm latency ms   p50 ${s.warmP50} · p90 ${s.warmP90} · max ${s.warmMax}\n`);
  if (wire.length) {
    process.stdout.write(`wire bytes/cold   p50 ${s.wireP50} · p90 ${pct(wire, 90)} · n ${wire.length} (successful rounds only)\n`);
  }
  process.stdout.write(`attempts cold     ${s.attemptsCold}\n`);
  process.stdout.write(`attempts warm     ${s.attemptsWarm}\n`);
  process.stdout.write(`failure phases    ${JSON.stringify(phases)}\n`);
  if (errors.length) {
    process.stdout.write('distinct errors:\n');
    for (const e of errors) process.stdout.write(`  - ${e}\n`);
  }
  return 0;
}

async function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (err) {
    process.stderr.write(`soak: ${err.message}\n`);
    process.exit(2);
  }
  if (o.report) process.exit(report(o.out, o.markdown));

  process.stdout.write(`soak: ${o.rounds} rounds every ${o.interval}s → ${o.out}\n`);
  // Numbering continues from --start-round so a restarted run appends to the
  // same file without duplicating round numbers.
  for (let i = o.startRound; i < o.startRound + o.rounds; i++) {
    const t0 = Date.now();
    let rec;
    try {
      rec = await oneRound(o, i);
    } catch (err) {
      rec = { round: i, startedAt: new Date().toISOString(), host: o.host, harnessError: String(err?.message ?? err) };
    }
    append(o.out, rec);
    const c = rec.cold ?? {};
    const w = rec.warm ?? {};
    process.stdout.write(
      `round ${i} probe=${rec.probeOk ? 'ok' : 'FAIL'}`
      + ` cold=${c.ok ? `${c.ms}ms` : `FAIL(${c.phase})`}`
      + ` warm=${w.ok ? `${w.ms}ms` : `FAIL(${w.phase})`}`
      + `${c.wire ? ` wire=${c.wire.total}B` : ''}\n`,
    );
    if (i < o.startRound + o.rounds - 1) {
      const deadline = t0 + o.interval * 1000;
      const late = Date.now() - deadline;
      if (late > 60_000) {
        process.stdout.write(
          `soak: WARNING round ${i + 1} starting ${(late / 1000).toFixed(0)}s late`
          + ' (timer delayed -- round not lost, but the cadence slipped)\n',
        );
      }
      await sleepUntil(deadline);
    }
  }
  process.stdout.write(`soak: done. report with: node scripts/soak/soak.mjs --report --out ${o.out}\n`);
  process.exit(0);
}

export { reportMarkdown, wireBytesFrom, tailLines };

// Only run when invoked as a CLI, so tests can import the renderer.
const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`soak: fatal ${err?.stack ?? err}\n`);
    process.exit(1);
  });
}
