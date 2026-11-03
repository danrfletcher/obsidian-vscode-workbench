import { FileSystemAdapter, ItemView, Notice, Platform, Plugin, TFile, type Menu, type TAbstractFile, type Tasks, type WorkspaceLeaf } from "obsidian";
import { randomBytes } from "node:crypto";
import * as path from "node:path";
import { checkFile, refusalMessage } from "./binary-guard";
import { ChildRegistry } from "./child-registry";
import { AUTO_SAVE_KEY, autoSaveMode, withAutoSaveDefault, type AutoSave } from "./dirty-guard";
import { ownerOfExtension, type ViewRegistryLike } from "./coexistence";
import { CodeView, VIEW_TYPE_CODE, baseName, type ChromeHiding, type CodeViewHost, type EmbedElement } from "./code-view";
import { ExtensionRegistry } from "./extension-registry";
import { scanVault } from "./extension-scan";
import { createClickInterceptor, readMode, type ClickLike, type ExtensionlessMode } from "./extensionless-intercept";
import { describeFailure, type StartFailure } from "./failure-messages";
import { IdleTimer } from "./idle-timer";
import { hasLiveTerminalShell, liveShellPids } from "./terminal-keepalive";
import { restartPrompt, type ShellAnswer } from "./restart-prompt";
import { readProcessTable } from "./process-utils";
import { LicenceDeclinedError, LicenceGate } from "./licence";
import { promptCloseDirty, promptLicence, promptRestartWithDirty, promptReuseBuild, promptSaveFailed, promptSaveOrDiscard, type CloseDirtyRequest } from "./modals";
import { OpenFiles } from "./open-file";
import { openCodeTabOnce, openFromEditor as routeEditorOpen } from "./open-from-editor";
import { normalizeLine, type EditorTarget } from "./paths";
import { PidFile, sweepOrphans } from "./pidfile";
import { carryEdits as carryEditsOnDisk, readBaseline as readBaselineOnDisk, statSignature as statSignatureOnDisk, type CarryResult } from "./rename-carry";
import {
  ServerStartError,
  StartCancelledError,
  WorkbenchServer,
  cachedServerCommits,
  checkServeWebSupport,
  findNewestBuild,
  heldPortsSnapshot,
  removePartialDownloads,
  type CodeBuild,
  type PortPick,
  type RunningServer,
} from "./server";
import { ServerManager, type ServerState, type StartOptions } from "./server-manager";
import { verifyCliPath, type CliCheck } from "./instances/probe";
import { appSupportRoot, describeCustom, type Instance, type ScanResult } from "./instances/scan";
import { InstanceService } from "./instances/service";
import { DrawerToggle } from "./hotkey/drawer-toggle";
import { EmbedKeyRelay, type RelayFrame } from "./hotkey/embed-key-relay";
import { resolveChords, type BridgeAction, type HotkeyLike } from "./hotkey/hotkey-bridge";
import { profileForInstance, userDataRootFor, type ProfileState } from "./profile/mirrored-profile";
import type { MirrorRequest, MirrorResult } from "./mirror/mirror";
import { MirrorStateCache, profileExtensionsFile } from "./server/shared-extensions";
import { instanceUserDir, profileSeedSource, seedUserData } from "./server/user-data-seed";
import { dataObject, readSettings, type WorkbenchSettings } from "./settings/data";
import { type PortStatus, type SpikeResult } from "./settings/extensions-section";
import { SPIKE_RESULT } from "./settings/spike-result";
import { buildExtensionList } from "./settings/extension-list";
import type { ExtensionListView } from "./settings/extension-states";
import { WorkbenchSettingTab, type SettingsHost } from "./settings/settings-tab";
import { workbenchOverlay, terminalOverlay, writeMachineSettings, type UserDataCopy } from "./settings";
import { overlayKeybindings, unbindCommands } from "./chrome-settings";
import { buildChromeHideScript } from "./chrome-script";
import { DEVICE_ID_KEY, deviceId } from "./terminal/drawer-state";
import { viewKind } from "./terminal/drawer-visibility";
import { FocusReturn } from "./terminal/focus-return";
import { HeightStore } from "./terminal/height-store";
import { addNewTerminalItem, type MenuLike, type MenuTarget } from "./terminal/new-terminal-menu";
import { TerminalDrawer } from "./terminal/terminal-drawer";
import { TerminalHostPage } from "./terminal-host/host-page";
import { newTerminalAtFolder } from "./terminal-host/new-terminal";
import { TabRegistry } from "./tab-registry";
import { decideFile, extensionOf, fileName, opensInCodeTab } from "./text-file-rules";
import { isDarkBody, themeSwitchMessage, ThemeSync } from "./theme-map";
import { trackObsidianCreates, trackObsidianDeletes, VaultSync } from "./vault-sync";

/** Spike: opened by the ribbon icon when the active file is not a code file. */
export const SPIKE_FILE = "AWS SA Associate Mock Exams/scripts/estimate_time.py";

/** The least time between two rescans triggered by the window regaining focus (files made outside Obsidian). */
const FOCUS_RESCAN_MS = 30_000;

/** Whether a start (or restart) that fails raises the failure Notice. The terminal page asks quietly: it shows the reason itself. */
interface StartNotice {
  notify: boolean;
}

interface WorkbenchData extends Partial<WorkbenchSettings> {
  /** Hand-edited; path to a `code` CLI. When set it overrides the instance chosen in the settings tab. */
  codeCliPath?: string;
  /** Hand-edited; the user-data folder of a custom CLI: a folder name under Application Support, or an absolute path. Used for a custom CLI only. */
  userDataFolder?: string;
  /** Hand-edited; vault-relative file the ribbon opens when no openable active file exists. */
  spikeFile?: string;
  /** Hand-edited; what a click on an extensionless file does: "intercept" (Code tab, the default) or "system-app". */
  extensionlessMode?: ExtensionlessMode;
  embed?: EmbedElement;
  /** The VS Code server licence was accepted (the modal at the first Code-tab open). Never holds a token. */
  serverLicenceAccepted?: boolean;
  /** The last server build that started: lets an offline re-download after a VS Code update name the change. */
  lastServer?: { commit: string; version: string };
  /** The terminal drawer's height, per device: `{ [deviceId]: { height } }`. The open state is never stored. */
  drawer?: unknown;
}

/** How often the bridged chords are compared with Obsidian's hotkey settings, so a rebinding is followed live. */
const CHORD_SYNC_MS = 1000;

