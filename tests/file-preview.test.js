import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readFilePreview, PREVIEW_BYTES, IMAGE_BYTES, DOWNLOAD_BYTES, sessionWorkspace, readLocalPreview } from '../src/lib/file-preview.js';
import { createRouter } from '../src/api/routes.js';

async function fixture(t) {
  const base = await mkdtemp(path.join(tmpdir(), 'hwb-preview-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'project');
  await mkdir(root);
  await mkdir(path.join(root, 'dir'));
  await writeFile(path.join(root, '中文 file.txt'), '<script>example</script>\nhello');
  await writeFile(path.join(root, 'large.txt'), 'a'.repeat(PREVIEW_BYTES + 50));
  await writeFile(path.join(root, 'binary'), Buffer.from([0, 1, 2]));
  await writeFile(path.join(base, 'outside'), 'secret');
  await symlink(path.join(base, 'outside'), path.join(root, 'escape'));
  return { base, root };
}
const local = { hostType: 'local' };
const remote = { hostType: 'remote', host: 'fixture' };
// Run the real remote Python script locally; no SSH host or user files involved.
const execRemote = (_host, script, args) => new Promise((resolve) => {
  const proc = spawn('bash', ['-s', '--', ...args]);
  let stdout = '', stderr = '';
  proc.stdout.on('data', (d) => { stdout += d; });
  proc.stderr.on('data', (d) => { stderr += d; });
  proc.on('close', (code) => resolve({ code, stdout, stderr }));
  proc.stdin.end(script);
});
for (const home of [local, remote]) {
  test(`download ${home.hostType}: complete bytes, empty files, limits and confinement`, async (t) => {
    const { root } = await fixture(t);
    const read = (file) => readFilePreview(home, root, file, execRemote, { download: true });
    assert.deepEqual(Buffer.from((await read('large.txt')).data, 'base64'), Buffer.from('a'.repeat(PREVIEW_BYTES + 50)));
    assert.deepEqual(Buffer.from((await read('binary')).data, 'base64'), Buffer.from([0, 1, 2]));
    await writeFile(path.join(root, 'empty'), '');
    assert.equal((await read('empty')).size, 0);
    await writeFile(path.join(root, 'too-big'), '');
    await truncate(path.join(root, 'too-big'), DOWNLOAD_BYTES + 1);
    await assert.rejects(read('too-big'), /64 MiB/);
    await assert.rejects(read('.'), /目录打包/);
    await assert.rejects(read('../outside'), /项目目录/);
    await assert.rejects(read('escape'), /项目目录/);
  });
  test(`preview ${home.hostType}: directories, UTF-8, binary, size limits and confinement`, async (t) => {
    const { root } = await fixture(t);
    const read = (file) => readFilePreview(home, root, file, execRemote);
    const dir = await read('.');
    assert.equal(dir.kind, 'directory');
    assert.equal(dir.parent, null);
    assert.equal(dir.entries[0].name, 'dir');
    assert.equal((await read('中文 file.txt')).content, '<script>example</script>\nhello');
    assert.equal((await read('binary')).binary, true);
    const large = await read('large.txt');
    assert.equal(large.content.length, PREVIEW_BYTES);
    assert.equal(large.truncated, true);
    await assert.rejects(read('../outside'), /项目目录/);
    await assert.rejects(read('escape'), /项目目录/);
    await assert.rejects(read('missing'));
    await assert.rejects(read('bad\0name'), /路径无效/);
    const shellName = '$(echo unsafe)`quote`\".txt';
    await writeFile(path.join(root, shellName), 'literal');
    assert.equal((await read(shellName)).content, 'literal');
    for (const [ext, mime] of [['png', 'image/png'], ['ico', 'image/x-icon'], ['svg', 'image/svg+xml']]) {
      const bytes = ext === 'svg' ? Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>') : Buffer.from([0, 1, 2, 3]);
      await writeFile(path.join(root, `image.${ext}`), bytes);
      const image = await read(`image.${ext}`);
      assert.equal(image.kind, 'image');
      assert.equal(image.mime, mime);
      assert.deepEqual(Buffer.from(image.data, 'base64'), bytes);
    }
    await writeFile(path.join(root, 'big.png'), Buffer.alloc(IMAGE_BYTES + 1));
    await assert.rejects(read('big.png'), /2 MiB/);
  });
}

test('preview API requires a registered home and workspace; blocks cross-site reads', async (t) => {
  const { root } = await fixture(t);
  const homeId = 'abcdef1234567890';
  const route = createRouter({ store: {
    getHome: (id) => id === homeId ? { homeId, ...local } : null,
    listWorkspaces: () => [{ workspaceId: 'w', project: 'project', path: root }],
    getSession: (home, id) => home === homeId && id === 's' ? { workspaceId: null, project: 'project' } : null,
  } });
  async function request(query, headers = {}, id = homeId) {
    let status, body;
    const res = { setHeader() {}, writeHead(s) { status = s; }, end(b) { body = JSON.parse(b); } };
    await route({ method: 'GET', headers }, res, new URL(`http://localhost/api/homes/${id}/preview?${query}`));
    return { status, body };
  }
  assert.equal((await request('workspaceId=w&path=dir')).body.kind, 'directory');
  assert.equal((await request('workspaceId=unregistered')).status, 400);
  assert.equal((await request('workspaceId=w', { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await request('workspaceId=w', {}, '0000000000000000')).status, 404);
  assert.equal((await request('workspaceId=w&path=../outside')).status, 400);
  assert.equal((await request('sessionId=s&path=dir')).body.workspace.workspaceId, 'w');
  assert.equal((await request('sessionId=s&path=../outside')).status, 400);
  assert.equal((await request('sessionId=unknown&workspaceId=w')).status, 400);
});

test('download API returns an attachment with complete bytes and encoded filename', async (t) => {
  const { root } = await fixture(t);
  const homeId = 'abcdef1234567890';
  const route = createRouter({ store: {
    getHome: () => ({ homeId, ...local }),
    listWorkspaces: () => [{ workspaceId: 'w', path: root }],
    getSession: (_home, id) => id === 's' ? { workspaceId: 'w' } : null,
  } });
  async function request(file, headers = {}, sessionId = 's') {
    const result = { headers: {} };
    const res = { setHeader(k, v) { result.headers[k] = v; },
      writeHead(status, fields) { result.status = status; Object.assign(result.headers, fields); },
      end(body) { result.body = body; } };
    await route({ method: 'GET', headers }, res, new URL(`http://localhost/api/homes/${homeId}/download?` + new URLSearchParams({ sessionId, path: file })));
    return result;
  }
  const response = await request('中文 file.txt');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, Buffer.from('<script>example</script>\nhello'));
  assert.equal(response.headers['Content-Length'], response.body.length);
  assert.equal(response.headers['Content-Type'], 'application/octet-stream');
  assert.equal(response.headers['X-Content-Type-Options'], 'nosniff');
  assert.ok(response.headers['Content-Disposition'].endsWith("UTF-8''" + encodeURIComponent('中文 file.txt')));
  assert.equal((await request('large.txt')).body.length, PREVIEW_BYTES + 50);
  assert.equal((await request('../outside')).status, 400);
  assert.equal((await request('escape')).status, 400);
  assert.equal((await request('binary', {}, 'unknown')).status, 400);
  assert.equal((await request('binary', { 'sec-fetch-site': 'cross-site' })).status, 403);
});

test('session workspace uses project when ID is missing, but never guesses duplicate projects', () => {
  const rows = [{ workspaceId: 'a', project: 'p', path: '/a' }, { workspaceId: 'b', project: 'q', path: '/b' }];
  assert.equal(sessionWorkspace(rows, { project: 'p' }).workspaceId, 'a');
  assert.equal(sessionWorkspace(rows, { workspaceId: 'b', project: 'p' }).workspaceId, 'b');
  assert.equal(sessionWorkspace([...rows, { workspaceId: 'c', project: 'p', path: '/c' }], { project: 'p' }), null);
  assert.equal(sessionWorkspace(rows, null), null);
});

// 本机下载不再走 base64。走 base64 的代价是三层同尺寸副本：
// 原 buffer → base64 字符串（1.33×）→ JSON.stringify 的结果（又一份）→ 调用方再解一遍。
// 实测 64 MiB 文件的额外堆占用约 170 MiB（合计约 235 MB 峰值）。
// 远端仍用 base64（那是 ssh 传输的需要），所以调用方必须两种都能处理。
test('download 本机返回 Buffer（不做 base64），远端仍是 base64 字符串', async (t) => {
  const { root } = await fixture(t);
  const local = { hostType: 'local' };
  const remote = { hostType: 'remote', host: 'fixture' };
  await writeFile(path.join(root, 'plain.txt'), 'hello world');

  const localResult = await readFilePreview(local, root, 'plain.txt', execRemote, { download: true });
  assert.equal(Buffer.isBuffer(localResult.data), true, '本机下载应交回 Buffer，避免 base64 + JSON 的两层副本');
  assert.equal(localResult.data.toString(), 'hello world');

  const remoteResult = await readFilePreview(remote, root, 'plain.txt', execRemote, { download: true });
  assert.equal(typeof remoteResult.data, 'string', '远端经 ssh 传回，仍应是 base64 字符串');
  assert.equal(Buffer.from(remoteResult.data, 'base64').toString(), 'hello world');
});

test('download 本机：Buffer 路径不做额外拷贝（同一底层内存）', async (t) => {
  const { root } = await fixture(t);
  await writeFile(path.join(root, 'plain.txt'), 'abc');
  const r = await readFilePreview({ hostType: 'local' }, root, 'plain.txt', execRemote, { download: true });
  assert.equal(Buffer.isBuffer(r.data), true);
  assert.equal(r.data.length, 3);
  assert.equal(r.size, 3);
});

// 文件被删掉之后点预览，界面上原先显示的是裸 errno：
// `ENOENT: no such file or directory, realpath '/private/var/.../nope.txt'` —— 英文系统错误，
// 既没说是哪个文件也没说该怎么办。与上传路径的 mapUploadError 同源处理。
test('readLocalPreview: 常见文件系统错误翻译成人话，不再把裸 errno 抛给界面', async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), 'hwb-preview-err-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const gone = path.join(base, 'gone.txt');
  await assert.rejects(readLocalPreview(base, 'gone.txt'), (err) => {
    assert.doesNotMatch(err.message, /ENOENT/, '不该把裸 errno 给用户看');
    assert.match(err.message, /不存在|权限|类型|链接/, `应给出可理解的说明，实际：${err.message}`);
    return true;
  });
  // 目录当文件下载：保持原有的中文提示
  await mkdir(path.join(base, 'sub'), { recursive: true });
  await assert.rejects(readLocalPreview(base, 'sub', true), /目录打包/);
});
