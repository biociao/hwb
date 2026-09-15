#!/usr/bin/env node
/**
 * dsh21 — send one instruction to the dsh on a remote host over a thin, flaky link.
 *
 * Why this exists
 * ---------------
 * The dsh web UI is the wrong transport on a VPN like dgx21.tun. Measured on this
 * link: 3 501 190 B (3.34 MB) of root + 46 plugin bundles must arrive before the
 * UI is usable, at ~25-30 KB/s that is minutes of stalling, and the bundles load
 * concurrently -- one timeout and the whole UI dies with "Failed to load plugins".
 *
 * `dsh --profile headless "<task>"` needs none of that: it boots straight over the
 * already-installed dsh-base + dsh-headless, opens no port, prints the answer and
 * exits. Measured end to end: ~9.6-9.8 KB on the wire (~2% run-to-run variance
 * from SSH framing and compression), ~3 s -- and the profile it needs is a
 * 173-byte package.json with an empty dependency list, so nothing is downloaded.
 *
 * What this wrapper adds on top
 * -----------------------------
 *   - connection multiplexing, so the ~9.5 KB SSH handshake is paid once per
 *     ControlPersist window instead of once per command (warm cost ~1.1 KB);
 *   - compression on the connection that actually carries the data, i.e. the
 *     master -- putting -C on an individual invocation does nothing;
 *   - keepalive/timeouts tuned for a high-latency tunnel, and attempts that are
 *     BOUNDED: waiting only on 'close' can outlive the timeout, because a forked
 *     ControlPersist master may hold the stdio pipes past the child's death;
 *   - a start-marker gate for retries. A one-shot task is not idempotent, so a
 *     retry could execute the instruction twice. The remote shell records that it
 *     began before launching dsh, and that file -- not ssh's stderr, which is
 *     silent under mux -- decides whether a retry is safe;
 *   - `--detach` / `--status` / `--collect` for tasks too long to hold one
 *     connection, since a dropped link also SIGHUPs the session and kills dsh;
 *   - `--cwd` that FAILS (exit 90) when the directory is missing, rather than
 *     silently running the task in the remote home directory;
 *   - `--measure` and `--shim-*`, which route the run through net-shim for exact
 *     wire bytes and on-demand link degradation.
 *
 * Usage
 *   node scripts/dsh21.mjs "list the files in ~/data and summarise them"
 *   node scripts/dsh21.mjs --measure "print the hostname"
 *   node scripts/dsh21.mjs --probe
 *
 * Full background and measurements: docs/dgx21-lowbandwidth-channel.md
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHIM = path.join(HERE, 'soak', 'net-shim.mjs');

/**
 * Exit code used when the requested remote working directory does not exist.
 * A bad --cwd must abort the task, not quietly run it somewhere else: the whole
 * point of --cwd is that commands like `make -j4` run in the right place.
 */
const EXIT_BAD_CWD = 90;

/**
 * Pass '--' before the host on every ssh invocation.
 *
 * ssh parses a leading-dash argument in host position as its OWN option, so a
 * host value like "-oProxyCommand=..." is consumed as configuration rather than
 * a hostname. Verified: without the separator ssh applied that ProxyCommand;
 * with it, the value is treated as a (rejected) hostname. The host normally
 * comes from the caller, but making the position unambiguous costs nothing.
 */
/** Remote directory holding per-invocation start/finish markers. */
const MARKER_DIR = '$HOME/.dsh21/state';
const markerPath = (token) => `${MARKER_DIR}/${token}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Piping into `head`/`sed` is normal usage; closing our stdout early must not
// crash the tool with an unhandled EPIPE.
process.stdout.on('error', (err) => {
  if (err && err.code === 'EPIPE') process.exit(0);
});


const USAGE = `dsh21 — one-shot instruction channel to a remote dsh over a thin link

Usage: node scripts/dsh21.mjs [options] <task...>

Options:
  --host H              ssh host alias                        (default dgx21.tun)
  --profile P           remote dsh profile                    (default headless)
  --cwd DIR             remote working directory (cd first)    (default: remote home)
  --timeout S           overall wall-clock budget, seconds     (default 900)
  --attempts N          retries for pre-execution failures     (default 3)
  --no-mux              one fresh SSH connection per command
  --control-path PATH   share an existing mux master at PATH (instead of the
                        default per-host socket)
  --mux-persist S       ControlPersist seconds                 (default 600)
  --keep-forwardings    honour RemoteForward from ~/.ssh/config
  --retry-started       also retry failures after the task provably began
                        (only for idempotent tasks -- may double-execute)
  --require-verified    only retry when the remote marker PROVES nothing started
                        (strict; may refuse to retry on a dead link)
  --measure             route through net-shim and report wire bytes
  --shim-rate-kbps N    cap the link at N KILOBITS/s (implies --measure)
  --shim-rate-kbyte N   cap the link at N KILOBYTES/s (implies --measure)
  --shim-latency-ms N   add connect latency               (implies --measure)
  --shim-jitter-ms N    add random connect jitter          (implies --measure)
  --shim-reset-pct N    reset N% of connections mid-flight (implies --measure)
  --shim-reset-after-ms N  ...at least N ms into the connection (default 700)
  --shim-stall-pct N    stall N% of connections            (implies --measure)
  --shim-stall-ms N     stall duration (default 1000)
  --detach              start the task detached; print a run id and return at once
                        (survives the connection dropping -- use for long tasks)
  --status ID           one-shot check on a detached run (no waiting)
  --collect ID          wait for a detached run and print its answer
  --poll-ms N           initial poll interval for --collect  (default 10000)
  --max-poll-ms N       cap the interval after backoff       (default 60000)
  --probe               report link health (no LLM call) and exit
  --dry-run             print the ssh argv instead of running it
  --json                emit a JSON result record
  -h, --help            this help

