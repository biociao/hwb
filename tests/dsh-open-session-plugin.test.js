// dsh-hwb-open-session 插件（Host 半 + Client 半）的契约测试。
//
// Host 半守：触发器校验（过期/损坏/超长/非法 sessionId 一律按没有处理）、只读路由、405。
// Client 半守：轮询到新 id 才 open、同 id 不重复、过期忽略、sessions 未 ready 时下一轮重试、
// 清理后不再轮询。Client 半在 Node 里用假的 __ModuleLoader__/fetch/window 驱动，不需要浏览器。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { readTrigger, triggerPath, apply, ROUTE } = await import('../dsh-hwb-open-session/lib/index.js');

function tempDir(prefix = 'hwb-open-session-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
}

function fakeResponse() {
  return {
    status: 0,
    headers: null,
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body ?? ''; },
  };
}

test('Host.readTrigger：合法/过期/损坏/超长/非法 sessionId 的行为', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'open-session.json');
  try {
    const future = Date.now() + 60_000;
    writeJsonFile(file, { id: 't1', sessionId: 'session-abc', createdAt: Date.now(), expiresAt: future });
    assert.deepEqual(await readTrigger(file), { ok: true, id: 't1', sessionId: 'session-abc', expiresAt: future });

    // 过期：按「没有触发器」处理（客户端下一轮继续轮询）
    writeJsonFile(file, { id: 't1', sessionId: 'session-abc', expiresAt: Date.now() - 1 });
    assert.equal(await readTrigger(file), null);

    // 损坏的 JSON
    fs.writeFileSync(file, 'not json', { mode: 0o600 });
    assert.equal(await readTrigger(file), null);

    // sessionId 白名单：路径分隔符/引号/空格都不接受
    for (const bad of ['', 'a/b', 'a b', '"><x>', 'x'.repeat(201), null, 42]) {
      writeJsonFile(file, { id: 't1', sessionId: bad, expiresAt: future });
      assert.equal(await readTrigger(file), null, `应拒绝 sessionId=${JSON.stringify(bad)}`);
    }

    // 超长文件（防止把路由变成读大文件的入口）
    fs.writeFileSync(file, JSON.stringify({ id: 't1', sessionId: 'session-abc', expiresAt: future, pad: 'x'.repeat(9_000) }));
    assert.equal(await readTrigger(file), null);

    // 不存在的文件
    assert.equal(await readTrigger(path.join(dir, 'missing.json')), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Host.triggerPath：默认在 $DSH_HOME/hwb，config 可覆盖', () => {
  const saved = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = '/tmp/custom-dsh';
    assert.equal(triggerPath({}), path.join('/tmp/custom-dsh', 'hwb', 'open-session.json'));
    assert.equal(triggerPath({ triggerPath: '/tmp/explicit/t.json' }), '/tmp/explicit/t.json');
    assert.equal(triggerPath({ triggerPath: '   ' }), path.join('/tmp/custom-dsh', 'hwb', 'open-session.json'));
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = saved;
  }
});

test('Host.apply：注册只读 GET 路由；405 与合法响应', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'open-session.json');
  const routes = [];
  const ctx = {
    webServer: { register(route) { routes.push(route); return () => {}; } },
    effect(fn) { fn(); },
    logger: { info() {} },
  };
  try {
    const future = Date.now() + 60_000;
    writeJsonFile(file, { id: 'abc', sessionId: 'session-1', expiresAt: future });
    apply(ctx, { triggerPath: file });

    assert.equal(routes.length, 1);
    assert.equal(routes[0].kind, 'exact');
    assert.equal(routes[0].path, ROUTE);
    assert.equal(routes[0].path, '/api/hwb-open-session');

    const ok = fakeResponse();
    await routes[0].handler({ method: 'GET' }, ok);
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.body), { ok: true, id: 'abc', sessionId: 'session-1', expiresAt: future });

    const method = fakeResponse();
    await routes[0].handler({ method: 'POST' }, method);
    assert.equal(method.status, 405);
    assert.equal(JSON.parse(method.body).ok, false);

    // 没有触发器时用 200 + ok:false（客户端按「无」处理，不当错误刷屏）
    fs.rmSync(file);
    const empty = fakeResponse();
    await routes[0].handler({ method: 'GET' }, empty);
    assert.equal(empty.status, 200);
    assert.deepEqual(JSON.parse(empty.body), { ok: false });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// —— Client 半：用假的 __ModuleLoader__ / window / fetch 驱动 ——

