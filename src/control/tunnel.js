import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, createConnection } from 'node:net';
import { logger } from '../lib/logger.js';
import { sshOpts, muxPath, muxPathUsable, muxEnabled } from './ssh-opts.js';

const log = logger('tunnel');
const execFileAsync = promisify(execFile);

// ClearAllForwardings=yes also removes our explicit -L. Resolve Host/Include/Match
// first, then remove only inherited forwarding directives from a private snapshot.
export function withoutForwardings(config) {
  return config.split('\n').filter(line => !/^\s*(?:localforward|remoteforward|dynamicforward)\s/i.test(line)).join('\n');
}

// —— 隧道优先复用既有 master（2026-09-13）——
//
// 背景（实测 2026-09-13）：dgx21 等 .tun 主机用 sshd 默认 `MaxStartups 10:30:100`，
// 而该 VPN 链路握手要 11.7–14.0s（见 ssh-opts 注释）。于是 hwb 并发**新建**连接时，
// 连接会在 sshd 的**未认证队列**里堆过 10 条，sshd 随机丢弃约 30%：
//   25 并发同时发起   → 5/25 失败（"Connection closed by <host> port 22"）
//   25 并发错开 0.6s  → 0/25 失败
//   ≤8 并发           → 0/8 失败
// 对照同 VPN 的 c4g.tun 同样 4/25 失败 ⇒ 不是某台主机的毛病，是「默认值 + 慢握手」的通病。
//
// 原实现给隧道写死 `mux:false`（每次新建连接），使它成为最大受害者：
// hwb 日志里 192 次「ssh 隧道子进程异常退出」中有 121 次（63%）正是这条报错，
// 用户侧表现为实例反复 degraded、中位 7s 最长 164s 的「进不去」。
//
// 现在优先把 -L 挂到既有 master 上（`ssh -O forward`）：**完全不新建连接**，
// master 已是认证态，绕过 MaxStartups 那条未认证队列。
// 实测复用 master：25 并发 → 1/25，16 并发 → 0/16。
// 无 master 时才回退为原来的独占连接（行为与修复前一致）。
//
// master 的保活由 ssh 自己负责；这里只需巡检 `ssh -O check`：master 一死，
// 挂在它上面的 -L 也一并消失，故巡检失败即视为隧道死亡，交由 launcher 走恢复流程。
const MASTER_CHECK_TIMEOUT_MS = () => envInt('HWB_TUNNEL_MASTER_CHECK_MS', 4000);
const MASTER_POLL_MS = () => envInt('HWB_TUNNEL_MASTER_POLL_MS', 10_000);

// —— master 退化自愈（2026-09-19）——
//
// 复用 master 是绕过 sshd `MaxStartups` 的关键，代价是把吞吐押在**一条长命连接**上：
// 实测同一个 master 后期能把单次请求拖到 20s，而同刻新建一条 master 只要 0.5–0.8s
// （docs/dgx21-tun-access.md「残留风险：长命 master 会退化」）。所以巡检不能只问
// 「master 活着吗 / 转发口还在吗」—— 那两问都答「在」，用户侧照样整页卡住、
// 浏览器一路 `Reconnecting`（dsh 客户端的连接 generation 3s 告警、15s 判死）。
//
// 于是补一问「它现在还快不快」：每轮经 ControlPath 跑一条 `true` 并计时 —— 走 master
// （`ControlMaster=no` 明确「只许复用、不许新建」），因此不经过 sshd 的未认证队列，
// 只占 master 上的一个 channel。连续 N 轮「慢或失败」即判定退化，**先 `ssh -O exit`
// 回收这条 master，再 finish(255)**，由 launcher 重建一条新的。
//
// 「先回收再 finish」是必须的顺序：否则 launcher 立刻重建时 muxControlPath() 仍能看到
// 存活的（已退化的）master，会把 -L 重新挂回同一条连接，等于没自愈。
const MASTER_RTT_TIMEOUT_MS = () => envInt('HWB_TUNNEL_MASTER_RTT_TIMEOUT_MS', 8000);
const MASTER_RTT_SLOW_MS = () => envInt('HWB_TUNNEL_MASTER_RTT_MS', 3000);
const MASTER_RTT_STREAK = () => envInt('HWB_TUNNEL_MASTER_RTT_STREAK', 3);
// 自愈冷却：如果**整条链路**就是慢的，重建一条 master 也一样慢 —— 没有冷却就会变成
// 「每 30s 拆一次 master」，反而把这条窄链路刷得更乱。同一主机在该窗口内只自愈一次。
const MASTER_SELF_HEAL_COOLDOWN_MS = () => envInt('HWB_TUNNEL_MASTER_HEAL_COOLDOWN_MS', 600_000);
const lastSelfHealAt = new Map();

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// 按主机取复用套接字路径；**文件不存在就直接返回 null**，省掉一次 `ssh -O check` 往返
// （「无 master」是最常见路径，不该为它等一次超时）。
function muxControlPath(host) {
  if (!muxEnabled()) return null;
  const p = muxPath(host);
  if (!muxPathUsable(p)) return null;
  return existsSync(p) ? p : null;
}

