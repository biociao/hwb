/**
 * Guard tests for scripts/dsh21.mjs — the low-bandwidth channel to a remote dsh.
 *
 * The retry logic exists because the dgx21.tun link drops connections during the
 * slow handshake. The risk it must not introduce: silently running a one-shot
 * instruction twice. These tests pin the rule that a retry happens ONLY when ssh
 * provably never authenticated, which is the only state in which the remote
 * command cannot have started.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  classifyFailure,
  everAuthenticated,
  visibleStderr,
  parseArgs,
  shq,
  remoteCommand,
  markerPath,
  MARKER_DIR,
  REMOTE_PATH_SETUP,
  runAttempt,
  detachedCommand,
  fetchCommand,
  nextPollInterval,
  EXIT_BAD_CWD,
  parseFetch,
  runPaths,
} from '../scripts/dsh21.mjs';

// Real shapes, captured from OpenSSH 10.2 against dgx21.tun.
const STDERR_AUTHED = [
  'OpenSSH_10.2p1, LibreSSL 3.3.6',
  'debug1: Reading configuration data /Users/ciao/.ssh/config',
  'debug1: Authenticating to 10.8.0.21:22 as \'bot\'',
  'Authenticated to 10.8.0.21 ([10.8.0.21]:22) using "publickey".',
  'debug1: Sending command: echo hi',
].join('\n');

const STDERR_HANDSHAKE_DROP = [
  'OpenSSH_10.2p1, LibreSSL 3.3.6',
  'debug1: Reading configuration data /Users/ciao/.ssh/config',
  'kex_exchange_identification: read: Connection reset by peer',
  'Connection closed by 10.8.0.21 port 22',
].join('\n');

test('the auth marker is matched despite carrying no debug prefix', () => {
  // Regression guard: an earlier version matched /debug1: Authenticated to / and
  // therefore reported "never authenticated" for successful runs too, which made
  // every failure look safe to retry.
  assert.equal(everAuthenticated(STDERR_AUTHED), true);
  assert.equal(everAuthenticated(STDERR_HANDSHAKE_DROP), false);
});

test('a failure before authentication is safe to retry', () => {
  const v = classifyFailure(STDERR_HANDSHAKE_DROP, true);
  assert.equal(v.phase, 'pre-exec');
  assert.equal(v.retryable, true);
});

test('a timeout before authentication is safe to retry', () => {
  const stderr = 'ssh: connect to host 10.8.0.21 port 22: Operation timed out';
  const v = classifyFailure(stderr, true);
  assert.equal(v.phase, 'pre-exec');
  assert.equal(v.retryable, true);
});

test('a failure after authentication is NOT retried', () => {
  // The command may have started, and a one-shot instruction is not idempotent.
  const stderr = `${STDERR_AUTHED}\nConnection to 10.8.0.21 closed by remote host.`;
  const v = classifyFailure(stderr, true);
  assert.equal(v.retryable, false);
  assert.notEqual(v.phase, 'pre-exec');
});

test('any stdout proves the task ran, so it is never retried', () => {
  const v = classifyFailure(STDERR_HANDSHAKE_DROP, false);
  assert.equal(v.phase, 'mid-run');
  assert.equal(v.retryable, false);
});

test('the auth line never leaks into user-visible stderr', () => {
  const visible = visibleStderr(STDERR_AUTHED);
  assert.equal(visible.includes('Authenticated to'), false);
  assert.equal(visible.includes('debug1:'), false);
});

test('real errors survive the stderr filter', () => {
  const visible = visibleStderr(STDERR_HANDSHAKE_DROP);
  assert.match(visible, /Connection closed by 10\.8\.0\.21 port 22/);
});

test('task text is shell-quoted, including single quotes', () => {
  assert.equal(shq('plain'), "'plain'");
  assert.equal(shq("it's here"), "'it'\\''s here'");
  assert.equal(shq('$(rm -rf /)'), "'$(rm -rf /)'");
});

test('a hostile task survives a real shell round-trip without being executed', () => {
  // The task text reaches the remote through ssh, which hands it to a shell.
  // This proves the quoting is injection-safe: substitutions and backticks must
  // come back as literal text rather than running.
  const marker = `M${Math.random().toString(36).slice(2)}`;
  const subst = `$(echo ${marker})`;
  const backtick = '`echo ' + marker + '`';
  const nasty = `a'b"c${subst}${backtick}; echo ${marker}\nnewline`;
  const out = execFileSync('bash', ['-c', `printf '%s' ${shq(nasty)}`], { encoding: 'utf8' });
  // Byte-exact round-trip: had either substitution run, the result would differ.
  assert.equal(out, nasty);
  // And the substitution syntax is still present as literal text.
  assert.equal(out.includes(subst), true);
  assert.equal(out.includes(backtick), true);
});

test('the remote command exports PATH, clears proxy traps and pins the profile', () => {
  const cmd = remoteCommand({ profile: 'headless', cwd: '' }, 'say hi');
  assert.equal(cmd.includes(REMOTE_PATH_SETUP), true);
  // A stale 127.0.0.1:7897 reverse-forward makes the remote hang if its local
  // proxy is dead, so the channel asserts a clean proxy state.
  assert.match(cmd, /unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy/);
  assert.match(cmd, /exec dsh --profile 'headless' -- 'say hi'/);
  assert.equal(cmd.includes('cd '), false);
});

test('--cwd changes directory before running the task', () => {
  const cmd = remoteCommand({ profile: 'headless', cwd: '/data/work' }, 'pwd');
  assert.match(cmd, /cd '\/data\/work' 2>\/dev\/null \|\|/);
});

test('parseArgs defaults are tuned for a thin link', () => {
  const o = parseArgs(['do', 'the', 'thing']);
  assert.equal(o.host, 'dgx21.tun');
  assert.equal(o.profile, 'headless');
  assert.equal(o.mux, true);
  assert.equal(o.attempts, 3);
  assert.equal(o.task.join(' '), 'do the thing');
});

test('degradation knobs imply byte measurement', () => {
  const o = parseArgs(['--shim-rate-kbps', '4', 'x']);
  assert.equal(o.shim.rateKbps, 4);
  assert.equal(o.measure, true);
});

test('unknown options are rejected rather than ignored', () => {
  // --shim-reset-after-ms was once accepted by the shim but not by this parser,
  // which silently degraded a degradation test into a usage error.
  assert.doesNotThrow(() => parseArgs(['--shim-reset-after-ms', '700', 'x']));
  assert.throws(() => parseArgs(['--nope', 'x']), /unknown option/);
});

// --- start-marker contract -------------------------------------------------
// The marker is the only trustworthy proof of "the instruction already began",
// so its shape is part of the safety guarantee, not an implementation detail.

test('without a token the task is exec-ed directly', () => {
  const cmd = remoteCommand({ profile: 'headless', cwd: '' }, 'x');
  assert.match(cmd, /exec dsh /);
  assert.equal(cmd.includes('started >'), false);
});

test('with a token the remote records start before launching dsh', () => {
  const cmd = remoteCommand({ profile: 'headless', cwd: '' }, 'x', 'abc123');
  const startIdx = cmd.indexOf('echo started >');
  const dshIdx = cmd.indexOf('dsh --profile');
  assert.ok(startIdx !== -1, 'marker write missing');
  assert.ok(dshIdx !== -1, 'dsh launch missing');
  assert.ok(startIdx < dshIdx, 'marker must be written BEFORE dsh can run');
});

test('the tokenised command must not exec, or the finish marker is lost', () => {
  const cmd = remoteCommand({ profile: 'headless', cwd: '' }, 'x', 'abc123');
  assert.equal(/exec dsh /.test(cmd), false);
});

test('the tokenised command propagates dsh exit code to the caller', () => {
  // Without the explicit `exit $__rc`, the trailing marker append would reset
  // the status to 0 and every failed task would look successful.
  const cmd = remoteCommand({ profile: 'headless', cwd: '' }, 'x', 'abc123');
  assert.match(cmd, /__rc=\$\?/);
  assert.match(cmd, /finished %s/);
  assert.match(cmd, /exit \$__rc/);
});

test('markers live under a private dot-directory and are pruned', () => {
  assert.equal(MARKER_DIR, '$HOME/.dsh21/state');
  assert.equal(markerPath('t1'), '$HOME/.dsh21/state/t1');
  const cmd = remoteCommand({ profile: 'headless', cwd: '' }, 'x', 'abc123');
  assert.match(cmd, /find \$HOME\/\.dsh21\/state -type f -mtime \+2 -delete/);
});

test('the marker path is derived from the token, never from the task text', () => {
  // A task containing shell metacharacters must not be able to steer the marker.
  const nasty = 'x; rm -rf $HOME/.dsh21; echo';
  const cmd = remoteCommand({ profile: 'headless', cwd: '' }, nasty, 'tok9');
  assert.match(cmd, /state\/tok9/);
  assert.equal(cmd.includes('state/x;'), false);
});

test("ssh's own -v byte summary is filtered out of stderr", () => {
  // It reports different numbers than --measure, and showing both invites doubt.
  const withSummary = [
    'Transferred: sent 4960, received 4240 bytes, in 2.3 seconds',
    'Bytes per second: sent 2200.5, received 1881.1',
    'Connection to 10.8.0.21 closed.',
    'real error line',
  ].join('\n');
  assert.equal(visibleStderr(withSummary), 'real error line');
});

// --- never hang on a leaked pipe -------------------------------------------
// Regression: ssh forks a ControlPersist master that inherits the stdio pipes.
// A close-only wait then never fires, so a call that should fail fast instead
// stalls past its own deadline -- fatal for an unattended overnight run.

test('runAttempt settles even when a grandchild holds the stdio pipes', async () => {
  // The direct child exits at once, but it hands its stdout/stderr to a detached
  // grandchild that outlives it, exactly as a forked ssh master does. `close`
  // cannot fire until that grandchild dies; `exit` fires immediately.
  const code = 'const{spawn}=require("child_process");'
    + 'spawn(process.execPath,["-e","setTimeout(()=>{},2000)"],{stdio:"inherit",detached:true}).unref();'
    + 'process.exit(0);';
  const t0 = Date.now();
  const r = await runAttempt({ timeout: 30 }, [process.execPath, '-e', code]);
  const ms = Date.now() - t0;
  assert.equal(r.code, 0);
  assert.ok(ms < 2000, `settled in ${ms}ms -- must not wait for the grandchild`);
});

test('runAttempt still honours the output of a normal child', async () => {
  const r = await runAttempt({ timeout: 30 }, [process.execPath, '-e', 'console.log("hello"); process.exit(3)']);
  assert.equal(r.code, 3);
  assert.match(r.stdout, /hello/);
  assert.equal(r.timedOut, false);
});

test('runAttempt bounds a child that ignores SIGTERM', async () => {
  // A hung ssh must not stall the caller: it is SIGTERMed, then SIGKILLed, and
  // the attempt is settled regardless of what the pipes are doing.
  const r = await runAttempt({ timeout: 1 }, [process.execPath, '-e', 'setInterval(()=>{},1000)']);
  assert.equal(r.timedOut, true);
  assert.ok(r.ms < 9000, `should be bounded, took ${ms(r)}`);
});
function ms(r) { return r.ms; }

test('the remote PATH setup globs inside a word list, not an assignment', () => {
  // `export PATH=.../node/*/bin` silently keeps a literal star: assignments are
  // not pathname-expanded. The for-loop form is what actually resolves dsh.
  // It no longer starts with the loop: a zsh guard precedes it (see below).
  assert.match(REMOTE_PATH_SETUP, /for d in "\$HOME\/\.nvm\/versions\/node\/"\*\/bin/);
  assert.match(REMOTE_PATH_SETUP, /\$HOME\/.nvm\/versions\/node\/"\*\/bin/);
  assert.match(REMOTE_PATH_SETUP, /\[ -d "\$d" \] \|\| continue/);
  assert.match(REMOTE_PATH_SETUP, /\$HOME\/.npm-global\/bin/);
  assert.equal(REMOTE_PATH_SETUP.includes('export PATH='), false);
});

test('remote commands export PATH after the setup loop', () => {
  const cmd = remoteCommand({ profile: 'headless', cwd: '' }, 'x');
  assert.ok(cmd.indexOf('for d in ') < cmd.indexOf('export PATH'), 'export must come after the loop');
});

// --- detached runs ---------------------------------------------------------
// The synchronous path dies with its connection (and sshd SIGHUPs the session's
// process group, so dsh dies too). Detaching is what makes a long instruction
// survive on a link that drops, so the launch contract is load-bearing.

test('a detached run writes a runner script, a log and a done file', () => {
  const p = runPaths('abc123');
  assert.match(p.script, /\/runs\/abc123\.sh$/);
  assert.match(p.log, /\/runs\/abc123\.log$/);
  assert.match(p.done, /\/runs\/abc123\.done$/);
});

test('the runner is delivered by a quoted heredoc keyed to the run id', () => {
  const cmd = detachedCommand({ profile: 'headless', cwd: '' }, 'do it', 'abc123');
  // Quoted delimiter: the remote shell must not expand anything in the body.
  assert.match(cmd, /<<'DSH21_ABC123'/);
  assert.ok(cmd.includes('\nDSH21_ABC123'), 'heredoc must be terminated');
  // The id is random hex, so a task cannot forge the delimiter line.
  assert.equal(cmd.includes("<<'DSH21_ABC123'\ndo it"), false);
});

test('the runner detaches so the task outlives the ssh connection', () => {
  const cmd = detachedCommand({ profile: 'headless', cwd: '' }, 'x', 'abc123');
  assert.match(cmd, /setsid/, 'setsid is the preferred detach');
  assert.match(cmd, /nohup/, 'nohup must remain as the fallback');
  assert.match(cmd, /< \/dev\/null &/, 'stdio must be detached from the channel');
});

test('the runner records its exit code and keeps it', () => {
  const cmd = detachedCommand({ profile: 'headless', cwd: '' }, 'x', 'abc123');
  assert.match(cmd, /__rc=\$\?/);
  assert.match(cmd, /printf '%s\\n' "\$__rc" > \$HOME\/\.dsh21\/runs\/abc123\.done/);
  assert.match(cmd, /exit \$__rc/);
});

test('a detached run reports the id so it can be collected', () => {
  const cmd = detachedCommand({ profile: 'headless', cwd: '' }, 'x', 'abc123');
  assert.match(cmd, /echo "dsh21-started abc123"/);
});

test('a detached run honours --cwd', () => {
  const cmd = detachedCommand({ profile: 'headless', cwd: '/data/work' }, 'x', 'abc123');
  assert.match(cmd, /cd '\/data\/work' 2>\/dev\/null \|\|/);
});

test('fetch inspects state and output in one round trip', () => {
  const cmd = fetchCommand('abc123');
  assert.match(cmd, /STATE=done/);
  assert.match(cmd, /STATE=running/);
  assert.match(cmd, /LOG_BEGIN/);
  // No loop: polling policy belongs to the caller, not the remote command.
  assert.equal(/while|until|for /.test(cmd), false);
});

test('parseFetch reads a finished run', () => {
  const out = 'STATE=done\nRC=0\nLOG_BEGIN\nPONG\nLOG_END';
  assert.deepEqual(parseFetch(out), { state: 'done', rc: 0, log: 'PONG', exists: null });
});

test('parseFetch reads a run still in flight', () => {
  const out = 'EXISTS=yes\nSTATE=running\nLOG_BEGIN\npartial output\nLOG_END';
  assert.deepEqual(parseFetch(out), { state: 'running', rc: null, log: 'partial output', exists: true });
});

test('parseFetch distinguishes "not started yet" from "no such run"', () => {
  // Without EXISTS a typo'd id would poll "still running" until the deadline.
  const missing = parseFetch('EXISTS=no\nSTATE=running\n');
  assert.equal(missing.exists, false);
  assert.equal(missing.state, 'running');
  const started = parseFetch('EXISTS=yes\nSTATE=running\n');
  assert.equal(started.exists, true);
});

test('fetch reports existence so a bad id can be caught early', () => {
  assert.match(fetchCommand('abc123'), /EXISTS=no/);
});

test('parseFetch survives a non-zero exit code and empty log', () => {
  assert.deepEqual(parseFetch('STATE=done\nRC=17\n'), { state: 'done', rc: 17, log: '', exists: null });
  assert.deepEqual(parseFetch('garbage'), { state: 'unknown', rc: null, log: '', exists: null });
});

// --- poll backoff ----------------------------------------------------------
// Each poll costs ~1.1 KB of real link traffic, so a fixed short interval makes
// collecting a long task cost bytes in proportion to its duration.

test('the poll interval backs off and then holds at the cap', () => {
  let i = 10000;
  const seq = [];
  for (let n = 0; n < 12; n++) { seq.push(i); i = nextPollInterval(i, 60000); }
  assert.equal(seq[0], 10000);
  assert.equal(seq[1], 15000);
  assert.equal(seq[2], 22500);
  assert.equal(seq.at(-1), 60000, 'must settle at the cap');
  assert.equal(seq.every((v, idx) => idx === 0 || v >= seq[idx - 1]), true, 'never shrinks');
});

test('the cap is respected even if it is below the initial interval', () => {
  assert.equal(nextPollInterval(30000, 5000), 30000, 'never polls faster than asked');
});

test('a 20-minute collect stays far below the fixed-interval cost', () => {
  // Fixed 10s would be ~120 polls (~132 KB). Backing off 1.5x to a 60s cap:
  let t = 0; let i = 10000; let polls = 0;
  while (t < 1200) { polls++; t += i; i = nextPollInterval(i, 60000); }
  assert.ok(polls < 30, `expected <30 polls, got ${polls}`);
});

// --- a bad --cwd must abort, not run somewhere else ------------------------
// Regression: `cd` failing without `set -e` let the task run in the remote home
// directory and exit 0 -- so `--cwd /data/work "make -j4"` on a host lacking
// that path would run make in the wrong place and report success.

test('a bad --cwd aborts the synchronous task with a distinct code', () => {
  const cmd = remoteCommand({ profile: 'headless', cwd: '/no/such/dir' }, 'x');
  assert.match(cmd, /cd '\/no\/such\/dir' 2>\/dev\/null \|\|/);
  assert.match(cmd, new RegExp(`exit ${EXIT_BAD_CWD}`));
  assert.match(cmd, /remote cwd does not exist/);
});

test('a bad --cwd aborts a detached run too, and records the code', () => {
  const cmd = detachedCommand({ profile: 'headless', cwd: '/no/such/dir' }, 'x', 'abc123');
  assert.match(cmd, /remote cwd does not exist/);
  assert.ok(cmd.includes(String(EXIT_BAD_CWD)), 'the done file must record the code');
});

test('the abort happens BEFORE dsh can run', () => {
  const cmd = remoteCommand({ profile: 'headless', cwd: '/no/such/dir' }, 'x');
  assert.ok(cmd.indexOf('remote cwd does not exist') < cmd.indexOf('dsh --profile'),
    'the guard must precede the dsh launch');
});

test('no --cwd means no guard is emitted', () => {
  const cmd = remoteCommand({ profile: 'headless', cwd: '' }, 'x');
  assert.equal(cmd.includes('remote cwd does not exist'), false);
});

test('EXIT_BAD_CWD is a distinct, non-zero code', () => {
  assert.equal(typeof EXIT_BAD_CWD, 'number');
  assert.notEqual(EXIT_BAD_CWD, 0);
  assert.notEqual(EXIT_BAD_CWD, 255, '255 is ssh-level failure; must not collide');
});

// --- the remote shell may be zsh -------------------------------------------
// zsh's default `nomatch` makes an unmatched glob FATAL for the whole command
// line. The PATH setup globs the nvm path, which does not exist on every host,
// so without a guard the loop kills everything after it -- including the dsh
// invocation. Verified against cms.tun, where the trailing echo never ran.

const unmatchedGlobEnv = { ...process.env, HOME: '/nonexistent-home-for-test' };

test('the PATH setup survives an unmatched glob under zsh', () => {
  const script = `${REMOTE_PATH_SETUP}; echo SURVIVED`;
  const r = spawnSync('zsh', ['-c', script], { encoding: 'utf8', env: unmatchedGlobEnv });
  if (r.error) return; // zsh not installed here; the bash test below still applies
  assert.match(r.stdout, /SURVIVED/, 'command line must not be aborted by the glob');
});

test('the same script WOULD be aborted without the guard (why the guard exists)', () => {
  const r = spawnSync('zsh', ['-c', 'for d in "$HOME/.nvm/versions/node/"*/bin; do :; done; echo SURVIVED'],
    { encoding: 'utf8', env: unmatchedGlobEnv });
  if (r.error) return;
  assert.equal(/SURVIVED/.test(r.stdout), false, 'unguarded form must abort, or this test proves nothing');
});

test('the PATH setup still behaves under bash', () => {
  const r = spawnSync('bash', ['-c', `${REMOTE_PATH_SETUP}; echo SURVIVED`], { encoding: 'utf8', env: unmatchedGlobEnv });
  assert.match(r.stdout, /SURVIVED/);
});

test('the guard is a no-op outside zsh', () => {
  // unsetopt does not exist in bash; the ZSH_VERSION test must short-circuit it.
  assert.match(REMOTE_PATH_SETUP, /\$\{ZSH_VERSION:-\}/);
  const r = spawnSync('bash', ['-c', `${REMOTE_PATH_SETUP}; echo OK`], { encoding: 'utf8', env: unmatchedGlobEnv });
  assert.equal(r.status, 0);
  assert.equal(/unsetopt: command not found/.test(r.stderr), false);
});

// --- argv hardening --------------------------------------------------------
// ssh reads a leading-dash argument in HOST position as one of its own options.
// Verified against OpenSSH 10.2: without a separator, a host of
// "-oProxyCommand=..." was applied as configuration instead of being rejected.

const CLI = new URL('../scripts/dsh21.mjs', import.meta.url).pathname;

function dryRun(args) {
  const r = spawnSync(process.execPath, [CLI, '--dry-run', ...args], { encoding: 'utf8' });
  return r.stdout.trim();
}

test('every dry-run argv separates the host with --', () => {
  for (const args of [['x'], ['--detach', 'x'], ['--status', 'abc123def'], ['--probe']]) {
    const line = dryRun(args);
    assert.match(line, / -- dgx21\.tun /, `missing -- before host for: ${args.join(' ')}`);
  }
});

test('a hostile --profile stays a single shell word', () => {
  const cmd = remoteCommand({ profile: 'headless; touch /tmp/pwned', cwd: '' }, 'x');
  // Quoted as one word, so the ';' cannot terminate the command.
  assert.equal(cmd.includes("--profile 'headless; touch /tmp/pwned'"), true);
  assert.equal(cmd.includes('--profile headless; touch'), false, 'must not be emitted unquoted');
});

test('--profile cannot smuggle in a command substitution', () => {
  const cmd = remoteCommand({ profile: 'a$(id)b', cwd: '' }, 'x');
  assert.equal(cmd.includes("--profile 'a$(id)b'"), true);
});

test('the dry-run never touches the network', () => {
  // A bad host plus --dry-run must still print, not connect.
  const line = dryRun(['--host', 'no-such-host.invalid', 'x']);
  assert.match(line, /no-such-host\.invalid/);
});
