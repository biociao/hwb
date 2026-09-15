#!/usr/bin/env node
/**
 * net-shim — a byte-counting, rate-limiting, failure-injecting TCP shim.
 *
 * Two jobs:
 *   1. MEASURE. Dropped in front of an SSH connection it reports the exact wire
 *      bytes each direction, which is the only honest way to compare "open the
 *      dsh web UI" (measured: 3 501 190 B of root + plugin bundles) against "run
 *      one headless task" (~9.6 KB) on a thin link.
 *   2. REPRODUCE. The same knobs throttle the link to a given rate, add connect
 *      latency/jitter, stall the stream, or reset the connection mid-flight, so
 *      "works on a bad network" can be tested on demand instead of hoped for.
 *
 * Calibrated before being trusted (see docs/dgx21-lowbandwidth-channel.md):
 * a 100 000 B incompressible payload reads as 104 851 B here (4.85% SSH framing),
 * and --rate-kbyte 8 delivers 8.38 KB/s (105% of target).
 *
 * Modes
 *   --stdio     stdin/stdout are the transport. Use as an OpenSSH ProxyCommand:
 *                 ssh -o ProxyCommand="node net-shim.mjs --stdio \
 *                     --target %h:%p --stats /tmp/s.json" dgx21.tun
 *   --listen    accept on --listen and shim each connection to --target, counting
 *               every connection -- which is how a shared mux master is measured.
 *
 * Rate units are spelled out because getting them wrong is SILENT: the limiter
 * paces to whatever the number means, so a mislabelled unit produces a plausible
 * run that tested a link 8x off from what the label claims. `--rate-kbps` is
 * kilobits/s; `--rate-kbyte` is kilobytes/s.
 *
 * Run with --help for the full flag list (kept in one place so it cannot drift).
 *
 * Exits 0 always: the shim is a transport, and its child (ssh) owns the verdict.
 */
import net from 'node:net';
import fs from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function splitHostPort(s, fallbackPort) {
  const i = s.lastIndexOf(':');
  if (i === -1) return { host: s, port: fallbackPort };
  return { host: s.slice(0, i), port: Number(s.slice(i + 1)) };
}

/** Statistics for one shim lifetime: bytes each way plus a timestamped event log. */
class Stats {
  constructor(extra = {}) {
    this.t0 = Date.now();
    this.toRemote = 0; // client -> server (e.g. keystrokes, command bytes)
    this.fromRemote = 0; // server -> client (e.g. the answer, the plugin bundles)
    this.connections = 0;
    this.events = [];
    this.event("start", extra);
  }
  event(type, detail) {
    this.events.push({ t: Date.now() - this.t0, type, ...(detail ? { detail } : {}) });
  }
  write(path) {
    if (!path) return;
    const payload = {
      startedAt: new Date(this.t0).toISOString(),
      durationMs: Date.now() - this.t0,
      connections: this.connections,
      bytesToRemote: this.toRemote,
      bytesFromRemote: this.fromRemote,
      totalBytes: this.toRemote + this.fromRemote,
      events: this.events,
    };
    try {
      fs.writeFileSync(path, JSON.stringify(payload, null, 2));
    } catch (err) {
      process.stderr.write(`net-shim: cannot write stats: ${err.message}\n`);
    }
  }
  summary() {
    return `${this.toRemote} B up / ${this.fromRemote} B down`;
  }
}

/**
 * Convert a rate specification to bytes/s.
 *
 * Named and tested because this is precisely where a silent 8x error lived: the
 * flag was read as kilobits/s while the help text and docs called it KB/s, so a
 * run labelled "4 KB/s" actually throttled to 0.5 KB/s. Nothing errored -- it
 * just measured a link 8x different from its label.
 *
 * @param {{kbps?: any, kbyte?: any}} spec - kilobits/s or kilobytes/s
 * @returns {number} bytes per second, 0 meaning unlimited
 */
function rateToBytesPerSec(spec) {
  if (spec.kbyte) return Math.round(Number(spec.kbyte) * 1024);
  if (spec.kbps) return Math.round((Number(spec.kbps) * 1000) / 8);
  return 0;
}

function makeStats(path, extra) {
  const s = new Stats(extra);
  const finish = () => s.write(path);
  process.on('exit', finish);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { finish(); process.exit(0); });
  return s;
}

/**
 * Pump `from` into `to`, counting bytes, honouring an optional rate cap.
 * A rate cap pauses the source rather than buffering without bound, so the
 * shim applies real backpressure to the peer (which is what a thin link does).
 */