function controlArgs({ host, controlPath, configFile }) {
  return [
    '-F', configFile,
    ...sshOpts({ host, mux: false }),
    '-o', `ControlPath=${controlPath}`,
  ];
}

// master 是否存活；存活时顺带取出它的 pid（`Master running (pid=NNNN)`）。
// 注意：`-O check` 把这行**打到 stderr**（实测 OpenSSH 9.x），所以两个流都要看。
async function masterAlive({ host, controlPath, configFile }) {
  try {
    const { stdout, stderr } = await execFileAsync('ssh', [
      ...controlArgs({ host, controlPath, configFile }),
      '-O', 'check', '--', host,
    ], { timeout: MASTER_CHECK_TIMEOUT_MS(), maxBuffer: 64 * 1024 });
    const m = /pid=(\d+)/.exec(`${stdout || ''}${stderr || ''}`);
    return { alive: true, pid: m ? Number(m[1]) : null };
  } catch {
    return { alive: false, pid: null };
  }
}

// 把 -L 挂到既有 master 上：不新建连接，因此不经过 sshd 的未认证队列。
async function addForward({ host, controlPath, configFile, localPort, remotePort }) {
  const spec = `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`;
  try {
    await execFileAsync('ssh', [
      ...controlArgs({ host, controlPath, configFile }),
      '-O', 'forward', '-L', spec, '--', host,
    ], { timeout: 15_000, maxBuffer: 64 * 1024 });
    return { ok: true, spec };
  } catch (error) {
    return { ok: false, spec, stderr: String(error?.stderr || error?.message || '').trim() };
  }
}

async function cancelForward({ host, controlPath, configFile, spec }) {
  try {
    await execFileAsync('ssh', [
      ...controlArgs({ host, controlPath, configFile }),
      '-O', 'cancel', '-L', spec, '--', host,
    ], { timeout: 15_000, maxBuffer: 64 * 1024 });
    return true;
  } catch {
    return false;
  }
}

// 经既存 master 的一次往返（`true`）并计时：master 健不健康，只有真的走它一趟才知道。
// `ControlMaster=no` 是刻意的：它表示「只复用既存 master、绝不新建」—— 于是 master 已消失时
// 这条探测只会**失败**，不会偷偷变出一条新连接来掩盖问题（那会给 sshd 的未认证队列加压，
// 正是我们要避开的对象）。
async function masterRtt({ host, controlPath, configFile }) {
  const started = Date.now();
  try {
    await execFileAsync('ssh', [
      ...controlArgs({ host, controlPath, configFile }),
      '-o', 'ControlMaster=no',
      '--', host, 'true',
    ], { timeout: MASTER_RTT_TIMEOUT_MS(), maxBuffer: 64 * 1024 });
    return { ok: true, ms: Date.now() - started, stderr: '' };
  } catch (error) {
    return { ok: false, ms: Date.now() - started, stderr: String(error?.stderr || error?.message || '').trim() };
  }
}

// 回收一条退化的 master（连带其上的所有 -L）。fire-and-await：调用方要等它落定后再 finish，
// 否则重建会挂回同一条连接（见 MASTER_SELF_HEAL_COOLDOWN_MS 上方的顺序说明）。
async function exitMaster({ host, controlPath, configFile }) {
  try {
    await execFileAsync('ssh', [
      ...controlArgs({ host, controlPath, configFile }),
      '-O', 'exit', '--', host,
    ], { timeout: 10_000, maxBuffer: 64 * 1024 });
    return true;
  } catch {
    return false;
  }
}

// 转发端口是否真的在监听（而不是只看 master 活着）。
//
// 为什么必须单独判：`ssh -O check` 只回答「master 进程还在不在」。而 -L 监听口挂在 master 上，
// master 从一次会话崩溃中复活（或 ControlPath socket 被新 master 复用）时，check 依旧回
// "Master running (pid=新pid)"，旧的 -L 却已经不在了。2026-09-14 实测：master running，
// 但 `lsof -iTCP -sTCP:LISTEN` 里一个 ssh 监听都没有 → hwb 认为隧道健康、既不重建也不报错，
// 实例永久卡在 unreachable（stable 入口只会回 connect ECONNREFUSED）。
// 故 liveness = master 活着 **且** 本地转发口能建立 TCP 连接；两者任一不成立即视为隧道已死，
// 交给 launcher 走恢复流程（重新 openTunnel 建一条新转发）。
const FORWARD_PROBE_TIMEOUT_MS = () => envInt('HWB_TUNNEL_FORWARD_PROBE_MS', 2000);

