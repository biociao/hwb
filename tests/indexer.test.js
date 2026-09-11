import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { IndexStore } from '../src/dshhome/store.js';
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

// 索引器 vs 3s 轮询器的竞态：索引器在读文件之后 `await liveStatus()`（一次 RPC，本机也可能几百毫秒），
// 期间轮询器可能已经写入了更新鲜的实时状态。若索引器随后照写自己那份更旧的快照，就会把新状态覆盖回去
// （实测：dsh 报 running、轮询器刚写成「运行中」，索引器把它改回「空闲」），而且整表替换还会删掉
// 窗口内新出现的会话，直到下一次轮询才回来。
test('indexer: 抓实时状态期间轮询器写过新数据时，索引器不得用更旧的快照覆盖', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hwb-race-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'storages'), { recursive: true });
  await writeFile(path.join(dir, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 }, global: { initialized: true, workspaceIds: ['w1'] },
    tables: { workspaces: { w1: { title: 'A', path: '/r/a', sessionIds: ['s1'] } } },
  }));
  await writeFile(path.join(dir, 'storages', 'session_projcache.json'), JSON.stringify({
    unit: { name: 'session_projcache', version: 3 }, global: null,
    tables: { sessions: { s1: { identity: { createdAt: Date.now(), cwd: '/r/a' }, rows: {} } } },
  }));

  const store = new IndexStore(':memory:');
  const homeId = store.registerHome({ homePath: dir });
  let releaseLive;
  const gate = new Promise((r) => { releaseLive = r; });
  const indexer = new Indexer({
    store,
    homes: () => [{ homeId, hostType: 'local', homePath: dir }],
    // 索引器的实时抓取会挂住，模拟一次慢 RPC；返回的是「更旧」的空闲状态
    liveStatus: async () => {
      await gate;
      return [{ sessionId: 's1', cwd: '/r/a', status: { kind: 'idle', label: '空闲', subagents: 0, approval: null },
        lastActivity: new Date().toISOString() }];
    },
  });

  // 先让索引器跑起来（它会卡在那次 RPC 上），不能先 await —— 那样就把自己锁死了
  const pending = indexer.reindexNow();
  await new Promise((r) => setTimeout(r, 30));
  // 索引器正在等 RPC —— 此刻轮询器写入更新鲜的「运行中」
  store.applyLiveStatus(homeId, [{ sessionId: 's1', cwd: '/r/a',
    status: { kind: 'running', label: '运行中', subagents: 0, approval: null }, lastActivity: new Date().toISOString() }]);
  releaseLive();                       // 放行索引器那份过期的快照
  const results = await pending;
  assert.equal(results.length, 1);

  const row = store.recentSessions({ homeId })[0];
  const kind = (typeof row.status === 'string' ? JSON.parse(row.status) : row.status)?.kind;
  assert.equal(kind, 'running', `轮询器写的新状态不该被索引器的旧快照覆盖（实际 ${kind}）`);
  store.close();
});

// 端点守卫：索引器抓实时状态期间用户切换了连接端点（同一个实例 id、另一个 dsh 进程），
// 那份实时数据属于**旧端点**，不该写进库。live-poller 一直有这句守卫，索引器这条路径原先没有。
test('indexer: 抓实时状态期间切换端点时，丢弃旧端点的实时数据', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hwb-epswitch-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'storages'), { recursive: true });
  await writeFile(path.join(dir, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 }, global: { initialized: true, workspaceIds: ['w1'] },
    tables: { workspaces: { w1: { title: 'A', path: '/r/a', sessionIds: ['s1'] } } },
  }));
  await writeFile(path.join(dir, 'storages', 'session_projcache.json'), JSON.stringify({
    unit: { name: 'session_projcache', version: 3 }, global: null,
    tables: { sessions: { s1: { identity: { createdAt: Date.now(), cwd: '/r/a' }, rows: {} } } },
  }));
  const store = new IndexStore(':memory:');
  const homeId = store.registerHome({ homePath: dir, hostType: 'local' });
  let release; const gate = new Promise((r) => { release = r; });
  const indexer = new Indexer({ store,
    homes: () => [{ homeId, hostType: 'local', homePath: dir }],
    liveStatus: async () => { await gate; return [{ sessionId: 's1', cwd: '/r/a',
      status: { kind: 'running', label: '运行中', subagents: 0, approval: null }, lastActivity: new Date().toISOString() }]; } });

  const pending = indexer.reindexNow();
  await new Promise((r) => setTimeout(r, 30));
  // 期间切换端点（用直接写库模拟 API 的 switch 效果）
  store.db.prepare('UPDATE homes SET activeEndpointId = ? WHERE homeId = ?').run('other-endpoint', homeId);
  release();
  await pending;
  const row = store.recentSessions({ homeId })[0];
  const kind = (typeof row.status === 'string' ? JSON.parse(row.status) : row.status)?.kind;
  assert.notEqual(kind, 'running', `旧端点的实时状态不该写进库（实际 ${kind}）`);
  store.close();
});

