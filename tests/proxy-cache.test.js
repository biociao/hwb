import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createProxy } from '../src/control/proxy.js';
// 增量补差默认关闭（见 proxy.js 的 HISTORY_DELTA_ENABLED 注释）：相关用例在 createProxy 上显式打开。
import { createProxyCache } from '../src/control/proxy-cache.js';

// —— 为什么有这些用例（2026-09-14，dgx21.tun 实测）——
//
// 远端 dsh 给插件 bundle 回 `cache-control: no-cache` 且不带 ETag，浏览器每次打开页面
// 都要把这 3.27 MiB 重下一遍（这条 VPN 只有 25–30 KB/s ⇒ 每次约 2 分钟）；会话列表/历史
// 走 POST RPC，浏览器在 HTTP 语义上无法缓存。于是缓存只能做在 hwb 代理这一层。
// 这些用例守住三件事：**该缓存的真缓存（含命中后不再打上游）**、
// **不该缓存的绝不缓存（无指纹的 URL、写类 RPC、鉴权响应）**、**回放不改语义（rpcId 必须换回本次的）**。

const BUNDLE = '/plugins/dsh-drop-any-file/client.js?rev=9eae050df40e';
const BUNDLE_BODY = '/* plugin bundle */'.repeat(64);

/**
 * `apiDelayMs`：让 `/api/*` 的响应慢一点。
 * 单飞（stale-while-revalidate）只有在**刷新还没回来**的时候才可能被观测到：
 * 上游秒回时，「5 次陈旧命中压了几条上游请求」就退化成机器调度问题 ——
 * CI 上实测过 3 次（本机 1 次）而红，那是在测调度、不是在测单飞。
 * 想验「慢链路上不会每个陈旧命中都压一条」，就得真的把上游变慢。
 */
function mockUpstream({ apiDelayMs = 0 } = {}) {
  const hits = new Map();
  const server = createServer((req, res) => {
    const key = `${req.method} ${req.url}`;
    hits.set(key, (hits.get(key) ?? 0) + 1);
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (req.url === BUNDLE) {
        // 远端 0.1.1 的真实形状：no-cache 且没有任何校验器。
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' });
        res.end(BUNDLE_BODY);
        return;
      }
      if (req.url === '/plugins/bar/client.js') {
        // 不带内容指纹的插件 URL：内容可以原地变化 —— 不许缓存。
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
        res.end(`/* bar ${hits.get(key)} */`);
        return;
      }
      if (req.url.startsWith('/api/')) {
        const envelope = JSON.parse(body);
        const respond = () => {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, method: envelope.method, value: { items: [{ sessionId: 's1', running: false }, { sessionId: 's2', running: true }] } } }));
        };
        if (apiDelayMs > 0) setTimeout(respond, apiDelayMs);
        else respond();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'auth=1; Path=/' });
      res.end('<html>index</html>');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server,
    base: `http://127.0.0.1:${server.address().port}`,
    hits,
    count: (m, u) => hits.get(`${m} ${u}`) ?? 0,
  })));
}

async function withProxy(up, opts = {}) {
  const cache = opts.cache === undefined ? createProxyCache({ dir: null }) : opts.cache;
  const proxy = await createProxy({ target: up.base, cache, cacheScope: opts.scope ?? 'home-test' });
  return proxy;
}

function rpcBody(method, rpcId, args = { _request: {} }) {
  return JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } });
}

test('proxy 缓存：插件 bundle 第二次打开不再打上游（这就是「每次都要下载」的正解）', async () => {
  const up = await mockUpstream();
  const proxy = await withProxy(up);
  try {
    const r1 = await fetch(`${proxy.url}${BUNDLE}`);
    assert.equal(r1.status, 200);
    assert.equal(await r1.text(), BUNDLE_BODY);
    assert.equal(up.count('GET', BUNDLE), 1);

    const r2 = await fetch(`${proxy.url}${BUNDLE}`);
    assert.equal(r2.status, 200);
    assert.equal(await r2.text(), BUNDLE_BODY);
    assert.equal(up.count('GET', BUNDLE), 1, '第二次必须由本地副本作答');
    assert.equal(r2.headers.get('x-hwb-cache'), 'hit');
    // 上游的 no-cache 策略原样保留（我们不改写上游策略），但**必须**补上校验器 ——
    // 远端 dsh 0.1.1 恰恰是「no-cache 且没有 ETag」，浏览器因此只能整包重下。
    assert.equal(r2.headers.get('cache-control'), 'no-cache');
    assert.ok(r2.headers.get('etag'), '命中回放也要带 ETag，浏览器才能只发一次条件请求');

    // 第一次（回源）**故意不带 ETag**：它是边流边攒的，为了让字节立刻开始流动
    // （见 onCacheableResponse 里静态分支的说明）。校验器从**第二次**（本地命中）起就有，
    // 而第二次是本地秒回，所以浏览器只多付一次本地请求。
    const etag = r2.headers.get('etag');
    const r3 = await fetch(`${proxy.url}${BUNDLE}`, { headers: { 'if-none-match': etag } });
    assert.equal(r3.status, 304, '拿着命中回放的 ETag 回来应当是 304');
    assert.equal(up.count('GET', BUNDLE), 1);
  } finally {
    await proxy.close();
    up.server.close();
  }
});

test('proxy 缓存：回源那一趟就开始流式下发（不攒完整包才发头）', async () => {
  // 这条守住「加载中断」的正解：原先静态响应要**攒完整个 body**（一次 combo 实测 10.8 MB）
  // 才 writeHead，那条链路上是分钟级，浏览器期间收不到一个字节。
  // 现在第一次响应就立刻发头并逐块下发；上游总字节仍被完整缓存下来。
  const up = await mockUpstream();
  // 让上游分多块、慢一点发，好观测「头先到、body 后到」。
  up.server.removeAllListeners('request');
  const chunk = Buffer.from('/* plugin bundle */'.repeat(4096));
  up.server.on('request', (req, res) => {
    if (req.url !== BUNDLE) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' });
    res.write(chunk.slice(0, 1024));
    setTimeout(() => { res.write(chunk.slice(1024)); res.end(); }, 120);
  });
  const cache = createProxyCache({ dir: null });
  const proxy = await createProxy({ target: up.base, cache, cacheScope: 'home-stream' });
  try {
    const started = Date.now();
    const res = await fetch(`${proxy.url}${BUNDLE}`);
    const firstByteMs = Date.now() - started;
    const text = await res.text();
    assert.equal(text.length, chunk.length, '流式下发也必须逐字节完整');
    assert.ok(firstByteMs < 120, `响应头应在最后一个数据块之前就到（实测 ${firstByteMs}ms，上游末尾延迟 120ms）`);
    // 缓存照样落地：下一次是本地命中。
    const again = await fetch(`${proxy.url}${BUNDLE}`);
    assert.equal(again.headers.get('x-hwb-cache'), 'hit');
    assert.equal(await again.text(), text);
  } finally {
    await proxy.close();
    up.server.close();
  }
});

test('proxy 缓存：无内容指纹的插件 URL 与带 token 的入口一律不缓存', async () => {
  const up = await mockUpstream();
  const proxy = await withProxy(up);
  try {
    await fetch(`${proxy.url}/plugins/bar/client.js`);
    await fetch(`${proxy.url}/plugins/bar/client.js`);
    assert.equal(up.count('GET', '/plugins/bar/client.js'), 2, '没有指纹的 URL 内容可原地变化，绝不能缓存');

    // 鉴权响应（set-cookie）不进缓存：两次都必须是上游的。
    const a = await fetch(`${proxy.url}/`, { redirect: 'manual' });
    await a.text();
    const b = await fetch(`${proxy.url}/`, { redirect: 'manual' });
    await b.text();
    assert.equal(up.count('GET', '/'), 2);
  } finally {
    await proxy.close();
    up.server.close();
  }
});

