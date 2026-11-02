/**
 * The bottom edge (G1, G3): a thin line along the bottom of the main pane area that turns blue under the pointer. A click
 * toggles the drawer and a drag resizes it. It draws no label, icon or button of its own (F1): the element is empty, and
 * the colour, the position and the cursor come from the stylesheet.
 *
 * Pointer rules, in one place:
 *  - a press that ends within CLICK_SLOP px of where it began is a click: one toggle, on release;
 *  - a press that moves further is a resize from then on: the wanted height follows the pointer, and the release does not
 *    toggle, even if the pointer comes back to where it began;
 *  - a drag ends cleanly however it ends: a release anywhere (the pointer is captured, and the window listens too), a
 *    cancelled pointer, a lost capture, a window that loses focus, or a move that reports no button held (the release
 *    happened where this page never saw it). The page is then not left in a "dragging" state and no text stays selected.
 *    A drag that ends this way other than by a release is never a click.
 */

/** The most a press may move, in px, and still be a click. */
export const CLICK_SLOP = 4;

export interface BottomEdgeOptions {
  document: Document;
  window: Window;
  /** The drawer's height now; 0 while it is closed (a drag from a closed drawer grows from nothing). */
  heightNow(): number;
  /** A click: open the drawer if it is closed, close it if it is open. */
  onToggle(): void;
  /** A drag: the height the pointer asks for, not yet clamped. The owner clamps it and opens the drawer if needed. */
  onResize(wanted: number): void;
  /** A drag that moved ended: the height is final. */
  onResizeEnd(): void;
}

interface Drag {
  startY: number;
  startHeight: number;
  pointerId: number | null;
  moved: boolean;
}

export class BottomEdge {
  readonly element: HTMLElement;
  private drag: Drag | null = null;
  private dragCleanup: (() => void) | null = null;
  private mounted = false;
  private readonly onPointerDown = (ev: Event) => this.begin(ev as PointerEvent);

  constructor(private readonly opts: BottomEdgeOptions) {
    const el = opts.document.createElement("div");
    el.className = "vscw-edge";
    el.setAttribute("role", "separator");
    el.setAttribute("aria-orientation", "horizontal");
    this.element = el;
    el.addEventListener("pointerdown", this.onPointerDown);
  }

  get dragging(): boolean {
    return this.drag !== null;
  }

  mount(parent: HTMLElement = this.opts.document.body): void {
    if (this.mounted) return;
    this.mounted = true;
    parent.appendChild(this.element);
  }

  /** Take the edge off the page, or put it back. A drag in progress ends first (without a toggle). */
  setHidden(hidden: boolean): void {
    if (hidden) this.end("abandon");
    this.element.hidden = hidden;
  }

  dispose(): void {
    this.end("abandon");
    this.element.removeEventListener("pointerdown", this.onPointerDown);
    this.element.remove();
    this.mounted = false;
  }

  private begin(ev: PointerEvent): void {
    if (this.drag || (typeof ev.button === "number" && ev.button !== 0)) return;
    ev.preventDefault(); // no text selection, and the focus stays where it was
    const pointerId = typeof ev.pointerId === "number" ? ev.pointerId : null;
    this.drag = { startY: ev.clientY, startHeight: this.opts.heightNow(), pointerId, moved: false };
    try {
      if (pointerId !== null) this.element.setPointerCapture?.(pointerId);
    } catch {
      /* the pointer is already gone */
    }
    this.element.classList.add("vscw-dragging");
    const body = this.opts.document.body;
    body.classList.add("vscw-terminal-dragging");
    const win = this.opts.window;
    const move = (e: Event) => this.move(e as PointerEvent);
    const up = () => this.end("release");
    const stop = () => this.end("abandon");
    const noSelect = (e: Event) => e.preventDefault();
    win.addEventListener("pointermove", move);
    win.addEventListener("pointerup", up);
    win.addEventListener("pointercancel", stop);
    win.addEventListener("blur", stop);
    this.element.addEventListener("lostpointercapture", stop);
    this.opts.document.addEventListener("selectstart", noSelect);
    this.dragCleanup = () => {
      win.removeEventListener("pointermove", move);
      win.removeEventListener("pointerup", up);
      win.removeEventListener("pointercancel", stop);
      win.removeEventListener("blur", stop);
      this.element.removeEventListener("lostpointercapture", stop);
      this.opts.document.removeEventListener("selectstart", noSelect);
    };
  }

  private move(ev: PointerEvent): void {
    const drag = this.drag;
    if (!drag) return;
    // A move with no button down means the release happened where this page never saw it.
    if (typeof ev.buttons === "number" && ev.buttons === 0) {
      this.end("abandon");
      return;
    }
    const dy = drag.startY - ev.clientY;
    if (!drag.moved) {
      if (Math.abs(dy) <= CLICK_SLOP) return;
      drag.moved = true;
    }
    this.opts.onResize(drag.startHeight + dy);
  }

  /**
   * Stop dragging. "release" is the pointer coming up: a press that did not move is the click. "abandon" is every other
   * ending: never a click. Either way a drag that moved reports its final height. Safe to call when no drag is going.
   */
  private end(how: "release" | "abandon"): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    this.dragCleanup?.();
    this.dragCleanup = null;
    try {
      if (drag.pointerId !== null) this.element.releasePointerCapture?.(drag.pointerId);
    } catch {
      /* already released */
    }
    this.element.classList.remove("vscw-dragging");
    this.opts.document.body.classList.remove("vscw-terminal-dragging");
    if (drag.moved) {
      this.opts.window.getSelection?.()?.removeAllRanges(); // nothing stays selected from the drag
      this.opts.onResizeEnd();
    } else if (how === "release") {
      this.opts.onToggle();
    }
  }
}
