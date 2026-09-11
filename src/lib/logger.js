// —— hwb 结构化日志（零依赖） ——
//
// 设计目标（对应"出错时提供对应信息方便排查"）：
//   · 分级（debug/info/warn/error/fatal）+ 时间戳 + 作用域（component），一眼区分严重程度与被调用方；
//   · 结构化上下文（context，如 homeId/host/port/stderr），出错时把根因字段一并带上；
//   · Error 对象自动打印完整 stack（不只 message），进程崩溃也能定位到源码位置；
//   · 可选落盘（~/.hwb/hwb.log，按体积轮转保留 .1/.2 两代），无需盯终端即可查历史；
//   · 进程级 crash handler（uncaughtException/unhandledRejection）在此统一记录，避免静默吞掉异常。
//
// 用法：
//   import { logger } from './logger.js';
//   const log = logger('launcher');            // 每个模块一个作用域
//   log.info('opened', { homeId, url });        // 普通消息 + 上下文
//   log.error('launch failed', { homeId, stderr });   // 上下文排查
//   log.error('launch failed', err, { homeId });      // 带 Error（打印 stack）
//   log.warn('guard rejected kill', { homeId, pid }); // 警告
//
// 输出路由：debug/info → stdout，warn/error/fatal → stderr。级别标签按分级着色（仅 TTY，
// 文件/非 TTY 不染色）。全局仅一次生效：server.js 启动时调用 initLogger({ level, file, silent }) 配置。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const LEVELS = { trace: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5 };
export const DEFAULT_LEVEL = 'info';
const DEFAULT_ROTATE_BYTES = 1_048_576;  // 单个日志文件超过 1MiB 触发轮转
const KEEP_ROTATED = 2;          // 保留 .1/.2 两代备份
const MAX_RING = 500;            // 内存日志环缓冲：供 /api/logs 与 SSE 实时推送
const SEED_LINES = 1200;         // 启动时从日志文件尾部回填的最大行数（含续行）

const ANSI = {
  gray: '\x1b[90m', blue: '\x1b[34m', green: '\x1b[32m',
  yellow: '\x1b[33m', red: '\x1b[31m', magenta: '\x1b[35m', reset: '\x1b[0m',
};
const LEVEL_COLOR = { trace: 'gray', debug: 'blue', info: 'green', warn: 'yellow', error: 'red', fatal: 'magenta' };

let config = {
  level: DEFAULT_LEVEL,
  file: null,       // 日志文件路径；null=不落盘
  silent: false,    // true=完全静默 console（仅落盘），供 --silent
  color: Boolean(process.stdout.isTTY),
  rotateBytes: DEFAULT_ROTATE_BYTES,
};

let fileFd = null;        // 惰性打开的追加 fd
let fileErrorLogged = false; // 记录一次文件写失败，避免刷屏

// 内存日志环缓冲 + 监听器：供「日志区域」读取历史（/api/logs）与实时推送（SSE log:event）。
const ring = [];              // [{ ts, level, scope, message, fields?, error?, stack? }]
const logListeners = new Set(); // (entry) => void

// —— 全局配置（幂等，仅首次生效；重复调用只会更新已提供的字段） ——
export function initLogger(cfg = {}) {
  const prevFile = config.file;
  if (cfg.level !== undefined) config.level = validateLevel(cfg.level);
  if (cfg.file !== undefined) config.file = cfg.file === false ? null : (cfg.file ?? null);
  if (cfg.silent !== undefined) config.silent = Boolean(cfg.silent);
  if (cfg.color !== undefined) config.color = Boolean(cfg.color);
  if (cfg.rotateBytes !== undefined && cfg.rotateBytes > 0) config.rotateBytes = cfg.rotateBytes;
  if (cfg.openRetryMs !== undefined && cfg.openRetryMs >= 0) openRetryMs = cfg.openRetryMs;
  // 切换日志文件时关闭旧 fd，避免句柄泄漏/写错文件（生产只 init 一次；测试会多次切换）。
  if (config.file !== prevFile) closeFile();
  if (config.file) openFile();
  // 用日志文件尾部回填环缓冲，让「日志区域」打开即有历史（而非仅本次进程启动后）。
  if (config.file && prevFile !== config.file && ring.length === 0) seedRingFromFile();
  return config;
}

// 订阅实时日志条目（返回退订函数）。用于把每条日志推送到 SSE。
export function onLog(listener) {
  logListeners.add(listener);
  return () => logListeners.delete(listener);
}

