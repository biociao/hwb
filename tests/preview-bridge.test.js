import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// preview-bridge 的单元测试（最小假 DOM）。桥接跑在内嵌 dsh 页里，负责把
// 「点文件路径 / 产物按钮」翻译成 hwb 的预览请求，并在 dsh 自己去调宿主
// xdg-open 失败时补一个走 hwb 预览的入口。这里覆盖三类形态：
//   ① dsh 当前形态：<code><button title=路径 aria-label="打开 路径"></button></code>
//   ② 旧形态：data-path / a[href] / 裸 code 文本
//   ③ 兜底：dsh 的「path open failed」提示（远端 Linux 上 xdg-open 必然失败）
const source = readFileSync(new URL('../src/web/preview-bridge.js', import.meta.url), 'utf8');

function fakeElement({ tag = 'DIV', title = null, label = null, dataPath = null, dataFilePath = null, href = null, text = '', produced = false, attrs = {} } = {}) {
  const element = {
    tagName: tag,
    nodeType: 1, // 元素节点：桥接的兜底逻辑只处理 nodeType === 1 的新增节点
    style: {},
    dataset: { ...(dataPath ? { path: dataPath } : {}), ...(dataFilePath ? { filePath: dataFilePath } : {}) },
    textContent: text,
    children: [],
    handlers: {},
    getAttribute(name) {
      if (name === 'title') return title;
      if (name === 'aria-label') return label;
      if (name === 'href') return href;
      return attrs[name] ?? null;
    },
    setAttribute(name, value) { attrs[name] = String(value); },
    matches(selector) {
      const parts = selector.split(',').map((s) => s.trim());
      return parts.includes(tag.toLowerCase()) || (parts.includes('code') && tag === 'CODE') || (parts.includes('[role="alert"]') && attrs.role === 'alert');
    },
    closest(selector) {
      const parts = selector.split(',').map((s) => s.trim());
      if (parts.some((s) => s.includes('button[title][aria-label]'))) {
        return tag === 'BUTTON' && title != null && label != null ? element : null;
      }
      if (parts.some((s) => s.includes('button[title]'))) {
        if (dataPath || dataFilePath) return element;
        return tag === 'BUTTON' && title != null ? element : null;
      }
      if (parts.some((x) => x.includes('a[href]') || x === 'code')) return (tag === 'A' && href) ? element : (tag === 'CODE' ? element : null);
      if (parts.includes('[data-produced-files-row]')) return produced ? element : null;
      if (parts.includes('textarea, input, [contenteditable="true"]')) return null;
      if (parts.includes('pre')) return null;
      if (parts.some((s) => s.startsWith('div, section'))) return tag === 'DIV' ? element : null;
      return null;
    },
    querySelectorAll(selector) {
      const wanted = selector.split(',').map((s) => s.trim().toLowerCase());
      const found = [];
      for (const child of element.children) {
        if (wanted.includes(child.tagName.toLowerCase())) found.push(child);
        found.push(...child.querySelectorAll(selector));
      }
      return found;
    },
    addEventListener(type, handler) { element.handlers[type] = handler; },
    querySelector(selector) {
      return element.children.find((child) => {
        if (selector.includes('[data-hwb-preview-open]')) return child.getAttribute('data-hwb-preview-open') != null;
        return child.tagName?.toLowerCase() === selector.toLowerCase();
      }) ?? null;
    },
    appendChild(child) { element.children.push(child); return child; },
  };
  return element;
}

