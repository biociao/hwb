import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readCredentials, queryBalance } from '../src/lib/balance.js';
import { QuotaService } from '../src/dshhome/quota.js';

const jsonRes = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

test('deepseek adapter parses balance_infos', async () => {
  const fetchImpl = async (url, opts) => {
    assert.equal(url, 'https://api.deepseek.com/user/balance');
    assert.equal(opts.headers.Authorization, 'Bearer sk-test');
    return jsonRes({ balance_infos: [{ currency: 'CNY', total_balance: '42.50' }] });
  };
  const r = await queryBalance({ provider: 'deepseek', key: 'sk-test' }, fetchImpl);
  assert.deepEqual(r, { provider: 'deepseek', remaining: 42.5, currency: 'CNY' });
});

test('kimi adapter parses available_balance', async () => {
  const fetchImpl = async () => jsonRes({ code: 0, data: { available_balance: 8.9 } });
  const r = await queryBalance({ provider: 'kimi', key: 'sk-test' }, fetchImpl);
  assert.deepEqual(r, { provider: 'kimi', remaining: 8.9, currency: 'CNY' });
});

test('queryBalance degrades errors instead of throwing', async () => {
  const boom = await queryBalance({ provider: 'deepseek', key: 'x' }, async () => { throw new Error('network down'); });
  // 错误被**分类**后再返回，不回显上游原始消息（见下一条测试的原因）
  assert.equal(typeof boom.error, 'string');
  assert.doesNotMatch(boom.error, /network down/, '不该把上游原始消息透给客户端');
  const httpErr = await queryBalance({ provider: 'kimi', key: 'x' }, async () => jsonRes({}, 401));
  assert.match(httpErr.error, /401/, '应保留下游可用的状态码信息');
  const unknown = await queryBalance({ provider: 'macstudio_local', key: 'x' }, async () => { throw new Error('should not be called'); });
  assert.equal(unknown.error, 'no adapter');
  const noApi = await queryBalance({ provider: 'zai', key: 'x' });
  assert.equal(noApi.error, 'no public balance API');
});

// /api/quota 是**未经鉴权**的 GET，任何本地进程都能读。而 Node 的 fetch 在 header 非法时
// 抛的消息里会带上 header 值本身（`Headers.append: "Bearer sk-…" is an invalid header value.`）——
// 若把 e.message 直接转发，一个含控制字符的 key 就会把明文 key 送进响应，
// 破坏本文件本来就承诺的不变量（§8.1「key NEVER 传给浏览器」）。
test('queryBalance: 上游/技术错误消息里的 key 绝不进入返回值', async () => {
  const secret = 'sk-live-SUPERSECRET-0001';
  const leaky = async () => { throw new Error(`Headers.append: "Bearer ${secret}" is an invalid header value.`); };
  const r = await queryBalance({ provider: 'deepseek', key: secret }, leaky);
  assert.doesNotMatch(JSON.stringify(r), /SUPERSECRET/, '响应里出现了明文 key');
  assert.match(r.error, /凭证格式无效/);

  // 其余分类也都不含请求内容
  for (const [err, re] of [
    [new Error('HTTP 403 Forbidden'), /403/],
    [new Error('The operation was aborted due to timeout'), /超时/],
  ]) {
    const out = await queryBalance({ provider: 'kimi', key: secret }, async () => { throw err; });
    assert.doesNotMatch(JSON.stringify(out), /SUPERSECRET/);
    assert.match(out.error, re);
  }
});

test('readCredentials reads refs: block with values', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hwb-cred-'));
  writeFileSync(path.join(dir, '.credentials.yaml'), 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-secret-1\n  ZAI_API_KEY: zzz\n');
  const creds = readCredentials(dir);
  assert.deepEqual(creds, [
    { ref: 'DEEPSEEK_API_KEY', key: 'sk-secret-1' },
    { ref: 'ZAI_API_KEY', key: 'zzz' },
  ]);
  rmSync(dir, { recursive: true, force: true });
});

