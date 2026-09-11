#!/usr/bin/env node
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { serviceDir, socketFile, configFile, readConfig, saveConfig, serverArgs } from './lib/service-config.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const help = `hwb — 服务管理（macOS / Linux，Node.js 22.5+）
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
    env: { ...process.env, HWB_SERVICE_PORT: String(cfg.port) },
  });
  fs.closeSync(fd);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(Error(`启动超时，查看 ${output}`)); }, 15000);
    child.once('error', err => { clearTimeout(timer); reject(err); });
    child.once('exit', code => { clearTimeout(timer); reject(Error(`启动失败 (${code})，查看 ${output}`)); });
    child.once('message', msg => { if (msg.ready) { clearTimeout(timer); resolve(); } });
  });
  child.unref();
  console.log(`已启动 PID ${child.pid} http://127.0.0.1:${cfg.port}`);
}
async function stop() {
  const old = await request('stop');
  if (!old) { console.log('已停止'); return; }
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
  const result = spawnSync(command, args, { cwd: root, env, stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8' });
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
      console.log(state ? JSON.stringify({ status: state.ready ? 'running' : 'starting', ...state }, null, 2) : 'stopped');
      if (!state?.ready) process.exitCode = 1;
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
      const [major, minor] = process.versions.node.split('.').map(Number);
      if (major < 22 || (major === 22 && minor < 5)) throw Error('需要 Node.js 22.5+');
      const state = await request();
      if (state?.ready) {
        const res = await fetch(`http://127.0.0.1:${state.port}/`, { signal: AbortSignal.timeout(3000) });
        if (!res.ok) throw Error(`HTTP ${res.status}`);
      }
      console.log(`Node ${process.version} ✓ 配置 ✓ 服务 ${state?.ready ? 'HTTP 正常 ✓' : '未运行'}`); return;
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
async function dispatch() {
  if (!['start', 'stop', 'restart'].includes(process.argv[2])) return main();
  fs.mkdirSync(serviceDir, { recursive: true, mode: 0o700 });
  const lock = path.join(serviceDir, 'service.lock');
  let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); }
  catch (err) {
    if (err.code === 'EEXIST') throw Error(`另一个启停命令持有 ${lock}；若命令曾异常退出，请确认没有启停操作后删除此锁文件`);
    throw err;
  }
  try { fs.writeFileSync(fd, String(process.pid)); return await main(); }
  finally { fs.closeSync(fd); fs.rmSync(lock, { force: true }); }
}
dispatch().catch(err => { console.error(`hwb: ${err.message}`); process.exitCode = 1; });
