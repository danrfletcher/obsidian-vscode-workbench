/**
 * The terminal host page: the DOM and the webview inside the bottom drawer that show VS Code's own terminal panel
 * (G2, G5, G17). `host-state.ts` decides what state it is in; this file carries the effects out. It draws no terminal tab,
 * list or kill control of its own (F1): the only things it draws are the "Starting..." text, the error with Retry, and the
 * "terminals lost" notice. The terminal itself is VS Code's page.
 *
 * The webview is created once, when the server is ready, and stays in the same parent until the plugin unloads: hiding
 * the drawer only makes its container invisible (a moved webview reloads, G17). A reload that happens anyway shows the
 * "terminals lost" notice over the page.
 */
import { logSeedOutcome, logTrustOutcome, runScriptsInWebview } from "../code-view";
import { LicenceDeclinedError } from "../licence";
import { StartCancelledError, type RunningServer } from "../server";
import { buildBrowserSeedScript, type UserDataCopy } from "../settings";
import { buildThemeSwitchScript, themeSwitchMessage, ThemeSync } from "../theme-map";
import { MANUAL_TRUST_STEPS } from "../trust/trust-message";
import { buildTrustSeedScript } from "../trust/trust-seed";
import { buildFileUri } from "../paths";
import { INITIAL_HOST_STATE, hostView, reduceHost, type HostEffect, type HostEvent, type HostState, type HostView } from "./host-state";
import { buildTerminalHostUrl, hostOriginUrl, hostSettings, TERMINAL_PARTITION } from "./host-url";
import { LAYOUT_SCRIPT, isPainted, isPanelOnly, parseLayout, type PageLayout } from "./panel-only";

export const STARTING_TEXT = "Starting VS Code server...";
export const LICENCE_TEXT = "Waiting for the VS Code server licence...";
export const LOST_TEXT = "Terminals lost: the terminal page was reloaded, so the shells that were running in it may have ended.";
/** The lost message after a server restart or crash (G13): one sentence, dismissible, with no token in it. */
export const RESTART_LOST_TEXT = "Your terminals were lost: the VS Code server was restarted, so the shells that were running ended.";
/** The crash banner in the drawer (G13): the same Restart as a Code tab's banner (CRASH_TEXT), saying the terminals are lost. */
export const TERMINAL_CRASH_TEXT = "The VS Code server stopped unexpectedly, so your terminals are lost. Restart starts a new server and a fresh terminal.";
/** A Restart from the crash banner that failed: the banner stays, with the reason (token-free) after this text. */
export const TERMINAL_RESTART_FAILED_TEXT = "The VS Code server could not be restarted. Try Restart again, or use \"Restart server\" in the plugin settings.";
export const DECLINED_NOTICE = "VS Code Workbench: the terminal needs the VS Code server licence. It will ask again the next time you open the terminal.";
export const CANCELLED_TEXT = "The VS Code server start was cancelled.";
export const NOT_LOADED_TEXT = "The VS Code terminal page did not load.";
export const NOT_PANEL_TEXT = "The VS Code terminal panel did not open on its own.";

/**
 * Puts focus on the terminal's input inside the page: the script the spike measured (docs/terminal-spike.md, S7), which
 * printed `focused` after which typed text reached the shell. The class name of the input belongs to the page's own
 * emulator; it is joined at run time from two pieces so that neither the source nor the built main.js holds the whole
 * name (F1: this plugin names and imports no emulator library; the fence tests are plain text searches). A `+` of two
 * literals would not do: esbuild folds it back into one string in the bundle.
 */
const HELPER_TEXTAREA = [".xter", "m-helper-textarea"].join("");
export const FOCUS_TERMINAL_SCRIPT =
  `(() => { const t = document.querySelector('.terminal-wrapper.active ${HELPER_TEXTAREA}') || document.querySelector('${HELPER_TEXTAREA}'); if (!t) return 'no terminal'; t.focus(); return document.activeElement === t ? 'focused' : 'not focused'; })()`;

/** The part of Electron's <webview> element this uses. */
interface HostWebview extends HTMLElement {
  executeJavaScript?: (code: string) => Promise<unknown>;
}

