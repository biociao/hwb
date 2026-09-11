#!/usr/bin/env node
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { serviceDir, socketFile, configFile, readConfig, saveConfig, serverArgs } from './lib/service-config.js';
import { isNodeSupported, nodeRequirementMessage, MIN_NODE } from './lib/node-version.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const help = `hwb — 服务管理（macOS / Linux，Node.js ${MIN_NODE}+）
  hwb [serve] [服务器选项]       前台运行，兼容原命令
  hwb start | stop | restart    后台启停（不配置开机自启）
  hwb status                   显示运行端口和 PID；停止时退出码 1
  hwb logs [-f] [-n 行数]       查看日志，-f 跟随轮转
  hwb config show|path          显示配置或配置文件位置
  hwb config set 键 JSON值      校验并保存，如 port 4320 / verbose true
  hwb config update 文件       合并 JSON 配置（重启后生效）
  hwb upgrade                  Git 快进更新并测试；原在运行则重启
  hwb test [Node测试选项]       运行项目测试
  hwb doctor                   检查 Node、配置和服务可达性
  hwb --version | --help
配置默认 ~/.hwb/config.json；HWB_DIR 可隔离配置、数据库与服务。
停止/重启 hwb 也会关闭它托管的 dsh 子进程。`;

function request(command = 'status') {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketFile);
    let data = '';
    socket.setTimeout(2000, () => socket.destroy(Error('服务控制连接超时')));
    socket.on('connect', () => socket.write(command + '\n'));
    socket.on('data', chunk => { data += chunk; });
    socket.on('error', err => ['ENOENT', 'ECONNREFUSED'].includes(err.code) ? resolve(null) : reject(err));
    socket.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(Error('服务控制响应无效')); } });
  });
}
// 启动失败时，子进程的 stdout/stderr 都进了 service.log —— 用户只看到一句
// 「启动失败 (2)，查看 …/service.log」就得自己去翻文件。而「为什么失败」往往是一句
// 已经写好的、能照做的提示（server.js 打的 `hwb: 无法打开数据库（路径）…` 常见原因……）。
// 这里把那几行直接带回终端：取**最后**一个 `hwb:` 提示块（含其缩进续行），
// 没有提示块时退回日志尾部。完整日志仍然是权威，所以两条路径都会把文件位置一并说出来。
//
// 「最后」这个限定是必须的：service.log 是 append-only 的，历次启动的提示都留在里面。
// 取第一个会把**上一次**失败的提示当成这一次的原因 —— 实测：日志开头是旧的
// `无法打开数据库（/tmp/OLD-backup/hwb.db）`，而这一次其实死于端口占用，
// 用户却被告知去改一个跟当前问题无关的数据库路径。
function failureDetail(logFile, maxLines = 8) {
  let text;
  try { text = fs.readFileSync(logFile, 'utf8'); } catch { return ''; }
  const lines = text.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim() !== '');
  let hint = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('hwb:')) continue;
    hint = [lines[i]];
    // 提示块是「首行 + 若干缩进续行」，续行紧跟在后面
    for (let j = i + 1; j < lines.length && /^\s{2,}\S/.test(lines[j]); j++) hint.push(lines[j]);
    break;
  }
  // 没有提示块时退回日志尾部，但**必须丢掉栈帧**：真实报错往往在栈帧的上一行，
  // 只截尾 4 行会得到「4 行 at …」而把唯一有用的那行挡在外面（实测过）。
  const body = hint.length
    ? hint
    : lines.filter((l) => !/^\s*at\s/.test(l) && !/^\s*$/.test(l)).slice(-3);
  return body.slice(0, maxLines)
    .map((l) => `  ${l.length > 300 ? l.slice(0, 300) + '…' : l}`)
    .join('\n');
}
async function start() {
  const old = await request();
  if (old) { if (!old.ready) throw Error('服务正在启动，请稍后查看状态'); console.log(`已运行 PID ${old.pid}`); return; }
  const cfg = readConfig();
  fs.mkdirSync(serviceDir, { recursive: true, mode: 0o700 });
  fs.rmSync(socketFile, { force: true });
  const output = path.join(serviceDir, 'service.log');
  const fd = fs.openSync(output, 'a', 0o600);
  const child = spawn(process.execPath, [path.join(root, 'src/service.js'), ...serverArgs(cfg)], {
    cwd: root, detached: true, stdio: ['ignore', fd, fd, 'ipc'],
    // HWB_DIR **必须传解析后的绝对路径**：子进程的 cwd 是仓库根（cwd: root），
    // 而 serviceDir 是各进程自己用 path.resolve 算的 —— 若用户给的是相对路径（HWB_DIR=state），
    // CLI 会指向 <当前目录>/state，子进程却指向 <仓库根>/state。实测后果：
    //   · 控制 socket 落在仓库里，`status` 报 stopped（退出码 1）而服务其实在 4399 正常服务
    //   · `stop` 永远停不掉它，还会误报「很可能是前台运行的 hwb serve」
    // 传绝对路径让两边指向同一个目录，与 cwd 无关。
    env: { ...process.env, HWB_DIR: serviceDir, HWB_SERVICE_PORT: String(cfg.port) },
  });
  fs.closeSync(fd);
  // 日志可能因失败而新增内容，所以细节要在失败发生的**那一刻**再读
  const why = () => {
    const detail = failureDetail(output);
    return `\n${detail}${detail ? '\n' : ''}  完整日志: ${output}`;
  };
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(Error(`启动超时${why()}`)); }, 15000);
    child.once('error', err => { clearTimeout(timer); reject(err); });
    child.once('exit', code => { clearTimeout(timer); reject(Error(`启动失败 (${code})${why()}`)); });
    child.once('message', msg => { if (msg.ready) { clearTimeout(timer); resolve(); } });
  });
  child.unref();
  console.log(`已启动 PID ${child.pid} http://127.0.0.1:${cfg.port}`);
}
// 端口上是不是**hwb 自己**在服务（不依赖控制 socket）。
// 只探测「端口有没有人在听」是不够的：随便一个程序占了配置端口，就会被报成
// 「前台运行的 hwb serve」—— 那是另一个方向的谎报。这里问一句只有 hwb 会这样答的问题：
// /api/homes 返回 `{homes:[...]}`（该路由只读、不受同源校验影响，别的服务不会给出这个形状）。
async function hwbOnPort(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/homes`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    const body = await res.json();
    return Array.isArray(body?.homes);
  } catch { return false; }
}

// 端口上有没有人在监听（不依赖控制 socket）。
function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host: '127.0.0.1' });
    const done = (v) => { socket.destroy(); resolve(v); };
    socket.setTimeout(800, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function stop() {
  const old = await request('stop');
  if (!old) {
    // 没有控制 socket ≠ 服务没在跑：前台 `hwb serve` 不创建 socket，但它占着端口。
    // 原先直接打印「已停止」并返回 0，用户以为停掉了，下一次 `hwb start` 却只报一句
    // 难懂的「启动失败 (1)」（其实是 EADDRINUSE）。这里说清楚实际情况。
    const port = readConfig().port;
    if (await hwbOnPort(port)) {
      throw Error(`没有控制 socket，但 http://127.0.0.1:${port} 上有 hwb 在服务 —— `
        + '多半是前台运行的 `hwb serve`。请到那个终端按 Ctrl-C 停止它。');
    }
    if (await portInUse(port)) {
      // 端口被占但不是 hwb：不要说成「前台 hwb serve」，那会把用户引到错误的方向
      // （去某个终端找 Ctrl-C），而实际该处理的是另一个程序。
      throw Error(`没有控制 socket，端口 ${port} 被**其它程序**占用（不是 hwb）。`
        + `可换端口：\`hwb config set port <新端口>\`；或查占用者：\`lsof -i :${port}\`。`);
    }
    console.log('已停止'); return;
  }
  for (let i = 0; i < 100; i++) {
    await delay(100);
    if (!await request()) { console.log('已停止'); return; }
  }
  throw Error('停止超时；未强制杀进程，请查看日志');
}
function run(command, args, capture = false) {
  const env = { ...process.env };
  // A CLI invoked by a Node test must still run its own test suite.
  delete env.NODE_TEST_CONTEXT;
  // spawnSync **阻塞事件循环**，心跳定时器在这期间不会触发 —— 前后各摸一次锁，
  // 让「正在跑长命令」期间锁的 mtime 尽量新（阈值见 LOCK_STALE_MS 的说明）。
  touchLock();
  const result = spawnSync(command, args, { cwd: root, env, stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8' });
  touchLock();
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(`${command} 失败 (${result.status})${result.stderr ? ': ' + result.stderr.trim() : ''}`);
  return result.stdout?.trim();
}
function test(args = []) {
  const files = fs.readdirSync(path.join(root, 'tests')).filter(f => f.endsWith('.test.js')).sort().map(f => path.join(root, 'tests', f));
  run(process.execPath, ['--test', ...args, ...files]);
}
async function main() {
  let [command, ...args] = process.argv.slice(2);
  if (['--help', '-h', 'help'].includes(command)) return console.log(help);
  if (['--version', '-V', 'version'].includes(command)) return console.log(JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version);
  // 版本门槛集中在此处（与 package.json engines 同源）：索引依赖 node:sqlite，
  // 版本不足时子进程只会写一行难懂的 ERR_UNKNOWN_BUILTIN_MODULE 到 service.log，
  // 这里先拦住并给出可照做的提示。--help/--version 仍然可用，便于排查。
  if (!isNodeSupported()) {
    console.error(nodeRequirementMessage());
    process.exit(1);
  }
  if (!command || command === 'serve' || command.startsWith('-')) {
    const extra = command && command !== 'serve' ? [command, ...args] : args;
    process.argv = [process.execPath, path.join(root, 'src/server.js'), ...serverArgs(readConfig()), ...extra];
    await import('./server.js'); return;
  }
  if (['start', 'stop', 'restart', 'status', 'upgrade', 'doctor'].includes(command) && args.length) throw Error(`${command} 不接受额外参数`);
  switch (command) {
    case 'start': return start();
    case 'stop': return stop();
    case 'restart': readConfig(); await stop(); return start();
    case 'status': {
      const state = await request();
      if (state) {
        console.log(JSON.stringify({ status: state.ready ? 'running' : 'starting', ...state }, null, 2));
        if (!state.ready) process.exitCode = 1;
        return;
      }
      // 没有控制 socket ≠ 没在跑：前台 `hwb serve` 不创建 socket，但它占着配置里的端口。
      // `stop` 早就为这件事补了端口探测，`status`/`doctor` 当时漏了 —— 于是看板明明在返回 200、
      // `status` 却说 `stopped` 并以退出码 1 结束（脚本里 `set -e` 会据此当成「服务挂了」）。
      const port = readConfig().port;
      if (await hwbOnPort(port)) {
        console.log(JSON.stringify({ status: 'running', foreground: true, port,
          note: '前台运行的 hwb serve 不创建控制 socket' }, null, 2));
        return;   // 确实是 hwb 在服务 → 退出码 0
      }
      console.log('stopped');
      process.exitCode = 1;
      return;
    }
    case 'config': {
      const [action = 'show', key, value, ...rest] = args;
      if (rest.length) throw Error('配置参数过多');
      if (action === 'show' && !key) return console.log(JSON.stringify(readConfig(), null, 2));
      if (action === 'path' && !key) return console.log(configFile);
      if (action === 'set' && key && value !== undefined) {
        let parsed; try { parsed = JSON.parse(value); } catch { parsed = value; }
        saveConfig({ ...readConfig(), [key]: parsed });
      } else if (action === 'update' && key && !value) {
        const patch = JSON.parse(fs.readFileSync(path.resolve(key), 'utf8'));
        if (!patch || Array.isArray(patch) || typeof patch !== 'object') throw Error('配置必须是 JSON 对象');
        saveConfig({ ...readConfig(), ...patch });
      } else throw Error('用法: hwb config show|path|set 键 值|update 文件');
      console.log(`已保存 ${configFile}；运行中的服务需 hwb restart 生效`); return;
    }
    case 'logs': {
      let lines = 100, follow = false;
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '-f' || args[i] === '--follow') follow = true;
        else if (args[i] === '-n') { lines = Number(args[++i]); if (!Number.isInteger(lines) || lines < 1) throw Error('行数必须为正整数'); }
        else throw Error(`未知日志选项: ${args[i]}`);
      }
      const file = readConfig().log || path.join(serviceDir, 'service.log');
      if (!fs.existsSync(file)) throw Error(`日志尚不存在: ${file}；启动诊断见 ${path.join(serviceDir, 'service.log')}`);
      run('tail', [...(follow ? ['-F'] : []), '-n', String(lines), file]); return;
    }
    case 'test': return test(args);
    case 'doctor': {
      readConfig();
      if (!isNodeSupported()) throw Error(nodeRequirementMessage());
      const state = await request();
      let port = state?.port;
      let up = false;
      if (state?.ready) {
        up = true;
      } else {
        // 同上：后台服务之外还有「前台 serve」这一种在跑法，它没有控制 socket。
        port = port || readConfig().port;
        up = await hwbOnPort(port);
      }
      if (up) {
        const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) });
        if (!res.ok) throw Error(`HTTP ${res.status}`);
      }
      const how = state?.ready ? '' : '（前台 serve，无控制 socket）';
      console.log(`Node ${process.version} ✓ 配置 ✓ 服务 ${up ? `HTTP 正常 ✓${how}` : '未运行'}`); return;
    }
    case 'upgrade': {
      if (!fs.existsSync(path.join(root, '.git'))) throw Error('upgrade 仅支持 Git 安装；npm 安装请使用 npm install -g hwb@latest 后 hwb restart');
      if (run('git', ['status', '--porcelain', '--untracked-files=all'], true)) throw Error('工作区有未提交修改；请先提交或自行保存后升级');
      run('git', ['rev-parse', '--abbrev-ref', '@{upstream}'], true);
      const wasRunning = await request();
      run('git', ['pull', '--ff-only']);
      test();
      if (wasRunning) run(process.execPath, [path.join(root, 'src/cli.js'), 'restart']);
      console.log('升级及测试完成'); return;
    }
    default: throw Error(`未知命令: ${command}\n运行 hwb --help 查看用法`);
  }
}
// 进程还在不在。process.kill(pid, 0) 不发信号，只做存在性检查；EPERM 表示「存在、但我们没权限
// 给它发信号」，同样算活着。判定方向刻意保守：把「活着」误判成「死了」才会去接管锁，
// 所以只有确定查不到该进程（ESRCH）才算死。
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (err) { return err.code === 'EPERM'; }
}

