// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  AUTO_SAVE_KEY,
  autoSaveMode,
  decide,
  resolveChoice,
  withAutoSaveDefault,
  type AutoSave,
  type BufferState,
  type Caller,
  type Choice,
  type GuardAction,
} from "../../src/dirty-guard";
import { DIRTY_SCRIPT } from "../../src/dirty-script";

describe("decide: the unsaved-buffer rule for close, idle and quit", () => {
  // caller, buffer state, auto-save -> what happens next
  const table: Array<[Caller, BufferState, AutoSave, GuardAction]> = [
    // a clean buffer never stops anything
    ["close", "clean", "off", "proceed"],
    ["close", "clean", "on", "proceed"],
    ["idle", "clean", "off", "proceed"],
    ["idle", "clean", "on", "proceed"],
    ["quit", "clean", "off", "proceed"],
    ["quit", "clean", "on", "proceed"],
    // close: auto-save off asks; auto-save on gives the edit a moment to reach disk first
    ["close", "dirty", "off", "ask"],
    ["close", "dirty", "on", "settle"],
    // close: when the state cannot be read there is nothing to wait for: ask
    ["close", "unreadable", "off", "ask"],
    ["close", "unreadable", "on", "ask"],
    // idle: any dirty or unreadable buffer means "not idle"; it never prompts
    ["idle", "dirty", "off", "block"],
    ["idle", "dirty", "on", "block"],
    ["idle", "unreadable", "off", "block"],
    ["idle", "unreadable", "on", "block"],
    // quit: always asks, whatever auto-save says
    ["quit", "dirty", "off", "ask"],
    ["quit", "dirty", "on", "ask"],
    ["quit", "unreadable", "off", "ask"],
    ["quit", "unreadable", "on", "ask"],
  ];
  it.each(table)("%s, buffer %s, auto-save %s -> %s", (caller, state, autoSave, expected) => {
    expect(decide(caller, state, autoSave)).toBe(expected);
  });

  it("covers every combination (no gap in the table)", () => {
    expect(table).toHaveLength(3 * 3 * 2);
    expect(new Set(table.map(([c, s, a]) => `${c}/${s}/${a}`)).size).toBe(18);
  });

  it("an unreadable state is never 'proceed': the tab is treated as dirty", () => {
    for (const caller of ["close", "idle", "quit"] as const) for (const a of ["on", "off"] as const) expect(decide(caller, "unreadable", a)).not.toBe("proceed");
  });
});

describe("resolveChoice: what the user's answer leads to", () => {
  const table: Array<[Choice, boolean, string]> = [
    ["cancel", false, "stay"], // the tab stays open and focused (tab close only; the quit prompt has no Cancel)
    ["cancel", true, "stay"],
    ["discard", false, "proceed"], // closes without writing
    ["discard", true, "proceed"],
    ["save", true, "proceed"], // saved, then close
    ["save", false, "retry"], // still dirty after the save: never closed on a failed save
  ];
  it.each(table)("%s (saved=%s) -> %s", (choice, saved, expected) => {
    expect(resolveChoice(choice, saved)).toBe(expected);
  });
});

describe("auto-save from the instance's settings", () => {
  it.each([
    ["afterDelay", "on"],
    ["onFocusChange", "on"],
    ["onWindowChange", "on"],
    ["off", "off"],
    [undefined, "off"], // VS Code on the desktop defaults to off
    ["sometimes", "off"],
    [true, "off"],
  ])("files.autoSave %j is %s", (value, expected) => {
    expect(autoSaveMode(value)).toBe(expected);
  });

  it("writes files.autoSave out when the instance sets none: the web workbench would otherwise default to afterDelay", () => {
    expect(withAutoSaveDefault({ "editor.fontSize": 15 })).toEqual({ "editor.fontSize": 15, "files.autoSave": "off" });
  });

  it("keeps the instance's own value, and does not change its input", () => {
    const own = { [AUTO_SAVE_KEY]: "afterDelay" };
    expect(withAutoSaveDefault(own)).toEqual({ "files.autoSave": "afterDelay" });
    const none = {};
    withAutoSaveDefault(none);
    expect(none).toEqual({});
  });
});

// The dirty script on real DOM pages with the tab strip hidden (chrome spike S5, docs/spike-chrome.md): there is no `.tab` element, and
// the window title's leading "●" is the signal. The rule table above did not move; only the signal the script reads did (PR-5).
describe("the dirty script on a workbench page with no tab strip (S5)", () => {
  /** The shape measured on VS Code 1.143.1 and 1.144.0 with `workbench.editor.showTabs: none`: an editor, no `.tab`. */
  function page(title: string, workbench = true): Document {
    const html = `<!doctype html><title>${title}</title>
      ${workbench ? `<div class="monaco-workbench"><div class="part editor"><div class="editor-group-container">
        <div class="monaco-editor" data-uri="vscode-remote://127.0.0.1:1/vault/a.js"><textarea class="inputarea"></textarea></div>
      </div></div></div>` : ""}`;
    return new DOMParser().parseFromString(html, "text/html");
  }
  const dirtyOf = (doc: Document) => new Function("document", `return ${DIRTY_SCRIPT}`)(doc) as boolean;

  it("has no `.tab` to read, whatever the editor holds", () => {
    expect(page("a.js \u2014 vault \u2014 Visual Studio Code").querySelector(".monaco-workbench .tab")).toBeNull();
  });

  it("reads a dirty active editor through the window title mark, and a saved one as clean", () => {
    expect(dirtyOf(page("\u25cf a.js \u2014 Visual Studio Code"))).toBe(true);
    expect(dirtyOf(page("a.js \u2014 Visual Studio Code"))).toBe(false);
  });

  it("reads a page with nothing open as clean", () => {
    expect(dirtyOf(page("Visual Studio Code"))).toBe(false);
  });

  it("does not answer clean when the title is empty or the workbench is not in the page: it throws, and the tab reads unreadable", () => {
    expect(() => dirtyOf(page(""))).toThrow();
    expect(() => dirtyOf(page("Visual Studio Code", false))).toThrow();
  });

  it("ignores a `dirty` class on a tab-like element: the tab strip is not the signal", () => {
    const doc = new DOMParser().parseFromString(
      `<!doctype html><title>a.js</title><div class="monaco-workbench"><div class="tab dirty" data-resource-name="a.js"></div></div>`,
      "text/html",
    );
    expect(dirtyOf(doc)).toBe(false);
  });
});
