// Runs inside the proxied dsh document; the parent verifies both source and origin.
(() => {
  if (window.parent === window) return;
  let parentOrigin;
  let lastSession;
  // 磁盘路径形态（用于从 dsh 的失败提示里把路径抠出来）。只接受绝对路径，避免误抓普通文本。
  const DISK_PATH = /(?:\/(?:[\w.@+-]+\/)*[\w.@+-]+\.[A-Za-z0-9]{1,12}|[A-Za-z]:\\[^\s"'“”]+)/g;
  // dsh 的「打开」标签是 `打开 {name}` / `Open {name}`（名字里可能带路径）。不同版本/不同入口
  // 的按钮文字会变（例如「打开文件」「打开此文件」），所以这里只要求以「打开/Open」开头，
  // 再配合后面的「标签里含 title 的路径」与「title 看起来是文件」两个条件，避免误判到
  // 「打开侧边栏」「打开目录」这类与本功能无关的按钮。
  function looksLikeFile(title) {
    if (typeof title !== 'string' || !title || title.length > 4096) return false;
    if (/^[a-z][a-z\d+.-]*:/i.test(title) && !/^[A-Za-z]:[\\/]/.test(title)) return false; // 带协议的都不是本地路径（含 app://、http://）
    if (title.includes('/') || title.includes('\\')) return true;
    return /^[\w.@+-]+\.[A-Za-z0-9]{1,12}$/.test(title);
  }
  function ariaLooksLikeOpen(element, title) {
    const label = element?.getAttribute?.('aria-label');
    if (!label) return false;
    if (!label.startsWith('打开') && !label.startsWith('Open')) return false;
    return typeof title !== 'string' || label.includes(title);
  }
  // 按钮可见文字（React 里 button 的 children 可能是 span）：用来判断「按钮显示的名字就是路径」。
  function visibleText(element) {
    let text = '';
    for (const child of element?.childNodes || []) {
      if (child.nodeType === 3) text += child.nodeValue || '';
      else if (child.textContent) text += child.textContent;
    }
    return text.trim();
  }
  // 取「这个元素代表哪个文件路径」：覆盖 dsh 当前形态（title+aria 的按钮）与历史形态
  // （data-path / a[href] / 裸 code 文本）。
  function pathFromEvent(event) {
    const target = event.target;
    if (typeof target?.closest !== 'function') return null;
    const button = target.closest('[data-path], [data-file-path], button[title], [title]');
    if (button) {
      const title = button.getAttribute?.('title');
      const inProducedRow = typeof button.closest === 'function' ? button.closest('[data-produced-files-row]') : null;
      // 三个条件任意满足其一才认：产物行里的 chip、aria 文案是「打开 <路径>」、
      // 或按钮显示的名字本身就是这个路径。仅凭「有 title 且像路径」会误伤
      // 「打开侧边栏」这类按钮（它的 title 恰好是一段普通文字）。
      const namedByButton = typeof title === 'string' && looksLikeFile(title)
        && (button.textContent?.trim() === title || visibleText(button) === title);
      if (typeof title === 'string' && (inProducedRow || namedByButton || (looksLikeFile(title) && ariaLooksLikeOpen(button, title)))) {
        return title;
      }
      const dataPath = button.dataset?.path || button.dataset?.filePath;
      if (dataPath) return dataPath;
    }
    const el = target.closest('a[href], code');
    if (!el || typeof el.matches !== 'function') return null;
    if (el.matches('a')) {
      const href = el.getAttribute('href');
      if (!href || /^(?:https?:|mailto:|#|javascript:|data:)/i.test(href)) return null;
      try {
        const file = href.startsWith('file://') ? new URL(href).pathname : decodeURIComponent(href);
        return /^[a-z][a-z\d+.-]*:/i.test(file) ? null : file;
      } catch { return null; }
    }
    if (el.matches('code') && !(typeof el.closest === 'function' && el.closest('pre'))) {
      const text = el.textContent.trim();
      if (/^(?:\.{0,2}\/|[\w@.-]+\/)[^\n]+$/.test(text) || /^[\w.-]+\.[a-z\d]{1,12}$/i.test(text)) return text;
    }
    return null;
  }
  function sendContext() {
    if (!parentOrigin) return;
    const href = location.href;
    const sessionId = new URL(href).searchParams.get('session');
    if (sessionId === lastSession) return;
    lastSession = sessionId;
    // 同时带上完整 URL：当前这套 dsh 客户端不做任何 URL 导航（切换会话时 URL 不变），
    // 因此父页在 URL 里通常读不到会话；但把 URL 一并送出，未来 dsh 若支持 URL 会话导航
    // 就无需再改这里，也便于排查「为什么读不到会话」。
    window.parent.postMessage({ type: 'hwb:preview-context', sessionId, href }, parentOrigin);
  }
  // dsh updates the session query through SPA navigation; the iframe itself
  // does not reload when the user changes conversations.
  new MutationObserver(sendContext).observe(document, { childList: true, subtree: true });
  window.addEventListener('popstate', sendContext);
  // Referrers may be stripped by the browser or an authentication redirect.
  // Accept initialization only from our actual parent, never a sibling frame.
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || event.data?.type !== 'hwb:preview-init' || event.origin === 'null') return;
    parentOrigin = event.origin;
    lastSession = undefined;
    sendContext();
  });
  window.addEventListener('hwb:open-workspace', (event) => {
    if (parentOrigin && typeof event.detail === 'string') window.parent.postMessage({ type: 'hwb:open-workspace', workspaceId: event.detail }, parentOrigin);
  });
  function handleFileClick(event) {
    if (!parentOrigin) return;
    if (event.defaultPrevented) return;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = event.target;
    if (typeof target?.closest !== 'function') return;
    if (target.closest('textarea, input, [contenteditable="true"]')) return;
    let file = pathFromEvent(event);
    if (!file || file.length > 4096) return;
    const match = file.match(/^(.*?)(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)$/);
    const line = match ? Number(match[2] || match[3]) : null;
    if (match) file = match[1];
    event.preventDefault();
    event.stopImmediatePropagation();
    window.parent.postMessage({ type: 'hwb:file-preview', path: file, line,
      sessionId: new URL(location.href).searchParams.get('session') }, parentOrigin);
  }
  // 挂三个 capture 监听：window、document（拦截），以及一个「没拦住时才提示」的 document 监听。
  // 过去只挂 window —— 实测同一份代码在 document 上能拦到、window 上那次没有，一旦漏拦，
  // 事件就交给 dsh 的原生「用系统应用打开」，在远端 Linux 上只能得到 xdg-open 报错。
  // 三个监听都在同一节点上的捕获阶段，顺序确定：前两个先处理，第三个只在 defaultPrevented
  // 仍为 false（= 确实要交给原生打开）时才提示。

  // 兜底：万一某个入口的点击仍漏给了 dsh 的原生「用宿主系统应用打开」（远端 Linux 上必然
  // 失败 → `xdg-open: no method available`），不要往会话正文里插任何控件（那会污染对话）；
  // 只在 iframe 角落浮一条自己会消失的小提示，给一个「在 hwb 预览里打开」的动作。
  let toastTimer = null;
  function showOpenNotice(path) {
    if (!parentOrigin) return;
    let toast = document.getElementById('hwb-preview-notice');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'hwb-preview-notice';
      toast.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483000;display:flex;gap:10px;'
        + 'align-items:center;max-width:420px;padding:10px 12px;border-radius:8px;background:#1f2430;color:#e8ecf3;'
        + 'font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;box-shadow:0 6px 24px #0006';
      document.body.appendChild(toast);
    }
    toast.replaceChildren();
    const text = document.createElement('span');
    text.textContent = '本机没有可用的打开方式（远端 xdg-open 失败）。';
    const action = document.createElement('button');
    action.type = 'button';
    action.textContent = '在 hwb 文件预览里打开';
    action.style.cssText = 'flex:none;padding:4px 10px;font:inherit;cursor:pointer';
    action.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      window.parent.postMessage({ type: 'hwb:file-preview', path, line: null,
        sessionId: new URL(location.href).searchParams.get('session') }, parentOrigin);
      toast.remove();
    }, true);
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', '关闭提示');
    close.style.cssText = 'flex:none;padding:0 6px;font:inherit;cursor:pointer;background:transparent;color:inherit;border:0';
    close.addEventListener('click', () => toast.remove());
    toast.append(text, action, close);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.remove(), 20000);
  }
  window.addEventListener('click', handleFileClick, true);
  document.addEventListener('click', handleFileClick, true);
  document.addEventListener('click', handleNativeOpen, true);

  // 走到这里说明这次点击**没被**上面拦下、即将交给 dsh 的原生打开。此时用一个更宽的判据
  // 把路径找出来即可（宽松不会有副作用：只是多浮一条提示，而且提示本身也是可关闭的）。
  function handleNativeOpen(event) {
    if (!parentOrigin || event.defaultPrevented) return;
    const target = event.target;
    if (typeof target?.closest !== 'function') return;
    if (target.closest('textarea, input, [contenteditable="true"]')) return;
    const holder = typeof target.closest === 'function' ? (target.closest('[title]') || target) : target;
    const title = holder?.getAttribute?.('title');
    if (typeof title === 'string' && looksLikeFile(title)) { showOpenNotice(title); return; }
    const path = pathFromEvent(event);
    if (path && path.length <= 4096) showOpenNotice(path);
  }
})();
