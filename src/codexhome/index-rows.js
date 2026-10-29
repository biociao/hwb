// Codex 快照 → hwb 索引行（纯函数，无 I/O）。
//
import path from 'node:path';

// 这一层是「Codex 与 dsh 同构」的关键：Codex 的项目/会话被翻译成 hwb 已有的
// workspace/session 行，于是 RECENT PROJECTS / RECENT SESSIONS / 用量/搜索全部复用，
// 不再需要一张 Codex 专属面板。
//
// 口径：
//   · workspace = Codex 项目（workspaceId = Codex project id，project = 项目名，path = 首个根路径）；
//   · session = Codex「用户会话」——Guardian review / subagent 是自动线程（本机 82%），
//     只算项目活动、不进会话列表，否则 RECENT SESSIONS 会被 0 token 的自动审查淹没；
//   · 只给「有用户会话」的项目建 workspace：没有用户会话的项目不该在 Recent Projects 里占位；
//   · Codex 只暴露 thread 的累计 tokens（无输入/输出拆分）→ tokenUsage 用 totalTokens，
//     Recent Projects 对它单独展示，不伪造成 input/output。

const AUTOMATED = new Set(['guardian_review', 'subagent']);

function isAutomated(thread) {
  return thread?.automated === true || AUTOMATED.has(thread?.source);
}

// Codex 的运行态来自 thread_history 的 thread_turns（见 codexhome/reader.js）：
//   · 最新 turn 在跑且线程 3 分钟内有更新 → 运行中；
//   · 最新 turn 已收尾（completed/interrupted/failed）→ 空闲（turn 完成 ≠ 会话目标完成，
//     所以**不映射成「已完成」**，避免把「这一轮跑完了」误导成「这个任务做完了」）；
//   · 无 turn 记录 / 库缺失 / inProgress 但已陈旧 → 已保存（前端显示「状态未知」，不编造）。
function statusOf(thread) {
  if (thread?.turnState === 'running') return { kind: 'running', label: '运行中', subagents: 0 };
  if (thread?.turnState === 'ended') return { kind: 'idle', label: '空闲', subagents: 0 };
  return { kind: 'idle', label: '已保存', subagents: 0 };
}

function sessionRow({ homeId, thread, project, workspaceId, workspaceTitle, generatedAt }) {
  return {
    type: 'session',
    homeId,
    sessionId: thread.id,
    workspaceId,
    workspaceTitle,
    project,
    title: thread.title ?? null,
    // Codex 没有输入/输出/缓存拆分：只写 totalTokens，不伪造成 uncachedInputTokens/outputTokens。
    tokenUsage: Number(thread.tokens) > 0 ? JSON.stringify({ totalTokens: Number(thread.tokens) }) : null,
    contextPressure: null,
    // 运行态/未读都来自 Codex 自己的投影（thread_turns / thread_read_receipts）。
    status: JSON.stringify(statusOf(thread)),
    // 1 = Codex 侧还有没看的 turn（thread_read_receipts 有行）；0 = 已读。
    // 传显式值（而不是 undefined）是契约的一部分：store 见到显式 unread 就以它为准，
    // 不再用「running → idle」的跃迁推断，避免同一条 Codex 会话被两套逻辑打架。
    unread: thread?.unread === true ? 1 : 0,
    lastActivity: thread.updatedAt ?? null,
    generatedAt,
  };
}

export function codexIndexRows(home, snapshot, { now = Date.now() } = {}) {
  const generatedAt = snapshot?.generatedAt ?? new Date(now).toISOString();
  const homeId = home.homeId;
  const rows = [{
    type: 'home',
    homeId,
    homePath: home.homePath,
    generatedAt,
    degraded: Array.isArray(snapshot?.reasons) && snapshot.reasons.length
      ? [{ domain: 'codex', error: snapshot.reasons.join('；') }]
      : [],
  }];

  for (const project of snapshot?.projects ?? []) {
    const sessions = (project?.threads ?? []).filter((t) => t && t.id && !isAutomated(t));
    if (!sessions.length) continue;
    rows.push({
      type: 'workspace',
      homeId,
      workspaceId: project.id,
      title: project.name,
      path: Array.isArray(project.roots) ? project.roots[0] ?? null : null,
      project: project.name,
      archived: 0,
      sessionCount: sessions.length,
    });
    for (const thread of sessions) {
      rows.push(sessionRow({ homeId, thread, project: project.name, workspaceId: project.id, workspaceTitle: project.name, generatedAt }));
    }
  }

  // 未归属项目根的会话：按 cwd basename 归一化成 project（与 dsh 对无 workspace 会话的口径一致）。
  // 这样它们也能进 RECENT SESSIONS，而不是因为「Codex 里没被指到项目」就从工作台消失。
  for (const thread of snapshot?.unassigned ?? []) {
    if (!thread?.id || isAutomated(thread)) continue;
    const project = typeof thread.cwd === 'string' && thread.cwd ? path.basename(thread.cwd) : '未归类';
    rows.push(sessionRow({ homeId, thread, project, workspaceId: null, workspaceTitle: null, generatedAt }));
  }
  return rows;
}
