/**
 * A fake DOM element and a fake VS Code page for the terminal host tests. The element follows the `FakeWebview` pattern of
 * `helpers.ts` (attributes, every `src` set, scripts run, dom-ready fired after a navigation) and adds what the host needs:
 * a parent, children, text, removal and input events. `FakeWorkbenchPage` stands in for the page behind a webview: it answers
 * the layout script from a layout that VS Code's commands change, the way the real workbench does: the plugin-owned extension
 * running in the page closes the side bars and focuses the terminal (the page here does the same by itself, or a test runs
 * the real extension against it and calls the page's command methods).
 */
import type { TerminalHostDeps } from "../src/terminal-host/host-page";
import { LAYOUT_SCRIPT, PART_NAMES, type PartName } from "../src/terminal-host/panel-only";

type Listener = { fn: (ev?: unknown) => void; once: boolean };

export class FakeHostEl {
  attrs: Record<string, string> = {};
  style: Record<string, string> = {};
  className = "";
  textContent = "";
  children: FakeHostEl[] = [];
  parent: FakeHostEl | null = null;
  removed = false;
  /** Every value `src` has been set to, in order. */
  srcs: string[] = [];
  executed: string[] = [];
  sent: Array<{ type: string; keyCode?: string; modifiers?: string[] }> = [];
  focusCount = 0;
  private listeners: Record<string, Listener[]> = {};
  /** The page behind the element, for a webview. */
  page: FakeWorkbenchPage | null = null;
  autoDomReady = true;
  constructor(public tag: string) {}

  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
    if (k === "src") {
      this.srcs.push(v);
      this.page?.navigated(this.srcs.length);
      if (this.autoDomReady) setTimeout(() => this.fire("dom-ready"), 0);
    }
  }
  addEventListener(name: string, fn: (ev?: unknown) => void, opts?: { once?: boolean }): void {
    (this.listeners[name] ??= []).push({ fn, once: opts?.once === true });
  }
  fire(name: string, ev?: unknown): void {
    for (const l of [...(this.listeners[name] ?? [])]) {
      if (l.once) this.listeners[name] = this.listeners[name].filter((x) => x !== l);
      l.fn(ev);
    }
  }
  appendChild(c: FakeHostEl): void {
    c.parent = this;
    this.children.push(c);
  }
  replaceChildren(): void {
    for (const c of this.children) c.parent = null;
    this.children = [];
  }
  remove(): void {
    this.removed = true;
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  focus(): void {
    this.focusCount++;
  }
  executeJavaScript(code: string): Promise<unknown> {
    this.executed.push(code);
    if (!this.page) return Promise.resolve("seeded");
    return this.page.run(code);
  }
  /** The plugin sends the page no key and no click any more; whatever reaches here is recorded so a test can say it is empty. */
  sendInputEvent(ev: { type: string; keyCode?: string; modifiers?: string[] }): void {
    this.sent.push(ev);
  }
  /** Every element below this one, depth first. */
  all(): FakeHostEl[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  /** The text of this element and everything below it that is not hidden with display: none. */
  visibleText(): string {
    if (this.style.display === "none") return "";
    return [this.textContent, ...this.children.map((c) => c.visibleText())].filter(Boolean).join("\n");
  }
  find(tag: string): FakeHostEl[] {
    return this.all().filter((e) => e.tag === tag);
  }
  click(): void {
    this.fire("click");
  }
}

type Size = [number, number] | null;

/** Width of the fake page's secondary side bar when it is open. */
const AUX_WIDTH = 160;

export interface PageOptions {
  /** The partition's profile already holds the panel-only layout (a later load). */
  panelOnlyAlready?: boolean;
  /** The secondary side bar (Chat) is open, as on a fresh profile of a current VS Code. Absent: it is closed. */
  auxiliaryBar?: boolean;
  /**
   * The plugin-owned extension in the page puts it in the panel-only layout (side bar closed, secondary side bar closed, the
   * terminal focused) once the workbench has painted. Default true. False: the extension never does (it is not installed, or
   * the page is not the terminal page), so a test can run the real extension against the page, or see the page never get there.
   */
  extension?: boolean;
  /** With the extension: it acts this many ms after the first paint (a cold page starts its extension host late). Default 0. */
  extensionDelayMs?: number;
  /** The workbench never paints. */
  neverPaints?: boolean;
  win?: [number, number];
  seedResult?: string;
  trustResult?: string;
  /**
   * Models VS Code's own behaviour of opening a first terminal, in the folder the page was opened on, whenever the terminal
   * panel comes up with no terminal in it (the terminal focus command, or a layout that already has the panel). Absent: no
   * terminal is modelled.
   */
  defaultCwd?: string;
  /**
   * With `defaultCwd`: VS Code's first terminal is listed in the extension host only this many ms after the panel came up
   * (the panel decides at once, the extension host hears of it later). Absent: it is listed at once.
   */
  terminalDelayMs?: number;
}

/** A terminal of the fake page: the folder it started in, and the two parts of VS Code's terminal object the plugin's extension uses. */
export interface FakeTerminal {
  cwd: string;
  exitStatus: undefined;
  dispose(): void;
}

/** The workbench page behind a webview, seen only through the scripts and input events the host sends. */
export class FakeWorkbenchPage {
  parts: Record<PartName, Size>;
  loads = 0;
  themeScripts: string[] = [];
  /** Held while set: a theme script waits for it (to make switches overlap). */
  themeGate: Promise<void> | null = null;
  constructor(private readonly opts: PageOptions = {}) {
    const win = opts.win ?? [1000, 400];
    this.win = win;
    const only = opts.panelOnlyAlready === true;
    this.parts = {
      titlebar: null,
      activitybar: null,
      sidebar: only ? [0, 0] : [250, win[1]],
      auxiliarybar: opts.auxiliaryBar === true && !only ? [AUX_WIDTH, win[1]] : null,
      editor: only ? [0, 0] : [win[0] - 250, win[1]],
      panel: only ? [win[0], win[1]] : [0, 0],
      statusbar: null,
    };
    if (only) this.panelUp();
  }
  win: [number, number];
  private extensionScheduled = false;
  /** The terminals in the page, in the order they were made: the page's own first one and any the extension asks for. */
  terminals: FakeTerminal[] = [];
  private firstTerminalPending = false;
  private openListeners = new Set<(t: FakeTerminal) => void>();

  /** `vscode.window.onDidOpenTerminal`: called after the terminal is in the list. */
  onDidOpenTerminal(cb: (t: FakeTerminal) => void): { dispose(): void } {
    this.openListeners.add(cb);
    return { dispose: () => void this.openListeners.delete(cb) };
  }

  /** A terminal is made in `cwd`. */
  addTerminal(cwd: string): FakeTerminal {
    const t: FakeTerminal = { cwd, exitStatus: undefined, dispose: () => void this.terminals.splice(this.terminals.indexOf(t), 1) };
    this.terminals.push(t);
    for (const cb of [...this.openListeners]) cb(t);
    return t;
  }

  /** The panel is up: VS Code makes its own first terminal when there is none. */
  private panelUp(): void {
    const cwd = this.opts.defaultCwd;
    if (cwd === undefined || this.terminals.length > 0 || this.firstTerminalPending) return;
    if (this.opts.terminalDelayMs === undefined) {
      this.addTerminal(cwd);
      return;
    }
    this.firstTerminalPending = true;
    setTimeout(() => {
      this.firstTerminalPending = false;
      this.addTerminal(cwd);
    }, this.opts.terminalDelayMs);
  }

  navigated(n: number): void {
    this.loads = n;
  }

  /** The first paint of a loaded page starts the extension, once. */
  private scheduleExtension(): void {
    if (this.extensionScheduled || this.opts.extension === false) return;
    this.extensionScheduled = true;
    if ((this.opts.extensionDelayMs ?? 0) === 0) this.runExtension();
    else setTimeout(() => this.runExtension(), this.opts.extensionDelayMs);
  }

  async run(code: string): Promise<unknown> {
    if (code === LAYOUT_SCRIPT) {
      if (this.loads < 2 || this.opts.neverPaints) return "";
      this.scheduleExtension();
      return JSON.stringify({ win: this.win, parts: this.parts });
    }
    if (code.includes("BroadcastChannel")) {
      this.themeScripts.push(code);
      if (this.themeGate) await this.themeGate;
      return "applied";
    }
    if (code.includes("vscode-web-state-db-global-shared")) return this.opts.trustResult ?? "seeded";
    return this.opts.seedResult ?? "seeded";
  }

  // VS Code's own commands, as the extension runs them. Each sets a state, none toggles: running one twice changes nothing more.

  /** `workbench.action.closeSidebar` */
  closeSideBar(): void {
    this.parts.sidebar = [0, 0];
    this.fillEditor();
  }

  /** `workbench.action.closeAuxiliaryBar` */
  closeAuxiliaryBar(): void {
    this.parts.auxiliarybar = [0, 0];
    this.fillEditor();
  }

  /** `workbench.action.terminal.focus`: opens the panel (maximized: the editor goes) and starts the first terminal when there is none. */
  focusTerminal(): void {
    const sideBar = this.parts.sidebar !== null && this.parts.sidebar[0] > 0 ? this.parts.sidebar[0] : 0;
    this.parts.panel = [this.win[0] - sideBar, this.win[1]];
    this.parts.editor = [0, 0];
    this.panelUp();
  }

  private fillEditor(): void {
    const taken = (n: PartName) => (this.parts[n] !== null && this.parts[n]![0] > 0 ? this.parts[n]![0] : 0);
    const panelUp = this.parts.panel !== null && this.parts.panel[0] > 0;
    this.parts.editor = panelUp ? [0, 0] : [this.win[0] - taken("sidebar") - taken("auxiliarybar"), this.win[1]];
  }

  /** The extension's three commands, in its order. */
  private runExtension(): void {
    this.closeSideBar();
    this.closeAuxiliaryBar();
    this.focusTerminal();
  }

  /** The parts that are drawn, by name. */
  shown(): PartName[] {
    return PART_NAMES.filter((n) => this.parts[n] !== null && this.parts[n]![0] > 0 && this.parts[n]![1] > 0);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// A host page wired to fakes
// ---------------------------------------------------------------------------------------------------------------

export const FAKE_SERVER = { baseUrl: "http://127.0.0.1:5555", port: 5555, token: "tok-SECRET-123" };

export interface World {
  parent: FakeHostEl;
  deps: TerminalHostDeps;
  /** Every element the host created, in order. */
  created: FakeHostEl[];
  notices: string[];
  calls: { licence: number; server: number };
  /** What the next licence modal answers; the promise it returns is held while `licenceGate` is set. */
  licence: { accepted: boolean; answer: boolean; gate: Promise<void> | null };
  /** What the next server start does. */
  server: { gate: Promise<void> | null; fail: unknown };
  dark: { value: boolean };
  webviews(): FakeHostEl[];
  container(): FakeHostEl;
  /** Everything the user can read: the text of every element in the parent that is not display: none. */
  text(): string;
}

export function makeWorld(opts: { page?: PageOptions; accepted?: boolean; trust?: boolean } = {}): World {
  const parent = new FakeHostEl("body");
  const created: FakeHostEl[] = [];
  const notices: string[] = [];
  const calls = { licence: 0, server: 0 };
  const licence = { accepted: opts.accepted ?? false, answer: true, gate: null as Promise<void> | null };
  const server = { gate: null as Promise<void> | null, fail: null as unknown };
  const dark = { value: true };
  const deps: TerminalHostDeps = {
    createElement: (tag) => {
      const e = new FakeHostEl(tag);
      if (tag === "webview") e.page = new FakeWorkbenchPage(opts.page);
      created.push(e);
      return e as unknown as HTMLElement;
    },
    parent: parent as unknown as HTMLElement,
    vaultRoot: () => "/Users/dan/My Vault",
    licenceAccepted: () => licence.accepted,
    requestLicence: async () => {
      calls.licence++;
      if (licence.gate) await licence.gate;
      if (licence.answer) licence.accepted = true;
      return licence.answer;
    },
    ensureServer: async () => {
      calls.server++;
      if (server.gate) await server.gate;
      if (server.fail) throw server.fail;
      return FAKE_SERVER;
    },
    failureText: (e) => `failed: ${e instanceof Error ? e.message : String(e)}`,
    notice: (m) => void notices.push(m),
    isDark: () => dark.value,
    workbenchOverlay: () => ({ "workbench.colorTheme": dark.value ? "Dark Modern" : "Light Modern" }),
    userDataCopy: () => null,
    trustVaultFolder: () => opts.trust ?? true,
    heldPorts: () => [5555],
    pollMs: 1,
    loadMs: 400,
    panelMs: 200,
  };
  return {
    parent,
    deps,
    created,
    notices,
    calls,
    licence,
    server,
    dark,
    webviews: () => created.filter((e) => e.tag === "webview"),
    container: () => parent.children[0],
    text: () => parent.visibleText(),
  };
}

/** A promise and the function that settles it. */
export function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
}
