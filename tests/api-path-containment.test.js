import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { IndexStore } from '../src/dshhome/store.js';
import { createApiServer } from '../src/api/server.js';

// preview / download 两条路由的**路径围栏**：它们把 `?path=` 交给 file-preview 解析，
// 而围栏（realpath + commonpath 校验、符号链接拒绝）是「用户项目目录之外的文件一道都读不到」
// 的唯一保证。单元测试覆盖了解析函数，这里补上**路由级**的端到端验证 —— 路由的接线
// （workspaceId/sessionId 的解析、400 的返回、正常的 200）只有真发 HTTP 才测得到。
//
// 实测过的形态（都必须 400 且**一个字节都不回**）：相对越界、绝对路径、符号链接文件、
// 符号链接目录、内嵌 `..`、URL 编码的 `..%2F`。正常工作区内文件必须 200。

function workspaceFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'hwb-fence-'));
  const proj = path.join(dir, 'proj');
  mkdirSync(proj, { recursive: true });
  writeFileSync(path.join(dir, 'SECRET.txt'), 'TOP SECRET\n');
  writeFileSync(path.join(proj, 'ok.txt'), 'ok\n');
  symlinkSync(path.join(dir, 'SECRET.txt'), path.join(proj, 'link.txt'));
  symlinkSync('/etc', path.join(proj, 'etcdir'));
  return { dir, proj };
}

async function withServer(fn) {
  const { dir, proj } = workspaceFixture();
  const store = new IndexStore(':memory:');
  const homeId = store.registerHome({ homePath: '/fake/home', hostType: 'local' });
  store.upsertRows([
    { type: 'home', homeId, homePath: '/fake/home', generatedAt: new Date().toISOString(), degraded: [] },
    { type: 'workspace', homeId, workspaceId: 'ws-1', title: 'T', path: proj, project: 'proj', archived: 0, sessionCount: 1 },
    { type: 'session', homeId, sessionId: 's1', workspaceId: 'ws-1', workspaceTitle: 'T', project: 'proj', title: 't',
      tokenUsage: null, contextPressure: null, status: null, lastActivity: new Date().toISOString(),
      generatedAt: new Date().toISOString(), liveOnly: 0 },
  ]);
  const server = createApiServer({
    store,
    indexer: { reindexNow: async () => [] },
    hub: { broadcast() {}, handle() {} },
    launcher: { status: () => null },
    monitor: { get: () => ({ runtime: 'stopped' }), refresh: async () => {} },
    quota: { list: () => [], refresh: async () => ({}) },
    logApi: { getLogs: () => [] },
    webRoot: '/nonexistent-web-root',
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn({ base, homeId, dir, proj }); }
  finally { await new Promise((r) => server.close(r)); store.close(); rmSync(dir, { recursive: true, force: true }); }
}

test('preview/download: 工作区之外的路径与符号链接一律拒绝（路由级）', async () => {
  await withServer(async ({ base, homeId, dir }) => {
    const attempts = [
      ['相对越界', '../../SECRET.txt'],
      ['绝对路径', path.join(dir, 'SECRET.txt')],
      ['符号链接文件', 'link.txt'],
      ['符号链接目录', 'etcdir/passwd'],
      ['内嵌 ..', 'sub/../../SECRET.txt'],
      ['URL 编码 ..%2F', '..%2F..%2FSECRET.txt'],
    ];
    for (const [label, p] of attempts) {
      for (const route of ['download', 'preview']) {
        const res = await fetch(`${base}/api/homes/${homeId}/${route}?workspaceId=ws-1&path=${encodeURIComponent(p)}`);
        const text = await res.text();
        assert.equal(res.status, 400, `${label} 必须 400（实际 ${res.status}）`);
        assert.doesNotMatch(text, /TOP SECRET|root:/, `${label} 泄漏了工作区外的内容`);
      }
    }
    // 对照：工作区内的正常文件必须能读
    const ok = await fetch(`${base}/api/homes/${homeId}/download?workspaceId=ws-1&path=${encodeURIComponent('ok.txt')}`);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), 'ok\n');

    // 预检请求的跨站头也必须挡住（这条围栏在路径校验之前）
    const cross = await fetch(`${base}/api/homes/${homeId}/download?workspaceId=ws-1&path=${encodeURIComponent('ok.txt')}`,
      { headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(cross.status, 403, '跨站读取必须在路径校验之前就被拒');
  });
});

test('preview/download: 未知 workspaceId 不泄漏任何文件内容', async () => {
  await withServer(async ({ base, homeId }) => {
    for (const route of ['download', 'preview']) {
      const res = await fetch(`${base}/api/homes/${homeId}/${route}?workspaceId=nope&path=${encodeURIComponent('ok.txt')}`);
      assert.ok(res.status >= 400, `${route} 未知 workspace 必须报错（实际 ${res.status}）`);
      assert.doesNotMatch(await res.text(), /TOP SECRET|ok\n/, `${route} 不该回文件内容`);
    }
  });
});