test('Client：轮询到新触发器才 open；同 id 不重复；过期忽略；dispose 后停止', async () => {
  const storage = new Map();
  let factory = null;
  globalThis.window = {
    __ModuleLoader__: { load(spec) { factory = spec.factory; } },
    __HWB_OPEN_SESSION_POLL_MS: 5,
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
    },
  };
  globalThis.fetch = async () => ({ ok: true, json: async () => pending });
  let pending = { ok: false };
  const opened = [];
  const legacy = [];
  const cleanups = [];
  let snapshot = { phase: 'loading', byId: {}, current: null };
  const uiWorkspace = { openSession: (id) => { opened.push(id); snapshot = { ...snapshot, current: id }; } };
  const ctx = {
    // dsh 0.2.x：视图选择在 uiWorkspace.openSession；ctx.sessions 没有 open()
    get: (name) => (name === 'uiWorkspace' ? uiWorkspace : undefined),
    sessions: {
      list: { getSnapshot: () => snapshot },
      open: (id) => { legacy.push(id); snapshot = { ...snapshot, current: id }; },
    },
    effect: (fn) => { cleanups.push(fn()); },
  };
  try {
    await import('../dsh-hwb-open-session/lib/client.js');
    assert.equal(typeof factory, 'function');
    const mod = factory();
    assert.equal(mod.inject[0], 'sessions');
    mod.apply(ctx);

    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    // sessions 未 ready：先不打开，等 ready 后同一触发器仍会被处理
    pending = { ok: true, id: 't1', sessionId: 'session-1', expiresAt: Date.now() + 60_000 };
    await wait(40);
    assert.deepEqual(opened, [], 'sessions 未 ready 时不能盲开');
    snapshot = { phase: 'ready', byId: { 'session-1': {} }, current: null };
    await wait(40);
    assert.deepEqual(opened, ['session-1']);
    assert.equal(storage.get('hwb:open-session:last'), 't1', '已处理 id 应持久化，刷新后不重复打开');

    // 同一个 id 反复返回：不能重复 open
    await wait(40);
    assert.deepEqual(opened, ['session-1']);

    // 过期触发器：忽略
    pending = { ok: true, id: 't2', sessionId: 'session-2', expiresAt: Date.now() - 1 };
    await wait(40);
    assert.deepEqual(opened, ['session-1']);

    // 新 id + 已知会话：打开
    pending = { ok: true, id: 't3', sessionId: 'session-2', expiresAt: Date.now() + 60_000 };
    snapshot = { phase: 'ready', byId: { 'session-1': {}, 'session-2': {} }, current: 'session-1' };
    await wait(40);
    assert.deepEqual(opened, ['session-1', 'session-2']);

    // 未知会话：重试 3 次后放弃，不刷屏
    pending = { ok: true, id: 't4', sessionId: 'session-missing', expiresAt: Date.now() + 60_000 };
    await wait(80);
    assert.equal(opened.includes('session-missing'), false);

    assert.deepEqual(legacy, [], '0.2.x 不应再调用不存在的 sessions.open');

    // dispose：不再轮询
    for (const fn of cleanups) fn();
    const before = opened.length;
    pending = { ok: true, id: 't5', sessionId: 'session-1', expiresAt: Date.now() + 60_000 };
    await wait(40);
    assert.equal(opened.length, before);
  } finally {
    delete globalThis.window;
    delete globalThis.fetch;
  }
});

test('Client：旧版 dsh（只有 sessions.open）仍能工作', async () => {
  const storage = new Map();
  let factory = null;
  globalThis.window = {
    __ModuleLoader__: { load(spec) { factory = spec.factory; } },
    __HWB_OPEN_SESSION_POLL_MS: 5,
    localStorage: { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)) },
  };
  let pending = { ok: true, id: 'legacy-1', sessionId: 'session-legacy', expiresAt: Date.now() + 60_000 };
  globalThis.fetch = async () => ({ ok: true, json: async () => pending });
  const opened = [];
  const cleanups = [];
  const ctx = {
    // 没有 uiWorkspace：回退到 0.1.x 的 sessions.open
    get: () => undefined,
    sessions: {
      list: { getSnapshot: () => ({ phase: 'ready', byId: { 'session-legacy': {} }, current: null }) },
      open: (id) => opened.push(id),
    },
    effect: (fn) => { cleanups.push(fn()); },
  };
  try {
    await import('../dsh-hwb-open-session/lib/client.js?legacy');
    factory().apply(ctx);
    await new Promise((r) => setTimeout(r, 40));
    assert.deepEqual(opened, ['session-legacy']);
    for (const fn of cleanups) fn();
  } finally {
    delete globalThis.window;
    delete globalThis.fetch;
  }
});
