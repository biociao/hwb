import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isThreadId } from './reader.js';

// 「跳到 Codex 对应项目/会话」唯一的入口：走 ChatGPT/Codex 桌面版注册的 `codex://` 深链。
//
// 已实测（2026-10-23，Codex 26.1016.62342）：
//   open "codex://threads/<threadId>"  →  桌面端收到并执行 thread/resume（app-server 日志可见）。
// 比 `codex resume <id>` 好在不需要终端、不需要 Codex 在 PATH、也不会在别处开一个新进程。
// 非 macOS 平台没有 `open(1)`：不猜 xdg-open/start 的语义，直接回退成可复制的 CLI 命令。

const OPEN_TIMEOUT_MS = 8_000;

const execFileAsync = promisify(execFile);

export function deepLinkFor(threadId) {
  // 只接受 UUID：`codex://threads/<id>` 会被桌面端 scheme handler 接走，任何拼接都必须先过白名单，
  // 否则一个 `..%2f` / 查询串注入就可能变成任意 URL 派发。
  if (!isThreadId(threadId)) throw new Error('无效的 Codex threadId');
  return `codex://threads/${threadId.toLowerCase()}`;
}

/**
 * @returns {Promise<{ok:boolean, threadId:string, url:string, fallback?:string, error?:string}>}
 */
export async function openCodexThread(threadId, { platform = process.platform, runner = execFileAsync } = {}) {
  const url = deepLinkFor(threadId); // 校验失败直接抛（调用方按 400 处理）
  const fallback = `codex resume ${threadId}`;

  if (platform !== 'darwin') {
    return { ok: false, threadId, url, fallback, error: `当前平台（${platform}）不支持自动跳转 Codex，请手动执行：${fallback}` };
  }
  try {
    await runner('/usr/bin/open', [url], { timeout: OPEN_TIMEOUT_MS });
    return { ok: true, threadId, url, fallback };
  } catch (error) {
    // 典型失败：没装 ChatGPT.app / LaunchServices 里没有 codex scheme。把可复制的命令带回去，
    // 让前端能给出「手动打开」而不是一个没有下文的 5xx。
    return { ok: false, threadId, url, fallback, error: `未能唤起 Codex：${error?.message ?? error}` };
  }
}
