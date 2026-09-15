import { addWorkspaceFinderMenu } from './workspace-menu.js';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { gunzipSync, brotliDecompressSync, inflateSync } from 'node:zlib';
const bridge = readFileSync(new URL('../web/preview-bridge.js', import.meta.url));
const themeLive = readFileSync(new URL('../web/dsh-theme-live.js', import.meta.url));
import { logger } from '../lib/logger.js';

const log = logger('proxy');
const STATIC_CACHE_CONTROL = 'private, max-age=31536000, immutable';
const STATIC_CONTENT_TYPES = {
  js: ['text/javascript', 'application/javascript'],
  mjs: ['text/javascript', 'application/javascript'],
  css: ['text/css'],
  woff: ['font/woff', 'application/font-woff'],
  woff2: ['font/woff2'],
  ttf: ['font/ttf'],
  otf: ['font/otf'],
  png: ['image/png'],
  jpg: ['image/jpeg'],
  jpeg: ['image/jpeg'],
  gif: ['image/gif'],
  svg: ['image/svg+xml'],
  webp: ['image/webp'],
  avif: ['image/avif'],
  ico: ['image/x-icon', 'image/vnd.microsoft.icon'],
};

// Vite assets carry an eight-character content hash; dsh combo scripts use a
// twelve-hex SHA1 of the script and source map. Match only those exact URL forms,
// not arbitrary plugin rev queries (some revisions are activation-time nonces).
// Preserve every upstream cache policy and exclude authentication responses.
function staticResponseHeaders(req, upRes) {
  const headers = upRes.headers;
  if (!['GET', 'HEAD'].includes(req.method) || upRes.statusCode !== 200) return headers;
  if (['cache-control', 'pragma', 'expires', 'set-cookie'].some((name) => headers[name] !== undefined)) return headers;
  if (headers.vary?.split(',').some((name) => name.trim() === '*')) return headers;
  const asset = /^\/assets\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8}\.(js|mjs|css|woff2?|ttf|otf|png|jpe?g|gif|svg|webp|avif|ico)$/.exec(req.url);
  const combo = /^\/plugins\/\?\?(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*\/client\.js(?:,(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*\/client\.js)*&rev=[a-f0-9]{12}$/.test(req.url);
  if (!asset && !combo) return headers;
  const type = (headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (!STATIC_CONTENT_TYPES[asset?.[1] || 'js'].includes(type)) return headers;
  return { ...headers, 'cache-control': STATIC_CACHE_CONTROL };
}

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
export function createProxy({ target, host = '127.0.0.1', preview = false, port: listenPort = 0 }) {
  return new Promise((resolve, reject) => {
    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch {
      const e = new Error(`proxy: invalid target ${target}`);
      log.error('创建代理失败：目标 URL 非法', e, { target });
      reject(e);
      return;
    }
    if (targetUrl.protocol !== 'http:') {
      const e = new Error(`proxy: only http target supported, got ${targetUrl.protocol}`);
      log.error('创建代理失败：目标协议不支持', e, { target, protocol: targetUrl.protocol });
      reject(e);
      return;
    }

    const server = http.createServer((req, res) => {
      if (preview && req.url === '/__hwb/preview-bridge.js') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
        res.end(bridge);
        return;
      }
      // 主题实时下发脚本：与 preview-bridge 同一条「本地生成、不入缓存」的路径。
      if (preview && req.url === '/__hwb/dsh-theme.js') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
        res.end(themeLive);
        return;
      }
      forwardRequest(req, res, targetUrl.hostname, Number(targetUrl.port), preview);
    });
    const sockets = new Set();
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server.on('upgrade', (req, socket, head) => forwardUpgrade(req, socket, head, targetUrl.hostname, Number(targetUrl.port)));
    server.on('clientError', (err, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });
    server.on('error', reject);

    server.listen(listenPort, host, () => {
      const p = server.address().port;
      resolve({
        server,
        port: p,
        url: `http://${host}:${p}`,
        retarget: (target) => {
          const next = new URL(target);
          if (next.protocol !== 'http:') throw new Error('proxy: only http target supported');
          targetUrl = next;
          // Existing streams belong to the old instance. Reconnect them to the new target.
          for (const socket of sockets) socket.destroy();
        },
        close: () => new Promise((r) => {
          server.close(() => r());
          for (const socket of sockets) socket.destroy();
        }),
      });
    });
  });
}

