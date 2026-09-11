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

// 取「第一行」这件事曾经只在 zstd 分支上是流式的：非 zstd 分支用 readFile 把整个
// session.jsonl 读进内存再取第一行。实测一个 300 MB 的 session.jsonl：峰值 RSS 从基线
// 44 MB 涨到 **360 MB**（这个脚本还会经 ssh 在远端主机上跑，大会话能把远端的 dsh 一起拖下水）。
// 内存数字不适合写成断言（GC/平台差异会抖），所以这里钉两件确定的事：
//   ① 行为：超过 HEADER_LIMIT 的大文件仍能正确取到头部（并在此后停止读取）；
//   ② 结构：取头部的实现里不许出现 readFile（整文件读）。
test('instance-index: 大 session.jsonl 的头部读取必须是流式的（不整文件读进内存）', async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), 'hwb-idxbig-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dir = path.join(base, 'tree', SESSION_DIR);
  await mkdir(dir, { recursive: true });
  const header = JSON.stringify({ type: 'session', id: SESSION_ID, cwd: '/home/bot/proj-a', createdAt: 1700000000000 });
  // 头部 + 远超 HEADER_LIMIT(64 KiB) 的后续内容
  await writeFile(path.join(dir, 'session.jsonl'), `${header}\n${'y'.repeat(8 * 1024 * 1024)}\n`);
  const { stdout } = await exec(process.execPath, [INSTANCE_INDEX, '--root', path.join(base, 'tree'),
    '--cache', path.join(base, 'cache'), '--instance', 'big'], { timeout: 30000 });
  const parsed = JSON.parse(stdout);
  const session = parsed.projects[0].sessions[0];
  assert.equal(session.id, SESSION_ID, '大文件里的头部仍应被正确解析');
  // sizeBytes 是 fmtBytes() 的展示值（8 MB 文件 → 8）
  assert.ok(session.sizeBytes >= 8, `sizeBytes 应反映真实文件大小，实际 ${session.sizeBytes}`);

  const src = await readFile(INSTANCE_INDEX, 'utf8');
  const fn = src.slice(src.indexOf('async function readHeaderFirstLine'), src.indexOf('function parseHeader'));
  assert.doesNotMatch(fn, /readFile\(/, '取头部的实现不得整文件读入 —— 那是 300 MB → 360 MB RSS 的来源');
  assert.match(fn, /createReadStream/, '必须走流式读取');
});

