// SSE 广播中心。
//
// 单向「服务端推、浏览器收」的通道有个容易被忽略的失败模式：客户端**连着但不再读**
// （笔记本合盖、标签页被节流、NAT 半开、curl 不读）。此时 socket 不会报错也不会关闭，
// 每一次广播都会堆进它的写队列，内存只增不减——而 hwb 是单进程工作台，一个卡住的标签页
// 就足以把进程拖到 OOM。所以广播必须**有背压上限**：落后太多的客户端直接断开，
// 由浏览器 EventSource 自己重连（重连会重新拉一次全量状态，不会丢数据）。
const MAX_LAG_BYTES = 4 * 1024 * 1024;
// 心跳：探测半开连接（对端已消失但没有 FIN），同时让中间的代理不因空闲而切断。
const HEARTBEAT_MS = 30_000;
// 客户端数量上限。背压上限管的是「一个卡住的客户端」，但没说「有多少个客户端」：
// 一个跑飞的脚本（或用户狂刷页面）可以开成百上千条 EventSource，每条都占一个 fd 与一份
// 连接状态。超过上限时**拒绝新连接**（503，浏览器 EventSource 会自己退避重连），
// 而不是踢掉正在工作的标签页 —— 后者会让用户当前看着的页面突然静默停止刷新。
const MAX_CLIENTS = 32;

export class SSEHub {
  constructor({ heartbeatMs = HEARTBEAT_MS, maxLagBytes = MAX_LAG_BYTES, maxClients = MAX_CLIENTS } = {}) {
    this.clients = new Set();
    this.maxLagBytes = maxLagBytes;
    this.maxClients = maxClients;
    // unref：心跳不应阻止进程退出（hwb 的 stop 路径依赖进程能正常结束）。
    this.timer = setInterval(() => this.#heartbeat(), heartbeatMs);
    this.timer.unref?.();
  }

  get size() {
    return this.clients.size;
  }

  handle(req, res) {
    if (this.clients.size >= this.maxClients) {
      // 用一个明确的 503 说明「太忙」，而不是接受连接后立刻断开（那看起来像随机故障）。
      try {
        res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(`SSE 连接数已达上限（${this.maxClients}）\n`);
      } catch { /* 对端已经走了 */ }
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    this.clients.add(res);
    req.on('close', () => this.clients.delete(res));
  }

  #drop(res) {
    this.clients.delete(res);
    // destroy 而不是 end：对端已经读不动了，等它把缓冲读空没有意义。
    res.destroy?.();
  }

  #heartbeat() {
    for (const res of this.clients) {
      if (res.writableLength > this.maxLagBytes || res.destroyed) { this.#drop(res); continue; }
      try { res.write(': ping\n\n'); } catch { this.#drop(res); }
    }
  }

  broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) {
      // 已经卡住 / 已销毁的先清掉；再判断这一次写完之后是否超限。
      if (res.destroyed || res.writableLength > this.maxLagBytes) { this.#drop(res); continue; }
      try { res.write(payload); } catch { this.#drop(res); }
    }
  }

  close() {
    clearInterval(this.timer);
    for (const res of this.clients) res.destroy?.();
    this.clients.clear();
  }
}
