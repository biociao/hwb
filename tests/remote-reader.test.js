import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCatScript, parseCatOutput, readHomeRemote } from '../src/dshhome/remote-reader.js';
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
  // 两个必需文件都缺失 → 各自降级；可选文件缺失不降级。
  assert.deepEqual(snap.degraded.map((d) => d.domain).sort(), ['projcache', 'workspace']);
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
