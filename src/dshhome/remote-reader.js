import { buildSnapshot } from '../lib/read-home.js';
import { sshBash } from '../control/remote.js';
import { logger } from '../lib/logger.js';

const log = logger('remote-reader');

// —— 远程 dsh home 只读索引（§4.6）——
// 用一次 `ssh host bash -s` 在远端 cat 出 4 个 schema-versioned 元数据文件（带分隔标记），
// 在 Node 侧解析回文件文本 → buildSnapshot → normalize → 入库。只读，绝不修改远端文件。
// 与 read-home.js 共用同一套 schema 验证 / 域降级语义，保证本地与远程实例的「当前项目/当前会话」
// 走同一套数据模型（见 instance-grid 的当前块）。

const FILES = ['storages/workspace.json', 'storages/session_projcache.json', 'model-tier.json', '.credentials.yaml'];

// 远端 cat 脚本：把 4 个文件用不易与 JSON/YAML 内容冲突的分隔标记串起来，一次 SSH 抓回。
// 文件不存在 → 输出 __MISSING__（对应「可选文件缺失」而非 degraded；必需文件缺失则 readText 抛错 → degraded）。
export function buildCatScript() {
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
emit 'storages/workspace.json'
emit 'storages/session_projcache.json'
emit 'model-tier.json'
emit '.credentials.yaml'
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

// 把开头的 `~` 换成 `$HOME`：ssh 非交互会话里 `~` 不会在双引号参数内展开，$HOME 会。
function expandHome(p) {
  return String(p || '~/.dsh').replace(/^~(?=\/|$)/, '$HOME');
}

// 读取一个远程 dsh home 的元数据快照。home: { homePath, host, remoteHome }。
// `exec` 可注入（测试用假 sshBash）；缺省用真实 sshBash。
export async function readHomeRemote(home, exec = sshBash) {
  const remoteHome = expandHome(home.remoteHome);
  const r = await exec(home.host, buildCatScript(), [remoteHome]);
  if (r.code !== 0) {
    const reason = (r.stderr || r.stdout || '').trim().split('\n').pop() || 'ssh 返回异常';
    log.error('读取远程 dsh home 元数据失败', {
      host: home.host, remoteHome, code: r.code, stderr: r.stderr, stdout: r.stdout,
    });
    throw new Error(`读取远程 dsh home 失败(${home.host}): ${reason}`);
  }
  const files = parseCatOutput(r.stdout);
  // 远端解析出文件集校验：至少 workspace 或 projcache 任一存在，否则判为「不可读」，交给 indexer 降级。
  return buildSnapshot({
    homePath: home.homePath || `ssh://${home.host}`,
    readText: (rel) => {
      const t = files[rel];
      if (t === undefined || t === null) throw new Error(`远程 home 缺失 ${rel}`);
      return t;
    },
    exists: (rel) => files[rel] !== undefined && files[rel] !== null,
  });
}
