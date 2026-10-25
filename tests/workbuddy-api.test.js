import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRouter } from '../src/api/routes.js';
import { localToolDefaultHome } from '../src/lib/harnesses.js';
import { initLogger } from '../src/lib/logger.js';

// WorkBuddy 作为「只读本地工具实例」接入 REST API（契约 §4）。
// 覆盖：/api/homes/detect 的 workbuddy 段、POST /api/homes 注册（默认 home / 缺库警告 /
// 目录不存在 400）、PUT 的只读配置面、以及 GET /api/homes 里 runtime.toolLabel/toolVersion
// 的归一化口径（含「dshVersion 只对 dsh 赋值」这条老 bug 的回归）。

initLogger({ level: 'error', file: false, color: false, silent: true });

const WB_HOME_ID = 'bc'.repeat(8);
const CODEX_HOME_ID = 'ab'.repeat(8);
const DSH_HOME_ID = 'cd'.repeat(8);

function makeWorkbuddyHome(dir, { db = true, version = '5.8.3' } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  if (version) fs.writeFileSync(path.join(dir, 'startup-seed-version.json'), JSON.stringify({ appVersion: version }));
  if (db) fs.writeFileSync(path.join(dir, 'workbuddy.db'), '');
  return dir;
}

function makeCodexHome(dir, version = '0.153.4') {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ latest_version: version }));
  fs.writeFileSync(path.join(dir, 'state_5.sqlite'), '');
  return dir;
}

function tmp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeRouter({ store = {}, indexer = {}, monitor = {}, dshVersion = null, localTools } = {}) {
  return createRouter({
    store: {
      getHome: () => null,
      listHomes: () => [],
      listWorkspaces: () => [],
      getSession: () => null,
      recentProjects: () => [],
      recentSessions: () => [],
      registerHome: () => 'newhome',
      updateHomeConfig: () => null,
      ...store,
    },
    indexer: { reindexNow: async () => [{}], ...indexer },
    hub: { broadcast() {} },
    launcher: { disconnect: async () => {} },
    monitor: { get: () => ({ runtime: 'running' }), refresh: async () => ({}), ...monitor },
    quota: { list: () => [], refresh: async () => [] },
    logApi: { getLogs: () => [] },
    dshVersion,
    ...(localTools !== undefined ? { localTools } : {}),
  });
}

async function request(route, method, pathname, { headers = {}, body } = {}) {
  const result = { status: null, body: null };
  const req = {
    method,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield typeof body === 'string' ? body : JSON.stringify(body);
    },
  };
  const res = {
    setHeader() {},
    writeHead(status) { result.status = status; },
    end(raw) { result.body = raw ? JSON.parse(raw) : null; },
  };
  await route(req, res, new URL(`http://127.0.0.1:4310${pathname}`));
  return result;
}

test('GET /api/homes/detect：workbuddy 段走描述符探测（默认 home 可被 WORKBUDDY_HOME 覆盖）', async (t) => {
  const dir = tmp(t, 'hwb-wb-detect-');
  makeWorkbuddyHome(path.join(dir, 'workbuddy'));
  const prev = process.env.WORKBUDDY_HOME;
  process.env.WORKBUDDY_HOME = path.join(dir, 'workbuddy');
  t.after(() => {
    if (prev === undefined) delete process.env.WORKBUDDY_HOME;
    else process.env.WORKBUDDY_HOME = prev;
  });

  const result = await request(makeRouter({}), 'GET', '/api/homes/detect');
  assert.equal(result.status, 200);
  assert.equal(result.body.workbuddy.path, path.join(dir, 'workbuddy'));
  assert.equal(result.body.workbuddy.exists, true);
  assert.equal(result.body.workbuddy.looksLikeWorkbuddy, true);
  // dsh 顶层形状与 codex 段保持不变
  assert.equal(typeof result.body.exists, 'boolean');
  assert.equal(typeof result.body.codex?.path, 'string');
  assert.ok(result.body.codex.path.endsWith('.codex'));
});

