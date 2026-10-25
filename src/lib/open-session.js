// —— 「在 DSH 里打开某个会话」的 hwb 侧实现 ——
//
// 背景：DSH 桌面端只接受 `dsh://open`（聚焦），没有会话级深链；dsh web 也没有
// `--session` 启动参数。因此 hwb 通过自己的插件 dsh-hwb-open-session 走一条「文件触发器」：
//
//   hwb 写 <homePath>/hwb/open-session.json
//     → 插件 Host 半暴露只读路由 /api/hwb-open-session
//     → 插件 Client 半轮询并调用 sessions.open(sessionId)
//
// 本模块负责：写触发器、检测插件是否装在该 home 的 profile 里、唤起/聚焦桌面 App。
// 不负责 HTTP（见 src/api/routes.js）与 UI（见 src/web/app.js）。

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { findDshAppPath, isDshAppRunning, focusDshApp, launchDshApp } from './dsh-app.js';

export const PLUGIN_NAME = 'dsh-hwb-open-session';
export const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;
export const DEFAULT_TTL_MS = 120_000;
const MAX_TRIGGER_BYTES = 8 * 1024;

// 仓库根：src/lib/open-session.js → ../../dsh-hwb-open-session
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const PLUGIN_DIR = path.join(REPO_ROOT, PLUGIN_NAME);

export function validateSessionId(sessionId) {
  return typeof sessionId === 'string' && SESSION_ID_RE.test(sessionId);
}

export function triggerFileFor(homePath) {
  return path.join(homePath, 'hwb', 'open-session.json');
}

/** 原子写触发器；返回实际落盘的内容（含 id/expiresAt），供 API 回给前端/日志。 */
export function writeTrigger(homePath, sessionId, {
  ttlMs = DEFAULT_TTL_MS, now = Date.now, id = randomUUID,
} = {}) {
  if (typeof homePath !== 'string' || !path.isAbsolute(homePath)) {
    throw new Error('homePath 必须是绝对路径');
  }
  if (!validateSessionId(sessionId)) throw new Error('无效的会话 ID');
  const file = triggerFileFor(homePath);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const createdAt = now();
  const payload = { id: id(), sessionId, createdAt, expiresAt: createdAt + ttlMs };
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return { file, ...payload };
}

/** 读回触发器（测试/诊断用；运行时由插件 Host 半读取）。 */
export function readTriggerFile(homePath, { now = Date.now() } = {}) {
  const file = triggerFileFor(homePath);
  let raw;
  try {
    raw = fs.readFileSync(file);
  } catch {
    return null;
  }
  if (raw.byteLength > MAX_TRIGGER_BYTES) return null;
  let data;
  try { data = JSON.parse(raw.toString('utf8')); } catch { return null; }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  if (typeof data.id !== 'string' || data.id === '') return null;
  if (!validateSessionId(data.sessionId)) return null;
  if (!Number.isFinite(Number(data.expiresAt)) || Number(data.expiresAt) <= now) return null;
  return { ...data, expiresAt: Number(data.expiresAt) };
}

/**
 * 插件装在哪些 profile 里。三种安装痕迹都认（link 安装只写 dependencies + node_modules 软链）：
 *   · package.json 的 dependencies/devDependencies
 *   · dsh.profile.bundles
 *   · profiles/<name>/node_modules/<plugin>/package.json
 * 失败/缺文件一律按「未安装」处理（宁可回退 iframe，也不要误报能打开）。
 */
