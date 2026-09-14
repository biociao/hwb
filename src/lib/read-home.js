import { readFileSync, existsSync, lstatSync, fstatSync, openSync, closeSync, readdirSync, constants as fsConstants } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  validateWorkspaceJson,
  validateProjcacheJson,
  validateProjcacheRecord,
  validateModelTierJson,
  validateCredentials,
} from './schema.js';

const PROVIDER_ALIASES = {
  kimi_code: 'kimi',
  minimax_cn: 'minimax',
};

// dsh 存储路径的**唯一事实来源**。
//
// 这些路径以前在多个文件里各写一份（本地 reader / 远程 cat 脚本 / 域校验错误消息），
// 而它们必须**始终一致** —— 远程脚本少抓一个目录，远程实例就少一块数据，且不会报错
// （实测就是这么漏掉 62% 会话的）。现在集中在这里，改一处即可；
// 与 dsh 实际布局是否一致由 tests/compat 的契约测试保证。
export const STORAGE_PATHS = {
  workspace: 'storages/workspace.json',
  /** 遗留的**单文件聚合** projcache（旧版 dsh 布局；新版只在首次发现时用来 bootstrap）。 */
  projcacheAggregate: 'storages/session_projcache.json',
  /** 当前布局：每个会话一个文件（dsh 的 `layout: 'per-record'`）。 */
  projcachePerRecordDir: 'storages/session_projcache/sessions',
  modelTier: 'model-tier.json',
  credentials: '.credentials.yaml',
};

/** 固定要读的元数据文件（顺序即远程 cat 顺序）。缺失 = 可选，不判 degraded。 */
export const METADATA_FILES = [
  STORAGE_PATHS.workspace,
  STORAGE_PATHS.projcacheAggregate,
  STORAGE_PATHS.modelTier,
  STORAGE_PATHS.credentials,
];

export function homeIdOf(homePath) {
  return createHash('sha256').update(homePath).digest('hex').slice(0, 16);
}

// Minimal YAML parser: flat "KEY: value" lines plus the real dsh layout,
// where keys live indented under a top-level "refs:" block. Values are
// discarded except for emptiness — we only extract provider names (§4.1).
export function parseCredentialsYaml(text) {
  const providers = [];
  const seen = new Set(); // 按 ref 去重（见下）
  let inRefs = false;
  // 去掉 UTF-8 BOM：`\s` 在 JS 里匹配 U+FEFF，于是带 BOM 的 `\uFEFFrefs:` 会走 else 分支、
  // inRefs 永远为 false，缩进的所有 key 全被跳过 —— 一个被 BOM-adding 编辑器重存过的
  // 凭据文件会表现为「这个 home 没有任何 provider」。必须在切行之前剥掉。
  for (const raw of String(text ?? '').replace(/^\uFEFF/, '').split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      inRefs = /^refs\s*:\s*$/.test(raw.trim());
      if (inRefs) continue;
    } else if (!inRefs) {
      continue;
    }
    const m = raw.trim().match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const [, ref, value] = m;
    if (!ref.endsWith('_API_KEY')) continue;
    if (!value || value.startsWith('#')) continue;
    const base = ref.slice(0, -'_API_KEY'.length).toLowerCase();
    // **按 ref 去重**：providers 表是 UNIQUE(homeId, ref)，而且插入用的是普通 INSERT。
    // 一个被手工追加/编辑器重排过的凭据文件里出现两行同名 key，就会让整个 upsertRows 事务
    // 撞 UNIQUE 约束并回滚 —— 该实例的会话/工作区一行都提交不了，状态永久 degraded，
    // 每 60s 重试一次同样失败。这里取**最后一条**（与 readCredentials 的 Map 语义一致）。
    if (seen.has(ref)) {
      const at = providers.findIndex((p) => p.ref === ref);
      providers[at] = { ref, provider: PROVIDER_ALIASES[base] ?? base };
      continue;
    }
    seen.add(ref);
    providers.push({ ref, provider: PROVIDER_ALIASES[base] ?? base });
  }
  return providers;
}