// 启停锁的持有者每 REFRESH_MS 更新一次锁文件的 mtime；超过 STALE_MS 没更新就认为它已经不在了。
const LOCK_REFRESH_MS = 5_000;
// STALE_MS 的取值**不是**「心跳的几倍」，而是「必须大于持有者最长的一次阻塞调用」：
// `hwb upgrade` 会依次执行 `git pull` 与**整套测试**，而它们走的是 `spawnSync` —— 事件循环
// 被整个阻塞住，心跳定时器根本不会触发。若阈值太短（例如按心跳 4 倍取 20s），upgrade 跑到一半
// 就会被另一个 `hwb stop`/`start` 判成残留并接管，锁在多线程意义上被绕过 —— 而那正是它要防的事。
// 2 分钟远大于任何单次阻塞调用（本仓库整套测试约 6 秒，git pull 若干秒），
// 代价是持有者被 kill -9 后，最多要等 2 分钟才自动接管（其间提示里也写明了可手工删除）。
const LOCK_STALE_MS = 120_000;
// run() 是阻塞调用，进入/返回时各摸一次锁，让「正在跑长命令」期间 mtime 尽量新。
let activeLock = null;
const touchLock = () => { try { activeLock?.touch(); } catch { /* 锁已被清掉 */ } };

// 拿启停锁。
//
// 锁文件里写着持有者 PID，所以「上次启停被 kill -9」留下的残留锁可以被识别并接管 ——
// 原先这种情况会让 start/stop/restart **全部**失败，只留一句「请删除此锁文件」。
//
// 但**只看 PID 活不活是不够的**：PID 会被回收（macOS 上限约 99998）。一个被 kill -9 的启停命令
// 留下的锁，其 PID 被任何无关进程复用之后，锁就永远「被持有」了 —— 用户再次卡在同一个症状上
// （实测：拿一个跟 hwb 无关的常驻进程 PID 写进锁文件，start/stop/restart 全部退出码 1）。
// 因此再加一路**心跳**：持有者活着就每 5s 摸一次锁文件的 mtime；20s 没有心跳即视为残留。
// 这样「PID 被复用」与「持有者真的死了」都能识别，而正常的长操作（`hwb upgrade` 会跑一整套
// 测试）因为一直在心跳，不会被误抢。代价写明白：持有者被 SIGSTOP/整机休眠而暂停超过 20s 时，
// 它也会被判为残留 —— 那种情况下另一个命令接管反而更符合用户期待。
function lockHeldBy(lock) {
  const raw = (() => { try { return fs.readFileSync(lock, 'utf8').trim(); } catch { return ''; } })();
  const pid = Number(raw.split(/\s+/)[0]);
  const alive = Number.isInteger(pid) && pid > 0 && pidAlive(pid);
  let ageMs = 0;
  try { ageMs = Date.now() - fs.statSync(lock).mtimeMs; } catch { return { held: false, pid, alive: false, ageMs: 0, raw }; }
  const fresh = ageMs <= LOCK_STALE_MS;
  // 空锁（持有者正在 open 与 write 之间）**不能**当成残留：那是并发命令刚创建的那一瞬间，
  // 抢过去就变成两个持有者。只有「空且已经不再更新」才算残留。
  const held = raw === '' ? fresh : (alive && fresh);
  return { held, pid, alive, ageMs, raw };
}

