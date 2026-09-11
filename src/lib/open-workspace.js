import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';

export async function openWorkspaceInFinder(home, workspace, { platform = process.platform, run = promisify(execFile) } = {}) {
  if (!home) throw new Error('实例不存在');
  if (home.hostType !== 'local') throw new Error('远程工作区无法直接在本机 Finder 中打开');
  if (platform !== 'darwin') throw new Error('在 Finder 中打开需要 hwb 运行于 macOS');
  if (!workspace?.path || !path.isAbsolute(workspace.path)) throw new Error('工作区目录不可用');
  if (!(await stat(workspace.path)).isDirectory()) throw new Error('工作区路径不是目录');
  await run('/usr/bin/open', ['-a', 'Finder', workspace.path], { timeout: 10000 });
}
