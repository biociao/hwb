// 给 dsh 内置的文档预览加一个「下载到本机」工具按钮。
//
// 为什么需要它：dsh 的预览只有「读」—— 右侧 Sidebar 的「文件」树点开一个文件后，只能看，
// 不能把文件本体取回浏览器；远端实例上连「用宿主应用打开」都被 canOpenPath/isLoopback 挡掉。
// hwb 自己有一条能用的下载（/api/homes/:id/download，远端经 SSH 读回来），但那条路在
// 「文件预览」侧栏里，从 dsh 的预览 tab 够不着。
//
// 注入的按钮**不自己发请求**：它只 dispatch 一个 CustomEvent，由同页的 preview-bridge 转给
// hwb 父页，父页再走 /api/homes/:id/download（本机直读、远端经 SSH）。这样鉴权、工作区围栏、
// 64 MiB 上限全部留在 hwb 那一侧，注入的代码不碰它们；协议与 workspace-menu.js 的
// hwb:open-workspace 完全一致（同样是「dispatch → bridge 转发 → 父页执行」）。
//
// fail-closed：两个锚点任一失配就原样返回。宁可没有按钮，也不能产出半截 JS 把整个 web 应用炸掉。
/**
 * dsh 0.1.5 的预览头部：重载按钮是 header children 里的最后一个工具。这两个锚点一起确认
 * 「这是预览头部、且重载工具还在」—— 只有它们都在时才插入。
 */
const RELOAD_MARKER = '"data-textpreview-tool": "reload"';
// 重载 Tooltip 的**开标签**（缩进随构建而变，所以用宽松空白匹配，不写死制表符）。
// 注入就发生在它前面，于是新按钮成为 header children 数组里的一个兄弟节点。
// 末尾那个捕获组是重载按钮自己的 className —— 也就是**这个 bundle 的 CSS module 变量名**
// （`TextPreview_module_css_default`）。引号里的内容必须跟着上游走，不能写死：上游换名时锚点
// 仍会匹配，写死就会让注入的按钮引用一个不存在的变量、渲染时抛 ReferenceError 把整页打崩
// （`node --check` 抓不到这种错，所以契约测试也拦不住）。
const RELOAD_TOOL_OPEN = /\(0,\s*react_jsx_runtime\.jsx\)\(_deepseek_ai_dsh_client_ui_primitives\.Tooltip,\s*\{\s*label:\s*t\("reload"\),[\s\S]{0,600}?className:\s*([A-Za-z0-9_$]+)\.tool,/;
/**
 * 注入的按钮：与相邻工具同样的样式与 Tooltip 外壳；图标缺失时退化为文字「下载」，
 * 这样即使上游收紧了 primitives 的导出，也只是少个图标而不是整页崩掉。
 * @param {string} css - 锚点里捕获到的 CSS module 变量名。
 * @returns {string} 插在重载工具之前的 React 元素源码。
 */
function downloadButton(css) {
  return `(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
	label: "下载到本机",
	side: "bottom",
	delayMs: 500,
	children: (0, react_jsx_runtime.jsx)("button", {
		type: "button",
		className: ${css}.tool,
		"aria-label": "下载到本机",
		"data-hwb-download": true,
		onClick: () => {
			window.dispatchEvent(new CustomEvent("hwb:download-file", {
				detail: file.path
			}));
		},
		children: _deepseek_ai_dsh_client_ui_primitives.IconDownloadOutline16 === void 0 ? "下载" : (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconDownloadOutline16, {})
	})
}), `;
}

export function addFileDownloadControl(source) {
  if (typeof source !== 'string' || !source.includes(RELOAD_MARKER) || !RELOAD_TOOL_OPEN.test(source)) return source;
  // 用函数式替换：注入文本里有 `$` 时不会被当成替换模式展开；第二个参数是捕获到的 CSS 变量名。
  return source.replace(RELOAD_TOOL_OPEN, (match, css) => downloadButton(css) + match);
}
