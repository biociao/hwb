import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readHome, homeIdOf, parseCredentialsYaml, buildSnapshot, STORAGE_PATHS } from '../src/lib/read-home.js';

// 一份合法的 workspace.json（single 布局）。per-record 相关用例里要给上它，
// 否则 buildSnapshot 会把 workspace 域判 degraded，断言就指不准 projcache 了。
const WS_JSON = JSON.stringify({
  unit: { name: 'workspace', version: 2 },
  global: { initialized: true, workspaceIds: [] },
  tables: { workspaces: {} },
});

let homePath;

function writeHome(overrides = {}) {
  homePath = mkdtempSync(path.join(tmpdir(), 'dsh-test-'));
  mkdirSync(path.join(homePath, 'storages'), { recursive: true });
  const files = {
    'storages/workspace.json': {
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: ['ws-1'] },
      tables: { workspaces: { 'ws-1': { title: 'T', path: '/r/proj', sessionIds: ['s1'] } } },
    },
    'storages/session_projcache.json': {
      unit: { name: 'session_projcache', version: 3 },
      global: null,
      tables: {
        sessions: {
          s1: {
            identity: { createdAt: 1786665487928, cwd: '/r/proj' },
            rows: {
              title: { ver: 1, seq: 1, val: 'test session' },
              tokenUsage: { ver: 1, seq: 1, val: { totals: { uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 } } },
            },
          },
        },
      },
    },
    'model-tier.json': {
      schema: 2,
      activeId: 'scheme-1',
      schemes: [{ id: 'scheme-1', tiers: { default: { provider: 'deepseek', model: 'deepseek-chat' } } }],
    },
    '.credentials.yaml': 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-real-looking-secret-value\n  KIMI_CODE_API_KEY: another-secret\n',
    ...overrides,
  };
  for (const [rel, content] of Object.entries(files)) {
    if (content === null) continue;
    writeFileSync(path.join(homePath, rel), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return homePath;
}

after(() => {
  if (homePath) rmSync(homePath, { recursive: true, force: true });
});

test('readHome produces a HomeSnapshot with 16-hex homeId', () => {
  writeHome();
  const snap = readHome(homePath);
  assert.equal(snap.homeId, homeIdOf(homePath));
  assert.match(snap.homeId, /^[0-9a-f]{16}$/);
  assert.equal(snap.wsVersion, 2);
  assert.equal(snap.pcVersion, 3);
  assert.equal(snap.workspaces.length, 1);
  assert.equal(snap.sessions.length, 1);
  assert.equal(snap.sessions[0].tokenUsage.outputTokens, 2);
  assert.equal(snap.sessions[0].title, 'test session');
  // 无状态类投影 → 默认空闲
  assert.deepEqual(snap.sessions[0].status, { kind: 'idle', label: '空闲', subagents: 0, approval: null });
  assert.equal(snap.modelTier.activeId, 'scheme-1');
  assert.deepEqual(snap.degraded, []);
});

test('readHome extracts provider names without key values', () => {
  writeHome();
  const snap = readHome(homePath);
  assert.deepEqual(snap.providers, [
    { ref: 'DEEPSEEK_API_KEY', provider: 'deepseek' },
    { ref: 'KIMI_CODE_API_KEY', provider: 'kimi' },
  ]);
  assert.ok(!JSON.stringify(snap).includes('sk-real-looking-secret-value'));
});

test('readHome degrades only the unknown-version domain', () => {
  writeHome({ 'storages/session_projcache.json': { unit: { version: 9 }, tables: { sessions: {} } } });
  const snap = readHome(homePath);
  assert.equal(snap.sessions.length, 0);
  assert.equal(snap.pcVersion, null);
  assert.equal(snap.workspaces.length, 1);
  assert.deepEqual(snap.degraded.map((d) => d.domain), ['projcache']);
  assert.match(snap.degraded[0].error, /unsupported version 9/);
});

test('readHome treats missing optional files (model-tier/credentials) as empty, not degraded', () => {
  writeHome({ 'model-tier.json': null, '.credentials.yaml': null });
  const snap = readHome(homePath);
  assert.equal(snap.modelTier, null);
  assert.equal(snap.providers.length, 0);
  assert.deepEqual(snap.degraded.map((d) => d.domain), []); // 可选文件缺失不 degraded
  assert.equal(snap.workspaces.length, 1);
});

test('readHome degrades a present but invalid model-tier.json', () => {
  writeHome({ 'model-tier.json': { schema: 2, activeId: 'x' } }); // 缺 schemes → 非法
  const snap = readHome(homePath);
  assert.equal(snap.degraded.some((d) => d.domain === 'modelTier'), true);
});

test('parseCredentialsYaml reads the refs: block, skips comments and non-keys', () => {
  const providers = parseCredentialsYaml([
    '# comment',
    'version: 1',
    'refs:',
    '  OTHER_SETTING: not-a-key',
    '  EMPTY_API_KEY:',
    '  ZAI_API_KEY: zzz',
    'other_section:',
    '  IGNORED_API_KEY: out-of-refs',
  ].join('\n'));
  assert.deepEqual(providers, [{ ref: 'ZAI_API_KEY', provider: 'zai' }]);
});

test('parseCredentialsYaml also accepts flat top-level keys', () => {
  const providers = parseCredentialsYaml('DEEPSEEK_API_KEY: x\n');
  assert.deepEqual(providers, [{ ref: 'DEEPSEEK_API_KEY', provider: 'deepseek' }]);
});

test('buildSnapshot builds the same snapshot from a pluggable readText/exists map (remote-reader shape)', () => {
  // 模拟 remote-reader 的「文件集」形式：存在 → 文本；缺失 → 不存在。
  const workspaceJson = JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['ws-1'] },
    tables: { workspaces: { 'ws-1': { title: 'R', path: '/remote/proj', sessionIds: ['s1'] } } },
  });
  const projcacheJson = JSON.stringify({
    unit: { name: 'session_projcache', version: 3 },
    global: null,
    tables: {
      sessions: {
        s1: {
          identity: { createdAt: 1, cwd: '/remote/proj' },
          rows: {
            title: { ver: 1, seq: 1, val: 'remote session' },
            tokenUsage: { ver: 1, seq: 1, val: { totals: { uncachedInputTokens: 9, outputTokens: 9, cacheReadTokens: 9, cacheWriteTokens: 9 } } },
          },
        },
      },
    },
  });
  const files = {
    'storages/workspace.json': workspaceJson,
    'storages/session_projcache.json': projcacheJson,
  };
  const snap = buildSnapshot({
    homePath: 'ssh://c4g:3080',
    readText: (rel) => {
      if (!(rel in files)) throw new Error(`missing ${rel}`);
      return files[rel];
    },
    exists: (rel) => rel in files,
  });
  assert.equal(snap.homeId, homeIdOf('ssh://c4g:3080'));
  assert.equal(snap.wsVersion, 2);
  assert.equal(snap.pcVersion, 3);
  assert.equal(snap.workspaces.length, 1);
  assert.equal(snap.sessions.length, 1);
  assert.equal(snap.sessions[0].title, 'remote session');
  assert.equal(snap.sessions[0].tokenUsage.outputTokens, 9);
  assert.equal(snap.modelTier, null);
  assert.deepEqual(snap.degraded.map((d) => d.domain), []); // 可选文件缺失不 degraded
});

