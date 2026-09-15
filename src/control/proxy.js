import { addWorkspaceFinderMenu } from './workspace-menu.js';
import {
  classifyRpc, classifyStatic, createProxyCache, isHistoryRpc, rewriteRpcEnvelope, rpcIdOf, storableResponse,
  RPC_REQUEST_BODY_CAP,
} from './proxy-cache.js';
import { buildHistoryBody, deltaRequestBody, historyRequestOf, mergeWindows, windowOf } from './proxy-history.js';
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

// Limit concurrent ordinary HTTP requests to avoid saturating slow links.
// SSE responses leave this pool once their headers arrive: a live event stream
// must not reserve one of the slots needed by page, plugin and auth requests.
// sshd MaxSessions limits shell/subsystem sessions, not direct-tcpip forwarding.
const UPSTREAM_MAX_SOCKETS = envInt('HWB_PROXY_MAX_SOCKETS', 3);
const UPSTREAM_MAX_UPGRADES = envInt('HWB_PROXY_MAX_UPGRADES', 2);

function envInt(name, fallback) {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// —— 增量历史（dsh-history-delta 插件）支持度 ——
// 每个实例（cacheScope）记一次：成功 → true 一直用；404/405/415 → false，10 分钟内不再试
// （免得每打开一个会话都白打一条注定 404 的请求）。未知 = 试一次。
const DELTA_ENDPOINT = '/api/histdelta/history';
const DELTA_NEGATIVE_TTL_MS = 10 * 60_000;
const deltaSupport = new Map();   // scope -> { ok, at }

// 默认关闭：真机（隔离实例）上这条路径目前会拿到 404（同一请求用 curl/node 直连同一 URL 却是 200，
// 尚未定位），虽然会安全回退成整段请求，但在查清之前不让它默认改变线上行为。
// 打开：HWB_HISTORY_DELTA=1
export const HISTORY_DELTA_ENABLED = ['1', 'true', 'yes', 'on'].includes(String(process.env.HWB_HISTORY_DELTA ?? '').toLowerCase());

function deltaSupported(scope, now = Date.now()) {
  const hit = deltaSupport.get(scope);
  if (!hit) return null;
  if (hit.ok) return true;
  return now - hit.at > DELTA_NEGATIVE_TTL_MS ? null : false;
}
function noteDeltaSupport(scope, ok) { deltaSupport.set(scope, { ok, at: Date.now() }); }

// —— 本地读取缓存（见 proxy-cache.js 顶部的实测依据）——
//
// 进程级单例：所有实例的代理共用一份（键里带 cacheScope，不会串台），落盘在 ~/.hwb/proxy-cache，
// 于是 hwb 重启后仍然命中。`HWB_PROXY_CACHE=0` 关闭（退化为纯透传）。
const CACHE_ENABLED = !['0', 'false', 'no', 'off'].includes(String(process.env.HWB_PROXY_CACHE ?? '').toLowerCase());
let sharedCache = null;
export function sharedProxyCache() {
  if (!CACHE_ENABLED) return null;
  sharedCache ||= createProxyCache();
  return sharedCache;
}

/**
 * 创建一个指向 target 的根路径 HTTP 反向代理。
 * @param {{ target: string, host?: string }} opts
 *   target 形如 `http://127.0.0.1:<dshport>`（本地）或 `http://127.0.0.1:<tunnel>)(远程隧道)。
 * @returns {Promise<{ server, port, url, close }>}
 */
export function createProxy({ target, host = '127.0.0.1', preview = false, port: listenPort = 0, requestTimeoutMs = envInt('HWB_PROXY_REQUEST_TIMEOUT_MS', 30_000), cache = undefined, cacheScope = '', historyDelta = HISTORY_DELTA_ENABLED }) {
  const cacheStore = cache === undefined ? sharedProxyCache() : cache;
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
    // 缓存作用域：调用方（launcher）给 homeId 时用它 —— 远程实例每次重连都会换一个随机隧道口，
    // 用端口做键等于永不命中。没给就用初始目标 authority（测试/临时代理各用各的，不会串台）。
    const scope = cacheScope || `${targetUrl.hostname}:${targetUrl.port}`;

    // 本代理自己的上游连接池（见上方注释）：上限决定这条链路上会占用几个 ssh channel。
    const httpPool = new http.Agent({ keepAlive: true, maxSockets: UPSTREAM_MAX_SOCKETS, maxFreeSockets: UPSTREAM_MAX_SOCKETS });
    const assetPool = new http.Agent({ keepAlive: true, maxSockets: UPSTREAM_MAX_SOCKETS, maxFreeSockets: UPSTREAM_MAX_SOCKETS });
    const upgradePool = new http.Agent({ keepAlive: false, maxSockets: UPSTREAM_MAX_UPGRADES });

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
      // Large plugin downloads must not queue auth, health checks or RPC behind them.
      const asset = /^(?:\/assets\/|\/plugins\/.*\.(?:js|css)(?:[?&]|$))/.test(req.url);
      forwardRequest(req, res, targetUrl.hostname, Number(targetUrl.port), preview,
        asset ? assetPool : httpPool, asset ? Math.max(requestTimeoutMs, 120_000) : requestTimeoutMs,
        cacheStore, scope, historyDelta);
    });
    const sockets = new Set();
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server.on('upgrade', (req, socket, head) => forwardUpgrade(req, socket, head, targetUrl.hostname, Number(targetUrl.port), upgradePool));
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
          httpPool.destroy();
          assetPool.destroy();
          upgradePool.destroy();
        },
        close: () => new Promise((r) => {
          server.close(() => r());
          for (const socket of sockets) socket.destroy();
          // 释放池里的空闲上游连接：它们是真实的 ssh channel，留着就是白占远端的 MaxSessions 名额。
          httpPool.destroy();
          assetPool.destroy();
          upgradePool.destroy();
        }),
      });
    });
  });
}