Exit codes: 0 task completed · 1 task failed · 2 usage error · 3 link unreachable
`;

function parseArgs(argv) {
  const o = {
    host: 'dgx21.tun',
    profile: 'headless',
    cwd: '',
    timeout: 900,
    attempts: 3,
    mux: true,
    muxPersist: 600,
    keepForwardings: false,
    retryStarted: false,
    requireVerified: false,
    controlPath: '',
    measure: false,
    probe: false,
    detach: false,
    collect: '',
    status: '',
    pollMs: 10000,
    maxPollMs: 60000,
    dryRun: false,
    json: false,
    shim: { rateKbps: 0, rateKbyte: 0, latencyMs: 0, jitterMs: 0, resetPct: 0, resetAfterMs: 700, stallPct: 0, stallMs: 1000 },
    task: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${a} needs a value`);
      i++;
      return v;
    };
    switch (a) {
      case '--host': o.host = val(); break;
      case '--profile': o.profile = val(); break;
      case '--cwd': o.cwd = val(); break;
      case '--timeout': o.timeout = Number(val()); break;
      case '--attempts': o.attempts = Number(val()); break;
      case '--no-mux': o.mux = false; break;
      case '--mux-persist': o.muxPersist = Number(val()); break;
      case '--keep-forwardings': o.keepForwardings = true; break;
      case '--retry-started': o.retryStarted = true; break;
      case '--require-verified': o.requireVerified = true; break;
      case '--control-path': o.controlPath = val(); break;
      case '--measure': o.measure = true; break;
      case '--shim-rate-kbps': o.shim.rateKbps = Number(val()); o.measure = true; break;
      case '--shim-rate-kbyte': o.shim.rateKbyte = Number(val()); o.measure = true; break;
      case '--shim-latency-ms': o.shim.latencyMs = Number(val()); o.measure = true; break;
      case '--shim-jitter-ms': o.shim.jitterMs = Number(val()); o.measure = true; break;
      case '--shim-reset-pct': o.shim.resetPct = Number(val()); o.measure = true; break;
      case '--shim-reset-after-ms': o.shim.resetAfterMs = Number(val()); o.measure = true; break;
      case '--shim-stall-pct': o.shim.stallPct = Number(val()); o.measure = true; break;
      case '--shim-stall-ms': o.shim.stallMs = Number(val()); o.measure = true; break;
      case '--probe': o.probe = true; break;
      case '--detach': o.detach = true; break;
      case '--collect': o.collect = val(); break;
      case '--status': o.status = val(); break;
      case '--poll-ms': o.pollMs = Number(val()); break;
      case '--max-poll-ms': o.maxPollMs = Number(val()); break;
      case '--dry-run': o.dryRun = true; break;
      case '--json': o.json = true; break;
      case '-h': case '--help': process.stdout.write(USAGE); process.exit(0); break;
      default:
        if (a.startsWith('--')) throw new Error(`unknown option: ${a}`);
        o.task.push(a);
    }
  }
  return o;
}

/** POSIX single-quote a string so the remote shell receives it verbatim. */
function shq(s) {
  return `'${String(s).replaceAll("'", "'\\''")}'`;
}

/** Strip ssh's own chatter so real stderr stays readable. */
function visibleStderr(text) {
  return String(text)
    .split('\n')
    .filter((l) => l
      && !/^debug\d+:/.test(l)
      && !/^Authenticated to /.test(l)
      // ssh's own -v byte summary: --measure reports this more precisely, and two
      // different numbers in one output only invite doubt.
      && !/^Transferred: sent /.test(l)
      && !/^Bytes per second: /.test(l)
      && !/^Connection to .*closed\.?$/.test(l))
    .join('\n')
    .trim();
}

/**
 * Did this ssh invocation ever get past authentication?
 *
 * Secondary signal only, and NOT sufficient on its own. With connection
 * multiplexing enabled (our default) a reused master performs no handshake at
 * all: ssh prints neither "Authenticated to" nor even "Sending command", and the
 * master keeps writing its debug lines to whichever stderr created it. So this
 * can help confirm "nothing ran"; it can never establish "something ran".
 *
 * NOTE: unlike the rest of ssh's verbose output, the auth line carries NO
 * "debug1: " prefix (verified against OpenSSH 10.2). Matching on the prefix once
 * made this report "never authenticated" even for a clean run.
 */
function everAuthenticated(stderr) {
  return /Authenticated to /.test(stderr);
}

/**
 * Ask the remote host whether this invocation's marker exists.
 *
 * This is the authoritative answer to "did the instruction already start?", and
 * it is transport independent: the remote shell writes the marker to disk before
 * launching dsh, so it survives however the connection died.
 *
 * @returns true started · false provably not started · null undeterminable
 */
