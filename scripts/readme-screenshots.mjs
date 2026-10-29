#!/usr/bin/env node
// Render the real web frontend with synthetic API fixtures. Never opens a user home,
// launches a harness, or uses the running hwb service. Requires Chrome and Node 22+.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = path.join(root, 'src/web');
const output = path.join(root, 'images/screenshots');
const chromePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const now = Date.now();
const ago = (minutes) => new Date(now - minutes * 60_000).toISOString();
const homes = [
  { homeId: 'demo-dsh-local', harness: 'dsh', alias: 'DSH · 本机', hostType: 'local', homePath: '/demo/dsh-local', localPort: 4510, liveIntervention: true },
  { homeId: 'demo-dsh-remote', harness: 'dsh', alias: 'DSH · 远程开发', hostType: 'remote', host: 'devbox.example', serverId: 'demo-devbox', homePath: '/demo/dsh-remote', remotePort: 4510, liveIntervention: true },
  { homeId: 'demo-codex', harness: 'codex', alias: 'Codex', hostType: 'local', homePath: '/demo/codex', liveIntervention: null },
  { homeId: 'demo-workbuddy', harness: 'workbuddy', alias: 'WorkBuddy', hostType: 'local', homePath: '/demo/workbuddy', liveIntervention: null },
].map((home) => ({
  ...home, degraded: [], lastIndexedAt: ago(1),
  runtime: { runtime: 'running', checkedAt: ago(0), latencyMs: home.hostType === 'remote' ? 86 : 4,
    toolLabel: { dsh: 'dsh', codex: 'Codex', workbuddy: 'WorkBuddy' }[home.harness],
    toolVersion: { dsh: '0.2.0-rc.2', codex: '0.153.4', workbuddy: '5.8.3' }[home.harness] },
}));
let sessionNumber = 0;
const session = (_id, home, project, title, kind, minutes, extra = {}) => ({
  homeId: homes[home].homeId, sessionId: `00000000-0000-4000-8000-${String(++sessionNumber).padStart(12, '0')}`, workspaceId: `demo-${project}`,
  workspaceTitle: project, project, title, lastActivity: ago(minutes), unread: false,
  tokenUsage: null, contextPressure: home < 2 ? { contextWindow: 128000, pressureTokens: 34560 } : null,
  status: { kind, label: { running: '运行中', idle: '空闲', completed: '已完成' }[kind], subagents: 0 },
  ...extra,
});
const interaction = (kind, label, minutes, reason, tool = null) => ({
  kind, label, source: kind === 'question' ? 'projection' : 'live', since: ago(minutes), reason, tool, count: 1,
});
const sessions = [
  session('approval', 0, 'Atlas Web', '确认部署命令并发布预览', 'idle', 2, {
    intervention: interaction('approval', '等待审批', 2, '发布演示预览前需要批准', 'Shell'),
  }),
  session('plan', 1, 'Search API', '确认检索索引的迁移计划', 'idle', 5, {
    intervention: interaction('plan-review', '计划待审', 5, '请确认索引迁移与回滚步骤'),
  }),
  session('question', 0, 'Docs Portal', '等待确认文档导航结构', 'idle', 8, {
    intervention: interaction('question', '等待回答', 8, '文档按功能还是按使用场景组织？'),
  }),
  session('parallel', 1, 'Search API', '并行检查索引、API 与缓存', 'running', 1, {
    status: { kind: 'running', label: '运行中', subagents: 3, subagentsRunning: 2 },
    contextPressure: { contextWindow: 128000, pressureTokens: 58880 },
  }),
  session('codex', 2, 'Atlas Web', '整理搜索交互并补充回归用例', 'running', 3),
  session('unread', 3, 'Release Toolkit', '汇总发布说明并核对升级步骤', 'idle', 12, { unread: true }),
  session('done', 0, 'Docs Portal', '修复文档侧栏并完成测试', 'completed', 23),
  session('layout', 0, 'Atlas Web', '统一主题切换与卡片布局', 'idle', 42),
  session('sandbox', 3, 'Sandbox Lab', '整理演示工作区与示例配置', 'idle', 95),
  session('history', 2, 'Atlas Web', '历史：统一键盘导航', 'idle', 20 * 24 * 60),
  session('auto', 0, 'relic-distill-cwd', 'Distill durable knowledge from the demo', 'completed', 4),
  session('child-a', 1, 'Search API', '检查索引一致性', 'running', 1, { status: { kind: 'running', label: '运行中', isSubagent: true } }),
  session('child-b', 1, 'Search API', '检查 API 缓存', 'running', 1, { status: { kind: 'running', label: '运行中', isSubagent: true } }),
];
const projects = [...new Set(sessions.map((s) => s.project))].map((name) => {
  const rows = sessions.filter((s) => s.project === name);
  const latest = [...rows].sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))[0];
  return { project: name, homeId: latest.homeId, homeIds: [...new Set(rows.map((s) => s.homeId))],
    workspaceId: latest.workspaceId, sessionId: latest.sessionId, lastActivity: latest.lastActivity, sessionCount: rows.length };
});
for (const home of homes) {
  home.sessionCount = sessions.filter((s) => s.homeId === home.homeId).length;
  home.workspaceCount = projects.filter((p) => p.homeIds.includes(home.homeId)).length;
}
function usage(params) {
  const hours = Number(params.get('hours') || 24);
  const days = Number(params.get('days') || 1);
  const stepMs = hours * 3_600_000 / 48;
  const buckets = Array.from({ length: 48 }, (_, i) => {
    const a = Math.round((2 + Math.sin(i * 0.47)) * (i % 7 === 0 ? 1500 : 3400));
    const b = Math.round((1.2 + Math.cos(i * 0.31)) * 2300);
    return { ts: new Date(now - (47 - i) * stepMs).toISOString(), groups: { 'Atlas Web': a, 'Search API': b }, total: a + b };
  });
  const project = { hours, stepMs, buckets };
  const total = { ...project, buckets: buckets.map((b) => ({ ...b, groups: { '合计': b.total } })) };
  return { summary: { days, sessionCount: 12, totalTokens: 628400, inputTokens: 196000,
    outputTokens: 81400, cacheRead: 312000, cacheWrite: 39000, cacheHitRate: 312000 / 547000 },
  byProject: [], trendBy: { total, project, instance: total, provider: total, model: total } };
}
const connections = new Set();
const unexpected = [];
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write(': synthetic screenshot fixture\n\n');
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    let data;
    if (url.pathname === '/api/homes') data = { homes };
    else if (url.pathname === '/api/projects/recent') data = { projects, truncated: false };
    else if (url.pathname === '/api/sessions/recent') data = {
      sessions: sessions.filter((s) => !url.searchParams.get('project') || s.project === url.searchParams.get('project')), truncated: false,
    };
    else if (url.pathname === '/api/search') {
      const q = (url.searchParams.get('q') || '').toLowerCase();
      const project = url.searchParams.get('project');
      data = { projects: projects.filter((p) => p.project.toLowerCase().includes(q)),
        sessions: sessions.filter((s) => (!project || s.project === project) && `${s.project} ${s.title}`.toLowerCase().includes(q)),
        truncated: { projects: false, sessions: false } };
    } else if (url.pathname === '/api/usage') data = usage(url.searchParams);
    else if (url.pathname === '/api/logs') data = { logs: [] };
    else if (url.pathname === '/api/theme') data = { preference: 'light', results: [] };
    else { unexpected.push(req.url); res.writeHead(404); res.end('{}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data));
    return;
  }
  try {
    const file = path.resolve(webRoot, `.${url.pathname === '/' ? '/index.html' : url.pathname}`);
    if (!file.startsWith(webRoot + path.sep)) throw new Error('outside web root');
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end('not found'); }
});
server.on('connection', (socket) => { connections.add(socket); socket.on('close', () => connections.delete(socket)); });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(path.join(tmpdir(), 'hwb-readme-chrome-'));
let chrome;
let ws;
try {
  chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--disable-extensions', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
  { stdio: ['ignore', 'ignore', 'pipe'] });
  const browserWs = await new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(new Error('Chrome startup timed out')), 20_000);
    chrome.stderr.on('data', (chunk) => { stderr += chunk; const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); } });
    chrome.once('error', (error) => { clearTimeout(timer); reject(error); });
    chrome.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Chrome exited: ${code}`)); });
  });
  const targets = await (await fetch(`http://${new URL(browserWs).host}/json/list`)).json();
  ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.addEventListener('message', ({ data }) => {
    const msg = JSON.parse(data);
    if (pending.has(msg.id)) {
      const task = pending.get(msg.id); pending.delete(msg.id); clearTimeout(task.timer);
      if (msg.error) task.reject(new Error(msg.error.message)); else task.resolve(msg.result);
    } else if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.text);
    else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push(msg.params.args.map((a) => a.value || a.description).join(' '));
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const key = ++id;
    const timer = setTimeout(() => { pending.delete(key); reject(new Error(`CDP timeout: ${method}`)); }, 15_000);
    pending.set(key, { resolve, reject, timer }); ws.send(JSON.stringify({ id: key, method, params }));
  });
  const evaluate = async (body) => {
    const result = await send('Runtime.evaluate', { expression: `(async()=>{${body}})()`, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  };
  const ready = (condition) => evaluate(`for(let i=0;i<100;i++){if(${condition})return true;await new Promise(r=>setTimeout(r,50));}throw new Error('UI did not reach expected state: '+JSON.stringify({titles:[...document.querySelectorAll('.session-card .name')].map(e=>e.textContent),searchHidden:document.getElementById('search-results').hidden,period:document.querySelector('#usage-period-toggle .active')?.outerHTML,theme:document.documentElement.dataset.theme,note:document.getElementById('note').textContent}));`);
  const click = (selector) => evaluate(`const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw new Error('Missing control');el.click();`);
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1.5, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: "localStorage.setItem('hwb:theme','light');localStorage.setItem('hwb:theme-sync','0');" });
  await send('Page.navigate', { url: origin });
  await ready("document.querySelectorAll('.session-card').length >= 8 && document.getElementById('live').classList.contains('on')");
  await evaluate('await document.fonts.ready;');
  await mkdir(output, { recursive: true });
  const captures = [];
  const capture = async (name, selector = null, maxHeight = null, keepFocus = false) => {
    await evaluate(`${keepFocus ? '' : 'document.activeElement?.blur();'}await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));`);
    const params = { format: 'png', captureBeyondViewport: true,
      clip: await evaluate(`return {x:0,y:0,width:innerWidth,height:Math.min(innerHeight,${maxHeight || 2000}),scale:1};`) };
    if (selector) {
      params.clip = await evaluate(`const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:Math.min(r.height,${maxHeight || 2000}),scale:1};`);
    }
    const { data } = await send('Page.captureScreenshot', params);
    await writeFile(path.join(output, name), Buffer.from(data, 'base64'));
    captures.push({ name, clip: params.clip || 'viewport' });
  };
  await capture('overview.png');
  await click('[data-status-filter="intervention"]');
  await ready("document.querySelectorAll('.session-card').length === 3");
  await capture('interventions.png', '.pane-sessions', 540);
  await click('[data-status-filter="all"]');
  await click('.project-card[data-project="Atlas Web"]');
  await ready("document.querySelectorAll('.session-card').length === 4");
  await evaluate("const input=document.getElementById('search');input.focus();input.value='Atlas';input.dispatchEvent(new Event('input',{bubbles:true}));");
  await ready("document.querySelector('[data-action=\"scope-search\"]')");
  await click('[data-action="scope-search"]');
  await ready("document.querySelectorAll('.session-card').length === 4 && document.getElementById('search-scope').textContent.includes('Atlas Web')");
  await evaluate('await new Promise(r=>setTimeout(r,350));');
  await capture('project-search.png', null, 650, true);
  await click('[data-action="clear-search"]');
  await click('[data-action="clear-project-filter"]');
  await click('#theme-btn'); await click('[data-mode="dark"]');
  // Theme changes trigger an asynchronous dashboard repaint; let it finish before
  // changing the usage period so a stale repaint cannot replace the new card.
  await evaluate('await new Promise(r=>setTimeout(r,200));');
  await click('[data-action="usage-period"][data-period="7d"]');
  await ready("document.querySelector('.usage-big .cap')?.textContent.includes('7天')");
  await click('[data-action="usage-dim"][data-dim="project"]');
  await evaluate("document.querySelector('section.usage').scrollIntoView({block:'center'});await new Promise(r=>setTimeout(r,100));");
  await capture('usage-dark.png', 'section.usage');
  if (errors.length || unexpected.length) throw new Error(JSON.stringify({ errors, unexpected }));
  console.log(JSON.stringify({ frontend: 'src/web (unmodified)', data: 'synthetic only', captures, consoleErrors: errors, unexpectedApiRequests: unexpected }, null, 2));
} finally {
  ws?.close();
  chrome?.kill('SIGKILL');
  for (const socket of connections) socket.destroy();
  server.close();
  await rm(profile, { recursive: true, force: true });
}