function pump(from, to, stats, opts, onBytes, label) {
  const capBytesPerSec = opts.rateBytesPerSec || 0;
  let windowStart = Date.now();
  let windowBytes = 0;
  let stalled = false;

  from.on('data', (chunk) => {
    onBytes(chunk.length);
    if (!capBytesPerSec) {
      // Fast path: hand the chunk straight through, pausing the source when the
      // sink is full so backpressure reaches the peer.
      if (!to.write(chunk)) {
        from.pause();
        to.once('drain', () => from.resume());
      }
      return;
    }
    from.pause();
    const chunkBytes = chunk.length;
    const now = Date.now();
    if (now - windowStart >= 1000) {
      windowStart = now;
      windowBytes = 0;
    }
    const budgetMs = ((windowBytes + chunkBytes) / capBytesPerSec) * 1000;
    const elapsed = now - windowStart;
    const waitMs = Math.max(0, budgetMs - elapsed);
    windowBytes += chunkBytes;
    const proceed = () => {
      if (stalled) return;
      if (!to.write(chunk)) {
        to.once('drain', () => from.resume());
      } else {
        from.resume();
      }
    };
    if (waitMs > 0) setTimeout(proceed, waitMs);
    else proceed();
  });

  // A stall is a hard pause of this direction: nothing moves for a while.
  if (opts.stallPct > 0 && Math.random() * 100 < opts.stallPct) {
    setTimeout(() => {
      stalled = true;
      from.pause();
      stats.event(`${label}-stall-begin`);
      setTimeout(() => {
        stalled = false;
        from.resume();
        stats.event(`${label}-stall-end`, { stallMs: opts.stallMs });
      }, opts.stallMs);
    }, 50 + Math.random() * 200);
  }

  from.on('end', () => {
    to.end();
  });
  from.on('error', () => {
    try { to.destroy(); } catch { /* already gone */ }
  });
  to.on('error', () => {
    try { from.destroy(); } catch { /* already gone */ }
  });
}

/** One shimmed connection: client socket (or stdio) <-> target socket. */
function shimConnection(target, opts, stats, client, onClose) {
  stats.connections++;
  const connectDelay = opts.latencyMs + (opts.jitterMs ? Math.random() * opts.jitterMs : 0);
  stats.event('connect-begin', { delayMs: Math.round(connectDelay), target: `${target.host}:${target.port}` });

  let closed = false;
  const closeOnce = () => {
    if (closed) return;
    closed = true;
    stats.event('closed');
    onClose?.();
  };

  const start = () => {
    const server = net.connect({ host: target.host, port: target.port });
    let connected = false;
    server.on('connect', () => {
      connected = true;
      stats.event('connected');
      pump(client, server, stats, opts, (n) => { stats.toRemote += n; }, 'up');
      pump(server, client, stats, opts, (n) => { stats.fromRemote += n; }, 'down');
    });
    server.on('error', (err) => {
      stats.event('target-error', { message: err.message });
      try { client.destroy(); } catch { /* already gone */ }
      closeOnce();
    });
    server.on('close', () => {
      stats.event('target-close', { connected });
      try { client.destroy(); } catch { /* already gone */ }
      closeOnce();
    });
    if (opts.resetPct > 0 && Math.random() * 100 < opts.resetPct) {
      const at = opts.resetAfterMs;
      setTimeout(() => {
        stats.event('injected-reset');
        server.destroy();
        try { client.destroy(); } catch { /* already gone */ }
      }, at);
    }
  };

  if (connectDelay > 0) setTimeout(start, connectDelay);
  else start();

  // A client that goes away is normal (ssh ends the session); the server 'close'
  // handler is what finalises the stats, so errors here need no separate path.
  client.on('error', () => { /* handled by the server close path */ });
}

const USAGE = `net-shim — byte-counting, rate-limiting, failure-injecting TCP shim

Measures exact wire bytes for a connection and can degrade it on demand, so a
"works on a bad link" claim can be tested instead of hoped for.

Usage as an SSH ProxyCommand (stdio mode):
  ssh -o ProxyCommand="node net-shim.mjs --stdio --target %h:%p --stats /tmp/s.json" HOST cmd

Usage as a local listening proxy (counts every connection, e.g. to measure a
shared mux master -- see docs/dgx21-lowbandwidth-channel.md section 8):
  node net-shim.mjs --listen 127.0.0.1:0 --target 10.0.0.1:22 --stats /tmp/s.json

Options:
  --stdio                stdin/stdout are the transport (for ProxyCommand)
  --listen HOST:PORT     accept connections (PORT 0 picks a free port and prints it)
  --target HOST:PORT     where to forward (or pass as "host port" in stdio mode)

  --rate-kbps N          cap throughput each direction, KILOBITS/s  (0 = unlimited)
  --rate-kbyte N         cap throughput each direction, KILOBYTES/s (0 = unlimited)
  --latency-ms N         delay before connecting (simulates a slow handshake)
  --jitter-ms N          random extra delay, 0..N
  --stall-pct N          chance a connection stalls mid-flight
  --stall-ms N           how long such a stall lasts (default 1000)
  --reset-pct N          chance a connection is reset mid-flight
  --reset-after-ms N     ...once at least this many ms have elapsed (default 500)

  --stats FILE           write a JSON summary (bytes + event timeline) on exit
  --quiet                suppress the one-line human summary
  -h, --help             this help

Rate units are spelled out on purpose: the limiter paces to whatever the number
means, so a mislabelled unit yields a plausible run that tested a link 8x off.
`;

