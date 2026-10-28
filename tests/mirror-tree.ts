/**
 * Builds a fake desktop VS Code user-data folder with real `state.vscdb` databases (made by
 * tests/fixtures/make-state-db.sh with the system `sqlite3`), for the integration and fence tests of the mirror.
 *
 *   <root>/User/globalStorage/state.vscdb                       the global list
 *   <root>/User/globalStorage/storage.json                      (never read by the disabled-list reader)
 *   <root>/User/profiles/<loc>/globalStorage/state.vscdb        the profile's list (when `profile` is given)
 *   <root>/User/workspaceStorage/<hash>/workspace.json + state.vscdb   the vault's list (when `workspace` is given)
 *   <root>/../extensions/extensions.json                        beside it, for the "nothing is touched" checks
 */
import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { FIXTURES } from "./helpers";
import { vscodeFolderUri } from "./fixtures/make-fake-user-data.mjs";

export const MAKE_STATE_DB = path.join(FIXTURES, "make-state-db.sh");

/** Make one database with make-state-db.sh. */
export function stateDb(file: string, ...args: string[]): string {
  execFileSync(MAKE_STATE_DB, [file, ...args], { stdio: "pipe" });
  return file;
}

export interface TreeSpec {
  /** Where to build it (an empty temp folder). */
  base: string;
  vault?: string;
  /** Arguments for make-state-db.sh for the global database; `null` = no global database. Default: an empty list. */
  global?: string[] | null;
  /** The mirrored profile's location and the arguments for its database; `dbArgs: null` = the profile folder has no database. */
  profile?: { location: string; dbArgs: string[] | null };
  /** The vault's workspace-storage folder; `dbArgs: null` = the folder is there without a database. */
  workspace?: { hash?: string; dbArgs: string[] | null };
  /** Other workspace-storage folders (other folders, with lists that must not count). */
  others?: Array<{ hash: string; folder: string; dbArgs: string[] }>;
}

export interface Tree {
  base: string;
  userDataRoot: string;
  vault: string;
  globalDb: string;
  profileDir: string | null;
  profileDb: string | null;
  workspaceDb: string | null;
}

export function buildTree(spec: TreeSpec): Tree {
  const userDataRoot = path.join(spec.base, "AppSupport", "Code - Insiders");
  const vault = spec.vault ?? path.join(spec.base, "Vault");
  fs.mkdirSync(vault, { recursive: true });
  const user = path.join(userDataRoot, "User");
  const globalDb = path.join(user, "globalStorage", "state.vscdb");
  fs.mkdirSync(path.dirname(globalDb), { recursive: true });
  if (spec.global !== null) stateDb(globalDb, ...(spec.global ?? []));
  fs.writeFileSync(path.join(user, "globalStorage", "storage.json"), '{"profileAssociations":{"workspaces":{}},"userDataProfiles":[]}\n');
  fs.mkdirSync(path.join(spec.base, "Home", ".vscode-insiders", "extensions"), { recursive: true });
  fs.writeFileSync(path.join(spec.base, "Home", ".vscode-insiders", "extensions", "extensions.json"), "[]\n");

  let profileDir: string | null = null;
  let profileDb: string | null = null;
  if (spec.profile) {
    profileDir = path.join(user, "profiles", spec.profile.location);
    profileDb = path.join(profileDir, "globalStorage", "state.vscdb");
    fs.mkdirSync(path.dirname(profileDb), { recursive: true });
    if (spec.profile.dbArgs) stateDb(profileDb, ...spec.profile.dbArgs);
  }

  let workspaceDb: string | null = null;
  const ws = (hash: string, folder: string, dbArgs: string[] | null) => {
    const dir = path.join(user, "workspaceStorage", hash);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "workspace.json"), JSON.stringify({ folder: vscodeFolderUri(folder) }));
    const db = path.join(dir, "state.vscdb");
    if (dbArgs) stateDb(db, ...dbArgs);
    return db;
  };
  if (spec.workspace) workspaceDb = ws(spec.workspace.hash ?? "5f1c2a9e0b7d4c3a8e6f1b2c3d4e5f60", vault, spec.workspace.dbArgs);
  for (const o of spec.others ?? []) ws(o.hash, o.folder, o.dbArgs);

  return { base: spec.base, userDataRoot, vault, globalDb, profileDir, profileDb, workspaceDb };
}

/** A folder holding a `sqlite3` stub script; returns the folder (put it first on PATH). */
export function stubSqlite(dir: string, script: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "sqlite3");
  fs.writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return dir;
}

/** Every file under a folder with a digest of its bytes, its size and its mtime. */
export function snapshotTree(root: string): Record<string, { bytes: string; mtimeMs: number; size: number }> {
  const out: Record<string, { bytes: string; mtimeMs: number; size: number }> = {};
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const st = fs.statSync(p);
        out[path.relative(root, p)] = { bytes: crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"), mtimeMs: st.mtimeMs, size: st.size };
      }
    }
  };
  walk(root);
  return out;
}
