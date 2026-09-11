import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFile } from 'node:child_process';
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
  const server = net.createServer(s => s.end());
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  await run('config', 'set', 'port', String(server.address().port));
  await assert.rejects(run('start'), /启动失败/);
  assert.equal(server.listening, true);
  await assert.rejects(run('status'));
});

test('CLI upgrade uses the tracked Git branch and rejects dirty or failing updates', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwb-upgrade-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const upstream = path.join(dir, 'upstream');
  const checkout = path.join(dir, 'checkout');
  fs.mkdirSync(upstream);
  const git = (cwd, ...args) => exec('git', args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' } });
  await git(upstream, 'init', '-b', 'main');
  fs.mkdirSync(path.join(upstream, 'src/lib'), { recursive: true });
  fs.mkdirSync(path.join(upstream, 'tests'));
  fs.copyFileSync(cli, path.join(upstream, 'src/cli.js'));
  fs.copyFileSync(new URL('../src/lib/service-config.js', import.meta.url), path.join(upstream, 'src/lib/service-config.js'));
  fs.copyFileSync(new URL('../src/lib/node-version.js', import.meta.url), path.join(upstream, 'src/lib/node-version.js'));
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
  const server = net.createServer(s => s.end());
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  await run('config', 'set', 'port', String(server.address().port));

  await assert.rejects(run('stop'), /端口 \d+ 仍被占用/);
  assert.equal(server.listening, true, 'CLI 不该去动这个进程');

  // 端口空闲时照常报已停止
  await new Promise(r => server.close(r));
  assert.match((await run('stop')).stdout, /已停止/);
});