export default class VSCodeWorkbenchPlugin extends Plugin implements CodeViewHost, SettingsHost {
  private views = new Set<CodeView>();
  private openFiles = new OpenFiles<WorkspaceLeaf>(() => this.app.workspace.getLeavesOfType(VIEW_TYPE_CODE));
  private tabRegistry = new TabRegistry<WorkspaceLeaf>(this.openFiles);
  private vaultSync = new VaultSync<WorkspaceLeaf>({
    registry: this.tabRegistry,
    tabFor: (leaf) => [...this.views].find((v) => v.leaf === leaf),
    eligible: (p) => opensInCodeTab(p, this.workbenchSettings().excludeExtensions),
  });
  private restoreDeletes: (() => void) | null = null;
  private restoreCreates: (() => void) | null = null;
  /** Follows Obsidian's light/dark: rewrites the Machine settings and switches the open tabs in place. */
  private themeSync = new ThemeSync((dark) => this.applyTheme(dark), false);
  /** The quit flow has decided to stop the server: closing tabs no longer asks (the quit prompt already did). */
  private quitting = false;
  /** Unsaved-changes prompts for tab closes run one after another ("close all" with several dirty files). */
  private promptChain: Promise<unknown> = Promise.resolve();
  private extensionRegistry!: ExtensionRegistry;
  private scan: Promise<void> | null = null;
  private scanAgain = false;
  private lastScanAt = 0;
  private unloaded = false;
  private data_: WorkbenchData = {};
  private registry = new ChildRegistry(null);
  private manager!: ServerManager;
  private gate!: LicenceGate;
  private idle!: IdleTimer;
  private serverRequest: Promise<RunningServer> | null = null;
  /** Whether the start in `serverRequest` shows a failure Notice: false while only the terminal page asked (it shows the reason itself). */
  private serverFlow: StartNotice = { notify: false };
  private restarting: Promise<void> | null = null;
  private restartFlow: StartNotice = { notify: false };
  private lastBuild: CodeBuild | null = null;
  /** The instance's settings and keybindings as copied at the last server start; the Code tab seeds its browser profile from it. */
  private copy: UserDataCopy | null = null;
  /** The bottom edge and the drawer: shows, hides and sizes the terminal host page. Null where there is no desktop app. */
  private drawer: TerminalDrawer | null = null;
  private heightStore: HeightStore | null = null;
  /** The terminal host page (VS Code's own terminal panel in a webview). Made at the first show, kept mounted until unload. */
  private terminalHost: TerminalHostPage | null = null;
  /** The hotkey bridge: carries Ctrl+` and the quick switcher out of the embed (G8, G1). Null until onload; inactive when the spike decision is `no`. */
  private keyRelay: EmbedKeyRelay | null = null;
  private bridgeToggle: DrawerToggle | null = null;
  private chordTimer: ReturnType<typeof setInterval> | null = null;
  private instances = new InstanceService();
  private cachedBefore: ReadonlySet<string> = new Set();
  /** Why the running server did not use the stored stable port (null when it did, none is stored, or no server is running). */
  private portNote: string | null = null;
  /** The mirrored profile as the last read left it. Read at the first start, at Restart server and when a start's instance differs from the one it was read for; never on an idle restart on the same instance or when settings opens. */
  private profile: ProfileState = { status: "not-read" };
  /** Where `profile` was read from (the instance's user-data folder, or why it cannot be told); null until a read. A start on another instance finds this different and reads again. */
  private profileSource: string | null = null;
  /** The next server start reads the profile: true from Obsidian start until a start reads it, and again from each Restart server. */
  private profileStale = true;
  /** What the last server start read of desktop VS Code's disabled lists (read, snapshot or none); null until a start has read them. Shown in settings. */
  private mirror: MirrorResult | null = null;
  /**
   * Everything the last read of desktop VS Code gave: the disabled lists and the profile's extension list. Every start
   * shares from it; it is read again only when the profile is (Obsidian start, Restart server, another instance), never
   * on an idle restart.
   */
  private mirrorCache = new MirrorStateCache();
  /** What the trust seed answered at the last Code tab load that ran it, during the current server run; shown in settings. In memory only: nothing about it is stored, and it is cleared whenever the server is not running. */
  private lastTrustOutcome: string | null = null;
  /** Tests only: replaces the process table reader that the live-shell check uses (a fake clock cannot wait for a real `ps`). */
  private processTable: () => Promise<string> = readProcessTable;
  /** Tests only: replaces the reachability check that turns a failed download into "the network is unreachable". */
  private downloadHostReachable?: () => Promise<boolean>;

