// 会话「需要人工介入」的判定与归一（纯函数，不读文件、不碰网络，便于单测）。
//
// 为什么需要这一层：hwb 的会话行原先只有 running / completed / idle 三态，而这三态回答不了
// 「这个会话是不是在等我点 Approve？」—— 一个正在等人审批的会话在 dsh 里**没有任何活动**，
// 用状态推导看它就是「空闲」，于是被当成「没在跑」而忽略，任务就卡在那里。
//
// 两种来源，折叠成同一个给 UI 的 intervention 对象：
//
//   · projection（持久）：dsh 的 `userQuestions` 投影里 `questions.active` 非空
//     —— 会话在等用户回答（`ask_user_question`）。它落在 projcache 里，所以**离线/远端**
//     实例也能看出来。缺点是：(a) 投影 schema 把问题的 `intent` 丢掉了，分不出「计划审阅」
//     与普通提问；(b) **看不到审批** —— 审批是瞬时交互态，不落投影（见 lib/status.js 的注释）。
//   · live（实时）：dsh remote-events 的 `approval/request` / `user-questions/request`
//     waterfall 帧（见 dshhome/pending-interactions.js）。能区分审批/计划审阅/回答，
//     并且在审批出现的那一刻就能上报 —— 这正是「及时展示 Approve」要求的来源。
//
// 合并优先级：approval(3) > plan-review(2) > question(1)。
// 为什么审批最高：审批是唯一会让 agent **完全停住**、只等一个二选一决定的交互
// （Approve / 拒绝），也是最容易被人忽略的那种；把它压在问答后面等于把最急的藏起来。
// 同 kind 时 live 覆盖 projection：实时通道知道得更多（例如能带上工具名与真实原因）。

export const INTERVENTION_KINDS = Object.freeze(['approval', 'plan-review', 'question']);

// 中文文案在这里统一，UI 不再自己拼（服务端返回值即最终文案，前端只做兜底）。
export const INTERVENTION_LABELS = Object.freeze({
  approval: '等待审批',
  'plan-review': '计划待审',
  question: '等待回答',
});

// 排序权重。0 表示「没有介入」，调用方可以统一用 interventionRank(...) 比较。
const RANK = Object.freeze({ approval: 3, 'plan-review': 2, question: 1 });

// 字段长度上限。这些值会进 sessions.status（SQLite 文本列）并经 SSE 发给浏览器，
// 不设上限时一个畸长的 reason（实测过 30 万字符的 approval）会把每次轮询/广播都撑大。
const MAX_TOOL = 64;
const MAX_REASON = 160;
const MAX_COUNT = 50;

export function interventionRank(kind) {
  return RANK[kind] ?? 0;
}

