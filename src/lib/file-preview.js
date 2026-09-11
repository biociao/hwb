import { open, realpath, opendir, lstat, stat, mkdtemp, link, unlink, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { sshBash } from '../control/remote.js';

export const PREVIEW_BYTES = 24 * 1024;
export const IMAGE_BYTES = 2 * 1024 * 1024;
export const DOWNLOAD_BYTES = 64 * 1024 * 1024;
export const UPLOAD_BYTES = 256 * 1024 * 1024;
const IMAGE_TYPES = { '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
export function sessionWorkspace(workspaces, session) {
  if (!session) return null;
  const exact = workspaces.find((w) => w.workspaceId === session.workspaceId);
  if (exact) return exact;
  const matches = workspaces.filter((w) => session.project && w.project === session.project && w.path);
  return matches.length === 1 ? matches[0] : null;
}
const MAX_ENTRIES = 200;
function inside(root, target) {
  const rel = path.relative(root, target);
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

export async function readLocalPreview(root, requested = '.', download = false) {
  // 与 mapUploadError 同源：把 Node 的裸 errno 翻成用户能看懂的话。
  // 之前文件被删掉后点预览，界面上显示的是 `ENOENT: no such file or directory, realpath '/...'`
  // —— 一句英文系统错误，既没说是哪个文件、也没说该怎么办。
  let target;
  try {
    root = await realpath(root);
    target = await realpath(path.resolve(root, requested));
  } catch (error) {
    throw mapPreviewError(error);
  }
  if (!inside(root, target)) throw new Error('只能预览当前项目目录内的文件');
  const base = { path: target, root, parent: target === root ? null : path.dirname(target) };
  // Nonblocking open avoids hanging on FIFOs; realpath also checks symlink escapes.
  const { constants } = await import('node:fs');
  let handle;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    throw mapPreviewError(error);
  }
  try {
    const st = await handle.stat();
    // realpath 与 open 之间存在 TOCTOU 窗口：窗口内把 target 换成符号链接，就能读到工作区之外
    // 的文件（越界检查查的是 realpath 那一刻的路径）。这里以**已打开的 fd** 为准，复核「打开的
    // 就是刚才 realpath 解析出来的那个对象」（dev+ino 相同）。独立审查在 129,576 次竞态读里
    // 没有撞出逃逸（窗口在同一个宏任务内，需要精确调度才能赢），所以这是加固而不是修缺陷。
    // 注意：不加密完全等价于 openat() 从 root 的 dirfd 逐段走 —— 那需要更多代码，这里是
    // 「以代价很小的一步把窗口从『随时可赢』缩到『需要竞态才能赢』」。也不能用 O_NOFOLLOW：
    // 指向工作区内的目录符号链接是**允许**的（见 inside() 的说明）。
    const confirmed = await stat(target);
    if (confirmed.dev !== st.dev || confirmed.ino !== st.ino) {
      throw new Error('文件在预览期间被替换，请刷新后重试');
    }
    if (st.isDirectory()) {
      if (download) throw new Error('请选择文件下载，暂不支持目录打包');
      const entries = [];
      let truncated = false;
      const dir = await opendir(target);
      for await (const item of dir) {
        if (entries.length === MAX_ENTRIES) { truncated = true; break; }
        entries.push({ name: item.name, kind: item.isDirectory() ? 'directory' : item.isSymbolicLink() ? 'symlink' : 'file' });
      }
      entries.sort((a, b) => (b.kind === 'directory') - (a.kind === 'directory') || a.name.localeCompare(b.name));
      return { ...base, kind: 'directory', entries, truncated };
    }
    if (!st.isFile()) throw new Error('不支持预览此文件类型');
    if (download) {
      if (st.size > DOWNLOAD_BYTES) throw new Error('文件超过 64 MiB 下载上限');
      const buffer = Buffer.alloc(Math.min(st.size + 1, DOWNLOAD_BYTES + 1));
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length !== st.size) throw new Error('文件在读取时发生变化，请重试');
      // 本机下载直接交回 Buffer，**不做 base64**。
      // 走 base64 的代价是三层同尺寸副本：原 buffer → base64 字符串（1.33×）→
      // JSON.stringify 的结果（又一份）→ 调用方 Buffer.from 再解一遍。
      // 64 MiB 的文件峰值约 300 MB。远端路径仍用 base64（那是 ssh 传输的需要），
      // 调用方按类型分别处理（Buffer 直接写出，字符串才解码）。
      return { ...base, kind: 'download', size: length, data: buffer.subarray(0, length) };
    }
    const mime = IMAGE_TYPES[path.extname(target).toLowerCase()];
    if (mime && st.size > IMAGE_BYTES) throw new Error('图片超过 2 MiB 预览上限');
    const buffer = Buffer.alloc(mime ? IMAGE_BYTES + 1 : PREVIEW_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const data = buffer.subarray(0, bytesRead);
    if (mime) {
      if (bytesRead > IMAGE_BYTES) throw new Error('图片超过 2 MiB 预览上限');
      return { ...base, kind: 'image', size: st.size, mime, data: data.toString('base64') };
    }
    const binary = data.includes(0);
    return { ...base, kind: 'file', size: st.size, binary, truncated: st.size > bytesRead,
      content: binary ? null : new TextDecoder().decode(data, { stream: st.size > bytesRead }) };
  } finally { await handle.close(); }
}

// Pass only base64 JSON as a shell argument. Paths never become shell source.
export const REMOTE_PREVIEW_SCRIPT = `python3 - "$1" <<'PY'
import os, sys, json, base64, stat
try:
    args = json.loads(base64.b64decode(sys.argv[1]))
    root = os.path.realpath(os.path.expanduser(args['root']))
    target = os.path.realpath(os.path.join(root, args['path']))
    if os.path.commonpath([root, target]) != root:
        raise Exception('只能预览当前项目目录内的文件')
    out = dict(path=target, root=root, parent=None if target == root else os.path.dirname(target))
    fd = os.open(target, os.O_RDONLY | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if stat.S_ISDIR(info.st_mode):
            if args.get('download'):
                raise Exception('请选择文件下载，暂不支持目录打包')
            entries = []
            truncated = False
            with os.scandir(target) as items:
                for item in items:
                    if len(entries) == 200:
                        truncated = True
                        break
                    entries.append(dict(name=item.name, kind='symlink' if item.is_symlink() else 'directory' if item.is_dir() else 'file'))
            entries.sort(key=lambda x: (x['kind'] != 'directory', x['name']))
            out.update(kind='directory', entries=entries, truncated=truncated)
        elif stat.S_ISREG(info.st_mode):
            download = args.get('download', False)
            if download and info.st_size > ${DOWNLOAD_BYTES}:
                raise Exception('文件超过 64 MiB 下载上限')
            mime = None if download else ${JSON.stringify(IMAGE_TYPES)}.get(os.path.splitext(target)[1].lower())
            if mime and info.st_size > ${IMAGE_BYTES}:
                raise Exception('图片超过 2 MiB 预览上限')
            if download:
                with os.fdopen(os.dup(fd), 'rb') as file:
                    data = file.read(info.st_size + 1)
                if len(data) != info.st_size:
                    raise Exception('文件在读取时发生变化，请重试')
            else:
                data = os.read(fd, ${IMAGE_BYTES + 1} if mime else 24576)
            if download:
                out.update(kind='download', size=len(data), data=base64.b64encode(data).decode('ascii'))
            elif mime:
                if len(data) > ${IMAGE_BYTES}:
                    raise Exception('图片超过 2 MiB 预览上限')
                out.update(kind='image', size=info.st_size, mime=mime, data=base64.b64encode(data).decode('ascii'))
            else:
                binary = b'\\x00' in data
                out.update(kind='file', size=info.st_size, binary=binary, truncated=info.st_size > len(data), content=None if binary else data.decode('utf-8', errors='replace'))
        else:
            raise Exception('不支持预览此文件类型')
    finally:
        os.close(fd)
    print(json.dumps(out, ensure_ascii=False))
except Exception as e:
    print(json.dumps(dict(error=str(e)), ensure_ascii=False))
PY`;

export async function readFilePreview(home, root, requested = '.', exec = sshBash, { download = false } = {}) {
  if (typeof requested !== 'string' || requested.length > 4096 || requested.includes('\0')) throw new Error('文件路径无效');
  if (home.hostType !== 'remote') return readLocalPreview(root, requested, download);
  const payload = Buffer.from(JSON.stringify({ root, path: requested, download })).toString('base64');
  const result = await exec(home.host, REMOTE_PREVIEW_SCRIPT, [payload], download ? 120000 : 15000,
    { maxStdoutBytes: download ? Math.ceil(DOWNLOAD_BYTES * 4 / 3) + 65536 : 3 * 1024 * 1024 });
  if (result.code !== 0) throw new Error('远端文件读取失败，请检查 SSH 连接和 Python 3');
  let data;
  try { data = JSON.parse(result.stdout); } catch { throw new Error('远端预览响应无效或过大'); }
  if (data.error) throw new Error(data.error);
  return data;
}

// —— 上传（写入当前预览目录）——
// 只接受「文件名」，不接受路径：任何目录分隔符都拒绝，写入位置完全由服务端已校验过的目录决定，
// 前端传来的路径没有任何机会影响落盘位置。
export function safeFileName(name) {
  if (typeof name !== 'string') throw new Error('缺少文件名');
  // 浏览器在上传前会剥掉目录部分；这里兼容贴进来的路径形态，并统一 Windows 分隔符。
  const base = name.trim().replace(/\\/g, '/').split('/').pop() ?? '';
  if (!base || base === '.' || base === '..') throw new Error('文件名无效');
  if (base.length > 200) throw new Error('文件名过长（最多 200 字符）');
  if (/[\0\r\n]/.test(base)) throw new Error('文件名含有非法字符');
  return base;
}

// 同名文件一律改名而不是覆盖：上传是「加文件」，覆盖一个已有结果是不可逆的破坏。
export function uniqueName(name, taken) {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 1; ; i++) {
    const candidate = `${stem}(${i})${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// 上传目标目录：必须是工作区内已存在的目录。realpath 兜住符号链接逃逸。
export async function resolveUploadDir(root, subdir) {
  root = await realpath(root);
  let target;
  try {
    target = await realpath(path.resolve(root, subdir || '.'));
  } catch (e) {
    throw mapUploadError(e);
  }
  if (!inside(root, target)) throw new Error('只能上传到当前项目目录内');
  const info = await lstat(target);
  if (!info.isDirectory()) throw new Error('请先打开一个目录（上传只能落到目录）');
  return { root, dir: target };
}

// 预览/下载路径上的同一件事：用户点开一个刚被删掉的文件时，不该看到一句英文 errno。
function mapPreviewError(error) {
  switch (error?.code) {
    case 'ENOENT': return new Error('文件或目录不存在，可能已被移动或删除，请刷新后重试');
    case 'EACCES': case 'EPERM': return new Error('没有读取该文件的权限');
    case 'EISDIR': case 'ENOTDIR': return new Error('路径类型不匹配（文件/目录），请刷新后重试');
    case 'ELOOP': return new Error('符号链接指向自身或层数过多');
    case 'ENAMETOOLONG': return new Error('路径过长');
    default: return error;
  }
}

// 把 Node 的裸错误翻译成用户能看懂的提示：ENOENT 基本都是“目标目录不存在”。
function mapUploadError(error) {
  if (error?.code === 'ENOENT') return new Error('上传目标目录不存在，请刷新后重试');
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return new Error('没有写入该目录的权限');
  if (error?.code === 'ENOSPC') return new Error('磁盘空间不足');
  return error;
}

async function localTaken(dir) {
  const taken = new Set();
  const entries = await opendir(dir);
  for await (const item of entries) taken.add(item.name);
  return taken;
}

// 收一个上传的文件：body 由 multipart 解析器边解析边喂进来（options.onFileStart 拿唯一文件名）。
// 先落隐藏临时文件、写全后再 link 到最终名：任何中断都不会留下「半截但看起来正常」的文件，
// 也不会把别人刚创建的同名文件覆盖掉（link 撞名即 EEXIST，换个名字重试）。
export async function localUploader(root, requestedDir) {
  const { dir } = await resolveUploadDir(root, requestedDir);
  const taken = await localTaken(dir);
  let temp = null, stream = null, active = null, size = 0;
  // 已经 stage（写完、等 commit）的临时目录。stage() 会把 temp 交给 commit 闭包并置空，
  // 于是 cleanup() 只清「当前那个」—— 中途失败时**之前**已 stage 的目录留在项目目录里，
  // 每个都装着整份文件副本（实测：第二个 part 中断 → 目录里留下 .hwb-upload-xxxx/part）。
  const staged = new Set();
  async function openTemp() {
    temp = await mkdtemp(path.join(dir, '.hwb-upload-'));
    stream = createWriteStream(path.join(temp, 'part'), { flags: 'wx' });
    await new Promise((resolve, reject) => { stream.once('open', resolve); stream.once('error', reject); });
  }
  const closeStream = async () => {
    const target = stream;
    await new Promise((resolve, reject) => { target.end(() => resolve()); target.once('error', reject); });
  };
  return {
    get dir() { return dir; },
    async begin(rawName) {
      active = safeFileName(rawName);
      size = 0;
      await openTemp();
      return uniqueName(active, taken);
    },
    // 写完一个 part：先停在临时文件上，等整批都收完再统一 commit。
    async stage() {
      if (!stream) throw new Error('上传未开始');
      await closeStream();
      const source = path.join(temp, 'part');
      const staging = temp;
      const request = active;
      const bytes = size;
      stream = null;
      temp = null;
      staged.add(staging);
      return {
        // 同名不覆盖：link 撞名就换下一个候选名（从原始请求名重算，不会越算越偏）。
        commit: async () => {
          // 整个流程（含 link 循环）都要在 try/finally 里：link 因 EACCES/ENOSPC/EMFILE 等失败时
          // 原先会**跳过**清理，于是在用户项目目录里留下一个装着整份文件副本的隐藏目录。
          // 注意 try 必须包住上面那个 for(;;) 里的 throw，只包 return 是不够的（实测仍残留）。
          try {
            let name = uniqueName(request, taken);
            for (;;) {
              if (taken.has(name)) { name = uniqueName(request, taken); continue; }
              try { await link(source, path.join(dir, name)); break; } catch (e) {
                if (e.code !== 'EEXIST') throw e;
                taken.add(name);
                name = uniqueName(request, taken);
              }
            }
            return { name, size: bytes, path: path.join(dir, name) };
          } finally {
            staged.delete(staging);
            await rm(staging, { recursive: true, force: true }).catch(() => {});
          }
        },
      };
    },
    // 用写回调（而不是 'drain' 事件）作为「这一块已经交给内核」的边界：drain 只在
    // 内部缓冲清空时才触发，配合 await 使用时容易出现「回调永不到达」的悬挂。
    write(chunk) {
      size += chunk.length;
      if (size > UPLOAD_BYTES) throw new Error(`文件超过 ${Math.floor(UPLOAD_BYTES / (1024 * 1024))} MiB 上限`);
      const target = stream;
      return new Promise((resolve, reject) => {
        target.write(chunk, (error) => (error ? reject(error) : resolve()));
      });
    },
    async cleanup() {
      try { stream?.destroy(); } catch { /* 尽力清理 */ }
      // 当前正在写的 + 之前已经 stage 的，全都要清 —— 否则失败一次就在项目目录里留一份残留。
      const all = new Set(staged);
      if (temp) all.add(temp);
      staged.clear();
      temp = null;
      for (const dirPath of all) await rm(dirPath, { recursive: true, force: true }).catch(() => {});
    },
  };
}

// 远端写入（SSH）。为何不把文件字节放在 stdin：
//   · sshBash 用 `bash -s` 从 stdin 读脚本，而 bash 会把 stdin 里剩下的字节当命令继续执行
//     （实测：数据会被当成“AAAA…: command not found”，Python 一字节都读不到）；
//   · 与脚本共用同一条 stdin 的任何“长度/哨兵”协议都要求精确到字节，而 bash 的预读
//     会把数据吞进它自己的缓冲区，不可靠。
// 因此改成：文件内容分片、每片 base64 后作为命令行参数传给远端的
// `python3 -c ...` 一次写入临时目录（参数不走 stdin，不存在竞争），最后再 mkdir/rename 合并到最终名。
// 单个参数上限实测约 1 MiB（macOS）：512 KiB 原始字节 → 683 KiB base64，留足余量。
const REMOTE_CHUNK_BYTES = 512 * 1024;

// 远端 python 引导程序（一行，因此字符串里不能出现双引号）。
// 为什么这么绕：sshBash 用 `bash -s` 从 stdin 读脚本，多行 stdin + 命令行参数一起用时
// bash 的解析会退化（实测只给 python 留下 "-c"），所以远端命令必须是**单行**；
// 而单行的 python -c 又不能用分号连接 `while`/`if` 这类复合语句（缩进会丢失）。
// 于是让引导程序自己解码真正的脚本源码（base64 → 文本，再用换行符 exec 成模块级代码）。
const REMOTE_PY_BOOTSTRAP = [
  'python3 -c "',
  'import sys, base64',
  'exec(base64.b64decode(sys.argv[1]).decode(chr(117) + chr(116) + chr(102) + chr(45) + chr(56)) + chr(10))',
  '"',
].join(String.fromCharCode(10));

// 把一段 python 源码 + 额外参数包装成远端可执行的单行命令。
function remotePython(source, extraArgs = []) {
  const args = extraArgs.map((arg) => `'${String(arg).replace(/'/g, `'\\''`)}'`).join(' ');
  return `${REMOTE_PY_BOOTSTRAP} '${Buffer.from(source).toString('base64')}'${args ? ` ${args}` : ''}`;
}

