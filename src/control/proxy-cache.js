import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
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
//
// —— 体积与「不必全量读取」（2026-09-17 按现网 386 条 / 311.7 MB 实测重做）——
//
// 实测把问题收得很窄：**38 个 ≥1 MB 的大条目 = 294.1 MB（94% 的体积）**，其中
// `session.history` 33 条就占 182.0 MB（均 5.5 MB、最大 14.7 MB）；而 235 个 <8 KB 的
// 小条目合计只有 428 KB，却各占 2 个文件（其中 227 条是 ttl≤60s 的只读 RPC）。
// 另有 310 条（162.0 MB）早已超出 ttl+stale，只因「重启不修剪」而留在盘上。
// 所以体积是「少数大条目」的事、条目数是「多数微条目」的事，两者不能用同一把尺子：
//
//   · 压缩落盘（C1）：按真实 body 实测，history 这类 JSON 事件流可压 ~12×、插件 combo ~2.85×，
//     整体 311.7 MB → 约 58 MB。压缩**只服务磁盘体积**：ETag 仍按 identity 字节算、
//     content-length 仍是 identity 长度、回给浏览器的仍是 identity（浏览器↔hwb 是 loopback，
//     压了没有线上收益、只会多一次协商）。meta 里的 `codec` 缺省即 identity，故天然向后兼容。
//   · 元数据/正文分离（C2）：304、HEAD、以及「新鲜度判断」都**不需要正文**。原先
//     `read()` 无条件 `readFileSync` 整条 body，于是一次 10.8 MB combo 的 304 校验就要
//     读 10.8 MB 磁盘 + 占 10.8 MB RSS。现在先用 `readMeta()` 判新鲜度，只有真要发正文时才读。
//   · 大条目不驻留内存（C3）：≥ `residentMaxEntryBytes` 的正文只在命中那一刻从磁盘读，
//     读完即弃。否则 28 个 live history ≈ 146 MB 会全部常驻 hwb 进程。
//   · 启动/定期修剪（C4）：初始化与每小时只读 meta 扫一遍目录，清掉死条目与超预算的 LRU 尾部。
//     **首次修剪按条目自己记录的 ttl/stale 判定**，所以历史上按旧策略（static 600s）写下的
//     陈旧副本会被正常清掉，而不会因为新版「static 不过期」被复活 —— 这正是迁移安全的依据。
//   · 微条目只留内存（C5）：`ttl ≤ PERSIST_MIN_TTL_MS 且 bytes < PERSIST_MIN_BYTES` 的条目
//     跨重启毫无价值（3 秒 TTL），落盘却要 2 个文件；它们只进内存，「少一次隧道往返」的延迟
//     收益一分不少。
//   · 分区预算（C7）：static 与 rpc 各自一套预算与 LRU，一条 14.7 MB 的历史再也挤不掉
//     插件 bundle 那份几 MB 的工作集。
//   · 历史限份数（C6）：同一 (scope, sessionId) 最多留 `maxHistoryVariants` 份 —— 实测有三个
//     会话各存了 2–3 份不同窗口，白占 37.1 MB。
//   · static 按内容寻址 ⇒ **不因时间过期**（`immortal`）：URL 里的 `rev`/hash 本身就是强校验器，
//     内容变了 URL 必然变。这与已经发给浏览器的 `immutable, 1 year` 保持一致。
//
// 两条**刻意不做**的事（理由见 CHANGELOG）：
//   · 不在本地把 combo 拆成 per-plugin 再重组：要逐字节复刻 dsh 的拼接与 sourcemap section
//     偏移，跨版本必碎，收益不值这个脆弱度。
//   · 不截断历史窗口后回放：`/api/events.host` 开流 payload 是 `{}`（无游标），截断会造成
//     静默的消息空洞 —— 比慢更糟。「不必全量」在这里的正确形态是**增量补差**（见 proxy.js 的
//     histdelta 通道与 `HWB_HISTORY_DELTA`），不是截断。

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