async function remoteStarted(o, token) {
  const argv = [
    'ssh',
    ...baseSshArgs(o, { controlPath: o.mux ? ctrl(o) : '', compress: true }),
    '--',
    o.host,
    // Read then remove: a marker is single-use, so a later run cannot be fooled
    // by a stale one.
    `M=${markerPath(token)}; if [ -f "$M" ]; then cat "$M"; rm -f "$M"; else echo NONE; fi`,
  ];
  // The probe is idempotent and cheap, so a flaky link must not turn "safe to
  // retry" into "refuse to retry" on its first dropped packet.
  for (let i = 0; i < 3; i++) {
    const r = await runAttempt({ ...o, timeout: 60 }, argv);
    if (r.code === 0) {
      const out = r.stdout.trim();
      if (out === 'NONE' || out === '') return false;
      return /started/.test(out);
    }
    await sleep(1000 * (i + 1));
  }
  return null;
}

/**
 * Failures that can only happen before the remote command runs. Anything else
 * (a drop mid-task) is ambiguous for a non-idempotent one-shot and must not be
 * retried automatically.
 */
const PRE_EXEC_PATTERNS = [
  /Connection closed by .* port \d+/,
  /Connection reset by peer/,
  /kex_exchange_identification/,
  /connect to host .* (?:Operation timed out|Connection timed out|No route to host|Connection refused)/,
  /Timeout, server .* not responding/,
  /Could not resolve hostname/,
  /Control socket connect/,
  /mux_client_connect/,
  /^ssh: connect /m,
  /Network is unreachable/,
];

function classifyFailure(stderr, stdoutWasEmpty) {
  if (!stdoutWasEmpty) return { phase: 'mid-run', retryable: false };
  // The decisive test: if ssh never authenticated, the remote command could not
  // have started, so a retry cannot double-execute it.
  if (!everAuthenticated(stderr)) {
    return { phase: 'pre-exec', retryable: true };
  }
  for (const re of PRE_EXEC_PATTERNS) {
    if (re.test(stderr)) return { phase: 'post-auth-unclear', retryable: false };
  }
  return { phase: 'ambiguous', retryable: false };
}

/** Runtime dir for control sockets — private, 0700, never /tmp. */
function runtimeDir() {
  const dir = process.env.DSH21_DIR
    || path.join(process.env.XDG_RUNTIME_DIR || path.join(os.homedir(), '.dsh'), 'dsh21');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function baseSshArgs(o, { controlPath, compress }) {
  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=20',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=4',
    '-o', 'TCPKeepAlive=yes',
    // -v is how classifyFailure proves whether the remote command could have run.
    '-v',
    // Compression must sit on the connection that carries the bytes. With mux
    // that is the master, so -C belongs here, not on an individual tunnel argv.
    `-o`, `Compression=${compress ? 'yes' : 'no'}`,
  ];
  if (!o.keepForwardings) args.push('-o', 'ClearAllForwardings=yes');
  if (controlPath) {
    args.push(
      '-o', 'ControlMaster=auto',
      '-o', `ControlPath=${controlPath}`,
      '-o', `ControlPersist=${o.muxPersist}`,
    );
  } else {
    args.push('-o', 'ControlMaster=no');
  }
  return args;
}

/**
 * Remote PATH setup, shared by every remote command this tool runs.
 *
 * dsh is usually NOT on the default non-interactive PATH: an nvm install or a
 * node bump relocates it. c4g.tun is a live example -- dsh sits at
 * ~/.nvm/versions/node/v24.15.0/bin/dsh, so a ~/.local-only PATH reports
 * "command not found" on a host where dsh works fine.
 *
 * Shape notes (both were wrong in the first attempt at this):
 *   · A plain assignment does NOT glob. Writing the nvm dir as a bare assignment
 *     leaves a literal star in PATH and silently matches nothing; pathname
 *     expansion happens in a word list, hence the `for d in ...` form below.
 *   · `[ -d "$d" ] || continue` disposes of the unmatched-glob case, and the
 *     `case ":$PATH:"` check keeps a directory from being added twice.
 * This mirrors the pattern already proven in src/control/remote.js.
 */
/**
 * Make an unmatched glob harmless on zsh.
 *
 * zsh's default `nomatch` treats a failed glob as a FATAL error and aborts the
 * rest of the command line -- so the PATH loop below would kill everything after
 * it, including the `dsh` invocation itself. On such a host the channel does not
 * degrade, it fails outright. Verified against cms.tun: a loop over a nonexistent
 * nvm path followed by a trailing echo never reaches that echo at all.
 *
 * bash has no `unsetopt`, and the ZSH_VERSION test keeps this a no-op there.
 *
 * (Careful editing this file: a literal glob-star-slash sequence inside a block
 * comment closes the comment early and yields a baffling syntax error. Two stars
 * and a slash in prose is a trap, so write the path as "$HOME/.nvm/versions/node/"
 * plus a star, or spell it out.)
 */
const ZSH_GLOB_GUARD = '[ -n "${ZSH_VERSION:-}" ] && unsetopt nomatch 2>/dev/null;';