test('proxy 缓存：只读 RPC 第二次本地作答，且回放的 rpcId 必须是本次请求的', async () => {
  const up = await mockUpstream();
  const proxy = await withProxy(up);
  try {
    const post = (body) => fetch(`${proxy.url}/api/session.list`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    });
    const first = await post(rpcBody('session.list', 'rpc-1'));
    assert.equal(first.status, 200);
    const j1 = await first.json();
    assert.equal(j1.rpcId, 'rpc-1');
    assert.equal(up.count('POST', '/api/session.list'), 1);

    const second = await post(rpcBody('session.list', 'rpc-2'));
    const j2 = await second.json();
    assert.equal(up.count('POST', '/api/session.list'), 1, '第二次必须命中本地缓存');
    assert.equal(j2.rpcId, 'rpc-2', 'rpcId 对不上号时客户端会丢弃响应 —— 回放必须改写它');
    assert.equal(j2.result.value.items[0].sessionId, 's1');
    assert.equal(second.headers.get('x-hwb-cache'), 'rpc-hit');
  } finally {
    await proxy.close();
    up.server.close();
  }
});

test('proxy 缓存：写类 RPC 永不缓存（prompt/create/cancel 每次都到上游）', async () => {
  const up = await mockUpstream();
  const proxy = await withProxy(up);
  try {
    for (const method of ['session.prompt', 'session.create', 'session.cancel', 'session.updateQueue']) {
      for (let i = 0; i < 2; i++) {
        const res = await fetch(`${proxy.url}/api/${method}`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: rpcBody(method, `id-${i}`),
        });
        assert.equal(res.status, 200);
        await res.text();
      }
      assert.equal(up.count('POST', `/api/${method}`), 2, `${method} 不该被缓存或提前返回`);
    }
  } finally {
    await proxy.close();
    up.server.close();
  }
});

test('proxy 缓存：不同实例（cacheScope）之间不串台', async () => {
  const up = await mockUpstream();
  const cache = createProxyCache({ dir: null });
  const a = await createProxy({ target: up.base, cache, cacheScope: 'home-a' });
  const b = await createProxy({ target: up.base, cache, cacheScope: 'home-b' });
  try {
    await (await fetch(`${a.url}${BUNDLE}`)).text();
    await (await fetch(`${b.url}${BUNDLE}`)).text();
    assert.equal(up.count('GET', BUNDLE), 2, '另一个实例必须自己取一份（缓存键按 home 隔离）');
    const again = await fetch(`${a.url}${BUNDLE}`);
    await again.text();
    assert.equal(up.count('GET', BUNDLE), 2, '原实例仍然命中自己的副本');
  } finally {
    await a.close();
    await b.close();
    up.server.close();
  }
});

test('proxy 缓存：内容寻址的静态**不因时间过期**（URL 的 hash 就是校验器）', async () => {
  // 这条替换了原先「static 过期 → 回陈旧副本 + 后台重取」的用例。
  // 2026-09-17 起 static 走 `immortal`：URL 自带 rev/hash，内容变则 URL 变，
  // 所以「到期重取」没有任何正确性收益，只有一条慢链路上 10.8 MB 的重复传输。
  // 这与已经发给浏览器的 `immutable, 1 year` 一致（见 staticResponseHeaders）。
  const up = await mockUpstream();
  const cache = createProxyCache({ dir: null, staticTtlMs: 20 });
  const proxy = await createProxy({ target: up.base, cache, cacheScope: 'home-ttl' });
  try {
    const first = await fetch(`${proxy.url}${BUNDLE}`);
    await first.text();
    assert.equal(up.count('GET', BUNDLE), 1);
    await new Promise((r) => setTimeout(r, 60));   // 远超 staticTtlMs=20
    const again = await fetch(`${proxy.url}${BUNDLE}`);
    assert.equal(await again.text(), BUNDLE_BODY);
    assert.equal(again.headers.get('x-hwb-cache'), 'hit', '内容寻址资源不该出现 stale 态');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(up.count('GET', BUNDLE), 1, 'immutable：不该有任何后台重取');
  } finally {
    await proxy.close();
    up.server.close();
  }
});

test('proxy 缓存：RPC 过期仍走「先回旧副本（用户不等），后台再刷新」', async () => {
  // SWR 的语义本身要保住 —— 只是它现在归 RPC 类所有（历史/列表这类会变的内容）。
  const up = await mockUpstream();
  const cache = createProxyCache({ dir: null, rpcTtlMs: 20, rpcStaleMs: 5_000 });
  const proxy = await createProxy({ target: up.base, cache, cacheScope: 'home-rpc-swr' });
  const body = rpcBody('session.list', 'rpc-swr', {});
  try {
    const first = await fetch(`${proxy.url}/api/session.list`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    });
    await first.text();
    assert.equal(up.count('POST', '/api/session.list'), 1);
    await new Promise((r) => setTimeout(r, 40));
    const stale = await fetch(`${proxy.url}/api/session.list`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    });
    assert.ok(await stale.text(), '过期也要立刻给旧副本，绝不空等一条慢链路');
    assert.equal(stale.headers.get('x-hwb-cache'), 'rpc-stale');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(up.count('POST', '/api/session.list'), 2, '陈旧副本被使用时必须去后台拉一次');
  } finally {
    await proxy.close();
    up.server.close();
  }
});

test('proxy 缓存：cache=null 时完全退化为透传', async () => {
  const up = await mockUpstream();
  const proxy = await withProxy(up, { cache: null });
  try {
    await (await fetch(`${proxy.url}${BUNDLE}`)).text();
    await (await fetch(`${proxy.url}${BUNDLE}`)).text();
    assert.equal(up.count('GET', BUNDLE), 2);
  } finally {
    await proxy.close();
    up.server.close();
  }
});

test('proxy 缓存：大请求体不进缓存（附件上传不能被当成 RPC 读缓存）', async () => {
  const up = await mockUpstream();
  const proxy = await withProxy(up);
  try {
    // 用 session.list 这个「白名单方法」+ 超长 body 验证上限闸门，而不是靠方法名。
    const big = rpcBody('session.list', 'big', { blob: 'x'.repeat(128 * 1024) });
    for (let i = 0; i < 2; i++) {
      const res = await fetch(`${proxy.url}/api/session.list`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: big,
      });
      assert.equal(res.status, 200);
      await res.text();
    }
    assert.equal(up.count('POST', '/api/session.list'), 2, '超过请求体上限的调用不缓存');
  } finally {
    await proxy.close();
    up.server.close();
  }
});

// —— 命名空间/动词策略（dgx21 的 0.1.1-rc.2 用的是点号命名）——
// 抓包实测远端每次加载都会发 session.list / session.history / workspace.list / llm.providers /
// host.describe 等；而写类方法（session.prompt/respond 等）**绝不能被提前返回**。
test('proxy 缓存：只读形态放行、写类动词一律否决（含 dgx21 的点号命名）', async () => {
  const { isReadOnlyRpc } = await import('../src/control/proxy-cache.js');
  for (const m of ['session.list', 'session.history', 'workspace.list', 'skill.list', 'agentPreset.list',
    'llm.providers', 'host.describe', 'session.models', 'subagent.list', 'commands/list',
    'dynamicCordisRunner/inventory', 'session/list', 'skills/list']) {
    assert.equal(isReadOnlyRpc(m), true, `${m} 是只读，应该被缓存`);
  }
  for (const m of ['session.prompt', 'session.create', 'session.cancel', 'session.updateQueue',
    'session.respond', 'attachment.upload', 'approval.respond', 'session.set', 'skill.install',
    'session.fork', 'session.control', 'workspace.open', 'session.rename', 'dynamicCordisRunner.syncInspectManifest',
    'events.mux', '', null, 'a'.repeat(200)]) {
    assert.equal(isReadOnlyRpc(m), false, `${String(m)} 不该被缓存`);
  }
});

test('proxy 缓存：远端点号命名的只读 RPC（session.history）第二次本地作答', async () => {
  const up = await mockUpstream();
  const proxy = await withProxy(up);
  try {
    const post = (body) => fetch(`${proxy.url}/api/session.history`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    });
    await (await post(rpcBody('session.history', 'h1', { sessionId: 's1' }))).text();
    assert.equal(up.count('POST', '/api/session.history'), 1);
    const res = await post(rpcBody('session.history', 'h2', { sessionId: 's1' }));
    assert.equal(up.count('POST', '/api/session.history'), 1, '同一会话的历史第二次应命中缓存');
    assert.equal((await res.json()).rpcId, 'h2');
    // 不同会话 → 不同键，必须回源。
    await (await post(rpcBody('session.history', 'h3', { sessionId: 's2' }))).text();
    assert.equal(up.count('POST', '/api/session.history'), 2);
  } finally {
    await proxy.close();
    up.server.close();
  }
});