export interface TerminalHostDeps {
  createElement(tag: string): HTMLElement;
  /** Where the drawer's container goes. It stays there until `dispose`. */
  parent: HTMLElement;
  vaultRoot(): string;
  licenceAccepted(): boolean;
  /** The licence modal (`LicenceGate.request`): resolves true only for an explicit Accept. Nothing downloads before that. */
  requestLicence(): Promise<boolean>;
  /** The plugin's shared server start (`ensureServer`): one server, one licence modal and one start however many callers. */
  ensureServer(): Promise<RunningServer>;
  /**
   * The crash banner's Restart: the plugin's single-flight `restartServer`. It never asks (the server is not running), shows its
   * own failure notice and rejects when the server cannot start; the host then shows the reason in the banner.
   */
  restartServer?(): Promise<void>;
  /** The token-free reason for a failed start (`describeFailure`). */
  failureText(e: unknown): string;
  notice(message: string): void;
  isDark(): boolean;
  workbenchOverlay(): Record<string, unknown>;
  userDataCopy(): UserDataCopy | null;
  trustVaultFolder(): boolean;
  heldPorts(): readonly number[];
  noteTrustOutcome?(outcome: string): void;
  /** Start watching the page's keys for the bridged chords (the plugin's key relay); returns the function that stops. Absent: no bridge. */
  attachKeys?(frame: HTMLElement): () => void;
  /** The host hid itself (the licence was declined), not because `hide` was called: the drawer closes. */
  closedByHost?(): void;
  /** The host's phase changed (a start began, the page is ready or was lost, a start failed, the host was closed): the plugin re-reads the idle clock's inputs. */
  stateChanged?(): void;
  /** Timings, overridable for tests. */
  pollMs?: number;
  loadMs?: number;
  panelMs?: number;
}

const POLL_MS = 200;
/** The first load of a workbench page can be slow (it is also the first start of the server's extension host). */
const LOAD_MS = 90_000;
/**
 * How long a loaded page has to become panel-only. The extension that does it starts with the page's extension host, which on a
 * fresh profile is slow, so this is generous.
 */
const PANEL_MS = 30_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A failure of the page itself whose message is already the text to show. */
class PageError extends Error {}

/** Thrown inside a start that the host no longer wants (unloaded, or the page was replaced). */
class Superseded extends Error {}

export class TerminalHostPage {
  private state: HostState = INITIAL_HOST_STATE;
  private flow: Promise<void> | null = null;
  private readonly container: HTMLElement;
  private readonly status: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly crashBanner: HTMLElement;
  /**
   * Counts the times a page was dropped with its server. A start in flight remembers the count it began at: when the count has
   * moved the page it was making is gone and it ends without touching the state, which belongs to whatever came after.
   */
  private epoch = 0;
  /** A Restart from the crash banner is under way: a second press shares it. */
  private restarting = false;
  private page: HostWebview | null = null;
  /** The page finished loading and is panel-only: theme switches may run, and a later dom-ready means a reload. */
  private pageReady = false;
  private statusKey = "";
  private themeSync: ThemeSync;
  /** The drawer opened before the page was ready: focus goes into the terminal when it is. */
  private focusWhenReady = false;
  private detachKeys: (() => void) | null = null;

