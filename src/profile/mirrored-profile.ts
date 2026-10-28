/**
 * The mirrored profile: which VS Code user-data profile desktop VS Code uses for the vault folder.
 *
 * Desktop VS Code records the choice in the instance's `User/globalStorage/storage.json`:
 *
 *   userDataProfiles                   [{ name, location, useDefaultFlags? }, ...]   the profiles that exist
 *   profileAssociations.workspaces     { "<folder URI>": "<profile location>" }       which folder uses which
 *
 * The value `__default__profile__` means the Default profile. Anything else is a profile `location`, whose
 * own files (`extensions.json`, `settings.json`, `keybindings.json`) are in `User/profiles/<location>/`.
 *
 * This module only reads (F1): it opens `storage.json` and looks at the profile folders; it writes, creates,
 * renames and deletes nothing, and it opens nothing outside the one user-data folder it is given (F9). It
 * never throws: a problem is an answer (Default, with the reason), so a server start never depends on it.
 *
 * Rules (G7, G8, G9, G15, E2, E6, E10):
 *  - The vault folder URI is percent-decoded and normalised before matching, and so are the keys of
 *    `profileAssociations.workspaces`, so an association written in encoded form still matches.
 *  - The vault folder wins; failing that, the nearest parent folder with an association.
 *  - No association, an association to a profile that is not listed, or to a profile whose folder is gone,
 *    is Default, with the reason. An association to Default itself is Default with no fallback note.
 *  - A profile flagged `useDefaultFlags` for a kind reads Default's file for that kind.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Instance } from "../instances/scan";
import { PROFILE_KINDS, type ProfileKind } from "./profile-kinds";

/** The value `profileAssociations` holds for the Default profile. */
export const DEFAULT_PROFILE_LOCATION = "__default__profile__";
export const DEFAULT_PROFILE_NAME = "Default";

/** The three files of a profile that the tab mirrors. */
export { PROFILE_KINDS, type ProfileKind };

/** Where one kind of file is read from. */
export interface KindSource {
  from: "default" | "profile";
  /**
   * The folder that holds the file. Default's `extensions.json` is not in the user-data folder (it is in the
   * instance's extensions folder, which the user-data folder does not name), so for that one `dir` is null.
   */
  dir: string | null;
}

/** Where the profile was chosen from. */
export type ChosenFrom = "vault-folder" | "parent-folder" | "default";

export interface MirroredProfile {
  /** `Default` or the profile's name. */
  name: string;
  /** `__default__profile__` for Default, else the profile's location id. */
  location: string;
  isDefault: boolean;
  /** The folder that holds the profile's own files: `User` for Default, `User/profiles/<location>` otherwise. */
  dir: string;
  /** Where each of the three files is read from (a flagged kind of a `useDefaultFlags` profile is Default's). */
  files: Record<ProfileKind, KindSource>;
  /** vault-folder / parent-folder: an association was found there; default: none was used. */
  chosenFrom: ChosenFrom;
  /** The folder URI the association was found on; null when none was used. */
  matchedUri: string | null;
  /** The normalised vault folder URI that was tried. */
  vaultUri: string;
  /** True when Default is used because something is missing or wrong (not when Default is the association). */
  fallback: boolean;
  /** Why this profile was chosen; for a fallback, what went wrong. Never empty. */
  reason: string;
}

/** What settings shows for the profile. */
export type ProfileState =
  | { status: "not-read" }
  | { status: "resolved"; profile: MirroredProfile }
  /** The profile could not be worked out at all (the user-data folder cannot be told, or the lookup failed). */
  | { status: "unavailable"; reason: string };

// ---------------------------------------------------------------------------
// The folder URI
// ---------------------------------------------------------------------------

interface FolderParts {
  scheme: string;
  authority: string;
  segments: string[];
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s; // a malformed escape: compare it as written
  }
}

