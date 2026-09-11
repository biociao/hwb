// Node 版本门槛检查。
//
// 索引层用的是 Node 内置的 `node:sqlite`，它在 **22.5.0** 才加入。低于该版本时
// `import { DatabaseSync } from 'node:sqlite'` 只会抛 `ERR_UNKNOWN_BUILTIN_MODULE:
// No such built-in module: node:sqlite` —— 报错完全指不到根因（看起来像缺依赖，
// 而本项目是零依赖），用户很容易以为是没跑 npm install。
//
// 因此启动路径上提前给一句能照做的提示，并且把版本要求集中在这一处：
// package.json 的 engines、CLI 的 doctor、server 的启动预检都指向同一个常量。

export const MIN_NODE = '22.5.0';

/** 语义化版本比较：version >= min 时返回 true。非法输入按「不满足」处理。 */
export function isNodeSupported(version = process.versions.node, min = MIN_NODE) {
  const cur = parse(version);
  const want = parse(min);
  if (!cur || !want) return false;
  for (let i = 0; i < 3; i++) {
    if (cur[i] !== want[i]) return cur[i] > want[i];
  }
  // 主次修订都相同：带预发布标记（如 22.5.0-rc.1）视为不满足正式版门槛。
  return !/-/.test(String(version));
}

function parse(value) {
  // process.version 带 'v' 前缀（如 v22.21.1），也接受不带前缀的写法。
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(value ?? ''));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function nodeRequirementMessage(version = process.versions.node) {
  return `hwb 需要 Node.js ≥ ${MIN_NODE}（当前 ${version}）。\n`
    + '原因：本地索引使用内置模块 node:sqlite，它自 22.5.0 起才提供；更早的版本只会报\n'
    + '  ERR_UNKNOWN_BUILTIN_MODULE: No such built-in module: node:sqlite\n'
    + '本项目零 npm 依赖，无需也不能靠 npm install 解决。请升级后重试：\n'
    + '  nvm install 22 && nvm use 22    # 或安装 Node 22.5+ / 更新的 LTS';
}

/**
 * 版本不满足时打印可操作提示并退出（返回 true 表示通过）。
 * exit/error 可注入，便于测试。
 */
export function enforceNodeVersion(version = process.versions.node, { exit, error } = {}) {
  if (isNodeSupported(version)) return true;
  (error ?? console.error)(nodeRequirementMessage(version));
  (exit ?? process.exit)(1);
  return false;
}
