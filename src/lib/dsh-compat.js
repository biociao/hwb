/**
 * dsh 兼容性自检（生产侧）。
 *
 * ## 与 tests/compat/ 的分工
 *
 * `tests/compat/dsh-contract.mjs` 是**测试侧**的提取器：它从安装的 dsh 里读出权威契约，
 * 交给测试断言。本模块是**生产侧**的自检：用同一套提取思路，在 `hwb doctor` 里
 * 把「本机装的 dsh 与 hwb 假设是否一致」直接告诉用户。
 *
 * 为什么生产侧也需要它：dsh 升级后 hwb 的降级是**静默**的 —— 实测真实事故是
 * 「476 个会话只显示 179 个，且 degraded 为空」。用户不会去看 hwb 的测试，
 * 但会在遇到「实例怎么空了」时跑 `hwb doctor`。所以把检查放在那里。
 *
 * ## 设计取舍
 *
 * 这里**故意不 import 测试目录**（tests/ 不进生产依赖路径，且 npm 包可能只装 src）。
 * 两个模块的提取逻辑因此各有一份 —— 代价是可能有轻微重复，收益是生产侧零额外依赖。
 * 为避免两份逻辑漂移，本项目用一条测试固定「两者对同一份 dsh 得出相同结论」
 * （tests/compat/dsh-compat.test.js 里的「生产自检与测试提取器结论一致」）。
 *
 * 本模块**只读**、不写任何东西；找不到 dsh 时返回 `{ available: false }` 而不是抛错
 * （doctor 是诊断命令，缺 dsh 不该让它崩）。
 */

import { readFileSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// hwb 支持的存储域版本。**必须与 src/lib/schema.js 的 SUPPORTED_VERSIONS 保持一致** ——
// 由 tests/compat 的「生产自检与 schema 常量一致」用例守住，别在这里独立演化。
export const HWB_SUPPORTED = {
  workspace: [2],
  projcache: [3, 4, 5, 6, 7],
};

/** 域包名 → 域内声明的 name。 */
const DOMAIN_PKGS = {
  workspace: { pkg: 'dsh-workspace', name: 'workspace' },
  projcache: { pkg: 'dsh-session-projection-cache', name: 'session_projcache' },
};

/** 找 dsh 安装根（node_modules 级）。找不到返回 null。 */
export function findDshRoot({ env = process.env, home = os.homedir() } = {}) {
  const roots = [];
  const push = (p) => { if (p && !roots.includes(p)) roots.push(p); };
  push(env.DSH_NODE_MODULES);
  if (env.DSH_INSTALL_ROOT) push(path.join(env.DSH_INSTALL_ROOT, 'node_modules'));
  // PATH 上的 dsh → <root>/bin/dsh → <root>/lib/node_modules
  for (const dir of String(env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const bin = path.join(dir, 'dsh');
    if (!existsSync(bin)) continue;
    try {
      const real = realpathSync(bin);
      push(path.join(path.resolve(path.dirname(real), '..'), 'lib', 'node_modules'));
    } catch { /* 忽略 */ }
  }
  // nvm 下可能有**多个** node 版本、各自装着 dsh。`readdir` 的顺序是按目录名字母序
  // （实测 v20 排在 v22 前），与「用户实际在跑哪个」无关 —— 只按顺序取第一个，
  // 会把一个更旧的 dsh 当作权威来判兼容性。
  //
  // 因此**优先当前正在运行的 Node 版本**对应的目录（`process.version`，如 v22.21.1）：
  // hwb 自身就跑在这个 Node 上，它下面的 dsh 才最可能是用户在用的那个。
  // 找不到再退回字母序（保持原行为，不会更差）。
  const nvm = path.join(home, '.nvm', 'versions', 'node');
  if (existsSync(nvm)) {
    const versions = readdirSafe(nvm);
    const current = process.version;                    // 形如 v22.21.1
    const preferred = versions.filter((v) => v === current);
    const rest = versions.filter((v) => v !== current);
    for (const v of [...preferred, ...rest]) push(path.join(nvm, v, 'lib', 'node_modules'));
  }
  push(path.join(home, '.local', 'node', 'lib', 'node_modules'));
  push('/usr/local/lib/node_modules');
  push('/usr/lib/node_modules');

  for (const r of roots) {
    if (existsSync(path.join(r, '@deepseek-ai', 'dsh', 'package.json'))) return r;
  }
  return null;
}

function readdirSafe(d) {
  try { return readdirSync(d); } catch { return []; }
}

/** 在安装根里定位包目录（flat / nested 两种布局）。 */
function findPkg(dshRoot, pkgName) {
  for (const c of [
    path.join(dshRoot, '@deepseek-ai', pkgName),
    path.join(dshRoot, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', pkgName),
  ]) {
    if (existsSync(path.join(c, 'package.json'))) return c;
  }
  return null;
}

/** 读 dsh 自身的版本号。 */
export function dshVersionOf(dshRoot) {
  if (!dshRoot) return null;
  try {
    return JSON.parse(readFileSync(path.join(dshRoot, '@deepseek-ai', 'dsh', 'package.json'), 'utf8')).version ?? null;
  } catch { return null; }
}

/** 括号配平：从 `{` 找到配对的 `}`（跳过字符串与注释）。 */
function matchBrace(text, open) {
  let depth = 0;
  let inS = null;
  let inLine = false;
  let inBlock = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inLine) { if (c === '\n') inLine = false; continue; }
    if (inBlock) { if (c === '*' && next === '/') { inBlock = false; i++; } continue; }
    if (inS) {
      if (c === '\\') { i++; continue; }
      if (c === inS) inS = null;
      continue;
    }
    if (c === '/' && next === '/') { inLine = true; i++; continue; }
    if (c === '/' && next === '*') { inBlock = true; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { inS = c; continue; }
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') {
      depth--;
      if (depth === 0 && c === '}') return i;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

/** 从源码文本里提取某个 defineDomain 规格的纯字面量字段。 */
function extractSpecFromSource(src, wantedName) {
  const needle = 'defineDomain(';
  let idx = 0;
  while ((idx = src.indexOf(needle, idx)) !== -1) {
    let i = idx + needle.length;
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] !== '{') { idx = i; continue; }
    const end = matchBrace(src, i);
    if (end === -1) { idx = i + 1; continue; }
    const body = src.slice(i + 1, end);
    const name = /(?:^|,)\s*name\s*:\s*["']([^"']+)["']/.exec(body)?.[1];
    if (name === wantedName) {
      const version = Number(/(?:^|,)\s*version\s*:\s*(\d+)/.exec(body)?.[1]);
      const compatRaw = /(?:^|,)\s*compatibleVersions\s*:\s*\[([^\]]*)\]/.exec(body)?.[1];
      // 只把**纯数字**列表当「已声明」。出现展开运算符（`[...OLD]`）或变量时静态解不出，
      // 必须视为「未声明」而不是「声明为空数组」—— 后者会让检查器以为 dsh 明确不支持任何旧版本。
      let compatibleVersions;
      if (compatRaw !== undefined) {
        const parts = compatRaw.split(',').map((s) => s.trim()).filter(Boolean);
        if (parts.every((s) => /^\d+$/.test(s))) compatibleVersions = parts.map(Number);
      }
      const layout = /(?:^|,)\s*layout\s*:\s*["']([^"']+)["']/.exec(body)?.[1];
      // tables 的**键名**（hwb 要按表名取数据）。只取 `tables: { a: …, b: … }` 顶层的键，
      // 不递归进值里 —— 值是 `domainTable(schema)` 之类，解析它没有意义且容易出错。
      const tablesRaw = /(?:^|,)\s*tables\s*:\s*\{([\s\S]*?)\}\s*$/m.exec(body)?.[1]
        ?? /(?:^|,)\s*tables\s*:\s*\{([^}]*)\}/.exec(body)?.[1];
      let tables;
      if (tablesRaw !== undefined) {
        const keys = [...tablesRaw.matchAll(/(?:^|,)\s*([A-Za-z_$][\w$]*)\s*:/g)].map((m) => m[1]);
        if (keys.length) tables = keys;
      }
      return {
        name,
        version: Number.isFinite(version) ? version : undefined,
        compatibleVersions,
        layout,
        tables,
      };
    }
    idx = end + 1;
  }
  return null;
}