function partsOf(input: string): FolderParts {
  const uri = /^([a-zA-Z][a-zA-Z0-9+.-]+):\/\/([^/?#]*)([^?#]*)/.exec(input);
  let scheme: string;
  let authority: string;
  let rawPath: string;
  let decode: boolean;
  if (uri) {
    // A URI, as VS Code writes the association keys: the path is percent-encoded.
    scheme = uri[1].toLowerCase();
    authority = safeDecode(uri[2]).normalize("NFC").toLowerCase();
    rawPath = uri[3];
    decode = true;
  } else {
    // A file system path (the vault's): already decoded, so a folder literally named `a%20b` stays that.
    scheme = "file";
    authority = "";
    rawPath = /^[a-zA-Z]:[\\/]/.test(input) ? `/${input.replace(/\\/g, "/")}` : input;
    decode = false;
  }
  if (scheme === "file" && authority === "localhost") authority = "";
  const segments = rawPath
    .split("/")
    .map((s) => (decode ? safeDecode(s) : s).normalize("NFC"))
    .filter((s) => s !== "" && s !== ".");
  // A drive letter (`file:///C%3A/Users` and `file:///c:/Users` are one folder).
  if (segments.length > 0 && /^[a-zA-Z]:$/.test(segments[0])) segments[0] = segments[0].toLowerCase();
  return { scheme, authority, segments };
}

function build(p: FolderParts, count: number = p.segments.length): string {
  return `${p.scheme}://${p.authority}/${p.segments.slice(0, count).join("/")}`;
}

/**
 * A folder, as a URI in one canonical form to compare with: scheme in lower case, percent-escapes decoded
 * (`%20`, encoded non-ASCII, `%3A` after a drive letter), Unicode in NFC, no trailing or doubled slash.
 * Takes a `file://` (or other scheme) URI, or a file system path (which is not decoded: it already is).
 * `/Users/x/My Vault/` and `file:///Users/x/My%20Vault` both give `file:///Users/x/My Vault`.
 */
export function normaliseFolderUri(folder: string): string {
  return build(partsOf(folder));
}

/**
 * The folder and then each parent folder up to (not including) the root, nearest first, each normalised.
 * Takes the folder as given, not its normalised form: decoding that again would change a name with a literal `%20`.
 */
function folderAndParents(folder: string): string[] {
  const p = partsOf(folder);
  const out: string[] = [];
  for (let n = p.segments.length; n >= 1; n--) out.push(build(p, n));
  return out;
}

// ---------------------------------------------------------------------------
// Reading storage.json
// ---------------------------------------------------------------------------

/** The file system calls this module makes (injectable so a test can record them). Reads only. */
export interface ProfileFs {
  readFileSync(file: string, encoding: "utf8"): string;
  statSync(file: string): { isDirectory(): boolean };
}

const realFs: ProfileFs = { readFileSync: (f, e) => fs.readFileSync(f, e), statSync: (f) => fs.statSync(f) };

type Read = { ok: true; value: Record<string, unknown> } | { ok: false; why: string };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readStorage(file: string, io: ProfileFs): Read {
  let text: string;
  try {
    text = io.readFileSync(file, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return { ok: false, why: "the file is missing" };
    if (code === "EACCES" || code === "EPERM") return { ok: false, why: "permission denied" };
    return { ok: false, why: code ? `the read failed: ${code}` : "the read failed" };
  }
  if (text.trim() === "") return { ok: false, why: "the file is empty" };
  let json: unknown;
  try {
    json = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return { ok: false, why: "the file is not valid JSON" }; // never quote the text: it is not ours
  }
  if (!isObject(json)) return { ok: false, why: "the file does not hold a JSON object" };
  if (!isObject(json.profileAssociations)) return { ok: false, why: "it has no profileAssociations" };
  return { ok: true, value: json };
}

interface ListedProfile {
  name: string;
  location: string;
  flags: Partial<Record<ProfileKind, boolean>>;
}

/** The last path segment of a profile `location`, which is a string (older and newer VS Code) or a URI object. */
function locationId(raw: unknown): string | null {
  const text = typeof raw === "string" ? raw : isObject(raw) && typeof raw.path === "string" ? raw.path : null;
  if (text === null) return null;
  const last = text.split("/").filter(Boolean).pop();
  return last ?? null;
}

function listProfiles(storage: Record<string, unknown>): ListedProfile[] {
  const raw = storage.userDataProfiles;
  if (!Array.isArray(raw)) return [];
  const out: ListedProfile[] = [];
  for (const item of raw) {
    if (!isObject(item)) continue;
    const location = locationId(item.location);
    if (location === null) continue;
    const flags: ListedProfile["flags"] = {};
    if (isObject(item.useDefaultFlags)) for (const k of PROFILE_KINDS) if (item.useDefaultFlags[k] === true) flags[k] = true;
    out.push({ name: typeof item.name === "string" && item.name !== "" ? item.name : location, location, flags });
  }
  return out;
}

/** A location id that is a single plain folder name (it is joined onto a path). */
function safeLocation(id: string): boolean {
  return id !== "" && id !== "." && id !== ".." && !/[\\/\0]/.test(id);
}

function isDir(p: string, io: ProfileFs): boolean {
  try {
    return io.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The lookup
// ---------------------------------------------------------------------------

export interface FindOptions {
  /** The instance's user-data folder, the one that holds `User/` (for example `~/Library/Application Support/Code - Insiders`). */
  userDataRoot: string;
  /** The vault folder: a file system path, or a `file://` URI. */
  vaultPath: string;
  /** Tests only: the file system calls, to record them. */
  fs?: ProfileFs;
}

function defaultProfile(o: { userDataRoot: string; vaultUri: string; chosenFrom: ChosenFrom; matchedUri: string | null; fallback: boolean; reason: string }): MirroredProfile {
  const userDir = path.join(o.userDataRoot, "User");
  return {
    name: DEFAULT_PROFILE_NAME,
    location: DEFAULT_PROFILE_LOCATION,
    isDefault: true,
    dir: userDir,
    files: { extensions: { from: "default", dir: null }, settings: { from: "default", dir: userDir }, keybindings: { from: "default", dir: userDir } },
    chosenFrom: o.chosenFrom,
    matchedUri: o.matchedUri,
    vaultUri: o.vaultUri,
    fallback: o.fallback,
    reason: o.reason,
  };
}

const where = (chosenFrom: ChosenFrom, uri: string) => (chosenFrom === "vault-folder" ? "the vault folder" : `a parent folder (${uri})`);

/**
 * Which profile desktop VS Code uses for the vault folder. Reads `User/globalStorage/storage.json` under
 * `userDataRoot` and looks at the profile's folder; writes nothing. Never throws.
 */
export function findMirroredProfile(opts: FindOptions): MirroredProfile {
  const io = opts.fs ?? realFs;
  const vaultUri = normaliseFolderUri(opts.vaultPath);
  const fallback = (reason: string) => defaultProfile({ userDataRoot: opts.userDataRoot, vaultUri, chosenFrom: "default", matchedUri: null, fallback: true, reason });
  try {
    const storage = readStorage(path.join(opts.userDataRoot, "User", "globalStorage", "storage.json"), io);
    if (!storage.ok) return fallback(`desktop VS Code's storage.json could not be read (${storage.why}), so Default is used`);

    const workspaces = (storage.value.profileAssociations as Record<string, unknown>).workspaces;
    const byFolder = new Map<string, string>();
    if (isObject(workspaces)) {
      for (const [key, value] of Object.entries(workspaces)) {
        if (typeof value !== "string") continue;
        const k = normaliseFolderUri(key);
        if (!byFolder.has(k)) byFolder.set(k, value);
      }
    }

    // The vault folder first, then each parent, nearest first.
    const candidates = folderAndParents(opts.vaultPath);
    const index = candidates.findIndex((c) => byFolder.has(c));
    if (index < 0) return fallback(`the vault folder is not associated with a profile in desktop VS Code (vault URI tried: ${vaultUri}), so Default is used`);
    const matchedUri = candidates[index];
    const id = byFolder.get(matchedUri) as string;
    const chosenFrom: ChosenFrom = index === 0 ? "vault-folder" : "parent-folder";

    if (id === DEFAULT_PROFILE_LOCATION) {
      return defaultProfile({ userDataRoot: opts.userDataRoot, vaultUri, chosenFrom, matchedUri, fallback: false, reason: `${where(chosenFrom, matchedUri)} is associated with the Default profile in desktop VS Code` });
    }

    const listed = safeLocation(id) ? listProfiles(storage.value).find((p) => p.location === id) : undefined;
    if (!listed) {
      return fallback(`${where(chosenFrom, matchedUri)} is associated with profile location "${id}", which is not in desktop VS Code's list of profiles (it was deleted or is unknown), so Default is used`);
    }

    const profileDir = path.join(opts.userDataRoot, "User", "profiles", listed.location);
    const ownKinds = PROFILE_KINDS.filter((k) => listed.flags[k] !== true);
    // A profile that takes all three files from Default has no use for a folder of its own.
    if (ownKinds.length > 0 && !isDir(profileDir, io)) {
      return fallback(`${where(chosenFrom, matchedUri)} is associated with profile "${listed.name}" (location "${listed.location}"), but its folder under User/profiles/ is missing, so Default is used`);
    }

    const userDir = path.join(opts.userDataRoot, "User");
    const files = {} as Record<ProfileKind, KindSource>;
    for (const k of PROFILE_KINDS) {
      files[k] = listed.flags[k] === true ? { from: "default", dir: k === "extensions" ? null : userDir } : { from: "profile", dir: profileDir };
    }
    const flagged = PROFILE_KINDS.filter((k) => listed.flags[k] === true);
    return {
      name: listed.name,
      location: listed.location,
      isDefault: false,
      dir: profileDir,
      files,
      chosenFrom,
      matchedUri,
      vaultUri,
      fallback: false,
      reason:
        `${where(chosenFrom, matchedUri)} is associated with profile "${listed.name}" in desktop VS Code` +
        (flagged.length > 0 ? `; it reads Default's ${flagged.join(", ")}` : ""),
    };
  } catch (e) {
    // Not expected (every read is guarded); an answer all the same, and nothing from the error is quoted.
    return fallback(`the profile lookup failed (${(e as NodeJS.ErrnoException | null)?.code ?? "unexpected error"}), so Default is used`);
  }
}

// ---------------------------------------------------------------------------
// The instance's user-data folder (E6)
// ---------------------------------------------------------------------------

export interface ForInstanceOptions {
  /** The instance the server runs on. */
  instance: Pick<Instance, "kind" | "userDataName">;
  vaultPath: string;
  /** The folder holding the instances' user-data folders (`appSupportRoot()`). */
  appSupport: string;
  /** A hand-edited `userDataFolder` in data.json: used for a custom CLI only. A bare name sits under `appSupport`. */
  configuredFolder?: string | null;
  fs?: ProfileFs;
}

function plainName(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && !/[\\/\0]/.test(name);
}

/** Where the instance keeps its user data: its own folder under Application Support, or a configured one for a custom CLI. */
export function userDataRootFor(o: Pick<ForInstanceOptions, "instance" | "appSupport" | "configuredFolder">): { root: string } | { reason: string } {
  const configured = o.configuredFolder?.trim();
  if (o.instance.kind === "custom" && configured) {
    if (path.isAbsolute(configured)) return { root: configured };
    if (plainName(configured)) return { root: path.join(o.appSupport, configured) };
    return { reason: `the userDataFolder set in data.json ("${configured}") is neither an absolute path nor a folder name` };
  }
  const name = o.instance.userDataName;
  if (name && plainName(name)) return { root: path.join(o.appSupport, name) };
  return {
    reason:
      'the user-data folder of this custom VS Code cannot be told (its product.json names none). Set "userDataFolder" in data.json to its folder name under Application Support, or to an absolute path',
  };
}

/** The profile for the instance a server starts on: only that instance's own user-data folder is read (F9). */
export function profileForInstance(o: ForInstanceOptions): ProfileState {
  const found = userDataRootFor(o);
  if ("reason" in found) return { status: "unavailable", reason: found.reason };
  return { status: "resolved", profile: findMirroredProfile({ userDataRoot: found.root, vaultPath: o.vaultPath, fs: o.fs }) };
}
