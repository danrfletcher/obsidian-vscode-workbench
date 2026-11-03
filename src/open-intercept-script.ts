/**
 * The page script that turns a file opened from inside the editor into an Obsidian tab (PR-4; the route PR-1 chose in
 * docs/spike-chrome.md S2). Go to Definition, Cmd+P quick open or a link makes VS Code show another file in the tab. The script
 * watches the editor's `data-uri` and the cursor line, and once the new file and line have been steady for a moment it reports
 * them through `console.log` (the Code tab reads the webview's console messages). The tab then asks the plugin to open that file
 * as a Code tab of its own and calls `window.__vscwOpen.restore()`, which presses the seeded close-editor chord so this tab shows
 * its own file again at its own cursor. If the opened file already holds unsaved edits in this tab, VS Code answers the close with
 * its "Do you want to save" prompt; restore() then cancels the prompt and presses the show-previous-editor chord instead, so the
 * tab still shows its own file and the edits are kept (never saved or discarded for the user). Nothing of VS Code is patched; the
 * script reads the DOM and presses seeded chords.
 *
 * The first file the page shows is the tab's own: it never triggers a report (the file the tab was loaded with). Only
 * `vscode-remote:` files are reported; a settings page, an untitled file or an output channel opens inside the tab as VS Code
 * would. The report carries a nonce the Code tab made for this load, so a message printed by an extension is not taken for one.
 *
 * It also keeps the tab to one editor group (E4): VS Code's own editor splits have no tab strip to be dragged from here, but the
 * palette's "Split Editor" still works, so a second visible group makes the script press the join-all-groups chord.
 *
 * Best effort (F3, F7): if VS Code renames what the script looks for, nothing is reported and the file opens inside the tab as
 * VS Code would. One observer, a fixed budget of join presses.
 */
import { CLOSE_ACTIVE_EDITOR, JOIN_ALL_GROUPS, SHOW_PREVIOUS_EDITOR } from "./chrome-settings";
import { chordEvent, MODAL_SELECTOR } from "./chrome-script";

/** What the script answers when it has been installed. */
export const OPEN_INTERCEPT_INSTALLED = "installed";

/** A report is the console message `<OPEN_REPORT_PREFIX><nonce>:<json>`; the json is `{"uri": string, "line": number | null}`. */
export const OPEN_REPORT_PREFIX = "__vscw_open__";

/** How long the new file and line must stay as they are before they are reported (the cursor lands a moment after the file shows). */
export const OPEN_SETTLE_MS = 250;

/**
 * The most join-groups presses one page load may make: the budget stops a join command that does not merge the groups from looping.
 * The close-editor press of restore() is the user's own open, one per report, and does not spend it (a long session opens many files).
 */
export const OPEN_PRESS_BUDGET = 100;

export interface OpenReport {
  uri: string;
  line: number | null;
}

/** Read the console message a page printed: the report, or null when it is not a report with this nonce. */
export function parseOpenReport(message: unknown, nonce: string): OpenReport | null {
  const head = `${OPEN_REPORT_PREFIX}${nonce}:`;
  if (typeof message !== "string" || !message.startsWith(head)) return null;
  try {
    const r = JSON.parse(message.slice(head.length)) as { uri?: unknown; line?: unknown };
    if (typeof r.uri !== "string" || r.uri === "") return null;
    return { uri: r.uri, line: typeof r.line === "number" && Number.isFinite(r.line) ? r.line : null };
  } catch {
    return null;
  }
}

/**
 * What restore() answers (it is asynchronous: the page script waits to see whether VS Code asks to save):
 * "pressed" the close-editor chord was pressed and no prompt followed;
 * "switched" the opened editor held unsaved edits, so the prompt was cancelled and the previous editor was shown instead (the edits stay);
 * "blocked by a dialog" another modal dialog was already up, so nothing was pressed;
 * "dialog stays" the save prompt did not go away when cancelled, so the tab may still show the other file;
 * "no budget" / "not installed" as before.
 */
