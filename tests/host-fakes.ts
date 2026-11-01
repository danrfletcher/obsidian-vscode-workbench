/**
 * A fake DOM element and a fake VS Code page for the terminal host tests. The element follows the `FakeWebview` pattern of
 * `helpers.ts` (attributes, every `src` set, scripts run, dom-ready fired after a navigation) and adds what the host needs:
 * a parent, children, text, removal and input events. `FakeWorkbenchPage` stands in for the page behind a webview: it answers
 * the layout script from a layout the key presses change, the way the real workbench does.
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
  sendInputEvent(ev: { type: string; keyCode?: string; modifiers?: string[] }): void {
    this.sent.push(ev);
    this.page?.input(ev);
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

export interface PageOptions {
  /** The partition's profile already holds the panel-only layout (a later load). */
  panelOnlyAlready?: boolean;
  /** Key presses do nothing (the layout never changes). */
  deaf?: boolean;
  /** The workbench never paints. */
  neverPaints?: boolean;
  win?: [number, number];
  seedResult?: string;
  trustResult?: string;
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
      auxiliarybar: null,
      editor: only ? [0, 0] : [win[0] - 250, win[1]],
      panel: only ? [win[0], win[1]] : [0, 0],
      statusbar: null,
    };
  }
  win: [number, number];

  navigated(n: number): void {
    this.loads = n;
  }

  async run(code: string): Promise<unknown> {
    if (code === LAYOUT_SCRIPT) {
      if (this.loads < 2 || this.opts.neverPaints) return "";
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

  input(ev: { type: string; keyCode?: string; modifiers?: string[] }): void {
    if (this.opts.deaf || ev.type !== "keyDown") return;
    const sidebarKey = ev.keyCode === "B" && (ev.modifiers?.includes("meta") || ev.modifiers?.includes("control"));
    if (sidebarKey) {
      const shown = this.parts.sidebar !== null && this.parts.sidebar[0] > 0;
      this.parts.sidebar = shown ? [0, 0] : [250, this.win[1]];
      this.parts.editor = [this.win[0] - (shown ? 0 : 250), this.win[1]];
    } else if (ev.keyCode === "`" && ev.modifiers?.includes("control")) {
      const shown = this.parts.panel !== null && this.parts.panel[0] > 0;
      // opensMaximized: always: an open panel hides the editor
      this.parts.panel = shown ? [0, 0] : [this.win[0] - (this.parts.sidebar && this.parts.sidebar[0] > 0 ? 250 : 0), this.win[1]];
      this.parts.editor = shown ? [this.win[0], this.win[1]] : [0, 0];
    }
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

export function makeWorld(opts: { page?: PageOptions; accepted?: boolean; trust?: boolean; mac?: boolean } = {}): World {
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
    mac: opts.mac ?? true,
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
