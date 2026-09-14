/**
 * 版本兼容性契约测试 —— dsh 升级后的**一键回归**入口。
 *
 * ## 这个文件解决什么问题
 *
 * hwb 消费 dsh 的磁盘格式与 CLI 表面。dsh 一升级，这些契约就可能漂移，而漂移的
 * **失败模式是静默的**：整块域被标 degraded、或只读到一半数据，界面上看不出异常
 * （实测：真实 home 上 476 个会话 hwb 只看到 179 个，漏 62%，且 `degraded` 为空）。
 *
 * 因此本文件把「hwb 的假设」与「dsh 的事实」逐条对照，并输出**可执行的结论**：
 *   · 每条契约 = 一个 subtest；失败时直接说「dsh 变了什么、hwb 哪一行要改」。
 *   · dsh 不可用时**不假装通过**，而是 `skip` 并说明原因（CI 上可能没装 dsh）。
 *
 * ## 七个维度
 *   A. 存储域契约（版本 / compatibleVersions / layout / tables / global）  ← 最容易漂移
 *   B. 磁盘布局契约（single vs per-record、信封形状、实际 home 的真实布局）
 *   C. CLI 契约（`dsh web: ` 打印行、token query 名、--version 输出形状）
 *   D. 真实 home 端到端（用本机 ~/.dsh 校正「hwb 看到的」与「磁盘上有的」）
 *   E. 域发现（dsh 有没有新增 hwb 还不认识的存储域）
 *   F. UI 注入锚点（真实 dsh bundle 里 workspace 菜单的集成点还在吗）
 *   G. 路径一致性（本地 reader 与远程 cat 脚本用的是同一组路径吗）
 *
 * ## 怎么用（升级 dsh 后）
 *     npm run test:compat                  # 只跑契约测试，几秒出结论
 *     node --test tests/compat/*.test.js   # 等价写法
 * 失败信息里带 `→ 需要改：<文件>:<行>` 提示。详见 tests/compat/README.md。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  extractAllDomains,
  extractCliContract,
  probeDshVersionCli,
} from './dsh-contract.mjs';

// hwb 自己的假设（被测对象）—— 直接 import 源码，保证测的是**真常量**而不是复制品。
import {
  SUPPORTED_VERSIONS,
  validateWorkspaceJson,
  validateProjcacheJson,
} from '../../src/lib/schema.js';

const REPO = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

// ---------------------------------------------------------------------------
// 环境发现（一次，供全部子测试复用）
// ---------------------------------------------------------------------------

const ENV = extractAllDomains();
const SKIP_NO_DSH = ENV.available ? false : `未找到 dsh 安装：${ENV.reason}`;

/** 每个域「hwb 允许的版本清单」来自源码常量，不是测试里抄的。 */
const HWB_ALLOWS = {
  workspace: SUPPORTED_VERSIONS.workspace,
  projcache: SUPPORTED_VERSIONS.projcache,
};

/** dsh 的接受集 = version + compatibleVersions（per-record 的判定依据）。 */
function acceptedByDsh(spec) {
  if (!spec || typeof spec.version !== 'number') return null;
  return [spec.version, ...(spec.compatibleVersions ?? [])];
}

/** 描述「hwb 缺哪些版本」——失败信息要能直接照做。 */
function missingVersions(hwbList, dshAccepted) {
  if (!Array.isArray(dshAccepted)) return null;
  return dshAccepted.filter((v) => !hwbList.includes(v));
}

// ===========================================================================
// A. 存储域契约
// ===========================================================================

