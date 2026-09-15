#!/usr/bin/env node
/**
 * nodownload-check.mjs — prove (or refute) that this channel downloads nothing.
 *
 * The whole point of the headless route is that it reuses packages already on the
 * remote: the profile is 396 bytes and no package manager ever runs. That claim is
 * easy to make and just as easy to break silently -- a stray `pnpm install`, an
 * implicit dependency fetch, or a warmed cache would all leave traces on disk.
 *
 * So this takes a read-only snapshot of everything a download would touch, and can
 * diff a later snapshot against it. It never writes to the remote and never
 * installs anything: a check that mutates the thing it is checking proves nothing.
 *
 * Usage:
 *   node scripts/soak/nodownload-check.mjs --host dgx21.tun --snapshot /tmp/base.json
 *   node scripts/soak/nodownload-check.mjs --host dgx21.tun --compare  /tmp/base.json
 *
 * Exit codes: 0 unchanged (or snapshot written) · 1 something changed · 3 unreachable
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

// Piping into `head`/`sed` is normal usage; closing our stdout early must not
// crash the tool with an unhandled EPIPE.
process.stdout.on('error', (err) => {
  if (err && err.code === 'EPIPE') process.exit(0);
});


function parseArgs(argv) {
  const o = { host: 'dgx21.tun', snapshot: '', compare: '', json: false, timeout: 120 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} needs a value`); return v; };
    switch (a) {
      case '--host': o.host = val(); break;
      case '--snapshot': o.snapshot = val(); break;
      case '--compare': o.compare = val(); break;
      case '--json': o.json = true; break;
      case '--timeout': o.timeout = Number(val()); break;
      case '-h': case '--help':
        process.stdout.write('nodownload-check.mjs [--host H] (--snapshot FILE | --compare FILE) [--json]\n');
        process.exit(0);
        break;
      default: throw new Error(`unknown option: ${a}`);
    }
  }
  return o;
}

/**
 * Read-only census of every place a download would land. `stat -c` is GNU, the
 * `-f %m` form is BSD, and the remotes are a mix (dgx21 is Linux, cms.tun is a
 * Mac), so mtime() tries both rather than assuming one.
 */
const CENSUS = String.raw`
mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo NA; }
for p in "$HOME/.local/share/pnpm/store" "$HOME/.pnpm-store" "$HOME/.cache/pnpm" \
         "$HOME/.npm/_cacache" "$HOME/.cache/node-gyp" "$HOME/.dsh/profiles/node_modules"; do
  if [ -e "$p" ]; then
    echo "path|$p|present|$(mtime "$p")|$(du -sk "$p" 2>/dev/null | cut -f1)"
  else
    echo "path|$p|absent|NA|NA"
  fi
done
echo "profiles_node_modules_entries|$(ls -1 "$HOME/.dsh/profiles/node_modules" 2>/dev/null | wc -l)"
echo "headless_dir_files|$(ls -1 "$HOME/.dsh/profiles/headless" 2>/dev/null | sort | tr '\n' ',')"
echo "headless_dir_kb|$(du -sk "$HOME/.dsh/profiles/headless" 2>/dev/null | cut -f1)"
echo "dsh_version|$(export PATH=$HOME/.local/node/bin:$PATH; dsh --version 2>&1 | head -1)"
`;
// NOTE: whole-disk usage is deliberately NOT recorded. dsh writes sessions and
// logs as it works, so disk usage always moves -- including it would make the
// morning comparison report CHANGED unconditionally and prove nothing.

function run(argv, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let kill;
    let grace;
    const settle = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(kill);
      clearTimeout(grace);
      resolve({ code, stdout, stderr });
    };
    kill = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* gone */ }
      setTimeout(() => settle(255), 3000);
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { stderr += err.message; settle(127); });
    child.on('exit', (code) => { grace = setTimeout(() => settle(code ?? 255), 300); });
    child.on('close', (code) => settle(code ?? 255));
  });
}

