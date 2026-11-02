/**
 * "New terminal at folder", the flow (G8, E1, E2, E8, E10): reveal the drawer, wait for the terminal host page to be ready, then
 * ask the plugin-owned extension for one terminal in the folder. It reuses the reveal path the edge, the command and the hotkey
 * use (`reveal`), and talks to the page on the same server through a request file; it opens no connection and starts nothing.
 *
 * One call is one terminal. Calls in quick succession share the one start of the host (the host page shares a start in flight),
 * and each writes a request of its own, so each gets its terminal in its own folder. A call that finds the host not ready
 * once its start has ended (the licence was declined, or the start failed) asks for nothing: the drawer shows the reason with
 * Retry and the folder is not kept to be replayed after a later Retry.
 *
 * First use (G2): a page made by this call has one terminal of VS Code's own, in the vault root, before the request is
 * read. The call that made the page marks its request `adoptFirst`, and the extension then ends with exactly one terminal,
 * in the chosen folder (see terminal-at-extension.ts for when it agrees to).
 */
import { resolveTerminalFolder } from "./terminal-folder-target";
import { writeTerminalRequest } from "./terminal-at-extension";

export interface NewTerminalDeps {
  /** The vault's base path. */
  vaultRoot(): string;
  /** Open the drawer if it is hidden, or reveal it if it is open, starting the host page on the first reveal. Synchronous. */
  reveal(): void;
  /** Resolves when the start of the host page in flight (if any) has ended, either way. */
  settled(): Promise<void>;
  /** The host page is mounted and showing the terminal. */
  ready(): boolean;
  /** A start of the host page is in flight. */
  starting(): boolean;
  /** Give keyboard focus to the terminal. */
  focusTerminal(): void;
  /** The server's data dir, or null when no server is running. */
  serverDataDir(): string | null;
  /** The plugin has unloaded. */
  unloaded(): boolean;
  notice(message: string): void;
}

export const REQUEST_FAILED_TEXT = "VS Code Workbench: the terminal could not be asked to open in that folder.";

export type NewTerminalResult = "asked" | "not-ready";

/** @param folder the folder's path inside the vault (`""` for the vault root) */
export async function newTerminalAtFolder(deps: NewTerminalDeps, folder: string): Promise<NewTerminalResult> {
  const wasIdle = !deps.ready() && !deps.starting();
  deps.reveal();
  // This call is the one that made the page: VS Code opens its own first terminal in the vault root when the panel comes up,
  // and the request asks the extension to put the chosen folder's terminal in its place. A call that found the page already
  // starting (a second quick choice) or already up leaves every terminal alone and adds one.
  const startedPage = wasIdle && deps.starting();
  await deps.settled();
  if (deps.unloaded() || !deps.ready()) return "not-ready";
  const dataDir = deps.serverDataDir();
  if (dataDir === null) return "not-ready";
  try {
    // The folder is looked at now, when the terminal is made: one deleted or renamed since the menu was built falls back to the vault root.
    writeTerminalRequest(dataDir, { cwd: resolveTerminalFolder(deps.vaultRoot(), folder), adoptFirst: startedPage });
  } catch {
    deps.notice(REQUEST_FAILED_TEXT);
    return "not-ready";
  }
  // The new terminal takes focus inside the page by itself; the page has to hold the keyboard first (the menu click was in Obsidian).
  deps.focusTerminal();
  return "asked";
}
