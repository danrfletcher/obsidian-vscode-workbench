/**
 * The settings this PR adds to `data.json` (G15), read field by field so a
 * corrupt, partial or missing file falls back to defaults and the settings tab
 * still opens. The exclude list is read by the extension scan (PR-4); the
 * non-code drawer toggle (read live by the drawer's visibility rule, G11) and
 * the shell path are stored here for the terminal drawer.
 */
import * as path from "node:path";

export interface WorkbenchSettings {
  /** The instance Dan picked (an id from the scan, or "custom"); null = use the default. */
  instanceId: string | null;
  /** A custom CLI path that passed the probe when it was verified; null = none. */
  customCliPath: string | null;
  /** File extensions kept out of Code tabs: lowercase, no dot, no duplicates. */
  excludeExtensions: string[];
  /** Show the terminal drawer over notes and other non-code views. Default on. */
  nonCodeDrawer: boolean;
  /** The shell the drawer starts; "" = the default (`$SHELL`, else `/bin/zsh`). */
  shellPath: string;
  /**
   * The loopback port this vault's VS Code server tries first, so the workbench's origin (and anything the
   * browser stores per origin) can stay the same across restarts. null = none stored yet: the first start
   * takes a free port and stores it. Only a whole number from 1024 to 65535 counts; anything else reads as null.
   */
  stablePort: number | null;
  /**
   * Seed VS Code's Workspace Trust record for the vault folder (and only that folder) at every tab load, so
   * extensions run without the Restricted Mode banner. Default on. Off: nothing is seeded and the workbench
   * shows the banner; a record that is already stored is left alone.
   */
  trustVaultFolder: boolean;
}

export const DEFAULT_SETTINGS: Readonly<WorkbenchSettings> = {
  instanceId: null,
  customCliPath: null,
  excludeExtensions: [],
  nonCodeDrawer: true,
  shellPath: "",
  stablePort: null,
  trustVaultFolder: true,
};

export const MIN_STABLE_PORT = 1024;
export const MAX_STABLE_PORT = 65535;

export const FALLBACK_SHELL = "/bin/zsh";

/** The default shell: `$SHELL` when it is an absolute path, else `/bin/zsh`. */
export function defaultShell(env: NodeJS.ProcessEnv = process.env): string {
  const s = env.SHELL?.trim();
  return s && path.isAbsolute(s) ? s : FALLBACK_SHELL;
}

/** The shell to use: the stored one, or the default. */
export function effectiveShell(settings: Pick<WorkbenchSettings, "shellPath">, env: NodeJS.ProcessEnv = process.env): string {
  return settings.shellPath.trim() || defaultShell(env);
}

export type ExtensionResult = { ok: true; value: string } | { ok: false; reason: string };

/** Normalise one typed extension: trimmed, lowercased, a leading dot stripped. */
export function normaliseExtension(input: string): ExtensionResult {
  let v = input.trim().toLowerCase();
  if (v.startsWith(".")) v = v.slice(1);
  if (v === "") return { ok: false, reason: "Enter a file extension, for example py." };
  if (v.includes("/")) return { ok: false, reason: `"${v}" has a slash; enter only the extension, for example py.` };
  if (/\s/.test(v)) return { ok: false, reason: `"${v}" has a space; an extension has no spaces.` };
  return { ok: true, value: v };
}

/** Add one typed extension to a list: the new list (de-duplicated), or the reason it was rejected. */
export function addExtension(list: readonly string[], input: string): { ok: true; list: string[]; added: boolean } | { ok: false; reason: string } {
  const r = normaliseExtension(input);
  if (!r.ok) return r;
  if (list.includes(r.value)) return { ok: true, list: [...list], added: false };
  return { ok: true, list: [...list, r.value], added: true };
}

/** A stored list: every entry normalised, bad entries and duplicates dropped, order kept. */
export function normaliseExtensionList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const r = normaliseExtension(item);
    if (r.ok && !out.includes(r.value)) out.push(r.value);
  }
  return out;
}

function stringOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/** A stored port: a whole number in 1024..65535, else null (missing, a string, a fraction, out of range). */
export function portOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= MIN_STABLE_PORT && v <= MAX_STABLE_PORT ? v : null;
}

/** The settings out of whatever `loadData()` returned. Never throws. */
export function readSettings(raw: unknown): WorkbenchSettings {
  const o: Record<string, unknown> = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    instanceId: stringOrNull(o.instanceId),
    customCliPath: stringOrNull(o.customCliPath),
    excludeExtensions: normaliseExtensionList(o.excludeExtensions),
    nonCodeDrawer: typeof o.nonCodeDrawer === "boolean" ? o.nonCodeDrawer : DEFAULT_SETTINGS.nonCodeDrawer,
    shellPath: typeof o.shellPath === "string" ? o.shellPath.trim() : DEFAULT_SETTINGS.shellPath,
    stablePort: portOrNull(o.stablePort),
    trustVaultFolder: typeof o.trustVaultFolder === "boolean" ? o.trustVaultFolder : DEFAULT_SETTINGS.trustVaultFolder,
  };
}

/** The data object out of `loadData()`: a plain object, else an empty one. */
export function dataObject(raw: unknown): Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
}