async function census(o) {
  const argv = [
    'ssh',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=20',
    '-o', 'ClearAllForwardings=yes',
    '-o', 'Compression=yes',
    o.host,
    CENSUS,
  ];
  const r = await run(argv, o.timeout * 1000);
  if (r.code !== 0) return { ok: false, error: r.stderr.trim().split('\n').pop() ?? `exit ${r.code}` };
  const snap = { host: o.host, takenAt: new Date().toISOString(), paths: {}, scalars: {} };
  for (const line of r.stdout.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('path|')) {
      const [, p, state, mtime, kb] = t.split('|');
      snap.paths[p] = { state, mtime, kb };
    } else {
      const m = /^([a-z0-9_]+)\|(.*)$/.exec(t);
      if (m) snap.scalars[m[1]] = m[2];
    }
  }
  return { ok: true, snap };
}

/** Compare two censuses. Disk usage is allowed to grow slightly (session data). */
function diff(base, now) {
  const changes = [];
  for (const [p, b] of Object.entries(base.paths)) {
    const n = now.paths[p];
    if (!n) { changes.push(`${p}: missing from the new snapshot`); continue; }
    // The decisive signal: a download creates or touches these directories.
    if (b.state === 'absent' && n.state === 'present') changes.push(`${p}: APPEARED (a cache was created)`);
    else if (b.state === 'present' && n.mtime !== b.mtime) changes.push(`${p}: mtime changed ${b.mtime} -> ${n.mtime} (written to)`);
    else if (b.state === 'present' && n.kb !== b.kb) changes.push(`${p}: size changed ${b.kb}KB -> ${n.kb}KB`);
  }
  // Symmetric: a censused location that appeared only in the new snapshot is a
  // violation too (e.g. a baseline taken before a location was added to CENSUS).
  for (const p of Object.keys(now.paths)) {
    if (!(p in base.paths)) changes.push(`${p}: not in the baseline (appeared since)`);
  }
  for (const [k, b] of Object.entries(base.scalars)) {
    const n = now.scalars[k];
    if (n === undefined) { changes.push(`${k}: missing from the new snapshot`); continue; }
    if (n !== b) changes.push(`${k}: ${b} -> ${n}`);
  }
  return changes;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!o.snapshot && !o.compare) {
    process.stderr.write('nodownload-check: need --snapshot FILE or --compare FILE\n');
    process.exit(2);
  }
  const res = await census(o);
  if (!res.ok) {
    process.stderr.write(`nodownload-check: cannot census ${o.host}: ${res.error}\n`);
    process.exit(3);
  }

  if (o.snapshot) {
    fs.mkdirSync(path.dirname(path.resolve(o.snapshot)), { recursive: true });
    fs.writeFileSync(o.snapshot, JSON.stringify(res.snap, null, 2));
    if (o.json) process.stdout.write(JSON.stringify(res.snap, null, 2) + '\n');
    else {
      process.stdout.write(`baseline written: ${o.snapshot}\n`);
      for (const [p, v] of Object.entries(res.snap.paths)) {
        process.stdout.write(`  ${v.state.padEnd(8)} ${v.kb === 'NA' ? '' : `${v.kb}KB`.padEnd(9)} ${p}\n`);
      }
      process.stdout.write(`  dsh version: ${res.snap.scalars.dsh_version ?? '?'}\n`);
    }
    process.exit(0);
  }

  const base = JSON.parse(fs.readFileSync(o.compare, 'utf8'));
  const changes = diff(base, res.snap);
  const header = `nodownload check — ${base.host}\n`
    + `baseline ${base.takenAt}\n`
    + `now      ${res.snap.takenAt}\n`;
  if (changes.length === 0) {
    process.stdout.write(header);
    process.stdout.write('UNCHANGED: no package store, cache or profile was created or written.\n');
    process.stdout.write(`  (${Object.keys(base.paths).length} locations checked, ${Object.keys(base.scalars).length} counters)\n`);
    process.exit(0);
  }
  process.stdout.write(header);
  process.stdout.write('CHANGED:\n');
  for (const c of changes) process.stdout.write(`  - ${c}\n`);
  process.exit(1);
}

export { diff, CENSUS };

// Only run when invoked as a CLI, so tests can import diff() without ssh-ing.
const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`nodownload-check: ${err.stack ?? err}\n`);
    process.exit(2);
  });
}