test('QuotaService: TTL cache, single-flight, keys never leak', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hwb-quota-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, '.credentials.yaml'), 'refs:\n  DEEPSEEK_API_KEY: sk-must-not-leak\n');

  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return jsonRes({ balance_infos: [{ currency: 'CNY', total_balance: '100.00' }] });
  };
  const events = [];
  const store = {
    listHomes: () => [{
      homeId: 'h1',
      homePath: dir,
      providers: [{ ref: 'DEEPSEEK_API_KEY', provider: 'deepseek' }],
    }],
  };
  const svc = new QuotaService({ store, broadcast: (e, d) => events.push(e), fetchImpl, ttlMs: 60_000 });

  // 首屏：缓存空 → 立即返回空 + 后台触发刷新
  assert.deepEqual(svc.list(), []);
  await svc.refresh();
  assert.equal(calls, 1);

  const rows = svc.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].remaining, 100);
  assert.equal(rows[0].currency, 'CNY');
  assert.ok(!JSON.stringify(rows).includes('sk-must-not-leak'));

  // TTL 内不重复查询；强制 refresh 才再查
  await svc.refresh();
  assert.equal(calls, 2); // refresh 总是强制
  assert.ok(events.includes('quota:updated'));

  // 失败降级：fetch 全挂 → 行仍在，带 error
  const svcDown = new QuotaService({
    store,
    fetchImpl: async () => { throw new Error('offline'); },
    ttlMs: 60_000,
  });
  const down = await svcDown.refresh();
  assert.equal(down[0].provider, 'deepseek');
  assert.ok(down[0].error, '失败也要给出一个可展示的原因');
  assert.doesNotMatch(down[0].error, /offline/, '原因应是分类后的短文案，不是上游原始消息');
});

// 实例被删除后，它的额度条目没有任何人会来清 —— 会一直返回给客户端；
// 且那条记录的时间戳永远是旧的，于是每次 list() 都会再触发一次全量刷新 + SSE 广播。
test('QuotaService: 实例被移除后，它的额度条目会被清掉', async () => {
  let homes = [{ homeId: 'h1', homePath: '/m', providers: [{ ref: 'DEEPSEEK_API_KEY', provider: 'deepseek' }] }];
  const store = { listHomes: () => homes };
  const events = [];
  const svc = new QuotaService({
    store,
    broadcast: (e) => events.push(e),
    fetchImpl: async () => jsonRes({ data: { total_balance: '10.00', currency: 'CNY' } }),
    ttlMs: 60_000,
  });
  await svc.refresh();
  assert.equal(svc.list().length, 1);

  homes = []; // 实例被删除
  assert.deepEqual(svc.list(), [], '已移除实例的额度不该继续返回');
});

// 「缓存为空」原先被当成「永远 stale」：只要实例在但一个 provider 都没有（没配 credentials 很常见），
// 每次 GET /api/quota 都会再来一轮刷新 + quota:updated 广播。客户端若把它映射回 /api/quota 就是死循环。
test('QuotaService: 没有 provider 时不会每次 list 都重刷/重播', async () => {
  const store = { listHomes: () => [{ homeId: 'h1', homePath: '/m', providers: [] }] };
  const events = [];
  let refreshes = 0;
  const svc = new QuotaService({
    store,
    broadcast: (e) => events.push(e),
    fetchImpl: async () => { refreshes++; return jsonRes({}); },
    ttlMs: 60_000,
  });
  for (let i = 0; i < 5; i++) svc.list();
  await new Promise((r) => setTimeout(r, 50));
  // 第一次 list 会刷一轮（lastRefreshAt=0 → 视为 stale）；之后 TTL 内不该再刷。
  assert.ok(refreshes <= 1, `不应反复刷新，实际 ${refreshes} 次`);
  assert.ok(events.length <= 1, `TTL 内不该重复广播，实际 ${events.length} 次`);

  // 再等一轮确认已经稳定（不会随 list 次数线性增长）
  const before = events.length;
  for (let i = 0; i < 5; i++) svc.list();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(events.length, before, '重复调用 list 不应继续产生广播');
});

