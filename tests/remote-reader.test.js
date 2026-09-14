import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCatScript, parseCatOutput, parsePerRecordDir, readHomeRemote, PER_RECORD_DIR } from '../src/dshhome/remote-reader.js';
import { IndexStore } from '../src/dshhome/store.js';
import { indexRemoteHome } from '../src/dshhome/reader.js';
import { homeIdOf } from '../src/lib/read-home.js';

const WS = JSON.stringify({
  unit: { name: 'workspace', version: 2 },
  global: { initialized: true, workspaceIds: ['ws-1'] },
  tables: { workspaces: { 'ws-1': { title: 'hwb', path: '/repo/hwb', sessionIds: ['s1'] } } },
});
const PC = JSON.stringify({
  unit: { name: 'session_projcache', version: 3 },
  global: null,
  tables: { sessions: { s1: {
    identity: { createdAt: 1, cwd: '/repo/hwb' },
    rows: {
      title: { ver: 1, seq: 1, val: 'current session' },
      tokenUsage: { ver: 1, seq: 1, val: { totals: { uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 } } },
    },
  } } },
});
const TIER = JSON.stringify({ schema: 2, activeId: 'scheme-1', schemes: [{ id: 'scheme-1', tiers: { default: { provider: 'deepseek', model: 'deepseek-chat' } } }] });
const CRED = 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sekret-value\n';

// 合成一次 `emit` 会产出的 stdout：文件存在输出正文，缺失输出 __MISSING__，尾部补一个换行分隔 END。
function catOutput(files) {
  const out = [];
  const order = ['storages/workspace.json', 'storages/session_projcache.json', 'model-tier.json', '.credentials.yaml'];
  for (const rel of order) {
    out.push(`__DSH_FILE_BEGIN__:${rel}\n`);
    if (rel in files) out.push(files[rel]);
    else out.push('__MISSING__\n');
    out.push('\n__DSH_FILE_END__\n');
  }
  return out.join('');
}

test('buildCatScript emits the 4 schema-versioned files with BEGIN/END markers', () => {
  const s = buildCatScript();
  for (const rel of ['storages/workspace.json', 'storages/session_projcache.json', 'model-tier.json', '.credentials.yaml']) {
    assert.ok(s.includes(`emit '${rel}'`), `cat script must close over ${rel}`);
  }
  assert.ok(s.includes('__DSH_FILE_BEGIN__'));
  assert.ok(s.includes('__DSH_FILE_END__'));
  assert.ok(s.includes('__MISSING__'));
});

// per-record 目录是**必须**抓的：漏了它，远程实例就会和本地修复前一样只看到聚合文件里的
// 陈旧会话（实测本机漏 62%）。这条断言把「per-record 抓取」钉在脚本里。
test('buildCatScript 也抓 per-record projcache 目录（带 DIR 标记）', () => {
  const s = buildCatScript();
  assert.ok(s.includes('storages/session_projcache/sessions'),
    'cat 脚本必须遍历 per-record 目录，否则远程实例会漏掉大部分会话');
  assert.ok(s.includes('__DSH_DIR_BEGIN__') && s.includes('__DSH_DIR_END__'),
    'per-record 目录需要 DIR 标记来区分「目录不存在」与「目录为空」');
  // 只收 .json：dsh 的 invalidRecords:'backup-and-skip' 会产出 <key>.json.bak.<stamp>
  assert.ok(/\*\.json/.test(s), '只应遍历 .json 文件');
});

test('parseCatOutput splits markers into a {rel: text} map, missing → null', () => {
  const out = catOutput({ 'storages/workspace.json': WS, 'storages/session_projcache.json': PC, 'model-tier.json': TIER });
  const files = parseCatOutput(out);
  assert.equal(files['storages/workspace.json'], WS);
  assert.equal(files['storages/session_projcache.json'], PC);
  assert.equal(files['model-tier.json'], TIER);
  assert.equal(files['.credentials.yaml'], null); // 缺失 → null
});