// 桥接运行环境：返回 { messages, clickOn, fireMutation }
function mount({ dialogRoots = [] } = {}) {
  const listeners = {};
  const messages = [];
  let mutationCallback;
  const win = {
    parent: { postMessage: (data, origin) => messages.push({ data, origin }) },
    addEventListener: (type, fn) => { listeners[type] = fn; },
  };
  const docListeners = {};
  const observers = [];
  let observed = false;
  runInNewContext(source, {
    window: win,
    document: {
      referrer: '',
      querySelectorAll: () => dialogRoots,
      createElement: (tag) => fakeElement({ tag: tag.toUpperCase() }),
      addEventListener: (type, fn) => { docListeners[type] = fn; },
    },
    URL,
    MutationObserver: class {
      constructor(callback) { mutationCallback = callback; observers.push(callback); }
      observe() { observed = true; }
    },
    location: { href: 'http://127.0.0.1:5555/?session=s1' },
  });
  assert.equal(observed, true, '桥接应当启动 MutationObserver');
  assert.equal(typeof listeners.click, 'function', '桥接应当注册 click 监听');
  listeners.message({ source: win.parent, origin: 'http://127.0.0.1:4310', data: { type: 'hwb:preview-init' } });
  return {
    messages,
    clickOn(target, options = {}) {
      const event = {
        button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, target,
        prevented: false, stopped: false,
        preventDefault() { this.prevented = true; },
        stopImmediatePropagation() { this.stopped = true; },
        ...options,
      };
      listeners.click(event);
      return event;
    },
    // 桥接会挂两个 MutationObserver（上下文上报 + 失败提示兜底），两个都触发。
    fireMutation(addedNode) {
      void mutationCallback;
      for (const callback of observers) callback([{ addedNodes: [addedNode] }]);
    },
    clickOnDocument(target, options = {}) {
      const event = {
        button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, target,
        prevented: false, stopped: false,
        preventDefault() { this.prevented = true; },
        stopImmediatePropagation() { this.stopped = true; },
        ...options,
      };
      docListeners.click(event);
      return event;
    },
  };
}

const last = (messages) => messages.at(-1)?.data;

test('bridge: dsh mention buttons (code>button，title + 打开 标签) 会被拦截', () => {
  for (const prefix of ['打开 ', 'Open ']) {
    const rig = mount();
    const file = '/home/bot/PMAID/analyses/ver18_1_review/REVIEW.md';
    const event = rig.clickOn(fakeElement({ tag: 'BUTTON', title: file, label: prefix + file, text: 'REVIEW.md' }));
    assert.equal(event.prevented, true, `未被拦截：${prefix}`);
    assert.equal(event.stopped, true);
    assert.equal(last(rig.messages).type, 'hwb:file-preview');
    assert.equal(last(rig.messages).path, file);
    assert.equal(last(rig.messages).sessionId, 's1');
  }
});

test('bridge: 产物 chip 与旧形态（data-path / a[href] / code 文本）仍可用', () => {
  const chipRig = mount();
  const chip = fakeElement({ tag: 'BUTTON', title: '/home/bot/PMAID/out.csv', label: '自定义标签', produced: true });
  assert.equal(chipRig.clickOn(chip).prevented, true);
  assert.equal(last(chipRig.messages).path, '/home/bot/PMAID/out.csv');

  const dataRig = mount();
  assert.equal(dataRig.clickOn(fakeElement({ tag: 'SPAN', dataPath: '/home/bot/PMAID/x.py' })).prevented, true);
  assert.equal(last(dataRig.messages).path, '/home/bot/PMAID/x.py');

  const anchorRig = mount();
  assert.equal(anchorRig.clickOn(fakeElement({ tag: 'A', href: '/home/bot/PMAID/y.txt' })).prevented, true);
  assert.equal(last(anchorRig.messages).path, '/home/bot/PMAID/y.txt');

  const codeRig = mount();
  assert.equal(codeRig.clickOn(fakeElement({ tag: 'CODE', text: 'analyses/ver18_1_review/REVIEW.md' })).prevented, true);
  assert.equal(last(codeRig.messages).path, 'analyses/ver18_1_review/REVIEW.md');
});

test('bridge: 路径带行号时拆出 line，且不动 URL 型链接', () => {
  const rig = mount();
  const file = '/home/bot/PMAID/a.py:42';
  assert.equal(rig.clickOn(fakeElement({ tag: 'BUTTON', title: file, label: '打开 ' + file })).prevented, true);
  assert.deepEqual({ path: last(rig.messages).path, line: last(rig.messages).line }, { path: '/home/bot/PMAID/a.py', line: 42 });

  const web = mount();
  assert.equal(web.clickOn(fakeElement({ tag: 'A', href: 'https://example.com/x.md' })).prevented, false);
});

test('bridge: 不误伤无关按钮与组合键点击', () => {
  const sidebar = mount();
  assert.equal(sidebar.clickOn(fakeElement({ tag: 'BUTTON', title: '侧边栏', label: '打开侧边栏' })).prevented, false);

  const modified = mount();
  const file = '/home/bot/PMAID/a.md';
  assert.equal(modified.clickOn(fakeElement({ tag: 'BUTTON', title: file, label: '打开 ' + file }), { metaKey: true }).prevented, false);
  assert.equal(modified.messages.filter((m) => m.data.type === 'hwb:file-preview').length, 0);
});