// dsh 存储文件的统一读取抽象：本地用 fs（readHome），远程用 SSH cat（remote-reader）。
// `readText(relPath)` 返回文件文本（缺失时抛错，对应本地 ENOENT）；`exists(relPath)` 判断可选文件是否在。
// `listDir(relPath)`（可选）列出目录下**文件名**（不含路径），目录不存在返回 null ——
// 供 per-record 布局读取用（见 readProjcache 的说明）。缺失时该能力整体降级为「只认聚合文件」。
// 它们共同决定哪个域的 degraded 判定与本地逐文件读取行为完全一致（§4.2/4.3）。
export function buildSnapshot({ homePath, readText, exists, listDir = null }) {
  const degraded = [];
  const snapshot = {
    homeId: homeIdOf(homePath),
    homePath,
    generatedAt: new Date().toISOString(),
    wsVersion: null,
    pcVersion: null,
    // 实际用到了哪些 projcache 布局。这是**诊断用的关键字段**：本次「漏 62% 会话」的事故里，
    // 磁盘上是 per-record、hwb 只读了聚合文件，而快照里没有任何字段能反映这件事
    // （聚合文件合法，所以没有 degraded）。记下来之后，「只读到 perRecord:0」本身
    // 就是一个可断言、可展示的信号。
    //   { perRecord: <文件数>, aggregate: <是否用聚合补齐过>, versions: { <版本>: <条数> } }
    pcLayout: { perRecord: 0, aggregate: false, versions: Object.create(null) },
    workspaces: [],
    sessions: [],
    modelTier: null,
    providers: [],
    degraded,
  };
  // JSON.parse 的错误消息会**带上文件开头的原始字节**（V8 的 "Unexpected token 'o', \"not json…\""），
  // 而这条消息会被存进 homes.degraded、经 SSE 广播、并渲染到实例卡上 —— 也就是说
  // 任意被指向的文件的前几十个字节会泄漏到工作台界面（例如一个指向 /etc/passwd 的符号链接）。
  // 解析失败只需要说「不是合法 JSON」，细节留在服务端日志里。
  const readJson = (rel) => {
    const text = readText(rel);
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error(`${rel}: 不是合法的 JSON`);
    }
  };

  try {
    const v = validateWorkspaceJson(readJson(STORAGE_PATHS.workspace));
    if (v.ok) {
      snapshot.wsVersion = v.version;
      snapshot.workspaces = v.workspaces;
    } else {
      degraded.push({ domain: 'workspace', error: v.error, degraded: true });
    }
  } catch (e) {
    degraded.push({ domain: 'workspace', error: e.message, degraded: true });
  }

  // —— projcache：dsh 有两种磁盘布局，必须都认（否则静默漏数据）——
  //
  // dsh 的 session_projcache 域声明 `layout: 'per-record'`（实测 0.1.5-rc.1）：
  //   · **per-record**（当前）：`storages/session_projcache/sessions/<key>.json`，每会话一个文件，
  //     信封是 `{ version: N, record: { identity, rows } }`；dsh **持续写**这些文件。
  //   · **single/聚合**（遗留）：`storages/session_projcache.json`，信封是
  //     `{ unit: { name, version }, global, tables }`；dsh 只在**首次发现**它且版本可接受时
  //     用它做一次 bootstrap，之后**不再更新**（实测本机该文件冻结在旧日期，而 per-record
  //     目录每天在写）。
  //
  // 原先只读聚合文件 → 真实 home 上 476 个会话只看到 179 个（漏 62%），而且没有任何 degraded 提示
  // （聚合文件本身合法，只是过期）。因此这里**以 per-record 为准**、聚合为补充：
  //   ① per-record 目录存在 → 逐个读，得到权威的活跃集合；
  //   ② 再用聚合里的会话补齐 per-record 尚未覆盖的（bootstrap 期的老会话）；
  //   ③ 同 id 冲突时以 per-record 为准（它更新）。
  // 两者都拿不到才算「该域无数据」（此时 aggregates 为空 → 沿用既有的 degraded 语义）。
  const projSessions = new Map();   // sessionId -> session（per-record 优先）
  let pcVersion = null;
  let pcErrors = [];                // per-record 读取中的错误（用于诊断，不直接判 degraded）

  // ① per-record
  const perRecDir = STORAGE_PATHS.projcachePerRecordDir;
  const perRecFiles = listDir ? listDir(perRecDir) : null;
  if (Array.isArray(perRecFiles) && perRecFiles.length) {
    // 只取 .json（dsh 的 invalidRecords:'backup-and-skip' 会把坏记录挪成
    // `<key>.json.bak.<stamp>`，那些不该被当成会话读）。
    for (const name of perRecFiles) {
      if (!name.endsWith('.json')) continue;
      const rel = `${perRecDir}/${name}`;
      let doc;
      try {
        doc = readJson(rel);
      } catch (e) {
        pcErrors.push(`${rel}: ${e.message}`);
        continue;
      }
      const v = validateProjcacheRecord(doc, rel);
      if (!v.ok) {
        pcErrors.push(v.error);
        continue;
      }
      // 版本：记**最高**版本作为该域的 pcVersion（而不是「第一个读到的」—— 那取决于
      // readdir 顺序，同一个 home 两次跑可能给出不同答案，是个假信号）。
      // 同时记下版本分布：一个 home 里 5 与 7 并存是正常的（dsh 只重写被访问到的会话），
      // 而「最高版本超出支持范围」才是要报警的事。
      if (pcVersion === null || v.version > pcVersion) pcVersion = v.version;
      snapshot.pcLayout.versions[v.version] = (snapshot.pcLayout.versions[v.version] ?? 0) + 1;
      projSessions.set(v.session.sessionId, v.session);
      snapshot.pcLayout.perRecord += 1;
    }
  }

  // ② 聚合（遗留 bootstrap 源）——只补 per-record 没有的，不覆盖。
  if (exists(STORAGE_PATHS.projcacheAggregate)) {
    try {
      const v = validateProjcacheJson(readJson(STORAGE_PATHS.projcacheAggregate));
      if (v.ok) {
        if (pcVersion === null) pcVersion = v.version;
        for (const s of v.sessions) {
          if (!projSessions.has(s.sessionId)) {
            projSessions.set(s.sessionId, s);
            snapshot.pcLayout.aggregate = true;   // 确有会话来自聚合（而非仅文件存在）
          }
        }
      } else {
        // 聚合文件版本不认识：只有在**没有** per-record 兜底时才算该域 degraded
        // （有 per-record 时它只是个过期的遗留文件，不该拖垮整个域）。
        if (projSessions.size === 0) degraded.push({ domain: 'projcache', error: v.error, degraded: true });
        else pcErrors.push(`（遗留聚合文件被忽略）${v.error}`);
      }
    } catch (e) {
      if (projSessions.size === 0) degraded.push({ domain: 'projcache', error: e.message, degraded: true });
      else pcErrors.push(`（遗留聚合文件被忽略）${e.message}`);
    }
  } else if (projSessions.size === 0 && Array.isArray(perRecFiles) === false) {
    // 既没有 per-record 目录、也没有聚合文件 → 该域确实没有数据（新 home）。
    // 不作为 degraded（沿用原有语义：文件缺失 ≠ 版本不兼容）。
  }

  if (projSessions.size > 0) {
    snapshot.pcVersion = pcVersion;
    snapshot.sessions = [...projSessions.values()];
    // **部分**文件读失败时，不能把错误悄悄丢掉。
    //
    // 之前这里只统计成功数，失败的文件连一条记录都没有：一个 home 里 476 个会话文件、
    // 其中 50 个损坏（磁盘故障、dsh 写入中途被杀、或版本不认识），界面上只是「少了 50 个会话」，
    // 没有任何线索。这与本次要治的「静默漏读」是同一类病。
    //
    // 处理原则：**不判 degraded**（大部分数据是好的，整域降级会把好的也冻结 —— 那更糟），
    // 而是把失败计数与样例原因放进 `pcLayout.skipped`，让它可观察、可断言。
    if (pcErrors.length) {
      snapshot.pcLayout.skipped = pcErrors.length;
      snapshot.pcLayout.skippedSample = pcErrors.slice(0, 3);
    }
  } else if (pcErrors.length) {
    // 一个会话都没读出来，但确实有文件 → 全部不可读，判 degraded 并把原因带上。
    degraded.push({ domain: 'projcache', error: pcErrors.slice(0, 3).join('；'), degraded: true });
  }

  // model-tier.json 是可选的：未配置模型分层的 dsh home 没有此文件。
  // 缺失 → 保持 modelTier=null，不判定 degraded；存在但校验失败（版本/结构）→ degraded。
  if (exists(STORAGE_PATHS.modelTier)) {
    try {
      const v = validateModelTierJson(readJson(STORAGE_PATHS.modelTier));
      if (v.ok) {
        snapshot.modelTier = v.modelTier;
      } else {
        degraded.push({ domain: 'modelTier', error: v.error, degraded: true });
      }
    } catch (e) {
      degraded.push({ domain: 'modelTier', error: e.message, degraded: true });
    }
  }

  // .credentials.yaml 是可选的：未配置 provider key 时缺失。
  // 缺失 → providers=[]，不判定 degraded。
  if (exists(STORAGE_PATHS.credentials)) {
    try {
      const v = validateCredentials(parseCredentialsYaml(readText(STORAGE_PATHS.credentials)));
      if (v.ok) {
        snapshot.providers = v.providers;
      } else {
        degraded.push({ domain: 'credentials', error: v.error, degraded: true });
      }
    } catch (e) {
      degraded.push({ domain: 'credentials', error: e.message, degraded: true });
    }
  }

  return snapshot;
}

