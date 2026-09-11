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
    assert.equal(body.homes[0].endpoints[0].token, undefined, '端点 token 同样不该回传');
    assert.equal(body.homes[0].endpoints[0].tokenSet, true, '改为 tokenSet 告知界面「已配置」');
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

// endpoints[].token 原先也一并回传（理由是端点编辑器要预填，否则保存会抹掉）。
// 现在改成「不回传 + 留空即保持不变」：出站给 tokenSet，更新时客户端不传就沿用已存值，
// 要清除必须显式 tokenClear。这样凭据不再交给浏览器，同时「打开设置再保存」不会静默清除。
test('endpoints: 不回传端点 token，且「留空保持不变 / 显式清除」语义正确', async () => {
  const store = new IndexStore(':memory:');
  const homeId = store.registerHome({
    homePath: 'ssh://bot@x', hostType: 'remote', host: 'bot@x',
    endpoints: [{ id: 'ep-1', label: '主线', host: 'bot@x', port: 3080, token: 'EP-SECRET-1' },
      { id: 'ep-2', label: '备线', host: 'bot@y', port: 3080, token: 'EP-SECRET-2' }],
    activeEndpointId: 'ep-1',
  });
  const server = createApiServer({
    store, indexer: { reindexNow: async () => [] }, hub: { broadcast() {}, handle() {} },
    launcher: { status: () => null }, monitor: { get: () => ({ runtime: 'stopped' }), refresh: async () => {} },
    quota: { list: () => [], refresh: async () => ({}) }, logApi: { getLogs: () => [] }, webRoot: '/nonexistent',
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const text = await (await fetch(`${base}/api/homes`)).text();
    assert.doesNotMatch(text, /EP-SECRET/, '端点 token 不该再回传');
    const body = JSON.parse(text);
    assert.equal(body.homes[0].endpoints[0].token, undefined);
    assert.equal(body.homes[0].endpoints[0].tokenSet, true, '应告诉界面「已配置」以便提示留空含义');
    assert.equal(body.homes[0].endpoints[1].tokenSet, true);

    const patch = (payload) => fetch(`${base}/api/homes/${homeId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: base, host: new URL(base).host },
      body: JSON.stringify(payload),
    });
    // ① 客户端不回传 token（界面不再知道它）→ 必须沿用已存的
    const kept = await patch({ endpoints: [{ id: 'ep-1', label: '改名', host: 'bot@x', port: 3080, tokenSet: true },
      { id: 'ep-2', label: '备线', host: 'bot@y', port: 3080, tokenSet: true }] });
    assert.equal(kept.status, 200, await kept.text());
    assert.equal(store.getHome(homeId).endpoints[0].token, 'EP-SECRET-1', '留空不该把 token 抹掉');
    assert.equal(store.getHome(homeId).endpoints[0].label, '改名');
    assert.equal(store.getHome(homeId).endpoints[1].token, 'EP-SECRET-2');

    // ② 显式清除
    const cleared = await patch({ endpoints: [{ id: 'ep-1', label: '改名', host: 'bot@x', port: 3080, tokenClear: true },
      { id: 'ep-2', label: '备线', host: 'bot@y', port: 3080, tokenSet: true }] });
    assert.equal(cleared.status, 200, await cleared.text());
    assert.equal(store.getHome(homeId).endpoints[0].token, null, 'tokenClear 应真的清除');
    assert.equal(store.getHome(homeId).endpoints[1].token, 'EP-SECRET-2', '只清被标记的那个端点');

    // ③ 显式设置新 token
    await patch({ endpoints: [{ id: 'ep-1', label: '改名', host: 'bot@x', port: 3080, token: 'NEW-TOKEN' },
      { id: 'ep-2', label: '备线', host: 'bot@y', port: 3080, tokenSet: true }] });
    assert.equal(store.getHome(homeId).endpoints[0].token, 'NEW-TOKEN');
  } finally { await new Promise((r) => server.close(r)); store.close(); }
});
