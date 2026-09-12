// 普通标签切换复用 iframe；入口变化（隧道换端口、token 更新等）必须重新认证。
export function planPaneNavigation(pane, url, sessionId, force = false) {
  const entryChanged = force || pane.url !== url;
  const wantSession = !!sessionId && pane.deeplink;
  const sessionChanged = wantSession && sessionId !== pane.sessionId;
  if (pane._iframed && !entryChanged && !sessionChanged) return null;

  const cookieReady = !entryChanged && pane._cookieReady;
  let finalTarget = url;
  if (wantSession) {
    // dsh 的 token 入口会重定向并丢弃 query；先认证，再进入无 token 的会话 URL。
    const target = new URL(url);
    target.searchParams.delete('token');
    target.searchParams.set('session', sessionId);
    finalTarget = target.toString();
  }
  return {
    firstTarget: wantSession && !cookieReady ? url : finalTarget,
    finalTarget,
    cookieReady,
    sessionId: sessionId || (entryChanged ? null : pane.sessionId),
  };
}

// 后台重建连接后，已打开面板直接采用服务器的新入口，不另发 /open 请求。
export function planPaneRecovery(pane, runtime) {
  if (!pane?._iframed || pane._opening || runtime?.runtime !== 'running' || !runtime.url) return null;
  // 兼容尚未提供 iframeUrl 的状态响应：原外部入口没变时保留已建立的预览代理。
  if (!runtime.iframeUrl && runtime.url === pane.externalUrl) return null;
  const url = runtime.iframeUrl || runtime.url;
  const force = url === pane.url && !!pane.externalUrl && runtime.url !== pane.externalUrl;
  if (url === pane.url && !force) return null;
  return { url, externalUrl: runtime.url, deeplink: !!runtime.deeplink, sessionId: pane.sessionId, ...(force ? { force: true } : {}) };
}

// 认证中间页报告的空会话不能覆盖待恢复会话；正常 SPA 切换则跟随其当前选择。
export function updatePaneSession(pane, sessionId) {
  if (pane._opening || pane._navTarget) return false;
  const next = sessionId || null;
  if (next === pane.sessionId) return false;
  pane.sessionId = next;
  return true;
}
