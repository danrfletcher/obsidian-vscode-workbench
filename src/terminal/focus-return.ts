/**
 * Where keyboard focus goes when the drawer hides (G1): back to the view that had it when the drawer opened, or to the
 * active leaf if that view is gone. Generic over the leaf type so it runs without Obsidian.
 */
export interface FocusDeps<L> {
  /** The leaf the user is on now; null when there is none. */
  activeLeaf(): L | null;
  /** The leaf is still in the workspace (its tab was not closed). */
  isAlive(leaf: L): boolean;
  /** Give the leaf's view keyboard focus. */
  focusLeaf(leaf: L): void;
}

export class FocusReturn<L> {
  private leaf: L | null = null;

  constructor(private readonly deps: FocusDeps<L>) {}

  /** The drawer is opening: note which view has focus now. */
  remember(): void {
    this.leaf = this.deps.activeLeaf();
  }

  /** The drawer has hidden: focus the remembered view, else the active leaf. Forgets what it remembered. */
  restore(): void {
    const remembered = this.leaf;
    this.leaf = null;
    const target = remembered !== null && this.deps.isAlive(remembered) ? remembered : this.deps.activeLeaf();
    if (target !== null) this.deps.focusLeaf(target);
  }
}