// —— 上游瞬时失败重试（2026-09-14）——
//
// 背景（实测）：经 dgx21.tun 的隧道带宽很差（25 KB/s 量级），dsh 前端启动时要并发拉约 10 个
// 插件 bundle。浏览器（无头 Chrome，CDP 抓包）实测：其中若干个会拿到 hwb 代理的
// `proxy: upstream error — socket hang up`（502），而同一个 URL 随后用 curl 单发又是 200。
// 插件加载器对**任何一次**失败都会整体报 "Failed to load plugins" → 整个 UI 打不开，
// 而浏览器自己不会重试。因此在代理这一层补一次重试：
//   · 只对 GET / HEAD（无请求体、无副作用）——POST 的 /api/rpc 之类绝不动；
//   · 只在上游**连接阶段**失败、且还没往客户端写出任何字节（!headersSent）时；
//   · 至多一次，间隔 UPSTREAM_RETRY_DELAY_MS，让瞬时拥塞过去；
//   · 客户端已断开（req.destroyed / res 已 close）时不重试，避免空转。
const UPSTREAM_MAX_ATTEMPTS = 2;
const UPSTREAM_RETRY_DELAY_MS = 150;

// 转发普通请求(含 SSE——Node 会按 chunk 流式回传)。
function forwardRequest(req, res, hostname, port, preview, agent = undefined, requestTimeoutMs = 30_000, cache = null, cacheScope = '', historyDelta = false) {
  const headers = { ...req.headers };
  // 去掉逐跳(hop-by-hop)头,避免连接语义混乱;Host 保留(浏览器访问代理的 Host)。
  for (const h of ['proxy-connection', 'keep-alive', 'connection']) delete headers[h];

  const workspaceScript = preview && req.method === 'GET' && req.url.startsWith('/plugins/') && req.url.includes('dsh-client-ui-workspace');
  const inject = preview && req.method === 'GET' && new URL(req.url, 'http://localhost').pathname === '/';
  // 被注入改造过的响应（index.html、workspace bundle 菜单）不能进缓存：它们与 preview 绑定，
  // 而同一实例的普通代理拿到的应是**未注入**的原文。
  const injectable = inject || workspaceScript;
  if (injectable) {
    headers['accept-encoding'] = 'identity';
    delete headers['if-none-match'];
    delete headers['if-modified-since'];
  }

  const retryable = req.method === 'GET' || req.method === 'HEAD';
  let attempt = 0;
  let upstream = null;
  // 客户端断开 → 掐掉当前上游连接（重试后 upstream 已换新，故用闭包变量而非固定引用）。
  let retryTimer = null;
  let headerTimer = null;
  res.on('close', () => {
    clearTimeout(retryTimer);
    clearTimeout(headerTimer);
    upstream?.destroy();
  });

  // 静态（内容寻址）读取：命中就直接本地回，一个字节都不走隧道。
  // 注意 plan 对「注入路径」也算出来：那份缓存存的是**未注入**的原文，注入在本地做
  // （dgx21 上 workspace bundle 有 115 KB，每次都从远端取等于每次多等约 4 s）。
  const staticPlan = cache ? cachePlan(cache, cacheScope, classifyStatic(req.method, req.url)) : null;
  if (staticPlan && !injectable && serveCached(req, res, cache, staticPlan)) return;
  if (staticPlan && workspaceScript && serveInjectedFromCache(req, res, cache, staticPlan)) return;

  // 只读 RPC：键要等请求体到手才算得出来（信封里有 method/payload）。请求体超过上限时不缓存并透传。
  if (cache && !injectable && req.method === 'POST' && req.url.startsWith('/api/')) {
    collectBody(req, RPC_REQUEST_BODY_CAP, (body, overflow) => {
      const plan = overflow ? null : cachePlan(cache, cacheScope, classifyRpc(req.method, req.url, body));
      if (plan) {
        plan.body = body;   // 后台刷新时要用同一份请求体重发
        if (serveCached(req, res, cache, plan, { rpcId: rpcIdOf(body) })) return;
        // 本地副本已经过期但还在：试一次「增量补差」（需要 dsh-history-delta 插件）。
        // 失败/不支持时原样回退成整段请求 —— 这条路径只可能是「更省」，不该是「更差」。
        if (historyDelta && isHistoryRpc(plan.rpcMethod)) {
          tryIncremental(plan, body, overflow);
          return;
        }
      }
      send({ plan, body, streaming: overflow });
    });
    return;
  }

  // 注入路径**不能**走可缓存响应处理器（那会把未注入的原文直接发给浏览器）；
  // 它的存/取都由上面的 serveInjectedFromCache + 注入分支负责。
  send({ plan: injectable ? null : staticPlan, body: null, streaming: true });

  function send({ plan, body = null, streaming = false }) {
    // 要缓存的响应必须拿到未压缩的字节：否则回放时还得逐字节复刻同一份 content-encoding。
    if (plan) {
      headers['accept-encoding'] = 'identity';
      delete headers['if-none-match'];
      delete headers['if-modified-since'];
    }
    const sendOnce = () => {
      if (res.destroyed || res.writableEnded) return;
      attempt += 1;
      upstream = http.request({
        hostname,
        port,
        path: req.url,
        method: req.method,
        headers,
        agent,
      }, plan ? onCacheableResponse(plan) : onResponse);
      // Include time queued for an Agent socket; socket timeouts alone miss it.
      headerTimer = setTimeout(() => {
        upstream.destroy(Object.assign(new Error('upstream response timeout'), { code: 'ETIMEDOUT' }));
      }, requestTimeoutMs);
      headerTimer.unref?.();
      upstream.setTimeout(requestTimeoutMs, () => {
        upstream.destroy(Object.assign(new Error('upstream idle timeout'), { code: 'ETIMEDOUT' }));
      });
      upstream.on('error', (e) => {
        clearTimeout(headerTimer);
        // 上游（dsh web 或 ssh 隧道）不可达/断开：记录上下文，便于定位健康检查失败原因。
        log.debug('代理上游请求失败', e, { target: `${hostname}:${port}`, path: req.url, attempt });
        // 客户端是否还在：看 **响应** 侧，不能用 req.destroyed —— GET 的请求体读完就被 Node
        // 自动销毁（autoDestroy），拿它当「客户端断开」判据会让重试永远不触发（实测踩到）。
        const canRetry = retryable && attempt < UPSTREAM_MAX_ATTEMPTS
          && !res.headersSent && !res.writableEnded && !res.destroyed;
        if (canRetry) {
          log.info('上游瞬时失败，重试一次', { target: `${hostname}:${port}`, path: req.url, error: e.message });
          retryTimer = setTimeout(sendOnce, UPSTREAM_RETRY_DELAY_MS);
          retryTimer.unref?.();
          return;
        }
        if (res.destroyed) return;
        if (res.headersSent) { res.destroy(e); return; }
        res.writeHead(e.code === 'ETIMEDOUT' ? 504 : 502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`proxy: upstream error — ${e.message}`);
      });
      if (body && body.length) upstream.write(body);
      if (streaming) req.pipe(upstream);
      else upstream.end();
    };
    sendOnce();
  }

  // 增量补差：拿本地窗口的最后一个 seq，向插件通道要「缺的那一段」，拼成与整段重取逐条相同的窗口。
  // 任何一步不成立就回退整段（send）—— 包括：没有本地窗口、请求是往回翻页、插件不在、
  // 插件回的窗口与本地副本不连续、插件报错。拼接前提见 proxy-history.js。
  // 向插件通道要增量并与本地窗口拼好；成功返回 { body, events, deltaBytes }，任何一步不成立返回 null。
  function fetchAndMergeDelta({ plan, cached, sessionId, maxMessages, rpcId, template, scope }) {
    if (deltaSupported(scope) === false) return Promise.resolve(null);
    const deltaBody = deltaRequestBody({ sessionId, maxMessages, rpcId, afterSeq: cached.lastSeq });
    const deltaHeaders = { ...headers, 'content-type': 'application/json', 'content-length': String(deltaBody.length) };
    delete deltaHeaders['if-none-match'];
    delete deltaHeaders['if-modified-since'];
    return new Promise((resolvePromise) => {
      let done = false;
      const finish = (value) => { if (!done) { done = true; resolvePromise(value); } };
      const upstreamDelta = http.request({ hostname, port, path: DELTA_ENDPOINT, method: 'POST', headers: deltaHeaders, agent }, (upRes) => {
        const chunks = [];
        let size = 0;
        upRes.on('data', (chunk) => {
          size += chunk.length;
          if (size > 32 * 1024 * 1024) { upRes.destroy(new Error('histdelta too large')); return; }
          chunks.push(chunk);
        });
        upRes.on('error', () => finish(null));
        upRes.on('end', () => {
          if ([404, 405, 415, 501].includes(upRes.statusCode)) { noteDeltaSupport(scope, false); finish(null); return; }
          if (upRes.statusCode !== 200) { finish(null); return; }
          const raw = Buffer.concat(chunks);
          const delta = windowOf(raw);
          if (!delta || !Number.isInteger(delta.value?.windowFirstSeq) || !Number.isInteger(delta.value?.windowLastSeq)) {
            noteDeltaSupport(scope, false);      // 端点存在但不是我们的插件
            finish(null);
            return;
          }
          const merged = mergeWindows(cached, { ...delta, windowFirstSeq: delta.value.windowFirstSeq, windowLastSeq: delta.value.windowLastSeq });
          if (!merged) { finish(null); return; }
          const outBody = buildHistoryBody(template, merged, rpcId);
          if (!outBody) { finish(null); return; }
          noteDeltaSupport(scope, true);
          finish({ body: outBody, merged, deltaBytes: raw.length, deltaEvents: delta.events.length });
        });
      });
      upstreamDelta.setTimeout(requestTimeoutMs, () => upstreamDelta.destroy(Object.assign(new Error('histdelta timeout'), { code: 'ETIMEDOUT' })));
      upstreamDelta.on('error', () => finish(null));
      upstreamDelta.end(deltaBody);
    });
  }

  function tryIncremental(plan, body, overflow) {
    const scope = cacheScope || 'default';
    const fallback = () => send({ plan, body, streaming: overflow });
    const entry = cache.read(plan.key);
    const cached = entry ? windowOf(entry.body) : null;
    const request = historyRequestOf(body);
    if (!cached || !request) { fallback(); return; }
    fetchAndMergeDelta({
      plan,
      cached,
      sessionId: request.sessionId,
      maxMessages: request.maxMessages,
      rpcId: request.rpcId ?? rpcIdOf(body),
      template: entry.body,
      scope,
    }).then((merged) => {
      if (!merged) { fallback(); return; }                          // 不连续/插件不在：整段重取
      cache.write(plan.key, {
        body: merged.body,
        contentType: 'application/json; charset=utf-8',
        kind: plan.kind,
        ttlMs: plan.ttlMs ?? null,
        staleMs: plan.staleMs ?? null,
        sessionId: plan.sessionId ?? null,
        rpcMethod: plan.rpcMethod ?? null,
      });
      log.debug('会话历史走增量补差', {
        sessionId: plan.sessionId,
        afterSeq: cached.lastSeq,
        deltaBytes: merged.deltaBytes,
        events: `${merged.deltaEvents} 条增量 → 合并 ${merged.merged.events.length} 条`,
      });
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(merged.body.length),
        'cache-control': 'no-store',
        'x-hwb-cache': 'rpc-delta',
      });
      res.end(req.method === 'HEAD' ? undefined : merged.body);
    });
  }

  // 缓存命中时把本地副本写出去。返回 true = 这个请求已经处理完。
  function serveCached(clientReq, clientRes, store, plan, { rpcId = null } = {}) {
    const entry = store.read(plan.key);
    if (!entry) { store.noteMiss(); return false; }
    const freshness = store.freshness(entry, plan.kind);
    if (freshness === 'expired') { store.noteMiss(); return false; }
    store.noteHit(entry, plan.kind, freshness === 'stale');
    // 陈旧但仍在宽限窗口内：先用本地副本回（用户不等），再去后台拉一次。
    if (freshness === 'stale') {
      const info = plan.body ? historyRequestOf(plan.body) : null;
      const tryDelta = (historyDelta && isHistoryRpc(plan.rpcMethod) && info && entry)
        ? () => fetchAndMergeDelta({
          plan,
          cached: windowOf(entry.body),
          sessionId: info.sessionId,
          maxMessages: info.maxMessages,
          rpcId: info.rpcId ?? null,
          template: entry.body,
          scope: cacheScope || 'default',
        }).then((merged) => merged?.body ?? null)
        : null;
      refreshInBackground(store, plan, { hostname, port, headers, method: clientReq.method, url: clientReq.url, body: plan.body ?? null, agent, requestTimeoutMs, tryDelta });
    }
    const hitHeader = {
      static: freshness === 'stale' ? 'stale' : 'hit',
      rpc: freshness === 'stale' ? 'rpc-stale' : 'rpc-hit',
    }[plan.kind];

    if (plan.kind === 'rpc') {
      const bodyOut = rewriteRpcEnvelope(entry.body, rpcId);
      // 命中也要喂「会话是否在跑」这个索引：历史缓存的长 TTL 就靠它区分
      // 「已结束（不可变）」与「正在跑（会变）」。只喂写入路径的话，一次缓存命中就会让
      // 索引停在旧值上，于是一个已经恢复运行的会话仍被当成不可变。
      // 只有**新鲜**命中才刷新「是否在跑」的观测：陈旧副本里的状态不该冒充刚确认过。
      store.noteSessionList?.(bodyOut, { fresh: freshness === 'fresh' });
      clientRes.writeHead(200, {
        'content-type': entry.contentType || 'application/json; charset=utf-8',
        'content-length': String(bodyOut.length),
        'cache-control': 'no-store',
        'x-hwb-cache': hitHeader,
      });
      clientRes.end(clientReq.method === 'HEAD' ? undefined : bodyOut);
      return true;
    }

    // 静态：URL 自带内容指纹，命中就是命中；但要给浏览器一个可回校验的 ETag，
    // 否则它下次仍然只能整包重下（这正是远端 dsh `no-cache` 且无校验器时的病根）。
    // 上游本来就给了 ETag 就直接沿用（`sourceEtag`），两种校验器都接受。
    const ttlSec = Math.max(1, Math.floor((plan.ttlMs ?? 600_000) / 1000));
    const validators = new Set([entry.etag, entry.sourceEtag].filter(Boolean));
    const inm = clientReq.headers['if-none-match'];
    if (inm && validators.has(inm)) {
      const matched = inm === entry.sourceEtag ? entry.sourceEtag : entry.etag;
      clientRes.writeHead(304, { etag: matched, 'cache-control': entry.cacheControl ?? `private, max-age=${ttlSec}`, 'x-hwb-cache': hitHeader });
      clientRes.end();
      return true;
    }
    clientRes.writeHead(200, {
      'content-type': entry.contentType || 'application/octet-stream',
      'content-length': String(entry.body.length),
      etag: entry.sourceEtag ?? entry.etag,
      ...(entry.cacheControl ? { 'cache-control': entry.cacheControl } : {}),
      'x-hwb-cache': hitHeader,
    });
    clientRes.end(clientReq.method === 'HEAD' ? undefined : entry.body);
    return true;
  }

  // 注入路径（preview 专属）的本地命中：拿缓存里的原文在本地注入后回出去。
  // 这里**不能**直接把原文发给浏览器（那会丢掉「在 Finder 中打开工作区」菜单项），
  // 所以仍然标 no-store：它是按代理改过的内容，只属于这条 preview 链路。
  function serveInjectedFromCache(clientReq, clientRes, store, plan) {
    const entry = store.read(plan.key);
    if (!entry) return false;
    const freshness = store.freshness(entry, plan.kind);
    if (freshness === 'expired') return false;
    store.noteHit(entry, plan.kind, freshness === 'stale');
    if (freshness === 'stale') {
      refreshInBackground(store, plan, { hostname, port, headers, method: clientReq.method, url: clientReq.url, body: null, agent, requestTimeoutMs });
    }
    const injected = addWorkspaceFinderMenu(entry.body.toString('utf8'));
    clientRes.writeHead(200, {
      'content-type': entry.contentType || 'text/javascript; charset=utf-8',
      'cache-control': 'no-store',
      'x-hwb-cache': freshness === 'stale' ? 'stale' : 'hit',
    });
    clientRes.end(clientReq.method === 'HEAD' ? undefined : injected);
    return true;
  }

  // 可缓存响应的包装：先攒一份（有上限），攒完再写头 —— 这样第一次响应也能带上 ETag，
  // 于是浏览器下次刷新只需要一次 304（几十字节），而不是把整包再下一遍。
  function onCacheableResponse(plan) {
    return (upRes) => {
      clearTimeout(headerTimer);
      const upstreamHeaders = staticResponseHeaders(req, upRes);
      const keep = upRes.statusCode === 200
        && !upRes.headers['set-cookie']
        && !(upRes.headers.vary ?? '').split(',').some((v) => v.trim() === '*')
        && !/no-store/i.test(upRes.headers['cache-control'] ?? '')
        && !/^text\/event-stream/i.test(upRes.headers['content-type'] || '');
      let headersWritten = false;
      const writeHeaders = (etag, length) => {
        if (headersWritten) return;
        headersWritten = true;
        const out = { ...upstreamHeaders };
        delete out['transfer-encoding'];
        // 只**补**一个校验器，不改动已有策略：上游/既有规则说了 immutable 就保持 immutable，
        // 说了 no-cache 就保持 no-cache（那种情况下 ETag 才是真正救命的东西 —— 浏览器下次
        // 会带 If-None-Match 回来，我们在本地回 304，一个字节都不用走隧道）。
        if (etag && !out.etag) out.etag = etag;
        if (Number.isInteger(length)) out['content-length'] = String(length);
        else delete out['content-length'];
        res.writeHead(upRes.statusCode, out);
        res.flushHeaders();
      };
      upRes.on('error', (error) => res.destroy(error));

      if (!keep) {
        writeHeaders(null, null);
        upRes.pipe(res);
        return;
      }

      const limit = plan.maxEntryBytes ?? 32 * 1024 * 1024;

      // 只读 RPC（会话历史就是最大的那种：实测一个会话 8–10 MiB）**立刻发头、边流边攒**。
      // 若先攒完再发头，30 s 的「响应头超时」会把整次请求打成 504 —— 实测 dgx21 打开大历史
      // 会话就是 `proxy: upstream error — upstream response timeout`，用户根本拿不到历史。
      // RPC 也不需要给浏览器 ETag（它不是浏览器缓存的载荷），所以没有攒完再发的理由。
      if (plan.kind === 'rpc') {
        writeHeaders(null, null);
        const rpcChunks = [];
        let rpcSize = 0;
        let rpcOverflow = false;
        upRes.on('data', (chunk) => {
          res.write(chunk);
          if (rpcOverflow) return;
          rpcSize += chunk.length;
          if (rpcSize > limit) { rpcOverflow = true; rpcChunks.length = 0; return; }
          rpcChunks.push(chunk);
        });
        upRes.on('end', () => {
          if (!rpcOverflow && rpcChunks.length) {
            const body = Buffer.concat(rpcChunks);
            if (storableResponse(upRes.statusCode, upRes.headers, body)) {
              cache.write(plan.key, {
                body,
                contentType: upRes.headers['content-type'],
                kind: plan.kind,
                sourceEtag: upRes.headers.etag ?? null,
                ttlMs: plan.ttlMs ?? null,
                staleMs: plan.staleMs ?? null,
                sessionId: plan.sessionId ?? null,
                rpcMethod: plan.rpcMethod ?? null,
              });
            }
          }
          res.end();
        });
        return;
      }

      const chunks = [];
      let size = 0;
      let overflowed = false;
      upRes.on('data', (chunk) => {
        if (overflowed) { res.write(chunk); return; }
        chunks.push(chunk);
        size += chunk.length;
        if (size > limit) {
          // 超过缓存上限：放弃缓存，但**已经收到的字节一个都不能丢**（否则 content-length 对不上，
          // 上游/客户端会一直等一个永远不来的结尾）。
          overflowed = true;
          writeHeaders(null, null);
          for (const c of chunks) res.write(c);
          chunks.length = 0;
        }
      });
      upRes.on('end', () => {
        if (overflowed) { res.end(); return; }
        const body = Buffer.concat(chunks);
        const storable = storableResponse(upRes.statusCode, upRes.headers, body);
        const entry = storable
          ? cache.write(plan.key, {
            body,
            contentType: upRes.headers['content-type'],
            kind: plan.kind,
            sourceEtag: upRes.headers.etag ?? null,
            // 回放时要原样复述这次给浏览器的缓存策略（immutable / no-cache 都不能丢）。
            cacheControl: upstreamHeaders['cache-control'] ?? null,
            ttlMs: plan.ttlMs ?? null,
            staleMs: plan.staleMs ?? null,
            sessionId: plan.sessionId ?? null,
            rpcMethod: plan.rpcMethod ?? null,
          })
          : null;
        writeHeaders(entry?.etag ?? null, body.length);
        res.end(req.method === 'HEAD' ? undefined : body);
      });
    };
  }

  function onResponse(upRes) {
    clearTimeout(headerTimer);
    if (/^text\/event-stream(?:;|$)/i.test(upRes.headers['content-type'] || '')) {
      upstream.setTimeout(0);
      // Node removes this socket from the Agent and services queued requests.
      // Its lifetime remains tied to res.close, so detached streams are cleaned up.
      upRes.socket?.emit('agentRemove');
    }
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
          // 先把**原文**存进缓存（注入是在本地做的，所以这份副本对普通代理同样有效）。
          if (staticPlan && storableResponse(200, upRes.headers, body)) {
            cache.write(staticPlan.key, { body, contentType: upRes.headers['content-type'], kind: staticPlan.kind, sourceEtag: upRes.headers.etag ?? null, ttlMs: staticPlan.ttlMs ?? null, staleMs: staticPlan.staleMs ?? null });
          }
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
    upRes.on('error', (error) => res.destroy(error));
    res.writeHead(upRes.statusCode, staticResponseHeaders(req, upRes));
    res.flushHeaders();
    upRes.pipe(res);
  }
}

