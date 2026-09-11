import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureFormDraft, restoreFormDraft } from '../src/web/components/form-draft.js';

// 「添加实例」表单的草稿必须能跨 dashboard 重建存活。
// 背景：有实例在跑时 live-poller 约每 3s 广播一次 index:updated → refresh → dashboardEl.innerHTML
// 整块重建。原先重建后直接插一个全新空表单、并把焦点抢回 homePath：
// 用户输入的路径/别名每 3s 被清空一次，这个表单实际上填不完。

function fakeInput(name, { type = 'text', value = '', checked = false } = {}) {
  return {
    name, type, value, checked,
    selectionStart: null, selectionEnd: null,
    focusCalls: 0,
    focus() { this.focusCalls++; },
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
  };
}

function fakeForm(controls) {
  return { querySelectorAll: () => controls, querySelector: (sel) => controls.find((c) => sel === `[name="${c.name}"]`) ?? null };
}

test('captureFormDraft: 记下每个具名控件的值、焦点与光标位置', () => {
  const homePath = fakeInput('homePath', { value: '/tmp/x' });
  const mode = { name: 'mode', type: 'select-one', value: 'remote' };
  const alias = fakeInput('alias', { value: 'my dsh' });
  const form = fakeForm([homePath, mode, alias]);
  homePath.selectionStart = 2; homePath.selectionEnd = 4;

  const draft = captureFormDraft(form, homePath);
  assert.deepEqual(draft.values, { homePath: '/tmp/x', mode: 'remote', alias: 'my dsh' });
  assert.equal(draft.focused, 'homePath');
  assert.equal(draft.selectionStart, 2);
  assert.equal(draft.selectionEnd, 4);
});

test('captureFormDraft: 复选框记 checked 而不是 value', () => {
  const cb = fakeInput('opt', { type: 'checkbox', value: 'on', checked: true });
  const draft = captureFormDraft(fakeForm([cb]), null);
  assert.equal(draft.values.opt, true);
});

test('captureFormDraft: 无 name 的控件跳过；空表单不抛', () => {
  const draft = captureFormDraft(fakeForm([{ name: '', type: 'text', value: 'x' }]), null);
  assert.deepEqual(draft.values, {});
  assert.equal(draft.focused, null);
  assert.equal(captureFormDraft(null), null);
});

test('restoreFormDraft: 值写回，焦点与光标一并还原', () => {
  const fresh = [fakeInput('homePath'), fakeInput('alias')];
  const draft = { values: { homePath: '/tmp/x', alias: 'my dsh' }, focused: 'alias', selectionStart: 3, selectionEnd: 3 };
  assert.equal(restoreFormDraft(fakeForm(fresh), draft), true);
  assert.equal(fresh[0].value, '/tmp/x');
  assert.equal(fresh[1].value, 'my dsh');
  assert.equal(fresh[1].focusCalls, 1, '焦点应回到用户原来所在的控件，而不是被抢到第一个输入框');
  assert.equal(fresh[0].focusCalls, 0);
  assert.equal(fresh[1].selectionStart, 3, '光标位置必须还原，否则每 3s 光标跳到末尾');
});

test('restoreFormDraft: 原本没聚焦在表单里时返回 false，让调用方走默认聚焦', () => {
  const draft = { values: { homePath: '/tmp/x' }, focused: null };
  assert.equal(restoreFormDraft(fakeForm([fakeInput('homePath')]), draft), false);
  assert.equal(restoreFormDraft(fakeForm([fakeInput('homePath')]), null), false);
  assert.equal(restoreFormDraft(null, draft), false);
});

test('restoreFormDraft: 草稿里没有的控件保持默认值（新增字段不会被清掉）', () => {
  const controls = [fakeInput('homePath', { value: '/tmp/x' }), fakeInput('remotePort', { value: '3080' })];
  restoreFormDraft(fakeForm(controls), { values: { homePath: '/y' }, focused: null });
  assert.equal(controls[0].value, '/y');
  assert.equal(controls[1].value, '3080', '未出现在草稿里的控件应保持表单默认值');
});

