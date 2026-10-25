import { test } from 'node:test';
import assert from 'node:assert/strict';

// 「默认静音项目」内核：纯函数，不碰 DOM。
//
// 背景：relic-distill-cwd 这类批量/自动化项目会持续产出同名会话（"Distill durable knowledge
// from the"），实测最近 50 条里 26 条来自它 —— 把其它项目的会话挤出视野。用户要求默认过滤掉。
// 这里锁的是「默认值 / 用户显式覆盖 / 什么时候不隐藏 / 提示文案」四条口径：
//   · localStorage 没有 key → 内置默认；显式 [] → 什么都不隐藏（默认不再回来）；
//   · 项目筛选是显式选择（点开被隐藏项目就是要看它）→ 不隐藏；
//   · 点「显示」临时全显；「恢复隐藏」回到默认；
//   · 隐藏了多少必须**可见地**说明，否则用户会以为会话丢了。

const {
  MUTED_PROJECTS_KEY, DEFAULT_MUTED_PROJECTS, normalizeMutedProjects,
  readMutedProjects, writeMutedProjects, toggleMutedProject, splitMutedSessions, mutedNoteSpec, renderMutedNote, renderMutedIdleNote,
} = await import('../src/web/components/session-mute.js');

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    dump: () => Object.fromEntries(map),
  };
}

const session = (project, id = 's1') => ({ homeId: 'h1', sessionId: id, project, title: `${project} 会话` });

test('normalizeMutedProjects：去空白/去重/忽略脏值，保持顺序', () => {
  assert.deepEqual(normalizeMutedProjects([' b ', 'a', 'b', '', '  ', null, 42, {}]), ['b', 'a']);
  assert.deepEqual(normalizeMutedProjects('relic'), [], '非数组一律当空（调用方会回默认）');
  assert.deepEqual(normalizeMutedProjects(undefined), []);
});

test('readMutedProjects：没有 key 用内置默认；显式 [] 尊重「不隐藏」；坏数据回默认', () => {
  assert.deepEqual(readMutedProjects(fakeStorage()), DEFAULT_MUTED_PROJECTS, '首次打开 = 默认静音');
  assert.deepEqual(DEFAULT_MUTED_PROJECTS, ['relic-distill-cwd'], '用户明确要求默认隐藏的批量项目');

  const explicitEmpty = fakeStorage({ [MUTED_PROJECTS_KEY]: '[]' });
  assert.deepEqual(readMutedProjects(explicitEmpty), [], '用户清空后默认值不能又冒出来');

  const valid = fakeStorage({ [MUTED_PROJECTS_KEY]: '["a"," a ","b"]' });
  assert.deepEqual(readMutedProjects(valid), ['a', 'b']);

  for (const broken of ['not json', '{"a":1}', '"relic"', '']) {
    const storage = fakeStorage({ [MUTED_PROJECTS_KEY]: broken });
    assert.deepEqual(readMutedProjects(storage), DEFAULT_MUTED_PROJECTS, `坏数据回默认：${broken}`);
  }
  assert.deepEqual(readMutedProjects(null), DEFAULT_MUTED_PROJECTS, 'storage 不可用也不能崩');
});

test('write/toggle：持久化与增删（已有项目再点 = 取消）', () => {
  const storage = fakeStorage();
  assert.equal(writeMutedProjects(storage, ['relic-distill-cwd', 'x']), true);
  assert.deepEqual(JSON.parse(storage.getItem(MUTED_PROJECTS_KEY)), ['relic-distill-cwd', 'x']);
  assert.deepEqual(readMutedProjects(storage), ['relic-distill-cwd', 'x']);

  assert.deepEqual(toggleMutedProject(['a'], 'b'), ['a', 'b'], '加入');
  assert.deepEqual(toggleMutedProject(['a', 'b'], 'a'), ['b'], '再点一次 = 取消隐藏');
  assert.deepEqual(toggleMutedProject(['a'], '  '), ['a'], '空项目名不产生垃圾项');
  assert.deepEqual(toggleMutedProject(['a', 'a'], 'b'), ['a', 'b'], '重复项被归一');
  assert.equal(writeMutedProjects(null, ['a']), false, 'storage 不可用时静默失败（本次仍生效）');
});

test('splitMutedSessions：默认隐藏静音项目；显示/项目筛选覆盖默认', () => {
  const sessions = [session('relic-distill-cwd', 'r1'), session('hwb', 'h1'), session('relic-distill-cwd', 'r2')];
  const muted = ['relic-distill-cwd'];

  const byDefault = splitMutedSessions(sessions, { mutedProjects: muted });
  assert.deepEqual(byDefault.visible.map((s) => s.sessionId), ['h1']);
  assert.deepEqual(byDefault.hidden.map((s) => s.sessionId), ['r1', 'r2']);
  assert.deepEqual(byDefault.projects, ['relic-distill-cwd'], '去重后的项目名，供提示文案说明');

  const shown = splitMutedSessions(sessions, { mutedProjects: muted, showMuted: true });
  assert.equal(shown.visible.length, 3);
  assert.equal(shown.hidden.length, 0);
  assert.equal(shown.muted.length, 2, '「按默认规则本该隐藏」的那份不能因为点过显示就丢掉（提示条要用它）');

  const filteredProject = splitMutedSessions(sessions, { mutedProjects: muted, projectFilter: 'relic-distill-cwd' });
  assert.equal(filteredProject.visible.length, 3, '显式点开这个项目时不能把它藏空');
  assert.equal(filteredProject.hidden.length, 0);
  assert.equal(filteredProject.muted.length, 2, '显式项目视图同样保留 should-hide 列表（筛选条用）');

  const noMuted = splitMutedSessions(sessions, { mutedProjects: [] });
  assert.equal(noMuted.visible.length, 3, '静音列表为空 = 完全不过滤');
});

