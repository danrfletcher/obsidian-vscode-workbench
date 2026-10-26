import { FileSystemAdapter, Notice, Plugin, TFile, type Tasks } from "obsidian";
import * as path from "node:path";
import { ChildRegistry } from "./child-registry";
import { CodeView, VIEW_TYPE_CODE, baseName, type CodeViewHost, type EmbedElement } from "./code-view";
import { describeFailure, type StartFailure } from "./failure-messages";
import { IdleTimer } from "./idle-timer";
import { LicenceDeclinedError, LicenceGate } from "./licence";
import { promptLicence, promptRestartWithDirty, promptReuseBuild, promptSaveFailed, promptSaveOrDiscard } from "./modals";
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
import { WorkbenchSettingTab } from "./settings-tab";
import { writeMachineSettings } from "./settings";

/** Spike: opened by the ribbon icon when the active file is not a code file. */
export const SPIKE_FILE = "AWS SA Associate Mock Exams/scripts/estimate_time.py";

/** Never opened in a Code tab (F6, and Obsidian's own formats). */
const NOT_CODE = new Set(["md", "canvas", "base"]);

interface WorkbenchData {
  /** Hand-edited; path to a `code` CLI. Default: newest VS Code build found. */
  codeCliPath?: string;
  /** Hand-edited; vault-relative file the ribbon opens when no openable active file exists. */
  spikeFile?: string;
  embed?: EmbedElement;
  /** The VS Code server licence was accepted (the modal at the first Code-tab open). Never holds a token. */
  serverLicenceAccepted?: boolean;
  /** The last server build that started: lets an offline re-download after a VS Code update name the change. */
  lastServer?: { commit: string; version: string };
}

export default class VSCodeWorkbenchPlugin extends Plugin implements CodeViewHost {
  private views = new Set<CodeView>();
  private data_: WorkbenchData = {};
  private registry = new ChildRegistry(null);
  private manager!: ServerManager;
  private gate!: LicenceGate;
  private idle!: IdleTimer;
  private serverRequest: Promise<RunningServer> | null = null;
  private restarting: Promise<void> | null = null;
  private lastBuild: CodeBuild | null = null;
  private cachedBefore: ReadonlySet<string> = new Set();
  /** Tests only: replaces the reachability check that turns a failed download into "the network is unreachable". */
  private downloadHostReachable?: () => Promise<boolean>;

  async onload(): Promise<void> {
    this.data_ = ((await this.loadData()) as WorkbenchData | null) ?? {};

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
  }

  onunload(): void {
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
    const build = findNewestBuild({ override: this.data_.codeCliPath });
    if (!build) throw new ServerStartError("No VS Code installation found.", null, "", { kind: "missing-binary" });
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
    return server;
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

  /** Open a file with the system's default app (the licence was declined). */
  openInSystemApp(file: string): void {
    const app = this.app as unknown as { openWithDefaultApp?: (p: string) => unknown };
    if (typeof app.openWithDefaultApp === "function") {
      // Logged so a run can see which way the file went (the console shows it; no token is involved).
      console.info(`VS Code Workbench: licence declined; opening ${file} in the system app.`);
      Promise.resolve(app.openWithDefaultApp(file)).catch((e: unknown) => {
        console.warn(`VS Code Workbench: the system app could not open ${file}:`, e instanceof Error ? e.message : e);
        new Notice(`VS Code Workbench: could not open ${file} in your system's app.`);
      });
    } else {
      console.info(`VS Code Workbench: licence declined; this Obsidian cannot open ${file} in the system app.`);
      new Notice(`VS Code Workbench: open ${file} in your system's app; Code tabs are off until the licence is accepted.`);
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
    if (active && !NOT_CODE.has(active.extension.toLowerCase())) return active.path;
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
   * Open a file in a Code tab. The server (and, the first time, the licence
   * modal) comes first: a failed start leaves no tab, and a declined licence
   * opens the file in the system app instead.
   */
  async openCodeFile(file: string): Promise<void> {
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
