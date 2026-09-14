import { buildSnapshot, METADATA_FILES, STORAGE_PATHS } from '../lib/read-home.js';
import { sshBash } from '../control/remote.js';
import { logger } from '../lib/logger.js';

const log = logger('remote-reader');

// —— 远程 dsh home 只读索引（§4.6）——
// 用一次 `ssh host bash -s` 在远端 cat 出 schema-versioned 元数据文件（带分隔标记），
// 在 Node 侧解析回文件文本 → buildSnapshot → normalize → 入库。只读，绝不修改远端文件。
// 与 read-home.js 共用同一套 schema 验证 / 域降级语义，保证本地与远程实例的「当前项目/当前会话」
// 走同一套数据模型（见 instance-grid 的当前块）。
//
// **路径来自 read-home.js 的 STORAGE_PATHS**（唯一事实来源），不在这里另写一份：
// 本地 reader 与远程 cat 脚本一旦对不上，远程实例就会静默少读一块数据 ——
// 这正是那次「漏 62% 会话」的成因，所以两边必须共用同一组常量。

// per-record projcache 目录：dsh 声明 `layout: 'per-record'` 后，会话数据在这里，
// 每个会话一个 `<key>.json`，信封是 `{version, record}`（与聚合文件不同）。
// **必须一起抓**，否则远程实例会和本地一样静默漏数据（实测本机漏 62%）。
export const PER_RECORD_DIR = STORAGE_PATHS.projcachePerRecordDir;

// 远端 cat 脚本：把固定文件与 per-record 目录一并抓回。
//
// per-record 目录的抓法：用一个循环 emit 每个文件，并在**目录整体**前后各加一个标记块
// （`__DSH_DIR_BEGIN__:<rel>` / `__DSH_DIR_END__:<rel>`）。这样：
//   · 目录不存在 → 只有 BEGIN/END 两个标记、中间没有文件块 → 解析出 `[]`（布局不存在）；
//   · 目录存在但为空 → 同样是 `[]`；
//   · 文件很多 → 每个文件仍是独立块，解析器逐个收，不受单文件大小限制。
// 文件名里可能含特殊字符，但 dsh 的 key 受 `SAFE_KEY_RE=[a-zA-Z0-9_-]+` 约束（实测成立），
// 仍用 `for f in "$dir"/*.json` 的 shell 展开并 `basename` 取名字，避免构造出不安全的路径。
export function buildCatScript() {
  // 单引号包裹：这些路径都是编译期常量，不含引号；用 ' 防止 shell 展开。
  const emitLines = METADATA_FILES.map((rel) => `emit '${rel}'`).join('\n');
  return String.raw`
home="$1"
emit() {
  rel="$1"
  printf '__DSH_FILE_BEGIN__:%s\n' "$rel"
  if [ -f "$home/$rel" ]; then
    cat "$home/$rel"
  else
    printf '__MISSING__\n'
  fi
  printf '\n__DSH_FILE_END__\n'
}
${emitLines}

# —— per-record projcache（dsh 的 layout:'per-record'）——
#
# **远端投影**：hwb 只用到每条记录里 21 个 projection 中的约 10 个
# （title / tokenUsage / contextPressure / sessionStats / goal / todos / subagent /
#   plan / permissions / sessionListMetadata），其余（titleInput、turnOutline、
# contextBreakdown 等）往往是大头。实测本机 476 个会话：全量 3.40 MiB → 投影后 0.58 MiB
# （**省 83%**）。在 25–30 KB/s 的链路上这是「能跑」与「超时」的差别。
#
# 安全性：投影**只删 rows 里确定不用的键**，不动 identity/version（hwb 要判身份与版本）。
# 任何一步失败（没有 python3、JSON 坏了、结构不符）都**退回 cat 原文** ——
# 宁可多传，也不能因为优化而少读（静默少读正是本次事故的教训）。
d="${PER_RECORD_DIR}"
printf '__DSH_DIR_BEGIN__:%s\n' "$d"
if [ -d "$home/$d" ]; then
  for f in "$home/$d"/*.json; do
    [ -f "$f" ] || continue
    n=$(basename "$f")
    printf '__DSH_FILE_BEGIN__:%s/%s\n' "$d" "$n"
    if command -v python3 >/dev/null 2>&1; then
      python3 -c 'import json,sys
KEEP={"title","tokenUsage","contextPressure","sessionStats","goal","todos","subagent","plan","permissions","sessionListMetadata"}
try:
    with open(sys.argv[1],encoding="utf-8",errors="replace") as fh: d=json.load(fh)
    rec=d.get("record")
    rows=rec.get("rows") if isinstance(rec,dict) else None
    if not isinstance(rows,dict): raise ValueError("no rows")
    rec["rows"]={k:v for k,v in rows.items() if k in KEEP}
    sys.stdout.write(json.dumps(d,ensure_ascii=False,separators=(",",":")))
except Exception:
    sys.stdout.write(open(sys.argv[1],encoding="utf-8",errors="replace").read())' "$f" 2>/dev/null || cat "$f"
    else
      cat "$f"
    fi
    printf '\n__DSH_FILE_END__\n'
  done
fi
printf '__DSH_DIR_END__:%s\n' "$d"
`;
}

