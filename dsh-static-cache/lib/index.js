/**
 * dsh-static-cache — Host 半（webServer 插件）
 *
 * 解决：远程 dsh web 前端静态资源（约 4.5MB，含 index-*.js / vendor-*.js /
 * langs/* 按语言懒加载 chunk）在浏览器端每次打开页面/实例都被重新下载的问题。
 *
 * 做法：在 webServer 上注册一个 /assets/ 前缀路由，带缓存头返回：
 *   Cache-Control: public, max-age=31536000, immutable   —— 资源文件名带 hash(不可变)
 *   配合 ETag / Last-Modified / If-None-Match / If-Modified-Since → 304
 * 其它路径（/、/index.html、/favicon.svg、/manifest.webmanifest、/api/*、
 * WebSocket /api/events.mux）一律不接管，仍走默认 fallback 与其余命名路由，
 * 因此 index 注入和各 API 完全不受影响。
 *
 * dist 目录定位采用多策略自动探测（可在 config.distRoot 显式覆盖）：
 *   1) config.distRoot（若传了最优先）
 *   2) require.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html')
 *   3) 扫描 $HOME/.nvm/versions/node/<版本>/lib/node_modules、execPath 派生的
 *      <...>/lib/node_modules、以及常用全局根下的 nested 与 flat 布局
 * 全部失败会抛出带指引的错误（提示传 config.distRoot）。
 *
 * 安全约束：磁盘路径做 /assets/ 前缀解码 + 越界防护（../ 与绝对路径逃逸均 403）。
 */
import { readFile, stat } from 'node:fs/promises'
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, extname, join, resolve, sep } from 'node:path'

export const name = 'dsh-static-cache'
export const inject = ['webServer']

const CACHE_DIRECTIVE = 'public, max-age=31536000, immutable'
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon'
}

/** 在一个 node_modules 根里找 frontend dist（先嵌套后扁平）。 */
function findFrontendDist(nodeModulesRoot) {
  const am = join(nodeModulesRoot, '@deepseek-ai')
  if (!existsSync(am)) return null
  // 扁平：<root>/@deepseek-ai/dsh-web-frontend/dist
  const flat = join(am, 'dsh-web-frontend', 'dist')
  if (existsSync(join(flat, 'index.html'))) return flat
  // 嵌套：<root>/@deepseek-ai/<dsh>/node_modules/@deepseek-ai/dsh-web-frontend/dist
  for (const entry of readdirSync(am)) {
    if (entry.startsWith('.')) continue
    const cand = join(am, entry, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist')
    if (existsSync(join(cand, 'index.html'))) return cand
  }
  return null
}

/** 收集候选的 node_modules 根（去重）。 */
function collectRoots() {
  const roots = new Set()
  const home = process.env.HOME || ''
  // 1) nvm: $HOME/.nvm/versions/node/*/lib/node_modules
  if (home) {
    const nvm = join(home, '.nvm', 'versions', 'node')
    if (existsSync(nvm)) {
      for (const v of readdirSync(nvm)) {
        roots.add(join(nvm, v, 'lib', 'node_modules'))
      }
    }
  }
  // 2) execPath 派生：<node>/bin/node → <node>/lib/node_modules
  if (process.execPath) {
    roots.add(join(dirname(dirname(process.execPath)), 'lib', 'node_modules'))
  }
  // 3) PATH 里 dsh 派生
  for (const dir of (process.env.PATH || '').split(':')) {
    if (!dir) continue
    const bin = join(dir, 'dsh')
    if (!existsSync(bin)) continue
    try {
      const real = realpathSync(bin) // <dsh>/lib/bin.js
      roots.add(join(dirname(dirname(real)), 'node_modules'))
    } catch { /* 跳过 */ }
  }
  // 4) 常用全局根
  for (const p of ['/usr/lib/node_modules', '/usr/local/lib/node_modules', '/usr/lib64/node_modules']) {
    roots.add(p)
  }
  roots.delete('') // 只保留绝对路径根
  return roots
}

/** 定位前端 dist 目录；hint 为显式覆盖。失败抛错并给指引。 */
function detectDistRoot(hint) {
  if (hint && !existsSync(resolve(hint))) {
    throw new Error(`dsh-static-cache: config.distRoot 不存在（${hint}）`)
  }
  if (hint) return resolve(hint)
  // 策略一：require.resolve（插件与前端同树时最直接）
  try {
    const req = createRequire(import.meta.url)
    const idx = req.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html')
    if (existsSync(idx)) return dirname(idx)
  } catch { /* 走下一步 */ }
  // 策略二：扫描各 node_modules 根
  for (const root of collectRoots()) {
    const r = findFrontendDist(root)
    if (r) return r
  }
  throw new Error(
    'dsh-static-cache: 无法自动定位 @deepseek-ai/dsh-web-frontend/dist。请在该插件行的 config 显式指定 distRoot，例如：\n' +
    '  distRoot: /home/bot/.nvm/versions/node/v24.15.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist'
  )
}

/** 为一个 /assets/* 请求返回带缓存头的静态文件。 */
async function serveAsset(req, res, distRoot) {
  let pathname
  try {
    pathname = new URL(req.url ?? '/', 'http://x').pathname
  } catch {
    res.writeHead(400); res.end(); return
  }
  let rel = pathname
  if (rel.startsWith('/assets/')) rel = rel.slice('/assets/'.length)
  if (rel === '' || rel.includes('..') || rel.includes('\0')) {
    res.writeHead(400); res.end(); return
  }
  // distRoot 为前端 dist 目录，静态资源实际位于其中的 /assets/ 子目录。
  const assetRoot = join(distRoot, 'assets')
  const target = resolve(assetRoot, rel)
  // 越界防护：必须仍在 assetRoot 内
  if (target !== assetRoot && !target.startsWith(assetRoot + sep)) {
    res.writeHead(403); res.end(); return
  }
  let st
  try {
    st = await stat(target)
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EISDIR' || err.code === 'ENOTDIR') {
      res.writeHead(404); res.end(); return
    }
    throw err
  }
  const type = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream'
  const etag = `"${st.mtimeMs.toString(16)}-${st.size.toString(16)}"`
  const lastModified = st.mtime.toUTCString()
  const imod = req.headers['if-none-match']
  const ims = req.headers['if-modified-since']
  if ((typeof imod === 'string' && imod === etag) || (typeof ims === 'string' && ims === lastModified)) {
    res.writeHead(304, {
      etag,
      'last-modified': lastModified,
      'cache-control': CACHE_DIRECTIVE
    })
    res.end()
    return
  }
  const body = await readFile(target)
  res.writeHead(200, {
    'content-type': type,
    'cache-control': CACHE_DIRECTIVE,
    etag,
    'last-modified': lastModified,
    'content-length': body.length
  })
  res.end(body)
}

export function apply(ctx, config) {
  const distRoot = detectDistRoot(config?.distRoot)
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: '/assets/',
      handler: (req, res) => serveAsset(req, res, distRoot)
    }),
    `dsh-static-cache: /assets/ route (${distRoot})`
  )
  ctx.logger?.info?.(`dsh-static-cache: serving /assets/* from ${distRoot} with ${CACHE_DIRECTIVE}`)
}
