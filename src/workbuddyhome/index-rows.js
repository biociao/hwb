// WorkBuddy 快照 → hwb 索引行（纯函数，无 I/O）。
//
import path from 'node:path';

// 这一层与 src/codexhome/index-rows.js 同构：WorkBuddy 的项目/会话被翻译成 hwb 已有的
// workspace/session 行，于是 RECENT PROJECTS / RECENT SESSIONS / 用量/搜索全部复用。
//
// 口径（契约 §6）：
//   · workspace = WorkBuddy 的 workspaces 行（用户打开过的项目目录）。workbuddy.db 里
//     workspaces 只有 path，WorkBuddy 自己也用 path 当 workspace id，所以 workspaceId = path，
//     title/project = basename(path)。没有会话的项目也建 workspace —— 它与 dsh 的 workspace.json
//     同性质（用户主动打开/创建的项目），不是 codex 那种「镜像里可能只有自动线程的 project」。
//   · session = sessions 表（deleted_at IS NULL 已在 reader 过滤）。
//   · 项目归属：cwd 按**最长前缀**匹配 workspaces.path；匹配不到按 basename(cwd) 归一化
//     （与 dsh/codex 对未归属会话的口径一致）。
//   · 状态：completed → 已完成；其余（terminated/error/failed/…）→ 已保存。只读元数据
//     无法断言「正在运行」，与 Codex 一致。
//   · token：session_usage.used/size 是上下文用量，本期不伪装成 token 拆分 →
//     tokenUsage / contextPressure 一律 null（契约 §6）。

function asString(value) {
  return typeof value === 'string' ? value : '';
}

function trimmedPath(value) {
  const text = asString(value).trim();
  return text ? text.replace(/\/+$/, '') || '/' : null;
}

function isUnder(cwd, root) {
  if (!cwd || !root) return false;
  if (root === '/') return cwd.startsWith('/');
  return cwd === root || cwd.startsWith(`${root}/`);
}

// completed 在真实库里大小写混用（实测本机同时有 'completed' 86 条与 'Completed' 3 条），
// 所以统一小写比较。只认 completed 为「已完成」，terminated/error/failed 都是「已保存」。
function sessionStatus(status) {
  const text = asString(status).trim().toLowerCase();
  if (text === 'completed') return { kind: 'completed', label: '已完成', subagents: 0 };
  return { kind: 'idle', label: '已保存', subagents: 0 };
}

function projectNameOf(cwd, workspacePath) {
  if (workspacePath) {
    const base = path.basename(workspacePath);
    return base || workspacePath;
  }
  if (typeof cwd === 'string' && cwd) {
    const base = path.basename(cwd);
    if (base) return base;
  }
  return '未归类';
}

function sessionRow({ homeId, session, workspace, project, generatedAt }) {
  return {
    type: 'session',
    homeId,
    sessionId: session.id,
    workspaceId: workspace ? workspace.workspaceId : null,
    workspaceTitle: workspace ? workspace.title : null,
    project,
    title: session.title ?? null,
    // 上下文用量不是 token 拆分：本期不写 tokenUsage（契约 §6），Recent Projects 的 token
    // 聚合对 WorkBuddy 会显示 0/空，这是刻意选择，不是漏读。
    tokenUsage: null,
    contextPressure: null,
    status: JSON.stringify(sessionStatus(session.status)),
    lastActivity: session.updatedAt ?? null,
    generatedAt,
  };
}

/**
 * @param {{homeId:string, homePath:string}} home  hwb 实例行
 * @param {object} snapshot readWorkbuddySnapshot 的输出
 * @param {{now?:number}} [options]
 * @returns {Array<object>} home / workspace / session 行
 */
export function workbuddyIndexRows(home, snapshot, { now = Date.now() } = {}) {
  const generatedAt = snapshot?.generatedAt ?? new Date(now).toISOString();
  const homeId = home?.homeId ?? null;

  // 降级域固定叫 'workbuddy'：store 的 DOMAIN_TABLES 不认识它，所以降级时**不会**保留旧子表
  // 行（那是 dsh 的 projcache/workspace 域才有的保护）。WorkBuddy 的库是单一来源，
  // 读不到就是真的读不到，清空比展示上一份陈旧快照更诚实；界面上由 ⚠ workbuddy 降级 归因。
  const reasons = (Array.isArray(snapshot?.reasons) ? snapshot.reasons : [])
    .filter((reason) => typeof reason === 'string' && reason.trim());
  const rows = [{
    type: 'home',
    homeId,
    homePath: home?.homePath ?? null,
    generatedAt,
    degraded: reasons.length ? [{ domain: 'workbuddy', error: reasons.join('；') }] : [],
  }];

  // workspace 行：快照顺序（last_opened_at 降序）保留；归属匹配单独用「最长前缀优先」的有序表。
  const workspaceRows = [];
  const matchOrder = [];
  for (const raw of snapshot?.workspaces ?? []) {
    const workspacePath = trimmedPath(raw?.path);
    if (!workspacePath) continue;
    const title = projectNameOf(null, workspacePath);
    const entry = { workspaceId: workspacePath, title, path: workspacePath };
    workspaceRows.push(entry);
    matchOrder.push(entry);
  }
  matchOrder.sort((a, b) => b.path.length - a.path.length);

  // 一次遍历算好归属：sessionId -> {session, cwd, workspace}；同时按 workspace 分桶供计数。
  const sessionsByWorkspace = new Map(); // workspaceId -> session[]
  const assignments = [];
  for (const session of snapshot?.sessions ?? []) {
    if (!session?.id) continue;
    const cwd = asString(session.cwd) || null;
    const workspace = cwd ? matchOrder.find((entry) => isUnder(cwd, entry.path)) : null;
    assignments.push({ session, cwd, workspace });
    if (workspace) {
      if (!sessionsByWorkspace.has(workspace.workspaceId)) sessionsByWorkspace.set(workspace.workspaceId, []);
      sessionsByWorkspace.get(workspace.workspaceId).push(session);
    }
  }

  for (const workspace of workspaceRows) {
    const sessions = sessionsByWorkspace.get(workspace.workspaceId) ?? [];
    rows.push({
      type: 'workspace',
      homeId,
      workspaceId: workspace.workspaceId,
      title: workspace.title,
      path: workspace.path,
      project: workspace.title,
      archived: 0,
      sessionCount: sessions.length,
    });
  }

  // 会话按快照顺序（最近活跃在前）落行，保证 Recent Sessions 的全局顺序不被 workspace 分组打乱。
  // 未归属会话按 cwd basename 归一化成 project（与 dsh/codex 同口径），仍进 RECENT SESSIONS。
  for (const { session, cwd, workspace } of assignments) {
    rows.push(sessionRow({
      homeId,
      session,
      workspace,
      project: projectNameOf(cwd, workspace?.path),
      generatedAt,
    }));
  }

  return rows;
}
