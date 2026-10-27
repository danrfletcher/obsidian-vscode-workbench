// @vitest-environment jsdom
/**
 * The hotkey bridge end to end through the real plugin class (main.ts): the drawer command is registered with its
 * default hotkey, a key relayed from a stub embed page opens the drawer (a real shell from the real Python PTY
 * helper in a temp vault) or runs `switcher:open`, a rebinding is followed live, and the fallback (decision `no`)
 * leaves the strip and the command working. The stub page runs the real page script against synthetic key events
 * and reports back the way the real page does: a console line (webview) or `postMessage` (iframe).
 * Only the terminal emulator (xterm) and Obsidian are stand-ins.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeTerminalView } from "../fake-terminal-view";
import { FAKE_CODE, isAlive, tempDir } from "../helpers";
import { listDescendants } from "../../src/process-utils";

const emulators: FakeTerminalView[] = [];
/** What the plugin gave each terminal view to find the close key with (the real view reads it on every key). */
const viewOptions: Array<{ toggleChords?: () => ReadonlyArray<Record<string, unknown>> } | undefined> = [];
vi.mock("../../src/terminal/xterm-view", async () => {
  const { FakeTerminalView } = await import("../fake-terminal-view");
  return {
    createXtermView: (_host: unknown, options?: (typeof viewOptions)[number]) => {
      viewOptions.push(options);
      const v = new FakeTerminalView();
      emulators.push(v);
      return v;
    },
  };
});

const VIEW = "vscode-workbench-code";
const TOGGLE_COMMAND = "obsidian-vscode-workbench:toggle-terminal-drawer";

type Mocks = typeof import("../mocks/obsidian");
type PluginClass = typeof import("../../src/main").default;

let mocks: Mocks;
let PluginCtor: PluginClass;
let vault: string;
let pidFile: string;
let plugin: InstanceType<PluginClass>;
let app: any;
let created: any[];
let revealed: any[];
let switcherOpened: number;
let view: { type: string; file: string | null; instance?: unknown };
let custom: Record<string, Array<{ modifiers: string[]; key: string }>>;
const logged: string[] = [];
const pids = new Set<number>();

class FakeKey {
  prevented = 0;
  constructor(readonly init: Record<string, unknown>) {}
  get key() { return this.init.key; }
  get ctrlKey() { return !!this.init.ctrlKey; }
  get metaKey() { return !!this.init.metaKey; }
  get altKey() { return !!this.init.altKey; }
  get shiftKey() { return !!this.init.shiftKey; }
  get repeat() { return !!this.init.repeat; }
  get isComposing() { return false; }
  preventDefault() { this.prevented += 1; }
  stopImmediatePropagation() { /* consumed */ }
}

/** A `<webview>` (console channel) or a framed page (postMessage channel) showing the server's workbench. */
class StubEmbed {
  private handlers = new Map<string, Array<(ev: any) => void>>();
  private keydown: Array<(ev: FakeKey) => void> = [];
  readonly contentWindow = { stub: true };
  focusCalls: string[] = [];
  scripts: string[] = [];
  isConnected = true;
  executeJavaScript?: (code: string) => Promise<unknown>;

  constructor(private readonly origin: string, readonly mode: "webview" | "iframe") {
    this.pageWindow = this.newPageWindow();
    if (mode === "webview") this.executeJavaScript = async (code) => void this.inject(code);
  }

  addEventListener(type: string, cb: (ev: any) => void) { this.handlers.set(type, [...(this.handlers.get(type) ?? []), cb]); }
  removeEventListener(type: string, cb: (ev: any) => void) { this.handlers.set(type, (this.handlers.get(type) ?? []).filter((h) => h !== cb)); }
  getURL() { return `${this.origin}/?folder=%2Fvault&tkn=TOKEN-NOT-FOR-LOGS`; }
  blur() { this.focusCalls.push("blur"); }
  focus() { this.focusCalls.push("focus"); }
  emit(type: string, ev: object = {}) { for (const h of this.handlers.get(type) ?? []) h(ev); }

