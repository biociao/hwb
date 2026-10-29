import path from 'node:path';

// node:sqlite 绑 TEXT 时按 C 字符串处理：**值里的 U+0000 会把后面全部截掉**且不报错。
// 实测（审查）：`run('A\u0000B')` 读回 `'A'`，`run('\u0000leading')` 读回 `''`。
// 也就是说外部 dsh home 的 title/cwd/path 里一旦有 NUL，入库时会被静默截断
// （无日志、无 degraded、界面上看不出少了什么）。这里在**产出侧**统一剥掉 NUL ——
// 比在 store 的每个绑定点上处理更集中，也顺带覆盖实时通道（live-status 的 toLiveRow 同样用它）。
// JSON 列不受影响（JSON.stringify 会把 NUL 转义成 \u0000 文本），所以只处理纯文本字段。
export const stripNul = (v) => (typeof v === 'string' && v.includes('\u0000') ? v.replace(/\u0000/g, '') : v);

// 项目名口径：**用户可见名优先**，目录名只作兜底。
//
// dsh 的 workspace 记录里 `path` 是「canonical host directory path」，`title` 是「user-visible
// title」；在 dsh 里重命名项目（`workspace.rename` → `Workspace.setTitle`）只改 title，path 不变。
// 早先这里按 `basename(path)` 取名，于是 dsh 里改了名工作台永远显示目录名（用户报障：编辑项目名后
// hwb 不更新）；同一目录在 Codex 侧用的是它自己的项目名，两个名字还会把同一目录拆成两张项目卡
// （实测：/Volumes/repo/ciao/PMSEQ/PMAID1.0-Production 在 dsh 里叫 PMAID-Production、
// 在 Codex 里也叫 PMAID-Production，hwb 里却显示成 PMAID1.0-Production 与 PMAID-Production 两张卡）。
//
// 现在与 Codex / WorkBuddy 的口径对齐：title 优先、basename(path) 兜底。已知取舍：dsh 允许不同
// 目录（甚至跨实例）用同一个 title，同名即合并 —— 与「同名项目跨实例聚合成一张卡」是同一套语义。
// 未归属会话（没有 workspace）会先看 cwd 是否**正好等于**某个 workspace.path，是则用那个工作区的
// 项目名，否则按 `basename(cwd)` 归一化，见下面的 session 分支。
function projectOf(ws) {
  // title/path 都可能不是字符串（外部/未来版本的文件内容），path.basename 会抛 TypeError。
  // normalize 是导出函数，一次抛错 = 整个 home 的索引失败，所以这里逐字段兜底。
  const title = typeof ws?.title === 'string' ? stripNul(ws.title).trim() : '';
  if (title) return title;
  if (typeof ws?.path === 'string' && ws.path) {
    const base = path.basename(stripNul(ws.path));
    if (base) return base;
  }
  return 'unknown';
}

const asArray = (v) => (Array.isArray(v) ? v : []);

// HomeSnapshot → IndexedRows[] (§4.4). Pure function, no side effects.
export function normalize(snapshot) {
  const rows = [];
  // projcache sessions don't carry workspaceId — invert workspace.sessionIds.
  const wsBySession = new Map();
  // 会话 → 工作区的**第二条**回退路径：cwd 与 workspace.path 完全相同（见下面 session 分支）。
  // dsh 自己的归属判据就是 `attachSession` 里的 cwd(realpath) === workspace.path，**不是前缀**：
  // 子目录里的会话属于它自己，不能被并进父工作区。这里用去掉尾部斜杠后的字符串相等比较，
  // 与 dsh 存的 canonical path 同一口径；路径解析不出来（符号链接等）就落回 basename(cwd)。
  const wsByPath = new Map();
  for (const w of asArray(snapshot.workspaces)) {
    for (const sid of asArray(w?.sessionIds)) wsBySession.set(sid, w);
    if (typeof w?.path !== 'string') continue;
    const p = stripNul(w.path).replace(/\/+$/, '');
    if (p && !wsByPath.has(p)) wsByPath.set(p, w);
  }

  rows.push({
    type: 'home',
    homeId: snapshot.homeId,
    homePath: snapshot.homePath,
    generatedAt: snapshot.generatedAt,
    degraded: snapshot.degraded,
  });

  const sessionCountByWs = new Map();
  for (const s of asArray(snapshot.sessions)) {
    const ws = wsBySession.get(s.sessionId);
    if (ws) sessionCountByWs.set(ws.workspaceId, (sessionCountByWs.get(ws.workspaceId) ?? 0) + 1);
  }

  for (const w of asArray(snapshot.workspaces)) {
    rows.push({
      type: 'workspace',
      homeId: snapshot.homeId,
      workspaceId: w.workspaceId,
      title: stripNul(w.title),
      path: stripNul(w.path),
      project: projectOf(w),
      archived: w.archived,
      sessionCount: sessionCountByWs.get(w.workspaceId) ?? 0,
    });
  }

  for (const s of asArray(snapshot.sessions)) {
    const ws = wsBySession.get(s.sessionId);
    const cwd = typeof s.cwd === 'string' ? stripNul(s.cwd) : '';
    const normalizedCwd = cwd.replace(/\/+$/, '');
    // dsh 的 sessionIds 只记「被 attach 过的会话」；同一目录里用 CLI / 其它入口跑出来的会话
    // （实测本机 /Volumes/repo/ciao/PMSEQ/PMAID1.0-Production 有 8 个）不在里面，但 cwd 就是
    // 工作区目录。工作区被重命名（改 title）后，这批会话若仍按 basename(cwd) 取名，就会留在
    // 旧目录名的项目卡上 —— 改名只生效一半（工作区行是新名、会话行是旧名，两张卡）。
    // 只用于**取项目名**：workspaceId / workspaceTitle 仍以 dsh 的 sessionIds 为准保持 null，
    // 归属还会被预览 / 下载 / 上传与「打开工作区」使用，不该由一条路径启发式伪造。
    const projectWs = ws ?? (normalizedCwd ? wsByPath.get(normalizedCwd) ?? null : null);
    rows.push({
      type: 'session',
      homeId: snapshot.homeId,
      sessionId: s.sessionId,
      workspaceId: ws?.workspaceId ?? null,
      workspaceTitle: stripNul(ws?.title ?? null),
      project: projectWs ? projectOf(projectWs) : (cwd ? path.basename(cwd) : 'unknown'),
      title: stripNul(s.title || null),
      tokenUsage: JSON.stringify(s.tokenUsage),
      contextPressure: s.contextPressure ? JSON.stringify(s.contextPressure) : null,
      status: s.status ? JSON.stringify(s.status) : null,
      lastActivity: s.lastActivity ?? null,
      generatedAt: snapshot.generatedAt,
    });
  }

  for (const p of asArray(snapshot.providers)) {
    rows.push({
      type: 'provider',
      homeId: snapshot.homeId,
      ref: stripNul(p.ref),
      provider: p.provider,
    });
  }

  if (snapshot.modelTier) {
    // tiers 全部来自 active scheme（validateModelTierJson 已按 activeId 选出），
    // 因此都标记 active；activeId 是 scheme id，不是 tierId。
    for (const [tierId, t] of Object.entries(snapshot.modelTier.tiers ?? {})) {
      if (!t || typeof t !== 'object') continue;
      rows.push({
        type: 'modelTier',
        homeId: snapshot.homeId,
        tierId,
        active: true,
        provider: t.provider,
        model: t.model,
      });
    }
  }

  return rows;
}
