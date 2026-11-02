/**
 * The plugin-owned extension puts the terminal page in its panel-only layout itself, with VS Code's own commands (F2, S1).
 * This runs the extension's real code (`extensionSource`) against a fake `vscode`: which commands, in what order, how often,
 * for which page, what happens while a command is not registered yet, and that a request is not taken before the layout is made.
 * The page the commands act on is the fake workbench of the host tests, so "idempotent" is measured on a layout.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLOSE_AUXILIARY_BAR_COMMAND,
  CLOSE_SIDE_BAR_COMMAND,
  FOCUS_TERMINAL_COMMAND,
  NEW_WITH_CWD_COMMAND,
  PANEL_ONLY_COMMANDS,
  REQUESTS_DIR,
  extensionDir,
  extensionSource,
  installTerminalAtExtension,
  writeTerminalRequest,
} from "../../src/terminal-host/terminal-at-extension";
import { FakeWorkbenchPage } from "../host-fakes";
import { tempDir } from "../helpers";

let data: string;

beforeEach(() => {
  data = tempDir();
  installTerminalAtExtension(data);
});

interface Run {
  /** Every command the extension gave VS Code, in order, with its arguments. */
  calls: Array<{ command: string; args: unknown[] }>;
  /** The error messages the user was shown. */
  errors: string[];
  /** The panel-only commands only. */
  layout(): string[];
}

interface HostOptions {
  terminalPage?: boolean;
  page?: FakeWorkbenchPage;
  /** A command that is not registered for this many asks (it rejects as VS Code does), by command id. */
  unknownFor?: Record<string, number>;
  /** A command that never answers until this is released, by command id. */
  hold?: Record<string, Promise<void>>;
  firstTerminalWaitMs?: number;
}

/** One extension host: the extension's code from `extensionSource`, activated on the installed extension folder. */
function startHost(opts: HostOptions = {}): Run {
  const page = opts.page ?? new FakeWorkbenchPage({ extension: false, defaultCwd: "/vault" });
  const calls: Run["calls"] = [];
  const errors: string[] = [];
  const asked: Record<string, number> = {};
  const vscode = {
    workspace: { getConfiguration: (section: string) => ({ get: (key: string) => (section === "obsidianWorkbench" && key === "terminalPage" ? (opts.terminalPage ?? true) : undefined) }) },
    window: { showErrorMessage: (m: string) => { errors.push(m); }, get terminals() { return [...page.terminals]; }, onDidOpenTerminal: (cb: (t: unknown) => void) => page.onDidOpenTerminal(cb) },
    commands: {
      executeCommand: async (command: string, ...args: unknown[]) => {
        asked[command] = (asked[command] ?? 0) + 1;
        calls.push({ command, args });
        if (asked[command] <= (opts.unknownFor?.[command] ?? 0)) throw new Error(`command '${command}' not found`);
        if (opts.hold?.[command]) await opts.hold[command];
        if (command === CLOSE_SIDE_BAR_COMMAND) page.closeSideBar();
        else if (command === CLOSE_AUXILIARY_BAR_COMMAND) page.closeAuxiliaryBar();
        else if (command === FOCUS_TERMINAL_COMMAND) page.focusTerminal();
        else if (command === NEW_WITH_CWD_COMMAND) page.addTerminal((args[0] as { cwd: string }).cwd);
      },
    },
  };
  const source = extensionSource(opts.firstTerminalWaitMs ?? 50);
  const mod: { exports: { activate?: (ctx: { extensionPath: string }) => void } } = { exports: {} };
  const requireFake = (name: string) => (name === "vscode" ? vscode : name === "fs" ? fs : name === "path" ? path : (() => { throw new Error(name); })());
  new Function("require", "exports", "module", source)(requireFake, mod.exports, mod);
  mod.exports.activate?.({ extensionPath: extensionDir(data) });
  return { calls, errors, layout: () => calls.map((c) => c.command).filter((c) => (PANEL_ONLY_COMMANDS as readonly string[]).includes(c)) };
}

const until = (fn: () => boolean) => vi.waitFor(() => { if (!fn()) throw new Error("not yet"); }, { timeout: 5000, interval: 10 });

