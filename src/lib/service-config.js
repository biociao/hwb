import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const serviceDir = path.resolve(process.env.HWB_DIR || path.join(os.homedir(), '.hwb'));
export const configFile = path.join(serviceDir, 'config.json');
export const socketFile = path.join(serviceDir, 'service.sock');
export function defaults() {
  return { port: 4310, db: path.join(serviceDir, 'hwb.db'), intervalMs: 60000,
    homes: [], log: path.join(serviceDir, 'hwb.log'), verbose: false, silent: false };
}
export function validate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('配置必须是 JSON 对象');
  const cfg = { ...defaults(), ...value };
  for (const key of Object.keys(value)) if (!Object.hasOwn(defaults(), key)) throw Error(`未知配置项: ${key}`);
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) throw Error('port 必须为 1–65535');
  if (!Number.isInteger(cfg.intervalMs) || cfg.intervalMs < 1) throw Error('intervalMs 必须为正整数');
  for (const key of ['verbose', 'silent']) if (typeof cfg[key] !== 'boolean') throw Error(`${key} 必须为 boolean`);
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
