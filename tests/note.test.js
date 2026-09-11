import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNote } from '../src/web/components/note.js';

// #note 是跨 dashboard 重建存活的那条提示。原先 `refresh()` 无条件 `note.hidden = true`，
// 于是「添加实例但服务端回了 warning」这类**需要用户处理**的提示，在下一次成功刷新
// （有实时轮询时 ≤3s）就被抹掉了 —— 独立审查用真浏览器实测：添加后立即可见，SSE 刷新后 hidden=true。
// 代码里的注释当时还写着「挂在持久的 #note 上」，实际只对 innerHTML 重建持久，对 refresh() 并不。

const fakeEl = () => ({ textContent: '', hidden: false });

test('note: 粘性提示不会被「这一轮刷新成功」撤掉', () => {
  const el = fakeEl();
  const note = createNote(el);
  note.set('已添加，但注意：directory does not look like a dsh home', { sticky: true });
  assert.equal(el.hidden, false);
  assert.equal(note.sticky, true);

  note.clearUnlessSticky(); // 成功刷新
  assert.equal(el.hidden, false, '粘性提示必须留着 —— 否则用户根本来不及处理');
  assert.match(el.textContent, /已添加，但注意/);

  note.clearUnlessSticky(); // 实时通道重连
  assert.equal(el.hidden, false);
});

test('note: 普通提示（刷新失败/断线）仍会被成功刷新撤掉', () => {
  const el = fakeEl();
  const note = createNote(el);
  note.set('刷新失败：boom');
  assert.equal(el.hidden, false);
  note.clearUnlessSticky();
  assert.equal(el.hidden, true, '失败提示必须在恢复后消失（否则顶栏 live、下面还挂着「已断开」）');
  assert.equal(el.textContent, '');
  assert.equal(note.sticky, false);
});

test('note: 普通提示会覆盖粘性提示，且此后按普通提示处理', () => {
  const el = fakeEl();
  const note = createNote(el);
  note.set('已添加，但注意：x', { sticky: true });
  note.set('刷新失败：y'); // 更紧急，覆盖
  assert.equal(note.sticky, false, '覆盖之后不再粘住');
  note.clearUnlessSticky();
  assert.equal(el.hidden, true);
});

test('note: clear() 显式清空并解除粘性；缺元素时不抛', () => {
  const el = fakeEl();
  const note = createNote(el);
  note.set('已添加，但注意：x', { sticky: true });
  note.clear();
  assert.equal(el.hidden, true);
  assert.equal(el.textContent, '');
  assert.equal(note.sticky, false);

  const detached = createNote(null);
  detached.set('x', { sticky: true });
  detached.clearUnlessSticky();
  detached.clear();
  assert.equal(detached.sticky, false, '没有 DOM 元素也不该抛');
});