// 解析 cat 输出 → { relPath: text|null }；null 表示远端无该文件。
// 要求 BEGIN 行后紧跟正文行，END 行独立成行。正文里若无该标记则解析残缺（后续 readText 抛错→degraded）。
// 缺失标记 body 可能是 `__MISSING__` 或 `__MISSING__\n`（script 末尾补了换行）——统一 trim 后判定。
export function parseCatOutput(stdout) {
  const files = Object.create(null);
  const re = /__DSH_FILE_BEGIN__:(.+?)\n([\s\S]*?)\n__DSH_FILE_END__/g;
  let m;
  while ((m = re.exec(stdout)) !== null) {
    const rel = m[1].trim();
    const body = m[2];
    files[rel] = body.trim() === '__MISSING__' ? null : body;
  }
  return files;
}

/**
 * 从 cat 输出里解析出 **per-record 目录的文件名清单**。
 *
 * 判据：目录标记块 `__DSH_DIR_BEGIN__:<dir> ... __DSH_DIR_END__:<dir>` 之间，出现了哪些
 * `__DSH_FILE_BEGIN__:<dir>/<name>` —— 这些名字就是目录里的 `.json` 文件。
 *
 * 为什么用目录标记而不是「按前缀过滤所有文件名」：后者无法区分「目录不存在」（旧版 dsh /
 * 全新 home，应判为不具备该布局）与「目录存在但空」（应判为空列表）。这个区分很重要 ——
 * 前者要退回只读聚合文件，后者说明数据确实为空。
 *
 * 返回 `{ present: bool, names: string[] }`。
 */
