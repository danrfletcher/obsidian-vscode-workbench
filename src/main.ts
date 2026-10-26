import { FileSystemAdapter, Notice, Plugin, TFile } from "obsidian";
import * as path from "node:path";
import { CodeView, VIEW_TYPE_CODE, type CodeViewHost, type EmbedElement } from "./code-view";
import { writeMachineSettings } from "./settings";
import {
  DEV_ACCEPT_SERVER_LICENSE,
  ServerStartError,
  WorkbenchServer,
  checkServeWebSupport,
  findNewestBuild,
  redactToken,
  type RunningServer,
} from "./server";

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
}

export default class VSCodeWorkbenchPlugin extends Plugin implements CodeViewHost {
  private server: WorkbenchServer | null = null;
  private views = new Set<CodeView>();
  private data_: WorkbenchData = {};

  async onload(): Promise<void> {
    this.data_ = ((await this.loadData()) as WorkbenchData | null) ?? {};

    this.registerView(VIEW_TYPE_CODE, (leaf) => new CodeView(leaf, this));
    this.addRibbonIcon("code-2", "Open in VS Code", () => void this.openSpikeFile());
    this.addCommand({
      id: "open-spike-file",
      name: "Open spike file in Code tab",
      callback: () => void this.openSpikeFile(),
    });

    // Theme follows Obsidian light/dark: rewrite the machine settings and reload open tabs.
    this.registerEvent(
      this.app.workspace.on("css-change", () => {
        if (!this.server) return;
        writeMachineSettings(this.server.serverDataDir, { dark: this.isDark() });
        for (const v of this.views) v.reload();
      }),
    );
    // Quitting Obsidian: take the server down with the window.
    this.registerDomEvent(window, "beforeunload", () => void this.server?.stop());
  }

  onunload(): void {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_CODE);
    // stop() sends its kill signals synchronously; unload does not wait for the exit.
    void this.server?.stop();
    this.server = null;
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
  }

  untrackView(view: CodeView): void {
    this.views.delete(view);
  }

  private isDark(): boolean {
    return document.body.classList.contains("theme-dark");
  }

  /** Start the one shared server (first call) or return it. Failures show a token-free Notice. */
  async ensureServer(): Promise<RunningServer> {
    try {
      if (!this.server) this.server = await this.createServer();
      return await this.server.ensureStarted();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      new Notice(`VS Code Workbench: ${redactToken(msg, null)}`, 15000);
      throw e;
    }
  }

  private async createServer(): Promise<WorkbenchServer> {
    const build = findNewestBuild({ override: this.data_.codeCliPath });
    if (!build) throw new Error("No VS Code installation found.");
    const support = await checkServeWebSupport(build.cli);
    if (!support.serveWeb) throw new ServerStartError(`${build.cli} has no "serve-web" command.`, null, "");
    const manifestDir = this.manifest.dir ?? path.join(this.app.vault.configDir, "plugins", this.manifest.id);
    const runtimeDir = path.join(this.vaultRoot(), manifestDir, ".server");
    const server = new WorkbenchServer({
      build,
      runtimeDir,
      acceptLicense: DEV_ACCEPT_SERVER_LICENSE,
      disableTelemetry: support.disableTelemetry,
    });
    writeMachineSettings(server.serverDataDir, { dark: this.isDark() });
    return server;
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
    try {
      await this.ensureServer();
    } catch {
      return; // Notice already shown
    }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_CODE, state: { file }, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }
}
