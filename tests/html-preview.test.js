import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readFilePreview, HTML_BYTES, PREVIEW_BYTES } from '../src/lib/file-preview.js';

// HTML 预览的**引擎侧**行为：① 识别成 html（而不是截断成 raw text）；② text=1 拿源码；
// ③ raw 回完整原字节；④ 越界与超限都被挡住。
// 渲染层（曾经由 hwb 侧栏的 <iframe> 承担，走已删除的 /asset 端点）已经并入 dsh 自带的文档预览，
// 所以这里只剩 readFilePreview 本身 —— 它仍是下载与「上传后目录列举」共用的那个引擎。

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
    // text=1 就是「要源码」那个模式：即使扩展名是 .html 也要走文本分支，
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

