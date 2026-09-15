import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Launcher } from '../src/control/launcher.js';

// Launcher.syncTheme / syncThemeOnConnect 的单测。
//
// 这两条是「hwb 主题怎么落到 dsh 上」的执行层：本机写文件、远程走 ssh（可注入）。
// 重点在**失败语义**：连接本身是主任务，主题同步失败绝不能把它拖坏；
// 但失败也不能被静默吞掉 —— 调用方要能如实告诉用户。

function localHome(dir) {
  return { homeId: 'a'.repeat(16), hostType: 'local', homePath: dir, alias: '本机' };
}
function remoteHome() {
  return { homeId: 'b'.repeat(16), hostType: 'remote', host: 'cms.lo', remotePort: 3080, remoteHome: '~/.dsh', alias: '远端' };
}

test('本机实例：写进 settings.yaml，且返回 transport=file', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hwb-launcher-theme-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'settings.yaml'), 'locale:\n  preference: zh\n');

  const launcher = new Launcher();
  const result = await launcher.syncTheme(localHome(dir), 'dark');
  assert.equal(result.changed, true);
  assert.equal(result.transport, 'file');
  assert.equal(result.preference, 'dark');
  const text = readFileSync(join(dir, 'settings.yaml'), 'utf8');
  assert.match(text, /locale:\n  preference: zh/);
  assert.match(text, /ui-theme:\n  preference: dark/);
});

test('本机实例：同值重复下发不重复写（changed=false）', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hwb-launcher-theme2-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const launcher = new Launcher();
  const home = localHome(dir);
  assert.equal((await launcher.syncTheme(home, 'dark')).changed, true);
  assert.equal((await launcher.syncTheme(home, 'dark')).changed, false);
});

test('远程实例：走注入的写入器，命令里带的是该实例的 home 与偏好', async () => {
  const seen = [];
  const launcher = new Launcher({
    remoteThemeWriter: async (home, preference) => {
      seen.push({ host: home.host, preference });
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  const result = await launcher.syncTheme(remoteHome(), 'system');
  assert.equal(result.transport, 'ssh');
  assert.equal(result.path, '~/.dsh/settings.yaml');
  assert.deepEqual(seen, [{ host: 'cms.lo', preference: 'system' }]);
});

test('远程实例：写入器返回非 0 → 抛错（附退出码与 stderr 尾部，便于排查）', async () => {
  const launcher = new Launcher({
    remoteThemeWriter: async () => ({ code: 255, stdout: '', stderr: 'ssh: connect to host cms.lo port 22: timed out\n' }),
  });
  await assert.rejects(
    () => launcher.syncTheme(remoteHome(), 'dark'),
    (error) => {
      assert.match(error.message, /远端主题写入失败/);
      assert.match(error.message, /255/);
      assert.match(error.message, /timed out/);
      return true;
    },
  );
});

test('远程实例：无 stderr 时错误信息仍可读（不留空）', async () => {
  const launcher = new Launcher({ remoteThemeWriter: async () => ({ code: 1, stdout: '', stderr: '' }) });
  await assert.rejects(() => launcher.syncTheme(remoteHome(), 'dark'), /无错误输出/);
});

test('非法偏好被拒（本机与远端都不会写出坏值）', async () => {
  const launcher = new Launcher({ remoteThemeWriter: async () => ({ code: 0 }) });
  await assert.rejects(() => launcher.syncTheme(remoteHome(), 'purple'), /invalid theme preference/);
  await assert.rejects(() => launcher.syncTheme(localHome('/tmp'), null), /invalid theme preference/);
});

test('syncThemeOnConnect：成功时回 {ok:true}，失败时回 {ok:false} 而**不抛**', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hwb-launcher-theme3-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const launcher = new Launcher({
    remoteThemeWriter: async () => ({ code: 255, stdout: '', stderr: 'boom' }),
  });
  const ok = await launcher.syncThemeOnConnect(localHome(dir), 'dark');
  assert.equal(ok.ok, true);

  const bad = await launcher.syncThemeOnConnect(remoteHome(), 'dark');
  assert.equal(bad.ok, false, '失败必须被表达成返回值，不能抛');
  assert.match(bad.error, /远端主题写入失败/);
});

test('syncThemeOnConnect：偏好非法时直接跳过（返回 null，不触碰实例）', async () => {
  let called = 0;
  const launcher = new Launcher({ remoteThemeWriter: async () => { called += 1; return { code: 0 }; } });
  assert.equal(await launcher.syncThemeOnConnect(remoteHome(), 'purple'), null);
  assert.equal(await launcher.syncThemeOnConnect(remoteHome(), undefined), null);
  assert.equal(called, 0, '非法偏好不该发出任何远端命令');
});

test('syncThemeOnConnect：本机 home 路径不可写时也不抛（连接照样成功）', async () => {
  const launcher = new Launcher();
  // 不存在的父路径 + 不可创建的路径：/proc 在 macOS 上不存在，用只读的 / 根下的假路径
  const result = await launcher.syncThemeOnConnect(
    { homeId: 'c'.repeat(16), hostType: 'local', homePath: '/dev/null/not-a-dir' },
    'dark',
  );
  assert.equal(result.ok, false);
  assert.ok(result.error, '应当带上失败原因');
});
