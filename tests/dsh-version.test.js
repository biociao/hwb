/**
 * 实例卡上的 dsh 版本号。
 *
 * 这一组守着三件事：
 *   ① 版本号一定是**干净的字面量**（远端命令的输出、package.json 的内容都不可信，只从中提取）；
 *   ② 本地同步读取、远程后台探测 —— `/api/homes` 绝不能被一次 SSH 往返卡住；
 *   ③ 探测失败**不清空**已经显示的版本，且按更短的退避重试（陈旧的值比没有值有用）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { IndexStore } from '../src/dshhome/store.js';
import { createRouter } from '../src/api/routes.js';
import { REMOTE_START, REMOTE_PATH_PRELUDE } from '../src/control/remote.js';
import {
  parseDshVersion, localDshVersion, dshBinaryFromCmd, remoteVersionScript,
  remoteDshVersion, DshVersionResolver,
} from '../src/lib/dsh-version.js';

// —— 一个假的远端安装根：<dir>/@deepseek-ai/dsh/package.json ——
function fakeInstall(version) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hwb-dsh-ver-'));
  mkdirSync(path.join(root, '@deepseek-ai', 'dsh'), { recursive: true });
  writeFileSync(path.join(root, '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }));
  return root;
}
// findDshRoot 只认传入的 env/home（不会去读进程环境或真的 home），所以夹具是完全封闭的。
function isolated(dir) {
  return { env: { DSH_NODE_MODULES: dir }, home: mkdtempSync(path.join(os.tmpdir(), 'hwb-dsh-home-')) };
}

// 假 ssh 子进程：与 sshBash 的约定一致（脚本走 stdin，close 带退出码）。
function fakeSsh(stdout, code, record = () => {}) {
  return (cmd, argv) => {
    const proc = new EventEmitter();
    proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.stdin = new PassThrough();
    proc.kill = () => {};
    let script = '';
    proc.stdin.on('data', (d) => { script += d; });
    proc.stdin.on('finish', () => {
      record({ cmd, argv, script });
      if (stdout) proc.stdout.write(stdout);
      proc.stdout.end();
      proc.emit('close', code);
    });
    return proc;
  };
}

test('parseDshVersion: 只接受版本号字面量，别的一律 null', () => {
  assert.equal(parseDshVersion('0.1.5-rc.1\n'), '0.1.5-rc.1');
  assert.equal(parseDshVersion('  0.1.1  '), '0.1.1');
  assert.equal(parseDshVersion('1.2.3'), '1.2.3');
  assert.equal(parseDshVersion(''), null);
  assert.equal(parseDshVersion(undefined), null);
  // 两段式版本（如 coreutils 的 9.1）不算 —— 否则会把包装器/系统工具的版本当成 dsh 版本显示出去
  assert.equal(parseDshVersion('env (GNU coreutils) 9.1'), null);
  // 任意文本不得透出（它会进 innerHTML）
  assert.equal(parseDshVersion('"><img src=x onerror=alert(1)>'), null);
});

test('localDshVersion: 读本机安装的 dsh；没有安装时返回 null 而不抛', () => {
  const install = fakeInstall('0.9.9-test');
  const empty = mkdtempSync(path.join(os.tmpdir(), 'hwb-dsh-empty-'));
  try {
    assert.equal(localDshVersion(isolated(install)), '0.9.9-test');
    // 空目录 = 没有安装：null（不是抛错 —— 它只是卡片上的一行字，不该让整个请求失败）
    assert.equal(localDshVersion(isolated(empty)), null);
  } finally {
    rmSync(install, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
  }
});

test('localDshVersion: package.json 里的脏版本号会被截成干净字面量', () => {
  const install = fakeInstall('0.1.5-rc.1"><img src=x onerror=alert(1)>');
  try {
    assert.equal(localDshVersion(isolated(install)), '0.1.5-rc.1');
  } finally { rmSync(install, { recursive: true, force: true }); }
});

test('dshBinaryFromCmd: 只在启动命令显式给了带路径的 dsh 时才认，包装器一律退回 PATH 探测', () => {
  assert.equal(dshBinaryFromCmd('~/.local/node/bin/dsh web --port 3080'), '~/.local/node/bin/dsh');
  assert.equal(dshBinaryFromCmd('/usr/local/bin/dsh web --port 3080'), '/usr/local/bin/dsh');
  assert.equal(dshBinaryFromCmd('$HOME/.nvm/versions/node/v24.15.0/bin/dsh web --port 3080'), '$HOME/.nvm/versions/node/v24.15.0/bin/dsh');
  // 默认值（裸 dsh）与各种包装器：不猜 —— 把 env/bash 当成 dsh 去问版本只会拿到一句无关输出
  assert.equal(dshBinaryFromCmd('dsh web --port 3080'), null);
  assert.equal(dshBinaryFromCmd('env FOO=1 dsh web'), null);
  assert.equal(dshBinaryFromCmd("bash -lc 'dsh web'"), null);
  assert.equal(dshBinaryFromCmd(''), null);
  assert.equal(dshBinaryFromCmd(null), null);
  // 带 shell 元字符的 token 不得进远端脚本
  assert.equal(dshBinaryFromCmd('/tmp/x/dsh;rm -rf /'), null);
  assert.equal(dshBinaryFromCmd('/tmp/x/dsh`id`'), null);
});

test('remoteVersionScript: 与启动脚本共用同一份 PATH 补齐，并优先使用显式配置的 dsh', () => {
  // 「跑起来的是哪个 dsh」与「报告的是哪个 dsh」必须看到同一套 PATH，否则卡片会撒谎
  assert.ok(REMOTE_START.includes(REMOTE_PATH_PRELUDE), 'REMOTE_START 必须包含共享的 PATH 前导');
  assert.ok(remoteVersionScript().includes(REMOTE_PATH_PRELUDE), '版本探测脚本必须包含共享的 PATH 前导');
  assert.match(remoteVersionScript(), /(^|\n)dsh --version 2>\/dev\/null \|\| true\n?$/);
  assert.match(remoteVersionScript('~/.local/node/bin/dsh web --port 3080'), /\n~\/\.local\/node\/bin\/dsh --version/);
});

test('remoteDshVersion: 通过一次 ssh 往返取版本；不成功一律 null（旁路信息不该重试）', async () => {
  let spawned = null;
  const record = (info) => { spawned = info; };

  assert.equal(await remoteDshVersion('box', { spawnProcess: fakeSsh('0.1.5-rc.1\n', 0, record) }), '0.1.5-rc.1');
  assert.equal(spawned.cmd, 'ssh');
  assert.ok(spawned.argv.includes('box'), 'ssh 的目标主机必须传进去');
  // sshBash 的约定：远端命令是 `bash -s --`，脚本正文走 stdin
  assert.equal(spawned.argv[spawned.argv.length - 1], 'bash -s --');
  assert.match(spawned.script, /(^|\n)dsh --version 2>\/dev\/null \|\| true/, '远端要跑的就是 `dsh --version`');
  assert.ok(spawned.script.startsWith(REMOTE_PATH_PRELUDE), '远端脚本必须以共享的 PATH 补齐开头');

  // 远端没装 dsh：脚本的 `|| true` 让它以 0 退出但输出为空 → null（不是把空串当版本号）
  assert.equal(await remoteDshVersion('box', { spawnProcess: fakeSsh('', 0) }), null);
  // SSH 本身失败（超时/鉴权/主机不可达）
  assert.equal(await remoteDshVersion('box', { spawnProcess: fakeSsh('', 255) }), null);
  assert.equal(await remoteDshVersion(null, { spawnProcess: fakeSsh('0.1.5', 0) }), null, '没有 host 就不该 ssh');
  // 输出超限 = 明确的失败，不把截断的内容当版本号
  assert.equal(await remoteDshVersion('box', { spawnProcess: fakeSsh(`${'x'.repeat(9000)}\n`, 0) }), null);
});

// —— 解析器：本地同步、远程后台、失败不清空 ——

const HOME = (extra = {}) => ({ homeId: 'h1', hostType: 'local', homePath: '/home/u/.dsh', ...extra });
const REMOTE = { homeId: 'h2', hostType: 'remote', host: 'bot@box', homePath: 'ssh://bot@box:3080' };
const flush = () => new Promise((s) => setImmediate(s));

test('resolver: 本地实例同步返回版本，且在 TTL 内不重复读取', () => {
  let reads = 0;
  const r = new DshVersionResolver({ localVersion: () => { reads++; return '0.1.5-rc.1'; } });
  assert.equal(r.resolve(HOME()), '0.1.5-rc.1');
  assert.equal(r.resolve(HOME()), '0.1.5-rc.1');
  assert.equal(reads, 1, 'TTL 内第二次 resolve 必须走缓存');
});

test('resolver: TTL 到期后重新读取，版本变了就广播一次', () => {
  let now = 1000;
  let version = '0.1.1';
  const seen = [];
  const r = new DshVersionResolver({
    now: () => now, ttlMs: 100, localVersion: () => version,
    onChange: (homeId, v) => seen.push([homeId, v]),
  });
  assert.equal(r.resolve(HOME()), '0.1.1');
  assert.deepEqual(seen, [], '首次解析不该广播（这次的响应体里已经带上了）');
  version = '0.1.5-rc.1';
  now += 101;
  assert.equal(r.resolve(HOME()), '0.1.5-rc.1');
  assert.deepEqual(seen, [['h1', '0.1.5-rc.1']], '升级后广播一次，前端才会重画卡片');
  // 没变就不广播（否则每次 TTL 到期都会多一次无谓的全量刷新）
  now += 101;
  assert.equal(r.resolve(HOME()), '0.1.5-rc.1');
  assert.equal(seen.length, 1);
});

test('resolver: 远程实例立刻返回上次已知值，版本在后台探测后广播（绝不阻塞调用方）', async () => {
  let release;
  const pending = new Promise((res) => { release = res; });
  let calls = 0;
  const seen = [];
  const r = new DshVersionResolver({
    remoteVersion: async () => { calls++; await pending; return '0.1.5-rc.1'; },
    onChange: (homeId, v) => seen.push([homeId, v]),
  });
  // 第一次：还没有任何已知值，立刻返回 null（而不是 await 一次 SSH 往返）
  assert.equal(r.resolve(REMOTE), null);
  assert.equal(r.resolve(REMOTE), null);
  await flush();          // 让第一次探测真正发出（remoteVersion 在微任务里调用）
  assert.equal(calls, 1, '探测进行中重复调用不得再开一次 SSH');
  assert.equal(r.resolve(REMOTE), null);
  assert.equal(calls, 1);
  release();
  await pending;
  await flush();
  assert.equal(r.resolve(REMOTE), '0.1.5-rc.1', '探测结果应进入缓存');
  assert.deepEqual(seen, [['h2', '0.1.5-rc.1']]);
  assert.equal(calls, 1);
});

test('resolver: 远端探测失败时沿用旧值，并按更短的退避重试', async () => {
  let now = 0;
  const results = ['0.1.5-rc.1', null, '0.1.5-rc.1'];
  let calls = 0;
  const r = new DshVersionResolver({
    now: () => now, ttlMs: 1000, retryMs: 10,
    remoteVersion: async () => { calls++; return results[Math.min(calls - 1, results.length - 1)]; },
  });
  assert.equal(r.resolve(REMOTE), null);
  await flush();
  assert.equal(r.resolve(REMOTE), '0.1.5-rc.1');
  // 距离 TTL 到期还很远：不该再探测
  now += 5;
  assert.equal(r.resolve(REMOTE), '0.1.5-rc.1');
  assert.equal(calls, 1);
  // TTL 到期 → 探测失败 → **旧值保留**，并把下一次尝试提前到 retryMs 之后
  now += 1000;
  assert.equal(r.resolve(REMOTE), '0.1.5-rc.1');
  await flush();
  assert.equal(calls, 2);
  assert.equal(r.resolve(REMOTE), '0.1.5-rc.1', '失败不得清空已显示的版本号');
  now += 10;   // retryMs 之后
  r.resolve(REMOTE);
  await flush();
  assert.equal(calls, 3, '失败后应按 retryMs 重试，而不是等满 TTL');
  assert.equal(r.resolve(REMOTE), '0.1.5-rc.1');
});

test('resolver: 探测抛错不影响调用方，也不清空旧值', async () => {
  const failing = new DshVersionResolver({ remoteVersion: async () => { throw new Error('ssh blew up'); }, retryMs: 1 });
  assert.equal(failing.resolve(REMOTE), null, '首次失败只是没有值，不是异常');
  await flush();
  assert.equal(failing.resolve(REMOTE), null);
});

test('resolver: 改了主机/启动命令就是另一个实例，旧版本号立刻失效', async () => {
  let calls = 0;
  const r = new DshVersionResolver({
    remoteVersion: async (home) => { calls++; return home.host === 'bot@box' ? '0.1.1' : '0.1.5-rc.1'; },
  });
  r.resolve(REMOTE);
  await flush();
  assert.equal(r.resolve(REMOTE), '0.1.1');
  const switched = { ...REMOTE, host: 'bot@b' };
  assert.equal(r.resolve(switched), null, '换了主机：上一个实例的版本号不得沿用');
  await flush();
  assert.equal(r.resolve(switched), '0.1.5-rc.1');
  assert.equal(calls, 2);
});

test('resolver: 探测期间实例被移除/改配置时，迟到的结果被丢弃', async () => {
  const gates = [];
  const seen = [];
  const r = new DshVersionResolver({
    remoteVersion: (home) => new Promise((res) => gates.push({ host: home.host, res })),
    onChange: (id, v) => seen.push([id, v]),
  });
  r.resolve(REMOTE);                            // 探测 #1：bot@box
  const switched = { ...REMOTE, host: 'bot@b' };  // 同一 homeId，配置已改 → 探测 #2
  r.resolve(switched);
  await flush();
  assert.equal(gates.length, 2, '改配置就是另一个实例，必须重新探测');
  // 新身份的结果先到
  gates[1].res('0.1.5-rc.1');
  await flush();
  assert.equal(r.resolve(switched), '0.1.5-rc.1');
  // 旧身份的结果迟到：不得覆盖、也不得广播
  gates[0].res('0.0.1-stale');
  await flush();
  assert.equal(r.resolve(switched), '0.1.5-rc.1', '迟到的旧结果不得覆盖当前身份的值');
  assert.deepEqual(seen, [['h2', '0.1.5-rc.1']]);
});

test('resolver: prune 只保留仍在册的实例', () => {
  const r = new DshVersionResolver({ localVersion: () => '0.1.5-rc.1' });
  r.resolve(HOME());
  r.resolve(HOME({ homeId: 'h9' }));
  assert.equal(r.entries.size, 2);
  r.prune(['h1']);
  assert.deepEqual([...r.entries.keys()], ['h1']);
});

// —— 路由级：/api/homes 的 runtime 里带上版本号（缺省依赖时不影响既有行为） ——

async function homesOf(router) {
  let data;
  const res = { writeHead(status) { assert.equal(status, 200); }, end(body) { data = JSON.parse(body); } };
  await router({ method: 'GET', headers: {} }, res, new URL('/api/homes', 'http://local'));
  return data.homes;
}

test('/api/homes: runtime.dshVersion 来自解析器；未注入时是 null（老的调用方不受影响）', async (t) => {
  const store = new IndexStore(); t.after(() => store.close());
  const homeId = store.registerHome({ homePath: '/tmp/example-home' });
  const monitor = { get: () => ({ runtime: 'stopped' }) };

  const plain = await homesOf(createRouter({ store, monitor }));
  assert.equal(plain[0].runtime.dshVersion, null, '没有解析器时不得凭空造一个版本号');

  const pruned = [];
  const route = createRouter({
    store, monitor,
    dshVersion: { resolve: (h) => (h.homeId === homeId ? '0.1.5-rc.1' : null), prune: (ids) => pruned.push(ids) },
  });
  const [home] = await homesOf(route);
  assert.equal(home.runtime.dshVersion, '0.1.5-rc.1');
  assert.equal(home.runtime.runtime, 'stopped', '版本号不得挤掉原有的运行时字段');
  assert.deepEqual(pruned, [[homeId]], '顺手清理已移除实例的缓存');
});
