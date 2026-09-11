import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createRouter } from './routes.js';
import { logger } from '../lib/logger.js';

const log = logger('api');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

async function serveStatic(webRoot, pathname, req, res) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.normalize(path.join(webRoot, rel));
  if (!file.startsWith(webRoot + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' }).end('forbidden');
    return;
  }
  try {
    const [body, s] = await Promise.all([readFile(file), stat(file)]);
    // 工作台静态资源（index.html / app.js / 组件模块）以固定、无哈希路径直接提供。
    // 既然文件名不带内容哈希，就不能用 max-age 长缓存（改源码后浏览器会拿到陈旧副本），
    // 因此走「no-cache + 强 revalidate」：每次加载都会向服务端重新验证，命中 304 只回状态不回 body；
    // 文件一旦改动（大小/mtime 变化 → ETag 变化 → 无 If-None-Match 匹配）就返回全新内容。
    // 这保证刷新后立刻看到改动，同时不重复传输未变化的资源。反代(proxy.js)只透传 dsh web 上游头，
    // 与本静态服务无关。
    const mtype = MIME[path.extname(file)] ?? 'application/octet-stream';
    const etag = `W/"${s.size}-${Math.round(s.mtimeMs)}"`;
    const lm = s.mtime.toUTCString();
    const base = { 'Content-Type': mtype, 'Cache-Control': 'no-cache', ETag: etag, 'Last-Modified': lm };
    // 条件请求：If-None-Match 命中 → 304；退而求其次用 If-Modified-Since（秒级，忽略 sub-ms 误差）。
    if (req.headers['if-none-match'] === etag
        || (req.headers['if-modified-since'] && new Date(req.headers['if-modified-since']).getTime() >= Math.floor(s.mtimeMs / 1000) * 1000)) {
      res.writeHead(304, base);
      res.end();
      return;
    }
    res.writeHead(200, base);
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' }).end('not found');
  }
}

// Listens on 127.0.0.1 only, no auth (§11).
// API 只接受回环地址的 Host —— DNS rebinding 防护。
//
// 「只监听 127.0.0.1 + 无鉴权」并不足以限定谁能访问：攻击者可以把自己的域名解析到 127.0.0.1，
// 让受害者的浏览器直接连上本机端口。此时请求里 Host 与 Origin 都是攻击者的域名、
// Sec-Fetch-Site 甚至是 same-origin，所以 routes.js 里那套同源检查会**全部通过**
// （它比较的两个值都由攻击者控制）。唯一能区分「本机页面」与「rebinding 页面」的信号就是
// Host 是否指向回环地址本身。
//
// 实测影响面（未加此校验时）：跨站页面可读到 GET /api/homes 返回的 dsh token 与本地路径、
// 经 preview/download 读取工作区文件、并经 upload 写入文件。
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * 解析 Host 头里的主机名（去掉端口与 IPv6 方括号）。
 */
export function hostNameOf(hostHeader) {
  const raw = String(hostHeader ?? '').trim();
  if (!raw) return '';
  return (raw.startsWith('[') && raw.includes(']') ? raw.slice(1, raw.indexOf(']')) : raw.split(':')[0]).toLowerCase();
}

/**
 * 该 Host 是否允许访问 API。
 *
 * 默认只允许回环地址（DNS rebinding 防护）。`extraAllowed` 是显式的逃生口：
 * /etc/hosts 别名、devcontainer/Codespaces 的转发域名、以及会保留浏览器 authority 的反代，
 * 都会让 Host 不是回环名 —— 那时 SPA 能加载但每个 /api/* 都 403，且没有任何办法自证是本人。
 * 通过 `HWB_ALLOWED_HOSTS=a.example,b.example` 或创建服务器时的 `allowedHosts` 显式放行，
 * 同时把安全后果写清楚（放行等于允许该主机名来源的页面访问本地 API）。
 */
export function isLoopbackHost(hostHeader, extraAllowed = []) {
  const hostname = hostNameOf(hostHeader);
  if (!hostname) return false;
  if (LOOPBACK_HOSTNAMES.has(hostname)) return true;
  return extraAllowed.some((allowed) => String(allowed ?? '').trim().toLowerCase() === hostname);
}

/** 从 `HWB_ALLOWED_HOSTS`（逗号分隔）读逃生口列表。 */
export function allowedHostsFromEnv(env = process.env) {
  return String(env.HWB_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function createApiServer({ store, indexer, hub, launcher, monitor, quota, logApi, webRoot, allowedHosts = [], remoteExec, usageTtlMs }) {
  const route = createRouter({ store, indexer, hub, launcher, monitor, quota, logApi, remoteExec, usageTtlMs });
  return createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname.startsWith('/api/')) {
      // 所有 /api/* 响应统一带 no-store：这些 JSON 里有实例元数据、会话标题、错误上下文，
      // 而这个 API 无鉴权（回环 != 只有你能访问）。preview/download 早就单独设了 no-store，
      // 其余路由此前一条都没有 —— 浏览器 HTTP 缓存或前面的反代都可能把它留下来。
      // 同时给 nosniff：JSON 响应被当成别的类型解析是额外风险。
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      // HEAD 落到与 GET 同一条路由：路由只匹配 `method === 'GET'`，于是 `curl -I /api/homes`
      // 会 404 —— 任何基于 HEAD 的健康检查都会认为 API 挂了。Node 对 HEAD 会自动不写 body，
      // 所以这里把方法改成 GET 交给同一套逻辑即可（用副本，不改原对象以免影响后续日志/判断）。
      if (req.method === 'HEAD') req.method = 'GET';
      if (!isLoopbackHost(req.headers.host, allowedHosts)) {
        log.warn('拒绝非回环 Host 的 API 请求（疑似 DNS rebinding）', { host: req.headers.host, path: url.pathname });
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'API 仅接受来自本机回环地址的请求' }));
        return;
      }
      route(req, res, url).catch((e) => {
        // API 处理抛错：记录请求路径 + 错误栈，返回 500；前端能拿到 message，日志能还原根因。
        log.error('API 请求处理失败', e, { method: req.method, path: url.pathname });
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      });
      return;
    }
    serveStatic(webRoot, url.pathname, req, res);
  });
}
