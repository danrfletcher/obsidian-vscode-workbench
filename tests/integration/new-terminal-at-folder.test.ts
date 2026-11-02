/**
 * Integration: "New terminal at folder" through the real plugin (`main.ts`), the real licence modal, the fake `code` script
 * (real processes, `tests/fixtures/fake-serve-web.mjs`) and the fake workbench page of the terminal host tests
 * (`tests/host-fakes.ts`). The terminal itself is VS Code's, so the plugin-owned extension is run for real, from the folder the
 * server start installed it in, against a fake `vscode` that records the commands it is given. Covers G8, E1, E2, E8, E10, G6.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileSystemAdapter, FakeNode, Menu, Modal, Notice, Plugin, TFile, TFolder, WorkspaceLeaf, type MockApp } from "../mocks/obsidian";
import VSCodeWorkbenchPlugin from "../../src/main";
import { REQUEST_FAILED_TEXT, newTerminalAtFolder } from "../../src/terminal-host/new-terminal";
import { CLOSE_AUXILIARY_BAR_COMMAND, CLOSE_SIDE_BAR_COMMAND, EXTENSION_DIR_NAME, EXTENSION_JS, FOCUS_TERMINAL_COMMAND, extensionSource, NEW_TERMINAL_COMMAND, NEW_WITH_CWD_COMMAND, REQUESTS_DIR, writeTerminalRequest } from "../../src/terminal-host/terminal-at-extension";
import { FILE_EXPLORER_SOURCE } from "../../src/terminal/new-terminal-menu";
import { FAKE_CODE, isAlive, tempDir } from "../helpers";
import { FakeHostEl, FakeWorkbenchPage } from "../host-fakes";

const PLUGIN_DIR = ".obsidian/plugins/obsidian-vscode-workbench";
const MODAL_ACCEPT = "Accept and download";
const INTERNALS = "HackerRank Mini-Course/_internals";

let vault: string;
let pidFile: string;
let argsFile: string;
let plugin: VSCodeWorkbenchPlugin;
let body: FakeHostEl;
let webviews: FakeHostEl[];
let seenModals = 0;
let hosts: Array<() => void> = [];
/** When set, VS Code's own first terminal is listed in the extension host only this long after the panel came up (T1). */
let firstTerminalDelayMs: number | undefined;

function makeApp(root: string): MockApp {
  const a = {
    vault: {
      adapter: new FileSystemAdapter(root),
      configDir: ".obsidian",
      getAbstractFileByPath: () => null,
      on: (name: string, cb: (...args: any[]) => void) => ({ name, cb }),
    },
    workspace: {
      onLayoutReady: () => undefined,
      activeFile: null as TFile | null,
      leaves: [] as WorkspaceLeaf[],
      getActiveFile: () => null,
      getLeavesOfType: () => [] as WorkspaceLeaf[],
      getLeaf: () => new WorkspaceLeaf(),
      revealLeaf: async () => undefined,
      detachLeavesOfType: () => undefined,
      on: (name: string, cb: (...args: unknown[]) => void) => ({ name, cb }),
    },
    openWithDefaultApp: async () => undefined,
  };
  return a as unknown as MockApp;
}

async function load(env: Record<string, string> = {}, data: Record<string, unknown> = {}): Promise<void> {
  Object.assign(process.env, { FAKE_CODE_NODE: process.execPath, FAKE_CODE_PIDFILE: pidFile, FAKE_CODE_ARGSFILE: argsFile }, env);
  plugin = new VSCodeWorkbenchPlugin(makeApp(vault) as never, { id: "obsidian-vscode-workbench", dir: PLUGIN_DIR } as never);
  (plugin as unknown as { pluginData: unknown }).pluginData = { codeCliPath: FAKE_CODE, embed: "iframe", ...data };
  (plugin as unknown as { downloadHostReachable: () => Promise<boolean> }).downloadHostReachable = async () => false;
  await plugin.onload();
}

