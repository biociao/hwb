import { esc } from '../store.js';

// 保存记录不代表执行状态。保持索引协议不变，在展示层区分 unknown 与真正的 idle。
// 计数字段归一：非数字 / 负数 / 空串一律 null（未知），而不是 0 —— 「不知道」与「已知是 0」
// 在 UI 上必须长得不一样（见 lib/intervention.js 的键存在约定）。
function countOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : null;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Math.max(0, Math.floor(Number(value)));
  }
  return null;
}

export function sessionState(session) {
  const status = session?.status;
  const saved = status?.label === '已保存' || status?.label === 'Codex';
  const kind = !saved && ['running', 'completed', 'idle'].includes(status?.kind) ? status.kind : 'unknown';
  const labels = { running: '运行中', completed: '已完成', idle: '空闲', unknown: '状态未知' };
  const icons = { running: '●', completed: '✓', idle: 'Ⅱ', unknown: '?' };
  const total = countOf(status?.subagents);
  // 「其中几个在跑」：缺键 = 未知（null），与「已观测的 0」不同。两个数都做取整钳制；
  // running 不可能大于历史总数（annotate 保证），但外部/未来数据源可能不守约，展示层再兜一层。
  const running = countOf(status?.subagentsRunning);
  return {
    kind, saved,
    label: kind === 'unknown' ? labels.unknown : status.label || labels[kind],
    icon: icons[kind],
    subagents: total ?? 0,
    subagentsKnown: total !== null,
    subagentsRunning: running !== null && total !== null ? Math.min(running, total) : running,
  };
}

// —— 需要人工介入（intervention）——
//
// 为什么不能靠 sessionState 判断：一个在等 Approve 的会话在 dsh 里**没有任何活动**，
// 状态推导看它就是「空闲」，于是被当成没在跑而漏掉，任务就卡在那里。所以介入状态是
// 独立的一层，由服务端根据 dsh 的 waterfall 帧 / userQuestions 投影算好，前端只负责展示。
//
// FROZEN 契约（/api/sessions/recent 与 /api/search 的 session 行可能带）：
//   intervention = { kind:'approval'|'plan-review'|'question', label, source:'live'|'projection',
//                    since:ISO|null, tool:string|null, reason:string|null, count:number }
// 两个落点都要读，缺一个就会漏数据（Lead 明确要求）：
//   · session.intervention        实时覆盖（watcher 合入，API 返回）；
//   · session.status.intervention 投影推导（持久，随 status 一起入库，离线/远端实例也能看到「等待回答」）。
// 两边都有时按 kind 优先级取强者，同 kind 时 live 覆盖 projection。
//
// 所有文本只做**纯文本**归一（剥 NUL、截断），绝不在这里拼 HTML —— 渲染端一律 esc()。
// tool/reason/label 都来自 dsh 元数据，属于存储型 XSS 面（见 CHANGELOG 的同类事故）。
// 与服务端 src/lib/intervention.js 的归一语义保持一致，但**故意不跨目录 import**：
// src/web 是独立的静态根（浏览器只加载这里的模块），跨目录会把 node 侧代码带进前端依赖图。
const INTERVENTION_KINDS = ['approval', 'plan-review', 'question'];
const INTERVENTION_LABELS = { approval: '等待审批', 'plan-review': '计划待审', question: '等待回答' };
// 审批是最急的（agent 完全停住只等一个二选一决定），用警示符号；其余用等待符号。
const INTERVENTION_ICONS = { approval: '⏳', 'plan-review': '⚠', question: '⏳' };
const INTERVENTION_RANKS = { approval: 3, 'plan-review': 2, question: 1 };
const MAX_LABEL = 24;
const MAX_TOOL = 64;
const MAX_REASON = 160;
const MAX_COUNT = 50;

// 0 = 没有介入；调用方可以统一用 interventionRank 比较「谁更急」。
export function interventionRank(kind) {
  return INTERVENTION_RANKS[kind] ?? 0;
}

