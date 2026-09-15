import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../lib/logger.js';
import { serviceDir } from '../lib/service-config.js';

const log = logger('proxy-cache');

// —— dsh web 读取的本地缓存（hwb 代理层）——
//
// 为什么必须有这一层（2026-09-14 实测 dgx21.tun）：
//   · 远端 dsh 0.1.1 给每个插件 bundle 回 `cache-control: no-cache`，**且不带 ETag/Last-Modified**。
//     浏览器因此完全没有校验依据，每次打开页面都必须把这 56 个 bundle（3.27 MiB）重新下载一遍。
//     这条 VPN 链路实测只有 25–30 KB/s ⇒ 每次打开都要 ~2 分钟，且中途任何一个 bundle 超时，
//     插件加载器就整体报 `Failed to load plugins`（浏览器自己不会重试）。
//   · 会话列表与历史走 POST /api/<method> 的 RPC（信封 {type:'client-request',rpcId,method,payload}），
//     POST 在 HTTP 语义上不可缓存，浏览器也永远不会命中任何缓存。
//   · `/assets/*` 由 hwb 注入 immutable（见 proxy.js 的 staticResponseHeaders），这一块一直是好的。
//
// 所以「缓存」只能坐在 hwb 这一层：它本来就是每条链路的唯一咽喉。策略是**只缓存内容寻址的静态资源
// 与只读 RPC**，其余（注入过的 HTML/JS、鉴权响应、任何可能写状态的 RPC）一律不碰：
//
//   static（kind='static'）：GET/HEAD，且 URL 自带内容指纹（`/assets/<name>-<hash8>.<ext>`、
//     `/plugins/**/client.js|.map?rev=<hex8+>`、`/plugins/??…&rev=<hex8+>` 组合脚本）。
//     内容变了 URL 就变，所以「同一 URL 的内容」在事实上是不可变的 —— 这正是它可以被缓存的前提。
//   rpc（kind='rpc'）：POST /api/<只读方法>，键 = 方法 + 规范化后的 payload（不含 rpcId）。
//     只读白名单见 RPC_READ_METHODS；任何写/控制类方法（prompt/create/cancel/control/…）
//     根本不在名单里，因此绝不会被缓存。
//
// 命中后的新鲜度：
//   · fresh（storedAt + ttl 之内）→ 直接本地回，零隧道流量；
//   · stale（ttl 之外、ttl+stale 之内）→ **仍立刻回本地副本**，同时后台拉一次更新缓存
//     （stale-while-revalidate：用户永远不等第二次，慢链路最怕的就是「等」）；
//   · 超出 stale 窗口 → 当作未命中，回源。
//
// 安全性：`set-cookie`、非 200、`vary: *`、超大响应体、任何带 token 的 URL 都不进缓存。
// 落盘（可选）让 hwb 重启后仍然命中 —— hwb 在开发期被反复重启，纯内存缓存等于每次都要重来。

const HEX8 = /^[0-9a-f]{8,}$/i;

