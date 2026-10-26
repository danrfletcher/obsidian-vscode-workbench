/**
 * Extensionless files and dotfiles (Makefile, Dockerfile, .env, .gitignore), G7.
 *
 * Obsidian opens files by extension, and a file with none has nothing to
 * register. So this is best effort: a capture-phase click listener on the file
 * explorer's file rows. A click on a row whose path has no usable extension is
 * taken over and opened in a Code tab.
 *
 * Limits (also in the README): it only sees clicks on rows Obsidian draws. With
 * "Detect all file extensions" off, Obsidian does not list an extensionless file,
 * and it never lists dotfiles, so for those there is no row to click.
 *
 * The mode is the spike decision (`docs/spike-decision.md`, header key
 * `extensionless`): `intercept` opens a Code tab; `system-app` is the fallback
 * for when interception does not work, which hands the file to the system app
 * with a notice instead of leaving a blank tab. A Code tab that cannot open also
 * falls back to the system app.
 */
import { decideFile } from "./text-file-rules";

export type ExtensionlessMode = "intercept" | "system-app";

/** The default mode. `docs/spike-decision.md` records the same value in its header (a test keeps the two equal). */
export const DEFAULT_EXTENSIONLESS_MODE: ExtensionlessMode = "intercept";

export function readMode(value: unknown): ExtensionlessMode {
  return value === "system-app" || value === "intercept" ? value : DEFAULT_EXTENSIONLESS_MODE;
}

/** The file explorer's clickable row. */
export const FILE_ROW_SELECTOR = ".nav-file-title[data-path]";

/** The part of a DOM click event the interceptor uses. */
export interface ClickLike {
  button: number;
  target: unknown;
  preventDefault(): void;
  stopPropagation(): void;
}

interface RowLike {
  closest?(selector: string): { getAttribute(name: string): string | null } | null;
}

export interface InterceptHost {
  mode(): ExtensionlessMode;
  excluded(): readonly string[];
  /** Open the file in a Code tab. Rejects when it cannot. */
  openInCodeTab(vaultPath: string): Promise<void>;
  openInSystemApp(vaultPath: string): void;
  notice(message: string): void;
}

/** The vault path of the explorer row a click landed in, or null. */
export function rowPath(target: unknown): string | null {
  const row = (target as RowLike | null)?.closest?.(FILE_ROW_SELECTOR);
  const p = row?.getAttribute("data-path");
  return p ? p : null;
}

export const SYSTEM_APP_NOTICE =
  "VS Code Workbench: this file has no extension, so it cannot open in a Code tab here; opening it in your system's app instead.";

/** Returns the click handler. A click it does not handle is left to Obsidian untouched. */
export function createClickInterceptor(host: InterceptHost): (ev: ClickLike) => void {
  return (ev) => {
    if (ev.button !== 0) return;
    const p = rowPath(ev.target);
    if (!p || decideFile(p, host.excluded()).kind !== "extensionless") return;

    ev.preventDefault();
    ev.stopPropagation();

    const fallback = () => {
      host.notice(SYSTEM_APP_NOTICE);
      host.openInSystemApp(p);
    };
    if (host.mode() === "system-app") return fallback();
    host.openInCodeTab(p).catch(fallback);
  };
}