/**
 * 在某个包的 lib/ 下找域规格。
 *
 * 先试常见文件名（快），再**兜底扫 lib/ 下所有 .js**：域定义放在哪个文件是 dsh 的内部组织，
 * 实测 rc.1 是 `lib/index.js`，而源码里还有 `lib/types/spec.js` / `lib/invariant.js` 两份副本；
 * 换个版本完全可能挪到别的文件名。只试固定几个名字会让自检在重构后退化成「提取失败」。
 */
function specInDir(dir, name) {
  const lib = path.join(dir, 'lib');
  if (!existsSync(lib)) return null;
  const preferred = ['index.js', 'types/spec.js', 'invariant.js', 'types/index.js', 'spec.js']
    .map((rel) => path.join(lib, rel))
    .filter((f) => existsSync(f));
  // 其余 .js（顶层，不递归到子目录深处）作为兜底，排除已在 preferred 里的。
  const prefSet = new Set(preferred);
  const rest = readdirSafe(lib)
    .filter((f) => f.endsWith('.js'))
    .map((f) => path.join(lib, f))
    .filter((f) => !prefSet.has(f));

  for (const f of [...preferred, ...rest]) {
    let src;
    try { src = readFileSync(f, 'utf8'); } catch { continue; }
    if (!src.includes('defineDomain(')) continue;
    const spec = extractSpecFromSource(src, name);
    if (spec) return { spec, file: f };
  }
  return null;
}