// 字符串清洗：只接受字符串，剥 NUL（node:sqlite 绑 TEXT 时按 C 字符串处理，U+0000 会把
// 后面的内容静默截掉），去掉首尾空白，超长截断成 `…`。非字符串/空串一律 null。
function cleanText(value, max) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\u0000/g, '').trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// 时间只接受**能被 Date 解析**的字符串，统一成 ISO；非法值降级 null（绝不抛）。
function isoOrNull(value) {
  if (typeof value !== 'string' || !value) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

function countOf(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(MAX_COUNT, Math.floor(n));
}

/**
 * 把任意来源的 intervention 归一成**可信形状**：kind 白名单、label 由本地文案派生
 * （不信任上游文案）、source 只认 'live'/'projection'、文本截断。
 * @param {unknown} raw
 * @returns {{kind:string,label:string,source:'live'|'projection',since:string|null,tool:string|null,reason:string|null,count:number}|null}
 */
export function normalizeIntervention(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const kind = INTERVENTION_KINDS.includes(raw.kind) ? raw.kind : null;
  if (!kind) return null;
  return {
    kind,
    label: INTERVENTION_LABELS[kind],
    // source 只影响合并优先级与提示文案；未知值按 projection 处理（更保守：可被 live 覆盖）。
    source: raw.source === 'live' ? 'live' : 'projection',
    since: isoOrNull(raw.since),
    // 只有审批才有「工具名」；其它来源带 tool 一律丢掉，避免 UI 显示误导性信息。
    tool: kind === 'approval' ? cleanText(raw.tool, MAX_TOOL) : null,
    reason: cleanText(raw.reason, MAX_REASON),
    count: countOf(raw.count),
  };
}

/**
 * 从 dsh 的 `userQuestions` 投影推导「等待回答」。
 *
 * 投影形状（实测 dsh 0.2.0-rc.2，见 dsh-user-questions 的 projectionViewSchema）：
 *   `{ inheritedEventCount?: number, timed?: boolean, questions: { active: [{callId, questions:[…]}], settled: […] } }`
 * 这里只关心 active；任何字段缺失/类型不对都当作「没有在等」—— 投影缓存可能来自旧版 dsh，
 * 也可能只写了一部分（快照在写盘中途被杀），宁可少报也不要把一个坏结构当成待介入标出去。
 *
 * @param {{userQuestions?: unknown}} src
 * @returns {ReturnType<typeof normalizeIntervention>}
 */
export function deriveProjectionIntervention(src = {}) {
  const raw = src?.userQuestions;
  const view = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  const questions = view?.questions;
  const active = questions && typeof questions === 'object' && Array.isArray(questions.active)
    ? questions.active
    : [];
  // 只认**确实带了问题**的批次：`{callId}` 而没有 questions 的记录不是一个待回答的提问
  // （历史版本/半截快照会出现），把它算进去会让会话卡永久挂一个「等待回答」。
  const batches = active.filter((entry) => entry && typeof entry === 'object' && Array.isArray(entry.questions) && entry.questions.length > 0);
  if (!batches.length) return null;
  const first = batches[0].questions.find((q) => q && typeof q === 'object') ?? null;
  const reason = cleanText(first?.question ?? first?.header, MAX_REASON);
  return normalizeIntervention({
    kind: 'question',
    source: 'projection',
    since: null,
    reason,
    // count 用「待回答的批次」数，与 live 通道的 questions.length 语义不同——
    // UI 只用它做 badge/aria 文案，不参与排序；统一限制在上限内即可。
    count: batches.length,
  });
}

/**
 * 合并两个 intervention：高优先级胜出，同 kind 时 live 覆盖 projection。
 * 字段级合并只补空（例如 live 的审批没带 displayReason 时，保留投影里的提问文本），
 * `since` 取更早的一次（「从什么时候开始等」比「最近一次看到」对人有意义）。
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {ReturnType<typeof normalizeIntervention>}
 */
export function mergeIntervention(a, b) {
  const left = normalizeIntervention(a);
  const right = normalizeIntervention(b);
  if (!left) return right;
  if (!right) return left;
  const rankLeft = interventionRank(left.kind);
  const rankRight = interventionRank(right.kind);
  let primary = left;
  let secondary = right;
  if (rankRight > rankLeft || (rankRight === rankLeft && right.source === 'live' && left.source !== 'live')) {
    primary = right;
    secondary = left;
  }
  const sinceFirst = [primary.since, secondary.since].filter(Boolean).sort()[0] ?? null;
  return {
    ...primary,
    tool: primary.tool ?? secondary.tool,
    reason: primary.reason ?? secondary.reason,
    count: Math.max(primary.count, secondary.count),
    since: sinceFirst,
  };
}

/**
 * 把一组 intervention 折叠成最强的那一个（null 安全）。UI/服务端都可能拿到多条来源。
 * @param {Iterable<unknown>} list
 */
export function strongestIntervention(list) {
  let best = null;
  for (const item of list ?? []) best = mergeIntervention(best, item);
  return best;
}

/**
 * 从会话行上读出现有的介入信息。约定两个落点：
 *   · `status.intervention`：由投影推导（持久，随会话入库）；
 *   · `intervention`：API 层合入的实时覆盖（不落库）。
 * 两个都在时按合并规则取强者；都没有返回 null。
 * @param {object|null|undefined} session
 */
export function interventionOfSession(session) {
  return mergeIntervention(session?.status?.intervention, session?.intervention);
}
