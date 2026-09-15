#!/usr/bin/env node
/**
 * bundle-weight.mjs — weigh what the dsh web UI must download before it is usable.
 *
 * This is the number the whole low-bandwidth argument rests on: the UI cannot
 * render until every plugin bundle has arrived, so on a thin link the payload
 * *is* the problem. The figure is worth re-deriving rather than quoting, both
 * because it changes whenever plugins are added and because a stale number in a
 * document is worse than no number.
 *
 * Everything is measured ON the remote host over loopback, so it costs the slow
 * VPN link nothing -- we only need the SIZE, never the bytes.
 *
 * Usage: node scripts/soak/bundle-weight.mjs [--host dgx21.tun] [--port 3080]
 */
import { spawn } from 'node:child_process';
import process from 'node:process';

// Piping into `head`/`sed` is normal usage; closing our stdout early must not
// crash the tool with an unhandled EPIPE.
process.stdout.on('error', (err) => {
  if (err && err.code === 'EPIPE') process.exit(0);
});


function parseArgs(argv) {
  const o = { host: 'dgx21.tun', port: 3080, timeout: 600, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} needs a value`); return v; };
    switch (a) {
      case '--host': o.host = val(); break;
      case '--port': o.port = Number(val()); break;
      case '--timeout': o.timeout = Number(val()); break;
      case '--json': o.json = true; break;
      case '-h': case '--help':
        process.stdout.write('bundle-weight.mjs [--host H] [--port N] [--json]\n');
        process.exit(0);
        break;
      default: throw new Error(`unknown option: ${a}`);
    }
  }
  return o;
}

/**
 * Runs entirely on the remote over loopback. The root document lists the loader
 * entries; each unique bundle URL is fetched twice -- once raw and once through
 * gzip -9 -- to measure the payload and the ceiling on what server-side
 * compression could save. `--compressed` is deliberately NOT used: it would ask
 * the server to compress, and the point is to find out whether it does.
 */
const REMOTE = String.raw`
set -u
PORT="$1"
# Write to a file rather than into $(...): command substitution strips trailing
# newlines, which silently under-counted the root document by a byte.
curl -s --max-time 30 -o /tmp/.dsh21-root.html "http://127.0.0.1:$PORT/"
ROOT_BYTES=$(wc -c < /tmp/.dsh21-root.html | tr -d ' ')
grep -oE '/plugins/[^"'"'"' ]+' /tmp/.dsh21-root.html | sort -u > /tmp/.dsh21-urls.txt
COUNT=$(wc -l < /tmp/.dsh21-urls.txt | tr -d ' ')
RAW=0; GZ=0; FAILED=0
while read -r u; do
  r=$(curl -s --max-time 60 "http://127.0.0.1:$PORT$u" | wc -c | tr -d ' ')
  if [ "$r" = "0" ]; then FAILED=$((FAILED+1)); continue; fi
  g=$(curl -s --max-time 60 "http://127.0.0.1:$PORT$u" | gzip -9 -c | wc -c | tr -d ' ')
  RAW=$((RAW+r)); GZ=$((GZ+g))
done < /tmp/.dsh21-urls.txt
# Does the server compress on request at all?
CMP=$(curl -s --compressed --max-time 30 "http://127.0.0.1:$PORT$(head -1 /tmp/.dsh21-urls.txt)" | wc -c | tr -d ' ')
FIRST=$(curl -s --max-time 30 "http://127.0.0.1:$PORT$(head -1 /tmp/.dsh21-urls.txt)" | wc -c | tr -d ' ')
rm -f /tmp/.dsh21-urls.txt /tmp/.dsh21-root.html
echo "root_bytes=$ROOT_BYTES"
echo "bundle_count=$COUNT"
echo "bundle_raw_bytes=$RAW"
echo "bundle_gzip_bytes=$GZ"
echo "bundle_fetch_failures=$FAILED"
echo "probe_first_bundle_raw=$FIRST"
echo "probe_first_bundle_with_compressed=$CMP"
`;

function run(argv, timeoutMs, input = '') {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
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
    // The remote script travels on stdin, so its quoting never reaches the shell.
    child.stdin.on('error', () => { /* remote may close early; the exit code tells */ });
    child.stdin.end(input);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { stderr += err.message; settle(127); });
    child.on('exit', (code) => { grace = setTimeout(() => settle(code ?? 255), 300); });
    child.on('close', (code) => settle(code ?? 255));
  });
}

const mb = (n) => `${(n / 1048576).toFixed(2)} MB`;

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const r = await run([
    'ssh',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=20',
    '-o', 'ClearAllForwardings=yes',
    '-o', 'Compression=yes',
    o.host,
    'bash -s -- ' + o.port,
  ], o.timeout * 1000, REMOTE);
  if (r.code !== 0) {
    process.stderr.write(`bundle-weight: ${o.host} failed (exit ${r.code})\n${r.stderr.trim()}\n`);
    process.exit(1);
  }
  const v = {};
  for (const line of r.stdout.split('\n')) {
    const m = /^([a-z_]+)=(\d+)$/.exec(line.trim());
    if (m) v[m[1]] = Number(m[2]);
  }
  if (!v.bundle_raw_bytes) {
    process.stderr.write(`bundle-weight: no measurements on ${o.host} (is dsh web on port ${o.port}?)\n${r.stdout.trim()}\n`);
    process.exit(1);
  }
  const firstPaint = v.root_bytes + v.bundle_raw_bytes;
  const ratio = (v.bundle_raw_bytes / v.bundle_gzip_bytes).toFixed(2);
  const out = {
    host: o.host,
    rootBytes: v.root_bytes,
    bundleCount: v.bundle_count,
    bundleRawBytes: v.bundle_raw_bytes,
    bundleGzipBytes: v.bundle_gzip_bytes,
    gzipRatio: Number(ratio),
    firstPaintBytes: firstPaint,
    firstPaintGzipBytes: v.root_bytes + v.bundle_gzip_bytes,
    serversCompressesOnRequest: v.probe_first_bundle_with_compressed < v.probe_first_bundle_raw,
    fetchFailures: v.bundle_fetch_failures,
  };
  if (o.json) {
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return;
  }
  process.stdout.write(`dsh web payload on ${o.host} (measured over loopback)\n`);
  process.stdout.write(`  root document      ${String(v.root_bytes).padStart(9)} B  ${mb(v.root_bytes)}\n`);
  process.stdout.write(`  plugin bundles     ${String(v.bundle_raw_bytes).padStart(9)} B  ${mb(v.bundle_raw_bytes)}   (${v.bundle_count} bundles, ${v.bundle_fetch_failures} failed)\n`);
  process.stdout.write(`  FIRST PAINT        ${String(firstPaint).padStart(9)} B  ${mb(firstPaint)}   <- must arrive before the UI works\n`);
  process.stdout.write(`\n  the same, if the server gzipped them:\n`);
  process.stdout.write(`  plugin bundles     ${String(v.bundle_gzip_bytes).padStart(9)} B  ${mb(v.bundle_gzip_bytes)}\n`);
  process.stdout.write(`  FIRST PAINT        ${String(v.root_bytes + v.bundle_gzip_bytes).padStart(9)} B  ${mb(v.root_bytes + v.bundle_gzip_bytes)}   (${ratio}x smaller)\n`);
  process.stdout.write(`\n  server compresses when asked? ${out.serversCompressesOnRequest ? 'yes' : 'NO'}\n`);
  process.stdout.write(`  for comparison, one cold headless task costs ~9.6 KB and is done in seconds.\n`);
}

main().catch((err) => {
  process.stderr.write(`bundle-weight: ${err.stack ?? err}\n`);
  process.exit(2);
});