function cleanText(value, max) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\u0000/g, '').trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// 把任意来源的 intervention 归一成可信形状：kind 白名单、label 兜底、非法时间降级 null、文本截断。
// 不抛错、不改入参；无法识别时返回 null（= 没有介入，不能把一个坏结构标成「在等你」）。
export function normalizeIntervention(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const kind = INTERVENTION_KINDS.includes(raw.kind) ? raw.kind : null;
  if (!kind) return null;
  const at = typeof raw.since === 'string' ? Date.parse(raw.since) : NaN;
  const count = Number(raw.count);
  return {
    kind,
    label: cleanText(raw.label, MAX_LABEL) ?? INTERVENTION_LABELS[kind],
    source: raw.source === 'live' ? 'live' : 'projection',
    since: Number.isFinite(at) ? new Date(at).toISOString() : null,
    // 只有审批有「工具名」：其它 kind 带 tool 一律丢掉，避免显示误导性信息。
    tool: kind === 'approval' ? cleanText(raw.tool, MAX_TOOL) : null,
    reason: cleanText(raw.reason, MAX_REASON),
    count: Number.isFinite(count) && count >= 1 ? Math.min(MAX_COUNT, Math.floor(count)) : 1,
  };
}

// 合并两个来源：高优先级胜出，同 kind 时 live 覆盖 projection；字段只补空不覆盖。
export function mergeInterventions(a, b) {
  const left = normalizeIntervention(a);
  const right = normalizeIntervention(b);
  if (!left) return right;
  if (!right) return left;
  const preferRight = interventionRank(right.kind) > interventionRank(left.kind)
    || (right.kind === left.kind && right.source === 'live' && left.source !== 'live');
  const primary = preferRight ? right : left;
  const secondary = preferRight ? left : right;
  const since = [primary.since, secondary.since].filter(Boolean).sort()[0] ?? null;
  return {
    ...primary,
    tool: primary.tool ?? secondary.tool,
    reason: primary.reason ?? secondary.reason,
    count: Math.max(primary.count, secondary.count),
    since, // 取更早的一次：「从什么时候开始等」比「最近一次看到」对人有意义
  };
}

