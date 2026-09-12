import { test } from 'node:test';
import assert from 'node:assert/strict';

// 「运行日志」面板的首屏快照只拉一次，而**失败也被记成「已加载」**：
//   loaded = true 无论成败 → app.js 只调用一次 logInit() → 页面加载时那一次请求失败
//   （后端正在重启 / 瞬时 500）就让面板永远停在「暂无日志」，之后 SSE 的 log:event 只追加新行，
//   没有任何机制补上历史快照。独立审查复现：fetch 返回 500 时连调两次 logInit() 全程只有 1 次请求。
//
// 这里用 fetch 桩 + 最小 DOM 桩驱动真实的 log-panel 模块（它的渲染会被 logRefresh 走到，
// 但 getElementById 返回 null 时是安全的空操作）。

const requests = [];
let mode = 'fail'; // 'fail' | 'ok'

function stubbedDom() {
  const noop = () => null;
  globalThis.document = {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: noop,
    createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {}, addEventListener() {} }),
  };
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    if (mode === 'fail') return { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
    return { ok: true, status: 200, json: async () => ({ logs: [{ ts: '2026-09-12T00:00:00.000Z', level: 'info', scope: 'test', message: 'hello' }] }) };
  };
}

stubbedDom();
const { logInit, appendLog } = await import('../src/web/components/log-panel.js');

test('logInit：首屏拉取失败后**仍然可以重试**（不再永远停在「暂无日志」）', async () => {
  mode = 'fail';
  await logInit();
  assert.equal(requests.length, 1, '第一次尝试');

  await logInit(); // 显式重试不受冷却限制
  assert.equal(requests.length, 2, '失败后必须还能再拉一次（原实现第二次直接被 loaded=true 挡掉）');

  mode = 'ok';
  await logInit();
  assert.equal(requests.length, 3, '后端恢复后应能真正拉到快照');

  await logInit();
  assert.equal(requests.length, 3, '成功之后不再重复拉取');
});

test('logInit：SSE 日志到达时自动补拉历史快照（受冷却限流）', async () => {
  // 上一组测试已经 loaded=true，这里换一个新模块实例来模拟「页面刚打开、首屏拉取失败」
  const mod = await import(`../src/web/components/log-panel.js?fresh=${Math.random()}`);
  mode = 'fail';
  requests.length = 0;
  await mod.logInit();
  assert.equal(requests.length, 1);
  // 失败会记录冷却时间：紧接着的自动补拉应被限流（否则持续 5xx 时每条日志都打一次请求）
  mod.appendLog({ ts: 'x1', level: 'info', message: 'a' });
  mod.appendLog({ ts: 'x2', level: 'info', message: 'b' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(requests.length, 1, `冷却期内不该重复请求，实际 ${requests.length}`);
});