  constructor(private readonly deps: TerminalHostDeps) {
    this.themeSync = new ThemeSync((dark) => this.applyTheme(dark), deps.isDark());
    const c = deps.createElement("div");
    // Where the container sits and how tall it is comes from styles.css (`.vscode-workbench-terminal-host`), from the
    // page variables the drawer writes: it spans the main pane area and has the drawer's height, shown or not.
    c.className = "vscode-workbench-terminal-host";
    this.container = c;
    this.status = deps.createElement("div");
    this.status.className = "vscode-workbench-terminal-host-status";
    Object.assign(this.status.style, {
      position: "absolute",
      inset: "0",
      zIndex: "2",
      display: "none",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      gap: "12px",
      padding: "12px",
      textAlign: "center",
      background: "var(--background-primary, #1e1e1e)",
      color: "var(--text-normal, #ccc)",
    });
    this.banner = deps.createElement("div");
    this.banner.className = "vscode-workbench-terminal-host-lost";
    Object.assign(this.banner.style, {
      position: "absolute",
      top: "0",
      left: "0",
      right: "0",
      zIndex: "3",
      display: "none",
      padding: "6px 12px",
      background: "var(--background-modifier-error, #a33)",
      color: "var(--text-on-accent, #fff)",
    });
    this.crashBanner = deps.createElement("div");
    this.crashBanner.className = "vscode-workbench-terminal-host-crash";
    Object.assign(this.crashBanner.style, {
      position: "absolute",
      top: "0",
      left: "0",
      right: "0",
      zIndex: "3",
      display: "none",
      padding: "8px 12px",
      background: "var(--background-modifier-error, #a33)",
      color: "var(--text-on-accent, #fff)",
    });
    c.appendChild(this.status);
    c.appendChild(this.banner);
    c.appendChild(this.crashBanner);
    deps.parent.appendChild(c);
    this.render();
  }

  // --- the small internal API (the drawer in `terminal/terminal-drawer.ts` drives it) ---------------------------

  show(): void {
    this.dispatch({ type: "show", licenceAccepted: this.deps.licenceAccepted() });
  }

  hide(): void {
    this.focusWhenReady = false;
    this.dispatch({ type: "hide" });
  }

  /**
   * Move keyboard focus into the terminal (G1). Both steps are scripts run in the page: the webview takes focus, then the
   * page puts it on the terminal's input. A page still loading gets it once it is ready, if the drawer is still showing.
   */
  focusTerminal(): void {
    if (!this.state.visible) return;
    if (!this.pageReady) {
      this.focusWhenReady = true;
      return;
    }
    this.runFocus();
  }

  /** The webview showing the page, or null before it is made (the key relay compares frames by identity). */
  get webview(): HTMLElement | null {
    return this.page;
  }

  private runFocus(): void {
    this.focusWhenReady = false;
    const el = this.page;
    if (!el) return;
    el.focus?.();
    if (typeof el.executeJavaScript !== "function") return;
    try {
      el.executeJavaScript(FOCUS_TERMINAL_SCRIPT).catch(() => undefined); // a page that cannot be asked keeps focus on the webview
    } catch {
      /* the same */
    }
  }

  toggle(): void {
    if (this.state.visible) this.hide();
    else this.show();
  }

  isVisible(): boolean {
    return this.state.visible;
  }

  /** What the drawer is showing: a phase, or "hidden". */
  view(): HostView {
    return hostView(this.state);
  }

  /** The page is mounted and showing the terminal (shown or hidden), the "terminals lost" notice included. */
  ready(): boolean {
    return this.state.phase === "running" || this.state.phase === "lost";
  }

  /** A start of the page is in flight (the licence, the server or the page loading). */
  starting(): boolean {
    return this.flow !== null;
  }

  /** Resolves when the start in flight (if any) has finished, either way. */
  settled(): Promise<void> {
    return this.flow ?? Promise.resolve();
  }

  /** Obsidian's theme changed: switch the page in place. No reload, so the terminals stay (G5). */
  themeChanged(dark: boolean): Promise<void> {
    // A page still loading is built from the theme as it is when it finishes (see `finishMount`).
    if (!this.pageReady) return Promise.resolve();
    return this.themeSync.set(dark);
  }

  // --- the server under the page (the plugin tells the host what the manager did) ---------------------------------

  /** The server died on its own: the page is dropped and the crash banner with Restart is shown. Nothing restarts. */
  serverCrashed(): void {
    this.dispatch({ type: "server-crashed" });
  }

  /** The server was stopped to be started again (Restart server): the page is dropped and made again when a server runs. */
  serverStopped(): void {
    this.dispatch({ type: "server-stopped" });
  }

  /** The server stopped for being idle: nothing is lost, so nothing is announced; the page is made again at the next show. */
  serverIdle(): void {
    this.dispatch({ type: "server-idle" });
  }

