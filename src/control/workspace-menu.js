// Extend the native menu so keyboard navigation, focus and dismissal stay with dsh.
// Fail closed if an upstream release changes either integration point.
export function addWorkspaceFinderMenu(source) {
  const items = 'const workspaceMenuItems = [{';
  const guard = 'if (id !== "rename" && id !== "delete") return;';
  if (!source.includes(items) || !source.includes(guard)) return source;
  return source.replace(items, `const workspaceMenuItems = [{
    id: "hwb-finder", label: "在 Finder 中打开工作区",
    icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconFolderOpen16, {})
  }, {`).replace(guard, `if (id === "hwb-finder") {
    window.dispatchEvent(new CustomEvent("hwb:open-workspace", { detail: row.workspaceId }));
    return;
  }
  ${guard}`);
}