// 分片写入：argv[2] = 临时目录，argv[3] = 分片序号，argv[4] = base64 内容。
const REMOTE_CHUNK_PY = `
import sys, os, json, base64
tmp = sys.argv[2]
merged = os.path.join(tmp, 'merged')
os.makedirs(merged, exist_ok=True)
data = base64.b64decode(sys.argv[4])
path = os.path.join(merged, 'chunk-%05d' % int(sys.argv[3]))
handle = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
try:
    written = 0
    while written < len(data):
        written += os.write(handle, data[written:])
finally:
    os.close(handle)
print(json.dumps({'size': written}))
`;

// 合并分片并落到最终名。argv[2] = 临时目录（含 merged/ 子目录），argv[3] = base64 JSON 元数据。
// 同名一律换名（绝不覆盖既有文件）；全程先写隐藏临时文件再 os.replace，中断不留半截文件。
const REMOTE_FINISH_PY = `
import sys, os, json, base64, glob
# sys.argv[0] = '-c'，argv[1] = 本脚本源码（base64），argv[2] = 临时目录，argv[3] = 元数据
meta = json.loads(base64.b64decode(sys.argv[3]))
tmp = sys.argv[2]
root = os.path.realpath(meta['root'])  # 两边都 realpath： macOS 下 /var → /private/var，不处理会误判为越界
# meta['dir'] 是相对项目根的路径（也可能是绝对），必须拼在 root 下才能正确解析。
target = os.path.realpath(os.path.join(root, meta['dir']))
if os.path.commonpath([root, target]) != root:
    raise Exception('只能上传到当前项目目录内')
if not os.path.isdir(target):
    raise Exception('上传目标目录不存在')
name = meta['name']
parts = [p for p in sorted(glob.glob(os.path.join(tmp, 'merged', '*'))) if os.path.isfile(p) and not os.path.islink(p)]
expected = int(sys.argv[4]) if len(sys.argv) > 4 else -1
if not parts and expected != 0:
    # 没有分片，但调用方说这个文件本来就不是 0 字节 → 分片真的丢了，照旧报错
    raise Exception('没有收到上传数据')
temp = os.path.join(target, '.hwb-upload-%d' % os.getpid())
out = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
total = 0
try:
    for part in parts:
        with open(part, 'rb') as source:
            while True:
                block = source.read(1048576)
                if not block:
                    break
                total += len(block)
                if total > meta['limit']:
                    raise Exception('上传内容超过 %d MiB 上限' % (meta['limit'] // 1048576))
                os.write(out, block)
finally:
    os.close(out)
try:
    stem, ext = os.path.splitext(name)
    counter = 1
    while os.path.lexists(os.path.join(target, name)):
        name = '%s(%d)%s' % (stem, counter, ext)
        counter += 1
        if counter > 1000:
            raise Exception('同名文件过多，请改名后重试')
    final = os.path.join(target, name)
    os.replace(temp, final)
finally:
    if os.path.exists(temp):
        os.remove(temp)
print(json.dumps({'name': name, 'path': final, 'size': total}))
`;

