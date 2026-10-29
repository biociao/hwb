// 「观测盲区」契约：没有实时通道的实例（本地只读 dsh / 当前不可达）上，
// 等待审批（approval/request）永远观察不到 —— 所以「待介入 0」不能当成「没人需要你」。
//
// 2026-10-27 实测事故：一条 3 小时会话在只读实例（大肥鱼桌面版，readOnly）上弹审批，
// 仪表盘显示「空闲 / 待介入 0」，任务被晾着。修复分两层：
//   ① 状态层：新鲜度用投影文件 mtime（observedAt），长任务不再翻「空闲」（tests/status.test.js）；
//   ② 观测层：API 暴露 home.liveIntervention，UI 把「看不到」明确说出来（本文件）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IndexStore } from '../src/dshhome/store.js';
import { createRouter } from '../src/api/routes.js';

globalThis.document = {
  documentElement: { dataset: { theme: 'light' } },
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
};
globalThis.window = { matchMedia: () => ({ matches: false }) };

const { renderInterventionBanner } = await import('../src/web/components/workbench.js');
const { renderSessionStatusFilter, sessionStatusChip } = await import('../src/web/components/session-state.js');
const { renderInstanceGrid } = await import('../src/web/components/instance-grid.js');

const row = (extra = {}) => ({
  homeId: 'h1', sessionId: 's1', title: '会话', project: 'P', lastActivity: '2026-10-27T06:00:00Z',
  status: { kind: 'idle', label: '空闲' }, ...extra,
});

// —— 服务端：/api/homes 必须能区分「有实时通道」与「没有」 ——

async function getHomes(route) {
  let body;
  await route({ method: 'GET', headers: { host: '127.0.0.1:4310' } },
    { writeHead() {}, end(b) { body = JSON.parse(b); } },
    new URL('http://127.0.0.1:4310/api/homes'));
  return body;
}

test('GET /api/homes：liveIntervention 反映实例能否观察审批（未注入时为 null）', async (t) => {
  const store = new IndexStore(); t.after(() => store.close());
  const ro = store.registerHome({ homePath: '/home/u/.dsh', alias: 'RO', readOnly: true });
  const live = store.registerHome({ homePath: '/home/u/live', alias: 'LIVE' });
  const codex = store.registerHome({ homePath: '/home/u/.codex', alias: 'Codex', harness: 'codex' });
  const runtime = new Map([[ro, { runtime: 'running' }], [live, { runtime: 'running' }]]);
  const base = {
    store,
    monitor: { get: (id) => runtime.get(id) ?? { runtime: 'stopped' }, refresh: async () => ({}) },
    hub: { broadcast() {} },
    launcher: {},
    quota: { list: () => [], refresh: async () => [] },
    logApi: { getLogs: () => [] },
  };
  const route = createRouter({ ...base, liveIntervention: (h) => h.homeId === live });
  const body = await getHomes(route);
  const byId = new Map(body.homes.map((h) => [h.homeId, h]));
  assert.equal(byId.get(ro).liveIntervention, false, '只读实例没有实时通道 → 观测不到审批');
  assert.equal(byId.get(live).liveIntervention, true);
  assert.equal(typeof byId.get(live).runtime, 'object', '原有 runtime 字段形状不变');
  // 审批是 dsh 的概念：Codex / WorkBuddy 返回 null（不适用），不能被当成「观测盲区」噪音。
  assert.equal(byId.get(codex).liveIntervention, null);

  // 旧调用（未注入 liveIntervention）→ 字段存在但为 null：让前端区分「不知道」而不是冒充 false。
  const legacy = await getHomes(createRouter(base));
  assert.equal(legacy.homes.find((h) => h.homeId === ro).liveIntervention, null);
});

// —— 前端：把「看不到」明确说出来 ——

test('提示条：没有可见介入但有观测盲区时，画一条弱化说明（0 不等于没事）', () => {
  const blind = renderInterventionBanner(0, { unobserved: ['大肥鱼桌面版'] });
  assert.match(blind, /class="intervention-banner coverage"/);
  assert.match(blind, /1 个实例无实时通道（大肥鱼桌面版）/);
  assert.match(blind, /那里的等待审批看不到/);
  assert.equal(renderInterventionBanner(0, { unobserved: [] }), '', '没有盲区时保持旧语义：不画');
  assert.equal(renderInterventionBanner(0), '');

  // 有介入时：警示条照旧，并附上盲区说明（两种信息都要在）。
  const both = renderInterventionBanner(2, { unobserved: ['A', 'B'] });
  assert.match(both, /<b>2<\/b> 个会话需要你操作/);
  assert.match(both, /2 个实例无实时通道（A、B）/);
  assert.match(both, /data-status-filter="intervention"/);

  // 实例名来自用户输入（alias 可任意填）→ 必须转义。
  const evil = renderInterventionBanner(0, { unobserved: ['"><img src=x onerror=alert(1)>'] });
  assert.doesNotMatch(evil, /<img/);
});

test('筛选条：待介入按钮的 title 说明有几个实例是未观测的', () => {
  const blind = renderSessionStatusFilter([], 'all', { unobserved: 2 });
  assert.match(blind, /data-status-filter="intervention"[^>]*title="其中 2 个实例无实时通道/);
  assert.doesNotMatch(renderSessionStatusFilter([], 'all'), /无实时通道/, '没有盲区时不加噪音');
});

test('状态 chip：无实时通道的实例加 tooltip 说明（不改状态文案）', () => {
  assert.match(sessionStatusChip(row(), { unobserved: true }), /该实例无实时通道，等待审批 \/ 提问可能看不到/);
  assert.doesNotMatch(sessionStatusChip(row()), /无实时通道/);
  // 文案本身不能被改：没有证据时不能把「空闲」写成「等待审批」。
  assert.match(sessionStatusChip(row(), { unobserved: true }), /空闲/);
});

test('实例卡：只读 dsh 卡上有「无实时通道」chip，可连接实例没有', () => {
  const home = {
    homeId: 'h1', alias: '大肥鱼桌面版', homePath: '/Users/u/.dsh', harness: 'dsh', readOnly: true,
    runtime: { runtime: 'running' }, liveIntervention: false, workspaceCount: 44, sessionCount: 1961,
    degraded: [], lastIndexedAt: '2026-10-27T06:00:00Z',
  };
  const html = renderInstanceGrid([home]);
  assert.match(html, /无实时通道/);
  assert.match(html, /title="只读接入：没有实时通道/);
  assert.doesNotMatch(renderInstanceGrid([{ ...home, liveIntervention: true }]), /无实时通道/,
    '能观测时不能挂这个 chip');
});