test('proxy 缓存：同一键的后台刷新单飞（慢链路上不能每个陈旧命中都压一条上游请求）', async () => {
  // 上游必须**真的慢**：只有刷新还在飞的时候才谈得上「单飞」。用秒回的上游测这条，量到的是
  // 调度而不是单飞 —— 同一份代码 CI 上实测 3 次、本机 1 次，就是这么红的（2026-09-15）。
  const up = await mockUpstream({ apiDelayMs: 400 });
  // 上游故意慢：刷新没结束时再来几个陈旧命中，也只允许有一条刷新在飞。
  const cache = createProxyCache({ dir: null, staticTtlMs: 10, rpcTtlMs: 1, rpcStaleMs: 5_000 });
  const proxy = await createProxy({ target: up.base, cache, cacheScope: 'home-single-flight' });
  try {
    const post = (rpcId) => fetch(`${proxy.url}/api/session.list`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: rpcBody('session.list', rpcId),
    });
    await (await post('a')).text();                     // 首次回源（400ms），写入缓存
    assert.equal(up.count('POST', '/api/session.list'), 1);
    await new Promise((r) => setTimeout(r, 30));         // 越过 1ms 的 ttl，进入 stale 窗口
    const before = up.count('POST', '/api/session.list');
    // 5 次陈旧命中：每次都立刻拿到旧副本（不受上游那 400ms 影响），只应有**一条**后台刷新在飞。
    for (let i = 0; i < 5; i++) await (await post(`s${i}`)).text();
    assert.equal(up.count('POST', '/api/session.list') - before, 1,
      '5 次陈旧命中必须被单飞压成 1 条上游刷新（每次命中各压一条 = 单飞失效）');
    await new Promise((r) => setTimeout(r, 600));        // 等那条刷新落地，确认它不会带出更多请求
    assert.equal(up.count('POST', '/api/session.list') - before, 1,
      '刷新落地后不应再冒出额外请求');
  } finally {
    await proxy.close();
    up.server.close();
  }
});