  /** A fresh page: no script, no key listener. Webviews announce it with dom-ready. */
  load(announce = true) {
    this.keydown = [];
    this.pageWindow = this.newPageWindow();
    if (announce && this.mode === "webview") this.emit("dom-ready");
  }

  private pageWindow: Record<string, unknown>;

  private newPageWindow(): Record<string, unknown> {
    const win: Record<string, unknown> = { addEventListener: (_t: string, fn: (ev: FakeKey) => void) => this.keydown.push(fn) };
    // Framed: the parent is the Obsidian window. A top-level page (webview) is its own parent.
    win.parent = this.mode === "iframe" ? { postMessage: (data: unknown) => this.postToHost(data) } : win;
    return win;
  }

  /** Run a script in the page, as `executeJavaScript` does. */
  inject(code: string) {
    this.scripts.push(code);
    new Function("window", "console", code)(this.pageWindow, { log: (message: string) => this.emit("console-message", { message }) });
  }

  postToHost(data: unknown) {
    const ev = new Event("message");
    Object.defineProperties(ev, { origin: { value: this.origin }, source: { value: this.contentWindow }, data: { value: data } });
    window.dispatchEvent(ev);
  }

  press(init: Record<string, unknown>): FakeKey {
    const ev = new FakeKey(init);
    for (const fn of this.keydown) fn(ev);
    return ev;
  }
}

function makeApp(root: string): any {
  const a: any = {
    vault: {
      adapter: new mocks.FileSystemAdapter(root),
      configDir: ".obsidian",
      getAbstractFileByPath: (p: string) => (fs.existsSync(path.join(root, p)) ? new mocks.TFile(p) : null),
      on: (name: string, cb: (...args: any[]) => void) => ({ name, cb }),
    },
    workspace: {
      onLayoutReady: (cb: () => void) => cb(),
      activeFile: null,
      leaves: [],
      getActiveFile: () => null,
      getActiveViewOfType: () => view.instance ?? (view.file ? { file: { path: view.file } } : null),
      getMostRecentLeaf: () => ({ view: { getViewType: () => view.type } }),
      getLeavesOfType: (type: string) => created.filter((l) => !l.detached && l.viewState?.type === type),
      getLeaf: () => {
        const l = new CodeLeaf();
        created.push(l);
        return l;
      },
      revealLeaf: async (l: unknown) => void revealed.push(l),
      detachLeavesOfType: () => undefined,
      on: (name: string, cb: (...args: any[]) => void) => ({ name, cb }),
    },
    // Obsidian's hotkey manager and command runner: the bridge reads the first and calls the second.
    hotkeyManager: {
      getHotkeys: (id: string) => custom[id],
      getDefaultHotkeys: (id: string) => defaultsOf(id),
    },
    commands: { executeCommandById: (id: string) => (id === "switcher:open" ? ((switcherOpened += 1), true) : false) },
    openWithDefaultApp: async () => undefined,
  };
  return a;
}

/** Obsidian's defaults: the quick switcher's Mod+O, and what the plugin registered for its own command. */
function defaultsOf(id: string) {
  if (id === "switcher:open") return [{ modifiers: ["Mod"], key: "o" }];
  const own = mocks.Plugin.commands.find((c: any) => `obsidian-vscode-workbench:${c.id}` === id) as any;
  return own?.hotkeys;
}

class CodeLeaf {
  viewState: { type?: string; state?: unknown } | null = null;
  detached = false;
  file: string | null = null;
  async setViewState(s: { type: string; state?: unknown }) {
    this.viewState = s;
    const file = (s.state as { file?: string } | undefined)?.file;
    if (s.type !== VIEW || !file) return;
    this.file = file;
    if (!(await plugin.admitFile(file, this as never))) this.detach();
  }
  detach() {
    if (this.detached) return;
    this.detached = true;
    if (this.file) plugin.releaseFile(this.file, this as never);
  }
}

