import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// 文档里写死的数字与清单会悄悄过期。README 原先写着「当前 62 个用例」，后来涨到 359、又到 419，
// 三次都没人发现；REST API 表也漏过 4 条已实现的路由。这里把**能自校验的部分**变成会失败的测试。

/** 从 routes.js 里抽出 `/api/homes/{homeId}/xxx` 形式的参数化路由（解析真实字面量，不手写清单）。 */
export function parameterizedRoutes(source) {
  const marker = 'pathname.match(/^\\/api\\/homes\\/([0-9a-f]{16})';
  const found = new Set();
  let index = source.indexOf(marker);
  while (index !== -1) {
    const rest = source.slice(index + marker.length);
    const end = rest.search(/\$/); // 正则字面量的结尾锚点
    if (end !== -1) {
      // 形如 `/upload$/`、`/(preview|download)$/`、`$/`（无后缀，即 {homeId} 本身）
      // 源码里的正则字面量把 `/` 写成 `\/`，先还原再拆段。
      const literal = rest.slice(0, end).replace(/\\\//g, '/');
      // 空后缀 = 正则到 `{16})` 就结束，即 `/api/homes/{homeId}` 本身（PUT/DELETE 用）。
      if (literal === '') { found.add('/api/homes/{homeId}'); }
      for (const seg of literal.replace(/^\//, '').replace(/[()]/g, '').split('|')) {
        if (seg) found.add(`/api/homes/{homeId}/${seg}`);
      }
    }
    index = source.indexOf(marker, index + marker.length);
  }
  return found;
}

/** 从 routes.js 里抽出字面量路径（`pathname === '/api/...'`）。 */
export function literalRoutes(source) {
  const found = new Set();
  for (const m of source.matchAll(/req\.method === '\w+' && pathname === '([^']+)'/g)) found.add(m[1]);
  return found;
}

test('README 的 REST API 表双向覆盖 src/api/routes.js 的路由', async () => {
  const [readme, routes] = await Promise.all([
    readFile(path.join(root, 'README.md'), 'utf8'),
    readFile(path.join(root, 'src', 'api', 'routes.js'), 'utf8'),
  ]);

  const literal = literalRoutes(routes);
  const parameterized = parameterizedRoutes(routes);

  // 先确认解析器本身有效 —— 否则下面的 for 循环会在空集合上「通过」，变成一个假测试
  // （第一版就是手写清单 + 手写转义，正则永远匹配不上，测试恒过而什么都没检查）。
  assert.ok(literal.size >= 8, `应解析出若干字面量路由，实际 ${literal.size}：${[...literal]}`);
  assert.ok(parameterized.size >= 8, `应解析出若干参数化路由，实际 ${parameterized.size}：${[...parameterized]}`);
  assert.ok(parameterized.has('/api/homes/{homeId}/upload'), `解析器应认出 upload，实际 ${[...parameterized]}`);

  // 方向一：代码里有 → 文档里必须有
  for (const p of literal) assert.ok(readme.includes(p), `README 的 REST API 表缺少已实现的路由：${p}`);
  for (const p of parameterized) assert.ok(readme.includes(p), `README 的 REST API 表缺少已实现的路由：${p}`);

  // 方向二：文档里写的 → 代码里必须真的存在
  const declared = [...readme.matchAll(/^\| `(?:GET|POST|PUT|DELETE|PATCH)` \| `([^`]+)` \|/gm)].map((m) => m[1]);
  assert.ok(declared.length >= 15, `应从 README 解析出 API 表，实际 ${declared.length} 行`);
  for (const p of declared) {
    const known = p.includes('{homeId}') ? parameterized.has(p) : literal.has(p);
    assert.ok(known, `README 声明了不存在的路由：${p}`);
  }
});

test('README 不写死会过期的计数（用例条数/测试文件数）', async () => {
  const readme = await readFile(path.join(root, 'README.md'), 'utf8');
  assert.doesNotMatch(readme, /\d+ 个用例/, '不要写死用例条数：每加一个用例都会过期（历史上漂过 3 次）');
  assert.doesNotMatch(readme, /\d+ 个测试文件/, '不要写死测试文件数：同上');
  assert.match(readme, /npm test/, '应指引用户用 npm test 看确切数字');
});

test('tests/ 下的测试文件确实都被 npm test 的 glob 覆盖', async () => {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const files = (await readdir(path.join(root, 'tests'))).filter((f) => f.endsWith('.test.js'));
  assert.match(pkg.scripts.test, /tests\/\*\.test\.js/, 'npm test 的 glob 应覆盖 tests/*.test.js');
  assert.ok(files.length > 0, '至少要有一个测试文件');
});

test('README 的 SSE 事件清单覆盖 store.js 订阅的全部事件', async () => {
  const [readme, store] = await Promise.all([
    readFile(path.join(root, 'README.md'), 'utf8'),
    readFile(path.join(root, 'src', 'web', 'store.js'), 'utf8'),
  ]);
  const events = new Set([...store.matchAll(/addEventListener\('([a-z:]+)'/g)].map((m) => m[1]));
  assert.ok(events.size >= 4, `应从 store.js 至少解析出几种事件，实际 ${[...events]}`);
  for (const e of events) assert.ok(readme.includes(e), `README 的 SSE 清单缺少：${e}`);
});

test('README 记录的 Node 门槛与 package.json / node-version.js 一致', async () => {
  const [readme, pkg, nodeVersion] = await Promise.all([
    readFile(path.join(root, 'README.md'), 'utf8'),
    readFile(path.join(root, 'package.json'), 'utf8').then(JSON.parse),
    readFile(path.join(root, 'src', 'lib', 'node-version.js'), 'utf8'),
  ]);
  const min = /export const MIN_NODE = '([^']+)'/.exec(nodeVersion)?.[1];
  assert.ok(min, '找不到 MIN_NODE');
  assert.equal(pkg.engines.node, `>=${min}`, 'package.json 的 engines 应与 MIN_NODE 同源');
  assert.ok(readme.includes(min), `README 应写明 Node ≥ ${min}`);
});

test('package.json 的 files 覆盖 README 引用的本地资源', async () => {
  const [pkg, readme] = await Promise.all([
    readFile(path.join(root, 'package.json'), 'utf8').then(JSON.parse),
    readFile(path.join(root, 'README.md'), 'utf8'),
  ]);
  for (const m of readme.matchAll(/\]\((?!https?:|#)([^)]+)\)/g)) {
    const top = m[1].split('/')[0];
    if (!top || top.endsWith('.md')) continue;                          // 根目录的 .md 已逐个列在 files 里
    if (['package.json', 'package-lock.json'].includes(top)) continue;   // npm 无论如何都会打包
    assert.ok(pkg.files.includes(top), `README 引用了 ${m[1]}，但 package.json 的 files 未包含 ${top}`);
  }
  for (const doc of ['README.md', 'CHANGELOG.md', 'LICENSE']) {
    assert.ok(pkg.files.includes(doc), `files 应包含 ${doc}`);
  }
});

test('CLI 的每个子命令都在 README 里有说明', async () => {
  const [readme, cli] = await Promise.all([
    readFile(path.join(root, 'README.md'), 'utf8'),
    readFile(path.join(root, 'src', 'cli.js'), 'utf8'),
  ]);
  const commands = new Set([...cli.matchAll(/case '([a-z]+)':/g)].map((m) => m[1]));
  assert.ok(commands.size >= 6, `应从 cli.js 解析出若干子命令，实际 ${[...commands]}`);
  for (const c of commands) {
    assert.ok(readme.includes(`hwb ${c}`), `README 缺少子命令说明：hwb ${c}`);
  }
});

test('源码注释里的 §N.M 章节引用都能在设计文档里解析到', async () => {
  const doc = await readFile(path.join(root, 'DSH_Workbench_Fusion_Architecture.md'), 'utf8');
  const sections = new Set([...doc.matchAll(/^#{2,4} ([0-9]+(?:\.[0-9]+)?)/gm)].map((m) => m[1]));

  const refs = new Map(); // 章节号 -> 引用它的文件
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      for (const m of (await readFile(full, 'utf8')).matchAll(/§([0-9]+(?:\.[0-9]+)?)/g)) {
        if (!refs.has(m[1])) refs.set(m[1], []);
        refs.get(m[1]).push(path.relative(root, full));
      }
    }
  }
  await walk(path.join(root, 'src'));

  assert.ok(refs.size >= 8, `源码里应有多处章节引用，实际 ${refs.size}`);
  const missing = [...refs.keys()].filter((k) => !sections.has(k));
  assert.deepEqual(missing, [],
    `源码引用了设计文档里不存在的章节：${missing.map((k) => `§${k} (${[...new Set(refs.get(k))].join(',')})`).join('; ')}`);
});

test('src/web 下没有「谁都不引用」的孤儿文件', async () => {
  const webRoot = path.join(root, 'src', 'web');
  const referenced = new Set();
  async function walk(rel) {
    if (referenced.has(rel)) return;
    referenced.add(rel);
    const src = await readFile(path.join(root, rel), 'utf8');
    for (const m of src.matchAll(/from\s+'(\.[^']+)'/g)) {
      const target = path.relative(root, path.resolve(path.dirname(path.join(root, rel)), m[1]));
      try { await readFile(path.join(root, target)); } catch { continue; }
      await walk(target);
    }
    for (const m of src.matchAll(/(?:src|href)="([^"#?]+)"/g)) {
      const target = path.relative(root, path.resolve(path.dirname(path.join(root, rel)), m[1].replace(/^\//, '')));
      try { await readFile(path.join(root, target)); } catch { continue; }
      await walk(target);
    }
  }
  await walk('src/web/index.html');

  // 服务端也会注入/读取一些前端资源（如预览桥接脚本），把这些显式列出来
  const proxy = await readFile(path.join(root, 'src', 'control', 'proxy.js'), 'utf8');
  for (const m of proxy.matchAll(/new URL\('\.\.\/web\/([^']+)'/g)) referenced.add(`src/web/${m[1]}`);

  const all = [];
  async function collect(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await collect(full);
      else all.push(path.relative(root, full));
    }
  }
  await collect(webRoot);

  // 已知且**有意**未接线的：额度卡片（见 README「已知限制」）
  const intentionallyUnwired = new Set(['src/web/components/quota-card.js']);
  const orphans = all.filter((f) => !referenced.has(f) && !intentionallyUnwired.has(f));
  assert.deepEqual(orphans, [], `src/web 下存在谁都不引用的文件（死资源）：\n${orphans.join('\n')}`);
  assert.ok(referenced.size >= 15, `可达文件数异常偏少（${referenced.size}），可达性分析可能失效`);
});
