import { test } from 'node:test';
import assert from 'node:assert/strict';
import { downloadFile, uploadFiles, partitionUploads, MAX_UPLOAD_BYTES } from '../src/web/file-ops.js';

// file-ops 是 hwb 父页真正发请求的那一层：dsh 侧栏里注入的控件只把「下载这个文件 / 把这些文件
// 传到这个目录」转过来。这里用最小假环境（fetch / document / XMLHttpRequest）覆盖：
//   · 下载：成功 → 交给浏览器保存；失败 → 抛出服务端的错误文案（父页据此记顶栏提示）
//   · 上传：串行、进度是整批语义、同名改名与逐条失败都不吞
//   · 上限：超 256 MiB 的文件在本地就分出去，不进入上传

function fakeFile(name, size = 10) { return { name, size, type: 'application/octet-stream' }; }

function withGlobals(overrides, run) {
  const saved = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  return Promise.resolve()
    .then(run)
    .finally(() => {
      for (const [key, descriptor] of saved) {
        if (descriptor === undefined) delete globalThis[key];
        else Object.defineProperty(globalThis, key, descriptor);
      }
    });
}

test('downloadFile：成功时用文件名触发浏览器保存，失败时抛出服务端文案', async (t) => {
  // objectURL 不能被立刻 revoke（部分浏览器会来不及取字节），所以用假时钟把那个 60s 窗口也钉住。
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const links = [];
  const revoked = [];
  class FakeURL extends URL {
    static createObjectURL(blob) { return `blob:${blob?.size ?? 0}`; }
    static revokeObjectURL(url) { revoked.push(url); }
  }
  const doc = {
    body: { append: (node) => links.push(node) },
    createElement: (tag) => ({
      tag, href: '', download: '',
      click() { this.clicked = true; },
      remove() { this.removed = true; },
    }),
  };
  await withGlobals({
    URL: FakeURL,
    document: doc,
    fetch: async (url) => {
      assert.equal(url, '/api/homes/h1/download?path=%2Fw%2Fout.csv');
      return { ok: true, blob: async () => ({ size: 42 }) };
    },
  }, async () => {
    await downloadFile('h1', {}, '/w/out.csv');
    assert.equal(links.length, 1);
    assert.equal(links[0].download, 'out.csv', '保存名取路径最后一段');
    assert.equal(links[0].clicked, true);
    assert.equal(links[0].removed, true, '点完要立刻摘掉 a 节点');
    assert.deepEqual(revoked, [], '刚点完还不能收回 objectURL');
    t.mock.timers.tick(59999);
    assert.deepEqual(revoked, [], '窗口未到不收回');
    t.mock.timers.tick(1);
    assert.deepEqual(revoked, ['blob:42'], '窗口到了才收回，避免内存长期挂着');
  });

  await withGlobals({
    URL: FakeURL,
    document: doc,
    fetch: async () => ({ ok: false, status: 403, json: async () => ({ error: '不允许跨站读取文件' }) }),
  }, async () => {
    await assert.rejects(() => downloadFile('h1', {}, '/w/out.csv'), /不允许跨站读取文件/);
  });
});

test('uploadFiles：串行上传、进度是整批语义、改名与失败都不吞', async () => {
  const calls = [];
  const progress = [];
  const put = async (homeId, params, dir, file, onProgress) => {
    calls.push({ homeId, params, dir, name: file.name });
    onProgress(0.5);
    if (file.name === 'bad.csv') throw new Error('HTTP 400');
    return file.name === 'dup.csv' ? { name: 'dup(1).csv' } : { name: file.name };
  };
  const result = await uploadFiles('h1', { sessionId: 's1' }, '/w/analyses',
    [fakeFile('a.csv'), fakeFile('dup.csv'), fakeFile('bad.csv')],
    (percent) => progress.push(percent), { put });
  assert.deepEqual(calls.map((c) => c.name), ['a.csv', 'dup.csv', 'bad.csv'], '逐个、按顺序（不并发）');
  assert.deepEqual(calls[0].params, { sessionId: 's1' });
  assert.equal(calls[0].dir, '/w/analyses');
  // 3 个文件、每个 50%：整批进度分别是 16 / 50 / 83。
  assert.deepEqual(progress, [17, 50, 83]);
  assert.equal(result.uploaded, 2);
  assert.deepEqual(result.renamed, ['dup.csv → dup(1).csv']);
  assert.deepEqual(result.failed, ['bad.csv（HTTP 400）']);
});

test('uploadFiles：全部失败时 uploaded=0（由调用方决定怎么报，不静默）', async () => {
  const result = await uploadFiles('h1', {}, '/w', [fakeFile('a.csv')], undefined,
    { put: async () => { throw new Error('网络错误，上传未完成'); } });
  assert.equal(result.uploaded, 0);
  assert.deepEqual(result.failed, ['a.csv（网络错误，上传未完成）']);
});

test('partitionUploads：超过 256 MiB 的分出去，边界值（恰好等于上限）算可以传', () => {
  const files = [fakeFile('ok.bin', MAX_UPLOAD_BYTES), fakeFile('huge.bin', MAX_UPLOAD_BYTES + 1), fakeFile('small.txt', 1)];
  const { accepted, oversize } = partitionUploads(files);
  assert.deepEqual(accepted.map((f) => f.name), ['ok.bin', 'small.txt']);
  assert.deepEqual(oversize.map((f) => f.name), ['huge.bin']);
  // 脏数据（缺 size）按 0 处理而不是崩掉：顶多让服务端再挡一次。
  assert.deepEqual(partitionUploads([{ name: 'x' }]).accepted.length, 1);
  assert.deepEqual(partitionUploads(undefined), { accepted: [], oversize: [] });
});
