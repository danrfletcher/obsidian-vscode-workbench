/**
 * Reads whether the page holds an unsaved buffer. With VS Code's own tab strip hidden (the Code tab shows only the editor) the one
 * signal left is the window title: the workbench puts "●" in front of it while the ACTIVE editor is dirty (chosen in the chrome
 * spike, docs/spike-chrome.md S5). The plugin writes `window.title` itself (`DIRTY_TITLE_SETTINGS` in src/chrome-settings.ts), so a
 * copied user setting cannot drop the mark. Every Code tab holds one file, so the active editor is the tab's file: no file name is
 * read, and a second file of the same name in another folder cannot be mistaken for it. The result is `true` or `false`.
 *
 * When the signal is not there the script THROWS instead of answering: the page has no workbench, or its title is empty (a VS Code
 * update that changed how the title is built would end up here). `executeJavaScript` then rejects and the caller reads the tab as
 * `unreadable`, which the guard treats as unsaved, never as clean (`npm run check:workbench` checks the signal against a real
 * workbench).
 */
export const DIRTY_SCRIPT = `(() => {
  const title = document.title || "";
  if (title.startsWith("\\u25cf")) return true;
  if (title === "" || document.querySelector(".monaco-workbench") === null) throw new Error("the window title is not readable");
  return false;
})()`;