// 接管一把残留锁：先把它**原子地**移到一边，再确认移走的正是我们读到的那个文件。
// 直接用 rmSync 是不安全的：并发接管者可能在我们读取之后、删除之前已经建好了自己的新锁，
// 我们那一记 rm 会把**别人的新锁**删掉，然后自己也 `wx` 成功 —— 两个持有者（审查提出，
// 未能复现，但窗口确实存在）。rename + 内容比对把这件事变成可判定的。
function takeOverLock(lock, expectedRaw) {
  const parked = `${lock}.stale-${process.pid}-${Date.now()}`;
  try { fs.renameSync(lock, parked); } catch { return false; }   // 别人先接管了
  let same = false;
  try { same = fs.readFileSync(parked, 'utf8').trim() === expectedRaw; } catch { same = false; }
  if (!same) {
    // 我们移走的是别人的新锁：还回去（尽力而为）并放弃接管
    try { fs.renameSync(parked, lock); } catch { /* 已被别人占住 */ }
    return false;
  }
  try { fs.rmSync(parked, { force: true }); } catch { /* 已被清掉 */ }
  return true;
}

function acquireLock(lock) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // 用带 flag:'wx' 的一次 writeFileSync 创建并写入（而不是 open + write 两步），
      // 尽量缩短「锁存在但内容为空」的窗口；配合上面「空锁按新鲜度判断」，并发命令不会互相抢。
      const body = `${process.pid} ${Date.now()}`;
      fs.writeFileSync(lock, body, { flag: 'wx', mode: 0o600 });
      const beat = setInterval(() => { const now = new Date(); try { fs.utimesSync(lock, now, now); } catch { /* 锁已被清掉 */ } }, LOCK_REFRESH_MS);
      beat.unref?.();
      const touch = () => { const now = new Date(); try { fs.utimesSync(lock, now, now); } catch { /* 锁已被清掉 */ } };
      return {
        touch,
        release() { clearInterval(beat); try { fs.rmSync(lock, { force: true }); } catch { /* 已被清掉 */ } },
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const info = lockHeldBy(lock);
      if (info.held) {
        const age = Math.round(info.ageMs / 1000);
        throw Error(`另一个启停命令（PID ${info.pid}）持有 ${lock}（${age}s 前还有更新）；`
          + `确认它确实不在运行后，删除该锁文件即可（残留锁最迟 ${Math.round(LOCK_STALE_MS / 1000)}s 后会自动接管）`);
      }
      if (attempt === 0 && takeOverLock(lock, info.raw)) {
        // 只动这一个锁文件，不碰任何进程。
        const why = info.alive
          ? `持有者 PID ${info.pid} 虽在运行，但已 ${Math.round(info.ageMs / 1000)}s 没有心跳（很可能是 PID 被回收了）`
          : `持有者 PID ${info.raw || '未知'} 已不存在`;
        console.warn(`hwb: 发现残留启停锁 ${lock}（${why}），已接管`);
        continue;
      }
      throw Error(`另一个启停命令持有 ${lock}；若命令曾异常退出，请确认没有启停操作后删除此锁文件`);
    }
  }
  throw Error(`无法获取启停锁 ${lock}`);
}

async function dispatch() {
  if (!['start', 'stop', 'restart'].includes(process.argv[2])) return main();
  fs.mkdirSync(serviceDir, { recursive: true, mode: 0o700 });
  const lock = path.join(serviceDir, 'service.lock');
  const held = acquireLock(lock);
  activeLock = held;
  try { return await main(); }
  finally { activeLock = null; held.release(); }
}
dispatch().catch(err => { console.error(`hwb: ${err.message}`); process.exitCode = 1; });