// 写入一批上传文件（同一目标目录）。parts: [{ name, chunks }]，chunks 为 async iterable<Buffer>。
// chunks 既可能是「收集好的数组」（流式解析器回调攒起来的），也可能是生成器/流。
// 注意不要写成 `part.chunks = (async function* () { yield* part.chunks; })()`——那会变成自引用：
// 属性被覆盖后 `yield* part.chunks` 指向生成器自身，for await 会永久挂起（实测）。
function asChunks(chunks) {
  if (Array.isArray(chunks)) return (async function* () { yield* chunks; })();
  return chunks;
}

export async function writeUpload(home, root, dir, parts, exec = sshBash) {
  if (!Array.isArray(parts) || !parts.length) throw new Error('没有收到文件内容');
  for (const part of parts) safeFileName(part.name);

  if (home.hostType !== 'remote') {
    // 先把每个 part 写成同目录下的隐藏临时文件，全部收完再依次 link 到最终名——任一 part 出错都不会在目录里留下半截文件。
    const uploader = await localUploader(root, dir);
    const staged = [];
    try {
      for (const part of parts) {
        await uploader.begin(part.name);
        for await (const chunk of asChunks(part.chunks)) await uploader.write(chunk);
        staged.push(await uploader.stage());
      }
      const files = [];
      for (const part of staged) files.push(await part.commit());
      return { dir: uploader.dir, files };
    } catch (e) {
      await uploader.cleanup();
      throw mapUploadError(e);
    }
  }

  // 远端：逐个文件、逐个分片写入远端临时目录，全部完成后再合并到最终名（同名不覆盖）。
  const files = [];
  for (const part of parts) {
    const name = safeFileName(part.name);
    const meta64 = Buffer.from(JSON.stringify({ root, dir, name, limit: UPLOAD_BYTES })).toString('base64');
    const tmp = `${await remoteTempDir(home, exec)}/${Date.now().toString(36)}-${safeRandomSuffix()}`;
    let total = 0;
    let index = 0;
    let pending = [];
    let pendingBytes = 0;
    try {
      for await (const chunk of asChunks(part.chunks)) {
        for (let at = 0; at < chunk.length; at += REMOTE_CHUNK_BYTES) {
          const slice = chunk.subarray(at, at + REMOTE_CHUNK_BYTES);
          total += slice.length;
          if (total > UPLOAD_BYTES) throw new Error(`上传内容超过 ${Math.floor(UPLOAD_BYTES / (1024 * 1024))} MiB 上限`);
          pending.push(slice);
          pendingBytes += slice.length;
          if (pendingBytes >= REMOTE_CHUNK_BYTES) {
            await sendRemoteChunk(home, exec, tmp, index++, Buffer.concat(pending));
            pending = [];
            pendingBytes = 0;
          }
        }
      }
      if (pendingBytes) await sendRemoteChunk(home, exec, tmp, index++, Buffer.concat(pending));
      const result = await finishRemoteUpload(home, exec, tmp, meta64, total);
      files.push({ ...result, path: result.path });
    } catch (e) {
      // 分片阶段失败时 finishRemoteUpload 还没跑过，没人清理远端临时目录：
      // 每次重试都会在远端留一份残留（TMPDIR 不可用时甚至在用户家目录里）。
      await cleanupRemoteTemp(home, exec, tmp);
      throw e;
    }
  }
  // 远端分支**不能**用 resolveUploadDir：它做的是本地 fs 的 realpath，而这里的 root 是远端主机上的
  // 路径（本机通常不存在）→ ENOENT。原先分片全都传完了、最后一步才失败，整条远端上传依旧走不通。
  // 越界与「目录是否存在」已由 REMOTE_FINISH_PY 在**远端**用 realpath+commonpath 校验过，
  // 且它返回的 path 是远端上的绝对路径 —— 目录直接取它的父目录。
  // （本机实例仍走 uploader.dir，那是本地 realpath 的结果。）
  const remoteDir = path.posix.dirname(files[0].path);
  return { dir: remoteDir, files };
}

