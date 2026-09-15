import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// dsh-theme-live 的单元测试（最小假 DOM）。
//
// 这个脚本跑在被 hwb 反代的内嵌 dsh 页里，负责把宿主下发的主题**立刻**作用到页面。
// 它写的是 dsh 自己的那套开关（body[data-ds-dark-theme] + root color-scheme），
// 所以这里逐条盯住：写对了属性、system 会跟随媒体查询、非父窗口的消息一律不认。
const source = readFileSync(new URL('../src/web/dsh-theme-live.js', import.meta.url), 'utf8');

function fakeBody() {
  return {
    attrs: {},
    setAttribute(name, value) { this.attrs[name] = String(value); },
    removeAttribute(name) { delete this.attrs[name]; },
    getAttribute(name) { return this.attrs[name] ?? null; },
  };
}

// 断言驱动：mount 后通过 listeners.message 投递消息，读回 body / colorScheme。
function mount({ parentIsSelf = false, systemDark = false, withMatchMedia = true } = {}) {
  const listeners = {};
  const mediaListeners = [];
  const body = fakeBody();
  const rootStyle = {};
  const self = {};
  // 媒体查询是一个**活**的对象：系统翻转会改变它的 matches，也让翻转后的 apply()
  // 重新解析出新的结果（这正是真实 matchMedia 的语义）。
  const mediaState = { matches: systemDark };
  const win = {
    parent: parentIsSelf ? self : { postMessage() {} },
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
  };
  // parent === window 表示脚本没有被嵌进 iframe：那种情况必须整段不生效。
  if (parentIsSelf) win.parent = win;
  const context = {
    window: win,
    document: { body, documentElement: { style: rootStyle } },
    URL,
  };
  if (withMatchMedia) {
    context.matchMedia = () => ({
      get matches() { return mediaState.matches; },
      addEventListener: (type, fn) => { if (type === 'change') mediaListeners.push(fn); },
    });
    win.matchMedia = context.matchMedia;
  }
  runInNewContext(source, context);
  return {
    body,
    rootStyle,
    send(data, { origin = 'http://127.0.0.1:4310', fromParent = true } = {}) {
      for (const fn of listeners.message || []) {
        fn({ source: fromParent ? win.parent : {}, origin, data });
      }
    },
    flipSystem(dark) {
      mediaState.matches = dark;
      for (const fn of mediaListeners) fn({ matches: dark });
    },
    listenerCount: (type) => (listeners[type] || []).length,
  };
}

const DARK = 'data-ds-dark-theme';

test('顶层直接 return：只在被嵌入（parent !== window）时才注册监听', () => {
  const embedded = mount();
  assert.equal(embedded.listenerCount('message'), 1, '被嵌入时应挂 message 监听');
  const standalone = mount({ parentIsSelf: true });
  assert.equal(standalone.listenerCount('message'), 0, '不是 iframe 时不该做任何事');
});

test('hwb:theme-init 明确指定 dark → 打上 dsh 的暗色属性', () => {
  const rig = mount();
  rig.send({ type: 'hwb:theme-init', preference: 'dark' });
  assert.equal(rig.body.getAttribute(DARK), '');
  assert.equal(rig.rootStyle.colorScheme, 'dark');
});

test('hwb:theme-init 明确指定 light → 移除暗色属性（而不是留个空值）', () => {
  const rig = mount();
  rig.send({ type: 'hwb:theme-init', preference: 'dark' });
  assert.equal(rig.body.getAttribute(DARK), '');
  rig.send({ type: 'hwb:theme-init', preference: 'light' });
  assert.equal(rig.body.getAttribute(DARK), null, '必须真的移除，不能只是置空');
  assert.equal(rig.rootStyle.colorScheme, 'light');
});

test('hwb:theme 增量下发也生效（不必重新 load 页面）', () => {
  const rig = mount();
  rig.send({ type: 'hwb:theme-init', preference: 'light' });
  assert.equal(rig.body.getAttribute(DARK), null);
  rig.send({ type: 'hwb:theme', preference: 'dark' });
  assert.equal(rig.body.getAttribute(DARK), '');
});

test('system：按 iframe 自己的媒体查询解析（暗色系统 → 暗）', () => {
  const dark = mount({ systemDark: true });
  dark.send({ type: 'hwb:theme-init', preference: 'system' });
  assert.equal(dark.body.getAttribute(DARK), '');

  const light = mount({ systemDark: false });
  light.send({ type: 'hwb:theme-init', preference: 'system' });
  assert.equal(light.body.getAttribute(DARK), null);
});

test('system + 系统亮暗翻转 → 自动跟随（无需宿主再发消息）', () => {
  const rig = mount({ systemDark: false });
  rig.send({ type: 'hwb:theme-init', preference: 'system' });
  assert.equal(rig.body.getAttribute(DARK), null);
  rig.flipSystem(true);
  assert.equal(rig.body.getAttribute(DARK), '', '系统转暗后应跟随');
  rig.flipSystem(false);
  assert.equal(rig.body.getAttribute(DARK), null, '系统转亮后应跟随');
});

test('明确指定 light/dark 时，系统翻转**不得**覆盖用户选择', () => {
  const rig = mount({ systemDark: false });
  rig.send({ type: 'hwb:theme-init', preference: 'light' });
  rig.flipSystem(true);
  assert.equal(rig.body.getAttribute(DARK), null, 'light 不该被系统翻转改成暗');

  const rig2 = mount({ systemDark: true });
  rig2.send({ type: 'hwb:theme-init', preference: 'dark' });
  rig2.flipSystem(false);
  assert.equal(rig2.body.getAttribute(DARK), '', 'dark 不该被系统翻转改成亮');
});

test('只接受来自真实父窗口的消息（内部 iframe / 兄弟 frame 一律忽略）', () => {
  const rig = mount();
  rig.send({ type: 'hwb:theme-init', preference: 'dark' }, { fromParent: false });
  assert.equal(rig.body.getAttribute(DARK), null, '非父窗口的消息必须忽略');
});

test("origin === 'null'（sandboxed / 无来源）的消息必须忽略", () => {
  const rig = mount();
  rig.send({ type: 'hwb:theme-init', preference: 'dark' }, { origin: 'null' });
  assert.equal(rig.body.getAttribute(DARK), null);
});

test('init 之后来自**别处 origin** 的 theme 消息不生效（防止串台）', () => {
  const rig = mount();
  rig.send({ type: 'hwb:theme-init', preference: 'light' });
  rig.send({ type: 'hwb:theme', preference: 'dark' }, { origin: 'http://evil.example' });
  assert.equal(rig.body.getAttribute(DARK), null);
});

test('未知 preference（含非字符串）按 system 处理，不抛错', () => {
  for (const value of ['purple', 42, null, undefined, {}]) {
    const rig = mount({ systemDark: true });
    rig.send({ type: 'hwb:theme-init', preference: value });
    assert.equal(rig.body.getAttribute(DARK), '', `preference=${JSON.stringify(value)} 应按 system→暗`);
  }
});

test('无关消息与畸形消息不影响当前主题', () => {
  const rig = mount();
  rig.send({ type: 'hwb:theme-init', preference: 'dark' });
  rig.send({ type: 'hwb:preview-init' });
  rig.send({ type: 'other' });
  rig.send(null);
  rig.send('string');
  assert.equal(rig.body.getAttribute(DARK), '');
});

test('没有 matchMedia 的环境下 system 退化为亮色且不抛错', () => {
  const rig = mount({ withMatchMedia: false });
  rig.send({ type: 'hwb:theme-init', preference: 'system' });
  assert.equal(rig.body.getAttribute(DARK), null);
});
