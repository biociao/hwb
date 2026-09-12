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
    // 前缀标点的形态（审查实测原先漏掉）：键名前的字符是 ( , ; { [ : = / # 时不再漏
    ['括号内', '(token=abc123)'],
    ['逗号后', 'a,b,token=abc123'],
    ['分号后', 'x;token=abc123'],
    ['花括号', '{token=abc123}'],
    ['方括号', '[token=abc123]'],
    ['冒号后（非键名）', 'err:token=abc123'],
    ['等号后', 'a=token=abc123'],
    ['路径中', 'path/token=abc123'],
    ['井号后', '#token=abc123'],
    // JSON 引号形态的 Authorization（原先 `[:=]` 之后紧跟引号就匹配不上）
    ['JSON Authorization', '{"Authorization":"Bearer sk-live-abcdef123456"}'],
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

// 裸的凭据**形状**：没有 `token=` 前缀，就一个 sk-… / dcs_pat_… 混在错误消息里。
// 上游 SDK 的报错经常带请求内容（header 值就是 key）—— 我自己验证额度失败日志时，
// 「网络炸了 sk-fake-for-test」这样的消息确实原样进了日志。按形状兜一层。
test('logger: 不带键名的裸凭据（sk-/sk-ant-/ghp_/dcs_pat_）也会被脱敏', async () => {
  const { redactSecrets } = await import('../src/lib/logger.js');
  const cases = [
    ['fetch failed: header sk-fake-for-test rejected', 'sk-fake-for-test'],
    ['key sk-ant-api03-abcdefghijklmnop is invalid', 'sk-ant-api03-abcdefghijklmnop'],
    ['DCS PAT dcs_pat_abcdef123456 expired', 'dcs_pat_abcdef123456'],
    ['token ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
  ];
  for (const [text, secret] of cases) {
    const out = redactSecrets(text);
    assert.doesNotMatch(out, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `仍能看到 ${secret}：${out}`);
    assert.match(out, /已脱敏/);
    assert.equal(redactSecrets(out), out, '必须幂等');
  }
  // 不误伤：只有前缀、后面没东西的普通文本
  assert.equal(redactSecrets('普通文本不该动：sk- 后面什么都没有'), '普通文本不该动：sk- 后面什么都没有');
});

// `logger(scope)` 返回**对象**（.warn/.error/…），不是可调用函数。quota.js 里有两处写成了
// `log('...', {...})`：一处会打断整批额度的异常处理，另一处被 Promise.allSettled 吞掉 ——
// 结果是失败原因永远不进日志。这条结构断言防的是整类错误。
test('结构: 任何从 logger() 取到的日志对象都不得被当成函数调用', async () => {
  const { readFile, readdir } = await import('node:fs/promises');
  const path = await import('node:path');
  const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
  const files = [];
  const walk = async (dir) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name.endsWith('.js')) files.push(full);
    }
  };
  await walk(path.join(root, 'src'));
  const offenders = [];
  for (const file of files) {
    const src = await readFile(file, 'utf8');
    // 找出 `const X = logger('scope')` 这类绑定，再看 X 有没有被当作函数调用
    for (const m of src.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*logger\(/g)) {
      const name = m[1];
      const call = new RegExp(`(^|[^.\\w$])${name}\\s*\\(`, 'm');
      // 允许 `logger(...)` 本身的调用；只找该绑定的裸调用
      const hit = src.split('\n').findIndex((line) => {
        const text = line.trim();
        // 注释行要跳过：quota.js 里正好有一段注释在**说明**这个坏写法（`log('...')`），
        // 不排除掉就会把文档当成违规。
        if (text.startsWith('//') || text.startsWith('*') || text.startsWith('/*')) return false;
        return call.test(line) && !line.includes('= logger(');
      });
      if (hit !== -1) offenders.push(`${path.relative(root, file)}:${hit + 1} 把 ${name} 当函数调用`);
    }
  }
  assert.deepEqual(offenders, [], `logger 返回的是对象，不能直接调用：\n${offenders.join('\n')}`);
});

