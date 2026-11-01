/**
 * The plugin-owned extension of the terminal spike (tests/render/terminal-at-extension.cjs, ticket warkworth-37, PR-1, S2),
 * run for real against a fake `vscode` and a real folder with a real `request.json`. What it pins is what the Obsidian
 * container run lost: several extension hosts watch the same request file and only one of them belongs to the page on screen.
 * The host's own copy of VS Code is not needed for that; `npm run check:terminal-spike` runs the same file in a real server.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REPO_ROOT } from "../helpers";

const SOURCE = fs.readFileSync(path.join(REPO_ROOT, "tests", "render", "terminal-at-extension.cjs"), "utf8");

/** Explicit waits for a file event: long, because a loaded machine delivers one late. */
const WAIT = { timeout: 15_000, interval: 25 };

interface Call { command: string; args: unknown[] }

/** One extension host: its own `vscode`, with the setting it was started with and a command that answers or never does. */
function startHost(extensionPath: string, opts: { terminalPage: boolean; answers: boolean }) {
  const calls: Call[] = [];
  const vscode = {
    workspace: { getConfiguration: (section: string) => ({ get: (key: string) => (section === "obsidianWorkbench" && key === "terminalPage" ? opts.terminalPage : undefined) }) },
    commands: {
      executeCommand: (command: string, ...args: unknown[]) => {
        calls.push({ command, args });
        return opts.answers ? Promise.resolve() : new Promise<void>(() => {});
      },
    },
  };
  const mod: { exports: { activate?: (ctx: { extensionPath: string }) => void } } = { exports: {} };
  const fakeRequire = (name: string) => (name === "vscode" ? vscode : name === "fs" ? fs : name === "path" ? path : (() => { throw new Error(name); })());
  new Function("require", "exports", "module", SOURCE)(fakeRequire, mod.exports, mod);
  mod.exports.activate?.({ extensionPath });
  return calls;
}

describe("terminal-at extension (the request file shared by every extension host on a server)", () => {
  let dir: string;
  const file = () => path.join(dir, "request.json");
  const ask = (id: string, cwd: string) => {
    fs.writeFileSync(path.join(dir, "tmp"), JSON.stringify({ id, cwd }));
    fs.renameSync(path.join(dir, "tmp"), file());
  };
  /**
   * Write the request until `seen()` holds. A watcher made a moment ago may not be listening yet (on macOS the file events
   * start a little after `fs.watch` returns, and a write in that gap is never delivered), and under load an event can be
   * late. The extension runs each request id once, so writing the same request again costs nothing; the waits are
   * explicit and long, never a guess at how fast the machine is.
   */
  const askUntil = (id: string, cwd: string, seen: () => boolean) =>
    vi.waitFor(() => { if (!seen()) { ask(id, cwd); throw new Error(`request ${id} not picked up yet`); } }, { timeout: 15_000, interval: 50 });
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-at-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("runs VS Code's newWithCwd with the folder as given (spaces, non-ASCII), then deletes the request", async () => {
    const live = startHost(dir, { terminalPage: true, answers: true });
    const folder = "/vault/estimaté tïme 文件/with spaces";
    await askUntil("a", folder, () => live.length > 0);
    await vi.waitFor(() => expect(fs.existsSync(file())).toBe(false), WAIT);
    expect(live).toEqual([{ command: "workbench.action.terminal.newWithCwd", args: [{ cwd: folder }] }]);
  });

  it("a host whose page is gone (its command never answers) does not swallow the request: the live host still opens exactly one terminal", async () => {
    // the dead hosts are started first, as they would be: they are the older ones
    const dead = [startHost(dir, { terminalPage: true, answers: false }), startHost(dir, { terminalPage: true, answers: false })];
    const live = startHost(dir, { terminalPage: true, answers: true });
    await askUntil("b", "/vault/Notes", () => live.length > 0);
    await vi.waitFor(() => expect(fs.existsSync(file())).toBe(false), WAIT);
    expect(live).toHaveLength(1);
    expect(live[0].args).toEqual([{ cwd: "/vault/Notes" }]);
    for (const d of dead) expect(d.length).toBeLessThanOrEqual(1); // tried, got no answer, did not remove the file
  });

  it("a host of a page that is not the terminal page (a Code tab: no terminalPage setting) leaves the request alone", async () => {
    const codeTab = startHost(dir, { terminalPage: false, answers: true });
    const watching = startHost(dir, { terminalPage: true, answers: false }); // a page that never answers: proves the request reached the hosts, and leaves the file in place
    await askUntil("c", "/vault/Notes", () => watching.length > 0);
    expect(codeTab).toEqual([]);
    expect(fs.existsSync(file())).toBe(true);
  });

  it("runs each request id once, and the next id again", async () => {
    const live = startHost(dir, { terminalPage: true, answers: true });
    await askUntil("d1", "/vault/one", () => live.length > 0);
    await vi.waitFor(() => expect(fs.existsSync(file())).toBe(false), WAIT);
    ask("d1", "/vault/one"); // the same id written again (a repeated event for one request)
    await new Promise((r) => setTimeout(r, 300));
    expect(live).toHaveLength(1);
    await askUntil("d2", "/vault/two", () => live.length > 1);
    expect(live).toHaveLength(2);
    expect(live[1].args).toEqual([{ cwd: "/vault/two" }]);
  });

  it("does not delete a newer request that arrived while its command was still running", async () => {
    let release: () => void = () => {};
    const calls: Call[] = [];
    const vscode = {
      workspace: { getConfiguration: () => ({ get: () => true }) },
      commands: { executeCommand: (command: string, ...args: unknown[]) => { calls.push({ command, args }); return new Promise<void>((r) => { release = r; }); } },
    };
    const mod: { exports: { activate?: (ctx: { extensionPath: string }) => void } } = { exports: {} };
    new Function("require", "exports", "module", SOURCE)((n: string) => (n === "vscode" ? vscode : n === "fs" ? fs : path), mod.exports, mod);
    mod.exports.activate?.({ extensionPath: dir });
    await askUntil("e1", "/vault/first", () => calls.length > 0);
    ask("e2", "/vault/second");
    release(); // the first command answers now; its continuation (the delete check) runs before the next macrotask
    await vi.waitFor(() => expect(calls).toHaveLength(2), WAIT); // the second request was picked up too...
    expect(calls[1].args).toEqual([{ cwd: "/vault/second" }]);
    await new Promise((r) => setImmediate(r));
    expect(fs.existsSync(file())).toBe(true); // ...and the first one finishing did not delete it (its command has not answered)
  });

  it("ignores a request file that is not valid JSON or has no id", async () => {
    const live = startHost(dir, { terminalPage: true, answers: true });
    fs.writeFileSync(file(), "{ not json");
    await new Promise((r) => setTimeout(r, 200));
    fs.writeFileSync(file(), JSON.stringify({ cwd: "/vault/x" }));
    await new Promise((r) => setTimeout(r, 300));
    expect(live).toEqual([]);
    await askUntil("ok", "/vault/y", () => live.length > 0); // the host was listening all along: a valid request is acted on
    expect(live).toHaveLength(1);
    expect(live[0].args).toEqual([{ cwd: "/vault/y" }]);
  });
});
