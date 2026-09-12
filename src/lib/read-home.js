import { readFileSync, existsSync, lstatSync, fstatSync, openSync, closeSync, constants as fsConstants } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  validateWorkspaceJson,
  validateProjcacheJson,
  validateModelTierJson,
  validateCredentials,
} from './schema.js';

const PROVIDER_ALIASES = {
  kimi_code: 'kimi',
  minimax_cn: 'minimax',
};

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
// 二者决定哪个域的 degraded 判定与本地逐文件读取行为完全一致（§4.2/4.3）。
export function buildSnapshot({ homePath, readText, exists }) {
  const degraded = [];
  const snapshot = {
    homeId: homeIdOf(homePath),
    homePath,
    generatedAt: new Date().toISOString(),
    wsVersion: null,
    pcVersion: null,
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
    const v = validateWorkspaceJson(readJson('storages/workspace.json'));
    if (v.ok) {
      snapshot.wsVersion = v.version;
      snapshot.workspaces = v.workspaces;
    } else {
      degraded.push({ domain: 'workspace', error: v.error, degraded: true });
    }
  } catch (e) {
    degraded.push({ domain: 'workspace', error: e.message, degraded: true });
  }

  try {
    const v = validateProjcacheJson(readJson('storages/session_projcache.json'));
    if (v.ok) {
      snapshot.pcVersion = v.version;
      snapshot.sessions = v.sessions;
    } else {
      degraded.push({ domain: 'projcache', error: v.error, degraded: true });
    }
  } catch (e) {
    degraded.push({ domain: 'projcache', error: e.message, degraded: true });
  }

  // model-tier.json 是可选的：未配置模型分层的 dsh home 没有此文件。
  // 缺失 → 保持 modelTier=null，不判定 degraded；存在但校验失败（版本/结构）→ degraded。
  if (exists('model-tier.json')) {
    try {
      const v = validateModelTierJson(readJson('model-tier.json'));
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
  if (exists('.credentials.yaml')) {
    try {
      const v = validateCredentials(parseCredentialsYaml(readText('.credentials.yaml')));
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

// 元数据文件的读取上限。正常的 4 个文件是 KB 级（projcache ~268 KB，远端上限 32 MiB），
// 64 MiB 足够宽松，同时挡住「一个 500 MB 的文件让进程吃掉 ~2 GB 内存」。
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

export function readHome(homePath) {
  return buildSnapshot({
    homePath,
    readText: (rel) => readMetadataFile(homePath, rel),
    exists: (rel) => existsSync(path.join(homePath, rel)),
  });
}
