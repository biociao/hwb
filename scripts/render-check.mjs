#!/usr/bin/env node
// 真浏览器的渲染检查（headless Chrome + CDP）。
//
// 为什么需要它：这个项目的前端是「拼 HTML 字符串 + innerHTML」，很多缺陷（坐标轴错位、
// 空状态少按钮、标签压字、贴边裁切）**只在真实布局里**才存在 —— 单元测试拿不到字体度量与
// 容器宽度，静态审查也只能靠猜。审查里几次最有价值的发现都来自真浏览器。
//
// 为什么不用 `--dump-dom`：`--dump-dom` 要等页面网络空闲，而 hwb 的前端有一条常驻 SSE
// （`/api/events`），于是它永远不 dump（实测 30s 超时、0 字节）。CDP 可以自己决定何时取值。
//
// 用法：
//   node scripts/render-check.mjs --url http://127.0.0.1:4310/ --wait-ms 3000 --expr-file /tmp/check.js
//   node scripts/render-check.mjs --url http://127.0.0.1:4310/ --expr 'return document.title'
// 表达式在页面里以 async 函数体执行，`return` 的值会被 JSON 序列化后打印。
// 输出：{ ok, result, consoleErrors, exceptions }
// 退出码：0 = 表达式执行成功且无未捕获异常/console.error；1 = 有异常或 console.error；2 = 启动/连接失败。
//
// 环境变量 CHROME_PATH 可覆盖 Chrome 可执行文件路径。

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const url = arg('url');
if (!url) {
  console.error('用法: node scripts/render-check.mjs --url <URL> [--wait-ms 3000] [--expr-file <文件> | --expr <代码>]');
  process.exit(2);
}
const waitMs = Number(arg('wait-ms', 3000));
const exprFile = arg('expr-file');
const expression = exprFile ? await readFile(exprFile, 'utf8') : arg('expr', 'return document.title');
const chromePath = process.env.CHROME_PATH || DEFAULT_CHROME;

const userDataDir = await mkdtemp(path.join(tmpdir(), 'hwb-render-'));
const chrome = spawn(chromePath, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--disable-extensions',
  '--remote-debugging-port=0', `--user-data-dir=${userDataDir}`, 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });

// Chrome 把实际端口打在 stderr 上：`DevTools listening on ws://127.0.0.1:<port>/devtools/browser/<id>`
const wsUrl = await new Promise((resolve, reject) => {
  let buf = '';
  const timer = setTimeout(() => reject(new Error('启动 Chrome 超时（没有等到 DevTools 监听）')), 20_000);
  chrome.stderr.on('data', (d) => {
    buf += d;
    const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) { clearTimeout(timer); resolve(m[1]); }
  });
  chrome.on('exit', (code) => reject(new Error(`Chrome 退出（code ${code}）`)));
}).catch((e) => { console.error(e.message); chrome.kill('SIGKILL'); process.exit(2); });

const base = new URL(wsUrl);
const listUrl = `http://${base.host}/json/list`;
const pageWs = await (async () => {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(listUrl)).json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('没有找到可用的 page target');
})();

const ws = new WebSocket(pageWs);
let nextId = 0;
const pending = new Map();
const consoleErrors = [];
const exceptions = [];
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
    return;
  }
  if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'assert'].includes(msg.params.type)) {
    consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    exceptions.push(d.exception?.description || d.text);
  }
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve);
  ws.addEventListener('error', () => reject(new Error('连接 DevTools WebSocket 失败')));
});

let exitCode = 0;
try {
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url });
  await new Promise((r) => setTimeout(r, waitMs));
  const { result, exceptionDetails } = await send('Runtime.evaluate', {
    expression: `(async () => { ${expression} })()`,
    awaitPromise: true, returnByValue: true,
  });
  const out = {
    ok: !exceptionDetails && !exceptions.length && !consoleErrors.length,
    result: result?.value ?? null,
    consoleErrors,
    exceptions,
  };
  if (exceptionDetails) out.exceptions.push(exceptionDetails.exception?.description || exceptionDetails.text);
  out.ok = !out.exceptions.length && !out.consoleErrors.length;
  console.log(JSON.stringify(out, null, 1));
  exitCode = out.ok ? 0 : 1;
} catch (e) {
  console.error(`渲染检查失败: ${e.message}`);
  exitCode = 2;
} finally {
  try { ws.close(); } catch { /* 已关闭 */ }
  chrome.kill('SIGKILL');
  await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
}
process.exit(exitCode);