function forwardListening(localPort) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port: localPort });
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(FORWARD_PROBE_TIMEOUT_MS(), () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

// master 模式下的「隧道进程」替身：没有独占子进程，但必须对 launcher 保持子进程语义
// （fingerprint 看 exitCode/signalCode、#signalAndWait 听 'exit'、#terminate 调 kill）。
// 故合成一个 EventEmitter 句柄，靠 `ssh -O check` 巡检发现 master 死亡。
function masterTunnel({ host, controlPath, configFile, localPort, remotePort, pid, dir, spec }) {
  const proc = new EventEmitter();
  let stderrText = '';
  let timer = null;
  // 「慢或探测失败」的连续轮数，以及「正在自愈」的互斥位（自愈要 await 回收 master，
  // 期间下一轮巡检可能已经触发，必须挡住）。
  let unhealthyStreak = 0;
  let healing = false;

  // 快照目录的清理必须**排在 `-O cancel` 之后**：cancel 用的是 `-F <configFile>`，
  // 若在 finish() 里立刻删目录，异步的 cancel 就会拿到一个已消失的配置文件而静默失败，
  // 转发会一直留在 master 上（实测 bug）。
  const cleanupDir = () => rm(dir, { recursive: true, force: true }).catch(() => {});

  // finish 只负责「标记死亡 + 通知」，不碰目录 —— 与真实子进程 kill 的「投递即返回」语义一致。
  const finish = (code = 255, signal = null) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    proc.exitCode = code;
    proc.signalCode = signal;
    if (timer) { clearInterval(timer); timer = null; }
    proc.emit('exit', code, signal);
  };

  const poll = async () => {
    if (healing) return;
    const r = await masterAlive({ host, controlPath, configFile });
    if (!r.alive) {
      stderrText += `master 已消失（${host}），依附其上的 -L 随之失效\n`;
      finish(255, null);
      cleanupDir();
      return;
    }
    // master 活着还不够：转发口必须真的能连上（见 forwardListening 的注释）。
    if (!(await forwardListening(localPort))) {
      stderrText += `本地转发口 127.0.0.1:${localPort} 已不再监听（master ${r.pid ?? 'unknown'} 仍在，但 -L 已丢）\n`;
      finish(255, null);
      cleanupDir();
      return;
    }

    // —— 第三问：这条 master 现在还快吗 ——
    const rtt = await masterRtt({ host, controlPath, configFile });
    const slowMs = MASTER_RTT_SLOW_MS();
    const unhealthy = !rtt.ok || rtt.ms > slowMs;
    if (!unhealthy) { unhealthyStreak = 0; return; }
    unhealthyStreak += 1;
    if (unhealthyStreak < MASTER_RTT_STREAK()) return;

    const detail = rtt.ok ? `往返 ${rtt.ms}ms > ${slowMs}ms` : `往返探测失败（${rtt.ms}ms）：${rtt.stderr || 'ssh 退出非 0'}`;
    const last = lastSelfHealAt.get(host) ?? 0;
    if (Date.now() - last < MASTER_SELF_HEAL_COOLDOWN_MS()) {
      // 冷却期内不再拆：链路整体慢时重建也没用，反复拆只会把窄链路刷得更乱。
      log.warn('master 健康探测连续偏慢，但处于自愈冷却期（不重复回收）', {
        host, streak: unhealthyStreak, detail,
      });
      unhealthyStreak = 0;
      return;
    }
    lastSelfHealAt.set(host, Date.now());
    healing = true;
    log.warn('master 健康探测连续偏慢，回收该 master 交由 launcher 重建', {
      host, streak: unhealthyStreak, detail, thresholdMs: slowMs,
    });
    const recycled = await exitMaster({ host, controlPath, configFile });
    stderrText += `master 连续 ${unhealthyStreak} 轮健康探测偏慢（${detail}），`
      + `${recycled ? '已回收该 master' : '回收失败'}（${host}）；重建以恢复吞吐\n`;
    finish(255, null);
    cleanupDir();
  };

  Object.assign(proc, {
    pid: Number.isInteger(pid) && pid > 0 ? pid : -1,
    exitCode: null,
    signalCode: null,
    // 与真实子进程一致地保留 argv 形状，便于测试与 ps 侧核对。
    spawnargs: ['ssh', '-O', 'forward', '-L', spec, '--', host],
    kill: (signal = 'SIGTERM') => {
      // 先摘转发（fire-and-forget：kill 与真实子进程一样「投递即返回」），再立即标记死亡 ——
      // 调用方（#signalAndWait / #releaseRemote）随后就能看到 'exit'。
      // 目录在 cancel 落定后再删，否则 cancel 会因配置文件缺失而失败、转发残留。
      cancelForward({ host, controlPath, configFile, spec })
        .catch(() => {})
        .finally(cleanupDir);
      finish(0, signal);
      return true;
    },
  });

  timer = setInterval(() => { poll().catch(() => {}); }, MASTER_POLL_MS());
  timer.unref?.();

  return {
    url: `http://127.0.0.1:${localPort}`,
    localPort,
    proc,
    viaMaster: true,
    stderr: () => stderrText,
  };
}