async function loadPlugin(data: Record<string, unknown> = {}): Promise<void> {
  Object.assign(process.env, { FAKE_CODE_NODE: process.execPath, FAKE_CODE_PIDFILE: pidFile });
  app = makeApp(vault);
  plugin = new PluginCtor(app as never, { id: "obsidian-vscode-workbench", dir: ".obsidian/plugins/obsidian-vscode-workbench" } as never);
  (plugin as unknown as { pluginData: unknown }).pluginData = { codeCliPath: FAKE_CODE, serverLicenceAccepted: true, shellPath: "/bin/sh", ...data };
  await plugin.onload();
}

const term = () => plugin as unknown as { terminal: import("../../src/terminal/feature").TerminalFeature; manager: { current: { baseUrl: string } | null } };
const drawerOpen = () => term().terminal.drawer?.open ?? false;

async function waitUntil(cond: () => boolean, ms = 10000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  if (!cond()) throw new Error(`condition not met in ${ms} ms`);
}

/** A running server (the fake `code serve-web`) and a Code tab's embed attached to the plugin. */
async function openEmbed(mode: "webview" | "iframe" = "webview"): Promise<StubEmbed> {
  const server = await plugin.ensureServer();
  const embed = new StubEmbed(server.baseUrl, mode);
  plugin.attachEmbed(embed as unknown as HTMLElement);
  embed.load();
  return embed;
}

/** One shell, past its start (the status-bar count includes a shell that is still starting, so count alone no longer says it runs). */
function shellRunning(): boolean {
  const m = term().terminal.sessions;
  return m.count === 1 && m.sessions.every((x: { controller: { state: { kind: string } } }) => x.controller.state.kind === "running");
}

function rememberShellPids(): void {
  for (const c of (plugin as unknown as { registry: { list(): Array<{ pid: number; label: string }> } }).registry.list()) if (c.label === "terminal-shell") pids.add(c.pid);
}

beforeEach(async () => {
  vi.resetModules();
  mocks = await import("../mocks/obsidian");
  PluginCtor = (await import("../../src/main")).default;
  vault = tempDir();
  pidFile = path.join(tempDir(), "pids");
  created = [];
  revealed = [];
  switcherOpened = 0;
  custom = {};
  view = { type: VIEW, file: null };
  emulators.length = 0;
  viewOptions.length = 0;
  logged.length = 0;
  mocks.Plugin.reset();
  mocks.Notice.reset();
  document.body.innerHTML = "";
  document.body.className = "";
  for (const m of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(" ")));
});

afterEach(async () => {
  rememberShellPids();
  plugin?.onunload();
  await new Promise((r) => setTimeout(r, 400));
  for (const pid of pids) {
    if (!isAlive(pid)) continue;
    for (const d of listDescendants(pid)) {
      try { process.kill(d, "SIGKILL"); } catch { /* gone */ }
    }
    try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  }
  pids.clear();
  const serverPids = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8").split("\n").filter(Boolean).map(Number) : [];
  for (const pid of serverPids) if (isAlive(pid)) process.kill(pid, "SIGKILL");
  for (const k of ["FAKE_CODE_NODE", "FAKE_CODE_PIDFILE"]) delete process.env[k];
  vi.restoreAllMocks();
});

