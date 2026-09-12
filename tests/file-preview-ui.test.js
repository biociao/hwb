import { test } from 'node:test';
import assert from 'node:assert/strict';

// attachFilePreview 的兜底行为测试：内嵌页没有上报会话时，侧栏必须仍能工作
// （用 hwb 索引里的工作区直接绑定 workspaceId，而不是只弹一句「请先打开会话」）。
// 这里用最小假 DOM + 假 fetch：不引入 jsdom，只实现组件真正用到的那部分接口。

class FakeClassList {
  constructor() { this.set = new Set(); }
  add(...names) { names.forEach((n) => this.set.add(n)); }
  remove(...names) { names.forEach((n) => this.set.delete(n)); }
  contains(name) { return this.set.has(name); }
  toggle(name, force) { const on = force ?? !this.set.has(name); on ? this.set.add(name) : this.set.delete(name); return on; }
}

class FakeElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parent = null;
    this.attributes = new Map();
    this.dataset = {};
    this.style = { setProperty() {} };
    this.classList = new FakeClassList();
    this.textContent = '';
    this.value = '';
    this.hidden = false;
    this.disabled = false;
    this.title = '';
    this.files = [];
    this.className = '';
    this._html = '';
    this._selectors = new Map();
  }
  set innerHTML(html) { this._html = String(html); parseSelectorStubs(this, this._html); }
  get innerHTML() { return this._html; }
  append(child) { child.parent = this; this.children.push(child); return child; }
  prepend(child) { child.parent = this; this.children.unshift(child); return child; }
  appendChild(child) { return this.append(child); }
  removeChild(child) { this.children = this.children.filter((c) => c !== child); return child; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  querySelector(selector) { return this._selectors.get(selector) || null; }
  addEventListener() {}
  focus() {}
  click() { this.onclick?.({}); }
  getBoundingClientRect() { return { width: 800, height: 600, top: 0, left: 0 }; }
  setPointerCapture() {}
  releasePointerCapture() {}
  hasPointerCapture() { return false; }
  contains(node) { return node === this || this.children.includes(node); }
  scrollIntoView() {}
}

