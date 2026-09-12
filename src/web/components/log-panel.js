import { api, esc } from '../store.js';

// —— 运行日志面板 ——
// 展示后端结构化日志（src/lib/logger.js）：分级着色、按级别过滤、实时跟随、可展开堆栈。
// 数据源：初始拉 /api/logs（环缓冲快照）+ SSE `log:event` 实时追加。
// 日志条目形如 { ts, level, scope, message, fields?, error?, stack? }。

const MAX_VIEW = 500;
const RANK = { trace: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5 };

let entries = [];    // 全量条目（模块态；dashboard 重建后据此重绘，不丢）
let filter = 'all';  // 'all' | 'debug' | 'info' | 'warn' | 'error'
let follow = true;   // 自动滚动到底部
let loaded = false;  // 是否已成功拉取过首屏快照
let loadPromise = null; // 正在进行中的首屏拉取（合并并发调用）
let retryAfter = 0;  // 失败后的重试冷却截止时间（避免持续 5xx 时被 SSE 事件打成请求风暴）
const RETRY_COOLDOWN_MS = 10_000;
const seen = new Set(); // 去重键（初始快照与实时事件重叠窗口）

// 去重键必须包含 scope 与 fields：同一毫秒里两条「相同 ts/level/message」但不同上下文的日志
// 是真实存在的（索引器对多个实例并发失败 → 同一句「索引该 home 失败」+ 不同 homeId），
// 只用 ts|level|message 会把后一条**丢掉**，用户看到的失败实例少一个。
// 导出是为了能直接测（这个模块的其余部分是 DOM 渲染）。
export const logEntryKey = (e) => [
  e.ts, e.level, e.scope ?? '', e.message,
  e.fields === undefined ? '' : JSON.stringify(e.fields),
].join('|');

const key = logEntryKey;

// 过滤语义：filter 视为「最低级别」（error=错误及以上 warn/error/fatal）。
function passes(e) {
  if (filter === 'all') return true;
  return (RANK[e.level] ?? 2) >= (RANK[filter] ?? 2);
}

// 首屏快照拉取。**失败不算「加载过」**：原先无论成败都置 `loaded = true`，而 app.js 只调用
// 一次 logInit() —— 于是页面加载时那一次请求只要失败（后端正在重启、瞬时 500），日志面板就永远停在
// 「暂无日志」，之后 SSE 的 log:event 只会往里追加新行，没有任何机制补上历史快照。
// 独立审查复现：让 fetch 返回 500 并连调两次 logInit()，全程只有 1 次请求。
// 现在失败不置位（并允许重试），并发调用合并成同一个 Promise。
// `auto: true` 是「SSE 收到日志后顺手补拉」那一类调用，受 RETRY_COOLDOWN_MS 限流
// （后端持续 5xx 时不会被日志流打成请求风暴）；显式调用（页面加载、用户操作）不受限。
export async function logInit({ auto = false } = {}) {
  if (loaded) return;
  if (auto && Date.now() < retryAfter) return;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const { logs } = await api(`/api/logs?limit=${MAX_VIEW}`);
      // 合并而不是覆盖：拉取期间 SSE 可能已经追加了新行，覆盖会把它们丢掉。
      const incoming = Array.isArray(logs) ? logs : [];
      const fresh = incoming.filter((e) => !seen.has(key(e)));
      for (const e of fresh) seen.add(key(e));
      entries = [...fresh, ...entries].slice(-MAX_VIEW);
      loaded = true;
    } catch {
      // 后端不可用：保持 loaded=false（下次还能重试），并设一个冷却，避免持续 5xx 时
      // 每个 SSE 日志事件都打一次请求。
      retryAfter = Date.now() + RETRY_COOLDOWN_MS;
    }
    logRefresh();
  })().finally(() => { loadPromise = null; });
  return loadPromise;
}

export function appendLog(entry) {
  const k = key(entry);
  if (seen.has(k)) return; // 与首屏快照重叠，去重
  seen.add(k);
  entries.push(entry);
  if (entries.length > MAX_VIEW) {
    // entries 截断后必须同步重建 seen：否则去重键只增不减（长开页面 / -v 级别日志下
    // 是无上限的字符串集合），而 entries 本身是有上限的。重建后 seen.size ≤ MAX_VIEW。
    // 被丢弃的旧键不会「复活」——服务端环缓冲只在尾部追加，不会重发这些历史条目。
    entries = entries.slice(-MAX_VIEW);
    seen.clear();
    for (const e of entries) seen.add(key(e));
  }
  // 每收到一条实时日志就说明后端是活的：如果首屏快照还没成功拉到，顺手补一次
  // （logInit 内部有 loaded/冷却/并发合并三重闸门，这里不会被 SSE 的频率放大成请求风暴）。
  if (!loaded) logInit({ auto: true }).catch(() => {});
  logRenderEntries();
}

