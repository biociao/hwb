import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexStore } from '../src/dshhome/store.js';
import { createApiServer } from '../src/api/server.js';

// tokenUsage 是 TEXT 列里存 JSON。`json_extract` 碰到**非法 JSON** 会让**整条 SQL**
// 报 `malformed JSON`，于是**一行**脏数据就把 /api/usage（以及 /api/projects/recent）
// 打成 500 —— 注意读路径上的 safeJsonParse 只保护行映射，管不到 SQL 聚合那一层。
// 这里用真 HTTP 服务端 + 真 IndexStore 复现：原实现下这几个请求会 500。
//
// 顺带守住另一条更隐蔽的坑：加法必须**逐项** COALESCE。写成
// `COALESCE(SUM(a + b + c + d), 0)` 时，某个键缺失 → 整个相加为 NULL → SUM 忽略该行，
// 于是总量**静默变少**（不报错，只是数字不对）。所以下面既测「不炸」也测「口径一致」。

const NOW = new Date().toISOString();

function seedStore() {
  const store = new IndexStore(':memory:');
  const homeId = store.registerHome({ homePath: '/m', hostType: 'local' });
  const ins = store.db.prepare(
    'INSERT INTO sessions (homeId, sessionId, project, lastActivity, status, tokenUsage) VALUES (?,?,?,?,?,?)'
  );
  // 完整的一行：113
  ins.run(homeId, 's-full', 'pA', NOW, 'idle', JSON.stringify({
    uncachedInputTokens: 100, outputTokens: 10, cacheReadTokens: 1, cacheWriteTokens: 2,
  }));
  // 缺两个字段的一行：靠**逐项** COALESCE 才能算出 220
  ins.run(homeId, 's-partial', 'pA', NOW, 'idle', JSON.stringify({
    uncachedInputTokens: 200, outputTokens: 20,
  }));
  // 外部工具写坏的一行：必须按 0 计入，而不是让整块面板不可用
  ins.run(homeId, 's-corrupt', 'pB', NOW, 'idle', 'not json at all');
  return { store, homeId };
}

const EXPECTED_TOTAL = 100 + 10 + 1 + 2 + 200 + 20; // 333

async function withRealStore(fn) {
  const { store, homeId } = seedStore();
  const server = createApiServer({
    store,
    indexer: { reindexNow: async () => [] },
    hub: { broadcast() {}, handle() {} },
    launcher: { status: () => null },
    // recentProjects 只统计**运行中**实例的项目，所以这里必须报 running
    monitor: { get: () => ({ runtime: 'running' }), refresh: async () => {} },
    quota: { list: () => [], refresh: async () => ({}) },
    logApi: { getLogs: () => [] },
    webRoot: '/nonexistent-web-root',
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn({ base, store, homeId });
  } finally {
    await new Promise((r) => server.close(r));
    store.close();
  }
}

test('api: tokenUsage 里有一行坏 JSON 时，/api/usage 仍然 200（原实现 500 malformed JSON）', async () => {
  await withRealStore(async ({ base }) => {
    const res = await fetch(`${base}/api/usage`);
    const body = await res.json();
    assert.equal(res.status, 200, `期望 200，实际 ${res.status}：${JSON.stringify(body)}`);
    assert.equal(body.summary.totalTokens, EXPECTED_TOTAL, '坏 JSON 行按 0 计入，好行仍要被统计');
    assert.equal(body.summary.sessionCount, 3);
  });
});

test('api: 坏 JSON 行不影响 /api/projects/recent（同一个 json_extract 坑的第二处入口）', async () => {
  await withRealStore(async ({ base }) => {
    const res = await fetch(`${base}/api/projects/recent`);
    const body = await res.json();
    assert.equal(res.status, 200, `期望 200，实际 ${res.status}：${JSON.stringify(body)}`);
    // recentProjects 把 cache 读/写也算进 inputTokens，所以 pA 总量 = 303 + 30 = 333
    const pA = body.projects.find((p) => p.project === 'pA');
    assert.equal(pA.inputTokens + pA.outputTokens, EXPECTED_TOTAL, 'pA 的两行都要算进去');
    // 坏 JSON 的那一行照旧出现在列表里（只是按 0 计入），不该被整条查询丢掉
    const pB = body.projects.find((p) => p.project === 'pB');
    assert.equal(pB.inputTokens, 0);
    assert.equal(pB.sessionCount, 1);
  });
});

test('store: 用量查询四套口径一致（summary / trend / trendGrouped / byProject）', async () => {
  const { store } = seedStore();
  const summary = store.usageSummary({ days: 30 });
  const trend = store.usageTrend({ hours: 24 });
  const grouped = store.usageTrendGrouped({ dimension: 'total', hours: 24 });
  const byProject = store.usageByProject({ days: 30 });

  const sum = (arr, k) => arr.reduce((a, r) => a + (r[k] ?? 0), 0);
  // 三套查询的字段名各不相同（trend 用 input/output/…，grouped 桶用 total），所以按各自口径折算总量
  const trendTotal = (rows) => rows.reduce(
    (a, r) => a + (r.input ?? 0) + (r.output ?? 0) + (r.cacheRead ?? 0) + (r.cacheWrite ?? 0), 0);
  assert.equal(summary.totalTokens, EXPECTED_TOTAL);
  assert.equal(trendTotal(trend), EXPECTED_TOTAL, 'trend 总量应与 summary 相同');
  assert.equal(sum(grouped.buckets, 'total'), EXPECTED_TOTAL, 'trendGrouped 总量应与 summary 相同');
  assert.equal(sum(byProject, 'tokens'), EXPECTED_TOTAL, 'byProject 总量应与 summary 相同');

  // 分项也要一致（缺字段的行不该被整行丢掉）
  assert.equal(summary.inputTokens, 300);
  assert.equal(summary.outputTokens, 30);
  assert.equal(summary.cacheRead, 1);
  assert.equal(summary.cacheWrite, 2);
  assert.equal(
    summary.inputTokens + summary.outputTokens + summary.cacheRead + summary.cacheWrite,
    summary.totalTokens,
    'totalTokens 必须等于四项之和'
  );
  store.close();
});

test('结构: 源码里每一处 json_extract 都带 json_valid 守卫（避免又漏一处入口）', async () => {
  const srcRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const files = (await readdir(srcRoot, { recursive: true }))
    .filter((f) => f.endsWith('.js'))
    .map((f) => path.join(srcRoot, f));
  const offenders = [];
  let checked = 0;
  for (const file of files) {
    const lines = (await readFile(file, 'utf8')).split('\n');
    lines.forEach((line, i) => {
      if (!line.includes('json_extract(')) return;
      if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) return; // 注释里的说明
      checked++;
      if (!line.includes('json_valid(')) offenders.push(`${path.relative(srcRoot, file)}:${i + 1}`);
    });
  }
  // 阈值只是「扫描器确实扫到了东西」的护栏，不是业务常量。
  // 用法聚合改用派生整数列之后，源码里的 json_extract 站点从 24 降到 8（剩下的主要是
  // sessions_tok_ai/au 两个维护派生列的触发器），所以这里跟着下调。
  assert.ok(checked >= 6, `应扫到足够多的 json_extract 站点，实际 ${checked}`);
  assert.deepEqual(offenders, [], `这些 json_extract 没有 json_valid 守卫，坏 JSON 会让整条 SQL 报错：${offenders}`);
});
