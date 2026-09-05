import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
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
};

async function serveStatic(webRoot, pathname, res) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.normalize(path.join(webRoot, rel));
  if (!file.startsWith(webRoot + path.sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
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
    serveStatic(webRoot, url.pathname, res);
  });
}
