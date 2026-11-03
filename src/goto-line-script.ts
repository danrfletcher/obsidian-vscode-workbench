/**
 * The page script that puts the cursor of a Code tab's editor on a line (PR-4; docs/spike-chrome.md S2: a line cannot travel in the
 * `openFile` payload, so the tab asks the editor itself). It waits for the editor to show, presses the seeded Go to Line chord
 * (`GO_TO_LINE`), types `:<line>` into the quick input it opens and presses Enter. Go to Line clamps a line past the end of the
 * file to the last line. Best effort (F3): it answers why it did nothing and never throws, and a tab whose editor never shows
 * keeps whatever cursor VS Code gave it.
 */
import { GO_TO_LINE } from "./chrome-settings";
import { chordEvent } from "./chrome-script";
import { normalizeLine } from "./paths";

/** What the script answers when it moved the cursor. Anything else is the reason it did not. */
export const GO_TO_LINE_DONE = "went";

/** The longest the script waits for the editor to show before it gives up (the quick input gets 2 s per chord, three chords). */
export const GO_TO_LINE_WAIT_MS = 15000;

/** What a caller allows the whole script: the wait for the editor, three chords, and the typing. */
export const GO_TO_LINE_TOTAL_MS = GO_TO_LINE_WAIT_MS + 8000;

export function buildGoToLineScript(line: unknown): string {
  const chord = chordEvent(GO_TO_LINE);
  return `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const shown = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const chord = ${JSON.stringify(chord)};
  const line = ${normalizeLine(line)};
  const until = async (find, ms) => {
    for (let i = 0; i < ms / 100; i++) {
      const found = find();
      if (found) return found;
      await sleep(100);
    }
    return null;
  };
  try {
    if (!(await until(() => [...document.querySelectorAll(".part.editor .monaco-editor[data-uri]")].find(shown), ${GO_TO_LINE_WAIT_MS}))) return "no editor";
    // The first chord after a load can reach the page before the workbench has bound its keys: ask again, up to three times.
    let input = null;
    for (let attempt = 0; attempt < 3 && !input; attempt++) {
      await sleep(attempt === 0 ? 500 : 200);
      const o = { key: chord.key, code: chord.code, keyCode: chord.keyCode, which: chord.keyCode, ctrlKey: true, altKey: true, shiftKey: true, bubbles: true, cancelable: true };
      const target = document.activeElement || document.body;
      for (const t of ["keydown", "keyup"]) target.dispatchEvent(new KeyboardEvent(t, o));
      input = await until(() => [...document.querySelectorAll(".quick-input-widget input")].find(shown), 2000);
    }
    if (!input) return "no quick input";
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ":" + line);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(300);
    const enter = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
    for (const t of ["keydown", "keyup"]) input.dispatchEvent(new KeyboardEvent(t, enter));
    return ${JSON.stringify(GO_TO_LINE_DONE)};
  } catch (e) {
    return "error:" + (e && e.message ? e.message : String(e));
  }
})()`;
}
