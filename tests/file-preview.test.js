import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readFilePreview, PREVIEW_BYTES, IMAGE_BYTES, DOWNLOAD_BYTES, sessionWorkspace } from '../src/lib/file-preview.js';
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
