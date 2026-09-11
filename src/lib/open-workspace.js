import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';

export async function openWorkspaceInFinder(home, workspace, { platform = process.platform, run = promisify(execFile) } = {}) {
  if (!home) throw new Error('实例不存在');
  if (home.hostType !== 'local') throw new Error('远程工作区无法直接在本机 Finder 中打开');
  if (platform !== 'darwin') throw new Error('在 Finder 中打开需要 hwb 运行于 macOS');
  if (!workspace?.path || !path.isAbsolute(workspace.path)) throw new Error('工作区目录不可用');
  // stat 直接抛的话，界面上会显示裸 errno（`ENOENT: no such file or directory, stat '/x/y'`）——
  // 与预览/下载路径同源的问题：用户看不懂，也不知道该怎么办。
  let info;
  try {
    info = await stat(workspace.path);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('工作区目录不存在，可能已被移动或删除');
    if (error?.code === 'EACCES' || error?.code === 'EPERM') throw new Error('没有访问该目录的权限');
    throw error;
  }
  if (!info.isDirectory()) throw new Error('工作区路径不是目录');
  await run('/usr/bin/open', ['-a', 'Finder', workspace.path], { timeout: 10000 });
}
