import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// 「跳到 WorkBuddy 对应会话」唯一的入口：走 WorkBuddy 桌面端注册的 `workbuddy://` 深链。
// 与 src/codexhome/open.js 同一套形状与安全约束：
//   · 只接受 UUID（深链会被桌面端 scheme handler 接走，任何拼接都必须先过白名单，
//     否则一个 `..%2f` / 查询串注入就可能变成任意 URL 派发）；
//   · 非 macOS 平台没有 `open(1)`：不猜 xdg-open/start 的语义，直接回退成可复制的命令；
//   · 唤起失败不抛给调用方，返回 ok:false + fallback，让前端给出「手动打开」。

const OPEN_TIMEOUT_MS = 8_000;

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const execFileAsync = promisify(execFile);

export function isWorkbuddySessionId(value) {
  return typeof value === 'string' && SESSION_ID_RE.test(value);
}

export function deepLinkFor(sessionId) {
  if (!isWorkbuddySessionId(sessionId)) throw new Error('无效的 WorkBuddy 会话 id');
  return `workbuddy://chat/${sessionId.toLowerCase()}`;
}

function fallbackCommandFor(sessionId, platform) {
  const url = `workbuddy://chat/${sessionId.toLowerCase()}`;
  if (platform === 'win32') return `start "" "${url}"`;
  if (platform === 'darwin') return `open "${url}"`;
  return `xdg-open "${url}"`;
}

/**
 * @returns {Promise<{ok:boolean, sessionId:string, url:string, fallback?:string, error?:string}>}
 */
export async function openWorkbuddyConversation(sessionId, { platform = process.platform, runner = execFileAsync } = {}) {
  const url = deepLinkFor(sessionId); // 校验失败直接抛（调用方按 400 处理）
  const fallback = fallbackCommandFor(sessionId, platform);

  if (platform !== 'darwin') {
    return {
      ok: false,
      sessionId,
      url,
      fallback,
      error: `当前平台（${platform}）不支持自动跳转 WorkBuddy，请手动执行：${fallback}`,
    };
  }
  try {
    await runner('/usr/bin/open', [url], { timeout: OPEN_TIMEOUT_MS });
    return { ok: true, sessionId, url, fallback };
  } catch (error) {
    // 典型失败：没装 WorkBuddy / LaunchServices 里没有 workbuddy scheme。
    return { ok: false, sessionId, url, fallback, error: `未能唤起 WorkBuddy：${error?.message ?? error}` };
  }
}

function asString(value) {
  return typeof value === 'string' ? value : '';
}

function trimmedPath(value) {
  const text = asString(value).trim();
  return text ? text.replace(/\/+$/, '') || '/' : null;
}

function isUnder(cwd, root) {
  if (!cwd || !root) return false;
  if (root === '/') return cwd.startsWith('/');
  return cwd === root || cwd.startsWith(`${root}/`);
}

/**
 * 目标解析（契约 §4.2）：sessionId > projectId 的最近一条会话 > 该实例最近一条会话。
 *
 * @param {object} snapshot readWorkbuddySnapshot 的输出
 * @param {{sessionId?:string, projectId?:string}} [options]
 *        projectId = workspaceId（WorkBuddy 的 workspaceId 就是项目目录 path）
 * @returns {string|null} 可跳转的会话 id；非法 sessionId 抛错（调用方按 400 处理），
 *          返回 null 表示没有可跳转的会话。
 */
export function resolveWorkbuddyTarget(snapshot, { sessionId, projectId } = {}) {
  if (typeof sessionId === 'string' && sessionId.trim()) {
    const id = sessionId.trim();
    if (!isWorkbuddySessionId(id)) throw new Error('无效的 WorkBuddy 会话 id');
    return id;
  }

  // snapshot.sessions 已按最近活跃降序（reader 保证）；只认合法 UUID，避免把库里的脏 id
  // 拼进深链。
  const sessions = (Array.isArray(snapshot?.sessions) ? snapshot.sessions : [])
    .filter((session) => session && isWorkbuddySessionId(session.id));

  if (typeof projectId === 'string' && projectId.trim()) {
    const workspacePath = trimmedPath(projectId);
    if (!workspacePath) return null;
    const candidate = sessions.find((session) => isUnder(asString(session.cwd) || null, workspacePath));
    return candidate?.id ?? null;
  }

  return sessions[0]?.id ?? null;
}