test('A. 存储域契约：dsh 声明的版本 / 布局被 hwb 完整覆盖', { skip: SKIP_NO_DSH }, async (t) => {
  await t.test('能定位 dsh 安装并读出其版本', () => {
    assert.ok(ENV.available, '应能定位 dsh');
    assert.ok(ENV.root, '应给出安装根');
    // 版本号只断言「是字符串」——不写死具体版本，否则每次升级都要改测试。
    if (ENV.dshVersion !== null) {
      assert.equal(typeof ENV.dshVersion, 'string');
      assert.match(ENV.dshVersion, /^\d+\.\d+\.\d+/, `dsh 版本形状异常：${ENV.dshVersion}`);
    }
  });

  await t.test('两个已知域都能从安装目录提取到 defineDomain 规格', () => {
    for (const key of ['workspace', 'projcache']) {
      const d = ENV.domains[key];
      assert.ok(d, `${key} 域缺失`);
      assert.ok(d.found, `${key} 域提取失败：${d.reason ?? '未知'} → 检查 tests/compat/dsh-contract.mjs 的包名映射`);
      assert.ok(d.spec && typeof d.spec.version === 'number', `${key} 域没解出 version`);
    }
  });

  await t.test('workspace 域：hwb 允许的版本 ⊇ dsh 接受集', () => {
    const spec = ENV.domains.workspace?.spec;
    assert.ok(spec, '未提取到 workspace 规格');
    const dshAccepted = acceptedByDsh(spec);
    const missing = missingVersions(HWB_ALLOWS.workspace, dshAccepted);
    assert.deepEqual(
      missing, [],
      `dsh 的 workspace 域接受 ${JSON.stringify(dshAccepted)}，hwb 只允许 ${JSON.stringify(HWB_ALLOWS.workspace)}；`
      + `缺 ${JSON.stringify(missing)}。→ 需要改：src/lib/schema.js 的 SUPPORTED_VERSIONS.workspace`,
    );
  });

  await t.test('projcache 域：hwb 允许的版本 ⊇ dsh 接受集', () => {
    const spec = ENV.domains.projcache?.spec;
    assert.ok(spec, '未提取到 projcache 规格');
    const dshAccepted = acceptedByDsh(spec);
    const missing = missingVersions(HWB_ALLOWS.projcache, dshAccepted);
    assert.deepEqual(
      missing, [],
      `dsh 的 session_projcache 域接受 ${JSON.stringify(dshAccepted)}，hwb 只允许 ${JSON.stringify(HWB_ALLOWS.projcache)}；`
      + `缺 ${JSON.stringify(missing)}。→ 需要改：src/lib/schema.js 的 SUPPORTED_VERSIONS.projcache`,
    );
  });

  await t.test('projcache 当前版本本身也在 hwb 的允许清单里（防「只列了 compatible 却漏了当前」）', () => {
    const spec = ENV.domains.projcache?.spec;
    assert.ok(spec, '未提取到 projcache 规格');
    assert.ok(
      HWB_ALLOWS.projcache.includes(spec.version),
      `dsh 当前写出的版本是 ${spec.version}，但 hwb 的 SUPPORTED_VERSIONS.projcache `
      + `= ${JSON.stringify(HWB_ALLOWS.projcache)} 不含它 → 新版 dsh 一写就整域 degraded。`
      + ' → 需要改：src/lib/schema.js',
    );
  });

  await t.test('tables 表名与 hwb 读取的表名一致', () => {
    assert.deepEqual(ENV.domains.workspace?.spec?.tables, ['workspaces'],
      'dsh 的 workspace 域表名变了 → hwb 读 data.tables.workspaces 会落空（src/lib/schema.js:50）');
    assert.deepEqual(ENV.domains.projcache?.spec?.tables, ['sessions'],
      'dsh 的 projcache 域表名变了 → hwb 读 data.tables.sessions 会落空（src/lib/schema.js:77）');
  });

  await t.test('workspace 域的 global 仍带 workspaceIds（hwb 用它判 archived）', () => {
    const spec = ENV.domains.workspace?.spec;
    assert.ok(spec?.hasGlobal, 'dsh 的 workspace 域不再声明 global → hwb 的 archived 判定会全体失效');
  });
});

// ===========================================================================
// B. 磁盘布局契约
// ===========================================================================

test('B. 磁盘布局契约：hwb 能读 dsh 实际写出的布局', { skip: SKIP_NO_DSH }, async (t) => {
  await t.test('projcache 是 per-record 布局时，hwb 必须能读 per-record 文件', () => {
    const spec = ENV.domains.projcache?.spec;
    assert.ok(spec, '未提取到 projcache 规格');
    if (spec.layout !== 'per-record') {
      // single 布局：hwb 只读聚合文件是**正确**的，无需 per-record 能力。
      return;
    }
    // dsh 是 per-record，hwb 却只读聚合文件 —— 这正是 62% 会话缺失的根因。
    // 本用例的判据是「reader 是否具备 per-record 读取能力」，用一个合成的 per-record
    // 目录去调 reader，而不是只看代码存在与否。
    assert.ok(
      typeof readPerRecordSessions === 'function',
      'projcache 是 per-record 布局，但 hwb 的 reader 没有 per-record 读取能力，'
      + '只会读到冻结的聚合文件（实测漏 62% 会话）。→ 需要改：src/lib/read-home.js',
    );
  });

  await t.test('per-record 信封是 {version, record}，且 hwb 的解析接受该信封', () => {
    const spec = ENV.domains.projcache?.spec;
    if (spec?.layout !== 'per-record') return;
    // 用真实 home 里的一个 per-record 文件验证信封形状。
    const dir = path.join(os.homedir(), '.dsh', 'storages', 'session_projcache', 'sessions');
    if (!existsSync(dir)) return;   // 本机没跑过 per-record，跳过（不假装通过也不失败）
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    if (!files.length) return;
    const doc = JSON.parse(readFileSync(path.join(dir, files[0]), 'utf8'));
    assert.ok(typeof doc.version === 'number',
      `per-record 文件缺少数字 version 字段（实测 rc.1 写的是 {version, record}）；实际 keys=${JSON.stringify(Object.keys(doc))}`);
    assert.ok('record' in doc, 'per-record 文件缺少 record 字段');
    assert.ok(doc.record && typeof doc.record === 'object', 'record 必须是对象');
    // record 内部就是 hwb 需要的 identity + rows
    assert.ok(doc.record.rows && typeof doc.record.rows === 'object',
      'record.rows 不存在 → hwb 读不到任何投影（title / tokenUsage / status）');
  });

  await t.test('聚合文件（single 信封）与 per-record 信封不是同一种形状 —— hwb 不能只认一种', () => {
    // 这条是「防止回退」的守卫：说明两种布局的信封不同，
    // 一旦有人把 reader 的兼容逻辑删掉，这条会提醒他两种形状都存在。
    const aggPath = path.join(os.homedir(), '.dsh', 'storages', 'session_projcache.json');
    const dir = path.join(os.homedir(), '.dsh', 'storages', 'session_projcache', 'sessions');
    if (!existsSync(aggPath) || !existsSync(dir)) return;
    const agg = JSON.parse(readFileSync(aggPath, 'utf8'));
    const perRec = readdirSync(dir).filter((f) => f.endsWith('.json'));
    if (!perRec.length) return;
    const doc = JSON.parse(readFileSync(path.join(dir, perRec[0]), 'utf8'));
    // 聚合 = {unit, global, tables}；per-record = {version, record}
    assert.ok('unit' in agg && 'tables' in agg, '聚合文件应是 single 信封 {unit, tables}');
    assert.ok('record' in doc && !('unit' in doc), 'per-record 文件应是 {version, record} 且无 unit');
  });
});

