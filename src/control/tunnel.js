import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { logger } from '../lib/logger.js';

const log = logger('tunnel');

// SSH 按需隧道（§5.3）：`ssh -L 127.0.0.1:{local}:127.0.0.1:{remote} {host}`，
// 把远程 dsh web 的端口安全地映射到本地回环，供 hwb 的 iframe 本地访问。
export async function openTunnel({ host, remotePort }) {
  if (!host || !Number.isInteger(remotePort) || remotePort <= 0) {
    const e = new Error(`invalid remote instance (host=${host}, remotePort=${remotePort})`);
    log.error('创建隧道被拒绝：远程实例参数非法', e, { host, remotePort });
    throw e;
  }
  const localPort = await freePort();
  const proc = spawn('ssh', [
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ConnectTimeout=10',
    '-N',
    '-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
    host,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