const inner = () => plugin as unknown as { manager: import("../../src/server-manager").ServerManager; data_: Record<string, unknown>; drawer: import("../../src/terminal/terminal-drawer").TerminalDrawer };
const host = () => (plugin as unknown as { terminalHost: import("../../src/terminal-host/host-page").TerminalHostPage | null }).terminalHost;
const serverPids = () => (fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8").split("\n").filter(Boolean).map(Number) : []);
const lastModal = () => Modal.opened[Modal.opened.length - 1] as unknown as { contentEl: FakeNode; close(): void };
const press = (label: string) => {
  const b = lastModal().contentEl.buttons().find((n) => n.text === label);
  if (!b) throw new Error(`no button "${label}"`);
  b.click();
};
async function onModal(then: () => void): Promise<void> {
  await vi.waitFor(() => expect(Modal.opened.length).toBeGreaterThan(seenModals), { timeout: 3000, interval: 10 });
  seenModals++;
  then();
}

const folderOf = (rel: string, parent?: TFolder): TFolder => {
  const f = new TFolder(rel);
  f.parent = parent ?? null;
  return f;
};
const mkdir = (rel: string) => fs.mkdirSync(path.join(vault, rel), { recursive: true });

/** Right-click on `target` in the file explorer and choose the item. Resolves when the whole flow has ended. */
async function choose(target: TFolder | TFile, source = FILE_EXPLORER_SOURCE): Promise<void> {
  const [onMenu] = Plugin.events.filter((e) => e.name === "file-menu").map((e) => e.cb);
  const menu = new Menu();
  onMenu(menu, target, source);
  expect(menu.items).toHaveLength(1);
  await menu.items[0].click();
}

/** Right-click and pick the item, without waiting for the flow: for two choices in quick succession. */
function chooseNow(target: TFolder | TFile): Promise<unknown> {
  const [onMenu] = Plugin.events.filter((e) => e.name === "file-menu").map((e) => e.cb);
  const menu = new Menu();
  onMenu(menu, target, FILE_EXPLORER_SOURCE);
  return menu.items[0].click() as Promise<unknown>;
}

interface Call {
  command: string;
  args: unknown[];
  /** What the plugin and the host page showed at the moment VS Code was asked. */
  webviewsThen: number;
  hostThen: string;
}

/**
 * One extension host: the installed extension's own `extension.js`, run against a fake `vscode`. `terminalPage` is the setting
 * of the page's profile. Started on the extension folder the server start made.
 */
function startExtensionHost(opts: { terminalPage?: boolean } = {}): Call[] {
  const dir = path.join(plugin_dataDir(), "extensions", EXTENSION_DIR_NAME);
  const calls: Call[] = [];
  // The extension host and the page are one VS Code: the terminals the extension sees are the page's own list, and a command
  // that makes a terminal adds to it.
  const page = webviews[0]?.page ?? new FakeWorkbenchPage();
  const make = (cwd: string) => void page.addTerminal(cwd);
  const vscode = {
    workspace: { getConfiguration: (section: string) => ({ get: (key: string) => (section === "obsidianWorkbench" && key === "terminalPage" ? (opts.terminalPage ?? true) : undefined) }) },
    window: { get terminals() { return [...page.terminals]; }, onDidOpenTerminal: (cb: (t: unknown) => void) => page.onDidOpenTerminal(cb) },
    commands: {
      executeCommand: async (command: string, ...args: unknown[]) => {
        // The panel-only commands act on the page and are not terminal requests: they are kept apart from `calls`.
        if (command === CLOSE_SIDE_BAR_COMMAND) return page.closeSideBar();
        if (command === CLOSE_AUXILIARY_BAR_COMMAND) return page.closeAuxiliaryBar();
        if (command === FOCUS_TERMINAL_COMMAND) return page.focusTerminal();
        calls.push({ command, args, webviewsThen: webviews.length, hostThen: host()?.view() ?? "none" });
        if (command === NEW_WITH_CWD_COMMAND) make((args[0] as { cwd: string }).cwd);
        else if (command === NEW_TERMINAL_COMMAND) make(vault); // VS Code's default start folder
      },
    },
  };
  const mod: { exports: { activate?: (ctx: { extensionPath: string }) => void } } = { exports: {} };
  const requireFake = (name: string) => (name === "vscode" ? vscode : name === "fs" ? fs : name === "path" ? path : (() => { throw new Error(name); })());
  new Function("require", "exports", "module", fs.readFileSync(path.join(dir, "extension.js"), "utf8"))(requireFake, mod.exports, mod);
  mod.exports.activate?.({ extensionPath: dir });
  hosts.push(() => undefined);
  return calls;
}
/** The terminals in the page, as the page itself would list them. */
const shells = () => webviews[0].page!.terminals;
const plugin_dataDir = () => path.join(vault, PLUGIN_DIR, ".server", "server-data");
const requestsDir = () => path.join(plugin_dataDir(), "extensions", EXTENSION_DIR_NAME, REQUESTS_DIR);
const pending = () => (fs.existsSync(requestsDir()) ? fs.readdirSync(requestsDir()).filter((n) => n.endsWith(".json")) : []);

/**
 * Wait until the extension has been asked `n` times. A file event made a moment after `fs.watch` returns can be missed on
 * macOS, so the folder is nudged with a file the extension ignores until the events arrive; nothing here guesses a delay.
 */
async function untilCalls(calls: Call[], n: number): Promise<void> {
  await vi.waitFor(
    () => {
      if (calls.length < n) {
        fs.writeFileSync(path.join(requestsDir(), `.nudge-${Date.now()}`), "");
        throw new Error(`${calls.length} of ${n} calls`);
      }
    },
    { timeout: 15_000, interval: 50 },
  );
}

beforeEach(() => {
  vault = tempDir();
  mkdir(INTERNALS);
  mkdir("Café Notes");
  mkdir("it's $HOME & (x)");
  fs.writeFileSync(path.join(vault, INTERNALS, "a.py"), "x");
  pidFile = path.join(tempDir(), "pids");
  argsFile = path.join(tempDir(), "args.json");
  Plugin.reset();
  Notice.reset();
  Modal.reset();
  seenModals = 0;
  hosts = [];
  firstTerminalDelayMs = undefined;
  webviews = [];
  body = new FakeHostEl("body") as FakeHostEl & { classList?: unknown };
  (body as FakeHostEl & { classList: { contains(c: string): boolean } }).classList = { contains: () => false };
  vi.stubGlobal("window", { addEventListener: () => undefined, removeEventListener: () => undefined, innerHeight: 900 });
  vi.stubGlobal("document", {
    body,
    createElement: (tag: string) => {
      const e = new FakeHostEl(tag);
      if (tag === "webview") {
        // VS Code opens a first terminal of its own, in the folder the page was opened on (the vault root), when the panel comes up
        e.page = new FakeWorkbenchPage({ defaultCwd: vault, terminalDelayMs: firstTerminalDelayMs });
        webviews.push(e);
      }
      return e;
    },
  });
});

afterEach(async () => {
  plugin?.onunload();
  await new Promise((r) => setTimeout(r, 400));
  for (const pid of serverPids()) if (isAlive(pid)) process.kill(pid, "SIGKILL");
  for (const k of ["FAKE_CODE_NODE", "FAKE_CODE_PIDFILE", "FAKE_CODE_ARGSFILE", "FAKE_CODE_MODE"]) delete process.env[k];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("G8: choosing the item opens the drawer and creates a terminal in the folder", () => {
  it("drawer hidden, licence accepted: the drawer opens, the page is ready, and only then is VS Code asked for one terminal at the folder", async () => {
    await load({}, { serverLicenceAccepted: true });
    expect(inner().drawer.isOpen).toBe(false);
    await choose(folderOf(INTERNALS, folderOf("HackerRank Mini-Course", folderOf("/"))));
    expect(inner().drawer.isOpen).toBe(true);
    expect(host()!.isVisible()).toBe(true);
    const calls = startExtensionHost();
    await untilCalls(calls, 1);
    expect(calls).toHaveLength(1);
    // the cwd is an argument of VS Code's own command, byte for byte
    expect(calls[0].command).toBe(NEW_WITH_CWD_COMMAND);
    expect(calls[0].args).toEqual([{ cwd: path.join(vault, INTERNALS) }]);
    // reveal, then create: the page was mounted and running when VS Code was asked
    expect(calls[0].webviewsThen).toBe(1);
    expect(calls[0].hostThen).toBe("running");
    await vi.waitFor(() => expect(pending()).toEqual([]));
  });

  it("the request is data: nothing is typed into a shell, no cd, and the page is asked only to focus", async () => {
    await load({}, { serverLicenceAccepted: true });
    await choose(folderOf(INTERNALS));
    const written = fs.readdirSync(requestsDir()).filter((n) => n.endsWith(".json"));
    expect(written).toHaveLength(1);
    const text = fs.readFileSync(path.join(requestsDir(), written[0]), "utf8");
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(["adoptFirst", "cwd", "id"]); // this click started the page (see the G2 tests)
    expect(JSON.parse(text).cwd).toBe(path.join(vault, INTERNALS));
    for (const wv of webviews) for (const script of wv.executed) expect(script).not.toMatch(/\bcd\s|sendText|sendSequence/);
    expect(EXTENSION_JS).not.toMatch(/sendText|sendSequence|\bcd\s/);
  });

  it("a file uses its parent folder", async () => {
    await load({}, { serverLicenceAccepted: true });
    const parent = folderOf(INTERNALS, folderOf("HackerRank Mini-Course", folderOf("/")));
    const file = new TFile(`${INTERNALS}/a.py`);
    file.parent = parent;
    await choose(file);
    const calls = startExtensionHost();
    await untilCalls(calls, 1);
    expect(calls[0].args).toEqual([{ cwd: path.join(vault, INTERNALS) }]);
  });

  it("a file at the top level, and the vault root, use the vault root", async () => {
    await load({}, { serverLicenceAccepted: true });
    const root = folderOf("/");
    const note = new TFile("note.md");
    note.parent = root;
    await choose(note);
    await choose(root);
    const calls = startExtensionHost();
    await untilCalls(calls, 2);
    expect(calls.map((c) => c.args)).toEqual([[{ cwd: vault }], [{ cwd: vault }]]);
  });

  it.each(["Café Notes", "it's $HOME & (x)"])("a folder named %s arrives as the cwd byte for byte", async (name) => {
    await load({}, { serverLicenceAccepted: true });
    await choose(folderOf(name));
    const calls = startExtensionHost();
    await untilCalls(calls, 1);
    const cwd = (calls[0].args[0] as { cwd: string }).cwd;
    expect(Buffer.from(cwd)).toEqual(Buffer.from(path.join(vault, name)));
  });

  it("drawer already open: it is revealed, not rebuilt, and a second terminal is added (the first is not touched)", async () => {
    await load({}, { serverLicenceAccepted: true });
    const calls = startExtensionHost.bind(null);
    await choose(folderOf(INTERNALS));
    const live = calls();
    await untilCalls(live, 1);
    const wv = webviews[0];
    const srcs = [...wv.srcs];
    await choose(folderOf("Café Notes"));
    await untilCalls(live, 2);
    expect(live.map((c) => c.args)).toEqual([[{ cwd: path.join(vault, INTERNALS) }], [{ cwd: path.join(vault, "Café Notes") }]]);
    expect(webviews).toEqual([wv]); // one page, the same one, not reloaded
    expect(wv.srcs).toEqual(srcs);
    expect(serverPids()).toHaveLength(1);
  });

  it("drawer collapsed: choosing the item opens it again and adds a terminal; the page is the one that was there", async () => {
    await load({}, { serverLicenceAccepted: true });
    await choose(folderOf(INTERNALS));
    const live = startExtensionHost();
    await untilCalls(live, 1);
    inner().drawer.close();
    expect(host()!.isVisible()).toBe(false);
    await choose(folderOf(INTERNALS));
    await untilCalls(live, 2);
    expect(host()!.isVisible()).toBe(true);
    expect(inner().drawer.isOpen).toBe(true);
    expect(webviews).toHaveLength(1);
  });

  it("focus: the page is given the keyboard after the request is made", async () => {
    await load({}, { serverLicenceAccepted: true });
    await choose(folderOf(INTERNALS));
    const wv = webviews[0];
    expect(wv.focusCount).toBeGreaterThan(0);
    expect(wv.executed.some((s) => s.includes("helper-textarea"))).toBe(true);
    expect(pending()).toHaveLength(1); // asked for, and not yet taken: no extension host is listening in this test
  });
});

describe("E8: a folder that is gone, or a vault that is", () => {
  it("a folder renamed on disk behind Obsidian, chosen from the stale menu: the terminal opens in the vault root, no dialog", async () => {
    await load({}, { serverLicenceAccepted: true });
    const [onMenu] = Plugin.events.filter((e) => e.name === "file-menu").map((e) => e.cb);
    const menu = new Menu();
    onMenu(menu, folderOf(INTERNALS), FILE_EXPLORER_SOURCE);
    fs.renameSync(path.join(vault, "HackerRank Mini-Course"), path.join(vault, "Renamed"));
    await menu.items[0].click();
    const calls = startExtensionHost();
    await untilCalls(calls, 1);
    expect(calls[0].args).toEqual([{ cwd: vault }]);
    expect(Modal.opened).toHaveLength(0);
    expect(Notice.messages.filter((m) => !m.includes("downloading the VS Code server"))).toEqual([]); // no error notice
  });

  it("the vault folder itself missing: a terminal is still asked for, with no cwd (VS Code's default start folder)", async () => {
    await load({}, { serverLicenceAccepted: true });
    await choose(folderOf("Café Notes")); // starts the server and installs the extension
    for (const f of pending()) fs.rmSync(path.join(requestsDir(), f));
    const order: string[] = [];
    const result = await newTerminalAtFolder(
      {
        vaultRoot: () => path.join(vault, "gone"), // the vault's base path is no longer a folder
        reveal: () => order.push("reveal"),
        settled: async () => void order.push("settled"),
        ready: () => true,
        starting: () => false,
        focusTerminal: () => void order.push("focus"),
        serverDataDir: () => plugin_dataDir(),
        unloaded: () => false,
        notice: (m) => void order.push(`notice:${m}`),
      },
      "Café Notes",
    );
    expect(result).toBe("asked");
    expect(order).toEqual(["reveal", "settled", "focus"]); // reveal, wait for the page, ask, then focus
    const calls = startExtensionHost();
    await untilCalls(calls, 1);
    expect(calls[0].command).toBe(NEW_TERMINAL_COMMAND);
    expect(calls[0].args).toEqual([]);
  });

  it("a request that cannot be written is one notice, not a crash, and nothing is focused", async () => {
    fs.writeFileSync(path.join(vault, "note.md"), "x");
    const log: string[] = [];
    const result = await newTerminalAtFolder(
      {
        vaultRoot: () => vault,
        reveal: () => undefined,
        settled: async () => undefined,
        ready: () => true,
        starting: () => false,
        focusTerminal: () => void log.push("focus"),
        serverDataDir: () => path.join(vault, "note.md", "not-a-dir"), // a file in the way
        unloaded: () => false,
        notice: (m) => void log.push(m),
      },
      "",
    );
    expect(result).toBe("not-ready");
    expect(log).toEqual([REQUEST_FAILED_TEXT]);
  });

  it("the Workspace Trust record is not part of this: the request is the same whether trust was seeded or not", async () => {
    await load({}, { serverLicenceAccepted: true, trustVaultFolder: false });
    await choose(folderOf(INTERNALS));
    const calls = startExtensionHost();
    await untilCalls(calls, 1);
    expect(calls[0].args).toEqual([{ cwd: path.join(vault, INTERNALS) }]);
  });
});

describe("G2 and E10: the server is not running yet", () => {
  it("first use: the licence modal first, the server starts once, 'Starting' shows, and exactly one terminal is made, in the chosen folder", async () => {
    await load();
    const done = choose(folderOf(INTERNALS));
    await vi.waitFor(() => expect(Modal.opened).toHaveLength(1));
    expect(serverPids()).toEqual([]);
    expect(webviews).toHaveLength(0);
    expect(host()!.view()).toBe("licence");
    press(MODAL_ACCEPT);
    await vi.waitFor(() => expect(host()!.view()).toBe("starting"));
    await done;
    expect(serverPids()).toHaveLength(1);
    expect(host()!.view()).toBe("running");
    // the page has made its own first terminal, in the vault root, before anything is asked of VS Code
    expect(shells().map((t) => t.cwd)).toEqual([vault]);
    const calls = startExtensionHost();
    await untilCalls(calls, 1);
    await new Promise((r) => setTimeout(r, 200));
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual([{ cwd: path.join(vault, INTERNALS) }]);
    // R1: the page ends with exactly one terminal, in the chosen folder, and no shell in the vault root beside it
    expect(shells().map((t) => t.cwd)).toEqual([path.join(vault, INTERNALS)]);
  });

  it("T1: the page's own first terminal is listed in the extension host only after the request is read: it is waited for and closed, so one terminal remains, in the chosen folder", async () => {
    firstTerminalDelayMs = 400;
    await load({}, { serverLicenceAccepted: true });
    await choose(folderOf(INTERNALS));
    // the panel is up but VS Code has not told the extension host about its first terminal yet
    expect(shells()).toEqual([]);
    const calls = startExtensionHost(); // reads the request at once
    await new Promise((r) => setTimeout(r, 150));
    expect(calls).toEqual([]); // not decided, not made: it is waiting for the page's terminal
    expect(pending()).toHaveLength(1);
    await untilCalls(calls, 1);
    await vi.waitFor(() => expect(pending()).toEqual([]));
    await new Promise((r) => setTimeout(r, 600)); // long enough for any late terminal to have been listed
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual([{ cwd: path.join(vault, INTERNALS) }]);
    expect(shells().map((t) => t.cwd)).toEqual([path.join(vault, INTERNALS)]);
  });

  it("T1: the page's first terminal listed late, with a later request waiting behind the first: still one terminal per choice", async () => {
    firstTerminalDelayMs = 300;
    await load({}, { serverLicenceAccepted: true });
    const a = chooseNow(folderOf(INTERNALS));
    const b = chooseNow(folderOf("Café Notes"));
    await Promise.all([a, b]);
    const calls = startExtensionHost();
    await untilCalls(calls, 2);
    await vi.waitFor(() => expect(pending()).toEqual([]));
    expect(shells().map((t) => t.cwd).sort()).toEqual([path.join(vault, INTERNALS), path.join(vault, "Café Notes")].sort());
  });

  it("T1: a page whose own first terminal never arrives: after the wait the terminal is made anyway and nothing is closed", async () => {
    await load({}, { serverLicenceAccepted: true });
    await choose(folderOf(INTERNALS));
    shells().splice(0); // VS Code made no terminal of its own
    const dir = path.join(plugin_dataDir(), "extensions", EXTENSION_DIR_NAME);
    fs.writeFileSync(path.join(dir, "extension.js"), extensionSource(100));
    const calls = startExtensionHost();
    await untilCalls(calls, 1);
    await vi.waitFor(() => expect(pending()).toEqual([]));
    expect(shells().map((t) => t.cwd)).toEqual([path.join(vault, INTERNALS)]);
  });

  it("first use with the vault root chosen: still one terminal, in the vault root", async () => {
    await load({}, { serverLicenceAccepted: true });
    await choose(folderOf("/"));
    const calls = startExtensionHost();
    await untilCalls(calls, 1);
    await new Promise((r) => setTimeout(r, 200));
    expect(shells().map((t) => t.cwd)).toEqual([vault]);
  });

  it("the page's own first terminal is replaced only by the click that made the page: a later choice adds one and touches nothing", async () => {
    await load({}, { serverLicenceAccepted: true });
    await choose(folderOf(INTERNALS));
    const live = startExtensionHost();
    await untilCalls(live, 1);
    await vi.waitFor(() => expect(shells().map((t) => t.cwd)).toEqual([path.join(vault, INTERNALS)]));
    const first = shells()[0];
    await choose(folderOf("Café Notes"));
    await untilCalls(live, 2);
    expect(shells().map((t) => t.cwd)).toEqual([path.join(vault, INTERNALS), path.join(vault, "Café Notes")]);
    expect(shells()[0]).toBe(first); // the first terminal is the same one, not made again
  });

  it("a terminal page that is not the first of the server run closes nothing, even for a request that says it started the page", async () => {
    await load({}, { serverLicenceAccepted: true });
    await choose(folderOf(INTERNALS));
    const before = startExtensionHost(); // the first page of this server run: marks it
    await untilCalls(before, 1);
    await vi.waitFor(() => expect(pending()).toEqual([]));
    // the page is reloaded: a new extension host, with the shell that outlived the reload in it
    const survivor = shells()[0];
    const reloaded = startExtensionHost();
    writeTerminalRequest(plugin_dataDir(), { cwd: path.join(vault, "Café Notes"), adoptFirst: true });
    await untilCalls(reloaded, 1);
    await vi.waitFor(() => expect(pending()).toEqual([]));
    expect(shells().map((t) => t.cwd)).toEqual([path.join(vault, INTERNALS), path.join(vault, "Café Notes")]);
    expect(shells()[0]).toBe(survivor);
  });

  it("two rapid choices: one modal, one server, one page, and one terminal for each, each in its own folder", async () => {
    await load();
    const a = chooseNow(folderOf(INTERNALS));
    const b = chooseNow(folderOf("Café Notes"));
    await onModal(() => press(MODAL_ACCEPT));
    await Promise.all([a, b]);
    expect(Modal.opened).toHaveLength(1);
    expect(serverPids()).toHaveLength(1);
    expect(webviews).toHaveLength(1);
    const calls = startExtensionHost();
    await untilCalls(calls, 2);
    await new Promise((r) => setTimeout(r, 200));
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => (c.args[0] as { cwd: string }).cwd).sort()).toEqual([path.join(vault, INTERNALS), path.join(vault, "Café Notes")].sort());
    await vi.waitFor(() => expect(pending()).toEqual([]));
    // the page's own vault-root shell is gone: one terminal per choice and no other
    expect(shells().map((t) => t.cwd).sort()).toEqual([path.join(vault, INTERNALS), path.join(vault, "Café Notes")].sort());
  });

  it("two choices made before the extension has looked are both kept and run in the order they were made", async () => {
    await load({}, { serverLicenceAccepted: true });
    await choose(folderOf(INTERNALS));
    await choose(folderOf("Café Notes"));
    await choose(folderOf(""));
    expect(pending()).toHaveLength(3);
    const calls = startExtensionHost(); // activation takes what is already there
    await untilCalls(calls, 3);
    expect(calls.map((c) => (c.args[0] as { cwd: string }).cwd)).toEqual([path.join(vault, INTERNALS), path.join(vault, "Café Notes"), vault]);
  });
});

describe("E2: licence declined", () => {
  it("the licence modal comes first; declining closes the drawer with the notice and creates no terminal and no download", async () => {
    await load();
    const done = choose(folderOf(INTERNALS));
    await onModal(() => press("Decline"));
    await done;
    expect(inner().drawer.isOpen).toBe(false);
    expect(host()!.view()).toBe("hidden");
    expect(Notice.messages.filter((m) => m.includes("needs the VS Code server licence"))).toHaveLength(1);
    expect(serverPids()).toEqual([]);
    expect(fs.existsSync(argsFile)).toBe(false);
    expect(webviews).toHaveLength(0);
    expect(fs.existsSync(path.join(plugin_dataDir(), "extensions"))).toBe(false); // no server start, so nothing installed, nothing requested
  });

  it("accepting at the next try continues to the folder chosen then", async () => {
    await load();
    let done = choose(folderOf(INTERNALS));
    await onModal(() => press("Decline"));
    await done;
    done = choose(folderOf("Café Notes"));
    await onModal(() => press(MODAL_ACCEPT));
    await done;
    const calls = startExtensionHost();
    await untilCalls(calls, 1);
    await new Promise((r) => setTimeout(r, 200));
    expect(calls.map((c) => c.args)).toEqual([[{ cwd: path.join(vault, "Café Notes") }]]); // the declined choice was not kept
  });
});

describe("E1: the server cannot start", () => {
  it("the drawer shows the reason with Retry and no terminal is asked for; after Retry succeeds the folder is not replayed", async () => {
    await load({ FAKE_CODE_MODE: "exit-plain" }, { serverLicenceAccepted: true });
    await choose(folderOf(INTERNALS));
    expect(host()!.view()).toBe("error");
    expect(inner().drawer.isOpen).toBe(true);
    expect(body.visibleText()).toContain("Retry");
    expect(body.visibleText()).toContain("The VS Code server exited with code 5");
    expect(pending()).toEqual([]);
    expect(webviews).toHaveLength(0);

    delete process.env.FAKE_CODE_MODE;
    body.find("button").find((b) => b.textContent === "Retry")!.click();
    await host()!.settled();
    expect(host()!.view()).toBe("running");
    const calls = startExtensionHost();
    await new Promise((r) => setTimeout(r, 300));
    expect(pending()).toEqual([]);
    expect(calls).toEqual([]); // the choice made before the failure is not silently replayed
  });

  it("a request left from an earlier run is cleared when the server next starts", async () => {
    await load({}, { serverLicenceAccepted: true });
    await choose(folderOf(INTERNALS));
    expect(pending()).toHaveLength(1);
    await inner().manager.restart({});
    expect(pending()).toEqual([]);
  });

  it("a server that has stopped gets no request", async () => {
    await load({}, { serverLicenceAccepted: true });
    await choose(folderOf(INTERNALS));
    for (const f of pending()) fs.rmSync(path.join(requestsDir(), f));
    await inner().manager.stop("idle");
    await choose(folderOf("Café Notes"));
    // the host page still thinks it is running, but the server is not: nothing is written for a later start to replay
    expect(pending()).toEqual([]);
  });
});

describe("G6: the drawer over non-code views setting is off", () => {
  it("the item still opens the drawer, and the edge stays hidden over a note", async () => {
    await load({}, { serverLicenceAccepted: true, nonCodeDrawer: false });
    vi.spyOn(plugin as unknown as { mainViewType(): string }, "mainViewType").mockReturnValue("markdown");
    expect(inner().drawer.visibility().edge).toBe(false);
    await choose(folderOf(INTERNALS));
    expect(inner().drawer.isOpen).toBe(true);
    expect(host()!.isVisible()).toBe(true);
    expect(inner().drawer.visibility().edge).toBe(false);
    inner().drawer.close();
    expect(inner().drawer.visibility().edge).toBe(false);
    await choose(folderOf(INTERNALS));
    expect(inner().drawer.isOpen).toBe(true);
  });
});

describe("a page that is not the terminal page", () => {
  it("a Code tab's extension host (no terminalPage setting) does not act on the request; the terminal page's does", async () => {
    await load({}, { serverLicenceAccepted: true });
    await choose(folderOf(INTERNALS));
    const codeTab = startExtensionHost({ terminalPage: false });
    const page = startExtensionHost({ terminalPage: true });
    await untilCalls(page, 1);
    expect(codeTab).toEqual([]);
    expect(page).toHaveLength(1);
  });
});

describe("F3, F4, F6: no second server, nothing outside the plugin's folder", () => {
  it("one server for the drawer and the item; the extension is written only under the server's own data dir", async () => {
    await load({}, { serverLicenceAccepted: true });
    await choose(folderOf(INTERNALS));
    await choose(folderOf("Café Notes"));
    expect(serverPids()).toHaveLength(1);
    const written = fs.readdirSync(path.join(plugin_dataDir(), "extensions")).sort();
    expect(written).toContain(EXTENSION_DIR_NAME);
    expect(written).toContain("extensions.json");
    const list = JSON.parse(fs.readFileSync(path.join(plugin_dataDir(), "extensions", "extensions.json"), "utf8")) as Array<{ identifier: { id: string }; location: { path: string } }>;
    expect(list.map((e) => e.identifier.id)).toContain("obsidian-vscode-workbench.terminal-at");
    for (const e of list) expect(e.location.path.startsWith(plugin_dataDir())).toBe(true);
  });
});
