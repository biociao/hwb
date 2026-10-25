// 给 dsh 右侧 Sidebar 内置的「文件」树加一个「上传到此处」工具按钮。
//
// 为什么需要它：dsh 0.1.5 的文件树只能看与打开（预览由 documentpreview 承担、下载由
// file-download.js 注入），没有把本机文件写回工作区的入口；而 hwb 有一条能用的上传
// （/api/homes/:id/upload，本机直写、远端经 SSH 分片），原先只在 hwb 自己的文件预览侧栏里，
// 从 dsh 的「文件」树够不着。现在预览与浏览都收敛到 dsh 侧栏，上传也补到同一个地方。
//
// 注入的按钮**不自己发请求**：它只调用同页桥接提供的 `window.__hwbUploadFiles(dir)`
// （见 preview-bridge.js），由桥接把 File 对象转给 hwb 父页，父页再走
// /api/homes/:id/upload。这样鉴权、工作区围栏、256 MiB 上限与并发闸门全部留在 hwb 那一侧，
// 注入的代码不碰它们；协议与 file-download 的 hwb:download-file 完全一致。
//
// fail-closed：两个锚点任一失配就原样返回。宁可没有按钮，也不能产出半截 JS 把整个 web 应用炸掉。
/**
 * dsh 0.1.5 的文件树头部：路径行是兄弟里的第一个，重载按钮带 `data-files-reload`。
 * 这个属性既是**存在性标记**（确认这确实是文件树头部），也是**定位锚点**（注入在它前面）。
 */
const RELOAD_MARKER = '"data-files-reload": true';
// 重载按钮的**开标签**（缩进随构建而变，所以用宽松空白，不写死制表符）。注入就发生在它前面，
// 于是新按钮成为 header children 数组里的一个兄弟节点、排在「重新读取」左侧。
// 末尾那个捕获组是**这个 bundle 自己的 CSS module 变量名**（`FilesBody_module_css_default`）：
// 引号里的内容必须跟着上游走，不能写死 —— 上游换名时锚点仍会匹配，写死就会让注入的按钮
// 引用一个不存在的变量、在渲染时抛 ReferenceError 把整棵树打崩（语法检查抓不到这种错）。
const RELOAD_BUTTON_OPEN = /\(0,\s*react_jsx_runtime\.jsx\)\("button",\s*\{\s*type:\s*"button",\s*className:\s*([A-Za-z0-9_$]+)\.tool,\s*"aria-label":\s*t\("reload"\),\s*title:\s*t\("reload"\),\s*"data-files-reload":\s*true,/;
/**
 * 注入的按钮：与 dsh 自己的重载工具同样的外壳（这个头部没有 Tooltip 包裹，只有 title），
 * 目标目录取 `state.root` —— FilesBody 作用域内就是会话工作区根。
 * 图标缺失时退化为文字「上传」，这样即使上游收紧了 primitives 的导出，也只是少个图标而不是整页崩掉。
 * @param {string} css - 锚点里捕获到的 CSS module 变量名。
 * @returns {string} 插在重载工具之前的 React 元素源码。
 */
function uploadButton(css) {
  return `(0, react_jsx_runtime.jsx)("button", {
	type: "button",
	className: ${css}.tool,
	"aria-label": "上传到此处",
	title: "上传到此处",
	"data-hwb-upload": true,
	onClick: () => {
		window.__hwbUploadFiles?.(state.root);
	},
	children: _deepseek_ai_dsh_client_ui_primitives.IconPlusOutline16 === void 0 ? "上传" : (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPlusOutline16, {})
}), `;
}

export function addFileUploadControl(source) {
  if (typeof source !== 'string' || !source.includes(RELOAD_MARKER) || !RELOAD_BUTTON_OPEN.test(source)) return source;
  // 用函数式替换：注入文本里有 `$` 时不会被当成替换模式展开；第二个参数是捕获到的 CSS 变量名。
  return source.replace(RELOAD_BUTTON_OPEN, (match, css) => uploadButton(css) + match);
}
