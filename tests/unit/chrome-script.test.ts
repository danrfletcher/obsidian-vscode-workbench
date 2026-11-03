import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CHROME_PRESS_BUDGET, CHROME_SCRIPT_INSTALLED, EDITOR_SELECTOR, buildChromeHideScript, chordEvent } from "../../src/chrome-script";
import { chromeKeybindings } from "../../src/chrome-settings";

// jsdom ships no types and the other tests use it through the vitest environment; a fresh page per test needs the class itself.
interface JSDOM {
  window: Window & typeof globalThis & { eval(code: string): unknown; close(): void };
}
const { JSDOM } = createRequire(import.meta.url)("jsdom") as { JSDOM: new (html: string, opts: { runScripts: "outside-only" }) => JSDOM };

/**
 * The page script run in a jsdom page standing in for the workbench: parts are elements whose size the test sets (jsdom has
 * no layout), and the chords it presses are read off the keydown events. A chord "closes" its part the way the workbench's
 * own command does, when `obey` says so.
 */
const PARTS = { sideBar: ".part.sidebar", secondarySideBar: ".part.auxiliarybar", panel: ".part.panel", activityBar: ".part.activitybar", statusBar: ".part.statusbar" } as const;
const CHORD_OF: Record<string, keyof typeof PARTS> = { "1": "sideBar", "2": "secondarySideBar", "3": "panel", "6": "statusBar", "7": "activityBar" };

let dom: JSDOM;
let document: Document;
let sizes: Record<string, number>;
let presses: string[];
let obey: boolean;

function addPart(selector: string, size: number): HTMLElement {
  const e = document.createElement("div");
  e.className = selector.replace(/^\./, "").replace(/\./g, " ");
  document.body.appendChild(e);
  sizes[selector] = size;
  return e;
}

// A fresh page for every test: the script's observer lives as long as its page, so a shared page would leak watchers between tests.
beforeEach(() => {
  dom = new JSDOM("<!doctype html><body></body>", { runScripts: "outside-only" });
  const win = dom.window as unknown as Window & typeof globalThis;
  document = win.document;
  sizes = {};
  presses = [];
  obey = true;
  // a frame later, on the page's own timers (closed with the page)
  win.requestAnimationFrame = ((f: FrameRequestCallback) => win.setTimeout(() => f(0), 1)) as never;
  win.Element.prototype.getBoundingClientRect = function (this: Element) {
    const match = Object.keys(sizes).find((s) => this.matches(s));
    const n = match ? sizes[match] : 0;
    return { width: n, height: n, top: 0, left: 0, right: n, bottom: n, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey && e.altKey && e.shiftKey)) return;
    presses.push(e.key);
    const part = CHORD_OF[e.key];
    if (part && obey) sizes[PARTS[part]] = 0;
  });
});
afterEach(() => dom.window.close());

const run = () => dom.window.eval(buildChromeHideScript()) as string;
const settle = () => new Promise((r) => setTimeout(r, 60));

