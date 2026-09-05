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
    res.writeHead(403).end('forbidden');
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
    res.writeHead(404).end('not found');
  }
}

// Listens on 127.0.0.1 only, no auth (§11).
export function createApiServer({ store, indexer, hub, launcher, monitor, quota, logApi, webRoot }) {
  const route = createRouter({ store, indexer, hub, launcher, monitor, quota, logApi });
  return createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname.startsWith('/api/')) {
      route(req, res, url).catch((e) => {
        // API 处理抛错：记录请求路径 + 错误栈，返回 500；前端能拿到 message，日志能还原根因。
        log.error('API 请求处理失败', e, { method: req.method, path: url.pathname });
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      });
      return;
    }
    serveStatic(webRoot, url.pathname, req, res);
  });
}
