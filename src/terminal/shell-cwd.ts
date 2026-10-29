/**
 * Where the drawer's shell starts (G12): the folder of the active file, else the
 * vault root. The folder is taken once, when the shell is created, and kept for
 * that shell's life: switching files or tabs afterwards neither moves nor restarts it.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface CwdDeps {
  isDirectory(absolute: string): boolean;
}

const realDeps: CwdDeps = {
  isDirectory: (p) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
};

/**
 * The start folder for a shell: `activeFile` (vault-relative, as Obsidian reports it) minus
 * its file name, under `vaultRoot`. The vault root when there is no file, the file is at the
 * top level, its folder is gone, or the path would leave the vault. Paths keep their spaces
 * and non-ASCII characters exactly as given.
 */
export function startDirectory(vaultRoot: string, activeFile: string | null | undefined, deps: CwdDeps = realDeps): string {
  if (typeof activeFile !== "string" || activeFile === "") return vaultRoot;
  const dir = path.dirname(activeFile);
  if (dir === "." || dir === "") return vaultRoot;
  const absolute = path.resolve(vaultRoot, dir);
  const inside = absolute === path.resolve(vaultRoot) || absolute.startsWith(path.resolve(vaultRoot) + path.sep);
  return inside && deps.isDirectory(absolute) ? absolute : vaultRoot;
}

/**
 * Holds the start folder of the current shell. `pin()` works it out the first time it is
 * called and returns the same folder until `release()` (the shell is gone), so a later
 * switch to another file cannot change it.
 */
export class ShellStartDir {
  private pinned: string | null = null;

  constructor(
    private readonly vaultRoot: () => string,
    private readonly activeFile: () => string | null | undefined,
    private readonly deps: CwdDeps = realDeps,
  ) {}

  pin(): string {
    if (this.pinned === null) this.pinned = startDirectory(this.vaultRoot(), this.activeFile(), this.deps);
    return this.pinned;
  }

  release(): void {
    this.pinned = null;
  }
}