const REMOTE_PATH_SETUP = ZSH_GLOB_GUARD + ' for d in "$HOME/.nvm/versions/node/"*/bin "$HOME/.npm-global/bin" '
  + '"$HOME/.local/bin" "$HOME/.local/node/bin" "$HOME/bin" "/usr/local/bin"; do '
  + '[ -d "$d" ] || continue; '
  + 'case ":$PATH:" in *":$d:"*) ;; *) PATH="$d:$PATH";; esac; done';

/** Env prefix + command string executed on the remote host. */
function remoteCommand(o, task, token = '') {
  const parts = [
    REMOTE_PATH_SETUP,
    'export PATH',
    // A stale 127.0.0.1:7897 reverse-forward is a trap: if the local proxy behind
    // it is down, anything that honours these vars hangs or fails instantly.
    // Non-interactive ssh does not source ~/.bashrc, so we assert the clean state.
    'unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy',
  ];
  if (o.cwd) {
    parts.push(`cd ${shq(o.cwd)} 2>/dev/null || { printf 'dsh21: remote cwd does not exist: %s\\n' ${shq(o.cwd)} >&2; exit ${EXIT_BAD_CWD}; }`);
  }

  if (!token) {
    parts.push(`exec dsh --profile ${shq(o.profile)} -- ${shq(task)}`);
    return parts.join('; ');
  }

  parts.push(`mkdir -p ${MARKER_DIR}`);
  // Bounded housekeeping: markers from crashed runs would otherwise accumulate.
  parts.push(`find ${MARKER_DIR} -type f -mtime +2 -delete 2>/dev/null || true`);
  parts.push(`echo started > ${markerPath(token)}`);
  // No `exec`: the shell must outlive dsh to record the outcome, and must still
  // exit with dsh's own code so the caller sees task success/failure.
  parts.push(`dsh --profile ${shq(o.profile)} -- ${shq(task)}`);
  parts.push('__rc=$?');
  parts.push(`printf 'finished %s\\n' "$__rc" >> ${markerPath(token)}`);
  parts.push('exit $__rc');
  return parts.join('; ');
}

/**
 * Run one attempt. Returns { code, stdout, stderr, ms, timedOut }.
 *
 * Never waits on `close` alone. `close` fires only once every holder of the stdio
 * pipes has released them, and ssh hands its pipes to a forked ControlPersist
 * master: kill the ssh client mid-handshake and that master can hold the pipes
 * open long past the child's death, so a close-only implementation overruns its
 * own timeout and reports nothing. (Seen as a 200s stall against c4g.tun on a
 * deadline that should have fired at 120s.)
 *
 * So it settles on `exit` after a brief grace to drain buffered output, and
 * settles unconditionally once the kill deadline passes. A late result is still
 * useful; one that never arrives is not.
 */
function runAttempt(o, argv) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let kill;
    let grace;

    const settle = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(kill);
      clearTimeout(grace);
      resolve({ code, stdout, stderr, ms: Date.now() - t0, timedOut });
    };

    kill = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, 2000);
      // Hard bound: whatever the pipes do, this attempt ends.
      setTimeout(() => settle(255), 5000);
    }, Math.min(o.timeout * 1000, 2_147_483_000));

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      stderr += String(err.message);
      settle(127);
    });
    child.on('exit', (code) => {
      // The process is gone; drain what is buffered, then stop caring about pipes.
      grace = setTimeout(() => settle(code ?? 255), 300);
    });
    child.on('close', (code) => settle(code ?? 255));
  });
}

/** Ask an existing master to shut down so a retry starts from a clean socket. */
function dropMaster(controlPath, host) {
  if (!controlPath) return;
  spawnSync('ssh', ['-o', `ControlPath=${controlPath}`, '-O', 'exit', host], { stdio: 'ignore' });
  try { fs.rmSync(controlPath, { force: true }); } catch { /* best effort */ }
}

function probeCommand() {
  return `${REMOTE_PATH_SETUP}; export PATH; `
    + 'echo "user=$(whoami) host=$(hostname)"; '
    + 'echo "dsh=$(dsh --version 2>&1 | head -1)"; '
    + 'ls -d $HOME/.dsh/profiles/headless >/dev/null 2>&1 && echo "headless_profile=present" || echo "headless_profile=MISSING"; '
    + 'echo "nproc=$(nproc)"; '
    + 'echo "mem_gb=$(free -g | awk \'/^Mem:/{print $2}\')"; '
    + 'echo "load1=$(cut -d" " -f1 /proc/loadavg)"';
}

async function probe(o) {
  const out = { host: o.host, ok: false, rttMs: 0, remote: {}, error: '' };
  const argv = ['ssh', ...baseSshArgs(o, { controlPath: o.mux ? ctrl(o) : '', compress: true }), '--', o.host, probeCommand()];
  const t0 = Date.now();
  const r = await runAttempt({ ...o, timeout: Math.min(o.timeout, 120) }, argv);
  out.rttMs = Date.now() - t0;
  out.ok = r.code === 0;
  out.error = r.code === 0 ? '' : visibleStderr(r.stderr).split('\n').slice(-2).join(' | ');
  for (const line of r.stdout.split('\n')) {
    const m = /^(\w+)=(.*)$/.exec(line.trim());
    if (m) out.remote[m[1]] = m[2];
  }
  return out;
}