describe("the command and its hotkey (G8)", () => {
  it("registers Toggle terminal drawer with Ctrl+` as its default, so it stays rebindable in Settings > Hotkeys", async () => {
    await loadPlugin();
    const cmd = mocks.Plugin.commands.find((c: any) => c.id === "toggle-terminal-drawer") as any;
    expect(cmd).toBeDefined();
    expect(cmd.hotkeys).toEqual([{ modifiers: ["Ctrl"], key: "`" }]);
    expect(`obsidian-vscode-workbench:${cmd.id}`).toBe(TOGGLE_COMMAND);
  });

  it("the command and the strip still open the drawer after the bridge is added (nothing removed)", async () => {
    await loadPlugin();
    await openEmbed();
    const cmd = mocks.Plugin.commands.find((c: any) => c.id === "toggle-terminal-drawer") as any;
    expect(cmd.checkCallback(true)).toBe(true);
    cmd.checkCallback(false);
    expect(drawerOpen()).toBe(true);
    cmd.checkCallback(false);
    expect(drawerOpen()).toBe(false);
    (document.querySelector(".vscw-strip") as HTMLElement).click();
    expect(drawerOpen()).toBe(true);
  });
});

describe("Ctrl+` relayed from the embed (webview channel)", () => {
  it("opens the drawer, consumes the key, and starts one real shell in the active file's folder (G12, GP5b)", async () => {
    fs.mkdirSync(path.join(vault, "AWS SA Associate Mock Exams/scripts"), { recursive: true });
    view.file = "AWS SA Associate Mock Exams/scripts/estimate_time.py";
    await loadPlugin();
    const embed = await openEmbed();
    expect(embed.scripts).toHaveLength(1);
    const ev = embed.press({ key: "`", ctrlKey: true });
    expect(ev.prevented).toBe(1); // no backtick typed into the editor
    expect(drawerOpen()).toBe(true);
    expect(embed.focusCalls).toEqual(["blur"]); // focus leaves the embed so the terminal gets the typing
    await waitUntil(shellRunning);
    rememberShellPids();
    emulators[0].type("pwd\n");
    await waitUntil(() => emulators[0].text().includes(path.join(vault, "AWS SA Associate Mock Exams/scripts")));
  });

  it("a second press hides it and gives focus back to the embed; a third reveals the same shell, not a new one", async () => {
    await loadPlugin();
    const embed = await openEmbed();
    embed.press({ key: "`", ctrlKey: true });
    await waitUntil(shellRunning);
    rememberShellPids();
    const [firstPid] = [...pids];
    embed.press({ key: "`", ctrlKey: true });
    expect(drawerOpen()).toBe(false);
    expect(embed.focusCalls).toEqual(["blur", "focus"]);
    embed.press({ key: "`", ctrlKey: true });
    expect(drawerOpen()).toBe(true);
    expect(term().terminal.sessions.sessions).toHaveLength(1);
    expect([...pids]).toEqual([firstPid]);
  });

  it("ten presses in a row leave a consistent state and exactly one shell (a held key adds none)", async () => {
    await loadPlugin();
    const embed = await openEmbed();
    for (let i = 0; i < 10; i++) embed.press({ key: "`", ctrlKey: true });
    for (let i = 0; i < 5; i++) embed.press({ key: "`", ctrlKey: true, repeat: true }); // auto-repeat of the last press
    await new Promise((r) => setTimeout(r, 50));
    expect(drawerOpen()).toBe(false);
    expect(term().terminal.sessions.sessions).toHaveLength(1);
    rememberShellPids();
    expect(pids.size).toBe(1);
  });

  it("unrelated keys reach VS Code untouched: Cmd+P, Cmd+S, Ctrl+Space, typing", async () => {
    await loadPlugin();
    const embed = await openEmbed();
    const keys = [{ key: "p", metaKey: true }, { key: "s", metaKey: true }, { key: " ", ctrlKey: true }, { key: "a" }, { key: "`" }];
    for (const k of keys) expect(embed.press(k).prevented).toBe(0);
    expect(drawerOpen()).toBe(false);
    expect(switcherOpened).toBe(0);
  });

  it("with the non-code setting off the key does nothing over a note, and works over a Code tab", async () => {
    await loadPlugin({ nonCodeDrawer: false });
    const embed = await openEmbed();
    view.type = "markdown";
    embed.press({ key: "`", ctrlKey: true });
    expect(drawerOpen()).toBe(false);
    expect(term().terminal.sessions.sessions).toHaveLength(0);
    view.type = VIEW;
    embed.press({ key: "`", ctrlKey: true });
    expect(drawerOpen()).toBe(true);
  });

  it("a hotkey reveal with python3 missing shows the red message and the same key hides the drawer (E9)", async () => {
    const saved = process.env.PATH;
    try {
      await loadPlugin();
      const embed = await openEmbed();
      process.env.PATH = "/nonexistent-path-for-test"; // after the fake server started; the preflight reads it at reveal
      embed.press({ key: "`", ctrlKey: true });
      await waitUntil(() => !!document.querySelector(".vscw-message.vscw-error"));
      expect(document.querySelector(".vscw-message")!.textContent).toMatch(/python3/);
      embed.press({ key: "`", ctrlKey: true });
      expect(drawerOpen()).toBe(false);
    } finally {
      process.env.PATH = saved;
    }
  });

  it("a hotkey reveal with a missing shell binary shows the red message and the same key hides it (E10)", async () => {
    await loadPlugin({ shellPath: "/no/such/shell" });
    const embed = await openEmbed();
    embed.press({ key: "`", ctrlKey: true });
    await waitUntil(() => !!document.querySelector(".vscw-message.vscw-error"));
    expect(document.querySelector(".vscw-message")!.textContent).toContain("/no/such/shell");
    embed.press({ key: "`", ctrlKey: true });
    expect(drawerOpen()).toBe(false);
  });

  it.each(["markdown", "canvas", "graph", "pdf"])(
    "with the non-code setting off the command is unavailable over %s, so Obsidian does not consume the key; over a Code tab it is available (C22)",
    async (type) => {
      await loadPlugin({ nonCodeDrawer: false });
      const cmd = mocks.Plugin.commands.find((c: any) => c.id === "toggle-terminal-drawer") as any;
      view.type = type;
      expect(cmd.checkCallback(true)).toBe(false); // false = the hotkey is not taken, the key goes on to Obsidian
      expect(cmd.checkCallback(false)).toBe(false);
      expect(drawerOpen()).toBe(false);
      expect(term().terminal.sessions.sessions).toHaveLength(0);
      view.type = VIEW;
      expect(cmd.checkCallback(true)).toBe(true);
      cmd.checkCallback(false);
      expect(drawerOpen()).toBe(true);
    },
  );

  it("a hotkey reveal while a Code tab is focused starts the shell in that file's folder, and a later tab switch does not move it (G12)", async () => {
    fs.mkdirSync(path.join(vault, "Café Notes"), { recursive: true });
    fs.mkdirSync(path.join(vault, "other"), { recursive: true });
    view.file = "Café Notes/my script.py";
    await loadPlugin();
    const embed = await openEmbed();
    embed.press({ key: "`", ctrlKey: true });
    await waitUntil(shellRunning);
    rememberShellPids();
    view.file = "other/b.py"; // the user moves to another tab afterwards
    emulators[0].type("pwd\n");
    await waitUntil(() => emulators[0].text().includes(path.join(vault, "Café Notes")));
    expect(emulators[0].text()).not.toContain(path.join(vault, "other"));
  });

  describe("keyboard focus when the drawer closes with focus in the terminal (GP5e)", () => {
    async function revealAndFocusTerminal(embed: StubEmbed): Promise<void> {
      embed.press({ key: "`", ctrlKey: true });
      await waitUntil(shellRunning);
      rememberShellPids();
      const field = document.createElement("textarea"); // xterm's helper textarea
      document.querySelector(".vscw-terminal")!.appendChild(field);
      field.focus();
      embed.focusCalls.length = 0;
    }

    it("over a Code tab the embed gets keyboard focus back (the real CodeView.focusEmbed)", async () => {
      await loadPlugin();
      const embed = await openEmbed();
      const { CodeView } = await import("../../src/code-view");
      const tab = Object.create(CodeView.prototype) as { frame: unknown };
      tab.frame = embed;
      view.instance = tab;
      await revealAndFocusTerminal(embed);
      emulators[0].pressToggleKey(); // Ctrl+` typed in the terminal
      expect(drawerOpen()).toBe(false);
      expect(embed.focusCalls).toEqual(["focus"]);
    });

    it("over a note the note's editor gets focus", async () => {
      await loadPlugin();
      const embed = await openEmbed();
      let focused = 0;
      view.instance = { editor: { focus: () => void (focused += 1) } };
      await revealAndFocusTerminal(embed);
      emulators[0].pressToggleKey();
      expect(drawerOpen()).toBe(false);
      expect(focused).toBe(1);
      expect(embed.focusCalls).toEqual([]);
    });

    it("with no view to hand focus to, closing does not throw", async () => {
      await loadPlugin();
      const embed = await openEmbed();
      await revealAndFocusTerminal(embed);
      expect(() => emulators[0].pressToggleKey()).not.toThrow();
      expect(drawerOpen()).toBe(false);
    });
  });
});