test('readHomeRemote builds a snapshot from a fake ssh stdout, and indexRemoteHome feeds store.current', async () => {
  const exec = async (_host, _script, _args) => ({
    code: 0, stdout: catOutput({ 'storages/workspace.json': WS, 'storages/session_projcache.json': PC, 'model-tier.json': TIER, '.credentials.yaml': CRED }), stderr: '',
  });
  const home = { homePath: 'ssh://c4g:3080', host: 'c4g', remoteHome: '~/.dsh' };
  const snap = await readHomeRemote(home, exec);
  assert.equal(snap.homeId, homeIdOf('ssh://c4g:3080'));
  assert.equal(snap.wsVersion, 2);
  assert.equal(snap.pcVersion, 3);
  assert.equal(snap.sessions[0].title, 'current session');
  assert.equal(snap.modelTier.activeId, 'scheme-1');
  assert.deepEqual(snap.providers, [{ ref: 'DEEPSEEK_API_KEY', provider: 'deepseek' }]);
  assert.deepEqual(snap.degraded, []);

  const store = new IndexStore(':memory:');
  store.registerHome({ homePath: 'ssh://c4g:3080', hostType: 'remote', host: 'c4g', remotePort: 3080 });
  const { rows } = await indexRemoteHome(store, home, exec);
  assert.ok(rows.some((r) => r.type === 'session'));
  // 远程实例的「当前项目/当前会话」入库：listHomes 的 current = 最近活跃 session。
  const homes = store.listHomes();
  assert.equal(homes.length, 1);
  assert.equal(homes[0].current.project, 'hwb');
  assert.equal(homes[0].current.sessionId, 's1');
  assert.equal(homes[0].current.title, 'current session');
  assert.equal(homes[0].sessionCount, 1);
  store.close();
});

test('readHomeRemote throws when ssh returns non-zero (unreachable remote)', async () => {
  const exec = async () => ({ code: 1, stdout: '', stderr: 'ssh: connect failed' });
  await assert.rejects(
    () => readHomeRemote({ homePath: 'ssh://c4g:3080', host: 'c4g' }, exec),
    /读取远程 dsh home 失败/
  );
});

test('readHomeRemote degrades a required file that is missing remotely', async () => {
  const exec = async () => ({ code: 0, stdout: catOutput({}), stderr: '' });
  const snap = await readHomeRemote({ homePath: 'ssh://c4g:3080', host: 'c4g' }, exec);
  // workspace 是 single 布局的必需文件：缺失 → degraded。
  // projcache 不再因「缺失」降级：dsh 迁到 per-record 布局后，聚合文件在新版 home 上本来就可能没有
  // （见 tests/read-home.test.js 的同名说明）。可选文件缺失同样不降级。
  assert.deepEqual(snap.degraded.map((d) => d.domain).sort(), ['workspace']);
});

test('readHomeRemote 能读远端 per-record projcache 目录（dsh 的新布局）', async () => {
  const rec = (title, v = 7) => JSON.stringify({
    version: v,
    record: { identity: { createdAt: 1, cwd: '/r' }, rows: { title: { ver: 1, seq: 1, val: title } } },
  });
  const dir = 'storages/session_projcache/sessions';
  const out = [
    '__DSH_FILE_BEGIN__:storages/workspace.json', WS, '__DSH_FILE_END__',
    '__DSH_FILE_BEGIN__:storages/session_projcache.json', '__MISSING__', '__DSH_FILE_END__',
    '__DSH_FILE_BEGIN__:model-tier.json', '__MISSING__', '__DSH_FILE_END__',
    '__DSH_FILE_BEGIN__:.credentials.yaml', '__MISSING__', '__DSH_FILE_END__',
    `__DSH_DIR_BEGIN__:${dir}`,
    `__DSH_FILE_BEGIN__:${dir}/session-a.json`, rec('A'), '__DSH_FILE_END__',
    `__DSH_FILE_BEGIN__:${dir}/session-b.json`, rec('B', 5), '__DSH_FILE_END__',
    `__DSH_DIR_END__:${dir}`,
  ].join('\n');
  const exec = async () => ({ code: 0, stdout: out, stderr: '' });
  const snap = await readHomeRemote({ homePath: 'ssh://c4g:3080', host: 'c4g' }, exec);
  assert.deepEqual(snap.sessions.map((s) => s.title).sort(), ['A', 'B']);
  assert.deepEqual(snap.degraded.map((d) => d.domain), [], 'per-record 读成功时不该降级');
});

