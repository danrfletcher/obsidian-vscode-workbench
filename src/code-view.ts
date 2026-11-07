/** The Code tab: one Obsidian tab hosting the VS Code web workbench for one file. */
import { ItemView, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import type { KeybindingEntry } from "./chrome-settings";
import { CHROME_SCRIPT_INSTALLED } from "./chrome-script";
import { DIRTY_SCRIPT } from "./dirty-script";
import { decide, resolveChoice, SETTLE_MS, SETTLE_POLL_MS, type AutoSave, type BufferState } from "./dirty-guard";
import { LicenceDeclinedError } from "./licence";
import type { CloseDirtyRequest } from "./modals";
import { buildGoToLineScript, GO_TO_LINE_DONE, GO_TO_LINE_TOTAL_MS } from "./goto-line-script";
import { fileKey } from "./open-file";
import { buildOpenInterceptScript, isOtherEditorReport, OPEN_INTERCEPT_INSTALLED, parseOpenReport, RESTORE_OPEN_SCRIPT, RESTORE_SWITCHED, type OpenReport } from "./open-intercept-script";
import { renderPathBreadcrumbs, type BreadcrumbParent } from "./path-breadcrumbs";
import { authorityOf, buildFileUri, buildFileUrl, normalizeLine, targetOfUri, type EditorTarget } from "./paths";
import type { CarryResult } from "./rename-carry";
import type { RunningServer } from "./server";
import type { ServerState } from "./server-manager";
import { buildBrowserSeedScript, BROWSER_APP_SETTINGS, type UserDataCopy } from "./settings";
import { buildThemeSwitchScript, type EmbedChannel, type ThemeSwitchMessage, type ThemeSwitchResult } from "./theme-map";
import { MANUAL_TRUST_STEPS, TRUST_BUILD_FAILED } from "./trust/trust-message";
import { buildTrustSeedScript } from "./trust/trust-seed";
import type { SyncTab } from "./vault-sync";

export const VIEW_TYPE_CODE = "vscode-workbench-code";

/** The Code tabs' webview partition (their shared browser profile). The terminal host page uses a different one (F5). */
export const CODE_TAB_PARTITION = "persist:vscode-workbench";

/**
 * `serve-web` answers with `X-Frame-Options: SAMEORIGIN` and
 * `frame-ancestors 'self'`, so a plain <iframe> inside Obsidian (origin
 * app://obsidian.md) is refused. A <webview> is its own top-level page and is
 * not subject to those headers. Both are kept switchable for the spike.
 */
export type EmbedElement = "webview" | "iframe";

/**
 * What hides the parts of the workbench that no setting hides (src/chrome-script.ts) and keeps them hidden: the keybinding overlay
 * the browser profile's keybindings gain at every load (src/keybinding-overlay.ts: the chords the page script presses and the
 * disabled layout chords), and the page script that presses them and puts away a bar a command brings back. A host that gives none (or `null`) leaves the tab with
 * the chrome the settings overlay hides, as in 0.1.0 (F3).
 */
export interface ChromeHiding {
  keybindings: readonly KeybindingEntry[];
  /** The commands a copied keybinding must not bind to any chord (`unbindCommands()`); unset: none are unbound. */
  unbind?: readonly string[];
  script: string;
}

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
  /** A folder in a tab's path was clicked: reveal that vault-relative folder in Obsidian's file explorer, as a note's path does. */
  revealFolder?(folder: string): void;
  /** Give a path crumb its hover tooltip (the crumb's own folder name, as on a note). `el` is the crumb's element; `folder` its vault-relative path. */
  folderTooltip?(el: unknown, folder: string): void;
  /** A path crumb was right-clicked: show the menu a note's crumb shows for the folder (the host builds it with `Menu.forEvent`, which shows it). */
  folderMenu?(folder: string, evt: unknown): void;
  /** A path crumb is being dragged: start Obsidian's drag of the folder. False when it cannot, so the drag is cancelled. */
  dragFolder?(folder: string, evt: unknown): boolean;
  /** The chosen instance's auto-save, from the settings copied at the last server start. Default off. */
  autoSave?(): AutoSave;
  /** Ask the unsaved-changes question when a tab with unsaved edits is closed. Without it, a dirty tab stays open. */
  confirmClose?(request: CloseDirtyRequest): Promise<"save" | "discard" | "cancel">;
  /** Bring a tab to the front and focus it (Cancel on the close prompt). */
  focusTab?(leaf: WorkspaceLeaf): void | Promise<void>;
  /**
   * True when `leaf` is the tab the user is on right now. Asked when the workbench page finishes loading: only the active
   * tab takes keyboard focus then, so a background tab (restored with the layout, or opened behind the active one) does not
   * steal it. Absent: no tab takes focus on load.
   */
  isActiveTab?(leaf: WorkspaceLeaf): boolean;
  /** The plugin's own theme and chrome settings for this load, laid over the browser profile's user settings (G5, G6). */
  workbenchOverlay?(): Record<string, unknown>;
  /** The chords and the page script that close the side bar, secondary side bar and panel in this load (GP1). Read at every load. */
  chromeHiding?(): ChromeHiding | null;
  /**
   * The `trustVaultFolder` setting, read at every tab load: true runs the trust seed (G5), false or absent runs
   * nothing and leaves whatever is stored alone (G6).
   */
  trustVaultFolder?(): boolean;
  /** Ports of the servers still running, for the trust seed's keep-list. Absent or empty: the seed removes no record. */
  heldPorts?(): readonly number[];
  /** What the trust seed answered for the tab that just loaded ("seeded", "version-mismatch", "timeout", "build-failed", ...). The settings tab reads it from the host. */
  noteTrustOutcome?(outcome: string): void;
  /**
   * A tab made its embed (webview or iframe): let the hotkey bridge watch it. Returns the function that stops watching,
   * called when the embed is replaced or the tab closes. Absent (or a no-op) when the bridge is off.
   */
  attachEmbed?(frame: HTMLElement): () => void;
  /** True while Obsidian is quitting or the plugin is unloading: tabs then close without asking (quit asks once for all of them). */
  skipCloseGuard?(): boolean;
  /** Open a file in a new Code tab (the file a tab was asked to navigate to while its own unsaved edits were kept). */
  openInNewTab?(file: string): void;
  /**
   * A file was opened from inside the editor of `from` (Go to Definition, quick open, a link): open it as a new Obsidian tab beside
   * `from`, in front, at `line` (null: the cursor stays where the file puts it), or focus the tab that already shows it, or, for a
   * kind that is not a Code tab or a file outside the vault, do what Obsidian does for that kind. Absent: the tab does not watch for
   * such opens and the file opens inside the tab as VS Code would (F3).
   */
  openFromEditor?(from: WorkspaceLeaf, target: EditorTarget, line: number | null): void | Promise<void>;
  /** The bytes of a vault file now (null if unreadable): taken when a rename leaves unsaved edits bound to the old path. */
  readBaseline?(file: string): Promise<Buffer | null>;
  /**
   * A fingerprint of the file at `file` now (its size, modification time and inode), null when there is no such file.
   * The plugin compares it across looks at the tab to tell the tab's own save from a file made there by something else.
   */
  statSignature?(file: string): Promise<string | null>;
  /**
   * After a save wrote the edits of a renamed file to its OLD path: move them into the renamed file and remove the
   * old path ("conflict" when the renamed file changed meanwhile; the user is told, nothing is overwritten).
   */
  carryEdits?(from: string, to: string, baseline: Buffer | null): Promise<CarryResult>;
  /**
   * This tab's edits of a renamed file will not be moved into it, so a save from the tab left them in `from`, not in
   * `to`, and the user is told. Either another file now belongs at `from` (R6), or the plugin did not see the tab save
   * the file there and so cannot tell the tab's text from another file's (R8).
   */
  editsNotMoved?(from: string, to: string): void;
  /**
   * A file opened from the editor held unsaved edits in this tab, so it was left open behind the tab's own file (PR-4 R8). The user is
   * told where the edits are: the new Obsidian tab for `opened` reads the file from disk, without them.
   */
  editsKeptInTab?(own: string, opened: string): void;
}

