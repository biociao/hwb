import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { IndexStore } from '../src/dshhome/store.js';
import { normalize } from '../src/lib/normalize.js';
import { normalizeEndpoints } from '../src/lib/endpoints.js';
import { parseMultipart } from '../src/lib/multipart.js';

// 一轮对抗式纯函数审查提出的问题，逐条钉成回归测试。

// ── store：分时用量不得丢掉「当前这一小时」，且顺序应为旧→新 ──
test('usageTrend: 包含当前小时，且按时间从旧到新', () => {
  const store = new IndexStore(':memory:');
  t0(store);
  store.close();
});

function t0(store) {
  const homeId = store.registerHome({ homePath: '/m' });
  const now = new Date();
  store.db.prepare('INSERT INTO sessions (homeId, sessionId, project, lastActivity, tokenUsage) VALUES (?,?,?,?,?)')
    .run(homeId, 'now', 'p', now.toISOString(), JSON.stringify({ uncachedInputTokens: 1000 }));
  const trend = store.usageTrend({ hours: 24 });
  assert.equal(trend.length, 24, '24 小时应产出 24 个桶');
  assert.equal(trend.reduce((a, b) => a + b.input, 0), 1000,
    '当前小时的数据必须有桶可放 —— 原实现只列到 floor(now/H)-1，把当前小时整段丢了');
  const first = Date.parse(trend[0].ts);
  const last = Date.parse(trend[trend.length - 1].ts);
  assert.ok(first < last, '桶应按时间从旧到新排列（与 usageTrendGrouped 一致）');
  assert.equal(new Date(last).toISOString().slice(0, 13), now.toISOString().slice(0, 13),
    '最后一个桶应当是当前小时');
}

// ── store：usageTrend 的 SQL 窗口必须与它产出的桶完全重合 ──
// 两者错位时（原实现：SQL 从 `now - hours*H` 起，桶却从整点起）会有一小段
// 「查得出来、却没有桶可放」的行被静默丢掉 —— 白查一趟，而且两条趋势口径在边界上
// 悄悄不一致。这个错位在**输出上**看不出来（桶本来就是那个样子），所以只能钉住查询参数。
test('usageTrend: SQL 窗口起点与首个桶重合（不留「查出来却无桶可放」的边界段）', () => {
  const store = new IndexStore(':memory:');
  const homeId = store.registerHome({ homePath: '/m' });
  store.db.prepare('INSERT INTO sessions (homeId, sessionId, project, lastActivity, tokenUsage) VALUES (?,?,?,?,?)')
    .run(homeId, 's', 'p', new Date().toISOString(), JSON.stringify({ uncachedInputTokens: 1 }));

  const orig = store.db.prepare.bind(store.db);
  const seen = [];
  store.db.prepare = (sql) => {
    const st = orig(sql);
    if (!sql.includes('GROUP BY h')) return st;
    return { ...st, all: (...args) => { seen.push(args[0]); return st.all(...args); } };
  };
  const trend = store.usageTrend({ hours: 24 });
  store.db.prepare = orig;

  assert.equal(seen.length, 1, '应恰好执行一次分桶查询');
  assert.equal(seen[0], trend[0].ts, 'SQL 窗口起点必须等于首个桶的时间（原实现早了 H - now%H）');
  store.close();
});

// ── store：SUM(a + b + c + d) 里缺任何一项都会让整段变 NULL ──
test('usageSummary / usageByProject: 缺少任一 token 字段时总量仍正确', () => {
  const store = new IndexStore(':memory:');
  const homeId = store.registerHome({ homePath: '/m' });
  const now = new Date().toISOString();
  const ins = store.db.prepare('INSERT INTO sessions (homeId, sessionId, project, lastActivity, tokenUsage) VALUES (?,?,?,?,?)');
  ins.run(homeId, 'partial', 'p', now, JSON.stringify({ uncachedInputTokens: 1000 })); // 只给一个键
  ins.run(homeId, 'full', 'p', now, JSON.stringify({ uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }));
  // 原实现是 COALESCE(SUM(a + b + c + d), 0)：任何一个键缺失 → a+b+c+d = NULL → SUM 忽略 → 0
  assert.equal(store.usageSummary({ days: 1 }).totalTokens, 1010);
  assert.equal(store.usageByProject({ days: 1 })[0].tokens, 1010);
  store.close();
});