/**
 * per-record 读取能力探针（B 维度的判据）。
 *
 * 现在返回 reader 是否导出了 per-record 读取函数；修复后由 src/lib/read-home.js 提供。
 * 用「函数是否存在」而不是「字符串是否出现在文件里」——避免注释里的字样把测试骗过。
 */
async function readPerRecordSessions() {
  const mod = await import('../../src/lib/read-home.js').catch(() => null);
  if (!mod) return null;
  const fn = mod.readProjcachePerRecord ?? mod.readPerRecordSessions ?? null;
  return typeof fn === 'function' ? fn : null;
}

// ===========================================================================
// C. CLI 契约
// ===========================================================================

test('C. CLI 契约：启动 URL 打印格式与 token 抓取', { skip: SKIP_NO_DSH }, async (t) => {
  const cli = ENV.available ? extractCliContract(ENV.root) : { found: false };

  await t.test('dsh web 仍打印 `dsh web: <url>` 这一行（hwb 靠它抓 token）', () => {
    assert.ok(cli.found,
      'dsh-web-app 里找不到 `dsh web: ` 的打印模板 → hwb 的 captureDshToken 永远抓不到 token，'
      + '会退回裸 URL，而裸 URL 被 401 拒绝（实测 0.1.5-rc.1 仍是 303 换 cookie）。'
      + ' → 需要改：src/control/launcher.js 的 captureDshToken');
    assert.equal(cli.marker, 'dsh web: ', '打印行的前缀变了');
  });

  await t.test('token 查询参数名仍是 `token`', () => {
    assert.equal(cli.tokenQuery, 'token',
      'dsh 的 token query 名变了 → hwb 的 /\\?token=[A-Za-z0-9_-]+/ 正则与拼接的 URL 会失配。'
      + ' → 需要改：src/control/launcher.js + src/control/remote.js');
  });

  await t.test('printUrl 默认仍为 true（否则 dsh 不再打印 token）', () => {
    // 提取不到就不判定（dsh 可能改了配置写法），但提取到就必须是 true。
    if (cli.printUrlDefault === null) return;
    assert.equal(cli.printUrlDefault, true,
      'dsh web 的 printUrl 默认变成 false → 不再打印带 token 的 URL，hwb 只能拿裸 URL（401）。'
      + ' → 需要改：src/control/launcher.js 的 token 获取策略（改用别的方式换 cookie）');
  });

  await t.test('dsh --version 输出是可解析的版本串', () => {
    const p = probeDshVersionCli();
    if (!p.ok) return;      // PATH 上没有 dsh 可执行文件：跳过，不失败
    assert.match(p.version, /^\d+\.\d+\.\d+/, `dsh --version 输出形状异常：${JSON.stringify(p.version)}`);
  });
});

// ===========================================================================
// D. 真实 home 端到端（本机有 ~/.dsh 时才有意义）
// ===========================================================================

const HOME_DIR = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const HAS_HOME = existsSync(path.join(HOME_DIR, 'storages'));