// 元数据文件的读取上限。正常文件是 KB 级（聚合 projcache ~268 KB，per-record 单文件几十 KB，
// 远端上限 32 MiB），64 MiB 足够宽松，同时挡住「一个 500 MB 的文件让进程吃掉 ~2 GB 内存」。
const MAX_METADATA_BYTES = 64 * 1024 * 1024;

/**
 * 读一个元数据文件。**不能**直接 readFileSync：
 *
 * · 如果那个路径是 **FIFO**（命名管道），readFileSync 会一直阻塞等写入端 —— 而且是**同步**阻塞，
 *   整个事件循环停住。因为 Node 把 listen() 的实际 bind 推迟到下一个事件循环轮次，
 *   阻塞发生在 HTTP 端口存在之前：表现为「端口连不上、日志里什么都没有、SIGTERM 也无效
 *   （进程卡在同步读里，信号处理函数没机会跑）」，只能 kill -9，且没有任何诊断信息。
 *   实测确认：mkfifo 一个 session_projcache.json 就能复现。
 * · 大文件会被整个读进内存（500 MB → RSS ~2 GB），没有任何上限。
 *
 * 因此：先 lstat 确认是**普通文件**（不是符号链接、目录、FIFO、设备），再按大小设限，
 * 最后用 O_NONBLOCK 打开（真正的防线 —— 即使中间被换成 FIFO，非阻塞 open 也不会挂住）。
 * 这套做法与 lib/file-preview.js 一致（那里的注释同样写着 "Nonblocking open avoids hanging on FIFOs"）。
 */
