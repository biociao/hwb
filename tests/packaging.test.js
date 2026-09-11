import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 打包契约：package.json 里 `bin` 指向的文件必须**真的可执行**。
//
// 这条是今晚踩出来的：用户运行 `hwb stop` 得到 `zsh: permission denied: hwb`，
// 而 `which hwb` 偏偏看得到它 —— 因为全局 bin 是个软链
// （`~/.nvm/.../bin/hwb -> ../lib/node_modules/hwb/src/cli.js`），软链指到仓库里的
// `src/cli.js`，而那个文件是 **0644**。软链本身没问题，问题在目标文件缺可执行位。
//
// 为什么必须在**索引**里也是 100755（只 chmod 工作树不够）：`git status` 不会提示这种丢失 ——
// 索引本来就是 0644，工作树改成 0755 反而会被报成「有改动」。于是「谁把它清掉的」无从察觉，
// 下一次 checkout / 换机器 clone 就再回到 0644。今晚的形态正是如此：索引一直是 100644，
// 而可执行位来自当年 `npm link` 给工作树文件加的 +x。
test('package.json 的 bin 入口必须有 shebang、可执行位，且在 git 索引里是 100755', async () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const bins = Object.entries(pkg.bin ?? {});
  assert.ok(bins.length > 0, 'package.json 必须声明 bin（否则没有任何入口可回归）');

  for (const [name, rel] of bins) {
    const file = path.join(root, rel);
    assert.ok(fs.existsSync(file), `bin ${name} → ${rel} 不存在`);
    assert.match(fs.readFileSync(file, 'utf8').split('\n', 1)[0], /^#!/, `bin ${name} 缺少 shebang，无法直接执行`);
    const mode = fs.statSync(file).mode & 0o777;
    assert.ok(mode & 0o111,
      `bin ${name} → ${rel} 没有可执行位（实测 0o${mode.toString(8)}）；`
      + '症状是 `zsh: permission denied: hwb`，而 `which hwb` 仍然找得到它（软链指向这个文件）');
  }

  // 非 git 检出（例如从 tarball 安装）时跳过索引断言 —— 这条断言依赖 git。
  let indexed = null;
  try {
    indexed = execFileSync('git', ['ls-files', '-s', '--', ...bins.map(([, rel]) => rel)], { cwd: root, encoding: 'utf8' });
  } catch { /* 没有 git 或不在仓库里 */ }
  if (indexed === null) return;
  const lines = indexed.split('\n').filter(Boolean);
  assert.equal(lines.length, bins.length, '索引里应能找到全部 bin 目标文件（否则断言会空转）');
  for (const line of lines) {
    const [mode, , , rel] = line.split(/\s+/);
    assert.equal(mode, '100755',
      `${rel} 在 git 索引里是 ${mode}，必须是 100755 —— 否则 clone/checkout/link 之后 hwb 会报 permission denied`);
  }
});
