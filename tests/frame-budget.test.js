import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MAX_LIVE_FRAMES,
  planFrameEviction,
  resolveMaxLiveFrames,
  touchFrameOrder,
} from '../src/web/frame-budget.js';

// 背景：每个实例 iframe 都是一整个 dsh web SPA，原来「切走只 hidden、永不销毁」，
// 于是浏览器内存随「访问过的实例数」单调增长（实测一个 WebKit WebContent 进程 2.3GB，
// Safari 直接以「占用过多内存」重载页面）。下面锁住的是预算策略本身。

test('默认预算是有界的，且 ?frames=N 只能把它调小/调大而不是关掉', () => {
  assert.equal(resolveMaxLiveFrames(''), DEFAULT_MAX_LIVE_FRAMES);
  assert.equal(resolveMaxLiveFrames('?x=1'), DEFAULT_MAX_LIVE_FRAMES);
  assert.equal(resolveMaxLiveFrames('?frames=2'), 2);
  assert.equal(resolveMaxLiveFrames('?frames=1'), 1);
  // 上限只防呆：不能靠一个天文数字把保护彻底关掉。
  assert.equal(resolveMaxLiveFrames('?frames=99999'), 64);
});

test('非法预算一律回退默认值：预算必须是 ≥1 的整数', () => {
  for (const bad of ['?frames=0', '?frames=-3', '?frames=2.5', '?frames=abc', '?frames=', '?frames=NaN', '?frames=Infinity']) {
    assert.equal(resolveMaxLiveFrames(bad), DEFAULT_MAX_LIVE_FRAMES, `${bad} 必须回退默认值`);
  }
  // 0 若被接受，每次进入实例都会立刻释放自己 → 面板永远空白。
  assert.notEqual(resolveMaxLiveFrames('?frames=0'), 0);
});

test('LRU 记账把刚用过的面板移到末尾，且不改写入参', () => {
  const order = ['a', 'b', 'c'];
  const next = touchFrameOrder(order, 'a');
  assert.deepEqual(next, ['b', 'c', 'a']);
  assert.deepEqual(order, ['a', 'b', 'c'], '入参不能被就地修改');
  assert.deepEqual(touchFrameOrder(['a', 'b'], 'new'), ['a', 'b', 'new']);
  assert.deepEqual(touchFrameOrder(['a', 'b'], null), ['a', 'b'], '空 id 只做去重外的清理');
});

test('未超预算时不释放任何 iframe', () => {
  assert.deepEqual(planFrameEviction(['a', 'b'], { limit: 3, keep: ['b'] }), []);
  assert.deepEqual(planFrameEviction(['a', 'b', 'c'], { limit: 3, keep: ['c'] }), []);
  assert.deepEqual(planFrameEviction([], { limit: 1 }), []);
});

test('超预算时从最旧的开始释放，绝不释放正在看的面板', () => {
  // 4 个活跃、预算 2、当前看的是最新的 d：释放最旧的 a、b。
  assert.deepEqual(planFrameEviction(['a', 'b', 'c', 'd'], { limit: 2, keep: ['d'] }), ['a', 'b']);
  // 当前看的如果恰好在最旧的一端，也不能动它 —— 宁可这轮少释放一个。
  assert.deepEqual(planFrameEviction(['a', 'b', 'c'], { limit: 1, keep: ['a'] }), ['b', 'c']);
  // 正在看的不在活跃列表里（例如刚从工作台切过来），此时没有需要保护的 id。
  assert.deepEqual(planFrameEviction(['a', 'b', 'c'], { limit: 2, keep: [null] }), ['a']);
});

test('预算非法时不释放：宁可多占内存，也不要误伤用户正在看的面板', () => {
  assert.deepEqual(planFrameEviction(['a', 'b', 'c'], { limit: 0, keep: ['c'] }), []);
  assert.deepEqual(planFrameEviction(['a', 'b', 'c'], { limit: Number.NaN, keep: ['c'] }), []);
  assert.deepEqual(planFrameEviction(['a', 'b', 'c'], { limit: undefined, keep: [] }), [], '缺省即默认预算，不越界就不释放');
});

test('活跃列表里混入空值时不影响计数与顺序', () => {
  assert.deepEqual(planFrameEviction([null, 'a', undefined, 'b', 'c'], { limit: 2, keep: ['c'] }), ['a']);
});