function ctrl(o) {
  // %C is a hash of host/port/user, so one socket file per host, kept short.
  return path.join(runtimeDir(), `cm-${o.host.replace(/[^\w.-]/g, '_')}-%C`);
}

/**
 * Shim stats files are written once per attempt and were accumulating without
 * bound (41 of them after a single evening). Drop yesterday's on startup; the
 * current run's own files are removed as soon as they have been read.
 */
function pruneMeasureFiles() {
  try {
    const dir = runtimeDir();
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(dir)) {
      if (!/^measure-\d+(-a\d+)?\.json$/.test(name)) continue;
      const file = path.join(dir, name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
      } catch { /* raced with another run; harmless */ }
    }
  } catch { /* runtime dir unreadable: not worth failing the task over */ }
}


/** Remote directory holding detached runs. */
const RUNS_DIR = '$HOME/.dsh21/runs';
const runPaths = (id) => ({
  script: `${RUNS_DIR}/${id}.sh`,
  log: `${RUNS_DIR}/${id}.log`,
  done: `${RUNS_DIR}/${id}.done`,
});

/**
 * Build the remote command that launches a task DETACHED from this ssh session.
 *
 * The synchronous path holds one ssh connection open for the whole task, so a
 * drop mid-run loses everything -- and sshd also SIGHUPs the session's process
 * group, killing dsh itself. On a link that drops (the whole reason this tool
 * exists) that makes any long instruction unreliable.
 *
 * So the work is written to a runner script and started under setsid, with all
 * of its stdio pointed at files. ssh then returns immediately and the task
 * outlives it. Verified on dgx21: connection closed, job still finished 12s
 * later and left its exit code behind.
 *
 * The runner is delivered through a quoted heredoc whose delimiter is derived
 * from the (random, hex) run id. That removes every layer of nested quoting --
 * the task text is written verbatim by the remote shell, not re-parsed by it.
 */
function detachedCommand(o, task, id) {
  const { script, log, done } = runPaths(id);
  const marker = `DSH21_${id.toUpperCase()}`;
  const body = [
    '#!/bin/sh',
    REMOTE_PATH_SETUP,
    'export PATH',
    'unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy',
    ...(o.cwd ? [`cd ${shq(o.cwd)} 2>/dev/null || { printf 'dsh21: remote cwd does not exist: %s\\n' ${shq(o.cwd)} >&2; printf '%s\\n' ${EXIT_BAD_CWD} > ${done}; exit ${EXIT_BAD_CWD}; }`] : []),
    `dsh --profile ${shq(o.profile)} -- ${shq(task)}`,
    '__rc=$?',
    `printf '%s\\n' "$__rc" > ${done}`,
    'exit $__rc',
  ].join('\n');

  return [
    `mkdir -p ${RUNS_DIR}`,
    // Bounded housekeeping, same idea as the markers directory.
    `find ${RUNS_DIR} -type f -mtime +2 -delete 2>/dev/null || true`,
    `rm -f ${script} ${log} ${done}`,
    `cat > ${script} <<'${marker}'`,
    body,
    marker,
    `chmod +x ${script}`,
    // setsid preferred (new session, immune to the session SIGHUP); nohup is the
    // fallback for hosts without it.
    `if command -v setsid >/dev/null 2>&1; then setsid ${script} > ${log} 2>&1 < /dev/null &`
      + ` else nohup ${script} > ${log} 2>&1 < /dev/null & fi`,
    `echo "dsh21-started ${id}"`,
  ].join('\n');
}

/**
 * Control socket to use, or '' for a fresh connection.
 *
 * Measurement forces a fresh connection on purpose: an invocation that reuses an
 * existing master never touches its own ProxyCommand, so the shim would sit
 * unused and report nothing -- leaving --measure silently empty rather than
 * wrong-looking.
 */
function muxPath(o) {
  if (!o.mux || o.measure) return '';
  return o.controlPath || ctrl(o);
}

/** Shim injection flags for the current options. */
function shimFlags(o) {
  const flags = [];
  if (o.shim.rateKbyte) flags.push('--rate-kbyte', String(o.shim.rateKbyte));
  else if (o.shim.rateKbps) flags.push('--rate-kbps', String(o.shim.rateKbps));
  if (o.shim.latencyMs) flags.push('--latency-ms', String(o.shim.latencyMs));
  if (o.shim.jitterMs) flags.push('--jitter-ms', String(o.shim.jitterMs));
  if (o.shim.resetPct) flags.push('--reset-pct', String(o.shim.resetPct), '--reset-after-ms', String(o.shim.resetAfterMs));
  if (o.shim.stallPct) flags.push('--stall-pct', String(o.shim.stallPct), '--stall-ms', String(o.shim.stallMs));
  return flags.map(shq).join(' ');
}

/**
 * Route an ssh invocation through net-shim when measurement or degradation is on.
 *
 * Shared by EVERY path. It used to be wired only into the synchronous call, so
 * `--measure`/`--shim-*` silently did nothing for --status, --collect and
 * --detach -- which made both the byte cost and the fault tolerance of those
 * paths unmeasurable, and left a claim in the docs that nothing could check.
 */
