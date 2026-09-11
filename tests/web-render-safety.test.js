import { test } from 'node:test';
import assert from 'node:assert/strict';

// 渲染安全回归。hwb 把 dsh home 的元数据（会话标题 / 项目名 / 权限策略…）直接拼进 HTML 字符串，
// 再交给 innerHTML —— 也就是说**远端实例上的元数据就是不可信输入**：一个被改过的 dsh home，
// 或者 dsh 未来新增的字段，都可能带着 `"><img src=x onerror=…>` 这类内容。
// 这里用最小 globals 顶替浏览器环境（chipColor 会读主题），只依赖组件真正用到的那部分。
globalThis.document = {
  documentElement: { dataset: { theme: 'light' } },
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
};
globalThis.window = { matchMedia: () => ({ matches: false }) };

const { renderRecentSessions } = await import('../src/web/components/recent-sessions.js');
const { renderRecentProjects } = await import('../src/web/components/recent-projects.js');

const PAYLOAD = 'x"><img src=x onerror=alert(1)>';
// 只有在「真的被解析成标签」时才算注入成功。注意不能拿 `onerror=` 之类的**字面量**当判据：
// 正确转义后它仍会作为可见文本原样出现在 HTML 里（无害），那正是我们要的正向证据。
const INJECTED_TAG = /<(?:img|script|svg|iframe|object|embed|body|style|link)\b/i;
const ESCAPED_TAG = /&lt;img/;

function session(status, extra = {}) {
  return { homeId: 'abcdef1234567890', sessionId: 's1', title: 'title', project: 'proj',
    lastActivity: null, status, ...extra };
}

test('recent-sessions: 恶意 approval 不能突破 title 属性（原先的存储型 XSS）', () => {
  const html = renderRecentSessions([session({ kind: 'idle', label: '空闲', subagents: 0, approval: PAYLOAD })]);
  assert.doesNotMatch(html, INJECTED_TAG, 'approval 必须转义，不得产生可执行标签');
  assert.match(html, ESCAPED_TAG, '证据：注入内容应作为转义文本出现');
  assert.match(html, /&quot;/, '双引号应转义为 &quot;，属性不会被提前闭合');
  // 转义后仍是「可见文本」，用户依旧能看到审批策略原文的一部分
  assert.match(html, /审批/);
});

test('recent-sessions: 正常的 approval 照常展示', () => {
  const html = renderRecentSessions([session({ kind: 'running', label: '运行中', subagents: 0, approval: 'never' })]);
  assert.match(html, /审批 never/);
  assert.doesNotMatch(html, /&amp;(?!nbsp)/, '普通文本不应被过度转义');
});

test('recent-sessions: label / subagents 字段同样不可注入', () => {
  const html = renderRecentSessions([session({ kind: 'idle', label: PAYLOAD, subagents: 0 })]);
  assert.doesNotMatch(html, INJECTED_TAG);
});

test('recent-sessions: 会话元数据（title/project/sessionId）逐字段转义', () => {
  const evil = '"><script>alert(1)</script>';
  const html = renderRecentSessions([session({ kind: 'idle', label: '空闲', subagents: 0 },
    { title: evil, project: evil, sessionId: evil, homeId: evil })]);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('recent-sessions: 空状态与缺 status 不崩', () => {
  assert.match(renderRecentSessions([]), /no sessions indexed yet/);
  assert.doesNotMatch(renderRecentSessions([session(undefined)]), INJECTED_TAG);
});

test('recent-projects: 项目名 / 实例别名 / 实例路径逐字段转义', () => {
  const evil = '"><img src=x onerror=alert(1)>';
  const html = renderRecentProjects(
    [{ homeId: 'abcdef1234567890', project: evil, sessionId: evil, lastActivity: null, sessionCount: 1, inputTokens: 0, outputTokens: 0 }],
    [{ homeId: 'abcdef1234567890', alias: evil, homePath: evil }],
  );
  assert.doesNotMatch(html, INJECTED_TAG);
});

test('recent-projects: 无实例信息时不给 chip，避免读 undefined 崩掉', () => {
  const html = renderRecentProjects(
    [{ homeId: 'abcdef1234567890', project: 'p', sessionId: null, lastActivity: null, sessionCount: 0, inputTokens: 0, outputTokens: 0 }],
    [],
  );
  assert.doesNotMatch(html, /home-chip/);
  assert.match(html, /no sessions/);
});
