import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pExec = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(root, 'scripts', 'dsh-remote-web.sh');

// 这个脚本此前完全没有测试。下面三条都只用「解析参数 → 提前退出」的路径，
// 不碰 ssh、不建隧道，所以可以在测试里安全地跑真脚本。
async function runScript(args, env = {}) {
  try {
    const { stdout, stderr } = await pExec('/bin/bash', [SCRIPT, ...args],
      { env: { ...process.env, ...env }, timeout: 10_000 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

test('dsh-remote-web: --kill-pattern 是可用的选项（文档一直这么写，实现里却没有）', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hwb-rw-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const res = await runScript(['--kill-pattern', 'dsh --profile web', '--dry-run', 'fakehost'],
    { DSH_REMOTE_WEB_DIR: dir });
  assert.doesNotMatch(res.stderr, /Unknown option/, `--kill-pattern 不应被当成未知选项：${res.stderr.slice(0, 200)}`);
  assert.notEqual(res.code, 2, '不应以「用法错误」退出');
});

test('dsh-remote-web: 拒绝 kill 时保留 PID 记录，并如实返回非零', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hwb-rw-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pidFile = path.join(dir, 'tunnel.pid');
  for (const bad of ['0', 'abc', '']) {
    await writeFile(pidFile, bad);
    const res = await runScript(['--kill-tunnel'], { DSH_REMOTE_WEB_DIR: dir, TUNNEL_PID_FILE: pidFile });
    assert.notEqual(res.code, 0, `PID 记录为 ${JSON.stringify(bad)} 时必须非零退出（实际 ${res.code}）`);
    assert.equal(await readFile(pidFile, 'utf8'), bad,
      '拒绝 kill 时不能删掉记录 —— 否则那条隧道再也管不到了，而命令还说成功');
  }
});

test('dsh-remote-web: 运行目录是预先存在的共享目录时不改它的权限', async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), 'hwb-rw-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const shared = path.join(base, 'shared');
  await mkdir(shared, { mode: 0o755 });
  const before = (await stat(shared)).mode & 0o777;
  await runScript(['--help'], { DSH_REMOTE_WEB_DIR: shared });
  const after = (await stat(shared)).mode & 0o777;
  assert.equal(after, before, `预存在的目录权限不该被改（${before.toString(8)} → ${after.toString(8)}）`);

  // 自己新建的目录仍然收 0700（安全默认值不能丢）
  const fresh = path.join(base, 'fresh');
  await runScript(['--help'], { DSH_REMOTE_WEB_DIR: fresh });
  assert.equal((await stat(fresh)).mode & 0o777, 0o700, '自己创建的目录应收到 0700');
});