export function readMetadataFile(homePath, rel) {
  const target = path.join(homePath, rel);
  const st = lstatSync(target);          // lstat：不跟随符号链接（见 buildSnapshot 的说明）
  if (st.isSymbolicLink()) {
    // 跟随符号链接会把 home 之外的任意文件读进来、持久化进 hwb.db 并展示给浏览器。
    // 元数据文件没有理由是指向别处的链接。
    throw new Error(`${rel} 是符号链接（元数据文件必须位于 home 目录内）`);
  }
  if (!st.isFile()) throw new Error(`${rel} 不是普通文件`);
  if (st.size > MAX_METADATA_BYTES) {
    throw new Error(`${rel} 超过 ${MAX_METADATA_BYTES / 1024 / 1024} MiB 读取上限`);
  }
  let fd;
  try {
    // 三道防线叠加，因为 lstat 与 open 之间**存在时间窗**（查的是路径，拿到的可能是另一个
    // 瞬间的对象 —— 经典的 TOCTOU）：
    //  · O_NOFOLLOW：即使此刻被换成符号链接，open 直接失败（ELOOP），不跟随到 home 之外；
    //  · O_NONBLOCK：即使此刻被换成 FIFO，也不会挂住（上面 lstat 那关只是「当时」不是 FIFO）；
    //  · fstatSync(fd)：对**已经打开的那个对象**再核一次身份与大小 —— 这一步没有竞态，
    //    是唯一能真正关掉窗口的检查。注意要 fstat 而不是再 stat 一次路径。
    fd = openSync(target,
      fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw new Error(`${rel} 不是普通文件`);
    if (opened.size > MAX_METADATA_BYTES) {
      throw new Error(`${rel} 超过 ${MAX_METADATA_BYTES / 1024 / 1024} MiB 读取上限`);
    }
    return readFileSync(fd, 'utf8');
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* 已关闭 */ } }
  }
}