// 读取环缓冲里的日志（可按最低级别过滤，取最近 limit 条）。
export function getLogs({ level, limit = 100 } = {}) {
  const out = level
    ? ring.filter((e) => (LEVELS[e.level] ?? levelVal('info')) >= levelVal(level))
    : [...ring];
  return out.slice(-Math.max(0, limit));
}

// 清空环缓冲。
export function clearLogs() { ring.length = 0; }

export function setLevel(level) { config.level = validateLevel(level); return config.level; }
export function getLevel() { return config.level; }

// 人类可读级别 → 数值等级（供比较阈值/测试）。
export function levelVal(level) { return LEVELS[level] ?? LEVELS[DEFAULT_LEVEL]; }

export function defaultLogFile() {
  return path.join(os.homedir(), '.hwb', 'hwb.log');
}

// —— 工厂：为某作用域返回带分级方法的 logger ——
export function logger(scope = 'root') {
  const mk = (level) => (message, errOrContext, maybeContext) => {
    const { message: msg, err, fields } = normalize(message, errOrContext, maybeContext);
    emit(level, scope, msg, err, fields);
  };
  return {
    trace: mk('trace'),
    debug: mk('debug'),
    info: mk('info'),
    warn: mk('warn'),
    error: mk('error'),
    fatal: mk('fatal'),
  };
}

// 统一一次进程崩溃 / 未处理拒绝的记录入口（server.js 在启动时调用）。
// 返回一个已安装 handlers 的清理函数（便于测试隔离）。
export function installCrashHandlers({ process: proc = process } = {}) {
  const onUncaught = (err) => {
    logger('process').fatal('uncaughtException', err, { pid: proc.pid });
    // 兜底：fatal 已尽力把内容写入文件与 stderr；无 crash handler 时 Node 默认打印后退出(1)，
    // 此处注入相同语义并触发 'exit' 事件（Launcher 会在其中杀掉所有 dsh web 子进程），避免半死状态。
    try { closeFile(); } catch { /* 兜底无更多可做 */ }
    try { if (proc.exit) proc.exit(1); } catch { /* 兜底无更多可做 */ }
  };
  const onUnhandled = (reason) => {
    logger('process').fatal('unhandledRejection', reason instanceof Error ? reason : new Error(String(reason)),
      { pid: proc.pid });
  };
  proc.on('uncaughtException', onUncaught);
  proc.on('unhandledRejection', onUnhandled);
  return () => {
    proc.off('uncaughtException', onUncaught);
    proc.off('unhandledRejection', onUnhandled);
  };
}

// —— 内部 ——
function validateLevel(level) {
  if (typeof level === 'number') return LEVELS[Object.keys(LEVELS).find((k) => LEVELS[k] === level)] ?? DEFAULT_LEVEL;
  return LEVELS[level] !== undefined ? level : DEFAULT_LEVEL;
}

// 归一 (message, errOrContext, maybeContext) 三种调用形态：
//   (msg)                     → 无 err，无 context
//   (msg, {..})               → context
//   (msg, Error)              → err
//   (msg, Error, {..})        → err + context
//   (msg, {.., err: Error})   → context 中含 err → 提取到顶层
function normalize(message, errOrContext, maybeContext) {
  let err = null;
  let fields = {};
  if (errOrContext instanceof Error) {
    err = errOrContext;
    fields = maybeContext ?? {};
  } else if (errOrContext !== undefined && errOrContext !== null) {
    fields = errOrContext;
  }
  if (typeof fields === 'object' && fields.err instanceof Error) {
    err = fields.err;
    fields = { ...fields };
    delete fields.err;
  }
  return { message, err, fields };
}

function emit(level, scope, message, err, fields) {
  if (LEVELS[level] < LEVELS[config.level]) return; // 低于阈值 → 丢弃（console 与 file 都拦）
  // 对**最终字符串**再脱敏一次：这是最强的一道防线，token 无论是从 fields、message
  // 还是 err 拼进来的，都不可能出现在落盘/console 的内容里。
  const line = redactSecrets(formatLine(level, scope, message, err, fields));
  writeConsole(level, line);
  writeFileLine(line);
  pushRing(makeEntry(level, scope, message, err, fields));
}

