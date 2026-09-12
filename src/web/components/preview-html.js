// HTML 预览：默认用 <iframe> 按浏览器的方式渲染（长报告不需要先看 24 KiB 截断的源码），
// 也可以一键切回带行号的源码视图。
//
// 为什么用 /asset 而不是把内容塞进 JSON：报告动辄数 MB（内联图表的 HTML 常有 5–10 MB），
// 走 JSON 会同时产生「原字节 + base64 + JSON 字符串」三份同尺寸副本；/asset 直接按真实
// MIME 流式返回，浏览器自己按需解析与排版。服务端那份响应带 CSP `sandbox`，脚本不会执行。
import { esc } from '../store.js';

// 源码视图与后端 PREVIEW_BYTES 一致：服务端只回前 24 KiB，这里明确告知用户。
const SOURCE_NOTICE = '仅预览前 24 KiB';

export function renderPreviewHtml(content, result, { assetUrl, line = null, loadSource, onDownload } = {}) {
  const viewer = document.createElement('section');
  viewer.className = 'html-viewer';
  viewer.innerHTML = `<div class="html-tools" role="toolbar" aria-label="网页预览操作">
      <button data-mode="render" aria-pressed="true">渲染</button>
      <button data-mode="source" aria-pressed="false">源码</button>
      <a data-open href="${esc(assetUrl)}" target="_blank" rel="noopener noreferrer">在浏览器打开</a>
      <button data-download>下载完整文件</button>
      <span class="html-meta"></span>
    </div>
    <div class="html-stage"></div>`;
  const stage = viewer.querySelector('.html-stage');
  const meta = viewer.querySelector('.html-meta');
  const buttons = [...viewer.querySelectorAll('[data-mode]')];
  content.append(viewer);

  let frame = null;
  let disposed = false;
  let source = null;       // 懒加载：只在用户切到「源码」时才去取前 24 KiB
  let sourceState = 'idle';
  const size = typeof result.size === 'number' ? `${result.size.toLocaleString()} 字节` : '';

  function clearStage() {
    if (frame) { frame.remove(); frame = null; }
    stage.replaceChildren();
  }
  function setMode(mode) {
    for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
    viewer.dataset.mode = mode;
    clearStage();
    stage.classList.remove('is-source', 'is-render');
    if (mode === 'source') {
      stage.classList.add('is-source');
      meta.textContent = size ? `${size} · ${SOURCE_NOTICE}` : SOURCE_NOTICE;
      if (sourceState === 'idle' && typeof loadSource === 'function') {
        sourceState = 'loading';
        stage.textContent = '正在读取源码…';
        Promise.resolve().then(loadSource).then((text) => {
          source = text;
          sourceState = 'done';
          if (!disposed && stage.classList.contains('is-source')) paintSource();
        }).catch((error) => {
          sourceState = 'failed';
          if (!disposed && stage.classList.contains('is-source')) stage.textContent = `源码读取失败：${error.message}`;
        });
        return;
      }
      if (sourceState === 'loading') { stage.textContent = '正在读取源码…'; return; }
      paintSource();
      return;
    }
    stage.classList.add('is-render');
    meta.textContent = size;
    frame = document.createElement('iframe');
    // 预览的是工作区里的文件，可能是外部来源的 HTML：去掉脚本、表单与 ability to navigate
    // 顶层窗口的能力，只保留展示；链接仍可开新标签（allow-popups），便于「看完整报告」。
    frame.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.title = result.path?.split('/').pop() || '网页预览';
    frame.src = assetUrl;
    stage.append(frame);
  }
  function paintSource() {
    stage.replaceChildren();
    stage.classList.add('is-source');
    const pre = document.createElement('pre');
    pre.innerHTML = String(source ?? result.source ?? '').split('\n').map((text, index) => `<span class="preview-line${index + 1 === line ? ' selected' : ''}" data-line="${index + 1}"><span class="line-number">${index + 1}</span>${esc(text)}\n</span>`).join('');
    stage.append(pre);
    if (line) stage.querySelector(`[data-line="${line}"]`)?.scrollIntoView({ block: 'center' });
  }
  const downloadButton = viewer.querySelector('[data-download]');
  if (typeof onDownload === 'function') downloadButton.onclick = () => onDownload();
  else downloadButton.hidden = true;
  for (const button of buttons) button.onclick = () => setMode(button.dataset.mode);
  setMode('render');
  return () => { disposed = true; clearStage(); viewer.remove(); };
}