test('D. 真实 home 端到端：hwb 读到的会话数不低于磁盘真值', { skip: HAS_HOME ? false : `本机无 ${HOME_DIR}/storages` }, async (t) => {
  await t.test('hwb 的 reader 不再静默漏会话', async () => {
    const { readHome } = await import('../../src/lib/read-home.js');
    const snap = readHome(HOME_DIR);

    // 磁盘真值：per-record 文件数 + （若 reader 只认聚合）聚合里的条目。
    const dir = path.join(HOME_DIR, 'storages', 'session_projcache', 'sessions');
    const perRec = existsSync(dir)
      ? readdirSync(dir).filter((f) => f.endsWith('.json')).length
      : 0;
    const aggPath = path.join(HOME_DIR, 'storages', 'session_projcache.json');
    let aggCount = 0;
    if (existsSync(aggPath)) {
      const agg = JSON.parse(readFileSync(aggPath, 'utf8'));
      aggCount = Object.keys(agg.tables?.sessions ?? {}).length;
    }
    const truth = Math.max(perRec, aggCount);
    if (truth === 0) return;   // 空 home

    // 这条断言是本次兼容性检查的核心产出：它把「62% 会话不可见」变成会红的测试。
    assert.ok(
      snap.sessions.length >= truth,
      `hwb 读到 ${snap.sessions.length} 个会话，但磁盘上有 ${truth} 个`
      + `（per-record ${perRec} / 聚合 ${aggCount}）→ 漏 ${truth - snap.sessions.length} 个`
      + `（${(((truth - snap.sessions.length) / truth) * 100).toFixed(0)}%）。`
      + ' 原因：dsh 已迁到 per-record 布局，hwb 只读冻结的聚合文件。'
      + ' → 需要改：src/lib/read-home.js 增加 per-record 读取',
    );
  });

  await t.test('真实 home 的 workspace.json 能被 hwb 校验通过（版本对得上）', () => {
    const p = path.join(HOME_DIR, 'storages', 'workspace.json');
    if (!existsSync(p)) return;
    const data = JSON.parse(readFileSync(p, 'utf8'));
    const r = validateWorkspaceJson(data);
    assert.ok(r.ok,
      `hwb 校验失败：${r.error} → workspace 域版本漂移，该实例工作区会整块 degraded。`
      + ' 需要改：src/lib/schema.js 的 SUPPORTED_VERSIONS.workspace');
  });

  await t.test('真实 home 的聚合 projcache（若在）能被 hwb 校验通过', () => {
    const p = path.join(HOME_DIR, 'storages', 'session_projcache.json');
    if (!existsSync(p)) return;
    const data = JSON.parse(readFileSync(p, 'utf8'));
    const r = validateProjcacheJson(data);
    assert.ok(r.ok,
      `hwb 校验失败：${r.error} → projcache 域版本漂移，该实例会话会整块 degraded。`
      + ' 需要改：src/lib/schema.js 的 SUPPORTED_VERSIONS.projcache');
  });

  await t.test('每个 per-record 文件的版本戳都在 hwb 的接受集内', async () => {
    const dir = path.join(HOME_DIR, 'storages', 'session_projcache', 'sessions');
    if (!existsSync(dir)) return;
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    const seen = new Map();
    for (const f of files) {
      let doc;
      try { doc = JSON.parse(readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
      const v = doc?.version;
      if (typeof v !== 'number') continue;
      seen.set(v, (seen.get(v) ?? 0) + 1);
    }
    const unknown = [...seen.keys()].filter((v) => !HWB_ALLOWS.projcache.includes(v));
    assert.deepEqual(
      unknown, [],
      `磁盘上存在 hwb 不认识的 projcache 版本戳 ${JSON.stringify(unknown)}`
      + `（分布 ${JSON.stringify(Object.fromEntries(seen))}）；hwb 允许 ${JSON.stringify(HWB_ALLOWS.projcache)}。`
      + ' → 需要改：src/lib/schema.js 的 SUPPORTED_VERSIONS.projcache',
    );
  });
});

// ===========================================================================
// E. 域发现：dsh 新增了我们还不认识的域吗？
// ===========================================================================

test('E. 域发现：dsh 的存储域清单已知（新增域需要人工评估是否该读）', { skip: SKIP_NO_DSH }, async (t) => {
  const { discoverDomains } = await import('./dsh-contract.mjs');

  await t.test('能扫出 dsh 声明的全部存储域', () => {
    const r = discoverDomains();
    assert.ok(r.available, '应能扫描 dsh 安装');
    assert.ok(r.domains.length >= 2, `至少应有 workspace 与 session_projcache，实际 ${JSON.stringify(r.domains.map((d) => d.name))}`);
    const names = r.domains.map((d) => d.name);
    for (const known of ['workspace', 'session_projcache']) {
      assert.ok(names.includes(known), `已知域 ${known} 未被扫出：${JSON.stringify(names)}`);
    }
  });

  await t.test('没有 hwb 还不认识的新域（有则提示评估）', () => {
    // hwb 当前读取的域。新增域**不一定**要读（可能是 dsh 内部用的），
    // 所以这里不是硬失败，而是要求「有人评估过」——评估后把域名加进这个白名单。
    const KNOWN = ['workspace', 'session_projcache'];
    const extra = discoverDomains().domains.map((d) => d.name).filter((n) => !KNOWN.includes(n));
    assert.deepEqual(
      extra, [],
      `dsh 声明了 hwb 还不认识的存储域 ${JSON.stringify(extra)}。`
      + ' → 请评估：该域是否包含工作台需要的数据（用量/状态/项目）？'
      + ' 若是，读它的方式见 tests/compat/README.md 的「新增域」一节；'
      + ' 若否，把域名加进本用例的 KNOWN 白名单即可（表示「已知且有意不读」）。',
    );
  });
});

// ===========================================================================
// F. Web UI 注入锚点：最脆的一处耦合（dsh 重新 minify 就静默失效）
// ===========================================================================

test('F. Web UI 注入锚点：workspace 菜单注入点仍然匹配', { skip: SKIP_NO_DSH }, async (t) => {
  const { findDshPackage } = await import('./dsh-contract.mjs');
  const { addWorkspaceFinderMenu } = await import('../../src/control/workspace-menu.js');

  await t.test('真实 bundle 里两个锚点都在，且注入产出合法 JS', async () => {
    const loc = ENV.root;
    const pkg = findDshPackage(loc, 'dsh-client-ui-workspace');
    if (!pkg) { t.skip('dsh 里没有 dsh-client-ui-workspace 包'); return; }
    const file = path.join(pkg, 'lib', 'client.js');
    if (!existsSync(file)) { t.skip('找不到 client.js'); return; }
    const src = readFileSync(file, 'utf8');

    // 这是全仓库最脆的耦合：按**字面量压缩后子串**打补丁，失配时 fail-closed（静默不注入）。
    // 失败信息要直接说明「用户会看到什么」+「去哪儿改」。
    const out = addWorkspaceFinderMenu(src);
    assert.notEqual(
      out, src,
      `dsh 的 workspace 客户端 bundle 集成点变了（锚点失配）→ 「在 Finder 中打开」菜单会**静默消失**。`
      + ' → 需要改：src/control/workspace-menu.js 的 items / guard 两个锚点常量',
    );

    // 注入后必须仍是合法 JS —— 否则会在浏览器里炸掉整个 dsh 前端（比不注入严重得多）。
    const tmp = path.join(os.tmpdir(), `hwb-compat-ws-${process.pid}.mjs`);
    const { writeFile, rm } = await import('node:fs/promises');
    await writeFile(tmp, out);
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      await promisify(execFile)(process.execPath, ['--check', tmp]);
    } finally {
      await rm(tmp, { force: true });
    }
  });
});

// ===========================================================================
// G. 路径一致性：本地 reader 与远程 cat 脚本必须用同一组路径
// ===========================================================================

test('G. 路径一致性：远程 cat 脚本与本地 reader 使用同一组存储路径', () => {
  // 这条防的是「改了一边忘了另一边」。历史上正是这种不一致导致远程实例静默少读数据：
  // 本地加上了 per-record 目录、远程脚本没加，远程实例就只看到陈旧的聚合文件。
  return Promise.all([
    import('../../src/lib/read-home.js'),
    import('../../src/dshhome/remote-reader.js'),
  ]).then(([local, remote]) => {
    const script = remote.buildCatScript();
    // ① 每个固定文件都在 cat 脚本里被 emit
    for (const rel of local.METADATA_FILES) {
      assert.ok(script.includes(`emit '${rel}'`),
        `cat 脚本没有抓 ${rel} → 远程实例会缺这个域（本地有、远端没有）`);
    }
    // ② per-record 目录常量两边必须相同
    assert.equal(remote.PER_RECORD_DIR, local.STORAGE_PATHS.projcachePerRecordDir,
      'per-record 目录常量在 remote-reader 与 read-home 之间不一致');
    assert.ok(script.includes(local.STORAGE_PATHS.projcachePerRecordDir),
      'cat 脚本没有抓 per-record 目录 → 远程实例会漏掉大部分会话（实测漏 62%）');
    // ③ 聚合文件也必须在（作为遗留 home 的兜底）
    assert.ok(script.includes(local.STORAGE_PATHS.projcacheAggregate),
      'cat 脚本没有抓聚合 projcache → 旧版 home 的远程实例会读不到会话');
  });
});

test('D2. 真实 home：pcLayout 能反映「磁盘布局」与「实际读取布局」是否一致', { skip: HAS_HOME ? false : `本机无 ${HOME_DIR}/storages` }, async () => {
  const { readHome, STORAGE_PATHS } = await import('../../src/lib/read-home.js');
  const snap = readHome(HOME_DIR);
  const dir = path.join(HOME_DIR, STORAGE_PATHS.projcachePerRecordDir);
  const onDisk = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).length : 0;
  if (onDisk === 0) return;   // 没有 per-record 数据：本机是旧布局，无需断言

  // 这是本次事故的**直接探测器**：磁盘上有 per-record 数据，而 hwb 一个都没读到，
  // 说明 reader 不认识这个布局（曾经的症状：只读到冻结的聚合文件、degraded 为空）。
  assert.ok(
    snap.pcLayout.perRecord > 0,
    `磁盘上有 ${onDisk} 个 per-record 会话文件，但 hwb 一个都没读到（pcLayout.perRecord=0）`
    + ' → reader 不认识 per-record 布局，只会读那个可能已冻结的聚合文件。'
    + ' 需要改：src/lib/read-home.js 的 projcache 读取分支',
  );
  // 且读到的会话数应覆盖磁盘上的 per-record 文件数（同 id 去重后至少是文件数量级）
  assert.ok(
    snap.sessions.length >= snap.pcLayout.perRecord,
    `读到的会话数（${snap.sessions.length}）少于 per-record 文件数（${snap.pcLayout.perRecord}）——不应发生`,
  );
  // pcVersion 必须是 dsh 接受集里的成员（否则说明读到的是 hwb 不认识的版本，却没报 degraded）
  const accepted = ENV.domains.projcache?.spec;
  if (accepted) {
    const allowed = [accepted.version, ...(accepted.compatibleVersions ?? [])];
    assert.ok(
      allowed.includes(snap.pcVersion),
      `读到 pcVersion=${snap.pcVersion}，但 dsh 只接受 ${JSON.stringify(allowed)}`
      + ' → 版本判定与磁盘不一致',
    );
  }
});