// 目录列举上限：per-record 目录下每个会话一个文件，一个用了几个月的 home 可能有几千个。
// 这个上限只防「异常爆炸的目录把内存吃光」，正常规模（实测 476 个）远低于它。
const MAX_DIR_ENTRIES = 50_000;

/**
 * 列出一个元数据目录下的**文件名**（不含路径，已排序）。目录不存在返回 null
 * （区分「目录不存在」与「目录是空的」：前者 = 旧版 dsh 没这个布局，后者 = 布局在但没数据）。
 *
 * 与 readMetadataFile 同样的安全考量：先 lstat（不跟随符号链接 —— 元数据目录没有理由是指向
 * 别处的链接），确认是目录；只返回普通文件的**名字**，不递归、不跟随。
 * 用 readdirSync 的 withFileTypes 避免对每个条目再 stat 一次（有竞态、也慢）。
 *
 * **不过滤扩展名**：返回该目录下全部普通文件名（含 dsh 的 `.json.bak.<stamp>` 备份文件）。
 * 过滤 `.json` 由调用方（projcache 读取分支）负责 —— 因为「哪些后缀算数」是**域的知识**，
 * 不是目录列举的知识。若把过滤塞进这里，将来另一个域想要别的后缀就得改这个通用函数。
 * 代价是备份文件也会进列表（实测 1000 个 .json + 1000 个 .bak 时列举 2ms），可接受。
 */
export function listMetadataDir(homePath, rel) {
  const target = path.join(homePath, rel);
  let st;
  try {
    st = lstatSync(target);
  } catch {
    return null;                        // 不存在（旧版 dsh / 全新 home）
  }
  if (st.isSymbolicLink()) return null;  // 目录是符号链接 → 视为不具备该布局（不跟随到 home 外）
  if (!st.isDirectory()) return null;
  const out = [];
  for (const d of readdirSync(target, { withFileTypes: true })) {
    if (out.length >= MAX_DIR_ENTRIES) break;
    if (d.isFile()) out.push(d.name);     // 文件；跳过子目录与符号链接（isFile 对 symlink 为 false）
  }
  out.sort();
  return out;
}

export function readHome(homePath) {
  return buildSnapshot({
    homePath,
    readText: (rel) => readMetadataFile(homePath, rel),
    exists: (rel) => existsSync(path.join(homePath, rel)),
    listDir: (rel) => listMetadataDir(homePath, rel),
  });
}