// 「抓实时状态期间轮询器已经写了更新的数据 → 丢弃自己这份」这条守卫原先没有测试：
// 审查把它改写成 `if (false) live = null;` 之后整个套件仍然全绿（610/609/0）。
// 它守的是：索引器拿一份**更旧**的快照把刚写进去的新状态覆盖回去
// （实测过：dsh 报 running、轮询器刚写成「运行中」，索引器把它改回「空闲」，
// 那份快照里还缺窗口期内新出现的会话，整表替换会把它们删掉）。
test('indexer: 抓取期间轮询器已写入更新数据时，丢弃自己这份 live', async () => {
  const live = [{
    sessionId: 'stale-live-session', cwd: '/r/p', title: '旧快照里的会话',
    status: { kind: 'idle', label: '空闲', subagents: 0, approval: null },
    lastActivity: '2026-09-06T07:30:00.000Z', tokenUsage: { outputTokens: 1 },
  }];
  const capturedRows = { rows: null };
  const store = {
    upsertRows: (rows) => { capturedRows.rows = rows; },
    markHomeError: () => {},
    // 关键：抓取结束后再问一次 → 返回**晚于**抓取开始时刻的时间戳，表示轮询器期间写过
    liveStatusAt: () => Date.now() + 1000,
    getHome: () => ({ homeId: 'aa'.repeat(8), activeEndpointId: null }),
  };
  const local = { homeId: 'aa'.repeat(8), homePath: mockHome, hostType: 'local' };
  const indexer = new Indexer({
    store, homes: () => [local], broadcast: () => {}, baseMs: 100, maxMs: 400,
    liveStatus: async () => live,
  });
  await indexer.reindexNow(local.homeId);
  assert.ok(capturedRows.rows, '索引应当照常落库');
  assert.ok(!capturedRows.rows.some((r) => r.sessionId === 'stale-live-session'),
    '轮询器已有更新数据时，索引器这份旧的 live 必须被丢弃（否则会把新状态覆盖回去）');
  assert.ok(capturedRows.rows.some((r) => r.type === 'session' && r.sessionId === 'sess-001'), '文件侧的会话照常入库');
});

test('indexer: 端点切换后丢弃这份 live（快照属于旧端点）', async () => {
  const live = [{ sessionId: 'ep-session', cwd: '/r/p', status: { kind: 'running', label: '运行中', subagents: 0, approval: null }, lastActivity: '2026-09-06T07:30:00.000Z' }];
  const capturedRows = { rows: null };
  // getHome 在「抓取前」与「抓取后」各被读一次：第一次 A、之后 B —— 模拟用户在 RPC 飞行途中切换端点
  let reads = 0;
  const store = {
    upsertRows: (rows) => { capturedRows.rows = rows; },
    markHomeError: () => {},
    liveStatusAt: () => 0,
    getHome: () => ({ homeId: 'aa'.repeat(8), activeEndpointId: ++reads <= 1 ? 'A' : 'B' }),
  };
  const local = { homeId: 'aa'.repeat(8), homePath: mockHome, hostType: 'local', activeEndpointId: 'A' };
  const indexer = new Indexer({
    store, homes: () => [local], broadcast: () => {}, baseMs: 100, maxMs: 400, liveStatus: async () => live,
  });
  await indexer.reindexNow(local.homeId);
  assert.ok(!capturedRows.rows.some((r) => r.sessionId === 'ep-session'), '端点已切换，旧端点的快照不能落库');
});
