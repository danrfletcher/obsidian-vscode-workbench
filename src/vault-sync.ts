/**
 * Keeps Code tabs in step with the vault (G3): a rename or move makes the tab follow, a delete closes it.
 * It reacts to vault events and never opens or creates a Code tab (F6), never writes to a note, and
 * does nothing on a modify event: an external change to an open file is left to VS Code (G4); the plugin adds no prompt and never touches the buffer.
 *
 * Deletes come in two kinds, told apart by who did them:
 *  - Obsidian deleted the file (the explorer, a command): the tab closes at once, with no save prompt even
 *    with unsaved edits, because there is nothing to save to;
 *  - something else deleted it (a `git checkout`, another tool): a clean tab closes, but a tab with unsaved
 *    edits stays open and VS Code shows its own deleted-file state. Dirty work is never closed behind
 *    the user's back.
 * Obsidian's own deletes are recognised by wrapping the delete calls (`trackObsidianDeletes`) for the
 * duration of the call; the "delete" event fires inside it.
 */
import type { LeafLike } from "./open-file";
import { fileKey } from "./open-file";
import type { TabRegistry } from "./tab-registry";

/** What VaultSync needs from a Code tab. */
export interface SyncTab {
  /** The file moved: title, saved state and the registry follow; the embed is re-pointed when it is safe (not loading, not dirty). */
  followTo(newPath: string): void;
  /** Obsidian deleted the file: close the tab now, with no prompt. Queued if the embed is still loading. */
  closeDeleted(): void;
  /** The file vanished on disk: close the tab only if it holds no unsaved edit. Resolves to whether it closed. */
  deletedOnDisk(): Promise<boolean>;
  /** The new path is not one a Code tab may show: close through the normal unsaved-changes prompt. `newPath` is where the file is now. */
  closeIneligible(newPath?: string): void;
}

export interface SyncDeps<L extends LeafLike> {
  registry: TabRegistry<L>;
  tabFor(leaf: L): SyncTab | undefined;
  /** May a Code tab show this path? (text-file rules and the exclude list; never markdown, canvas, base or a binary.) */
  eligible(path: string): boolean;
}

function isUnder(path: string, folder: string): boolean {
  const p = fileKey(path);
  const f = fileKey(folder);
  return p === f || p.startsWith(`${f}/`);
}

export class VaultSync<L extends LeafLike> {
  /** Paths Obsidian is deleting right now, with a count so nested calls (trash calling delete) balance. */
  private readonly deleting = new Map<string, number>();

  constructor(private readonly deps: SyncDeps<L>) {}

  /** A vault "rename" event: `newPath` is where the file (or folder) is now. */
  onRename(newPath: string, oldPath: string): void {
    const outcome = this.deps.registry.rename(oldPath, newPath, (p) => this.deps.eligible(p));
    for (const move of outcome.follow) this.deps.tabFor(move.leaf)?.followTo(move.to);
    for (const move of outcome.ineligible) this.deps.tabFor(move.leaf)?.closeIneligible(move.to);
    for (const move of outcome.duplicate) this.deps.tabFor(move.leaf)?.closeIneligible(); // the new path is another tab's file: nothing is moved into it
  }

  /** A vault "delete" event for a file or a folder. */
  async onDelete(path: string): Promise<void> {
    // Decided before anything is awaited: the wrapper around Obsidian's delete call ends soon after the event.
    const claims = this.deps.registry.under(path).map((claim) => ({ claim, byObsidian: this.isObsidianDelete(claim.path) }));
    for (const { claim, byObsidian } of claims) {
      const tab = this.deps.tabFor(claim.leaf);
      if (!tab) {
        this.deps.registry.files.release(claim.path, claim.leaf);
        continue;
      }
      if (byObsidian) {
        this.deps.registry.files.release(claim.path, claim.leaf);
        tab.closeDeleted();
      } else if (await tab.deletedOnDisk()) {
        this.deps.registry.files.release(claim.path, claim.leaf);
      }
    }
  }

  /** Obsidian starts deleting `path`; call the returned function when the call ends. */
  beginObsidianDelete(path: string): () => void {
    this.deleting.set(path, (this.deleting.get(path) ?? 0) + 1);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      const n = (this.deleting.get(path) ?? 1) - 1;
      if (n <= 0) this.deleting.delete(path);
      else this.deleting.set(path, n);
    };
  }

  private isObsidianDelete(path: string): boolean {
    for (const folder of this.deleting.keys()) if (isUnder(path, folder)) return true;
    return false;
  }
}

