// 本地 dsh 的「Codex 式只读实例」：
//   · 与同 homePath 的可连接实例并存（独立 homeId），MBP 这类旧实例不受影响；
//   · 不做进程/端口/token 探测，runtime 直接按 home 目录是否存在判定；
//   · Recent / 用量对同一 home 只取一份（只读优先），避免重复行与重复计数；
//   · Instances 可检测、可添加；卡片不出现连接/断开。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IndexStore } from '../src/dshhome/store.js';
import { createRouter } from '../src/api/routes.js';
import { Monitor } from '../src/control/monitor.js';
import { InstanceRegistry } from '../src/control/registry.js';
import { tabHomes } from '../src/web/instance-state.js';
import { renderInstanceGrid } from '../src/web/components/instance-grid.js';
import { applyHomeMode, renderHomeForm, renderOnboarding, renderSettingsForm } from '../src/web/components/add-home.js';

function homeRow(homeId, extra = {}) {
  return {
    homeId, homePath: '/Users/me/.dsh', alias: 'MBP', hostType: 'local', harness: 'dsh',
    readOnly: 0, status: 'ok', sessionCount: 0, workspaceCount: 0, degraded: [], ...extra,
  };
}

test('store：只读实例与可连接实例可并存（不同 homeId）且互不覆盖', (t) => {
  const store = new IndexStore(); t.after(() => store.close());
  const normal = store.registerHome({ homePath: '/home/u/.dsh', alias: 'MBP' });
  const readOnly = store.registerHome({ homePath: '/home/u/.dsh', alias: 'MBP 只读', readOnly: true });
  assert.notEqual(normal, readOnly, '同一路径的两种模式必须是两个实例');
  assert.match(normal, /^[0-9a-f]{16}$/);
  assert.match(readOnly, /^[0-9a-f]{16}$/);
  const homes = store.listHomes();
  assert.equal(homes.length, 2);
  assert.equal(homes.find((h) => h.homeId === normal).readOnly, false);
  assert.equal(homes.find((h) => h.homeId === readOnly).readOnly, true);
  assert.equal(homes.find((h) => h.homeId === readOnly).homePath, '/home/u/.dsh');
  // 只读实例没有端点/token
  assert.deepEqual(store.getHome(readOnly).endpoints, []);
  assert.throws(() => store.registerHome({ homePath: '/x', hostType: 'remote', readOnly: true }), /只读实例只支持本机 dsh home/);
  assert.throws(() => store.registerHome({ homePath: '/x', harness: 'codex', readOnly: true }), /只读实例只支持本机 dsh home/);
});

test('monitor：只读 dsh 不探测 HTTP/端口，按目录存在判定 ready/gone', async (t) => {
  const store = new IndexStore(); t.after(() => store.close());
  const id = store.registerHome({ homePath: '/home/u/.dsh', readOnly: true });
  const home = store.getHome(id);
  let probed = false;
  const monitor = new Monitor({
    store: { listHomes: () => [home], getHome: () => home },
    launcher: { status: () => null },
    registry: new InstanceRegistry(),
    probe: async () => { probed = true; return true; },
    exists: () => true,
    broadcast: () => {},
    intervalMs: 60_000,
  });
  t.after(() => monitor.stop());
  await monitor.checkNow();
  assert.equal(monitor.get(id).runtime, 'running');
  assert.equal(probed, false, '只读实例不应触发网络探测');

  const gone = new Monitor({
    store: { listHomes: () => [home], getHome: () => home },
    launcher: { status: () => null },
    registry: new InstanceRegistry(),
    probe: async () => { throw new Error('不应探测'); },
    exists: () => false,
    broadcast: () => {},
    intervalMs: 60_000,
  });
  t.after(() => gone.stop());
  await gone.checkNow();
  assert.equal(gone.get(id).runtime, 'gone');
});

