import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAX_TIMER_MS } from './timers.js';

export const serviceDir = path.resolve(process.env.HWB_DIR || path.join(os.homedir(), '.hwb'));
export const configFile = path.join(serviceDir, 'config.json');
export const socketFile = path.join(serviceDir, 'service.sock');
export function defaults() {
  return { port: 4310, db: path.join(serviceDir, 'hwb.db'), intervalMs: 60000,
    homes: [], log: path.join(serviceDir, 'hwb.log'), verbose: false, silent: false,
    // 界面外观偏好（白天/黑夜/跟随系统）。存在服务端而不只是浏览器 localStorage：
    // 它正是「下发给 dsh 实例」的那个值 —— hwb 重启、或换一个浏览器打开时都必须还是同一个，
    // 否则「新连接的实例该同步成什么主题」就无从判断。
    theme: 'system' };
}
export function validate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('配置必须是 JSON 对象');
  const cfg = { ...defaults(), ...value };
  for (const key of Object.keys(value)) if (!Object.hasOwn(defaults(), key)) throw Error(`未知配置项: ${key}`);
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) throw Error('port 必须为 1–65535');
  if (!Number.isInteger(cfg.intervalMs) || cfg.intervalMs < 1) throw Error('intervalMs 必须为正整数');
  // 上限 = setTimeout 延时上限。别以为「设得越大越好」：超过 2^31-1 时 Node 会把它当 1ms，
  // 服务反而开始每毫秒跑一轮（实测 1e16 曾原样通过校验）。
  if (cfg.intervalMs > MAX_TIMER_MS) throw Error(`intervalMs 过大（上限 ${MAX_TIMER_MS} ms ≈ 24.8 天；再大 setTimeout 会退化成 1ms 空转）`);
  for (const key of ['verbose', 'silent']) if (typeof cfg[key] !== 'boolean') throw Error(`${key} 必须为 boolean`);
  if (!['light', 'dark', 'system'].includes(cfg.theme)) throw Error(`theme 必须是 light / dark / system 之一`);
  for (const key of ['db', 'log']) {
    if (key === 'log' && cfg[key] === false) continue;
    if (typeof cfg[key] !== 'string' || !cfg[key].trim()) throw Error(`${key} 必须为非空路径`);
    if (!(key === 'db' && cfg[key] === ':memory:')) cfg[key] = expand(cfg[key]);
  }
  if (!Array.isArray(cfg.homes) || cfg.homes.some(h => typeof h !== 'string' || !h.trim())) throw Error('homes 必须为路径数组');
  cfg.homes = cfg.homes.map(expand);
  return cfg;
}
function expand(p) { return path.resolve(p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p); }
export function readConfig() {
  try { return validate(JSON.parse(fs.readFileSync(configFile, 'utf8'))); }
  catch (err) { if (err.code === 'ENOENT') return defaults(); throw err; }
}
export function saveConfig(value) {
  const cfg = validate(value);
  fs.mkdirSync(serviceDir, { recursive: true, mode: 0o700 });
  const tmp = `${configFile}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, configFile);
  } finally { fs.rmSync(tmp, { force: true }); }
  return cfg;
}
export function serverArgs(cfg) {
  return ['--port', String(cfg.port), '--db', cfg.db, '--interval-ms', String(cfg.intervalMs),
    ...(cfg.log === false ? ['--no-log'] : ['--log', cfg.log]),
    ...cfg.homes.flatMap(h => ['--home', h]), ...(cfg.verbose ? ['--verbose'] : []), ...(cfg.silent ? ['--silent'] : [])];
}