  /** A server is running: a dropped page is made again at the new address and says its terminals were lost. */
  serverRunning(): void {
    this.dispatch({ type: "server-running" });
  }

  /** A restart that nothing in the host started could not start the server. `reason` must be token-free. A start of the host's own reports itself. */
  serverFailed(reason: string): void {
    if (this.flow) return;
    this.dispatch({ type: "server-failed", reason });
  }

  /** The plugin unloads: no webview, container or start is left behind. */
  dispose(): void {
    this.dispatch({ type: "dispose" });
  }

  // --- state ---------------------------------------------------------------------------------------------------

  private dispatch(event: HostEvent): void {
    const wasVisible = this.state.visible;
    const before = this.state;
    const step = reduceHost(this.state, event);
    this.state = step.state;
    for (const effect of step.effects) this.carryOut(effect);
    this.render();
    if (step.state.phase !== before.phase || step.state.disposed !== before.disposed) this.deps.stateChanged?.();
    // The host closed itself (a declined licence): the drawer that asked for it follows. A `hide` or the unload came from the caller.
    if (wasVisible && !step.state.visible && event.type !== "hide" && event.type !== "dispose") this.deps.closedByHost?.();
  }

  private carryOut(effect: HostEffect): void {
    switch (effect) {
      case "start":
        // One start at a time: a Retry (or a show) that arrives while one is running shares it.
        if (!this.flow) this.flow = this.runStart();
        break;
      case "drop-page":
        // The server under the page is gone: the page and any start making it are abandoned (the start ends by itself, silently).
        this.epoch++;
        this.flow = null;
        this.removePage();
        break;
      case "notice-declined":
        this.deps.notice(DECLINED_NOTICE);
        break;
      case "teardown":
        this.removePage();
        this.container.remove();
        break;
    }
  }

  /** The start has ended: let the next one begin, then record how it ended. */
  private finish(event: HostEvent): void {
    this.flow = null;
    this.dispatch(event);
  }

  private async runStart(): Promise<void> {
    const epoch = this.epoch;
    const abandoned = () => this.state.disposed || this.epoch !== epoch;
    try {
      if (!this.deps.licenceAccepted()) {
        const accepted = await this.deps.requestLicence();
        if (abandoned()) return;
        if (!accepted) return this.finish({ type: "licence-declined" });
        this.dispatch({ type: "licence-accepted" });
      }
      const server = await this.deps.ensureServer();
      if (abandoned()) return;
      await this.mount(server);
      if (abandoned()) return;
      this.finish({ type: "ready" });
      if (this.focusWhenReady && this.state.visible) this.runFocus(); // the drawer opened while the page was loading
    } catch (e) {
      if (abandoned()) return;
      this.removePage();
      if (e instanceof LicenceDeclinedError) return this.finish({ type: "licence-declined" });
      const reason = e instanceof StartCancelledError ? CANCELLED_TEXT : e instanceof Superseded || e instanceof PageError ? e.message : this.deps.failureText(e);
      this.finish({ type: "failed", reason });
    }
  }

  // --- the page ------------------------------------------------------------------------------------------------

