import { esc } from '../store.js';

// 顶栏搜索框的过滤内核：纯函数，不碰 DOM。
//
// 为什么单独成模块：过滤规则（大小写、全角/半角、空查询、回退字段、计数口径）是搜索框的
// 全部行为；把它留在 app.js 里就只能靠真浏览器验证。这里输入 → 输出的形状固定，
// tests/search-filter.test.js 可以直接覆盖边界。
//
// 匹配口径只认**用户看得见的名字**，不做模糊/拼音/分词：
//   · 项目 = 项目名（recent-projects.js 卡片上的 .name）；
//   · 会话 = 标题（缺省回退工作区名）+ 所属项目名（会话卡上的项目 chip）。
// 于是「搜项目名 → Sessions 栏也只剩该项目的会话」是同一套规则的自然结果，不是特例分支。
// 不匹配 sessionId：它不是名字，而且 UUID 的公共前缀会让「敲几个字母就全命中」变成噪音。

// NFKC 把全角「ＡＢＣ」「１」折叠成半角 —— 中文输入法下常常混着全角字符；
// toLowerCase 因为项目名/标题大小写并不稳定（PMAID / pmaid 都有）；
// trim 因为「输入框里只剩空格」对用户来说就是没在搜，不该把列表筛成 0 条。
export function normalizeQuery(raw) {
  return String(raw ?? '').normalize('NFKC').toLowerCase().trim();
}

function includesAny(values, query) {
  if (!query) return true;
  return values.some((value) => String(value ?? '').normalize('NFKC').toLowerCase().includes(query));
}

export function projectMatches(project, query) {
  return includesAny([project?.project], normalizeQuery(query));
}

export function sessionMatches(session, query) {
  // 与 recent-sessions.js 的标题回退链保持同一口径：卡片显示哪个名字，就用哪些字段匹配。
  // project 单独列出：会话卡上的项目 chip 也是一个名字，搜项目名应能把它的会话一起筛出来。
  return includesAny([session?.title, session?.workspaceTitle, session?.project], normalizeQuery(query));
}

// 按项目名**精确**过滤会话（不是搜索：大小写/子串都不折叠）。
//
// 服务端 /api/sessions/recent?project= 已经做了一次精确过滤，这里为什么还要再做一次？
// 因为前端文件是「每次请求都从磁盘取」的静态资源，而服务端进程是**启动时加载**的：
// 升级后只刷新浏览器、没重启 hwb 时，会出现「新前端 + 旧后端」的混合状态 —— 旧后端不认识
// project 参数，会把**全局最近 200 条**当成项目会话返回，于是筛选条写着 PMAID-GPPH、列表里
// 却混着 relic-distill-cwd 的会话（实测真实发生）。前端兜底再过滤一次，混合状态下至少
// 不会显示错的行；重启后端后就变成一次无害的空操作。
export function filterExactProject(sessions, project) {
  const name = String(project ?? '');
  const list = Array.isArray(sessions) ? sessions.filter(Boolean) : [];
  if (!name) return list;
  return list.filter((s) => String(s.project ?? '') === name);
}

// 过滤 + 计数：列表渲染前的唯一一道口径。
// connectedIds 是已连接实例的 homeId 集合；为空表示「当前没有可展示的数据源」，
// 此时返回空列表与 null 计数（渲染方画「连接实例后显示…」空态）。
// 计数在过滤时变成「命中/总数」字符串：让用户一眼区分「真的没有这条」与「被自己筛掉了」。
export function filterRecent({ projects = [], sessions = [], connectedIds = null, query = '' } = {}) {
  const q = normalizeQuery(query);
  const filtering = q !== '';
  const connected = !!(connectedIds && connectedIds.size);
  const allowed = (item) => connectedIds.has(item?.homeId);
  const visibleProjects = connected ? projects.filter(allowed) : [];
  const visibleSessions = connected ? sessions.filter(allowed) : [];
  const shownProjects = filtering ? visibleProjects.filter((p) => projectMatches(p, q)) : visibleProjects;
  const shownSessions = filtering ? visibleSessions.filter((s) => sessionMatches(s, q)) : visibleSessions;
  const count = (shown, total) => (filtering ? `${shown.length}/${total}` : total);
  return {
    filtering,
    query: q,
    connected,
    projects: shownProjects,
    sessions: shownSessions,
    totalProjects: visibleProjects.length,
    totalSessions: visibleSessions.length,
    projectCount: connected ? count(shownProjects, visibleProjects.length) : null,
    sessionCount: connected ? count(shownSessions, visibleSessions.length) : null,
  };
}

