/** The Code tab: one Obsidian tab hosting the VS Code web workbench for one file. */
import { ItemView, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { LicenceDeclinedError } from "./licence";
import { fileKey } from "./open-file";
import { buildFileUrl } from "./paths";
import type { RunningServer } from "./server";
import type { ServerState } from "./server-manager";
import { buildBrowserSeedScript, BROWSER_APP_SETTINGS, type UserDataCopy } from "./settings";

export const VIEW_TYPE_CODE = "vscode-workbench-code";

/**
 * `serve-web` answers with `X-Frame-Options: SAMEORIGIN` and
 * `frame-ancestors 'self'`, so a plain <iframe> inside Obsidian (origin
 * app://obsidian.md) is refused. A <webview> is its own top-level page and is
 * not subject to those headers. Both are kept switchable for the spike.
 */
export type EmbedElement = "webview" | "iframe";

/** What the view needs from the plugin. */
export interface CodeViewHost {
  vaultRoot(): string;
  embedElement(): EmbedElement;
  /** Start the server on demand (shared, one process). */
  ensureServer(): Promise<RunningServer>;
  trackView(view: CodeView): void;
  untrackView(view: CodeView): void;
  serverState(): ServerState;
  /** Notified on every server state change; returns the unsubscribe function. */
  onServerState(cb: (state: ServerState) => void): () => void;
  /** Restart the server (the banner's button). Resolves once it is running again; rejects if it cannot start. */
  restartServer(): Promise<void>;
  /** The copy of the chosen instance's settings and keybindings made at the last server start, or null. */
  userDataCopy(): UserDataCopy | null;
  /**
   * Called synchronously, before anything is awaited, when a tab is given a file. Claims the file for
   * `leaf` (one Code tab per file) and runs the binary and size guard. Resolves false when the tab must
   * not show the file: another tab already shows it (that tab has been focused), or the file was refused
   * and handed to the system app. The tab then closes itself.
   */
  admitFile(file: string, leaf: WorkspaceLeaf): Promise<boolean>;
  /** The tab no longer shows `file` (closed, or moved to another file): give its claim back. */
  releaseFile(file: string, leaf: WorkspaceLeaf): void;
  /** Hand a file to the system's default app (the licence was declined). */
  openInSystemApp(file: string): void;
}

/**
 * Reads whether the page holds an unsaved buffer. The VS Code web workbench puts
 * "●" in front of the window title when the active editor is dirty, and marks a
 * dirty editor tab with the class `dirty`. The result is `true` or `false`.
 */
export const DIRTY_SCRIPT = `(() => {
  if ((document.title || "").startsWith("\u25cf")) return true;
  return document.querySelector(".monaco-workbench .tab.dirty") !== null;
})()`;

/**
 * VS Code's default "Save All" key sequence, as Electron key events: Cmd+Alt+S on macOS, and the
 * chord Ctrl+K then S on Windows and Linux. Each entry is a key pressed and released.
 */
export function saveAllKeys(platform: string): Array<{ keyCode: string; modifiers: string[] }> {
  if (platform === "darwin") return [{ keyCode: "S", modifiers: ["meta", "alt"] }];
  return [
    { keyCode: "K", modifiers: ["control"] },
    { keyCode: "S", modifiers: [] },
  ];
}

export const CRASH_TEXT =
  "The VS Code server stopped unexpectedly. Restarting reloads this tab, and any unsaved changes in your open Code tabs are lost. Copy anything you need first.";
export const RESTART_FAILED_TEXT =
  "The VS Code server could not be restarted. Unsaved changes in this tab are lost if you reload it. Try Restart again, or use \"Restart server\" in the plugin settings.";

interface CodeViewState {
  file?: string;
  [key: string]: unknown;
}

/** The part of Electron's <webview> element the seeding step uses. */
interface WebviewLike extends HTMLElement {
  executeJavaScript?: (code: string) => Promise<unknown>;
  sendInputEvent?: (event: { type: string; keyCode?: string; modifiers?: string[] }) => unknown;
}

/**
 * Run `script` once in the page the webview has just loaded (same origin as the
 * workbench), then resolve. Best effort: a missing `dom-ready`, a rejected script
 * or the timeout all resolve, so the workbench still opens.
 */
export function runInWebview(el: WebviewLike, script: string, timeoutMs = 8000): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    el.addEventListener(
      "dom-ready",
      () => {
        if (typeof el.executeJavaScript !== "function") return finish();
        el.executeJavaScript(script).then(finish, finish);
      },
      { once: true },
    );
  });
}

export function baseName(file: string): string {
  return file.split("/").pop() || file;
}

