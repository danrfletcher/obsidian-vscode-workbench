/**
 * One Code tab per file (Q16, G1): opening a file that is already open in a
 * Code tab focuses that tab instead of adding another, from any entry point
 * (explorer, quick switcher, link, command, split, another leaf), and also when
 * the same file is opened twice in a row while the first tab is still loading.
 *
 * Two things make that hold:
 *  - a synchronous claim: the tab that is first to set its state for a file owns
 *    it until it closes, so a second tab asking for the same file in the same
 *    tick already sees the claim, before any await;
 *  - a workspace look-up of the Code leaves' saved state, which also finds tabs
 *    restored from the last session that have not loaded yet.
 */

/** The part of a workspace leaf this needs. */
export interface LeafLike {
  getViewState?(): { type?: string; state?: unknown };
}

/** The key two spellings of one path share: macOS stores names decomposed (NFD), typed names are composed (NFC). */
export function fileKey(file: string): string {
  return file.normalize("NFC");
}

function stateFile(leaf: LeafLike): string | null {
  try {
    const f = (leaf.getViewState?.().state as { file?: unknown } | undefined)?.file;
    return typeof f === "string" && f !== "" ? f : null;
  } catch {
    return null;
  }
}

/** One claim: the tab and the path it was given (the path as the vault spells it). */
export interface Claim<L> {
  path: string;
  leaf: L;
}

export class OpenFiles<L extends LeafLike> {
  private readonly claims = new Map<string, Claim<L>>();
  private readonly pending = new Map<string, Promise<void>>();

  /** @param codeLeaves every leaf that holds, or is about to hold, a Code tab (including ones not loaded yet) */
  constructor(private readonly codeLeaves: () => L[]) {}

  /**
   * Claim `file` for `leaf`. Returns the other leaf that already shows the
   * file (the caller focuses it and drops `leaf`), or null when `leaf` now owns it.
   */
  claim(file: string, leaf: L): L | null {
    const other = this.existing(file, leaf);
    if (other) return other;
    this.claims.set(fileKey(file), { path: file, leaf });
    return null;
  }

  /** Every claim, in the order they were taken. */
  entries(): Claim<L>[] {
    return [...this.claims.values()];
  }

  /**
   * The tab that showed `from` now shows `to`: the claim moves with it, in one step, so there is no moment
   * when either path is unclaimed. False (nothing changes) when `leaf` does not hold `from`, or another
   * tab already holds `to` (one tab per file).
   */
  move(from: string, to: string, leaf: L): boolean {
    const fromKey = fileKey(from);
    const toKey = fileKey(to);
    if (this.claims.get(fromKey)?.leaf !== leaf) return false;
    if (fromKey === toKey) {
      this.claims.set(toKey, { path: to, leaf });
      return true;
    }
    const other = this.claims.get(toKey);
    if (other && other.leaf !== leaf) return false;
    this.claims.delete(fromKey);
    this.claims.set(toKey, { path: to, leaf });
    return true;
  }

  /** Give a claim back (the tab closed, or moved to another file). A claim held by another leaf is left alone. */
  release(file: string, leaf: L): void {
    const key = fileKey(file);
    if (this.claims.get(key)?.leaf === leaf) this.claims.delete(key);
  }

  /** The leaf already showing `file`, other than `except`, or null. */
  existing(file: string, except?: L): L | null {
    const key = fileKey(file);
    const claimed = this.claims.get(key)?.leaf;
    if (claimed && claimed !== except) return claimed;
    for (const leaf of this.codeLeaves()) {
      if (leaf === except) continue;
      const f = stateFile(leaf);
      if (f !== null && fileKey(f) === key) return leaf;
    }
    return null;
  }

  /**
   * Open `file` once. An existing tab is focused; a second call that arrives while the
   * first is still creating its tab waits for it and then focuses it (no duplicate).
   */
  async openOnce(file: string, create: () => Promise<void>, focus: (leaf: L) => Promise<void> | void): Promise<void> {
    const key = fileKey(file);
    for (;;) {
      const there = this.existing(file);
      if (there) return void (await focus(there));
      const inFlight = this.pending.get(key);
      if (!inFlight) break;
      await inFlight.catch(() => undefined);
    }
    const p = create().finally(() => {
      if (this.pending.get(key) === p) this.pending.delete(key);
    });
    this.pending.set(key, p);
    await p;
  }
}