test('POST /api/homes：harness=workbuddy 注册本机只读实例并立即索引/刷新 runtime', async (t) => {
  const dir = tmp(t, 'hwb-wb-register-');
  const wbDir = makeWorkbuddyHome(path.join(dir, 'workbuddy'));

  let registered = null;
  const indexed = [];
  const refreshed = [];
  const route = makeRouter({
    store: { registerHome: (args) => { registered = args; return WB_HOME_ID; } },
    indexer: { reindexNow: async (homeId) => { indexed.push(homeId); return [{ homeId, ok: true, harness: 'workbuddy' }]; } },
    monitor: { refresh: async (homeId) => { refreshed.push(homeId); return {}; } },
  });

  const result = await request(route, 'POST', '/api/homes', {
    body: { harness: 'workbuddy', homePath: wbDir, alias: '我的 WorkBuddy' },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.harness, 'workbuddy');
  assert.equal(result.body.homeId, WB_HOME_ID);
  assert.equal(result.body.warning, null);
  assert.deepEqual(result.body.result, { homeId: WB_HOME_ID, ok: true, harness: 'workbuddy' });
  assert.deepEqual(registered, { homePath: wbDir, alias: '我的 WorkBuddy', hostType: 'local', harness: 'workbuddy' });
  assert.deepEqual(indexed, [WB_HOME_ID], '注册后立即索引，不等 60s 节拍');
  assert.deepEqual(refreshed, [WB_HOME_ID], '注册后立即刷新 runtime，否则卡片先显示路径缺失');

  // 目录存在但没有 workbuddy.db：仍可添加，但给出降级警告
  const noDbDir = path.join(dir, 'no-db');
  fs.mkdirSync(noDbDir);
  registered = null;
  const warned = await request(route, 'POST', '/api/homes', { body: { harness: 'workbuddy', homePath: noDbDir } });
  assert.equal(warned.status, 200);
  assert.match(warned.body.warning, /WorkBuddy home/);
  assert.match(warned.body.warning, /workbuddy\.db/);
  assert.equal(registered.harness, 'workbuddy');

  // 目录不存在 → 400，不落库
  registered = null;
  const missing = await request(route, 'POST', '/api/homes', { body: { harness: 'workbuddy', homePath: '/definitely/missing-workbuddy' } });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /not a directory/);
  assert.equal(registered, null);

  // 本地工具只支持本机 home：带远端字段要明确拒绝，而不是静默按本机注册
  const remote = await request(route, 'POST', '/api/homes', {
    body: { harness: 'workbuddy', hostType: 'remote', host: 'example.com', remotePort: 22 },
  });
  assert.equal(remote.status, 400);
  assert.match(remote.body.error, /只支持本机 home/);
  assert.equal(registered, null);
});

test('POST /api/homes：workbuddy 不传 homePath 时用描述符默认值（WORKBUDDY_HOME）', async (t) => {
  const dir = tmp(t, 'hwb-wb-default-');
  const wbDir = makeWorkbuddyHome(path.join(dir, 'workbuddy'));
  const prev = process.env.WORKBUDDY_HOME;
  process.env.WORKBUDDY_HOME = wbDir;
  t.after(() => {
    if (prev === undefined) delete process.env.WORKBUDDY_HOME;
    else process.env.WORKBUDDY_HOME = prev;
  });
  assert.equal(localToolDefaultHome('workbuddy'), wbDir);

  let registered = null;
  const route = makeRouter({ store: { registerHome: (args) => { registered = args; return WB_HOME_ID; } } });
  const result = await request(route, 'POST', '/api/homes', { body: { harness: 'workbuddy', alias: 'WB 默认' } });
  assert.equal(result.status, 200);
  assert.equal(registered.homePath, wbDir);
  assert.equal(registered.alias, 'WB 默认');
});