// —— 本地缓存辅助（见 proxy-cache.js）——

// 把实例作用域并进缓存键：同一个 hwb 进程托管多个实例/多个 home，键必须隔离。
// 注意用 homeId 而不是隧道端口 —— 远程实例每次重连都会换一个随机隧道口，用端口做键等于永不命中。
function cachePlan(cache, scope, plan) {
  if (!plan) return null;
  // 每条目自带 TTL：历史类（会话事件日志）在会话**已结束**时用长 TTL，正在跑则用短窗口。
  const policy = cache?.policy?.({ kind: plan.kind, rpcMethod: plan.rpcMethod ?? null, sessionId: plan.sessionId ?? null })
    ?? { ttlMs: cache?.ttlMs?.(plan.kind), staleMs: undefined };
  return {
    ...plan,
    key: `${scope || 'default'}|${plan.key}`,
    ttlMs: policy.ttlMs,
    staleMs: policy.staleMs,
    maxEntryBytes: cache?.maxEntryBytes,
  };
}

// 读一个「小请求体」的上限：超过上限就把已读到的部分交回调用方，由它写完后继续 pipe。
// RPC 的信封只有几百字节，但同一条通道上也会走附件上传（可达数百 MB），所以必须有这道闸。
function collectBody(req, cap, done) {
  const chunks = [];
  let size = 0;
  let settled = false;
  const onData = (chunk) => {
    chunks.push(chunk);
    size += chunk.length;
    if (size > cap) {
      // 超限：把**已收到的**（含这一块）交回调用方写出去，剩下的由它继续 pipe。
      // 这里若丢掉触发超限的那一块，上游收到的字节数就会少于 content-length，
      // 它会一直等一个永远不来的结尾（实测：整个请求 30s 后 504）。
      settled = true;
      req.pause();
      req.off('data', onData);
      done(Buffer.concat(chunks), true);
    }
  };
  req.on('data', onData);
  req.on('end', () => {
    if (settled) return;
    settled = true;
    req.off('data', onData);
    done(Buffer.concat(chunks), false);
  });
  req.on('error', () => {
    if (settled) return;
    settled = true;
    req.off('data', onData);
    done(Buffer.alloc(0), true);
  });
}