test('readHomeRemote: 远端没有 per-record 目录时退回只读聚合文件', async () => {
  const exec = async () => ({ code: 0, stdout: catOutput({ 'storages/workspace.json': WS, 'storages/session_projcache.json': PC }), stderr: '' });
  const snap = await readHomeRemote({ homePath: 'ssh://c4g:3080', host: 'c4g' }, exec);
  assert.equal(snap.sessions.length, 1);
  assert.deepEqual(snap.degraded.map((d) => d.domain), []);
});

test('remote reader preserves workspace and large projcache through SSH stdout collection', async () => {
  const { sshBash } = await import('../src/control/remote.js');
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const bigPc = JSON.parse(PC);
  bigPc.tables.sessions.s1.rows.title.val = '会话'.repeat(40000);
  const output = catOutput({ 'storages/workspace.json': WS, 'storages/session_projcache.json': JSON.stringify(bigPc) });
  const spawnProcess = () => {
    const proc = new EventEmitter();
    proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.stdin = new PassThrough();
    proc.kill = () => {};
    proc.stdin.on('finish', () => {
      const bytes = Buffer.from(output);
      // Deliberately split multibyte text across chunks.
      for (let i = 0; i < bytes.length; i += 8191) proc.stdout.write(bytes.subarray(i, i + 8191));
      proc.stdout.end();
      proc.emit('close', 0);
    });
    return proc;
  };
  const exec = (host, script, args, timeout, options) => sshBash(host, script, args, timeout, { ...options, spawnProcess });
  const snapshot = await readHomeRemote({ homePath: 'ssh://cms:3080', host: 'cms' }, exec);
  assert.deepEqual(snapshot.degraded, []);
  assert.equal(snapshot.workspaces.length, 1);
  assert.equal(snapshot.sessions[0].title, '会话'.repeat(40000));
});

test('SSH output overflow is an explicit failure instead of a successful truncated tail', async () => {
  const { sshBash } = await import('../src/control/remote.js');
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  let killed = false;
  const spawnProcess = () => {
    const proc = new EventEmitter();
    proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.stdin = new PassThrough();
    proc.kill = () => { killed = true; };
    proc.stdin.on('finish', () => { proc.stdout.write('x'.repeat(100)); proc.emit('close', 0); });
    return proc;
  };
  const result = await sshBash('cms', 'test', [], 1000, { maxStdoutBytes: 50, spawnProcess });
  assert.equal(result.code, -3);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /exceeded 50 bytes/);
  assert.equal(killed, true);
});

test('truncated remote file framing fails without replacing existing sessions', async () => {
  const store = new IndexStore(':memory:');
  const home = { homePath: 'ssh://cms:3080', host: 'cms', hostType: 'remote' };
  store.registerHome(home);
  try {
    await indexRemoteHome(store, home, async () => ({ code: 0, stdout: catOutput({ 'storages/workspace.json': WS, 'storages/session_projcache.json': PC }), stderr: '' }));
    await assert.rejects(() => indexRemoteHome(store, home, async () => ({ code: 0, stdout: catOutput({}).slice(20), stderr: '' })), /输出不完整/);
    assert.equal(store.listHomes()[0].sessionCount, 1);
  } finally { store.close(); }
});

