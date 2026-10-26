/**
 * The vault extension scan (GP1): walk the vault folder on disk and collect
 * every extension that may open in a Code tab, in batches that give the UI
 * back between slices of work.
 *
 * It walks the disk, not Obsidian's file index: with "Detect all file
 * extensions" off Obsidian does not list a `.py` or `.zig` file until its
 * extension is registered, so the index cannot be the source. Hidden folders
 * (`.obsidian`, `.git`, `node_modules`) are never entered. A symlink loop, a
 * broken link or an unreadable folder is skipped with a console warning and the
 * scan carries on.
 */
import * as nodeFs from "node:fs";
import * as path from "node:path";
import { decideFile, isInHiddenFolder } from "./text-file-rules";

/** The slice of `fs` the walk uses, replaceable in tests. */
export interface DirEntryLike {
  name: string;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}
export interface ScanFs {
  readdir(dir: string): Promise<DirEntryLike[]>;
  /** Follows symlinks. */
  stat(p: string): Promise<{ isDirectory(): boolean }>;
  realpath(p: string): Promise<string>;
}

export const nodeScanFs: ScanFs = {
  readdir: (dir) => nodeFs.promises.readdir(dir, { withFileTypes: true }),
  stat: (p) => nodeFs.promises.stat(p),
  realpath: (p) => nodeFs.promises.realpath(p),
};

export interface ScanOptions {
  /** Extensions on the user's exclude list: never collected. */
  excluded?: readonly string[];
  /** Longest stretch of work between two yields, in ms (one frame is about 16 ms). Default 8. */
  budgetMs?: number;
  now?: () => number;
  /** Gives the UI a turn. Default: a macrotask (`setTimeout 0`). */
  yieldToUi?: () => Promise<void>;
  warn?: (message: string, error?: unknown) => void;
  fs?: ScanFs;
  /** Checked between slices; a true stops the walk and returns what it has. */
  isCancelled?: () => boolean;
}

export interface ScanResult {
  /** Sorted, lowercase, no dot, no duplicates. */
  extensions: string[];
  /** Files with no usable extension (Makefile, .env): reached by click interception, not registration. */
  extensionless: number;
  files: number;
  /** Entries skipped with a warning (loops, broken links, unreadable folders). */
  skipped: number;
  /** How many times the walk gave the UI a turn. */
  yields: number;
}

/** Collects extensions from paths, one at a time. Used by the walk and by the create/rename events. */
export class ExtensionCollector {
  private found = new Set<string>();
  extensionless = 0;
  files = 0;

  constructor(private readonly excluded: readonly string[] = []) {}

  add(vaultPath: string): void {
    this.files++;
    const d = decideFile(vaultPath, this.excluded);
    if (d.kind === "extension") this.found.add(d.extension);
    else if (d.kind === "extensionless") this.extensionless++;
  }

  get extensions(): string[] {
    return [...this.found].sort();
  }
}

/** The extensions in a list of paths (no file system). Case folded, de-duplicated, sorted. */
export function extensionsOf(paths: Iterable<string>, excluded: readonly string[] = []): string[] {
  const c = new ExtensionCollector(excluded);
  for (const p of paths) c.add(p);
  return c.extensions;
}

const MAX_DEPTH = 64;
const ENTRIES_PER_CLOCK_CHECK = 64;

export async function scanVault(root: string, options: ScanOptions = {}): Promise<ScanResult> {
  const fs = options.fs ?? nodeScanFs;
  const budget = options.budgetMs ?? 8;
  const now = options.now ?? (() => performance.now());
  const yieldToUi = options.yieldToUi ?? (() => new Promise<void>((r) => setTimeout(r, 0)));
  const warn = options.warn ?? ((m: string, e?: unknown) => console.warn(m, e instanceof Error ? e.message : (e ?? "")));
  const collector = new ExtensionCollector(options.excluded);
  let skipped = 0;
  let yields = 0;
  let sliceStart = now();

  const skip = (message: string, error?: unknown) => {
    skipped++;
    warn(`VS Code Workbench: scan skipped ${message}`, error);
  };
  const maybeYield = async (): Promise<boolean> => {
    if (now() - sliceStart < budget) return false;
    yields++;
    await yieldToUi();
    sliceStart = now();
    return true;
  };

  // Real paths of the folders reached through a symlink (and the root): a link back to one of them is a loop.
  const visited = new Set<string>();
  try {
    visited.add(await fs.realpath(root));
  } catch (e) {
    skip("the vault root (cannot resolve it)", e);
    return { extensions: [], extensionless: 0, files: 0, skipped, yields };
  }

  const stack: Array<{ rel: string; depth: number }> = [{ rel: "", depth: 0 }];
  while (stack.length) {
    if (options.isCancelled?.()) break;
    const { rel, depth } = stack.pop() as { rel: string; depth: number };
    let entries: DirEntryLike[];
    try {
      entries = await fs.readdir(rel === "" ? root : path.join(root, rel));
    } catch (e) {
      skip(`the folder "${rel || "/"}" (unreadable)`, e);
      continue;
    }
    let sinceCheck = 0;
    for (const entry of entries) {
      try {
        const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
        if (isInHiddenFolder(childRel)) continue;
        if (entry.isSymbolicLink()) {
          let target: { isDirectory(): boolean };
          try {
            target = await fs.stat(path.join(root, childRel));
          } catch (e) {
            skip(`the link "${childRel}" (broken or looping)`, e);
            continue;
          }
          if (!target.isDirectory()) {
            collector.add(childRel);
            continue;
          }
          const real = await fs.realpath(path.join(root, childRel)).catch(() => null);
          if (real === null || visited.has(real)) {
            skip(`the link "${childRel}" (it loops back into the vault)`);
            continue;
          }
          visited.add(real);
          if (depth + 1 < MAX_DEPTH) stack.push({ rel: childRel, depth: depth + 1 });
        } else if (entry.isDirectory()) {
          if (depth + 1 < MAX_DEPTH) stack.push({ rel: childRel, depth: depth + 1 });
          else skip(`the folder "${childRel}" (nested more than ${MAX_DEPTH} deep)`);
        } else {
          collector.add(childRel);
        }
      } catch (e) {
        skip("an entry that could not be read", e);
      }
      if (++sinceCheck >= ENTRIES_PER_CLOCK_CHECK) {
        sinceCheck = 0;
        await maybeYield();
      }
    }
    await maybeYield();
  }

  return { extensions: collector.extensions, extensionless: collector.extensionless, files: collector.files, skipped, yields };
}
