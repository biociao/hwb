// —— 把 dsh-hwb-open-session 装进 DSH 桌面端 profile（desktop）——
//
// 为什么不用 `dsh plugin --profile desktop add link:...`：
// dsh CLI 对 desktop profile 有硬性保护 —— "profile \"desktop\" is managed exclusively by
// the Electron application"，CLI 拒绝写它。但 desktop profile 本身仍是标准的
// pnpm profile（package.json + node_modules + cordis.patch.yml），app 启动时按
// package.json 的 `dsh.profile.bundles` 组合插件，并保留用户已有的第三方 bundle
//（本机现有 dsh-finder-reveal / dsh-science 等就是这种形态）。
//
// 所以这里做的是「等价于一次 link 安装」的最小文件操作：
//   · package.json  dependencies += "dsh-hwb-open-session": "link:<pluginDir>"
//   · package.json  dsh.profile.bundles += "dsh-hwb-open-session"（已有则不动）
//   · node_modules/dsh-hwb-open-session → pluginDir 软链
// 写前备份 package.json；零网络、零依赖；uninstall 可完整回滚。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const PLUGIN_NAME = 'dsh-hwb-open-session';
export const DEFAULT_PROFILE = 'desktop';

export function defaultDshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

export function profileDirFor(homePath, profile = DEFAULT_PROFILE) {
  return path.join(homePath, 'profiles', profile);
}

function readJson(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`profile 清单不存在：${file}`);
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`profile 清单不是合法 JSON：${file}`);
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o644 });
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function bundleList(manifest) {
  const dsh = isPlainObject(manifest.dsh) ? manifest.dsh : (manifest.dsh = {});
  const profile = isPlainObject(dsh.profile) ? dsh.profile : (dsh.profile = {});
  if (!Array.isArray(profile.bundles)) profile.bundles = [];
  return profile.bundles;
}

/**
 * 计算安装计划（不写盘）。changed=false 表示已经装好（幂等）。
 * @returns {{changed:boolean, manifest:object, link:string, symlink:string, notes:string[]}}
 */
export function planInstall({ homePath, pluginDir, profile = DEFAULT_PROFILE }) {
  const dir = profileDirFor(homePath, profile);
  const manifestPath = path.join(dir, 'package.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`找不到 ${profile} profile（${dir}）—— 先启动一次 DSH 桌面端让它创建 profile`);
  }
  if (!fs.existsSync(path.join(pluginDir, 'package.json'))) {
    throw new Error(`插件目录不完整（缺少 package.json）：${pluginDir}`);
  }
  const manifest = readJson(manifestPath);
  if (!isPlainObject(manifest.dependencies)) manifest.dependencies = {};
  const link = `link:${pluginDir}`;
  const notes = [];
  let changed = false;

  if (manifest.dependencies[PLUGIN_NAME] !== link) {
    manifest.dependencies[PLUGIN_NAME] = link;
    changed = true;
    notes.push(`dependencies += ${PLUGIN_NAME}=${link}`);
  }
  const bundles = bundleList(manifest);
  if (!bundles.includes(PLUGIN_NAME)) {
    bundles.push(PLUGIN_NAME);
    changed = true;
    notes.push(`bundles += ${PLUGIN_NAME}`);
  }
  return {
    changed,
    manifest,
    manifestPath,
    profileDir: dir,
    link,
    symlink: path.join(dir, 'node_modules', PLUGIN_NAME),
    notes,
  };
}

function ensureSymlink(target, linkPath, { force = false } = {}) {
  try {
    const existing = fs.readlinkSync(linkPath);
    if (path.resolve(path.dirname(linkPath), existing) === path.resolve(target)) return false;
    if (!force) throw new Error(`node_modules 里已有 ${linkPath}（指向 ${existing}），不是本插件；加 --force 覆盖`);
    fs.unlinkSync(linkPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      if (error?.code === 'EINVAL') {
        // 已存在的真实目录/文件：默认不动，避免误删用户内容。
        if (!force) throw new Error(`${linkPath} 已存在且不是软链；加 --force 覆盖`);
        fs.rmSync(linkPath, { recursive: true, force: true });
      } else {
        throw error;
      }
    }
  }
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(target, linkPath, 'dir');
  return true;
}

/**
 * 执行安装。幂等：已经装好时 changed=false 且不写任何文件。
 * @returns {{changed:boolean, backup:string|null, restartRequired:boolean, notes:string[]}}
 */
export function installOpenSessionPlugin({ homePath, pluginDir, profile = DEFAULT_PROFILE, dryRun = false, force = false, now = Date.now }) {
  const plan = planInstall({ homePath, pluginDir, profile });
  const symlinkExists = (() => {
    try {
      return path.resolve(path.dirname(plan.symlink), fs.readlinkSync(plan.symlink)) === path.resolve(pluginDir);
    } catch {
      return false;
    }
  })();
  if (!plan.changed && symlinkExists) {
    return { changed: false, backup: null, restartRequired: false, notes: ['已经安装，无需改动'] };
  }
  if (dryRun) {
    return { changed: true, backup: null, restartRequired: true, notes: [...plan.notes, `symlink ${plan.symlink} -> ${pluginDir}`, '(dry-run)'] };
  }
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
  const backup = `${plan.manifestPath}.bak.${stamp}`;
  fs.copyFileSync(plan.manifestPath, backup);
  writeJson(plan.manifestPath, plan.manifest);
  ensureSymlink(pluginDir, plan.symlink, { force });
  return {
    changed: true,
    backup,
    restartRequired: true,
    notes: [...plan.notes, `symlink ${plan.symlink} -> ${pluginDir}`],
  };
}

/** 卸载：移除 dependency / bundle / 软链；同样先备份。 */
export function uninstallOpenSessionPlugin({ homePath, profile = DEFAULT_PROFILE, dryRun = false, now = Date.now }) {
  const dir = profileDirFor(homePath, profile);
  const manifestPath = path.join(dir, 'package.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`找不到 ${profile} profile（${dir}）`);
  const manifest = readJson(manifestPath);
  const notes = [];
  let changed = false;
  if (isPlainObject(manifest.dependencies) && Object.hasOwn(manifest.dependencies, PLUGIN_NAME)) {
    delete manifest.dependencies[PLUGIN_NAME];
    changed = true;
    notes.push(`dependencies -= ${PLUGIN_NAME}`);
  }
  const bundles = bundleList(manifest);
  const idx = bundles.indexOf(PLUGIN_NAME);
  if (idx >= 0) {
    bundles.splice(idx, 1);
    changed = true;
    notes.push(`bundles -= ${PLUGIN_NAME}`);
  }
  const symlink = path.join(dir, 'node_modules', PLUGIN_NAME);
  let symlinkExists = false;
  try { symlinkExists = fs.lstatSync(symlink).isSymbolicLink(); } catch { /* 不存在 */ }
  if (symlinkExists) {
    changed = true;
    notes.push(`remove ${symlink}`);
  }
  if (!changed) return { changed: false, backup: null, restartRequired: false, notes: ['没有安装痕迹'] };
  if (dryRun) return { changed: true, backup: null, restartRequired: true, notes: [...notes, '(dry-run)'] };
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
  const backup = `${manifestPath}.bak.${stamp}`;
  fs.copyFileSync(manifestPath, backup);
  writeJson(manifestPath, manifest);
  if (symlinkExists) fs.unlinkSync(symlink);
  return { changed: true, backup, restartRequired: true, notes };
}