export function setLogFilter(level) { filter = level || 'all'; logRenderEntries(); }
export function toggleLogFollow() { follow = !follow; logRenderEntries(); }
export function clearLogView() { entries = []; seen.clear(); logRenderEntries(); }

// —— 渲染 ——
export function logPanelHtml() {
  const fbtn = (lvl, label) =>
    `<button class="log-fbtn ${filter === lvl ? 'active' : ''}" data-action="log-filter" data-level="${lvl}">${label}</button>`;
  const followBtn = `<button class="log-fbtn ${follow ? 'active' : ''}" data-action="log-follow" title="自动滚动到底部">跟随</button>`;
  return `
    <section class="logs"><h2>运行日志
      <span class="log-live" title="实时推送"><i></i>实时</span>
      <span class="log-tools">${fbtn('all', '全部')}${fbtn('error', '错误')}${fbtn('warn', '警告')}${fbtn('info', '信息')}${fbtn('debug', '调试')}${followBtn}<button class="log-fbtn" data-action="log-clear">清空</button></span>
    </h2>
    <div class="log-body" id="log-entries">${logRowsHtml()}</div>
  </section>`;
}

export function logRefresh() {
  logRenderEntries();
}

function logRenderEntries() {
  const el = document.getElementById('log-entries');
  if (el) {
    el.innerHTML = logRowsHtml();
    if (follow) el.scrollTop = el.scrollHeight;
  }
  logSyncToolbar();
}

function logRowsHtml() {
  const rows = entries.filter(passes);
  if (!rows.length) {
    const hint = filter === 'all' ? '（可用 -v 开启 debug 级）' : '';
    return `<div class="empty">暂无日志${hint}</div>`;
  }
  return rows.slice(-MAX_VIEW).map(logRow).join('');
}

function logRow(e) {
  const r = RANK[e.level] ?? 2;
  const cls = r >= 4 ? 'error' : r >= 3 ? 'warn' : 'info';
  const fields = fmtFields(e.fields);
  const stack = (e.error || e.stack)
    ? `<pre class="log-stack" hidden>${esc(e.error ? `Error: ${e.error}\n` : '')}${esc(e.stack || '')}</pre>`
    : '';
  return `<div class="log-row ${cls}" data-level="${esc(e.level || 'info')}">
    <span class="log-ts">${esc(e.ts || '')}</span>
    <span class="log-lvl">${esc((e.level || 'info').toUpperCase())}</span>
    <span class="log-scope">${esc(e.scope || '')}</span>
    <span class="log-msg">${esc(e.message || '')}${fields}${stack}</span>
  </div>`;
}

function fmtFields(fields) {
  const keys = Object.keys(fields || {});
  if (!keys.length) return '';
  const parts = keys.map((k) => {
    let v = fields[k];
    if (Array.isArray(v)) v = v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' | ');
    else if (typeof v === 'object' && v !== null) v = JSON.stringify(v);
    return `${k}=${v}`;
  });
  return ` <span class="log-fields">${esc(parts.join(' · '))}</span>`;
}

function logSyncToolbar() {
  document.querySelectorAll('.log-tools .log-fbtn[data-action="log-filter"]')
    .forEach((b) => b.classList.toggle('active', b.dataset.level === filter));
  const fb = document.querySelector('.log-tools .log-fbtn[data-action="log-follow"]');
  if (fb) fb.classList.toggle('active', follow);
}

// 点击某行：展开/收起堆栈（Error 详细 trace）。
document.addEventListener('click', (e) => {
  const row = e.target.closest('.log-row');
  const stack = row?.querySelector('.log-stack');
  if (stack) stack.hidden = !stack.hidden;
});

// 向上滚动则暂停「跟随」，滚到底部自动恢复。
document.addEventListener('scroll', (e) => {
  const el = e.target.closest?.('#log-entries');
  if (!el) return;
  follow = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  logSyncToolbar();
}, true);
