import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { addWorkspaceFinderMenu } from '../src/control/workspace-menu.js';

const exec = promisify(execFile);

// workspace-menu.js 把「在 Finder 中打开工作区」注入 dsh 客户端 bundle 的原生菜单，
// 以便菜单的键盘导航/焦点/关闭行为仍然由 dsh 自己管。注入失败必须 fail-closed（原样返回）。

// 形状取自真实的 @deepseek-ai/dsh-client-ui-workspace/lib/client.js（关键两个锚点）。
const FIXTURE = `
function ProjectRowItem({ group, onToggle, onCreate, actions, drag, home, t }) {
	const row = group;
	const label = row.workspaceId === void 0 ? t("group.ungrouped") : row.label;
	const [menuOpen, setMenuOpen] = (0, react.useState)(false);
	const workspaceMenuItems = [{
		id: "rename",
		label: t("rename"),
		icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconEditOutline16, {})
	}, {
		id: "delete",
		label: t("delete.workspace"),
		icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconTrashOutline16, {})
	}];
	const onSelect = (id) => {
		if (id !== "rename" && id !== "delete") return;
		actions[id](row.workspaceId);
	};
}
`;

test('注入改动会同时打上 items 与 handler 两个锚点', () => {
  const out = addWorkspaceFinderMenu(FIXTURE);
  assert.notEqual(out, FIXTURE, '两个锚点都在时应发生替换');
  assert.match(out, /hwb-finder/);
  assert.match(out, /hwb:open-workspace/);
  assert.match(out, /IconFolderOpen16/);
});

test('菜单项只在有 workspaceId 的行上出现（未分组行不该显示一个点了没反应的项）', () => {
  // 「未分组」那一行的 workspaceId 是 undefined（groupByWorkspace → buildGroup("", void 0, …)）。
  // 无条件插入会让它显示同样的菜单项，点击时 detail 为 undefined，桥接层按「必须是 string」丢弃。
  const out = addWorkspaceFinderMenu(FIXTURE);
  assert.match(out, /row\.workspaceId === void 0 \? \[\] : \[\{/, '应按 row.workspaceId 条件展开');
  assert.doesNotMatch(out, /const workspaceMenuItems = \[\{\s*\n\s*id: "hwb-finder"/, '不能无条件插在最前面');
});

test('注入后的模块仍是合法 JS', async () => {
  const out = addWorkspaceFinderMenu(FIXTURE);
  // `exec` 会在非零退出时抛错，所以语法检查本身是有效断言；但「输出为空」也能通过 --check，
  // 那样这条用例就变成空跑 —— 显式断言注入确实发生了。
  assert.ok(out.length > FIXTURE.length, '注入后应当变长');
  assert.match(out, /在 Finder 中打开工作区/, '应含注入的菜单项文字');
  const file = `${process.env.TMPDIR ?? '/tmp'}/hwb-ws-menu-check-${process.pid}.mjs`;
  await (await import('node:fs/promises')).writeFile(file, out);
  await exec(process.execPath, ['--check', file]);
  await (await import('node:fs/promises')).rm(file, { force: true });
});

test('锚点缺失时 fail-closed（原样返回，不产出半截注入）', () => {
  assert.equal(addWorkspaceFinderMenu(''), '');
  assert.equal(addWorkspaceFinderMenu('const workspaceMenuItems = [];'), 'const workspaceMenuItems = [];',
    '只有 items 锚点、没有 handler 锚点时必须原样返回');
  assert.equal(addWorkspaceFinderMenu('if (id !== "rename" && id !== "delete") return;'), 'if (id !== "rename" && id !== "delete") return;',
    '只有 handler 锚点时必须原样返回');
});

test('针对真实安装的 dsh bundle 注入（存在时；验证锚点仍然匹配）', async (t) => {
  const candidates = [
    process.env.HWB_DSH_CLIENT_BUNDLE,
    '/Users/ciao/.nvm/versions/node/v22.21.1/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js',
  ].filter(Boolean);
  const real = candidates.find((p) => existsSync(p));
  if (!real) { t.skip('本机没有安装 dsh 客户端 bundle'); return; }

  const src = readFileSync(real, 'utf8');
  const out = addWorkspaceFinderMenu(src);
  assert.notEqual(out, src, `锚点失配：${path.basename(real)} 的集成点变了，注入会静默失效`);
  assert.match(out, /row\.workspaceId === void 0 \? \[\] : \[\{/);
  // 真实 bundle 注入后必须仍是合法 JS，否则会在浏览器里炸掉整个应用
  const file = `${process.env.TMPDIR ?? '/tmp'}/hwb-ws-real-${process.pid}.mjs`;
  await (await import('node:fs/promises')).writeFile(file, out);
  await exec(process.execPath, ['--check', file]).catch((e) => {
    throw new Error(`注入真实 bundle 后语法非法: ${e.stderr || e.message}`);
  });
  await (await import('node:fs/promises')).rm(file, { force: true });
});
