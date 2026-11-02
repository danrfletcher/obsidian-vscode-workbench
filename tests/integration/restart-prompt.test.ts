/**
 * Integration: the rule for the "Restart the VS Code server?" prompt (G12) and the modal that draws it. A table over the inputs
 * (server state, dirty files, the live-shell answer, whether the terminal page is loaded) gives "no prompt" or the exact lines.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { Modal } from "../mocks/obsidian";
import { restartPrompt, terminalLine, type RestartPrompt, type ShellAnswer } from "../../src/restart-prompt";
import { promptRestartWithDirty } from "../../src/modals";
import type { ServerState } from "../../src/server-manager";

interface Row {
  name: string;
  state?: ServerState;
  dirty?: string[];
  shells: ShellAnswer;
  pageLoaded: boolean;
  expected: RestartPrompt | null;
}

const NONE = null;
const TABLE: Row[] = [
  // live shells, counted
  { name: "one live shell: singular", shells: 1, pageLoaded: true, expected: { files: [], terminalLine: "1 terminal will end." } },
  { name: "two live shells: plural", shells: 2, pageLoaded: true, expected: { files: [], terminalLine: "2 terminals will end." } },
  { name: "twelve live shells", shells: 12, pageLoaded: true, expected: { files: [], terminalLine: "12 terminals will end." } },
  { name: "live shells with the page not loaded (the count is still true)", shells: 3, pageLoaded: false, expected: { files: [], terminalLine: "3 terminals will end." } },
  // none counted
  { name: "no live shell, nothing dirty: no prompt", shells: 0, pageLoaded: true, expected: NONE },
  { name: "no live shell (an exited shell with a leftover tab is not counted), page not loaded: no prompt", shells: 0, pageLoaded: false, expected: NONE },
  // cannot count
  { name: "cannot count, page loaded: the line without a number", shells: "unknown", pageLoaded: true, expected: { files: [], terminalLine: "Terminals will end." } },
  { name: "cannot count, page not loaded: no line, no prompt", shells: "unknown", pageLoaded: false, expected: NONE },
  // dirty buffers
  { name: "one dirty file alone: the old prompt, no terminal line", dirty: ["a.py"], shells: 0, pageLoaded: true, expected: { files: ["a.py"], terminalLine: null } },
  { name: "dirty files alone with an uncountable page not loaded", dirty: ["a.py", "b.py"], shells: "unknown", pageLoaded: false, expected: { files: ["a.py", "b.py"], terminalLine: null } },
  { name: "dirty file and one shell: one prompt with both lines", dirty: ["a.py"], shells: 1, pageLoaded: true, expected: { files: ["a.py"], terminalLine: "1 terminal will end." } },
  { name: "dirty files and several shells: one prompt with both lines", dirty: ["a.py", "b.py"], shells: 4, pageLoaded: true, expected: { files: ["a.py", "b.py"], terminalLine: "4 terminals will end." } },
  { name: "dirty file and shells that cannot be counted, page loaded", dirty: ["a.py"], shells: "unknown", pageLoaded: true, expected: { files: ["a.py"], terminalLine: "Terminals will end." } },
  // states: only a running server is asked
  ...(["crashed", "failed", "stopped", "stopped-by-idle", "starting"] as ServerState[]).flatMap((state): Row[] => [
    { name: `${state}: never prompts, even with a dirty file and shells`, state, dirty: ["a.py"], shells: 3, pageLoaded: true, expected: NONE },
    { name: `${state}: never prompts with shells that cannot be counted`, state, shells: "unknown", pageLoaded: true, expected: NONE },
  ]),
];

describe("restartPrompt: the rule", () => {
  for (const row of TABLE) {
    it(row.name, () => {
      expect(restartPrompt({ state: row.state ?? "running", dirtyFiles: row.dirty ?? [], shells: row.shells, pageLoaded: row.pageLoaded })).toEqual(row.expected);
    });
  }

  it("terminalLine alone: singular, plural, zero, and cannot-count by page", () => {
    expect(terminalLine(1, false)).toBe("1 terminal will end.");
    expect(terminalLine(2, false)).toBe("2 terminals will end.");
    expect(terminalLine(0, true)).toBeNull();
    expect(terminalLine("unknown", true)).toBe("Terminals will end.");
    expect(terminalLine("unknown", false)).toBeNull();
  });

  it("does not hold on to the caller's list", () => {
    const dirty = ["a.py"];
    const p = restartPrompt({ state: "running", dirtyFiles: dirty, shells: 1, pageLoaded: true })!;
    dirty.push("b.py");
    expect(p.files).toEqual(["a.py"]);
  });
});

describe("promptRestartWithDirty: what the modal says", () => {
  beforeEach(() => Modal.reset());
  const last = () => Modal.opened[Modal.opened.length - 1] as unknown as { contentEl: import("../mocks/obsidian").FakeNode; close(): void };

  it("a terminal line alone: Cancel and Restart and discard changes, the line, no file line", async () => {
    const asked = promptRestartWithDirty({} as never, [], "2 terminals will end.");
    await new Promise((r) => setTimeout(r, 0));
    const text = last().contentEl.textContent();
    expect(text).toContain("Restart the VS Code server?");
    expect(text).toContain("2 terminals will end.");
    expect(text).not.toContain("unsaved");
    expect(last().contentEl.buttons().map((b) => b.text)).toEqual(["Cancel", "Restart and discard changes"]);
    last().contentEl.buttons().find((b) => b.text === "Restart and discard changes")!.click();
    expect(await asked).toBe(true);
  });

  it("both lines in one modal", async () => {
    const asked = promptRestartWithDirty({} as never, ["estimate.py"], "1 terminal will end.");
    await new Promise((r) => setTimeout(r, 0));
    const text = last().contentEl.textContent();
    expect(text).toContain("estimate.py has unsaved changes.");
    expect(text).toContain("1 terminal will end.");
    expect(Modal.opened).toHaveLength(1);
    last().contentEl.buttons().find((b) => b.text === "Cancel")!.click();
    expect(await asked).toBe(false);
  });

  it("Escape is Cancel", async () => {
    const asked = promptRestartWithDirty({} as never, [], "Terminals will end.");
    await new Promise((r) => setTimeout(r, 0));
    last().close();
    expect(await asked).toBe(false);
  });

  it("dirty files alone read as they did before this change", async () => {
    const asked = promptRestartWithDirty({} as never, ["a.py", "b.py"]);
    await new Promise((r) => setTimeout(r, 0));
    expect(last().contentEl.textContent()).toContain("a.py, b.py have unsaved changes. Restarting reloads every Code tab, and unsaved changes are lost.");
    expect(last().contentEl.textContent()).not.toContain("terminal");
    last().close();
    await asked;
  });
});
