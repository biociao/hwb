// #note 提示条。它挂在 dashboard 之外（dashboard 每轮 SSE 刷新都会重建 innerHTML），
// 所以是「跨刷新存活」的那一条。但**存活多久**取决于提示的种类：
//
//   · 普通提示：刷新失败、部分数据加载失败、实时通道断开 —— 描述的是「刚刚那一轮出了问题」，
//     下一次成功刷新/重连就该撤掉（否则顶栏写着 live、下面还挂着「已断开」）。
//   · 粘性提示：描述的是「需要你处理的事实」，例如添加实例时服务端回的
//     「这个目录看起来不像 dsh home」。刷新成功与通道重连都**不该**把它抹掉 ——
//     独立审查用真浏览器实测：添加后立即可见，下一次 SSE 刷新（有实时轮询时 ≤3s）就 hidden=true，
//     用户根本来不及看到/处理。（原实现里 `refresh()` 无条件 `note.hidden = true`。）
//
// 抽成独立模块是因为 app.js 无法在测试里加载（需要整套 DOM），而这段语义值得有回归测试。
export function createNote(el) {
  let sticky = false;
  return {
    // sticky: true → 后续的成功刷新/重连都不会撤掉它
    set(text, { sticky: isSticky = false } = {}) {
      sticky = isSticky;
      if (el) {
        el.textContent = text;
        el.hidden = false;
      }
    },
    clear() {
      sticky = false;
      if (el) {
        el.hidden = true;
        el.textContent = '';
      }
    },
    // 「这一轮成功了」：撤掉上一次的失败提示，但粘性提示不属于失败提示。
    clearUnlessSticky() {
      if (!sticky) this.clear();
    },
    get sticky() { return sticky; },
  };
}