/** 列出 dsh 安装里所有 @deepseek-ai/<pkg> 目录（兼容 flat / nested 两种布局）。 */
function allDshPackages(dshRoot) {
  const out = [];
  for (const scopeDir of [
    path.join(dshRoot, '@deepseek-ai'),
    path.join(dshRoot, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'),
  ]) {
    if (!existsSync(scopeDir)) continue;
    for (const pkg of readdirSafe(scopeDir)) out.push(path.join(scopeDir, pkg));
  }
  return out;
}

/**
 * 提取一个域的规格。
 *
 * 先试**已知包名**（快、且给出精确的错误信息），失败则**回退到全量扫描**：
 * 域名（`session_projcache` / `workspace`）比包名稳定得多 —— dsh 完全可能把域定义
 * 挪到别的包（拆分/合并/重命名）。只认死包名的话，这种重构会让自检退化成
 * 「提取失败」——虽然不会谎报兼容，但也帮不上忙。扫描一次只读几十个文件，代价可接受。
 */
function extractDomain(dshRoot, key) {
  const { pkg, name } = DOMAIN_PKGS[key];
  const known = findPkg(dshRoot, pkg);
  if (known) {
    const hit = specInDir(known, name);
    if (hit) return { found: true, spec: hit.spec, file: hit.file, via: pkg };
  }
  // 回退：扫全部包找这个**域名**（包改名/移动时仍能定位）。
  for (const dir of allDshPackages(dshRoot)) {
    if (known && dir === known) continue;   // 上面已试过
    const hit = specInDir(dir, name);
    if (hit) return { found: true, spec: hit.spec, file: hit.file, via: path.basename(dir) };
  }
  return {
    found: false,
    reason: known
      ? `在 ${pkg} 及全量扫描里都没找到 ${name} 的 defineDomain`
      : `找不到 ${pkg}，全量扫描里也没有 ${name}`,
  };
}

/**
 * 做一次完整的兼容性自检。
 *
 * 返回：
 *   {
 *     available: bool,          // 是否找到 dsh
 *     dshVersion, dshRoot,
 *     ok: bool,                 // 兼容性结论
 *     problems: [ { domain, kind, detail } ],
 *     domains: { <key>: spec },
 *     summary: string,          // 一行给人看的结论
 *   }
 *
 * `kind` 取值：
 *   'version-missing'  —— dsh 接受的某个版本 hwb 不在白名单里（会整域降级）
 *   'layout-unsupported' —— dsh 用 per-record 而 hwb 版本白名单/读取能力跟不上
 *   'extract-failed'   —— 提取不到（无法判定，**不算不兼容**，但要说出来）
 */
export function checkDshCompat({ env = process.env, home = os.homedir() } = {}) {
  const dshRoot = findDshRoot({ env, home });
  if (!dshRoot) {
    return { available: false, ok: true, problems: [], domains: {}, summary: '未找到 dsh 安装（跳过兼容性检查）' };
  }
  const dshVersion = dshVersionOf(dshRoot);
  const problems = [];
  const domains = {};

  for (const key of Object.keys(DOMAIN_PKGS)) {
    const d = extractDomain(dshRoot, key);
    if (!d.found) {
      problems.push({ domain: key, kind: 'extract-failed', detail: d.reason });
      continue;
    }
    const spec = d.spec;
    const accepted = [spec.version, ...(spec.compatibleVersions ?? [])].filter((v) => typeof v === 'number');
    domains[key] = { ...spec, accepted };
    const missing = accepted.filter((v) => !HWB_SUPPORTED[key].includes(v));
    if (missing.length) {
      problems.push({
        domain: key,
        kind: 'version-missing',
        detail: `dsh 接受 ${JSON.stringify(accepted)}，hwb 只认 ${JSON.stringify(HWB_SUPPORTED[key])}，缺 ${JSON.stringify(missing)}`,
      });
    }
    // 极端但值得单列：dsh 的**当前**版本 hwb 都不认（数据一写就会被判降级）。
    if (!HWB_SUPPORTED[key].includes(spec.version)) {
      problems.push({
        domain: key,
        kind: 'layout-unsupported',
        detail: `dsh 当前写出的版本是 ${spec.version}，hwb 不支持 → 该域会整块 degraded`,
      });
    }
  }

  const hard = problems.filter((p) => p.kind !== 'extract-failed');
  const unknown = problems.filter((p) => p.kind === 'extract-failed');
  const ok = hard.length === 0;
  // `ok` 只代表「已判定的契约都兼容」；提取失败（dsh 改了包名/目录结构）属**无法判定**，
  // 既不算通过也不算不兼容，但必须说出来 —— 否则「兼容 ✓」会把「我们根本没读到」说成好事。
  let summary;
  if (!ok) {
    summary = `dsh ${dshVersion ?? '?'} 存在 ${hard.length} 处不兼容：${hard.map((p) => `${p.domain}(${p.kind})`).join('、')}`;
  } else if (unknown.length) {
    summary = `dsh ${dshVersion ?? '?'} 兼容性无法完全判定（${unknown.length} 个域提取失败，见下）`;
  } else {
    summary = `dsh ${dshVersion ?? '?'} 兼容 ✓`;
  }

  return { available: true, dshRoot, dshVersion, ok, problems, domains, summary };
}

/** 供 doctor 打印的多行文本。 */
export function formatDshCompat(report) {
  if (!report.available) return report.summary;
  const lines = [report.summary];
  for (const p of report.problems) {
    lines.push(`  · ${p.domain}: ${p.detail}`);
  }
  if (!report.ok) {
    lines.push('  → 修复：src/lib/schema.js 的 SUPPORTED_VERSIONS 加上缺的版本；'
      + '若布局变化还需改 src/lib/read-home.js。详见 tests/compat/README.md');
    lines.push('  → 先跑 `npm run test:compat` 看契约测试的具体结论');
  }
  return lines.join('\n');
}