function main() {
  const argv = parseArgs(process.argv.slice(2));
  if (argv.help || argv.h) {
    process.stdout.write(USAGE);
    return;
  }
  const opts = {
    stdio: !!argv.stdio,
    listen: typeof argv.listen === 'string' ? argv.listen : '',
    // One canonical internal unit (bytes/s); the two flags differ only by 8x.
    rateBytesPerSec: rateToBytesPerSec({ kbps: argv['rate-kbps'], kbyte: argv['rate-kbyte'] }),
    rateSpec: argv['rate-kbyte'] ? `${argv['rate-kbyte']} kbyte/s` : (argv['rate-kbps'] ? `${argv['rate-kbps']} kbit/s` : 'unlimited'),
    latencyMs: argv['latency-ms'] ? Number(argv['latency-ms']) : 0,
    jitterMs: argv['jitter-ms'] ? Number(argv['jitter-ms']) : 0,
    stallPct: argv['stall-pct'] ? Number(argv['stall-pct']) : 0,
    stallMs: argv['stall-ms'] ? Number(argv['stall-ms']) : 1000,
    resetPct: argv['reset-pct'] ? Number(argv['reset-pct']) : 0,
    resetAfterMs: argv['reset-after-ms'] ? Number(argv['reset-after-ms']) : 500,
    statsPath: typeof argv.stats === 'string' ? argv.stats : '',
    quiet: !!argv.quiet,
  };

  // In stdio mode the target arrives either via --target or as `%h %p`.
  const targetArg = typeof argv.target === 'string'
    ? argv.target
    : (argv._.length >= 2 ? `${argv._[0]}:${argv._[1]}` : argv._[0] ?? '');
  const target = splitHostPort(targetArg, 22);
  if (!target.host || !Number.isFinite(target.port)) {
    process.stderr.write('net-shim: need --target host:port (or host port args)\n');
    process.exit(2);
  }

  const stats = makeStats(opts.statsPath, {
    mode: opts.stdio ? 'stdio' : 'listen',
    target: `${target.host}:${target.port}`,
    rateBytesPerSec: opts.rateBytesPerSec,
    rateSpec: opts.rateSpec,
    latencyMs: opts.latencyMs,
    jitterMs: opts.jitterMs,
    stallPct: opts.stallPct,
    resetPct: opts.resetPct,
  });

  const report = () => {
    if (!opts.quiet) {
      process.stderr.write(
        `net-shim: ${stats.connections} conn, ${stats.toRemote} B up, ${stats.fromRemote} B down\n`,
      );
    }
  };

  // ssh may hard-kill its ProxyCommand the instant the session ends, so an
  // exit-only flush loses the measurement exactly when it matters. Persist on a
  // short interval while bytes are moving, plus on every signal/exit path.
  const flush = () => stats.write(opts.statsPath);
  const timer = setInterval(flush, 250);
  const stopAll = () => {
    clearInterval(timer);
    flush();
    report();
  };
  process.on('exit', stopAll);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { stopAll(); process.exit(0); });
  }

  if (opts.stdio) {
    // ProxyCommand: ssh talks to us over stdin (toward the remote) and stdout
    // (from the remote). Present that pair as a socket-shaped duplex so the very
    // same pump code serves both modes.
    const { stdin, stdout } = process;
    const facade = {
      write: (chunk) => stdout.write(chunk),
      end: () => { try { stdout.end(); } catch { /* already ended */ } },
      destroy: () => { try { stdin.destroy(); } catch { /* already gone */ } },
      pause: () => stdin.pause(),
      resume: () => stdin.resume(),
      on(ev, fn) {
        if (ev === 'drain') stdout.on('drain', fn);
        else if (ev === 'error') stdin.on('error', fn);
        else stdin.on(ev, fn);
        return facade;
      },
      once(ev, fn) {
        if (ev === 'drain') stdout.once('drain', fn);
        else if (ev === 'error') stdin.once('error', fn);
        else stdin.once(ev, fn);
        return facade;
      },
      removeListener: () => facade,
    };
    // Deliberately NOT resumed here: stdin must stay paused until the target
    // socket is up and pump() attaches its data listener. Resuming first would
    // let ssh's opening bytes (kex) fire with no listener attached and vanish,
    // which shows up as "Bad packet length" / MAC errors rather than a clean
    // failure -- the stream stays intact only because a paused stream buffers.
    shimConnection(target, opts, stats, facade, () => {
      stopAll();
      // Let the final flush land, then get out of ssh's way.
      setTimeout(() => process.exit(0), 30);
    });
  } else {
    const lp = splitHostPort(opts.listen || '127.0.0.1:0', 0);
    const proxy = net.createServer((client) => {
      shimConnection(target, opts, stats, client, () => { /* stay up for the next client */ });
    });
    proxy.listen(lp.port, lp.host, () => {
      const addr = proxy.address();
      // Announce the chosen port so callers (and tests) can find it.
      process.stdout.write(`net-shim listening on ${addr.address}:${addr.port}\n`);
      stats.event('listening', { port: addr.port });
    });
  }
}

export { rateToBytesPerSec };

// Only run when invoked as a CLI, so tests can import the conversion.
const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
