import { readMetadataFile } from './read-home.js';
import { logger } from './logger.js';

const log = logger('balance');

// §8.1: API key 只存在于服务端内存 —— readCredentials 的返回值 NEVER 传给浏览器。
// /api/quota 只输出 { provider, remaining, currency, ... }。

const KEY_LINE = /^([A-Za-z0-9_]+)\s*:\s*(.+)$/;

// 读取 refs: 块下的完整 key 值（与 parseCredentialsYaml 同一布局，但保留 value）。
export function readCredentials(homePath) {
  let text;
  try {
    // 必须走 readMetadataFile，而不是裸 readFileSync：
    //  · 该路径若是 **FIFO**，同步 readFileSync 会永久阻塞事件循环 —— 而且这条路径是从
    //    `GET /api/quota` → QuotaService.#hasStale() → refresh() 一路**没有 await** 地进来的，
    //    所以阻塞会卡死整个进程（端口无响应、SIGTERM 也无效，只能 kill -9）。
    //    这正是 read-home.js 那边修过的同一个故障模式，凭据这条路径当时漏了。
    //  · 顺带拿到「非普通文件/符号链接/超限」的拒绝与大文件上限。
    text = readMetadataFile(homePath, '.credentials.yaml');
  } catch (error) {
    // 「文件不存在」是正常状态（用户没配 key）；但「存在却读不出来」（权限、符号链接、超过上限、
    // 是 FIFO/目录）会让额度面板只显示「key not found」—— 与「真的没配」完全无法区分。
    // 这里把非 ENOENT 的原因记一条结构化日志（消息里只有相对路径，没有文件内容）。
    if (error?.code !== 'ENOENT') {
      try { log.warn('凭据文件读取失败', { homePath, error: String(error?.message ?? error).slice(0, 200) }); }
      catch { /* 日志失败不影响返回 */ }
    }
    return [];
  }
  // 剥掉 UTF-8 BOM：JS 的 `\s` 匹配 U+FEFF，于是 `\uFEFFrefs:` 会走错分支、inRefs 永远为 false，
  // 带 BOM 的凭据文件会表现为「一个 key 都没有」—— 与 parseCredentialsYaml 那边保持一致。
  text = String(text).replace(/^\uFEFF/, '');
  const creds = [];
  let inRefs = false;
  for (const raw of text.split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      inRefs = /^refs\s*:\s*$/.test(raw.trim());
      if (!inRefs) {
        const m = raw.trim().match(KEY_LINE);
        if (m && m[1].endsWith('_API_KEY')) creds.push({ ref: m[1], key: m[2].trim() });
      }
      continue;
    }
    if (!inRefs) continue;
    const m = raw.trim().match(KEY_LINE);
    if (m && m[1].endsWith('_API_KEY')) creds.push({ ref: m[1], key: m[2].trim() });
  }
  return creds;
}

const bearer = (key) => ({ Authorization: `Bearer ${key}` });

async function getJson(fetchImpl, url, key) {
  const res = await fetchImpl(url, {
    headers: { ...bearer(key) },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// QuotaProvider adapters (§8.2). fetchBalance 返回
// { remaining, currency, expireAt? } 或抛错 —— 抛错由上层降级为 "余额不可用"。
export const adapters = [
  {
    name: 'deepseek',
    match: (provider) => provider === 'deepseek',
    async fetchBalance(key, fetchImpl) {
      const data = await getJson(fetchImpl, 'https://api.deepseek.com/user/balance', key);
      const info = data?.balance_infos?.[0];
      if (!info) throw new Error('no balance_infos');
      return { remaining: Number(info.total_balance), currency: info.currency ?? 'CNY' };
    },
  },
  {
    name: 'kimi',
    match: (provider) => provider === 'kimi',
    async fetchBalance(key, fetchImpl) {
      const data = await getJson(fetchImpl, 'https://api.moonshot.cn/v1/users/me/balance', key);
      const available = data?.data?.available_balance;
      if (available == null) throw new Error(data?.error?.message ?? 'no balance data');
      return { remaining: Number(available), currency: 'CNY' };
    },
  },
  // zai / minimax 暂无公开余额 API —— 显式降级而不是静默失败（§8.1 失败降级）。
  {
    name: 'zai',
    match: (provider) => provider === 'zai',
    async fetchBalance() {
      throw new Error('no public balance API');
    },
  },
  {
    name: 'minimax',
    match: (provider) => provider === 'minimax',
    async fetchBalance() {
      throw new Error('no public balance API');
    },
  },
];

// provider → { remaining, currency } 或 { error }。永不抛错。
//
// 注意 error 会**原样**出现在未经鉴权的 GET /api/quota 响应里，所以绝不能把 `e.message`
// 直接转发出去：Node 的 fetch 在 header 值非法时会抛
//   `Headers.append: "Bearer sk-…" is an invalid header value.`
// —— 消息里带着 key 本身。实测一个含控制字符的 key 就能把明文 key 送进响应，
// 而那条不变量（§8.1「key NEVER 传给浏览器」）本来就是本文件开头写下的承诺。
// 技术细节只记服务端日志，客户端只拿到一个分类过的原因。
export async function queryBalance({ provider, key }, fetchImpl = fetch) {
  const adapter = adapters.find((a) => a.match(provider));
  if (!adapter) return { provider, error: 'no adapter' };
  try {
    const r = await adapter.fetchBalance(key, fetchImpl);
    return { provider, ...r };
  } catch (e) {
    logBalanceFailure(provider, e);
    return { provider, error: classifyBalanceError(e) };
  }
}

// 适配器**主动**抛出的、本身就是给用户看的原因（如「无公开余额 API」）—— 原样保留。
// 只有技术性错误才需要被分类，因为技术消息可能带上请求内容（header 值 = key）。
const INTENTIONAL = new Set(['no public balance API']);

// 只回一个不含任何请求内容的短分类，供 UI 展示。
function classifyBalanceError(e) {
  const msg = String(e?.message ?? e);
  if (INTENTIONAL.has(msg)) return msg;
  if (/invalid header value/i.test(msg)) return '凭证格式无效（含非法字符）';
  if (/HTTP 401|HTTP 403/.test(msg)) return '凭证被拒绝（401/403）';
  if (/HTTP \d+/.test(msg)) return `上游返回错误（${/HTTP \d+/.exec(msg)[0]}）`;
  if (/timeout|aborted/i.test(msg)) return '查询超时';
  return '余额查询失败';
}

// 走结构化日志，而不是 `process.emitWarning`：
//   · emitWarning 的输出**绕过脱敏管线**（logger.js 只在自己的写入通道上脱敏）——适配器的错误
//     消息里一旦带上请求内容就会原样落到 service.log；而调用方一直强调「技术消息可能带 key，
//     所以只给 UI 一个分类」。日志这一路同样不该是例外。
//   · 它也不进环缓冲/SSE，所以界面上的「日志区域」看不到任何余额失败的原因，用户只能去翻
//     service.log 才知道发生了什么。
// 结构化日志同时解决这两点：脱敏 + 进 UI。（UI 展示的仍是 classifyBalanceError 的分类结果。）
function logBalanceFailure(provider, e) {
  try {
    // 只记**分类结果**，不记原始消息：分类函数存在的理由就是「技术消息可能带上请求内容」，
    // 而日志这一路同样不该是例外（我自己验证时把带 key 的错误消息喂进来，它确实原样进了日志）。
    log.warn('余额查询失败', { provider, error: classifyBalanceError(e) });
  } catch { /* 日志失败不影响返回值 */ }
}