/** What a Code tab does once its embed has finished loading, for a vault event that arrived while it was loading. */
type QueuedClose = "close" | "close-guarded" | "close-if-clean";
const QUEUE_RANK: Record<QueuedClose, number> = { "close-if-clean": 1, "close-guarded": 2, close: 3 };

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** How long the workbench page may take to answer a read before the tab counts as unreadable. */
const READ_TIMEOUT_MS = 3000;

/** How often a tab with a renamed file's pending move is looked at, to see its save happen (R8). */
const MOVE_WATCH_MS = 1000;

/**
 * A rename of the file a tab has loaded. The workbench's buffer stays bound to `from`, the path it was loaded from. A
 * save writes the edits there, and `settleRename` moves them into the renamed file, but only for a save this tab was
 * seen to make: a file at `from` that nobody saw the tab write (one made there by a shell or `git checkout`) is not
 * the tab's to move, and moving it would overwrite the renamed file with it.
 */
interface PendingMove {
  from: string;
  to: string;
  /** The renamed file's bytes when the rename was noticed. */
  baseline: Promise<Buffer | null>;
  /** The buffer's state and the old path's fingerprint at the last look. */
  lastState: "clean" | "dirty" | null;
  lastSig: string | null;
  /** The buffer held unsaved edits at some look after the rename. */
  everDirty: boolean;
  /** A look saw the buffer go from dirty to clean while the old path's file changed: the tab's own save wrote it. */
  saved: boolean;
  /** The old path's fingerprint right after that save. The edits are carried only while the file still has it (R10). */
  savedSig: string | null;
}

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

export { DIRTY_SCRIPT };

export const CRASH_TEXT =
  "The VS Code server stopped unexpectedly. Restarting reloads this tab, and any unsaved changes in your open Code tabs are lost. Copy anything you need first.";
export const RESTART_FAILED_TEXT =
  "The VS Code server could not be restarted. Unsaved changes in this tab are lost if you reload it. Try Restart again, or use \"Restart server\" in the plugin settings.";

interface CodeViewState {
  file?: string;
  /** Not persisted (`getState` leaves it out): the line a tab opened for a file opened from the editor puts the cursor on. */
  line?: unknown;
  [key: string]: unknown;
}

/** The part of Electron's <webview> element the seeding step uses. */
interface WebviewLike extends HTMLElement {
  executeJavaScript?: (code: string) => Promise<unknown>;
  sendInputEvent?: (event: { type: string; keyCode?: string; modifiers?: string[] }) => unknown;
}

/**
 * Run `script` once in the page the webview has just loaded (same origin as the
 * workbench), then resolve with what the script returned. Best effort: a missing
 * `dom-ready`, a rejected script or the timeout all resolve (with "timeout",
 * "unsupported" or "error:<message>"), so the workbench still opens.
 */
export function runInWebview(el: WebviewLike, script: string, timeoutMs = 8000): Promise<unknown> {
  return runScriptsInWebview(el, [script], timeoutMs).then((outcomes) => outcomes[0]);
}

/**
 * Run `scripts` one after another in the page the webview has just loaded, all after the same `dom-ready` (that
 * event fires once per page, so a second `runInWebview` on the same page would wait for it in vain). Resolves
 * with one outcome per script, in order, each as `runInWebview` would give it. `timeoutMs` is one budget for the
 * whole sequence (the wait for `dom-ready` and every script), so a page that hangs holds the tab for at most that
 * long. A script that fails does not stop the next one; once the budget is spent, the script that was running and
 * every one after it answer "timeout", and none that has not started is run. If the page never reports
 * `dom-ready`, every outcome is "timeout".
 */
export async function runScriptsInWebview(el: WebviewLike, scripts: readonly string[], timeoutMs = 8000): Promise<unknown[]> {
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(0, deadline - Date.now());
  const ready = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), remaining());
    el.addEventListener(
      "dom-ready",
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      { once: true },
    );
  });
  if (!ready) return scripts.map(() => "timeout");
  const execute = el.executeJavaScript;
  if (typeof execute !== "function") return scripts.map(() => "unsupported");
  const outcomes: unknown[] = [];
  for (const script of scripts) {
    if (remaining() === 0) {
      outcomes.push("timeout"); // the budget is spent: this one is not started
      continue;
    }
    outcomes.push(
      await new Promise<unknown>((resolve) => {
        const timer = setTimeout(() => resolve("timeout"), remaining());
        Promise.resolve()
          .then(() => execute.call(el, script))
          .then(
            (v) => {
              clearTimeout(timer);
              resolve(v);
            },
            (e) => {
              clearTimeout(timer);
              resolve(`error:${e instanceof Error ? e.message : String(e)}`);
            },
          );
      }),
    );
  }
  return outcomes;
}

/**
 * Run `script` in the page the webview is showing right now, with no wait for `dom-ready`: for a page that reloaded itself, whose
 * `dom-ready` the caller is already handling. Same outcomes as `runInWebview` ("unsupported", "timeout", "error:<message>").
 */