// SSH 按需隧道（§5.3）：`ssh -L 127.0.0.1:{local}:127.0.0.1:{remote} {host}`，
// 把远程 dsh web 的端口安全地映射到本地回环，供 hwb 的 iframe 本地访问。
//
// 优先把 -L 挂到既有 master（不新建连接，规避 MaxStartups 丢连）；
// 无 master 时回退为独占连接（修复前的行为）。
export async function openTunnel({ host, remotePort }) {
  if (!host || !Number.isInteger(remotePort) || remotePort <= 0) {
    const e = new Error(`invalid remote instance (host=${host}, remotePort=${remotePort})`);
    log.error('创建隧道被拒绝：远程实例参数非法', e, { host, remotePort });
    throw e;
  }
  const localPort = await freePort();
  const { stdout: config } = await execFileAsync('ssh', ['-G', '--', host], {
    timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  const dir = await mkdtemp(path.join(tmpdir(), 'hwb-ssh-'));
  const configFile = path.join(dir, 'config');
  const cleanup = () => rm(dir, { recursive: true, force: true }).catch(() => {});
  try {
    await writeFile(configFile, withoutForwardings(config), { mode: 0o600 });

    // —— 首选：复用既有 master ——
    const controlPath = muxControlPath(host);
    if (controlPath) {
      const master = await masterAlive({ host, controlPath, configFile });
      if (master.alive) {
        const forward = await addForward({ host, controlPath, configFile, localPort, remotePort });
        if (forward.ok) {
          log.info('隧道复用既有 master（未新建 ssh 连接）', {
            host, localPort, remotePort, masterPid: master.pid,
          });
          return masterTunnel({
            host, controlPath, configFile, localPort, remotePort,
            pid: master.pid, dir, spec: forward.spec,
          });
        }
        log.warn('向既有 master 添加转发失败，回退为独占连接', {
          host, localPort, remotePort, stderr: forward.stderr,
        });
      }
    }

    // —— 回退：独占连接 ——
    let proc;
    try {
      proc = spawn('ssh', [
        '-F', configFile,
        '-o', 'ClearAllForwardings=no',
        // 压缩（`-C`）现由 ssh-opts 统一提供，这里不再单独加 —— 隧道若复用 master，
        // 真正承载数据的是 master 那条连接，压缩必须落在共享策略上才生效
        // （实测：缺压缩时 3.32 MB 的插件 bundle 要 140.5s，带压缩 30.4s，差 4.6 倍）。
        // 连接策略（ConnectTimeout/保活）来自 ssh-opts；**回退路径必须独占连接，不得复用**：
        // 一旦 master 已存在，`ControlMaster=auto` 会把 -L 交给 master 后立即以 code 0 退出、
        // stderr 为空，而 launcher 的 assertCurrent() 见到 proc.exitCode !== null 就抛
        // 'ssh exited early' —— 端口其实还在转发，是 hwb 自己判自己失败（2026-09-12 实测）。
        //
        // 那条路径现已由「-O forward 显式挂载 + 合成句柄」正确覆盖：有 master 走 -O forward，
        // 无 master 才落到这里独占建连。故此处显式 mux:false。
        ...sshOpts({ host, mux: false }),
        '-o', 'ExitOnForwardFailure=yes',
        '-N',
        '-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
        '--', host,
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      await cleanup();
      throw err;
    }
    proc.once('error', cleanup);
    proc.once('close', cleanup);
    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr += d;
      if (stderr.length > 8192) stderr = stderr.slice(-4096);
    });
    return {
      url: `http://127.0.0.1:${localPort}`,
      localPort,
      proc,
      viaMaster: false,
      stderr: () => stderr,
    };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}