// ── store：providers 的 UNIQUE 冲突不该拖垮整个 home 索引 ──
test('upsertRows: 重复 provider ref 不再让整个事务回滚', () => {
  const store = new IndexStore(':memory:');
  const homeId = store.registerHome({ homePath: '/m' });
  const row = (type, extra) => ({ type, homeId, homePath: '/m', generatedAt: 'x', degraded: [], ...extra });
  store.upsertRows([
    row('home'),
    row('provider', { ref: 'OPENAI_API_KEY', provider: 'openai' }),
    row('provider', { ref: 'OPENAI_API_KEY', provider: 'openai' }), // 同 ref
  ]);
  assert.equal(store.getHome(homeId).providers.length, 1, '重复 ref 应收敛成一行，而不是抛错回滚');
  assert.equal(store.getHome(homeId).status, 'ok');
  store.close();
});

// ── endpoints：端口只接受真正的端口，主机名限长 ──
test('normalizeEndpoints: 端口不接受 Number() 的强制转换结果', () => {
  // Number(true)=1 / Number([22])=22 / Number('0x50')=80 / Number('1e3')=1000 —— 都会被静默接受
  for (const bad of [true, false, [22], '0x50', '1e3', 0.5, {}, null, -1, 65536, '']) {
    assert.throws(() => normalizeEndpoints([{ host: 'example.com', port: bad }], 'remote'),
      /有效的主机和端口/, `port=${JSON.stringify(bad)} 不该被接受`);
  }
  for (const good of [22, '22', ' 22 ']) {
    assert.equal(normalizeEndpoints([{ host: 'example.com', port: good }], 'remote')[0].port, 22, String(good));
  }
});

test('normalizeEndpoints: 主机名有长度上限（id/label 本来就有）', () => {
  assert.ok(normalizeEndpoints([{ host: 'x'.repeat(255), port: 22 }], 'remote')[0].host.length === 255);
  assert.throws(() => normalizeEndpoints([{ host: 'x'.repeat(256), port: 22 }], 'remote'), /有效的主机名/);
  assert.throws(() => normalizeEndpoints([{ host: '-oProxyCommand=x', port: 22 }], 'remote'), /有效的主机名/);
});

// ── normalize：导出函数，不该因为一个坏字段就把整个 home 的索引炸掉 ──
test('normalize: 缺字段/类型不对时兜底而不是抛错', () => {
  const cases = [
    ['缺全部数组', { homeId: 'h', homePath: '/h' }],
    ['path 不是字符串', { homeId: 'h', homePath: '/h', workspaces: [{ workspaceId: 'w', path: 42, title: 't', sessionIds: [] }], sessions: [], providers: [] }],
    ['cwd 不是字符串', { homeId: 'h', homePath: '/h', workspaces: [], sessions: [{ sessionId: 's', cwd: 42 }], providers: [] }],
    ['sessionIds 为 null', { homeId: 'h', homePath: '/h', workspaces: [{ workspaceId: 'w', path: '/p', sessionIds: null }], sessions: [], providers: [] }],
    ['tiers 为 null', { homeId: 'h', homePath: '/h', workspaces: [], sessions: [], providers: [], modelTier: { activeId: 'a', tiers: null } }],
    ['tier 为 null', { homeId: 'h', homePath: '/h', workspaces: [], sessions: [], providers: [], modelTier: { activeId: 'a', tiers: { a: null, b: { provider: 'p', model: 'm' } } } }],
    ['数组变字符串', { homeId: 'h', homePath: '/h', workspaces: 'x', sessions: null, providers: 0 }],
  ];
  for (const [name, snap] of cases) {
    assert.doesNotThrow(() => normalize(snap), name);
  }
  // 正常的输入仍然产出正确结果
  const rows = normalize({
    homeId: 'h', homePath: '/h', generatedAt: 'x', wsVersion: 2, pcVersion: 3,
    workspaces: [{ workspaceId: 'w1', title: 'A', path: '/r/a', archived: false, sessionIds: ['s1'] }],
    sessions: [{ sessionId: 's1', tokenUsage: { outputTokens: 1 }, lastActivity: 'x' }],
    modelTier: { activeId: 'std', tiers: { std: { provider: 'p', model: 'm' } } },
    providers: [], degraded: [],
  });
  assert.deepEqual(rows.filter((r) => r.type === 'workspace').map((r) => r.workspaceId), ['w1']);
  assert.deepEqual(rows.filter((r) => r.type === 'session').map((r) => r.workspaceId), ['w1']);
  assert.equal(rows.find((r) => r.type === 'modelTier').tierId, 'std');
});