test('buildSnapshot degrades a required file that readText reports missing', () => {
  const snap = buildSnapshot({
    homePath: '/h',
    readText: (rel) => { throw new Error(`missing ${rel}`); },
    exists: () => false,
  });
  // workspace 是 single 布局的必需文件：读不到 → degraded（沿用原语义）。
  //
  // projcache **不再**因「文件缺失」而 degraded：dsh 已迁到 per-record 布局
  // （`storages/session_projcache/sessions/`），聚合文件在新版 home 上本来就可能没有。
  // 「文件不存在」= 这个 home 没有该数据（新 home / 旧版本没有该布局），**不是**版本不兼容；
  // 把它判 degraded 会让一个只有 per-record 数据的实例整块显示为空。
  // 真正的版本不兼容（文件在、但版本不认识）仍然 degraded —— 见下面那条用例。
  assert.deepEqual(snap.degraded.map((d) => d.domain).sort(), ['workspace']);
  assert.equal(snap.workspaces.length, 0);
  assert.equal(snap.sessions.length, 0);
});

test('buildSnapshot: per-record 目录能读出会话（dsh 的新布局）', () => {
  const dir = 'storages/session_projcache/sessions';
  const rec = (title, v = 7) => JSON.stringify({
    version: v,
    record: { identity: { createdAt: 1, cwd: '/p' }, rows: { title: { ver: 1, seq: 1, val: title } } },
  });
  const snap = buildSnapshot({
    homePath: '/h',
    readText: (rel) => {
      if (rel === 'storages/workspace.json') return WS_JSON;
      if (rel === `${dir}/a.json`) return rec('A');
      if (rel === `${dir}/b.json`) return rec('B', 5);   // 混版本也要读得出
      throw new Error(`missing ${rel}`);
    },
    // 聚合文件不存在（新版 home 的常态）
    exists: (rel) => rel === 'storages/workspace.json',
    listDir: (rel) => (rel === dir ? ['a.json', 'b.json', 'a.json.bak.202601010000'] : null),
  });
  // .bak.* 文件被忽略（dsh 的 invalidRecords:'backup-and-skip' 产物）
  assert.deepEqual(snap.sessions.map((s) => s.title).sort(), ['A', 'B']);
  assert.deepEqual(snap.degraded.map((d) => d.domain), []);
  assert.equal(snap.sessions.find((s) => s.title === 'A').sessionId, 'a');
});

