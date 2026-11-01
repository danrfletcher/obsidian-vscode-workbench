/**
 * What the terminal host page loads, from PR-1's recipe (docs/terminal-spike.md, S1): the ordinary workbench page of the
 * same `code serve-web` server (F3), on the vault folder, in a webview partition of its own (F5), with the plugin's Code
 * tab browser settings plus `workbench.panel.opensMaximized: always` and the setting the terminal-at extension reads.
 * The panel-only layout itself comes from two key presses (see panel-only.ts); no URL parameter does it.
 */
import { BROWSER_APP_SETTINGS } from "../settings";
import { buildFolderUrl } from "../paths";

/**
 * The host page's own browser profile. It must never equal the Code tabs' partition (`CODE_TAB_PARTITION`): the panel
 * layout the host page keeps would otherwise show in Code tabs (F5).
 */
export const TERMINAL_PARTITION = "persist:vscode-workbench-terminal";

/** Read by the plugin-owned terminal-at extension (PR-5): it acts only in a page whose profile carries this. */
export const TERMINAL_PAGE_SETTING = "obsidianWorkbench.terminalPage";

/** Settings the host page has and a Code tab does not (S1, S2). */
export const PANEL_SETTINGS: Readonly<Record<string, unknown>> = {
  "workbench.panel.opensMaximized": "always",
  "workbench.startupEditor": "none",
  [TERMINAL_PAGE_SETTING]: true,
};

/** The settings laid over the browser profile at every load of the host page: the Code tab's switches, its theme and chrome overlay, then the panel ones. */
export function hostSettings(overlay: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return { ...BROWSER_APP_SETTINGS, ...overlay, ...PANEL_SETTINGS };
}

/** The server's bare origin: loaded first so the settings can be written into the partition's profile, with no token in it. */
export function hostOriginUrl(baseUrl: string): string {
  return `${baseUrl}/`;
}

/** The workbench page on the vault root. The token is the caller's secret: keep this URL out of text, notices and logs. */
export function buildTerminalHostUrl(baseUrl: string, vaultRoot: string, token?: string): string {
  return buildFolderUrl(baseUrl, vaultRoot, token);
}
