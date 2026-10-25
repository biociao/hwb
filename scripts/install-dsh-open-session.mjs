#!/usr/bin/env node
// 安装/卸载 dsh-hwb-open-session 到 DSH 桌面端 profile。
//
//   node scripts/install-dsh-open-session.mjs                 # 安装到 ~/.dsh/profiles/desktop
//   node scripts/install-dsh-open-session.mjs --dry-run
//   node scripts/install-dsh-open-session.mjs --uninstall
//   node scripts/install-dsh-open-session.mjs --home /path/to/.dsh --profile desktop
//
// 为什么不是 `dsh plugin --profile desktop add`：dsh CLI 拒绝写 desktop profile
//（"managed exclusively by the Electron application"）。本脚本做等价的最小文件操作，
// 并在改动前备份 package.json。

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_PROFILE,
  defaultDshHome,
  installOpenSessionPlugin,
  planInstall,
  uninstallOpenSessionPlugin,
} from '../src/lib/install-plugin.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_DIR = path.join(REPO_ROOT, 'dsh-hwb-open-session');

function parseArgs(argv) {
  const opts = { home: defaultDshHome(), profile: DEFAULT_PROFILE, pluginDir: PLUGIN_DIR, dryRun: false, uninstall: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--home': opts.home = path.resolve(argv[++i]); break;
      case '--profile': opts.profile = argv[++i]; break;
      case '--plugin': opts.pluginDir = path.resolve(argv[++i]); break;
      case '--dry-run': opts.dryRun = true; break;
      case '--uninstall': opts.uninstall = true; break;
      case '--force': opts.force = true; break;
      case '-h':
      case '--help':
        console.log('用法: node scripts/install-dsh-open-session.mjs [--home <dshHome>] [--profile desktop] [--plugin <dir>] [--dry-run] [--uninstall] [--force]');
        process.exit(0);
        break;
      default:
        console.error(`未知参数: ${arg}`);
        process.exit(2);
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
try {
  if (opts.uninstall) {
    const result = uninstallOpenSessionPlugin({ homePath: opts.home, profile: opts.profile, dryRun: opts.dryRun });
    if (!result.changed) console.log('未安装 dsh-hwb-open-session，无需卸载。');
    else {
      console.log(`已卸载（备份：${result.backup ?? 'dry-run 未写盘'}）`);
      for (const note of result.notes) console.log(`  · ${note}`);
      console.log('重启 DeepSeek Harness 后生效。');
    }
    process.exit(0);
  }

  // 先做一次只读计划，帮助用户确认路径（--dry-run 时也走这里）。
  const plan = planInstall({ homePath: opts.home, pluginDir: opts.pluginDir, profile: opts.profile });
  console.log(`DSH home : ${opts.home}`);
  console.log(`profile  : ${plan.profileDir}`);
  console.log(`plugin   : ${opts.pluginDir}`);
  console.log(`状态     : ${plan.changed ? '需要安装/更新' : '已安装'}`);
  for (const note of plan.notes) console.log(`  · ${note}`);

  const result = installOpenSessionPlugin({
    homePath: opts.home,
    pluginDir: opts.pluginDir,
    profile: opts.profile,
    dryRun: opts.dryRun,
    force: opts.force,
  });
  if (!result.changed) {
    console.log('\n已经安装，无需改动。');
    process.exit(0);
  }
  if (opts.dryRun) {
    console.log('\n[dry-run] 未写盘：');
    for (const note of result.notes) console.log(`  · ${note}`);
    process.exit(0);
  }
  console.log(`\n已安装（package.json 备份：${result.backup}）。`);
  console.log('请**完全退出并重新打开** DeepSeek Harness，插件在 App 启动时加载。');
  console.log('之后在 hwb 里点击本地 dsh 的会话/项目行就会在 App 中打开对应会话。');
  console.log('卸载：node scripts/install-dsh-open-session.mjs --uninstall');
} catch (error) {
  console.error(`安装失败：${error.message}`);
  process.exit(1);
}