describe("the panel-only step of the terminal-at extension", () => {
  it("runs VS Code's own commands, in order: close the side bar, close the secondary side bar, focus the terminal; each with no argument", async () => {
    const run = startHost();
    await until(() => run.layout().length === 3);
    expect(run.layout()).toEqual([CLOSE_SIDE_BAR_COMMAND, CLOSE_AUXILIARY_BAR_COMMAND, FOCUS_TERMINAL_COMMAND]);
    expect(run.layout()).toEqual(["workbench.action.closeSidebar", "workbench.action.closeAuxiliaryBar", "workbench.action.terminal.focus"]);
    for (const c of run.calls) expect(c.args).toEqual([]);
    // and nothing else: no key, no toggle command
    expect(run.calls.map((c) => c.command)).toEqual([...PANEL_ONLY_COMMANDS]);
  });

  it("takes a fresh page (side bar and Chat open, no panel) to panel-only, with one terminal of the page's own", async () => {
    const page = new FakeWorkbenchPage({ extension: false, auxiliaryBar: true, defaultCwd: "/vault" });
    expect(page.shown()).toEqual(["sidebar", "auxiliarybar", "editor"]);
    const run = startHost({ page });
    await until(() => run.layout().length === 3);
    expect(page.shown()).toEqual(["panel"]);
    expect(page.terminals.map((t) => t.cwd)).toEqual(["/vault"]);
  });

  it("is idempotent: the same commands again leave the same layout and no second terminal (nothing is a toggle)", async () => {
    const page = new FakeWorkbenchPage({ extension: false, auxiliaryBar: true, defaultCwd: "/vault" });
    const first = startHost({ page });
    await until(() => first.layout().length === 3);
    const after = JSON.stringify(page.parts);
    const second = startHost({ page }); // the same page loaded again: a new extension host runs the step once more
    await until(() => second.layout().length === 3);
    expect(JSON.stringify(page.parts)).toBe(after);
    expect(page.shown()).toEqual(["panel"]);
    expect(page.terminals).toHaveLength(1);
  });

  it("runs once per page load: a request taken afterwards does not run it again", async () => {
    const run = startHost();
    await until(() => run.layout().length === 3);
    writeTerminalRequest(data, { cwd: "/vault/a" });
    writeTerminalRequest(data, { cwd: "/vault/b" });
    await until(() => run.calls.filter((c) => c.command === NEW_WITH_CWD_COMMAND).length === 2);
    expect(run.layout()).toHaveLength(3);
  });

  it("runs nothing when the page is not the terminal page (terminalPage unset), not even for a request", async () => {
    writeTerminalRequest(data, { cwd: "/vault/a" });
    const run = startHost({ terminalPage: false });
    await new Promise((r) => setTimeout(r, 150));
    expect(run.calls).toEqual([]);
    // the request is left for the host that is the terminal page
    expect(fs.readdirSync(path.join(extensionDir(data), REQUESTS_DIR)).filter((n) => n.endsWith(".json"))).toHaveLength(1);
  });

  it("asks each command once: one VS Code does not know is not asked again, the user sees an error, and the commands after it still run", async () => {
    const run = startHost({ unknownFor: { [CLOSE_SIDE_BAR_COMMAND]: 1000 } });
    await until(() => run.calls.some((c) => c.command === FOCUS_TERMINAL_COMMAND));
    await new Promise((r) => setTimeout(r, 100));
    expect(run.calls.map((c) => c.command)).toEqual([CLOSE_SIDE_BAR_COMMAND, CLOSE_AUXILIARY_BAR_COMMAND, FOCUS_TERMINAL_COMMAND]);
    expect(run.errors).toHaveLength(1);
    expect(run.errors[0]).toContain(CLOSE_SIDE_BAR_COMMAND);
  });

  it("shows no error when every command works", async () => {
    const run = startHost();
    await until(() => run.layout().length === 3);
    expect(run.errors).toEqual([]);
  });

  it("has no wait or count in its code: no timer between commands and no loop", () => {
    const source = extensionSource(100);
    expect(source).not.toMatch(/sleep|for \(let i|while\s*\(|setInterval/);
  });

  it("does the layout BEFORE it takes a request, so the page's own first terminal is there for the first-use adoption to see", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    // the request is already waiting when the extension starts
    writeTerminalRequest(data, { cwd: "/vault/chosen", adoptFirst: true });
    const page = new FakeWorkbenchPage({ extension: false, defaultCwd: "/vault" });
    const run = startHost({ page, hold: { [FOCUS_TERMINAL_COMMAND]: held } });
    await until(() => run.layout().length === 3);
    await new Promise((r) => setTimeout(r, 100));
    // the focus command has not answered: the request has not been taken
    expect(run.calls.some((c) => c.command === NEW_WITH_CWD_COMMAND)).toBe(false);
    expect(page.terminals).toHaveLength(0);
    release();
    await until(() => run.calls.some((c) => c.command === NEW_WITH_CWD_COMMAND));
    // the page's own vault-root terminal existed when the chosen folder's was made, and was then taken away: exactly one is left
    await until(() => page.terminals.length === 1 && page.terminals[0].cwd === "/vault/chosen");
    expect(page.terminals.map((t) => t.cwd)).toEqual(["/vault/chosen"]);
  });

  it("holds no key press and no text for a shell: its code names only commands", () => {
    const source = extensionSource(100);
    expect(source).not.toMatch(/sendText|sendSequence|sendInputEvent|keyDown|\bcd\s/);
    for (const c of PANEL_ONLY_COMMANDS) expect(source).toContain(c);
  });
});
