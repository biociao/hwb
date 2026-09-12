import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { logger } from '../lib/logger.js';
import { sshOpts } from './ssh-opts.js';

const log = logger('tunnel');
const execFileAsync = promisify(execFile);

// ClearAllForwardings=yes also removes our explicit -L. Resolve Host/Include/Match
// first, then remove only inherited forwarding directives from a private snapshot.
export function withoutForwardings(config) {
  return config.split('\n').filter(line => !/^\s*(?:localforward|remoteforward|dynamicforward)\s/i.test(line)).join('\n');
}

// SSH 按需隧道（§5.3）：`ssh -L 127.0.0.1:{local}:127.0.0.1:{remote} {host}`，
// 把远程 dsh web 的端口安全地映射到本地回环，供 hwb 的 iframe 本地访问。
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
  let proc;
  try {
    await writeFile(configFile, withoutForwardings(config), { mode: 0o600 });
    proc = spawn('ssh', [
      '-F', configFile,
      '-o', 'ClearAllForwardings=no',
      // dsh serves large JavaScript bundles; compress them across remote links.
      '-C',
      // 连接策略（ConnectTimeout/保活）来自 ssh-opts；**但隧道必须独占连接，不得复用**。
      //
      // 原实现锁死 `ControlPath=none`（每次新建连接），在高延迟链路上因 ConnectTimeout=10
      // 直接失败，故一度改成复用常驻 master。实测（2026-09-12）复用对隧道是错的：
      // 一旦 master 已存在（remote.js 的 sshBash 抓 token / 探活会先建一条，ControlPersist=300
      // 保活 5 分钟），本命令就退化成从连接——它把 -L 请求交给 master 后【立即以 code 0 退出、
      // stderr 为空】，而 launcher 的 assertCurrent() 见到 proc.exitCode !== null 就抛
      // 'ssh exited early'，实例连接因此失败（端口实际还在转发，是 hwb 自己判自己失败）。
      // 复现：master 存在时 `ssh -o ControlMaster=auto -N -L …` → exit 0；不存在时则常驻。
      //
      // 复用只对「短命令」有益（sshBash/探活），对「必须常驻的隧道所有者进程」有害。
      // 故此处显式 mux:false：隧道永远自己建连并持有它，配合 ConnectTimeout=30 承受 12–25s 握手。
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
    stderr: () => stderr,
  };
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
