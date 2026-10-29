/**
 * The terminal drawer as the plugin uses it: the drawer UI, the shell sessions, the layout,
 * the status-bar count and the per-device state in `data.json`, wired together. main.ts creates this, calls
 * `mount()` once the workspace is ready and `dispose()` on unload.
 *
 * Nothing here touches the network: the shell is reached through the helper's pipes only.
 */
import * as path from "node:path";
import type { ChildRegistry } from "../child-registry";
import { DrawerUI, type TerminalView } from "./drawer-ui";
import { clampHeight } from "./drawer-geometry";
import { drawerVisibility, viewKind, type Visibility } from "./drawer-visibility";
import { KillConfirm } from "./kill-confirm";
import { LayoutController } from "./layout";
import { SessionManager, type SessionEvent } from "./session-manager";
import { ShellCountItem } from "./shell-count";
import { DRAWER_KEY, deviceId, readDrawerState, withDrawerState, type DeviceIdStore, type DrawerState } from "./drawer-state";
import type { ShellProgress } from "../hotkey/drawer-toggle";
import { installHelper } from "./helper-source";
import { preflight as realPreflight, type PreflightResult } from "./pty-preflight";
import { PtySession, realSessionDeps, type SessionDeps, type SessionOptions } from "./pty-session";
import { ShellStartDir } from "./shell-cwd";
import { ShellController, type ShellState } from "./terminal-controller";
import { createXtermView, DEFAULT_TOGGLE_CHORDS, type ToggleChord } from "./xterm-view";

export interface TerminalHost {
  document: Document;
  window: Window;
  vaultRoot(): string;
  /** The vault-relative path of the file in the active view; null when there is none. */
  activeFile(): string | null;
  /** The plugin's live data object (what `saveData` writes). */
  data(): Record<string, unknown>;
  save(): Promise<void>;
  /** The shell the settings ask for, the default already applied. */
  shell(): string;
  /** The plugin's runtime folder; the helper script is written here. */
  runtimeDir(): string;
  registry: ChildRegistry;
  deviceStore: DeviceIdStore;
  /** The "terminal drawer over non-code views" setting, read each time it matters (so a change applies live). */
  nonCodeDrawer(): boolean;
  /** The view type of the main-area tab the user is on (the sidebars do not count); "" when there is none. */
  activeViewType(): string;
  /** This plugin's own Code tab view type. */
  codeViewType: string;
  /** A new status-bar element (Obsidian's `addStatusBarItem`). */
  addStatusBarItem(): HTMLElement;
  /** Give keyboard focus back to the editor of the active view (the drawer closed with focus in the terminal, GP5e). */
  focusEditor?(): void;
  /** The chords Obsidian has for "Toggle terminal drawer" now, so the terminal closes the drawer on the rebound key too. Absent: Ctrl+`. */
  toggleChords?(): readonly ToggleChord[];
  /** Ask whether to kill the running shell named `title`. true only for an explicit confirm; Cancel and Escape are false. */
  confirmKill(title: string): Promise<boolean>;
}

/** Replacements for the real xterm, preflight and process spawn (tests only). */
export interface TerminalOverrides {
  createTerminal?: (host: HTMLElement, options?: { toggleChords?: () => readonly ToggleChord[] }) => TerminalView;
  preflight?: (shell: string) => Promise<PreflightResult>;
  session?: SessionDeps;
  baseEnv?: NodeJS.ProcessEnv;
}

/** The environment the shell starts with. A bare Obsidian has no TERM or locale, so both are set. */
export function shellEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "obsidian-vscode-workbench" };
  delete env.ELECTRON_RUN_AS_NODE;
  if (!env.LC_ALL && !env.LANG) env.LANG = "en_US.UTF-8";
  return env;
}

/** How long the drawer state waits after the last change before data.json is written. */
export const SAVE_DEBOUNCE_MS = 400;