describe("the quick switcher relayed from the embed (G1)", () => {
  const MOD_O_MAC = { key: "o", ctrlKey: false, metaKey: true };
  const MOD_O = process.platform === "darwin" ? MOD_O_MAC : { key: "o", ctrlKey: true };

  it("Cmd+O (Mod+O) runs switcher:open once, takes focus out of the embed and is consumed", async () => {
    await loadPlugin();
    const embed = await openEmbed();
    const ev = embed.press(MOD_O);
    expect(ev.prevented).toBe(1);
    expect(switcherOpened).toBe(1);
    expect(embed.focusCalls).toEqual(["blur"]);
    expect(drawerOpen()).toBe(false);
  });

  it("choosing a file opens it in a Code tab; choosing one already open focuses its tab and adds none", async () => {
    fs.mkdirSync(path.join(vault, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(vault, "scripts/a.py"), "a = 1\n");
    fs.writeFileSync(path.join(vault, "scripts/b.py"), "b = 1\n");
    await loadPlugin();
    const embed = await openEmbed();
    const choose = async (file: string) => {
      const leaf = app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW, state: { file }, active: true });
      return leaf;
    };
    embed.press(MOD_O);
    const first = await choose("scripts/a.py");
    embed.press(MOD_O);
    await choose("scripts/b.py");
    expect(switcherOpened).toBe(2);
    const live = () => created.filter((l) => !l.detached);
    expect(live().map((l) => l.file)).toEqual(["scripts/a.py", "scripts/b.py"]);
    embed.press(MOD_O);
    const dup = await choose("scripts/a.py");
    expect(dup.detached).toBe(true);
    expect(live().map((l) => l.file)).toEqual(["scripts/a.py", "scripts/b.py"]);
    expect(revealed[revealed.length - 1]).toBe(first);
  });

  it("opening the switcher does not touch an open buffer: nothing is asked, closed or written", async () => {
    fs.writeFileSync(path.join(vault, "dirty.py"), "x = 1\n");
    await loadPlugin();
    const embed = await openEmbed();
    const before = fs.readFileSync(path.join(vault, "dirty.py"), "utf8");
    const notices = mocks.Notice.messages.length;
    embed.press(MOD_O);
    expect(mocks.Notice.messages.length).toBe(notices);
    expect(created.filter((l) => l.detached)).toHaveLength(0);
    expect(fs.readFileSync(path.join(vault, "dirty.py"), "utf8")).toBe(before);
    expect(embed.scripts).toHaveLength(1);
  });
});

