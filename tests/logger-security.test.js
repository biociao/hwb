import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initLogger, logger, redactSecrets, getLogs } from '../src/lib/logger.js';

// 日志里绝不能出现 dsh 的启动 token，日志文件也不能是 world-readable。
//
// 背景（实测于本机）：`~/.hwb/hwb.log` 是 0644、所在目录 0755，而日志里有 44 处
// `http://127.0.0.1:<port>/?token=<launchToken>` —— monitor/launcher 会把带 token 的 URL
// 直接写进日志字段。持有该 token 等于持有那个 dsh 实例的完整控制权（工具能执行 shell、写文件），
// 同机任何用户读到日志就能拿到。

test('redactSecrets: 各种形态的 token 都被脱敏', () => {
  const cases = [
    ['http://127.0.0.1:3080/?token=SEKRET123', 'http://127.0.0.1:3080/?token=[已脱敏]'],
    ['http://127.0.0.1:3080/?token=abc&x=1', 'http://127.0.0.1:3080/?token=[已脱敏]&x=1'],
    ['"token": "SEKRET"', '"token": "[已脱敏]"'],
    ['token=SEKRET', 'token=[已脱敏]'],
    ['x=1&token=SEKRET', 'x=1&token=[已脱敏]'],
  ];
  for (const [input, expected] of cases) assert.equal(redactSecrets(input), expected, input);
});

test('redactSecrets: 不误伤普通文本', () => {
  for (const s of ['no secrets here', 'tokens=2 表示两个 token 数量', '/home/u/.dsh', '']) {
    assert.equal(redactSecrets(s), s, s);
  }
});

test('日志内容：token 不落盘、不进环缓冲、也不进 console', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hwb-logsec-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'nested', 'hwb.log');
  initLogger({ level: 'debug', file, color: false, rotateBytes: 1024 * 1024 });
  // console 输出没有注入口，直接替换 console 方法抓取（用完必须还原）。
  const printed = [];
  const orig = { log: console.log, error: console.error };
  console.log = (l) => printed.push(l);
  console.error = (l) => printed.push(l);
  t.after(() => { console.log = orig.log; console.error = orig.error; });

  const log = logger('sec');
  log.info('实例恢复可用', { url: 'http://127.0.0.1:3080/?token=SUPERSECRETTOKEN', homeId: 'h' });
  log.warn('直连本机 dsh web 不可达', new Error('connect failed to http://127.0.0.1:9/?token=ERRTOKEN'), { homeId: 'h' });

  const body = await readFile(file, 'utf8');
  assert.doesNotMatch(body, /SUPERSECRETTOKEN/);
  assert.doesNotMatch(body, /ERRTOKEN/);
  assert.match(body, /\[已脱敏\]/);
  assert.doesNotMatch(printed.join('\n'), /SUPERSECRETTOKEN|ERRTOKEN/);

  assert.doesNotMatch(JSON.stringify(getLogs({ limit: 50 })), /SUPERSECRETTOKEN|ERRTOKEN/);
});

test('日志目录 0700、日志文件 0600（原先分别是 0755 / 0644）', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hwb-logperm-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state', 'hwb.log');
  initLogger({ level: 'info', file, color: false });
  logger('sec').info('perm check');

  const mode = async (p) => (await stat(p)).mode & 0o777;
  assert.equal(await mode(path.dirname(file)), 0o700, '状态目录应是 0700');
  assert.equal(await mode(file), 0o600, '日志文件应是 0600');
});

test('已存在的 0644 日志文件会被纠正为 0600（升级路径）', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hwb-logfix-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'hwb.log');
  await mkdir(dir, { recursive: true });
  // 模拟升级前留下的 world-readable 文件
  await import('node:fs/promises').then((fs) => fs.writeFile(file, 'old\n', { mode: 0o644 }));
  await chmod(file, 0o644).catch(() => {});
  assert.equal((await stat(file)).mode & 0o777, 0o644, '前置条件');

  initLogger({ level: 'info', file, color: false });
  logger('sec').info('after upgrade');
  assert.equal((await stat(file)).mode & 0o777, 0o600, '打开时应把已有文件收紧到 0600');
  assert.match(await readFile(file, 'utf8'), /after upgrade/);
});

test('logger 单例被前一个用例初始化过时，仍能重新指向新文件（不互相污染）', () => {
  // 这些用例共享模块级单例；这里只断言不会因为重复 initLogger 抛错。
  assert.doesNotThrow(() => initLogger({ level: 'error', file: false, color: false, silent: true }));
  assert.doesNotThrow(() => logger('sec').info('noop'));
});

