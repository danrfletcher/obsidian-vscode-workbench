/**
 * The disabled-extension lists of desktop VS Code (PR-4, G1): which extensions Dan has switched off.
 *
 * VS Code keeps the list in three places, and an extension is disabled if any of them names it:
 *
 *   global      `<user-data>/User/globalStorage/state.vscdb`
 *   profile     the mirrored profile's own `globalStorage/state.vscdb` (a profile other than Default only: for
 *               Default the profile's list IS the global one, so it is read once, not twice)
 *   workspace   `<user-data>/User/workspaceStorage/<hash>/state.vscdb`, the folder whose `workspace.json` names
 *               the vault. Found by matching that file to the percent-decoded, normalised vault URI, never by
 *               working out VS Code's folder hash.
 *
 * A missing profile or workspace database is an empty list; a missing global database is a failure. If any one
 * of the databases cannot be read the whole read has failed: a partial list would share extensions Dan disabled.
 * Ids compare case-insensitively (`publisher.name`, as `extensions.json` names them), so they are lower-cased.
 *
 * Nothing is written next to the databases (F1): each is read from a temp copy (see sqlite-read.ts).
 * Nothing throws: the result says what happened.
 */
import * as path from "node:path";
import { normaliseFolderUri } from "../profile/mirrored-profile";
import { isMissing, realMirrorFs, type MirrorFs } from "./mirror-fs";
import { readDisabledFromDb, type FailureKind, type SqliteDeps } from "./sqlite-read";

export type ListName = "global" | "profile" | "workspace";

export interface ReadDisabledInput {
  /** The instance's user-data folder, the one that holds `User/`. */
  userDataRoot: string;
  /** The vault folder: a file system path, or a `file://` URI. */
  vaultPath: string;
  /** The mirrored profile: whether it is Default, and the folder that holds its own files. */
  profile: { isDefault: boolean; dir: string };
  /** Where temp copies are made: inside the plugin's own folder. */
  tmpRoot: string;
  signal?: AbortSignal;
}

export type DisabledListsResult =
  | {
      ok: true;
      /** The union of the lists, lower case, sorted, no duplicates. */
      disabled: string[];
      /** Each list on its own; `profile` is null when the profile is Default (its list is the global one). */
      lists: { global: string[]; profile: string[] | null; workspace: string[] };
      /** Things worth showing that are not failures (a workspace database that was not found, a missing profile database). */
      notes: string[];
    }
  | { ok: false; kind: FailureKind; list: ListName; reason: string };

/** Whether `id` (any case) is disabled in a successful result. */
export function isDisabled(result: Extract<DisabledListsResult, { ok: true }>, id: string): boolean {
  return result.disabled.includes(id.trim().toLowerCase());
}

/** Where the databases are. Pure: it only builds paths. */
export function globalDbPath(userDataRoot: string): string {
  return path.join(userDataRoot, "User", "globalStorage", "state.vscdb");
}

export function profileDbPath(profileDir: string): string {
  return path.join(profileDir, "globalStorage", "state.vscdb");
}

const workspaceStorageDir = (userDataRoot: string) => path.join(userDataRoot, "User", "workspaceStorage");

/**
 * The `state.vscdb` of every workspace-storage folder whose `workspace.json` names the vault. The URI in that file
 * is percent-encoded and the vault path is not, so both go through `normaliseFolderUri` before they are compared
 * (a path with spaces, `%` or accents still matches). A folder whose `workspace.json` is missing or unreadable
 * cannot be matched and is passed over. All matches are read: VS Code can leave an old folder beside the current
 * one, and a longer list is the safe side.
 */
export async function findWorkspaceDbs(
  userDataRoot: string,
  vaultPath: string,
  io: MirrorFs = realMirrorFs,
): Promise<{ ok: true; dbs: string[]; note: string | null } | { ok: false; reason: string }> {
  const root = workspaceStorageDir(userDataRoot);
  const vaultUri = normaliseFolderUri(vaultPath);
  let names: string[];
  try {
    names = await io.readdir(root);
  } catch (e) {
    if (isMissing(e)) return { ok: true, dbs: [], note: "desktop VS Code has no workspace storage yet, so no workspace list applies" };
    return { ok: false, reason: "the workspace storage folder could not be read" };
  }
  const dbs: string[] = [];
  for (const name of names.sort()) {
    let folder: unknown;
    try {
      folder = (JSON.parse(await io.readFile(path.join(root, name, "workspace.json"), "utf8")) as { folder?: unknown } | null)?.folder;
    } catch {
      continue; // no workspace.json (a file, or a folder without one), or not JSON: it cannot name the vault
    }
    if (typeof folder === "string" && normaliseFolderUri(folder) === vaultUri) dbs.push(path.join(root, name, "state.vscdb"));
  }
  if (dbs.length === 0) {
    return { ok: true, dbs, note: `no workspace storage in desktop VS Code names the vault folder (vault URI tried: ${vaultUri}), so no workspace list applies` };
  }
  return { ok: true, dbs, note: null };
}

export type ReadDeps = SqliteDeps;

/** Read the three lists and combine them. Never throws. */
export async function readDisabledLists(input: ReadDisabledInput, deps: ReadDeps = {}): Promise<DisabledListsResult> {
  try {
    return await read(input, deps);
  } catch (e) {
    return { ok: false, kind: "unreadable", list: "global", reason: `the read failed unexpectedly (${(e as NodeJS.ErrnoException | null)?.code ?? "error"})` };
  }
}

async function read(input: ReadDisabledInput, deps: ReadDeps): Promise<DisabledListsResult> {
  const io = deps.fs ?? realMirrorFs;
  const opts = { ...deps, tmpRoot: input.tmpRoot, signal: input.signal };
  const notes: string[] = [];

  const global = await readDisabledFromDb(globalDbPath(input.userDataRoot), opts);
  if (!global.ok) return { ok: false, kind: global.kind, list: "global", reason: `the global list: ${global.reason}` };
  if (global.missing) return { ok: false, kind: "unreadable", list: "global", reason: "the global list: desktop VS Code's global state database is missing" };

  let profile: string[] | null = null;
  if (!input.profile.isDefault) {
    const r = await readDisabledFromDb(profileDbPath(input.profile.dir), opts);
    if (!r.ok) return { ok: false, kind: r.kind, list: "profile", reason: `the profile list: ${r.reason}` };
    if (r.missing) notes.push("the profile has no state database, so its own list is empty");
    profile = r.ids;
  }

  const found = await findWorkspaceDbs(input.userDataRoot, input.vaultPath, io);
  if (!found.ok) return { ok: false, kind: "unreadable", list: "workspace", reason: `the workspace list: ${found.reason}` };
  if (found.note) notes.push(found.note);
  const workspace = new Set<string>();
  for (const db of found.dbs) {
    const r = await readDisabledFromDb(db, opts);
    if (!r.ok) return { ok: false, kind: r.kind, list: "workspace", reason: `the workspace list: ${r.reason}` };
    for (const id of r.ids) workspace.add(id);
  }

  const disabled = [...new Set([...global.ids, ...(profile ?? []), ...workspace])].sort();
  return { ok: true, disabled, lists: { global: global.ids, profile, workspace: [...workspace].sort() }, notes };
}
