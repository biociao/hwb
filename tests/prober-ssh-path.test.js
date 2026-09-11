import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { buildSshPathCommand, shellSingleQuote, sshPathExists } from '../src/control/prober.js';

// 远端 home 路径会被拼进 `ssh host "<cmd>"`，由**远端登录 shell**解释。
// 原生实现里 `~` 开头的路径是裸拼的：一个空格就让 `test -d` 收到多个参数而误判「不可访问」，
// 而 `;` / `$()` 更会被远端直接执行（remoteHome 只经过 trim 校验）。
// 这里锁定「任何路径都按字面量引用、同时 `~` 仍能展开」这条契约。

test('shellSingleQuote: 单引号包裹，内部单引号用收尾-转义-续接', () => {
  assert.equal(shellSingleQuote('/a/b'), "'/a/b'");
  assert.equal(shellSingleQuote("/a/it's"), "'/a/it'\\''s'");
  assert.equal(shellSingleQuote(''), "''");
});

test('buildSshPathCommand: 含空格的路径整体加引号（原先会被 test -d 当成多个参数）', () => {
  assert.equal(buildSshPathCommand('/abs/my dsh'), "test -d '/abs/my dsh'");
  assert.equal(buildSshPathCommand('~/my dsh'), `test -d "$HOME"'/my dsh'`);
});

test('buildSshPathCommand: shell 元字符一律按字面量处理', () => {
  // 双引号里 $(...) 仍会执行（实测），所以必须落在单引号段里。
  assert.equal(buildSshPathCommand('~/a$(touch /tmp/pwned)'), `test -d "$HOME"'/a$(touch /tmp/pwned)'`);
  assert.equal(buildSshPathCommand('/a; rm -rf /'), "test -d '/a; rm -rf /'");
  assert.equal(buildSshPathCommand('/a`id`'), "test -d '/a`id`'");
  assert.equal(buildSshPathCommand('/a"b'), `test -d '/a"b'`);
  assert.equal(buildSshPathCommand("/a'b"), `test -d '/a'\\''b'`);
  for (const p of ['~/a$(x)', '/a;b', '/a`x`', '/a|b', '/a&b', '/a>b']) {
    const cmd = buildSshPathCommand(p);
    // 除 `"$HOME"` 这一段外，不应出现未被单引号包住的 $ 或反引号
    const outsideQuotes = cmd.replace(/"\$HOME"/g, '').replace(/'[^']*'/g, '');
    assert.doesNotMatch(outsideQuotes, /[$`;|&<>]/, `未引用段里残留元字符: ${cmd}`);
  }
});

test('buildSshPathCommand: ~ 与 ~/… 展开成 $HOME，~user 按字面量（与 expandHome 一致）', () => {
  assert.equal(buildSshPathCommand('~'), 'test -d "$HOME"\'\'');
  assert.equal(buildSshPathCommand('~/.dsh'), `test -d "$HOME"'/.dsh'`);
  assert.equal(buildSshPathCommand('~user/x'), "test -d '~user/x'");
});

test('buildSshPathCommand: 真实 bash 下引号语义正确（~ 展开、注入不生效）', async () => {
  const expand = (cmd) => new Promise((resolve, reject) => {
    execFile('bash', ['-c', `printf %s ${cmd.replace(/^test -d /, '')}`], (err, stdout) => err ? reject(err) : resolve(stdout));
  });
  const home = process.env.HOME;
  assert.equal(await expand(buildSshPathCommand('~/.dsh')), `${home}/.dsh`);
  // 注入尝试必须原样作为文本出现，而不是被执行
  assert.equal(await expand(buildSshPathCommand('~/$(echo PWNED)')), `${home}/$(echo PWNED)`);
  assert.equal(await expand(buildSshPathCommand('/a b')), '/a b');
});

test('sshPathExists: 把引号处理后的命令交给注入的 ssh runner，失败时返回 false', async () => {
  const calls = [];
  const run = async (bin, argv) => { calls.push({ bin, argv }); };
  assert.equal(await sshPathExists('me@host', '~/my dsh', 1000, run), true);
  assert.equal(calls[0].bin, 'ssh');
  assert.equal(calls[0].argv.at(-1), `test -d "$HOME"'/my dsh'`, '传给远端 shell 的必须是加引号的命令');
  assert.equal(calls[0].argv.at(-2), 'me@host');

  const failing = async () => { throw new Error('exit 2'); };
  assert.equal(await sshPathExists('me@host', '/x', 1000, failing), false);
  assert.equal(await sshPathExists('', '/x', 1000, failing), false, '缺 host 直接 false，不发命令');
  assert.equal(await sshPathExists('me@host', '', 1000, failing), false, '缺路径直接 false');
});
