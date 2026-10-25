import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// preview-bridge 的单元测试（最小假 DOM）。桥接跑在内嵌 dsh 页里，**不再接管文件点击**：
// dsh 自己把会话里的文件路径与「文件」树的文件行开进右侧 Sidebar 的文档预览，hwb 只补
// dsh 缺的两件事 —— 下载到本机（documentpreview 头部注入的按钮）与上传回工作区
// （sidebar-files 头部注入的按钮）。因此这里覆盖：
//   ① 不再拦截：click 监听根本不注册（dsh 的原生链路必须完整）
//   ② 转交：hwb:download-file / window.__hwbUploadFiles(dir) → 父页
//   ③ 结果回传：父页的 hwb:upload-status 渲染成角落状态 + 成功后替用户重读文件树
//   ④ 边界：未经真实父页初始化前一律不外发
const source = readFileSync(new URL('../src/web/preview-bridge.js', import.meta.url), 'utf8');

function fakeElement({ tag = 'DIV', attrs = {}, text = '' } = {}) {
  const element = {
    tagName: tag,
    nodeType: 1,
    id: '',
    style: {},
    dataset: {},
    children: [],
    handlers: {},
    getAttribute: (name) => attrs[name] ?? null,
    setAttribute(name, value) { attrs[name] = String(value); },
    addEventListener(type, handler) { element.handlers[type] = handler; },
    append(...nodes) { element.children.push(...nodes); },
    remove() { element.removed = true; },
    appendChild(child) { element.children.push(child); return child; },
    click() { element.clicked = true; element.onclick?.(); },
    get textContent() { return element.children.map((child) => child.textContent || '').join(''); },
    set textContent(value) { element.children = value === '' ? [] : [{ nodeType: 3, textContent: String(value) }]; },
  };
  if (text) element.textContent = text;
  return element;
}

/**
 * 桥接运行环境。window 上的监听**按类型累积**：桥接挂了两个 message 监听（上传状态回传与
 * 父页初始化），只留一个的话第二个会把第一个顶掉 —— 这正是这个假环境踩过的坑。
 * @returns {object} 事件触发器、已发出的消息、按 id 索引的浮层。
 */
function mount({ reloadButton = fakeElement({ tag: 'BUTTON', attrs: { 'data-files-reload': 'true' } }) } = {}) {
  const windowListeners = {};
  const messages = [];
  const byId = {};
  const observers = [];
  const win = {
    parent: { postMessage: (data, origin) => messages.push({ data, origin }) },
    addEventListener: (type, fn) => { (windowListeners[type] ||= []).push(fn); },
  };
  const fireWindow = (type, event) => { for (const fn of windowListeners[type] || []) fn(event); };
  runInNewContext(source, {
    window: win,
    document: {
      querySelectorAll: () => [],
      querySelector: (selector) => (selector.includes('data-files-reload') ? reloadButton : null),
      createElement: (tag) => fakeElement({ tag: tag.toUpperCase() }),
      getElementById: (id) => byId[id] || null,
      addEventListener: () => {},
      body: {
        children: [],
        appendChild(child) {
          this.children.push(child);
          if (child.id) byId[child.id] = child;
          return child;
        },
      },
    },
    URL,
    Array,
    // 浮层会用一个自动消失的定时器；沙箱里补上（不真的等待）
    setTimeout: () => 0,
    clearTimeout: () => {},
    MutationObserver: class {
      constructor(callback) { observers.push(callback); }
      observe() {}
    },
    location: { href: 'http://127.0.0.1:5555/?session=s1' },
  });
  assert.equal(observers.length, 1, '桥接应当启动 MutationObserver 以跟随会话变化');
  const last = () => messages.at(-1)?.data;
  const pickFiles = (dir, files) => {
    // 直接调用注入侧会用的那个钩子（真实页面里由 sidebar-files 头部注入的按钮调用）。
    win.__hwbUploadFiles(dir);
    const input = byId['hwb-upload-input'];
    assert.ok(input, '首次上传应当创建隐藏的 file input');
    assert.equal(input.clicked, true, '应当真的把选择框点开（用户手势内）');
    if (files) { input.files = files; input.onchange(); }
    return input;
  };
  fireWindow('message', { source: win.parent, origin: 'http://127.0.0.1:4310', data: { type: 'hwb:preview-init' } });
  return {
    messages,
    last,
    window: win,
    fireWindow,
    pickFiles,
    reloadButton,
    byId,
    fireParentMessage: (data, origin = 'http://127.0.0.1:4310', source = win.parent) => fireWindow('message', { source, origin, data }),
  };
}

