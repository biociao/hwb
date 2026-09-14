/**
 * dsh 契约提取器（compat 模块的地基）。
 *
 * ## 为什么需要它
 *
 * hwb 是 dsh **磁盘格式 + CLI 表面**的消费者，但它对这些契约的假设是**手抄**进
 * `src/lib/schema.js` 的（`SUPPORTED_VERSIONS`），而且注释里还引用了 dsh 源码行号
 * （如 `dsh-session-projection-cache/lib/index.js:86-90`）。手抄必然滞后：
 *
 *   实测 2026-09-15，本机 dsh 0.1.5-rc.1 声明 session_projcache `version: 7`、
 *   `compatibleVersions: [3,4,5,6]`，而 hwb 的常量是 `[3,4,5]` —— 一旦某个 home 的
 *   projcache 被新版写成 6 或 7，hwb 把整个域判 degraded、该实例在仪表盘上「看起来空了」。
 *   而且 dsh 早已把 projcache 从「单文件聚合」迁到 **per-record 布局**
 *   （`storages/session_projcache/sessions/<key>.json`），hwb 却只读那个冻结的聚合文件：
 *   真实 home 上 476 个会话只有 179 个可见（**漏 62%**），且完全没有 degraded 提示。
 *
 * 所以本模块把「契约」从 dsh 的**实际安装**里读出来（而不是抄），让测试去比对
 * 「hwb 的假设」与「dsh 的事实」，并在 dsh 升级后**自动**报告漂移 —— 这正是用户要的
 * 「版本更新后进行及时的测试和匹配」。
 *
 * ## 提取策略（三级降级，优先级从高到低）
 *
 *   1. **运行时提取**（最强）：import dsh 的 `defineDomain` 模块 + 域包，直接拿到
 *      `projectionCacheDomainSpec` / `workspaceDomainSpec` 的活对象。但 dsh 是 ESM
 *      bundle，域包的 import 图可能带副作用（注册全局、要求 cordis ctx），风险高。
 *   2. **源码文本提取**（主力）：读 dsh 安装目录里的 `defineDomain({...})` 调用文本，
 *      用括号配平切出对象字面量，再用一个**受限求值器**把 `version: 7` /
 *      `compatibleVersions: [3,4,5,6]` / `layout: "per-record"` / `name: "x"` 这些
 *      纯字面量字段解出来。不 eval、不 import，只做正则 + 配平 —— 安全且足够。
 *   3. **缺失即未知**：提取不到就报 `found: false`，测试按「无法判定」处理（**不**假装通过）。
 *
 * 第 2 级是主力：dsh 的编译产物里 `defineDomain({...})` 始终是**纯字面量**调用
 * （实测 0.1.5-rc.1 的 session_projcache / workspace 两处都是），提取稳定且无副作用。
 *
 * ## 与 dsh 版本的关系
 * 本模块**不写死**任何版本号；版本号是提取的**结果**。
 * 唯一写死的是「怎么找到 dsh」与「域叫什么名字」（`session_projcache` / `workspace`），
 * 而这两个名字本身也会被反向校验（见 `assertKnownDomainNames`）。
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// 定位 dsh 安装
// ---------------------------------------------------------------------------

/**
 * 候选根目录（每个都是「能再往下找 @deepseek-ai/<pkg>」的 node_modules 根）。
 * 顺序即优先级：先显式环境变量，再 PATH 上的 dsh 推导，最后常见全局布局。
 *
 * 为什么这么多候选：hwb 在三种场景下运行 —— 本机 nvm、远端 dgx（自编译、路径不同）、
 * CI（可能完全没有 dsh）。找不到 dsh 不是错误，是「本测试无法判定」，必须优雅降级。
 */
export function candidateDshRoots({ env = process.env, home = os.homedir() } = {}) {
  const roots = [];
  const push = (p) => { if (p && !roots.includes(p)) roots.push(p); };

  // 1) 显式指定（CI / 特殊安装）
  push(env.DSH_INSTALL_ROOT ? path.join(env.DSH_INSTALL_ROOT, 'node_modules') : null);
  push(env.DSH_NODE_MODULES);

  // 2) PATH 上的 dsh binary → 反推安装根
  const fromPath = dshRootFromPath(env.PATH);
  push(fromPath);

  // 3) nvm 下所有 node 版本（本机最常见）。
  //    **优先当前运行的 Node 版本**：多个版本各自装着 dsh 时，`readdir` 的字母序
  //    （v20 在 v22 前）与「用户实际在跑哪个」无关。与生产侧 findDshRoot 保持一致
  //    （否则 doctor 与契约测试会看不同的 dsh —— 由「两份提取器不漂移」那条测试守住）。
  const nvm = path.join(home, '.nvm', 'versions', 'node');
  if (existsSync(nvm)) {
    const versions = safeReaddir(nvm);
    const rest = versions.filter((v) => v !== process.version);
    for (const v of [process.version, ...rest]) {
      if (versions.includes(v)) push(path.join(nvm, v, 'lib', 'node_modules'));
    }
  }

  // 4) 其他常见全局布局
  push(path.join(home, '.local', 'node', 'lib', 'node_modules'));
  push('/usr/local/lib/node_modules');
  push('/usr/lib/node_modules');
  push(path.join(home, '.dsh', 'profiles', 'node_modules'));

  return roots.filter((r) => existsSync(r));
}