export function runNowInWebview(el: WebviewLike, script: string, timeoutMs = 8000): Promise<unknown> {
  const execute = el.executeJavaScript;
  if (typeof execute !== "function") return Promise.resolve("unsupported");
  return new Promise<unknown>((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), timeoutMs);
    Promise.resolve()
      .then(() => execute.call(el, script))
      .then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          resolve(`error:${e instanceof Error ? e.message : String(e)}`);
        },
      );
  });
}

/** Say in the console when the cursor could not be put on a line; the tab is open at the file's own cursor then. */
export function logGoToLine(outcome: unknown): void {
  if (outcome === GO_TO_LINE_DONE) console.debug("VS Code Workbench: cursor moved to the requested line");
  else console.warn(`VS Code Workbench: the cursor was not moved to the requested line (${String(outcome)}); the file is open at its own cursor.`);
}

/** Say in the console how the browser-profile seed went, so a seed that quietly stops working can be seen. */
export function logSeedOutcome(outcome: unknown): void {
  if (outcome === "seeded") console.debug("VS Code Workbench: browser profile seeded");
  else console.warn(`VS Code Workbench: the browser profile seed did not apply (${String(outcome)}); the workbench opens with its own defaults, so extension update checks, experiments and telemetry may not be switched off for this tab.`);
}

/**
 * Say in the console how the chrome-hiding script went. Anything but the install answer (the page never reported dom-ready, the
 * script threw, the webview cannot run scripts) leaves the parts the settings cannot hide on screen, so it is said once per load.
 */
export function logChromeOutcome(outcome: unknown): void {
  if (outcome === CHROME_SCRIPT_INSTALLED) console.debug("VS Code Workbench: chrome-hiding script installed");
  else console.warn(`VS Code Workbench: the chrome-hiding script did not run (${String(outcome)}); this tab may show the side bar, secondary side bar or panel of VS Code.`);
}

/** Say in the console how the trust seed went, the way `logSeedOutcome` does for the settings seed. */
export function logTrustOutcome(outcome: unknown): void {
  if (outcome === "seeded") console.debug("VS Code Workbench: vault folder trusted");
  else console.warn(`VS Code Workbench: the trust seed did not apply (${String(outcome)}); the workbench opens in Restricted Mode. To trust the vault folder by hand, ${MANUAL_TRUST_STEPS}.`);
}

export function baseName(file: string): string {
  return file.split("/").pop() || file;
}

export class CodeView extends ItemView implements SyncTab, EmbedChannel {
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
  /** Stops the hotkey bridge watching the current embed. */
  private detachBridge: (() => void) | null = null;
  /** Counts loadWorkbench calls, so a restart can tell whether the "running" event already reloaded this tab. */
  private loadCount = 0;
  /** The file the embed was last pointed at. Differs from `file` after a rename that has not been applied to the embed yet. */
  private shownFile = "";
  /** A vault event that arrived while the embed was loading: applied once it has loaded. */
  private queuedClose: QueuedClose | null = null;
  /** The file was deleted: closing no longer asks about unsaved edits. */
  private deleted = false;
  private closed = false;
  private closing: Promise<void> | null = null;
  private repointing = false;
  /** The line to put the cursor on once the workbench page has loaded (set by `setState` or `goToLine`), or null. Cleared when a load ends. */
  private pendingLine: number | null = null;
  /** The workbench page of the current load has reported dom-ready (the first dom-ready is the server's origin page). */
  private workbenchReady = false;
  /**
   * The page of the current load may hold an editor besides the tab's own file (PR-5 R1). The window title that `bufferState`
   * reads follows the ACTIVE editor only, so an unsaved editor behind the tab's file would read clean. Set when the open-from-editor
   * script did not run at all (the host has no open-from-editor, or no chrome-hiding script: it gave none or building it threw), or
   * did not install, or when putting an opened editor away did not end in "pressed" (the unsaved editor stayed, the
   * close was blocked, timed out or threw), or when the page shows an editor that stays in the tab (an untitled file, user
   * settings, a file of another server: R7). While set, `bufferState` never answers "clean". Cleared when the page is loaded again.
   */
  private mayHoldOtherEditor = false;
  /** The editor opened from this tab held unsaved edits that were left open behind the tab's file (the "switched" answer): the close prompt says so. */
  private heldEditsElsewhere = false;
  /**
   * Set by a rename of the loaded file: the workbench's buffer stays bound to `from`, the path it was loaded from,
   * while the file is now at `to` (this.file, or the ineligible new name). A save writes the edits to `from`; they are
   * moved into the renamed file by `settleRename`. `baseline` is the renamed file's bytes when the rename was noticed.
   * The move is dropped (nothing is carried) when the user discards, or when the old path stops being this tab's to
   * use: it was taken by another file (`pathTaken`). It is only carried out when the tab was seen to save (`saved`).
   */
  private pendingMove: PendingMove | null = null;
  /** Looks at the pending move run one after another, so each compares with the one before. */
  private observing: Promise<void> = Promise.resolve();
  private moveWatch: ReturnType<typeof setInterval> | null = null;
  /** `leaf.detach` as it was before the close guard replaced it; null when no guard is installed. */
  private originalDetach: (() => void) | null = null;
  private restoreDetach: (() => void) | null = null;

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

  /**
   * Draw the file's folder path in the view header, as Obsidian does for a note, each folder revealing itself in the file explorer
   * when clicked (and offering a tooltip, a right-click menu and drag, as a note's crumb does). `titleParentEl` is Obsidian's own header element (not in its typings); without it there is nothing to draw into
   * and the tab keeps just its title. A click does nothing when the host cannot reveal.
   */
  private renderBreadcrumbs(): void {
    const parent = (this as unknown as { titleParentEl?: BreadcrumbParent }).titleParentEl;
    if (!parent) return;
    const host = this.host;
    renderPathBreadcrumbs(parent, this.file, {
      reveal: (folder) => host.revealFolder?.(folder),
      tooltip: host.folderTooltip && ((el, folder) => host.folderTooltip?.(el, folder)),
      menu: host.folderMenu && ((folder, evt) => host.folderMenu?.(folder, evt)),
      drag: host.dragFolder && ((folder, evt) => host.dragFolder?.(folder, evt) ?? false),
    });
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
        // Navigate-in-place: Obsidian can also hand this tab a different file (an explorer click while a Code tab
        // is active). Replacing the page would drop unsaved text, so this goes through the same unsaved-changes
        // prompt as closing the tab; on Cancel the tab keeps its file and the requested one opens in a new tab. A tab still loading has no
        // editor text yet, so it is not asked.
        const navigating = this.file !== "" && fileKey(this.file) !== fileKey(file);
        if (navigating && this.frame && !this.loading && !this.deleted && !(await this.guardUnsaved())) {
          this.host.openInNewTab?.(file);
          return;
        }
        // The claim is taken before anything is awaited, so two tabs given the same file in one tick cannot both win.
        const admitting = this.host.admitFile(file, this.leaf);
        if (navigating) this.host.releaseFile(this.file, this.leaf);
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
          this.detachNow();
          return;
        }
        this.renderBreadcrumbs();
        (this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
        const line = (state as CodeViewState).line;
        this.pendingLine = line === undefined || line === null ? null : normalizeLine(line);
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
    this.installCloseGuard();
  }

