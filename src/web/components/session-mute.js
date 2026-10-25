import { esc } from '../store.js';

// 「默认静音项目」：批量/自动化项目会在 Recent Sessions 里持续产出成百上千条同名会话，
// 把其它项目的会话挤出视野。用户明确要求：**默认过滤掉 relic 的 distill 相关会话**
// （`relic-distill-cwd` 项目下大量 "Distill durable knowledge from the"，实测最近 50 条里
// 26 条来自它）。
//
// 设计取舍：
//   · 这是**默认值**，不是硬编码过滤器：用户点过一次「取消隐藏」后，localStorage 里写入
//     显式列表（`[]` 表示什么都不隐藏），默认值就不再回来；
//   · 只在**默认视图**隐藏：项目筛选是用户的显式选择（点开被隐藏项目就是想看它），
//     此时不隐藏；「显示」按钮也能临时展示全部隐藏会话；
//   · 过滤只发生在前端展示层：接口数据、项目卡上的 sessionCount、搜索命中的原始数据都不变，
//     所以随时能看回来，也不会因为隐藏而让某条会话「搜不到却不知道去哪了」。
export const MUTED_PROJECTS_KEY = 'hwb:muted-projects';
export const DEFAULT_MUTED_PROJECTS = ['relic-distill-cwd'];

// 归一化：只要非空字符串，去首尾空白、去重、保序。脏数据不能让整栏列表消失。
export function normalizeMutedProjects(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const name = typeof item === 'string' ? item.trim() : '';
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

// 读取偏好。key 不存在 → 内置默认；存在但坏 → 也回默认（不能因为一条坏数据变成「全显示」，
// 那会让用户以为功能失效）；显式存了 `[]` → 尊重「什么都不隐藏」。
export function readMutedProjects(storage) {
  try {
    const raw = storage?.getItem?.(MUTED_PROJECTS_KEY);
    if (raw == null) return [...DEFAULT_MUTED_PROJECTS];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? normalizeMutedProjects(parsed) : [...DEFAULT_MUTED_PROJECTS];
  } catch {
    return [...DEFAULT_MUTED_PROJECTS];
  }
}

export function writeMutedProjects(storage, projects) {
  if (!storage || typeof storage.setItem !== 'function') return false;
  try {
    storage.setItem(MUTED_PROJECTS_KEY, JSON.stringify(normalizeMutedProjects(projects)));
    return true;
  } catch {
    return false; // storage 不可用（隐私模式/配额）时本次生效，下次回到默认
  }
}

export function toggleMutedProject(projects, project) {
  const name = String(project ?? '').trim();
  const list = normalizeMutedProjects(projects);
  if (!name) return list;
  return list.includes(name) ? list.filter((p) => p !== name) : [...list, name];
}

// 把会话切成「显示 / 默认隐藏」两半。
//   · showMuted=true（用户点了「显示」）或 projectFilter 非空（显式点开了某个项目）→ 不隐藏；
//   · 其余情况隐藏 project ∈ mutedProjects 的会话。
// 返回：
//   · visible —— 当前应该渲染的会话（显式显示 / 项目筛选覆盖时 = 全部）；
//   · hidden  —— **当前真的被藏起来**的会话（空状态下用来判断「不是没有、是被藏了」）；
//   · muted   —— **按默认规则本应隐藏**的会话，不受 showMuted / projectFilter 影响；
//                提示条必须用它算条数，否则「已显示默认隐藏的 N 条 · 恢复隐藏」永远画不出来
//                （showMuted=true 时 hidden 一定是空的 —— 这是真实踩过的接线缺陷）。
//   · projects—— muted 里的项目名（去重），供提示文案说明。
export function splitMutedSessions(sessions, { mutedProjects = [], showMuted = false, projectFilter = null } = {}) {
  const list = Array.isArray(sessions) ? sessions.filter(Boolean) : [];
  const mutedSet = new Set(normalizeMutedProjects(mutedProjects));
  const muted = [];
  const unmuted = [];
  for (const session of list) {
    if (mutedSet.has(String(session.project ?? ''))) muted.push(session);
    else unmuted.push(session);
  }
  const override = showMuted === true || projectFilter != null;
  const visible = override ? list : unmuted;
  const hidden = override ? [] : muted;
  const projects = [...new Set(muted.map((s) => String(s.project ?? '').trim()).filter(Boolean))];
  return { visible, hidden, muted, projects };
}

// 提示条的**入参合成**（这一层单独抽出来是为了能被纯函数测试覆盖接线：
// 曾经 app.js 把 split.hidden 传给提示条，showMuted=true 时它是空的 →
// 「恢复隐藏」入口消失，单元测试却全绿）。
// 项目筛选是显式视图，不画提示条（筛选条里已有「隐藏/取消隐藏」）；没有静音会话时也不画。
export function mutedNoteSpec(split, { showMuted = false, filtering = false, projectFilter = null } = {}) {
  if (projectFilter != null) return null;
  const muted = Array.isArray(split?.muted) ? split.muted.filter(Boolean) : [];
  if (!muted.length) return null;
  return { hiddenSessions: muted, showMuted: showMuted === true, filtering: filtering === true };
}

// 隐藏/显示提示条。默认隐藏时必须**可见**地说明「不是没有，是被默认规则藏了」，
// 并把「显示」放在原地 —— 否则用户会以为会话真的没了。
// filtering：搜索/筛选态下文案改成「匹配会话被隐藏」，不要让人误以为搜索没有命中。
export function renderMutedNote({ hiddenSessions = [], showMuted = false, filtering = false } = {}) {
  const hidden = Array.isArray(hiddenSessions) ? hiddenSessions.filter(Boolean) : [];
  if (!hidden.length) return '';
  const names = [...new Set(hidden.map((s) => String(s.project ?? '').trim()).filter(Boolean))];
  const label = names.length
    ? `${names.slice(0, 2).map((n) => `「${esc(n)}」`).join('、')}${names.length > 2 ? ` 等 ${names.length} 个项目` : ''}`
    : '默认隐藏的项目';
  const count = `<b>${hidden.length}</b>`;
  const text = showMuted
    ? `已显示默认隐藏的 ${count} 条会话（${label}）`
    : filtering
      ? `${count} 条匹配会话被默认规则隐藏（${label}）`
      : `已按默认规则隐藏 ${count} 条会话（${label}）`;
  const button = showMuted
    ? '<button type="button" data-action="hide-muted-sessions">恢复隐藏</button>'
    : '<button type="button" data-action="show-muted-sessions">显示</button>';
  return `<div class="muted-note">${text}${button}</div>`;
}

// 默认静音被关掉时的恢复入口。
//
// 为什么需要：默认列表是「一次性」偏好 —— 点过一次「取消默认隐藏」就会写入显式空列表
// （这是设计），但用户可能只是误点/试探，之后既看不到提示条、也不知道怎么把默认规则找回来，
// 只能认为「隐藏功能坏了」。所以在静音列表为空（且内置默认非空）时给一条弱提示 + 恢复按钮。
export function renderMutedIdleNote({ mutedProjects = [], defaultMutedProjects = DEFAULT_MUTED_PROJECTS } = {}) {
  const muted = normalizeMutedProjects(mutedProjects);
  if (muted.length) return '';
  const defaults = normalizeMutedProjects(defaultMutedProjects);
  if (!defaults.length) return '';
  const names = defaults.slice(0, 2).map((n) => `「${esc(n)}」`).join('、');
  return `<div class="muted-note muted-idle">默认静音已关闭（${names}）
    <button type="button" data-action="reset-muted-projects">恢复默认静音</button></div>`;
}