export class TerminalFeature {
  private ui: DrawerUI | null = null;
  private layout: LayoutController | null = null;
  private readonly manager: SessionManager;
  private readonly kills: KillConfirm;
  private readonly count: ShellCountItem;
  private id: string | null = null;
  private disposed = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly host: TerminalHost,
    private readonly overrides: TerminalOverrides = {},
  ) {
    const sessionDeps: SessionDeps = { ...realSessionDeps, ...overrides.session, registry: host.registry };
    this.manager = new SessionManager({
      shellName: () => path.basename(host.shell()) || "shell",
      createController: (sessionId) =>
        new ShellController({
          shell: () => host.shell(),
          preflight: overrides.preflight ?? ((shell) => realPreflight(shell)),
          installHelper: () => installHelper(host.runtimeDir()),
          // One start folder per session: each new shell takes the folder of the file active when it is created.
          startDir: new ShellStartDir(() => host.vaultRoot(), () => host.activeFile()),
          size: () => this.ui?.terminalOf(sessionId)?.size() ?? { cols: 80, rows: 24 },
          env: () => shellEnv(overrides.baseEnv ?? process.env),
          createSession: (opts: SessionOptions) => new PtySession(opts, sessionDeps),
        }),
    });
    this.kills = new KillConfirm(this.manager, (title) => host.confirmKill(title));
    this.count = new ShellCountItem(() => host.addStatusBarItem());
    this.manager.onEvent((e) => this.onSessionEvent(e));
  }

  get drawer(): DrawerUI | null {
    return this.ui;
  }

  get sessions(): SessionManager {
    return this.manager;
  }

  /** The status-bar item's element; null while no shell runs. */
  get statusItem(): HTMLElement | null {
    return this.count.element;
  }

  /** Create the strip and the drawer, restoring this device's height and open state. Safe to call twice. */
  mount(): void {
    if (this.ui || this.disposed) return;
    const doc = this.host.document;
    if (!doc?.body || typeof doc.createElement !== "function") return; // a host with no page to draw on
    const id = deviceId(this.host.deviceStore);
    this.id = id;
    const windowHeight = this.host.window.innerHeight;
    const initial = readDrawerState(this.host.data(), id, windowHeight);
    this.layout = new LayoutController({ document: doc, window: this.host.window, onChange: () => this.ui?.refit() });
    const ui = new DrawerUI({
      document: doc,
      window: this.host.window,
      initial,
      layout: this.layout,
      onChange: (state) => {
        this.persist(state);
        this.applyVisibility();
      },
      onReveal: () => this.reveal(),
      onNewSession: () => this.newSession(),
      onKillActive: () => this.killActive(),
      onSelect: (sessionId) => this.manager.activate(sessionId),
      onRestart: (sessionId) => void this.manager.restart(sessionId),
      onClosed: (hadFocus) => {
        if (hadFocus) this.host.focusEditor?.();
      },
      createTerminal: (el) => (this.overrides.createTerminal ?? createXtermView)(el, { toggleChords: () => this.host.toggleChords?.() ?? DEFAULT_TOGGLE_CHORDS }),
    });
    ui.onInput((sessionId, data) => this.manager.get(sessionId)?.controller.write(data));
    ui.onTerminalResize((sessionId, cols, rows) => this.manager.get(sessionId)?.controller.resize(cols, rows));
    this.ui = ui;
    // A saved height taller than this window is corrected in the file as well as on screen (E14).
    if (this.storedHeight(id) !== undefined && this.storedHeight(id) !== initial.height) this.persist(initial);
    ui.setHidden(!this.visibility().strip);
    ui.mount(doc.body);
  }

  /** What the strip, the drawer and the hotkey do over the view the user is on (G11, GP6). */
  visibility(): Visibility {
    return drawerVisibility({
      kind: viewKind(this.host.activeViewType(), this.host.codeViewType),
      nonCodeDrawer: this.host.nonCodeDrawer(),
      drawerOpen: this.ui?.open ?? false,
    });
  }

  /** The drawer is open (what was last asked for, shown or not). */
  get isOpen(): boolean {
    return this.ui?.open ?? false;
  }

  /** How far the active shell is, for the hotkey toggle's state (hotkey/drawer-toggle.ts). */
  shellProgress(): ShellProgress {
    const id = this.manager.activeId;
    const kind = id ? this.manager.get(id)?.controller.state.kind : undefined;
    if (!kind) return "none";
    if (kind === "idle" || kind === "starting") return "starting";
    return kind === "running" ? "running" : "ended";
  }

  /** The reveal command and its hotkey work over the current view. */
  hotkeyEnabled(): boolean {
    return this.visibility().hotkey;
  }

  /**
   * The view the user is on, or the non-code setting, changed: show or take off the strip and drawer.
   * Nothing is closed or killed; the open state and every shell stay as they were.
   */
  applyVisibility(): void {
    const ui = this.ui;
    if (!ui) return;
    const v = this.visibility();
    ui.setHidden(!v.strip);
    if (v.drawer) this.reveal(); // back in view with no shell (the first reveal happened while hidden): make the first one
  }

  /** The reveal command, Ctrl+`, and the strip. Does nothing where the hotkey is off (the strip is off the page there). */
  toggle(): void {
    this.mount();
    if (!this.hotkeyEnabled()) return;
    this.ui?.toggle();
  }

  /** The + button: a new session, shown and focused. */
  newSession(): void {
    if (this.disposed || !this.ui) return;
    this.manager.create();
  }

  /** The trash button: end the active session, asking first when its shell is running. */
  killActive(): Promise<void> {
    const id = this.manager.activeId;
    return id ? this.killSession(id) : Promise.resolve();
  }

  async killSession(id: string): Promise<void> {
    await this.kills.request(id);
  }

  /** Obsidian switched between light and dark. */
  themeChanged(): void {
    this.ui?.refreshTheme();
  }

  /** The main pane area changed shape (a tab moved, a sidebar was collapsed): measure the drawer's bounds again. */
  layoutChanged(): void {
    this.layout?.refresh();
  }

  /** Stop every shell and take the drawer off the page. The kill signals go out before this returns. */
  dispose(): Promise<void> {
    this.disposed = true;
    if (this.saveTimer) this.flushSave();
    const done = this.manager.dispose();
    this.count.dispose();
    this.ui?.unmount();
    this.ui = null;
    this.layout?.dispose();
    this.layout = null;
    return done;
  }

  /** The drawer is showing: the first reveal makes one shell. Nothing starts while the strip and drawer are hidden. */
  private reveal(): void {
    if (this.disposed || !this.visibility().drawer) return;
    this.manager.ensureFirst();
  }

  private onSessionEvent(e: SessionEvent): void {
    const ui = this.ui;
    switch (e.type) {
      case "created":
        ui?.addSession(e.session.id, e.session.title);
        break;
      case "activated":
        ui?.setActive(e.id);
        break;
      case "removed":
        ui?.removeSession(e.id);
        break;
      case "output":
        ui?.write(e.id, e.data);
        break;
      case "count":
        this.count.update(e.count);
        break;
      case "empty":
        ui?.close(); // the last shell is gone: the drawer closes and the strip stays
        break;
      case "state":
        this.onShellState(e.id, e.state);
        break;
    }
  }

  private onShellState(id: string, s: ShellState): void {
    const ui = this.ui;
    if (!ui) return;
    if (s.kind === "starting") ui.showStarting(id);
    else if (s.kind === "running") {
      ui.clearMessage(id);
      const size = ui.terminalOf(id)?.size();
      if (size) this.manager.get(id)?.controller.resize(size.cols, size.rows);
      if (this.manager.activeId === id) ui.terminalOf(id)?.focus();
    } else if (s.kind === "exited") ui.showExited(id, s.code);
    else if (s.kind === "failed") ui.showError(id, s.message);
  }

  private storedHeight(id: string): number | undefined {
    const all = this.host.data()[DRAWER_KEY] as Record<string, { height?: unknown }> | undefined;
    const mine = all && typeof all === "object" && Object.prototype.hasOwnProperty.call(all, id) ? all[id] : undefined;
    return typeof mine?.height === "number" ? mine.height : undefined;
  }

  /**
   * Record the drawer state in the plugin data now and write data.json a moment later. Dragging the window edge
   * fires `resize` many times a second; each one that changes the clamped height lands here, so the write waits
   * until they stop (PR-6 R4). `dispose` writes at once what is still waiting.
   */
  private persist(state: DrawerState): void {
    if (!this.id) return;
    const data = this.host.data();
    Object.assign(data, withDrawerState(data, this.id, { height: clampHeight(state.height, this.host.window.innerHeight), open: state.open }));
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flushSave(), SAVE_DEBOUNCE_MS);
  }

  private flushSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.host.save().catch((e: unknown) => console.warn("VS Code Workbench: could not save the terminal drawer state:", e instanceof Error ? e.message : e));
  }
}
