/**
 * The page script that keeps the side bar, the secondary side bar and the panel closed in a Code tab (the spike's route R6a,
 * docs/spike-chrome.md). No setting hides the side bar, and the other two come back from layout state a profile has saved,
 * so the script does what a person would: it runs the workbench's own close commands. The commands are bound to chords the
 * plugin seeds into the browser profile's keybindings (`chromeKeybindings()`), and the script presses a chord whenever its
 * part is on screen. A MutationObserver presses again if a part comes back (a command palette reveal, a user rule), so the
 * parts stay closed; it is the observer's own events that drive it, not a timer, and it reads nothing but the page's DOM.
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

/** `ctrl+alt+shift+4` as the key event fields a page script dispatches. Only the chords of this plugin (ctrl+alt+shift plus a digit). */
export function chordEvent(entry: KeybindingEntry): { key: string; code: string; keyCode: number } {
  const m = /^ctrl\+alt\+shift\+(\d)$/.exec(entry.key);
  if (!m) throw new Error(`not a chrome chord: ${entry.key}`);
  return { key: m[1], code: `Digit${m[1]}`, keyCode: 48 + Number(m[1]) };
}

export function buildChromeHideScript(): string {
  const parts = closeRoutes().map((r) => ({ selector: r.selector, ...chordEvent(r) }));
  const others = chordEvent(CLOSE_OTHER_EDITORS);
  return `(() => {
  if (window.__vscwChrome) return ${JSON.stringify(CHROME_SCRIPT_INSTALLED)};
  const parts = ${JSON.stringify(parts)};
  const others = ${JSON.stringify(others)};
  const editorSelector = ${JSON.stringify(EDITOR_SELECTOR)};
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
  const sweep = () => {
    for (const p of parts) if (shown(p.selector)) press(p);
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