test('PUT /api/homes/{id}：WorkBuddy 的配置面只有 alias + homePath（忽略 token/端口/端点）', async (t) => {
  const dir = tmp(t, 'hwb-wb-put-');
  const wbDir = makeWorkbuddyHome(path.join(dir, 'workbuddy'));
  const nextDir = makeWorkbuddyHome(path.join(dir, 'workbuddy-2'));
  const home = { homeId: WB_HOME_ID, homePath: wbDir, alias: 'WB', hostType: 'local', harness: 'workbuddy', readOnly: false };

  let patched = null;
  const route = makeRouter({
    store: {
      getHome: () => home,
      updateHomeConfig: (_id, patch) => { patched = patch; return { ...home, ...patch }; },
    },
    monitor: { refresh: async () => ({}) },
  });

  const result = await request(route, 'PUT', `/api/homes/${home.homeId}`, {
    body: { alias: '新名字', homePath: nextDir, token: 'SHOULD-NOT-BE-SAVED', localPort: 9999, accessPort: 8888 },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(patched, { alias: '新名字', homePath: nextDir }, '只读本地工具的配置面只有 alias/homePath');
  assert.equal(result.body.home.alias, '新名字');

  // 目标路径不存在 → 400，不落库
  patched = null;
  const bad = await request(route, 'PUT', `/api/homes/${home.homeId}`, { body: { homePath: '/definitely/missing-wb' } });
  assert.equal(bad.status, 400);
  assert.equal(patched, null);
});

test('GET /api/homes：runtime.toolLabel/toolVersion 归一化，dshVersion 只对 dsh 赋值', async (t) => {
  const dir = tmp(t, 'hwb-runtime-');
  const codexDir = makeCodexHome(path.join(dir, 'codex'));
  const wbDir = makeWorkbuddyHome(path.join(dir, 'workbuddy'));

  const dshHome = { homeId: DSH_HOME_ID, homePath: path.join(dir, 'dsh'), alias: 'MBP', hostType: 'local', harness: 'dsh', readOnly: false };
  const codexHome = { homeId: CODEX_HOME_ID, homePath: codexDir, alias: 'Codex', hostType: 'local', harness: 'codex', readOnly: false };
  const wbHome = { homeId: WB_HOME_ID, homePath: wbDir, alias: 'WB', hostType: 'local', harness: 'workbuddy', readOnly: false };
  const readonlyDsh = { homeId: 'de'.repeat(8), homePath: path.join(dir, 'dsh'), alias: 'dsh 只读', hostType: 'local', harness: 'dsh', readOnly: true };

  const dshVersion = {
    resolve: (home) => (home.harness === 'dsh' ? '0.2.0-rc.2' : null),
    prune() {},
  };
  const route = makeRouter({
    store: { listHomes: () => [dshHome, codexHome, wbHome, readonlyDsh] },
    dshVersion,
  });

  const result = await request(route, 'GET', '/api/homes');
  assert.equal(result.status, 200);
  const byId = new Map(result.body.homes.map((h) => [h.homeId, h.runtime]));

  // 连接型 dsh：toolLabel 'dsh'，版本沿用 DshVersionResolver
  assert.deepEqual(byId.get(DSH_HOME_ID), {
    ...byId.get(DSH_HOME_ID), runtime: 'running', toolLabel: 'dsh', toolVersion: '0.2.0-rc.2', dshVersion: '0.2.0-rc.2',
  });

  // Codex：label/version 来自安装目录，dshVersion 必须为 null（不能把 dsh 版本塞进 Codex 卡）
  const codexRuntime = byId.get(CODEX_HOME_ID);
  assert.equal(codexRuntime.toolLabel, 'Codex');
  assert.equal(codexRuntime.toolVersion, '0.153.4');
  assert.equal(codexRuntime.dshVersion, null);

  // WorkBuddy：label/version 来自 startup-seed-version.json
  const wbRuntime = byId.get(WB_HOME_ID);
  assert.equal(wbRuntime.toolLabel, 'WorkBuddy');
  assert.equal(wbRuntime.toolVersion, '5.8.3');
  assert.equal(wbRuntime.dshVersion, null);

  // 本地 dsh 只读：仍是 dsh 身份，版本取 dsh 自己的
  const roRuntime = byId.get(readonlyDsh.homeId);
  assert.equal(roRuntime.toolLabel, 'dsh');
  assert.equal(roRuntime.toolVersion, '0.2.0-rc.2');
  assert.equal(roRuntime.dshVersion, '0.2.0-rc.2');
});

test('GET /api/homes：版本号取不到时 toolVersion=null，不画占位符（不伪造版本）', async (t) => {
  const dir = tmp(t, 'hwb-runtime-noversion-');
  const wbDir = makeWorkbuddyHome(path.join(dir, 'workbuddy'), { version: null });
  const wbHome = { homeId: WB_HOME_ID, homePath: wbDir, alias: 'WB', hostType: 'local', harness: 'workbuddy', readOnly: false };
  const route = makeRouter({ store: { listHomes: () => [wbHome] } });
  const result = await request(route, 'GET', '/api/homes');
  assert.equal(result.body.homes[0].runtime.toolLabel, 'WorkBuddy');
  assert.equal(result.body.homes[0].runtime.toolVersion, null);
});