// ── multipart：允许前导 CRLF 的正文必须在**任何**分片位置都能解析 ──
async function parseWithChunks(body, boundary, chunkSizes) {
  const req = new Readable({ read() {} });
  req.on('error', () => {});
  req.headers = { 'content-length': String(body.length) };
  const settles = [];
  const parsed = parseMultipart(req, {
    boundary, maxBytes: 1024 * 1024,
    onSettle: (_s, m) => { if (m) settles.push(m); },
    onFileStart: () => true, write: () => {},
  });
  parsed.catch(() => {});
  let at = 0, k = 0;
  while (at < body.length) { const n = chunkSizes[k++ % chunkSizes.length]; req.push(body.subarray(at, at + n)); at += n; }
  req.push(null);
  return parsed.then(() => 'OK', () => settles[0] ?? 'failed');
}

test('parseMultipart: 前导 CRLF 的正文在任何分片位置都能解析（不再依赖 TCP 分段）', async () => {
  const CRLF = '\r\n';
  const B = 'B';
  const body = (lead) => Buffer.from(
    `${lead}--${B}${CRLF}Content-Disposition: form-data; name="f"; filename="a.txt"${CRLF}${CRLF}hello${CRLF}--${B}--${CRLF}`
  );
  for (const [name, payload] of [['无前导', body('')], ['有前导 CRLF', body(CRLF)]]) {
    const outcomes = new Set();
    for (let split = 1; split < payload.length; split++) outcomes.add(await parseWithChunks(payload, B, [split]));
    outcomes.add(await parseWithChunks(payload, B, [payload.length]));
    outcomes.add(await parseWithChunks(payload, B, [1]));
    assert.deepEqual([...outcomes], ['OK'], `${name} 在某个分片位置失败了：${[...outcomes]}`);
  }
});

test('parseMultipart: 非 multipart 内容仍然被立刻拒绝（不被当成「还没读全」）', async () => {
  for (const junk of [Buffer.alloc(4096), Buffer.from('not-a-multipart-body')]) {
    assert.match(await parseWithChunks(junk, 'B', [7]), /格式无效/);
  }
});

// 非文件字段在前、文件在后时，解析器原先把**文件整个吞掉**：field 状态找的是收尾分隔符
// （`\r\n--boundary--`），于是在字段处直接跳到 done。结果是解析成功、零文件，
// 调用方只报一句令人费解的「没有收到文件内容」。
test('parseMultipart: 非文件字段在前时，后面的文件仍被正确解析', async () => {
  const CRLF = '\r\n';
  const B = 'B';
  const part = (headers, body) => `--${B}${CRLF}${headers}${CRLF}${CRLF}${body}${CRLF}`;
  const field = part('Content-Disposition: form-data; name="dir"', 'sub/dir');
  const file = part('Content-Disposition: form-data; name="file"; filename="a.txt"', 'hello world');
  const build = (order) => Buffer.from(order.map((k) => (k === 'file' ? file : field)).join('') + `--${B}--${CRLF}`);

  async function parseWith(buf, chunk) {
    const req = new Readable({ read() {} });
    req.on('error', () => {});
    req.headers = { 'content-length': String(buf.length) };
    const files = [];
    let current = null;
    const p = parseMultipart(req, {
      boundary: B, maxBytes: 1024 * 1024,
      onFileStart: (name) => { current = { name, bytes: 0 }; files.push(current); return true; },
      write: (c) => { if (current) current.bytes += c.length; },
    });
    p.catch(() => {});
    for (let i = 0; i < buf.length; i += chunk) req.push(buf.subarray(i, i + chunk));
    req.push(null);
    await p;
    return files.map((f) => `${f.name}:${f.bytes}`);
  }

  for (const [order, label] of [[['field', 'file'], '字段在前'], [['file', 'field'], '文件在前'], [['file'], '只要文件']]) {
    assert.deepEqual(await parseWith(build(order), 7), ['a.txt:11'], label);
    assert.deepEqual(await parseWith(build(order), 1), ['a.txt:11'], `${label}（1 字节切分）`);
  }
  // 只有字段时不该伪造出文件
  assert.deepEqual(await parseWith(build(['field']), 7), []);
});
