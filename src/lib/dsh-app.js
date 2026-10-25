// —— DSH 桌面 App 探测与唤起（macOS）——
//
// hwb 的「按会话打开」依赖 DSH 桌面端在跑：插件（dsh-hwb-open-session）装在它的 profile 里，
// UI 才会轮询触发器。这里只做三件事：找到 .app、判断是否在跑、聚焦或启动。
// 全部通过注入 runner 实现可测试；非 macOS 一律返回不可用，不猜 xdg-open/start 语义。

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const APP_NAME = 'DeepSeek Harness';
const DEFAULT_RUN = promisify(execFile);

/** 主进程命令行里会出现的稳定片段（Helper 进程不含这一段，避免误判成「App 在跑」）。 */
export const APP_MAIN_PATTERN = `${APP_NAME}.app/Contents/MacOS/${APP_NAME}`;

/** 返回 .app 路径；找不到返回 null。 */
export function findDshAppPath({ platform = process.platform, home = os.homedir(), exists = existsSync } = {}) {
  if (platform !== 'darwin') return null;
  const candidates = [
    path.join('/Applications', `${APP_NAME}.app`),
    path.join(home, 'Applications', `${APP_NAME}.app`),
  ];
  for (const candidate of candidates) {
    try {
      if (exists(candidate)) return candidate;
    } catch { /* 无权限读目录：按不存在处理 */ }
  }
  return null;
}

/** `pgrep -f` 命中主进程 → true。pgrep 的退出码就是判据，stderr 不关心。 */
export async function isDshAppRunning({ run = DEFAULT_RUN, pattern = APP_MAIN_PATTERN } = {}) {
  try {
    await run('/usr/bin/pgrep', ['-f', pattern], { timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}

/** 聚焦主窗口：走 App 已注册的 `dsh://open`（app 的 open-url 只认这一个 URL）。 */
export async function focusDshApp({ run = DEFAULT_RUN } = {}) {
  await run('/usr/bin/open', ['dsh://open'], { timeout: 5_000 });
}

/** 启动 App（不等待其 UI ready；触发器有 2 分钟有效期，客户端启动后会自己取）。 */
export async function launchDshApp(appPath, { run = DEFAULT_RUN } = {}) {
  await run('/usr/bin/open', ['-a', appPath], { timeout: 10_000 });
}