// 权限收紧原先只覆盖**活文件**：`mkdirSync(..., mode:0o700)` 对已存在的目录无效，
// 而轮转代 `.1/.2` 是**老版本**以 0644 写的（里面同样有 `?token=…`，本文件自己的注释就写了
// 「实测有 44 处 ?token=」）。审查实测：一次轮转后 .1 变 0600，而被它顶到 .2 的那一代仍是 0644。
test('轮转代（.1/.2）与已存在的目录也要收权限（升级路径下 token 不再留在 world-readable 文件里）', async (t) => {
  if (process.platform === 'win32') return t.skip('权限位在 Windows 上没有意义');
  const { mkdtemp, mkdir, writeFile, chmod, stat, readFile, rm } = await import('node:fs/promises');
  const dir = await mkdtemp(path.join(tmpdir(), 'hwb-logperm-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sub = path.join(dir, 'state');
  const file = path.join(sub, 'hwb.log');
  await mkdir(sub, { recursive: true });
  await chmod(sub, 0o755).catch(() => {});
  await writeFile(file, 'x\n', { mode: 0o644 });
  await writeFile(`${file}.1`, 'dsh web: http://127.0.0.1:3080/?token=OLDTOKEN1\n', { mode: 0o644 });
  await writeFile(`${file}.2`, 'x\n', { mode: 0o644 });
  await chmod(file, 0o644).catch(() => {});
  await chmod(`${file}.1`, 0o644).catch(() => {});
  await chmod(`${file}.2`, 0o644).catch(() => {});
  assert.equal((await stat(sub)).mode & 0o777, 0o755, '前置条件：目录是旧版本留下的 0755');
  assert.equal((await stat(`${file}.2`)).mode & 0o777, 0o644, '前置条件：.2 是 world-readable');

  initLogger({ level: 'info', file, color: false });
  logger('sec').info('upgrade path');
  assert.equal((await stat(sub)).mode & 0o777, 0o700, '已存在的状态目录必须被收紧到 0700');
  for (const f of [file, `${file}.1`, `${file}.2`]) {
    assert.equal((await stat(f)).mode & 0o777, 0o600, `${f} 应收紧到 0600`);
  }
  assert.match(await readFile(`${file}.1`, 'utf8'), /OLDTOKEN1/, '内容不受影响（只是权限）');
});

// 目录权限收紧**绝不能碰当前目录及其祖先**：日志路径可以是相对的（`--log hwb.log`、
// `hwb config set log x`），那样 dirname 就是 `.` 或 `..` —— 无条件 chmod 会把用户的工作目录
// （甚至家的上一级）改成 0700，比它想防的「目录可被遍历」严重得多。自查本轮改动时发现的。
test('logger: 日志路径是相对路径时，不许改动当前目录及其祖先的权限', async (t) => {
  if (process.platform === 'win32') return t.skip('权限位在 Windows 上没有意义');
  const { mkdtemp, mkdir, writeFile, chmod, stat, rm } = await import('node:fs/promises');
  const base = await mkdtemp(path.join(tmpdir(), 'hwb-logrel-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const work = path.join(base, 'work');
  await mkdir(work, { recursive: true });
  await chmod(work, 0o755).catch(() => {});
  const saved = process.cwd();
  process.chdir(work);
  t.after(() => process.chdir(saved));
  try {
    // 相对路径：dirname 就是 `.`（即 work 目录本身）
    initLogger({ level: 'info', file: path.join('.', 'rel.log'), color: false });
    logger('sec').info('relative log path');
    assert.equal((await stat(work)).mode & 0o777, 0o755, '当前目录的权限不许被日志模块改动');
    // 文件本身仍应收紧（那是我们要防的凭据泄漏）
    initLogger({ level: 'info', file: path.join('.', 'rel2.log'), color: false });
    logger('sec').info('x');
    assert.equal((await stat(path.join(work, 'rel2.log'))).mode & 0o777, 0o600, '日志文件本身仍要 0600');
  } finally {
    // 还原 cwd 之后再收尾，避免 rm 在已 chdir 的目录里失败
    process.chdir(saved);
  }
});
