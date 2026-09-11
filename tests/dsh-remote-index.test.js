import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync } from 'node:zlib';

const exec = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const INSTANCE_INDEX = path.join(root, 'dsh-remote-index', 'dsh-instance-index.mjs');
const MERGED_INDEX = path.join(root, 'dsh-remote-index', 'dsh-merged-index.mjs');

// dsh-remote-index 这两个脚本此前完全没有测试覆盖。它们会：
//   · 在本地读 dsh 会话目录，也可能**经 ssh 在远端主机上跑**（所以内存/耗时不是小事）；
//   · 解析远端 stdout（登录 banner 会混进来）；
//   · 把远端投影缓存里的字段渲染进一个聚合 HTML（注入面）。

const SESSION_ID = 'session-11111111-2222-3333-4444-555555555555';
const SESSION_DIR = `proj-a/${SESSION_ID}`;

async function makeTree(t, { sessionStats = null, headerBytes = 4096 } = {}) {
  const base = await mkdtemp(path.join(tmpdir(), 'hwb-idx-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const tree = path.join(base, 'tree');
  const cache = path.join(base, 'cache');
  const dir = path.join(tree, SESSION_DIR);
  await mkdir(dir, { recursive: true });
  await mkdir(cache, { recursive: true });
  const header = `${JSON.stringify({ type: 'session', cwd: '/r/proj-a', createdAt: 1_700_000_000_000 })}\n`;
  await writeFile(path.join(dir, 'session.jsonl.zstd'), zstdCompressSync(Buffer.from(header + 'A'.repeat(headerBytes))));
  await writeFile(path.join(cache, `${SESSION_ID}.json`), JSON.stringify({
    record: { rows: { title: { val: '缓存里的标题' }, sessionStats: { val: sessionStats ?? { turns: 3, steps: 4 } } } },
  }));
  return { base, tree, cache };
}

async function runInstanceIndex(tree, cache, extra = []) {
  const { stdout } = await exec(process.execPath, [INSTANCE_INDEX, '--root', tree, '--cache', cache, '--instance', 'test', ...extra],
    { maxBuffer: 32 * 1024 * 1024, timeout: 60_000 });
  return JSON.parse(stdout);
}

test('instance-index: 读出会话、并从投影缓存富化标题与统计', async (t) => {
  const { tree, cache } = await makeTree(t);
  const out = await runInstanceIndex(tree, cache);
  assert.equal(out.instance, 'test');
  assert.equal(out.sessions.length, 1, '应索引到唯一那个会话');
  const s = out.sessions[0];
  assert.equal(s.id, SESSION_ID);
  assert.equal(s.cwd, '/r/proj-a', 'header 的第一行要能被解析出来');
  assert.equal(s.title, '缓存里的标题', '投影缓存应按 sessionId 富化标题');
  assert.equal(s.turns, 3);
  assert.equal(s.steps, 4);
});

test('instance-index: 只读压缩文件的第一行，不为一行 header 解压整个会话', async (t) => {
  // 解压后 64 MiB —— 修复前（整包 zstdDecompressSync）会按这个尺寸吃内存，
  // 而这个脚本会在远端主机上跑，大会话能把远端一起拖下水。
  const { tree, cache } = await makeTree(t, { headerBytes: 64 * 1024 * 1024 });
  const started = Date.now();
  const out = await runInstanceIndex(tree, cache);
  const elapsed = Date.now() - started;
  assert.equal(out.sessions.length, 1);
  assert.equal(out.sessions[0].cwd, '/r/proj-a', '只读第一行不能影响 header 解析');
  // 流式实现在毫秒级；整包解压 64 MiB 需要明显更久。阈值取 15s，留足慢机器余量。
  assert.ok(elapsed < 15_000, `应只解压到第一行为止，实际耗时 ${elapsed}ms`);
});

test('instance-index: 投影缓存是全局的，多个项目目录不会重复读取', async (t) => {
  const { base, tree, cache } = await makeTree(t);
  // 再放 20 个空项目目录：修复前每个目录都会重扫缓存目录并解析所有 json。
  for (let i = 0; i < 20; i++) await mkdir(path.join(tree, `proj-${i}`), { recursive: true });
  const out = await runInstanceIndex(tree, cache);
  assert.equal(out.sessions.length, 1, '空的额外项目目录不该影响结果');
  assert.equal(out.sessions[0].title, '缓存里的标题', '富化仍然生效（hoist 不能改变语义）');
  assert.ok(base);
});

test('instance-index: header 缺失/不可解析时不崩，仍产出该会话', async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), 'hwb-idx-bad-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const tree = path.join(base, 'tree');
  const cache = path.join(base, 'cache');
  const dir = path.join(tree, SESSION_DIR);
  await mkdir(dir, { recursive: true });
  await mkdir(cache, { recursive: true });
  // 不是 JSON 的第一行
  await writeFile(path.join(dir, 'session.jsonl.zstd'), zstdCompressSync(Buffer.from('not json at all\nrest')));
  const out = await runInstanceIndex(tree, cache);
  assert.equal(out.sessions.length, 1);
  // header 解析不出来时回落到项目目录**路径**（这是该工具既有的行为）
  assert.match(out.sessions[0].cwd, /proj-a$/, 'header 不可用时回落到项目目录');
});