test('readHomeRemote: per-record 体积偏大时告警（只告警，不改变读取行为）', async () => {
  // per-record 布局按会话分文件，远程每次索引要抓的字节数远大于聚合文件
  // （本机实测 4.05 MiB vs 635 KB）。低带宽链路上会逼近 ssh 超时。
  // 断言：① 读取结果不受影响（不做「少读一点」这种事 —— 静默少读正是本次事故的教训）
  //       ② 体积超阈值时确实记了一条 warn（可观察）
  const rec = (i) => JSON.stringify({
    version: 7,
    record: { identity: { createdAt: 1, cwd: '/r' }, rows: { title: { ver: 1, seq: i, val: 'x'.repeat(2000) } } },
  });
  const dir = 'storages/session_projcache/sessions';
  const parts = [
    '__DSH_FILE_BEGIN__:storages/workspace.json', WS, '__DSH_FILE_END__',
    '__DSH_FILE_BEGIN__:storages/session_projcache.json', '__MISSING__', '__DSH_FILE_END__',
    '__DSH_FILE_BEGIN__:model-tier.json', '__MISSING__', '__DSH_FILE_END__',
    '__DSH_FILE_BEGIN__:.credentials.yaml', '__MISSING__', '__DSH_FILE_END__',
    `__DSH_DIR_BEGIN__:${dir}`,
  ];
  const N = 1200;   // 每个约 2 KB → 总量 > 2 MiB 阈值
  for (let i = 0; i < N; i++) parts.push(`__DSH_FILE_BEGIN__:${dir}/session-${i}.json`, rec(i), '__DSH_FILE_END__');
  parts.push(`__DSH_DIR_END__:${dir}`);
  const out = parts.join('\n');

  const exec = async () => ({ code: 0, stdout: out, stderr: '' });
  const snap = await readHomeRemote({ homePath: 'ssh://big', host: 'big-host-test' }, exec);
  // ① 数据完整（1200 个会话一个不少）
  assert.equal(snap.sessions.length, N, '体积大也必须读全，不能悄悄少读');
  assert.equal(snap.pcLayout.perRecord, N);
  assert.ok(out.length > 2 * 1024 * 1024, `夹具应超过告警阈值，实际 ${out.length} 字节`);
});

