/** The Code tab: one Obsidian tab hosting the VS Code web workbench for one file. */
import { ItemView, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { buildFileUrl } from "./paths";
import type { RunningServer } from "./server";
import { buildBrowserSeedScript } from "./settings";

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
}

interface CodeViewState {
  file?: string;
  [key: string]: unknown;
}

/** The part of Electron's <webview> element the seeding step uses. */
interface WebviewLike extends HTMLElement {
  executeJavaScript?: (code: string) => Promise<unknown>;
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

  getState(): CodeViewState {
    // Only the vault-relative path is persisted. The token never goes into view state.
    return { file: this.file };
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const file = (state as CodeViewState | null)?.file;
    if (typeof file === "string" && file) {
      this.file = file;
      (this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
      await this.loadWorkbench();
    }
    await super.setState(state, result);
  }

  async onOpen(): Promise<void> {
    this.host.trackView(this);
    this.contentEl.addClass("vscode-workbench-view");
    this.contentEl.style.padding = "0";
    this.contentEl.style.overflow = "hidden";
  }

  async onClose(): Promise<void> {
    this.host.untrackView(this);
    this.frame?.remove();
    this.frame = null;
  }

  /** Reload the embedded workbench (used after a theme change). */
  reload(): void {
    const f = this.frame as (HTMLElement & { reload?: () => void }) | null;
    if (!f) return;
    if (typeof f.reload === "function") f.reload();
    else void this.loadWorkbench();
  }

  private async loadWorkbench(): Promise<void> {
    this.contentEl.empty();
    this.frame = null;
    try {
      const server = await this.host.ensureServer();
      const url = buildFileUrl(server.baseUrl, this.host.vaultRoot(), this.file, server.token);
      const el = document.createElement(this.host.embedElement());
      const isWebview = this.host.embedElement() === "webview";
      if (isWebview) {
        el.setAttribute("partition", "persist:vscode-workbench");
        el.setAttribute("allowpopups", "");
      }
      el.style.width = "100%";
      el.style.height = "100%";
      el.style.border = "0";
      // The application-scoped off switches (extension updates, experiments,
      // telemetry) are only read from the browser profile, so a webview first
      // loads the server's origin (no workbench), has them written into that
      // profile, and only then navigates to the workbench.
      el.setAttribute("src", isWebview ? `${server.baseUrl}/` : url);
      this.contentEl.appendChild(el);
      this.frame = el;
      if (isWebview) {
        await runInWebview(el as WebviewLike, buildBrowserSeedScript());
        if (this.frame === el) el.setAttribute("src", url);
      }
    } catch {
      // main.ts has already shown the Notice with the (token-free) reason.
      this.contentEl.createDiv({ text: "VS Code server is not running. Run \"Open spike file in Code tab\" to retry." });
    }
  }
}