  async onClose(): Promise<void> {
    // A last look at the buffer before the page goes, so a save made since the last one is still seen (R8).
    if (!this.deleted) await this.observeMove();
    this.closed = true;
    this.stopMoveWatch();
    this.restoreDetach?.();
    this.restoreDetach = null;
    this.originalDetach = null;
    if (this.file) this.host.releaseFile(this.file, this.leaf);
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.host.untrackView(this);
    this.dropBridge();
    this.frame?.remove();
    this.frame = null;
    // Any way of closing ends here (saved, auto-saved, closed without asking at quit): edits saved to the old path
    // of a renamed file are moved into it. Not for a file Obsidian deleted: there is nothing to move them to.
    if (!this.deleted) await this.settleRename();
  }

  /** True when this tab is on screen (not a background tab). */
  isVisible(): boolean {
    return (this.contentEl as { isShown?: () => boolean }).isShown?.() ?? false;
  }

  /** Call when tab visibility may have changed: a tab left behind by an idle stop wakes the server when shown. */
  notifyVisible(): void {
    if (this.stale && !this.crashed && !this.loading && this.isVisible()) void this.loadWorkbench();
    else if (this.shownFile !== this.file) void this.repoint(); // a rename held back by unsaved edits: apply it if they are saved now
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
    this.dropBridge();
    this.frame?.remove();
    this.frame = null;
    this.stale = false;
    this.detachNow();
  }

  private dropBridge(): void {
    const off = this.detachBridge;
    this.detachBridge = null;
    off?.();
  }

