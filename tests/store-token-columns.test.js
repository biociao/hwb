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
