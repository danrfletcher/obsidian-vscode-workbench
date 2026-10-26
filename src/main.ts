import { FileSystemAdapter, Notice, Plugin, TFile, type TAbstractFile, type Tasks, type WorkspaceLeaf } from "obsidian";
import { randomBytes } from "node:crypto";
import * as path from "node:path";
import { checkFile, refusalMessage } from "./binary-guard";
import { ChildRegistry } from "./child-registry";
import { ownerOfExtension, type ViewRegistryLike } from "./coexistence";
import { CodeView, VIEW_TYPE_CODE, baseName, type CodeViewHost, type EmbedElement } from "./code-view";
import { ExtensionRegistry } from "./extension-registry";
import { scanVault } from "./extension-scan";
import { createClickInterceptor, readMode, type ClickLike, type ExtensionlessMode } from "./extensionless-intercept";
import { describeFailure, type StartFailure } from "./failure-messages";
import { IdleTimer } from "./idle-timer";
import { LicenceDeclinedError, LicenceGate } from "./licence";
import { promptLicence, promptRestartWithDirty, promptReuseBuild, promptSaveFailed, promptSaveOrDiscard } from "./modals";
import { OpenFiles } from "./open-file";
import { PidFile, sweepOrphans } from "./pidfile";
import {
  ServerStartError,
  StartCancelledError,
  WorkbenchServer,
  cachedServerCommits,
  checkServeWebSupport,
  findNewestBuild,
  removePartialDownloads,
  type CodeBuild,
  type RunningServer,
} from "./server";
import { ServerManager, type ServerState, type StartOptions } from "./server-manager";
import { chooseInstance } from "./instances/choose";
import { verifyCliPath, type CliCheck } from "./instances/probe";
import { appSupportRoot, describeCustom, type Instance, type ScanResult } from "./instances/scan";
import { InstanceService } from "./instances/service";
import { instanceUserDir, seedUserData } from "./server/user-data-seed";
import { dataObject, readSettings, type WorkbenchSettings } from "./settings/data";
import { WorkbenchSettingTab, type SettingsHost } from "./settings/settings-tab";
import { writeMachineSettings, type UserDataCopy } from "./settings";
import { decideFile, extensionOf, fileName } from "./text-file-rules";

/** Spike: opened by the ribbon icon when the active file is not a code file. */
export const SPIKE_FILE = "AWS SA Associate Mock Exams/scripts/estimate_time.py";

/** The least time between two rescans triggered by the window regaining focus (files made outside Obsidian). */
const FOCUS_RESCAN_MS = 30_000;

interface WorkbenchData extends Partial<WorkbenchSettings> {
  /** Hand-edited; path to a `code` CLI. When set it overrides the instance chosen in the settings tab. */
  codeCliPath?: string;
  /** Hand-edited; vault-relative file the ribbon opens when no openable active file exists. */
  spikeFile?: string;
  /** Hand-edited; what a click on an extensionless file does: "intercept" (Code tab, the default) or "system-app". */
  extensionlessMode?: ExtensionlessMode;
  embed?: EmbedElement;
  /** The VS Code server licence was accepted (the modal at the first Code-tab open). Never holds a token. */
  serverLicenceAccepted?: boolean;
  /** The last server build that started: lets an offline re-download after a VS Code update name the change. */
  lastServer?: { commit: string; version: string };
}