test('API：添加只读实例（readOnly=true）不要求端口/token，注册后索引', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hwb-ro-'));
  mkdirSync(path.join(dir, 'storages'), { recursive: true });
  writeFileSync(path.join(dir, 'storages', 'workspace.json'), '{}');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new IndexStore(); t.after(() => store.close());
  const calls = [];
  const route = createRouter({
    store,
    indexer: { reindexNow: async (homeId) => { calls.push(homeId); return [{ homeId }]; } },
    monitor: { get: () => ({ runtime: 'stopped' }), refresh: async () => ({}) },
    hub: { broadcast() {} },
    launcher: {},
    quota: { list: () => [], refresh: async () => [] },
    logApi: { getLogs: () => [] },
  });
  let status; let body;
  const req = { method: 'POST', async *[Symbol.asyncIterator]() { yield JSON.stringify({ homePath: dir, alias: 'RO', readOnly: true, harness: 'dsh' }); } };
  await route(req, { writeHead(s) { status = s; }, end(b) { body = JSON.parse(b); } }, new URL('http://local/api/homes'));
  assert.equal(status, 200);
  assert.equal(body.readOnly, true);
  assert.match(body.homeId, /^[0-9a-f]{16}$/);
  assert.equal(calls[0], body.homeId, '添加后应立即索引');
  const home = store.getHome(body.homeId);
  assert.equal(home.readOnly, true);
  assert.equal(home.hostType, 'local');
});

test('API：同 home 的只读实例优先展示，Recent 不出现两份、用量不重复计数', async (t) => {
  const store = new IndexStore(); t.after(() => store.close());
  const normal = store.registerHome({ homePath: '/home/u/.dsh', alias: 'MBP' });
  const readOnly = store.registerHome({ homePath: '/home/u/.dsh', alias: 'MBP 只读', readOnly: true });
  store.db.prepare("UPDATE homes SET status='ok' WHERE homeId IN (?, ?)").run(normal, readOnly);
  const now = new Date().toISOString();
  const usage = JSON.stringify({ uncachedInputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 });
  const ins = store.db.prepare('INSERT INTO sessions (homeId, sessionId, project, lastActivity, tokenUsage) VALUES (?,?,?,?,?)');
  ins.run(normal, 's1', 'p', now, usage);
  ins.run(readOnly, 's1', 'p', now, usage);

  const both = new Map([[normal, { runtime: 'running' }], [readOnly, { runtime: 'running' }]]);
  const route = createRouter({
    store,
    monitor: { get: (id) => both.get(id) ?? { runtime: 'stopped' }, refresh: async () => ({}) },
    indexer: { reindexNow: async () => [] },
    hub: { broadcast() {} },
    launcher: {},
    quota: { list: () => [], refresh: async () => [] },
    logApi: { getLogs: () => [] },
  });
  async function get(p) {
    let data;
    await route({ method: 'GET' }, { writeHead(s) { assert.equal(s, 200); }, end(b) { data = JSON.parse(b); } }, new URL(p, 'http://local'));
    return data;
  }
  const sessions = (await get('/api/sessions/recent')).sessions;
  assert.equal(sessions.length, 1, '同一 home 的会话只出现一次');
  assert.equal(sessions[0].homeId, readOnly, '优先归到只读实例（它不依赖连接）');

  const summary = store.usageSummary({ days: 3650 });
  assert.equal(summary.sessionCount, 1, '只读与可连接实例的会话不能重复计数');
  assert.equal(summary.totalTokens, 15);

  // 只读实例没有连接动作
  let status; let body;
  await route({ method: 'POST' }, { writeHead(s) { status = s; }, end(b) { body = JSON.parse(b); } }, new URL(`http://local/api/homes/${readOnly}/open`));
  assert.equal(status, 400);
  assert.match(body.error, /只读/);
});