export function parsePerRecordDir(stdout, dir = PER_RECORD_DIR) {
  const begin = `__DSH_DIR_BEGIN__:${dir}`;
  const end = `__DSH_DIR_END__:${dir}`;
  const bi = stdout.indexOf(begin);
  if (bi === -1) return { present: false, names: [] };
  const ei = stdout.indexOf(end, bi);
  if (ei === -1) return { present: false, names: [] };   // 输出残缺 → 不假装有目录
  const seg = stdout.slice(bi + begin.length, ei);
  const names = [];
  const re = new RegExp(`__DSH_FILE_BEGIN__:${escapeRe(dir)}/(.+?)\\n`, 'g');
  let m;
  while ((m = re.exec(seg)) !== null) {
    const name = m[1].trim();
    // 只收单段文件名（防 `../` 之类把路径逃出去）
    if (name && !name.includes('/') && name.endsWith('.json')) names.push(name);
  }
  return { present: true, names };
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 把开头的 `~` 换成 `$HOME`：ssh 非交互会话里 `~` 不会在双引号参数内展开，$HOME 会。
function expandHome(p) {
  return String(p || '~/.dsh').replace(/^~(?=\/|$)/, '$HOME');
}

// 读取一个远程 dsh home 的元数据快照。home: { homePath, host, remoteHome }。
// `exec` 可注入（测试用假 sshBash）；缺省用真实 sshBash。
// 同一 host 的同一失败原因在窗口内只记一次（见下面的用法说明）。
const FAILURE_LOG_WINDOW_MS = 10 * 60_000;
const failureLog = new Map();   // host -> { key, at }
const volumeWarned = new Set(); // 已就「传输体积偏大」告警过的 host（只提醒一次）

export async function readHomeRemote(home, exec = sshBash) {
  const remoteHome = expandHome(home.remoteHome);
  // projcache 常超过启动日志使用的 64 KiB；必须完整传输，超限明确失败。
  const r = await exec(home.host, buildCatScript(), [remoteHome], undefined, { maxStdoutBytes: 32 * 1024 * 1024 });
  if (r.code !== 0) {    const reason = (r.stderr || '').trim().split('\n').pop() || 'ssh 返回异常';
    // 同一个 host 的同一个原因只记一次（10 分钟窗口）：一个长期不可达的远端会在每轮索引里
    // 记一条，而它只是**同一件事**。真实日志里这条占了噪音大头（用户那台机器 16,334 行 hwb.log
    // 里约 700 次 `读取远程 dsh home 失败(bot@cms.lo)`，每次都带一整套 async 栈帧）。
    // 原因变化或成功一次即复位（成功路径见下面的 rm failureLog.delete）。
    const key = `${home.host}|${reason}`;
    const now = Date.now();
    const prev = failureLog.get(home.host);
    if (prev?.key !== key || now - prev.at > FAILURE_LOG_WINDOW_MS) {
      failureLog.set(home.host, { key, at: now });
      log.error('读取远程 dsh home 元数据失败', { host: home.host, remoteHome, code: r.code });
    }
    throw new Error(`读取远程 dsh home 失败(${home.host}): ${reason}`);
  }
  failureLog.delete(home.host);   // 这次读成功了 → 复位抑制（下次失败要重新记全）
  const files = parseCatOutput(r.stdout);
  // cat 脚本即使遇到缺失文件也会输出标记。标记消失表示传输残缺，不能当作文件缺失入库。
  if (METADATA_FILES.some((rel) => !(rel in files))) {
    throw new Error('远程元数据输出不完整（文件分隔标记缺失）；保留已有索引');
  }
  // per-record 目录：解析出清单（目录不存在 → present:false → 退回只读聚合文件）。
  const perRec = parsePerRecordDir(r.stdout);

  // 传输体积观测：per-record 布局要抓**每个会话一个文件**，总量远大于聚合文件
  // （本机实测 4.05 MiB vs 635 KB，6.4×）。在这条代码服务的低带宽链路（25–30 KB/s）上，
  // 一批大 home 会把每次索引压到 90s 的 ssh 超时边缘。
  //
  // 这里**只告警不改变行为**：超限时明确失败（由调用方降级），而不是悄悄少读一部分 ——
  // 静默少读正是本次事故的教训。体积阈值取超时预算的保守一半：
  // 90s × 25 KB/s ≈ 2.2 MiB，超过它就有超时风险。
  const VOLUME_WARN_BYTES = 2 * 1024 * 1024;
  if (r.stdout.length > VOLUME_WARN_BYTES && !volumeWarned.has(home.host)) {
    volumeWarned.add(home.host);   // 同一 host 只提醒一次，避免每 60s 刷屏
    log.warn('远程元数据传输体积偏大（per-record 布局按会话分文件）', {
      host: home.host,
      bytes: r.stdout.length,
      perRecordFiles: perRec.names.length,
      hint: '低带宽链路上可能逼近 ssh 超时；可考虑降低索引频率或只对必要实例开启远程索引',
    });
  }

  // 远端解析出文件集校验：至少 workspace 或 projcache 任一存在，否则判为「不可读」，交给 indexer 降级。
  return buildSnapshot({
    homePath: home.homePath || `ssh://${home.host}`,
    readText: (rel) => {
      const t = files[rel];
      if (t === undefined || t === null) throw new Error(`远程 home 缺失 ${rel}`);
      return t;
    },
    exists: (rel) => files[rel] !== undefined && files[rel] !== null,
    // listDir 只对 per-record projcache 目录有意义（其余一律返回 null = 不具备该目录）。
    listDir: (rel) => {
      if (rel !== PER_RECORD_DIR) return null;
      return perRec.present ? perRec.names : null;
    },
  });
}