// 过滤后为 0 条时的空态：说清「是筛掉的、不是没有」，并把出路（清除搜索）放在原地。
// query 来自用户输入 → 必须 esc 后再进 innerHTML（与其它卡片同一条规矩）。
export function searchEmptyHtml(label, query) {
  const text = String(query ?? '').trim();
  return `<div class="empty search-empty">没有匹配「${esc(text)}」的${label}`
    + '<button type="button" data-action="clear-search">清除搜索</button></div>';
}

// 全库补搜还在路上、最近列表里又暂时没有命中时的占位。
// 为什么需要：搜索会先做本地过滤、再发 /api/search；历史命中要等后端的响应。
// 这几十~几百毫秒里如果直接画「没有匹配」，用户会以为真的没有，然后在结果出现时看到
// 列表自己跳出来 —— 先说「正在全库检索」，语义才对。
export function searchPendingHtml(label, query) {
  return `<div class="empty search-empty">正在全库检索「${esc(String(query ?? '').trim())}」的${label}…</div>`;
}

// —— 全库补搜结果与「最近列表」的合并 ——
//
// 分工（为什么不是直接用检索结果替换列表）：
//   · 最近列表已经在屏幕上，直接替换会让「输入第一个字」时整栏跳变；
//   · 最近列表的项目卡带有 7 天窗口内的聚合与跳转目标，检索结果的行虽然同构，
//     但「最近」这两个字本身也是信息，丢掉反而退步。
// 所以：最近行优先（去重时保留最近那行），检索结果只补最近列表里没有的行，并打
// historical 标记（组件渲染成「历史」chip，让用户知道它为什么不在 Recent 里）。
//
// 去重口径：
//   · 项目按 project 名（recentProjects / searchAll 都按项目名跨实例聚合）；
//   · 会话按 homeId + sessionId（同一条会话可能被不同实例索引到）。
// 合并后按最后活动时间倒序：历史命中可能比最近列表的末位还新（recentProjects 会把
// 无会话的 workspace 追加在末尾），不能一律 append 到尾部。
const activityMs = (row) => {
  const t = Date.parse(row?.lastActivity ?? '');
  return Number.isFinite(t) ? t : -Infinity;
};

export function mergeSearchResults({ projects = [], sessions = [], searchedProjects = [], searchedSessions = [] } = {}) {
  // 入参来自网络（最近列表）与接口（检索结果），任一侧都可能带空行；先滤掉再建 key，
  // 否则 null 会一路漏进排序与渲染。
  const baseProjects = projects.filter(Boolean);
  const baseSessions = sessions.filter(Boolean);
  const projectKeys = new Set(baseProjects.map((p) => String(p.project ?? '')));
  const sessionKeys = new Set(baseSessions.map((s) => `${s.homeId ?? ''}\u0000${s.sessionId ?? ''}`));
  const extraProjects = (Array.isArray(searchedProjects) ? searchedProjects : [])
    .filter((p) => p && !projectKeys.has(String(p.project ?? '')))
    .map((p) => ({ ...p, historical: true }));
  const extraSessions = (Array.isArray(searchedSessions) ? searchedSessions : [])
    .filter((s) => s && !sessionKeys.has(`${s.homeId ?? ''}\u0000${s.sessionId ?? ''}`))
    .map((s) => ({ ...s, historical: true }));
  return {
    projects: [...baseProjects, ...extraProjects].sort((a, b) => activityMs(b) - activityMs(a)),
    sessions: [...baseSessions, ...extraSessions].sort((a, b) => activityMs(b) - activityMs(a)),
  };
}
