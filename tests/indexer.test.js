import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Indexer } from '../src/dshhome/indexer.js';
import { initLogger } from '../src/lib/logger.js';

// 单元测试静默日志，避免索引失败路径把 error 打进测试输出。
initLogger({ level: 'error', file: false, color: false, silent: true });

const mockHome = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mock-home');

function fixture({ liveStatus = null } = {}) {
  const local = { homeId: 'aa'.repeat(8), homePath: mockHome, hostType: 'local' };
  const remote = { homeId: 'bb'.repeat(8), homePath: 'ssh://fake:3080', hostType: 'remote', host: 'fake', remoteHome: '~/.dsh' };
  const captured = { rows: null, errors: [] };
  const store = {
    upsertRows: (rows) => { captured.rows = rows; },
    markHomeError: (homeId, error) => captured.errors.push({ homeId, error }),
  };
  const events = [];
  const indexer = new Indexer({
    store,
    homes: () => [local, remote],
    broadcast: (event, data) => events.push({ event, data }),
    baseMs: 100,
    maxMs: 400,
    remoteExec: async () => ({ code: 255, stdout: '', stderr: 'boom' }),
    liveStatus,
  });
  return { indexer, local, remote, captured, events };
}

test('indexer: per-home 退避——远程失败只加倍自己，本地保持 baseline', async () => {
  const { indexer, local, remote } = fixture();
  const results = await indexer.reindexNow();
  assert.equal(results.length, 2); // 首轮两个都到点
  assert.equal(indexer.backoffMs.get(local.homeId), 100);  // 成功：÷1.5 后 clamp 回 baseline
  assert.equal(indexer.backoffMs.get(remote.homeId), 200); // 失败：×2

  // 把两个实例都拨到「到点」，再跑一轮：本地仍 baseline，远程继续 ×2（不受彼此影响）
  indexer.nextDue.set(local.homeId, 0);
  indexer.nextDue.set(remote.homeId, 0);
  await indexer.reindexNow();
  assert.equal(indexer.backoffMs.get(local.homeId), 100);
  assert.equal(indexer.backoffMs.get(remote.homeId), 400);
});

test('indexer: 周期索引跳过未到点的实例，reindexNow(homeId) 强制立即执行', async () => {
  const { indexer, local, remote } = fixture();
  await indexer.reindexNow();

  // 紧接着的周期跑：两个都未到点 → 空结果
  const skipped = await indexer.reindexNow();
  assert.equal(skipped.length, 0);

  // 强制重索引未到点的远程实例：绕过退避立即执行，失败继续加倍自己的间隔
  const forced = await indexer.reindexNow(remote.homeId);
  assert.deepEqual(forced.map((r) => r.homeId), [remote.homeId]);
  assert.equal(indexer.backoffMs.get(remote.homeId), 400);
  assert.ok(indexer.backoffMs.get(local.homeId) === 100);
});

test('indexer: liveStatus 里 projcache 之外的新会话随索引入库', async () => {
  const live = [{
    sessionId: 'live-only-session',
    cwd: '/Volumes/repo/ciao/github.com/hwb',
    status: { kind: 'running', label: '运行中', subagents: 0, approval: null },
    lastActivity: '2026-09-06T07:30:00.000Z',
    tokenUsage: { outputTokens: 7 },
    title: '实时新会话',
  }];
  const { indexer, local, captured } = fixture({ liveStatus: async () => live });
  await indexer.reindexNow(local.homeId);
  const inserted = captured.rows.find((r) => r.type === 'session' && r.sessionId === 'live-only-session');
  assert.ok(inserted, 'live 独有的新会话应被补插进索引行');
  assert.equal(inserted.project, 'hwb');
  assert.equal(inserted.lastActivity, '2026-09-06T07:30:00.000Z');
  //  projcache 已有会话也应在（mock-home 自带 sess-001..）
  assert.ok(captured.rows.some((r) => r.type === 'session' && r.sessionId === 'sess-001'));
});

test('indexer: connection refresh arriving during indexing runs again after the active batch', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const { indexer, local } = fixture({ liveStatus: async () => {
    calls++;
    if (calls === 1) await gate;
    return null;
  } });
  const first = indexer.reindexNow(local.homeId);
  const connected = indexer.reindexNow(local.homeId);
  release();
  await Promise.all([first, connected]);
  assert.equal(calls, 2);
});

test('indexer: remote live state is read after the SSH snapshot completes', async () => {
  const order = [];
  const { indexer, remote } = fixture({ liveStatus: async () => { order.push('live'); return null; } });
  indexer.remoteExec = async () => { order.push('ssh'); return { code: 0, stdout: ['storages/workspace.json', 'storages/session_projcache.json', 'model-tier.json', '.credentials.yaml'].map((p) => `__DSH_FILE_BEGIN__:${p}\n__MISSING__\n__DSH_FILE_END__\n`).join(''), stderr: '' }; };
  await indexer.reindexNow(remote.homeId);
  assert.deepEqual(order, ['ssh', 'live']);
});

// 退避状态按 homeId 记，实例删除后没人清 —— 长跑（反复增删实例）下 backoffMs/nextDue 会一直涨。
test('Indexer: 实例被移除后，per-home 退避状态会被清掉', async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const pathMod = await import('node:path');
  const dir = await mkdtemp(pathMod.join(tmpdir(), 'hwb-idx-prune-'));
  let homes = [];
  const indexer = new Indexer({
    store: { upsertRows() {}, markHomeError() {} },
    homes: () => homes,
    baseMs: 60_000,
  });
  for (let i = 0; i < 20; i++) homes.push({ homeId: `h${i}`, hostType: 'local', homePath: dir });
  await indexer.reindexNow();
  assert.equal(indexer.backoffMs.size, 20);
  assert.equal(indexer.nextDue.size, 20);

  homes = [];
  await indexer.reindexNow();
  assert.equal(indexer.backoffMs.size, 0, '实例删除后不该继续留着它的退避状态');
  assert.equal(indexer.nextDue.size, 0);
});
