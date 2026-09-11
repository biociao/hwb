import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const cli = new URL('../src/cli.js', import.meta.url).pathname;
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwb-cli-'));
  const run = (...args) => exec(process.execPath, [cli, ...args], { env: { ...process.env, HWB_DIR: dir }, timeout: 25000 });
  t.after(async () => { await run('stop').catch(() => {}); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, run };
}
async function port() {
  const server = net.createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const n = server.address().port;
  await new Promise(r => server.close(r));
  return n;
}
test('CLI help, config validation and atomic update', async t => {
  const { dir, run } = await fixture(t);
  assert.match((await run('--help')).stdout, /upgrade/);
  await run('config', 'set', 'port', '4321');
  const before = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
  await assert.rejects(run('config', 'set', 'port', '0'));
  await assert.rejects(run('config', 'set', 'unknown', 'true'));
  assert.equal(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), before);
  const patch = path.join(dir, 'patch.json');
  fs.writeFileSync(patch, '{"verbose":true}');
  await run('config', 'update', patch);
  const cfg = JSON.parse((await run('config', 'show')).stdout);
  assert.equal(cfg.port, 4321);
  assert.equal(cfg.verbose, true);
  await assert.rejects(run('typo'));
});
test('CLI service lifecycle, readiness, persisted config, logs and doctor', async t => {
  const { run } = await fixture(t);
  const n = await port();
  await run('config', 'set', 'port', String(n));
  await assert.rejects(run('status'));
  await run('start');
  const first = JSON.parse((await run('status')).stdout);
  assert.equal(first.ready, true);
  assert.equal(first.port, n);
  await run('start');
  assert.equal(JSON.parse((await run('status')).stdout).pid, first.pid);
  assert.match((await run('doctor')).stdout, /HTTP 正常/);
  assert.match((await run('logs', '-n', '10')).stdout, /listening/);
  await run('restart');
  assert.notEqual(JSON.parse((await run('status')).stdout).pid, first.pid);
  await run('stop');
  await run('stop');
  await assert.rejects(run('status'));
});
test('CLI refuses occupied ports without stopping the unrelated listener', async t => {
  const { run } = await fixture(t);
  const server = net.createServer(s => s.destroy());
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const n = server.address().port;
  await run('config', 'set', 'port', String(n));
  // 原先只报「启动失败 (1)，查看 …/service.log」—— 真正的原因（EADDRINUSE）在日志里，
  // 而且尾部还是 4 行栈帧。现在要把原因带回终端，并且绝不能只给栈帧。
  await assert.rejects(run('start'), (err) => {
    assert.match(err.stderr, /启动失败/);
    assert.match(err.stderr, new RegExp(String(n)), '应说出是哪个端口');
    assert.match(err.stderr, /已被占用/, '应说出原因，而不是只让用户去翻日志');
    assert.doesNotMatch(err.stderr, /^\s+at /m, '终端输出不该只有栈帧');
    return true;
  });
  assert.equal(server.listening, true);
  await assert.rejects(run('status'));
});

// 数据库打不开是第二常见的启动失败。server.js 早就会打一句能照做的 `hwb:` 提示，
// 但它只落在 service.log 里，终端上只有「启动失败 (2)」—— 用户必须去翻文件才知道该删哪个路径。
test('CLI：启动失败的原因（数据库损坏）直接出现在终端上', async t => {
  const { dir, run } = await fixture(t);
  const n = await port();
  await run('config', 'set', 'port', String(n));
  fs.writeFileSync(path.join(dir, 'hwb.db'), 'this is not a sqlite database\n');
  await assert.rejects(run('start'), (err) => {
    assert.match(err.stderr, /无法打开数据库/, '应把 server.js 的提示带回终端');
    assert.match(err.stderr, /hwb\.db/, '提示里应含具体路径');
    assert.match(err.stderr, /service\.log/, '仍要指出完整日志位置');
    assert.doesNotMatch(err.stderr, /^\s+at /m);
    return true;
  });
});

