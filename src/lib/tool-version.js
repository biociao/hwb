import { existsSync, readFileSync, readlinkSync } from 'node:fs';
import path from 'node:path';

// 本地工具（Codex / WorkBuddy）的版本号解析器。
//
// 为什么不问工具本身：这两个都是只读接入的桌面端，hwb 索引时它们可能根本没在跑；
// 「问进程」既不可靠又会让一张实例卡依赖对方的可用性。版本号就写在它们自己的安装目录里，
// 读一两个文件即可（同步，实例卡首帧就带版本号）。
//
// 取值口径（契约 §2/§5）：
//   · codex     ：<home>/packages/standalone/current 软链（releases/<version>-<arch>-apple-darwin）
//                 → 回退 <home>/version.json 的 latest_version；
//   · workbuddy ：<home>/startup-seed-version.json 的 appVersion
//                 → 回退 <home>/app/renderer-version.json 的 version；
//   · dsh       ：不在这里（沿用 src/lib/dsh-version.js 的 DshVersionResolver）。
//
// 版本号必须过白名单正则才显示（远端/第三方文件不可信）：界面上的版本号一定是干净的
// 字面量，取不到就当未知、不画占位符。

// 契约 §5 的白名单：x.y.z 或 x.y.z-<prerelease>。
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

// 版本号只在升级工具时变：半小时查一次足够新鲜；读不到时按更短退避再试
// （用户刚装好/刚改 home 时不必等半小时）。
const TTL_MS = 30 * 60_000;
const RETRY_MS = 2 * 60_000;

const LABELS = { codex: 'Codex', workbuddy: 'WorkBuddy' };

// key = `${harness}\0${绝对路径}` -> { value, nextAt }
const cache = new Map();

export const TOOL_VERSION_TTL_MS = TTL_MS;

function asString(value) {
  return typeof value === 'string' ? value : '';
}

function cleanVersion(raw) {
  const text = asString(raw).trim();
  return VERSION_RE.test(text) ? text : null;
}

function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function homePathOf(home) {
  if (typeof home === 'string') return home.trim();
  return asString(home?.homePath ?? home?.home).trim();
}

// 只有路径（没带 harness）时靠哨兵文件判断是哪个工具。优先 WorkBuddy 的唯一库文件，
// 再认 Codex 的元数据/安装目录。
function inferHarness(homePath) {
  const has = (rel) => existsSync(path.join(homePath, rel));
  if (has('workbuddy.db') || has('startup-seed-version.json')) return 'workbuddy';
  if (has('packages/standalone') || has('version.json') || has('state_5.sqlite') || has('.codex-global-state.json')) return 'codex';
  return null;
}

// Codex standalone 的软链目标是 releases/<version>-<arch>-apple-darwin（实测 0.153.4-aarch64-apple-darwin）：
// 平台后缀不是版本的一部分，先剥掉再进白名单。`-rc.1` 这类预发布后缀不受影响。
const CODEX_PLATFORM_SUFFIX_RE = /-(?:aarch64|x86_64|arm64|universal)(?:[-.].*)?$/i;

function codexVersion(homePath) {
  try {
    const target = readlinkSync(path.join(homePath, 'packages', 'standalone', 'current'));
    const base = path.basename(target.replace(/[/\\]+$/, ''));
    const version = cleanVersion(base.replace(CODEX_PLATFORM_SUFFIX_RE, '')) ?? cleanVersion(base);
    if (version) return version;
  } catch {
    // 不是软链（Windows / 旧安装）：走下面的 version.json
  }
  const meta = readJsonFile(path.join(homePath, 'version.json'));
  return cleanVersion(meta?.latest_version);
}

function workbuddyVersion(homePath) {
  const seed = readJsonFile(path.join(homePath, 'startup-seed-version.json'));
  const fromSeed = cleanVersion(seed?.appVersion);
  if (fromSeed) return fromSeed;
  const renderer = readJsonFile(path.join(homePath, 'app', 'renderer-version.json'));
  return cleanVersion(renderer?.version);
}

/**
 * 本地工具版本号：`{label, version} | null`。
 *
 * @param {object|string} home 实例行（{harness, homePath}）或 home 路径；
 *        路径形式会按哨兵文件推断 harness。
 * @param {{now?:number}} [options] 注入时钟（测试用；默认 Date.now()）
 * @returns {{label:string, version:string}|null}
 */
export function resolveToolVersion(home, { now = Date.now() } = {}) {
  const rawPath = homePathOf(home);
  if (!rawPath) return null;
  const homePath = path.resolve(rawPath);

  // 显式 harness 优先：harness 存在但不是本地工具（例如 dsh）→ 明确返回 null，
  // 不再按文件猜（避免把 dsh home 里的杂项当成 Codex）。
  let harness = typeof home === 'object' && home ? asString(home.harness).trim().toLowerCase() : '';
  if (!harness) harness = inferHarness(homePath);
  const label = LABELS[harness];
  if (!label) return null;

  const key = `${harness}\u0000${homePath}`;
  const hit = cache.get(key);
  if (hit && now < hit.nextAt) return hit.value;

  const version = harness === 'codex' ? codexVersion(homePath) : workbuddyVersion(homePath);
  const value = version ? { label, version } : null;
  cache.set(key, { value, nextAt: now + (value ? TTL_MS : RETRY_MS) });
  return value;
}

/** 清空版本缓存（测试 / 实例移除后可选调用；正常使用不需要）。 */
export function clearToolVersionCache() {
  cache.clear();
}
