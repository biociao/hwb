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