// 陈旧副本仍在使用时，去上游悄悄拉一份新的。失败只记 debug：旧副本继续可用，
// 用户不该因为一次后台刷新失败而看到空页面。
//
// 同一键的刷新必须单飞（single-flight）：这条链路一次 session.list 要 9 秒量级，
// 而页面会重复发同一个请求 —— 不设闸的话每个陈旧命中都会再压一条上游请求，
// 把本来就很窄的带宽和 ssh channel 名额全吃掉。
const refreshInFlight = new Set();
function refreshInBackground(cache, plan, { hostname, port, headers, method, url, body, agent, requestTimeoutMs, tryDelta = null }) {
  if (refreshInFlight.has(plan.key)) return;
  refreshInFlight.add(plan.key);
  let settled = false;
  const finish = () => { if (!settled) { settled = true; refreshInFlight.delete(plan.key); } };
  // 会话历史的刷新也走增量（装了 dsh-history-delta 时）：否则「陈旧副本被用到」这件事本身
  // 就会触发一次 8–10 MiB 的整段重取 —— 那正是这条链路最贵的动作。
  const doFull = () => {
    // 会话历史的刷新也走增量（装了 dsh-history-delta 时）：否则「陈旧副本被用到」这件事本身
    // 就会触发一次 8–10 MiB 的整段重取 —— 那正是这条链路最贵的动作。
    const doFull = () => {
      const h = { ...headers, 'accept-encoding': 'identity' };
      delete h['if-none-match'];
      delete h['if-modified-since'];
      const refresh = http.request({ hostname, port, path: url, method, headers: h, agent }, (upRes) => {
        if (upRes.statusCode !== 200) { upRes.resume(); upRes.on('end', finish); return; }
        const chunks = [];
        let size = 0;
        let tooLarge = false;
        upRes.on('data', (chunk) => {
          if (tooLarge) return;
          size += chunk.length;
          if (size > (plan.maxEntryBytes ?? 16 * 1024 * 1024)) { tooLarge = true; chunks.length = 0; return; }
          chunks.push(chunk);
        });
        upRes.on('end', () => {
          if (!tooLarge && chunks.length) {
            const fresh = Buffer.concat(chunks);
            if (storableResponse(200, upRes.headers, fresh)) {
              cache.write(plan.key, {
                body: fresh,
                contentType: upRes.headers['content-type'],
                kind: plan.kind,
                sourceEtag: upRes.headers.etag ?? null,
                ttlMs: plan.ttlMs ?? null,
                staleMs: plan.staleMs ?? null,
                sessionId: plan.sessionId ?? null,
                rpcMethod: plan.rpcMethod ?? null,
              });
            }
          }
          finish();
        });
        upRes.on('error', () => { finish(); });
      });
      refresh.setTimeout(requestTimeoutMs, () => refresh.destroy(Object.assign(new Error('cache refresh timeout'), { code: 'ETIMEDOUT' })));
      refresh.on('error', (error) => {
        log.debug('后台刷新失败（保留旧副本）', { path: url, reason: error.message });
        finish();
      });
      if (body && body.length) refresh.write(body);
      refresh.end();
    };
    if (typeof tryDelta === 'function') {
      Promise.resolve().then(tryDelta).then((merged) => {
        if (!merged) { doFull(); return; }
        cache.write(plan.key, {
          body: merged,
          contentType: 'application/json; charset=utf-8',
          kind: plan.kind,
          ttlMs: plan.ttlMs ?? null,
          staleMs: plan.staleMs ?? null,
          sessionId: plan.sessionId ?? null,
          rpcMethod: plan.rpcMethod ?? null,
        });
        log.debug('会话历史后台刷新走增量补差', { sessionId: plan.sessionId, bytes: merged.length });
        finish();
      }).catch(() => doFull());
      return;
    }
    doFull();
  };
  if (typeof tryDelta === 'function') {
    Promise.resolve().then(tryDelta).then((merged) => {
      if (!merged) { doFull(); return; }
      cache.write(plan.key, {
        body: merged,
        contentType: 'application/json; charset=utf-8',
        kind: plan.kind,
        ttlMs: plan.ttlMs ?? null,
        staleMs: plan.staleMs ?? null,
        sessionId: plan.sessionId ?? null,
        rpcMethod: plan.rpcMethod ?? null,
      });
      log.debug('会话历史后台刷新走增量补差', { sessionId: plan.sessionId, bytes: merged.length });
      finish();
    }).catch(() => doFull());
    return;
  }
  doFull();
}

// 转发 WebSocket 升级。
function forwardUpgrade(req, socket, head, hostname, port, agent = undefined) {
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
    agent,
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