// 构造结构化日志条目（供内存环缓冲 + SSE 推送到「日志区域」）。
// dsh 的启动 URL 形如 `http://127.0.0.1:<port>/?token=<launchToken>`，持有它等于持有该实例的
// 完整控制权（dsh web 的工具能执行 shell、写文件）。而这个 URL 会被 monitor / launcher 直接写进
// 日志字段，日志又要落盘（~/.hwb/hwb.log）并经 SSE 推到浏览器 —— 所以 token 必须在**写入通道之前**
// 就抹掉，而不是指望调用方记得别传。这里做统一的最后一道防线。
//
// 只匹配「token 的值」而不动其它内容：`?token=xxx`、`&token=xxx`、`token=xxx`、
// `"token": "xxx"`（safeJson 之后的形态）都要覆盖，值字符集与 captureDshToken 对齐。
const TOKEN_PATTERN = /((?:[?&\s"']|^)?token(?:=|"\s*:\s*")[\s]*)([A-Za-z0-9_-]+)/gi;

export function redactSecrets(value) {
  return String(value ?? '').replace(TOKEN_PATTERN, (m, prefix) => `${prefix}[已脱敏]`);
}

function redactFields(fields) {
  if (!fields || typeof fields !== 'object') return fields;
  let changed = false;
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    const redacted = redactValue(v);
    if (redacted !== v) changed = true;
    out[k] = redacted;
  }
  return changed ? out : fields;
}

function redactValue(v) {
  if (typeof v === 'string') return redactSecrets(v);
  if (Array.isArray(v)) {
    let changed = false;
    const out = v.map((x) => { const r = redactValue(x); if (r !== x) changed = true; return r; });
    return changed ? out : v;
  }
  if (v && typeof v === 'object') {
    let changed = false;
    const out = {};
    for (const [k, x] of Object.entries(v)) { const r = redactValue(x); if (r !== x) changed = true; out[k] = r; }
    return changed ? out : v;
  }
  return v;
}

function makeEntry(level, scope, message, err, fields) {
  const entry = {
    ts: timestamp(),
    level,
    scope,
    message: redactSecrets(message),
  };
  const safeFields = redactFields(fields);
  if (safeFields && Object.keys(safeFields).length) entry.fields = safeFields;
  if (err != null) {
    entry.error = redactSecrets(err instanceof Error ? err.message : String(err));
    entry.stack = err instanceof Error && err.stack ? redactSecrets(err.stack) : null;
  }
  return entry;
}

function pushRing(entry) {
  ring.push(entry);
  if (ring.length > MAX_RING) ring.splice(0, ring.length - MAX_RING);
  for (const listener of logListeners) {
    try { listener(entry); } catch { /* 单个监听器异常不影响日志主流程 */ }
  }
}

function pad(level) { return level.toUpperCase().padEnd(5); }

function formatLine(level, scope, message, err, fields) {
  fields = redactFields(fields);
  const ts = timestamp();
  const tag = config.color
    ? `${ANSI[LEVEL_COLOR[level] ?? 'gray']}${pad(level)}${ANSI.reset}`
    : pad(level);
  let out = `[${ts}] ${tag}`;
  if (scope) out += ` [${scope}]`;
  out += ` ${message}`;
  const serialized = serializeFields(fields);
  out += serialized;
  if (err) out += `\n${formatErr(err)}`;
  return out;
}

function timestamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

// 序列化上下文：普通值 → JSON；多行字符串（如 stderr/stdout/cmd）→ 缩进块，便于人读。
function serializeFields(fields) {
  const keys = Object.keys(fields ?? {});
  if (!keys.length) return '';
  let out = '';
  for (const k of keys) {
    const v = fields[k];
    if (Array.isArray(v)) { out += `\n  ${k}=` + v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' | '); continue; }
    if (typeof v === 'string' && v.includes('\n')) {
      out += `\n  ${k}=` + v.split('\n').map((l) => `\n    ${l}`).join('');
      continue;
    }
    if (typeof v === 'object' && v !== null) {
      out += `\n  ${k}=` + safeJson(v);
      continue;
    }
    out += `\n  ${k}=${v === undefined ? 'undefined' : v}`;
  }
  return out;
}

function safeJson(v) {
  try { return JSON.stringify(v); } catch (e) { return String(v); }
}

function formatErr(err) {
  if (err instanceof Error) {
    const name = err.name || 'Error';
    const stack = err.stack || '';
    return `${name}: ${err.message}${stack ? `\n${stack}` : ''}`;
  }
  return String(err);
}

function writeConsole(level, line) {
  if (config.silent) return;
  if (LEVELS[level] >= LEVELS.warn) console.error(line);
  else console.log(line);
}

// —— 文件 sink（惰性打开的追加 fd + 按体积轮转） ——
function openFile() {
  if (!config.file || fileFd !== null) return;
  try {
    // 0700/0600：日志里有本地路径、会话标题等，且这是每个用户自己的私有状态目录。
    // 原先 openSync 不带 mode → 0666 & ~umask = 0644（实测 ~/.hwb/hwb.log 就是 -rw-r--r--），
    // 同机其它用户可读。已存在的旧文件也要纠正权限，否则升级后仍是 0644。
    fs.mkdirSync(path.dirname(config.file), { recursive: true, mode: 0o700 });
    fileFd = fs.openSync(config.file, 'a', 0o600);
    try { fs.fchmodSync(fileFd, 0o600); } catch { /* 某些文件系统不支持，忽略 */ }
  } catch (e) {
    reportFileError(e);
  }
}

// 打开失败后的重试节流：openFile() 原先只在 initLogger 与 rotate() 里被调用，而 rotate()
// 又只在 writeFileLine() 里可达 —— 后者在 fileFd === null 时直接 return。也就是说一次
// **瞬时**失败（EACCES/ENOSPC、日志目录被临时改名）之后，文件日志会在整个进程生命周期里
// 静默停掉，只留 console 里一行提示；而 help 文案恰恰叫用户去看那个文件。
const OPEN_RETRY_MS = 30_000;
let openRetryMs = OPEN_RETRY_MS;   // 可被 initLogger 覆盖（测试用）
let nextOpenAttemptAt = 0;

function closeFile() {
  if (fileFd !== null) {
    try { fs.closeSync(fileFd); } catch { /* already closed */ }
    fileFd = null;
  }
}

function writeFileLine(line) {
  // fileFd 为空时按节流重试打开（而不是永久放弃）。打开失败本身不写日志（会递归），
  // 由 reportFileError 在 console 上提示一次。
  if (fileFd === null) {
    const now = Date.now();
    if (now < nextOpenAttemptAt) return;
    nextOpenAttemptAt = now + openRetryMs;
    openFile();
    if (fileFd === null) return;
  }
  try {
    // 写前检查体积（同步 stat 开销可忽略：日志量级低）。
    const st = fs.fstatSync(fileFd);
    if (st.size > config.rotateBytes) rotate();
    fs.writeSync(fileFd, `${line}\n`);
    fileErrorLogged = false;
  } catch (e) {
    reportFileError(e);
  }
}

function rotate() {
  closeFile();
  const f = config.file;
  // 丢弃最旧一代（.KEEP_ROTATED），再把备份整体右移一位：.1 -> .2（若有），当前文件 -> .1。
  // 注意当前活文件是 f（索引 0），不是 f.0——之前误把 f.0 当成活文件导致永不轮转。
  try { if (fs.existsSync(`${f}.${KEEP_ROTATED}`)) fs.rmSync(`${f}.${KEEP_ROTATED}`, { force: true }); } catch { /* best-effort */ }
  try { if (fs.existsSync(`${f}.1`)) fs.renameSync(`${f}.1`, `${f}.2`); } catch { /* best-effort */ }
  try { fs.renameSync(f, `${f}.1`); } catch { /* best-effort */ }
  openFile();
}

function reportFileError(e) {
  if (fileErrorLogged) return;
  fileErrorLogged = true;
  console.error(`[logger] 日志文件写入失败: ${e.message}`);
}

// —— 启动回填：用日志文件尾部填充环缓冲，让「日志区域」打开即有历史 ——
// 只读本进程格式化写的行（`[ts] LEVEL [scope] msg`），缩进续行（fields/stack）并入上一条 message。
// 尽力而为：解析不了的行直接丢弃或并入，绝不抛错影响启动。
const ENTRY_RE = /^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3})\] (TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\s+\[([^\]]+)\] (.*)$/;
function seedRingFromFile() {
  let raw = '';
  try {
    raw = fs.readFileSync(config.file, 'utf8');
  } catch {
    return;
  }
  const lines = raw.split('\n').slice(-SEED_LINES);
  let cur = null;
  const entries = [];
  for (const rawLine of lines) {
    const line = rawLine.replace(/\x1b\[[0-9;]*m/g, ''); // 去 ANSI
    if (!line.trim()) continue;
    const m = line.match(ENTRY_RE);
    if (m) {
      if (cur) entries.push(cur);
      cur = { ts: m[1], level: m[2].toLowerCase(), scope: m[3], message: m[4] };
    } else if (cur) {
      cur.message += `\n${line}`;
    }
  }
  if (cur) entries.push(cur);
  for (const e of entries) pushRing(e);
}