/** 从 PATH 里找 `dsh` 可执行文件，反推它所属的 node_modules 根。 */
function dshRootFromPath(PATH = '') {
  for (const dir of String(PATH).split(path.delimiter)) {
    if (!dir) continue;
    const bin = path.join(dir, 'dsh');
    if (!existsSync(bin)) continue;
    try {
      // <root>/bin/dsh → <root>/lib/node_modules
      const real = safeRealpath(bin);
      const root = path.resolve(path.dirname(real), '..');
      const nm = path.join(root, 'lib', 'node_modules');
      if (existsSync(nm)) return nm;
    } catch { /* 继续找下一个 */ }
  }
  return null;
}

function safeReaddir(dir) {
  try { return readdirSync(dir); } catch { return []; }
}

function safeRealpath(p) {
  try { return statSync(p) && require$realpath(p); } catch { return p; }
}

function require$realpath(p) {
  try {
    const require_ = createRequire(import.meta.url);
    return require_('node:fs').realpathSync(p);
  } catch { return p; }
}

/**
 * 找到「某个真正装了 dsh 的 node_modules 根」。
 * 返回 `{ root, dshPkgDir, version }`；找不到返回 `{ root: null, reason }`。
 *
 * 注意 **两种布局**：
 *   · flat（npm -g 本机）：`<root>/@deepseek-ai/dsh/package.json`
 *   · nested（hwb 的远端脚本遇到的）：`<root>/@deepseek-ai/dsh/node_modules/@deepseek-ai/<pkg>`
 * 提取器两种情况都要能走通 —— 这不是假想，`dsh-static-cache` 的 dist 自动探测就同时处理了这两种。
 */
export function locateDsh({ env = process.env, home = os.homedir() } = {}) {
  const tried = [];
  for (const root of candidateDshRoots({ env, home })) {
    tried.push(root);
    const dshPkg = path.join(root, '@deepseek-ai', 'dsh', 'package.json');
    if (!existsSync(dshPkg)) continue;
    let version = null;
    try { version = JSON.parse(readFileSync(dshPkg, 'utf8')).version ?? null; } catch { /* 版本读不到也继续 */ }
    return { root, dshPkgDir: path.dirname(dshPkg), version, tried };
  }
  return { root: null, dshPkgDir: null, version: null, tried, reason: '在候选根里都没找到 @deepseek-ai/dsh/package.json' };
}

/**
 * 在 dsh 安装里定位某个包（兼容 flat / nested 两种布局）。
 * 返回包目录的绝对路径，找不到返回 null。
 */
export function findDshPackage(dshRoot, pkgName) {
  const candidates = [
    path.join(dshRoot, '@deepseek-ai', pkgName),                                  // flat
    path.join(dshRoot, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', pkgName), // nested
  ];
  for (const c of candidates) {
    if (existsSync(path.join(c, 'package.json'))) return c;
  }
  return null;
}

// ---------------------------------------------------------------------------
// defineDomain({...}) 源码提取
// ---------------------------------------------------------------------------

/**
 * 从一段 JS 文本里，切出 `defineDomain(` 后面那个**对象字面量**的原文。
 *
 * 做法：找到 `defineDomain(`，从它后面的 `{` 起做括号配平（同时跳过字符串 / 模板串 /
 * 行注释 / 块注释 —— 否则一个 `'}'` 字符串就能把配平带偏）。返回所有顶层调用的对象文本。
 *
 * 为什么不用正则直接抓字段：对象里有嵌套（`tables: { sessions: domainTable(...) }`、
 * `compatibleVersions: [3,4,5,6]`），正则很容易在嵌套边界上切错；配平是可靠的。
 */
export function extractDefineDomainObjects(source) {
  const out = [];
  const text = String(source ?? '');
  const needle = 'defineDomain(';
  let idx = 0;
  while ((idx = text.indexOf(needle, idx)) !== -1) {
    // 跳过**注释里的** defineDomain：dsh 的源码注释里就出现过示例写法，
    // 若把它当成真规格，会凭空多出一个假域（实测本仓库的注释密度很高，这个坑必须堵）。
    if (isInsideComment(text, idx)) { idx += needle.length; continue; }
    let i = idx + needle.length;
    // 跳过空白，找第一个 '{'
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] !== '{') { idx = i; continue; }
    const start = i;
    const end = matchBrace(text, start);
    if (end === -1) { idx = start + 1; continue; }
    out.push(text.slice(start, end + 1));
    idx = end + 1;
  }
  return out;
}

