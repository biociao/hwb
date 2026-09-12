import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeUpload } from '../src/lib/file-preview.js';

// 远端上传的临时目录处理。tmp 目录名来自**远端 stdout**，会被拼进后续远端命令
// （包括收尾的 `rm -rf`）；而分片阶段失败时原先没有任何人清理，重试一次就在远端留一份残留
// （TMPDIR 不可用时 mktemp 的兜底还会把它建到用户家目录里）。

const remote = { hostType: 'remote', host: 'fixture' };

// 记录所有远端命令；按需让第 N 次调用失败。
function recordingExec({ failOn = () => false, dirStdout = '/tmp/hwb-upload-abc123\n' } = {}) {
  const commands = [];
  const exec = async (_host, script, args = []) => {
    commands.push({ script, args });
    const n = commands.length;
    if (script.includes('mktemp')) return { code: 0, stdout: dirStdout, stderr: '' };
    if (failOn({ n, script })) return { code: 1, stdout: '', stderr: 'boom' };
    // 合并阶段的输出被 JSON.parse(lastLine(stdout)) 消费；其它阶段的 stdout 无人读取，
    // 统一返回成功 JSON 即可。
    return { code: 0, stdout: '{"name":"a.txt","path":"/r/a.txt","size":3,"renamed":false}\n', stderr: '' };
  };
  return { exec, commands };
}

const part = (name, text) => ({ name, chunks: (async function* () { yield Buffer.from(text); })() });

async function fixture(t) {
  const base = await mkdtemp(path.join(tmpdir(), 'hwb-remote-tmp-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'project');
  await (await import('node:fs/promises')).mkdir(root, { recursive: true });
  return root;
}

test('远端临时目录名只取 stdout 最后一行（profile 噪声不得混进目录名）', async (t) => {
  const root = await fixture(t);
  const { exec, commands } = recordingExec({
    dirStdout: 'welcome to the server\n/tmp/hwb-upload-abc123\n',
  });
  await writeUpload(remote, root, '.', [part('a.txt', 'hi')], exec);
  const finish = commands.find((c) => c.script.includes('rm -rf'));
  assert.match(finish.script, /\/tmp\/hwb-upload-abc123/, '目录名必须取自最后一行');
  assert.doesNotMatch(finish.script, /welcome to the server/, 'profile 噪声不得进入命令');
});

test('远端临时目录名含引号时被正确转义，不能逃出 rm -rf 的引号', async (t) => {
  const root = await fixture(t);
  // 恶意/异常的远端 TMPDIR：目录名里带单引号与命令拼接
  const evil = "/tmp/hwb-it's ; touch /tmp/pwned ; '";
  const { exec, commands } = recordingExec({ dirStdout: `${evil}\n` });
  // 字符集校验会先拒绝这种目录名（更加稳妥）
  await assert.rejects(writeUpload(remote, root, '.', [part('a.txt', 'hi')], exec), /无法在远端创建临时目录/);
  assert.equal(commands.some((c) => c.script.includes('touch /tmp/pwned')), false, '绝不能执行注入的命令');
});

test('远端临时目录名只允许安全字符集，异常名字直接拒绝', async (t) => {
  const root = await fixture(t);
  for (const bad of ['relative/dir', '/tmp/ok$(id)', '/tmp/ok`id`', '/tmp/a b', '']) {
    const { exec } = recordingExec({ dirStdout: `${bad}\n` });
    await assert.rejects(writeUpload(remote, root, '.', [part('a.txt', 'hi')], exec), /无法在远端创建临时目录/, JSON.stringify(bad));
  }
});

test('分片阶段失败时会清理远端临时目录（否则每次重试都留残留）', async (t) => {
  const root = await fixture(t);
  const { exec, commands } = recordingExec({
    // 调用顺序：1) mktemp 建临时目录  2) 写分片  3) 合并收尾。
    // 让第 2 次（分片阶段）失败 —— 此时 finish 还没跑过，只有新增的失败清理能兜住。
    failOn: ({ n }) => n === 2,
  });
  await assert.rejects(writeUpload(remote, root, '.', [part('a.txt', 'x'.repeat(1024))], exec));
  const cleanups = commands.filter((c) => c.script.trim().startsWith('rm -rf'));
  assert.ok(cleanups.length >= 1, `应在失败后清理远端临时目录，实际命令：${JSON.stringify(commands.map((c) => c.script.slice(0, 60)))}`);
  // 清理的是具体那次上传的临时条目（tmp 目录下的随机名）
  assert.match(cleanups.at(-1).script, /^rm -rf '\/tmp\/hwb-upload-abc123\/[^']+'$/);
});
