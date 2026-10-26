/**
 * The path-to-tab map as the vault changes under it (G3): which Code tab follows a rename or a move, which
 * closes, which goes away with a delete, and the one-tab-per-file rule through all of it.
 *
 * It owns no tab and does no I/O. It edits the claims in `OpenFiles` (the same map the open path uses to
 * find "the tab that already shows this file") and returns what became of each tab, for `VaultSync` to act on.
 * Each change is made in one synchronous step, so a file opened a moment later already finds the right tab.
 *
 * A folder rename or delete is handled through the files under it: a tab whose path starts with `old + "/"`
 * moves to `new + "/"` plus the rest, or is released.
 */
import { fileKey, type Claim, type LeafLike, type OpenFiles } from "./open-file";

export interface TabMove<L> {
  leaf: L;
  from: string;
  to: string;
}

export interface RenameOutcome<L> {
  /** Tabs that follow the file to its new path. Their claims have moved. */
  follow: TabMove<L>[];
  /** Tabs whose file is no longer one a Code tab may show (a `.md` name, a binary extension, a hidden folder). Their claims are released. */
  ineligible: TabMove<L>[];
  /** Tabs that could not follow because another tab already shows the new path. Their claims are released. */
  duplicate: TabMove<L>[];
}

/** True when `path` is `folder` or inside it. Both compared in one Unicode normal form. */
function isUnder(path: string, folder: string): boolean {
  const p = fileKey(path);
  const f = fileKey(folder);
  return p === f || p.startsWith(`${f}/`);
}

export class TabRegistry<L extends LeafLike> {
  constructor(readonly files: OpenFiles<L>) {}

  /** The tab claiming exactly `path`, or undefined. */
  tabAt(path: string): L | undefined {
    const key = fileKey(path);
    return this.files.entries().find((c) => fileKey(c.path) === key)?.leaf;
  }

  /** The claims on `path` or, when it is a folder, on files inside it. */
  under(path: string): Claim<L>[] {
    return this.files.entries().filter((c) => isUnder(c.path, path));
  }

  /**
   * `oldPath` became `newPath` (a rename, or a move to another folder). `eligible` says whether a Code tab
   * may show the new path. Every tab under `oldPath` is moved, released as ineligible, or released as a
   * duplicate; none is left claiming the old path.
   */
  rename(oldPath: string, newPath: string, eligible: (path: string) => boolean): RenameOutcome<L> {
    const out: RenameOutcome<L> = { follow: [], ineligible: [], duplicate: [] };
    for (const claim of this.under(oldPath)) {
      // The part of the tab's path below the renamed folder (empty when the tab's file itself was renamed). Cut by
      // path segments, not characters: the vault may spell a name decomposed where the event spells it composed.
      const rest = claim.path.split("/").slice(oldPath.split("/").length);
      const to = rest.length ? `${newPath}/${rest.join("/")}` : newPath;
      const move: TabMove<L> = { leaf: claim.leaf, from: claim.path, to };
      if (!eligible(to)) {
        this.files.release(claim.path, claim.leaf);
        out.ineligible.push(move);
      } else if (this.files.move(claim.path, to, claim.leaf)) {
        out.follow.push(move);
      } else {
        this.files.release(claim.path, claim.leaf);
        out.duplicate.push(move);
      }
    }
    return out;
  }

  /** `path` (a file or a folder) was deleted: release and return every claim under it. */
  remove(path: string): Claim<L>[] {
    const claims = this.under(path);
    for (const c of claims) this.files.release(c.path, c.leaf);
    return claims;
  }
}
