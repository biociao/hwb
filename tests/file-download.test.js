import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { addFileDownloadControl } from '../src/control/file-download.js';

const exec = promisify(execFile);

// file-download.js 给 dsh 内置的文档预览头部注入一个「下载到本机」工具按钮：按一下 →
// dispatch hwb:download-file → 同页桥接转给 hwb 父页 → 父页走 /api/homes/:id/download
// （本机直读、远端经 SSH）。注入失败必须 fail-closed（原样返回），否则会产出半截 JS 炸掉 web 应用。

// 形状取自真实的 @deepseek-ai/dsh-client-ui-sidebar-documentpreview/lib/client.js
// （预览头部：路径行 + 换行工具 + 重载工具；重载是最后一个工具）。
const FIXTURE = `
function TextPreview({ useTabInfo, useResource, actions, t }) {
	const { tab } = useTabInfo();
	const file = (0, react.useMemo)(() => hostFileOf(tab.contentId), [tab.contentId]);
	const state = useStore((s) => s.byTab[tab.id]);
	const reload = () => {};
	return (0, react_jsx_runtime.jsxs)("div", {
		className: TextPreview_module_css_default.preview,
		children: [(0, react_jsx_runtime.jsxs)("div", {
			className: TextPreview_module_css_default.header,
			children: [
				(0, react_jsx_runtime.jsx)("div", {
					className: TextPreview_module_css_default.path,
					title: displayPath,
					"data-textpreview-path": true
				}),
				(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
					label: t("wrap.enable"),
					side: "bottom",
					delayMs: 500,
					children: (0, react_jsx_runtime.jsx)("button", {
						"data-textpreview-tool": "wrap"
					})
				}),
				(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
					label: t("reload"),
					side: "bottom",
					delayMs: 500,
					children: (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: TextPreview_module_css_default.tool,
						"aria-label": t("reload"),
						"data-textpreview-tool": "reload",
						onClick: reload,
						children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconRefreshOutline16, {})
					})
				})
			]
		})]
	});
}
`;

test('注入：预览头部多一个「下载到本机」工具，且插在重载工具之前（同为 header children）', () => {
  const out = addFileDownloadControl(FIXTURE);
  assert.notEqual(out, FIXTURE, '两个锚点都在时应发生替换');
  assert.match(out, /"data-hwb-download": true/);
  assert.match(out, /hwb:download-file/);
  assert.match(out, /file\.path/, '按钮要拿当前预览的路径（TextPreview 的 file 在作用域内）');
  assert.match(out, /下载到本机/);
  // 位置：注入块必须落在 header children 数组内的重载工具之前（否则就不是预览头部的兄弟节点）。
  const injected = out.indexOf('data-hwb-download');
  const reloadTool = out.indexOf('label: t("reload")');
  assert.ok(injected > 0 && reloadTool > injected, `注入点应在重载工具之前（injected=${injected} reload=${reloadTool}）`);
  assert.match(out, /\}\),\s*\(0, react_jsx_runtime\.jsx\)\(_deepseek_ai_dsh_client_ui_primitives\.Tooltip, \{\s*label: t\("reload"\),/,
    '注入块要以「闭合本元素 + 逗号」接到重载工具上，才是同一 children 数组里的兄弟节点');
});

test('图标缺失时退化为文字，不让整页炸掉', () => {
  const out = addFileDownloadControl(FIXTURE);
  assert.match(out, /IconDownloadOutline16 === void 0 \? "下载" :/, 'primitives 收紧导出时只少个图标，不是崩掉');
});

test('样式类名取自 bundle 自己（上游改 CSS module 变量名时不会引用到不存在的变量）', () => {
  // 写死 `TextPreview_module_css_default` 是**语法合法但运行时 ReferenceError** 的错：
  // 上游换了变量名，锚点仍匹配、node --check 仍通过，注入的按钮却会在渲染时把整页带崩。
  const renamed = FIXTURE.replaceAll('TextPreview_module_css_default', 'Tp_css');
  const out = addFileDownloadControl(renamed);
  assert.notEqual(out, renamed, '锚点不该依赖那个变量名');
  assert.match(out, /className: Tp_css\.tool/);
  assert.doesNotMatch(out, /TextPreview_module_css_default/);
});

test('注入后的模块仍是合法 JS', async () => {
  const out = addFileDownloadControl(FIXTURE);
  assert.ok(out.length > FIXTURE.length, '注入后应当变长');
  const file = `${process.env.TMPDIR ?? '/tmp'}/hwb-dl-check-${process.pid}.mjs`;
  await (await import('node:fs/promises')).writeFile(file, out);
  // exec 会在非零退出时抛错，所以语法检查本身是有效断言。
  await exec(process.execPath, ['--check', file]);
  await (await import('node:fs/promises')).rm(file, { force: true });
});

test('锚点缺失时 fail-closed（原样返回，不产出半截注入）', () => {
  assert.equal(addFileDownloadControl(''), '');
  assert.equal(addFileDownloadControl('"data-textpreview-tool": "reload"'), '"data-textpreview-tool": "reload"',
    '只有 marker、没有 Tooltip 开标签锚点时必须原样返回');
  const onlyTool = '(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, { label: t("reload"),';
  assert.equal(addFileDownloadControl(onlyTool), onlyTool,
    '只有 Tooltip 锚点时必须原样返回');
});

test('针对真实安装的 dsh bundle 注入（存在时；验证锚点仍然匹配）', async (t) => {
  // 用 tests/compat 的 dsh 定位器，而不是写死本机的 nvm 路径 —— 否则这条用例在
  // 别人的机器 / CI 上永远 skip（「看起来绿，其实没测」）。显式 env 仍可覆盖。
  const { locateDsh, findDshPackage } = await import('./compat/dsh-contract.mjs');
  const candidates = [process.env.HWB_DSH_DOCPREVIEW_BUNDLE].filter(Boolean);
  const loc = locateDsh();
  if (loc.root) {
    const pkg = findDshPackage(loc.root, 'dsh-client-ui-sidebar-documentpreview');
    if (pkg) candidates.push(path.join(pkg, 'lib', 'client.js'));
  }
  const real = candidates.find((p) => existsSync(p));
  if (!real) { t.skip('本机没有安装 dsh 的 documentpreview bundle'); return; }

  const src = readFileSync(real, 'utf8');
  const out = addFileDownloadControl(src);
  assert.notEqual(out, src, `锚点失配：${path.basename(real)} 的集成点变了，注入会静默失效`);
  assert.match(out, /"data-hwb-download": true/);
  // 真实 bundle 注入后必须仍是合法 JS，否则会在浏览器里炸掉整个应用。
  const file = `${process.env.TMPDIR ?? '/tmp'}/hwb-dl-real-${process.pid}.mjs`;
  await (await import('node:fs/promises')).writeFile(file, out);
  await exec(process.execPath, ['--check', file]).catch((e) => {
    throw new Error(`注入真实 bundle 后语法非法: ${e.stderr || e.message}`);
  });
  await (await import('node:fs/promises')).rm(file, { force: true });
});
