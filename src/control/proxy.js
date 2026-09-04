import http from 'node:http';

// —— dsh web 反向代理（hwb 侧, §5.5）——
// 以「根路径 1:1 转发」的方式为一个 dsh web 实例提供 hwb 自有的代理入口。
// 为什么必须根路径：dsh web 的 index.html 用 `/plugins/...`、`/assets/...` 这些根绝对路径
// （`<base href="/">`, `<script src="/plugins/...">`），若挂在 hwb 的子路径（/proxy/<id>/）下,
// 这些绝对路径会解析到 hwb 自己的根而被 404。因此代理必须独立监听一个端口、把根路径原样转发,
// 才能让资源/插件/API/WebSocket 全部走通。
//
// 该代理替 hwb 统一持有每个实例的入口（本地 dsh 端口 或 远程 ssh -L 隧道端口）,并：
//   · Host 头原样透传(浏览器访问代理的 Host)——dsh 的鉴权 cookie 按 authority=Host 绑定,
//     这样 cookie 在「代理 origin」上稳定有效;
//   · 透传所有方法 + 请求体,流式回传响应;
//   · 处理 WebSocket(`upgrade`)升级,让 dsh web 的实时通道(SSE/WS)也走代理。

/**
 * 创建一个指向 target 的根路径 HTTP 反向代理。
 * @param {{ target: string, host?: string }} opts
 *   target 形如 `http://127.0.0.1:<dshport>`（本地）或 `http://127.0.0.1:<tunnel>)(远程隧道)。
 * @returns {Promise<{ server, port, url, close }>}
 */
export function createProxy({ target, host = '127.0.0.1' }) {
  return new Promise((resolve, reject) => {
    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch {
      reject(new Error(`proxy: invalid target ${target}`));
      return;
    }
    const { hostname, port } = targetUrl;
    if (targetUrl.protocol !== 'http:') {
      reject(new Error(`proxy: only http target supported, got ${targetUrl.protocol}`));
      return;
    }

    const server = http.createServer((req, res) => forwardRequest(req, res, hostname, Number(port)));
    server.on('upgrade', (req, socket, head) => forwardUpgrade(req, socket, head, hostname, Number(port)));
    server.on('clientError', (err, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });
    server.on('error', reject);

    server.listen(0, host, () => {
      const p = server.address().port;
      resolve({
        server,
        port: p,
        url: `http://${host}:${p}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// 转发普通请求(含 SSE——Node 会按 chunk 流式回传)。
function forwardRequest(req, res, hostname, port) {
  const headers = { ...req.headers };
  // 去掉逐跳(hop-by-hop)头,避免连接语义混乱;Host 保留(浏览器访问代理的 Host)。
  for (const h of ['proxy-connection', 'keep-alive', 'connection']) delete headers[h];

  const upstream = http.request({
    hostname,
    port,
    path: req.url,
    method: req.method,
    headers,
  }, (upRes) => {
    res.writeHead(upRes.statusCode, upRes.headers);
    upRes.pipe(res);
  });
  upstream.on('error', (e) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`proxy: upstream error — ${e.message}`);
  });
  req.pipe(upstream);
}

// 转发 WebSocket 升级。
function forwardUpgrade(req, socket, head, hostname, port) {
  const headers = { ...req.headers };
  for (const h of ['proxy-connection']) delete headers[h];
  const upstream = http.request({
    hostname,
    port,
    path: req.url,
    method: req.method,
    headers,
  });
  upstream.on('upgrade', (upRes, upSocket, upHead) => {
    // 回写 101 + 上游响应头,再双向 pipe。
    socket.write('HTTP/1.1 101 Switching Protocols\r\n');
    const rHeaders = upRes.rawHeaders;
    for (let i = 0; i < rHeaders.length; i += 2) socket.write(`${rHeaders[i]}: ${rHeaders[i + 1]}\r\n`);
    socket.write('\r\n');
    if (upHead && upHead.length) upSocket.write(upHead);
    upSocket.pipe(socket);
    socket.pipe(upSocket);
  });
  upstream.on('response', () => socket.destroy());
  upstream.on('error', () => socket.destroy());
  upstream.end();
}