test('buildSnapshot: 版本不认识的 projcache 记录仍判 degraded（真正的版本漂移）', () => {
  const dir = 'storages/session_projcache/sessions';
  const snap = buildSnapshot({
    homePath: '/h',
    // workspace 正常、只有 projcache 是「未来版本」：这样断言能精确指向 projcache 的降级。
    readText: (rel) => (rel === 'storages/workspace.json'
      ? WS_JSON
      : JSON.stringify({ version: 99, record: { identity: { createdAt: 1 }, rows: {} } })),
    exists: (rel) => rel === 'storages/workspace.json',
    listDir: (rel) => (rel === dir ? ['x.json'] : null),
  });
  assert.equal(snap.sessions.length, 0);
  assert.deepEqual(snap.degraded.map((d) => d.domain), ['projcache'],
    '磁盘上有文件但一个都读不出（版本不认识）→ 必须 degraded，让界面能归因');
});

// ── readMetadataFile 的 TOCTOU 加固（O_NOFOLLOW + 以 fd 为准复核） ──
// lstat 查的是**路径**、open 拿到的是**另一个瞬间的对象**，两者之间有一个窗口：
// 窗口内被换成符号链接就能把 home 之外的文件读进来（持久化进 hwb.db 并展示给浏览器），
// 被换成 FIFO 就能把进程永久卡住。这个窗口无法在测试里稳定撞上（要精确控制时序），
// 所以这里分两条守：① 合法场景不被误伤（硬链接仍是普通文件）② 加固代码本身不被悄悄删掉。
test('readMetadataFile: 硬的普通文件（硬链接）仍可正常读取，不被 O_NOFOLLOW 误伤', async () => {
  const { linkSync } = await import('node:fs');
  const { readMetadataFile } = await import('../src/lib/read-home.js');
  const dir = mkdtempSync(path.join(tmpdir(), 'hwb-hardlink-'));
  try {
    const real = path.join(dir, 'real.json');
    writeFileSync(real, '{"ok":true}');
    linkSync(real, path.join(dir, 'alias.json')); // 硬链接：同一个 inode，不是符号链接
    assert.equal(readMetadataFile(dir, 'alias.json'), '{"ok":true}');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('结构: readMetadataFile 必须用 O_NOFOLLOW 打开，并在读之前以 fd 复核身份', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/lib/read-home.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('export function readMetadataFile'));
  assert.match(fn, /openSync\([^)]*O_NOFOLLOW/, 'open 必须带 O_NOFOLLOW（否则窗口内换成符号链接会被跟随）');
  assert.match(fn, /fstatSync\(fd\)/, '必须对已打开的 fd 复核身份 —— 只有这一步没有竞态');
  const fstatAt = fn.indexOf('fstatSync(fd)');
  const readAt = fn.indexOf('readFileSync(fd');
  assert.ok(fstatAt > 0 && readAt > fstatAt, 'fstat 复核必须发生在读取之前');
});

// ── pcLayout / pcVersion：诊断「读了哪种布局、读了什么版本」 ──
// 本次事故（dsh 迁到 per-record 而 hwb 只读聚合文件 → 静默漏 62% 会话）里，
// 快照没有任何字段能反映「磁盘上是 per-record、我们却走的是聚合」——聚合文件合法，
// 所以连 degraded 都没有。下面两个字段把这件事变成可断言的信号。

test('buildSnapshot: pcLayout 记录真实用到的布局与版本分布', () => {
  const dir = STORAGE_PATHS.projcachePerRecordDir;
  const rec = (v) => JSON.stringify({ version: v, record: { identity: { createdAt: 1 }, rows: {} } });
  const snap = buildSnapshot({
    homePath: '/h',
    readText: (rel) => {
      if (rel === STORAGE_PATHS.workspace) return WS_JSON;
      if (rel === `${dir}/a.json`) return rec(5);
      if (rel === `${dir}/b.json`) return rec(7);
      if (rel === `${dir}/c.json`) return rec(7);
      throw new Error('missing');
    },
    exists: (rel) => rel === STORAGE_PATHS.workspace,
    listDir: (rel) => (rel === dir ? ['a.json', 'b.json', 'c.json'] : null),
  });
  assert.equal(snap.pcLayout.perRecord, 3, 'perRecord 应等于成功读出的 per-record 文件数');
  assert.equal(snap.pcLayout.aggregate, false, '本用例没有聚合文件');
  assert.deepEqual({ ...snap.pcLayout.versions }, { 5: 1, 7: 2 }, '版本分布应如实记录');
  // pcVersion 取**最高**版本（而不是 readdir 顺序里的第一个 —— 那是不确定的假信号）
  assert.equal(snap.pcVersion, 7, 'pcVersion 应是最高版本');
});

test('buildSnapshot: pcVersion 与文件顺序无关（确定性）', () => {
  const dir = STORAGE_PATHS.projcachePerRecordDir;
  const rec = (v) => JSON.stringify({ version: v, record: { identity: { createdAt: 1 }, rows: {} } });
  const mk = (order) => buildSnapshot({
    homePath: '/h',
    readText: (rel) => (rel === STORAGE_PATHS.workspace ? WS_JSON : rec(rel.endsWith('hi.json') ? 7 : 3)),
    exists: (rel) => rel === STORAGE_PATHS.workspace,
    listDir: (rel) => (rel === dir ? order : null),
  });
  // 同一个 home，两种 readdir 顺序 → pcVersion 必须一致
  assert.equal(mk(['lo.json', 'hi.json']).pcVersion, mk(['hi.json', 'lo.json']).pcVersion);
  assert.equal(mk(['hi.json', 'lo.json']).pcVersion, 7);
});

test('buildSnapshot: 只有聚合文件时 pcLayout.aggregate 为 true', () => {
  // 遗留 home（无 per-record 目录）→ 完全靠聚合文件，这个标记能让人一眼看出
  // 「这个实例还在旧布局上」，而不是要翻代码才知道。
  const agg = JSON.stringify({
    unit: { name: 'session_projcache', version: 3 },
    tables: { sessions: { s1: { identity: { createdAt: 1 }, rows: {} } } },
  });
  const snap = buildSnapshot({
    homePath: '/h',
    readText: (rel) => (rel === STORAGE_PATHS.workspace ? WS_JSON : agg),
    exists: (rel) => rel === STORAGE_PATHS.workspace || rel === STORAGE_PATHS.projcacheAggregate,
    listDir: () => null,
  });
  assert.equal(snap.pcLayout.perRecord, 0);
  assert.equal(snap.pcLayout.aggregate, true);
  assert.equal(snap.pcVersion, 3);
});

test('buildSnapshot: 部分 per-record 文件损坏时，读得到好的、且失败可观察', () => {
  // 场景：476 个会话文件里有一些损坏（磁盘故障 / dsh 写入中途被杀 / 版本不认识）。
  // 期望：① 好的照读（不能整域降级 —— 那会把好的也冻结，更糟）
  //       ② 失败个数与样例原因**可见**（否则界面上只是「少了几个会话」，无从归因）
  const dir = STORAGE_PATHS.projcachePerRecordDir;
  const good = JSON.stringify({ version: 7, record: { identity: { createdAt: 1 }, rows: {} } });
  const snap = buildSnapshot({
    homePath: '/h',
    readText: (rel) => {
      if (rel === STORAGE_PATHS.workspace) return WS_JSON;
      if (rel.endsWith('/good.json')) return good;
      if (rel.endsWith('/truncated.json')) return '{"version":7,"record":';   // 截断
      if (rel.endsWith('/broken.json')) return 'not json';                    // 非 JSON
      return JSON.stringify({ version: 7 });                                  // 缺 record
    },
    exists: (rel) => rel === STORAGE_PATHS.workspace,
    listDir: (rel) => (rel === dir ? ['good.json', 'truncated.json', 'broken.json', 'norecord.json'] : null),
  });
  assert.equal(snap.sessions.length, 1, '好的会话仍要读出来');
  assert.deepEqual(snap.degraded, [], '部分失败不应判整域降级（会把好的也冻结）');
  assert.equal(snap.pcLayout.skipped, 3, '3 个文件读取/校验失败，应被计数');
  assert.equal(snap.pcLayout.skippedSample.length, 3, '应保留样例原因供排查');
  assert.ok(snap.pcLayout.skippedSample.some((m) => m.includes('broken.json')), '样例应指名道姓');
});

test('buildSnapshot: 全新 home（rc.1 首次启动只写 workspace.json）不误判 degraded', () => {
  // 实测 dsh 0.1.5-rc.1 首次启动只写 storages/workspace.json（没有 projcache、没有 per-record 目录）。
  // 这与「有文件但版本不认识」必须区分开：
  //   · 没有数据          → 不 degraded（新装的实例不该顶着一个红色警告）
  //   · 有数据但读不出来  → degraded（那才是真的有问题）
  const snap = buildSnapshot({
    homePath: '/fresh',
    readText: (rel) => {
      if (rel === STORAGE_PATHS.workspace) {
        return JSON.stringify({
          unit: { name: 'workspace', version: 2 },
          global: { initialized: true, workspaceIds: [], archivedSessionIds: [] },
          tables: { workspaces: {} },
        });
      }
      throw new Error('missing');   // projcache / model-tier / credentials 都不存在
    },
    exists: (rel) => rel === STORAGE_PATHS.workspace,
    listDir: () => null,            // 没有 per-record 目录
  });
  assert.equal(snap.sessions.length, 0);
  assert.equal(snap.workspaces.length, 0);
  assert.equal(snap.pcVersion, null);
  assert.equal(snap.pcLayout.perRecord, 0);
  assert.deepEqual(snap.degraded, [], '全新 home 不该被判 degraded');
});

test('buildSnapshot: 聚合文件 stale 时不覆盖更新的 per-record 数据（per-record 优先）', () => {
  // 这是本次修复的核心语义。dsh 迁移到 per-record 后**不再更新**聚合文件，
  // 于是聚合里留着旧快照、per-record 里是新数据。若合并顺序反了（聚合覆盖 per-record），
  // 界面会显示几周前的旧标题与旧用量 —— 比「少读几个会话」更隐蔽的错。
  const dir = STORAGE_PATHS.projcachePerRecordDir;
  const agg = JSON.stringify({
    unit: { name: 'session_projcache', version: 3 },
    tables: {
      sessions: {
        s1: {   // 同一个会话：聚合里是旧的（seq 10），per-record 里是新的（seq 99）
          identity: { createdAt: 1, cwd: '/p' },
          rows: { title: { ver: 1, seq: 10, val: 'STALE' }, tokenUsage: { ver: 1, seq: 10, val: { totals: { uncachedInputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } } } },
        },
        s2: {   // 只存在于聚合里（per-record 还没覆盖到）
          identity: { createdAt: 2, cwd: '/p' },
          rows: { title: { ver: 1, seq: 5, val: 'only-in-aggregate' } },
        },
      },
    },
  });
  const fresh = JSON.stringify({
    version: 7,
    record: {
      identity: { createdAt: 1, cwd: '/p' },
      rows: {
        title: { ver: 1, seq: 99, val: 'FRESH' },
        tokenUsage: { ver: 1, seq: 99, val: { totals: { uncachedInputTokens: 100, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 } } },
      },
    },
  });
  const snap = buildSnapshot({
    homePath: '/h',
    readText: (rel) => {
      if (rel === STORAGE_PATHS.workspace) return WS_JSON;
      if (rel === STORAGE_PATHS.projcacheAggregate) return agg;
      if (rel === `${dir}/s1.json`) return fresh;
      throw new Error('missing');
    },
    exists: (rel) => rel === STORAGE_PATHS.workspace || rel === STORAGE_PATHS.projcacheAggregate,
    listDir: (rel) => (rel === dir ? ['s1.json'] : null),
  });

  assert.equal(snap.sessions.length, 2, '并集：per-record 的 s1 + 只在聚合里的 s2');
  const s1 = snap.sessions.find((s) => s.sessionId === 's1');
  assert.equal(s1.title, 'FRESH', 'per-record 更新，必须覆盖聚合里的旧标题');
  assert.equal(s1.tokenUsage.outputTokens, 200, '用量同样以 per-record 为准');
  const s2 = snap.sessions.find((s) => s.sessionId === 's2');
  assert.equal(s2.title, 'only-in-aggregate', '只在聚合里的会话仍要保留（bootstrap 期的老会话）');
  assert.equal(snap.pcLayout.perRecord, 1);
  assert.equal(snap.pcLayout.aggregate, true, '确有会话来自聚合');
});

// ── per-record 目录的列举语义（安全 + 正确性） ──
// 这个目录里的内容是 dsh 写的、但路径来自配置，所以既要**正确**（不把备份当会话、
// 不把子目录当文件），也要**安全**（不跟随符号链接把 home 之外的东西读进来）。

test('listMetadataDir: 列出普通文件、跳过子目录与符号链接、目录不存在返回 null', async () => {
  const { listMetadataDir } = await import('../src/lib/read-home.js');
  const { symlinkSync } = await import('node:fs');
  const home = mkdtempSync(path.join(tmpdir(), 'hwb-listdir-'));
  const dir = path.join(home, 'storages', 'sessions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'a.json'), '{}');
  writeFileSync(path.join(dir, 'a.json.bak.202601010000'), '{}');   // dsh 的 backup-and-skip 产物
  mkdirSync(path.join(dir, 'subdir'));
  symlinkSync(path.join(dir, 'a.json'), path.join(dir, 'link.json'));
  try {
    const files = listMetadataDir(home, 'storages/sessions');
    assert.ok(files.includes('a.json'), '普通文件要列出');
    // 备份文件**要**列出：后缀过滤是「域的知识」，由调用方做（见函数注释）。
    // 这里固定这个分层，免得有人把过滤搬进来导致别的域没法用。
    assert.ok(files.includes('a.json.bak.202601010000'), '.bak 由调用方过滤，列举层不过滤后缀');
    assert.ok(!files.includes('subdir'), '子目录不是文件');
    assert.ok(!files.includes('link.json'), '符号链接不列出（isFile 对 symlink 为 false）');
    // 目录不存在 → null（与「空目录 → []」区分开：前者 = 没有该布局，后者 = 布局在但没数据）
    // 目录不存在 → null（与「存在但为空 → []」区分开）
    assert.equal(listMetadataDir(home, 'nope/nope'), null, '不存在的目录返回 null');
    // 存在但里面没有普通文件 → 空数组（不是 null）——这个区分是刻意的：
    //   null = 这个 home 没有该布局（旧版 dsh）；[] = 布局在但没数据。
    assert.deepEqual(listMetadataDir(home, 'storages'), [], '存在的目录返回数组（可能为空）');
    // 路径指向一个**文件**而不是目录 → null
    assert.equal(listMetadataDir(home, 'storages/sessions/a.json'), null, '文件不是目录');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('buildSnapshot: .bak 备份文件既不算会话、也不算读取错误', () => {
  // dsh 的 invalidRecords:'backup-and-skip' 会把**校验失败**的记录挪成
  // `<key>.json.bak.<stamp>`。那些文件的内容本来就是坏的 —— 若把它们计入
  // `pcLayout.skipped`，用户会看到「跳过了 N 个文件」的假警告（其实是 dsh 自己挪走的）。
  const dir = STORAGE_PATHS.projcachePerRecordDir;
  const snap = buildSnapshot({
    homePath: '/h',
    readText: (rel) => {
      if (rel === STORAGE_PATHS.workspace) return WS_JSON;
      if (rel === `${dir}/good.json`) return JSON.stringify({ version: 7, record: { identity: { createdAt: 1 }, rows: {} } });
      return 'this is the corrupt content dsh moved aside';
    },
    exists: (rel) => rel === STORAGE_PATHS.workspace,
    listDir: (rel) => (rel === dir ? ['good.json', 'good.json.bak.202601010000', 'other.json.bak.202601010000'] : null),
  });
  assert.equal(snap.sessions.length, 1, '只有 good.json 是会话');
  assert.equal(snap.pcLayout.skipped, undefined, '.bak 不该计入 skipped（它们本就是被挪走的坏记录）');
  assert.deepEqual(snap.degraded, []);
});