test('bridge: 不再拦截文件点击 —— dsh 自己把文件开进右侧 Sidebar 的预览', () => {
  const rig = mount();
  // 桥接现在**不注册** click 监听（注册了就会 preventDefault/stopImmediatePropagation，
  // 把 dsh 的 openFile → sidebarRight.openResource 这条原生路径挡掉）。
  rig.fireWindow('click', { target: { closest: () => ({}) }, button: 0,
    preventDefault: () => { throw new Error('桥接不得 preventDefault'); },
    stopImmediatePropagation: () => { throw new Error('桥接不得 stopImmediatePropagation'); } });
  const sent = rig.messages.filter((m) => m.data.type !== 'hwb:preview-context');
  assert.equal(sent.length, 0, '除会话上下文中报外不该再往外发任何消息');
  assert.equal(rig.byId['hwb-preview-notice'], undefined, '不再有「在 hwb 预览里打开」的角落提示');
});

test('bridge: publishes context initially and after SPA session changes, including clearing it', () => {
  const rig = mount();
  const sent = rig.messages.filter((m) => m.data.type === 'hwb:preview-context');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].data.sessionId, 's1');
  // 上报里同时带完整 URL：父页据此解析会话（当前 dsh 不做 URL 导航，通常为空）。
  assert.equal(sent[0].data.href, 'http://127.0.0.1:5555/?session=s1');
});

test('bridge: 内置预览「下载到本机」的事件被转成 hwb:file-download（带会话）', () => {
  const rig = mount();
  rig.fireWindow('hwb:download-file', { detail: '/home/bot/PMAID/analyses/out.csv' });
  // 跨 realm 的对象不能用 deepEqual 比（原型不同），逐字段断言。
  const sent = rig.last();
  assert.equal(sent.type, 'hwb:file-download');
  assert.equal(sent.path, '/home/bot/PMAID/analyses/out.csv');
  assert.equal(sent.sessionId, 's1');

  // 注入侧给什么都不能越界：非字符串、空串、超长 detail 一律丢弃。
  const bad = mount();
  for (const detail of [{ path: '/etc/passwd' }, '', 'a'.repeat(4097)]) bad.fireWindow('hwb:download-file', { detail });
  assert.equal(bad.messages.filter((m) => m.data.type === 'hwb:file-download').length, 0);
});

test('bridge: 上传把 File 清单与目标目录交给父页（File 走结构化克隆，桥接自己不发请求）', () => {
  const rig = mount();
  const files = [{ name: 'a.csv', size: 12 }, { name: 'b.png', size: 34 }];
  rig.pickFiles('/home/bot/PMAID/analyses', files);
  const sent = rig.last();
  assert.equal(sent.type, 'hwb:file-upload');
  assert.equal(sent.dir, '/home/bot/PMAID/analyses');
  assert.equal(sent.sessionId, 's1');
  assert.deepEqual([...sent.files].map((f) => f.name), ['a.csv', 'b.png']);
  // 同一个隐藏 input 复用：连选两次不会再建一个，但两次都要发出消息。
  rig.pickFiles('/home/bot/PMAID/analyses', [{ name: 'c.txt', size: 1 }]);
  assert.equal(rig.messages.filter((m) => m.data.type === 'hwb:file-upload').length, 2);
  // 空选择（用户在系统弹窗里点了取消）不发消息。
  rig.pickFiles('/home/bot/PMAID/analyses', []);
  assert.equal(rig.messages.filter((m) => m.data.type === 'hwb:file-upload').length, 2);
});

