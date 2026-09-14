#!/usr/bin/env node
/**
 * `hwb compat` —— 升级 dsh 后的一键兼容性检查（给人看的输出）。
 *
 * ## 为什么不直接用测试框架
 *
 * 契约测试（`tests/compat/`）是给 CI 与开发者看的 TAP 输出，几十行 JSON，人读起来费劲。
 * 而升级 dsh 时的真实问题是**一个二值判断**：
 *
 *   「我升级了 dsh，hwb 还能用吗？不能用的话改哪里？」
 *
 * 所以这个脚本只回答这件事：读本机装的 dsh 的契约 → 与 hwb 的假设比对 →
 * 打印结论 + 可照做的修复指引，并在不兼容时以非 0 退出（可进 CI）。
 *
 * ## 与 `hwb doctor` 的区别
 *
 * - `hwb compat`：**只查契约**，不问服务是否运行、不读 home。适合刚换完 dsh 立刻跑。
 * - `hwb doctor`：更宽的体检（Node / 配置 / 服务 HTTP / 契约 / 本机 home 可读性）。
 *
 * 两者共用 `src/lib/dsh-compat.js`，结论不会互相矛盾。
 *
 * 用法：
 *   node scripts/compat-check.mjs           # 人类可读
 *   node scripts/compat-check.mjs --json    # 机器可读（CI 用）
 *   node scripts/compat-check.mjs --verbose # 附带每个域提取到的原始规格
 */

import { checkDshCompat, formatDshCompat } from '../src/lib/dsh-compat.js';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const verbose = args.includes('--verbose') || args.includes('-v');

const report = checkDshCompat();

if (asJson) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.ok ? 0 : 1);
}

const line = '─'.repeat(64);
console.log(line);
console.log('hwb ↔ dsh 兼容性检查');
console.log(line);

// 找不到 dsh 时也要走完**同样的输出骨架**（含结论行与分隔线）：
// 早退时只打印两行说明，会让「脚本输出里必有结论行」这条不变式不成立
// （CI 上没装 dsh 时，下游按结论行做判断就会落空 —— 实测就是被测试抓到的）。
if (!report.available) {
  console.log(report.summary);
  console.log();
  console.log('结论：无法判定（本机未安装 dsh —— 不是错误，也无法给出兼容性结论）');
  console.log('提示：装 dsh 后再跑一次；或直接看 tests/compat 在有 dsh 的机器上的结论');
  console.log(line);
  process.exit(0);
}

console.log(`dsh 版本：${report.dshVersion ?? '未知'}`);
console.log(`安装位置：${report.dshRoot}`);
console.log();
console.log(formatDshCompat(report));

if (verbose) {
  console.log();
  console.log('提取到的域规格：');
  for (const [key, d] of Object.entries(report.domains)) {
    console.log(`  ${key}: version=${d.version} layout=${d.layout ?? 'single'} `
      + `accepted=${JSON.stringify(d.accepted)} tables=${JSON.stringify(d.tables ?? [])}`);
  }
}

console.log();
// 结论分**三种**，不能只按 `ok` 二值输出 —— 否则会出现自相矛盾的输出：
// 上面刚说「兼容性无法完全判定（2 个域提取失败）」，下面却盖一句「结论：兼容 ✓」。
// `ok` 只表示「已判定的契约都兼容」，提取失败是「无法判定」，必须单独说。
const unjudged = report.problems.filter((p) => p.kind === 'extract-failed').length;
let verdict;
if (!report.ok) {
  verdict = '存在不兼容 ✗';
} else if (unjudged) {
  verdict = `无法完全判定（${unjudged} 个域提取失败，见上）`;
} else {
  verdict = '兼容 ✓';
}
console.log(`结论：${verdict}`);
console.log(line);
// 退出码沿用 `ok`：提取失败不作为门禁失败（那通常是 dsh 内部重构，不是 hwb 的错），
// 但**不谎报兼容** —— 上面的结论行已如实说明。
process.exit(report.ok ? 0 : 1);
