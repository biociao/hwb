/**
 * dsh-hwb-open-session — Client 半
 *
 * 每 ~1s 轮询同源只读路由 `/api/hwb-open-session`；发现新的（未过期的）触发器就调用
 * `ctx.sessions.open(sessionId)`，把当前 UI 切到 hwb 指定的会话。
 *
 * 为什么是轮询而不是推送：Host 半只需要一个只读路由（与 dsh-finder-reveal 同款），
 * 不引入新的连接/协议；本机 1 req/s 的代价可以忽略。触发器带 expiresAt，最长 2 分钟，
 * 不会在 App 重启后把很久以前的会话重新打开。
 *
 * 可靠性约定（dsh 进程内插件的异步异常会拖垮整个 App，见 dsh-app-boot README）：
 *   · tick 内所有 await 都包在 try/catch 里，永不产生 unhandled rejection；
 *   · 用 setTimeout 串行调度，避免上一轮未结束时堆叠请求；
 *   · 已处理的 id 写入 localStorage，刷新/重启不重复打开；
 *   · sessions 快照未 ready 时下一轮重试；同一 id 连续 3 次找不到会话就放弃（避免刷屏）。
 */

window.__ModuleLoader__.load({
  id: "dsh-hwb-open-session",
  factory: () => {
    var module = { exports: {} };
    var exports = module.exports;

    var ROUTE = "/api/hwb-open-session";
    // 默认 1s；测试/调试可通过 window.__HWB_OPEN_SESSION_POLL_MS 覆盖（不改变生产行为）。
    var POLL_MS = Number(window.__HWB_OPEN_SESSION_POLL_MS) > 0 ? Number(window.__HWB_OPEN_SESSION_POLL_MS) : 1000;
    var LAST_KEY = "hwb:open-session:last";
    var MAX_MISSES = 3;
    var inject = ["sessions"];

    function readLast() {
      try {
        return window.localStorage.getItem(LAST_KEY) || null;
      } catch (_error) {
        return null;
      }
    }

    function saveLast(id) {
      try {
        window.localStorage.setItem(LAST_KEY, id);
      } catch (_error) {
        /* 隐私模式/配额：只影响「刷新后不重复打开」，不影响本次 */
      }
    }

    function apply(ctx) {
      var stopped = false;
      var timer = null;
      var lastId = readLast();
      var pending = null; // { id, misses }

      /**
       * 切会话的正确入口随 dsh 版本换过：0.2.x 里 `ctx.sessions` 只负责 Host 目录与引用分配，
       * **视图选择（openSession）在 `uiWorkspace` 服务上**；0.1.x 的会话服务曾有 open()。
       * 这里按「uiWorkspace 优先、旧 sessions.open 兜底」解析，解析不到就下一轮再试
       * （ui-workspace 插件可能比本插件晚激活）。
       * @returns {((id:string)=>void)|null}
       */
      function sessionOpener() {
        var workspace = null;
        try {
          workspace = typeof ctx.get === "function" ? ctx.get("uiWorkspace") : undefined;
        } catch (_error) {
          workspace = undefined;
        }
        if (workspace === undefined || workspace === null) workspace = ctx.uiWorkspace;
        if (workspace !== undefined && workspace !== null && typeof workspace.openSession === "function") {
          return function (id) { workspace.openSession(id); };
        }
        if (ctx.sessions !== undefined && ctx.sessions !== null && typeof ctx.sessions.open === "function") {
          return function (id) { ctx.sessions.open(id); };
        }
        return null;
      }

      /**
       * @returns {"opened"|"unchanged"|"wait"|"unknown"}
       */
      function openNow(sessionId) {
        var snapshot = ctx.sessions.list.getSnapshot();
        if (snapshot === undefined || snapshot === null || snapshot.phase !== "ready") return "wait";
        if (snapshot.byId === undefined || snapshot.byId[sessionId] === undefined) return "unknown";
        if (snapshot.current === sessionId) return "unchanged";
        var open = sessionOpener();
        if (open === null) return "wait"; // ui-workspace 还没就绪：下一轮重试
        try {
          open(sessionId);
          return "opened";
        } catch (error) {
          console.warn("[dsh-hwb-open-session] failed to open session", sessionId, error);
          return "unknown";
        }
      }

      function schedule() {
        if (stopped) return;
        timer = setTimeout(tick, POLL_MS);
      }

      async function tick() {
        if (stopped) return;
        try {
          var response = await fetch(ROUTE, { cache: "no-store", credentials: "same-origin" });
          if (response !== undefined && response !== null && response.ok) {
            var data = await response.json();
            if (
              data !== null && typeof data === "object" && data.ok === true &&
              typeof data.id === "string" && data.id !== "" &&
              typeof data.sessionId === "string" && data.sessionId !== "" &&
              (typeof data.expiresAt !== "number" || data.expiresAt > Date.now())
            ) {
              if (data.id !== lastId) {
                var result = openNow(data.sessionId);
                if (result === "opened" || result === "unchanged") {
                  lastId = data.id;
                  pending = null;
                  saveLast(lastId);
                } else if (result === "unknown") {
                  if (pending === null || pending.id !== data.id) pending = { id: data.id, misses: 0 };
                  pending.misses += 1;
                  if (pending.misses >= MAX_MISSES) {
                    // 会话不存在（被删/来自别的 home）：放弃这个 id，别把它变成每秒钟的告警。
                    console.warn("[dsh-hwb-open-session] unknown session", data.sessionId);
                    lastId = data.id;
                    pending = null;
                    saveLast(lastId);
                  }
                }
              }
            }
          }
        } catch (_error) {
          /* 路由未就绪/网络抖动：静默重试，绝不冒泡 */
        }
        schedule();
      }

      schedule();
      ctx.effect(() => () => {
        stopped = true;
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
      });
      console.info("[dsh-hwb-open-session] polling", ROUTE);
    }

    exports.apply = apply;
    exports.inject = inject;

    return module.exports;
  },
});
