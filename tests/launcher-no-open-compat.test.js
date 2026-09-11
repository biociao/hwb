import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Launcher } from '../src/control/launcher.js';

// 旧版 dsh 不认识 `--no-open`：remote.js 早就在**远端**路径里刻意不发它（见那里的兼容说明），
// 但本机路径一直硬发 —— 于是同一台旧版 dsh「远端能用、本机连不上」，报错只有一句
// `error: unknown option '--no-open'`。这里用一个假 dsh 复现该行为，验证会摘掉参数重试。
//
// 假 dsh 的行为：
//   · 命令行里出现 --no-open → 打印 unknown option 并退出 2
//   · 否则 → 在 --port 指定的端口起一个 HTTP 服务，并按新版格式打印带 token 的 URL 行

const FAKE_DSH = `#!/usr/bin/env node
const args = process.argv.slice(2);
const portIndex = args.indexOf('--port');
const port = Number(args[portIndex + 1]);
if (args.includes('--no-open')) {
  process.stderr.write("error: unknown option '--no-open'\\n");
  process.exit(2);
}
const http = require('node:http');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<html><head></head><body>session-deeplink ok</body></html>');
});
server.listen(port, '127.0.0.1', () => {
  process.stdout.write('dsh web: http://127.0.0.1:' + port + '/?token=fake-token-123\\n');
});
process.on('SIGTERM', () => { server.close(); process.exit(0); });
`;

async function fakeDshOnPath(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'hwb-fake-dsh-'));
  const bin = path.join(dir, 'dsh');
  await writeFile(bin, FAKE_DSH);
  await chmod(bin, 0o755);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function trackExitListeners() {
  const before = new Set(process.listeners('exit'));
  return () => {
    for (const l of process.listeners('exit')) if (!before.has(l)) process.removeListener('exit', l);
  };
}

async function withPath(dir, fn) {
  const saved = process.env.PATH;
  process.env.PATH = `${dir}:${saved}`;
  try { return await fn(); } finally { process.env.PATH = saved; }
}

const FAST = { tunnelReadyDelayMs: 0 };

test('本机连接：旧版 dsh 不认 --no-open 时自动摘掉参数重试并成功', async (t) => {
  const dir = await fakeDshOnPath(t);
  const cleanup = trackExitListeners();
  t.after(cleanup);
  const home = await mkdtemp(path.join(tmpdir(), 'hwb-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));

  const launcher = new Launcher({ registry: { set() {} }, ...FAST });
  const homeSpec = { homeId: 'legacy-dsh-local', hostType: 'local', homePath: home };
  t.after(() => launcher.stop(homeSpec).catch(() => {}));

  const inst = await withPath(dir, () => launcher.open(homeSpec));
  assert.match(inst.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=fake-token-123$/, `实际: ${inst.url}`);
  assert.equal(launcher.status(homeSpec.homeId)?.pid > 0, true);
});

test('本机连接：新版 dsh 正常带 --no-open，不会多起一次', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hwb-fake-dsh-new-'));
  const bin = path.join(dir, 'dsh');
  // 新版：接受 --no-open，并把「被调用次数」写进一个文件，便于断言只起了一次。
  const calls = path.join(dir, 'calls.log');
  await writeFile(bin, `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.FAKE_DSH_CALLS, process.argv.slice(2).join(' ') + '\\n');
const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]);
const http = require('node:http');
http.createServer((req, res) => { res.writeHead(200); res.end('<html><body>session-deeplink ok</body></html>'); })
  .listen(port, '127.0.0.1', () => process.stdout.write('dsh web: http://127.0.0.1:' + port + '/?token=new-token\\n'));
process.on('SIGTERM', () => process.exit(0));
`);
  await chmod(bin, 0o755);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cleanup = trackExitListeners();
  t.after(cleanup);
  const home = await mkdtemp(path.join(tmpdir(), 'hwb-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));

  const launcher = new Launcher({ registry: { set() {} }, ...FAST });
  const homeSpec = { homeId: 'new-dsh-local', hostType: 'local', homePath: home };
  t.after(() => launcher.stop(homeSpec).catch(() => {}));

  process.env.FAKE_DSH_CALLS = calls;
  t.after(() => { delete process.env.FAKE_DSH_CALLS; });
  const inst = await withPath(dir, () => launcher.open(homeSpec));
  assert.match(inst.url, /token=new-token/);

  const fs = await import('node:fs/promises');
  const lines = (await fs.readFile(calls, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 1, '新版 dsh 应一次成功，不该重试');
  assert.match(lines[0], /--no-open/, '新版路径应带 --no-open（避免多弹浏览器标签）');
});

test('本机连接：其它启动失败不会被误当成「不认识 --no-open」而重试', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hwb-fake-dsh-broken-'));
  const bin = path.join(dir, 'dsh');
  const calls = path.join(dir, 'calls.log');
  await writeFile(bin, `#!/usr/bin/env node
require('node:fs').appendFileSync(process.env.FAKE_DSH_CALLS, 'call\\n');
process.stderr.write('error: something else broke\\n');
process.exit(3);
`);
  await chmod(bin, 0o755);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cleanup = trackExitListeners();
  t.after(cleanup);
  const home = await mkdtemp(path.join(tmpdir(), 'hwb-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));

  const launcher = new Launcher({ registry: { set() {} }, ...FAST });
  const homeSpec = { homeId: 'broken-dsh-local', hostType: 'local', homePath: home };

  process.env.FAKE_DSH_CALLS = calls;
  t.after(() => { delete process.env.FAKE_DSH_CALLS; });
  const error = await withPath(dir, () => launcher.open(homeSpec).then(() => null, (e) => e));
  assert.ok(error, '应当失败');
  assert.match(error.message, /dsh web did not come up/);

  const fs = await import('node:fs/promises');
  const callLines = (await fs.readFile(calls, 'utf8')).trim().split('\n');
  assert.equal(callLines.length, 1, '与 --no-open 无关的失败不该重试');
});