test('proxy 缓存：preview 的 workspace bundle —— 存原文、本地注入、第二次不再打上游', async () => {
  // 这份 bundle 会被 preview 代理改写（注入「在 Finder 中打开工作区」菜单项），所以它必须
  // 按代理分别处理：缓存里放**未注入**的原文，注入在本地做。dgx21 上它有 115 KB（≈4 s/次）。
  const ANCHOR = 'const workspaceMenuItems = [{';
  const GUARD = 'if (id !== "rename" && id !== "delete") return;';
  const bundle = `/* workspace bundle */\n${ANCHOR}\n${GUARD}\n/* end */`;
  let hits = 0;
  const up = createServer((req, res) => {
    hits++;
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' });
    res.end(bundle);
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const cache = createProxyCache({ dir: null });
  const proxy = await createProxy({ target: `http://127.0.0.1:${up.address().port}`, preview: true, cache, cacheScope: 'home-inject' });
  try {
    const path = '/plugins/@deepseek-ai/dsh-client-ui-workspace/client.js?rev=226eef2a8c75';
    const first = await fetch(proxy.url + path);
    const body1 = await first.text();
    assert.equal(hits, 1);
    assert.equal(body1.includes('hwb-finder'), true, '注入必须发生');
    assert.equal(first.headers.get('cache-control'), 'no-store', '注入过的内容只属于这条 preview 链路');

    const second = await fetch(proxy.url + path);
    const body2 = await second.text();
    assert.equal(hits, 1, '第二次必须由本地原文注入而来，不再打上游');
    assert.equal(second.headers.get('x-hwb-cache'), 'hit');
    assert.equal(body2, body1, '本地注入的结果与首次逐字节一致');
  } finally {
    await proxy.close();
    up.close();
  }
});

test('proxy 缓存：preview 的 documentpreview bundle —— 存原文、本地注入下载按钮、第二次不再打上游', async () => {
  // 与 workspace bundle 同一条注入路径、同一套缓存语义：缓存里放**未注入**的原文，
  // 注入在本地做。这里守的是「新增的第二个补丁没有绕过缓存/没有把原文直接发出去」。
  const MARKER = '"data-textpreview-tool": "reload"';
  const TOOL = '(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {\n\t\t\t\tlabel: t("reload"),\n\t\t\t\tchildren: (0, react_jsx_runtime.jsx)("button", { type: "button", className: TextPreview_module_css_default.tool, "data-textpreview-tool": "reload" })';
  const bundle = `/* documentpreview bundle */\nconst header = [${TOOL}];\n/* ${MARKER} */\n/* end */`;
  let hits = 0;
  const up = createServer((req, res) => {
    hits++;
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' });
    res.end(bundle);
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const cache = createProxyCache({ dir: null });
  const proxy = await createProxy({ target: `http://127.0.0.1:${up.address().port}`, preview: true, cache, cacheScope: 'home-download' });
  try {
    const path = '/plugins/??@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client.js&rev=012345abcdef';
    const first = await fetch(proxy.url + path);
    const body1 = await first.text();
    assert.equal(hits, 1);
    assert.equal(body1.includes('data-hwb-download'), true, '下载按钮注入必须发生');
    assert.equal(first.headers.get('cache-control'), 'no-store', '注入过的内容只属于这条 preview 链路');

    const second = await fetch(proxy.url + path);
    const body2 = await second.text();
    assert.equal(hits, 1, '第二次必须由本地原文注入而来，不再打上游');
    assert.equal(second.headers.get('x-hwb-cache'), 'hit');
    assert.equal(body2, body1, '本地注入的结果与首次逐字节一致');
    assert.equal(body2.includes('hwb-finder'), false, '两个补丁各管各的，不能串台');
  } finally {
    await proxy.close();
    up.close();
  }
});

test('proxy 缓存：preview 的 sidebar-files bundle —— 存原文、本地注入上传按钮、第二次不再打上游', async () => {
  // 第三个补丁（dsh 的「文件」树头部加「上传到此处」）走的是同一条「存原文 → 本地注入 → no-store」
  // 路径；这里守的是它没有绕过缓存、也没有把别的补丁串进来。
  const TOOL = '(0, react_jsx_runtime.jsx)("button", {\n\ttype: "button",\n\tclassName: FilesBody_module_css_default.tool,\n\t"aria-label": t("reload"),\n\ttitle: t("reload"),\n\t"data-files-reload": true,\n\tonClick: reload,\n\tchildren: (0, react_jsx_runtime.jsx)(prim.IconRefreshOutline16, {})\n});';
  const bundle = `/* sidebar-files bundle */\nconst header = [${TOOL}];\n/* end */`;
  let hits = 0;
  const up = createServer((req, res) => {
    hits++;
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' });
    res.end(bundle);
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const proxy = await createProxy({ target: `http://127.0.0.1:${up.address().port}`, preview: true, cache: createProxyCache({ dir: null }), cacheScope: 'home-upload' });
  try {
    const path = '/plugins/??@deepseek-ai/dsh-client-ui-sidebar-files/client.js&rev=012345abcdef';
    const first = await fetch(proxy.url + path);
    const body1 = await first.text();
    assert.equal(hits, 1);
    assert.equal(body1.includes('data-hwb-upload'), true, '上传按钮注入必须发生');
    assert.equal(first.headers.get('cache-control'), 'no-store', '注入过的内容只属于这条 preview 链路');

    const second = await fetch(proxy.url + path);
    const body2 = await second.text();
    assert.equal(hits, 1, '第二次必须由本地原文注入而来，不再打上游');
    assert.equal(second.headers.get('x-hwb-cache'), 'hit');
    assert.equal(body2, body1, '本地注入的结果与首次逐字节一致');
    assert.equal(body2.includes('data-hwb-download'), false, '三个补丁各管各的，不能串台');
  } finally {
    await proxy.close();
    up.close();
  }
});

test('proxy：一条 combo 里同时有三款待改写 bundle 时，三个补丁都要打上', async () => {
  // dsh 把多个 plugin id 合并进一条 `/plugins/??a,b&rev=…` 的 combo 请求（上限 3 KiB，
  // 够塞几十个包）。早期实现是「按 URL 挑一个补丁」——那样后一个会**静默失效**。
  const wsBundle = 'const workspaceMenuItems = [{\nif (id !== "rename" && id !== "delete") return;\n';
  const dpBundle = '(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {\n\tlabel: t("reload"),\n\tchildren: (0, react_jsx_runtime.jsx)("button", { type: "button", className: TextPreview_module_css_default.tool, "data-textpreview-tool": "reload" })\n});\n/* "data-textpreview-tool": "reload" */\n';
  const flBundle = '(0, react_jsx_runtime.jsx)("button", {\n\ttype: "button",\n\tclassName: FilesBody_module_css_default.tool,\n\t"aria-label": t("reload"),\n\ttitle: t("reload"),\n\t"data-files-reload": true,\n\tonClick: reload,\n\tchildren: (0, react_jsx_runtime.jsx)(prim.IconRefreshOutline16, {})\n});\n';
  const bundle = wsBundle + dpBundle + flBundle;
  const up = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' });
    res.end(bundle);
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const proxy = await createProxy({ target: `http://127.0.0.1:${up.address().port}`, preview: true, cache: createProxyCache({ dir: null }), cacheScope: 'home-combo' });
  try {
    const path = '/plugins/??@deepseek-ai/dsh-client-ui-workspace/client.js,@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client.js,@deepseek-ai/dsh-client-ui-sidebar-files/client.js&rev=012345abcdef';
    const res = await fetch(proxy.url + path);
    const body = await res.text();
    assert.equal(body.includes('hwb-finder'), true, 'workspace 菜单补丁要打上');
    assert.equal(body.includes('data-hwb-download'), true, '下载按钮补丁也要打上（不能被 combo 吞掉）');
    assert.equal(body.includes('data-hwb-upload'), true, '上传按钮补丁也要打上（不能被 combo 吞掉）');
    assert.equal(res.headers.get('cache-control'), 'no-store');
  } finally {
    await proxy.close();
    up.close();
  }
});

test('proxy 缓存：锚点失配的 bundle 仍按上游原样发，不被标成 no-store', async () => {
  // 通过/失败要能区分：上游换了写法（锚点没了）时，注入返回原文，响应就该沿用上游的缓存策略，
  // 而不是把一份与上游逐字节相同的内容标成 no-store、让浏览器每次重下。
  const bundle = '/* documentpreview bundle without the reload tool */\nexport const x = 1;\n';
  let hits = 0;
  const up = createServer((req, res) => {
    hits++;
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' });
    res.end(bundle);
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const proxy = await createProxy({ target: `http://127.0.0.1:${up.address().port}`, preview: true, cache: createProxyCache({ dir: null }), cacheScope: 'home-nopatch' });
  try {
    const res = await fetch(`${proxy.url}/plugins/@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client.js`);
    assert.equal(await res.text(), bundle);
    assert.equal(res.headers.get('cache-control'), 'no-cache', '没打上补丁就保持上游策略');
  } finally {
    await proxy.close();
    up.close();
  }
});

// —— 会话历史（`session.history`）是最大的一块 ——
// 实测 dgx21：一个会话 50 条消息的窗口 = 8–10 MiB 原始事件日志（gzip 后 ~0.5–0.9 MiB，
// 25–30 KB/s 的链路上要 20–35 秒）。所以：**已结束**的会话用长 TTL（历史不可变），
// **正在跑**的会话用短窗口（否则界面会停在旧快照上）。
test('proxy 缓存：已结束会话的历史走长 TTL，第二次打开是本地回', async () => {
  const up = await mockUpstream();
  const cache = createProxyCache({ dir: null, historyTtlMs: 60_000, historyStaleMs: 3_600_000 });
  const proxy = await createProxy({ target: up.base, cache, cacheScope: 'home-hist' });
  try {
    const post = (path, body) => fetch(`${proxy.url}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    });
    // 页面先拉 session.list：其中 s1 已结束、s2 正在跑。
    await (await post('/api/session.list', rpcBody('session.list', 'l1'))).text();
    const history = (sid, rpcId) => post('/api/session.history', rpcBody('session.history', rpcId, { sessionId: sid, maxMessages: 50 }));

    await (await history('s1', 'h1')).text();
    assert.equal(up.count('POST', '/api/session.history'), 1);
    await new Promise((r) => setTimeout(r, 30));   // 远超 rpcTtlMs(默认 3s 之外? 不 —— 这里用 30ms 只是为了错开写入时刻)
    const again = await history('s1', 'h2');
    assert.equal(up.count('POST', '/api/session.history'), 1, '已结束会话的历史第二次必须本地回（长 TTL）');
    assert.equal(again.headers.get('x-hwb-cache'), 'rpc-hit');
  } finally {
    await proxy.close();
    up.server.close();
  }
});

test('proxy 缓存：会话一旦在跑，长 TTL 立刻降级为短窗口（界面不能停在旧快照上）', async () => {
  let running = false;
  const hits = new Map();
  const up = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      hits.set(req.url, (hits.get(req.url) ?? 0) + 1);
      const env = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      if (env.method === 'session.list') {
        res.end(JSON.stringify({ type: 'server-response', rpcId: env.rpcId, result: { value: { items: [{ sessionId: 's1', running }] } } }));
        return;
      }
      res.end(JSON.stringify({ type: 'server-response', rpcId: env.rpcId, result: { ok: true, value: { events: [{ event: { seq: 1 } }], hasMore: false } } }));
    });
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const cache = createProxyCache({ dir: null, rpcTtlMs: 10, rpcStaleMs: 20, historyTtlMs: 3_600_000, historyStaleMs: 86_400_000 });
  const proxy = await createProxy({ target: `http://127.0.0.1:${up.address().port}`, cache, cacheScope: 'home-hist-run' });
  try {
    const post = (path, body) => fetch(`${proxy.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    await (await post('/api/session.list', rpcBody('session.list', 'l1'))).text();      // s1 已结束
    await (await post('/api/session.history', rpcBody('session.history', 'h1', { sessionId: 's1' }))).text();
    assert.equal(hits.get('/api/session.history'), 1);

    running = true;                                                                     // 会话恢复运行
    await new Promise((r) => setTimeout(r, 30));                                        // 让 session.list 越过短 TTL
    await (await post('/api/session.list', rpcBody('session.list', 'l2'))).text();
    await new Promise((r) => setTimeout(r, 60));                                        // 超出短窗口（含后台刷新）
    const res = await post('/api/session.history', rpcBody('session.history', 'h2', { sessionId: 's1' }));
    await res.text();
    assert.equal(hits.get('/api/session.history'), 2, '会话在跑 → 旧的「长 TTL」副本不能再被当成新鲜的');
  } finally {
    await proxy.close();
    up.close();
  }
});

test('proxy 缓存：大 RPC 响应必须先发头再流式传输（否则 30s 头超时会把历史会话打成 504）', async () => {
  // 实测 dgx21：一个会话的 session.history 有 8–10 MiB，链路上要几十秒。若代理先攒完整个响应
  // 再写响应头，`upstream response timeout`（默认 30s）会在中途把请求打成 504 —— 用户拿不到历史。
  const up = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const env = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const payload = JSON.stringify({ type: 'server-response', rpcId: env.rpcId, result: { ok: true, value: { events: [], pad: 'x'.repeat(256 * 1024) } } });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.write(payload.slice(0, 1024));
      // 头已经发出，正文慢慢来：模拟慢链路
      setTimeout(() => res.end(payload.slice(1024)), 150);
    });
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const cache = createProxyCache({ dir: null });
  // 超时给足正文间隙（150ms），但要小到能证明「头不是等正文攒完才发的」。
  const proxy = await createProxy({ target: `http://127.0.0.1:${up.address().port}`, cache, cacheScope: 'home-stream', requestTimeoutMs: 400 });
  try {
    const started = Date.now();
    const res = await fetch(`${proxy.url}/api/session.history`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: rpcBody('session.history', 's1', { sessionId: 's1' }),
    });
    const headersMs = Date.now() - started;
    assert.equal(res.status, 200, '不能是 504');
    assert.ok(headersMs < 120, `响应头必须立刻到（实测 ${headersMs}ms），不能等正文攒完（正文还要 150ms）`);
    const body = await res.json();
    assert.equal(body.result.value.pad.length, 256 * 1024);
    // 流完之后仍要进缓存：第二次是本地回。
    const again = await fetch(`${proxy.url}/api/session.history`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: rpcBody('session.history', 's2', { sessionId: 's1' }),
    });
    assert.equal(again.headers.get('x-hwb-cache'), 'rpc-hit');
    assert.equal((await again.json()).rpcId, 's2');
  } finally {
    await proxy.close();
    up.close();
  }
});

// —— 增量问题：dsh 的历史接口没有「向前增量」——
// 实测（远端 0.1.1-rc.2 源码 dsh-host-apiproxy/lib/index.js:2557）：`session.history` 只接受
// `{sessionId, beforeSeq, maxMessages}` —— `beforeSeq` 是**往回翻**更早的内容；不给就是切
// 「最新尾部窗口」（historyCutOf 取整条事件日志再 paginate）。**没有 sinceSeq/afterSeq**。
// 而事件流 `/api/events.host` 开流时 payload 是 `{}`（没有游标），只推订阅之后的新事件。
// 结论：一份陈旧的历史窗口**补不回**中间那段事件 —— 所以运行中的会话连陈旧副本都不能供。
test('proxy 缓存：运行中的会话连陈旧副本也不供（事件流没有游标，补不回中间那段）', async () => {
  const up = await mockUpstream();
  // 先用「已结束」把它灌成长 TTL 条目，再让它变成运行中。
  const cache = createProxyCache({ dir: null, rpcTtlMs: 10, runningStaleMs: 0, historyTtlMs: 600_000, historyStaleMs: 600_000 });
  const proxy = await createProxy({ target: up.base, cache, cacheScope: 'home-nostale' });
  try {
    const post = (p, b) => fetch(`${proxy.url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: b });
    await (await post('/api/session.list', rpcBody('session.list', 'l1'))).text();          // s1 已结束 / s2 在跑
    await (await post('/api/session.history', rpcBody('session.history', 'h1', { sessionId: 's2' }))).text();
    assert.equal(up.count('POST', '/api/session.history'), 1);
    await new Promise((r) => setTimeout(r, 40));                                            // 超出短 TTL
    await (await post('/api/session.history', rpcBody('session.history', 'h2', { sessionId: 's2' }))).text();
    assert.equal(up.count('POST', '/api/session.history'), 2, '运行中的会话必须回源（默认不供陈旧副本）');
  } finally {
    await proxy.close();
    up.server.close();
  }
});

test('proxy 缓存：会话运行状态未知时按保守档处理（不拿旧观测批准长 TTL）', async () => {
  const up = await mockUpstream();
  let clock = 1_000_000;
  const cache = createProxyCache({ dir: null, now: () => clock, rpcTtlMs: 10, runningTrustMs: 100, historyTtlMs: 600_000, historyStaleMs: 600_000 });
  const proxy = await createProxy({ target: up.base, cache, cacheScope: 'home-unknown' });
  try {
    const post = (p, b) => fetch(`${proxy.url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: b });
    await (await post('/api/session.list', rpcBody('session.list', 'l1'))).text();          // 观测 s1=已结束
    assert.equal(cache.isRunning('s1'), false);
    await (await post('/api/session.history', rpcBody('session.history', 'h1', { sessionId: 's1' }))).text();
    assert.equal(up.count('POST', '/api/session.history'), 1);

    clock += 1_000;                                                                          // 观测过期（> runningTrustMs）
    assert.equal(cache.isRunning('s1'), undefined, '过期的观测必须变成「未知」');
    await (await post('/api/session.history', rpcBody('session.history', 'h2', { sessionId: 's1' }))).text();
    assert.equal(up.count('POST', '/api/session.history'), 2, '未知 ≠ 已结束：不能拿几天前的观测批准长 TTL');
  } finally {
    await proxy.close();
    up.server.close();
  }
});

// —— 增量补差：hwb 用 dsh-history-delta 插件的 /api/histdelta/history 把「重传整段」变成「只补差」——
// 实测（dgx21 隔离实例）：大会话整段 8 732 706 B；带 afterSeq 的增量 403 934 B。
// 这里用假上游同时实现两个端点，验证：第二次打开只传增量、回给浏览器的仍是**完整窗口**、
// 不连续时退回整段、插件不在时不反复白试。
function historyUpstream({ withDelta = true } = {}) {
  const calls = { full: 0, delta: 0 };
  let log = Array.from({ length: 60 }, (_, i) => ({ event: { type: 'chunk', seq: 100 + i } }));
  const page = (from, to) => log.filter((r) => r.event.seq >= from && r.event.seq <= to);
  const value = (events) => ({ events, hasMore: true, projections: { asOfSeq: events.at(-1)?.event.seq ?? 0 } });
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const env = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (req.url === '/api/session.list') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ rpcId: env.rpcId, result: { ok: true, value: { items: [{ sessionId: 's1', running: false }] } } }));
        return;
      }
      if (req.url === '/api/session.history') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        calls.full += 1;
        const max = env.payload.maxMessages ?? 50;
        res.end(JSON.stringify({ rpcId: env.rpcId, result: { ok: true, value: value(log.slice(-Math.max(max, 1))) } }));
        return;
      }
      if (req.url === '/api/histdelta/history') {
        calls.delta += 1;                                   // 计数「探测/使用次数」，与是否支持无关
        if (!withDelta) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        const afterSeq = env.payload.args.afterSeq;
        const max = env.payload.args.maxMessages ?? 50;
        // 与上游同构：窗口 = **最新 maxMessages 条消息**（这里一条事件当一条消息），不是整条日志。
        const window = value(log.slice(-Math.max(max, 1)));
        const kept = window.events.filter((r) => r.event.seq > afterSeq);
        res.end(JSON.stringify({
          rpcId: env.rpcId,
          result: {
            ok: true,
            value: {
              ...value(kept),
              afterSeq,
              windowFirstSeq: window.events[0].event.seq,
              windowLastSeq: window.events.at(-1).event.seq,
            },
          },
        }));
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server, base: `http://127.0.0.1:${server.address().port}`, calls,
    grow: (n) => { const last = log.at(-1).event.seq; for (let i = 1; i <= n; i++) log.push({ event: { type: 'chunk', seq: last + i } }); },
  })));
}

test('proxy 增量：第二次打开会话只传增量，但回给浏览器的仍是完整窗口', async () => {
  const up = await historyUpstream();
  const cache = createProxyCache({ dir: null, rpcTtlMs: 1, rpcStaleMs: 1, historyTtlMs: 1, historyStaleMs: 1 });
  const proxy = await createProxy({ target: up.base, cache, cacheScope: 'home-delta', historyDelta: true });
  try {
    const ask = (rpcId) => fetch(`${proxy.url}/api/session.history`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: rpcBody('session.history', rpcId, { sessionId: 's1', maxMessages: 50 }),
    });
    const first = await ask('a');
    const firstBody = await first.json();
    assert.equal(up.calls.full, 1);
    assert.equal(firstBody.result.value.events.length, 50);

    up.grow(5);                                     // 会话又长了 5 个 seq
    await new Promise((r) => setTimeout(r, 20));    // 让本地副本过期（stale 窗口也设成 1ms）
    const second = await ask('b');
    const secondBody = await second.json();
    assert.equal(up.calls.delta, 1, '必须走增量通道');
    assert.equal(up.calls.full, 1, '不能整段重取');
    assert.equal(second.headers.get('x-hwb-cache'), 'rpc-delta');
    assert.equal(secondBody.rpcId, 'b');
    // 回给浏览器的必须是「上游此刻会给的完整窗口」：55 条里的最后 50 条
    assert.deepEqual(
      secondBody.result.value.events.map((r) => r.event.seq),
      Array.from({ length: 50 }, (_, i) => 115 + i),   // 日志 100..164 的最后 50 条
    );
    assert.equal('windowFirstSeq' in secondBody.result.value, false, '内部字段不能漏给客户端');
  } finally {
    await proxy.close();
    up.server.close();
  }
});

test('proxy 增量：插件不在（404）时回退整段，且不反复白试', async () => {
  const up = await historyUpstream({ withDelta: false });   // 有 history、没有 histdelta 端点
  const cache = createProxyCache({ dir: null, rpcTtlMs: 1, rpcStaleMs: 1, historyTtlMs: 1, historyStaleMs: 1 });
  const proxy = await createProxy({ target: up.base, cache, cacheScope: 'home-nodelta', historyDelta: true });
  try {
    const ask = (rpcId) => fetch(`${proxy.url}/api/session.history`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: rpcBody('session.history', rpcId, { sessionId: 's1', maxMessages: 50 }),
    });
    const first = await ask('a'); await first.text();
    await new Promise((r) => setTimeout(r, 20));
    const second = await ask('b'); await second.text();
    await new Promise((r) => setTimeout(r, 20));    // 让本地副本过期，否则第三次会被本地命中（那也是对的，但不是这条用例要证的）
    const third = await ask('c'); await third.text();
    assert.equal(up.calls.full, 3, '不支持增量时每次都走整段（正确优先）');
    assert.equal(up.calls.delta, 1, '探测一次 404 后就该记住，不再白打');
  } finally {
    await proxy.close();
    up.server.close();
  }
});