// 「已等待」的中文时长。只用于 title，不在界面上占位；非法时间返回 null（不画）。
function waitedText(since) {
  const at = Date.parse(since ?? '');
  if (!Number.isFinite(at)) return null;
  const minutes = Math.floor(Math.max(0, Date.now() - at) / 60_000);
  if (minutes < 1) return '不到 1 分钟';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天`;
}

/**
 * 读出一个会话的介入状态（两个落点合并后归一）。
 * @param {object|null|undefined} session
 * @returns {{kind:string,label:string,icon:string,rank:number,source:string,since:string|null,
 *            tool:string|null,reason:string|null,count:number,title:string}|null}
 */
export function interventionState(session) {
  const merged = mergeInterventions(session?.status?.intervention, session?.intervention);
  if (!merged) return null;
  const parts = [merged.label];
  if (merged.tool) parts.push(`工具 ${merged.tool}`);
  if (merged.reason) parts.push(`原因 ${merged.reason}`);
  parts.push(`来源 ${merged.source === 'live' ? '实时' : '投影'}`);
  const waited = waitedText(merged.since);
  if (waited) parts.push(`已等待 ${waited}`);
  if (merged.count > 1) parts.push(`共 ${merged.count} 项待处理`);
  return {
    ...merged,
    icon: INTERVENTION_ICONS[merged.kind],
    rank: interventionRank(merged.kind),
    // title 是**纯文本**，交给渲染端 esc() 后进属性；这里绝不拼 HTML。
    title: parts.join(' · '),
  };
}

// 「待介入」放在最前：它是列表的第一优先级，用户打开仪表盘第一眼就该看到。
export const SESSION_FILTERS = [
  ['intervention', '待介入'], ['all', '全部'], ['running', '运行中'], ['completed', '已完成'], ['other', '其他'],
];

// 排序权重：有介入的最前（kind 越急越靠前），其次运行中，再次「未读」，其余按最近活动。
// 用固定权重区间而不是逐字段比较，保证「待介入」永远整体排在「运行中」之前。
function sortPriority(session) {
  const intervention = interventionState(session);
  if (intervention) return 100 + intervention.rank;
  const { kind } = sessionState(session);
  if (kind === 'running') return 50;
  return 0;
}

export function filterSessionState(sessions, filter = 'all') {
  return sessions.filter((s) => {
    // 待介入只保留真的有介入的行；其余筛选键的语义保持不变。
    if (filter === 'intervention') return !!interventionState(s);
    const { kind } = sessionState(s);
    return filter === 'all' || (filter === 'other' ? kind === 'idle' || kind === 'unknown' : kind === filter);
  }).sort((a, b) => {
    const priority = sortPriority(b) - sortPriority(a);
    const time = (s) => Date.parse(s.lastActivity) || 0;
    return priority || time(b) - time(a);
  });
}

export function renderSessionStatusFilter(sessions, active = 'all', { showSubagents = false, subagentCount = 0, unobserved = 0 } = {}) {
  // unobserved：屏上会话所属实例里没有实时通道的数量。这些实例上的等待审批观察不到，
  // 所以「待介入 0」不能当成「没人需要你」—— 按钮上给出可查的说明（不改变计数语义）。
  const blindCount = Number.isFinite(Number(unobserved)) ? Math.max(0, Math.floor(Number(unobserved))) : 0;
  // 没有盲区时**不加 title**（保持旧 DOM 逐字节不变，避免给无观测限制的实例平添噪音）。
  const interventionTitle = blindCount > 0
    ? `其中 ${blindCount} 个实例无实时通道：等待审批 / 计划待审 / 等待回答可能不会出现在这里`
    : null;
  return `<div class="session-status-filter" role="group" aria-label="按会话状态筛选">${SESSION_FILTERS.map(([key, label]) =>
    `<button type="button" data-action="filter-session-status" data-status-filter="${key}" aria-pressed="${active === key}"${key === 'intervention' && interventionTitle ? ` title="${esc(interventionTitle)}"` : ''}>${label}<span>${filterSessionState(sessions, key).length}</span></button>`
  ).join('')}<button type="button" class="subagent-toggle" data-action="toggle-subagents" aria-pressed="${showSubagents}" title="显示或隐藏已索引的子代理会话（父会话卡上的子代理计数不受此开关影响）">${showSubagents ? '隐藏子代理' : '显示子代理'}${subagentCount > 0 ? `<span>${Number(subagentCount) || 0}</span>` : ''}</button><span class="session-order">待介入优先</span></div>`;
}

// unobserved：这条会话所属实例没有实时通道 → 「空闲」不排除「其实在等审批」。
// 只能改 tooltip 说明，不能改状态文案（没有证据时不能凭空造一个状态）。
export function sessionStatusChip(session, { unobserved = false } = {}) {
  const state = sessionState(session);
  const cls = { running: 'run', completed: 'done', idle: 'idle', unknown: 'unknown' }[state.kind];
  const approval = session?.status?.approval ? ` · 审批 ${session.status.approval}` : '';
  const coverage = unobserved ? '；该实例无实时通道，等待审批 / 提问可能看不到' : '';
  const baseHint = state.kind === 'unknown'
    ? '未取得执行状态；索引记录不能证明正在运行或空闲'
    : `会话状态: ${state.label}`;
  const hint = baseHint + coverage;
  return `<span class="chip status ${cls}" title="${esc(hint + approval)}"><span class="status-symbol" aria-hidden="true">${state.icon}</span>${esc(state.label)}</span>`;
}

// 介入 chip：橙色警示块，放在状态 chip **之前**（更急的信息先被读到）。
// data-intervention 让测试/样式能按 kind 定位；kind 是白名单值，label/title 必须 esc()。
export function interventionChip(session) {
  const intervention = interventionState(session);
  if (!intervention) return '';
  return `<span class="chip status warn intervention" data-intervention="${intervention.kind}" title="${esc(intervention.title)}"><span class="status-symbol" aria-hidden="true">${intervention.icon}</span>${esc(intervention.label)}</span>`;
}
