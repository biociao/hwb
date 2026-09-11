import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { writeUpload, localUploader, resolveUploadDir, safeFileName, uniqueName, UPLOAD_BYTES } from '../src/lib/file-preview.js';
import { parseMultipart } from '../src/lib/multipart.js';
import { createRouter } from '../src/api/routes.js';

const HOME_ID = 'abcdef1234567890';
const NUL = String.fromCharCode(0);
const CRLF = '\r\n';

async function fixture(t) {
  const base = await mkdtemp(path.join(tmpdir(), 'hwb-upload-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'project');
  await mkdir(path.join(root, 'dir'), { recursive: true });
  await writeFile(path.join(base, 'outside.txt'), 'secret');
  await symlink(path.join(base, 'outside.txt'), path.join(root, 'escape.txt'));
  await symlink(base, path.join(root, 'escape-dir'));
  return { base, root };
}

const local = { hostType: 'local' };
const remote = { hostType: 'remote', host: 'fixture' };
// 在本地跑真实的远端命令：stdin 只给脚本（与 sshBash 一致），数据全部走命令行参数。
function execRemote(_host, script, args) {
  return new Promise((resolve) => {
    const proc = spawn('bash', ['-s', '--', ...args]);
    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.stdin.on('error', () => {});
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
    proc.stdin.end(script);
  });
}

const part = (name, text) => ({ name, chunks: (async function* () { yield Buffer.from(text); })() });
// 故意把内容切成多个小块：验证「一个 part 被拆成多段到达」也能拼对。
const splitPart = (name, text) => ({ name, chunks: (async function* () {
  const buffer = Buffer.from(text);
  for (let i = 0; i < buffer.length; i += 4) yield buffer.subarray(i, i + 4);
})() });

for (const home of [local, remote]) {
  test(`upload ${home.hostType}: writes files into the requested subdirectory`, async (t) => {
    const { root } = await fixture(t);
    const result = await writeUpload(home, root, 'dir',
      [part('data.csv', 'a,b\n1,2\n'), splitPart('中文 name.txt', '你好 world')], execRemote);
    assert.deepEqual(result.files.map((f) => f.name).sort(), ['data.csv', '中文 name.txt'].sort());
    assert.equal(await readFile(path.join(root, 'dir', 'data.csv'), 'utf8'), 'a,b\n1,2\n');
    assert.equal(await readFile(path.join(root, 'dir', '中文 name.txt'), 'utf8'), '你好 world');
    assert.equal(result.files.find((f) => f.name === 'data.csv').size, 8);
  });

  test(`upload ${home.hostType}: never overwrites, renames duplicates`, async (t) => {
    const { root } = await fixture(t);
    await writeFile(path.join(root, 'dir', 'data.csv'), 'original');
    await writeFile(path.join(root, 'dir', 'data(1).csv'), 'one');
    const result = await writeUpload(home, root, 'dir', [part('data.csv', 'new'), part('data.csv', 'newer')], execRemote);
    assert.deepEqual(result.files.map((f) => f.name), ['data(2).csv', 'data(3).csv']);
    assert.equal(await readFile(path.join(root, 'dir', 'data.csv'), 'utf8'), 'original');
    assert.equal(await readFile(path.join(root, 'dir', 'data(1).csv'), 'utf8'), 'one');
    assert.equal(await readFile(path.join(root, 'dir', 'data(3).csv'), 'utf8'), 'newer');
  });

  test(`upload ${home.hostType}: rejects escaping paths, symlinks and non-directory targets`, async (t) => {
    const { root } = await fixture(t);
    await assert.rejects(writeUpload(home, root, '../..', [part('x.txt', 'x')], execRemote), /项目目录/);
    await assert.rejects(writeUpload(home, root, 'escape-dir', [part('x.txt', 'x')], execRemote), /项目目录/);
    await assert.rejects(writeUpload(home, root, 'missing', [part('x.txt', 'x')], execRemote), /不存在|No such/);
    await writeFile(path.join(root, 'plain.txt'), 'plain');
    await assert.rejects(writeUpload(home, root, 'plain.txt', [part('x.txt', 'x')], execRemote), /目录|Not a directory/);
    // 文件名只取 basename；纯路径（没有文件名）一律拒绝。
    const named = await writeUpload(home, root, 'dir', [part('../../evil.txt', 'x')], execRemote);
    assert.equal(named.files[0].name, 'evil.txt');
    assert.equal(await readFile(path.join(root, 'dir', 'evil.txt'), 'utf8'), 'x');
    await assert.rejects(writeUpload(home, root, 'dir', [part('..', 'x')], execRemote), /文件名无效/);
  });
}

test('safeFileName / uniqueName: basename only, sane renaming', () => {
  assert.equal(safeFileName('a/b/c.txt'), 'c.txt');
  assert.equal(safeFileName('C:\\Users\\me\\d.csv'), 'd.csv');
  assert.equal(safeFileName('  spaced.txt '), 'spaced.txt');
  for (const bad of ['', '.', '..', 'a/b/..', `x${NUL}y`, 'a\nb', 'x'.repeat(201), 42]) {
    assert.throws(() => safeFileName(bad), /文件名/);
  }
  assert.equal(uniqueName('data.csv', new Set()), 'data.csv');
  assert.equal(uniqueName('data.csv', new Set(['data.csv'])), 'data(1).csv');
  assert.equal(uniqueName('data.csv', new Set(['data.csv', 'data(1).csv'])), 'data(2).csv');
  assert.equal(uniqueName('.env', new Set(['.env'])), '.env(1)');
});

test('localUploader stages files, commits atomically and cleans up on abort', async (t) => {
  const { root } = await fixture(t);
  const uploader = await localUploader(root, '.');
  await uploader.begin('keep.txt');
  await uploader.write(Buffer.from('kept'));
  const staged = await uploader.stage();
  // 尚未 commit：目标名不该出现，目录里只应有隐藏暂存目录。
  const before = await readdir(root);
  assert.equal(before.includes('keep.txt'), false);
  assert.equal(before.some((name) => name.startsWith('.hwb-upload-')), true);
  assert.equal((await staged.commit()).name, 'keep.txt');
  assert.equal(await readFile(path.join(root, 'keep.txt'), 'utf8'), 'kept');
  assert.equal((await readdir(root)).some((name) => name.startsWith('.hwb-upload-')), false);

  await uploader.begin('broken.txt');
  await uploader.write(Buffer.from('partial'));
  await uploader.cleanup();
  const names = await readdir(root);
  assert.equal(names.some((name) => name.startsWith('.hwb-upload-')), false);
  assert.equal(names.includes('broken.txt'), false);
});

test('resolveUploadDir confines to the workspace root', async (t) => {
  const { root } = await fixture(t);
  const resolved = await resolveUploadDir(root, 'dir');
  assert.equal(resolved.dir, path.join(await realpath(root), 'dir'));
  await assert.rejects(resolveUploadDir(root, '../..'), /项目目录/);
  await assert.rejects(resolveUploadDir(root, 'missing'), /不存在|No such/);
});

// —— multipart 解析 ——
function multipartBody(boundary, files) {
  const chunks = [];
  for (const { name, data } of files) {
    chunks.push(Buffer.from(
      `--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="${encodeURIComponent(name)}"${CRLF}`
      + `Content-Type: application/octet-stream${CRLF}${CRLF}`));
    chunks.push(Buffer.from(data));
    chunks.push(Buffer.from(CRLF));
  }
  chunks.push(Buffer.from(`--${boundary}--${CRLF}`));
  return Buffer.concat(chunks);
}

// 统一夹具：先挂好流的 error handler，再创建 Promise，并立刻给结果挂空 catch，
// 保证任何时刻都不会出现「未处理的拒绝」而打断整个测试进程。
function openParse(body, boundary, { chunkSize = 7, maxBytes = UPLOAD_BYTES, write } = {}) {
  const req = new Readable({ read() {} });
  req.on('error', () => {});
  req.headers = { 'content-length': String(body.length) };
  const files = [];
  let current = null;
  // outcome 在「结果产生的那一刻」就记下成功/失败（同步），测试就不再依赖 Promise 的
  // 事后结算——否则在 node:test 里，解析阶段抛出的拒绝会被判成未处理拒绝而中断测试进程。
  const outcome = { reason: null, failed: false };
  const parsed = parseMultipart(req, {
    boundary,
    maxBytes,
    onSettle: (_status, message) => { if (message) { outcome.failed = true; outcome.reason = message; } },
    onFileStart(name) { current = { name, chunks: [] }; files.push(current); return true; },
    write: write || ((chunk) => { current.chunks.push(chunk); }),
  });
  parsed.catch(() => {});
  const result = parsed.then(() => files.map((file) => ({ name: file.name, data: Buffer.concat(file.chunks) })));
  return {
    outcome,
    result,
    feed() {
      for (let i = 0; i < body.length; i += chunkSize) req.push(body.subarray(i, i + chunkSize));
      req.push(null);
    },
  };
}

// 读「错误信息」：优先用 onSettle 当场记录的原因（同步确定），否则看 Promise 结算。
async function readFailure(body, boundary, options = {}) {
  const { outcome, result, feed } = openParse(body, boundary, options);
  feed();
  if (outcome.reason) return outcome.reason;
  try { await result; return 'resolved'; } catch (e) { return e.message; }
}

async function parseInChunks(body, boundary, options) {
  const { result, feed } = openParse(body, boundary, options);
  feed();
  return result;
}

test('parseMultipart: reassembles parts split at arbitrary byte offsets', async () => {
  const boundary = 'XyZ123';
  const body = multipartBody(boundary, [
    { name: 'a.txt', data: 'hello' },
    { name: '中文 b.bin', data: Buffer.from([0, 1, 2, 255]) },
  ]);
  // 覆盖「分隔符被切碎」与「一个分片里含多个 part」两种极端：都必须正确切分。
  for (const chunkSize of [1, 2, 3, 7, 64, body.length]) {
    const files = await parseInChunks(body, boundary, { chunkSize });
    assert.equal(files.length, 2, `chunkSize=${chunkSize}`);
    assert.equal(files[0].name, 'a.txt');
    assert.equal(files[0].data.toString(), 'hello');
    assert.equal(files[1].name, '中文 b.bin');
    assert.deepEqual([...files[1].data], [0, 1, 2, 255]);
  }
});

// 说明：浏览器提交的表单一定至少带一个 file part，因此「只有结束分隔符的空表单」不在
// 支持的协议子集内（本机/远端写入都要求至少一个 part）。
test('parseMultipart: rejects malformed and truncated payloads', async () => {
  const boundary = 'B';
  const body = multipartBody(boundary, [{ name: 'a.txt', data: 'hello' }]);
  // 非 multipart 内容：找不到边界就直接报错，不能把消息体当成文件内容。
  assert.match(await readFailure(Buffer.alloc(4096), boundary), /格式无效/);
  assert.match(await readFailure(Buffer.from('not-a-multipart-body'), boundary), /格式无效/);
  // 尾部被截断（结束分隔符不完整）：必须报错，不能把半截数据当成完整文件。
  assert.match(await readFailure(body.subarray(0, body.length - 6), boundary), /不完整|格式无效/);
  // 写入端判定超限（解析器只管边界）：回报「超上限」后应立刻终止并让整个上传失败。
  let written = 0;
  const over = openParse(body, boundary, {
    write(chunk) { written += chunk.length; if (written > 4) throw new Error('文件超过上传上限'); },
  });
  over.feed();
  await over.result.catch(() => {}); // 等解析器跑到失败（写回调在微任务里触发）
  assert.match(over.outcome.reason || 'resolved', /上限/);
});

test('parseMultipart: requires Content-Length so the size limit holds', async () => {
  const bare = new Readable({ read() {} });
  bare.on('error', () => {});
  bare.headers = {};
  const outcome = { reason: null };
  const parsed = parseMultipart(bare, {
    boundary: 'B',
    maxBytes: UPLOAD_BYTES,
    onFileStart: () => true,
    write() {},
    onSettle: (_status, message) => { if (message) outcome.reason = message; },
  });
  parsed.catch(() => {});
  assert.match(outcome.reason || 'resolved', /Content-Length/);
});

// 回归：路由把解析器攒下来的数组直接作为 chunks 传入。曾经这里写成
// `part.chunks = (async function* () { yield* part.chunks; })()`（自引用生成器），
// 会让 for await 永远挂起——必须保证数组形态的 chunks 能正常写入。
test('writeUpload accepts plain array chunks (no self-referential generator)', async (t) => {
  const { root } = await fixture(t);
  const arrays = [{ name: 'arr.txt', chunks: [Buffer.from('a'), Buffer.from('b')] }];
  const local = await writeUpload({ hostType: 'local' }, root, 'dir', arrays);
  assert.equal(local.files[0].name, 'arr.txt');
  assert.equal(await readFile(path.join(root, 'dir', 'arr.txt'), 'utf8'), 'ab');
  const remote = await writeUpload({ hostType: 'remote', host: 'fixture' }, root, 'dir',
    [{ name: 'arr-remote.txt', chunks: [Buffer.from('a'), Buffer.from('b')] }], execRemote);
  assert.equal(remote.files[0].name, 'arr-remote.txt');
  assert.equal(await readFile(path.join(root, 'dir', 'arr-remote.txt'), 'utf8'), 'ab');
});

// —— API 路由 ——
function makeRoute(root, home = local) {
  return createRouter({ store: {
    getHome: (id) => id === HOME_ID ? { homeId: id, ...home } : null,
    listWorkspaces: () => [{ workspaceId: 'w', project: 'project', path: root }],
    getSession: (_home, id) => id === 's' ? { workspaceId: 'w' } : null,
  } });
}

async function request(route, { body = Buffer.alloc(0), query = 'sessionId=s', headers = {} } = {}) {
  const req = new Readable({ read() {} });
  req.on('error', () => {});
  req.method = 'PUT';
  req.headers = { 'content-length': String(body.length), 'content-type': 'multipart/form-data; boundary=B', ...headers };
  const result = { headers: {} };
  const res = {
    setHeader(k, v) { result.headers[k] = v; },
    writeHead(status, fields) { result.status = status; Object.assign(result.headers, fields || {}); },
    end(payload) { result.body = payload ? JSON.parse(payload) : null; },
    destroy() { result.destroyed = true; },
  };
  const url = new URL(`http://127.0.0.1/api/homes/${HOME_ID}/upload?${query}`);
  // 先同步挂上上传处理（让解析器装好监听器），再灌数据。
  const pending = route(req, res, url).catch((e) => { result.error = e.message; });
  for (let i = 0; i < body.length; i += 1024) req.push(body.subarray(i, i + 1024));
  req.push(null);
  await pending;
  return result;
}

test('upload API: writes into the requested dir and returns a fresh listing', async (t) => {
  const { root } = await fixture(t);
  const body = multipartBody('B', [{ name: 'report.csv', data: 'x,y\n1,2\n' }]);
  const response = await request(makeRoute(root), { body, query: 'sessionId=s&dir=dir' });
  assert.equal(response.status, 200);
  assert.equal(response.body.files[0].name, 'report.csv');
  assert.equal(await readFile(path.join(root, 'dir', 'report.csv'), 'utf8'), 'x,y\n1,2\n');
  assert.equal(response.body.listing.kind, 'directory');
  assert.ok(response.body.listing.entries.some((entry) => entry.name === 'report.csv'));

  const again = await request(makeRoute(root), { body, query: 'sessionId=s&dir=dir' });
  assert.equal(again.body.files[0].name, 'report(1).csv');
});

test('upload API: blocks cross-site writes, bad targets and unknown instances', async (t) => {
  const { root } = await fixture(t);
  const body = multipartBody('B', [{ name: 'a.txt', data: 'x' }]);
  assert.equal((await request(makeRoute(root), { body, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await request(makeRoute(root), { body, headers: { origin: 'http://evil.example' } })).status, 403);
  assert.equal((await request(makeRoute(root), { body, query: 'sessionId=s&dir=../..' })).status, 400);
  assert.equal((await request(makeRoute(root), { body, query: 'sessionId=s&dir=escape-dir' })).status, 400);
  assert.equal((await request(makeRoute(root), { body, query: 'sessionId=s&dir=escape.txt' })).status, 400);
  assert.equal((await request(makeRoute(root), { body, query: 'sessionId=unknown' })).status, 400);
  assert.equal((await request(makeRoute(root), { body, headers: { 'content-type': 'text/plain' } })).status, 400);
  const unknown = createRouter({ store: { getHome: () => null, listWorkspaces: () => [], getSession: () => null } });
  assert.equal((await request(unknown, { body })).status, 404);
});
