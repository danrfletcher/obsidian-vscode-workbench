import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GO_TO_LINE_DONE, buildGoToLineScript } from "../../src/goto-line-script";
import { OPEN_INTERCEPT_INSTALLED, OPEN_REPORT_PREFIX, OPEN_SETTLE_MS, RESTORE_OPEN_SCRIPT, buildOpenInterceptScript, parseOpenReport } from "../../src/open-intercept-script";

// jsdom ships no types; a fresh page per test (see tests/unit/chrome-script.test.ts).
interface JSDOM {
  window: Window & typeof globalThis & { eval(code: string): unknown; close(): void };
}
const { JSDOM } = createRequire(import.meta.url)("jsdom") as { JSDOM: new (html: string, opts: { runScripts: "outside-only" }) => JSDOM };

const NONCE = "n0nce-1";
const OWN = "vscode-remote://127.0.0.1:5555/v/pd.js";
const OTHER = "vscode-remote://127.0.0.1:5555/v/helper.js";

let dom: JSDOM;
let document: Document;
let logs: string[];
let presses: string[];
/** What the workbench does when the close-editor chord (digit 5) arrives; null when it does nothing (a refused close). */
let onClose: (() => void) | null;
/** What the workbench does when the show-previous-editor chord (digit 0) arrives. */
let onPrevious: (() => void) | null;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = () => sleep(OPEN_SETTLE_MS + 200);

/** The page: one editor element at a time, as the workbench shows it. jsdom has no layout, so a part is sized by being in the document. */
function showEditor(uri: string | null, line: number | null): void {
  document.querySelector(".part.editor .monaco-editor[data-uri]")?.remove();
  const part = document.querySelector(".part.editor") ?? document.body.appendChild(Object.assign(document.createElement("div"), { className: "part editor" }));
  if (uri === null) return;
  const ed = part.appendChild(Object.assign(document.createElement("div"), { className: "monaco-editor" }));
  ed.setAttribute("data-uri", uri);
  if (line !== null) ed.appendChild(Object.assign(document.createElement("div"), { className: "line-numbers active-line-number", textContent: String(line) }));
}
function setLine(line: number): void {
  const n = document.querySelector(".part.editor .line-numbers.active-line-number") as HTMLElement;
  n.textContent = String(line);
  n.className = "line-numbers active-line-number"; // an attribute change, as the workbench's re-render is
  (n.parentElement as HTMLElement).className = "monaco-editor focused";
}

beforeEach(() => {
  dom = new JSDOM("<!doctype html><body></body>", { runScripts: "outside-only" });
  const win = dom.window as unknown as Window & typeof globalThis;
  document = win.document;
  logs = [];
  presses = [];
  onClose = null;
  onPrevious = null;
  (win.console as unknown as { log: (m: string) => void }).log = (m: string) => void logs.push(m);
  win.Element.prototype.getBoundingClientRect = function (this: Element) {
    const n = this.matches(".part.editor, .monaco-editor, .editor-group-container") ? 100 : 0;
    return { width: n, height: n, top: 0, left: 0, right: n, bottom: n, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.altKey && e.shiftKey) {
      presses.push(e.key);
      if (e.key === "5") onClose?.();
      if (e.key === "0") onPrevious?.();
    }
  });
});
afterEach(() => dom.window.close());

const install = () => dom.window.eval(buildOpenInterceptScript(NONCE)) as string;
const reports = () => logs.map((l) => parseOpenReport(l, NONCE)).filter((r) => r !== null);