// 「有 provider 行、但没有对应凭据」是很常见的状态（key 还没配 / ref 改过名）。
// 原实现里这一支是 `(key ? queryBalance(...) : {…}).then(...)` —— 右侧是**普通对象**、
// 没有 .then，于是同步抛 TypeError，而且是在循环里抛：整批 provider（含其它实例）
// 一个都进不了缓存，quota:updated 也不会广播。整个额度功能表现为「一直没有数据」。
test('QuotaService: 缺少凭据 key 时仍能完成整批刷新（不再 TypeError）', async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const pathMod = await import('node:path');
  const homePath = await mkdtemp(pathMod.join(tmpdir(), 'hwb-quota-nokey-'));
  const events = [];
  const svc = new QuotaService({
    store: {
      listHomes: () => [
        { homeId: 'no-key', homePath, providers: [{ ref: 'DEEPSEEK_API_KEY', provider: 'deepseek' }] },
        { homeId: 'has-key', homePath, providers: [{ ref: 'KIMI_CODE_API_KEY', provider: 'kimi' }] },
      ],
    },
    broadcast: (e) => events.push(e),
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: { total_balance: '5', currency: 'CNY' } }) }),
    ttlMs: 60_000,
  });
  const rows = await svc.refresh();   // 此前这里会直接抛
  assert.equal(rows.length, 2, '两个 provider 都应产出条目，不能因为一个缺 key 就整批失败');
  assert.equal(rows.find((r) => r.homeId === 'no-key').error, 'key not found');
  assert.ok(events.some((e) => e === 'quota:updated'), '整批完成时应广播');

  // 单个 home 的凭据读取失败也要被隔离
  const svc2 = new QuotaService({
    store: { listHomes: () => [
      { homeId: 'bad', homePath: '/nonexistent-dir-for-test', providers: [{ ref: 'X_API_KEY', provider: 'deepseek' }] },
      { homeId: 'ok', homePath, providers: [{ ref: 'KIMI_CODE_API_KEY', provider: 'kimi' }] },
    ] },
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: { total_balance: '1', currency: 'CNY' } }) }),
    ttlMs: 60_000,
  });
  const rows2 = await svc2.refresh();
  assert.equal(rows2.length, 2, '一个实例的凭据异常不该让其它实例也拿不到额度');
});

