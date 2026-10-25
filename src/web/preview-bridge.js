// Runs inside the proxied dsh document; the parent verifies both source and origin.
//
// 这个桥接**不再接管文件点击**。dsh 0.1.5 自己就把会话里的文件路径与右侧 Sidebar「文件」
// 树的文件行开进 Sidebar 的文档预览（chat 的 `openFile` → `sidebarRight.openResource`），
// 而 hwb 原先的拦截（preventDefault + 自己的文件预览侧栏）恰好把这条原生路径挡掉了。
// 现在预览完全落在 dsh 自己的侧栏里，hwb 只补两件 dsh 没有的事：
//   · 下载到本机（documentpreview 头部注入的按钮 → hwb:download-file）
//   · 上传到工作区（sidebar-files 头部注入的按钮 → hwb:file-upload，见 window.__hwbUploadFiles）
// 注入的控件都不自己发请求：它们只 dispatch/调用本文件里的钩子，由父页走 hwb 的
// /api/homes/:id/*（本机直读、远端经 SSH）。鉴权、工作区围栏与大小上限全部留在 hwb 那一侧。
(() => {
  if (window.parent === window) return;
  let parentOrigin;
  let lastSession;

  function currentSession() {
    try { return new URL(location.href).searchParams.get('session'); } catch { return null; }
  }

  function sendContext() {
    if (!parentOrigin) return;
    const href = location.href;
    const sessionId = currentSession();
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

  // —— 上传：dsh 的「文件」树头部那个注入按钮调用这里 ——
  //
  // 为什么不在这里直接发请求：这个文档是从 hwb 的**反代端口**加载的，相对路径 /api/... 会
  // 被反代原样转给 dsh 上游，根本到不了 hwb 的 API。所以走「桥接 → 父页 → hwb」这条老路：
  // File 对象可以结构化克隆，父子同机，postMessage 传的是引用而不是再拷一份字节。
  const UPLOAD_STATUS_ID = 'hwb-upload-status';
  let statusTimer = null;

  function showUploadStatus(text, tone) {
    let box = document.getElementById(UPLOAD_STATUS_ID);
    if (!box) {
      box = document.createElement('div');
      box.id = UPLOAD_STATUS_ID;
      box.setAttribute('role', 'status');
      box.setAttribute('aria-live', 'polite');
      box.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483000;max-width:420px;'
        + 'padding:9px 12px;border-radius:8px;background:#1f2430;color:#e8ecf3;'
        + 'font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;box-shadow:0 6px 24px #0006';
      document.body.appendChild(box);
    }
    box.textContent = text;
    if (tone === 'error') box.style.background = '#4a1f24';
    else if (tone === 'ok') box.style.background = '#1f3a2a';
    else box.style.background = '#1f2430';
    clearTimeout(statusTimer);
    // 失败信息留久一点：用户往往要看清是哪一条没上去；成功则很快让位。
    if (tone === 'error') statusTimer = setTimeout(() => box.remove(), 20000);
    else if (tone === 'ok') statusTimer = setTimeout(() => box.remove(), 8000);
  }

  function failUpload(text) {
    if (parentOrigin) showUploadStatus(text, 'error');
  }

  window.__hwbUploadFiles = (dir) => {
    if (!parentOrigin) return;
    if (typeof dir !== 'string' || !dir || dir.length > 4096) { failUpload('上传失败：目标目录无效。'); return; }
    let input = document.getElementById('hwb-upload-input');
    if (!input) {
      input = document.createElement('input');
      input.id = 'hwb-upload-input';
      input.type = 'file';
      input.multiple = true;
      input.style.cssText = 'position:fixed;left:-9999px;width:1px;height:1px;opacity:0';
      document.body.appendChild(input);
    }
    input.onchange = () => {
      const files = Array.from(input.files || []);
      input.value = ''; // 同一个文件连选两次也要能触发 change
      if (!files.length) return;
      window.parent.postMessage({ type: 'hwb:file-upload', dir, files,
        sessionId: currentSession() }, parentOrigin);
      showUploadStatus(`正在上传 ${files.length} 个文件…`);
    };
    input.click();
  };

  // 上传结果由父页回传（真正的请求在 hwb 父页/服务端，见 app.js）。
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || event.origin !== parentOrigin) return;
    const data = event.data;
    if (data?.type !== 'hwb:upload-status') return;
    const text = typeof data.text === 'string' ? data.text.slice(0, 512) : '';
    if (!text) return;
    showUploadStatus(text, data.tone === 'ok' ? 'ok' : data.tone === 'error' ? 'error' : 'info');
    // 传完了就让 dsh 的「文件」树重读一次：新文件应当立刻出现在树里，而不必用户手动刷新
    // （树头部的重载按钮就是 dsh 自己的入口，这里只是替用户按一下）。
    if (data.tone === 'ok' && data.reload === true) {
      document.querySelector('[data-files-reload]')?.click();
    }
  });

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

  // 内置文件预览头部那个「下载到本机」按钮（由 file-download.js 注入 bundle）按下时派发。
  // 桥接只负责转交 —— 真正的读取与围栏都在 hwb 父页/服务端，注入的按钮不碰它们。
  window.addEventListener('hwb:download-file', (event) => {
    if (!parentOrigin) return;
    const detail = event.detail;
    if (typeof detail !== 'string' || !detail || detail.length > 4096) return;
    window.parent.postMessage({ type: 'hwb:file-download', path: detail,
      sessionId: currentSession() }, parentOrigin);
  });
})();