function addShim(o, sshArgs, shimStats, label) {
  if (!o.measure) return sshArgs;
  const sp = path.join(runtimeDir(), `measure-${process.pid}-${label}.json`);
  shimStats.push(sp);
  fs.rmSync(sp, { force: true });
  const flags = shimFlags(o);
  sshArgs.push(
    '-o',
    `ProxyCommand=node ${shq(SHIM)} --stdio --target %h:%p --stats ${shq(sp)} --quiet${flags ? ` ${flags}` : ''}`,
  );
  return sshArgs;
}

/** Total wire bytes across every shimmed connection of one operation. */
function sumShimStats(shimStats) {
  let up = 0;
  let down = 0;
  let conns = 0;
  let found = false;
  for (const sp of shimStats) {
    try {
      const j = JSON.parse(fs.readFileSync(sp, 'utf8'));
      up += j.bytesToRemote;
      down += j.bytesFromRemote;
      conns += j.connections;
      found = true;
    } catch { /* that connection never got as far as writing stats */ }
    try { fs.rmSync(sp, { force: true }); } catch { /* already gone */ }
  }
  return found ? { toRemote: up, fromRemote: down, total: up + down, connections: conns } : null;
}

/** One stateless round trip: is the run finished, and what has it produced? */
function fetchCommand(id) {
  const { log, done } = runPaths(id);
  return [
    `D=${done}`,
    `L=${log}`,
    // "running" and "never existed" look identical without this, which made a
    // typo'd run id report "still running" forever.
    'if [ -f "$D" ] || [ -f "$L" ]; then echo "EXISTS=yes"; else echo "EXISTS=no"; fi',
    'if [ -f "$D" ]; then echo "STATE=done"; printf \'RC=%s\\n\' "$(cat "$D")";'
      + ' else echo "STATE=running"; fi',
    'if [ -f "$L" ]; then echo "LOG_BEGIN"; tail -c 200000 "$L"; echo; echo "LOG_END"; fi',
  ].join('; ');
}

/**
 * Parse a fetchCommand reply. Pure so it can be tested without a host.
 * @returns { state: 'done'|'running'|'unknown', rc: number|null, log: string }
 */
function parseFetch(stdout) {
  const state = /STATE=(\w+)/.exec(stdout)?.[1] ?? 'unknown';
  const rcRaw = /^RC=(.*)$/m.exec(stdout)?.[1]?.trim();
  const rc = rcRaw && /^\d+$/.test(rcRaw) ? Number(rcRaw) : null;
  const logMatch = /LOG_BEGIN\n([\s\S]*?)\n?LOG_END/.exec(stdout);
  const existsRaw = /EXISTS=(\w+)/.exec(stdout)?.[1];
  return { state, rc, log: logMatch ? logMatch[1] : '', exists: existsRaw === undefined ? null : existsRaw === 'yes' };
}

/**
 * Next poll interval after a miss: back off by 1.5x, capped.
 * Pure so the policy can be tested without a host.
 */
function nextPollInterval(currentMs, maxMs) {
  const grown = Math.round(currentMs * 1.5);
  return Math.max(currentMs, Math.min(grown, maxMs));
}

/** Poll a detached run until it finishes or the budget runs out. */
async function collectRun(o, id, shimStats = []) {
  const deadline = Date.now() + o.timeout * 1000;
  let last = { state: 'unknown', rc: null, log: '' };
  let polls = 0;
  let misses = 0;
  // Count poll failures explicitly. Without this, a run that survived a bad link
  // looks identical to one that never encountered one, so the resilience claim
  // would rest on an untested premise.
  let failedPolls = 0;
  // Polling costs real bytes: measured ~1.1 KB per warm poll. A fixed short
  // interval therefore makes the cost grow with the task's DURATION -- a 20
  // minute task at 10s would spend ~120 polls / ~132 KB, 13x the synchronous
  // path, on a link where bytes are the scarce resource. Back off instead:
  // early polls (when a short task is likely to finish) stay responsive, and
  // long tasks settle onto a cheap steady cadence.
  let interval = o.pollMs;
  for (;;) {
    polls++;
    const argv = [
      'ssh',
      ...addShim(o, baseSshArgs(o, { controlPath: muxPath(o), compress: true }), shimStats, `p${polls}`),
      '--',
      o.host,
      fetchCommand(id),
    ];
    const r = await runAttempt({ ...o, timeout: Math.min(o.timeout, 60) }, argv);
    if (r.code === 0) {
      last = parseFetch(r.stdout);
      if (last.state === 'done') return { ...last, ok: true, polls, failedPolls };
      // Three consecutive definite misses means a bad id, not a slow start.
      if (last.exists === false) {
        misses++;
        if (misses >= 3) return { ...last, ok: false, polls, failedPolls, state: 'no-such-run' };
      } else misses = 0;
    } else {
      // A failed poll is expected on a bad link; keep trying until the deadline.
      failedPolls++;
      last = { ...last, state: last.state === 'unknown' ? 'unreachable' : last.state };
    }
    if (Date.now() >= deadline) return { ...last, ok: false, polls, failedPolls, timedOut: true };
    await sleep(interval);
    interval = nextPollInterval(interval, o.maxPollMs);
  }
}