// —— 慢链路上的「会话列表」TTL（2026-09-22，dgx21.tun 实测）——
//
// `session.list` 是 hwb 轮询最频繁的只读 RPC，而它的响应**很大**：实测 dgx21 上
// 179 个会话的响应是 129 KB。在本地环回上重取一次是 1ms 的事，3s 的 TTL 完全合理；
// 但经隧道时同一份 129 KB 要 3.4–7.3s —— 于是「TTL 3s 就过期」意味着**每一轮轮询
// 都要重新搬 129 KB**，而这份数据在 3 秒内几乎不可能有任何变化。轮询节奏 3s、
// 传输耗时 3.4s+，结果是永远追不上：日志里成功与失败交替刷屏（实测 3380 失败 / 2135 成功）。
//
// 这里让 TTL 跟着**实测的上游耗时**走：一次 RPC 花得越久，说明链路越窄，
// 越不值得为了几秒的新鲜度重搬整份响应。新鲜度上限由 maxTtl 兜住 —— 会话状态可以
// 稍微滞后，但不能无限期停在旧快照上（正在跑的会话仍走下面的短窗口分支）。
//
// 判据用「上游耗时」而不是配置里的 hostType：hwb 无从可靠区分「本地实例」与
// 「快隧道」，而耗时是**直接测出来的事实**，本地实例自然落在慢阈值以下、行为不变。
const SLOW_LINK_RPC_MS = envInt('HWB_PROXY_CACHE_SLOW_LINK_MS', 1_500);
const SLOW_LINK_RPC_TTL_MS = envInt('HWB_PROXY_CACHE_SLOW_RPC_TTL_MS', 15_000);
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
// 单一总预算（旧旋钮，仍生效）。默认值只在**调用方显式传 maxBytes** 时用于单池模式；
// 不传时走下面按类分区的两套预算（C7：一条大历史不该挤掉插件工作集）。
export const DEFAULT_MAX_BYTES = envInt('HWB_PROXY_CACHE_MAX_BYTES', 256 * 1024 * 1024);
// 分区预算（C7）：按**落盘字节**算。实测 static 的活工作集只有 3.4 MB、压完约 1.2 MB，
// 而 rpc 全是 5–15 MB 的历史 —— 给 static 32 MB 已经非常宽裕，且它再也不会被历史挤掉。
export const DEFAULT_STATIC_MAX_BYTES = envInt('HWB_PROXY_CACHE_STATIC_MAX_BYTES', 32 * 1024 * 1024);
export const DEFAULT_RPC_MAX_BYTES = envInt('HWB_PROXY_CACHE_RPC_MAX_BYTES', 64 * 1024 * 1024);
// 正文常驻内存的上限（C3）：超过它的进程内存就是 O(条目大小)。32 MB 够放全部小条目 +
// 几份中等 RPC，而 28 份 live history（实测 ~146 MB）一律不驻留。
export const DEFAULT_MAX_RESIDENT_BYTES = envInt('HWB_PROXY_CACHE_MAX_RESIDENT_BYTES', 32 * 1024 * 1024);
// 单条正文是否驻留的分界（C3）：≥ 1 MB 的正文读完即弃，只在命中那一刻占内存。
export const DEFAULT_RESIDENT_MAX_ENTRY_BYTES = envInt('HWB_PROXY_CACHE_RESIDENT_MAX_ENTRY_BYTES', 1024 * 1024);
// 压缩（C1）：`gzip` 或 `none`。只影响落盘体积，不影响回给浏览器的字节（始终 identity）。
export const DEFAULT_CODEC = ['none', 'identity', 'off'].includes(String(process.env.HWB_PROXY_CACHE_CODEC ?? '').toLowerCase())
  ? 'identity' : 'gzip';
