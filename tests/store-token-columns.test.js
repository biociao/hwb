import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { IndexStore } from '../src/dshhome/store.js';

// 派生列（tokInput/tokOutput/tokCacheRead/tokCacheWrite）与 tokenUsage（JSON，真相）必须永远一致。
//
// 为什么要冗余：/api/usage 要跑八个聚合，逐行 json_extract 在真实规模下很贵（40k 会话实测
// 合计 ~330ms，而 node:sqlite 是同步的 —— 那段时间整个单线程服务都停着）。落成整数列后
// 聚合就是普通 SUM。
//
// 为什么这条测试用「直接对 JSON 跑 SQLite 的 json_extract」当**独立预言机**：
// 断言 store 的方法 == 我在测试里现写的旧式 SQL，而不是「store 的方法 == store 的方法」。
// 这样它既覆盖派生逻辑，也覆盖「两列与 JSON 不会漂移」这件事。

const LEGACY_SQL = {
  summary: `SELECT COUNT(*) AS sessionCount,
      COALESCE(SUM(CASE WHEN json_valid(tokenUsage) THEN json_extract(tokenUsage, '$.uncachedInputTokens') ELSE NULL END), 0) AS inputTokens,
      COALESCE(SUM(CASE WHEN json_valid(tokenUsage) THEN json_extract(tokenUsage, '$.outputTokens') ELSE NULL END), 0) AS outputTokens,
      COALESCE(SUM(CASE WHEN json_valid(tokenUsage) THEN json_extract(tokenUsage, '$.cacheReadTokens') ELSE NULL END), 0) AS cacheRead,
      COALESCE(SUM(CASE WHEN json_valid(tokenUsage) THEN json_extract(tokenUsage, '$.cacheWriteTokens') ELSE NULL END), 0) AS cacheWrite
    FROM sessions WHERE lastActivity IS NOT NULL AND lastActivity >= ?`,
  byProject: `SELECT project,
      COALESCE(SUM(COALESCE(CASE WHEN json_valid(tokenUsage) THEN json_extract(tokenUsage, '$.uncachedInputTokens') ELSE NULL END, 0)
        + COALESCE(CASE WHEN json_valid(tokenUsage) THEN json_extract(tokenUsage, '$.outputTokens') ELSE NULL END, 0)
        + COALESCE(CASE WHEN json_valid(tokenUsage) THEN json_extract(tokenUsage, '$.cacheReadTokens') ELSE NULL END, 0)
        + COALESCE(CASE WHEN json_valid(tokenUsage) THEN json_extract(tokenUsage, '$.cacheWriteTokens') ELSE NULL END, 0)), 0) AS tokens
    FROM sessions WHERE project IS NOT NULL AND lastActivity IS NOT NULL AND lastActivity >= ?
    GROUP BY project ORDER BY tokens DESC, project LIMIT 15`,
};

// 语料覆盖真实与恶心两种输入：完整、缺键、字符串数字、非法 JSON、null、空对象、负数、浮点。
const CORPUS = [
  { id: 'full', usage: { uncachedInputTokens: 100, outputTokens: 10, cacheReadTokens: 1, cacheWriteTokens: 2 } },
  { id: 'partial', usage: { uncachedInputTokens: 200, outputTokens: 20 } },
  { id: 'strings', usage: { uncachedInputTokens: '300', outputTokens: '30' } },
  { id: 'corrupt', raw: 'not json at all' },
  { id: 'empty-object', usage: {} },
  { id: 'float', usage: { uncachedInputTokens: 1.5, outputTokens: 2.25 } },
  { id: 'negative', usage: { uncachedInputTokens: -5, outputTokens: 5 } },
  { id: 'null-json', raw: null },
  { id: 'array', raw: '[1,2,3]' },
];

// 必须走**生产写入路径**（upsertRows）：派生列就是在那里算的。
// 直接用裸 SQL 插 sessions 只会得到默认值 0 —— 这本身说明了「新增写入者必须同时写派生列」，
// 下面的结构断言就是防这件事。
function seed(store) {
  const homeId = store.registerHome({ homePath: '/m', hostType: 'local' });
  const now = new Date().toISOString();
  const rows = CORPUS.map((c, i) => ({
    type: 'session', homeId, sessionId: c.id,
    workspaceId: null, workspaceTitle: null,
    project: `p${i % 2}`,
    title: null,
    tokenUsage: 'raw' in c ? c.raw : JSON.stringify(c.usage),
    contextPressure: null, status: JSON.stringify({ kind: 'idle' }),
    lastActivity: now, generatedAt: now, liveOnly: 0,
  }));
  // 只给 session 行：home 行的作用域会触发「整表替换」，这里不需要（也避免构造 home 的完整行形状）
  store.upsertRows(rows);
  return { homeId, now };
}

