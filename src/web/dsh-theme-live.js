// Runs inside the proxied dsh document (injected into index.html by src/control/proxy.js).
//
// 职责：让 hwb 的主题切换**立刻**作用到已经打开的 dsh 页面，而不必等 dsh 自己的
// settings 热重载 + 前端重渲染（那条路要等 watcher 去抖 + 一次 RPC，实测有 200ms–1s 级延迟，
// 且页面在后台标签页时更慢）。
//
// 做法刻意与 hwb 主界面保持一致：dsh 的深浅两套调色板由 `body[data-ds-dark-theme]` 与
// `documentElement.style.colorScheme` 共同决定（见 dsh-client-ui-layout 的 ThemePresenter）。
// 这里只**镜像**同一个开关，不往页面里注入任何自定义样式 —— 一旦 dsh 那边因为 settings
// 热重载也应用了主题，两边写的是同一个属性、同一个值，不会打架。
//
// 唯一的例外是 `system`：dsh 自己会跟随 `prefers-color-scheme`，而 iframe 的媒体查询
// 与宿主浏览器一致，因此这里也按同一个媒体查询解析，保持「跟随系统」语义不变。
(() => {
  if (window.parent === window) return;   // 只有被 hwb 嵌入时才有宿主可通信
  const DARK_ATTR = 'data-ds-dark-theme';
  let parentOrigin;
  let current = null;      // 宿主下发的偏好：light | dark | system | null（未知）
  let media = null;

  function resolve(preference) {
    if (preference === 'light' || preference === 'dark') return preference;
    // system（或未知）：跟随 iframe 自己的媒体查询 —— 它与宿主浏览器同源同设置。
    try { return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; }
    catch { return 'light'; }
  }

  function apply(preference) {
    current = preference;
    const scheme = resolve(preference);
    // 与 dsh 的 ThemePresenter 写的是同样两处：body 的调色板属性 + root 的 color-scheme。
    // 因为写的是同一个属性、同一个值，dsh 随后自己应用主题时只是**覆盖成相同结果**，不会打架。
    if (scheme === 'dark') document.body?.setAttribute(DARK_ATTR, '');
    else document.body?.removeAttribute(DARK_ATTR);
    try { document.documentElement.style.colorScheme = scheme; } catch { /* 只读实现（测试假 DOM）忽略 */ }
  }

  window.addEventListener('message', (event) => {
    // 与 preview-bridge 同样的校验：只接受来自**真实父窗口**的初始化/主题消息。
    if (event.source !== window.parent || event.origin === 'null') return;
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'hwb:theme-init') {
      parentOrigin = event.origin;
      apply(typeof data.preference === 'string' ? data.preference : null);
      return;
    }
    if (data.type === 'hwb:theme' && event.origin === parentOrigin) {
      apply(typeof data.preference === 'string' ? data.preference : null);
    }
  });

  // system 模式下，操作系统亮暗切换要跟着变。preference 不是 system 时不动。
  try {
    media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener?.('change', () => {
      if (current === 'system' || current === null) apply(current ?? 'system');
    });
  } catch { /* 无 matchMedia 的环境（测试假 DOM）不需要跟随 */ }
})();