// 独立的复现用夹具：两个实例，其中一个的输出坏掉（banner 里带 `{`，把「从第一个 { 开始解析」
// 这条兜底也打穿）或者给出一个超大索引。
async function makeTwoInstances(t, { big = false } = {}) {
  const base = await mkdtemp(path.join(tmpdir(), 'hwb-mrg-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const tree = path.join(base, 'tree');
  const cache = path.join(base, 'cache');
  await mkdir(tree, { recursive: true });
  const binDir = path.join(base, 'bin');
  await mkdir(binDir, { recursive: true });
  const badBin = path.join(binDir, 'node-banner');
  await writeFile(badBin, `#!/bin/bash\necho "Welcome to {buildhost} - node 22"\nexec "${process.execPath}" "$@"\n`);
  await chmod(badBin, 0o755);
  const bigBin = path.join(binDir, 'node-big');
  // 输出 >1 MiB 的**合法**索引 JSON，越过 spawnSync 默认的 maxBuffer
  // （会话在「扁平列表」与「按项目嵌套」里各出现一次，所以实际 JSON 会翻倍）
  await writeFile(bigBin, `#!/bin/bash\nexec "${process.execPath}" -e `
    + `'let s=[];for(let i=0;i<9000;i++)s.push({id:"session-"+i+"-aaaaaaaaaaaaaaaaaaaaaaaaaaaa",`
    + `cwd:"/home/bot/projects/some-project",title:"a fairly long session title",sizeBytes:1});`
    + `process.stdout.write(JSON.stringify({instance:"big",resources:["big"],projects:[],sessions:s}))' "$@"\n`);
  await chmod(bigBin, 0o755);
  const instances = path.join(base, 'instances.json');
  await writeFile(instances, JSON.stringify({ instances: [
    { id: 'good', nodeBin: process.execPath, sessionsRoot: tree, cacheRoot: cache },
    big ? { id: 'big', nodeBin: bigBin, sessionsRoot: tree, cacheRoot: cache }
        : { id: 'bad', nodeBin: badBin, sessionsRoot: tree, cacheRoot: cache },
  ] }));
  return { base, instances, bigBin, badBin };
}

// 一个实例的输出坏掉时，原先 parse 失败会冒到 tickGuarded，**整轮被丢弃** ——
// 旁边完全健康的实例也一整轮不刷新，--watch 的 HTML 永远停在旧快照上。
// 脚本自己的注释写着「单个实例的抖动不该拖垮看板」（ssh 非零退出就是这么处理的），
// 故障必须隔离在实例粒度。
test('merged-index: 坏输出的实例只让它自己离线，健康实例照常刷新', async (t) => {
  const { instances } = await makeTwoInstances(t);
  const data = JSON.parse((await runMerged(instances)).trim().split('\n').pop());
  assert.ok(data.resources.includes('good'), `健康实例必须仍在，实际 resources=${JSON.stringify(data.resources)}`);
  const offline = data.offline.map((o) => o.instance);
  assert.deepEqual(offline, ['bad'], `只有坏实例该离线，实际 ${JSON.stringify(data.offline)}`);
  assert.match(data.offline[0].error, /不是 JSON|banner/, '离线原因要说人话');
});

// spawnSync 默认 maxBuffer 是 1 MiB，而索引 JSON 约 350 B/会话（会话在扁平列表与按项目
// 嵌套里各出现一次）—— 大约 1.4k 个会话就越过上限，ENOBUFS 时 status 为 null、stderr 为空，
// 原先界面上只显示「exit null」。现在给出 256 MiB 的上限，并在真超限时说明原因。
test('merged-index: 索引输出大于 1 MiB 的实例不会被判成「离线 exit null」', async (t) => {
  const { instances, bigBin } = await makeTwoInstances(t, { big: true });
  // 先确认夹具真的越过了默认 maxBuffer（1 MiB）——否则这条测试会「恒定通过」而什么都测不到
  const raw = await exec(bigBin, [], { maxBuffer: 64 * 1024 * 1024, timeout: 30000 });
  assert.ok(raw.stdout.length > 1024 * 1024, `夹具输出必须超过 1 MiB，实际 ${raw.stdout.length} 字节`);

  const data = JSON.parse((await runMerged(instances)).trim().split('\n').pop());
  assert.ok(data.resources.includes('big'), `大索引实例应在线，实际 ${JSON.stringify(data.offline)}`);
  assert.equal(data.sessions.length, 9000);
});

// JSON 模式（无 --html）下 stdout 是给机器消费的：`hwb-index > index.json`。
// 原先失败时什么都不输出、却以 0 退出 —— 下游拿到**空的** index.json 且毫不知情。
test('merged-index: JSON 模式失败时给出结构化错误并非零退出（不再静默空输出）', async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), 'hwb-mrgf-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  let failure = null;
  try {
    await exec(process.execPath, [MERGED_INDEX, '--instances', path.join(base, 'missing.json')], { timeout: 30000 });
  } catch (error) { failure = error; }
  assert.ok(failure, 'instances.json 不存在时必须以非零码退出');
  assert.notEqual(failure.code, 0);
  const out = JSON.parse(failure.stdout.trim().split('\n').pop());
  assert.match(out.error, /ENOENT/, 'stdout 应是结构化的失败文档，而不是空文件');
  assert.deepEqual(out.projects, []);
});

