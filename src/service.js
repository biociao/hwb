// The private control socket belongs to this process: no PID-file based killing.
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
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
// 控制 socket 在 bind 与 chmod 之间存在一个极短的 0755 窗口（实测），期间同机其它用户
// 可以连上来发 stop —— 那会 SIGTERM 掉服务并连带杀掉所有托管的 dsh web 子进程。
// socket 无法在 bind 前 chmod，所以先把**目录**收到 0700 来消除这个窗口的可达性：
// 目录不可进入时，socket 的权限位就无关紧要了。
try { fs.mkdirSync(path.dirname(socketFile), { recursive: true, mode: 0o700 }); fs.chmodSync(path.dirname(socketFile), 0o700); } catch { /* 尽力而为 */ }
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