test('UI：只读卡用统一的本地工具模板（身份+版本 / 已就绪 / 打开 dsh），无连接按钮；tab 不保留', () => {
  const runtime = { runtime: 'running', toolLabel: 'dsh', toolVersion: '0.2.0-rc.2', dshVersion: '0.2.0-rc.2' };
  const home = homeRow('ab'.repeat(8), { readOnly: true, sessionCount: 12, workspaceCount: 3, lastIndexedAt: new Date().toISOString(), runtime });
  const html = renderInstanceGrid([home]);
  // 契约 §3：与 Codex / WorkBuddy 同一段模板 —— 身份 chip 文本 = <label> <version>
  assert.match(html, /class="chip harness-dsh"[^>]*>dsh 0\.2\.0-rc\.2</);
  assert.match(html, /title="只读接入的 dsh 本地实例（版本 0\.2\.0-rc\.2）"/, '「只读」是类型说明，只进 title');
  assert.match(html, /class="chip ok">已就绪</);
  assert.doesNotMatch(html, /class="chip [^"]*">只读</, '只读不能再占状态位');
  assert.match(html, /索引 /);
  assert.match(html, /3 projects/);
  assert.doesNotMatch(html, /data-action="connect"/);
  assert.doesNotMatch(html, /data-action="disconnect"/);
  assert.match(html, /12 sessions/);
  assert.match(html, /class="primary" data-action="local-tool-open"[^>]*>打开 dsh</);
  assert.match(html, /重新索引/);
  assert.match(html, /⚙ 设置/);
  assert.deepEqual(tabHomes([home]), [], '只读实例没有 Web 页面');

  // 老后端只回 dshVersion、没有归一化的 toolVersion 时，dsh 版本仍要显示（回退路径）。
  const legacy = renderInstanceGrid([homeRow('cd'.repeat(8), { readOnly: true, runtime: { runtime: 'running', dshVersion: '0.1.5-rc.1' } })]);
  assert.match(legacy, /class="chip harness-dsh"[^>]*>dsh 0\.1\.5-rc\.1</);

  const form = renderHomeForm({ exists: true, path: '/Users/me/.dsh' });
  assert.match(form, /data-action="add-detected"[^>]*data-readonly="true"/);
  assert.match(form, /添加为只读实例/);
  // 只读 dsh 与 Codex / WorkBuddy 同处「只读本地工具」类型下拉里
  assert.match(form, /<option value="workbuddy">WorkBuddy（只读）<\/option>/);

  const onboarding = renderOnboarding({ exists: true, path: '/Users/me/.dsh', looksLikeDshHome: true });
  assert.match(onboarding, /(只读，不连接)/);

  const settings = renderSettingsForm({ ...home, readOnly: true });
  assert.match(settings, /data-readonly="true"/);
  assert.doesNotMatch(settings, /鉴权 token|接入端口|连接端点/);
});

test('applyHomeMode(local-readonly)：只留 homePath；隐藏 token/本地端口；默认值 ~/.dsh', () => {
  const form = {
    homePath: { hidden: false, placeholder: '', required: true, value: '' },
    host: { hidden: false, required: false }, remotePort: { hidden: false, required: false },
    remoteHome: { hidden: false }, remoteCmd: { hidden: false }, remoteLog: { hidden: false },
    token: { hidden: false }, localPort: { hidden: false }, accessPort: { hidden: false, disabled: false },
  };
  applyHomeMode(form, 'local-readonly');
  assert.equal(form.homePath.hidden, false);
  assert.equal(form.homePath.value, '~/.dsh');
  assert.equal(form.homePath.required, true);
  assert.equal(form.token.hidden, true);
  assert.equal(form.localPort.hidden, true);
  assert.equal(form.host.hidden, true);
  assert.equal(form.accessPort.hidden, true);
  // 切回本机：清掉只读默认值
  applyHomeMode(form, 'local');
  assert.equal(form.homePath.value, '');
  assert.equal(form.token.hidden, false);
});