describe("the open-from-editor page script", () => {
  it("installs once; a second run on the same page adds no second watcher", async () => {
    showEditor(OWN, 1);
    expect(install()).toBe(OPEN_INTERCEPT_INSTALLED);
    expect(install()).toBe(OPEN_INTERCEPT_INSTALLED);
    showEditor(OTHER, 5);
    await settle();
    expect(reports()).toHaveLength(1);
  });

  it("does not report the file the tab was loaded with, nor a cursor that moves inside it", async () => {
    install();
    showEditor(OWN, 1); // the first editor that shows is the tab's own
    await settle();
    setLine(40);
    await settle();
    expect(logs).toEqual([]);
    expect(presses).toEqual([]);
  });

  it("reports a different file once it has settled, with its line", async () => {
    showEditor(OWN, 3);
    install();
    showEditor(OTHER, 5);
    await settle();
    expect(reports()).toEqual([{ uri: OTHER, line: 5 }]);
    expect(logs[0].startsWith(`${OPEN_REPORT_PREFIX}${NONCE}:`)).toBe(true);
  });

  it("waits for the cursor to land: the line reported is the final one, not the first one the file showed", async () => {
    showEditor(OWN, 3);
    install();
    showEditor(OTHER, 1);
    await sleep(OPEN_SETTLE_MS / 3);
    setLine(5);
    await settle(); // the line changed during the wait: the file must then stay steady for a full wait again
    await settle();
    expect(reports()).toEqual([{ uri: OTHER, line: 5 }]);
  });

  it("a target with no line numbers shown is reported with a null line", async () => {
    showEditor(OWN, 3);
    install();
    showEditor(OTHER, null);
    await settle();
    expect(reports()).toEqual([{ uri: OTHER, line: null }]);
  });

  it("reports a file only once while it stays on screen", async () => {
    showEditor(OWN, 3);
    install();
    showEditor(OTHER, 5);
    await settle();
    setLine(6);
    await settle();
    expect(reports()).toHaveLength(1);
  });

  it("does not report while the editor is swapped (no editor on screen for a moment)", async () => {
    showEditor(OWN, 3);
    install();
    showEditor(null, null);
    await settle();
    expect(logs).toEqual([]);
  });

  it("only reports files of the workbench's remote file system: a settings page or an untitled file stays inside the tab", async () => {
    showEditor(OWN, 3);
    install();
    for (const uri of ["vscode-userdata://127.0.0.1:5555/User/settings.json", "untitled:Untitled-1", "output:extension-output"]) {
      showEditor(uri, 1);
      await settle();
    }
    expect(logs).toEqual([]);
  });

  it("restore() presses the close-editor chord; after the own file is back, the same target is reported again (E3 a second time)", async () => {
    showEditor(OWN, 3);
    install();
    showEditor(OTHER, 5);
    await settle();
    onClose = () => showEditor(OWN, 3); // what the chord does in the workbench
    expect(await dom.window.eval(RESTORE_OPEN_SCRIPT)).toBe("pressed");
    expect(presses).toEqual(["5"]);
    await settle();
    showEditor(OTHER, 5);
    await settle();
    expect(reports()).toHaveLength(2);
  });

  it("restore() presses every time, however many files a long session has opened: it does not spend the join budget (R1)", async () => {
    showEditor(OWN, 3);
    install();
    // a few real report/restore cycles through the observer ...
    for (let i = 0; i < 3; i++) {
      showEditor(OTHER, 5 + i);
      await settle();
      expect(reports()).toHaveLength(i + 1);
      onClose = () => showEditor(OWN, 3);
      expect(await dom.window.eval(RESTORE_OPEN_SCRIPT)).toBe("pressed");
      await settle();
    }
    // ... and past the 100-press budget
    for (let i = 3; i < 105; i++) {
      showEditor(OTHER, 5);
      expect(await dom.window.eval(RESTORE_OPEN_SCRIPT)).toBe("pressed");
    }
    expect(presses).toHaveLength(105);
    // the budget is still the join loop's: used up by joins, restore() still presses
    const part = document.querySelector(".part.editor") as HTMLElement;
    for (let i = 0; i < 2; i++) part.appendChild(Object.assign(document.createElement("div"), { className: "editor-group-container" }));
    for (let i = 0; i < 110; i++) {
      part.className = i % 2 ? "part editor a" : "part editor b";
      await sleep(40); // past the observer's 30 ms debounce, so each change is looked at and presses a join
    }
    await sleep(100);
    expect(presses.length - 105).toBe(100); // the join budget is spent
    showEditor(OTHER, 5);
    expect(await dom.window.eval(RESTORE_OPEN_SCRIPT)).toBe("pressed");
    expect(presses).toHaveLength(206);
  }, 20000);

  it("restore() before the script is installed says so and presses nothing", () => {
    expect(dom.window.eval(RESTORE_OPEN_SCRIPT)).toBe("not installed");
    expect(presses).toEqual([]);
  });

  // T1: the opened file already holds unsaved edits in this tab (a backup the workbench restored, or edits typed before the
  // intercept saw it), so VS Code answers the close with its save prompt and the tab would be left showing the other file.
  describe("restore() when VS Code asks to save the opened file", () => {
    const showSavePrompt = () => {
      const block = document.body.appendChild(Object.assign(document.createElement("div"), { className: "monaco-dialog-modal-block" }));
      const button = block.appendChild(document.createElement("button"));
      button.focus();
      block.addEventListener("keydown", (e) => {
        if ((e as KeyboardEvent).key === "Escape") block.remove(); // the prompt's Cancel
      });
    };
    const prompt = () => document.querySelector(".monaco-dialog-modal-block");

    it("cancels the prompt and shows the previous editor, so the tab shows its own file again with the edits kept", async () => {
      showEditor(OWN, 3);
      install();
      showEditor(OTHER, 1);
      await settle();
      expect(reports()).toHaveLength(1);
      onClose = showSavePrompt; // the close is refused: the editor stays and the prompt shows
      onPrevious = () => showEditor(OWN, 3);
      expect(await dom.window.eval(RESTORE_OPEN_SCRIPT)).toBe("switched");
      expect(presses).toEqual(["5", "0"]); // close, then show-previous: never the Save or Don't Save button
      expect(prompt()).toBeNull();
      expect((document.querySelector(".part.editor .monaco-editor[data-uri]") as HTMLElement).getAttribute("data-uri")).toBe(OWN);
      // the opened editor is still open behind it (its edits are kept): the same target is reported again when it is reached again
      await settle();
      showEditor(OTHER, 1);
      await settle();
      expect(reports()).toHaveLength(2);
    });

    it("never presses a Save or Don't Save button: the prompt is answered with Escape only", async () => {
      showEditor(OWN, 3);
      install();
      showEditor(OTHER, 1);
      await settle();
      let clicked = 0;
      onClose = () => {
        showSavePrompt();
        document.querySelector(".monaco-dialog-modal-block button")?.addEventListener("click", () => clicked++);
      };
      onPrevious = () => showEditor(OWN, 3);
      await dom.window.eval(RESTORE_OPEN_SCRIPT);
      expect(clicked).toBe(0);
    });

    it("says so when the prompt does not go away, and does not press the previous-editor chord over it", async () => {
      showEditor(OWN, 3);
      install();
      showEditor(OTHER, 1);
      await settle();
      onClose = () => void document.body.appendChild(Object.assign(document.createElement("div"), { className: "monaco-dialog-modal-block" }));
      expect(await dom.window.eval(RESTORE_OPEN_SCRIPT)).toBe("dialog stays");
      expect(presses).toEqual(["5"]);
    });

    it("does nothing when another modal dialog is already up (it would answer a prompt that is not ours)", async () => {
      showEditor(OWN, 3);
      install();
      showEditor(OTHER, 1);
      await settle();
      showSavePrompt();
      expect(await dom.window.eval(RESTORE_OPEN_SCRIPT)).toBe("blocked by a dialog");
      expect(presses).toEqual([]);
      expect(prompt()).not.toBeNull();
    });

    it("a clean opened file is closed without the previous-editor chord", async () => {
      showEditor(OWN, 3);
      install();
      showEditor(OTHER, 1);
      await settle();
      onClose = () => showEditor(OWN, 3);
      expect(await dom.window.eval(RESTORE_OPEN_SCRIPT)).toBe("pressed");
      expect(presses).toEqual(["5"]);
    });
  });

  it("joins the editor groups when a second one shows (E4: Split Editor from the palette), and not for one group", async () => {
    showEditor(OWN, 3);
    install();
    const part = document.querySelector(".part.editor") as HTMLElement;
    part.appendChild(Object.assign(document.createElement("div"), { className: "editor-group-container" }));
    showEditor(OWN, 3); // a change the observer sees
    await sleep(100);
    expect(presses).toEqual([]);
    part.appendChild(Object.assign(document.createElement("div"), { className: "editor-group-container" }));
    part.appendChild(Object.assign(document.createElement("div"), { className: "editor-group-container" }));
    await sleep(100);
    expect(presses).toContain("8");
  });

  it("stops pressing after its fixed budget, so a command that does not merge the groups cannot loop", async () => {
    showEditor(OWN, 3);
    install();
    const part = document.querySelector(".part.editor") as HTMLElement;
    for (let i = 0; i < 2; i++) part.appendChild(Object.assign(document.createElement("div"), { className: "editor-group-container" }));
    for (let i = 0; i < 150; i++) {
      part.className = i % 2 ? "part editor a" : "part editor b";
      await sleep(1);
    }
    await sleep(100);
    expect(presses.length).toBeLessThanOrEqual(100);
  });

  it("a page that throws inside the watcher does not surface an error", async () => {
    showEditor(OWN, 3);
    install();
    (document as unknown as { querySelectorAll: unknown }).querySelectorAll = () => {
      throw new Error("VS Code changed the page");
    };
    showEditor(OTHER, 5);
    await settle();
    expect(logs).toEqual([]);
  });

  it("reads and presses only: it never touches the tab strip or the settings (E7, F1)", () => {
    const text = buildOpenInterceptScript(NONCE);
    expect(text).not.toMatch(/showTabs|tabs-and-actions|fetch\(|XMLHttpRequest|WebSocket|indexedDB|localStorage|innerHTML|\.remove\(\)/);
    expect(text.match(/console\.\w+/g)).toEqual(["console.log"]); // the one bound log it reports through
  });
});

describe("parseOpenReport", () => {
  const msg = (nonce: string, body: unknown) => `${OPEN_REPORT_PREFIX}${nonce}:${typeof body === "string" ? body : JSON.stringify(body)}`;

  it("reads a report with this load's nonce", () => {
    expect(parseOpenReport(msg(NONCE, { uri: OTHER, line: 5 }), NONCE)).toEqual({ uri: OTHER, line: 5 });
    expect(parseOpenReport(msg(NONCE, { uri: OTHER, line: null }), NONCE)).toEqual({ uri: OTHER, line: null });
  });

  it.each([
    ["another nonce (a message an extension printed)", msg("other", { uri: OTHER, line: 5 })],
    ["no nonce", `${OPEN_REPORT_PREFIX}:${JSON.stringify({ uri: OTHER, line: 5 })}`],
    ["not JSON", msg(NONCE, "{oops")],
    ["no uri", msg(NONCE, { line: 5 })],
    ["an empty uri", msg(NONCE, { uri: "", line: 5 })],
    ["a uri that is not text", msg(NONCE, { uri: 5, line: 5 })],
    ["a message that is not about this", "hello"],
    ["not text", 42],
    ["nothing", undefined],
  ])("ignores %s", (_name, message) => {
    expect(parseOpenReport(message, NONCE)).toBeNull();
  });

  it("a line that is not a finite number is null, so the tab never asks for a bad line", () => {
    for (const line of ["5", NaN, null, {}, "x"]) expect(parseOpenReport(msg(NONCE, { uri: OTHER, line }), NONCE)?.line, String(line)).toBeNull();
  });
});

describe("the go-to-line page script", () => {
  const typed: string[] = [];
  let quick: HTMLInputElement | null;

  beforeEach(() => {
    typed.length = 0;
    quick = null;
    const win = dom.window as unknown as Window & typeof globalThis;
    const real = win.Element.prototype.getBoundingClientRect;
    win.Element.prototype.getBoundingClientRect = function (this: Element) {
      if (this.matches(".quick-input-widget input")) return { width: 50, height: 10, top: 0, left: 0, right: 50, bottom: 10, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
      return real.call(this);
    };
    // the workbench's side of the chord: Go to Line shows its quick input; Enter in it takes the text
    document.addEventListener("keydown", (e) => {
      if (e.ctrlKey && e.altKey && e.shiftKey && e.key === "9") {
        const w = document.body.appendChild(Object.assign(document.createElement("div"), { className: "quick-input-widget" }));
        quick = w.appendChild(document.createElement("input"));
      }
      if (e.key === "Enter" && quick && e.target === quick) typed.push(quick.value);
    });
  });

  it.each([
    [5, ":5"],
    [1, ":1"],
    [0, ":1"],
    [-4, ":1"],
    ["abc", ":1"],
    [NaN, ":1"],
    ["12", ":12"],
    [100000, ":100000"],
  ])("line %j types %s into Go to Line", async (line, expected) => {
    showEditor(OWN, 1);
    expect(await dom.window.eval(buildGoToLineScript(line))).toBe(GO_TO_LINE_DONE);
    expect(typed).toEqual([expected]);
    expect(presses).toEqual(["9"]);
  });

  it("waits for the editor to show before it presses anything", async () => {
    const run = dom.window.eval(buildGoToLineScript(7)) as Promise<string>;
    await sleep(300);
    expect(presses).toEqual([]);
    showEditor(OWN, 1);
    expect(await run).toBe(GO_TO_LINE_DONE);
    expect(typed).toEqual([":7"]);
  });

  it("a line that is not a number can never put script text in the page", () => {
    const text = buildGoToLineScript("5; document.title = 'x'");
    expect(text).toContain("const line = 1;");
    expect(text).not.toContain("document.title = 'x'");
  });
});
