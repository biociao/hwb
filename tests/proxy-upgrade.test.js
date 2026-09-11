import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createProxy } from '../src/control/proxy.js';

// WebSocket 升级的退化路径回归。
//
// 从客户端发出 Upgrade 请求，到上游回 101 之间有一段**空窗**（经 ssh -L 隧道可达数百毫秒）。
// 这期间客户端断开（关标签页 / 断网）会让客户端 socket 抛 ECONNRESET。原生实现把
// `socket.on('error', noop)` 写在 upstream 的 'upgrade' 回调内部——也就是空窗**结束之后**才挂上，
// 于是空窗里的 ECONNRESET 变成 uncaughtException，直接打穿整个 hwb 进程
// （并连带 SIGTERM 掉所有托管的 dsh web 子进程）。
//
// 这里用「接受连接但从不回应」的上游人为拉长空窗，再在空窗里 reset 客户端连接。

function stalledUpstream(t) {
  const server = http.createServer(() => { /* 永不响应：把请求留在空窗里 */ });
  server.on('upgrade', () => { /* 同样不回应 */ });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    // 注意：不要 await server.close()。代理转发进来的那个升级请求会被这个「永不回应」的
    // server 一直挂着，close 的回调要等它结束才触发，after 钩子会永远挂住（实测：测试进程
    // 直接静默退出、连 TAP 汇总都不打）。destroy 掉连接即可，测试不需要优雅关闭。
    t.after(() => { server.closeAllConnections?.(); server.close(); });
    resolve(server.address().port);
  }));
}

// 收集本进程的 uncaughtException：这正是「打穿整个 hwb 进程」的那条路径。
function countUncaught(t) {
  const seen = [];
  const handler = (e) => seen.push(e.message);
  process.on('uncaughtException', handler);
  t.after(() => process.removeListener('uncaughtException', handler));
  return seen;
}

function openUpgradeSocket(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ port, host: '127.0.0.1' });
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.write([
        'GET /api/events.mux HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        '', '',
      ].join('\r\n'));
      resolve(socket);
    });
  });
}

// 代理是否还活着：直接连它的监听端口，不经过那个不会回应的上游。
function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host: '127.0.0.1' });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

test('升级握手空窗内客户端断开：代理不崩、进程不受影响', async (t) => {
  const uncaught = countUncaught(t);
  const upstreamPort = await stalledUpstream(t);
  const proxy = await createProxy({ target: new URL(`http://127.0.0.1:${upstreamPort}`) });
  t.after(() => proxy.close());

  const socket = await openUpgradeSocket(proxy.port);
  await new Promise((r) => setTimeout(r, 60)); // 停在空窗里（上游还没回 101）
  socket.resetAndDestroy();

  await new Promise((r) => setTimeout(r, 250)); // 给事件循环几个回合把异常抛出来
  assert.deepEqual(uncaught, [], '空窗内断开不应产生 uncaughtException');
  assert.equal(await canConnect(proxy.port), true, '代理应仍在监听（没有被异常带崩）');
});

test('升级握手空窗内连续断开多次：仍然稳定', async (t) => {
  const uncaught = countUncaught(t);
  const upstreamPort = await stalledUpstream(t);
  const proxy = await createProxy({ target: new URL(`http://127.0.0.1:${upstreamPort}`) });
  t.after(() => proxy.close());

  for (let i = 0; i < 5; i++) {
    const socket = await openUpgradeSocket(proxy.port);
    await new Promise((r) => setTimeout(r, 20));
    socket.resetAndDestroy();
  }
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(uncaught, []);
  assert.equal(await canConnect(proxy.port), true);
});