export function pluginProfiles(homePath) {
  if (typeof homePath !== 'string' || homePath === '') return [];
  const profilesDir = path.join(homePath, 'profiles');
  let entries;
  try {
    entries = fs.readdirSync(profilesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dir = path.join(profilesDir, entry.name);
    let pkg = null;
    try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { /* 没有 package.json */ }
    const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
    const bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : [];
    const linked = fs.existsSync(path.join(dir, 'node_modules', PLUGIN_NAME, 'package.json'));
    if (deps[PLUGIN_NAME] || bundles.includes(PLUGIN_NAME) || linked) found.push(entry.name);
  }
  return found.sort();
}

export function installHint(homePath = '~/.dsh', repoRoot = REPO_ROOT) {
  // desktop profile 由 Electron 独占管理，dsh CLI 会拒绝 `--profile desktop`；
  // 必须用仓库里的安装脚本做等价的最小文件操作。
  return `node ${path.join(repoRoot, 'scripts', 'install-dsh-open-session.mjs')} --home ${homePath}`;
}

/**
 * 没有可跳转的会话（或插件缺失）时的退路：聚焦/启动 DSH 桌面端本身。
 *
 * 这是统一入口 `POST /api/harness/open` 的 `app-focused` 分支：本地只读 dsh 实例
 * 只做元数据索引，用户点「打开」想要的通常是「把 DSH 端叫到前台」，能不能落到
 * 具体会话取决于插件与触发器。这里只负责 App 这一层，不写任何触发器。
 *
 * @returns {Promise<{ok:boolean, code?:string, error?:string, appPath?:string, mode?:string, focused?:boolean}>}
 */
export async function openDshApp({ platform = process.platform, deps = {} } = {}) {
  // 非 macOS 没有 `open(1)` 与 .app 概念：不猜 xdg-open/start 的语义，如实回不支持。
  if (platform !== 'darwin') {
    return { ok: false, code: 'platform-unsupported', error: '仅 macOS 支持唤起 DSH 桌面端' };
  }
  const appPath = (deps.findDshAppPath ?? findDshAppPath)();
  if (!appPath) {
    return { ok: false, code: 'app-missing', error: '未找到 DeepSeek Harness.app' };
  }
  try {
    const running = await (deps.isDshAppRunning ?? isDshAppRunning)();
    if (running) {
      await (deps.focusDshApp ?? focusDshApp)();
      return { ok: true, mode: 'focus', appPath, focused: true };
    }
    await (deps.launchDshApp ?? launchDshApp)(appPath);
    return { ok: true, mode: 'launch', appPath, focused: false };
  } catch (error) {
    return { ok: false, code: 'app-open-failed', appPath, error: `唤起 DSH 桌面端失败：${error?.message ?? error}` };
  }
}

/**
 * 点击「在 DSH 中打开」的完整动作：校验 → 检测插件/App → 写触发器 → 聚焦或启动。
 * @returns {Promise<{ok:boolean, code?:string, error?:string, ...}>}
 */
export async function openSessionInDsh({ home, sessionId, platform = process.platform, deps = {} } = {}) {
  if (platform !== 'darwin') {
    return { ok: false, code: 'platform-unsupported', error: '仅 macOS 支持唤起 DSH 桌面端' };
  }
  if (!validateSessionId(sessionId)) {
    return { ok: false, code: 'bad-session-id', error: '无效的会话 ID' };
  }
  const homePath = home?.homePath;
  if (typeof homePath !== 'string' || !path.isAbsolute(homePath)) {
    return { ok: false, code: 'bad-home', error: '实例 home 路径不可用' };
  }
  const appPath = (deps.findDshAppPath ?? findDshAppPath)();
  if (!appPath) {
    return { ok: false, code: 'app-missing', error: '未找到 DeepSeek Harness.app' };
  }
  const profiles = (deps.pluginProfiles ?? pluginProfiles)(homePath);
  // 桌面 App 只加载 desktop profile；只装在 web profile 时，写触发器不会被 App 消费。
  if (!profiles.includes('desktop')) {
    return {
      ok: false,
      code: 'plugin-missing',
      error: 'DSH desktop profile 未安装 dsh-hwb-open-session 插件',
      install: installHint(homePath),
      profiles,
    };
  }

  // 先落触发器，再唤起 App：App 启动后 Client 半会立刻轮询，避免「先启动后写」的竞态。
  const trigger = (deps.writeTrigger ?? writeTrigger)(homePath, sessionId);
  const running = await (deps.isDshAppRunning ?? isDshAppRunning)();
  let focused = false;
  let warning = null;
  try {
    if (running) {
      await (deps.focusDshApp ?? focusDshApp)();
      focused = true;
    } else {
      await (deps.launchDshApp ?? launchDshApp)(appPath);
    }
  } catch (error) {
    // 触发器已落盘：App 若其实在跑/稍后启动，仍会消费它；把失败如实带回去让界面提示。
    warning = `已写入会话触发器，但唤起 DSH 失败：${error?.message ?? error}`;
  }
  return {
    ok: true,
    mode: 'in-app',
    appPath,
    profiles,
    focused,
    trigger: { id: trigger.id, sessionId: trigger.sessionId, expiresAt: trigger.expiresAt },
    ...(warning ? { warning } : {}),
  };
}
