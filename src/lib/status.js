// 会话工作状态推导（纯函数）：把 projcache 中携带的状态类投影
//（sessionStats / goal / todos / subagent / plan / permissions）折叠成一个
// 给 UI 展示的状态对象。它不读任何文件，只消费一组原始投影值，便于单测。
//
// 说明：projcache 是 DSH 的持久化投影快照，能可靠地反映「是否处于进行中 / 是否完成」。
// 「正在等待用户**审批**（approval pending）」属于运行时交互态，不落在投影缓存里——那部分
// 只能靠实时通道（dshhome/pending-interactions.js 观察 remote-events 的 approval/request），
// 由 API 层合入 `session.intervention`。但「在等用户**回答**」是持久投影（`userQuestions`
// 的 questions.active），会随快照一起落盘，所以这里额外输出 `intervention`：
// 它让离线/远端实例也能标出「等待回答」，UI 不必分辨数据来自哪条通道。
// 审批策略（permissions.approval）仍是附带信息，仅作次级提示。
import { deriveProjectionIntervention } from './intervention.js';

// 「仍在进行中」的最长无活动时间。超过就认为那条快照已经冻结。
const RUNNING_STALE_MS = 30 * 60_000;

function isStale(lastActivity) {
  if (!lastActivity) return false; // 没有时间信息时不做判断（例如只从实时通道来的会话）
  const at = Date.parse(lastActivity);
  if (!Number.isFinite(at)) return false;
  const age = Date.now() - at;
  // **未来的时间戳也算陈旧**：它的 age 是负数，而 `age > RUNNING_STALE_MS` 对负数恒为 false ——
  // 闸门被整个关掉。实测（审查）：`openStep + lastActivity 在未来 6 小时` 判成 running；
  // 写成公元 33658 年同样 running；而真实 projcache 里时钟偏一点就会产生未来时间戳
  // （CHANGELOG 记录过：远端实例时钟偏一点 → summary 6000 而 trend 0）。
  // 这个闸门本身就是为修「179 个会话里 18 个被永久标成运行中」而写的，不能被一个未来时刻绕过。
  // 本机时钟无法判断「未来的时刻有多新」，按本项目一贯的取舍降级为 idle —— 真正在跑的实例
  // 另有实时通道（3s 轮询）覆盖状态。
  return age < 0 || age > RUNNING_STALE_MS;
}