describe("rebinding and reloads", () => {
  it("a rebinding in Obsidian's hotkey settings is followed on the next sync, and the old chord no longer works in the embed", async () => {
    await loadPlugin();
    const embed = await openEmbed();
    custom[TOGGLE_COMMAND] = [{ modifiers: ["Ctrl", "Alt"], key: "j" }];
    // The plugin syncs on a timer and on tab changes; a tab change is what this drives.
    (mocks.Plugin.events.find((e: any) => e.name === "active-leaf-change") as any).cb();
    expect(embed.scripts).toHaveLength(2);
    const oldChord = embed.press({ key: "`", ctrlKey: true });
    expect(oldChord.prevented).toBe(0);
    expect(drawerOpen()).toBe(false);
    embed.press({ key: "j", ctrlKey: true, altKey: true });
    expect(drawerOpen()).toBe(true);
  });

  it("the terminal's own close key is the command's live hotkey list: Ctrl+` by default, the new chord after a rebinding, none when unbound (PR-8 R3)", async () => {
    await loadPlugin();
    const embed = await openEmbed();
    embed.press({ key: "`", ctrlKey: true });
    await waitUntil(shellRunning);
    const chordsNow = () => (viewOptions[0]!.toggleChords!() as Array<Record<string, unknown>>).map((c) => [c.ctrl, c.alt, c.shift, c.meta, c.key]);
    expect(chordsNow()).toEqual([[true, false, false, false, "`"]]);
    custom[TOGGLE_COMMAND] = [{ modifiers: ["Ctrl", "Alt"], key: "j" }];
    expect(chordsNow()).toEqual([[true, true, false, false, "j"]]); // no resync needed: read on every key
    custom[TOGGLE_COMMAND] = [];
    expect(chordsNow()).toEqual([]);
  });

  it("unbinding the command in Obsidian frees the chord for VS Code", async () => {
    await loadPlugin();
    const embed = await openEmbed();
    custom[TOGGLE_COMMAND] = [];
    (mocks.Plugin.events.find((e: any) => e.name === "layout-change") as any).cb();
    expect(embed.press({ key: "`", ctrlKey: true }).prevented).toBe(0);
    expect(drawerOpen()).toBe(false);
  });

  it("a reload (server restart) gets the script again; keys before the page loads do not throw", async () => {
    await loadPlugin();
    const embed = await openEmbed();
    expect(() => embed.press({ key: "`", ctrlKey: true })).not.toThrow();
    embed.press({ key: "`", ctrlKey: true }); // hide again
    embed.load(false); // reload: a fresh page that has not announced itself yet
    expect(embed.press({ key: "`", ctrlKey: true }).prevented).toBe(0); // not yet scripted
    embed.emit("dom-ready");
    expect(embed.scripts.length).toBeGreaterThanOrEqual(2);
    expect(embed.press({ key: "`", ctrlKey: true }).prevented).toBe(1);
  });

  it("a message arriving after the tab closed (stub detached) is ignored", async () => {
    await loadPlugin();
    const embed = await openEmbed();
    const keys = (plugin as unknown as { keyRelay: { dispose(): void } }).keyRelay;
    keys.dispose();
    embed.emit("console-message", { message: '__vscw_key__:{"v":1,"action":"toggle-terminal"}' });
    expect(drawerOpen()).toBe(false);
  });
});