function envInt(name, fallback) {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envBool(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(v.toLowerCase());
}

export const DEFAULT_STATIC_TTL_MS = envInt('HWB_PROXY_CACHE_STATIC_TTL_MS', 600_000);
export const DEFAULT_RPC_TTL_MS = envInt('HWB_PROXY_CACHE_RPC_TTL_MS', 3_000);
export const DEFAULT_RPC_STALE_MS = envInt('HWB_PROXY_CACHE_RPC_STALE_MS', 60_000);
// 会话历史（`session.history` 等）是**原始事件日志**：实测 dgx21 上一个会话 50 条消息的窗口
// 就有 8–10 MiB（gzip 后 ~0.5–0.9 MiB，25–30 KB/s 的链路上要 20–35 秒）。而**已结束**的会话
// 历史是不可变的 —— 所以给它一个长 TTL：同一份历史第二次打开就该是本地回。
// 正在跑的会话不行：它的历史还在增长，长 TTL 会让界面停在旧快照上（见 noteSessionList /
// 读取时的 running 降级）。
// 「会话是否在跑」这个观测最多信多久。超过就当作**未知**并按保守档处理 ——
// 磁盘缓存可能带着几天前的条目跨 hwb 重启，拿一个过期观测去批准「长 TTL」正是
// 会让界面停在旧快照上的路径。
const DEFAULT_RUNNING_TRUST_MS = envInt('HWB_PROXY_CACHE_RUNNING_TRUST_MS', 5 * 60_000);
// 正在跑的会话能供多陈旧的副本。默认 **0 = 不供陈旧副本**，原因是实测到的协议事实：
// 事件流 `/api/events.host` 开流时 payload 是 `{}`（没有游标），只推「订阅之后」的新事件；
// 所以一份陈旧的历史窗口补不回中间那段事件，界面会出现静默的空洞。宁可回源。
// （`HWB_PROXY_CACHE_RUNNING_STALE_MS` 可以调大，代价就是上面这个空洞风险。）
function envIntAllowZero(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
const DEFAULT_RUNNING_STALE_MS = envIntAllowZero('HWB_PROXY_CACHE_RUNNING_STALE_MS', 0);
export const DEFAULT_HISTORY_TTL_MS = envInt('HWB_PROXY_CACHE_HISTORY_TTL_MS', 30 * 60_000);
export const DEFAULT_HISTORY_STALE_MS = envInt('HWB_PROXY_CACHE_HISTORY_STALE_MS', 7 * 24 * 3600_000);
export const DEFAULT_MAX_ENTRY_BYTES = envInt('HWB_PROXY_CACHE_MAX_ENTRY_BYTES', 32 * 1024 * 1024);
export const DEFAULT_MAX_BYTES = envInt('HWB_PROXY_CACHE_MAX_BYTES', 256 * 1024 * 1024);
// 被缓存的 RPC 请求体上限：信封 + args 通常只有几百字节，超过这个量级的一律不缓存（例如附件上传）。
export const RPC_REQUEST_BODY_CAP = envInt('HWB_PROXY_CACHE_RPC_BODY_CAP', 64 * 1024);

// 只读 RPC 白名单。写/控制类方法（prompt、create、cancel、control、rename、updateQueue、
// selectModel、steer、fork、attachment、respond、upload…）**绝不会**匹配，因此永远不会被缓存或提前返回。
//
// 为什么要「显式名单 + 形态规则」两层：dsh 的方法名随版本变，而且两代命名风格并存 ——
// 0.1.2 是 `session/list`、`skills/list`；远端 dgx21 的 0.1.1-rc.2 是 `session.list`、
// `skill.list`、`session.history`、`llm.providers`、`host.describe`（2026-09-14 CDP 抓包实测）。
// 只写死名单的话，换个版本缓存就整体失效；所以再加一条「命名空间 + 只读动词后缀」的形态规则，
// 并用写动词后缀做**先否决**（宁可漏缓存，也绝不把可能带副作用的调用提前返回）。
const RPC_READ_NAMESPACES = new Set([
  'session', 'sessions', 'workspace', 'workspaces', 'skill', 'skills',
  'agentPreset', 'agentPresets', 'subagent', 'subagents', 'llm', 'host',
  'settings', 'credentials', 'commands', 'fileReferences', 'dynamicCordisRunner',
  'project', 'projects', 'goal', 'goals', 'plan', 'plans', 'jobs', 'files',
]);
const RPC_READ_SUFFIX = /(?:^|[/.])(list|describe|history|search|page|catalog|models|providers|inventory|snapshot|schema|stats|capabilities|candidates)$/i;
const RPC_WRITE_SUFFIX = /(?:^|[/.])(prompt|create|cancel|control|update|delete|rename|set|steer|fork|queue|attach|upload|approve|respond|write|remove|kill|stop|start|open|select|archive|truncate|edit|compact|sync|send|submit|run|exec|install|enable|disable)$/i;

export const RPC_READ_METHODS = new Set([
  'session/list', 'session.list', 'session/history', 'session.history',
  'session/search', 'session.search', 'session/page', 'session.page',
  'session/models', 'session.models', 'session/modelCatalog', 'session.modelCatalog',
  'session/getSnapshot', 'session.getSnapshot',
  'workspace/list', 'workspace.list',
  'skill/list', 'skill.list', 'skills/list', 'skills.list',
  'subagent/list', 'subagent.list', 'subagents/list', 'subagents.list',
  'commands/list', 'commands.list',
  'agentPreset/list', 'agentPreset.list', 'agentPresets/list', 'agentPresets.list',
  'llm/providers', 'llm.providers',
  'llm/listProviders', 'llm.listProviders',
  'llm/listConfigurableProviders', 'llm.listConfigurableProviders',
  'host/describe', 'host.describe',
  'credentials/describe', 'credentials.describe',
  'settings/describe', 'settings.describe',
  'fileReferences/list', 'fileReferences.list',
  'dynamicCordisRunner/inventory', 'dynamicCordisRunner.inventory',
]);

// 该方法名是否属于「只读」。导出以便单测直接盯住「写类方法绝不放行」这条底线。
export function isReadOnlyRpc(method) {
  if (typeof method !== 'string' || method.length === 0 || method.length > 96) return false;
  if (RPC_WRITE_SUFFIX.test(method)) return false;      // 先否决：带副作用的动词结尾一律不缓存
  if (RPC_READ_METHODS.has(method)) return true;
  const namespace = method.split(/[/.]/, 1)[0];
  if (!RPC_READ_NAMESPACES.has(namespace)) return false;
  return RPC_READ_SUFFIX.test(method);
}

// 「历史类」方法：它们的返回值是会话事件日志的一段窗口（大、append-only）。
const RPC_HISTORY_SUFFIX = /(?:^|[/.])(history|page|snapshot)$/i;
export function isHistoryRpc(method) {
  return typeof method === 'string' && RPC_HISTORY_SUFFIX.test(method);
}

// 内容寻址的静态资源（只有这些 URL 可以被缓存）。
// `/assets/` 用 Vite 的 8 位内容哈希；插件 bundle 用 `?rev=<12 位 SHA1>`（dsh 自己按内容算）。
// 不带指纹的 `/plugins/**` 一概不缓存：那种 URL 的内容可以原地变化。
const HASHED_ASSET = /^\/assets\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8}\.(?:js|mjs|css|woff2?|ttf|otf|png|jpe?g|gif|svg|webp|avif|ico|map)$/;
const PLUGIN_BUNDLE = /^\/plugins\/(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*\/client\.js(?:\.map)?$/;
const PLUGIN_COMBO = /^\/plugins\/$/;

// 静态缓存键。返回 null 表示「这个请求不缓存」。
export function classifyStatic(method, rawUrl) {
  if (method !== 'GET' && method !== 'HEAD') return null;
  let url;
  try { url = new URL(rawUrl, 'http://hwb.invalid'); } catch { return null; }
  const { pathname, search } = url;
  // 带 token 的入口 URL（鉴权握手）绝不缓存。
  if (search.includes('token=')) return null;
  const rev = url.searchParams.get('rev') ?? '';
  const revOk = HEX8.test(rev);
  if (HASHED_ASSET.test(pathname)) return { key: `${pathname}${search}`, kind: 'static' };
  if (PLUGIN_BUNDLE.test(pathname) && revOk) return { key: `${pathname}${search}`, kind: 'static' };
  if (PLUGIN_COMBO.test(pathname) && revOk) return { key: `${pathname}${search}`, kind: 'static' };
  return null;
}

// payload 的规范化：键排序后序列化，使「同样的请求」得到同一个键
// （不排序的话，前端换一次参数顺序就会出现一份重复缓存）。
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

// RPC 缓存键。body 必须是完整请求体（Buffer/string）。返回 null 表示不缓存。
export function classifyRpc(method, rawUrl, body) {
  if (method !== 'POST' || !body) return null;
  let url;
  try { url = new URL(rawUrl, 'http://hwb.invalid'); } catch { return null; }
  if (!url.pathname.startsWith('/api/')) return null;
  if (url.search.includes('token=')) return null;
  let envelope;
  try { envelope = JSON.parse(body.toString('utf8')); } catch { return null; }
  if (!envelope || typeof envelope !== 'object') return null;
  const rpcMethod = typeof envelope.method === 'string' ? envelope.method : '';
  if (!isReadOnlyRpc(rpcMethod)) return null;
  // rpcId 不进键：它每个请求都不同，进键就等于永不命中。响应里的 rpcId 会在回放时改写成
  // 当前请求的那个（见 rewriteRpcEnvelope），否则客户端会因为对不上号而丢弃响应。
  const payload = envelope.payload ?? null;
  const digest = createHash('sha1').update(canonicalJson(payload)).digest('hex').slice(0, 16);
  // sessionId 用于「这条历史属于哪个会话」——策略要靠它区分「已结束」（可长缓存）与「正在跑」。
  const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId
    : (typeof payload?.args?.sessionId === 'string' ? payload.args.sessionId : null);
  return { key: `${url.pathname}|${rpcMethod}|${digest}`, kind: 'rpc', rpcMethod, sessionId, rpcId: envelope.rpcId ?? null };
}

// 从请求体里取出 rpcId（回放缓存响应时必须把它换回这次请求的 id）。
export function rpcIdOf(body) {
  try {
    const j = JSON.parse(body.toString('utf8'));
    return typeof j?.rpcId === 'string' ? j.rpcId : null;
  } catch { return null; }
}

// 把缓存下来的 JSON 信封里的 rpcId 换成当前请求的 rpcId。
export function rewriteRpcEnvelope(body, rpcId) {
  if (!rpcId) return body;
  try {
    const j = JSON.parse(body.toString('utf8'));
    if (j && typeof j === 'object' && 'rpcId' in j) {
      j.rpcId = rpcId;
      return Buffer.from(JSON.stringify(j), 'utf8');
    }
  } catch { /* 不是 JSON 就原样回（调用方只在 JSON 响应上缓存） */ }
  return body;
}

// 响应是否可以进入缓存。
export function storableResponse(status, headers, body) {
  if (status !== 200) return false;
  if (!body || body.length === 0) return false;
  if (headers['set-cookie']) return false;                 // 鉴权响应绝不缓存
  if ((headers.vary ?? '').split(',').some((v) => v.trim() === '*')) return false;
  if (/no-store/i.test(headers['cache-control'] ?? '')) return false;
  return true;
}

function etagOf(body) {
  return `"hwb-${createHash('sha1').update(body).digest('hex').slice(0, 20)}"`;
}

/**
 * 创建代理缓存。缺省落盘到 `<hwb 状态目录>/proxy-cache`（`HWB_DIR` 可改、`HWB_PROXY_CACHE_DIR`
 * 可指定、`HWB_PROXY_CACHE=0` 关闭；测试里传 dir:null 得到纯内存实例）。
 *
 * 测试运行（`node --test`）默认**不落盘**：缓存是纯派生数据，测试没有必要在用户的状态目录里
 * 留下一堆二进制，而且落盘会让「同一 URL 的两个用例」互相串台。
 */
export function createProxyCache({
  dir = envBool('HWB_PROXY_CACHE', true)
    ? (process.env.HWB_PROXY_CACHE_DIR || (process.env.NODE_TEST_CONTEXT ? null : path.join(serviceDir, 'proxy-cache')))
    : null,
  staticTtlMs = DEFAULT_STATIC_TTL_MS,
  rpcTtlMs = DEFAULT_RPC_TTL_MS,
  rpcStaleMs = DEFAULT_RPC_STALE_MS,
  historyTtlMs = DEFAULT_HISTORY_TTL_MS,
  historyStaleMs = DEFAULT_HISTORY_STALE_MS,
  runningTrustMs = DEFAULT_RUNNING_TRUST_MS,
  runningStaleMs = DEFAULT_RUNNING_STALE_MS,
  maxEntryBytes = DEFAULT_MAX_ENTRY_BYTES,
  maxBytes = DEFAULT_MAX_BYTES,
  now = () => Date.now(),
} = {}) {
  const entries = new Map();       // key -> { body, contentType, storedAt, etag, kind, bytes, hits }
  let totalBytes = 0;
  // sessionId -> running。由**流经代理的 session.list 响应**喂进来（页面每次加载都会拉它），
  // 于是历史缓存能区分「已结束」（不可变 → 长 TTL）与「正在跑」（会变 → 短 TTL）。
  const sessionRunning = new Map();
  const stats = { hits: 0, staleHits: 0, misses: 0, stores: 0, evictions: 0, savedBytes: 0, errors: 0 };

  if (dir) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch (error) {
      log.warn('代理缓存目录不可用，退化为纯内存缓存', { dir, reason: error.message });
      dir = null;
    }
  }

  const filesFor = (key) => {
    const name = createHash('sha1').update(key).digest('hex');
    return { meta: path.join(dir, `${name}.json`), body: path.join(dir, `${name}.bin`) };
  };

  // 落盘：先写临时文件再 rename —— 进程被 kill（hwb 开发期常态）时不会留下半截 JSON。
  function persist(key, entry) {
    if (!dir) return;
    const { meta, body } = filesFor(key);
    try {
      const tmpMeta = `${meta}.${process.pid}.${randomUUID()}.tmp`;
      const tmpBody = `${body}.${process.pid}.${randomUUID()}.tmp`;
      fs.writeFileSync(tmpBody, entry.body, { mode: 0o600 });
      fs.writeFileSync(tmpMeta, JSON.stringify({ key, contentType: entry.contentType, storedAt: entry.storedAt, etag: entry.etag, sourceEtag: entry.sourceEtag, cacheControl: entry.cacheControl, ttlMs: entry.ttlMs, staleMs: entry.staleMs, sessionId: entry.sessionId, kind: entry.kind, bytes: entry.bytes }), { mode: 0o600 });
      fs.renameSync(tmpBody, body);
      fs.renameSync(tmpMeta, meta);
    } catch (error) {
      stats.errors += 1;
      log.debug('代理缓存落盘失败（不影响本次响应）', { reason: error.message });
    }
  }

  function loadFromDisk(key) {
    if (!dir) return null;
    const { meta, body } = filesFor(key);
    try {
      const m = JSON.parse(fs.readFileSync(meta, 'utf8'));
      const buf = fs.readFileSync(body);
      if (!buf.length) return null;
      return { body: buf, contentType: m.contentType ?? 'application/octet-stream', storedAt: Number(m.storedAt) || 0, etag: m.etag ?? etagOf(buf), sourceEtag: m.sourceEtag ?? null, cacheControl: m.cacheControl ?? null, ttlMs: m.ttlMs ?? null, staleMs: m.staleMs ?? null, sessionId: m.sessionId ?? null, kind: m.kind ?? 'static', bytes: buf.length, hits: 0 };
    } catch { return null; }
  }

  function evictIfNeeded() {
    while (totalBytes > maxBytes && entries.size > 1) {
      let oldestKey = null;
      let oldestAt = Infinity;
      for (const [k, e] of entries) {
        const at = e.lastUsed ?? e.storedAt;
        if (at < oldestAt) { oldestAt = at; oldestKey = k; }
      }
      if (oldestKey === null) break;
      drop(oldestKey);
      stats.evictions += 1;
    }
  }

  function drop(key) {
    const e = entries.get(key);
    if (!e) return;
    totalBytes -= e.bytes;
    entries.delete(key);
    if (dir) {
      const f = filesFor(key);
      try { fs.rmSync(f.body, { force: true }); fs.rmSync(f.meta, { force: true }); } catch { /* 忽略 */ }
    }
  }

  return {
    dir,
    enabled: true,
    stats,
    maxEntryBytes,
    get size() { return entries.size; },
    get bytes() { return totalBytes; },

    // 该类条目的 TTL（供代理层给浏览器写 max-age）。
    ttlMs(kind) { return kind === 'rpc' ? rpcTtlMs : staticTtlMs; },

    // 会话是否在运行：true / false / undefined（未知）。
    // 观测太旧（超过 RUNNING_TRUST_MS）也返回 undefined —— 调用方一律把 unknown 当「在跑」处理。
    isRunning(sessionId) {
      const hit = sessionId ? sessionRunning.get(sessionId) : undefined;
      if (!hit) return undefined;
      if (now() - hit.at > runningTrustMs) return undefined;
      return hit.running;
    },

    // 从一份 session.list 响应体里更新会话运行状态。解析失败静默忽略（它只是缓存策略的输入，
    // 不该影响任何转发路径）。
    noteSessionList(body, { fresh = true } = {}) {
      try {
        const j = JSON.parse(body.toString('utf8'));
        const items = j?.result?.value?.items ?? j?.value?.items ?? j?.items;
        if (!Array.isArray(items)) return 0;
        let n = 0;
        for (const it of items) {
          const sid = typeof it?.sessionId === 'string' ? it.sessionId : null;
          if (!sid) continue;
          // 非新鲜观测（例如把陈旧副本回给浏览器时）不刷新可信时间：否则会用一个旧状态
          // 冒充「刚刚确认过」。
          const prev = sessionRunning.get(sid);
          if (fresh || !prev) sessionRunning.set(sid, { running: it.running === true, at: now() });
          n += 1;
        }
        return n;
      } catch { return 0; }
    },

    // 一次请求该用哪套 TTL/宽限窗口。
    //   · 历史类 + 该会话**确定已结束** → 长 TTL（历史不可变，第二次打开就该是本地回）；
    //   · 历史类 + 会话在跑/状态未知 → 短窗口（界面不能停在旧快照上）；
    //   · 其余 RPC → 短窗口；静态 → 静态 TTL。
    policy({ kind, rpcMethod = null, sessionId = null } = {}) {
      if (kind !== 'rpc') return { ttlMs: staticTtlMs, staleMs: staticTtlMs * 6 };
      if (isHistoryRpc(rpcMethod) && sessionId && this.isRunning(sessionId) === false) {
        return { ttlMs: historyTtlMs, staleMs: historyStaleMs };
      }
      return { ttlMs: rpcTtlMs, staleMs: rpcStaleMs };
    },

    // 取一个条目（内存 → 磁盘）。不判断新鲜度，调用方按返回的 storedAt 自己决定。
    read(key) {
      let entry = entries.get(key);
      if (!entry) {
        entry = loadFromDisk(key);
        if (entry) {
          entries.set(key, entry);
          totalBytes += entry.bytes;
          evictIfNeeded();
        }
      }
      if (!entry) return null;
      entry.lastUsed = now();
      return entry;
    },

    // 新鲜度：新鲜 / 陈旧但可用（serve-stale）/ 过期不可用。
    // 条目自带 TTL 时以它为准（历史的长 TTL 就是写在这上面的）；但只要这个会话此刻**在跑**，
    // 一律降级到短窗口 —— 长 TTL 的前提是「内容不会再变」，会话一恢复就不再成立。
    freshness(entry, kind) {
      let ttl = entry.ttlMs ?? (kind === 'rpc' ? rpcTtlMs : staticTtlMs);
      let stale = entry.staleMs ?? (kind === 'rpc' ? rpcStaleMs : staticTtlMs * 6);
      if (kind === 'rpc' && entry.sessionId && this.isRunning(entry.sessionId) !== false) {
        // 在跑（或状态未知）：长 TTL 的前提「内容不会再变」不成立 —— 事件流又没有游标
        // （`/api/events.host` 开流 payload 为空），补不回中间那段，所以连陈旧副本也不供。
        ttl = Math.min(ttl, rpcTtlMs);
        stale = Math.min(stale, runningStaleMs);
      }
      const age = now() - entry.storedAt;
      if (age <= ttl) return 'fresh';
      if (age <= ttl + stale) return 'stale';
      return 'expired';
    },

    write(key, { body, contentType, kind, sourceEtag = null, cacheControl = null, ttlMs = null, staleMs = null, sessionId = null, rpcMethod = null }) {
      if (!body || body.length > maxEntryBytes) return null;
      if (rpcMethod && !isHistoryRpc(rpcMethod)) this.noteSessionList(body);   // session.list 等顺带刷新运行状态
      const previous = entries.get(key);
      if (previous) { totalBytes -= previous.bytes; entries.delete(key); }
      const entry = {
        body,
        contentType: contentType ?? 'application/octet-stream',
        storedAt: now(),
        etag: etagOf(body),
        sourceEtag: sourceEtag ?? null,
        cacheControl: cacheControl ?? null,
        ttlMs: ttlMs ?? null,
        staleMs: staleMs ?? null,
        sessionId: sessionId ?? null,
        kind: kind ?? 'static',
        bytes: body.length,
        lastUsed: now(),
        hits: 0,
      };
      entries.set(key, entry);
      totalBytes += entry.bytes;
      stats.stores += 1;
      evictIfNeeded();
      persist(key, entry);
      return entry;
    },

    noteHit(entry, kind, stale) {
      entry.hits = (entry.hits ?? 0) + 1;
      if (stale) { stats.staleHits += 1; } else { stats.hits += 1; }
      stats.savedBytes += entry.bytes;
    },
    noteMiss() { stats.misses += 1; },

    clear() {
      entries.clear();
      totalBytes = 0;
      if (!dir) return;
      try {
        for (const f of fs.readdirSync(dir)) {
          if (f.endsWith('.bin') || f.endsWith('.json') || f.endsWith('.tmp')) fs.rmSync(path.join(dir, f), { force: true });
        }
      } catch { /* 忽略 */ }
    },

    // 供启动/心跳日志用的一行摘要。
    summary() {
      return {
        entries: entries.size,
        megabytes: Number((totalBytes / 1048576).toFixed(2)),
        hits: stats.hits,
        staleHits: stats.staleHits,
        misses: stats.misses,
        savedMegabytes: Number((stats.savedBytes / 1048576).toFixed(2)),
        dir,
      };
    },
  };
}

export { etagOf };
