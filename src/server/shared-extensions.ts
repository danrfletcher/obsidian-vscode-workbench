/**
 * Which extensions the server shares (PR-5, G1, G2, G10): exactly the ones the mirrored profile lists in its
 * `extensions.json` and desktop VS Code has not switched off, read once per Restart server or Obsidian start.
 *
 *   profile's extensions.json  -  the combined disabled lists (src/mirror/)  =  the shared set
 *
 * This file only reads: the profile's `extensions.json` once, and, when the links are built, whether each
 * extension's folder is there (F1). The links and the rewritten `extensions.json` are made in the plugin's own
 * server data dir by `shareExtensions` (src/server.ts). Nothing here installs, updates or switches an extension
 * (F2), and nothing watches a file (F7): the callers are the start paths and nothing else.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { MirrorResult } from "../mirror/mirror";
import type { MirroredProfile } from "../profile/mirrored-profile";

/** The name of the list a profile (and the instance's extensions folder, for Default) keeps. */
export const EXTENSIONS_LIST_FILE = "extensions.json";

/** One entry of the profile's list that can be shared. */
export interface ProfileExtension {
  /** `publisher.name`, lower case: ids compare case-insensitively. */
  id: string;
  /** The folder name in the instance's extensions folder (`publisher.name-1.2.3`): the version the profile lists. */
  folder: string;
  /** The entry as the profile wrote it; `rewriteExtensionsJson` moves its `location` to the link. */
  entry: Record<string, unknown>;
}

export type ProfileExtensions = { ok: true; extensions: ProfileExtension[] } | { ok: false; why: string };

/**
 * What one read of desktop VS Code gave: the disabled lists and the profile's extension list. Kept in memory by the
 * plugin, so an idle restart builds its links from it without a second read.
 */
export interface MirrorState {
  disabled: MirrorResult;
  extensions: ProfileExtensions;
}

/**
 * The plugin's memory of the last read (G2): a start shares from it instead of reading again, unless something asked
 * for a new read. Only Obsidian start (nothing held yet) and Restart server (`reread`) ask; an idle restart does not,
 * so desktop VS Code's state is never re-read behind the user's back, and never by a watcher or a timer (F7).
 */
export class MirrorStateCache {
  private held: { key: string; state: MirrorState } | null = null;

  /**
   * The state a start for `key` should share from, or null when it must read. `key` names what the state is for (the
   * instance's user-data folder, the profile, its extension list); a start for anything else reads again, and
   * forgets what it held.
   */
  forStart(key: string, reread: boolean): MirrorState | null {
    if (reread || this.held === null || this.held.key !== key) {
      this.held = null;
      return null;
    }
    return this.held.state;
  }

  /** Keep what a read produced, for the starts after it. */
  keep(key: string, state: MirrorState): void {
    this.held = { key, state };
  }

  /** What is held, if anything (settings reads the disabled lists from the plugin, not from here). */
  get current(): MirrorState | null {
    return this.held?.state ?? null;
  }
}

/** Where the mirrored profile's `extensions.json` is: its own folder, or (Default, or a flagged profile) the instance's extensions folder. */
export function profileExtensionsFile(profile: Pick<MirroredProfile, "files">, extensionsDir: string | null): string | null {
  const source = profile.files.extensions;
  if (source.from === "default" || source.dir === null) return extensionsDir ? path.join(extensionsDir, EXTENSIONS_LIST_FILE) : null;
  return path.join(source.dir, EXTENSIONS_LIST_FILE);
}

/** A folder name that is one plain, visible path segment: it is joined onto two paths, so it can never climb out of them. */
function plainFolderName(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && !name.startsWith(".") && !/[\\/\0]/.test(name) && name !== EXTENSIONS_LIST_FILE;
}

/** The extension folder an entry names: `relativeLocation`, else the last segment of `location`. Same rule as `rewriteExtensionsJson`. */
function folderOf(entry: Record<string, unknown>): string | null {
  const loc = entry.location;
  const locPath = typeof loc === "object" && loc !== null ? (loc as { path?: unknown }).path : typeof loc === "string" ? loc : undefined;
  const rel = typeof entry.relativeLocation === "string" ? entry.relativeLocation : typeof locPath === "string" ? path.posix.basename(locPath) : undefined;
  return rel !== undefined && plainFolderName(rel) ? rel : null;
}

/** Parse the text of a profile's `extensions.json`. Entries with no id or no usable folder name are left out. */
export function parseProfileExtensions(text: string): ProfileExtensions {
  let json: unknown;
  try {
    json = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return { ok: false, why: "the profile's extension list is not valid JSON" }; // never quote the text
  }
  if (!Array.isArray(json)) return { ok: false, why: "the profile's extension list is not a JSON array" };
  const extensions: ProfileExtension[] = [];
  for (const item of json) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    const identifier = entry.identifier;
    const rawId = typeof identifier === "object" && identifier !== null ? (identifier as { id?: unknown }).id : undefined;
    const folder = folderOf(entry);
    if (typeof rawId !== "string" || rawId.trim() === "" || folder === null) continue;
    extensions.push({ id: rawId.trim().toLowerCase(), folder, entry });
  }
  return { ok: true, extensions };
}

export interface ProfileExtensionsFs {
  readFileSync(file: string, encoding: "utf8"): string;
}

/** Read the profile's `extensions.json` once. Never throws: a file that cannot be read is an answer (nothing is shared). */
export function readProfileExtensions(file: string | null, io: ProfileExtensionsFs = fs): ProfileExtensions {
  if (file === null) return { ok: false, why: "the profile's extension list cannot be located" };
  let text: string;
  try {
    text = io.readFileSync(file, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException | null)?.code;
    return { ok: false, why: code === "ENOENT" || code === "ENOTDIR" ? "the profile has no extension list" : `the profile's extension list could not be read${code ? ` (${code})` : ""}` };
  }
  return parseProfileExtensions(text);
}

/**
 * The extensions to share: the profile's list minus the disabled ones, one per folder. Nothing when the disabled
 * list could not be read at all (source "none": a list that may name extensions Dan switched off must not be guessed
 * at) or when the profile's list could not be read.
 */
export function enabledExtensions(state: MirrorState | null): ProfileExtension[] {
  if (!state || state.disabled.source === "none" || !state.extensions.ok) return [];
  const disabled = new Set(state.disabled.disabled.map((d) => d.trim().toLowerCase()));
  const seen = new Set<string>();
  const out: ProfileExtension[] = [];
  for (const e of state.extensions.extensions) {
    if (disabled.has(e.id) || seen.has(e.folder)) continue;
    seen.add(e.folder);
    out.push(e);
  }
  return out;
}

/**
 * Read-only helper for the settings list (E5): the names of the shared links under `<serverDataDir>/extensions`
 * whose target no longer exists (an extension folder removed after the start). It changes nothing: the link stays
 * until the next start rebuilds the set. Sorted; empty when there is no extensions folder.
 */
export function danglingSharedLinks(serverDataDir: string): string[] {
  const target = path.join(serverDataDir, "extensions");
  let names: string[];
  try {
    names = fs.readdirSync(target);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names.sort()) {
    const p = path.join(target, name);
    if (!isLink(p)) continue;
    try {
      fs.statSync(p); // follows the link: throws when its target is gone
    } catch {
      out.push(name);
    }
  }
  return out;
}

function isLink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}