test('store: 派生列与 tokenUsage（JSON）逐项一致 —— 以 SQLite 的 json_extract 为独立预言机', () => {
  const store = new IndexStore(':memory:');
  const { now } = seed(store);
  const since = new Date(Date.parse(now) - 86_400_000).toISOString();

  // ① 每一行的四列都要等于 JSON 里对应的值
  const rows = store.db.prepare('SELECT sessionId, tokenUsage, tokInput, tokOutput, tokCacheRead, tokCacheWrite FROM sessions').all();
  for (const r of rows) {
    let v = null;
    try { v = JSON.parse(r.tokenUsage); } catch { v = null; }
    if (!v || typeof v !== 'object' || Array.isArray(v)) v = {};
    const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x
      : (typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x)) ? Number(x) : 0));
    assert.equal(r.tokInput, num(v.uncachedInputTokens), `${r.sessionId} 的 tokInput 与 JSON 不一致`);
    assert.equal(r.tokOutput, num(v.outputTokens), `${r.sessionId} 的 tokOutput 与 JSON 不一致`);
    assert.equal(r.tokCacheRead, num(v.cacheReadTokens), `${r.sessionId} 的 tokCacheRead 与 JSON 不一致`);
    assert.equal(r.tokCacheWrite, num(v.cacheWriteTokens), `${r.sessionId} 的 tokCacheWrite 与 JSON 不一致`);
  }

  // ② 聚合结果与旧式 SQL（直接对 JSON 跑 json_extract）逐项相等
  const legacy = store.db.prepare(LEGACY_SQL.summary).get(since);
  const fresh = store.usageSummary({ days: 1 });
  assert.equal(fresh.sessionCount, legacy.sessionCount);
  assert.equal(fresh.inputTokens, legacy.inputTokens);
  assert.equal(fresh.outputTokens, legacy.outputTokens);
  assert.equal(fresh.cacheRead, legacy.cacheRead);
  assert.equal(fresh.cacheWrite, legacy.cacheWrite);
  assert.equal(fresh.totalTokens, legacy.inputTokens + legacy.outputTokens + legacy.cacheRead + legacy.cacheWrite);

  const legacyByProject = store.db.prepare(LEGACY_SQL.byProject).all(since);
  const freshByProject = store.usageByProject({ days: 1 });
  assert.deepEqual(freshByProject.map((r) => [r.project, r.tokens]),
    legacyByProject.map((r) => [r.project, r.tokens]), '按项目聚合必须与旧式 SQL 一致');
  store.close();
});