test('CLI upgrade uses the tracked Git branch and rejects dirty or failing updates', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwb-upgrade-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const upstream = path.join(dir, 'upstream');
  const checkout = path.join(dir, 'checkout');
  fs.mkdirSync(upstream);
  const git = (cwd, ...args) => exec('git', args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' } });
  await git(upstream, 'init', '-b', 'main');
  fs.mkdirSync(path.join(upstream, 'src', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(upstream, 'tests'));
  fs.copyFileSync(cli, path.join(upstream, 'src/cli.js'));
  // 整个 src/lib 一起复制，**不要**逐个列文件名：cli.js 的 import 会变（加过 node-version.js、
  // 又加过 timers.js），每加一个文件都要回来改这份清单，忘了就是一次「升级测试莫名其妙失败」。
  // 复制目录后新增依赖自动被覆盖。
  fs.cpSync(new URL('../src/lib', import.meta.url), path.join(upstream, 'src/lib'), { recursive: true });
  fs.writeFileSync(path.join(upstream, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(upstream, 'tests/pass.test.js'), 'import test from "node:test"; test("ok", () => {});');
  await git(upstream, 'add', '.');
  await git(upstream, 'commit', '-m', 'initial');
  await git(dir, 'clone', upstream, checkout);
  const run = () => exec(process.execPath, [path.join(checkout, 'src/cli.js'), 'upgrade'], { env: { ...process.env, HWB_DIR: path.join(dir, 'state') }, timeout: 15000 });
  fs.writeFileSync(path.join(upstream, 'change.txt'), 'new release');
  await git(upstream, 'add', '.');
  await git(upstream, 'commit', '-m', 'release');
  await run();
  assert.equal(fs.readFileSync(path.join(checkout, 'change.txt'), 'utf8'), 'new release');
  fs.writeFileSync(path.join(checkout, 'dirty.txt'), 'local work');
  await assert.rejects(run(), /未提交修改/);
  fs.unlinkSync(path.join(checkout, 'dirty.txt'));
  fs.writeFileSync(path.join(upstream, 'tests/pass.test.js'), 'throw Error("regression");');
  await git(upstream, 'add', '.');
  await git(upstream, 'commit', '-m', 'bad release');
  await assert.rejects(run(), /失败/);
});

// `hwb stop` 原先在「没有控制 socket」时无条件打印「已停止」并返回 0。
// 但前台运行的 `hwb serve` 不创建控制 socket，它占着端口 —— 用户以为停掉了，
// 下一次 `hwb start` 却只报一句难懂的「启动失败 (1)」（真实原因是 EADDRINUSE）。
test('CLI stop：没有控制 socket 但端口被占用时如实报错，而不是谎报已停止', async (t) => {
  const { dir, run } = await fixture(t);
  const server = net.createServer(s => s.destroy());
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  await run('config', 'set', 'port', String(server.address().port));

  // 端口被占但**不是** hwb 时，不该说成「前台运行的 hwb serve」（那会把用户引去某个终端找 Ctrl-C，
  // 而真正该处理的是别的程序）。消息里必须点出这是别的程序占的。
  await assert.rejects(run('stop'), /其它程序\*\*占用/);
  assert.equal(server.listening, true, 'CLI 不该去动这个进程');

  // 端口空闲时照常报已停止
  await new Promise(r => server.close(r));
  assert.match((await run('stop')).stdout, /已停止/);
});

// 启停锁是 `wx` 创建的独占文件，`finally` 里删除 —— 但如果一条启停命令被 kill -9，
// 锁文件就留在那里了，于是 start/stop/restart **全部**失败，只留一句「请删除此锁文件」。
// 锁里写着持有者的 PID，所以「持有者已不存在」是可以判定的：这种情况应当自动接管。
test('CLI 启停锁：残留锁（持有者已死）自动接管，活锁仍然拦住', async (t) => {
  const { dir, run } = await fixture(t);
  const lock = path.join(dir, 'service.lock');
  const n = await port();
  await run('config', 'set', 'port', String(n));

  // ① 拿一个「确定已死」的 PID：起一个子进程并等它退出
  const dead = await new Promise((resolve, reject) => {
    const child = execFile(process.execPath, ['-e', ''], (err) => (err ? reject(err) : resolve(child.pid)));
  });
  fs.writeFileSync(lock, String(dead));
  const started = await run('start');                       // 原实现：直接报「另一个启停命令持有…」
  assert.match(started.stdout, /已启动/);
  assert.match(started.stderr, /残留启停锁/, '应说明这是一把残留锁，而不是默默接管');
  assert.equal(JSON.parse((await run('status')).stdout).ready, true);
  await run('stop');

  // ② 空锁文件（上次在创建与写内容之间被杀）同样算残留 —— 但要**过期**才算：
  // 空锁可能是并发命令刚创建的那一瞬间，那必须视为「被持有」（见下一条用例）。
  fs.writeFileSync(lock, '');
  const aged = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(lock, aged, aged);
  await run('start');
  await run('stop');

  // ③ 持有者**活着且心跳新鲜**时必须照旧拦住 —— 接管逻辑不能变成「谁都能抢锁」
  fs.writeFileSync(lock, `${process.pid} ${Date.now()}`);   // 刚写完 = mtime 刚刚
  await assert.rejects(run('start'), /持有/);
  await assert.rejects(run('stop'), /持有/);

  // ④ PID 复用：持有者「活着」但这个 PID 其实是无辜的旁观者 —— 只看 PID 活不活会被它永久卡住
  // （macOS 的 PID 上限约 99998，回收很常见）。心跳过期即视为残留。
  const stale = new Date(Date.now() - 10 * 60_000);   // 远超过期阈值
  fs.utimesSync(lock, stale, stale);
  const taken = await run('start');
  assert.match(taken.stdout, /已启动/, '心跳过期的锁应被接管，而不是让所有启停命令都失败');
  assert.match(taken.stderr, /残留启停锁/, '应说明接管原因');
  await run('stop');
  fs.rmSync(lock, { force: true });
});

// service.log 是 append-only 的：历次启动失败的提示都留在里面。取「第一个」hwb: 提示
// 会把**上一次**失败的原因当成这一次的 —— 实测：日志开头是旧的「无法打开数据库（/tmp/OLD-…）」，
// 而这次其实死于端口占用，终端却让用户去改一个跟当前问题无关的数据库路径。
test('CLI：启动失败取的是日志里**最后**一条提示，不能把旧故障当成本次原因', async t => {
  const { dir, run } = await fixture(t);
  const server = net.createServer(s => s.destroy());
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const n = server.address().port;
  await run('config', 'set', 'port', String(n));
  // 写入一条历史提示（比本次启动更早）
  fs.writeFileSync(path.join(dir, 'service.log'),
    'hwb: 无法打开数据库（/tmp/OLD-backup/hwb.db）: unable to open database file\n'
    + '  常见原因：该路径已被一个目录占用、父目录不可写、或文件不是 SQLite 数据库。\n');

  await assert.rejects(run('start'), (err) => {
    assert.match(err.stderr, /已被占用/, '应报本次的真实原因（端口占用）');
    assert.doesNotMatch(err.stderr, /OLD-backup/, '不得把上一次失败的提示当成这次的原因');
    assert.doesNotMatch(err.stderr, /无法打开数据库/, '不得回显历史提示');
    return true;
  });
});

// HWB_DIR 允许是相对路径，但 serviceDir 是**各进程自己**用 path.resolve 算的，而后台服务是被
// `spawn(..., { cwd: root })` 拉起来的 —— 于是 CLI 指向 <当前目录>/state、子进程指向 <仓库根>/state。
// 实测后果（修前）：控制 socket 落在仓库里，`status` 报 stopped（退出码 1）而服务在 4399 正常服务，
// `stop` 永远停不掉它，还会误报「很可能是前台运行的 hwb serve」。
test('CLI：相对的 HWB_DIR 下 status/stop 依然能找到服务，且不往仓库里落文件', async t => {
  const repoRoot = path.dirname(path.dirname(cli));
  const stray = path.join(repoRoot, 'relstate');           // 修前子进程会创建它
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwb-rel-'));
  const run = (...args) => exec(process.execPath, [cli, ...args], { cwd: dir, env: { ...process.env, HWB_DIR: 'relstate' }, timeout: 25000 });
  t.after(async () => {
    await run('stop').catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(stray, { recursive: true, force: true });
  });
  const n = await port();
  await run('config', 'set', 'port', String(n));
  await run('start');
  const state = JSON.parse((await run('status')).stdout);
  assert.equal(state.ready, true, 'status 必须能找到刚启动的服务（两边要指向同一个 HWB_DIR）');
  assert.equal(state.port, n);
  assert.equal(fs.existsSync(stray), false, '相对 HWB_DIR 不该解析到仓库根下（子进程的 cwd）');
  await run('stop');
  await assert.rejects(run('status'), /./, 'stop 之后 status 应当报停止');
});

// setTimeout/setInterval 的延时上限是 2^31-1，**超过不会报错**，而是打印一行
// TimeoutOverflowWarning 后按 1ms 处理 —— 于是「把间隔调大」变成「每毫秒跑一轮索引与心跳」。
// 实测 1e16 曾原样通过 config 校验；命令行那条门（`serve --interval-ms`）连类型都不校验。
test('CLI：间隔与端口必须是有界的正整数，不能悄悄退化成 1ms 空转', async t => {
  const { dir, run } = await fixture(t);
  const n = await port();
  await run('config', 'set', 'port', String(n));
  const baseline = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');

  // ① 配置这条门
  await assert.rejects(run('config', 'set', 'intervalMs', '9999999999999999'), /intervalMs 过大/);
  await assert.rejects(run('config', 'set', 'intervalMs', '0'), /正整数/);
  assert.equal(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), baseline, '非法值不该写进配置');

  // ② 命令行这条门（绕过配置校验）。修前 `--interval-ms abc` 会照常启动服务并 1ms 空转。
  const serve = (args) => exec(process.execPath, [cli, 'serve', ...args, '--db', path.join(dir, 'hwb.db'),
    '--log', path.join(dir, 'serve.log')], { env: { ...process.env, HWB_DIR: dir }, timeout: 8000 });
  await assert.rejects(serve(['--interval-ms', 'abc', '--port', String(n)]), (err) => {
    assert.match(String(err.stderr || err.message), /--interval-ms 需要 1 到/);
    return true;
  });
  await assert.rejects(serve(['--interval-ms', '1e16', '--port', String(n)]), /--interval-ms 需要 1 到/);
  await assert.rejects(serve(['--port', 'abc']), /--port 需要 1 到/);
});

// `hwb start` 拉起的是**后台**服务，而 CLI 在子进程报到之前就消失是很常见的
// （Ctrl-C、关掉终端、supervisor/timeout 杀掉）。那时服务其实**已经监听成功**了，
// 不该因此死掉：原先 process.send() 在 IPC 通道关闭时会以未捕获的 EPIPE 打死它 ——
// 实测父进程 30ms 后退出 → 端口连不上 + 日志里一条 FATAL。注意这个失败是**异步**的
// （错误从 channel 的 'error' 事件冒出来），光用 try/catch 包住 send 是抓不到的。
test('service: 父进程（hwb start）提前退出时，已监听的服务不该被 EPIPE 杀掉', async t => {
  const n = await port();
  const cwd = path.dirname(path.dirname(cli));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwb-svc-'));
  const log = path.join(dir, 'service.log');
  const fd = fs.openSync(log, 'a', 0o600);
  const child = spawn(process.execPath, [path.join(cwd, 'src', 'service.js'),
    '--port', String(n), '--db', path.join(dir, 'hwb.db'), '--log', path.join(dir, 'hwb.log')],
    { cwd, detached: true, stdio: ['ignore', fd, fd, 'ipc'], env: { ...process.env, HWB_DIR: dir, HWB_SERVICE_PORT: String(n) } });
  fs.closeSync(fd);
  child.on('error', () => {});
  child.unref();
  t.after(() => {
    try { process.kill(child.pid, 'SIGKILL'); } catch { /* 已经退出 */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await new Promise(r => setTimeout(r, 30));
  try { child.disconnect(); } catch { /* 通道可能已断 */ }   // 模拟 CLI 死亡

  const reachable = async () => new Promise((resolve) => {
    const s = net.createConnection({ port: n, host: '127.0.0.1' });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { await new Promise(r => setTimeout(r, 100)); up = await reachable(); }
  assert.equal(up, true, '服务应仍在监听（不该被 EPIPE 打死）');
  assert.doesNotMatch(fs.readFileSync(log, 'utf8'), /EPIPE/, '日志里不该出现 EPIPE');
});

// `status` 原先只认控制 socket：前台 `hwb serve` 不创建 socket，于是看板明明在返回 200，
// `status` 却说 stopped 并**以退出码 1 结束**（脚本里 set -e 会据此认为服务挂了），
// `doctor` 则报「服务 未运行」还退出 0。`stop` 早就为这件事补了端口探测，这两条当时漏了。
test('CLI: status/doctor 对「前台 hwb serve」必须如实报告在运行', async t => {
  const { dir, run } = await fixture(t);
  const n = await port();
  await run('config', 'set', 'port', String(n));
  const cwd = path.dirname(path.dirname(cli));
  const out = fs.openSync(path.join(dir, 'serve.log'), 'a', 0o600);
  const fg = spawn(process.execPath, [cli, 'serve'], { cwd, env: { ...process.env, HWB_DIR: dir }, stdio: ['ignore', out, out] });
  fs.closeSync(out);
  fg.on('error', () => {});
  t.after(() => { try { process.kill(fg.pid, 'SIGKILL'); } catch { /* 已退出 */ } });

  const reachable = async () => new Promise((resolve) => {
    const s = net.createConnection({ port: n, host: '127.0.0.1' });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { await new Promise(r => setTimeout(r, 100)); up = await reachable(); }
  assert.equal(up, true, '前台 serve 应当起来了（夹具前提）');

  const status = await run('status');            // 没有控制 socket，但端口在服务
  assert.match(status.stdout, /running/, `status 应报在运行，实际：${status.stdout}`);
  assert.match(status.stdout, /foreground/);
  const doctor = await run('doctor');
  assert.match(doctor.stdout, /HTTP 正常/, `doctor 应报服务正常，实际：${doctor.stdout}`);
});

// 空锁（持有者正在 open 与 write 之间）不能被当成残留：那是并发命令刚创建的那一瞬间，
// 抢过去就变成两个持有者。只有「空且已经不再更新」才算残留。
test('CLI 启停锁：刚创建的空锁算「被持有」，过期空锁才算残留', async t => {
  const { dir, run } = await fixture(t);
  const lock = path.join(dir, 'service.lock');
  const n = await port();
  await run('config', 'set', 'port', String(n));

  fs.writeFileSync(lock, '');                       // 空锁 + 刚刚的 mtime = 并发命令正在写
  await assert.rejects(run('start'), /持有/, '空但新鲜的锁必须被视为被持有');

  const old = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(lock, old, old);                    // 空锁 + 过期 mtime = 上次崩在 open 与 write 之间
  const taken = await run('start');
  assert.match(taken.stdout, /已启动/);
  await run('stop');
  fs.rmSync(lock, { force: true });
});

// 心跳阈值必须大于「持有者最长的一次阻塞调用」。`hwb upgrade` 会跑 git pull 与**整套测试**，
// 而它们走 spawnSync —— 事件循环被整个阻塞，心跳定时器根本不会触发。
// 若阈值按「心跳的几倍」取（例如 20s），upgrade 跑到一半就会被另一个 start/stop 判成残留并接管，
// 锁在最该生效的场合失效。这里用「PID 活着 + 60s 没有心跳」来代表一台正在跑阻塞命令的持有者。
test('CLI 启停锁：持有者正卡在阻塞调用里（心跳暂停）时不得被抢', async t => {
  const { dir, run } = await fixture(t);
  const lock = path.join(dir, 'service.lock');
  const n = await port();
  await run('config', 'set', 'port', String(n));

  // 自己的 PID（活）+ 60s 前的心跳：正常路径下心跳是 5s 一次，但这 60s 里它正在跑阻塞命令
  fs.writeFileSync(lock, `${process.pid} ${Date.now()}`);
  const aged = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, aged, aged);
  await assert.rejects(run('start'), /持有/, '不能因为心跳暂停就抢走锁');

  // 真过期（10 分钟）才接管
  const dead = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(lock, dead, dead);
  const taken = await run('start');
  assert.match(taken.stdout, /已启动/);
  await run('stop');
  fs.rmSync(lock, { force: true });
});

// `git rev-parse @{upstream}` 在没有上游分支时只会给一句
// 「fatal: no upstream configured for branch 'x'」——用户得自己知道 upstream 是什么、该怎么建。
// upgrade 是文档里明确提供的命令，这条错误消息应该能照做（并带上分支名）。
// 注意：upgrade 作用在**它自己所在的仓库**上（run() 的 cwd 是 root），所以必须像上面那条
// 用例一样，把 cli.js + src/lib 复制到一个独立的临时仓库里跑 —— 否则测的是 hwb 自己的工作区。
test('CLI: upgrade 在没有上游分支时给出可照做的提示', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwb-noupstream-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.copyFileSync(cli, path.join(repo, 'src/cli.js'));
  fs.cpSync(new URL('../src/lib', import.meta.url), path.join(repo, 'src/lib'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'package.json'), '{"type":"module"}');
  const git = (...args) => exec('git', args, { cwd: repo, env: { ...process.env,
    GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid' } });
  await git('init', '-b', 'lonely');
  await git('add', '.');
  await git('commit', '-m', 'init');

  await assert.rejects(
    exec(process.execPath, [path.join(repo, 'src/cli.js'), 'upgrade'],
      { env: { ...process.env, HWB_DIR: path.join(dir, 'state') }, timeout: 15000 }),
    (err) => {
      assert.match(err.stderr, /没有上游分支/, `应说明缺上游，实际：${err.stderr}`);
      assert.match(err.stderr, /lonely/, '应带上分支名');
      assert.match(err.stderr, /git push -u/, '应给出可照做的命令');
      assert.doesNotMatch(err.stderr, /git 失败 \(128\)/, '不该只把 git 的英文报错抛出来');
      return true;
    });
});

// 审查实测：`hwb serve --port 4399`（配置里是别的端口）时，`stop` 打印「已停止」并 exit 0，
// 而 4399 上的服务照常返回 200；紧接着 `hwb start` 会再起一个后台服务 —— 两个进程共用同一个
// hwb.db 与同一个 hwb.log。根因是 stop/status/doctor 只看**配置里**的端口。
// 现在前台 serve 会把生效端口写进 <HWB_DIR>/service.port，三个命令都先看它。
test('CLI: 前台 serve 用了非配置端口时，stop 不得谎报已停止', async (t) => {
  const { dir, run } = await fixture(t);
  const cfgPort = await port();
  const servePort = await port();
  await run('config', 'set', 'port', String(cfgPort));
  const child = spawn(process.execPath, [cli, 'serve', '--port', String(servePort)],
    { env: { ...process.env, HWB_DIR: dir }, stdio: 'ignore' });
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* 已经退出 */ } });
  // 等它起来
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await new Promise((r) => setTimeout(r, 250));
    up = await fetch(`http://127.0.0.1:${servePort}/api/homes`).then((r) => r.ok, () => false);
  }
  assert.equal(up, true, '前置条件：前台 serve 已在非配置端口上服务');
  assert.ok(fs.existsSync(path.join(dir, 'service.port')), '生效端口必须被记下来');

  const status = await run('status').then((r) => r.stdout, (e) => e.stdout ?? '');
  assert.match(status, /running/, `status 必须报 running（实际 ${status.trim()}）`);

  const stopped = await run('stop').then(() => 'ok', (e) => e.message);
  assert.match(String(stopped), /前台运行|Ctrl-C/, `stop 必须指出服务还在（实际 ${stopped}）`);
  const still = await fetch(`http://127.0.0.1:${servePort}/api/homes`).then((r) => r.ok, () => false);
  assert.equal(still, true, '服务仍在服务（stop 不该声称已停止）');
});

// service.log 是子进程 stdout/stderr 的重定向目标，append-only 且从不轮转 ⇒ 可能几百 MB。
// 原先整份 readFileSync + split：审查实测 433 MB → 1.80s 阻塞、峰值 RSS 1.98 GB（≈4.5×文件大小）。
// 这里用一个 100 MB 的日志 + `--max-old-space-size=128` 复现同一形状：整份读会 OOM，
// 只读尾部则照常给出「最后一个 hwb: 提示块」。同时在文件**开头**放一个陈旧的提示块 ——
// 它绝不能被当成这一次的原因（这也是「取最后一个」这条语义在大文件下的回归）。
test('CLI: 启动失败的诊断只读日志尾部（100 MB 的 service.log 也不会整份读进内存）', async (t) => {
  const { dir, run } = await fixture(t);
  const busy = await port();
  await run('config', 'set', 'port', String(busy));
  // 占住配置端口，让 start 必然失败
  const blocker = net.createServer((s) => s.destroy());
  await new Promise((r) => blocker.listen(busy, '127.0.0.1', r));
  t.after(() => new Promise((r) => blocker.close(r)));

  const logFile = path.join(dir, 'service.log');
  const fd = fs.openSync(logFile, 'w');
  fs.writeSync(fd, 'hwb: 很久以前的旧原因（不该被当成这一次）\n  /tmp/OLD-backup/hwb.db\n');
  const line = 'x'.repeat(1023) + '\n';
  const chunk = Buffer.from(line.repeat(1024));   // ~1 MiB
  for (let i = 0; i < 100; i++) fs.writeSync(fd, chunk);   // ~100 MB
  fs.closeSync(fd);

  const capped = (...args) => exec(process.execPath, [cli, ...args], {
    env: { ...process.env, HWB_DIR: dir, NODE_OPTIONS: '--max-old-space-size=128' }, timeout: 30000,
  });
  let message = '';
  try { await capped('start'); } catch (e) { message = `${e.stdout ?? ''}${e.stderr ?? ''}${e.message ?? ''}`; }
  assert.match(message, /已被占用|无法启动/, `必须给出本次的真实原因（实际 ${message.slice(0, 300)}）`);
  assert.doesNotMatch(message, /很久以前的旧原因/, '不能把日志开头的陈旧提示块当成这一次的原因');
});

// `hwb upgrade` 会跑 `git pull` + 整套测试（几十秒），期间事件循环被 spawnSync 阻塞。
// 原先它**不持有启停锁**，而且最后无条件 restart —— 审查实测：用户在升级期间 `hwb stop`
// （成功、退出码 0），升级结束后服务被**又拉起来了**，两条命令谁都不报冲突。
// 修复：upgrade 也持锁（于是并发的启停命令会被明确拒绝，而不是「成功后被静默撤销」），
// 重启前再复核一次运行状态。
//
// 这里用**仓库副本**（含当前工作树，不是 HEAD）：upgrade 只作用于 CLI 自己所在的仓库，
// 所以必须在副本里跑；把副本的 tests/ 换成一个 6 秒的慢用例，把窗口拉开。
test('CLI: upgrade 全程持有启停锁（并发 stop 必须被明确拒绝）', async (t) => {
  const root = path.resolve(path.dirname(cli), '..');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hwb-upgrade-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const copy = path.join(base, 'repo');
  const bare = path.join(base, 'upstream.git');
  const state = path.join(base, 'state');
  fs.mkdirSync(copy, { recursive: true });
  await exec('/bin/sh', ['-c', `tar -C ${JSON.stringify(root)} --exclude=.git --exclude=node_modules -cf - . | tar -C ${JSON.stringify(copy)} -xf -`]);

  const g = (...args) => exec('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args], { cwd: copy, timeout: 30000 });
  await g('init', '-q', '-b', 'main');
  // 把整套测试换成一个 6 秒的慢用例：upgrade 的窗口就是 test() 这一步
  fs.rmSync(path.join(copy, 'tests'), { recursive: true, force: true });
  fs.mkdirSync(path.join(copy, 'tests'));
  fs.writeFileSync(path.join(copy, 'tests', 'slow.test.js'),
    "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('slow', async () => { await new Promise((r) => setTimeout(r, 6000)); assert.ok(true); });\n");
  await g('add', '-A');
  await g('commit', '-q', '-m', 'init');
  await g('init', '-q', '--bare', bare);
  await g('remote', 'add', 'origin', bare);
  await g('push', '-q', '-u', 'origin', 'main');

  const env = { ...process.env, HWB_DIR: state };
  const upgrade = spawn(process.execPath, [path.join(copy, 'src/cli.js'), 'upgrade'],
    { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let upgradeOut = '';
  upgrade.stdout.on('data', (d) => { upgradeOut += d; });
  upgrade.stderr.on('data', (d) => { upgradeOut += d; });
  const done = new Promise((r) => upgrade.on('exit', (code) => r(code)));
  t.after(() => { try { upgrade.kill('SIGKILL'); } catch { /* 已退出 */ } });

  await new Promise((r) => setTimeout(r, 2500));   // 等它进入 test() 阶段（此时锁已被持有）
  const stopOut = await exec(process.execPath, [path.join(copy, 'src/cli.js'), 'stop'], { env, timeout: 20000 })
    .then((r) => r.stdout, (e) => `${e.stdout ?? ''}${e.stderr ?? ''}${e.message ?? ''}`);
  assert.match(stopOut, /另一个启停命令/,
    `升级期间并发 stop 必须被明确拒绝（否则它会「成功」又被升级撤销），实际：${stopOut.trim().slice(0, 200)}`);

  const code = await done;
  assert.equal(code, 0, `upgrade 应正常结束，实际 ${code}；输出：${upgradeOut.slice(-300)}`);
  assert.match(upgradeOut, /升级及测试完成/);
});

// 记录端口只是**线索**，不能让它制造与 hwb 无关的错误：前台 serve 退出后留下的陈旧
// `service.port`，配上之后某个无关程序恰好占用那个端口，原先会让 `hwb stop` 报
// 「端口 X 被其它程序占用（不是 hwb）」—— 而 X 跟用户当前的服务毫无关系。
// 「被其它程序占用」只对**配置端口**报（那才是用户打算给 hwb 用的端口）。
test('CLI: 陈旧的 service.port 指向无关程序时，stop 不该报错（只对配置端口报占用）', async (t) => {
  const { dir, run } = await fixture(t);
  const cfgPort = await port();
  await run('config', 'set', 'port', String(cfgPort));
  // 一个与 hwb 无关的监听者，占用「记录端口」
  const strangerPort = await port();
  const stranger = net.createServer((s) => s.destroy());
  await new Promise((r) => stranger.listen(strangerPort, '127.0.0.1', r));
  t.after(() => new Promise((r) => stranger.close(r)));
  fs.writeFileSync(path.join(dir, 'service.port'), String(strangerPort));

  const stopOut = await run('stop').then((r) => r.stdout, (e) => `${e.stdout ?? ''}${e.stderr ?? ''}${e.message ?? ''}`);
  assert.match(String(stopOut), /已停止/, `没有 hwb 在跑时 stop 应正常报已停止（实际 ${String(stopOut).trim()}）`);
  assert.doesNotMatch(String(stopOut), /其它程序/, '无关程序占用的是记录端口，不该拿它报错');
  assert.ok(!fs.existsSync(path.join(dir, 'service.port')), 'stop 之后应清掉端口记录');

  // 对照：**配置端口**被无关程序占用时仍然要明确报错（用户该处理的就是这个）
  const blocker = net.createServer((s) => s.destroy());
  const busy = await port();
  await new Promise((r) => blocker.listen(busy, '127.0.0.1', r));
  t.after(() => new Promise((r) => blocker.close(r)));
  await run('config', 'set', 'port', String(busy));
  const busyOut = await run('stop').then((r) => r.stdout, (e) => `${e.stdout ?? ''}${e.stderr ?? ''}${e.message ?? ''}`);
  assert.match(String(busyOut), /其它程序/, `配置端口被占用时必须说清楚（实际 ${String(busyOut).trim().slice(0, 120)}）`);
});
