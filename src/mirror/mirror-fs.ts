/**
 * The file system calls the mirror makes (PR-4), behind one small interface so a test can record them (F1).
 *
 * The mirror reads desktop VS Code's files and writes only into the plugin's own folders: a temp copy of a
 * database while it is read, and the Mirror snapshot. Every method here is async so a 50 MB copy never blocks
 * Obsidian's main thread.
 */
import * as fs from "node:fs";

export interface MirrorFs {
  mkdir(dir: string, opts: { recursive: true }): Promise<unknown>;
  /** Make a new, uniquely named folder from `prefix` and return its path. */
  mkdtemp(prefix: string): Promise<string>;
  copyFile(src: string, dst: string): Promise<void>;
  readFile(file: string, encoding: "utf8"): Promise<string>;
  readdir(dir: string): Promise<string[]>;
  stat(file: string): Promise<{ mtimeMs: number }>;
  writeFile(file: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(target: string, opts: { recursive?: boolean; force?: boolean }): Promise<void>;
}

export const realMirrorFs: MirrorFs = {
  mkdir: (dir, opts) => fs.promises.mkdir(dir, opts),
  mkdtemp: (prefix) => fs.promises.mkdtemp(prefix),
  copyFile: (src, dst) => fs.promises.copyFile(src, dst),
  readFile: (file, encoding) => fs.promises.readFile(file, encoding),
  readdir: (dir) => fs.promises.readdir(dir),
  stat: (file) => fs.promises.stat(file),
  writeFile: (file, data) => fs.promises.writeFile(file, data, { mode: 0o600 }),
  rename: (from, to) => fs.promises.rename(from, to),
  rm: (target, opts) => fs.promises.rm(target, opts),
};

/** The error code of a failed call (`ENOENT`, `EACCES`, ...), or undefined. */
export function errorCode(e: unknown): string | undefined {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/** A file or folder that is not there (a missing path, or a parent that is a file). */
export function isMissing(e: unknown): boolean {
  const code = errorCode(e);
  return code === "ENOENT" || code === "ENOTDIR";
}