// 一次**瞬时**的打开失败不该让文件日志永久静默。
// 原先 openFile() 只在 initLogger 与 rotate() 里被调用，而 rotate() 又只在 writeFileLine()
// 里可达 —— 后者在 fileFd === null 时直接 return。于是失败一次之后，整个进程生命周期里
// 日志再也不落盘，只留 console 上一行提示；而 help 文案恰恰叫用户去看那个文件。
test('文件打开失败后会按节流重试，故障恢复即恢复写入', async (t) => {
  const { mkdir, writeFile, rmdir } = await import('node:fs/promises');
  const base = await mkdtemp(path.join(tmpdir(), 'hwb-open-retry-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const blocker = path.join(base, 'blocker');
  await writeFile(blocker, 'x'); // 父路径是个文件 → mkdir/open 必然失败
  const target = path.join(blocker, 'hwb.log');

  initLogger({ level: 'info', file: target, color: false, openRetryMs: 5 });
  logger('retry').info('第一次（预期失败）');
  await assert.rejects(stat(target), '前置条件：此时日志文件不该存在');

  // 故障恢复：把挡路的文件换成目录
  await rm(blocker, { force: true });
  await mkdir(blocker, { recursive: true });
  await new Promise((r) => setTimeout(r, 20)); // 越过节流窗口

  logger('retry').info('恢复之后');
  const body = await readFile(target, 'utf8');
  assert.match(body, /恢复之后/, '文件日志必须在故障恢复后自己续上，而不是永久静默');
});

// 脱敏原先的值字符集是 `[A-Za-z0-9_-]`，只吃前缀：`token=abc+DEF/ghi==` 会脱敏成
// `token=[已脱敏]+DEF/ghi==`（**值的一半还留在日志里**）。键名也只认 token，
// `Authorization: Bearer …` / `api_key=…` / `DCS_PAT=…` / `token: …` 一律漏。
// 真实 dsh token 是 base64url（今天的形态本来就覆盖），所以这是**加固**；但这里已经是唯一收口。
test('logger: 脱敏覆盖更多键名与值形态，且幂等、不误伤散文', async () => {
  const { redactSecrets } = await import('../src/lib/logger.js');
  const leaks = [
    ['launch url', 'http://127.0.0.1:3080/?token=abc123'],
    ['加号/斜杠/等号', 'token=abc+DEF/ghi=='],
    ['冒号形态', 'token: abc123def'],
    ['命令行 flag', '--token abc123def'],
    ['Authorization Bearer', 'Authorization: Bearer sk-live-abcdef123456'],
    ['裸 Bearer', 'Bearer sk-live-abcdef123456'],
    ['api_key', 'api_key=sk-live-123456'],
    ['DCS_PAT', 'DCS_PAT=dcs_pat_abcdef'],
    ['JSON 形态', '"token": "json-shaped-value"'],
    ['password', 'password=hunter2'],
    ['cookie', 'dsh_token=abcdef123456;'],
  ];
  for (const [label, text] of leaks) {
    const out = redactSecrets(text);
    assert.doesNotMatch(out, /(sk-live|abc123|hunter2|dcs_pat|json-shaped|abcdef123456)/, `${label} 仍有明文：${out}`);
    assert.match(out, /已脱敏/, `${label} 应出现脱敏标记`);
    // 幂等：同一行会在 console、文件、环缓冲三条路上各过一次
    assert.equal(redactSecrets(out), out, `${label} 的脱敏结果必须幂等（否则标记会被二次吃掉）`);
  }
  // 不误伤：散文里的 token/bearer 只是普通词
  assert.equal(redactSecrets('这段文本里 token 只是一个词，没有分隔符'), '这段文本里 token 只是一个词，没有分隔符');
  assert.equal(redactSecrets('the bearer of bad news arrived'), 'the bearer of bad news arrived');
  assert.equal(redactSecrets('indexed 5 sessions in 12ms'), 'indexed 5 sessions in 12ms');
});

// `slice(-Math.max(0, limit))`：limit=0 时算的是 `slice(-0)`，而 `-0 === 0` → `slice(0)` → 返回整个环。
test('logger: getLogs({limit:0}) 返回空，而不是把整个环缓冲倒出来', async () => {
  const { initLogger, logger: log, getLogs, clearLogs } = await import('../src/lib/logger.js');
  initLogger({ level: 'info', file: false, silent: true });
  clearLogs();
  const l = log('t');
  for (let i = 0; i < 5; i++) l.info(`条目 ${i}`);
  assert.equal(getLogs({ limit: 3 }).length, 3);
  assert.equal(getLogs({ limit: 0 }).length, 0, 'limit=0 必须是空数组');
  assert.equal(getLogs({ limit: -5 }).length, 0, '负数同样为空');
  assert.equal(getLogs({ limit: Number.NaN }).length, 0, 'NaN 也要安全');
});