// 转发普通请求(含 SSE——Node 会按 chunk 流式回传)。
function forwardRequest(req, res, hostname, port, preview) {
  const headers = { ...req.headers };
  // 去掉逐跳(hop-by-hop)头,避免连接语义混乱;Host 保留(浏览器访问代理的 Host)。
  for (const h of ['proxy-connection', 'keep-alive', 'connection']) delete headers[h];

  const workspaceScript = preview && req.method === 'GET' && req.url.startsWith('/plugins/') && req.url.includes('dsh-client-ui-workspace');
  const inject = preview && req.method === 'GET' && new URL(req.url, 'http://localhost').pathname === '/';
  if (inject || workspaceScript) {
    headers['accept-encoding'] = 'identity';
    delete headers['if-none-match'];
    delete headers['if-modified-since'];
  }
  const upstream = http.request({
    hostname,
    port,
    path: req.url,
    method: req.method,
    headers,
  }, (upRes) => {
    if ((inject || workspaceScript) && upRes.statusCode === 200 && (inject ? /text\/html/i : /javascript/i).test(upRes.headers['content-type'] || '')) {
      const chunks = [];
      let size = 0;
      upRes.on('data', (chunk) => {
        size += chunk.length;
        if (size > 32 * 1024 * 1024) upRes.destroy(new Error('dsh index too large'));
        else chunks.push(chunk);
      });
      upRes.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('dsh index unavailable'); });
      upRes.on('end', () => {
        try {
          let body = Buffer.concat(chunks);
          const decode = { gzip: gunzipSync, br: brotliDecompressSync, deflate: inflateSync }[upRes.headers['content-encoding']];
          if (decode) body = decode(body, { maxOutputLength: 32 * 1024 * 1024 });
          // 两个注入脚本都用**同步** <script src>：preview-bridge 必须尽早挂上点击拦截，
          // dsh-theme-live 要在 dsh 首帧前拿到主题偏好（否则暗色下会先闪一下亮色）。
          const tag = '<script src="/__hwb/preview-bridge.js"></script>'
            + '<script src="/__hwb/dsh-theme.js"></script>';
          const html = body.toString('utf8');
          const updated = workspaceScript ? addWorkspaceFinderMenu(html) : (/<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, '$&' + tag) : tag + html);
          const outHeaders = workspaceScript && updated === html
            ? { ...staticResponseHeaders(req, upRes) }
            : { ...upRes.headers, 'cache-control': 'no-store' };
          for (const h of ['content-length', 'content-encoding', 'etag', 'last-modified', 'transfer-encoding']) delete outHeaders[h];
          res.writeHead(200, outHeaders);
          res.end(updated);
        } catch { res.writeHead(502); res.end('dsh index decoding failed'); }
      });
      return;
    }
    res.writeHead(upRes.statusCode, staticResponseHeaders(req, upRes));
    upRes.pipe(res);
  });
  upstream.on('error', (e) => {
    // 上游（dsh web 或 ssh 隧道）不可达/断开：记录上下文，便于定位健康检查失败原因。
    log.debug('代理上游请求失败', e, { target: `${hostname}:${port}`, path: req.url });
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`proxy: upstream error — ${e.message}`);
  });
  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
}

// 转发 WebSocket 升级。
function forwardUpgrade(req, socket, head, hostname, port) {
  // 客户端 socket 的 error 监听必须在**任何异步等待之前**挂上。从收到 upgrade 请求到上游回 101
  // 之间存在一段空窗（经 ssh -L 隧道可达数百毫秒），这期间浏览器关标签页/断网会让 socket 抛
  // ECONNRESET；没有监听就是 uncaughtException → 整个 hwb 进程退出，并连带杀掉所有托管的
  // dsh web 子进程。原先 `socket.on('error', noop)` 写在 upstream 'upgrade' 回调内部，
  // 覆盖不到这段空窗（实测：上游挂起不应答 + 客户端 resetAndDestroy ⇒ ECONNRESET 打穿进程）。
  const noop = () => {};
  socket.on('error', noop);
  const headers = { ...req.headers };
  for (const h of ['proxy-connection']) delete headers[h];
  const upstream = http.request({
    hostname,
    port,
    path: req.url,
    method: req.method,
    headers,
  });
  // 空窗内的拆除也必须在这里建立，不能只放在 'upgrade' 回调里：
  // 若客户端在上游回 101 **之前**就走了，这个挂起中的 upstream 请求没有任何人中止，
  // 它会连着自己的 socket 一直挂着（代理侧泄漏；实测会让持有它的进程无法干净退出）。
  // upgraded 标记用于区分「已交出 socket」与「仍在等 101」——升级成功后 socket 归 upSocket，
  // 此时再 destroy upstream 反而会把刚建立的隧道拆掉。
  let closed = false;
  let upgraded = false;
  let upSocket = null;
  const teardown = () => {
    if (closed) return;
    closed = true;
    if (!upgraded) upstream.destroy();
    upSocket?.destroy();
    socket.destroy();
  };
  socket.on('close', teardown);
  upstream.on('upgrade', (upRes, upSocketIn, upHead) => {
    // 对端（浏览器 / SSH 隧道）可能在升级握手中途断开：此时向已关闭的 socket 写入会抛 EPIPE。
    // 若不挂 error 监听，EPIPE 会以 uncaughtException 打穿整个 hwb 进程——曾在写响应头时
    // （@proxy.js:103）触发并连带杀掉本地 dsh web 子进程（见 hwb.log 14:53:26 uncaughtException）。
    // 连接没了本就不该崩，这里是代理最常见的退化路径：吞掉 error、静默拆除即可。
    upgraded = true;
    upSocket = upSocketIn;
    if (closed) { upSocket.destroy(); return; }
    upSocket.on('close', teardown);
    upSocket.on('error', noop);
    const safeWrite = (sock, chunk) => {
      if (closed) return;
      try { sock.write(chunk); } catch { teardown(); }
    };
    // 回写 101 + 上游响应头,再双向 pipe。
    safeWrite(socket, 'HTTP/1.1 101 Switching Protocols\r\n');
    const rHeaders = upRes.rawHeaders;
    for (let i = 0; i < rHeaders.length; i += 2) safeWrite(socket, `${rHeaders[i]}: ${rHeaders[i + 1]}\r\n`);
    safeWrite(socket, '\r\n');
    if (upHead && upHead.length) safeWrite(upSocket, upHead);
    upSocket.pipe(socket);
    socket.pipe(upSocket);
  });
  upstream.on('response', () => teardown());
  upstream.on('error', () => teardown());
  upstream.end();
}
