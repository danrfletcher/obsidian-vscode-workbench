/**
 * The status-bar item that shows how many shells are running (G18). It follows the shell
 * count and nothing else: the non-code setting and whether the drawer is open do not
 * hide it. It exists while one or more shells run and is taken off the page at zero.
 */

/** The item's text, or null when there is nothing to show (no shells). */
export function shellCountLabel(count: number): string | null {
  if (!Number.isFinite(count) || count < 1) return null;
  const n = Math.floor(count);
  return n === 1 ? "1 shell" : `${n} shells`;
}

export class ShellCountItem {
  private el: HTMLElement | null = null;

  /** `add` creates the status-bar element (Obsidian's `addStatusBarItem`). */
  constructor(private readonly add: () => HTMLElement) {}

  get element(): HTMLElement | null {
    return this.el;
  }

  update(count: number): void {
    const label = shellCountLabel(count);
    if (label === null) {
      this.el?.remove();
      this.el = null;
      return;
    }
    if (!this.el) {
      this.el = this.add();
      this.el.classList.add("vscw-shell-count");
      this.el.setAttribute("aria-label", "Running terminal shells");
    }
    this.el.textContent = label;
  }

  dispose(): void {
    this.update(0);
  }
}
