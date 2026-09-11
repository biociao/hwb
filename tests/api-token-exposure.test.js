import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IndexStore } from '../src/dshhome/store.js';
import { createApiServer } from '../src/api/server.js';

// `GET /api/homes` 曾经把每个实例的 dsh **token** 原样回给客户端。
//
// token 是控制凭据（持有它 = 持有那个 dsh 实例：能执行 shell、写文件），而这个 API 在回环上
// **没有鉴权** —— 任何本机进程一条 curl 就能拿到全部实例的凭据（实测就是这样拿到明文
// SUPER-SECRET-LAUNCH-TOKEN 的）。而界面并不需要它：带 token 的 iframe 入口由
// `POST /homes/{id}/open` 现取现用，PATCH 也只在客户端**显式**传 token 时才改它。
//
// 这条测试同时守住「不要为了遮掉一个字段而把更新流程弄坏」：PATCH 不传 token 必须保留原值，
// 显式传空串才清除。

const SECRET = 'SUPER-SECRET-LAUNCH-TOKEN';

async function withServer(fn) {
  const store = new IndexStore(':memory:');
  const homeId = store.registerHome({ homePath: '/tmp', hostType: 'local', token: SECRET, localPort: 4444 });
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
  try { return await fn({ base, store, homeId }); }
  finally { await new Promise((r) => server.close(r)); store.close(); }
}

test('GET /api/homes 不再回传 dsh token（它只是更新时才需要的凭据）', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/api/homes`);
    const text = await res.text();
    assert.equal(res.status, 200);
    const body = JSON.parse(text);
    assert.equal(body.homes.length, 1);
    assert.equal(body.homes[0].token, undefined, '顶层 token 不该再回传（界面用不到，凭据少一份就少一份）');
    // 其它字段照旧（别把整个对象都弄没了）
    assert.equal(body.homes[0].homeId.length, 16);
    assert.equal(body.homes[0].localPort, 4444);
    // **诚实的残留**：endpoints[].token 仍在响应里 —— 连接端点编辑器需要它做预填，
    // 而 readEndpoints() 会把输入框的值原样回传，预填为空就等于「保存时把 token 抹掉」。
    // 所以这次只去掉顶层那份冗余字段，**没有**关闭凭据暴露这条路（真正的原因是这个 API 无鉴权，
    // 见 README「安全边界」）。这里把现状钉住：谁要改这一条，必须同时处理 UI 的预填与清除语义。
    assert.equal(body.homes[0].endpoints[0].token, SECRET,
      '端点 token 目前仍需回传（端点编辑器预填依赖它）——若要收掉，必须同步改编辑器与保存语义');
  });
});

test('PATCH 不传 token 时保留原值，显式传空串才清除', async () => {
  await withServer(async ({ base, store, homeId }) => {
    const patch = (body) => fetch(`${base}/api/homes/${homeId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: base, host: new URL(base).host },
      body: JSON.stringify(body),
    });
    const renamed = await patch({ alias: 'renamed' });
    if (renamed.status !== 200) assert.fail(`PATCH 失败：${renamed.status} ${await renamed.text()}`);
    assert.equal(store.getHome(homeId).alias, 'renamed');
    assert.equal(store.getHome(homeId).token, SECRET, '局部更新不该把没提到的 token 抹掉');

    const cleared = await patch({ token: '' });
    if (cleared.status !== 200) assert.fail(`PATCH 失败：${cleared.status} ${await cleared.text()}`);
    assert.equal(store.getHome(homeId).token, null, '显式传空串应清除');

    const reset = await patch({ token: SECRET });
    if (reset.status !== 200) assert.fail(`PATCH 失败：${reset.status} ${await reset.text()}`);
    assert.equal(store.getHome(homeId).token, SECRET);
    // 响应里同样不带 token
    const body = await reset.json();
    assert.equal(body.home.token, undefined);
  });
});