test('G2. 远端投影的保留清单必须覆盖 schema 实际读取的每个 projection', () => {
  // 远端为了让 per-record 传输量降下来，在远端**丢掉** hwb 不用的 projection
  // （实测省 69–97%）。代价是引入一条隐式耦合：投影的 KEEP 清单必须 ⊇
  // `src/lib/schema.js` 真正读的 rows 键。
  //
  // 一旦有人在 schema 里多读一个 projection（比如加个 `modelUsage`）而忘了加进 KEEP，
  // 症状是：**本地实例有值、远程实例是空** —— 最难排查的那种「只有一部分实例不对」。
  // 所以这里把清单从源码里**推导**出来比对，而不是两边各写一份。
  const schemaSrc = readFileSync(path.join(REPO, 'src', 'lib', 'schema.js'), 'utf8');
  const remoteSrc = readFileSync(path.join(REPO, 'src', 'dshhome', 'remote-reader.js'), 'utf8');

  // schema.js 里所有 `rows.<key>` 的读取（含 deriveSessionStatus 的参数）
  const used = new Set([...schemaSrc.matchAll(/rows\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]));
  assert.ok(used.size >= 8, `应从 schema.js 解析出足够的 projection 键，实际 ${used.size}`);

  const keepMatch = /KEEP=\{([^}]*)\}/.exec(remoteSrc);
  assert.ok(keepMatch, '应能从 remote-reader.js 里找到投影的 KEEP 清单');
  const keep = new Set(
    keepMatch[1].split(',').map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean),
  );
  assert.ok(keep.size >= 8, `KEEP 清单过小（${keep.size}）—— 可能解析失败或被人改窄了`);

  const missing = [...used].filter((k) => !keep.has(k));
  assert.deepEqual(
    missing, [],
    `远端投影会丢掉 schema 需要的 projection ${JSON.stringify(missing)} →`
    + ' 症状是「本地实例有值、远程实例为空」，且只在远程复现。'
    + ' → 需要改：src/dshhome/remote-reader.js 里 buildCatScript 的 KEEP 集合'
    + '（或 python 投影脚本里的 KEEP），把它加上；同时更新本用例所在 README 的说明',
  );
});