/**
 * 判断下标 `at` 是否落在行注释 / 块注释 / 字符串里。
 * 做法：从头扫一遍，维护状态机。对 ≤ 数 MB 的 bundle 只做一次线性扫描，代价可忽略。
 */
function isInsideComment(text, at) {
  let inS = null;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < at; i++) {
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
  }
  return inLine || inBlock || inS !== null;
}

/** 从 `open`（必须是 '{'）开始做括号配平，返回对应 '}' 的下标；失败返回 -1。 */function matchBrace(text, open) {
  let depth = 0;
  let i = open;
  let inS = null;      // 当前字符串引号
  let inLine = false;
  let inBlock = false;
  for (; i < text.length; i++) {
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
    if (c === '{' || c === '[' || c === '(') { depth++; continue; }
    if (c === '}' || c === ']' || c === ')') {
      depth--;
      if (depth === 0 && c === '}') return i;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

/**
 * 从对象字面量文本里解出**纯字面量**字段。
 * 只认这几类值（它们是 defineDomain 规格里唯一需要的）：
 *   · 字符串：`name: "session_projcache"` / `'x'`
 *   · 数字：`version: 7`
 *   · 布尔：`invalidRecords` 之类不会出现，但 layout 可能被显式写
 *   · 数字数组：`compatibleVersions: [3, 4, 5, 6]`
 *   · 嵌套对象（浅层）：`tables: { sessions: domainTable(checkpointRecord) }` → 取 key 名
 *
 * **不 eval**：先用顶层逗号切分（同样做括号配平），再逐项正则。任何解不出的字段留 undefined，
 * 由调用方按「未知」处理 —— 宁可报未知，也不猜。
 */
export function parseSpecLiteral(objectText) {
  const spec = {};
  const body = stripOuterBraces(objectText);

  for (const [key, valueText] of topLevelEntries(body)) {
    switch (key) {
      case 'name': {
        const s = stringLiteral(valueText);
        if (s !== undefined) spec.name = s;
        break;
      }
      case 'version': {
        const n = numberLiteral(valueText);
        if (n !== undefined) spec.version = n;
        break;
      }
      case 'compatibleVersions': {
        const arr = numberArrayLiteral(valueText);
        if (arr !== undefined) spec.compatibleVersions = arr;
        break;
      }
      case 'layout': {
        const s = stringLiteral(valueText);
        if (s !== undefined) spec.layout = s;
        else if (/undefined/.test(valueText)) spec.layout = undefined;
        break;
      }
      case 'invalidRecords': {
        const s = stringLiteral(valueText);
        if (s !== undefined) spec.invalidRecords = s;
        break;
      }
      case 'tables': {
        const t = objectKeys(stripOuterBraces(valueText));
        if (t.length) spec.tables = t;
        break;
      }
      case 'global': {
        spec.hasGlobal = /schema\s*:/.test(valueText);
        const ids = valueText.match(/workspaceIds/);
        if (ids) spec.globalKeysHint = ['workspaceIds'];
        break;
      }
      default:
        break;
    }
  }
  return spec;
}

function stripOuterBraces(t) {
  const s = String(t ?? '').trim();
  if (s.startsWith('{') && s.endsWith('}')) return s.slice(1, -1);
  return s;
}

/** 顶层（深度 1）的 `key: value` 切分。 */
function topLevelEntries(body) {
  const entries = [];
  let depth = 0;
  let inS = null;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    const next = body[i + 1];
    if (inS) {
      if (c === '\\') { i++; continue; }
      if (c === inS) inS = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inS = c; continue; }
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') depth--;
    else if (c === ',' && depth === 0) {
      pushEntry(entries, body.slice(start, i));
      start = i + 1;
    }
  }
  pushEntry(entries, body.slice(start));
  return entries;
}

function pushEntry(entries, chunk) {
  const m = /^\s*([A-Za-z_$][\w$]*)\s*:\s*([\s\S]*)$/.exec(chunk);
  if (m) entries.push([m[1], m[2].trim()]);
}

function stringLiteral(t) {
  const m = /^\s*(['"`])((?:\\.|(?!\1)[\s\S])*)\1\s*$/.exec(String(t ?? ''));
  return m ? m[2] : undefined;
}

function numberLiteral(t) {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*$/.exec(String(t ?? ''));
  return m ? Number(m[1]) : undefined;
}

function numberArrayLiteral(t) {
  const s = String(t ?? '').trim();
  if (!s.startsWith('[') || !s.endsWith(']')) return undefined;
  const parts = s.slice(1, -1).split(',').map((x) => x.trim()).filter(Boolean);
  const nums = [];
  for (const p of parts) {
    if (p === '...' || /\.\.\./.test(p)) return undefined;   // 展开运算符：无法静态解出
    if (!/^-?\d+$/.test(p)) return undefined;
    nums.push(Number(p));
  }
  return nums;
}

function objectKeys(t) {
  const keys = [];
  for (const [k] of topLevelEntries(t)) keys.push(k);
  return keys;
}

// ---------------------------------------------------------------------------
// 具体域的提取（把上面两步串起来）
// ---------------------------------------------------------------------------

/**
 * 从某个域包（如 `dsh-session-projection-cache`）里提取 defineDomain 规格。
 * 会**取所有**提取到的对象，按 `name` 匹配目标域；匹配不到再退回「只有一个就取它」。
 * 返回 `{ found, spec, source, file }`。
 */
export function extractDomainSpec(dshRoot, pkgName, wantedName = null) {
  const dir = findDshPackage(dshRoot, pkgName);
  if (!dir) return { found: false, reason: `找不到包 ${pkgName}`, file: null };

  // 域定义可能在 lib/index.js、lib/types/spec.js、lib/invariant.js 等多处（实测 rc.1 就重复了三处），
  // 也可能被挪到别的文件名（`lib/spec.js` 等）。先试常见名，**再把 lib 下所有 .js 都带上** ——
  // 只试固定几个名字的话，dsh 一重构就退化成「提取失败」，契约测试会静默失去覆盖。
  const files = [];
  const libDir = path.join(dir, 'lib');
  const preferred = ['index.js', 'types/spec.js', 'invariant.js', 'types/index.js', 'spec.js']
    .map((rel) => path.join(libDir, rel))
    .filter((f) => existsSync(f));
  const prefSet = new Set(preferred);
  const rest = safeReaddir(libDir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => path.join(libDir, f))
    .filter((f) => !prefSet.has(f));
  files.push(...preferred, ...rest);

  const all = [];
  for (const f of files) {
    let src;
    try { src = readFileSync(f, 'utf8'); } catch { continue; }
    for (const objText of extractDefineDomainObjects(src)) {
      const spec = parseSpecLiteral(objText);
      if (spec.name) all.push({ spec, file: f });
    }
  }

  if (!all.length) return { found: false, reason: `在 ${pkgName} 里没提取到带 name 的 defineDomain 规格`, file: null };

  if (wantedName) {
    const hit = all.find((a) => a.spec.name === wantedName);
    if (hit) return { found: true, spec: hit.spec, file: hit.file, all };
    return { found: false, reason: `提取得到了 ${all.map((a) => a.spec.name).join('/')}，但没有 ${wantedName}`, file: null, all };
  }
  return { found: true, spec: all[0].spec, file: all[0].file, all };
}

/**
 * 提取全部已知域。返回：
 *   {
 *     available: bool,          // 是否成功定位到 dsh 安装
 *     dshVersion, root,
 *     domains: { workspace: {...}, projcache: {...} },
 *   }
 * 每个域形如 `{ found, spec, file }`；`found:false` 表示「提取不到」= 无法判定（**不**等于通过）。
 */
export function extractAllDomains({ env = process.env, home = os.homedir() } = {}) {
  const loc = locateDsh({ env, home });
  if (!loc.root) return { available: false, reason: loc.reason, tried: loc.tried, dshVersion: null, root: null, domains: {} };

  const domains = {
    // 域包名 → 期望的域 name。包名/域名都是 dsh 的公开事实，提取结果会反向校验。
    workspace: { pkg: 'dsh-workspace', name: 'workspace' },
    projcache: { pkg: 'dsh-session-projection-cache', name: 'session_projcache' },
  };

  const out = {};
  for (const [key, { pkg, name }] of Object.entries(domains)) {
    out[key] = extractDomainSpec(loc.root, pkg, name);
  }
  return { available: true, root: loc.root, dshVersion: loc.version, domains: out };
}

// ---------------------------------------------------------------------------
// CLI 契约（--version 输出、web 子命令、启动 URL 打印格式）
// ---------------------------------------------------------------------------

/** 读 dsh 的 `dsh web` 启动打印逻辑，确认 `dsh web: <url>?token=` 这条契约还在。
 *  返回 `{ found, marker, tokenQuery, printUrlDefault, file }`。 */
export function extractCliContract(dshRoot) {
  const dir = findDshPackage(dshRoot, 'dsh-web-app');
  if (!dir) return { found: false, reason: '找不到 dsh-web-app' };
  const idx = path.join(dir, 'lib', 'index.js');
  if (!existsSync(idx)) return { found: false, reason: '找不到 dsh-web-app/lib/index.js' };
  const src = readFileSync(idx, 'utf8');

  // 启动打印行：`dsh web: ${authenticatedUrl}...`
  const marker = /`(dsh web: )\$\{/.exec(src);
  // printUrl 默认值（决定「不打印」是否成为默认行为 —— 那会让 hwb 抓不到 token）
  const printUrl = /printUrl\s*:\s*z\.boolean\(\)\.default\((true|false)\)/.exec(src)
    ?? /printUrl[\s\S]{0,40}default\((true|false)\)/.exec(src);

  // token query 名来自 dsh-client-connection
  const connDir = findDshPackage(dshRoot, 'dsh-client-connection');
  let tokenQuery = null;
  let handshake = null;
  if (connDir) {
    const ci = path.join(connDir, 'lib', 'index.js');
    if (existsSync(ci)) {
      const cs = readFileSync(ci, 'utf8');
      tokenQuery = /TOKEN_QUERY\s*=\s*["']([^"']+)["']/.exec(cs)?.[1] ?? null;
      handshake = /searchParams\.set\(\s*TOKEN_QUERY/.test(cs) ? 'searchParams' : null;
    }
  }

  return {
    found: Boolean(marker),
    marker: marker ? marker[1] : null,
    printUrlDefault: printUrl ? printUrl[1] === 'true' : null,
    tokenQuery,
    handshake,
    file: idx,
  };
}

/** `dsh --version` 的真实输出，以及 `web --no-open --port` 是否被接受。
 *  只在显式调用时执行（进程开销）—— 默认测试走源码提取。 */
export function probeDshVersionCli({ timeoutMs = 20_000 } = {}) {
  try {
    const out = execFileSync('dsh', ['--version'], { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, version: out.trim() };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

export const __internals = { matchBrace, topLevelEntries, stripOuterBraces };

// ---------------------------------------------------------------------------
// 域发现：找出 dsh 里**全部**已声明的存储域（不止 hwb 已知的两个）
// ---------------------------------------------------------------------------

/**
 * 扫描 dsh 安装里所有 `defineDomain({...})` 调用，返回去重后的域清单。
 *
 * 为什么需要：hwb 只认 `workspace` 与 `session_projcache`。若 dsh 新版**新增**一个
 * 有价值的域（例如把用量从 projcache 里拆出去），hwb 不会报错、只是静静地少读一块数据。
 * 这条发现能力让测试能给出「dsh 现在有这些域，其中这些 hwb 还不认识」的结论。
 *
 * 返回 `[{ name, version, compatibleVersions, layout, file }]`（按 name 排序，同名取首个）。
 */
export function discoverDomains({ env = process.env, home = os.homedir() } = {}) {
  const loc = locateDsh({ env, home });
  if (!loc.root) return { available: false, reason: loc.reason, domains: [] };

  // 遍历 @deepseek-ai/* 下的包（只扫 lib/index.js，域定义都在那里；兼容 flat/nested）。
  const roots = [
    path.join(loc.root, '@deepseek-ai'),
    path.join(loc.root, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'),
  ];
  const seen = new Map();
  for (const r of roots) {
    if (!existsSync(r)) continue;
    for (const pkg of safeReaddir(r)) {
      const f = path.join(r, pkg, 'lib', 'index.js');
      if (!existsSync(f)) continue;
      let src;
      try { src = readFileSync(f, 'utf8'); } catch { continue; }
      if (!src.includes('defineDomain(')) continue;
      for (const objText of extractDefineDomainObjects(src)) {
        const spec = parseSpecLiteral(objText);
        if (!spec.name || seen.has(spec.name)) continue;
        seen.set(spec.name, { ...spec, file: f });
      }
    }
  }
  return { available: true, root: loc.root, domains: [...seen.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}