test('store: 老库（只有 tokenUsage、没有派生列）升级时会被正确回填', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hwb-olddb-'));
  try {
    const file = path.join(dir, 'hwb.db');
    // 1) 先用当前 schema 建库并写入数据
    const a = new IndexStore(file);
    const { now } = seed(a);
    const before = a.usageSummary({ days: 1 });
    // 2) 模拟「老库」：把派生列删掉（SQLite 3.35+ 支持 DROP COLUMN；fail 就退化为只清值）
    try {
      for (const col of ['tokInput', 'tokOutput', 'tokCacheRead', 'tokCacheWrite']) {
        a.db.exec(`ALTER TABLE sessions DROP COLUMN ${col}`);
      }
    } catch {
      a.db.exec('UPDATE sessions SET tokInput = 0, tokOutput = 0, tokCacheRead = 0, tokCacheWrite = 0');
    }
    a.close();
    // 3) 重新打开：migrate() 应当补列并回填
    const b = new IndexStore(file);
    const cols = b.db.prepare("SELECT name FROM pragma_table_info('sessions')").all().map((c) => c.name);
    for (const col of ['tokInput', 'tokOutput', 'tokCacheRead', 'tokCacheWrite']) {
      assert.ok(cols.includes(col), `升级后应有 ${col} 列`);
    }
    const after = b.usageSummary({ days: 1 });
    assert.deepEqual(after, before, `回填后用量必须与升级前一致（before=${JSON.stringify(before)} after=${JSON.stringify(after)}）`);
    assert.ok(Date.parse(now) > 0);
    b.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// 派生列由触发器维护，所以**任何**写入者都不会让它漂移 —— 包括裸 SQL（外部工具改库、
// 或者像上面那些历史测试那样直接 INSERT）。这条测试就是那个保证：
// 走裸 SQL 写 tokenUsage，派生列必须自动跟上；改 tokenUsage 也要跟上。
test('store: 裸 SQL 写入 sessions 时派生列也由触发器自动维护（不会漂移）', () => {
  const store = new IndexStore(':memory:');
  const homeId = store.registerHome({ homePath: '/m', hostType: 'local' });
  const now = new Date().toISOString();
  const ins = store.db.prepare('INSERT INTO sessions (homeId, sessionId, project, lastActivity, status, tokenUsage) VALUES (?,?,?,?,?,?)');
  ins.run(homeId, 'raw-1', 'p', now, 'idle', JSON.stringify({ uncachedInputTokens: 7, outputTokens: 3 }));
  const row = store.db.prepare("SELECT tokInput, tokOutput, tokCacheRead, tokCacheWrite FROM sessions WHERE sessionId = 'raw-1'").get();
  assert.deepEqual({ ...row }, { tokInput: 7, tokOutput: 3, tokCacheRead: 0, tokCacheWrite: 0 },
    '裸 INSERT 之后触发器应已把派生列算好');

  // UPDATE 路径：换一份 tokenUsage，派生列要跟着变
  store.db.prepare("UPDATE sessions SET tokenUsage = ? WHERE sessionId = 'raw-1'")
    .run(JSON.stringify({ uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }));
  const after = store.db.prepare("SELECT tokInput, tokOutput, tokCacheRead, tokCacheWrite FROM sessions WHERE sessionId = 'raw-1'").get();
  assert.deepEqual({ ...after }, { tokInput: 1, tokOutput: 2, tokCacheRead: 3, tokCacheWrite: 4 }, 'UPDATE 之后也要跟上');

  // 非法 JSON：按 0（与旧 json_valid 守卫一致）
  store.db.prepare("UPDATE sessions SET tokenUsage = 'not json' WHERE sessionId = 'raw-1'").run();
  const corrupt = store.db.prepare("SELECT tokInput, tokOutput FROM sessions WHERE sessionId = 'raw-1'").get();
  assert.deepEqual({ ...corrupt }, { tokInput: 0, tokOutput: 0 });
  assert.equal(store.usageSummary({ days: 1 }).totalTokens, 0, '坏 JSON 行按 0 计入（不是报错，也不是旧值）');
  store.close();
});

// 审查的 HIGH：旧的迁移闸门是「看列在不在」，而四个 ALTER 各自自动提交、回填另起一个事务。
// 回填一旦失败（磁盘满、被杀 —— 4 万行约 60ms，窗口真实存在），列已经存在 ⇒ 下次启动不会再回填
// ⇒ **所有历史用量永久为 0**，且没有任何报错。现在：事务 + user_version 标记 + 逐列补齐 + 幂等回填。
test('store: 回填失败后重启必须自愈（不能把历史永久显示成 0）', async (t) => {
  const { chmodSync } = await import('node:fs');
  const dir = mkdtempSync(path.join(tmpdir(), 'hwb-migfail-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'hwb.db');
  const expected = 2000 * 1111;   // 1000 + 100 + 10 + 1

  // ① 造旧库形态（无派生列、user_version=0）
  const a = new IndexStore(file);
  const homeId = a.registerHome({ homePath: '/m', hostType: 'local' });
  const now = new Date().toISOString();
  a.upsertRows(Array.from({ length: 2000 }, (_, i) => ({ type: 'session', homeId, sessionId: `s${i}`, project: 'p', title: null,
    tokenUsage: JSON.stringify({ uncachedInputTokens: 1000, outputTokens: 100, cacheReadTokens: 10, cacheWriteTokens: 1 }),
    contextPressure: null, status: JSON.stringify({ kind: 'idle' }), lastActivity: now, generatedAt: now, liveOnly: 0 })));
  assert.equal(a.usageSummary({ days: 30 }).totalTokens, expected, '夹具前提');
  a.db.exec('DROP TRIGGER IF EXISTS sessions_tok_ai; DROP TRIGGER IF EXISTS sessions_tok_au;');
  for (const c of ['tokInput', 'tokOutput', 'tokCacheRead', 'tokCacheWrite']) a.db.exec(`ALTER TABLE sessions DROP COLUMN ${c}`);
  a.db.exec('PRAGMA user_version = 0');
  a.close();

  // ② 迁移写不进去（只读库）：必须**明确失败**并说清原因，而不是静默显示 0
  chmodSync(file, 0o444);
  let message = null;
  try { new IndexStore(file); } catch (e) { message = e.message; }
  chmodSync(file, 0o600);
  assert.ok(message, '只读库上的迁移必须抛错（静默显示 0 是最坏的结局）');
  assert.match(message, /迁移失败/, `错误信息应点名迁移，实际：${message}`);
  assert.match(message, /自动重试/, '应告诉用户修好后重启会自动重试');

  // ③ 修好之后重启：自动完成回填，数字必须分毫不差
  const b = new IndexStore(file);
  assert.equal(b.usageSummary({ days: 30 }).totalTokens, expected, '重启后必须自愈（而不是永久 0）');
  assert.equal(Number(b.db.prepare('PRAGMA user_version').get().user_version), 2, '成功后才抬 user_version');
  b.close();
});

// 多语句 exec 中途失败时，前面成功的语句是保留的 → 可能出现「四列只加了一部分」的库。
// 那种库会让每个用量查询报 no such column；按列判断才能补全。
test('store: 只加了一部分派生列的库也要能补全（不留 no such column）', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hwb-partial-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'hwb.db');
  const a = new IndexStore(file);
  const homeId = a.registerHome({ homePath: '/m', hostType: 'local' });
  const now = new Date().toISOString();
  a.upsertRows([{ type: 'session', homeId, sessionId: 's1', project: 'p', title: null,
    tokenUsage: JSON.stringify({ uncachedInputTokens: 5, outputTokens: 6 }), contextPressure: null,
    status: JSON.stringify({ kind: 'idle' }), lastActivity: now, generatedAt: now, liveOnly: 0 }]);
  assert.equal(a.usageSummary({ days: 30 }).totalTokens, 11);
  // 只留两列，另两列删掉 + user_version 归零（模拟「exec 中途失败」）
  a.db.exec('DROP TRIGGER IF EXISTS sessions_tok_ai; DROP TRIGGER IF EXISTS sessions_tok_au;');
  a.db.exec('ALTER TABLE sessions DROP COLUMN tokCacheRead');
  a.db.exec('ALTER TABLE sessions DROP COLUMN tokCacheWrite');
  a.db.exec('PRAGMA user_version = 0');
  a.close();

  const b = new IndexStore(file);
  const cols = b.db.prepare("SELECT name FROM pragma_table_info('sessions')").all().map((c) => c.name);
  for (const c of ['tokInput', 'tokOutput', 'tokCacheRead', 'tokCacheWrite']) assert.ok(cols.includes(c), `应补全 ${c}`);
  assert.equal(b.usageSummary({ days: 30 }).totalTokens, 11, '补全后用量查询必须可用');
  assert.equal(b.usageTrendGrouped({ dimension: 'total', hours: 24 }).buckets.reduce((x, y) => x + y.total, 0), 11);
  b.close();
});

// 端到端版本：实时通道只报了一部分计数器时，用量面板不能塌（审查实测塌过 109100 → 120）。
// 这是「投影缓存（文件）」与「dsh 实时 RPC」两路数据在 sessions.tokenUsage 这一列上的交接，
// 所以放在派生列这组测试里 —— 面板上的数字就是这四列的和。
test('applyLiveStatus: 实时只带部分计数时，其余计数保持文件索引的值（面板不塌）', () => {
  const store = new IndexStore(':memory:');
  const homeId = store.registerHome({ homePath: '/m', hostType: 'local' });
  const now = new Date().toISOString();
  const fileUsage = { uncachedInputTokens: 12400, outputTokens: 3200, cacheReadTokens: 88100, cacheWriteTokens: 5400 };
  store.upsertRows([{
    type: 'session', homeId, sessionId: 's1', project: 'p', title: 't',
    tokenUsage: JSON.stringify(fileUsage), contextPressure: null,
    status: JSON.stringify({ kind: 'idle', label: '空闲' }), lastActivity: now, generatedAt: now, liveOnly: 0,
  }]);
  assert.equal(store.usageSummary({ days: 30 }).totalTokens, 109100, '前置条件：文件索引的合计');

  store.applyLiveStatus(homeId, [{
    sessionId: 's1', cwd: '/r/p', title: 't2',
    status: { kind: 'running', label: '运行中', subagents: 0, approval: null },
    lastActivity: now,
    tokenUsage: { uncachedInputTokens: 100, outputTokens: 20 }, // dsh 只报了这两项
  }]);

  assert.equal(store.usageSummary({ days: 30 }).totalTokens, 93620,
    '实时没报的计数必须保留（没报 ≠ 归零），整列覆盖会塌成 120');
  // 部分用量不该影响其它字段的实时覆盖
  const row = store.recentSessions({ homeId }).find((s) => s.sessionId === 's1');
  assert.equal((typeof row.status === 'string' ? JSON.parse(row.status) : row.status).kind, 'running');
  assert.equal(row.title, 't2');
  store.close();
});

// user_version 只能证明「这一版代码写过这个库」，证明不了「列里的值与 tokenUsage 一致」。
// 审查构造的库：四列都在、user_version = 1（旧版本写的），但四列全是 0 —— 版本 1 的闸门直接放行，
// 于是历史用量**永久显示 0**，正是这套迁移本来要消灭的症状（实测：uv=0 能自愈、uv=1 不自愈）。
// 把迁移版本抬到 2 之后，所有既有库都会再跑一次幂等回填，列里的脏值随之被纠正。
test('store: 派生列全为 0 但 user_version=1 的库也要被回填纠正（版本闸门不能当数据正确的证据）', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hwb-uv1-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'hwb.db');
  const expected = 1234 + 56 + 7 + 1;
  const a = new IndexStore(file);
  const homeId = a.registerHome({ homePath: '/m', hostType: 'local' });
  const now = new Date().toISOString();
  a.upsertRows([{ type: 'session', homeId, sessionId: 's1', project: 'p', title: null,
    tokenUsage: JSON.stringify({ uncachedInputTokens: 1234, outputTokens: 56, cacheReadTokens: 7, cacheWriteTokens: 1 }),
    contextPressure: null, status: JSON.stringify({ kind: 'idle' }), lastActivity: now, generatedAt: now, liveOnly: 0 }]);
  assert.equal(a.usageSummary({ days: 30 }).totalTokens, expected, '前置条件：列里有正确的值');

  // 模拟「外部工具改过 / 从别处拷来的库」：触发器还在（不加触发器的话写入会立刻纠正，见下），
  // 但既有行的派生列是 0，且版本标记停在旧值 1。
  a.db.exec('DROP TRIGGER IF EXISTS sessions_tok_ai; DROP TRIGGER IF EXISTS sessions_tok_au;');
  a.db.exec('UPDATE sessions SET tokInput = 0, tokOutput = 0, tokCacheRead = 0, tokCacheWrite = 0');
  a.db.exec('PRAGMA user_version = 1');
  a.close();

  const b = new IndexStore(file);
  assert.equal(b.usageSummary({ days: 30 }).totalTokens, expected,
    'uv=1 却四列为 0 的库必须被重新回填（否则历史用量永久显示 0）');
  assert.equal(Number(b.db.prepare('PRAGMA user_version').get().user_version), 2);
  const trig = b.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND name IN ('sessions_tok_ai','sessions_tok_au')").get();
  assert.equal(Number(trig.n), 2, '触发器必须补齐');
  b.close();
});

// 「另一个进程正在使用这个库」与「权限/磁盘问题」的补救办法完全不同：前者不该让用户去改名或换路径
// （那等于把库整个换掉），后者才需要。审查指出原先任何失败都只给后者 —— 对瞬时锁是错建议。
test('store: 另一个进程持写锁时，错误消息给的是「谁在用」而不是「改名或换路径」', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hwb-locked-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'hwb.db');
  const held = new IndexStore(file);
  held.db.exec('BEGIN IMMEDIATE'); // 持住写锁：另一个连接的第一步（CREATE TABLE IF NOT EXISTS）就会失败
  let message = null;
  try { new IndexStore(file); } catch (e) { message = e.message; }
  held.db.exec('ROLLBACK');
  held.close();

  assert.ok(message, '持锁时应明确失败');
  assert.match(message, /locked|busy/i, `底层原因要保留：${message}`);
  assert.match(message, /另一个进程|hwb status/, `应指向「谁在用这个库」：${message}`);
  assert.doesNotMatch(message, /改名或换一个路径/, '瞬时锁不该建议用户换库');
});
