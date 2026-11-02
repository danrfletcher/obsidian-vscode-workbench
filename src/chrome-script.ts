/**
 * The page script that keeps the side bar, the secondary side bar and the panel closed in a Code tab (the spike's route R6a,
 * docs/spike-chrome.md), and puts away the activity bar and status bar if a command brings them back (E8). No setting hides the
 * side bar, and the other two come back from layout state a profile has saved, so the script does what a person would: it runs
 * the workbench's own close commands. The commands are bound to chords the plugin seeds into the browser profile's keybindings
 * (the keybinding overlay, src/keybinding-overlay.ts; the chords are `closeRoutes()`), and the script presses a chord whenever
 * its part is on screen. The activity bar and status bar have no close command, only a toggle: the settings hide them at every
 * load, so the script only ever presses their toggle when they are on screen, which is a reveal. A MutationObserver presses
 * again if a part comes back (a command palette reveal, a user rule, a terminal opening the panel), so the parts stay closed; it is the observer's own events that drive it, not a timer, and it reads nothing but the page's DOM.
 * While one of VS Code's modal dialogs is up (the Workspace Trust prompt that a new terminal brings), no key reaches the workbench, so
 * the panel's own hide button is clicked instead of its chord; the dialog is left for the user to answer (F8).
 *
 * It also keeps the tab to its one file: once the first editor shows, it closes every other editor the profile restored
 * (E6). It does not move keyboard focus: the Code tab focuses the webview itself when the page is ready (CodeView.focusWhenReady).
 *
 * Best effort (F3, F7): if VS Code renames a part's class, `shown()` never matches and the script presses nothing, so the
 * chrome shows as in 0.1.0 and nothing throws. Not a retry layer: one observer, a fixed budget of presses so a command that
 * does not hide its part cannot loop.
 */
import { CLOSE_OTHER_EDITORS, closeRoutes, type KeybindingEntry } from "./chrome-settings";

/** What the script answers when it has been installed. Anything else the Code tab gets back (timeout, unsupported, error:...) is logged. */
export const CHROME_SCRIPT_INSTALLED = "installed";

/** The most chord presses one page load may make, so a command that never hides its part cannot spin. */
export const CHROME_PRESS_BUDGET = 200;

/** The selector of the editor the script waits for, then closes the other editors. */
export const EDITOR_SELECTOR = ".part.editor .monaco-editor[data-uri]";

/** VS Code's modal dialog (the Workspace Trust prompt, the save prompt). While it is up it stops every key event at itself, so no chord gets through. */
export const MODAL_SELECTOR = ".monaco-dialog-modal-block";

/** `ctrl+alt+shift+4` as the key event fields a page script dispatches. Only the chords of this plugin (ctrl+alt+shift plus a digit). */
export function chordEvent(entry: KeybindingEntry): { key: string; code: string; keyCode: number } {
  const m = /^ctrl\+alt\+shift\+(\d)$/.exec(entry.key);
  if (!m) throw new Error(`not a chrome chord: ${entry.key}`);
  return { key: m[1], code: `Digit${m[1]}`, keyCode: 48 + Number(m[1]) };
}

export function buildChromeHideScript(): string {
  const parts = closeRoutes().map((r) => ({ selector: r.selector, button: r.button, ...chordEvent(r) }));
  const others = chordEvent(CLOSE_OTHER_EDITORS);
  return `(() => {
  if (window.__vscwChrome) return ${JSON.stringify(CHROME_SCRIPT_INSTALLED)};
  const parts = ${JSON.stringify(parts)};
  const others = ${JSON.stringify(others)};
  const editorSelector = ${JSON.stringify(EDITOR_SELECTOR)};
  const modalSelector = ${JSON.stringify(MODAL_SELECTOR)};
  let budget = ${CHROME_PRESS_BUDGET};
  let editorDone = false;
  let queued = false;
  window.__vscwChrome = true;
  const shown = (selector) => {
    const e = document.querySelector(selector);
    if (!e) return false;
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const press = (c) => {
    if (budget <= 0) return;
    budget--;
    const o = { key: c.key, code: c.code, keyCode: c.keyCode, which: c.keyCode, ctrlKey: true, altKey: true, shiftKey: true, bubbles: true, cancelable: true };
    const target = document.activeElement || document.body;
    for (const t of ["keydown", "keyup"]) target.dispatchEvent(new KeyboardEvent(t, o));
  };
  // A part that is open behind a modal dialog (a panel that "Terminal: Create New Terminal" opened while VS Code asks whether to trust the
  // folder): the dialog swallows the chord, so the part's own hide button is clicked instead, and the dialog is left as it is (F8). A part
  // with no button waits; the dialog going away changes the page, and the sweep then presses its chord.
  const click = (p) => {
    const b = p.button && document.querySelector(p.button);
    if (!b || budget <= 0) return;
    budget--;
    b.click();
  };
  const sweep = () => {
    const modal = !!document.querySelector(modalSelector);
    for (const p of parts) if (shown(p.selector)) { if (modal) click(p); else press(p); }
    if (!editorDone && shown(editorSelector)) {
      editorDone = true;
      press(others);
    }
  };
  const later = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (f) => Promise.resolve().then(f);
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    // Best effort: a page that is going away (or a layout the script does not understand) must not surface as an error.
    later(() => { queued = false; try { sweep(); } catch (e) { /* nothing to do: the part just stays as it is */ } });
  }).observe(document.documentElement, { subtree: true, attributes: true, childList: true, attributeFilter: ["class", "style"] });
  sweep();
  return ${JSON.stringify(CHROME_SCRIPT_INSTALLED)};
})()`;
}