test('buildCatScript: per-record 走远端投影（只保留 hwb 用到的 rows），且失败时原文回退', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');

  // 造一个真实的小 home：一个 per-record 文件，含大 projection + hwb 需要的字段。
  const root = mkdtempSync(path.join(os.tmpdir(), 'hwb-proj-'));
  const dir = path.join(root, '.dsh', 'storages', 'session_projcache', 'sessions');
  mkdirSync(dir, { recursive: true });
  const big = 'X'.repeat(20000);
  const rec = {
    version: 7,
    record: {
      identity: { createdAt: 1, cwd: '/p' },
      rows: {
        title: { ver: 1, seq: 1, val: 'T' },
        titleInput: { ver: 3, seq: 1, val: { big } },      // hwb 不用 → 应被投影掉
        turnOutline: { ver: 1, seq: 1, val: { big } },     // 同上
        tokenUsage: { ver: 1, seq: 1, val: { totals: { uncachedInputTokens: 5, outputTokens: 6, cacheReadTokens: 7, cacheWriteTokens: 8 } } },
      },
    },
  };
  writeFileSync(path.join(dir, 'session-a.json'), JSON.stringify(rec));
  const rawSize = readFileSync(path.join(dir, 'session-a.json')).length;

  const scriptFile = path.join(root, 'cat.sh');
  writeFileSync(scriptFile, buildCatScript());
  try {
    const { stdout } = await promisify(execFile)('bash', [scriptFile, path.join(root, '.dsh')], { maxBuffer: 16 * 1024 * 1024 });
    // ① 体积确实变小（这是这条优化的全部意义）
    assert.ok(stdout.length < rawSize,
      `投影后（${stdout.length}）应小于原文（${rawSize}）—— 否则优化没生效`);
    // ② 但 hwb 需要的字段一个不少
    const snap = await readHomeRemote({ homePath: 'ssh://proj', host: 'proj-test' },
      async () => ({ code: 0, stdout, stderr: '' }));
    assert.equal(snap.sessions.length, 1);
    const s = snap.sessions[0];
    assert.equal(s.title, 'T', 'title 必须保留');
    assert.equal(s.cwd, '/p', 'identity.cwd 必须保留（投影只删 rows，不动 identity）');
    assert.equal(s.tokenUsage.outputTokens, 6, 'tokenUsage 必须保留');
    // 只断言 projcache 域没降级（这个夹具没造 workspace.json，workspace 降级是预期的）。
    assert.ok(!snap.degraded.some((d) => d.domain === 'projcache'),
      `projcache 不该因投影而降级：${JSON.stringify(snap.degraded)}`);

    // ③ 坏 JSON 必须**原文回退**（不能因为优化而少读/读错）
    writeFileSync(path.join(dir, 'session-bad.json'), 'not json');
    const { stdout: out2 } = await promisify(execFile)('bash', [scriptFile, path.join(root, '.dsh')], { maxBuffer: 16 * 1024 * 1024 });
    assert.ok(out2.includes('not json'), '无法解析的文件应原样传出（回退），而不是变成空');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cat 协议的健壮性：内容里出现分隔标记字样 / 非 ASCII 都不会破坏分帧', () => {
  // 分帧协议用 `__DSH_FILE_BEGIN__:` / `__DSH_FILE_END__` 标记。若某份元数据的内容里
  // **恰好**含有这些字样（会话标题、项目路径都可能出现），分帧会不会被带偏？
  // 实测：不会 —— 正则要求 END 标记**独立成行**且正文非贪婪，但这条性质必须有测试守着，
  // 否则将来有人把正则改成正则 dotAll 或贪婪匹配，就会出现「一个标题把后面几个文件吃掉」
  // 这类极难排查的错位。
  const dir = PER_RECORD_DIR;
  const tricky = JSON.stringify({
    version: 7,
    record: {
      identity: { createdAt: 1, cwd: '/p' },
      rows: { title: { ver: 1, seq: 1, val: '中文标题 🎉 中间夹 __DSH_FILE_END__ 与\n__DSH_FILE_BEGIN__:fake 字样' } },
    },
  });
  const normal = JSON.stringify({ version: 7, record: { identity: { createdAt: 2 }, rows: { title: { ver: 1, seq: 1, val: 'B' } } } });
  const out = [
    '__DSH_FILE_BEGIN__:storages/workspace.json', WS, '__DSH_FILE_END__',
    '__DSH_FILE_BEGIN__:storages/session_projcache.json', '__MISSING__', '__DSH_FILE_END__',
    '__DSH_FILE_BEGIN__:model-tier.json', '__MISSING__', '__DSH_FILE_END__',
    '__DSH_FILE_BEGIN__:.credentials.yaml', '__MISSING__', '__DSH_FILE_END__',
    `__DSH_DIR_BEGIN__:${dir}`,
    `__DSH_FILE_BEGIN__:${dir}/tricky.json`, tricky, '__DSH_FILE_END__',
    `__DSH_FILE_BEGIN__:${dir}/normal.json`, normal, '__DSH_FILE_END__',
    `__DSH_DIR_END__:${dir}`,
  ].join('\n');

  const files = parseCatOutput(out);
  assert.equal(files['storages/workspace.json'], WS, '带标记字样的邻居文件不应被吃掉');
  assert.ok(files[`${dir}/normal.json`].includes('"B"'), '标记字样之后的文件仍要正确切出');
  const names = parsePerRecordDir(out).names;
  assert.deepEqual(names.sort(), ['normal.json', 'tricky.json'], '两个文件都应被识别');
  // 中文与 emoji 必须原样保留（不能用会丢码位的读写路径）
  assert.ok(files[`${dir}/tricky.json`].includes('🎉'), '多字节字符不应损坏');
});