  async onload(): Promise<void> {
    try {
      this.data_ = dataObject(await this.loadData()) as WorkbenchData;
    } catch {
      this.data_ = {}; // an unreadable data.json: every setting falls back to its default
    }

    // Nothing below spawns a process or opens a port: the server starts at the first Code tab (G13).
    this.registry = new ChildRegistry(new PidFile(path.join(this.runtimeDir(), "pids.json")));
    this.manager = new ServerManager({ create: (o) => this.createServer(o), registry: this.registry });
    this.gate = new LicenceGate(
      {
        accepted: () => this.data_.serverLicenceAccepted === true,
        setAccepted: async (value) => {
          this.data_.serverLicenceAccepted = value;
          await this.saveData(this.data_);
        },
      },
      () => promptLicence(this.app),
    );
    this.idle = new IdleTimer({
      visibleCodeTab: () => [...this.views].some((v) => v.isVisible()),
      hasDirtyBuffer: async () => (await this.dirtyViews()).length > 0,
      // A live terminal shell under the server keeps it up, drawer shown or hidden (G10). Read from the server's own process tree.
      liveTerminalShell: () => hasLiveTerminalShell(this.manager.serverInstance?.pid, () => this.processTable()),
      onIdle: () => this.manager.stop("idle"),
    });
    this.manager.onChange((state) => {
      if (state === "running") this.idle.start();
      else this.idle.stop();
      // Both describe one run of the server (the port the start picked, the Code tab's trust seed): once it is not running they would
      // describe a run that is over, so settings must not show them (the next start and the next tab load set them again).
      if (state !== "running") {
        this.portNote = null;
        this.lastTrustOutcome = null;
      }
      this.terminalFollowsServer(state);
    });

    // A server left over from a crash or force-quit is swept before anything new starts (E11).
    try {
      await sweepOrphans(path.join(this.runtimeDir(), "pids.json"));
    } catch {
      /* the sweep is best effort; a new start never depends on it */
    }

    this.registerView(VIEW_TYPE_CODE, (leaf) => new CodeView(leaf, this));
    this.extensionRegistry = new ExtensionRegistry(
      {
        registerExtensions: (extensions, viewType) => this.registerExtensions(extensions, viewType),
        ownerOf: (extension) => ownerOfExtension((this.app as unknown as { viewRegistry?: ViewRegistryLike }).viewRegistry, extension),
        notice: (message) => void new Notice(message, 10000),
        log: (message, ...args) => console.info(message, ...args),
      },
      VIEW_TYPE_CODE,
    );
    this.addRibbonIcon("code-2", "Open in VS Code", () => void this.openSpikeFile());
    this.addCommand({
      id: "open-spike-file",
      name: "Open spike file in Code tab",
      callback: () => void this.openSpikeFile(),
    });
    this.addSettingTab(new WorkbenchSettingTab(this.app, this, this));

    // The terminal drawer: a thin edge along the bottom of the main pane area, and the terminal host page behind it (VS Code's
    // own terminal). It is desktop only and only in the main window (F7): the edge and the drawer go on this window's
    // document, so a pop-out window gets neither. The page is drawn once the workspace is ready (below).
    if (Platform.isDesktopApp) {
      this.heightStore = new HeightStore({
        data: () => this.data_ as Record<string, unknown>,
        save: () => this.saveData(this.data_),
        deviceId: deviceId({
          get: () => this.app.loadLocalStorage?.(DEVICE_ID_KEY),
          set: (id) => this.app.saveLocalStorage?.(DEVICE_ID_KEY, id),
        }),
        windowHeight: () => window.innerHeight,
      });
      this.drawer = new TerminalDrawer({
        document,
        window,
        host: () => this.terminalHostPage(),
        initialHeight: this.heightStore.read(),
        saveHeight: (height) => this.heightStore?.write(height),
        viewKind: () => viewKind(this.mainViewType(), VIEW_TYPE_CODE),
        nonCodeDrawer: () => this.workbenchSettings().nonCodeDrawer,
        focus: new FocusReturn<WorkspaceLeaf>({
          activeLeaf: () => this.activeLeaf(),
          isAlive: (leaf) => this.leafIsAlive(leaf),
          focusLeaf: (leaf) => this.focusLeafView(leaf),
        }),
      });
      this.bridgeToggle = new DrawerToggle(this.drawer);
      this.addCommand({
        id: "toggle-terminal-drawer",
        name: "Toggle terminal drawer",
        // Ctrl, not Mod: on macOS Mod is Cmd, and Ctrl+` is the VS Code binding. Rebindable in Obsidian's hotkey settings.
        // An explicit action: it opens the drawer over every view, whatever the non-code setting says (G6).
        hotkeys: [{ modifiers: ["Ctrl"], key: "`" }],
        callback: () => this.drawer?.toggle(),
      });
      // "New terminal at folder" in the file explorer's right-click menu (G8). The single-item `file-menu` only: a multi-selection
      // fires `files-menu`, which is not listened to, so one choice is never several terminals.
      this.registerEvent(this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile, source: string) => this.onFileMenu(menu, file, source)));
    }

    // The hotkey bridge (E12): installed only when the recorded spike decision allows it. It follows the hotkeys
    // Obsidian has for the two bridged commands, checked every second and when the active tab changes.
    this.keyRelay = new EmbedKeyRelay({
      window,
      serverOrigin: () => this.manager.current?.baseUrl ?? null,
      chords: () => resolveChords((id) => this.hotkeysOf(id), this.isMac()),
      onAction: (action, frame) => this.onBridgedKey(action, frame),
    });
    if (this.keyRelay.install()) {
      this.chordTimer = setInterval(() => this.keyRelay?.sync(), CHORD_SYNC_MS);
      (this.chordTimer as { unref?: () => void }).unref?.();
    }

    // Theme follows Obsidian light/dark (G6): the Machine settings are rewritten and every open tab is
    // switched in place, without a reload. Rapid toggling is coalesced by ThemeSync.
    this.registerEvent(
      this.app.workspace.on("css-change", () => {
        void this.themeSync.set(this.isDark());
        void this.terminalHost?.themeChanged(this.isDark());
      }),
    );
    // A tab shown, hidden or closed changes what the idle clock sees; a tab left behind by an idle stop wakes the server.
    const visibilityChanged = () => {
      for (const v of this.views) v.notifyVisible();
      void this.idle.evaluate();
      this.keyRelay?.sync();
      // The tab the user is on decides whether the edge shows (G6); a moved pane or sidebar changes the drawer's bounds.
      this.drawer?.applyVisibility();
      this.drawer?.layoutChanged();
    };
    this.registerEvent(this.app.workspace.on("active-leaf-change", visibilityChanged));
    this.registerEvent(this.app.workspace.on("layout-change", visibilityChanged));
    // Quitting Obsidian: ask about unsaved buffers first, then take the server and every registered child down (GP8).
    // Obsidian runs its quit flow inside the window's own `beforeunload` handler: it fires "quit", calls
    // preventDefault, awaits the tasks, then closes the window. Listener order against that handler is not
    // something to rely on, so nothing here acts on `beforeunload`: the server stays up until the tasks are done.
    this.registerEvent(
      this.app.workspace.on("quit", (tasks: Tasks) => {
        tasks.add(() => this.onQuit());
      }),
    );
    // Fallback when the quit event does not run (a reload, say): the window really is going away, so no prompt,
    // but nothing is left running. `pagehide` fires only once the page is actually unloading, never for a
    // `beforeunload` that gets cancelled or is still waiting on the quit tasks; after a finished quit the
    // server is already stopped, so this finds nothing to do.
    this.registerDomEvent(window, "pagehide", () => {
      void this.shutdownAll();
    });

    // Every extension found in the vault is registered against the Code tab, now and as new files appear (GP1).
    // All of it waits for layout-ready, when every community plugin has loaded: registering earlier would take
    // an extension before Code Files, VSCode Editor or Code Workbench had registered it, and their own
    // registerExtensions call would then throw and abort their onload (F8). Obsidian also fires "create" once
    // per existing file while the vault loads, which would register everything early the same way.
    // The scan runs in the background in small slices; nothing waits for it.
    this.app.workspace.onLayoutReady(() => {
      if (this.unloaded) return;
      this.drawer?.mount();
      this.registerEvent(this.app.vault.on("create", (f) => this.onFileAppeared(f)));
      this.registerEvent(this.app.vault.on("rename", (f) => this.onFileAppeared(f)));
      // Open Code tabs follow the vault (G3): a rename or move re-points the tab, a delete closes it. A modify is
      // deliberately not handled: an external change is left to VS Code (G4); the plugin adds no prompt and never touches the buffer.
      this.registerEvent(
        this.app.vault.on("rename", (f: TAbstractFile, oldPath: string) => {
          if (typeof oldPath !== "string" || typeof f?.path !== "string") return;
          this.vaultSync.onRename(f.path, oldPath);
          // Something renamed onto the old path of a renamed file with unsaved edits: that path is no longer the tab's.
          this.pathTaken(f.path);
        }),
      );
      this.registerEvent(
        this.app.vault.on("delete", (f: TAbstractFile) => {
          if (typeof f?.path === "string") void this.vaultSync.onDelete(f.path);
        }),
      );
      this.restoreDeletes = trackObsidianDeletes(this.app as never, this.vaultSync);
      this.restoreCreates = trackObsidianCreates(this.app as never, (p) => this.pathTaken(p));
      // A file made outside Obsidian (a `touch` in a terminal) is picked up when the window next gets focus.
      this.registerDomEvent(window, "focus", () => {
        if (Date.now() - this.lastScanAt >= FOCUS_RESCAN_MS) void this.rescanExtensions();
      });
      void this.rescanExtensions();
    });
    // Extensionless files and dotfiles: best-effort click interception on the explorer's file rows (G7).
    const intercept = createClickInterceptor({
      mode: () => readMode(this.data_.extensionlessMode),
      excluded: () => this.workbenchSettings().excludeExtensions,
      openInCodeTab: (p) => this.openCodeFile(p),
      openInSystemApp: (p) => this.openInSystemApp(p, "extensionless"),
      notice: (m) => void new Notice(m),
    });
    this.registerDomEvent(document, "click", (ev: MouseEvent) => intercept(ev as ClickLike), true);
  }

  onunload(): void {
    this.unloaded = true;
    this.restoreDeletes?.();
    this.restoreDeletes = null;
    this.restoreCreates?.();
    this.restoreCreates = null;
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_CODE);
    this.idle?.stop();
    if (this.chordTimer) clearInterval(this.chordTimer);
    this.chordTimer = null;
    this.keyRelay?.dispose();
    this.keyRelay = null;
    this.bridgeToggle = null;
    // The terminal host page goes with the plugin: no webview left behind (a start still running is dropped at its next step).
    // It goes before the server stops, so the page never reloads onto a dying server and no banner or lost message shows.
    this.endTerminalPage();
    // The edge and the layout variables go off the page, and the drawer height still waiting to be written is written.
    this.drawer?.dispose();
    this.drawer = null;
    this.heightStore?.flush();
    this.heightStore = null;
    // shutdown() sends its kill signals synchronously; unload does not wait for the exit.
    void this.manager?.shutdown();
  }

  // --- CodeViewHost -------------------------------------------------------

  vaultRoot(): string {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) throw new Error("VS Code Workbench needs a local vault.");
    return adapter.getBasePath();
  }

  embedElement(): EmbedElement {
    return this.data_.embed ?? "webview";
  }

  attachEmbed(frame: HTMLElement): () => void {
    return this.keyRelay?.attach(frame as unknown as RelayFrame) ?? (() => undefined);
  }

  // --- the hotkey bridge ----------------------------------------------------

  private isMac(): boolean {
    return Platform.isMacOS ?? (typeof process !== "undefined" && process.platform === "darwin");
  }

  /** The hotkeys Obsidian has for a command: the user's own if any were set (even none), else the default. */
  private hotkeysOf(commandId: string): readonly HotkeyLike[] {
    const manager = (this.app as unknown as { hotkeyManager?: { getHotkeys?(id: string): HotkeyLike[] | undefined; getDefaultHotkeys?(id: string): HotkeyLike[] | undefined } }).hotkeyManager;
    return manager?.getHotkeys?.(commandId) ?? manager?.getDefaultHotkeys?.(commandId) ?? [];
  }

  /** A bridged chord was pressed inside the embed or the terminal host page. Only the action name arrived; nothing is logged. */
  private onBridgedKey(action: BridgeAction, frame: RelayFrame): void {
    if (action === "toggle-terminal") {
      // From the terminal page the press gives no focus handle: closing the drawer sends focus back to the view that had it (G1),
      // not to the webview that is being hidden.
      const fromTerminal = (frame as unknown) === this.terminalHost?.webview;
      this.bridgeToggle?.press(fromTerminal ? null : frame);
      return;
    }
    // The quick switcher: the embed gives up focus first so the switcher's search box gets the typing.
    frame.blur?.();
    (this.app as unknown as { commands?: { executeCommandById?(id: string): boolean } }).commands?.executeCommandById?.("switcher:open");
  }

  /** The leaf the user is on: the focused one (a sidebar's too), else the last used in the main area. */
  private activeLeaf(): WorkspaceLeaf | null {
    const ws = this.app.workspace as unknown as { getActiveViewOfType?: (t: unknown) => { leaf?: WorkspaceLeaf } | null };
    return ws.getActiveViewOfType?.(ItemView)?.leaf ?? this.app.workspace.getMostRecentLeaf?.() ?? null;
  }

  /** The leaf is still in the workspace (its tab was not closed). */
  private leafIsAlive(leaf: WorkspaceLeaf): boolean {
    let found = false;
    this.app.workspace.iterateAllLeaves?.((l) => {
      if (l === leaf) found = true;
    });
    return found;
  }

  /** Keyboard focus into a leaf's view (the drawer hid): a Code tab's embed, or a note's editor. */
  private focusLeafView(leaf: WorkspaceLeaf): void {
    const active = document.activeElement as HTMLElement | null;
    if (active?.tagName === "WEBVIEW") active.blur(); // the terminal page keeps focus otherwise, though it is hidden
    const ws = this.app.workspace as unknown as { setActiveLeaf?: (l: WorkspaceLeaf, o?: { focus: boolean }) => void };
    ws.setActiveLeaf?.(leaf, { focus: true });
    const view = leaf.view as unknown;
    if (view instanceof CodeView) view.focusEmbed();
    else (view as { editor?: { focus?(): void } } | null | undefined)?.editor?.focus?.();
  }

  trackView(view: CodeView): void {
    this.views.add(view);
    void this.idle?.evaluate();
  }

  untrackView(view: CodeView): void {
    this.views.delete(view);
    void this.idle?.evaluate();
  }

  serverState(): ServerState {
    return this.manager.state;
  }

  onServerState(cb: (state: ServerState) => void): () => void {
    return this.manager.onChange((state) => cb(state));
  }

  /** The view type of the tab the user is on in the main area; a sidebar being focused does not change it. */
  private mainViewType(): string {
    const leaf = this.app.workspace.getMostRecentLeaf?.() ?? null;
    return leaf?.view?.getViewType?.() ?? "";
  }

  /** The file in the active view: a Code tab's file, or the file of a note or other file view; null when the view has none. */
  private activeFilePath(): string | null {
    const ws = this.app.workspace as unknown as { getActiveViewOfType?: (t: unknown) => unknown; getActiveFile(): TFile | null };
    if (typeof ws.getActiveViewOfType !== "function") return ws.getActiveFile()?.path ?? null;
    const view = ws.getActiveViewOfType(ItemView);
    if (view instanceof CodeView) return view.filePath;
    const file = (view as { file?: { path?: unknown } | null } | null)?.file;
    return typeof file?.path === "string" ? file.path : null;
  }

  private isDark(): boolean {
    return isDarkBody(document.body.classList);
  }

  /** Obsidian's theme changed to `dark`: write the Machine settings (the next load reads them) and switch every open tab in place. */
  private async applyTheme(dark: boolean): Promise<void> {
    const server = this.manager.serverInstance;
    if (this.manager.state === "running" && server) writeMachineSettings(server.serverDataDir, { dark });
    const message = themeSwitchMessage(dark);
    await Promise.all([...this.views].map((v) => v.switchTheme(message)));
  }

  workbenchOverlay(): Record<string, unknown> {
    return workbenchOverlay({ dark: this.isDark() });
  }

  /** The terminal drawer's host page has an overlay of its own: it never reads the Code tab's hiding settings (F2). */
  terminalOverlay(): Record<string, unknown> {
    return terminalOverlay({ dark: this.isDark() });
  }

  /** The keybinding overlay and page script that keep the bars of a Code tab closed and the layout chords dead; read at every load (GP1, GP4). */
  chromeHiding(): ChromeHiding {
    return { keybindings: overlayKeybindings(), unbind: unbindCommands(), script: buildChromeHideScript() };
  }

  /** Read at every tab load, so the toggle applies at the next load (G6). */
  trustVaultFolder(): boolean {
    return this.workbenchSettings().trustVaultFolder;
  }

  heldPorts(): readonly number[] {
    return heldPortsSnapshot();
  }

  noteTrustOutcome(outcome: string): void {
    this.lastTrustOutcome = outcome;
  }

  /** The trust seed's last answer, for the settings tab (SettingsHost). null until a Code tab has loaded with the seed on. */
  trustOutcome(): string | null {
    return this.lastTrustOutcome;
  }

  autoSave(): AutoSave {
    return autoSaveMode(this.copy?.settings[AUTO_SAVE_KEY]);
  }

  skipCloseGuard(): boolean {
    return this.ending;
  }

  /** The plugin is going away for good (Obsidian is quitting, or the plugin unloaded): a start still under way must not go on to show a notice or spawn a server. */
  private get ending(): boolean {
    return this.quitting || this.unloaded;
  }

  confirmClose(request: CloseDirtyRequest): Promise<"save" | "discard" | "cancel"> {
    const ask = () => promptCloseDirty(this.app, request);
    const p = this.promptChain.then(ask, ask);
    this.promptChain = p.catch(() => undefined);
    return p;
  }

  focusTab(leaf: WorkspaceLeaf): Promise<void> {
    return this.focusLeaf(leaf);
  }

  isActiveTab(leaf: WorkspaceLeaf): boolean {
    return this.activeLeaf() === leaf;
  }

  openInNewTab(file: string): void {
    void this.openCodeFile(file);
  }

  /**
   * A file was opened from inside the editor of the Code tab `from` (Go to Definition, quick open, a link). It becomes an Obsidian tab
   * beside `from`, in front, at `line`; a tab that already shows it is focused instead; a note, canvas, base, image or PDF opens the
   * way Obsidian opens it; a file outside the vault only gets a notice (E2, E3, E4).
   */
  async openFromEditor(from: WorkspaceLeaf, target: EditorTarget, line: number | null): Promise<void> {
    // The new tab goes into the tab group of the active tab, so a Code tab in a split pane must be the active one first.
    if (!this.isActiveTab(from)) (this.app.workspace as unknown as { setActiveLeaf?: (l: WorkspaceLeaf, o?: { focus: boolean }) => void }).setActiveLeaf?.(from, { focus: false });
    await routeEditorOpen(target, line, {
      excluded: () => this.workbenchSettings().excludeExtensions,
      openCode: (file, at) => this.openCodeFile(file, at),
      openInObsidian: (file) => this.openInObsidian(file),
      notify: (message) => void new Notice(message, 10000),
    });
  }

  /** Obsidian's usual open for a file that is not a Code tab's (a note, canvas, base, image or PDF), in a new tab. */
  private async openInObsidian(file: string): Promise<void> {
    const found = this.findVaultFile(file);
    if (!found) {
      new Notice(`VS Code Workbench: ${fileName(file)} is not in this vault, so Obsidian cannot open it.`, 10000);
      return;
    }
    await this.app.workspace.getLeaf("tab").openFile(found, { active: true });
  }

  readBaseline(file: string): Promise<Buffer | null> {
    return readBaselineOnDisk(this.vaultRoot(), file);
  }

  statSignature(file: string): Promise<string | null> {
    return statSignatureOnDisk(this.vaultRoot(), file);
  }

  /** Another file took `path` (Obsidian created or renamed one there, or a tab opened it): the Code tabs renamed away from it stop carrying. */
  private pathTaken(path: string, except?: WorkspaceLeaf): void {
    for (const v of this.views) if (v.leaf !== except) v.pathTaken(path);
  }

  editsNotMoved(from: string, to: string): void {
    new Notice(
      `VS Code Workbench: ${baseName(to)} was renamed while it had unsaved edits, and ${from} holds a file the plugin cannot tie to this tab's save. Nothing was moved or overwritten: anything you saved from this tab is in ${from}, so copy it out from there.`,
      15000,
    );
  }

  /** Edits of a renamed file were saved to its old path: move them into the renamed file. Tells the user when it could not. */
  async carryEdits(from: string, to: string, baseline: Buffer | null): Promise<CarryResult> {
    let result: CarryResult;
    try {
      result = await carryEditsOnDisk(this.vaultRoot(), from, to, baseline);
    } catch (e) {
      console.warn("VS Code Workbench: could not move saved edits to the renamed file:", e instanceof Error ? e.message : e);
      result = "conflict";
    }
    if (result === "conflict") {
      new Notice(
        `VS Code Workbench: ${baseName(to)} was renamed while it had unsaved edits, and it changed since. Your edits were saved to ${from}; nothing was overwritten.`,
        15000,
      );
    }
    return result;
  }

  /** The plugin-owned runtime dir: token file, server data, CLI data, pidfile. */
  private runtimeDir(): string {
    const manifestDir = this.manifest.dir ?? path.join(this.app.vault.configDir, "plugins", this.manifest.id);
    return path.join(this.vaultRoot(), manifestDir, ".server");
  }

  // --- The terminal host page ---------------------------------------------

  /** The host page, made on first use; null once the plugin has unloaded. Its start goes through `ensureServer` and the licence gate: one server, one modal. */
  private terminalHostPage(): TerminalHostPage | null {
    if (this.unloaded || this.quitting) return null;
    if (this.terminalHost) return this.terminalHost;
    this.terminalHost = new TerminalHostPage({
      createElement: (tag) => document.createElement(tag),
      parent: document.body,
      vaultRoot: () => this.vaultRoot(),
      licenceAccepted: () => this.gate.accepted,
      requestLicence: () => this.gate.request(),
      // The page shows a failed start's reason itself, with Retry (or in the crash banner): no Notice beside it.
      ensureServer: () => this.ensureServer({ quiet: true }),
      restartServer: () => this.restartServer({ quiet: true }),
      failureText: (e) => this.describeStartFailure(e).message,
      notice: (message) => void new Notice(message, 10000),
      isDark: () => this.isDark(),
      workbenchOverlay: () => this.terminalOverlay(),
      userDataCopy: () => this.copy,
      trustVaultFolder: () => this.trustVaultFolder(),
      heldPorts: () => this.heldPorts(),
      noteTrustOutcome: (outcome) => this.noteTrustOutcome(outcome),
      attachKeys: (frame) => this.keyRelay?.attach(frame as unknown as RelayFrame) ?? (() => undefined),
      closedByHost: () => this.drawer?.hostClosed(),
      // The page was created, became ready or lost its page, failed or was closed: what the idle clock sees may have changed.
      stateChanged: () => void this.idle?.evaluate(),
    });
    void this.idle?.evaluate(); // the host page was just created
    return this.terminalHost;
  }

  /**
   * The server changed state: the terminal page follows it (G13). A crash shows the banner in the drawer; a restart's stop drops
   * the page, which comes back at the new address when a server runs; an idle stop drops it with nothing announced. Quit and
   * unload never get here: they end the page first (`endTerminalPage`), so a stop that is theirs raises no banner and no reload.
   */
  private terminalFollowsServer(state: ServerState): void {
    const host = this.terminalHost;
    if (!host || this.quitting || this.unloaded) return;
    switch (state) {
      case "crashed":
        host.serverCrashed();
        break;
      case "stopped":
        host.serverStopped();
        break;
      case "stopped-by-idle":
        host.serverIdle();
        break;
      case "running":
        host.serverRunning();
        break;
      case "failed":
        host.serverFailed(this.describeStartFailure(this.manager.lastError).message);
        break;
      default:
        break;
    }
  }

  /** End the terminal page: its webview and container are removed and later events are ignored. Idempotent. */
  private endTerminalPage(): void {
    this.terminalHost?.dispose();
    this.terminalHost = null;
  }

  /** The file explorer's menu is being built: add the item that opens a terminal in the folder (or the file's folder). */
  private onFileMenu(menu: Menu, file: TAbstractFile, source: string): void {
    if (this.unloaded) return;
    addNewTerminalItem(menu as unknown as MenuLike, file as unknown as MenuTarget, source, (folder) => this.openTerminalAtFolder(folder));
  }

  /**
   * Open a new terminal in `folder` (a vault path, "" for the vault root): the drawer is opened or revealed through its own
   * reveal path, then VS Code's own terminal is asked for a new one at that folder. The drawer, the host page and the server
   * start are the ones the edge and the hotkey use.
   */
  private openTerminalAtFolder(folder: string): Promise<unknown> {
    return newTerminalAtFolder(
      {
        vaultRoot: () => this.vaultRoot(),
        reveal: () => this.drawer?.openDrawer(),
        settled: () => this.terminalHost?.settled() ?? Promise.resolve(),
        ready: () => this.terminalHost?.ready() ?? false,
        starting: () => this.terminalHost?.starting() ?? false,
        focusTerminal: () => this.terminalHost?.focusTerminal(),
        // Only a server that is running has a page to answer: a crashed one gets no request that a later start could replay.
        serverDataDir: () => (this.manager.current ? (this.manager.serverInstance?.serverDataDir ?? null) : null),
        unloaded: () => this.unloaded,
        notice: (message) => void new Notice(message, 10000),
      },
      folder,
    );
  }

  // --- Starting the server ------------------------------------------------

  /**
   * The running server, starting it first if needed. The first call ever asks
   * for the licence; nothing is downloaded before it is accepted. Callers that
   * arrive while it starts share one start, one licence modal and one failure
   * notice. Rejects with LicenceDeclinedError if the licence was declined, or
   * with the start error (shown in a Notice unless every caller was `quiet`) if the server failed.
   * A `quiet` caller shows the failure itself (the terminal page does, beside Retry), so the Notice is skipped; as soon as a
   * caller that is not quiet shares the start, the Notice is raised for the failure.
   */
  ensureServer(opts: { quiet?: boolean } = {}): Promise<RunningServer> {
    const running = this.manager.current;
    if (running) return Promise.resolve(running);
    if (!this.serverRequest) {
      const flow: StartNotice = { notify: false };
      this.serverFlow = flow;
      const p: Promise<RunningServer> = this.startFlow((o) => this.manager.ensureStarted(o), flow).finally(() => {
        if (this.serverRequest === p) this.serverRequest = null;
      });
      this.serverRequest = p;
    }
    if (!opts.quiet) this.serverFlow.notify = true;
    return this.serverRequest;
  }

  private async startFlow(start: (o?: StartOptions) => Promise<RunningServer>, flow: StartNotice): Promise<RunningServer> {
    if (!(await this.gate.request())) throw new LicenceDeclinedError();
    // The plugin was unloaded while the licence modal was up: accepting it must not start a server nobody owns.
    if (this.ending) throw new StartCancelledError();
    try {
      const running = await start();
      await this.recordLastServer();
      return running;
    } catch (e) {
      if (e instanceof StartCancelledError) throw e;
      const failure = this.reportFailure(e, flow);
      if (failure.offerReuse && failure.versionChange && (await promptReuseBuild(this.app, failure.versionChange))) {
        if (this.ending) throw new StartCancelledError();
        try {
          // The reused build is not recorded as the last server: it is the old one.
          return await this.manager.ensureStarted({ commitOverride: failure.offerReuse.commit });
        } catch (e2) {
          if (!(e2 instanceof StartCancelledError)) this.reportFailure(e2, flow);
          throw e2;
        }
      }
      throw e;
    }
  }

  /** The token-free description of a failed start: what the Notice says, and what the terminal host shows beside Retry. */
  private describeStartFailure(e: unknown): StartFailure {
    const cliDataDir = path.join(this.runtimeDir(), "cli-data");
    const last = this.data_.lastServer ?? null;
    return describeFailure(e, {
      installedVersion: this.lastBuild?.versionText,
      installedCommit: this.lastBuild?.commit ?? null,
      lastServer: last,
      lastServerCached: last ? cachedServerCommits(cliDataDir).has(last.commit) : false,
    });
  }

  /**
   * Show the Notice for a failed start (token-free) unless the start was the terminal page's alone, and clear any
   * half-downloaded server either way.
   */
  private reportFailure(e: unknown, flow: StartNotice): StartFailure {
    const cliDataDir = path.join(this.runtimeDir(), "cli-data");
    const failure = this.describeStartFailure(e);
    if (failure.kind === "offline-first-run" || failure.kind === "offline-redownload" || failure.kind === "download") {
      removePartialDownloads(cliDataDir, this.cachedBefore);
    }
    if (flow.notify) new Notice(failure.message, 15000);
    return failure;
  }

  private async recordLastServer(): Promise<void> {
    const b = this.lastBuild;
    if (!b?.commit) return;
    const last = this.data_.lastServer;
    if (last?.commit === b.commit && last.version === b.versionText) return;
    this.data_.lastServer = { commit: b.commit, version: b.versionText };
    await this.saveData(this.data_);
  }

  private async createServer(o: StartOptions): Promise<WorkbenchServer> {
    // Defence in depth: no download can start without an accepted licence.
    if (!this.gate.accepted) throw new LicenceDeclinedError();
    // Unload does not wait for a start: each await below can finish after the plugin is gone, and nothing
    // may then be written, shown or spawned for it. (ServerManager also drops a server created after a stop.)
    if (this.ending) throw new StartCancelledError();
    const chosen = await this.instanceForStart();
    if (this.ending) throw new StartCancelledError();
    const build = chosen ? findNewestBuild({ override: chosen.cli }) : null;
    if (!chosen || !build) throw new ServerStartError("No VS Code installation found.", null, "", { kind: "missing-binary" });
    const support = await checkServeWebSupport(build.cli);
    if (this.ending) throw new StartCancelledError();
    if (!support.serveWeb) {
      throw new ServerStartError(`${build.cli} has no "serve-web" command.`, null, "", { kind: "no-serve-web", detail: build.cli });
    }
    this.lastBuild = build;
    const runtimeDir = this.runtimeDir();
    this.cachedBefore = cachedServerCommits(path.join(runtimeDir, "cli-data"));
    const commit = o.commitOverride ?? build.commit ?? null;
    if (commit ? !this.cachedBefore.has(commit) : this.cachedBefore.size === 0) {
      // The server for this VS Code build is not on disk yet: the start below downloads it (this is the progress notice).
      new Notice("VS Code Workbench: downloading the VS Code server. The first run needs internet and can take a minute.", 8000);
    }
    const reread = this.mirrorProfile(chosen);
    const extensionsFile = this.profileExtensionsFile(build);
    const stateKey = `${this.profileSource}|${this.profile.status === "resolved" ? this.profile.profile.location : ""}|${extensionsFile ?? ""}`;
    // An idle restart (nothing asked for a new read, same place) shares from the state it already has: no sqlite3, no re-read of the profile's list.
    const reuse = this.mirrorCache.forStart(stateKey, reread);
    this.mirror = reuse ? reuse.disabled : null; // a new read: until it has finished, settings says "not read yet"
    const server = new WorkbenchServer({
      build: o.commitOverride ? { ...build, commit: o.commitOverride } : build,
      runtimeDir,
      acceptLicense: true,
      disableTelemetry: support.disableTelemetry,
      registry: this.registry,
      workspace: this.vaultRoot(),
      installTerminalAt: true,
      downloadHostReachable: this.downloadHostReachable,
      storedPort: this.workbenchSettings().stablePort,
      onPortPick: (pick) => this.notePort(pick),
      mirror: this.mirrorRequest(chosen),
      profileExtensionsFile: extensionsFile,
      reuseMirror: reuse,
      onMirror: (result) => {
        if (!this.unloaded) this.mirror = result;
      },
      onMirrorState: (state) => {
        if (!this.unloaded) this.mirrorCache.keep(stateKey, state);
      },
    });
    writeMachineSettings(server.serverDataDir, { dark: this.isDark() });
    this.themeSync.markApplied(this.isDark());
    this.seedUserData(server.userDataDir, chosen);
    return server;
  }

  /**
   * The instance the next start runs on: the hand-edited `codeCliPath` if there is one, else the
   * saved choice, else the default (the newest VS Code build). null when none can be found.
   */
  private async instanceForStart(): Promise<Instance | null> {
    const override = this.data_.codeCliPath;
    if (override) return describeCustom(override);
    const settings = this.workbenchSettings();
    return this.instances.forStart(settings.customCliPath, settings.instanceId);
  }

  /** At each start: copy the mirrored profile's settings and keybindings one way into the user-data dir, trust keys stripped, excludes on top (G12, G13, G16, G17). */
  private seedUserData(userDataDir: string, instance: Instance): void {
    try {
      const source = profileSeedSource(this.profile, instanceUserDir(instance.userDataName, appSupportRoot()));
      const result = seedUserData({ userDataDir, ...source });
      if (result.notice) new Notice(`VS Code Workbench: ${result.notice}`, 10000);
      // files.autoSave is written out: the web workbench defaults to afterDelay, the desktop to off (G2).
      this.copy = { id: randomBytes(8).toString("hex"), settings: withAutoSaveDefault(result.merged), keybindingsBase64: result.keybindingsBase64 };
    } catch {
      this.copy = null;
      new Notice("VS Code Workbench: could not copy the settings and keybindings of the VS Code profile this vault uses, so the editor starts without them.", 10000);
    }
  }

  /**
   * Read which profile desktop VS Code uses for the vault, once at the first server start after Obsidian starts and once per Restart server
   * (an idle restart on the same instance keeps the result, G2). A start on a different instance (or user-data
   * folder) than the one the result was read for reads again, so settings never shows another instance's profile
   * (E6, F9). It only reads, and a failure is a result shown in settings: the start goes on.
   * Returns whether it read (true) or kept the result it had (false); the disabled lists and the profile's extension
   * list are read again exactly when this is true.
   */
  private mirrorProfile(instance: Instance): boolean {
    const found = userDataRootFor({ instance, appSupport: appSupportRoot(), configuredFolder: this.data_.userDataFolder });
    const source = "root" in found ? `root:${found.root}` : `reason:${found.reason}`;
    if (!this.profileStale && source === this.profileSource) return false;
    this.profileStale = false;
    this.profileSource = source;
    try {
      this.profile = profileForInstance({
        instance,
        vaultPath: this.vaultRoot(),
        appSupport: appSupportRoot(),
        configuredFolder: this.data_.userDataFolder,
      });
    } catch {
      this.profile = { status: "unavailable", reason: "the lookup failed" };
    }
    return true;
  }

  /** The mirrored profile's `extensions.json` (its own, or Default's for Default and for a profile that reads Default's); null when the profile is unknown. */
  private profileExtensionsFile(build: CodeBuild): string | null {
    return this.profile.status === "resolved" ? profileExtensionsFile(this.profile.profile, build.extensionsDir) : null;
  }

  mirroredProfile(): ProfileState {
    return this.profile;
  }

  /**
   * What the server start reads of desktop VS Code's disabled lists: the instance's own user-data folder (F9),
   * the profile `mirrorProfile` just resolved, and this vault. Nothing can be read when either is unknown.
   */
  private mirrorRequest(instance: Instance): MirrorRequest {
    const found = userDataRootFor({ instance, appSupport: appSupportRoot(), configuredFolder: this.data_.userDataFolder });
    if ("reason" in found) return { unavailable: found.reason };
    const state = this.profile;
    if (state.status === "unavailable") return { unavailable: state.reason };
    if (state.status !== "resolved") return { unavailable: "the profile was not read" };
    const { location, isDefault, dir } = state.profile;
    return { instanceId: instance.id, userDataRoot: found.root, vaultPath: this.vaultRoot(), profile: { location, isDefault, dir } };
  }

  /** The disabled-list read of the last server start, for settings. */
  disabledLists(): MirrorResult | null {
    return this.mirror;
  }

  /**
   * The Extensions list for settings, built now from what the last start read, the plugin's own links and the
   * extension host log (read only; nothing is kept). `server-not-running` unless the server is up, so no state
   * from an earlier run is shown.
   */
  extensionRows(): Promise<ExtensionListView> {
    const server = this.manager.serverInstance;
    return buildExtensionList({
      serverRunning: this.manager.state === "running",
      serverDataDir: server?.serverDataDir ?? null,
      sourceDir: this.lastBuild?.extensionsDir ?? null,
      mirror: this.mirrorCache.current,
      trustSeedOn: this.workbenchSettings().trustVaultFolder,
      trustOutcome: this.lastTrustOutcome,
    });
  }

  /** Shared links whose extension folder has been removed since the last start (E5). Read-only; the next start rebuilds the set. */
  danglingExtensionLinks(): string[] {
    return this.manager.serverInstance?.danglingLinks() ?? [];
  }

  userDataCopy(): UserDataCopy | null {
    return this.copy;
  }

  /**
   * The port a start picked. With no stable port stored yet, the first one picked is stored (it is per vault:
   * data.json lives in this vault's plugin folder). A stored port that could not be used is kept as it is, and
   * the reason is shown in settings.
   */
  private notePort(pick: PortPick): void {
    this.portNote = pick.note;
    if (this.workbenchSettings().stablePort === null) void this.updateSettings({ stablePort: pick.port }).catch(() => undefined);
  }

  // --- SettingsHost -------------------------------------------------------

  workbenchSettings(): WorkbenchSettings {
    return readSettings(this.data_);
  }

  async updateSettings(patch: Partial<WorkbenchSettings>): Promise<void> {
    Object.assign(this.data_, patch);
    this.drawer?.applyVisibility(); // the non-code setting takes effect now, with no reload
    await this.saveData(this.data_);
  }

  portStatus(): PortStatus {
    return { stored: this.workbenchSettings().stablePort, current: this.manager.current?.port ?? null, note: this.portNote };
  }

  spikeResult(): SpikeResult | null {
    return SPIKE_RESULT;
  }

  scanInstances(): Promise<ScanResult> {
    return this.instances.scan(this.workbenchSettings().customCliPath);
  }

  verifyCustomCli(input: string): Promise<CliCheck> {
    return verifyCliPath(input);
  }

  codeCliOverride(): string | undefined {
    return this.data_.codeCliPath || undefined;
  }

  /**
   * Stop the server and start a fresh one (new token; the stable port when it is free, else a new port); open Code tabs
   * reload, and the terminal page reloads and says its terminals were lost. Works from every state, the failed and crashed ones
   * included (they never prompt). Asks first when a running server holds unsaved buffers or live terminal shells (`restartPrompt`).
   * Resolves once running; rejects if it cannot start. Two calls share one restart. A `quiet` caller (the crash banner) shows the
   * failure itself, so a failed restart raises no Notice unless a caller that is not quiet shares it.
   */
  restartServer(opts: { quiet?: boolean } = {}): Promise<void> {
    if (this.restarting) {
      if (!opts.quiet) this.restartFlow.notify = true;
      return this.restarting;
    }
    const flow: StartNotice = { notify: !opts.quiet };
    this.restartFlow = flow;
    const p = (async () => {
      if (this.manager.state === "running") {
        // Both questions are asked once, before the prompt: a server that crashes or a shell that exits while it is open changes
        // nothing about what it says, and confirming still restarts.
        const dirty = (await this.dirtyViews()).map((v) => baseName(v.filePath));
        const shells = await this.liveShellAnswer();
        const prompt = restartPrompt({ state: "running", dirtyFiles: dirty, shells, pageLoaded: this.terminalHost?.ready() ?? false });
        if (prompt && !(await promptRestartWithDirty(this.app, prompt.files, prompt.terminalLine))) return;
      }
      this.profileStale = true; // the user chose to re-read desktop VS Code's state
      try {
        await this.startFlow((o) => this.manager.restart(o), flow);
      } catch (e) {
        if (e instanceof LicenceDeclinedError) return;
        throw e;
      }
    })().finally(() => {
      this.restarting = null;
    });
    this.restarting = p;
    return p;
  }

  /** How many terminal shells live under the server, read from its process tree; "unknown" when the process table cannot be read. */
  private async liveShellAnswer(): Promise<ShellAnswer> {
    const pid = this.manager.serverInstance?.pid;
    if (pid === undefined) return 0;
    try {
      return liveShellPids(await this.processTable(), pid).length;
    } catch {
      return "unknown";
    }
  }

  // --- Unsaved buffers and quit -------------------------------------------

  private async dirtyViews(): Promise<CodeView[]> {
    const views = [...this.views];
    const flags = await Promise.all(views.map((v) => v.isDirty()));
    return views.filter((_, i) => flags[i]);
  }

  private async onQuit(): Promise<void> {
    let dirty = await this.dirtyViews();
    let firstAsk = true;
    while (dirty.length) {
      const names = dirty.map((v) => baseName(v.filePath));
      const choice = firstAsk ? await promptSaveOrDiscard(this.app, names) : await promptSaveFailed(this.app, names);
      // No Cancel here (a deviation from E13's "Cancel aborts the stop"): this is one of Obsidian's quit tasks and
      // Obsidian closes the window once the tasks finish, so a Cancel would not stop the quit; it would destroy the
      // unsaved buffers and stop the server through `pagehide`. The prompt offers only Save and Discard.
      if (choice === "discard") {
        for (const v of dirty) v.abandonRename(); // given up: nothing at a renamed file's old path is moved
        break;
      }
      firstAsk = false;
      await Promise.all(dirty.map((v) => v.saveBuffers()));
      // Ask the tabs again rather than trust the save's answer: whatever is still dirty is never dropped silently.
      dirty = await this.dirtyViews();
    }
    // A rename of a file with edits saved from its tab (Cmd+S, auto-save, the Save above) left them in the old path.
    await Promise.all([...this.views].map((v) => v.settleRename()));
    await this.shutdownAll();
  }

  /**
   * Quit (after its prompts) and the `pagehide` fallback: the terminal page, the server and every shell go, with no prompt. Only
   * Code buffers are ever asked about; shells add nothing. The page is ended first and the manager is told to stop for good
   * (`stopped`, never `crashed`), so nothing shows a banner, reloads onto the dying server or raises an error notice.
   */
  private async shutdownAll(): Promise<void> {
    this.quitting = true;
    this.endTerminalPage();
    await this.manager.shutdown();
  }

  /**
   * Open a file with the system's default app: the licence was declined, the guard refused
   * the file (its notice is already shown), or an extensionless file cannot open in a Code tab.
   */
  openInSystemApp(file: string, why: "licence" | "refused" | "extensionless" = "licence"): void {
    const app = this.app as unknown as { openWithDefaultApp?: (p: string) => unknown };
    const because = why === "licence" ? "licence declined" : why === "refused" ? "file refused" : "extensionless file";
    if (typeof app.openWithDefaultApp === "function") {
      // Logged so a run can see which way the file went (the console shows it; no token is involved).
      console.info(`VS Code Workbench: ${because}; opening ${file} in the system app.`);
      Promise.resolve(app.openWithDefaultApp(file)).catch((e: unknown) => {
        console.warn(`VS Code Workbench: the system app could not open ${file}:`, e instanceof Error ? e.message : e);
        new Notice(`VS Code Workbench: could not open ${file} in your system's app.`);
      });
    } else {
      console.info(`VS Code Workbench: ${because}; this Obsidian cannot open ${file} in the system app.`);
      new Notice(
        why === "licence"
          ? `VS Code Workbench: open ${file} in your system's app; Code tabs are off until the licence is accepted.`
          : `VS Code Workbench: open ${file} in your system's app.`,
      );
    }
  }

  // --- Which files open, one tab per file ---------------------------------

  async admitFile(file: string, leaf: WorkspaceLeaf): Promise<boolean> {
    // Synchronous up to here: the claim is taken before any await.
    const other = this.openFiles.claim(file, leaf);
    if (other) {
      await this.focusLeaf(other);
      return false;
    }
    this.pathTaken(file, leaf); // another tab now shows a file at a path a renamed tab's edits would be carried from
    const kind = decideFile(file).kind;
    if (kind === "never" || kind === "hidden") {
      this.openFiles.release(file, leaf);
      console.info(`VS Code Workbench: ${file} is not opened in a Code tab (${kind}).`);
      return false;
    }
    if (!(await this.fitsInCodeTab(file))) {
      this.openFiles.release(file, leaf);
      return false;
    }
    return true;
  }

  releaseFile(file: string, leaf: WorkspaceLeaf): void {
    this.openFiles.release(file, leaf);
  }

  /** The size and binary guard (E6). A refused file gets a notice and goes to the system app. */
  private async fitsInCodeTab(file: string): Promise<boolean> {
    const result = await checkFile(path.join(this.vaultRoot(), file));
    if (result.ok) return true;
    new Notice(refusalMessage(fileName(file), result), 10000);
    // A file that cannot be read (deleted, say, behind a restored tab) has nothing for the system app to open.
    if (result.reason !== "unreadable") this.openInSystemApp(file, "refused");
    return false;
  }

  private async focusLeaf(leaf: WorkspaceLeaf): Promise<void> {
    await this.app.workspace.revealLeaf(leaf);
    const ws = this.app.workspace as unknown as { setActiveLeaf?: (l: WorkspaceLeaf, o?: { focus: boolean }) => void };
    ws.setActiveLeaf?.(leaf, { focus: true });
  }

  // --- Extension registration (GP1, E7, F8) -------------------------------

  /**
   * Scan the vault folder and register every extension found. Calls that arrive while a scan
   * runs share it and trigger one more pass afterwards, so a file made mid-scan is not missed.
   */
  rescanExtensions(): Promise<void> {
    if (this.scan) {
      this.scanAgain = true;
      return this.scan;
    }
    const run = async () => {
      do {
        this.scanAgain = false;
        await this.scanOnce();
      } while (this.scanAgain && !this.unloaded);
    };
    const p = run().finally(() => {
      if (this.scan === p) this.scan = null;
    });
    this.scan = p;
    return p;
  }

  private async scanOnce(): Promise<void> {
    const excluded = this.workbenchSettings().excludeExtensions;
    try {
      const result = await scanVault(this.vaultRoot(), { excluded, isCancelled: () => this.unloaded });
      if (this.unloaded) return;
      const outcome = this.extensionRegistry.register(result.extensions, excluded);
      this.lastScanAt = Date.now();
      console.info(
        `VS Code Workbench: scanned ${result.files} files (${result.skipped} skipped); found ${result.extensions.length} extensions: ${result.extensions.join(", ") || "none"}`,
      );
      console.info(`VS Code Workbench: registered extensions (${this.extensionRegistry.registered.length}): ${this.extensionRegistry.registered.join(", ")}`);
      if (outcome.refused.length) {
        console.info(`VS Code Workbench: left to other plugins: ${outcome.refused.map((r) => `.${r.extension} (${r.owner})`).join(", ")}`);
      }
    } catch (e) {
      console.warn("VS Code Workbench: the extension scan failed:", e instanceof Error ? e.message : e);
    }
  }

  /** A file was created or renamed: register its extension if it is new. No full scan is needed. */
  private onFileAppeared(file: TAbstractFile): void {
    if (!(file instanceof TFile)) return;
    const extension = extensionOf(file.path);
    const excluded = this.workbenchSettings().excludeExtensions;
    if (extension === "" || this.extensionRegistry.isSettled(extension)) return;
    if (decideFile(file.path, excluded).kind !== "extension") return;
    const outcome = this.extensionRegistry.register([extension], excluded);
    if (outcome.registered.length) {
      console.info(`VS Code Workbench: registered extensions (${this.extensionRegistry.registered.length}): ${this.extensionRegistry.registered.join(", ")}`);
    }
  }

  // --- Spike command ------------------------------------------------------

  /**
   * Which file the ribbon/command opens. Obsidian has no view for `.py` and the
   * like, so such a file can never be the active file: the active file only helps
   * for formats Obsidian itself opens. Order: active file, the hand-edited
   * `spikeFile` in data.json, then the built-in SPIKE_FILE.
   */
  private pickFile(): string | null {
    const active = this.app.workspace.getActiveFile();
    if (active && decideFile(active.path, this.workbenchSettings().excludeExtensions).kind === "extension") return active.path;
    for (const candidate of [this.data_.spikeFile, SPIKE_FILE]) {
      if (!candidate) continue;
      const found = this.findVaultFile(candidate);
      if (found) return found.path;
    }
    return null;
  }

  /** Look a vault path up as typed, then in the other Unicode normal form (macOS stores names decomposed). */
  private findVaultFile(p: string): TFile | null {
    for (const form of [p, p.normalize("NFC"), p.normalize("NFD")]) {
      const f = this.app.vault.getAbstractFileByPath(form);
      if (f instanceof TFile) return f;
    }
    return null;
  }

  async openSpikeFile(): Promise<void> {
    const file = this.pickFile();
    if (!file) {
      new Notice(`VS Code Workbench: open a code file first (or add ${SPIKE_FILE}).`);
      return;
    }
    await this.openCodeFile(file);
  }

  /**
   * Open a file in a Code tab, or focus the one that already shows it (one tab per file; a second
   * call while the first is still opening waits for it). The guard comes first, then the server (and,
   * the first time, the licence modal): a refused file or a failed start leaves no tab, and a declined
   * licence opens the file in the system app instead. `line` (a file opened from the editor at a definition) puts the cursor
   * there, in a new tab and in the tab that already shows the file; zero, negative or non-numeric is line 1, and one past the
   * end of the file is the last line. Without it the cursor stays where VS Code puts it.
   */
  async openCodeFile(file: string, line?: unknown): Promise<void> {
    const at = line === undefined ? null : normalizeLine(line);
    await openCodeTabOnce(this.openFiles, file, at, {
      create: () => this.createCodeTab(file, at),
      focus: (leaf) => this.focusLeaf(leaf),
      placeCursor: (leaf, n) => this.placeCursor(leaf, n),
    });
  }

  /** Put the cursor of the Code tab in `leaf` on `line`; a tab restored from the last session and not loaded yet is loaded first. */
  private async placeCursor(leaf: WorkspaceLeaf, line: number): Promise<void> {
    await (leaf as unknown as { loadIfDeferred?: () => Promise<void> }).loadIfDeferred?.();
    if (leaf.view instanceof CodeView) await leaf.view.goToLine(line);
  }

  private async createCodeTab(file: string, line: number | null = null): Promise<void> {
    const kind = decideFile(file).kind;
    if (kind === "never" || kind === "hidden") {
      new Notice(`VS Code Workbench: ${fileName(file)} is not opened in a Code tab; Obsidian's own view handles it.`);
      return;
    }
    if (!(await this.fitsInCodeTab(file))) return;
    try {
      await this.ensureServer();
    } catch (e) {
      if (e instanceof LicenceDeclinedError) this.openInSystemApp(file);
      return; // any other failure has already been shown in a Notice
    }
    if (this.unloaded) return; // unloaded while the server started: no tab on a plugin that is gone
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_CODE, state: line === null ? { file } : { file, line }, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }
}