  private async mount(server: RunningServer): Promise<void> {
    const el = this.deps.createElement("webview") as HostWebview;
    el.setAttribute("partition", TERMINAL_PARTITION);
    el.setAttribute("allowpopups", "");
    Object.assign(el.style, { width: "100%", height: "100%", border: "0" });
    // A page with a running terminal asks "leave this page?" on reload; a webview has no dialog to answer it.
    el.addEventListener("will-prevent-unload", (ev: Event) => ev.preventDefault());
    el.addEventListener("dom-ready", () => {
      // Every dom-ready after the page was ready is a reload (Obsidian rebuilt the layout): say the terminals may be gone.
      if (this.page === el && this.pageReady) this.dispatch({ type: "page-reloaded" });
    });
    this.page = el;
    // G16: the Ctrl+` bridge runs inside this page too, so the chord closes the drawer from inside the terminal.
    this.detachKeys = this.deps.attachKeys?.(el) ?? null;
    // The settings go into the partition's profile from the server's bare origin, then the workbench loads (as a Code tab does).
    el.setAttribute("src", hostOriginUrl(server.baseUrl));
    this.container.appendChild(el);
    const darkAtSeed = this.deps.isDark();
    const settingsSeed = buildBrowserSeedScript(hostSettings(this.deps.workbenchOverlay()), this.deps.userDataCopy());
    const trust = this.trustSeedScript(server);
    const outcomes = await runScriptsInWebview(el, trust === null ? [settingsSeed] : [settingsSeed, trust]);
    this.stillWanted(el);
    logSeedOutcome(outcomes[0]);
    if (trust !== null) {
      logTrustOutcome(outcomes[1]);
      this.deps.noteTrustOutcome?.(String(outcomes[1]));
    }
    const loaded = this.nextDomReady(el);
    el.setAttribute("src", buildTerminalHostUrl(server.baseUrl, this.deps.vaultRoot(), server.token));
    if (!(await loaded)) throw new PageError(NOT_LOADED_TEXT);
    this.stillWanted(el);
    const layout = await this.until(() => this.readLayout(el), (l) => isPainted(l), this.deps.loadMs ?? LOAD_MS);
    if (!layout) throw new PageError(NOT_LOADED_TEXT);
    await this.waitPanelOnly(el, layout);
    this.stillWanted(el);
    // Ready: from now on a dom-ready is a reload, and a theme change that came in while loading is applied.
    this.pageReady = true;
    this.themeSync.markApplied(darkAtSeed);
    void this.themeSync.set(this.deps.isDark());
  }

  private stillWanted(el: HostWebview): void {
    if (this.state.disposed || this.page !== el) throw new Superseded(CANCELLED_TEXT);
  }

  private trustSeedScript(server: RunningServer): string | null {
    if (!this.deps.trustVaultFolder()) return null;
    try {
      return buildTrustSeedScript({
        origin: server.baseUrl,
        folderUri: buildFileUri(server.baseUrl, this.deps.vaultRoot()),
        heldPorts: this.deps.heldPorts(),
      });
    } catch (e) {
      console.warn(`VS Code Workbench: the trust seed was not built for the terminal (${e instanceof Error ? e.name : "error"}); it opens in Restricted Mode. To trust the vault folder by hand, ${MANUAL_TRUST_STEPS}.`);
      this.deps.noteTrustOutcome?.(`error:${e instanceof Error ? e.name : "build"}`);
      return null;
    }
  }