test('proxy 增量：陈旧副本的后台刷新也只传增量（否则「用到旧副本」本身就会触发整段重取）', async () => {
  const up = await historyUpstream();
  // 新鲜窗口 1ms、陈旧窗口给足：让第二次请求走「先回旧副本 + 后台刷新」这条路。
  const cache = createProxyCache({ dir: null, rpcTtlMs: 1, rpcStaleMs: 60_000, historyTtlMs: 1, historyStaleMs: 60_000 });
  const proxy = await createProxy({ target: up.base, cache, cacheScope: 'home-delta-refresh', historyDelta: true });
  try {
    const ask = (rpcId) => fetch(`${proxy.url}/api/session.history`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: rpcBody('session.history', rpcId, { sessionId: 's1', maxMessages: 50 }),
    });
    // 先让代理知道 s1 已结束（真实页面每次加载都会拉 session.list）——否则按保守档处理，
    // 陈旧副本不会被供出（那也对，但不是这条用例要证的路径）。
    await (await fetch(`${proxy.url}/api/session.list`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: rpcBody('session.list', 'l1', {}),
    })).text();
    await (await ask('a')).text();
    assert.equal(up.calls.full, 1);
    up.grow(3);
    await new Promise((r) => setTimeout(r, 20));
    const stale = await ask('b');
    assert.equal(stale.headers.get('x-hwb-cache'), 'rpc-stale', '第二次应立刻回旧副本');
    await stale.text();
    await new Promise((r) => setTimeout(r, 150));            // 等后台刷新
    assert.equal(up.calls.delta, 1, '后台刷新必须走增量');
    assert.equal(up.calls.full, 1, '后台刷新不能整段重取');
    // 刷新后缓存里是新窗口：随后的请求从新的 lastSeq 继续补差。
    const third = await ask('c');
    const body = await third.json();
    assert.deepEqual(body.result.value.events.map((r) => r.event.seq), Array.from({ length: 50 }, (_, i) => 113 + i));
  } finally {
    await proxy.close();
    up.server.close();
  }
});