  /** Give keyboard focus to the embedded editor (after the terminal drawer closes, GP5e). */
  focusEmbed(): void {
    (this.frame as HTMLElement | null)?.focus?.();
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
   * What the workbench in this tab holds: "dirty" or "clean" as the page reports, or "unreadable" when the
   * page cannot be asked (not loaded yet, an iframe, the script fails or does not answer, or the window title that
   * carries the signal is not there: `DIRTY_SCRIPT` throws then). The page reports the tab's one file: the
   * title's dirty mark follows the active editor, and a tab holds one file. A tab with no file has nothing to lose
   * and is "clean". While the page may hold another editor behind the tab's file (`mayHoldOtherEditor`) the title
   * cannot vouch for it, so a title that reads clean is "unreadable" instead (a dirty title is still "dirty").
   */
  async bufferState(): Promise<BufferState> {
    if (!this.file) return "clean";
    const f = this.frame as WebviewLike | null;
    if (!f || typeof f.executeJavaScript !== "function" || !this.domReady) return "unreadable";
    try {
      if ((await withTimeout(f.executeJavaScript(DIRTY_SCRIPT), READ_TIMEOUT_MS)) === true) return "dirty";
      return this.mayHoldOtherEditor ? "unreadable" : "clean";
    } catch {
      return "unreadable";
    }
  }

  /**
   * Whether this tab must keep the server alive and be asked about: it holds an unsaved buffer, or the
   * page cannot be asked. An unsaved buffer is never discarded on a guess (E13). Used by the idle clock,
   * the quit prompt and the restart prompt.
   */
  async isDirty(): Promise<boolean> {
    return decide("idle", await this.bufferState(), this.autoSave()) === "block";
  }

  private autoSave(): AutoSave {
    return this.host.autoSave?.() ?? "off";
  }

  /**
   * The unsaved-changes check for a tab that is about to close (or to be given another file). True when it
   * may go ahead: nothing unsaved, auto-save wrote the edit in time, the user saved, or the user discarded.
   * False on Cancel (or when there is no way to ask): the tab stays.
   */
  private async guardUnsaved(): Promise<boolean> {
    const outcome = await this.askUnsaved();
    if (outcome === "stay") return false;
    // Discard: the user gave the edits up, so nothing is moved. Whatever sits at the old path is not this tab's to carry.
    if (outcome === "discard") this.abandonRename();
    // Going ahead: a save of a renamed file's edits went to its old path, so they are moved before the tab goes.
    else await this.settleRename();
    return true;
  }

  private async askUnsaved(): Promise<"go" | "stay" | "discard"> {
    let state = await this.bufferState();
    let action = decide("close", state, this.autoSave());
    if (action === "settle") {
      // Auto-save is on and the edit is moments old: give it time to reach disk before bothering the user.
      const deadline = Date.now() + SETTLE_MS;
      while (state === "dirty" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, SETTLE_POLL_MS));
        state = await this.bufferState();
      }
      action = decide("close", state, "off");
    }
    if (action === "proceed") return "go";
    const file = baseName(this.file);
    let failed = false;
    for (;;) {
      const prompt = this.host.confirmClose;
      const choice = prompt ? await prompt.call(this.host, { file, state: state === "unreadable" ? "unreadable" : "dirty", failed, otherEditor: state === "unreadable" && this.mayHoldOtherEditor ? (this.heldEditsElsewhere ? "unsaved" : "unknown") : undefined }) : "cancel";
      if (choice === "cancel") return "stay";
      const saved = choice === "save" ? await this.saveBuffers() : false;
      const resolution = resolveChoice(choice, saved);
      if (resolution === "proceed") return choice === "discard" ? "discard" : "go";
      if (resolution === "stay") return "stay";
      failed = true; // saved nothing: ask again, in the "could not save" wording
      state = await this.bufferState();
      if (state === "clean") return "go";
    }
  }

  /**
   * Close this tab the way the user asked, but not before unsaved edits are dealt with. Obsidian closes a tab
   * by calling `leaf.detach()` (the close button, Cmd+W, close all, close others, a background or pinned
   * tab); the guard installed in onOpen routes all of those here. Calls made while a prompt is up share it,
   * so a dirty file is asked about once.
   */
  requestClose(): Promise<void> {
    if (this.closing) return this.closing;
    const p: Promise<void> = (async () => {
      try {
        if (this.deleted || !this.file || this.host.skipCloseGuard?.()) return this.detachNow();
        if (await this.guardUnsaved()) this.detachNow();
        else await this.host.focusTab?.(this.leaf);
      } catch (e) {
        // Could not tell: the tab stays rather than risk the text.
        console.warn("VS Code Workbench: the unsaved-changes check failed; the tab stays open:", e instanceof Error ? e.message : e);
      }
    })().finally(() => {
      if (this.closing === p) this.closing = null;
    });
    this.closing = p;
    return p;
  }

  /** Close now, without asking: the file is gone, the server could not start, or the tab never had a page. */
  private detachNow(): void {
    if (this.originalDetach) this.originalDetach();
    else this.leaf.detach();
  }

  private installCloseGuard(): void {
    const leaf = this.leaf as unknown as { detach?: () => unknown };
    if (typeof leaf.detach !== "function" || this.originalDetach) return;
    const own = Object.prototype.hasOwnProperty.call(leaf, "detach");
    const before = leaf.detach;
    const original = before.bind(leaf);
    const guarded = () => void this.requestClose();
    this.originalDetach = () => void original();
    leaf.detach = guarded;
    this.restoreDetach = () => {
      if (leaf.detach !== guarded) return;
      if (own) leaf.detach = before;
      else delete leaf.detach;
    };
  }

  /**
   * Press the workbench's "Save All" shortcut and wait until no editor in the tab is dirty. True if
   * everything saved. Save All, not Save: Save only reaches the active editor, and any other dirty
   * editor would stay dirty. An untitled editor opens a Save As box that nothing here can answer, so
   * it stays dirty and this returns false; the caller asks the user what to do next.
   */
  async saveBuffers(timeoutMs = 5000): Promise<boolean> {
    await this.observeMove(); // the state and the old path just before the save, for the look that follows it (R8)
    const saved = await this.pressSave(timeoutMs);
    await this.observeMove();
    return saved;
  }

  private async pressSave(timeoutMs: number): Promise<boolean> {
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

  /**
   * The trust seed for this load, or null when the setting is off (nothing is run, nothing stored is touched) or the
   * script cannot be built for this folder (logged; the tab opens in Restricted Mode, never errors or blanks).
   */
  private trustSeedScript(server: RunningServer): string | null {
    if (this.host.trustVaultFolder?.() !== true) return null;
    try {
      return buildTrustSeedScript({
        origin: server.baseUrl,
        folderUri: buildFileUri(server.baseUrl, this.host.vaultRoot()),
        heldPorts: this.host.heldPorts?.() ?? [],
      });
    } catch (e) {
      console.warn(`VS Code Workbench: the trust seed was not built (${e instanceof Error ? e.message : String(e)}); the workbench opens in Restricted Mode. To trust the vault folder by hand, ${MANUAL_TRUST_STEPS}.`);
      this.host.noteTrustOutcome?.(TRUST_BUILD_FAILED); // the page never ran anything, so this is not a page error ("error:...")
      return null;
    }
  }

  /** The host's overlay for this load; a host that fails to give one leaves the browser profile's own settings (logged), never a blank tab (F3). */
  private overlay(): Record<string, unknown> {
    try {
      return this.host.workbenchOverlay?.() ?? {};
    } catch (e) {
      console.warn(`VS Code Workbench: the workbench settings were not built (${e instanceof Error ? e.message : String(e)}); this tab opens with VS Code's own layout settings.`);
      return {};
    }
  }

  private async runChromeScript(el: HTMLElement, hiding: ChromeHiding): Promise<void> {
    const outcome = await runInWebview(el as WebviewLike, hiding.script);
    if (this.frame === el) logChromeOutcome(outcome); // a reload since has its own script and its own outcome
  }

  /**
   * The editor takes keyboard focus on open: when the workbench page's dom-ready fires, the webview is focused if it is still
   * this tab's current frame (a reload since has replaced it) and this tab is the one the user is on. Obsidian's own
   * setActiveLeaf({focus:true}) focuses nothing inside an ItemView, so without this typing would not reach the editor.
   */
  private focusWhenReady(el: HTMLElement): void {
    el.addEventListener(
      "dom-ready",
      () => {
        if (this.frame !== el || this.closed) return;
        if (this.host.isActiveTab?.(this.leaf)) el.focus?.();
      },
      { once: true },
    );
  }

  /** The chrome-hiding chords and script for this load, or null when the host gives none or fails to build them (logged; the tab opens with the chrome the settings leave). */
  private chromeHiding(): ChromeHiding | null {
    try {
      return this.host.chromeHiding?.() ?? null;
    } catch (e) {
      console.warn(`VS Code Workbench: the chrome-hiding script was not built (${e instanceof Error ? e.message : String(e)}); this tab may show the side bar, secondary side bar or panel of VS Code.`);
      return null;
    }
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
    this.mayHoldOtherEditor = false; // a new page holds only the tab's own file
    this.heldEditsElsewhere = false;
    this.dropBridge();
    this.contentEl.empty();
    this.frame = null;
    this.banner = null;
    try {
      const server = await this.host.ensureServer();
      const url = buildFileUrl(server.baseUrl, this.host.vaultRoot(), this.file, server.token);
      this.shownFile = this.file;
      this.pendingMove = null; // the new page's buffer is bound to the file as it is now
      const el = document.createElement(this.host.embedElement());
      const isWebview = this.host.embedElement() === "webview";
      if (isWebview) {
        el.setAttribute("partition", CODE_TAB_PARTITION);
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
      this.detachBridge = this.host.attachEmbed?.(el) ?? null;
      if (isWebview) {
        // One page, one dom-ready: both seeds run from it, the settings seed first, then the trust seed.
        const trust = this.trustSeedScript(server);
        const hiding = this.chromeHiding();
        // Without the chrome-hiding script (the host gave none, or building it threw) or a host that opens files from the editor,
        // nothing watches the page: Go to Definition or Cmd+P opens another file inside the tab, as stock VS Code does (PR-5 R10).
        if (!hiding || !this.host.openFromEditor) this.mayHoldOtherEditor = true;
        const settingsSeed = buildBrowserSeedScript({ ...BROWSER_APP_SETTINGS, ...this.overlay() }, this.host.userDataCopy(), hiding?.keybindings, hiding?.unbind);
        const outcomes = await runScriptsInWebview(el as WebviewLike, trust === null ? [settingsSeed] : [settingsSeed, trust]);
        logSeedOutcome(outcomes[0]);
        if (trust !== null) {
          logTrustOutcome(outcomes[1]);
          this.host.noteTrustOutcome?.(String(outcomes[1]));
        }
        if (this.frame === el) {
          el.setAttribute("src", url);
          // The workbench page's own dom-ready (the second this element reports: the first was the server's origin page) runs
          // the script that closes the parts. Not awaited: a script that fails or times out is logged and changes nothing
          // else, and the load is finished (F3). The listener is added in the same tick as the navigation, before the event.
          if (hiding) void this.runChromeScript(el, hiding);
          const reopen = hiding && this.host.openFromEditor ? this.watchOpens(el, authorityOf(server.baseUrl)) : null;
          this.placeCursorOnLoad(el);
          this.focusWhenReady(el);
          this.reinstallOnReload(el, hiding, reopen);
        }
      }
    } catch (e) {
      // A declined licence opens the file in the system app, as the explicit open does (a tab Obsidian
      // opened itself, from the explorer or a link, comes this way).
      if (e instanceof LicenceDeclinedError) this.host.openInSystemApp(this.file);
      // main.ts has already shown the (token-free) reason. A tab is closed rather than left blank; only a
      // tab that was showing the crash banner (its page may hold text to copy) keeps its place and offers Restart.
      this.frame = null;
      this.pendingLine = null; // a line asked for during a load that failed is not kept for the next one
      this.contentEl.empty();
      if (keepForRestart) {
        this.crashed = true;
        this.showBanner(RESTART_FAILED_TEXT);
      } else {
        this.detachNow();
      }
    } finally {
      this.loading = false;
      if (!this.closed) void this.afterLoad();
    }
  }

  /**
   * A file opened from inside this tab's editor becomes an Obsidian tab of its own (PR-4). The page script reports the new file and
   * line through the console; the report carries a nonce made for this load. The tab puts the opened editor away, so it shows its
   * own file at its own cursor again, and hands the file to the host. It never navigates in place.
   */
  private watchOpens(el: HTMLElement, authority: string): () => void {
    const nonce = globalThis.crypto.randomUUID();
    el.addEventListener("console-message", (event: Event) => {
      if (this.frame !== el || this.closed) return;
      const message = (event as { message?: unknown } | undefined)?.message;
      // An editor VS Code keeps inside the tab (untitled, settings, output): it may hold typed text behind the tab's file (R7).
      if (isOtherEditorReport(message, nonce)) this.mayHoldOtherEditor = true;
      const report = parseOpenReport(message, nonce);
      if (report) void this.openedFromEditor(el, authority, report);
    });
    const script = buildOpenInterceptScript(nonce);
    const report = (outcome: unknown) => {
      if (this.frame !== el) return;
      if (outcome !== OPEN_INTERCEPT_INSTALLED) {
        this.mayHoldOtherEditor = true; // nothing puts an opened editor away, so one may sit behind the tab's file
        console.warn(`VS Code Workbench: the open-from-editor script did not install (${String(outcome)}); a file opened from this tab's editor opens inside the tab, as VS Code does.`);
      }
    };
    void runInWebview(el as WebviewLike, script).then(report);
    // The same script, for a page that reloaded itself (the listener above keeps its nonce, so the reports still match).
    return () => void runNowInWebview(el as WebviewLike, script).then(report);
  }

  /**
   * A workbench page that reloads itself (Developer: Reload Window, an extension that asks for a reload) fires `dom-ready` again on the
   * same webview, with none of the scripts of the first load: hidden parts would rely on the saved layout, a palette reveal would not
   * be undone, and an editor opened from the tab would open inside it. Each later `dom-ready` runs the chrome script and the
   * open-from-editor script again, and says so in the console; a script that fails is logged as on the first load. This listener is
   * added in the same tick as the navigation, after the once-listeners of the workbench page, so the first event it sees is that
   * page's own (which those listeners handle) and every one after it is a reload.
   */
  private reinstallOnReload(el: HTMLElement, hiding: ChromeHiding | null, reopen: (() => void) | null): void {
    if (!hiding && !reopen) return;
    let first = true;
    el.addEventListener("dom-ready", () => {
      if (first) {
        first = false;
        return;
      }
      if (this.frame !== el || this.closed) return;
      console.info("VS Code Workbench: the workbench page reloaded itself; the chrome-hiding and open-from-editor scripts are run again.");
      if (hiding) {
        void runNowInWebview(el as WebviewLike, hiding.script).then((outcome) => {
          if (this.frame === el) logChromeOutcome(outcome);
        });
      }
      reopen?.();
    });
  }

  private async openedFromEditor(el: HTMLElement, authority: string, report: OpenReport): Promise<void> {
    const target = targetOfUri(report.uri, authority, this.host.vaultRoot());
    if (target.kind === "other") {
      // Not a file of this server (another authority, say): it opens inside the tab as VS Code does, and may hold typed text there.
      if (this.frame === el) this.mayHoldOtherEditor = true;
      return;
    }
    // The tab's own file is not "another file" (a spelling of the same path): leave the editor alone.
    if (target.kind === "vault" && [this.file, this.shownFile].some((own) => own !== "" && fileKey(own) === fileKey(target.file))) return;
    try {
      const f = el as WebviewLike;
      if (typeof f.executeJavaScript === "function") {
        const restored = await withTimeout(f.executeJavaScript(RESTORE_OPEN_SCRIPT), 5000);
        if (restored !== "pressed" && this.frame === el) this.mayHoldOtherEditor = true;
        if (restored === RESTORE_SWITCHED) {
          // The opened file already held unsaved edits in this tab, so VS Code would not close it without asking. The prompt was
          // cancelled and the tab shows its own file; the edits stay here (nothing was saved or discarded for the user).
          console.info("VS Code Workbench: the file opened from the editor has unsaved edits in this tab; they stay in this tab, which shows its own file again.");
          this.heldEditsElsewhere = true;
          this.host.editsKeptInTab?.(this.file, target.kind === "vault" ? target.file : "");
        } else if (restored !== "pressed") {
          console.warn(`VS Code Workbench: the opened editor was not put away (${String(restored)}); this tab may show the other file too.`);
        }
      }
    } catch (e) {
      if (this.frame === el) this.mayHoldOtherEditor = true;
      console.warn(`VS Code Workbench: could not put the opened editor away (${e instanceof Error ? e.message : String(e)}); this tab may show the other file too.`);
    }
    try {
      await this.host.openFromEditor?.(this.leaf, target, report.line);
    } catch (e) {
      console.warn(`VS Code Workbench: a file opened from the editor was not opened as a tab (${e instanceof Error ? e.message : String(e)}).`);
    }
  }

  /**
   * The line asked for at load: once the workbench page (the second dom-ready this element reports) has loaded, the page script
   * moves the cursor. A line asked for before that moment (`goToLine` on a tab still loading its page) waits in `pendingLine` and
   * is taken here. Best effort; the tab is open either way.
   */
  private placeCursorOnLoad(el: HTMLElement): void {
    this.workbenchReady = false;
    el.addEventListener(
      "dom-ready",
      () => {
        if (this.frame !== el || this.closed) return;
        this.workbenchReady = true;
        const line = this.pendingLine;
        this.pendingLine = null;
        if (line !== null) void this.runGoToLine(el as WebviewLike, line);
      },
      { once: true },
    );
  }

  private async runGoToLine(f: WebviewLike, line: number): Promise<void> {
    if (typeof f.executeJavaScript !== "function") return logGoToLine("unsupported");
    try {
      logGoToLine(await withTimeout(f.executeJavaScript(buildGoToLineScript(line)), GO_TO_LINE_TOTAL_MS));
    } catch (e) {
      logGoToLine(`error:${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Put this tab's cursor on `line` (an already-open tab that a file opened from the editor named again, E3; or a restored tab
   * that has just been loaded). A tab whose workbench page has not loaded yet keeps the line for when it has. A line that is zero, negative or
   * not a number is line 1, and one past the end of the file is the last line. No-op on an iframe, which cannot be scripted (F5).
   */
  async goToLine(line: unknown): Promise<void> {
    const n = normalizeLine(line);
    const f = this.frame as WebviewLike | null;
    if (this.loading || !f || !this.workbenchReady) {
      this.pendingLine = n;
      return;
    }
    await this.runGoToLine(f, n);
  }

  // --- following the vault (G3) --------------------------------------------

  /**
   * The file was renamed or moved to `newPath`. The tab keeps its place: title and saved state change at once, the embed is
   * re-pointed when that cannot lose text. The workbench's buffer stays bound to the path it was loaded from, so
   * the move is remembered (`pendingMove`): if the buffer is saved meanwhile, its text lands in the old path and is
   * moved into the renamed file by `settleRename`.
   */
  followTo(newPath: string): void {
    if (!this.file || newPath === this.file) return;
    this.file = newPath;
    this.notePendingMove(newPath);
    this.renderBreadcrumbs();
    (this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
    (this.app as unknown as { workspace?: { requestSaveLayout?: () => void } } | undefined)?.workspace?.requestSaveLayout?.();
    void this.repoint();
  }

  /**
   * The loaded buffer's file is now at `to`: remember where its path was, and what `to` held, so a later save can be
   * carried over. The old path must be free at this point (Obsidian just moved the file away); if something is there
   * already (a rename swap, a file put back), a save would not be this tab's own file to carry, so nothing is remembered.
   */
  private notePendingMove(to: string): void {
    const from = this.pendingMove?.from ?? this.shownFile;
    if (!this.frame || !from) return; // nothing loaded yet: the load will use the new path
    if (from === to) {
      this.pendingMove = null; // renamed back: the buffer's path is valid again
      this.stopMoveWatch();
      return;
    }
    const prev = this.pendingMove;
    const baseline = prev?.baseline ?? (this.host.readBaseline?.(to) ?? Promise.resolve(null)).catch(() => null);
    const move: PendingMove = prev
      ? { ...prev, to }
      : { from, to, baseline, lastState: null, lastSig: null, everDirty: false, saved: false, savedSig: null };
    this.pendingMove = move;
    if (prev) return;
    this.startMoveWatch();
    void this.observeMove(); // the first look: the buffer's state and the (free) old path as of the rename
    if (!this.host.readBaseline) return;
    void this.host
      .readBaseline(from)
      .catch(() => null)
      .then((occupant) => {
        if (occupant !== null && this.pendingMove?.from === from) this.pathTaken(from);
      });
  }

  private startMoveWatch(): void {
    if (this.moveWatch) return;
    this.moveWatch = setInterval(() => {
      if (!this.pendingMove || this.closed) return this.stopMoveWatch();
      // A save made inside the embed raises no event of the plugin's: this look is what notices it, and the rename
      // held back by the unsaved edits is applied at once (a reload onto the renamed file), not when the user next
      // switches tabs. repoint() does nothing while the buffer is still unsaved or unreadable.
      void this.observeMove().then(() => {
        if (this.shownFile !== this.file) void this.repoint();
      });
    }, MOVE_WATCH_MS);
    (this.moveWatch as { unref?: () => void }).unref?.();
  }

  private stopMoveWatch(): void {
    if (this.moveWatch) clearInterval(this.moveWatch);
    this.moveWatch = null;
  }

  /**
   * Look at the buffer and at the old path of a renamed file, and note whether the tab saved since the last look
   * (R8). A save is the buffer going from dirty to clean while the old path's file changed, because a save writes the
   * file before the buffer reads clean. Edits that are undone (clean again with no write by the tab) leave the file
   * as it was, so a file put there by something else is never taken for the tab's save. The state is the tab's own
   * (`bufferState`: the window title's dirty mark follows the tab's one file), so unsaved edits of another buffer in
   * the page do not hide a save of this one. A state that cannot be read ("unreadable") is not counted as a save: it
   * is not carried (it cannot be told from a write by something else), and settleRename tells the user that the text
   * is in the old path. Nothing is lost or overwritten. Never throws.
   */
  observeMove(): Promise<void> {
    const look = this.observing.then(() => this.lookAtMove()).catch(() => undefined);
    this.observing = look;
    return look;
  }

  private statOld(from: string): Promise<string | null> {
    return (this.host.statSignature?.(from) ?? Promise.resolve(null)).catch(() => null);
  }

  private async lookAtMove(): Promise<void> {
    const from = this.pendingMove?.from;
    if (!from) return;
    const stat = (): Promise<string | null> => this.statOld(from);
    const before = await stat();
    const state = await this.bufferState();
    if (state === "unreadable") {
      // The buffer was not seen, so a later dirty-to-clean change cannot be matched with the earlier look: it is not
      // counted as a save (R11). A save made in this gap is then reported as "not moved", never carried on a guess.
      const gap = this.pendingMove;
      if (gap && gap.from === from) {
        gap.lastState = null;
        gap.lastSig = null;
      }
      return;
    }
    // A clean buffer means the save's write is already done, so the fingerprint is taken after the state is read.
    const sig = state === "clean" ? await stat() : before;
    const move = this.pendingMove;
    if (!move || move.from !== from) return; // dropped or settled while looking
    if (state === "dirty") move.everDirty = true;
    else if (move.lastState === "dirty" && sig !== null && sig !== move.lastSig) {
      move.saved = true;
      move.savedSig = sig; // what the save wrote: the only file at the old path that is the tab's to move (R10)
    } else if (move.saved && sig !== move.savedSig) {
      move.saved = false; // the buffer is clean and the old path changed since the save: something else wrote it (R10)
      move.savedSig = null;
    }
    move.lastState = state;
    move.lastSig = sig;
  }

  /**
   * Something other than this tab's own save put a file at `path` (a note or file created there, another file
   * renamed or moved onto it, another tab opened on it). If that is the old path of this tab's renamed file, the
   * edits are no longer carried: moving the old path's bytes into the renamed file would overwrite it with the
   * other file's text. The user is told that a save from this tab writes to the old path.
   */
  pathTaken(path: string): void {
    const move = this.pendingMove;
    if (!move || fileKey(move.from) !== fileKey(path)) return;
    this.pendingMove = null;
    this.stopMoveWatch();
    this.host.editsNotMoved?.(move.from, move.to);
  }

  /** The user gave this tab's unsaved edits up (Discard): nothing at the old path of a renamed file is moved. */
  abandonRename(): void {
    this.pendingMove = null;
    this.stopMoveWatch();
  }

  /**
   * After a rename, edits saved from the workbench went to the file's OLD path (the buffer is bound to it), which
   * brings that file back while the renamed file keeps its old text. Moves them into the renamed file. Called
   * when the tab is about to close or reload and when Obsidian quits; does nothing for a tab that was not
   * renamed, and nothing was saved. True when the edits were moved into the renamed file. Never throws.
   */
  async settleRename(): Promise<boolean> {
    await this.observeMove(); // a last look: a save since the previous one still counts
    const move = this.pendingMove;
    if (!move) return false;
    this.pendingMove = null;
    this.stopMoveWatch();
    try {
      // Carry only if the old path is still exactly the file the save the plugin saw wrote: a file put there since (a shell, git
      // checkout, a new file with the old name) is not the tab's (R10).
      const intact = move.saved && move.savedSig !== null && (await this.statOld(move.from)) === move.savedSig;
      if (intact) return (await this.host.carryEdits?.(move.from, move.to, await move.baseline)) === "carried";
      if (move.everDirty && (await this.host.readBaseline?.(move.from)) != null) this.host.editsNotMoved?.(move.from, move.to);
    } catch (e) {
      console.warn("VS Code Workbench: could not move saved edits to the renamed file:", e instanceof Error ? e.message : e);
    }
    return false;
  }

  /**
   * Point the embed at `file` if a rename left it on the old path. Does nothing while the embed is loading
   * (the load's end calls this again), while the tab is stopped or crashed (its next load uses the new
   * path), or while the buffer holds unsaved edits or cannot be read: a reload would drop them, so the
   * embed stays on the old buffer, and the move is applied once it is saved (checked when the tab is shown, and at every look of the move watch, so a save made inside the embed applies it within about a second),
   * after the saved text has been carried from the old path into the renamed file. A save that lands between the
   * look that found the buffer unsaved and now is carried at once (`carryHeld`), without waiting for the reload.
   * Repeated renames end in one reload to the final path.
   */
  private async repoint(): Promise<void> {
    if (this.repointing) return;
    this.repointing = true;
    try {
      while (!this.closed && !this.deleted && this.frame && this.shownFile !== this.file && !this.loading && !this.admitting && !this.crashed && !this.stale) {
        if ((await this.bufferState()) !== "clean") return void (await this.carryHeld());
        if (this.shownFile === this.file || this.closed) return;
        await this.settleRename();
        // settleRename took several async round trips (page query, stat, file IO), during which the user may have typed
        // again. The reload would drop that text, so the buffer is checked once more right before it.
        if (this.closed || this.deleted) return;
        if ((await this.bufferState()) !== "clean") {
          // The buffer is bound to the old path still, and settleRename has forgotten the move: remember it again, so the
          // next save is carried into the renamed file (and not left to recreate the old one). The watch applies the
          // reload once that save has happened.
          this.notePendingMove(this.file);
          return;
        }
        await this.loadWorkbench();
      }
    } finally {
      this.repointing = false;
    }
  }

  /**
   * The reload is held back (the buffer reads unsaved), but this renamed file's own buffer may have been saved
   * meanwhile: its text sits in the old path, where it would stay until the reload. Carry it into the renamed file now.
   * The buffer is still bound to the old path, so the move is remembered again: a later save of it is carried too, and
   * not left to recreate the old file. Does nothing unless a save was seen and the tab now reads clean.
   */
  private async carryHeld(): Promise<void> {
    const move = this.pendingMove;
    if (!move?.saved || this.closed || this.deleted) return;
    if ((await this.bufferState()) !== "clean") return;
    const carried = await this.settleRename();
    if (carried && !this.closed && !this.deleted) this.notePendingMove(this.file);
  }

  private queue(action: QueuedClose): void {
    if (this.queuedClose === null || QUEUE_RANK[action] > QUEUE_RANK[this.queuedClose]) this.queuedClose = action;
  }

  private busy(): boolean {
    return this.loading || this.admitting;
  }

  /** The embed finished loading: do what vault events asked for meanwhile. */
  private async afterLoad(): Promise<void> {
    const action = this.queuedClose;
    this.queuedClose = null;
    if (action === "close") return this.detachNow();
    if (action === "close-guarded") return void this.requestClose();
    if (action === "close-if-clean" && (await this.bufferState()) === "clean") return this.detachNow();
    await this.repoint();
  }

  /** Obsidian deleted the file: close with no prompt (there is nothing to save to). Queued while the embed loads, so no stale tab is left. */
  closeDeleted(): void {
    this.deleted = true;
    if (this.busy()) this.queue("close");
    else this.detachNow();
  }

  /** The file vanished outside Obsidian: a clean tab closes; one with unsaved edits stays, showing VS Code's own deleted-file state. */
  async deletedOnDisk(): Promise<boolean> {
    if (this.busy()) {
      this.queue("close-if-clean");
      return false;
    }
    if ((await this.bufferState()) !== "clean") return false;
    this.deleted = true;
    this.detachNow();
    return true;
  }

  /** The new name is not one a Code tab may show: close through the unsaved-changes prompt. Queued while the embed loads. `newPath` is where the file is now (a save then moves its text there). */
  closeIneligible(newPath?: string): void {
    if (newPath) this.notePendingMove(newPath);
    if (this.busy()) this.queue("close-guarded");
    else void this.requestClose();
  }

  // --- theme (G6) ------------------------------------------------------------

  /** Switch the loaded workbench to another theme in place: no reload, so the open file and the cursor stay. */
  async switchTheme(message: ThemeSwitchMessage): Promise<ThemeSwitchResult> {
    const f = this.frame as WebviewLike | null;
    if (!f || typeof f.executeJavaScript !== "function" || !this.domReady || this.loading) return "skipped";
    try {
      return (await withTimeout(f.executeJavaScript(buildThemeSwitchScript(message)), 6000)) === "applied" ? "applied" : "unconfirmed";
    } catch {
      return "unconfirmed";
    }
  }
}
