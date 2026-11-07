/**
 * Reads whether the page holds an unsaved buffer. With VS Code's own tab strip hidden (the Code tab shows only the editor) the one
 * signal left is the window title: the workbench puts "●" in front of it while the ACTIVE editor is dirty (chosen in the chrome
 * spike, docs/spike-chrome.md S5). The plugin writes `window.title` itself (`DIRTY_TITLE_SETTINGS` in src/chrome-settings.ts), so a
 * copied user setting cannot drop the mark. Every Code tab holds one file, so the active editor is the tab's file: no file name is
 * read, and a second file of the same name in another folder cannot be mistaken for it. The result is `true` or `false`.
 *
 * When the signal is not there the script THROWS instead of answering: the page has no workbench, its title is empty, or a title that
 * carries no dirty mark does not have the SHAPE the plugin's own template produces (`DIRTY_TITLE_SETTINGS`: the active editor's name, a
 * separator, the app name; the separator is " \u2014 " or " - " depending on the platform). `executeJavaScript` then rejects and the caller
 * reads the tab as `unreadable`, which the guard treats as unsaved, never as clean (`npm run check:workbench` checks the signal against a
 * real workbench). This catches a title that is built some other way (a VS Code update, or a workspace `window.title` such as
 * `${activeEditorShort}` that wins over the plugin's setting). It cannot catch one that keeps this shape and only drops the mark (say a
 * workspace setting `${activeEditorShort}${separator}${appName}`): the page offers no second signal with the tab strip hidden, so the
 * README names that case.
 */
export const DIRTY_SCRIPT = `(() => {
  const title = document.title || "";
  if (title.startsWith("\\u25cf")) return true;
  if (title === "" || document.querySelector(".monaco-workbench") === null) throw new Error("the window title is not readable");
  if (document.querySelector(".part.editor .monaco-editor[data-uri]") !== null && !/\\s[\\u2014-]\\s/.test(title)) throw new Error("the window title does not have the shape the plugin writes");
  return false;
})()`;
