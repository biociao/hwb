// The private control socket belongs to this process: no PID-file based killing.
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
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
// 只对「hwb 自己的私有目录」收权限。HWB_DIR 被误设成共享位置（/tmp、$HOME、/）时，
// 无条件 chmod 0700 会把一个不属于 hwb 的目录重新授权（/tmp 的 sticky/world 位会掉），
// 影响的远不只是 hwb。这些位置只建目录、不改权限；socket 自身的 0600 仍然生效。
// （默认的 ~/.hwb 与 HWB_DIR 指向的私有目录照旧收到 0700 —— 那里有会话标题、路径与日志。）
{
  const stateDir = path.resolve(path.dirname(socketFile));
  const shared = new Set(['/', path.resolve(os.homedir()), path.resolve(os.tmpdir()),
    (() => { try { return fs.realpathSync(os.tmpdir()); } catch { return ''; } })()]);
  try {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    if (shared.has(stateDir)) {
      console.error(`hwb: HWB_DIR 指向共享目录 ${stateDir}，不收权限（建议换成私有目录）`);
    } else {
      fs.chmodSync(stateDir, 0o700);
    }
  } catch { /* 尽力而为 */ }
}
control.listen(socketFile, async () => {
  // 顺序要紧：先把 'exit' 清理挂上，再做任何可能抛错的事。监听回调是 async，
  // 在 `await import` 之前抛出的异常会变成 unhandledRejection —— 而 crash handler 要等
  // import 进去才安装，此时没人接得住，进程直接死、socket 文件还留在原地。
  process.once('exit', () => { try { fs.unlinkSync(socketFile); } catch {} });
  try { fs.chmodSync(socketFile, 0o600); } catch { /* socket 已消失（并发的 start 删掉了它）*/ }
  // server reports readiness only after the HTTP listener has bound successfully.
  // 父进程（`hwb start`）先一步消失是很常见的：Ctrl-C、关掉终端、supervisor/timeout 杀掉。
  // 我们这时**已经监听成功**了，不该因此死掉。注意 send 失败是**异步**的 —— 错误从 IPC
  // channel 以 'error' 事件冒出来，`try/catch` 抓不到（实测：只加 try/catch 仍会被 crash
  // handler 记成 FATAL 再 exit(1)，端口随后连不上）。所以必须显式吞掉 channel 错误。
  const ignoreChannelError = (error) => {
    const code = error?.code;
    // 父进程没了：EPIPE / 通道已关闭都是「没人收报到」这件事的不同表现，一律忽略；
    // 其它错误照旧抛出去，不要在这里变成静默。
    if (code === 'EPIPE' || code === 'ERR_IPC_CHANNEL_CLOSED' || code === 'ERR_IPC_DISCONNECTED') return;
    throw error;
  };
  process.on('error', ignoreChannelError);
  globalThis.hwbServiceReady = () => {
    ready = true;
    if (!process.connected) return;
    try { process.send({ ready: true }); } catch { /* 父进程已退出：服务照常运行 */ }
    try { process.disconnect?.(); } catch { /* 同上 */ }
  };
  try { await import('./server.js'); }
  catch (err) { console.error(err); process.exit(1); }
});