test('splitMutedSessions：空/脏输入不崩，hidden 项目名保持去重顺序', () => {
  assert.deepEqual(splitMutedSessions(null, { mutedProjects: ['a'] }), { visible: [], hidden: [], muted: [], projects: [] });
  assert.deepEqual(splitMutedSessions([null, session('a'), undefined], { mutedProjects: ['a'] }).hidden.length, 1);
  const projects = splitMutedSessions([session('b'), session('a'), session('b')], { mutedProjects: ['b', 'a'] }).projects;
  assert.deepEqual(projects, ['b', 'a']);
});

test('renderMutedNote：隐藏时可见说明 + 显示按钮；显示态给恢复按钮；搜索态文案区分', () => {
  const hidden = [session('relic-distill-cwd'), session('relic-distill-cwd', 's2')];
  const note = renderMutedNote({ hiddenSessions: hidden });
  assert.match(note, /class="muted-note"/);
  assert.match(note, /已按默认规则隐藏 <b>2<\/b> 条会话/);
  assert.match(note, /「relic-distill-cwd」/);
  assert.match(note, /data-action="show-muted-sessions"/);
  assert.match(note, />显示</);

  const shown = renderMutedNote({ hiddenSessions: hidden, showMuted: true });
  assert.match(shown, /已显示默认隐藏的 <b>2<\/b> 条会话/);
  assert.match(shown, /data-action="hide-muted-sessions"/);

  const searching = renderMutedNote({ hiddenSessions: hidden, filtering: true });
  assert.match(searching, /<b>2<\/b> 条匹配会话被默认规则隐藏/);

  assert.equal(renderMutedNote({ hiddenSessions: [] }), '', '没有隐藏行时不占位');
  assert.equal(renderMutedNote(), '');
});

test('renderMutedNote：项目名来自索引元数据，必须转义', () => {
  const evil = 'x"><img src=x onerror=alert(1)>';
  const note = renderMutedNote({ hiddenSessions: [session(evil)] });
  assert.doesNotMatch(note, /<img/);
  assert.match(note, /&lt;img/);
});

// 接线回归：提示条入参必须用 split.muted，而不是 split.hidden。
// 真实缺陷：点「显示」后 split.hidden 为空 → 提示条不渲染 → 「恢复隐藏」入口消失，只能刷新页面。
test('mutedNoteSpec：显示态仍然给出提示（含恢复隐藏入口）；项目筛选态不画', () => {
  const sessions = [session('relic-distill-cwd', 'r1'), session('hwb', 'h1')];
  const muted = ['relic-distill-cwd'];

  const hiddenSplit = splitMutedSessions(sessions, { mutedProjects: muted });
  assert.deepEqual(mutedNoteSpec(hiddenSplit, { showMuted: false }), {
    hiddenSessions: [sessions[0]],
    showMuted: false,
    filtering: false,
  });

  const shownSplit = splitMutedSessions(sessions, { mutedProjects: muted, showMuted: true });
  const shownSpec = mutedNoteSpec(shownSplit, { showMuted: true });
  assert.ok(shownSpec, '点「显示」后提示条不能消失（否则无法恢复隐藏）');
  const note = renderMutedNote(shownSpec);
  assert.match(note, /已显示默认隐藏的 <b>1<\/b> 条会话/);
  assert.match(note, /data-action="hide-muted-sessions"/, '必须能点回「恢复隐藏」');

  // 项目筛选是显式视图：筛选条里已有「隐藏/取消隐藏」，不重复画提示条。
  assert.equal(mutedNoteSpec(hiddenSplit, { projectFilter: 'relic-distill-cwd' }), null);
  assert.equal(mutedNoteSpec({ muted: [] }, {}), null);
  assert.equal(mutedNoteSpec(null, {}), null);
});

// 默认静音被关掉后的恢复入口：用户可能只是误点了「取消默认隐藏」，之后没有任何提示，
// 会以为「隐藏功能坏了」。静音列表为空 + 内置默认非空时必须给一条恢复提示。
test('renderMutedIdleNote：静音列表为空时给出「恢复默认静音」入口；非空时不画', () => {
  const idle = renderMutedIdleNote({ mutedProjects: [] });
  assert.match(idle, /class="muted-note muted-idle"/);
  assert.match(idle, /默认静音已关闭（「relic-distill-cwd」）/);
  assert.match(idle, /data-action="reset-muted-projects"/);
  assert.match(idle, />恢复默认静音</);

  assert.equal(renderMutedIdleNote({ mutedProjects: ['x'] }), '', '还有静音项目时不需要恢复入口');
  assert.equal(renderMutedIdleNote({ mutedProjects: [], defaultMutedProjects: [] }), '');
  const evil = renderMutedIdleNote({ mutedProjects: [], defaultMutedProjects: ['x"><img src=x>'] });
  assert.doesNotMatch(evil, /<img/);
});
