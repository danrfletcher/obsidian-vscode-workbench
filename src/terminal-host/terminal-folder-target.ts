/**
 * Which folder a "New terminal at folder" choice opens in (G8, E8). Pure rules over the disk, no Obsidian types:
 *  - a folder uses its own path; a file uses its parent folder (the caller passes the folder's vault-relative path, `""` for the root),
 *  - the vault root is the folder `""` and resolves to the vault's own base path,
 *  - a folder that is not a directory on disk now (deleted or renamed outside Obsidian since the menu was built) falls back to the vault root,
 *  - a path that would leave the vault (`..`, or an absolute path) falls back to the vault root,
 *  - a vault root that is itself missing or not a directory gives `null`: the terminal then opens in VS Code's own default start folder.
 * The folder is never changed on the way: spaces, non-ASCII and shell characters arrive byte for byte, because the result is
 * passed to VS Code as data (a `cwd` argument) and never put on a command line.
 */
import * as fs from "node:fs";
import * as path from "node:path";

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** `child` is `root` or below it. */
function within(root: string, child: string): boolean {
  const rel = path.relative(root, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * The absolute folder to open the terminal in, or null for VS Code's default start folder.
 * @param vaultRoot the vault's base path (the adapter's)
 * @param folder the folder's path inside the vault (`""` or `"/"` for the vault root)
 */
export function resolveTerminalFolder(vaultRoot: string, folder: string): string | null {
  if (!isDirectory(vaultRoot)) return null;
  const rel = folder === "/" ? "" : folder;
  if (rel === "") return vaultRoot;
  if (path.isAbsolute(rel) || rel.includes("\0")) return vaultRoot;
  const absolute = path.join(vaultRoot, rel);
  if (!within(vaultRoot, absolute)) return vaultRoot;
  return isDirectory(absolute) ? absolute : vaultRoot;
}
