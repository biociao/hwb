import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  THEME_PREFERENCES, isThemePreference, applyThemePreference, readSection, readSectionField,
  readThemePreference, writeThemePreference, remoteThemeSettingsPath, remoteThemeCommand,
} from '../src/lib/dsh-theme.js';

// 这一组测试盯住的是一件很具体的事：**我们只被允许改自己那一节**。
// dsh 的 settings.yaml 里有 API key、模型白名单、locale —— 写主题必须逐字节保住它们，
// 而且必须是**原子的**（dsh 用自己的 watcher 热重载这份文件，读到半截 YAML 就整份丢弃）。

function tempHome(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hwb-theme-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// 一份贴近真实的 settings.yaml：多个 namespace、嵌套、注释、引号、行尾注释。
const SAMPLE = [
  '# 用户设置（注释必须原样保住）',
  'locale:',
  '  preference: zh',
  'llm-pi-ai:',
  '  providers:',
  '    kimi-code:',
  '      apiKeyEnv: KIMI_CODE_API_KEY',
  '      baseURL: "https://api.kimi.com/coding/v1"',
  'ui-theme:',
  '  preference: light',
  '  fontSize: 15',
  'ui-onboarding:',
  '  welcomeNoticeVersion: 2026-08-13.1',
  '',
].join('\n');

test('只改动 ui-theme 一节，其它 namespace 与注释逐字节保留', () => {
  const out = applyThemePreference(SAMPLE, 'dark');
  assert.match(out, /^# 用户设置（注释必须原样保住）$/m);
  assert.match(out, /apiKeyEnv: KIMI_CODE_API_KEY/);
  assert.match(out, /baseURL: "https:\/\/api\.kimi\.com\/coding\/v1"/);
  assert.match(out, /welcomeNoticeVersion: 2026-08-13\.1/);
  assert.match(out, /^ui-theme:\n  preference: dark/m);
  // 同节里的别的字段（dsh 自己写的 fontSize）不能被我们顺手删掉。
  assert.match(out, /  fontSize: 15/);
  // 除 preference 那一行之外，整份文档其余部分必须与原文完全一致。
  const before = SAMPLE.split('\n').filter((l) => l !== '  preference: light');
  const after = out.split('\n').filter((l) => l !== '  preference: dark');
  assert.deepEqual(after, before);
});

test('重复应用同一偏好是幂等的（不产生 diff、不重写文件）', () => {
  const once = applyThemePreference(SAMPLE, 'dark');
  assert.equal(applyThemePreference(once, 'dark'), once);
});

test('文档里没有该节时追加一节，且不破坏原有内容', () => {
  const out = applyThemePreference('locale:\n  preference: zh\n', 'dark');
  assert.equal(out, 'locale:\n  preference: zh\nui-theme:\n  preference: dark\n');
});

test('空文档 / 不存在的文件（空串）不会写出前导空行', () => {
  assert.equal(applyThemePreference('', 'dark'), 'ui-theme:\n  preference: dark\n');
  const withTrailing = applyThemePreference('locale:\n  preference: zh', 'system');
  assert.equal(withTrailing, 'locale:\n  preference: zh\nui-theme:\n  preference: system\n');
});

test('非法偏好被拒绝（不写出一个 dsh 认不出的值）', () => {
  for (const bad of ['purple', '', null, undefined, 'LIGHT', 1]) {
    assert.equal(isThemePreference(bad), false);
    assert.throws(() => applyThemePreference(SAMPLE, bad), /invalid theme preference/);
  }
  for (const good of THEME_PREFERENCES) assert.equal(isThemePreference(good), true);
});

test('带引号的节名与带行内值的写法都能被识别', () => {
  const out = applyThemePreference(`'ui-theme': {}\n`, 'dark');
  assert.match(out, /preference: dark/);
});

test('readSection / readSectionField 基本语义', () => {
  const section = readSection(SAMPLE, 'ui-theme');
  assert.equal(section.found, true);
  assert.equal(section.body, 'ui-theme:\n  preference: light\n  fontSize: 15');
  assert.equal(readSectionField(section.body, 'preference'), 'light');
  assert.equal(readSection(section.body + '\n', 'nope').found, false);
});

test('子字段值带引号时读出去引号的值', () => {
  assert.equal(readSectionField('ui-theme:\n  preference: "dark"', 'preference'), 'dark');
  assert.equal(readSectionField("ui-theme:\n  preference: 'system'", 'preference'), 'system');
});

test('writeThemePreference：落盘、读回、权限、幂等', (t) => {
  const home = tempHome(t);
  writeFileSync(join(home, 'settings.yaml'), SAMPLE);

  const first = writeThemePreference(home, 'dark');
  assert.equal(first.changed, true);
  assert.equal(first.path, join(home, 'settings.yaml'));
  assert.equal(readThemePreference(home), 'dark');
  assert.match(readFileSync(first.path, 'utf8'), /apiKeyEnv: KIMI_CODE_API_KEY/);
  // 权限跟 dsh 一致（0600）：这份文件里有 API key。
  assert.equal(statSync(first.path).mode & 0o777, 0o600);

  const second = writeThemePreference(home, 'dark');
  assert.equal(second.changed, false, '同值不重写');
});

test('writeThemePreference：文件不存在时新建，目录权限 0700', (t) => {
  const home = tempHome(t);
  const nested = join(home, 'sub');
  const result = writeThemePreference(nested, 'light');
  assert.equal(result.changed, true);
  assert.equal(readThemePreference(nested), 'light');
  assert.equal(statSync(nested).mode & 0o777, 0o700);
});

test('writeThemePreference 是原子替换：不留临时文件、且不破坏原文件', (t) => {
  const home = tempHome(t);
  const file = join(home, 'settings.yaml');
  writeFileSync(file, SAMPLE);
  writeThemePreference(home, 'system');
  // 只应剩一个文件：临时文件必须已被 rename 走（或失败时被清掉）。
  assert.deepEqual(readdirSync(home), ['settings.yaml']);
  assert.match(readFileSync(file, 'utf8'), /^ui-theme:\n  preference: system/m);
});

test('readThemePreference：读不动/没有该节/值非法时回 null（而不是编一个默认值）', (t) => {
  const home = tempHome(t);
  assert.equal(readThemePreference(home), null, '文件不存在');
  writeFileSync(join(home, 'settings.yaml'), 'locale:\n  preference: zh\n');
  assert.equal(readThemePreference(home), null, '没有 ui-theme 节');
  writeFileSync(join(home, 'settings.yaml'), 'ui-theme:\n  preference: purple\n');
  assert.equal(readThemePreference(home), null, '值不是合法偏好');
});

test('crlf / 无末尾换行 / 空文件 都不炸，且换行风格被保留', (t) => {
  const home = tempHome(t);
  writeFileSync(join(home, 'settings.yaml'), 'locale:\r\n  preference: zh\r\nui-theme:\r\n  preference: light\r\n');
  assert.equal(readThemePreference(home), 'light');
  const out = writeThemePreference(home, 'dark');
  assert.equal(out.changed, true);
  const text = readFileSync(out.path, 'utf8');
  assert.equal(readThemePreference(home), 'dark');
  // 关键：不能在 CRLF 文件里插进一行 LF（混合换行 = 没必要的 diff）。
  assert.equal(text.includes('\n  preference: dark\n'), false);
  assert.match(text, /\r\n  preference: dark\r\n/);
  assert.equal(/\r\n/.test(text) && /[^\r]\n/.test(text), false, '不得出现混合换行');

  writeFileSync(join(home, 'settings.yaml'), '');
  assert.equal(writeThemePreference(home, 'dark').changed, true);
  assert.equal(readThemePreference(home), 'dark');

  // 无末尾换行：追加一节时必须先补一个换行，不能和上一行粘在一起。
  writeFileSync(join(home, 'settings.yaml'), 'locale:\n  preference: zh');
  writeThemePreference(home, 'system');
  const appended = readFileSync(join(home, 'settings.yaml'), 'utf8');
  assert.match(appended, /preference: zh\nui-theme:/);
});

test('remoteThemeSettingsPath 默认 ~/.dsh，且拼上 settings.yaml', () => {
  assert.equal(remoteThemeSettingsPath('~/.dsh'), '~/.dsh/settings.yaml');
  assert.equal(remoteThemeSettingsPath('/home/u/.dsh'), '/home/u/.dsh/settings.yaml');
  assert.equal(remoteThemeSettingsPath(''), '~/.dsh/settings.yaml');
  assert.equal(remoteThemeSettingsPath(null), '~/.dsh/settings.yaml');
});

// —— 远程命令：这是最容易写错的一处（shell 的 && / || 结合律、awk 的节边界）。
// 所以这里**真的执行它**（本机 bash），而不是只断言字符串长相。
function runRemote(t, initialYaml, preference) {
  const dir = tempHome(t);
  if (initialYaml !== null) writeFileSync(join(dir, 'settings.yaml'), initialYaml);
  const cmd = remoteThemeCommand(dir, preference);
  execFileSync('bash', ['-c', cmd], { stdio: 'pipe' });
  return { file: join(dir, 'settings.yaml'), dir };
}

test('远程命令：替换已有节，保住其它 namespace 与同节其它字段', (t) => {
  const { file } = runRemote(t, SAMPLE, 'dark');
  const text = readFileSync(file, 'utf8');
  assert.match(text, /^ui-theme:\n(  fontSize: 15\n)?  preference: dark$/m);
  assert.match(text, /apiKeyEnv: KIMI_CODE_API_KEY/);
  assert.match(text, /welcomeNoticeVersion: 2026-08-13\.1/);
  assert.match(text, /^# 用户设置（注释必须原样保住）$/m);
});

test('远程命令：节不存在时新增，不破坏原有内容', (t) => {
  const { file } = runRemote(t, 'locale:\n  preference: zh\n', 'system');
  const text = readFileSync(file, 'utf8');
  assert.match(text, /locale:\n  preference: zh/);
  assert.match(text, /ui-theme:\n  preference: system/);
});

test('远程命令：文件不存在时也能建出来（mkdir -p + 追加）', (t) => {
  const { file } = runRemote(t, null, 'dark');
  assert.equal(readFileSync(file, 'utf8'), 'ui-theme:\n  preference: dark\n');
});

test('远程命令：重复执行是幂等的（不重复追加节、不残留临时文件）', (t) => {
  const { file, dir } = runRemote(t, SAMPLE, 'dark');
  const once = readFileSync(file, 'utf8');
  // 再跑一次同一个偏好
  execFileSync('bash', ['-c', remoteThemeCommand(dir, 'dark')], { stdio: 'pipe' });
  assert.equal(readFileSync(file, 'utf8'), once);
  assert.equal((once.match(/^ui-theme:/gm) || []).length, 1, '不该出现第二个 ui-theme 节');
  assert.deepEqual(readdirSync(dir), ['settings.yaml'], '临时文件必须已 mv 走');
});

test('远程命令：把权限收到 0600（这份文件里有 API key）', (t) => {
  const { file } = runRemote(t, SAMPLE, 'dark');
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('远程命令：非法偏好直接抛（不把坏值发到远端）', () => {
  assert.throws(() => remoteThemeCommand('~/.dsh', 'purple'), /invalid theme preference/);
});

test('远程命令：home 路径含空格或单引号时仍然安全（正确转义）', (t) => {
  const dir = tempHome(t);
  const weird = join(dir, "we ird'quote");
  execFileSync('bash', ['-c', remoteThemeCommand(weird, 'dark')], { stdio: 'pipe' });
  assert.equal(readFileSync(join(weird, 'settings.yaml'), 'utf8'), 'ui-theme:\n  preference: dark\n');
});

test('远程命令：偏好值不会被解释成 shell 元字符', () => {
  const cmd = remoteThemeCommand('~/.dsh', 'dark');
  // 值只出现在引号内（awk -v 的单引号参数 + printf 的单引号字面量）
  assert.match(cmd, /awk -v pref='dark'/);
  assert.match(cmd, /printf 'ui-theme:\\n  preference: dark\\n'/);
});