// —— 2026-09-17：体积与「不必全量读取」——
//
// 现网实测（386 条 / 311.7 MB、772 个文件）：38 个 ≥1 MB 的大条目占 94% 的体积，
// `session.history` 33 条就 182.0 MB；235 个 <8 KB 的小条目合计只有 428 KB 却各占 2 个文件；
// 另有 310 条（162.0 MB）早已死掉，只因「重启不修剪」而留在盘上。
// 下面这些用例守住新增的六个机制，任何一个悄悄退化都会有人红。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { randomBytes } from 'node:crypto';

function tempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `hwb-cache-${tag}-`));
}

function diskFiles(dir) {
  return fs.readdirSync(dir);
}

test('缓存 C1：落盘压缩 —— 大正文按 gzip 存，读回来逐字节相同', () => {
  const dir = tempDir('codec');
  try {
    const cache = createProxyCache({ dir });
    // 可压性高的正文（JSON 事件流是真实场景里最典型的：实测 ~12×）。
    const body = Buffer.from(JSON.stringify({ events: Array.from({ length: 500 }, (_, i) => ({ seq: i, text: 'x'.repeat(40) })) }));
    cache.write('s|/api/session.history|session.history|k', { body, kind: 'rpc', ttlMs: 60_000, staleMs: 60_000 });
    const bin = diskFiles(dir).find((f) => f.endsWith('.bin'));
    assert.ok(bin, '应当落盘');
    const stored = fs.readFileSync(path.join(dir, bin));
    assert.ok(stored.length < body.length / 2, `落盘应显著小于原文（${stored.length} vs ${body.length}）`);
    const fresh = createProxyCache({ dir });                      // 新实例：从盘上读
    const meta = fresh.readMeta('s|/api/session.history|session.history|k');
    assert.ok(meta, 'meta 应当可读');
    assert.equal(meta.bytes, body.length, 'bytes 是逻辑长度');
    assert.deepEqual(fresh.readBody(meta), body, '解压后必须逐字节相同');
    fresh.dispose();
    cache.dispose();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('缓存 C1：codec=identity 时按原文落盘（旋钮与向后兼容）', () => {
  const dir = tempDir('nocodec');
  try {
    const cache = createProxyCache({ dir, codec: 'identity' });
    const body = Buffer.from('y'.repeat(4096));
    cache.write('s|/assets/a-12345678.js|x', { body, kind: 'static', immortal: true });
    const bin = diskFiles(dir).find((f) => f.endsWith('.bin'));
    assert.ok(bin, 'immortal 的 static 一律落盘（它就是那份免重下的工作集）');
    assert.equal(fs.readFileSync(path.join(dir, bin)).length, 4096, 'identity 模式不该压缩');
    cache.dispose();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('缓存 C2：304 与 HEAD 都不读正文（只读 meta）', () => {
  const dir = tempDir('meta');
  try {
    const cache = createProxyCache({ dir });
    const body = Buffer.alloc(256 * 1024, 7);
    const written = cache.write('s|/assets/big-abcdef12.js|x', { body, kind: 'static', immutable: true, immortal: true });
    const before = cache.stats.bodyLoads;
    // 只读 meta：不该触发任何正文读取。
    const fresh = createProxyCache({ dir });
    const meta = fresh.readMeta('s|/assets/big-abcdef12.js|x');
    assert.ok(meta);
    assert.equal(meta.etag, written.etag);
    assert.equal(fresh.stats.bodyLoads, 0, 'readMeta 不得读 .bin');
    void before;
    fresh.dispose();
    cache.dispose();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('缓存 C3：大正文不常驻内存，小正文常驻（有盘可回退时）', () => {
  const dir = tempDir('resident');
  try {
    const cache = createProxyCache({ dir, residentMaxEntryBytes: 4096, maxResidentBytes: 64 * 1024 });
    const big = Buffer.alloc(200 * 1024, 1);
    cache.write('s|k-big', { body: big, kind: 'rpc', ttlMs: 60_000, staleMs: 60_000 });
    assert.equal(cache.residentBytes, 0, '超过驻留上限的正文不该常驻（盘上有副本就够）');
    const small = Buffer.from('small');
    cache.write('s|k-small', { body: small, kind: 'rpc', ttlMs: 60_000, staleMs: 60_000 });
    assert.equal(cache.residentBytes, small.length, '小正文应当常驻');
    // 大正文仍能整条读回来（从磁盘），并且读完之后**再次**不常驻。
    assert.deepEqual(cache.read('s|k-big').body, big);
    assert.equal(cache.residentBytes, small.length, '读完即弃：大正文不得留在内存里');
    cache.dispose();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('缓存 C3：没有磁盘可回退时必须驻留（否则缓存直接丢内容）', () => {
  const cache = createProxyCache({ dir: null, residentMaxEntryBytes: 4096 });
  const big = Buffer.alloc(20 * 1024, 1);
  cache.write('s|k-big', { body: big, kind: 'rpc', ttlMs: 60_000, staleMs: 60_000 });
  assert.deepEqual(cache.read('s|k-big')?.body, big, 'dir=null 时大正文也必须能读回来');
  cache.dispose();
});

test('缓存 C4：启动修剪按 ttl+stale 清掉死条目（含按旧策略写下的 static）', () => {
  const dir = tempDir('prune');
  try {
    const cache = createProxyCache({ dir });
    // 用「旧策略」写一条 static（ttl=600s/stale=3600s），模拟历史积压。
    const old = cache.write('s|/assets/old-12345678.js|x', {
      body: Buffer.from('old'), kind: 'static', ttlMs: 600_000, staleMs: 3_600_000,
    });
    assert.ok(old);
    // 手工把 storedAt 拨到 72 小时前 —— 这正是现网那 116.7 MB 死 static 的形状。
    const metaFile = diskFiles(dir).find((f) => f.endsWith('.json'));
    const m = JSON.parse(fs.readFileSync(path.join(dir, metaFile), 'utf8'));
    m.storedAt = Date.now() - 72 * 3600_000;
    fs.writeFileSync(path.join(dir, metaFile), JSON.stringify(m));
    cache.dispose();

    const reopened = createProxyCache({ dir });           // 启动即修剪
    assert.equal(diskFiles(dir).length, 0, '死条目（含旧策略的 static）应当被清掉');
    assert.equal(reopened.size, 0);
    reopened.dispose();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('缓存 C4：immortal 条目不会被时间修剪掉（新的 static 语义）', () => {
  const dir = tempDir('prune-immortal');
  try {
    const cache = createProxyCache({ dir });
    cache.write('s|/assets/keep-12345678.js|x', { body: Buffer.from('keep'), kind: 'static', immortal: true });
    assert.ok(cache.readMeta('s|/assets/keep-12345678.js|x'));
    cache.dispose();
    const reopened = createProxyCache({ dir });
    assert.ok(reopened.readMeta('s|/assets/keep-12345678.js|x'), 'immortal 不该被修剪');
    reopened.dispose();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('缓存 C5：微小的短 TTL RPC 只留内存、不落盘', () => {
  const dir = tempDir('persist');
  try {
    const cache = createProxyCache({ dir });
    // 真实形状：commands/list 只有 1 KB、ttl 3 秒（现网 227 条这样的条目各占 2 个文件）。
    cache.write('s|/api/commands/list|commands/list|k', {
      body: Buffer.from('{"r":[]}'), kind: 'rpc', ttlMs: 3_000, staleMs: 60_000,
    });
    assert.equal(diskFiles(dir).length, 0, '微小短 TTL 条目不该落盘');
    assert.ok(cache.readMeta('s|/api/commands/list|commands/list|k'), '但内存里必须还在（省一次隧道往返）');
    // 大条目 / 长 TTL 条目仍然落盘。
    cache.write('s|/api/session.history|session.history|k', {
      body: Buffer.alloc(64 * 1024, 3), kind: 'rpc', ttlMs: 30 * 60_000, staleMs: 60_000,
    });
    assert.equal(diskFiles(dir).length, 2, '大条目应当落盘（.bin + .json）');
    cache.dispose();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('缓存 C6：同一会话的历史最多留 N 份不同窗口', () => {
  const dir = tempDir('variants');
  try {
    const cache = createProxyCache({ dir });
    const w = (k, n) => ({ key: `sc|/api/session.history|session.history|${k}`, opts: { body: Buffer.alloc(n, 5), kind: 'rpc', ttlMs: 30 * 60_000, staleMs: 60_000, sessionId: 'sess-1' } });
    const a = w('a', 4096); const b = w('b', 4096); const c = w('c', 4096);
    cache.write(a.key, a.opts);
    cache.write(b.key, b.opts);
    cache.write(c.key, c.opts);
    const alive = [a, b, c].filter((x) => cache.readMeta(x.key)).length;
    assert.equal(alive, 2, '上限是 2：最旧的那份窗口应被淘汰');
    // 别的会话不受影响。
    const other = 'sc|/api/session.history|session.history|z';
    cache.write(other, { body: Buffer.alloc(4096, 6), kind: 'rpc', ttlMs: 30 * 60_000, staleMs: 60_000, sessionId: 'sess-2' });
    assert.ok(cache.readMeta(other), '不同会话之间不该互相淘汰');
    cache.dispose();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('缓存 C7：分区预算 —— 大历史挤不掉 static 工作集', () => {
  const dir = tempDir('pools');
  try {
    const cache = createProxyCache({ dir, staticMaxBytes: 8 * 1024, rpcMaxBytes: 8 * 1024 });
    cache.write('sc|/assets/keep-12345678.js|x', { body: Buffer.alloc(4096, 1), kind: 'static', immortal: true });
    assert.ok(cache.readMeta('sc|/assets/keep-12345678.js|x'));
    // 塞入多个 RPC 条目，总量远超 **static** 的预算 —— static 必须活着。
    for (let i = 0; i < 6; i += 1) {
      cache.write(`sc|/api/session.history|session.history|k${i}`, {
        body: Buffer.alloc(4096, 2), kind: 'rpc', ttlMs: 30 * 60_000, staleMs: 60_000, sessionId: `s${i}`,
      });
    }
    assert.ok(cache.readMeta('sc|/assets/keep-12345678.js|x'), 'static 不该被 rpc 的淘汰波及');
    cache.dispose();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('缓存 C1/C2 集成：304 命中不读正文，且压缩落盘的 304 也正确', async () => {
  const dir = tempDir('e2e-304');
  try {
    const up = await mockUpstream();
    const cache = createProxyCache({ dir });
    const proxy = await createProxy({ target: up.base, cache, cacheScope: 'home-304' });
    try {
      const first = await fetch(`${proxy.url}${BUNDLE}`);
      const firstText = await first.text();
      assert.equal(firstText, BUNDLE_BODY);
      // 回源那趟是流式的、故意不带 ETag；校验器从**本地命中**那一趟起提供。
      const warm = await fetch(`${proxy.url}${BUNDLE}`);
      const etag = warm.headers.get('etag');
      assert.ok(etag, '本地命中必须带上 ETag（否则浏览器下次只能整包重下）');
      assert.equal(warm.headers.get('x-hwb-cache'), 'hit');
      const loadsAfterFirst = cache.stats.bodyLoads;
      const second = await fetch(`${proxy.url}${BUNDLE}`, { headers: { 'if-none-match': etag } });
      assert.equal(second.status, 304, '带 ETag 回来应当命中本地 304');
      assert.equal(cache.stats.bodyLoads, loadsAfterFirst, '304 路径不得读正文');
      // HEAD 同样不读正文。
      const head = await fetch(`${proxy.url}${BUNDLE}`, { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(cache.stats.bodyLoads, loadsAfterFirst, 'HEAD 路径不得读正文');
      // 真的再要一次正文时仍然逐字节正确（解压路径）。
      const third = await fetch(`${proxy.url}${BUNDLE}`);
      assert.equal(await third.text(), BUNDLE_BODY);
    } finally {
      await proxy.close();
      up.server.close();
    }
    cache.dispose();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('缓存：zlib 往返自检（防线：解压失败必须当未命中，而不是回坏字节）', () => {
  // 这条是给「codec 字段与字节不一致」这类事故兜底的：解码失败返回 null，调用方按未命中处理。
  const raw = Buffer.from('hello'.repeat(1000));
  const gz = zlib.gzipSync(raw);
  assert.deepEqual(zlib.gunzipSync(gz), raw);
});

test('缓存 C1 回归：同进程内回放压缩条目必须逐字节相同（codec 必须写进内存 meta）', () => {
  // 这条是真实踩到的坑：`codec` 只写进了盘上的 meta.json，内存里的 meta 没有，
  // 于是同进程回放时把 **gzip 流当原文发出去** —— 200 KB 的正文变成 233 字节。
  // 它不会报错、只会静默地给出坏内容，所以必须有用例钉住。
  const dir = tempDir('codec-regress');
  try {
    const cache = createProxyCache({ dir });
    const body = Buffer.alloc(200 * 1024, 9);
    cache.write('s|k-in-proc', { body, kind: 'rpc', ttlMs: 60_000, staleMs: 60_000 });
    assert.equal(cache.read('s|k-in-proc').body.length, body.length, '同进程回放必须是原文长度');
    assert.deepEqual(cache.read('s|k-in-proc').body, body);
    // 换一个进程视角（新实例从盘上读）也必须一致。
    const reopened = createProxyCache({ dir });
    const meta = reopened.readMeta('s|k-in-proc');
    assert.deepEqual(reopened.readBody(meta), body);
    reopened.dispose();
    cache.dispose();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('缓存 C4/C7：重启后预算对**整目录**生效（含本次会话没碰过的条目）', () => {
  // 内存记账只看「加载过的条目」，所以盘上超预算的部分不会自己消失 —— 这正是现网
  // 314 MB > 256 MiB 预算的来源。启动修剪必须按整目录裁 LRU 尾部。
  // 造法：先用宽松预算写满，再用**收紧的**预算重开（等价于改小旋钮 / 历史积压）。
  const dir = tempDir('budget');
  try {
    const writer = createProxyCache({ dir, staticMaxBytes: 256 * 1024, rpcMaxBytes: 256 * 1024 });
    for (let i = 0; i < 12; i += 1) {
      // 不可压的随机字节：可压数据会被 gzip 压到几百字节，那样量到的是压缩而不是预算。
      writer.write(`sc|/assets/f${i}-12345678.js|x`, {
        body: randomBytes(4096), kind: 'static', immortal: true,
      });
    }
    writer.dispose();
    const dirBytes = () => diskFiles(dir).reduce((s, f) => s + fs.statSync(path.join(dir, f)).size, 0);
    const before = dirBytes();
    assert.ok(before > 16 * 1024, `先真的写出超预算的目录（实际 ${before} B）`);

    const reopened = createProxyCache({ dir, staticMaxBytes: 8 * 1024, rpcMaxBytes: 8 * 1024 });
    const after = dirBytes();
    assert.ok(after < before, `启动修剪必须把整目录裁下来（${before} → ${after}）`);
    assert.ok(reopened.summary().diskMegabytes > 0, '摘要里的盘上体积在重启后必须有值（运维看的就是这个）');
    // 至少留一条：预算的意图是「留住最有用的那部分」，不是「宁可清空」。
    assert.ok(diskFiles(dir).filter((f) => f.endsWith('.bin')).length >= 1, '不该被清空');
    reopened.dispose();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('缓存：重复覆盖写同一键不会让记账漂移（summary 的 megabytes 必须真实）', () => {
  // 覆盖写要把旧条目的账退干净：内存常驻、落盘字节、逻辑字节三本都要退。
  // 否则重写 N 次之后 summary 里的 megabytes 会虚高 N 倍 —— 这类漂移不会报错，
  // 只会让「缓存到底多大」这个判断失真。
  const dir = tempDir('rewrite');
  try {
    const cache = createProxyCache({ dir });
    const body = randomBytes(4096);
    for (let i = 0; i < 20; i += 1) {
      cache.write('s|k-rewrite', { body, kind: 'rpc', ttlMs: 60_000, staleMs: 60_000 });
    }
    const s = cache.summary();
    assert.equal(cache.size, 1, '同一个键只该有一条');
    assert.ok(Math.abs(s.megabytes - 4096 / 1048576) < 0.01, `逻辑体积不该漂移（实际 ${s.megabytes} MB）`);
    assert.ok(Math.abs(s.storedMegabytes - 4096 / 1048576) < 0.01, `落盘体积不该漂移（实际 ${s.storedMegabytes} MB）`);
    assert.equal(cache.residentBytes, 4096, '常驻体积不该漂移');
    cache.dispose();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('缓存：后台刷新不得把 static 的 immortal 抹掉（否则旧条目永远 stale）', async () => {
  // 生产实测踩到：一个 static 条目是 `codec:gzip`（新代码写的）却 `immortal:false`。
  // 原因是 refreshInBackground 的三处 write 没带 immortal ——
  // 于是一个从**旧格式**（有限 TTL）升上来的 static 条目，一旦命中 stale 被后台刷新，
  // 就会被「写回有限 TTL」，永远保持 stale 并每次刷新都整段重取。这条守住它。
  //
  // 这里走**真实代理**而不是直接调 write：那条 stale 分支才是出问题的地方。
  const dir = tempDir('immortal-refresh');
  try {
    const up = await mockUpstream();
    const cache = createProxyCache({ dir, staticTtlMs: 20 });
    // 1) 先按「旧策略」塞一条有限 TTL 的 static（模拟迁移前留下的条目）。
    const key = `home-legacy|${BUNDLE}`;
    cache.write(key, {
      body: Buffer.from(BUNDLE_BODY), kind: 'static',
      contentType: 'text/javascript; charset=utf-8', cacheControl: 'no-cache',
      ttlMs: 20, staleMs: 60_000,
    });
    assert.equal(cache.readMeta(key).immortal, false, '前提：这条不是 immortal');
    const proxy = await createProxy({ target: up.base, cache, cacheScope: 'home-legacy' });
    try {
      await new Promise((r) => setTimeout(r, 40));               // 让它变成 stale
      assert.equal(cache.freshness(cache.readMeta(key), 'static'), 'stale', '前提：它现在是 stale');
      const res = await fetch(`${proxy.url}${BUNDLE}`);          // 命中 stale → 触发后台刷新
      assert.equal(res.headers.get('x-hwb-cache'), 'stale', 'stale 仍要立刻回旧副本');
      await res.text();
      await new Promise((r) => setTimeout(r, 250));              // 等后台刷新落地
      const after = cache.readMeta(key);
      assert.equal(after.immortal, true, '后台刷新必须把 immortal 写回去');
      assert.equal(cache.freshness(after, 'static'), 'fresh', 'immortal 的 static 不该再 stale');
    } finally {
      await proxy.close();
      up.server.close();
    }
    cache.dispose();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// —— 慢链路上的会话列表 TTL（2026-09-22，dgx21.tun 实测）——
//
// `session.list` 是 hwb 轮询最频繁的只读 RPC，响应很大（实测 179 会话 = 129 KB）。
// 本地重取是 1ms 的事，3s TTL 合理；但经隧道同一份 129 KB 要 3.4–7.3s ——
// 「TTL 3s 就过期」意味着**每一轮轮询都重搬 129 KB**，而这份数据 3 秒内几乎不会变。
// 这里守住：慢链路放宽、快链路不变、**历史类绝不放宽**（放宽会造成静默的消息空洞）。
test('proxy-cache: 慢链路上放宽 session.list 的 TTL，快链路保持 3s', () => {
  const cache = createProxyCache({ dir: null });
  const key = 'homeA|/api/session.list|session.list|digest';
  // 无观测（本地/快链路）→ 既有行为
  assert.equal(cache.slowLink(key), false);
  assert.equal(cache.policy({ kind: 'rpc', rpcMethod: 'session.list', key }).ttlMs, 3000);
  // 观测到一次 5s 的上游耗时 → 判为慢链路并放宽
  cache.noteUpstreamLatency(key, 5000);
  assert.equal(cache.slowLink(key), true);
  assert.ok(cache.policy({ kind: 'rpc', rpcMethod: 'session.list', key }).ttlMs > 3000,
    '慢链路上必须放宽，否则每轮都要重搬整份响应');
  // 链路恢复后收敛回 3s
  for (let i = 0; i < 10; i += 1) cache.noteUpstreamLatency(key, 20);
  assert.equal(cache.slowLink(key), false, '链路恢复后应收敛回快链路');
  assert.equal(cache.policy({ kind: 'rpc', rpcMethod: 'session.list', key }).ttlMs, 3000);
});

test('proxy-cache: 历史类 RPC 不因慢链路放宽 TTL（避免静默的消息空洞）', () => {
  const cache = createProxyCache({ dir: null });
  const key = 'homeA|/api/session.history|session.history|digest';
  cache.noteUpstreamLatency(key, 9000);   // 就算很慢
  // 会话在跑/状态未知 → 必须保持短窗口：事件流没有游标，陈旧窗口补不回中间那段。
  assert.equal(cache.policy({ kind: 'rpc', rpcMethod: 'session.history', sessionId: 's1', key }).ttlMs, 3000,
    '历史类在会话状态未知时必须用短窗口');
});

test('proxy-cache: noteUpstreamLatency 忽略非法输入，不影响判定', () => {
  const cache = createProxyCache({ dir: null });
  const key = 'k';
  for (const bad of [null, undefined, 0, -5, NaN, 'x']) cache.noteUpstreamLatency(key, bad);
  assert.equal(cache.slowLink(key), false);
  assert.equal(cache.upstreamLatencyOf(key), null);
});