/** The part of Obsidian's `app` whose delete calls are wrapped. */
export interface DeleteHost {
  vault?: { delete?: (...a: any[]) => unknown; trash?: (...a: any[]) => unknown };
  fileManager?: { trashFile?: (...a: any[]) => unknown };
}

/**
 * How long a delete stays "Obsidian's own" after the wrapped call has settled (PR-5 R3). Obsidian normally fires the
 * vault `delete` event before the promise settles, but if it fires it later (from the file watcher, say) the event
 * would otherwise look like a delete made outside Obsidian and a tab with unsaved edits would stay open. A grace
 * period closes that gap. Nothing is lost either way (an outside delete only keeps a dirty tab open).
 */
export const OBSIDIAN_DELETE_GRACE_MS = 1500;

/**
 * Wrap Obsidian's delete calls (`vault.delete`, `vault.trash`, `fileManager.trashFile`) so `sync` knows a
 * delete is Obsidian's own while it runs, and for `OBSIDIAN_DELETE_GRACE_MS` after it settles. Each wrapper calls
 * the original with the same arguments and returns its result, so behaviour is unchanged. The returned function
 * puts the originals back.
 */
export function trackObsidianDeletes<L extends LeafLike>(app: DeleteHost, sync: VaultSync<L>): () => void {
  const restores: Array<() => void> = [];
  const graceTimers = new Set<ReturnType<typeof setTimeout>>();
  const endLater = (end: () => void) => {
    const timer = setTimeout(() => {
      graceTimers.delete(timer);
      end();
    }, OBSIDIAN_DELETE_GRACE_MS);
    (timer as { unref?: () => void }).unref?.();
    graceTimers.add(timer);
    restores.push(() => {
      if (graceTimers.delete(timer)) {
        clearTimeout(timer);
        end();
      }
    });
  };
  const wrap = (owner: Record<string, any> | undefined, name: string) => {
    if (!owner || typeof owner[name] !== "function") return;
    const original = owner[name] as (...a: any[]) => unknown;
    const wrapper = function (this: unknown, file: { path?: string } | undefined, ...rest: unknown[]) {
      const end = typeof file?.path === "string" ? sync.beginObsidianDelete(file.path) : () => undefined;
      let result: unknown;
      try {
        result = original.call(this, file, ...rest);
      } catch (e) {
        end();
        throw e;
      }
      return Promise.resolve(result).finally(() => endLater(end));
    };
    owner[name] = wrapper;
    restores.push(() => {
      if (owner[name] === wrapper) owner[name] = original;
    });
  };
  wrap(app.vault, "delete");
  wrap(app.vault, "trash");
  wrap(app.fileManager, "trashFile");
  return () => {
    for (const r of restores.splice(0)) r();
  };
}

/** The part of Obsidian's `app` whose create calls are wrapped. */
export interface CreateHost {
  vault?: { create?: (...a: any[]) => unknown; createBinary?: (...a: any[]) => unknown; copy?: (...a: any[]) => unknown };
}

/**
 * Wrap Obsidian's own file-creating calls (`vault.create`, `vault.createBinary`, `vault.copy`, which the "new
 * note" command and the explorer go through) so `claimed` hears of the path being taken. A save from a Code
 * tab does not go through them, so this tells a tab's own write to a path from another file taking it. Each
 * wrapper calls the original with the same arguments and returns its result. The returned function puts the
 * originals back.
 */
export function trackObsidianCreates(app: CreateHost, claimed: (path: string) => void): () => void {
  const restores: Array<() => void> = [];
  const wrap = (name: "create" | "createBinary" | "copy", pathArg: number) => {
    const owner = app.vault as Record<string, any> | undefined;
    if (!owner || typeof owner[name] !== "function") return;
    const original = owner[name] as (...a: any[]) => unknown;
    const wrapper = function (this: unknown, ...args: unknown[]) {
      const target = args[pathArg];
      if (typeof target === "string") {
        try {
          claimed(target);
        } catch {
          // a failing listener must not break the create
        }
      }
      return original.apply(this, args);
    };
    owner[name] = wrapper;
    restores.push(() => {
      if (owner[name] === wrapper) owner[name] = original;
    });
  };
  wrap("create", 0);
  wrap("createBinary", 0);
  wrap("copy", 1);
  return () => {
    for (const r of restores.splice(0)) r();
  };
}