// 把 innerHTML 里出现的属性选择器补成占位元素，供组件 querySelector 使用。
function parseSelectorStubs(element, html) {
  const selectors = [
    '[data-close]', '[data-up]', '[data-root]', '[data-refresh]', '[data-download]',
    '[data-upload]', '[data-upload-hint]', '[data-workspace]',
    '.preview-workspace', '.preview-content', '.preview-path', '.preview-actions',
    '.download-status', '.upload-zone', '.upload-progress', '.upload-progress-text',
    'input[aria-label="文件路径"]', 'input[type="file"]', 'form', 'progress', 'select',
  ];
  for (const selector of selectors) {
    if (html.includes(selector.replace(/[\[\]"]/g, '')) || html.includes(selector)) {
      if (!element._selectors.has(selector)) element._selectors.set(selector, new FakeElement(selector.includes('input') ? 'input' : 'div'));
    }
  }
  // 组件按 aria-label / type / data-* 取元素，这里按需补齐。
  const stubs = {
    'input[aria-label="文件路径"]': 'input', 'input[type="file"]': 'input',
    progress: 'progress', form: 'form', select: 'select',
  };
  for (const [selector, tag] of Object.entries(stubs)) {
    if (!element._selectors.has(selector)) element._selectors.set(selector, new FakeElement(tag));
  }
  for (const selector of selectors) {
    if (!element._selectors.has(selector)) element._selectors.set(selector, new FakeElement('div'));
  }
}

function installDom() {
  const registry = new Map();
  const paneEl = new FakeElement('div');
  const actions = new FakeElement('div');
  actions.id = 'preview-actions';
  registry.set('preview-actions', actions);
  global.document = {
    documentElement: { dataset: {} },
    body: new FakeElement('body'),
    createElement: (tag) => new FakeElement(tag),
    getElementById: (id) => registry.get(id) || null,
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  global.window = { matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {} };
  global.ResizeObserver = class { observe() {} disconnect() {} };
  global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  global.URL.createObjectURL = () => 'blob:x';
  global.URL.revokeObjectURL = () => {};
  return { paneEl, actions };
}

function installFetch({ workspaces, sessions, preview }) {
  const calls = [];
  global.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    let body = {};
    if (url.startsWith('/api/workspaces')) body = { workspaces };
    else if (url.startsWith('/api/sessions/recent')) body = { sessions };
    else if (url.includes('/preview?')) {
      const params = new URL(url, 'http://x').searchParams;
      const target = params.get('sessionId') || params.get('workspaceId');
      const workspace = preview[target];
      if (!workspace) return { ok: false, status: 400, json: async () => ({ error: '当前会话尚未关联可用的 project 工作区' }) };
      body = { path: workspace.path, root: workspace.path, parent: null, kind: 'directory', entries: [{ name: 'a.txt', kind: 'file' }], truncated: false, workspace };
    }
    return { ok: true, status: 200, json: async () => body };
  };
  return calls;
}

const HOME = 'fe53172819028365';
const WORKSPACES = [
  { homeId: HOME, workspaceId: 'w-pmaid', title: 'PMAID', path: '/home/bot/PMAID', project: 'PMAID', archived: 0 },
  { homeId: HOME, workspaceId: 'w-dsh', title: 'dsh-workspace', path: '/home/bot/dsh-workspace', project: 'dsh-workspace', archived: 0 },
];
const PREVIEW = {
  'w-pmaid': { workspaceId: 'w-pmaid', title: 'PMAID', path: '/home/bot/PMAID' },
  'w-dsh': { workspaceId: 'w-dsh', title: 'dsh-workspace', path: '/home/bot/dsh-workspace' },
  'session-1': { workspaceId: 'w-dsh', title: 'dsh-workspace', path: '/home/bot/dsh-workspace' },
};

async function mount(options) {
  const dom = installDom();
  const calls = installFetch(options);
  const { attachFilePreview } = await import(`../src/web/components/file-preview.js?case=${Math.random()}`);
  const pane = { el: dom.paneEl };
  const preview = attachFilePreview(pane, HOME);
  return { preview, pane, calls, dom };
}

// 组件用 `aside.hidden` 判断开合；假元素默认 hidden=false，这里显式置为关闭态。
function findAside(pane) {
  const aside = pane.el.children.find((c) => c.className === 'file-preview' || c.tagName === 'ASIDE');
  assert.ok(aside, '没找到 .file-preview 侧栏');
  return aside;
}

test('预览侧栏：没有会话上下文时自动绑定最近活跃会话所在工作区', async () => {
  const { preview, pane, calls } = await mount({
    workspaces: WORKSPACES,
    sessions: [{ sessionId: 'session-1', workspaceId: 'w-pmaid', lastActivity: '2026-09-11T00:00:00.000Z' }],
    preview: PREVIEW,
  });
  const aside = findAside(pane);
  aside.hidden = true; // 侧栏关闭态起步，receive 应当把它打开
  await preview.receive({ path: '.' }); // 内嵌页点了文件但没带 sessionId
  const previewCall = calls.find((c) => c.url.includes('/preview?'));
  assert.ok(previewCall, '应当发起一次预览请求');
  assert.match(previewCall.url, /workspaceId=w-pmaid/, `未上报会话时应按工作区兜底绑定：${previewCall.url}`);
  assert.equal(aside.hidden, false, '面板应当打开');
});

test('预览侧栏：会话上下文优先于兜底工作区', async () => {
  const { preview, pane, calls } = await mount({
    workspaces: WORKSPACES,
    sessions: [{ sessionId: 'session-1', workspaceId: 'w-pmaid' }],
    preview: PREVIEW,
  });
  await preview.receive({ sessionId: 'session-1', path: 'a.txt' });
  const previewCall = calls.find((c) => c.url.includes('/preview?'));
  assert.match(previewCall.url, /sessionId=session-1/, `有会话时应跟随会话：${previewCall.url}`);
  assert.equal(previewCall.url.includes('workspaceId='), false);
});

test('预览侧栏：该实例没有任何工作区时给出明确提示而不是崩掉', async () => {
  const { preview, pane, calls } = await mount({ workspaces: [], sessions: [], preview: {} });
  const aside = findAside(pane);
  await preview.receive({ path: '.' });
  assert.equal(calls.some((c) => c.url.includes('/preview?')), false, '没有工作区时不应发预览请求');
  assert.match(aside.querySelector('.preview-content').textContent, /工作区|会话/);
});
