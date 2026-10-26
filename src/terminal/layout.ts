/**
 * Where the drawer sits and how much room it takes (G11). The drawer spans only the main
 * pane area (Obsidian's root split), not the sidebars: it takes that area's left edge and
 * width, and the area is shortened by the drawer's height with a bottom margin, so the
 * sidebars keep the full window height. Closing the drawer, or hiding it, sets the offset
 * to zero (the bottom margin is gone, so no gap is left); disposing removes every variable.
 *
 * The page variables, all on <body>:
 *   --vscw-left         the drawer's left edge (px)
 *   --vscw-width        the drawer's width (px)
 *   --vscw-status-lift  how far the status bar moves up to clear the drawer (px)
 */

export interface Rect {
  left: number;
  right: number;
  width: number;
}

export interface Bounds {
  left: number;
  width: number;
  /** The height taken from the main pane area: the drawer's height while it is open, else 0. */
  offset: number;
  /** The status bar floats at the window's bottom right; it is lifted only when the drawer reaches that corner. */
  statusLift: number;
}

export const NO_BOUNDS: Readonly<Bounds> = { left: 0, width: 0, offset: 0, statusLift: 0 };

/**
 * The drawer's bounds from the main pane area's rectangle. With no rectangle (no root split on the
 * page) the drawer spans the window. `openHeight` is the drawer's height while it is open and 0 when it is
 * closed or hidden; a negative or non-numeric height counts as 0.
 */
export function computeBounds(main: Rect | null, windowWidth: number, openHeight: number): Bounds {
  const offset = Number.isFinite(openHeight) && openHeight > 0 ? Math.round(openHeight) : 0;
  const left = main ? Math.max(0, Math.round(main.left)) : 0;
  const width = main ? Math.max(0, Math.round(main.width)) : Math.max(0, Math.round(windowWidth));
  const reachesRight = left + width >= Math.round(windowWidth) - 1;
  return { left, width, offset, statusLift: reachesRight ? offset : 0 };
}

export const MAIN_PANE_SELECTOR = ".workspace-split.mod-root";
const SIDEBAR_SELECTORS = [".workspace-split.mod-left-split", ".workspace-split.mod-right-split"];
const VARS = ["--vscw-left", "--vscw-width", "--vscw-status-lift"];

export interface LayoutOptions {
  document: Document;
  window: Window;
  /** The drawer's left edge or width changed: its terminal needs to fit again. */
  onChange?(bounds: Bounds): void;
}

export class LayoutController {
  private openHeight = 0;
  private current: Bounds = { ...NO_BOUNDS };
  private observer: ResizeObserver | null = null;
  private observed = new Set<Element>();
  private onWindowResize = () => this.refresh();
  private disposed = false;

  constructor(private readonly opts: LayoutOptions) {
    opts.window.addEventListener("resize", this.onWindowResize);
    const RO = (opts.window as unknown as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    if (typeof RO === "function") this.observer = new RO(() => this.refresh());
  }

  get bounds(): Bounds {
    return this.current;
  }

  /** The drawer's open height; 0 when it is closed or hidden. */
  setOpenHeight(px: number): void {
    this.openHeight = px;
    this.refresh();
  }

  /** Measure the main pane area again and write the variables. Safe to call at any time. */
  refresh(): void {
    if (this.disposed) return;
    // Closed or hidden: no offset and no lift, but the last left and width stay, so a closing drawer slides down in place.
    const next = this.openHeight > 0 ? computeBounds(this.measure(), this.opts.window.innerWidth, this.openHeight) : { ...this.current, offset: 0, statusLift: 0 };
    const moved = next.left !== this.current.left || next.width !== this.current.width;
    this.current = next;
    this.write(next);
    if (moved && next.offset > 0) this.opts.onChange?.(next);
  }

  dispose(): void {
    this.disposed = true;
    this.opts.window.removeEventListener("resize", this.onWindowResize);
    this.observer?.disconnect();
    this.observed.clear();
    this.write(NO_BOUNDS);
  }

  private measure(): Rect | null {
    const doc = this.opts.document;
    const main = doc.querySelector(MAIN_PANE_SELECTOR);
    this.watch([main, ...SIDEBAR_SELECTORS.map((s) => doc.querySelector(s))]);
    if (!main) return null;
    const r = main.getBoundingClientRect();
    return { left: r.left, right: r.right, width: r.width };
  }

  /** Follow the main pane area and the sidebars as they change size (collapse, expand, drag), including a re-created element. */
  private watch(elements: Array<Element | null>): void {
    if (!this.observer) return;
    const live = new Set(elements.filter((e): e is Element => e !== null));
    for (const e of this.observed) {
      if (!live.has(e)) {
        this.observer.unobserve(e);
        this.observed.delete(e);
      }
    }
    for (const e of live) {
      if (!this.observed.has(e)) {
        this.observer.observe(e);
        this.observed.add(e);
      }
    }
  }

  private write(b: Bounds): void {
    const style = this.opts.document.body.style;
    if (b === NO_BOUNDS) {
      for (const v of VARS) style.removeProperty(v);
      return;
    }
    style.setProperty("--vscw-left", `${b.left}px`);
    style.setProperty("--vscw-width", `${b.width}px`);
    style.setProperty("--vscw-status-lift", `${b.statusLift}px`);
  }
}