describe("the framed page channel (postMessage)", () => {
  it("a framed stub page posts the action and the drawer opens; a foreign origin is ignored", async () => {
    await loadPlugin();
    const embed = await openEmbed("iframe");
    const { buildRelayScript, resolveChords } = await import("../../src/hotkey/hotkey-bridge");
    embed.inject(buildRelayScript(resolveChords((id) => (id === TOGGLE_COMMAND ? [{ modifiers: ["Ctrl"], key: "`" }] : []), false)));
    const foreign = new Event("message");
    Object.defineProperties(foreign, { origin: { value: "https://evil.example" }, source: { value: embed.contentWindow }, data: { value: { vscw: 1, v: 1, action: "toggle-terminal" } } });
    window.dispatchEvent(foreign);
    expect(drawerOpen()).toBe(false);
    embed.press({ key: "`", ctrlKey: true });
    expect(drawerOpen()).toBe(true);
  });
});

describe("what the bridge writes and sends", () => {
  it("logs nothing at all while keys are relayed: no key, no text, no token", async () => {
    await loadPlugin();
    const embed = await openEmbed();
    logged.length = 0;
    embed.press({ key: "`", ctrlKey: true });
    embed.press({ key: "a" });
    embed.press({ key: "o", metaKey: true });
    embed.press({ key: "`", ctrlKey: true });
    expect(logged.filter((l) => !l.startsWith("__vscw_key__:"))).toEqual([]);
    expect(logged.join("\n")).not.toContain("TOKEN-NOT-FOR-LOGS");
  });

  it("the script given to the page carries no token or address, and the bridge makes no note changes", async () => {
    fs.writeFileSync(path.join(vault, "note.md"), "# note\n");
    await loadPlugin();
    const embed = await openEmbed();
    embed.press({ key: "`", ctrlKey: true });
    expect(embed.scripts.join("")).not.toMatch(/TOKEN-NOT-FOR-LOGS|127\.0\.0\.1|tkn/);
    expect(fs.readFileSync(path.join(vault, "note.md"), "utf8")).toBe("# note\n");
  });
});