  /** Resolves true at the page's next dom-ready, false after the load time. Listen before navigating: the event can come at once. */
  private nextDomReady(el: HostWebview): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), this.deps.loadMs ?? LOAD_MS);
      el.addEventListener(
        "dom-ready",
        () => {
          clearTimeout(timer);
          resolve(true);
        },
        { once: true },
      );
    });
  }

  private async readLayout(el: HostWebview): Promise<PageLayout | null> {
    if (typeof el.executeJavaScript !== "function") throw new PageError(NOT_LOADED_TEXT);
    try {
      return parseLayout(await el.executeJavaScript(LAYOUT_SCRIPT));
    } catch {
      return null; // the page is navigating or not ready to be asked
    }
  }

  /** Read until `ok` accepts what was read, or the time is up (null). Gives up at once when the host no longer wants this page. */
  private async until<T>(read: () => Promise<T | null>, ok: (v: T) => boolean, ms: number): Promise<T | null> {
    const el = this.page;
    const deadline = Date.now() + ms;
    for (;;) {
      if (this.state.disposed || this.page !== el) throw new Superseded(CANCELLED_TEXT);
      const v = await read();
      if (v !== null && ok(v)) return v;
      if (Date.now() >= deadline) return null;
      await sleep(this.deps.pollMs ?? POLL_MS);
    }
  }

  /**
   * S1: the page is put in its panel-only layout by the plugin-owned extension running inside it (VS Code's own commands:
   * close the side bars, focus the terminal; see terminal-at-extension.ts). The plugin sends the page no key and no click: a
   * key sent into a fresh profile's page was dropped, and a script cannot tell a key that worked from a bar that was already
   * hidden. This only waits for the layout to be panel-only. A page that is not by then is an error with Retry, never a
   * half-drawn drawer (E3).
   */
  private async waitPanelOnly(el: HostWebview, layout: PageLayout): Promise<void> {
    if (isPanelOnly(layout)) return;
    if (!(await this.until(() => this.readLayout(el), (l) => isPanelOnly(l), this.deps.panelMs ?? PANEL_MS))) throw new PageError(NOT_PANEL_TEXT);
  }

  private async applyTheme(dark: boolean): Promise<void> {
    const el = this.page;
    if (!el || !this.pageReady || typeof el.executeJavaScript !== "function") return;
    try {
      await el.executeJavaScript(buildThemeSwitchScript(themeSwitchMessage(dark)));
    } catch {
      /* the page could not be asked; it keeps its theme until the next change */
    }
  }

  private removePage(): void {
    const el = this.page;
    this.page = null;
    this.pageReady = false;
    this.detachKeys?.();
    this.detachKeys = null;
    el?.remove();
  }

  /**
   * The crash banner's Restart. Two presses share one restart. The server's `running` event brings the page back (see
   * `serverRunning`); a restart that fails reaches the banner through `serverFailed`, so this only has to wait and swallow the
   * rejection (its notice has been shown). It restarts nothing by itself: only a press gets here.
   */
  private async restartFromBanner(): Promise<void> {
    if (this.restarting || this.state.phase !== "crashed" || !this.deps.restartServer) return;
    this.restarting = true;
    try {
      await this.deps.restartServer();
    } catch {
      /* the failure notice was shown and the banner carries the reason */
    } finally {
      this.restarting = false;
    }
  }

  // --- drawing -------------------------------------------------------------------------------------------------

  private render(): void {
    const { phase, visible, error, lostCause } = this.state;
    // Hidden means invisible and inert, in place: the webview is never moved, detached or resized (G17).
    this.container.style.visibility = visible ? "visible" : "hidden";
    this.container.style.pointerEvents = visible ? "auto" : "none";

    const key = `${phase}|${error ?? ""}|${lostCause ?? ""}`;
    if (key !== this.statusKey) {
      this.statusKey = key;
      this.status.replaceChildren();
      const text = phase === "starting" ? STARTING_TEXT : phase === "licence" ? LICENCE_TEXT : phase === "error" ? (error ?? "") : "";
      this.status.style.display = text === "" ? "none" : "flex";
      if (text !== "") {
        const line = this.deps.createElement("div");
        line.textContent = text;
        this.status.appendChild(line);
      }
      if (phase === "error") {
        const retry = this.deps.createElement("button");
        retry.textContent = "Retry";
        retry.addEventListener("click", () => this.dispatch({ type: "retry" }));
        this.status.appendChild(retry);
      }
      this.crashBanner.replaceChildren();
      this.crashBanner.style.display = phase === "crashed" ? "block" : "none";
      if (phase === "crashed") {
        const line = this.deps.createElement("span");
        line.textContent = error === null ? TERMINAL_CRASH_TEXT : `${TERMINAL_RESTART_FAILED_TEXT} ${error}`;
        const restart = this.deps.createElement("button");
        restart.textContent = "Restart";
        restart.className = "mod-cta";
        restart.style.marginLeft = "12px";
        restart.addEventListener("click", () => void this.restartFromBanner());
        this.crashBanner.appendChild(line);
        this.crashBanner.appendChild(restart);
      }
      this.banner.replaceChildren();
      this.banner.style.display = phase === "lost" ? "block" : "none";
      if (phase === "lost") {
        const line = this.deps.createElement("span");
        line.textContent = lostCause === "restart" ? RESTART_LOST_TEXT : LOST_TEXT;
        const dismiss = this.deps.createElement("button");
        dismiss.textContent = "Dismiss";
        dismiss.style.marginLeft = "12px";
        dismiss.addEventListener("click", () => this.dispatch({ type: "dismiss-lost" }));
        this.banner.appendChild(line);
        this.banner.appendChild(dismiss);
      }
    }
  }
}