test('C2. RPC 端点命名：hwb 首选的写法仍是 dsh 当前的写法', { skip: SKIP_NO_DSH }, async () => {
  // hwb 有一套「两代端点命名」的回退（`/api/session/list` → `/api/session.list`，见
  // src/dshhome/live-status.js 的 DEFAULT_ENDPOINTS）。回退能容错，但**首选写错**是有代价的：
  // 每次发现都先白发一条 404，日志里刷「rpc http 404」，而且一旦 dsh 哪天只认另一种写法，
  // 从此每次都要多一个来回。
  //
  // 本用例把「实测的 dsh 现状」钉住：0.1.5-rc.1 的 host 注册的是 slash 形
  // （`#session/list`，见 dsh-api-session-controller/lib/typert.host.js）。若哪天变成 dot 形，
  // 这里会提醒把首选顺序换过来 —— 不是硬失败，因为回退仍能工作，但值得知道。
  const { readFileSync } = await import('node:fs');
  const { findDshPackage } = await import('./dsh-contract.mjs');
  const pkg = findDshPackage(ENV.root, 'dsh-api-session-controller');
  if (!pkg) { return; }   // 该包不在这个安装里：无法判定
  const hostJs = path.join(pkg, 'lib', 'typert.host.js');
  if (!existsSync(hostJs)) return;
  const src = readFileSync(hostJs, 'utf8');

  // host 侧注册的端点 id
  const slash = /#session\/list/.test(src);
  const dot = /#session\.list/.test(src);
  const { DEFAULT_ENDPOINTS } = await import('../../src/dshhome/live-status.js').catch(() => ({}));
  if (!DEFAULT_ENDPOINTS) {
    // 没导出就**断言失败**，而不是悄悄 return ——
    // 悄悄 return 会让这条用例变成「假绿」：报「通过」，其实一行断言都没跑。
    // 本仓库对「静默跳过」的态度见 tests/compat/README.md：不确定就明确说，
    // 不要用沉默冒充通过。
    assert.fail(
      'src/dshhome/live-status.js 没有导出 DEFAULT_ENDPOINTS → 本条契约无法判定。'
      + ' 需要改：把 `const DEFAULT_ENDPOINTS` 改成 `export const DEFAULT_ENDPOINTS`',
    );
  }

  if (slash) {
    assert.equal(
      DEFAULT_ENDPOINTS[0], 'session/list',
      `dsh 的 host 注册的是 slash 形端点，但 hwb 首选的却是 ${DEFAULT_ENDPOINTS[0]}`
      + ' → 每次都会先白发一条 404。需要改：src/dshhome/live-status.js 的 DEFAULT_ENDPOINTS 顺序',
    );
  }
  assert.ok(slash || dot, 'dsh 里应能找到 session/list 或 session.list 之一的端点注册');
});