describe("the chrome page script", () => {
  it("presses the chord of every part that shows, once, and nothing for a part that is closed", () => {
    addPart(PARTS.sideBar, 200);
    addPart(PARTS.panel, 100);
    addPart(PARTS.secondarySideBar, 0);
    expect(run()).toBe(CHROME_SCRIPT_INSTALLED);
    expect(presses.sort()).toEqual(["1", "3"]);
  });

  it("presses exactly the seeded chords: ctrl+alt+shift plus the digit of the keybinding for that part's close command", () => {
    const byCommand = Object.fromEntries(chromeKeybindings().map((k) => [k.command, k.key]));
    expect(byCommand["workbench.action.closeSidebar"]).toBe(`ctrl+alt+shift+${Object.keys(CHORD_OF).find((d) => CHORD_OF[d] === "sideBar")}`);
    expect(byCommand["workbench.action.closeAuxiliaryBar"]).toBe("ctrl+alt+shift+2");
    expect(byCommand["workbench.action.closePanel"]).toBe("ctrl+alt+shift+3");
    expect(byCommand["workbench.action.toggleStatusbarVisibility"]).toBe("ctrl+alt+shift+6");
    expect(byCommand["workbench.action.toggleActivityBarVisibility"]).toBe("ctrl+alt+shift+7");
    for (const k of chromeKeybindings()) {
      const e = chordEvent(k);
      expect(k.key).toBe(`ctrl+alt+shift+${e.key}`);
      expect(e.code).toBe(`Digit${e.key}`);
      expect(e.keyCode).toBe(48 + Number(e.key));
    }
  });

  it("presses keydown and keyup with the modifiers set, on the focused element, bubbling", () => {
    const part = addPart(PARTS.sideBar, 200);
    const input = document.createElement("input");
    part.appendChild(input);
    input.focus();
    const seen: Array<{ type: string; target: EventTarget | null; ctrl: boolean; alt: boolean; shift: boolean; code: string }> = [];
    for (const type of ["keydown", "keyup"]) document.addEventListener(type, (e) => seen.push({ type, target: e.target, ctrl: (e as KeyboardEvent).ctrlKey, alt: (e as KeyboardEvent).altKey, shift: (e as KeyboardEvent).shiftKey, code: (e as KeyboardEvent).code }));
    run();
    expect(seen).toEqual([
      { type: "keydown", target: input, ctrl: true, alt: true, shift: true, code: "Digit1" },
      { type: "keyup", target: input, ctrl: true, alt: true, shift: true, code: "Digit1" },
    ]);
  });

  it("presses again when a closed part comes back (the watcher), and not while it stays closed", async () => {
    run();
    expect(presses).toEqual([]);
    addPart(PARTS.panel, 120); // appears after the script was installed
    await settle();
    expect(presses).toEqual(["3"]);
    sizes[PARTS.sideBar] = 0;
    document.body.appendChild(document.createElement("span")); // unrelated change: the panel is closed, nothing is pressed
    await settle();
    expect(presses).toEqual(["3"]);
    addPart(PARTS.sideBar, 180);
    await settle();
    expect(presses).toEqual(["3", "1"]);
  });

  describe("a modal dialog is up (Workspace Trust, from \"Terminal: Create New Terminal\")", () => {
    // VS Code's dialog takes the focus and stops every key event at itself: a chord never reaches the handlers behind it.
    const openDialog = () => {
      const block = document.createElement("div");
      block.className = "monaco-dialog-modal-block dimmed";
      const box = document.createElement("div");
      box.className = "monaco-dialog-box";
      block.appendChild(box);
      document.body.appendChild(block);
      document.defaultView!.addEventListener("keydown", (e) => { if (block.isConnected) e.stopImmediatePropagation(); }, true);
      return block;
    };
    const addHideButton = (part: HTMLElement, selectorSize: string) => {
      const b = document.createElement("a");
      b.className = "action-label codicon codicon-panel-close";
      b.addEventListener("click", () => { sizes[selectorSize] = 0; });
      part.appendChild(b);
      return b;
    };

    it("clicks the panel's own hide button, because the chord is swallowed, and leaves the dialog where it is (E8, F8)", async () => {
      const dialog = openDialog();
      run();
      const panel = addPart(PARTS.panel, 300); // "Create New Terminal" opened the panel behind the dialog
      addHideButton(panel, PARTS.panel);
      await settle();
      expect(sizes[PARTS.panel]).toBe(0);
      expect(presses).toEqual([]); // nothing was pressed: the dialog would have eaten it
      expect(document.body.contains(dialog)).toBe(true);
    });

    it("presses no chord for a part with no hide button while the dialog is up, and presses it once the dialog is gone", async () => {
      const dialog = openDialog();
      run();
      addPart(PARTS.sideBar, 200);
      await settle();
      expect(presses).toEqual([]);
      expect(sizes[PARTS.sideBar]).toBe(200);
      dialog.remove(); // the user answered it: the page changes, the watcher sweeps
      await settle();
      expect(presses).toEqual(["1"]);
      expect(sizes[PARTS.sideBar]).toBe(0);
    });

    it("does not click anything when the dialog is not up: the chord is the route", async () => {
      const panel = addPart(PARTS.panel, 300);
      let clicks = 0;
      addHideButton(panel, PARTS.panel).addEventListener("click", () => clicks++);
      run();
      expect(presses).toEqual(["3"]);
      expect(clicks).toBe(0);
    });

    it("does nothing and throws nothing when the panel has no hide button of the expected class (F3)", async () => {
      openDialog();
      run();
      addPart(PARTS.panel, 300);
      await settle();
      expect(sizes[PARTS.panel]).toBe(300);
      expect(presses).toEqual([]);
    });
  });

  it("puts away the activity bar and the status bar when a command brings them back (E8), and leaves them alone while the settings keep them hidden", async () => {
    addPart(PARTS.activityBar, 0);
    addPart(PARTS.statusBar, 0);
    run();
    expect(presses).toEqual([]); // hidden by the settings at load: nothing to put away
    sizes[PARTS.activityBar] = 48; // a palette "Toggle Activity Bar Visibility" brought it back
    document.body.appendChild(document.createElement("span"));
    await settle();
    expect(presses).toEqual(["7"]);
    expect(sizes[PARTS.activityBar]).toBe(0);
    sizes[PARTS.statusBar] = 22;
    document.body.appendChild(document.createElement("span"));
    await settle();
    expect(presses).toEqual(["7", "6"]);
    expect(sizes[PARTS.statusBar]).toBe(0);
  });

  it("is installed once per page: a second run adds no second watcher", async () => {
    expect(run()).toBe(CHROME_SCRIPT_INSTALLED);
    expect(run()).toBe(CHROME_SCRIPT_INSTALLED);
    obey = false;
    addPart(PARTS.panel, 50);
    await settle();
    expect(presses).toEqual(["3"]); // one watcher, one press per change
  });

  it("closes the other editors once, when the first editor shows, and not again", async () => {
    run();
    expect(presses).toEqual([]);
    const ed = document.createElement("div");
    ed.className = "part editor";
    const monaco = document.createElement("div");
    monaco.className = "monaco-editor";
    monaco.setAttribute("data-uri", "vscode-remote://x/a.py");
    ed.appendChild(monaco);
    document.body.appendChild(ed);
    sizes[EDITOR_SELECTOR] = 400;
    await settle();
    expect(presses).toEqual(["4"]);
    addPart(PARTS.panel, 10);
    await settle();
    expect(presses).toEqual(["4", "3"]); // the panel only: no second close-others
  });

  it("gives up after its budget when a command does not hide its part, instead of spinning", async () => {
    obey = false;
    const panel = addPart(PARTS.panel, 100);
    run();
    for (let i = 0; i < CHROME_PRESS_BUDGET + 50; i++) {
      panel.setAttribute("class", `part panel c${i}`);
      await new Promise((r) => setTimeout(r, 6)); // longer than a frame
    }
    await settle();
    expect(presses).toHaveLength(CHROME_PRESS_BUDGET);
  });

  it("does nothing and throws nothing when VS Code's class names are not the ones expected (F3): the part just shows", async () => {
    const renamed = document.createElement("div");
    renamed.className = "part sidebar-renamed";
    document.body.appendChild(renamed);
    sizes[".part.sidebar-renamed"] = 200;
    expect(() => run()).not.toThrow();
    renamed.setAttribute("class", "part sidebar-renamed again");
    await settle();
    expect(presses).toEqual([]);
  });

  it("reads and sends nothing but the page's own DOM: no network, no storage, no timers of its own", () => {
    const source = buildChromeHideScript();
    for (const word of ["fetch(", "XMLHttpRequest", "WebSocket", "localStorage", "sessionStorage", "indexedDB", "setInterval", "setTimeout", "document.cookie", "eval(", "innerHTML"]) {
      expect(source, word).not.toContain(word);
    }
  });

  it("the script text is valid JavaScript that is a single expression a webview can return from", () => {
    expect(() => new Function(`return ${buildChromeHideScript()}`)).not.toThrow();
  });

  it("refuses a chord that is not one of the plugin's own", () => {
    expect(() => chordEvent({ key: "ctrl+k", command: "x" })).toThrow(/not a chrome chord/);
  });
});
