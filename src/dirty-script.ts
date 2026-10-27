/**
 * Reads whether the page holds an unsaved buffer. The VS Code web workbench puts
 * "●" in front of the window title when the active editor is dirty, and marks a
 * dirty editor tab with the class `dirty`. The result is `true` or `false`. It is `true` while ANY editor
 * in the page holds unsaved edits, not only the active one (`npm run check:workbench` checks this against a
 * real workbench).
 */
export const DIRTY_SCRIPT = `(() => {
  if ((document.title || "").startsWith("\u25cf")) return true;
  return document.querySelector(".monaco-workbench .tab.dirty") !== null;
})()`;

/**
 * Reads whether the editor tab of ONE file holds unsaved edits, while the page-wide `DIRTY_SCRIPT` says true because
 * some editor is unsaved. The answer is "clean" only when the page has a tab for that file name and none of the tabs
 * with that name is dirty; "dirty" when one is; "none" when no tab carries the name (tabs hidden by a user setting,
 * or the editor closed), and the caller then keeps the page-wide answer. The tab's `data-resource-name` is the file's
 * base name, so two files with one name in different folders are read together: dirty if either is
 * (`npm run check:workbench` checks this against a real workbench).
 */
export function fileDirtyScript(name: string): string {
  return `((name) => {
  const tabs = [...document.querySelectorAll(".monaco-workbench .tab")].filter((t) => t.getAttribute("data-resource-name") === name);
  if (tabs.length === 0) return "none";
  return tabs.some((t) => t.classList.contains("dirty")) ? "dirty" : "clean";
})(${JSON.stringify(name)})`;
}