export const RESTORE_SWITCHED = "switched";

/** The script that puts the opened editor away; run in the page by the Code tab after it has handed the file on. */
export const RESTORE_OPEN_SCRIPT = `(() => { const o = window.__vscwOpen; return o ? o.restore() : "not installed"; })()`;

export function buildOpenInterceptScript(nonce: string): string {
  const close = chordEvent(CLOSE_ACTIVE_EDITOR);
  const join = chordEvent(JOIN_ALL_GROUPS);
  return `(() => {
  if (window.__vscwOpen) return ${JSON.stringify(OPEN_INTERCEPT_INSTALLED)};
  const tag = ${JSON.stringify(`${OPEN_REPORT_PREFIX}${nonce}:`)};
  const log = console.log.bind(console);
  const close = ${JSON.stringify(close)};
  const join = ${JSON.stringify(join)};
  const show = ${JSON.stringify(chordEvent(SHOW_PREVIOUS_EDITOR))};
  const modalSelector = ${JSON.stringify(MODAL_SELECTOR)};
  const editorSelector = ".part.editor .monaco-editor[data-uri]";
  const groupSelector = ".part.editor .editor-group-container";
  let budget = ${OPEN_PRESS_BUDGET};
  let own = null;
  let reported = null;
  let pending = false;
  const shown = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const press = (c, free) => {
    if (!free) {
      if (budget <= 0) return "no budget";
      budget--;
    }
    const o = { key: c.key, code: c.code, keyCode: c.keyCode, which: c.keyCode, ctrlKey: true, altKey: true, shiftKey: true, bubbles: true, cancelable: true };
    const target = document.activeElement || document.body;
    for (const t of ["keydown", "keyup"]) target.dispatchEvent(new KeyboardEvent(t, o));
    return "pressed";
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const modal = () => document.querySelector(modalSelector) !== null;
  const escape = () => {
    const o = { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true };
    const target = document.activeElement || document.body;
    for (const t of ["keydown", "keyup"]) target.dispatchEvent(new KeyboardEvent(t, o));
  };
  const read = () => {
    const ed = [...document.querySelectorAll(editorSelector)].find(shown);
    const al = ed ? ed.querySelector(".line-numbers.active-line-number") : null;
    const line = al ? Number(al.textContent) : NaN;
    return { uri: ed ? ed.getAttribute("data-uri") : null, line: Number.isFinite(line) && line >= 1 ? line : null };
  };
  const look = () => {
    if ([...document.querySelectorAll(groupSelector)].filter(shown).length > 1) press(join);
    const s = read();
    if (s.uri === null) return;
    if (own === null) { own = s.uri; return; }
    if (s.uri === own) { reported = null; return; }
    if (s.uri === reported || !s.uri.startsWith("vscode-remote:") || pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      const t = read();
      if (t.uri !== s.uri || t.line !== s.line) { look(); return; }
      reported = t.uri;
      log(tag + JSON.stringify({ uri: t.uri, line: t.line }));
    }, ${OPEN_SETTLE_MS});
  };
  const restore = async () => {
    if (modal()) return "blocked by a dialog";
    const opened = read().uri;
    const pressed = press(close, true);
    for (let i = 0; i < 50; i++) {
      await wait(20);
      if (modal()) {
        escape();
        for (let j = 0; j < 25 && modal(); j++) await wait(20);
        if (modal()) return "dialog stays";
        press(show, true);
        return ${JSON.stringify(RESTORE_SWITCHED)};
      }
      if (read().uri !== opened) break;
    }
    return pressed;
  };
  window.__vscwOpen = { restore };
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    setTimeout(() => { queued = false; try { look(); } catch (e) { /* nothing to do: the file just opens inside the tab */ } }, 30);
  }).observe(document.documentElement, { subtree: true, attributes: true, childList: true, attributeFilter: ["data-uri", "class"] });
  look();
  return ${JSON.stringify(OPEN_INTERCEPT_INSTALLED)};
})()`;
}
