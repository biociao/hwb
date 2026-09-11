// The private control socket belongs to this process: no PID-file based killing.
import net from 'node:net';
import fs from 'node:fs';
import { socketFile } from './lib/service-config.js';
let ready = false;
const startedAt = new Date().toISOString();
const control = net.createServer(socket => {
  socket.setTimeout(2000, () => socket.destroy());
  let input = '';
  socket.on('error', () => {});
  socket.on('data', chunk => {
    input += chunk;
    if (input.length > 1024) return socket.destroy();
    if (!input.includes('\n')) return;
    const command = input.trim();
    socket.end(JSON.stringify({ pid: process.pid, ready, startedAt, port: Number(process.env.HWB_SERVICE_PORT) }) + '\n');
    if (command === 'stop') socket.once('close', () => process.kill(process.pid, 'SIGTERM'));
  });
});
control.on('error', err => { console.error(err.message); process.exit(1); });
control.listen(socketFile, async () => {
  fs.chmodSync(socketFile, 0o600);
  process.once('exit', () => { try { fs.unlinkSync(socketFile); } catch {} });
  // server reports readiness only after the HTTP listener has bound successfully.
  globalThis.hwbServiceReady = () => {
    ready = true;
    process.send?.({ ready: true });
    process.disconnect?.();
  };
  try { await import('./server.js'); }
  catch (err) { console.error(err); process.exit(1); }
});