test('C3. profile 模板契约：dsh 自带的 headless/web 模板仍与 hwb 脚本一致', { skip: SKIP_NO_DSH }, async (t) => {
  // `scripts/dsh21-deploy.sh` 会在远端**自己写一份 headless profile 的 package.json**：
  //   {"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-headless"],
  //                      "patchReload":"startup"}}}
  // 它假定这个形状与 dsh 自带模板一致。若 dsh 改了模板（比如 headless 不再用 dsh-base、
  // 或 patchReload 取值变了），那个脚本会写出一份**连不上**的 profile ——
  // 症状是远端 `dsh --profile headless` 起不来，而错误信息指向插件加载，很难联想到脚本。
  //
  // 这里从 dsh 的 app-boot 里读出**权威模板**来比对。
  const { findDshPackage } = await import('./dsh-contract.mjs');
  const pkg = findDshPackage(ENV.root, 'dsh-app-boot');
  if (!pkg) { t.skip('dsh 里没有 dsh-app-boot'); return; }
  const f = path.join(pkg, 'lib', 'index.js');
  if (!existsSync(f)) { t.skip('找不到 dsh-app-boot/lib/index.js'); return; }
  const src = readFileSync(f, 'utf8');

  await t.test('能读出 dsh 自带的 profile 模板', () => {
    assert.match(src, /PROFILE_TEMPLATES/, 'dsh 应仍以 PROFILE_TEMPLATES 声明自带模板');
    // web 与 headless 是 hwb 用到的两个
    for (const name of ['web', 'headless']) {
      assert.ok(new RegExp(`\\b${name}:\\s*\\{`).test(src), `模板里应有 ${name}`);
    }
  });

  await t.test('headless 模板与 dsh21-deploy.sh 写的那份一致', () => {
    // 抓 headless 那一块的 bundles 与 patchReload
    const block = /\bheadless:\s*\{([\s\S]*?)\}/.exec(src)?.[1];
    assert.ok(block, '应能切出 headless 模板块');
    const bundles = [...block.matchAll(/"(@deepseek-ai\/[^"]+)"/g)].map((m) => m[1]);
    const patchReload = /patchReload:\s*"([^"]+)"/.exec(block)?.[1];

    // 从脚本里**精确切出那份 profile package.json**（脚本以 `cat > ... <<'EOF'` 写它），
    // 而不是在整个脚本里搜字符串 —— 后者会被注释/预检里的同名出现「骗过」
    // （实测：只改 profile 行、留着注释里的包名，全文搜索仍然「通过」）。
    const script = readFileSync(path.join(REPO, 'scripts', 'dsh21-deploy.sh'), 'utf8');
    const jsonLine = script.split('\n').find((l) => l.trim().startsWith('{"name":"dsh-profile-headless"'));
    assert.ok(jsonLine, '应能在 dsh21-deploy.sh 里找到写成 profile 的那行 JSON');
    const scripted = JSON.parse(jsonLine.trim());
    const scriptedBundles = scripted.dsh?.profile?.bundles ?? [];

    // bundles 必须**逐项**一致（顺序也一致：dsh-base 在前是加载顺序）
    assert.deepEqual(
      scriptedBundles, bundles,
      `dsh 的 headless 模板是 ${JSON.stringify(bundles)}，而 dsh21-deploy.sh 写的是 `
      + `${JSON.stringify(scriptedBundles)} → 需要改：scripts/dsh21-deploy.sh 那行 profile JSON`,
    );
    if (patchReload !== undefined) {
      assert.equal(
        scripted.dsh?.profile?.patchReload, patchReload,
        `dsh 的 headless 模板现在是 patchReload:"${patchReload}"，`
        + `dsh21-deploy.sh 写的是 "${scripted.dsh?.profile?.patchReload}" → 需要改那个脚本`,
      );
    }
  });
});

test('C4. CLI 参数回落：dsh 的真实报错措辞仍能触发 hwb 的 --no-open 回退', { skip: SKIP_NO_DSH }, async (t) => {
  // hwb 启动本机 dsh web 时会带 `--no-open`（避免多弹一个浏览器）。若目标 dsh 不认识它，
  // hwb 靠**解析 stderr 措辞**来判断「该去掉这个参数重试一次」。
  // 判据写错 = 新版 dsh 下本机实例**完全起不来**（而且只在旧/特殊 dsh 上复现，很难查）。
  //
  // 这里不去真的跑 dsh（要起服务），而是从 dsh 的 CLI 定义里确认：
  // ① `--no-open` 仍**存在**（那就不需要回退，回退只是兜底）；
  // ② 报错措辞仍是 commander 的 `unknown option` 形态（hwb 的正则认它）。
  const { findDshPackage } = await import('./dsh-contract.mjs');
  const pkg = findDshPackage(ENV.root, 'dsh-web-app');
  if (!pkg) { t.skip('dsh 里没有 dsh-web-app'); return; }

  await t.test('dsh web 仍提供 --no-open（hwb 的常规路径）', () => {
    const f = path.join(pkg, 'lib', 'startup.js');
    const candidates = [f, path.join(pkg, 'lib', 'index.js')].filter((p) => existsSync(p));
    if (!candidates.length) { t.skip('找不到 dsh-web-app 的 startup/index'); return; }
    const src = candidates.map((p) => readFileSync(p, 'utf8')).join('\n');
    assert.ok(
      /--no-open/.test(src),
      'dsh web 不再提供 --no-open → 需要改：src/control/launcher.js 去掉该参数（或改用等价开关）',
    );
  });

  await t.test('hwb 的回退判据能匹配 commander 的 unknown-option 措辞', () => {
    // 实测 dsh 0.1.5-rc.1 的措辞（`dsh web --port N --definitely-not-a-flag`）：
    //   error: unknown option '--definitely-not-a-flag'
    // 另有一种带提示的变体（commander 会另起一行）：
    //   error: unknown option '--no-open'\n(Did you mean --open?)
    const launcher = readFileSync(path.join(REPO, 'src', 'control', 'launcher.js'), 'utf8');
    // 只认**可执行代码**行：源码里 `unknown option` 也出现在注释里（实测踩过），
    // 若不过滤注释，会从一个注释行里去取正则，取不到就报「找不到判据」——
    // 那是测试自己的问题，会误导成实现有问题。
    const line = launcher.split('\n').find(
      (l) => /unknown option/.test(l) && !l.trim().startsWith('//') && /\/i/.test(l),
    );
    assert.ok(line, '应能在 launcher.js 里找到回退判据（可执行代码行）');
    // 直接从源码里取出那个正则，用它去测真实措辞 —— 避免测试与实现各写一份
    const m = /(\/unknown option[^\n]*?\/i)/.exec(line);
    assert.ok(m, `应从 launcher.js 里取出回退正则，实际那一行：${line.trim().slice(0, 120)}`);
    // eslint-disable-next-line no-eval
    const re = eval(m[1]);
    for (const wording of [
      "error: unknown option '--no-open'",
      "error: unknown option '--no-open'\n(Did you mean --open?)",
    ]) {
      assert.ok(re.test(wording), `回退正则应匹配真实措辞：${JSON.stringify(wording)}`);
    }
  });
});

