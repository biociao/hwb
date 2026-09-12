import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readFilePreview, HTML_BYTES, PREVIEW_BYTES } from '../src/lib/file-preview.js';
import { createRouter } from '../src/api/routes.js';

// HTML 预览：文件本体走 /asset 原字节渲染，因此这里要覆盖
// ① 识别成 html（而不是截断成 raw text）；② /asset 按真实 MIME 返回完整字节与安全头；
// ③ 越界/跨站/超限都被挡住。

const HTML = '<!doctype html><html><head><title>报告</title><style>h1{color:red}</style></head><body><h1>ver17 评估</h1></body></html>';

async function fixture(t) {
  const base = await mkdtemp(path.join(tmpdir(), 'hwb-html-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'project');
  await mkdir(path.join(root, 'report'), { recursive: true });
  await writeFile(path.join(root, 'report', 'index.html'), HTML);
  await writeFile(path.join(root, 'report', '页面.htm'), HTML);
  await writeFile(path.join(root, 'report', 'data.json'), '{"a":1}');
  await writeFile(path.join(root, 'notes.md'), '# 说明');
  await writeFile(path.join(base, 'outside.html'), '<html>secret</html>');
  return { base, root };
}

const local = { hostType: 'local' };
const remote = { hostType: 'remote', host: 'fixture' };
// 在本地跑真实的远端 Python 预览脚本（stdin 只给脚本，与 sshBash 一致）。
const execRemote = (_host, script, args) => new Promise((resolve) => {
  const proc = spawn('bash', ['-s', '--', ...args]);
  let stdout = '', stderr = '';
  proc.stdout.on('data', (d) => { stdout += d; });
  proc.stderr.on('data', (d) => { stderr += d; });
  proc.stdin.on('error', () => {});
  proc.on('close', (code) => resolve({ code, stdout, stderr }));
  proc.stdin.end(script);
});

for (const home of [local, remote]) {
  test(`html preview ${home.hostType}: reports kind=html with mime and size instead of truncated text`, async (t) => {
    const { root } = await fixture(t);
    const result = await readFilePreview(home, root, 'report/index.html', execRemote);
    assert.equal(result.kind, 'html');
    assert.equal(result.mime, 'text/html');
    assert.equal(result.size, Buffer.byteLength(HTML));
    assert.equal(result.content, undefined, 'html 不该把正文塞进 JSON');
    assert.equal((await readFilePreview(home, root, 'report/页面.htm', execRemote)).kind, 'html');
    // 非 HTML 不受影响：仍是文本/其他 kind
    assert.equal((await readFilePreview(home, root, 'report/data.json', execRemote)).kind, 'file');
    assert.equal((await readFilePreview(home, root, 'notes.md', execRemote)).kind, 'file');
  });

  test(`html preview ${home.hostType}: text request returns the page source (source view path)`, async (t) => {
    const { root } = await fixture(t);
    // 侧栏「源码」按钮发的就是 text=1：即使扩展名是 .html 也要走文本分支，
    // 否则只会拿到没有正文的 html 元数据。
    const source = await readFilePreview(home, root, 'report/index.html', execRemote, { text: true });
    assert.equal(source.kind, 'file');
    assert.equal(typeof source.content, 'string');
    assert.match(source.content, /ver17 评估/);
    assert.equal(source.binary, false);
  });

  test(`html preview ${home.hostType}: raw mode returns complete bytes for rendering`, async (t) => {
    const { root } = await fixture(t);
    const result = await readFilePreview(home, root, 'report/index.html', execRemote, { raw: true });
    const bytes = Buffer.isBuffer(result.data) ? result.data : Buffer.from(result.data, 'base64');
    assert.equal(bytes.toString('utf8'), HTML, 'raw 必须回完整原字节（不是前 24 KiB）');
    assert.equal(result.size, bytes.length);
    // 越界仍然被挡（raw 不改变沙箱范围）
    await assert.rejects(readFilePreview(home, root, '../outside.html', execRemote, { raw: true }), /项目目录/);
  });

  test(`html preview ${home.hostType}: oversized pages are rejected with a clear message`, async (t) => {
    const { root } = await fixture(t);
    // 用稀疏文件造一个超过 32 MiB 的 HTML：不必真写满磁盘。
    const { truncate } = await import('node:fs/promises');
    const big = path.join(root, 'report', 'big.html');
    await writeFile(big, '');
    await truncate(big, HTML_BYTES + 1);
    await assert.rejects(readFilePreview(home, root, 'report/big.html', execRemote), /32 MiB/);
    // 普通文本预览上限不受影响
    const bigText = path.join(root, 'big.txt');
    await writeFile(bigText, 'a'.repeat(PREVIEW_BYTES + 10));
    assert.equal((await readFilePreview(home, root, 'big.txt', execRemote)).truncated, true);
  });
}

// —— /asset 路由 ——
function makeRouter(root) {
  const homeId = 'abcdef1234567890';
  const route = createRouter({ store: {
    getHome: (id) => id === homeId ? { homeId, ...local } : null,
    listWorkspaces: () => [{ workspaceId: 'w', project: 'project', path: root }],
    getSession: (_home, id) => id === 's' ? { workspaceId: 'w' } : null,
  } });
  async function request(query, headers = {}, id = homeId) {
    const result = { headers: {} };
    const res = {
      setHeader(k, v) { result.headers[k] = v; },
      writeHead(status, fields) { result.status = status; Object.assign(result.headers, fields || {}); },
      end(body) { result.body = body; },
    };
    await route({ method: 'GET', headers }, res, new URL(`http://localhost/api/homes/${id}/asset?${query}`));
    return result;
  }
  return { request, homeId };
}

test('asset API: serves the page with text/html and hardening headers', async (t) => {
  const { root } = await fixture(t);
  const { request } = makeRouter(root);
  const result = await request('sessionId=s&path=report/index.html');
  assert.equal(result.status, 200);
  assert.equal(result.headers['Content-Type'], 'text/html; charset=utf-8');
  assert.equal(result.headers['Content-Length'], Buffer.byteLength(HTML));
  assert.equal(result.body.toString('utf8'), HTML);
  assert.equal(result.headers['X-Content-Type-Options'], 'nosniff');
  assert.match(result.headers['Content-Security-Policy'], /sandbox/);
  assert.doesNotMatch(result.headers['Content-Security-Policy'], /allow-scripts/);
  assert.equal(result.headers['X-Frame-Options'], 'SAMEORIGIN');
  // 其他类型也按扩展名给 MIME，未知类型退回二进制
  assert.equal((await request('sessionId=s&path=report/data.json')).headers['Content-Type'], 'application/json; charset=utf-8');
  assert.equal((await request('sessionId=s&path=notes.md')).headers['Content-Type'], 'text/plain; charset=utf-8');
});

test('preview API: text=1 makes .html return source text instead of html metadata', async (t) => {
  const { root } = await fixture(t);
  const homeId = 'abcdef1234567890';
  const route = createRouter({ store: {
    getHome: (id) => id === homeId ? { homeId, ...local } : null,
    listWorkspaces: () => [{ workspaceId: 'w', project: 'project', path: root }],
    getSession: (_home, id) => id === 's' ? { workspaceId: 'w' } : null,
  } });
  const ask = async (query) => {
    let body;
    const res = { setHeader() {}, writeHead() {}, end(payload) { body = JSON.parse(payload); } };
    await route({ method: 'GET', headers: {} }, res, new URL(`http://localhost/api/homes/${homeId}/preview?${query}`));
    return body;
  };
  const meta = await ask('sessionId=s&path=report/index.html');
  assert.equal(meta.kind, 'html');
  assert.equal(meta.content, undefined);
  const source = await ask('sessionId=s&path=report/index.html&text=1');
  assert.equal(source.kind, 'file');
  assert.match(source.content, /ver17 评估/);
});

test('asset API: confines to the workspace and rejects cross-site reads', async (t) => {
  const { root } = await fixture(t);
  const { request } = makeRouter(root);
  assert.equal((await request('sessionId=s&path=../outside.html')).status, 400);
  assert.equal((await request('sessionId=s&path=report/index.html', { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await request('sessionId=unknown')).status, 400);
  assert.equal((await request('sessionId=s&path=report', {}, '0000000000000000')).status, 404);
  // 目录不能走 asset
  assert.equal((await request('sessionId=s&path=report')).status, 400);
});
