export function attachPreviewResize(pane, aside, homeId) {
  const handle = document.createElement('div');
  handle.className = 'preview-resize';
  handle.tabIndex = 0;
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-label', '调整文件预览宽度');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.title = '拖动调整宽度，双击恢复默认';
  aside.prepend(handle);
  const key = `hwb:preview-width:${homeId}`;
  let preferred = null, drag = null;
  try {
    const saved = Number(localStorage.getItem(key));
    if (Number.isFinite(saved) && saved > 0) preferred = saved;
  } catch { /* Storage may be unavailable. */ }

  function bounds() {
    const width = pane.el.getBoundingClientRect().width;
    const max = Math.max(0, width - (width <= 700 ? 24 : 320));
    return { width, min: Math.min(280, max), max };
  }
  function layout() {
    const { width, min, max } = bounds();
    if (!width) return; // Hidden instance tabs have no layout yet.
    const fallback = width <= 700 ? width * 0.9 : Math.min(width * 0.42, 560);
    const value = Math.round(Math.max(min, Math.min(max, preferred ?? fallback)));
    pane.el.style.setProperty('--preview-width', `${value}px`);
    handle.setAttribute('aria-valuemin', String(min));
    handle.setAttribute('aria-valuemax', String(max));
    handle.setAttribute('aria-valuenow', String(value));
    handle.setAttribute('aria-valuetext', `${value} 像素`);
  }
  function setWidth(value) {
    const { min, max } = bounds();
    preferred = Math.max(min, Math.min(max, value));
    layout();
  }
  function save() {
    try {
      if (preferred === null) localStorage.removeItem(key);
      else localStorage.setItem(key, String(preferred));
    } catch { /* Keep resizing usable without storage. */ }
  }
  function finish() {
    if (!drag) return;
    const { pointerId } = drag;
    drag = null;
    pane.el.classList.remove('resizing-preview');
    if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
    save();
  }
  handle.onpointerdown = (event) => {
    if (event.button !== 0 || drag) return;
    event.preventDefault();
    handle.focus();
    drag = { pointerId: event.pointerId, x: event.clientX, width: aside.getBoundingClientRect().width };
    handle.setPointerCapture(event.pointerId);
    // The pointer must not disappear into dsh's cross-origin iframe mid-drag.
    pane.el.classList.add('resizing-preview');
  };
  handle.onpointermove = (event) => {
    if (drag?.pointerId === event.pointerId) setWidth(drag.width + drag.x - event.clientX);
  };
  handle.onpointerup = handle.onpointercancel = handle.onlostpointercapture = finish;
  handle.ondblclick = () => { preferred = null; layout(); save(); };
  handle.onkeydown = (event) => {
    const current = aside.getBoundingClientRect().width;
    const { min, max } = bounds();
    const next = { ArrowLeft: current + 32, ArrowRight: current - 32, Home: min, End: max }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    setWidth(next);
    save();
  };
  // ResizeObserver 在 Safari < 13.1 不存在。这里是侧栏宽度自适应的增强，不是功能本身：
  // 没有它就退化成「改变窗口大小后布局不重算」，不该让整个实例面板挂在 attachFilePreview 上。
  // （同文件其它地方已经用了 `?.` 做能力检测，这里补齐同一套写法。）
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(layout) : null;
  observer?.observe(pane.el);
  layout();
  return () => { finish(); observer?.disconnect(); };
}