test('restoreFormDraft: setSelectionRange 抛错（number 类型输入框）不影响整体恢复', () => {
  const port = { name: 'accessPort', type: 'number', value: '', checked: false, focusCalls: 0,
    focus() { this.focusCalls++; }, setSelectionRange() { throw new Error('InvalidStateError'); } };
  assert.equal(restoreFormDraft(fakeForm([port]), { values: { accessPort: '4310' }, focused: 'accessPort', selectionStart: 1, selectionEnd: 1 }), true);
  assert.equal(port.value, '4310');
  assert.equal(port.focusCalls, 1);
});

// ── 与「模式相关字段状态」的配合（回归：只恢复值会让 SSH 表单提交不了） ──
//
// 显隐/必填是值之外的状态，只在 change 处理器里设置；dashboard 每次 SSE 重建都会生成一个
// 「本机」布局的新表单。若恢复草稿时只写 value，就会出现：select 显示「SSH 远程」、
// host/remotePort 仍 hidden（输入的内容看不见也改不了），而可见的空 homePath 仍是 required
// → 原生校验直接拦下提交，submit 事件根本不触发。只能来回切两次模式才能恢复。
// 这里用真实渲染出的标记 + 最小 DOM 同时验证「标记里的默认布局」与「applyHomeMode 的修正」。

const { applyHomeMode } = await import('../src/web/components/add-home.js');

function fieldsFrom(form) {
  const names = ['homePath', 'host', 'remotePort', 'remoteHome', 'remoteCmd', 'remoteLog', 'token', 'localPort', 'accessPort'];
  const out = {};
  for (const name of names) out[name] = { hidden: false, disabled: false, required: false };
  return out;
}

test('applyHomeMode(remote): host/port 可见且必填，homePath 隐藏且不再必填', () => {
  const form = { ...fieldsFrom(), mode: { value: 'remote' } };
  applyHomeMode(form, 'remote');
  assert.equal(form.host.hidden, false);
  assert.equal(form.remotePort.hidden, false);
  assert.equal(form.host.required, true, '远程模式必须要求 host');
  assert.equal(form.remotePort.required, true);
  assert.equal(form.homePath.hidden, true);
  assert.equal(form.homePath.required, false, '隐藏的 homePath 若仍 required 会静默拦下提交');
  assert.equal(form.accessPort.disabled, false);
  assert.equal(form.token.hidden, false, 'token 两种模式都可见');
});

test('applyHomeMode(local): 回到本机布局（homePath 可见必填，远程字段隐藏）', () => {
  const form = { ...fieldsFrom(), mode: { value: 'local' } };
  applyHomeMode(form, 'local');
  assert.equal(form.homePath.hidden, false);
  assert.equal(form.homePath.required, true);
  assert.equal(form.host.hidden, true);
  assert.equal(form.host.required, false);
  assert.equal(form.remotePort.hidden, true);
  assert.equal(form.accessPort.disabled, true);
});

test('renderHomeForm 的默认布局就是「本机」——所以恢复 remote 草稿必须重放 applyHomeMode', async () => {
  const { renderHomeForm } = await import('../src/web/components/add-home.js');
  const html = renderHomeForm();
  assert.match(html, /name="homePath"[^>]*(required|placeholder)/, 'homePath 在默认布局里可见且必填');
  assert.match(html, /name="host"[^>]*hidden/, 'host 在默认布局里是隐藏的');
  assert.match(html, /name="remotePort"[^>]*hidden/, 'remotePort 在默认布局里是隐藏的');
  // 也就是说：只恢复 value 会让 select=remote 与「本机布局」打架 —— 这正是必须重放模式的原因。
});

test('restoreFormDraft 会调用 onRestored 钩子（调用方据此重放模式）', () => {
  const controls = [fakeInput('homePath'), fakeInput('host')];
  const draft = { values: { homePath: '', host: 'me@box' }, focused: null };
  const seen = [];
  restoreFormDraft(fakeForm(controls), draft, { onRestored: (form, d) => seen.push([form, d]) });
  assert.equal(seen.length, 1, '恢复后必须给调用方一次重放模式的机会');
  assert.equal(seen[0][1], draft);
});

test('restoreFormDraft 不传钩子时照常工作（向后兼容）', () => {
  const controls = [fakeInput('homePath')];
  assert.equal(restoreFormDraft(fakeForm(controls), { values: { homePath: '/x' }, focused: null }), false);
  assert.equal(controls[0].value, '/x');
});