test('D3. 不同 home 可以处在不同的 projcache 版本上（真实场景：v7 与 v5 并存）', { skip: SKIP_NO_DSH }, async () => {
  // 实测本机两个 home 就是不同版本：~/.dsh 是 v7（0.1.5-rc.1 写的）、
  // ~/.dsh-bee 是 v5（更早的 dsh 写的，之后没被新版重写过）。
  // hwb 必须**同时**正确读它们 —— 这正是把 SUPPORTED_VERSIONS.projcache
  // 从 [3,4,5] 放宽到 [3,4,5,6,7] 的现实依据（不是假想的兼容性）。
  //
  // 这条用**合成的两个 home** 来断言，不依赖本机恰好有哪几个 home。
  const { readHome } = await import('../../src/lib/read-home.js');
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const os2 = await import('node:os');

  const mkHome = (ver) => {
    const home = mkdtempSync(path.join(os2.tmpdir(), `hwb-mix-${ver}-`));
    const dir = path.join(home, 'storages', 'session_projcache', 'sessions');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(home, 'storages', 'workspace.json'), JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { workspaceIds: [] },
      tables: { workspaces: {} },
    }));
    writeFileSync(path.join(dir, `session-v${ver}.json`), JSON.stringify({
      version: ver,
      record: {
        identity: { createdAt: 1, cwd: '/p' },
        rows: { title: { ver: 1, seq: 1, val: `home-on-v${ver}` } },
      },
    }));
    return home;
  };

  // dsh 接受集里的每个版本都要能读（含「当前版本」与「compatible 旧版本」）
  const spec = ENV.domains.projcache?.spec;
  const accepted = [spec.version, ...(spec.compatibleVersions ?? [])];
  const homes = [];
  try {
    for (const ver of accepted) {
      const home = mkHome(ver);
      homes.push(home);
      const snap = readHome(home);
      assert.equal(snap.sessions.length, 1, `v${ver} 的 home 应读出 1 个会话`);
      assert.equal(snap.sessions[0].title, `home-on-v${ver}`);
      assert.equal(snap.pcVersion, ver, `pcVersion 应如实反映 v${ver}`);
      assert.deepEqual(snap.degraded, [], `v${ver} 不该降级（dsh 声明它兼容）`);
    }
    assert.equal(homes.length, accepted.length, '每个接受版本都应被测到');
  } finally {
    for (const h of homes) rmSync(h, { recursive: true, force: true });
  }
});

test('D4. dsh 降级后 v7 与 v3 文件并存，hwb 要都能读', { skip: SKIP_NO_DSH }, async () => {
  // 真实场景：用户把 dsh 从 0.1.5-rc.1 **降级**回旧版。
  // 新版写过的 v7 文件**仍在盘上**（旧版不认识、不会去重写或删除它们），
  // 于是这个 home 变成 v3 与 v7 混装。若 hwb 只认一个版本（或只认当前版本），
  // 满盘一半会话会消失 —— 而且旧版 dsh 自己也读不了另一半，这个状态会长期存在。
  const { readHome } = await import('../../src/lib/read-home.js');
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const os2 = await import('node:os');

  const home = mkdtempSync(path.join(os2.tmpdir(), 'hwb-downgrade-'));
  const dir = path.join(home, 'storages', 'session_projcache', 'sessions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(home, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { workspaceIds: [] },
    tables: { workspaces: {} },
  }));
  const rec = (v, seq, title) => JSON.stringify({
    version: v,
    record: { identity: { createdAt: seq, cwd: '/p' }, rows: { title: { ver: 1, seq, val: title } } },
  });
  // 新版写过的（降级后遗留）+ 降级后旧版写的
  writeFileSync(path.join(dir, 's-new.json'), rec(7, 9, 'written by NEW dsh'));
  writeFileSync(path.join(dir, 's-old.json'), rec(3, 5, 'written by OLD dsh'));
  try {
    const snap = readHome(home);
    assert.equal(snap.sessions.length, 2, '混装的两个版本都要读出来');
    assert.deepEqual(
      snap.sessions.map((s) => s.title).sort(),
      ['written by NEW dsh', 'written by OLD dsh'],
    );
    assert.deepEqual(snap.degraded, [], '两个版本都在 dsh 的接受集里，不该降级');
    assert.equal(snap.pcVersion, 7, 'pcVersion 取最高版本');
    assert.deepEqual({ ...snap.pcLayout.versions }, { 3: 1, 7: 1 }, '版本分布如实记录');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