function safeRandomSuffix() {
  return Math.random().toString(36).slice(2, 8);
}

// 远端临时目录（放在 /tmp 下，避开用户家目录的权限差异）。
async function remoteTempDir(home, exec) {
  const result = await exec(home.host, REMOTE_TEMP_DIR_SCRIPT, [], 20000);
  // 只取最后一行：远端登录 shell 可能先打印 profile / motd / BASH_ENV 之类的内容，
  // 整段 trim 会把它们一并当成目录名（本文件其它远端消费点一律用 lastLine）。
  const dir = lastLine(result.stdout);
  // 目录名会被拼进后续远端命令（包括 `rm -rf`），必须限制字符集：只允许绝对路径 +
  // 常见安全字符。mktemp 生成的名字必然满足；出现别的说明远端环境异常，宁可拒绝。
  if (result.code !== 0 || !/^\/[A-Za-z0-9._/-]+$/.test(dir)) throw new Error('无法在远端创建临时目录，请检查 SSH 连接');
  return dir;
}

// POSIX 单引号引用（与 control/prober.js 的 shellSingleQuote 同一套规则）：
// 单引号之外的字符一律按字面量处理。
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// 失败路径的 best-effort 清理：合并阶段自己会清（见 finishRemoteUpload），但**分片阶段**
// 失败（SSH 断、超时、超限）时没人清，重试一次就在远端留一份残留 —— 而且 TMPDIR 不可用时
// mktemp 的兜底会把目录建到用户家目录里。清理失败不掩盖原始错误。
async function cleanupRemoteTemp(home, exec, tmp) {
  try {
    await exec(home.host, `rm -rf ${shellQuote(tmp)}`, [], 20000);
  } catch { /* 尽力而为 */ }
}