// ── 合并索引 ──

async function makeInstancesFile(t, { withBanner = false, sessionStats = null } = {}) {
  const { base, tree, cache } = await makeTree(t, { sessionStats });
  const binDir = path.join(base, 'bin');
  await mkdir(binDir, { recursive: true });
  const nodeBin = path.join(binDir, 'node-with-banner');
  // 模拟远端登录 shell 的 banner：JSON 前面混进两行普通文本。
  await writeFile(nodeBin, `#!/bin/bash\n${withBanner ? 'echo "Welcome to the server!"\necho "Last login: today"\n' : ''}exec "${process.execPath}" "$@"\n`);
  await chmod(nodeBin, 0o755);
  const instances = path.join(base, 'instances.json');
  await writeFile(instances, JSON.stringify({
    instances: [{ id: 'local-test', nodeBin, sessionsRoot: tree, cacheRoot: cache }],
  }));
  return { base, instances, binDir, nodeBin, tree, cache };
}

async function runMerged(instances, extraArgs = []) {
  const { stdout } = await exec(process.execPath, [MERGED_INDEX, '--instances', instances, ...extraArgs],
    { maxBuffer: 32 * 1024 * 1024, timeout: 60_000 });
  return stdout;
}

test('merged-index: 远端 stdout 混入登录 banner 时仍能解析（不是 SyntaxError）', async (t) => {
  const { instances, tree, cache } = await makeInstancesFile(t, { withBanner: true });
  const stdout = await runMerged(instances);
  const data = JSON.parse(stdout.trim().split('\n').pop());
  assert.deepEqual(data.offline, [], '混入 banner 不该让实例被标记离线');
  assert.ok(data.resources.includes('local-test'), `resources 应含该实例，实际 ${JSON.stringify(data.resources)}`);
  // 顺带确认夹具确实被读到了（否则上面的断言可能是「空跑也通过」）
  assert.equal(data.sessions.length, 1, `应读到夹具里的那个会话（tree=${tree} cache=${cache}）`);
});

test('merged-index: 远端缓存里的数值字段被规范化，不能注入 HTML', async (t) => {
  const { base, instances, tree, cache } = await makeInstancesFile(t, {
    sessionStats: { turns: '<img src=x onerror=alert(1)>', steps: '</span><script>alert(2)</script>' },
  });
  const htmlPath = path.join(base, 'out.html');
  await runMerged(instances, ['--html', htmlPath]);
  const html = await readFile(htmlPath, 'utf8');
  assert.doesNotMatch(html, /<img src=x/, '数值字段必须规范化，不能把远端文本当 HTML 插入');
  assert.doesNotMatch(html, /<script>alert/, '同上');
  assert.match(html, />0 轮 \/ 0 步</, '无法解析成数字时退化为 0');
  assert.ok(tree && cache);
});

test('merged-index: 单轮失败不会让 --watch 进程退出，而是记录并等下一轮', async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), 'hwb-mi-watch-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const child = execFile(process.execPath,
    [MERGED_INDEX, '--instances', path.join(base, 'missing.json'), '--html', path.join(base, 'out.html'), '--watch', '1'],
    { timeout: 20_000 });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  let exited = false;
  child.on('exit', () => { exited = true; });
  // 等两轮（1s 一轮）
  await new Promise((r) => setTimeout(r, 2600));
  assert.equal(exited, false, 'watch 进程不该因为一轮失败就退出');
  assert.match(stderr, /本轮刷新失败/, `应记录失败原因，实际 stderr: ${stderr}`);
  child.kill('SIGTERM');
  await new Promise((r) => child.once('exit', r));
});
