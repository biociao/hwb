import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openWorkspaceInFinder } from '../src/lib/open-workspace.js';
import { addWorkspaceFinderMenu } from '../src/control/workspace-menu.js';

test('Finder opens the selected workspace as one argument without a shell', async () => {
  let args;
  await openWorkspaceInFinder({ hostType: 'local' }, { path: process.cwd() }, {
    platform: 'darwin', run: async (...values) => { args = values; },
  });
  assert.deepEqual(args.slice(0, 2), ['/usr/bin/open', ['-a', 'Finder', process.cwd()]]);
});
test('Finder rejects remote, missing and unsupported workspaces before launching', async () => {
  const run = () => assert.fail('must not launch');
  for (const [home, workspace, platform] of [
    [{ hostType: 'remote' }, { path: process.cwd() }, 'darwin'],
    [{ hostType: 'local' }, null, 'darwin'],
    [{ hostType: 'local' }, { path: process.cwd() }, 'linux'],
    [{ hostType: 'local' }, { path: 'relative' }, 'darwin'],
  ]) await assert.rejects(openWorkspaceInFinder(home, workspace, { platform, run }));
});
test('native workspace menu extension requires both known integration points', () => {
  const source = 'const workspaceMenuItems = [{ }]; if (id !== "rename" && id !== "delete") return;';
  const result = addWorkspaceFinderMenu(source);
  assert.match(result, /在 Finder 中打开工作区/);
  assert.match(result, /detail: row.workspaceId/);
  assert.equal(addWorkspaceFinderMenu('const workspaceMenuItems = [{ }];'), 'const workspaceMenuItems = [{ }];');
});