export class CodeView extends ItemView {
  private file = "";
  private frame: HTMLElement | null = null;
  private banner: HTMLElement | null = null;
  private unsubscribe: (() => void) | null = null;
  /** The server died under this tab; the banner is up and the page may hold unsaved text. */
  private crashed = false;
  /** The server was stopped (idle, settings restart) or failed since this tab loaded. */
  private stale = false;
  private loading = false;
  /** setState has asked the host to admit the file and is waiting for the answer. */
  private admitting = false;
  private domReady = false;
  /** Counts loadWorkbench calls, so a restart can tell whether the "running" event already reloaded this tab. */
  private loadCount = 0;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly host: CodeViewHost,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_CODE;
  }

  getDisplayText(): string {
    return this.file ? baseName(this.file) : "VS Code";
  }

  getIcon(): string {
    return "code-2";
  }

  get filePath(): string {
    return this.file;
  }

  getState(): CodeViewState {
    // Only the vault-relative path is persisted. The token never goes into view state.
    return { file: this.file };
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const file = (state as CodeViewState | null)?.file;
    if (typeof file === "string" && file) {
      // Obsidian calls setState again on a tab that already shows the file (the file is clicked in the explorer,
      // or opened from a link or the quick switcher). Reloading would restart the workbench and could drop
      // unsaved text, so a tab that has the file loaded, or is loading it, is left alone. A crashed or stale
      // tab falls through and reloads, which is what brings it back.
      const alreadyShown =
        this.file !== "" && fileKey(file) === fileKey(this.file) && !this.crashed && !this.stale && (this.admitting || this.loading || this.frame !== null);
      if (!alreadyShown) {
        // The claim is taken before anything is awaited, so two tabs given the same file in one tick cannot both win.
        const admitting = this.host.admitFile(file, this.leaf);
        // Navigate-in-place: Obsidian can also hand this tab a different file (an explorer click while a Code tab
        // is active). The old file is released and the tab reloads with no unsaved-buffer check; PR-5's dirty
        // guard must cover this path too, not only close, idle stop and quit.
        if (this.file && fileKey(this.file) !== fileKey(file)) this.host.releaseFile(this.file, this.leaf);
        this.file = file;
        this.admitting = true;
        let admitted: boolean;
        try {
          admitted = await admitting;
        } finally {
          this.admitting = false;
        }
        if (!admitted) {
          this.file = "";
          this.leaf.detach();
          return;
        }
        (this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
        await this.loadWorkbench();
      }
    }
    await super.setState(state, result);
  }

  async onOpen(): Promise<void> {
    this.host.trackView(this);
    this.unsubscribe = this.host.onServerState((s) => this.onServerState(s));
    this.contentEl.addClass("vscode-workbench-view");
    this.contentEl.style.padding = "0";
    this.contentEl.style.position = "relative";
    this.contentEl.style.overflow = "hidden";
  }

  async onClose(): Promise<void> {
    if (this.file) this.host.releaseFile(this.file, this.leaf);
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.host.untrackView(this);
    this.frame?.remove();
    this.frame = null;
  }

  /** True when this tab is on screen (not a background tab). */
  isVisible(): boolean {
    return (this.contentEl as { isShown?: () => boolean }).isShown?.() ?? false;
  }

  /** Call when tab visibility may have changed: a tab left behind by an idle stop wakes the server when shown. */
  notifyVisible(): void {
    if (this.stale && !this.crashed && !this.loading && this.isVisible()) void this.loadWorkbench();
  }

  private onServerState(state: ServerState): void {
    if (this.loading) return;
    switch (state) {
      case "crashed":
        if (this.frame) {
          this.crashed = true;
          this.showBanner(CRASH_TEXT);
        }
        break;
      case "stopped":
      case "stopped-by-idle":
        if (this.frame && !this.crashed) this.stale = true;
        break;
      case "failed":
        // A start failed (a settings restart, say) and this tab still shows the page of the server that
        // was stopped for it: no tab is left on a dead embed (G14). A tab with the crash banner stays,
        // because its page may hold text to copy and the banner's Restart can try again.
        if (this.frame && !this.crashed) this.closeDeadTab();
        break;
      case "running":
        // A restart (banner button or settings): reload this tab onto the new port and token.
        if (this.crashed || (this.stale && this.isVisible())) void this.loadWorkbench();
        break;
      default:
        break;
    }
  }

  /** Close this tab: its server is gone and could not be brought back. The reason is already in a Notice. */
  private closeDeadTab(): void {
    this.frame?.remove();
    this.frame = null;
    this.stale = false;
    this.leaf.detach();
  }

  /** Reload the embedded workbench (used after a theme change). */
  reload(): void {
    const f = this.frame as (HTMLElement & { reload?: () => void }) | null;
    if (!f) return;
    if (typeof f.reload === "function") f.reload();
    else void this.loadWorkbench();
  }

  // --- unsaved buffers ------------------------------------------------------

  /**
   * Whether the workbench in this tab holds an unsaved buffer. When the page
   * cannot be asked (it has loaded but the script fails) the answer is "yes":
   * an unsaved buffer must never be discarded on a guess.
   */
  async isDirty(): Promise<boolean> {
    const f = this.frame as WebviewLike | null;
    if (!f || typeof f.executeJavaScript !== "function") return false; // nothing loaded, or an iframe (cannot be read)
    if (!this.domReady) return false;
    try {
      return (await f.executeJavaScript(DIRTY_SCRIPT)) === true;
    } catch {
      return true;
    }
  }

  /**
   * Press the workbench's "Save All" shortcut and wait until no editor in the tab is dirty. True if
   * everything saved. Save All, not Save: Save only reaches the active editor, and any other dirty
   * editor would stay dirty. An untitled editor opens a Save As box that nothing here can answer, so
   * it stays dirty and this returns false; the caller asks the user what to do next.
   */
  async saveBuffers(timeoutMs = 5000): Promise<boolean> {
    const f = this.frame as WebviewLike | null;
    if (!f || typeof f.sendInputEvent !== "function") return !(await this.isDirty());
    (f as HTMLElement).focus?.();
    // The workbench's own auto-save setting is left alone.
    const platform = typeof process !== "undefined" ? process.platform : "linux";
    for (const { keyCode, modifiers } of saveAllKeys(platform)) {
      await f.sendInputEvent({ type: "keyDown", keyCode, modifiers });
      await f.sendInputEvent({ type: "keyUp", keyCode, modifiers });
      await new Promise((r) => setTimeout(r, 50)); // a chord's second key must arrive after the first
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!(await this.isDirty())) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    return !(await this.isDirty());
  }

  // --- loading ----------------------------------------------------------------

  private showBanner(text: string): void {
    this.banner?.remove();
    const banner = this.contentEl.createDiv({ cls: "vscode-workbench-banner", text: "" }) as HTMLElement;
    banner.style.position = "absolute";
    banner.style.top = "0";
    banner.style.left = "0";
    banner.style.right = "0";
    banner.style.zIndex = "10";
    banner.style.padding = "8px 12px";
    banner.style.background = "var(--background-modifier-error, #a33)";
    banner.style.color = "var(--text-on-accent, #fff)";
    banner.createEl("span", { text });
    const button = banner.createEl("button", { text: "Restart", cls: "mod-cta" });
    button.style.marginLeft = "12px";
    button.addEventListener("click", () => void this.restartFromBanner());
    this.banner = banner;
    // The banner floats over the (dead) page, which stays visible so unsaved text can be copied.
  }

  private async restartFromBanner(): Promise<void> {
    const loadsBefore = this.loadCount;
    try {
      await this.host.restartServer();
    } catch {
      // The failure notice has been shown; keep the banner so Restart can be pressed again.
      if (!this.loading) this.showBanner(RESTART_FAILED_TEXT);
      return;
    }
    // Normally the "running" event has already reloaded this tab (successfully or not); this covers a
    // server that was already running again, when no event reached this tab.
    if (this.loadCount === loadsBefore && !this.loading && (this.crashed || this.stale)) await this.loadWorkbench();
  }

  private async loadWorkbench(): Promise<void> {
    // Only a tab that showed the crash banner keeps its place when the reload fails; any other tab is closed.
    const keepForRestart = this.crashed;
    this.loadCount++;
    this.loading = true;
    this.crashed = false;
    this.stale = false;
    this.domReady = false;
    this.contentEl.empty();
    this.frame = null;
    this.banner = null;
    try {
      const server = await this.host.ensureServer();
      const url = buildFileUrl(server.baseUrl, this.host.vaultRoot(), this.file, server.token);
      const el = document.createElement(this.host.embedElement());
      const isWebview = this.host.embedElement() === "webview";
      if (isWebview) {
        el.setAttribute("partition", "persist:vscode-workbench");
        el.setAttribute("allowpopups", "");
        el.addEventListener("dom-ready", () => {
          if (this.frame === el) this.domReady = true;
        });
      }
      el.style.width = "100%";
      el.style.height = "100%";
      el.style.border = "0";
      // The application-scoped off switches (extension updates, experiments,
      // telemetry) and the user's settings and keybindings (copied from the chosen
      // instance, G17) are only read from the browser profile, so a webview first
      // loads the server's origin (no workbench), has them written into that
      // profile, and only then navigates to the workbench.
      el.setAttribute("src", isWebview ? `${server.baseUrl}/` : url);
      this.contentEl.appendChild(el);
      this.frame = el;
      if (isWebview) {
        await runInWebview(el as WebviewLike, buildBrowserSeedScript(BROWSER_APP_SETTINGS, this.host.userDataCopy()));
        if (this.frame === el) el.setAttribute("src", url);
      }
    } catch (e) {
      // A declined licence opens the file in the system app, as the explicit open does (a tab Obsidian
      // opened itself, from the explorer or a link, comes this way).
      if (e instanceof LicenceDeclinedError) this.host.openInSystemApp(this.file);
      // main.ts has already shown the (token-free) reason. A tab is closed rather than left blank; only a
      // tab that was showing the crash banner (its page may hold text to copy) keeps its place and offers Restart.
      this.frame = null;
      this.contentEl.empty();
      if (keepForRestart) {
        this.crashed = true;
        this.showBanner(RESTART_FAILED_TEXT);
      } else {
        this.leaf.detach();
      }
    } finally {
      this.loading = false;
    }
  }
}
