import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { addFileUploadControl } from '../src/control/file-upload.js';

const exec = promisify(execFile);

// file-upload.js 给 dsh 右侧 Sidebar 内置的「文件」树头部注入一个「上传到此处」工具按钮：
// 按一下 → window.__hwbUploadFiles(state.root) → 同页桥接把 File 清单转给 hwb 父页 →
// 父页走 /api/homes/:id/upload（本机直写、远端经 SSH 分片）。
// 注入失败必须 fail-closed（原样返回），否则会产出半截 JS 炸掉整个 web 应用。

// 形状取自真实的 @deepseek-ai/dsh-client-ui-sidebar-files/lib/client.js
// （FilesBody 的 header：路径行 + 重载工具，重载带 data-files-reload）。
const FIXTURE = `
function FilesBody({ useTabInfo, sessionId, useSessions, useStore, actions, start, load, toggle, t }) {
	const { tab } = useTabInfo();
	const state = useStore((store) => store.byTab[tab.id]);
	const reload = () => {};
	const { directory, name } = pathPartsOf(state.root);
	return (0, react_jsx_runtime.jsxs)("div", {
		className: FilesBody_module_css_default.root,
		children: [(0, react_jsx_runtime.jsxs)("div", {
			className: FilesBody_module_css_default.header,
			children: [(0, react_jsx_runtime.jsx)("div", {
				className: FilesBody_module_css_default.path,
				title: state.root,
				"data-files-path": true
			}), (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: FilesBody_module_css_default.tool,
				"aria-label": t("reload"),
				title: t("reload"),
				"data-files-reload": true,
				onClick: reload,
				children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconRefreshOutline16, {})
			})]
		})]
	});
}
`;

test('注入：「文件」树头部多一个「上传到此处」工具，且插在重载工具之前（同为 header children）', () => {
  const out = addFileUploadControl(FIXTURE);
  assert.notEqual(out, FIXTURE, '两个锚点都在时应发生替换');
  assert.match(out, /"data-hwb-upload": true/);
  assert.match(out, /window\.__hwbUploadFiles\?\.\(state\.root\)/, '按钮要把当前工作区根交给桥接');
  assert.match(out, /上传到此处/);
  // 位置：注入块必须落在 header children 数组内的重载工具之前（否则就不是头部的兄弟节点）。
  const injected = out.indexOf('data-hwb-upload');
  const reloadTool = out.indexOf('"data-files-reload": true');
  assert.ok(injected > 0 && reloadTool > injected, `注入点应在重载工具之前（injected=${injected} reload=${reloadTool}）`);
  assert.match(out, /\}\),\s*\(0, react_jsx_runtime\.jsx\)\("button", \{\s*type: "button",\s*className: FilesBody_module_css_default\.tool,\s*"aria-label": t\("reload"\),/,
    '注入块要以「闭合本元素 + 逗号」接到重载工具上，才是同一 children 数组里的兄弟节点');
});

test('图标缺失时退化为文字，不让整页炸掉', () => {
  const out = addFileUploadControl(FIXTURE);
  assert.match(out, /IconPlusOutline16 === void 0 \? "上传" :/, 'primitives 收紧导出时只少个图标，不是崩掉');
});

test('样式类名取自 bundle 自己（上游改 CSS module 变量名时不会引用到不存在的变量）', () => {
  // 写死 `FilesBody_module_css_default` 是**语法合法但运行时 ReferenceError** 的错：
  // 上游换了变量名，锚点仍匹配、node --check 仍通过，注入的按钮却会在渲染时把整棵文件树带崩。
  const renamed = FIXTURE.replaceAll('FilesBody_module_css_default', 'Fb_css');
  const out = addFileUploadControl(renamed);
  assert.notEqual(out, renamed, '锚点不该依赖那个变量名');
  assert.match(out, /className: Fb_css\.tool/);
  assert.doesNotMatch(out, /FilesBody_module_css_default/);
});

test('注入后的模块仍是合法 JS', async () => {
  const out = addFileUploadControl(FIXTURE);
  assert.ok(out.length > FIXTURE.length, '注入后应当变长');
  const file = `${process.env.TMPDIR ?? '/tmp'}/hwb-ul-check-${process.pid}.mjs`;
  await (await import('node:fs/promises')).writeFile(file, out);
  // exec 会在非零退出时抛错，所以语法检查本身是有效断言。
  await exec(process.execPath, ['--check', file]);
  await (await import('node:fs/promises')).rm(file, { force: true });
});

test('锚点缺失时 fail-closed（原样返回，不产出半截注入）', () => {
  assert.equal(addFileUploadControl(''), '');
  assert.equal(addFileUploadControl('"data-files-reload": true'), '"data-files-reload": true',
    '只有 marker、没有按钮开标签锚点时必须原样返回');
  const onlyTool = '(0, react_jsx_runtime.jsx)("button", { type: "button", className: FilesBody_module_css_default.tool, "aria-label": t("reload"),';
  assert.equal(addFileUploadControl(onlyTool), onlyTool,
    '只有按钮开标签时必须原样返回');
  // 文件树之外的另一棵树（例如会话树）里也有 button.tool，但没有 data-files-reload：不动它。
  const otherTree = '(0, react_jsx_runtime.jsx)("button", {\n type: "button",\n className: SessionTree_module_css_default.tool,\n title: "重新读取"\n}),';
  assert.equal(addFileUploadControl(otherTree), otherTree);
});

test('针对真实安装的 dsh bundle 注入（存在时；验证锚点仍然匹配）', async (t) => {
  // 用 tests/compat 的 dsh 定位器，而不是写死本机的 nvm 路径 —— 否则这条用例在
  // 别人的机器 / CI 上永远 skip（「看起来绿，其实没测」）。显式 env 仍可覆盖。
  const { locateDsh, findDshPackage } = await import('./compat/dsh-contract.mjs');
  const candidates = [process.env.HWB_DSH_SIDEBAR_FILES_BUNDLE].filter(Boolean);
  const loc = locateDsh();
  if (loc.root) {
    const pkg = findDshPackage(loc.root, 'dsh-client-ui-sidebar-files');
    if (pkg) candidates.push(path.join(pkg, 'lib', 'client.js'));
  }
  const real = candidates.find((p) => existsSync(p));
  if (!real) { t.skip('本机没有安装 dsh 的 sidebar-files bundle'); return; }

  const src = readFileSync(real, 'utf8');
  const out = addFileUploadControl(src);
  assert.notEqual(out, src, `锚点失配：${path.basename(real)} 的集成点变了，注入会静默失效`);
  assert.match(out, /"data-hwb-upload": true/);
  // 真实 bundle 注入后必须仍是合法 JS，否则会在浏览器里炸掉整个应用。
  const file = `${process.env.TMPDIR ?? '/tmp'}/hwb-ul-real-${process.pid}.mjs`;
  await (await import('node:fs/promises')).writeFile(file, out);
  await exec(process.execPath, ['--check', file]).catch((e) => {
    throw new Error(`注入真实 bundle 后语法非法: ${e.stderr || e.message}`);
  });
  await (await import('node:fs/promises')).rm(file, { force: true });
});
