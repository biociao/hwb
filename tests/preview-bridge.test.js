import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../src/web/preview-bridge.js', import.meta.url), 'utf8');
function click({ title = '/repo/src/file.js', label = `打开 ${title}`, produced = false, metaKey = false, initialize = true, foreign = false, origin = 'http://127.0.0.1:4310' } = {}) {
  let listener, init, prevented = false, stopped = false, message;
  const button = {
    dataset: {},
    getAttribute: (name) => ({ title, 'aria-label': label })[name],
    closest: (selector) => selector === '[data-produced-files-row]' ? produced : null,
  };
  const target = { closest: (selector) => selector === 'button[title][aria-label]' ? button : null };
  const win = {
    parent: { postMessage: (data, origin) => { message = { data, origin }; } },
    addEventListener: (type, handler, capture) => {
      if (type === 'message') { init = handler; return; }
      if (type === 'popstate' || type === 'hwb:open-workspace') return;
      assert.equal(type, 'click'); assert.equal(capture, true); listener = handler;
    },
  };
  runInNewContext(source, { window: win, document: { referrer: '' }, URL,
    MutationObserver: class { observe() {} }, location: { href: 'http://127.0.0.1:5555/?session=s1' } });
  if (initialize) init({ source: foreign ? {} : win.parent, origin, data: { type: 'hwb:preview-init' } });
  listener({ button: 0, metaKey, target, preventDefault() { prevented = true; }, stopImmediatePropagation() { stopped = true; } });
  return { prevented, stopped, message };
}
test('bridge: native dsh produced-file and Markdown buttons open preview before desktop handlers', () => {
  for (const label of ['打开 /repo/src/file.js', 'Open /repo/src/file.js']) {
    const result = click({ label });
    assert.equal(result.prevented, true);
    assert.equal(result.stopped, true);
    assert.equal(result.message.data.path, '/repo/src/file.js');
    assert.equal(result.message.data.sessionId, 's1');
    assert.equal(result.message.origin, 'http://127.0.0.1:4310');
  }
  assert.equal(click({ label: 'localized label', produced: true }).message.data.path, '/repo/src/file.js');
});
test('bridge: publishes context initially and after SPA session changes, including clearing it', () => {
  const listeners = {}, messages = [];
  let changed;
  const win = { parent: { postMessage: (data) => messages.push(data) }, addEventListener: (type, fn) => { listeners[type] = fn; } };
  const location = { href: 'http://localhost/?session=s1' };
  runInNewContext(source, { window: win, document: {}, URL, location,
    MutationObserver: class { constructor(fn) { changed = fn; } observe() {} } });
  listeners.message({ source: win.parent, origin: 'http://localhost:4310', data: { type: 'hwb:preview-init' } });
  changed();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].sessionId, 's1');
  // 上报里同时带完整 URL：父页据此解析会话（当前 dsh 不做 URL 导航，通常为空）。
  assert.equal(messages[0].href, 'http://localhost/?session=s1');
  location.href = 'http://localhost/?session=s2';
  changed();
  assert.equal(messages[1].sessionId, 's2');
  location.href = 'http://localhost/';
  listeners.popstate();
  assert.equal(messages[2].sessionId, null);
});
test('bridge: preserves unrelated buttons and modifier clicks', () => {
  assert.equal(click({ label: '复制 /repo/src/file.js' }).prevented, false);
  assert.equal(click({ metaKey: true }).prevented, false);
});
test('bridge: requires initialization from the real parent even when referrer is empty', () => {
  assert.equal(click().prevented, true);
  assert.equal(click({ initialize: false }).prevented, false);
  assert.equal(click({ foreign: true }).prevented, false);
  assert.equal(click({ origin: 'null' }).prevented, false);
});