test('bridge: 上传状态按父页回传渲染；成功且要求刷新时替用户点 dsh 的「重新读取」', () => {
  const rig = mount();
  rig.fireParentMessage({ type: 'hwb:upload-status', text: '正在上传… 40%', tone: 'info' });
  assert.equal(rig.byId['hwb-upload-status']?.textContent, '正在上传… 40%');
  // 来源不对（不是本页父窗口）→ 不渲染
  rig.fireParentMessage({ type: 'hwb:upload-status', text: '伪造', tone: 'ok' }, 'http://evil.example', {});
  assert.equal(rig.byId['hwb-upload-status']?.textContent, '正在上传… 40%');
  // 成功 + reload：把文件树重读一次（新文件应当立刻可见，不必用户手动刷新）
  assert.equal(rig.reloadButton.clicked, undefined);
  rig.fireParentMessage({ type: 'hwb:upload-status', text: '已上传 2 个文件', tone: 'ok', reload: true });
  assert.equal(rig.reloadButton.clicked, true);
  assert.equal(rig.byId['hwb-upload-status']?.textContent, '已上传 2 个文件');
});

test('bridge: 未经父页初始化时，下载与上传一律不外发（与 open-workspace 同一条边界）', () => {
  const windowListeners = {};
  const messages = [];
  const byId = {};
  const win = { parent: { postMessage: (data) => messages.push(data) }, addEventListener: (type, fn) => { (windowListeners[type] ||= []).push(fn); } };
  const fireWindow = (type, event) => { for (const fn of windowListeners[type] || []) fn(event); };
  runInNewContext(source, {
    window: win,
    document: {
      querySelectorAll: () => [], querySelector: () => null, getElementById: (id) => byId[id] || null, addEventListener: () => {},
      createElement: (tag) => fakeElement({ tag }), body: { children: [], appendChild(child) { this.children.push(child); if (child.id) byId[child.id] = child; return child; } },
    },
    URL, Array, setTimeout: () => 0, clearTimeout: () => {},
    MutationObserver: class { observe() {} },
    location: { href: 'http://localhost/?session=s1' },
  });
  fireWindow('hwb:download-file', { detail: '/home/bot/PMAID/a.csv' });
  win.__hwbUploadFiles('/tmp');
  assert.equal(byId['hwb-upload-input'], undefined, '初始化之前连选择框都不该被创建');
  assert.equal(messages.length, 0, 'parentOrigin 未知前不能向任意窗口发消息');
});

test('bridge: 非法目标目录不发起上传（注入侧给什么都不越界）', () => {
  const rig = mount();
  for (const dir of ['', null, 'a'.repeat(4097)]) rig.window.__hwbUploadFiles(dir);
  assert.equal(rig.messages.filter((m) => m.data.type === 'hwb:file-upload').length, 0, '非法目录不得进入上传流程');
  assert.equal(rig.byId['hwb-upload-input'], undefined, '非法目录不该创建选择框');
  assert.equal(rig.byId['hwb-upload-status']?.textContent, '上传失败：目标目录无效。', '要给出可见的失败原因');
});

test('bridge: requires initialization from the real parent even when referrer is empty', () => {
  const windowListeners = {};
  const messages = [];
  const win = { parent: { postMessage: (data) => messages.push(data) }, addEventListener: (type, fn) => { (windowListeners[type] ||= []).push(fn); } };
  const fireWindow = (type, event) => { for (const fn of windowListeners[type] || []) fn(event); };
  runInNewContext(source, { window: win, document: { querySelectorAll: () => [], addEventListener: () => {} }, URL,
    MutationObserver: class { observe() {} }, location: { href: 'http://localhost/?session=s1' } });
  // 来自其它窗口/来源的初始化必须被忽略
  fireWindow('message', { source: {}, origin: 'http://localhost:4310', data: { type: 'hwb:preview-init' } });
  fireWindow('message', { source: win.parent, origin: 'null', data: { type: 'hwb:preview-init' } });
  assert.equal(messages.length, 0);
  fireWindow('message', { source: win.parent, origin: 'http://localhost:4310', data: { type: 'hwb:preview-init' } });
  assert.equal(messages.length, 1);
});