// 压缩的收益下限：压完没变小就存原文（例如已压过的 woff2）。
const CODEC_MIN_BYTES = envInt('HWB_PROXY_CACHE_CODEC_MIN_BYTES', 1024);
const CODEC_LEVEL = envInt('HWB_PROXY_CACHE_CODEC_LEVEL', 6);
const CODEC = 'gzip';
// 是否落盘的分界（C5）：`ttl ≤ 60s 且 bytes < 8KB` 的条目跨重启毫无价值，只留内存。
const PERSIST_MIN_BYTES = envInt('HWB_PROXY_CACHE_PERSIST_MIN_BYTES', 8 * 1024);
const PERSIST_MIN_TTL_MS = envInt('HWB_PROXY_CACHE_PERSIST_MIN_TTL_MS', 60_000);
// 同一 (scope, sessionId) 的历史最多留几份不同窗口（C6）。实测有会话存了 2–3 份，
// 白占 37.1 MB；上限 2 既保住「小的常用窗口 + 大的完整窗口」，又把最坏情况变成常数。
const MAX_HISTORY_VARIANTS = envInt('HWB_PROXY_CACHE_HISTORY_VARIANTS', 2);
// 定期修剪的间隔（C4）。hwb 会连跑很多天，只在初始化修剪不够。
const PRUNE_INTERVAL_MS = envInt('HWB_PROXY_CACHE_PRUNE_INTERVAL_MS', 3600_000);
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
 *
 * `maxBytes` 只要显式传了就走**单池**模式（保留旧行为，测试与需要一把尺子时用）；
 * 不传则按 kind 走 `staticMaxBytes` / `rpcMaxBytes` 两套预算（C7）。
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
  maxBytes = undefined,
  staticMaxBytes = DEFAULT_STATIC_MAX_BYTES,
  rpcMaxBytes = DEFAULT_RPC_MAX_BYTES,
  maxResidentBytes = DEFAULT_MAX_RESIDENT_BYTES,
  residentMaxEntryBytes = DEFAULT_RESIDENT_MAX_ENTRY_BYTES,
  codec = DEFAULT_CODEC,
  pruneIntervalMs = PRUNE_INTERVAL_MS,
  now = () => Date.now(),
} = {}) {
  // 单池模式（显式传 maxBytes）与分区模式（默认）二选一。
  const singlePool = Number.isFinite(maxBytes) && maxBytes > 0;
  const poolLimit = (kind) => (singlePool ? maxBytes : (kind === 'rpc' ? rpcMaxBytes : staticMaxBytes));
  // key -> meta（**不含正文**）。所有条目都在这里；这是「不读正文也能判新鲜度/回 304」的前提。
  const metas = new Map();
  // key -> 正文。只放小条目（≤ residentMaxEntryBytes），大条目命中时从磁盘读、读完即弃（C3）。
  const bodies = new Map();
  // key -> 该条目的落盘字节数（用于磁盘预算与修剪）。未落盘（纯内存）的条目为 0。
  const storedBytesOf = new Map();
  let logicalTotal = 0;    // 全部条目的逻辑（identity）字节，用于日志/摘要
  let storedTotal = 0;     // 真正落在磁盘上的字节（预算依据）
  let residentBytes = 0;   // 常驻内存的正文字节
  let prunedBytes = 0;     // 累计被修剪回收的字节（观测用）
  // sessionId -> running。由**流经代理的 session.list 响应**喂进来（页面每次加载都会拉它），
  // 于是历史缓存能区分「已结束」（不可变 → 长 TTL）与「正在跑」（会变 → 短 TTL）。
  const sessionRunning = new Map();
  // key -> 该条目「上游取回耗时」的 EWMA（ms）。用来判断这条链路是不是慢链路，
  // 从而决定 RPC 的 TTL 该不该放宽（见 SLOW_LINK_RPC_MS 的注释）。
  const upstreamLatency = new Map();
  const stats = { hits: 0, staleHits: 0, misses: 0, stores: 0, evictions: 0, savedBytes: 0, errors: 0, pruned: 0, metaHits: 0, bodyLoads: 0 };

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

  // —— 何时该落盘（C5）——
  // 3 秒 TTL 的 `commands/list`（1 KB）跨重启毫无价值，落盘却要 2 个文件 + 2 次写。
  // 保留在内存里，「少一次隧道往返」的延迟收益一分不少。
  // `immortal` 的条目（内容寻址的 static）没有 TTL 可比，而它们恰恰是最值得跨重启保留的
  // ——那份几 MB 的插件工作集就是靠它免掉重下的，所以一律落盘。
  const shouldPersist = (entry) => {
    if (!dir) return false;
    if (entry.immortal === true) return true;
    if (entry.bytes >= PERSIST_MIN_BYTES) return true;
    return Number.isFinite(entry.ttlMs) && entry.ttlMs > PERSIST_MIN_TTL_MS;
  };

  // 压缩只在「真的变小」时采用；`codec` 缺省即 identity ⇒ 老条目原样可读（迁移安全）。
  function encode(body) {
    if (codec !== CODEC || body.length < CODEC_MIN_BYTES) return { stored: body, codec: 'identity' };
    try {
      const gz = zlib.gzipSync(body, { level: CODEC_LEVEL });
      return gz.length < body.length ? { stored: gz, codec: CODEC } : { stored: body, codec: 'identity' };
    } catch (error) {
      stats.errors += 1;
      log.debug('压缩失败，按原文落盘', { reason: error.message });
      return { stored: body, codec: 'identity' };
    }
  }

  function decode(buf, entryCodec) {
    if (entryCodec !== CODEC) return buf;
    try {
      return zlib.gunzipSync(buf);
    } catch (error) {
      stats.errors += 1;
      log.debug('解压失败（当作未命中处理）', { reason: error.message });
      return null;
    }
  }

  // 落盘：先写临时文件再 rename —— 进程被 kill（hwb 开发期常态）时不会留下半截 JSON。
  function persist(key, entry) {
    if (!shouldPersist(entry)) { entry.persisted = false; return; }
    const { meta, body } = filesFor(key);
    try {
      const encoded = encode(entry.body);
      const tmpMeta = `${meta}.${process.pid}.${randomUUID()}.tmp`;
      const tmpBody = `${body}.${process.pid}.${randomUUID()}.tmp`;
      fs.writeFileSync(tmpBody, encoded.stored, { mode: 0o600 });
      fs.writeFileSync(tmpMeta, JSON.stringify({
        key,
        contentType: entry.contentType,
        storedAt: entry.storedAt,
        etag: entry.etag,
        sourceEtag: entry.sourceEtag,
        cacheControl: entry.cacheControl,
        ttlMs: entry.ttlMs,
        staleMs: entry.staleMs,
        immortal: entry.immortal === true,
        sessionId: entry.sessionId,
        kind: entry.kind,
        bytes: entry.bytes,               // 逻辑（identity）长度
        storedBytes: encoded.stored.length, // 落盘长度，预算按这个算
        codec: encoded.codec,
      }), { mode: 0o600 });
      fs.renameSync(tmpBody, body);
      fs.renameSync(tmpMeta, meta);
      entry.persisted = true;
      // **内存里的 meta 也要跟着记上 codec**：否则同进程内回放会拿压缩字节当原文发出去
      // （实测：200 KB 的正文变成 233 字节的 gzip 流）。这是必须在写入路径上钉死的一致性。
      entry.codec = encoded.codec;
      entry.storedBytes = encoded.stored.length;
      const prev = storedBytesOf.get(key) ?? 0;
      storedBytesOf.set(key, encoded.stored.length);
      storedTotal += encoded.stored.length - prev;
    } catch (error) {
      stats.errors += 1;
      entry.persisted = false;
      log.debug('代理缓存落盘失败（不影响本次响应）', { reason: error.message });
    }
  }

  /** 只读 meta（不碰 .bin）。到这一步就可以判新鲜度、回 304/HEAD 了。 */
  function loadMetaFromDisk(key) {
    if (!dir) return null;
    const { meta } = filesFor(key);
    try {
      const m = JSON.parse(fs.readFileSync(meta, 'utf8'));
      if (!m || typeof m !== 'object') return null;
      const bytes = Number(m.bytes) || 0;
      if (!bytes) return null;
      return {
        key,
        contentType: m.contentType ?? 'application/octet-stream',
        storedAt: Number(m.storedAt) || 0,
        etag: m.etag ?? null,
        sourceEtag: m.sourceEtag ?? null,
        cacheControl: m.cacheControl ?? null,
        ttlMs: m.ttlMs ?? null,
        staleMs: m.staleMs ?? null,
        immortal: m.immortal === true,
        sessionId: m.sessionId ?? null,
        kind: m.kind ?? 'static',
        bytes,
        storedBytes: Number(m.storedBytes) || bytes,
        codec: m.codec === CODEC ? CODEC : 'identity',
        hits: 0,
        persisted: true,
      };
    } catch { return null; }
  }

  /** 读正文（按需解压）。失败返回 null（调用方当未命中处理）。 */
  function loadBody(meta) {
    if (bodies.has(meta.key)) return bodies.get(meta.key);
    if (!meta.persisted) return null;
    const { body } = filesFor(meta.key);
    let buf;
    try {
      buf = fs.readFileSync(body);
    } catch { return null; }
    if (!buf.length) return null;
    stats.bodyLoads += 1;
    const raw = decode(buf, meta.codec);
    if (raw === null) return null;
    rememberBody(meta.key, raw, meta.bytes);
    return raw;
  }

  // 小正文驻留内存；大正文本读完即弃（C3）。原先 28 份 live history（~146 MB）会全部常驻。
  // 注意：**没有磁盘可回退时（dir=null，测试/`HWB_PROXY_CACHE_DIR` 不可用）必须一律驻留** ——
  // 否则大正文会变得既不在内存也不在盘上，等于直接丢缓存。
  function rememberBody(key, body) {
    if (dir && body.length > residentMaxEntryBytes) return;
    if (!dir && body.length > maxEntryBytes) return;
    const prev = bodies.get(key);
    if (prev) residentBytes -= prev.length;
    bodies.set(key, body);
    residentBytes += body.length;
    const limit = dir ? Math.min(maxResidentBytes, poolLimit(metas.get(key)?.kind)) : Infinity;
    while (residentBytes > limit && bodies.size > 1) {
      let oldestKey = null;
      let oldestAt = Infinity;
      for (const k of bodies.keys()) {
        const at = metas.get(k)?.lastUsed ?? 0;
        if (at < oldestAt) { oldestAt = at; oldestKey = k; }
      }
      if (oldestKey === null) break;
      residentBytes -= bodies.get(oldestKey).length;
      bodies.delete(oldestKey);
    }
  }

  function dropMemory(key) {
    const body = bodies.get(key);
    if (body) { residentBytes -= body.length; bodies.delete(key); }
    const meta = metas.get(key);
    if (meta) { logicalTotal -= meta.bytes; metas.delete(key); }
  }

  function dropFiles(key) {
    const prev = storedBytesOf.get(key) ?? 0;
    if (prev) { storedTotal -= prev; storedBytesOf.delete(key); }
    if (!dir) return;
    const f = filesFor(key);
    try { fs.rmSync(f.body, { force: true }); fs.rmSync(f.meta, { force: true }); } catch { /* 忽略 */ }
  }

  function drop(key) {
    dropMemory(key);
    dropFiles(key);
  }

  /** C7：只在**本类**预算内淘汰 LRU 尾部。 */
  function evictIfNeeded(kind) {
    const limit = poolLimit(kind);
    if (!(limit > 0)) return;
    const sameKind = [...metas].filter(([, e]) => (e.kind ?? 'static') === kind);
    let sum = sameKind.reduce((s, [k, e]) => s + (storedBytesOf.get(k) ?? 0), 0);
    while (sum > limit && sameKind.length > 1) {
      let oldestIdx = -1;
      let oldestAt = Infinity;
      for (let i = 0; i < sameKind.length; i += 1) {
        const [k, e] = sameKind[i];
        const at = e.lastUsed ?? e.storedAt;
        if (at < oldestAt) { oldestAt = at; oldestIdx = i; }
      }
      if (oldestIdx < 0) break;
      const [key] = sameKind[oldestIdx];
      sum -= storedBytesOf.get(key) ?? 0;
      sameKind.splice(oldestIdx, 1);
      drop(key);
      stats.evictions += 1;
    }
  }

  /** C6：同一 (scope, sessionId) 的历史最多留 MAX_HISTORY_VARIANTS 份不同窗口。 */
  function enforceHistoryVariants(key, entry) {
    if (entry.kind !== 'rpc' || !entry.sessionId) return;
    const scope = key.split('|', 1)[0];
    const same = [...metas]
      .filter(([k, e]) => e.kind === 'rpc' && e.sessionId === entry.sessionId && k.split('|', 1)[0] === scope)
      .sort((a, b) => (b[1].lastUsed ?? b[1].storedAt) - (a[1].lastUsed ?? a[1].storedAt));
    for (const [k] of same.slice(MAX_HISTORY_VARIANTS)) {
      drop(k);
      stats.evictions += 1;
    }
  }

  /**
   * C4：修剪。只读 meta（不碰 .bin），所以对「几百 MB / 上千文件」也是一次廉价扫描。
   * 判定用**条目自己记录的 ttl/stale**：历史上按旧策略（static 600s）写下的陈旧副本会被
   * 正常清掉，而不会被新版「static 不过期」复活 —— 这就是迁移安全的依据。
   */
  function prune() {
    if (!dir) return { removed: 0, bytes: 0 };
    let removed = 0;
    let freed = 0;
    const at = now();
    // 目录里**所有**条目的元数据（只看 .json，不碰 .bin），用于死条目回收与预算回收。
    const survivors = [];
    for (const file of fs.readdirSync(dir)) {
      if (file.endsWith('.tmp')) { try { fs.rmSync(path.join(dir, file), { force: true }); } catch { /* 忽略 */ } continue; }
      if (!file.endsWith('.json')) continue;
      const full = path.join(dir, file);
      let m;
      try { m = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { m = null; }
      const key = typeof m?.key === 'string' ? m.key : null;
      const storedBytes = Number(m?.storedBytes) || Number(m?.bytes) || 0;
      // 判定用条目**自己记录的** ttl/stale：历史上按旧策略（static 600s）写下的陈旧副本会被
      // 正常清掉，而不会被新版「static 不过期」复活 —— 这就是迁移安全的依据。
      // 读不出来 / 没有 TTL 记录的老格式，一律按「已死」处理（保守回收）。
      let dead = true;
      if (m && m.immortal !== true) {
        const ttl = Number(m.ttlMs);
        const stale = Number(m.staleMs);
        if (Number.isFinite(ttl)) {
          dead = (at - (Number(m.storedAt) || 0)) > ttl + (Number.isFinite(stale) ? stale : 0);
        }
      } else if (m && m.immortal === true) {
        dead = false;
      }
      if (dead) {
        removeFiles(full, key);
        removed += 1;
        freed += storedBytes;
        if (key) dropMemory(key);
        continue;
      }
      survivors.push({ key, file: full, bytes: storedBytes, kind: m.kind ?? 'static', lastUsed: Number(m.storedAt) || 0 });
    }

    // 预算回收：**整目录**（含本次会话从没碰过的条目）按 kind 各自的预算裁 LRU 尾部。
    // 这一步是「重启后预算才真正生效」的保证 —— 内存记账只看加载过的条目，盘上的不会自己消失。
    for (const kind of ['static', 'rpc']) {
      const limit = poolLimit(kind);
      if (!(limit > 0)) continue;
      const pool = survivors.filter((s) => s.kind === kind);
      let sum = pool.reduce((s, x) => s + x.bytes, 0);
      if (sum <= limit) continue;
      pool.sort((a, b) => a.lastUsed - b.lastUsed);           // 最旧在前
      // 留至少一条：预算是「留住最有用的那部分」，不是「宁可清空」。
      // 单条就超过预算时（例如一份很大的历史），保留它比清空更接近调用方的意图；
      // 内存侧的 evictIfNeeded 用的是同一条底线。
      for (let i = 0; i < pool.length - 1 && sum > limit; i += 1) {
        const victim = pool[i];
        removeFiles(victim.file, victim.key);
        sum -= victim.bytes;
        removed += 1;
        freed += victim.bytes;
        if (victim.key) dropMemory(victim.key);
      }
    }

    if (removed) {
      stats.pruned += removed;
      prunedBytes += freed;
      log.info('代理缓存修剪完成', { removed, freedMegabytes: Number((freed / 1048576).toFixed(2)), dir });
    }
    return { removed, bytes: freed };
  }

  /** 删掉一条条目的 .json + .bin，并同步记账。`metaPath` 是 .json 的完整路径。 */
  function removeFiles(metaPath, key) {
    try {
      fs.rmSync(metaPath, { force: true });
      const binPath = key ? filesFor(key).body : metaPath.replace(/\.json$/, '.bin');
      fs.rmSync(binPath, { force: true });
    } catch { /* 忽略 */ }
    if (key) {
      const prev = storedBytesOf.get(key) ?? 0;
      if (prev) { storedTotal -= prev; storedBytesOf.delete(key); }
    }
  }

  // 启动即修剪一次（治「重启不修剪 ⇒ 盘上是历史积压」），之后每小时一次。
  let pruneTimer = null;
  if (dir) {
    prune();
    pruneTimer = setInterval(() => { try { prune(); } catch (error) { log.warn('代理缓存定期修剪失败', { reason: error.message }); } }, pruneIntervalMs);
    pruneTimer.unref?.();
  }

  /** 量一次目录的实际占用（只用于日志/摘要，不在热路径上）。 */
  function dirSizeBytes() {
    if (!dir) return 0;
    try {
      let sum = 0;
      for (const f of fs.readdirSync(dir)) {
        try { sum += fs.statSync(path.join(dir, f)).size; } catch { /* 忽略 */ }
      }
      return sum;
    } catch { return 0; }
  }

  const api = {
    dir,
    enabled: true,
    stats,
    maxEntryBytes,
    codec,
    get size() { return metas.size; },
    get bytes() { return storedTotal; },
    get residentBytes() { return residentBytes; },
    get prunedBytes() { return prunedBytes; },
    prune,

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
    //   · 静态：内容寻址 ⇒ **不因时间过期**（C1/C7 的一致性要求：URL 里的 hash 就是校验器，
    //     这也与已经发给浏览器的 `immutable, 1 year` 一致）；
    //   · 历史类 + 该会话**确定已结束** → 长 TTL（历史不可变，第二次打开就该是本地回）；
    //   · 历史类 + 会话在跑/状态未知 → 短窗口（界面不能停在旧快照上）；
    //   · 其余 RPC → 短窗口；**慢链路上放宽**（见 SLOW_LINK_RPC_MS）。
    policy({ kind, rpcMethod = null, sessionId = null, key = null } = {}) {
      if (kind !== 'rpc') return { ttlMs: staticTtlMs, staleMs: staticTtlMs * 6, immortal: true };
      const history = isHistoryRpc(rpcMethod);
      if (history && sessionId && this.isRunning(sessionId) === false) {
        return { ttlMs: historyTtlMs, staleMs: historyStaleMs };
      }
      // 慢链路上放宽 TTL —— 但**只对非历史类 RPC**（会话列表/描述这类幂等快照）。
      // 历史类在「会话在跑或状态未知」时**必须**保持短窗口：事件流没有游标
      // （`/api/events.host` 开流 payload 为空），一份陈旧的历史窗口补不回中间那段事件，
      // 放宽 TTL 就等于让界面出现静默的消息空洞 —— 那比慢更糟（见 README「已知限制」）。
      const relax = !history && this.slowLink(key);
      return { ttlMs: relax ? Math.max(rpcTtlMs, SLOW_LINK_RPC_TTL_MS) : rpcTtlMs, staleMs: rpcStaleMs };
    },

    /**
     * 记录一次「上游取回」的耗时（ms）。代理在响应写完后调用。
     * 只按 key 记 EWMA，避免单次抖动就翻转整条链路的判定。
     */
    noteUpstreamLatency(key, ms) {
      if (typeof key !== 'string' || !key) return;
      if (!Number.isFinite(ms) || ms <= 0) return;
      const prev = upstreamLatency.get(key);
      upstreamLatency.set(key, Number.isFinite(prev) ? prev * 0.6 + ms * 0.4 : ms);
    },

    /** 该 key 是否落在「慢链路」上（无观测时按快链路处理，保持既有行为）。 */
    slowLink(key) {
      const v = upstreamLatency.get(key);
      return Number.isFinite(v) && v >= SLOW_LINK_RPC_MS;
    },

    /** 观测用：该 key 的上游耗时 EWMA（ms），无观测为 null。 */
    upstreamLatencyOf(key) {
      const v = upstreamLatency.get(key);
      return Number.isFinite(v) ? Math.round(v) : null;
    },

    /**
     * **只读 meta**（不碰 .bin）。这是 C2 的落点：304、HEAD、新鲜度判断都只需要这些字段。
     * 返回的对象**没有 body**；要正文请再调 `readBody(meta)`。
     */
    readMeta(key) {
      let entry = metas.get(key);
      if (!entry) {
        entry = loadMetaFromDisk(key);
        if (entry) {
          metas.set(key, entry);
          logicalTotal += entry.bytes;
          if (entry.persisted) { storedBytesOf.set(key, entry.storedBytes); storedTotal += entry.storedBytes; }
        }
      }
      if (!entry) return null;
      entry.lastUsed = now();
      return entry;
    },

    /** 取一个 meta 的正文（磁盘 ⇒ 解压 ⇒ 可能驻留）。失败返回 null。 */
    readBody(meta) {
      if (!meta) return null;
      return loadBody(meta);
    },

    /** meta + body（需要正文的老调用方，例如增量补差）。 */
    read(key) {
      const meta = api.readMeta(key);
      if (!meta) return null;
      const body = loadBody(meta);
      if (!body) { return null; }
      return { ...meta, body };
    },

    // 新鲜度：新鲜 / 陈旧但可用（serve-stale）/ 过期不可用。
    // 条目自带 TTL 时以它为准（历史的长 TTL 就是写在这上面的）；但只要这个会话此刻**在跑**，
    // 一律降级到短窗口 —— 长 TTL 的前提是「内容不会再变」，会话一恢复就不再成立。
    freshness(entry, kind) {
      if (!entry) return 'expired';
      // 内容寻址的静态：URL 自带内容指纹 ⇒ 永不因时间过期（只受自己那类预算的 LRU 淘汰）。
      if (kind !== 'rpc' && entry.immortal === true) return 'fresh';
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

    write(key, { body, contentType, kind, sourceEtag = null, cacheControl = null, ttlMs = null, staleMs = null, immortal = false, sessionId = null, rpcMethod = null }) {
      if (!body || body.length > maxEntryBytes) return null;
      if (rpcMethod && !isHistoryRpc(rpcMethod)) this.noteSessionList(body);   // session.list 等顺带刷新运行状态
      // 覆盖写：先把旧条目的两本账（内存常驻 / 落盘字节 / 逻辑字节）都退掉，
      // 否则每次重写都会把 logicalTotal 越加越大（实测会让 summary 里的 megabytes 虚高）。
      if (metas.has(key)) dropMemory(key);
      dropFiles(key);
      const entry = {
        key,
        body,
        contentType: contentType ?? 'application/octet-stream',
        storedAt: now(),
        etag: etagOf(body),
        sourceEtag: sourceEtag ?? null,
        cacheControl: cacheControl ?? null,
        ttlMs: immortal ? ttlMs : (ttlMs ?? null),
        staleMs: immortal ? staleMs : (staleMs ?? null),
        immortal: immortal === true,
        sessionId: sessionId ?? null,
        kind: kind ?? 'static',
        bytes: body.length,
        lastUsed: now(),
        hits: 0,
        persisted: false,
        // 未落盘（纯内存）的条目永远是 identity；落盘时 persist() 会按实际编码改写这两个字段。
        codec: 'identity',
        storedBytes: 0,
      };
      metas.set(key, entry);
      logicalTotal += entry.bytes;
      rememberBody(key, body);
      stats.stores += 1;
      persist(key, entry);
      evictIfNeeded(entry.kind);
      enforceHistoryVariants(key, entry);
      return entry;
    },

    noteHit(entry, kind, stale) {
      if (!entry) return;
      entry.hits = (entry.hits ?? 0) + 1;
      if (stale) { stats.staleHits += 1; } else { stats.hits += 1; }
      stats.savedBytes += entry.bytes;
    },
    noteMiss() { stats.misses += 1; },

    clear() {
      metas.clear();
      bodies.clear();
      storedBytesOf.clear();
      storedTotal = 0;
      residentBytes = 0;
      logicalTotal = 0;
      if (!dir) return;
      try {
        for (const f of fs.readdirSync(dir)) {
          if (f.endsWith('.bin') || f.endsWith('.json') || f.endsWith('.tmp')) fs.rmSync(path.join(dir, f), { force: true });
        }
      } catch { /* 忽略 */ }
    },

    dispose() {
      if (pruneTimer) clearInterval(pruneTimer);
      pruneTimer = null;
    },

    // 供启动/心跳日志用的一行摘要。
    summary() {
      // `diskMegabytes` 是**整目录的落盘体积**（启动时直接量一次目录），`storedMegabytes` 是
      // 本次会话记账到的部分。两者在刚启动时会不同 —— 记账只看加载过的条目，而运维要看的是盘。
      return {
        entries: metas.size,
        megabytes: Number((logicalTotal / 1048576).toFixed(2)),
        storedMegabytes: Number((storedTotal / 1048576).toFixed(2)),
        diskMegabytes: dir ? Number((dirSizeBytes() / 1048576).toFixed(2)) : 0,
        residentMegabytes: Number((residentBytes / 1048576).toFixed(2)),
        prunedMegabytes: Number((prunedBytes / 1048576).toFixed(2)),
        codec,
        hits: stats.hits,
        staleHits: stats.staleHits,
        misses: stats.misses,
        savedMegabytes: Number((stats.savedBytes / 1048576).toFixed(2)),
        dir,
      };
    },
  };
  return api;
}

export { etagOf };