test('bridge: path open failed 弹窗 → 补「用 hwb 文件预览打开」入口', () => {
  const alert = fakeElement({
    tag: 'DIV',
    text: '无法打开文件 path open failed: Command failed: xdg-open /home/bot/PMAID/analyses/ver18_1_review/REVIEW.md /usr/bin/xdg-open: 882: www-browser: not found',
  });
  const rig = mount({ dialogRoots: [alert] });
  rig.fireMutation(alert);
  const added = alert.children.find((child) => child.getAttribute('data-hwb-preview-open'));
  assert.ok(added, '未在失败提示里插入预览入口');
  assert.equal(added.getAttribute('data-hwb-preview-open'), '/home/bot/PMAID/analyses/ver18_1_review/REVIEW.md');
  assert.match(added.textContent, /hwb/);
  // 点这个按钮应当发出一条预览请求（父页据此打开侧栏预览）
  const clickEvent = { prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
  added.handlers.click(clickEvent);
  assert.equal(clickEvent.prevented, true);
  assert.equal(last(rig.messages).type, 'hwb:file-preview');
  assert.equal(last(rig.messages).path, '/home/bot/PMAID/analyses/ver18_1_review/REVIEW.md');
  // 重复触发不重复插
  rig.fireMutation(alert);
  assert.equal(alert.children.filter((child) => child.getAttribute('data-hwb-preview-open')).length, 1);
});

test('bridge: 与打开文件无关的弹窗不插按钮', () => {
  const other = fakeElement({ tag: 'DIV', text: '网络连接失败，请重试。' });
  const rig = mount({ dialogRoots: [other] });
  rig.fireMutation(other);
  assert.equal(other.children.length, 0);
  assert.equal(rig.messages.some((m) => m.data.type === 'hwb:file-preview'), false);
});

test('bridge: publishes context initially and after SPA session changes, including clearing it', () => {
  const listeners = {}, messages = [];
  const observers = [];
  const win = { parent: { postMessage: (data) => messages.push(data) }, addEventListener: (type, fn) => { listeners[type] = fn; } };
  const location = { href: 'http://localhost/?session=s1' };
  runInNewContext(source, {
    window: win,
    document: { querySelectorAll: () => [], addEventListener: () => {}, createElement: () => fakeElement({}) },
    URL, location,
    MutationObserver: class { constructor(fn) { observers.push(fn); } observe() {} },
  });
  // observers[0] 是「上下文上报」用的那个（桥接还挂了失败提示兜底用的 observer）。
  const sendContext = observers[0];
  listeners.message({ source: win.parent, origin: 'http://localhost:4310', data: { type: 'hwb:preview-init' } });
  sendContext();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].sessionId, 's1');
  // 上报里同时带完整 URL：父页据此解析会话（当前 dsh 不做 URL 导航，通常为空）。
  assert.equal(messages[0].href, 'http://localhost/?session=s1');
  location.href = 'http://localhost/?session=s2';
  sendContext();
  assert.equal(messages[1].sessionId, 's2');
  location.href = 'http://localhost/';
  listeners.popstate();
  assert.equal(messages[2].sessionId, null);
});

test('bridge: requires initialization from the real parent even when referrer is empty', () => {
  const messages = [];
  const listeners = {};
  const win = { parent: { postMessage: (data) => messages.push(data) }, addEventListener: (type, fn) => { listeners[type] = fn; } };
  runInNewContext(source, { window: win, document: { querySelectorAll: () => [], addEventListener: () => {} }, URL,
    MutationObserver: class { observe() {} }, location: { href: 'http://localhost/?session=s1' } });
  // 来自其它窗口/来源的初始化必须被忽略
  listeners.message({ source: {}, origin: 'http://localhost:4310', data: { type: 'hwb:preview-init' } });
  listeners.message({ source: win.parent, origin: 'null', data: { type: 'hwb:preview-init' } });
  assert.equal(messages.length, 0);
  listeners.message({ source: win.parent, origin: 'http://localhost:4310', data: { type: 'hwb:preview-init' } });
  assert.equal(messages.length, 1);
});
