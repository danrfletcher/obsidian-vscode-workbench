/**
 * The terminal drawer as the plugin uses it: the drawer UI, the one shell and the
 * per-device state in `data.json`, wired together. main.ts creates this, calls
 * `mount()` once the workspace is ready and `dispose()` on unload.
 *
 * Nothing here touches the network: the shell is reached through the helper's pipes only.
 */
import type { ChildRegistry } from "../child-registry";
import { DrawerUI, type TerminalView } from "./drawer-ui";
import { clampHeight } from "./drawer-geometry";
import { DRAWER_KEY, deviceId, readDrawerState, withDrawerState, type DeviceIdStore, type DrawerState } from "./drawer-state";
import { installHelper } from "./helper-source";
import { preflight as realPreflight, type PreflightResult } from "./pty-preflight";
import { PtySession, realSessionDeps, type SessionDeps, type SessionOptions } from "./pty-session";
import { ShellStartDir } from "./shell-cwd";
import { ShellController } from "./terminal-controller";
import { createXtermView } from "./xterm-view";

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
}

/** Replacements for the real xterm, preflight and process spawn (tests only). */
export interface TerminalOverrides {
  createTerminal?: (host: HTMLElement) => TerminalView;
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

export class TerminalFeature {
  private ui: DrawerUI | null = null;
  private readonly controller: ShellController;
  private id: string | null = null;
  private disposed = false;

  constructor(
    private readonly host: TerminalHost,
    private readonly overrides: TerminalOverrides = {},
  ) {
    const sessionDeps: SessionDeps = { ...realSessionDeps, ...overrides.session, registry: host.registry };
    this.controller = new ShellController({
      shell: () => host.shell(),
      preflight: overrides.preflight ?? ((shell) => realPreflight(shell)),
      installHelper: () => installHelper(host.runtimeDir()),
      startDir: new ShellStartDir(() => host.vaultRoot(), () => host.activeFile()),
      size: () => this.ui?.terminal?.size() ?? { cols: 80, rows: 24 },
      env: () => shellEnv(overrides.baseEnv ?? process.env),
      createSession: (opts: SessionOptions) => new PtySession(opts, sessionDeps),
    });
    this.controller.onOutput((data) => this.ui?.write(data));
    this.controller.onState((s) => {
      const ui = this.ui;
      if (!ui) return;
      if (s.kind === "starting") ui.showStarting();
      else if (s.kind === "running") {
        ui.clearMessage();
        const size = ui.terminal?.size();
        if (size) this.controller.resize(size.cols, size.rows);
        ui.terminal?.focus();
      } else if (s.kind === "exited") ui.showExited(s.code);
      else if (s.kind === "failed") ui.showError(s.message);
    });
  }

  get drawer(): DrawerUI | null {
    return this.ui;
  }

  get shells(): ShellController {
    return this.controller;
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
    const ui = new DrawerUI({
      document: doc,
      window: this.host.window,
      initial,
      onChange: (state) => this.persist(state),
      onReveal: () => void this.controller.ensure(),
      onRestart: () => void this.controller.restart(),
      createTerminal: this.overrides.createTerminal ?? createXtermView,
    });
    ui.onInput((data) => this.controller.write(data));
    ui.onTerminalResize((cols, rows) => this.controller.resize(cols, rows));
    this.ui = ui;
    // A saved height taller than this window is corrected in the file as well as on screen (E14).
    if (this.storedHeight(id) !== undefined && this.storedHeight(id) !== initial.height) this.persist(initial);
    ui.mount(doc.body);
  }

  toggle(): void {
    this.mount();
    this.ui?.toggle();
  }

  /** Obsidian switched between light and dark. */
  themeChanged(): void {
    this.ui?.refreshTheme();
  }

  /** Stop the shell and take the drawer off the page. The kill signals go out before this returns. */
  dispose(): Promise<void> {
    this.disposed = true;
    const done = this.controller.dispose();
    this.ui?.unmount();
    this.ui = null;
    return done;
  }

  private storedHeight(id: string): number | undefined {
    const all = this.host.data()[DRAWER_KEY] as Record<string, { height?: unknown }> | undefined;
    const mine = all && typeof all === "object" && Object.prototype.hasOwnProperty.call(all, id) ? all[id] : undefined;
    return typeof mine?.height === "number" ? mine.height : undefined;
  }

  private persist(state: DrawerState): void {
    if (!this.id) return;
    const data = this.host.data();
    Object.assign(data, withDrawerState(data, this.id, { height: clampHeight(state.height, this.host.window.innerHeight), open: state.open }));
    this.host.save().catch((e: unknown) => console.warn("VS Code Workbench: could not save the terminal drawer state:", e instanceof Error ? e.message : e));
  }
}