describe("the fallback: the recorded decision is `no` (E12, F2)", () => {
  async function loadWithDecisionNo(): Promise<void> {
    vi.resetModules();
    vi.doMock("../../src/hotkey/decision", () => ({ HOTKEY_BRIDGE: "no", bridgeEnabled: (d: string = "no") => d === "yes" }));
    mocks = await import("../mocks/obsidian");
    PluginCtor = (await import("../../src/main")).default;
    mocks.Plugin.reset();
    await loadPlugin();
  }

  afterEach(() => vi.doUnmock("../../src/hotkey/decision"));

  it("no relay is installed: the embed is never scripted and keys inside it are left to VS Code", async () => {
    await loadWithDecisionNo();
    expect((plugin as unknown as { keyRelay: { active: boolean } }).keyRelay.active).toBe(false);
    const embed = await openEmbed();
    expect(embed.scripts).toEqual([]);
    expect(embed.press({ key: "`", ctrlKey: true }).prevented).toBe(0);
    embed.emit("console-message", { message: '__vscw_key__:{"v":1,"action":"toggle-terminal"}' });
    expect(drawerOpen()).toBe(false);
    expect(switcherOpened).toBe(0);
  });

  it("the order of the container check: Ctrl+` inside the embed does nothing, then the strip click opens the drawer (E12, C42)", async () => {
    await loadWithDecisionNo();
    const embed = await openEmbed();
    const ev = embed.press({ key: "`", ctrlKey: true });
    expect(ev.prevented).toBe(0); // the key is left to VS Code, nothing harmful happens
    expect(drawerOpen()).toBe(false);
    expect(term().terminal.sessions.sessions).toHaveLength(0);
    expect(embed.focusCalls).toEqual([]);
    (document.querySelector(".vscw-strip") as HTMLElement).click();
    expect(drawerOpen()).toBe(true);
    await waitUntil(shellRunning);
    rememberShellPids();
  });

  it("the strip still opens the drawer, and the command works once a non-embed pane has focus", async () => {
    await loadWithDecisionNo();
    await openEmbed();
    (document.querySelector(".vscw-strip") as HTMLElement).click();
    expect(drawerOpen()).toBe(true);
    const cmd = mocks.Plugin.commands.find((c: any) => c.id === "toggle-terminal-drawer") as any;
    cmd.checkCallback(false);
    expect(drawerOpen()).toBe(false);
  });

  it("no Monaco or other editor appears: the plugin adds no editor element of its own (F2)", async () => {
    await loadWithDecisionNo();
    await openEmbed();
    expect(document.querySelector(".monaco-editor, .cm-editor")).toBeNull();
  });
});
