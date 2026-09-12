// 会话工作状态推导（纯函数）：把 projcache 中携带的状态类投影
//（sessionStats / goal / todos / subagent / plan / permissions）折叠成一个
// 给 UI 展示的状态对象。它不读任何文件，只消费一组原始投影值，便于单测。
//
// 说明：projcache 是 DSH 的持久化投影快照，能可靠地反映「是否处于进行中 / 是否完成」，
// 但「正在等待用户审批（approval pending）」属于运行时交互态，不落在投影缓存里——
// 因此这里只输出 running / completed / idle 三态；审批策略（permissions.approval）
// 作为附带信息给出，UI 可酌情用作次级提示。
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

  const subagentRaw = src.subagent;
  const subagents =
    subagentRaw && typeof subagentRaw === 'object' && !Array.isArray(subagentRaw) && !(subagentRaw instanceof Date)
      ? Object.keys(subagentRaw).length
      : 0;

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
  // 极少数「长时间没有新输入」的真跑任务会被误判成空闲，这是刻意选择的取舍：
  // 本机实例另有 3s 的实时通道（live-status 的 `running` 布尔是权威信号）会覆盖这里的结论，
  // 而远端/离线实例只能靠文件索引，宁可保守显示「空闲」，也不能把几周前的会话标成在跑。
  if (kind === 'running' && isStale(src.lastActivity)) kind = 'idle';

  const labels = {
    running: '运行中',
    completed: '已完成',
    idle: '空闲',
  };

  return {
    kind,
    label: labels[kind],
    subagents,
    // approval 是**自由文本**，来源是 dsh 元数据（projcache 的 permissions.val / 实时 RPC）。
    // 它会被展示在状态 chip 上，因此这里做一层兜底：只接受字符串、并限制长度。
    // 注意这不是「转义」的替代品（转义在渲染层做，且必须做），而是防止一个畸长的值
    // 把整行状态 JSON 撑大、以及把非字符串（对象/数组）塞进本来是标量的字段。
    approval: normalizeApproval(src.permissions?.approval),
  };
}
