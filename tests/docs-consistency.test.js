import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// 文档里写死的数字与清单会悄悄过期。README 原先写着「当前 62 个用例」，后来涨到 359、又到 419，
// 三次都没人发现；REST API 表也漏过 4 条已实现的路由。这里把**能自校验的部分**变成会失败的测试。

/**
 * 从 routes.js 里抽出**所有**参数化路由（`pathname.match(/^...$/)`），解析真实字面量、不手写清单。
 *
 * 旧版只认 `pathname.match(/^\/api\/homes\/([0-9a-f]{16})` 这一族：今天确实所有参数化路由都在
 * 这一族里，但只要以后新增一个别的族（比如 `/api/sessions/([0-9a-f]{16})/xxx`），它就会**悄悄**
 * 漏掉双向检查 —— README 不写它不报错，写了也不校验。所以这里改成通用解析：
 *   · `([0-9a-f]{16})` → `{homeId}`
 *   · `(a|b)` 顶层分支 → 展开成多条（README 里 preview / download 是两行）
 *   · 其它捕获组 → `{组内容}`（宁可让 README 对不上而报错，也不要静默跳过）
 * 同时返回 `literals`（扫到的正则字面量个数）供调用方做「解析器没漏」的反向校验。
 */
export function parameterizedRoutes(source) {
  const found = new Set();
  let literals = 0;
  for (const m of source.matchAll(/pathname\.match\(\/\^(.+?)\$\/\)/g)) {
    const raw = m[1];
    // 源码里正则把 `/` 写成 `\/`，**先还原**再判断。曾把这个判断写在还原之前
    // （`raw.includes('api/')`）：转义后的文本里只有 `api\/`，于是永远匹配不上、提取出 0 条。
    const literal = raw.replace(/\\\//g, '/');
    if (!literal.startsWith('/api/')) continue;   // 只关心 /api 路由；静态资源匹配器不算
    literals++;
    // 先把 `([0-9a-f]{16})` 占位掉，剩下的 `(a|b)` 才是需要展开的分支
    const marked = literal.replace(/\(\[0-9a-f\]\{16\}\)/g, '\u0000');
    const branch = /^(.*?)\(([^()]+)\)(.*)$/.exec(marked);
    const expanded = branch ? branch[2].split('|').map((alt) => `${branch[1]}${alt}${branch[3]}`) : [marked];
    for (const e of expanded) {
      // 16 位十六进制在 homes 族里就是 homeId；别的族（以后可能出现的 /api/sessions/...）
      // 用中性占位符，否则会逼着 README 把一个会话 id 写成 {homeId}。
      const placeholder = e.startsWith('/api/homes/') ? '{homeId}' : '{id}';
      const p = e.replace(/\u0000/g, placeholder)
        // 残留的捕获组（未预期的写法）显式标出来，宁可让 README 对不上而报错，也不静默漏掉
        .replace(/\(([^()]*)\)/g, '{$1}');
      if (p.startsWith('/api/')) found.add(p);
    }
  }
  return Object.assign(found, { literals });
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
  // 反向校验「解析器没漏」：routes.js 里每一个 /api 的正则匹配器都要被解析到。
  // 旧版解析器写死了 homes 这一族，新增别的族（如 /api/sessions/{id}/xxx）会被静默漏掉 ——
  // 既不要求 README 写它，也不校验 README 里写的它对不对。
  const allMatchers = [...routes.matchAll(/pathname\.match\(\/\^(.+?)\$\/\)/g)]
    .map((m) => m[1].replace(/\\\//g, '/'))
    .filter((s) => s.startsWith('/api/'));
  assert.equal(parameterized.literals, allMatchers.length,
    `routes.js 里有 ${allMatchers.length} 个 /api 正则匹配器，解析器只处理了 ${parameterized.literals} 个`);
  for (const matcher of allMatchers) {
    // 用「具体化」的方式精确校验：把解析出来的路由里的占位符换成具体值，
    // 看源码里这个匹配器是否真的能匹配上它。匹配不上 = 解析器漏了这一族。
    const sample = (p) => p.replace('{homeId}', 'a'.repeat(16));
    const hit = [...parameterized].some((p) => new RegExp(matcher).test(sample(p)));
    assert.ok(hit, `解析器漏掉了这个路由匹配器：${matcher}（解析结果：${[...parameterized]}）`);
  }

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

  // 子目录也必须被覆盖：`tests/*.test.js` 不递归，所以 tests/compat/ 会被**静默跳过** ——
  // 跑 npm test 看到全绿，其实一行兼容性契约都没验（这正是本项目最怕的那类失败）。
  // 新增子目录时也要同步加进 glob，否则这里会红。
  for (const sub of await subTestDirs()) {
    assert.ok(
      pkg.scripts.test.includes(`tests/${sub}/*.test.js`),
      `npm test 的 glob 没有覆盖 tests/${sub}/（readdir 不递归 → 该子目录的用例会被静默跳过）。`
      + ` → 需要改：package.json 的 scripts.test 加上 tests/${sub}/*.test.js`,
    );
  }
});

/** tests/ 下含 *.test.js 的子目录（跳过点开头的）。 */
async function subTestDirs() {
  const out = [];
  for (const entry of await readdir(path.join(root, 'tests'), { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const inside = await readdir(path.join(root, 'tests', entry.name)).catch(() => []);
    if (inside.some((f) => f.endsWith('.test.js'))) out.push(entry.name);
  }
  return out;
}

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

// ── CHANGELOG 的结构完整性（防「编辑时把下一个标题吃掉」） ──
// 真事：一次替换把 `#### 预览代理的建立竞态…` 这一行which 连同空行一起删掉了，
// 于是那条修复的正文变成挂在上一篇末尾的孤儿 —— 渲染出来是「上一条的附带说明」，
// 读者根本不知道它在讲什么，而且没有任何测试会红。这里把结构钉住。
test('CHANGELOG 的每条修复都有标题，不存在挂在别人末尾的孤儿正文', async () => {
  const changelog = await readFile(path.join(root, 'CHANGELOG.md'), 'utf8');
  const lines = changelog.split('\n');

  // 取 [Unreleased] 段（到下一个 ## [ 版本标题为止）
  const start = lines.findIndex((l) => l.startsWith('## [Unreleased]'));
  assert.ok(start >= 0, '找不到 [Unreleased] 段');
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## ['));
  const body = lines.slice(start, end === -1 ? lines.length : end);

  // 判据只用一条：**连续两个空行之后直接跟列表项**。正常排版不会这样，
  // 而「标题行被删掉、正文留在原处」恰好会留下这个形状（实测就是这么被发现的）。
  // 不要求「小节第一条必须是 ####」—— ### Changed 之类本来就是直接列条目。
  let headingCount = 0;
  for (let i = 0; i < body.length; i++) {
    if (/^#### /.test(body[i])) headingCount++;
    if (body[i].trim() === '' && body[i + 1]?.trim() === '' && /^- /.test(body[i + 2] ?? '')) {
      assert.fail(`第 ${start + i + 3} 行附近：连续空行后直接跟列表项，疑似标题被删（孤儿正文）`);
    }
  }
  assert.ok(headingCount >= 10, `[Unreleased] 里应有多条 #### 修复条目，实际 ${headingCount}`);
});