export default class VSCodeWorkbenchPlugin extends Plugin implements CodeViewHost, SettingsHost {
  private views = new Set<CodeView>();
  private openFiles = new OpenFiles<WorkspaceLeaf>(() => this.app.workspace.getLeavesOfType(VIEW_TYPE_CODE));
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
  private restarting: Promise<void> | null = null;
  private lastBuild: CodeBuild | null = null;
  /** The instance's settings and keybindings as copied at the last server start; the Code tab seeds its browser profile from it. */
  private copy: UserDataCopy | null = null;
  private instances = new InstanceService();
  private cachedBefore: ReadonlySet<string> = new Set();
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
      onIdle: () => this.manager.stop("idle"),
    });
    this.manager.onChange((state) => {
      if (state === "running") this.idle.start();
      else this.idle.stop();
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

    // Theme follows Obsidian light/dark: rewrite the machine settings and reload open tabs.
    this.registerEvent(
      this.app.workspace.on("css-change", () => {
        const server = this.manager.serverInstance;
        if (this.manager.state !== "running" || !server) return;
        writeMachineSettings(server.serverDataDir, { dark: this.isDark() });
        for (const v of this.views) v.reload();
      }),
    );
    // A tab shown, hidden or closed changes what the idle clock sees; a tab left behind by an idle stop wakes the server.
    const visibilityChanged = () => {
      for (const v of this.views) v.notifyVisible();
      void this.idle.evaluate();
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
      void this.manager.shutdown();
    });

    // Every extension found in the vault is registered against the Code tab, now and as new files appear (GP1).
    // All of it waits for layout-ready, when every community plugin has loaded: registering earlier would take
    // an extension before Code Files, VSCode Editor or Code Workbench had registered it, and their own
    // registerExtensions call would then throw and abort their onload (F8). Obsidian also fires "create" once
    // per existing file while the vault loads, which would register everything early the same way.
    // The scan runs in the background in small slices; nothing waits for it.
    this.app.workspace.onLayoutReady(() => {
      if (this.unloaded) return;
      this.registerEvent(this.app.vault.on("create", (f) => this.onFileAppeared(f)));
      this.registerEvent(this.app.vault.on("rename", (f) => this.onFileAppeared(f)));
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
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_CODE);
    this.idle?.stop();
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

  private isDark(): boolean {
    return document.body.classList.contains("theme-dark");
  }

  /** The plugin-owned runtime dir: token file, server data, CLI data, pidfile. */
  private runtimeDir(): string {
    const manifestDir = this.manifest.dir ?? path.join(this.app.vault.configDir, "plugins", this.manifest.id);
    return path.join(this.vaultRoot(), manifestDir, ".server");
  }

  // --- Starting the server ------------------------------------------------

  /**
   * The running server, starting it first if needed. The first call ever asks
   * for the licence; nothing is downloaded before it is accepted. Callers that
   * arrive while it starts share one start, one licence modal and one failure
   * notice. Rejects with LicenceDeclinedError if the licence was declined, or
   * with the start error (already shown in a Notice) if the server failed.
   */
  ensureServer(): Promise<RunningServer> {
    const running = this.manager.current;
    if (running) return Promise.resolve(running);
    if (!this.serverRequest) {
      const p: Promise<RunningServer> = this.startFlow((o) => this.manager.ensureStarted(o)).finally(() => {
        if (this.serverRequest === p) this.serverRequest = null;
      });
      this.serverRequest = p;
    }
    return this.serverRequest;
  }

  private async startFlow(start: (o?: StartOptions) => Promise<RunningServer>): Promise<RunningServer> {
    if (!(await this.gate.request())) throw new LicenceDeclinedError();
    try {
      const running = await start();
      await this.recordLastServer();
      return running;
    } catch (e) {
      if (e instanceof StartCancelledError) throw e;
      const failure = this.reportFailure(e);
      if (failure.offerReuse && failure.versionChange && (await promptReuseBuild(this.app, failure.versionChange))) {
        try {
          // The reused build is not recorded as the last server: it is the old one.
          return await this.manager.ensureStarted({ commitOverride: failure.offerReuse.commit });
        } catch (e2) {
          if (!(e2 instanceof StartCancelledError)) this.reportFailure(e2);
          throw e2;
        }
      }
      throw e;
    }
  }

  /** Show the Notice for a failed start (token-free) and clear any half-downloaded server. */
  private reportFailure(e: unknown): StartFailure {
    const cliDataDir = path.join(this.runtimeDir(), "cli-data");
    const last = this.data_.lastServer ?? null;
    const failure = describeFailure(e, {
      installedVersion: this.lastBuild?.versionText,
      installedCommit: this.lastBuild?.commit ?? null,
      lastServer: last,
      lastServerCached: last ? cachedServerCommits(cliDataDir).has(last.commit) : false,
    });
    if (failure.kind === "offline-first-run" || failure.kind === "offline-redownload" || failure.kind === "download") {
      removePartialDownloads(cliDataDir, this.cachedBefore);
    }
    new Notice(failure.message, 15000);
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
    const chosen = await this.instanceForStart();
    const build = chosen ? findNewestBuild({ override: chosen.cli }) : null;
    if (!chosen || !build) throw new ServerStartError("No VS Code installation found.", null, "", { kind: "missing-binary" });
    const support = await checkServeWebSupport(build.cli);
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
    const server = new WorkbenchServer({
      build: o.commitOverride ? { ...build, commit: o.commitOverride } : build,
      runtimeDir,
      acceptLicense: true,
      disableTelemetry: support.disableTelemetry,
      registry: this.registry,
      workspace: this.vaultRoot(),
      downloadHostReachable: this.downloadHostReachable,
    });
    writeMachineSettings(server.serverDataDir, { dark: this.isDark() });
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
    const scan = await this.scanInstances();
    return chooseInstance(scan, this.workbenchSettings().instanceId).selected;
  }

  /** At each start: copy the instance's settings and keybindings one way into the user-data dir, excludes on top (G16, G17). */
  private seedUserData(userDataDir: string, instance: Instance): void {
    try {
      const result = seedUserData({ userDataDir, sourceUserDir: instanceUserDir(instance.userDataName, appSupportRoot()) });
      if (result.notice) new Notice(`VS Code Workbench: ${result.notice}`, 10000);
      this.copy = { id: randomBytes(8).toString("hex"), settings: result.merged, keybindingsBase64: result.keybindingsBase64 };
    } catch {
      this.copy = null;
      new Notice("VS Code Workbench: could not copy the instance's settings, so the editor starts without them.", 10000);
    }
  }

  userDataCopy(): UserDataCopy | null {
    return this.copy;
  }

  // --- SettingsHost -------------------------------------------------------

  workbenchSettings(): WorkbenchSettings {
    return readSettings(this.data_);
  }

  async updateSettings(patch: Partial<WorkbenchSettings>): Promise<void> {
    Object.assign(this.data_, patch);
    await this.saveData(this.data_);
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
   * Stop the server and start a fresh one (new port, new token); open Code tabs
   * reload. Works from every state, the failed one included. Asks first when a
   * running server holds unsaved buffers. Resolves once running; rejects if it cannot start.
   */
  restartServer(): Promise<void> {
    if (this.restarting) return this.restarting;
    const p = (async () => {
      if (this.manager.state === "running") {
        const dirty = (await this.dirtyViews()).map((v) => baseName(v.filePath));
        if (dirty.length && !(await promptRestartWithDirty(this.app, dirty))) return;
      }
      try {
        await this.startFlow((o) => this.manager.restart(o));
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
      if (choice === "discard") break;
      firstAsk = false;
      await Promise.all(dirty.map((v) => v.saveBuffers()));
      // Ask the tabs again rather than trust the save's answer: whatever is still dirty is never dropped silently.
      dirty = await this.dirtyViews();
    }
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
   * licence opens the file in the system app instead.
   */
  async openCodeFile(file: string): Promise<void> {
    await this.openFiles.openOnce(
      file,
      () => this.createCodeTab(file),
      (leaf) => this.focusLeaf(leaf),
    );
  }

  private async createCodeTab(file: string): Promise<void> {
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
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_CODE, state: { file }, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }
}
