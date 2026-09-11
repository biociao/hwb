// Extend the native menu so keyboard navigation, focus and dismissal stay with dsh.
// Fail closed if an upstream release changes either integration point.
export function addWorkspaceFinderMenu(source) {
  const items = 'const workspaceMenuItems = [{';
  const guard = 'if (id !== "rename" && id !== "delete") return;';
  if (!source.includes(items) || !source.includes(guard)) return source;
  // 这个数组同时被「未分组」那一行复用：ProjectRowItem 里
  //   `const row = group; const label = row.workspaceId === void 0 ? t("group.ungrouped") : row.label;`
  // 未分组桶的 workspaceId 是 undefined（groupByWorkspace 里 buildGroup("", void 0, …)）。
  // 原先无条件把菜单项插在最前面，于是未分组那一行也会显示「在 Finder 中打开工作区」，
  // 点下去 dispatch 的 detail 是 undefined，桥接层按「必须是 string」丢掉 —— 点了没反应。
  // 因此按 row.workspaceId 做条件展开。
  const injected = `const workspaceMenuItems = [...(row.workspaceId === void 0 ? [] : [{
    id: "hwb-finder", label: "在 Finder 中打开工作区",
    icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconFolderOpen16, {})
  }]), {`;
  const handler = `if (id === "hwb-finder") {
    window.dispatchEvent(new CustomEvent("hwb:open-workspace", { detail: row.workspaceId }));
    return;
  }
  ${guard}`;
  return source.replace(items, injected).replace(guard, handler);
}