// ── 渲染期的故障隔离 + 远端参数引号 + 单实例采集超时 ──
// 采集期早就做了「一个实例失败不影响别的」，但**渲染期**没有：`card()` 直接用 `s.id.slice(...)`，
// 所以一个数字型 id（或 sessions:[null]）会让整个 renderHtml 抛错 → **整页不写、退出码 1** ——
// 旁边健康实例的卡片也一起消失。实测（修前）：一个坏实例 + 一个健康实例 → 没有 HTML。
async function makeMixedInstances(t) {
  const base = await mkdtemp(path.join(tmpdir(), 'hwb-mi-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const bin = path.join(base, 'bin');
  await mkdir(bin, { recursive: true });
  const write = async (name, body) => {
    const p = path.join(bin, name);
    await writeFile(p, `#!/bin/bash\n${body}\n`);
    await chmod(p, 0o755);
    return p;
  };
  // 坏实例：id 是数字、且 sessions 里混了 null；同时带一个正常的项目会话，验证它仍会渲染
  const bad = await write('node-bad', `printf '%s' '{"instance":"bad","resources":["bad"],`
    + `"projects":[{"key":"pb","path":"/r/pb","sessions":[{"id":777,"cwd":"/r/pb","updatedAt":1}]}],`
    + `"sessions":[null,{"id":777}]}'`);
  // 健康实例：带一个项目，卡片必须被渲染出来
  const good = await write('node-good', `printf '%s' '{"instance":"good","resources":["good"],`
    + `"projects":[{"key":"pg","path":"/r/pg","sessions":[{"id":"session-good-1","cwd":"/r/pg","updatedAt":2}]}],`
    + `"sessions":[{"id":"session-good-1"}]}'`);
  const slow = await write('node-slow', `sleep 5\nprintf '%s' '{"instance":"slow","resources":["slow"],"projects":[],"sessions":[]}'`);
  const instances = path.join(base, 'instances.json');
  await writeFile(instances, JSON.stringify({ instances: [
    { id: 'bad', nodeBin: bad, sessionsRoot: path.join(base, 'r'), cacheRoot: path.join(base, 'c') },
    { id: 'good', nodeBin: good, sessionsRoot: path.join(base, 'r'), cacheRoot: path.join(base, 'c') },
  ] }));
  const slowInstances = path.join(base, 'instances-slow.json');
  await writeFile(slowInstances, JSON.stringify({ instances: [
    { id: 'slow', nodeBin: slow, sessionsRoot: path.join(base, 'r'), cacheRoot: path.join(base, 'c') },
    { id: 'good', nodeBin: good, sessionsRoot: path.join(base, 'r'), cacheRoot: path.join(base, 'c') },
  ] }));
  return { base, instances, slowInstances };
}

test('merged-index: 一个实例的坏条目不再让整页渲染失败（健康实例的卡片要留下）', async (t) => {
  const { base, instances } = await makeMixedInstances(t);
  const out = path.join(base, 'out.html');
  const { stdout } = await exec(process.execPath, [MERGED_INDEX, '--instances', instances, '--html', out],
    { timeout: 30000 });
  assert.match(stdout, /good/, '健康实例应出现在这一轮的统计里');
  const html = await readFile(out, 'utf8');
  // 页面对 id 做 slice(0,13) 截断显示（"session-good-1" → "session-good-"），断言按截断后的形态
  assert.match(html, /session-good-/, '健康实例的会话卡片必须被渲染出来');
  assert.match(html, /777/, '坏实例里那条 id 是数字的会话应被规范成字符串后正常渲染');
});

test('merged-index: 单个实例卡住时按超时隔离，其余实例照常出图', async (t) => {
  const { base, slowInstances } = await makeMixedInstances(t);
  const out = path.join(base, 'out-slow.html');
  const started = Date.now();
  const { stdout } = await exec(process.execPath, [MERGED_INDEX, '--instances', slowInstances,
    '--html', out, '--collect-timeout-ms', '800'], { timeout: 30000 });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 4000, `应在超时后立刻继续（sleep 5 的实例不该拖满 5s），实际 ${elapsed}ms`);
  assert.match(stdout, /离线: slow/, '慢实例应被标成离线并给出原因');
  const html = await readFile(out, 'utf8');
  assert.match(html, /session-good-/, '健康实例仍要出图');
});

// `ssh host cmd a b` 会被**远端 shell 重新按空白分段**：路径里有空格就会被拆开（实例静默变离线），
// 值里有 `;`/`$()` 就会在远端执行。dsh-remote-web.sh 早就用 printf '%q' 处理了同一件事。
// 这里用 PATH 前置一个假 ssh，把「远端命令」原样记录下来。
test('merged-index: 远端参数必须过 shell 引号（空格不拆、元字符不执行）', async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), 'hwb-sshq-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const bin = path.join(base, 'bin');
  await mkdir(bin, { recursive: true });
  const log = path.join(base, 'ssh.log');
  const fakeSsh = path.join(bin, 'ssh');
  // 记录收到的参数（每行一个），然后输出一份合法索引 JSON
  await writeFile(fakeSsh, `#!/bin/bash\nprintf '%s\\n' "$@" >> ${JSON.stringify(log)}\n`
    + `printf '%s' '{"instance":"r1","resources":["r1"],"projects":[],"sessions":[]}'\n`);
  await chmod(fakeSsh, 0o755);
  const instances = path.join(base, 'instances.json');
  const nastyRoot = '/tmp/x/My Sessions/.dsh/sessions; touch /tmp/hwb-should-not-exist;';
  await writeFile(instances, JSON.stringify({ instances: [
    { id: 'r1', host: 'fake@host', sessionsRoot: nastyRoot, cacheRoot: '/tmp/x/c' },
  ] }));
  await exec(process.execPath, [MERGED_INDEX, '--instances', instances], {
    timeout: 30000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  const argv = (await readFile(log, 'utf8')).split('\n').filter(Boolean);
  const joined = argv.join(' ');
  // 空格必须落在引号里（`'...My Sessions/.dsh/sessions; touch ...;'`）
  assert.match(joined, /'[^']*My Sessions\/\.dsh\/sessions; touch \/tmp\/hwb-should-not-exist;'/,
    `含空格与 ; 的路径必须整体被引号包住，实际远端命令：${joined.slice(0, 200)}`);
  assert.ok(argv.includes('-o') && argv.includes('BatchMode=yes'), '应带 BatchMode（避免交互式挂起）');
});
