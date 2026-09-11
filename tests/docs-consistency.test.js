import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// 文档里写死的数字会悄悄过期。README 原先写着「当前 62 个用例」，实际早就 359；
// 修成 359 之后又涨到 419 —— 同一个问题复发。这里把**能自校验的部分**钉住：
// 测试文件数可以直接数出来，写进 README 并在这里比对；用例条数则不写死（见 README 的说明）。

test('README 不写死会过期的计数（用例条数/测试文件数）', async () => {
  const readme = await readFile(path.join(root, 'README.md'), 'utf8');
  // 历史上这里从「62 个用例」漂到 359、再到 419，三次都没人发现。
  // 与其要求每次加测试都回来改数字，不如从根上不写数字。
  assert.doesNotMatch(readme, /\d+ 个用例/, '不要写死用例条数：每次加用例都会过期');
  assert.doesNotMatch(readme, /\d+ 个测试文件/, '不要写死测试文件数：同上');
  assert.match(readme, /npm test/, '应指引用户用 npm test 看确切数字');
});

test('tests/ 下的测试文件确实都被 npm test 的 glob 覆盖', async () => {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const files = (await readdir(path.join(root, 'tests'))).filter((f) => f.endsWith('.test.js'));
  assert.match(pkg.scripts.test, /tests\/\*\.test\.js/, 'npm test 的 glob 应覆盖 tests/*.test.js');
  assert.ok(files.length > 0, '至少要有一个测试文件');
});

test('README 的 REST API 表覆盖 src/api/routes.js 里的全部路由', async () => {
  const [readme, routes] = await Promise.all([
    readFile(path.join(root, 'README.md'), 'utf8'),
    readFile(path.join(root, 'src', 'api', 'routes.js'), 'utf8'),
  ]);
  // 从代码里抽「字面量路径」的路由（参数化路径由下面的显式清单覆盖）
  const literal = new Set();
  for (const m of routes.matchAll(/req\.method === '(\w+)' && pathname === '([^']+)'/g)) literal.add(m[2]);
  for (const p of literal) {
    assert.ok(readme.includes(p), `README 的 REST API 表缺少已实现的路由：${p}`);
  }
  // 参数化路由：由正则匹配，逐个显式列出（新增路由时这条会提醒你补文档）
  const parameterized = ['/open-workspace', '/preview', '/download', '/upload', '/reindex', '/open', '/switch', '/disconnect', '/stop', '/restart'];
  for (const suffix of parameterized) {
    const re = new RegExp(`/api/homes/\\\\(\\\\[0-9a-f\\\\]\\\\{16}\\\\)${suffix.replace(/[/-]/g, (c) => `\\\\${c}`)}`);
    if (!re.test(routes)) continue; // 代码里没有这条
    assert.ok(readme.includes(`/api/homes/{homeId}${suffix}`), `README 缺少参数化路由：${suffix}`);
  }
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
  // README 里引用的仓库内相对链接，其顶层目录必须在发布白名单里（否则装到的包里是坏链）
  for (const m of readme.matchAll(/\]\((?!https?:|#)([^)]+)\)/g)) {
    const top = m[1].split('/')[0];
    if (!top || top.endsWith('.md')) continue; // 根目录的 .md 已逐个列在 files 里
    // npm 无论如何都会打包这些，不必（也不能）列进 files
    if (['package.json', 'package-lock.json'].includes(top)) continue;
    assert.ok(pkg.files.includes(top), `README 引用了 ${m[1]}，但 package.json 的 files 未包含 ${top}`);
  }
  for (const doc of ['README.md', 'CHANGELOG.md', 'LICENSE']) {
    assert.ok(pkg.files.includes(doc), `files 应包含 ${doc}`);
  }
});
