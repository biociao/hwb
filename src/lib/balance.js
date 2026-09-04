import { readFileSync } from 'node:fs';
import path from 'node:path';

// §8.1: API key 只存在于服务端内存 —— readCredentials 的返回值 NEVER 传给浏览器。
// /api/quota 只输出 { provider, remaining, currency, ... }。

const KEY_LINE = /^([A-Za-z0-9_]+)\s*:\s*(.+)$/;

// 读取 refs: 块下的完整 key 值（与 parseCredentialsYaml 同一布局，但保留 value）。
export function readCredentials(homePath) {
  let text;
  try {
    text = readFileSync(path.join(homePath, '.credentials.yaml'), 'utf8');
  } catch {
    return [];
  }
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
export async function queryBalance({ provider, key }, fetchImpl = fetch) {
  const adapter = adapters.find((a) => a.match(provider));
  if (!adapter) return { provider, error: 'no adapter' };
  try {
    const r = await adapter.fetchBalance(key, fetchImpl);
    return { provider, ...r };
  } catch (e) {
    return { provider, error: e.message };
  }
}
