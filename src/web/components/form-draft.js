// 表单草稿的保存/恢复。
//
// 为什么需要：dashboard 每次 SSE 刷新都会整块重建 innerHTML（有实例在跑时 live-poller 约每 3s
// 广播一次），「添加实例」表单因此每 3s 被换成全新的空表单 —— 用户输入的路径/别名被清空，
// 焦点还被抢回第一个输入框。结果就是这个表单实际上填不完。
//
// 做成独立模块（而不是留在 app.js 里）是为了能用最小假 DOM 单独测：
// 这里只依赖元素上的 value/checked/name/type 与 focus/setSelectionRange。

/** 记下表单里每个具名控件的值，以及当前焦点所在控件与光标位置。 */
export function captureFormDraft(form, activeElement = null) {
  if (!form) return null;
  const draft = { values: {}, focused: null, selectionStart: null, selectionEnd: null };
  for (const el of form.querySelectorAll('input, select, textarea')) {
    if (!el.name) continue;
    draft.values[el.name] = el.type === 'checkbox' || el.type === 'radio' ? el.checked : el.value;
    if (activeElement && activeElement === el) {
      draft.focused = el.name;
      draft.selectionStart = el.selectionStart;
      draft.selectionEnd = el.selectionEnd;
    }
  }
  return draft;
}

/**
 * 把草稿写回表单。返回 true 表示还成功恢复了焦点（调用方据此决定是否回落到默认聚焦行为）。
 * 控件有默认值但用户没动过时，draft.values 里存的就是默认值本身，写回是幂等的。
 *
 * `onRestored` 是必须的钩子：值只是一半状态。像「本机 / SSH 远程」这种模式选择，会把
 * `hidden` / `disabled` / `required` 施加到**别的**字段上，而这些属性只在 change 处理器里设置 ——
 * 重建后的表单永远是「本机」布局。只恢复 value 的话会出现：select 显示「SSH 远程」、
 * host/port 却还是 hidden，而可见的空 homePath 仍是 required → 原生校验直接拦下提交，
 * submit 事件根本不会触发（只能来回切两次模式才能恢复）。
 * 所以恢复完值之后必须让调用方重放一次模式切换。
 */
export function restoreFormDraft(form, draft, { escapeSelector, onRestored } = {}) {
  if (!form || !draft) return false;
  const escape = escapeSelector ?? ((v) => (globalThis.CSS?.escape ? CSS.escape(v) : v));
  for (const el of form.querySelectorAll('input, select, textarea')) {
    if (!el.name || !Object.hasOwn(draft.values, el.name)) continue;
    if (el.type === 'checkbox' || el.type === 'radio') el.checked = draft.values[el.name];
    else el.value = draft.values[el.name];
  }
  onRestored?.(form, draft);
  if (!draft.focused) return false;
  const target = form.querySelector(`[name="${escape(draft.focused)}"]`);
  if (!target) return false;
  target.focus?.();
  // 光标位置一并还原，否则每 3s 光标就跳到末尾，「在中间补字」变得不可能。
  if (draft.selectionStart != null && typeof target.setSelectionRange === 'function') {
    try { target.setSelectionRange(draft.selectionStart, draft.selectionEnd); } catch { /* 部分 input 类型不支持 */ }
  }
  return true;
}
