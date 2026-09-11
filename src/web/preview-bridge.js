// Runs inside the proxied dsh document; the parent verifies both source and origin.
(() => {
  if (window.parent === window) return;
  let parentOrigin;
  let lastSession;
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
  window.addEventListener('click', (event) => {
    if (!parentOrigin) return;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    // dsh's native Markdown file mentions and produced-file chips put the full
    // path in title (and a localized Open label), rather than data-path.
    const button = event.target.closest?.('button[title][aria-label]');
    const nativePath = button?.getAttribute('title');
    const isFileButton = nativePath && (
      button.closest('[data-produced-files-row]') ||
      ['打开 ', 'Open '].some((prefix) => button.getAttribute('aria-label') === prefix + nativePath)
    );
    const el = isFileButton ? button : event.target.closest?.('[data-path], [data-file-path], a[href], code');
    if (!el || el.closest('textarea, input, [contenteditable="true"]')) return;
    let file = isFileButton ? nativePath : el.dataset.path || el.dataset.filePath;
    if (!file && el.matches('a')) {
      const href = el.getAttribute('href');
      if (!href || /^(?:https?:|mailto:|#|javascript:|data:)/i.test(href)) return;
      try { file = href.startsWith('file://') ? new URL(href).pathname : decodeURIComponent(href); } catch { return; }
      if (/^[a-z][a-z\d+.-]*:/i.test(file)) return;
    }
    if (!file && el.matches('code') && !el.closest('pre')) {
      const text = el.textContent.trim();
      if (/^(?:\.{0,2}\/|[\w@.-]+\/)[^\n]+$/.test(text) || /^[\w.-]+\.[a-z\d]{1,12}$/i.test(text)) file = text;
    }
    if (!file || file.length > 4096) return;
    const match = file.match(/^(.*?)(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)$/);
    const line = match ? Number(match[2] || match[3]) : null;
    if (match) file = match[1];
    event.preventDefault();
    event.stopImmediatePropagation();
    window.parent.postMessage({ type: 'hwb:file-preview', path: file, line,
      sessionId: new URL(location.href).searchParams.get('session') }, parentOrigin);
  }, true);
})();