async function sendRemoteChunk(home, exec, tmp, index, data) {
  const command = remotePython(REMOTE_CHUNK_PY, [tmp, String(index), data.toString('base64')]);
  const result = await exec(home.host, command, [], 120000);
  if (result.code !== 0) throw mapUploadError(new Error(lastLine(result.stderr) || '远端分片写入失败'));
}

function lastLine(text) {
  return String(text || '').trim().split(String.fromCharCode(10)).filter(Boolean).pop() || '';
}

async function finishRemoteUpload(home, exec, tmp, meta64, total) {
  // total 一并传给远端：0 字节文件**不会产生任何分片**，而远端原先只会看到「merged 目录是空的」
  // 就报「没有收到上传数据」——于是本机能传空文件（.gitkeep、空 csv），远端永远 400。
  // 有了期望字节数，远端才能区分「协议坏了/分片丢了」与「这就是个空文件」。
  const command = remotePython(REMOTE_FINISH_PY, [tmp, meta64, String(total)]);
  // 无论合并成败都清掉远端临时目录（否则失败会在 /tmp 下留一堆分片）。
  // 用 shellQuote 而不是裸 `'${tmp}'`：tmp 来自远端 stdout，其中一个单引号就能闭合引号，
  // 把后面的内容变成要执行的命令。
  const script = `${command} ; __hwb_rc=$? ; rm -rf ${shellQuote(tmp)} ; exit $__hwb_rc`;
  const result = await exec(home.host, script, [], Math.max(120000, Math.ceil(total / (1024 * 1024)) * 2000));
  if (result.code !== 0) {
    const reason = lastLine(result.stderr);
    throw new Error(reason.includes('上传') || reason.includes('同名') || reason.includes('MiB') ? reason : '远端合并失败（需要 Python 3）');
  }
  let data;
  try { data = JSON.parse(lastLine(result.stdout)); } catch { throw new Error('远端上传响应无效'); }
  if (data.error) throw new Error(data.error);
  return data;
}

const REMOTE_TEMP_DIR_SCRIPT = 'set -e\nd="$(mktemp -d "${TMPDIR:-/tmp}/hwb-upload-XXXXXX" 2>/dev/null || mktemp -d)"\nprintf %s "$d"';