async function main() {
  pruneMeasureFiles();
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`dsh21: ${err.message}\n\n${USAGE}`);
    process.exit(2);
  }

  // --dry-run must be honoured before ANY branch with a side effect. It used to
  // sit after the detach branch, so `--dry-run --detach` really did launch a task.
  if (o.dryRun) {
    const runId = o.collect || o.status;
    const task = o.task.join(' ').trim();
    let cmd;
    if (runId) cmd = fetchCommand(runId);
    else if (o.probe) cmd = probeCommand();
    else if (!task) {
      process.stderr.write(`dsh21: no task given\n\n${USAGE}`);
      process.exit(2);
    } else if (o.detach) cmd = detachedCommand(o, task, 'dryrun000000');
    else cmd = remoteCommand(o, task, 'dryrun000000');
    const argv = [
      'ssh',
      ...baseSshArgs(o, { controlPath: o.mux ? ctrl(o) : '', compress: true }),
      '--',
      o.host,
      cmd,
    ];
    process.stdout.write(argv.map((a) => (a.includes(' ') || a.includes('\n') ? shq(a) : a)).join(' ') + '\n');
    process.exit(0);
  }

  if (o.probe) {
    const p = await probe(o);
    if (o.json) process.stdout.write(JSON.stringify(p, null, 2) + '\n');
    else {
      process.stdout.write(`host        ${p.host}\n`);
      process.stdout.write(`reachable   ${p.ok ? 'yes' : 'NO'}  (${p.rttMs} ms)\n`);
      for (const [k, v] of Object.entries(p.remote)) process.stdout.write(`${k.padEnd(11)} ${v}\n`);
      if (!p.ok) process.stdout.write(`error       ${p.error}\n`);
    }
    process.exit(p.ok ? 0 : 3);
  }

  // --- detached runs: status / collect / start -------------------------------
  const runId = o.collect || o.status;
  if (runId) {
    if (!/^[0-9a-f]{8,}$/.test(runId)) {
      process.stderr.write('dsh21: run id must be the hex string printed by --detach\n');
      process.exit(2);
    }
    if (o.status) {
      const shimStats = [];
      const argv = [
        'ssh',
        ...addShim(o, baseSshArgs(o, { controlPath: muxPath(o), compress: true }), shimStats, 'status'),
        '--',
        o.host,
        fetchCommand(runId),
      ];
      const r = await runAttempt({ ...o, timeout: Math.min(o.timeout, 60) }, argv);
      const statusWire = sumShimStats(shimStats);
      if (r.code !== 0) {
        process.stderr.write(`dsh21: cannot reach ${o.host}\n`);
        if (visibleStderr(r.stderr)) process.stderr.write(visibleStderr(r.stderr) + '\n');
        process.exit(3);
      }
      const st = parseFetch(r.stdout);
      if (o.json) process.stdout.write(JSON.stringify({ id: runId, ...st, wire: statusWire }, null, 2) + '\n');
      else {
        const label = st.exists === false ? 'no such run (never started, or pruned)' : st.state;
        process.stdout.write(`run ${runId}: ${label}${st.rc === null ? '' : ` (rc ${st.rc})`}\n`);
        if (st.log.trim()) process.stdout.write(st.log.trim() + '\n');
        if (statusWire) process.stderr.write(`dsh21: status wire ${statusWire.total} B\n`);
      }
      process.exit(0);
    }
    const collectStats = [];
    const res = await collectRun(o, runId, collectStats);
    const collectWire = sumShimStats(collectStats);
    if (o.json) process.stdout.write(JSON.stringify({ id: runId, ...res, wire: collectWire }, null, 2) + '\n');
    else {
      if (res.log.trim()) process.stdout.write(res.log.trim() + '\n');
      if (collectWire) {
        process.stderr.write(`dsh21: collect wire ${collectWire.total} B over ${collectWire.connections} connection(s)\n`);
      }
      if (res.failedPolls) {
        process.stderr.write(`dsh21: survived ${res.failedPolls} failed poll(s) out of ${res.polls}\n`);
      }
      if (!res.ok) {
        process.stderr.write(res.state === 'no-such-run'
          ? `dsh21: no run ${runId} on ${o.host} (never started, or pruned after 2 days)\n`
          : `dsh21: run ${runId} still ${res.state} after ${o.timeout}s (${res.polls} polls)\n`);
      }
    }
    process.exit(res.ok && res.rc === 0 ? 0 : 1);
  }

  const task = o.task.join(' ').trim();
  if (!task) {
    process.stderr.write(`dsh21: no task given\n\n${USAGE}`);
    process.exit(2);
  }

  if (o.detach) {
    const id = randomBytes(6).toString('hex');
    const detachStats = [];
    const argv = [
      'ssh',
      ...addShim(o, baseSshArgs(o, { controlPath: muxPath(o), compress: true }), detachStats, 'detach'),
      '--',
      o.host,
      detachedCommand(o, task, id),
    ];
    const r = await runAttempt(o, argv);
    const detachWire = sumShimStats(detachStats);
    // The launch is deliberately not retried: a second attempt could start the
    // task twice, and a dropped launch is recoverable by looking up the id.
    if (r.code !== 0 || !r.stdout.includes(`dsh21-started ${id}`)) {
      process.stderr.write(`dsh21: detached launch failed (exit ${r.code})\n`);
      if (visibleStderr(r.stderr)) process.stderr.write(visibleStderr(r.stderr) + '\n');
      process.stderr.write(`dsh21: to see whether it did start: --status ${id}\n`);
      if (o.json) process.stdout.write(JSON.stringify({ id, started: false, exitCode: r.code }, null, 2) + '\n');
      process.exit(1);
    }
    if (o.json) process.stdout.write(JSON.stringify({ id, started: true, host: o.host, wire: detachWire }, null, 2) + '\n');
    else {
      process.stdout.write(`${id}\n`);
      process.stderr.write(`dsh21: started detached; collect with: --collect ${id}\n`);
      if (detachWire) process.stderr.write(`dsh21: launch wire ${detachWire.total} B\n`);
    }
    process.exit(0);
  }

  const token = randomBytes(6).toString('hex');
  const controlPath = muxPath(o);
  const shimStats = [];

  // Each attempt needs its own shim (and stats file): a retry after a mid-flight
  // reset must not overwrite the bytes the failed attempt already spent.
  const buildArgv = (attempt) => [
    'ssh',
    ...addShim(o, baseSshArgs(o, { controlPath, compress: true }), shimStats, `a${attempt}`),
    '--',
    o.host,
    remoteCommand(o, task, token),
  ];

  let last;
  let attemptsUsed = 0;
  let remoteStart = 'not-checked';
  const t0 = Date.now();
  for (let attempt = 1; attempt <= Math.max(1, o.attempts); attempt++) {
    attemptsUsed = attempt;
    last = await runAttempt(o, buildArgv(attempt));
    if (last.code === 0) break;

    // A deterministic setup error is not a link failure: retrying it just
    // repeats the same mistake and muddies the phase label.
    if (last.code === EXIT_BAD_CWD) {
      last.phase = 'bad-cwd';
      break;
    }

    const verdict = classifyFailure(last.stderr, last.stdout.length === 0);
    last.phase = verdict.phase;
    if (attempt >= o.attempts) break;

    // Never decide this from ssh's stderr: under mux a reused master is silent,
    // so the only trustworthy source is the remote marker the task itself wrote.
    const started = verdict.phase === 'mid-run' ? true : await remoteStarted(o, token);
    remoteStart = started === null ? 'unknown' : String(started);
    const proceed = verdict.phase === 'mid-run'
      ? o.retryStarted
      : (started === false || (started === null && verdict.retryable && !o.requireVerified));
    if (!proceed) {
      last.phase = started === true ? 'started-remote'
        : (started === null ? 'unverified' : verdict.phase);
      break;
    }
    process.stderr.write(
      `dsh21: attempt ${attempt} failed before the remote task started`
      + ` (${verdict.phase}${started === false ? ', marker absent' : ', unverified'});`
      + ` reconnecting in ${attempt * 2}s\n`,
    );
    if (controlPath) dropMaster(controlPath, o.host);
    await sleep(attempt * 2000);
  }

  let bytes = null;
  if (o.measure) {
    await sleep(200);
    bytes = sumShimStats(shimStats);
  }

  const record = {
    host: o.host,
    ok: last.code === 0,
    exitCode: last.code,
    ms: last.ms,
    totalMs: Date.now() - t0,
    attemptsUsed,
    authenticated: everAuthenticated(last.stderr),
    remoteStarted: remoteStart,
    timedOut: !!last.timedOut,
    phase: last.phase ?? (last.code === 0 ? 'done' : 'run'),
    answer: last.stdout.trim(),
    // Carry the failure reason in the machine-readable record. Without it, a
    // consumer like the soak harness can only scrape stderr, and what it scrapes
    // is this tool's own retry chatter rather than the underlying cause.
    error: visibleStderr(last.stderr).split('\n').filter((l) => l && !/^dsh21: attempt /.test(l)).join(' | '),
    wire: bytes ? { toRemote: bytes.toRemote, fromRemote: bytes.fromRemote, total: bytes.total, connections: bytes.connections } : null,
  };

  if (o.json) process.stdout.write(JSON.stringify(record, null, 2) + '\n');
  else {
    if (record.answer) process.stdout.write(record.answer + '\n');
    if (visibleStderr(last.stderr)) process.stderr.write(visibleStderr(last.stderr) + '\n');
    if (o.measure && record.wire) {
      process.stderr.write(`dsh21: wire ${record.wire.total} B total (${record.wire.toRemote} up / ${record.wire.fromRemote} down), ${last.ms} ms\n`);
    }
  }

  if (last.code !== 0 && !o.json) {
    process.stderr.write(`dsh21: task failed (exit ${last.code}, phase ${record.phase})\n`);
  }
  process.exit(last.code === 0 ? 0 : 1);
}

export {
  classifyFailure, everAuthenticated, visibleStderr, parseArgs, shq,
  remoteCommand, markerPath, MARKER_DIR, PRE_EXEC_PATTERNS, REMOTE_PATH_SETUP, runAttempt,
  detachedCommand, fetchCommand, parseFetch, runPaths, addShim, sumShimStats, shimFlags, muxPath,
  nextPollInterval, EXIT_BAD_CWD,
};

// Only run when invoked as a CLI: importing this file (tests) must not execute ssh.
const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`dsh21: ${err.stack || err.message}\n`);
    process.exit(1);
  });
}
