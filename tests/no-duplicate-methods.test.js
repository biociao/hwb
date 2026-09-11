import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// 结构性回归：同一个类里不允许出现重复的方法名。
//
// 为什么值得单独一条测试：JS 里**后定义的会静默覆盖先定义的**，不报错、不警告。
// 本次代码回顾就真的踩到了 —— 把 store.getHome 从 `listHomes().find(...)` 改成点查时，
// 新实现被插到了 listHomes 旁边，旧的那份留在原处没删：行为是对的（后定义生效，测试全绿），
// 但文件里躺着一份永不执行的旧实现。下次有人改上面那份，会以为改的就是真正生效的那个。

// 只认「整行就是方法签名」的行：`  name(args) {` / `  async name(args) {` / `  #name(args) {`。
// 这样不会把 SQL 的 `UNIQUE(homeId, sessionId)` 或 `} else if (cond) {` 误判成方法。
const METHOD_LINE = /^ {2}(?:static )?(?:async )?(?:#[A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{$/;

// `  if (cond) {` / `  for (...) {` 这类语句与「无参方法」在字面上完全同形，必须靠关键字排除。
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'else', 'do', 'try', 'finally', 'return', 'constructor']);

function methodName(line) {
  const m = METHOD_LINE.exec(line);
  if (!m) return null;
  const name = m[0].trim().replace(/\s*\(.*$/, '').replace(/^(?:static |async )/, '').replace(/^#/, '');
  return KEYWORDS.has(name) ? null : name;
}

async function jsFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await jsFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

test('同一个类里没有重复的方法定义（后定义会静默覆盖先定义）', async () => {
  // 只查核心运行时代码；前端组件是单函数模块，没有类。
  const files = await jsFiles(path.join(root, 'src'));
  const duplicates = [];
  for (const file of files) {
    const lines = (await readFile(file, 'utf8')).split('\n');
    const seen = new Map();
    for (let i = 0; i < lines.length; i++) {
      const name = methodName(lines[i]);
      if (!name) continue;
      if (!seen.has(name)) seen.set(name, []);
      seen.get(name).push(i + 1);
    }
    for (const [name, at] of seen) {
      if (at.length > 1) duplicates.push(`${path.relative(root, file)}: ${name} 定义于第 ${at.join(' / ')} 行`);
    }
  }
  assert.deepEqual(duplicates, [], `发现重复的方法定义（只有最后一个会生效）：\n${duplicates.join('\n')}`);
});

test('重复方法扫描器自身有效（对已知重复能报出来）', () => {
  const sample = [
    'class A {',
    '  foo(x) {',
    '    return 1;',
    '  }',
    '  foo(x) {',
    '    return 2;',
    '  }',
    '}',
  ];
  const lines = sample;
  const seen = new Map();
  for (let i = 0; i < lines.length; i++) {
    const name = methodName(lines[i]);
    if (!name) continue;
    seen.set(name, (seen.get(name) ?? []).concat(i + 1));
  }
  assert.deepEqual(seen.get('foo'), [2, 5], '扫描器应能识别出重复的 foo');

  // 反向：SQL、控制流语句、普通调用都不该被误判
  for (const line of ['  UNIQUE(homeId, sessionId)', '  } else if (cond) {', '  if (a && b) {', '  for (let i = 0; i < n; i++) {', '  while (true) {', '   const x = f(1);']) {
    assert.equal(methodName(line), null, `不应把这一行当成方法定义：${line}`);
  }
  // 正向：带修饰符/私有/异步的签名要认得出来
  assert.equal(methodName('  async foo(a, b) {'), 'foo');
  assert.equal(methodName('  #bar() {'), 'bar');
  assert.equal(methodName('  static baz() {'), 'baz');
});
