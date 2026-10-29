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
