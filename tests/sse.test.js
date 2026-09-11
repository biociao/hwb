import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SSEHub } from '../src/api/sse.js';

// SSE 背压回归。曾经的 broadcast 只做 `res.write(payload)` 且完全忽略返回值：
// 客户端**连着但不再读**（合盖的笔记本、被节流的标签页、NAT 半开、只连不读的 curl）时，
// socket 不报错也不关闭，每次广播都堆进它的写队列，内存只增不减。
// 实测：一个卡住的客户端 + 40 次 256 KiB 广播 ⇒ writableLength 涨到 10 MiB 且永不回落。
// hwb 是单进程工作台，一个卡住的标签页就足以把进程拖到 OOM。

function fakeRes() {
  return {
    writableLength: 0,
    destroyed: false,
    head: null,
    writes: [],
    writeHead(status, headers) { this.head = { status, headers }; },
    write(chunk) { this.writes.push(chunk); this.writableLength += Buffer.byteLength(chunk); return false; },
    // 真实的 ServerResponse 一定有 end()：假的也得有，否则「拒绝连接时回一句话」这种代码
    // 在测试里会被 try/catch 吞掉，测出来的是假象。
    end(chunk) { if (chunk !== undefined) this.writes.push(chunk); this.ended = true; },
    destroy() { this.destroyed = true; },
  };
}

function fakeReq() {
  const listeners = new Map();
  return {
    on(event, cb) { listeners.set(event, cb); },
    close() { listeners.get('close')?.(); },
  };
}

function connect(hub) {
  const req = fakeReq();
  const res = fakeRes();
  hub.handle(req, res);
  return { req, res };
}

test('handle: 建立连接时写 200 + text/event-stream，并注册关闭清理', (t) => {
  const hub = new SSEHub({ heartbeatMs: 1_000_000 });
  t.after(() => hub.close());
  const { req, res } = connect(hub);
  assert.equal(res.head.status, 200);
  assert.equal(res.head.headers['Content-Type'], 'text/event-stream');
  assert.equal(hub.size, 1);
  req.close();
  assert.equal(hub.size, 0, 'req close 后必须从 clients 移除');
});

test('broadcast: 落后超过上限的客户端被断开，而不是无限堆积', (t) => {
  const hub = new SSEHub({ heartbeatMs: 1_000_000, maxLagBytes: 4096 });
  t.after(() => hub.close());
  const { res } = connect(hub);

  // 1 KiB 载荷 × 20 次 = 20 KiB，远超 4 KiB 上限。
  for (let i = 0; i < 20; i++) hub.broadcast('log:event', { i, pad: 'x'.repeat(900) });

  assert.equal(hub.size, 0, '卡住的客户端应被移除');
  assert.equal(res.destroyed, true, '应被 destroy，而不是继续留在 clients 里');
  // 上限 + 最后一个载荷的余量，绝不是 20 KiB。
  assert.ok(res.writableLength <= 4096 + 2048, `写队列仍被限制在上限附近，实际 ${res.writableLength}`);
});

test('broadcast: 正常消费的客户端不受影响', (t) => {
  const hub = new SSEHub({ heartbeatMs: 1_000_000, maxLagBytes: 4096 });
  t.after(() => hub.close());
  const { res } = connect(hub);
  // 模拟一直读空的客户端
  res.write = function write(chunk) { this.writes.push(chunk); return true; };

  for (let i = 0; i < 50; i++) hub.broadcast('index:updated', { i });
  assert.equal(hub.size, 1, '会消费的客户端不应被断开');
  assert.equal(res.destroyed, false);
  assert.ok(res.writes.some((w) => w.includes('event: index:updated')));
});

test('heartbeat: 心跳会剔除已销毁的客户端并写入 ping', (t) => {
  const hub = new SSEHub({ heartbeatMs: 10, maxLagBytes: 1024 });
  t.after(() => hub.close());
  const healthy = connect(hub).res;
  const dead = connect(hub).res;
  dead.destroyed = true;

  return new Promise((resolve) => setTimeout(resolve, 60)).then(() => {
    assert.equal(hub.size, 1, '已销毁的客户端被心跳清掉');
    assert.ok(healthy.writes.some((w) => w === ': ping\n\n'), '健康客户端应收到心跳');
  });
});

test('close: 断开全部客户端并停掉心跳定时器', (t) => {
  const hub = new SSEHub({ heartbeatMs: 10 });
  const { res } = connect(hub);
  hub.close();
  assert.equal(hub.size, 0);
  assert.equal(res.destroyed, true);
  // 定时器已清理：再等几拍也不应抛错或复活
  return new Promise((resolve) => setTimeout(resolve, 40)).then(() => assert.equal(hub.size, 0));
});

test('broadcast/handle 对抛错的响应不再二次抛出', (t) => {
  const hub = new SSEHub({ heartbeatMs: 1_000_000 });
  t.after(() => hub.close());
  const { res } = connect(hub);
  res.write = () => { throw new Error('write after end'); };
  assert.doesNotThrow(() => hub.broadcast('x', {}));
  assert.equal(hub.size, 0, '写失败的客户端应被清理');
});

// 背压上限管的是「一个卡住的客户端」，但没管「有多少个客户端」：一个跑飞的脚本能开成百上千条
// EventSource，每条占一个 fd 与一份连接状态。超过上限拒绝**新**连接（浏览器会自己退避重连），
// 而不是踢掉正在工作的标签页 —— 后者会让用户当前页面突然静默停止刷新。
test('handle: 客户端数达上限时拒绝新连接（503），且不影响已有连接', (t) => {
  const hub = new SSEHub({ heartbeatMs: 1_000_000, maxClients: 3 });
  t.after(() => hub.close());
  const first = [];
  for (let i = 0; i < 3; i++) first.push(connect(hub));
  assert.equal(hub.size, 3);
  for (const { res } of first) assert.equal(res.head.status, 200);

  const extra = connect(hub);
  assert.equal(extra.res.head.status, 503, '第 4 条应被拒绝');
  assert.match(String(extra.res.writes.join('')), /上限/);
  assert.equal(hub.size, 3, '被拒绝的连接不该计入');

  // 已有连接照旧收广播；关掉一条后新连接能被接受
  hub.broadcast('log:event', { ok: true });
  assert.ok(first[0].res.writes.some((w) => String(w).includes('log:event')));
  first[0].req.close();
  assert.equal(hub.size, 2);
  const again = connect(hub);
  assert.equal(again.res.head.status, 200, '有位置时新连接必须能进');
});