// 额度失败原来只走 process.emitWarning：绕过脱敏管线、也不进环缓冲/SSE，
// 界面上的「日志区域」看不到任何原因，只能去翻 service.log。
// 现在两处都走结构化日志：balance 记分类原因（不记原始消息，因为它可能带请求内容），
// quota 记带 home/ref 上下文的一条；而「没公开余额 API」「还没配 key」这两种预期内空状态不刷屏。
test('quota: provider 失败会进结构化日志（带上下文、不含 key 原文、不刷屏）', async (t) => {
  const { initLogger, getLogs, clearLogs } = await import('../src/lib/logger.js');
  const { QuotaService } = await import('../src/dshhome/quota.js');
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const dir = await mkdtemp(path.join(tmpdir(), 'hwb-quota-log-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, '.credentials.yaml'), 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-naked-secret-1234567890\n');

  initLogger({ level: 'debug', file: false, silent: true });
  clearLogs();
  const svc = new QuotaService({
    store: { listHomes: () => [{ homeId: 'h1', homePath: dir, providers: [
      { ref: 'DEEPSEEK_API_KEY', provider: 'deepseek' },
      { ref: 'NOT_CONFIGURED', provider: 'missing' },
    ] }] },
    fetchImpl: async () => { throw new Error(`网络炸了 sk-naked-secret-1234567890`); },
  });
  const rows = await svc.refresh();
  assert.equal(rows.find((r) => r.ref === 'DEEPSEEK_API_KEY').error, '余额查询失败', 'UI 仍拿到分类结果');

  const logs = getLogs({ limit: 50 });
  const failed = logs.filter((l) => l.message === 'provider 额度刷新失败');
  assert.equal(failed.length, 1, `应恰好一条额度失败日志，实际 ${failed.length}`);
  assert.equal(failed[0].fields.homeId, 'h1');
  assert.equal(failed[0].fields.ref, 'DEEPSEEK_API_KEY');
  assert.equal(failed[0].fields.error, '余额查询失败', '只记分类结果');
  assert.ok(logs.some((l) => l.message === '余额查询失败'), 'balance 侧也要有一条');
  assert.doesNotMatch(JSON.stringify(logs), /sk-naked-secret/, '日志里不得出现 key');
  assert.equal(failed.some((l) => l.fields.ref === 'NOT_CONFIGURED'), false, '「还没配 key」不该记成失败');
});

// 「凭据文件读不出来」与「没配 key」原先在界面上都是「key not found」，完全无法区分。
// 现在非 ENOENT 的失败会记一条带路径的结构化日志（文件不存在仍保持安静）。
test('balance: 凭据文件存在但读不出来时给出原因，而不是当成「没配 key」', async (t) => {
  const { initLogger, getLogs, clearLogs } = await import('../src/lib/logger.js');
  const { readCredentials } = await import('../src/lib/balance.js');
  const { mkdtemp, rm, writeFile, chmod } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  initLogger({ level: 'debug', file: false, silent: true });

  const dir = await mkdtemp(path.join(tmpdir(), 'hwb-cred-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // ① 文件不存在 → 保持安静
  clearLogs();
  assert.deepEqual(readCredentials(dir), []);
  assert.equal(getLogs({ limit: 20 }).length, 0, '「没配」是正常状态，不该记日志');
  // ② 目录当成凭据文件（不是普通文件）→ 记一条 warn，且说明原因
  const weird = path.join(dir, 'weird');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.join(weird, '.credentials.yaml'), { recursive: true });
  clearLogs();
  assert.deepEqual(readCredentials(weird), []);
  const logs = getLogs({ limit: 20 });
  assert.equal(logs.length, 1, `应有一条日志，实际 ${logs.length}`);
  assert.equal(logs[0].level, 'warn');
  assert.match(logs[0].message, /凭据文件读取失败/);
  assert.match(String(logs[0].fields.error), /不是普通文件/, '原因要说清楚');
  assert.equal(logs[0].fields.homePath, weird);
});

// YAML 里 `KEY: "sk-x"` / `'sk-x'` / `sk-x  # 注释` 都是合法写法，原先只 trim 空白 ——
// 带引号的 key 会把引号一起发出去 → 上游 401 → UI 显示「凭证被拒绝（401/403）」，
// 用户以为自己的 key 失效（审查提出的 nit，但症状是误导性的）。
test('readCredentials: 引号与行尾注释按 YAML 规则取值', async () => {
  const { mkdtemp, writeFile, rm, mkdir } = await import('node:fs/promises');
  const { readCredentials, yamlScalar } = await import('../src/lib/balance.js');
  const dir = await mkdtemp(path.join(tmpdir(), 'hwb-cred-'));
  try {
    await mkdir(path.join(dir, 'storages'), { recursive: true });
    await writeFile(path.join(dir, '.credentials.yaml'), [
      'refs:',
      '  deepseek_API_KEY: "sk-double"',
      "  openai_API_KEY: 'sk-single'",
      '  anthropic_API_KEY: sk-plain   # 行尾注释',
      '  volc_API_KEY: sk-hash#inside',
      '',
    ].join('\n'));
    const creds = new Map(readCredentials(dir).map((c) => [c.ref, c.key]));
    assert.equal(creds.get('deepseek_API_KEY'), 'sk-double', '双引号要去掉');
    assert.equal(creds.get('openai_API_KEY'), 'sk-single', '单引号要去掉');
    assert.equal(creds.get('anthropic_API_KEY'), 'sk-plain', '行尾注释要去掉');
    assert.equal(creds.get('volc_API_KEY'), 'sk-hash#inside', '紧跟内容的 # 属于值本身');
    assert.equal(yamlScalar('  "x"  '), 'x');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
