// scripts/install-dsh-open-session.mjs 背后的安装器契约：
//   · 幂等（装好后再跑不改文件、不产生新备份）；
//   · 只动 package.json 的 dependency/bundles 与 node_modules 软链，保留其它用户插件；
//   · 写前备份；dry-run 不落盘；卸载可回滚。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  PLUGIN_NAME,
  installOpenSessionPlugin,
  planInstall,
  profileDirFor,
  uninstallOpenSessionPlugin,
} from '../src/lib/install-plugin.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'install-dsh-open-session.mjs');

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hwb-install-plugin-'));
  const home = path.join(root, 'dsh');
  const pluginDir = path.join(root, 'plugin');
  fs.mkdirSync(path.join(pluginDir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({ name: PLUGIN_NAME, version: '0.1.0', type: 'module' }));
  const profileDir = profileDirFor(home, 'desktop');
  fs.mkdirSync(path.join(profileDir, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-desktop',
    private: true,
    dependencies: { 'other-plugin': 'link:/elsewhere' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'other-plugin'] } },
  }, null, 2) + '\n');
  return { root, home, pluginDir, profileDir, manifestPath: path.join(profileDir, 'package.json') };
}

test('planInstall：补齐 dependency 与 bundle，保留既有顺序', () => {
  const { home, pluginDir } = setup();
  const plan = planInstall({ homePath: home, pluginDir });
  assert.equal(plan.changed, true);
  assert.equal(plan.manifest.dependencies[PLUGIN_NAME], `link:${pluginDir}`);
  assert.equal(plan.manifest.dependencies['other-plugin'], 'link:/elsewhere');
  assert.deepEqual(plan.manifest.dsh.profile.bundles, [
    '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'other-plugin', PLUGIN_NAME,
  ]);
  assert.match(plan.symlink, /node_modules\/dsh-hwb-open-session$/);
});

test('install：写备份 + manifest + 软链；第二次幂等不再改', () => {
  const { home, pluginDir, manifestPath } = setup();
  const first = installOpenSessionPlugin({ homePath: home, pluginDir, now: () => Date.UTC(2026, 9, 24, 0, 0, 0) });
  assert.equal(first.changed, true);
  assert.ok(first.backup && fs.existsSync(first.backup), '必须有备份');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.dependencies[PLUGIN_NAME], `link:${pluginDir}`);
  assert.ok(manifest.dsh.profile.bundles.includes(PLUGIN_NAME));
  const link = path.join(profileDirFor(home, 'desktop'), 'node_modules', PLUGIN_NAME);
  assert.equal(fs.readlinkSync(link), pluginDir);

  const mtime = fs.statSync(manifestPath).mtimeMs;
  const second = installOpenSessionPlugin({ homePath: home, pluginDir });
  assert.equal(second.changed, false);
  assert.equal(second.backup, null);
  assert.equal(fs.statSync(manifestPath).mtimeMs, mtime, '幂等时不应该重写清单');
});

test('dry-run：只报告、不落盘', () => {
  const { home, pluginDir, manifestPath } = setup();
  const before = fs.readFileSync(manifestPath, 'utf8');
  const result = installOpenSessionPlugin({ homePath: home, pluginDir, dryRun: true });
  assert.equal(result.changed, true);
  assert.equal(result.backup, null);
  assert.equal(fs.readFileSync(manifestPath, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(profileDirFor(home, 'desktop'), 'node_modules', PLUGIN_NAME)), false);
});

test('uninstall：移除 dep/bundle/软链并可恢复', () => {
  const { home, pluginDir, manifestPath } = setup();
  installOpenSessionPlugin({ homePath: home, pluginDir });
  const result = uninstallOpenSessionPlugin({ homePath: home, profile: 'desktop' });
  assert.equal(result.changed, true);
  assert.ok(result.backup && fs.existsSync(result.backup));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(Object.hasOwn(manifest.dependencies, PLUGIN_NAME), false);
  assert.equal(manifest.dsh.profile.bundles.includes(PLUGIN_NAME), false);
  assert.equal(fs.existsSync(path.join(profileDirFor(home, 'desktop'), 'node_modules', PLUGIN_NAME)), false);
  // 其它插件不受影响
  assert.equal(manifest.dependencies['other-plugin'], 'link:/elsewhere');
});

test('防护：profile 缺失、插件目录不完整、已存在非本插件软链', () => {
  const { root, home, pluginDir } = setup();
  assert.throws(() => planInstall({ homePath: path.join(root, 'nope'), pluginDir }), /找不到 desktop profile/);
  assert.throws(() => planInstall({ homePath: home, pluginDir: path.join(root, 'missing') }), /插件目录不完整/);

  const foreign = path.join(root, 'foreign');
  fs.mkdirSync(foreign);
  const link = path.join(profileDirFor(home, 'desktop'), 'node_modules', PLUGIN_NAME);
  fs.symlinkSync(foreign, link, 'dir');
  assert.throws(() => installOpenSessionPlugin({ homePath: home, pluginDir }), /已有 .*不是本插件/);
  // --force 可以覆盖
  const forced = installOpenSessionPlugin({ homePath: home, pluginDir, force: true });
  assert.equal(forced.changed, true);
  assert.equal(fs.readlinkSync(link), pluginDir);
});

test('CLI 脚本：--dry-run 输出计划且不写盘，--home 指向自定义 profile', () => {
  const { home, manifestPath } = setup();
  const before = fs.readFileSync(manifestPath, 'utf8');
  const out = execFileSync(process.execPath, [SCRIPT, '--home', home, '--dry-run'], { encoding: 'utf8' });
  assert.match(out, /需要安装\/更新/);
  assert.match(out, /dry-run/);
  assert.equal(fs.readFileSync(manifestPath, 'utf8'), before);
});