// 观测时间归一：只接受能解析的 ISO 字符串，其余（缺省/坏值/未来由 isStale 处理）返回 null。
// 它是**投影快照文件**的 mtime（见 read-home.js 的 statMtime），不是「用户上次说话的时间」。
function observedAtIso(value) {
  if (typeof value !== 'string') return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

// 审批策略：只保留字符串，并限制长度（超长直接截断 —— 它只是一个展示用的次级提示）。
const APPROVAL_MAX = 64;

// 导出：实时通道（dshhome/live-status.js）也必须经过同一套守卫 —— 否则 `permissions.approval`
// 会绕过它（实测：`{"obj":true}` 直接落库 → 界面显示「审批 [object Object]」；300k 的字符串
// 会把 sessions.status 撑到 300KB 且每 3s 重写一次），而且在宽限期内实时值赢过文件侧被守卫的值。
export function normalizeApproval(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > APPROVAL_MAX ? `${trimmed.slice(0, APPROVAL_MAX)}…` : trimmed;
}

// subagent v2 的磁盘 state 是 {identity:{mode,label,seq}}，RPC wire 是 identity 本身。
// 这是“自己是子代理”的身份，不能用 Object.keys 数成“有 1/3 个子代理”。
// 旧版的 child-id -> state 字典仍保留计数兼容；当前版本的子代理数量来自 catalog。
export function subagentStatus(raw, catalog, inheritedEventCount = 0) {
  const object = raw && typeof raw === 'object' && !Array.isArray(raw) && !(raw instanceof Date) ? raw : null;
  const identity = object?.identity ?? object;
  const inherited = Number.isSafeInteger(inheritedEventCount) && inheritedEventCount >= 0 ? inheritedEventCount : 0;
  const isSubagent = !!identity && ['one-shot', 'continuable'].includes(identity.mode)
    && Number.isSafeInteger(identity.seq) && identity.seq >= inherited
    && (identity.mode !== 'continuable' || typeof identity.label === 'string');
  let subagents;
  if (Array.isArray(catalog)) {
    subagents = new Set(catalog.filter((entry) => typeof entry?.id === 'string' && entry.id.trim()).map((entry) => entry.id)).size;
  } else if (catalog && typeof catalog === 'object' && !Array.isArray(catalog)) {
    // Catalog 的磁盘 state 是 {head:{values:[{childId,...}],previous?}}，wire 才是数组。
    const ids = new Set();
    const seen = new Set();
    for (let node = catalog.head; node && typeof node === 'object' && !seen.has(node); node = node.previous) {
      seen.add(node);
      for (const entry of Array.isArray(node.values) ? node.values : []) {
        if (typeof entry?.childId === 'string' && entry.childId.trim()) ids.add(entry.childId);
      }
    }
    subagents = ids.size;
  } else {
    subagents = object && !('identity' in object) && !('mode' in object) ? Object.keys(object).length : 0;
  }
  return { subagents, ...(isSubagent ? { isSubagent: true } : {}) };
}

// —— 子代理「其中几个在跑」 ——
//
// status.subagents 是 `subagentCatalog` 的条目数：**历史总数**（含已结束的 one-shot 子代理），
// 不是并发数。要回答「现在有几个在跑」，必须把父会话 catalog 里的 childId 与本实例的会话行
// join —— 子会话 `status.kind === 'running'` 即视为在跑。这也是 dsh 自己会话头的口径
//（dsh-client-ui-subagent 的 CatalogDropdown：`entry.activity = 子会话 running`）。
//
// 三条硬规则（与 intervention 的「键存在=有观测」同一套语义，缺一条就会把「不知道」伪装成
// 「没有」，或把历史数字冻在空闲卡上）：
//   1. **只有父会话自己 running 才判**：子代理运行在父 turn 内，父会话空闲时残留的 running
//      子行多半是投影没来得及降级，别把数字贴到空闲卡上；
//   2. **catalog 里任一 childId 在本批会话里找不到 → 未知，不写键**（子会话可能没被索引/已归档，
//      缺失不等于没在跑）；
//   3. 全部找到才写 —— 包括 0（那是**已观测的 0**，与「没有数据」不是一回事）。
const MAX_SUBAGENT_IDS = 64;

/**
 * 从 `subagentCatalog` 投影里取出直接子会话 id（两种形态都认）。
 *
 * · wire（`session/list` 的 `projections.values.subagentCatalog`）是数组：`[{ id, mode, label }]`；
 * · 磁盘 projcache 是链接结构：`{ head: { values: [{ childId }], previous: {...} } }`。
 *
 * 返回 `null` 表示**不可用**（没有 catalog / 条目超过上限 / 形状不认识）而不是空数组：
 * 空 catalog 与「读不懂」在展示层都要落成「没有运行中数字」，但内部要能区分「已知 0 个子代理」
 * 与「这台的投影格式不认识」—— 前者可以断言，后者绝不能当成 0 个子代理。
 * @param {unknown} raw
 * @param {number} [max]
 * @returns {string[]|null}
 */
export function subagentCatalogIds(raw, max = MAX_SUBAGENT_IDS) {
  const ids = new Set();
  const add = (value) => {
    if (typeof value !== 'string') return;
    const id = value.trim();
    if (id) ids.add(id);
  };
  if (Array.isArray(raw)) {
    for (const entry of raw) add(entry?.id);
  } else if (raw && typeof raw === 'object') {
    // 磁盘形态：沿 previous 链去重（同一节点被链两次的坏数据不会死循环）。
    const seen = new Set();
    for (let node = raw.head; node && typeof node === 'object' && !seen.has(node); node = node.previous) {
      seen.add(node);
      for (const entry of Array.isArray(node.values) ? node.values : []) add(entry?.childId);
    }
  }
  if (!ids.size || ids.size > max) return null;
  return [...ids];
}

/**
 * 给一批同一 home 的会话行补 `status.subagentsRunning`（原地修改并返回同一数组）。
 *
 * 入参的会话行可以带一个**临时**字段 `childSessionIds`（由 schema.js / live-status.js 从
 * `subagentCatalog` 折出来，不会入库：normalize 只拷贝已知字段）。
 *
 * 只有「父会话 running + catalog 全部 childId 都能在本批会话里找到」时才写键 ——
 * 其余情况保持缺键（未知），展示层据此决定不画数字。
 * @template {{sessionId?:unknown, status?:any, childSessionIds?:unknown}} T
 * @param {T[]} sessions
 * @returns {T[]}
 */
export function annotateSubagentRunning(sessions) {
  if (!Array.isArray(sessions) || !sessions.length) return sessions;
  const statusById = new Map();
  for (const session of sessions) {
    if (session && typeof session.sessionId === 'string' && session.status) {
      statusById.set(session.sessionId, session.status);
    }
  }
  for (const session of sessions) {
    const status = session?.status;
    const ids = session?.childSessionIds;
    if (!status || status.kind !== 'running' || !Array.isArray(ids) || !ids.length) continue;
    let running = 0;
    let known = true;
    for (const id of ids) {
      const childStatus = statusById.get(id);
      if (!childStatus) {
        known = false;
        break;
      }
      if (childStatus.kind === 'running') running += 1;
    }
    // 任一子会话查不到 → 整条保持未知：不能把「有子会话没被索引」写成「0 个在跑」。
    if (!known) continue;
    status.subagentsRunning = running;
  }
  return sessions;
}

export function deriveSessionStatus(src = {}) {
  const stats = src.sessionStats ?? {};
  const openStep = stats.openStep != null && stats.openStep !== undefined;
  const pendingCalls =
    stats.pendingCalls && typeof stats.pendingCalls === 'object' &&
    !Array.isArray(stats.pendingCalls) &&
    Object.keys(stats.pendingCalls).length > 0;

  const goalPhase = src.goal?.goal?.phase ?? null;
  const todos = Array.isArray(src.todos) ? src.todos : [];
  const hasInProgressTodo = todos.some((t) => t && t.status === 'in_progress');
  const todoCount = todos.length;
  const allDone = todoCount > 0 && todos.every((t) => t && t.status === 'completed');
  // `plan.active` 是**持久模式开关**（`plan/mode` 设置，空闲时不会复位），
  // 只有 `plan.running`（进行中的 /plan 命令）才代表「正在跑」。
  // 把 active 当活动信号的话，任何开过 plan 模式的会话都会永久显示「运行中」。
  const planRunning = !!(src.plan && src.plan.running != null);

  const subagents = subagentStatus(src.subagent, src.subagentCatalog, src.inheritedEventCount);

  let kind;
  if (openStep || pendingCalls || hasInProgressTodo || goalPhase === 'active' || planRunning) {
    kind = 'running';
  } else if (goalPhase === 'complete' || allDone) {
    kind = 'completed';
  } else {
    kind = 'idle';
  }

  // 新鲜度门限：以上信号全部来自**投影缓存快照**。进程被杀、机器休眠、会话被放弃之后，
  // 那些「进行中」的标记会永久冻结在缓存里 —— 不断言新鲜度的话，几周前的会话会一直显示
  // 「运行中」。实测真实 home：179 个会话里 18 个被判 running，全部空闲 7–28 天，0 个在 10 分钟内。
  //
  // **两个时间信号，都陈旧才降级**。只看 lastActivity 是错的：它是
  // `sessionListMetadata.lastPromptAt`（最后一条**用户输入**），一个跑了 3 小时、中途没有
  // 新用户输入的长任务会让它停在 3 小时前，于是真在跑的会话被误判成冻结快照、翻成「空闲」。
  // 实测（2026-10-27）：一条 3 小时会话从 15:07 起被显示为空闲，而它一直有工具调用、17:38 才弹审批。
  // observedAt 是投影文件自己的 mtime（dsh 每写一条投影就会重写该文件），它才回答
  // 「这份快照是什么时候的」。缺省 observedAt（远程/聚合/实时通道）时退回只看 lastActivity。
  const observedAt = observedAtIso(src.observedAt);
  const stale = observedAt ? (isStale(src.lastActivity) && isStale(observedAt)) : isStale(src.lastActivity);
  if (kind === 'running' && stale) kind = 'idle';

  // 一次推导、两处使用（状态对象与后续可能的日志/测试）：避免调用两次拿到不同 since。
  const projectedIntervention = deriveProjectionIntervention({ userQuestions: src.userQuestions });

  const labels = {
    running: '运行中',
    completed: '已完成',
    idle: '空闲',
  };

  return {
    kind,
    label: labels[kind],
    ...subagents,
    // 状态观测时间（投影快照 mtime）：有它时 UI 能说明「状态观测于 N 分钟前」，也是排查
    // 「为什么显示运行中」的证据。缺省（实时通道/远程）时不写这个键，保持旧形状。
    ...(observedAt ? { observedAt } : {}),
    // approval 是**自由文本**，来源是 dsh 元数据（projcache 的 permissions.val / 实时 RPC）。
    // 它会被展示在状态 chip 上，因此这里做一层兜底：只接受字符串、并限制长度。
    // 注意这不是「转义」的替代品（转义在渲染层做，且必须做），而是防止一个畸长的值
    // 把整行状态 JSON 撑大、以及把非字符串（对象/数组）塞进本来是标量的字段。
    approval: normalizeApproval(src.permissions?.approval),
    // 投影来源的人工介入（当前只有「等待回答」）：审批/计划审阅需要实时通道，见文件头。
    // **没有介入时不写这个键**（而不是写 null）：status JSON 会入库、进 API、进 SSE 广播，
    // 绝大多数会话没有介入，一个恒为 null 的键只是把每行的载荷和每个 deepEqual 断言都撑大。
    ...(projectedIntervention ? { intervention: projectedIntervention } : {}),
  };
}
