export function renderPreviewImage(content, result) {
  const viewer = document.createElement('section');
  viewer.className = 'image-viewer';
  viewer.innerHTML = `<div class="image-tools" role="toolbar" aria-label="图片预览操作">
    <button data-out aria-label="缩小图片">−</button><output aria-live="polite">100%</output>
    <button data-in aria-label="放大图片">＋</button><button data-actual>100%</button>
    <button data-fit>适应窗口</button><button data-full>全屏预览</button></div>
    <div class="image-stage" tabindex="0" aria-label="图片，可滚动查看放大后的内容"></div>`;
  const stage = viewer.querySelector('.image-stage');
  const img = document.createElement('img');
  img.className = 'preview-image';
  img.alt = result.path.split('/').pop();
  // Image documents disable SVG scripts; never insert SVG markup into the DOM.
  img.src = `data:${result.mime};base64,${result.data}`;
  stage.append(img);
  content.append(viewer);
  const dialog = document.createElement('dialog');
  dialog.className = 'image-fullscreen';
  dialog.setAttribute('aria-label', `全屏预览 ${img.alt}`);
  document.body.append(dialog);
  const full = viewer.querySelector('[data-full]');
  const output = viewer.querySelector('output');
  let scale = 1, fit = true, disposed = false, nativeFullscreen = false;
  function update() {
    if (!img.naturalWidth) return;
    if (fit) scale = Math.min(1, Math.max(0.01, (stage.clientWidth - 24) / img.naturalWidth), Math.max(0.01, (stage.clientHeight - 24) / img.naturalHeight));
    img.style.width = `${img.naturalWidth * scale}px`;
    img.style.height = `${img.naturalHeight * scale}px`;
    output.textContent = `${Math.round(scale * 100)}%`;
    viewer.querySelector('[data-out]').disabled = scale <= 0.1;
    viewer.querySelector('[data-in]').disabled = scale >= 16;
  }
  function zoom(next) { fit = false; scale = Math.min(16, Math.max(0.1, next)); update(); }
  viewer.querySelector('[data-in]').onclick = () => zoom(scale * 1.25);
  viewer.querySelector('[data-out]').onclick = () => zoom(scale / 1.25);
  viewer.querySelector('[data-actual]').onclick = () => zoom(1);
  viewer.querySelector('[data-fit]').onclick = () => { fit = true; update(); };
  function leave() {
    if (!dialog.open) return;
    nativeFullscreen = false;
    if (document.fullscreenElement === dialog) document.exitFullscreen?.().catch(() => {});
    content.append(viewer);
    dialog.close();
    full.textContent = '全屏预览';
    update();
    if (!disposed) full.focus();
  }
  full.onclick = async () => {
    if (dialog.open) { leave(); return; }
    dialog.append(viewer);
    dialog.showModal();
    full.textContent = '退出全屏';
    full.focus();
    update();
    // A viewport-sized dialog remains usable when browser fullscreen is unavailable.
    try { await dialog.requestFullscreen?.(); } catch { /* Use the dialog fallback. */ }
  };
  const fullscreenChanged = () => {
    if (document.fullscreenElement === dialog) nativeFullscreen = true;
    else if (nativeFullscreen) leave();
  };
  document.addEventListener('fullscreenchange', fullscreenChanged);
  dialog.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); leave(); }
  });
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); leave(); });
  img.onload = update;
  img.onerror = () => { stage.textContent = '图片无法解码，文件可能已损坏或格式不匹配。'; };
  const observer = new ResizeObserver(() => { if (fit) update(); });
  observer.observe(stage);
  return () => { disposed = true; leave(); observer.disconnect(); document.removeEventListener('fullscreenchange', fullscreenChanged); dialog.remove(); };
}
