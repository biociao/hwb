/**
 * 生产侧自检（`src/lib/dsh-compat.js`）的测试。
 *
 * 这里测的是 **`hwb doctor` 会打印什么**，而不是测试目录里的提取器 ——
 * 两者是独立实现（生产侧不 import tests/），所以必须有一条测试保证它们**结论一致**：
 * 否则「doctor 说兼容、但 CI 的契约测试说缺版本」会让用户完全不知道该信谁。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { findDshRoot, dshVersionOf, checkDshCompat, formatDshCompat, HWB_SUPPORTED } from '../../src/lib/dsh-compat.js';
import { SUPPORTED_VERSIONS } from '../../src/lib/schema.js';

const HOME = process.env.HOME ?? '';

/**
 * 造一个「假 dsh 安装」：只放提取器要看的两个包（dsh 的 package.json + 两个域的 defineDomain）。
 * 放在 tmp 下，通过 DSH_NODE_MODULES 指给 findDshRoot。
 */
function makeFakeDsh({ dshVersion = '0.2.0', projcache, workspace } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'hwb-fakedsh-'));
  const nm = path.join(root, 'node_modules');
  const nested = path.join(nm, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai');
  mkdirSync(path.join(nm, '@deepseek-ai', 'dsh'), { recursive: true });
  writeFileSync(path.join(nm, '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: dshVersion }));

  if (projcache) {
    const d = path.join(nested, 'dsh-session-projection-cache', 'lib');
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(nested, 'dsh-session-projection-cache', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-session-projection-cache' }));
    writeFileSync(path.join(d, 'index.js'), `const projectionCacheDomainSpec = defineDomain(${projcache});\n`);
  }
  if (workspace) {
    const d = path.join(nested, 'dsh-workspace', 'lib');
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(nested, 'dsh-workspace', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-workspace' }));
    writeFileSync(path.join(d, 'index.js'), `const workspaceDomainSpec = defineDomain(${workspace});\n`);
  }
  return nm;
}

/** 用一次性假 dsh 跑自检，跑完删目录。 */
function withFakeDsh(opts, fn) {
  const nm = makeFakeDsh(opts);
  try {
    return fn({ env: { DSH_NODE_MODULES: nm, PATH: '' }, home: path.join(tmpdir(), 'hwb-no-such-home') });
  } finally {
    rmSync(path.dirname(nm), { recursive: true, force: true });
  }
}

const CURRENT = `{
  name: "session_projcache",
  version: 7,
  compatibleVersions: [3, 4, 5, 6],
  layout: "per-record",
  tables: { sessions: domainTable(checkpointRecord) }
}`;
const CURRENT_WS = `{ name: "workspace", version: 2, tables: { workspaces: domainTable(workspaceRecord) } }`;

test('dsh-compat: HWB_SUPPORTED 与 schema.js 的 SUPPORTED_VERSIONS 不漂移', () => {
  // 两份常量服务不同目的（生产自检 vs 读取校验），但必须表达同一件事。
  // 这条守住了「改了 schema 忘了改 dsh-compat」导致 doctor 骗人的情况。
  assert.deepEqual(HWB_SUPPORTED.workspace, SUPPORTED_VERSIONS.workspace);
  assert.deepEqual(HWB_SUPPORTED.projcache, SUPPORTED_VERSIONS.projcache);
});

test('dsh-compat: 找不到 dsh 时不报错、也不假装兼容', () => {
  const r = checkDshCompat({ env: { DSH_NODE_MODULES: '/nonexistent-xyz', PATH: '' }, home: '/nonexistent-home-xyz' });
  assert.equal(r.available, false);
  assert.equal(r.ok, true, '缺 dsh 不是不兼容');
  assert.match(r.summary, /未找到 dsh/);
});

test('dsh-compat: 当前契约（v7 / workspace v2）判为兼容', () => {
  const r = withFakeDsh({ projcache: CURRENT, workspace: CURRENT_WS }, (env) => checkDshCompat(env));
  assert.equal(r.available, true);
  assert.equal(r.ok, true, `应判兼容，实际问题：${JSON.stringify(r.problems)}`);
  assert.match(r.summary, /兼容 ✓/);
  assert.deepEqual(r.domains.projcache.accepted, [7, 3, 4, 5, 6]);
});

test('dsh-compat: 版本前进（projcache v9 / workspace v3）被判为不兼容并给出原因', () => {
  const r = withFakeDsh({
    projcache: `{ name: "session_projcache", version: 9, compatibleVersions: [7, 8], layout: "per-record", tables: { sessions: domainTable(x) } }`,
    workspace: `{ name: "workspace", version: 3, tables: { workspaces: domainTable(y) } }`,
  }, (env) => checkDshCompat(env));
  assert.equal(r.ok, false, '未来版本必须判不兼容');
  const kinds = r.problems.map((p) => `${p.domain}:${p.kind}`).sort();
  assert.ok(kinds.includes('projcache:version-missing'), `缺 projcache 版本未被报出：${JSON.stringify(kinds)}`);
  assert.ok(kinds.includes('workspace:version-missing'), `缺 workspace 版本未被报出：${JSON.stringify(kinds)}`);
  // 提示必须能照做
  const text = formatDshCompat(r);
  assert.match(text, /src\/lib\/schema\.js/);
  assert.match(text, /test:compat/);
});

test('dsh-compat: 提取失败（dsh 改了包名/结构）单独归为「无法判定」', () => {
  // 只放 dsh 的 package.json，不放两个域包 → 两个域都 extract-failed。
  const r = withFakeDsh({ projcache: null, workspace: null }, (env) => checkDshCompat(env));
  assert.equal(r.ok, true, '无法判定 ≠ 不兼容');
  assert.equal(r.problems.length, 2);
  assert.ok(r.problems.every((p) => p.kind === 'extract-failed'));
  // 但**不能**说「兼容 ✓」—— 那是把「没读到」说成好事。
  assert.doesNotMatch(r.summary, /兼容 ✓/);
  assert.match(r.summary, /无法完全判定/);
});

test('dsh-compat: 注释里的 defineDomain 不被当成真规格', () => {
  const r = withFakeDsh({
    // 真规格是 v7；注释里藏一个「未来版本」不该影响判定。
    projcache: `{
      name: "session_projcache", version: 7, compatibleVersions: [3, 4, 5, 6], layout: "per-record",
      tables: { sessions: domainTable(checkpointRecord) }
    }`,
    workspace: CURRENT_WS,
  }, (env) => checkDshCompat(env));
  assert.equal(r.ok, true, `注释不该影响结论：${JSON.stringify(r.problems)}`);
  assert.equal(r.domains.projcache.version, 7);
});

test('dsh-compat: 展开运算符的 compatibleVersions 不被误读成空数组断言', () => {
  // `compatibleVersions: [...OLD]` 静态解不出 → 应视为「未声明」而不是「声明为空」。
  const r = withFakeDsh({
    projcache: `{ name: "session_projcache", version: 7, compatibleVersions: [...OLD], layout: "per-record", tables: { sessions: domainTable(x) } }`,
    workspace: CURRENT_WS,
  }, (env) => checkDshCompat(env));
  assert.equal(r.domains.projcache.accepted.includes(7), true);
  assert.equal(r.domains.projcache.compatibleVersions, undefined, '解不出应是 undefined（未声明）');
});

test('dsh-compat: 能读到真实 dsh 的版本号（装了 dsh 才有意义）', { skip: !existsSync(path.join(HOME, '.nvm')) }, () => {
  const root = findDshRoot({ env: process.env, home: HOME });
  if (!root) return;   // 本机没装 dsh：跳过
  const v = dshVersionOf(root);
  assert.match(String(v), /^\d+\.\d+\.\d+/, `dsh 版本形状异常：${v}`);
});

test('dsh-compat: 生产自检与测试提取器对真实 dsh 结论一致（防两份实现漂移）', async () => {
  const prod = checkDshCompat({ env: process.env, home: HOME });
  if (!prod.available) return;   // 本机没装 dsh
  const { extractAllDomains } = await import('./dsh-contract.mjs');
  const ref = extractAllDomains({ env: process.env, home: HOME });
  assert.equal(prod.dshVersion, ref.dshVersion, '两个提取器读到的 dsh 版本不一致');
  assert.ok(prod.dshRoot, '生产自检应给出 dsh 安装根');
  // 比**全部**关键字段，不只 accepted：layout 决定「要不要读 per-record」、
  // tables 决定「读哪个表」——这两样漂移比版本漂移更隐蔽（版本错会降级，layout 错会静默少读）。
  for (const key of ['workspace', 'projcache']) {
    const t = ref.domains[key]?.spec;
    if (!t) continue;
    const expected = [t.version, ...(t.compatibleVersions ?? [])].sort();
    const p = prod.domains[key];
    assert.ok(p, `生产自检没提取到 ${key}（测试提取器提取到了）—— 两份实现已漂移`);
    assert.deepEqual(
      p.accepted.slice().sort(), expected,
      `${key}: 接受集不一致（生产 ${JSON.stringify(p.accepted)} vs 测试 ${JSON.stringify(expected)}）`
      + ' → 两处提取逻辑已漂移，doctor 与 CI 会说不同的话',
    );
    assert.equal(p.version, t.version, `${key}: version 不一致`);
    // layout：测试侧未声明时视为 single（与 dsh 的默认行为一致）
    assert.equal(p.layout ?? 'single', t.layout ?? 'single',
      `${key}: layout 不一致（生产 ${p.layout} vs 测试 ${t.layout}）——`
      + ' 这会导致「要不要读 per-record」的判断不同，比版本漂移更隐蔽');
    // tables 若两边都解出了，必须一致
    if (p.tables && t.tables) {
      assert.deepEqual(p.tables.slice().sort(), t.tables.slice().sort(),
        `${key}: tables 不一致（生产 ${JSON.stringify(p.tables)} vs 测试 ${JSON.stringify(t.tables)}）`);
    }
  }
});

test('整合：`hwb test` 会把 tests/compat/ 一并跑上（不能静默漏掉整个模块）', async () => {
  // `hwb test` 是升级 dsh 后最自然要跑的命令（README 与 doctor 都指向它），
  // 而它原先用 readdirSync(tests) —— **不递归**，于是整个 tests/compat 被静默跳过。
  // 这条用 `--test-name-pattern` 只挑本模块的一条用例，断言它**确实被执行到**。
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { fileURLToPath } = await import('node:url');
  const cli = fileURLToPath(new URL('../../src/cli.js', import.meta.url));

  // `hwb test` 会 spawn 一个**完整测试进程**（几百条用例），在本机高负载时可能很慢，
  // 因此给足超时并显式放大 maxBuffer；失败时取其输出（我们主要看「有没有跑到 compat」）。
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [cli, 'test', '--test-name-pattern=dsh-compat: HWB_SUPPORTED 与 schema.js'],
    { timeout: 180_000, maxBuffer: 32 * 1024 * 1024 },
  ).catch((e) => e);   // 用例通过时 exit 0；这里主要看输出里有没有跑到

  const out = String(stdout ?? '');
  assert.match(
    out, /dsh-compat: HWB_SUPPORTED 与 schema\.js/,
    '`hwb test` 没有跑到 tests/compat/ 里的用例 → 兼容性测试模块被静默跳过。'
    + ' → 检查 src/cli.js 的 collectTestFiles() 是否包含 tests/compat',
  );
  assert.match(out, /# fail 0/, '`hwb test` 报告的失败数不为 0');
});

test('dsh-compat: 旧版 dsh（低版本/无 compatibleVersions）同样判兼容', () => {
  // 兼容性检查**双向**都要成立：用户可能把 dsh 回滚到旧版。
  // 旧版声明 version 3、没有 compatibleVersions —— hwb 仍支持 3，故应判兼容。
  // （反向已由「版本前进」那条覆盖：未来版本会被判不兼容。）
  const r = withFakeDsh({
    dshVersion: '0.1.1',
    projcache: '{ name: "session_projcache", version: 3, layout: "per-record", tables: { sessions: domainTable(x) } }',
    workspace: '{ name: "workspace", version: 2, tables: { workspaces: domainTable(y) } }',
  }, (env) => checkDshCompat(env));
  assert.equal(r.ok, true, `旧版 dsh 应判兼容，实际问题：${JSON.stringify(r.problems)}`);
  assert.deepEqual(r.domains.projcache.accepted, [3], '无 compatibleVersions 时只接受当前版本');
  assert.match(r.summary, /兼容 ✓/);
});

test('dsh-compat: dsh 重构（域包改名 / 定义换文件）后仍能定位到域', () => {
  // 真实风险：域定义放在哪个包、哪个文件都是 dsh 的内部组织。
  // 只认死包名 + 死文件名的话，dsh 一重构自检就退化成「提取失败」——
  // 不会谎报兼容（那更糟），但也帮不上忙。这条固定「按域名回退扫描」的能力。
  const nm = makeFakeDshRenamed();
  try {
    const r = checkDshCompat({ env: { DSH_NODE_MODULES: nm, PATH: '' }, home: path.join(tmpdir(), 'hwb-no-such-home') });
    assert.ok(r.domains.projcache, `包改名后应仍能定位 session_projcache，实际问题：${JSON.stringify(r.problems)}`);
    assert.equal(r.domains.projcache.version, 7);
    assert.ok(r.domains.workspace, '定义挪到 lib/spec.js 后也应能找到');
    assert.equal(r.domains.workspace.version, 2);
    assert.equal(r.ok, true, '这两个版本都在 hwb 支持范围内，应判兼容');
  } finally {
    rmSync(path.dirname(nm), { recursive: true, force: true });
  }
});

/** 造一个「域包被合并改名、定义换到 lib/spec.js」的假 dsh。 */
function makeFakeDshRenamed() {
  const root = mkdtempSync(path.join(tmpdir(), 'hwb-fakedsh-renamed-'));
  const nm = path.join(root, 'node_modules');
  mkdirSync(path.join(nm, '@deepseek-ai', 'dsh'), { recursive: true });
  writeFileSync(path.join(nm, '@deepseek-ai', 'dsh', 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.3.0' }));
  // 域包不叫 dsh-workspace / dsh-session-projection-cache，而是一个新名字的合并包；
  // 且定义不在 index.js，而在 spec.js。
  const dir = path.join(nm, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-storage-domains', 'lib');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(nm, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-storage-domains', 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh-storage-domains' }));
  writeFileSync(path.join(dir, 'spec.js'), [
    'const a = defineDomain({ name: "session_projcache", version: 7, compatibleVersions: [3,4,5,6], layout: "per-record", tables: { sessions: x } });',
    'const b = defineDomain({ name: "workspace", version: 2, tables: { workspaces: y } });',
  ].join('\n'));
  return nm;
}

test('dsh-compat: 升级闭环 —— 按提示补上版本后转为兼容', () => {
  // 这条测试守的是「提示**可照做**」：如果修复指引说得含糊或指错文件，用户照做之后
  // 自检仍红，那这个模块就只是噪声。这里模拟完整的升级流程：
  //   ① 新版 dsh 声明 v8 → 自检红，且提示指向 SUPPORTED_VERSIONS
  //   ② 按提示把 8 加进 hwb 的支持清单（用一份改过的 HWB_SUPPORTED 模拟）
  //   ③ 自检转绿
  // 第③步通过临时注入支持集实现，不改动真实源码。
  const future = '{ name: "session_projcache", version: 8, compatibleVersions: [3,4,5,6,7], layout: "per-record", tables: { sessions: domainTable(x) } }';
  const ws = '{ name: "workspace", version: 2, tables: { workspaces: domainTable(y) } }';

  const before = withFakeDsh({ dshVersion: '0.2.0', projcache: future, workspace: ws }, (env) => checkDshCompat(env));
  assert.equal(before.ok, false, '升级后应先报不兼容');
  assert.ok(before.problems.some((p) => p.kind === 'version-missing' && p.domain === 'projcache'),
    `应报出缺版本：${JSON.stringify(before.problems)}`);
  // 指引必须可执行：指名文件 + 指名命令
  const text = formatDshCompat(before);
  assert.match(text, /src\/lib\/schema\.js/, '指引应指名要改的文件');
  assert.match(text, /test:compat/, '指引应给出验证命令');

  // ② 模拟「已按提示修好」：临时把 8 加进支持清单
  const saved = HWB_SUPPORTED.projcache.slice();
  HWB_SUPPORTED.projcache.push(8);
  try {
    const after = withFakeDsh({ dshVersion: '0.2.0', projcache: future, workspace: ws }, (env) => checkDshCompat(env));
    assert.equal(after.ok, true, `按提示修好后应转绿，实际：${JSON.stringify(after.problems)}`);
    assert.match(after.summary, /兼容 ✓/);
  } finally {
    HWB_SUPPORTED.projcache.length = 0;
    HWB_SUPPORTED.projcache.push(...saved);
  }
});

test('文档一致性：compat 说明文档里的「组数」与实际测试组数一致', async () => {
  // 组数从 A 加到 G 的过程中，README 与测试文件头的「四组/五组」都曾经过时。
  // 这类数字一旦漂了就会误导（读者以为只有 4 组保护，实际有 7 组）。
  // 这里从**测试文件本身**数出实际组数，再要求文档写对。
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const testFile = fileURLToPath(new URL('./dsh-compat.test.js', import.meta.url));
  const readme = fileURLToPath(new URL('./README.md', import.meta.url));

  const src = await readFile(testFile, 'utf8');
  // 组标题形如 'A. 存储域契约：…' / 'E. 域发现：…'
  const letters = [...new Set([...src.matchAll(/^test\('([A-G])\./gm)].map((m) => m[1]))].sort();
  assert.ok(letters.length >= 5, `应至少识别出 5 组，实际 ${letters.join(',')}`);
  const last = letters[letters.length - 1];

  const doc = await readFile(readme, 'utf8');
  const cn = { A: '一', B: '两', C: '三', D: '四', E: '五', F: '六', G: '七' };
  // README 里应出现「七个维度」这类说法，且不应再出现更小的过时数字
  assert.ok(
    doc.includes(`${cn[last]}个维度`) || doc.includes(`${last} 组`),
    `README 应写明共有 ${letters.length} 组（到 ${last} 为止）；实际没找到「${cn[last]}个维度」或「${last} 组」`,
  );
  for (const [L, word] of Object.entries(cn)) {
    if (letters.includes(L)) continue;
    assert.ok(
      !new RegExp(`${word}个维度|${word}组测试`).test(doc),
      `README 不应再写「${word}…组」（那是过时数字：现在到 ${last} 组）`,
    );
  }
});

test('doctor 的本机 home 检查：无库时优雅跳过，有库时如实报告布局与版本', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { fileURLToPath } = await import('node:url');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const os = await import('node:os');
  const cli = fileURLToPath(new URL('../../src/cli.js', import.meta.url));
  const run = (dir) => promisify(execFile)(process.execPath, [cli, 'doctor'], {
    env: { ...process.env, HWB_DIR: dir }, timeout: 60_000,
  }).catch((e) => e);   // doctor 在服务未运行时也可能非 0，这里主要看输出

  // ① 全新 HWB_DIR（没有索引库）→ 应优雅说明，而不是崩
  const empty = mkdtempSync(path.join(os.tmpdir(), 'hwb-doctor-empty-'));
  try {
    const r = await run(empty);
    const out = String(r.stdout ?? '');
    assert.match(out, /本机 home/, 'doctor 应输出本机 home 检查段');
    assert.match(out, /没有本地 home|跳过/, `无库时应优雅说明，实际：${out.slice(-200)}`);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }

  // ①b 有索引库、但里面**只有远程 home**（合法配置：用户只聚合远程实例）
  //     → 应照样优雅说明，不去尝试读远程（doctor 不该为诊断而走 SSH 等几十秒）
  const remoteOnly = mkdtempSync(path.join(tmpdir(), 'hwb-doctor-remote-'));
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(remoteOnly, 'hwb.db'));
    db.exec('CREATE TABLE homes (homeId TEXT PRIMARY KEY, homePath TEXT, alias TEXT, hostType TEXT)');
    db.prepare('INSERT INTO homes VALUES (?,?,?,?)').run('h1', 'ssh://bot@x.tun:3080', 'remote-one', 'remote');
    db.close();
    const r = await run(remoteOnly);
    assert.match(String(r.stdout ?? ''), /没有本地 home/,
      '只有远程 home 时应说明「没有本地 home」，而不是尝试 SSH');
  } finally {
    rmSync(remoteOnly, { recursive: true, force: true });
  }

  // ② 真实 HWB_DIR（有索引库）→ 应列出本地 home 的布局与版本
  const real = process.env.HOME ? path.join(process.env.HOME, '.hwb') : null;
  if (!real || !existsSync(path.join(real, 'hwb.db'))) return;
  const r2 = await run(real);
  const out2 = String(r2.stdout ?? '');
  // 读**真实**索引库会与并行跑着的服务争用（库可能正被索引写入、也可能被独占）。
  // 因此这里只断言「输出形态正确」，不把「一定能读到 home」当作硬条件 ——
  // 那会把一个环境相关的偶发失败混进来（实测高负载下出现过一次）。
  assert.match(out2, /本机 home/, 'doctor 应输出本机 home 检查段');
  if (/本机 home（\d+ 个）/.test(out2)) {
    assert.match(out2, /布局 per-record=\d+/,
      '报告 home 时应带上实际用到的布局（排查「数据变少」的第一手信息）');
  }
  // 不应泄漏 Node 的实验特性警告到给人看的输出里（这条与环境无关，硬断言）
  assert.doesNotMatch(out2, /ExperimentalWarning/, 'doctor 输出不该混入 node:sqlite 的实验特性警告');
});

test('scripts/compat-check.mjs：人类可读输出 / --json / 退出码', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { fileURLToPath } = await import('node:url');
  const script = fileURLToPath(new URL('../../scripts/compat-check.mjs', import.meta.url));
  // 成功与失败都要拿到 `code`：execFile 成功时不带 code，失败时 e.code 是退出码。
  const run = async (env, ...args) => {
    try {
      const r = await promisify(execFile)(process.execPath, [script, ...args], {
        env: { ...process.env, ...env }, timeout: 60_000,
      });
      return { stdout: r.stdout, stderr: r.stderr, code: 0 };
    } catch (e) {
      return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code };
    }
  };

  // ① 默认输出：给人看的结论行
  const human = await run({});
  assert.match(human.stdout, /hwb ↔ dsh 兼容性检查/, '应有标题');
  assert.match(human.stdout, /结论：/, '应有明确结论行');

  // ② --json：可被程序解析，且字段齐全
  const json = await run({}, '--json');
  const parsed = JSON.parse(json.stdout);
  assert.ok('available' in parsed && 'ok' in parsed && 'domains' in parsed);
  if (parsed.available) {
    for (const key of ['workspace', 'projcache']) {
      assert.ok(parsed.domains[key]?.accepted?.length > 0, `${key} 应有接受集`);
      // tables 必须解出来（否则「读哪个表」没有契约可依）
      assert.ok(Array.isArray(parsed.domains[key].tables), `${key} 应有 tables`);
    }
  }

  // ③ 不兼容时必须**非 0 退出**（否则进不了 CI 门禁）
  const nm = makeFakeDsh({
    dshVersion: '9.9.9',
    projcache: '{ name: "session_projcache", version: 99, compatibleVersions: [98], layout: "per-record", tables: { sessions: domainTable(x) } }',
    workspace: '{ name: "workspace", version: 88, tables: { workspaces: domainTable(y) } }',
  });
  try {
    const bad = await run({ DSH_NODE_MODULES: nm }, '--json');
    assert.equal(bad.code, 1, '不兼容时退出码应为 1');
    const badParsed = JSON.parse(bad.stdout);
    assert.equal(badParsed.ok, false);
    assert.ok(badParsed.problems.length > 0, '应列出具体问题');
  } finally {
    rmSync(path.dirname(nm), { recursive: true, force: true });
  }

  // ④ 无 dsh 时退出 0（缺 dsh 不算「不兼容」，见 checkDshCompat 的说明）
  //
  // 注意要连 **HOME 一起隔离**：findDshRoot 的候选顺序里会用
  // `$HOME/.nvm/versions/node/*/lib/node_modules` 兜底，只改 DSH_NODE_MODULES/PATH
  // 仍会找到本机真实的 dsh（实测踩过），于是「没有 dsh」这条分支根本没被验证到。
  const isolatedHome = mkdtempSync(path.join(tmpdir(), 'hwb-nodsh-home-'));
  try {
    const none = await run({ DSH_NODE_MODULES: '/nonexistent-xyz', PATH: '', HOME: isolatedHome });
    assert.equal(none.code, 0, '找不到 dsh 不该判失败');
    assert.match(none.stdout, /没有 dsh 不是错误|未找到 dsh/);
  } finally {
    rmSync(isolatedHome, { recursive: true, force: true });
  }
});

test('dsh-compat: 装了多个 node 版本时，优先当前运行的那个（而不是字母序第一个）', () => {
  // 真实场景：nvm 下 v20 与 v22 各自装了 dsh。`readdir` 的字母序把 v20 排在前面，
  // 若只取第一个，就会拿一个**用户根本没在跑**的旧 dsh 当权威来判兼容性
  // （实测：v20 里是 0.1.1，v22 里是 0.1.5-rc.1）。
  // hwb 自己就跑在当前 Node 上，所以那个 Node 下的 dsh 才是该看的。
  const home = mkdtempSync(path.join(tmpdir(), 'hwb-multinode-'));
  const cur = process.version;         // 形如 v22.21.1
  const older = 'v18.0.0';             // 字母序在 v22 之前
  const mkDsh = (ver, version) => {
    const d = path.join(home, '.nvm', 'versions', 'node', ver, 'lib', 'node_modules', '@deepseek-ai', 'dsh');
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }));
  };
  mkDsh(older, '0.1.1');               // 旧 Node 下的旧 dsh
  mkDsh(cur, '0.1.5-rc.1');            // 当前 Node 下的 dsh
  try {
    const root = findDshRoot({ env: { PATH: '' }, home });
    assert.ok(root, '应找到 dsh');
    assert.ok(root.includes(`${path.sep}${cur}${path.sep}`),
      `应优先当前 Node（${cur}）下的 dsh，实际选中 ${root}`);
    assert.equal(dshVersionOf(root), '0.1.5-rc.1', '选中的应是当前 Node 下的那个版本');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('scripts/compat-check.mjs：结论分三种，不出现「无法判定」却报「兼容 ✓」的自相矛盾', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { fileURLToPath } = await import('node:url');
  const script = fileURLToPath(new URL('../../scripts/compat-check.mjs', import.meta.url));

  // 造一个「dsh 在、但域提取不出来」的安装（模拟 dsh 内部重构）：
  // 这种情况既不是兼容也不是不兼容，是**无法判定**。
  const home = mkdtempSync(path.join(tmpdir(), 'hwb-unjudged-'));
  const nm = path.join(home, 'node_modules');
  const dshDir = path.join(nm, '@deepseek-ai', 'dsh');
  mkdirSync(dshDir, { recursive: true });
  writeFileSync(path.join(dshDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.0' }));
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [script], {
      env: { ...process.env, DSH_NODE_MODULES: nm, HOME: home, PATH: '' },
      timeout: 60_000,
    });
    assert.match(stdout, /无法完全判定/, `应如实说明无法判定，实际：${stdout.slice(-300)}`);
    // **关键**：不能一边说「无法判定」一边盖「结论：兼容 ✓」——那是自相矛盾，
    // 会让人以为查过了没问题，其实是根本没读到契约。
    const verdictLine = stdout.split('\n').find((l) => l.startsWith('结论：')) ?? '';
    assert.doesNotMatch(verdictLine, /兼容 ✓/,
      `结论行不该在「无法判定」时说兼容：${verdictLine}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
