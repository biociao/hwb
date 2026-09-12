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
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(title)) return false; // http(s):// 等 URL 不是本地路径
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
  // 挂两次：window 与 document 各一个 capture 监听。过去只挂 window —— 一旦某个环境下
  // window 上的 capture 监听没有生效（实测 headless Chrome 里出现过，同一份代码在
  // document 上正常），文件点击就会漏给 dsh 的原生「用系统应用打开」，在远端 Linux 上
  // 只能得到 `xdg-open: no method available`。两个都挂，谁先到手都行（后者看到
  // defaultPrevented 就退出，不会重复上报）。
  window.addEventListener('click', handleFileClick, true);
  document.addEventListener('click', handleFileClick, true);

  // 兜底：dsh 的「用宿主系统应用打开」在无 GUI 的远端必然失败（xdg-open: no method available），
  // 界面上只会弹一句英文报错。这里把它的路径取出来，就地补一个走 hwb 预览的按钮。
  // 触发点是**应用内新增的节点**，与用户点击的是哪个元素无关，因此即使上面的点击识别
  // 没覆盖到某个入口（不同 dsh 版本/不同产物面板），这条兜底也能让用户把文件打开。
  function decorateOpenFailure(root) {
    if (!parentOrigin || typeof root?.querySelectorAll !== 'function') return;
    const candidates = [root];
    if (typeof root.matches !== 'function' || root.matches('div, section, dialog, [role="alert"], [role="dialog"]')) {
      candidates.push(...root.querySelectorAll('div, section, dialog, [role="alert"], [role="dialog"]'));
    }
    for (const node of candidates) {
      const text = node.textContent || '';
      if (!text.includes('path open failed') || text.length > 4000) continue;
      if (node.querySelector('[data-hwb-preview-open]')) continue;
      const paths = text.match(DISK_PATH);
      const path = paths?.find((item) => /\.[A-Za-z0-9]{1,12}$/.test(item));
      if (!path) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('data-hwb-preview-open', path);
      button.textContent = '用 hwb 文件预览打开';
      button.style.cssText = 'margin-top:8px;padding:4px 10px;font:inherit;font-size:12px;cursor:pointer';
      button.addEventListener('click', (clickEvent) => {
        clickEvent.preventDefault();
        clickEvent.stopImmediatePropagation();
        window.parent.postMessage({ type: 'hwb:file-preview', path, line: null,
          sessionId: new URL(location.href).searchParams.get('session') }, parentOrigin);
      }, true);
      node.appendChild(button);
    }
  }
  new MutationObserver((records) => {
    if (!Array.isArray(records)) { decorateOpenFailure(document); return; }
    for (const record of records) {
      for (const node of record?.addedNodes || []) {
        if (node?.nodeType === 1) decorateOpenFailure(node);
      }
    }
  }).observe(document, { childList: true, subtree: true });
})();
