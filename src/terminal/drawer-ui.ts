/**
 * The drawer itself: a strip along the bottom edge of the window, and the drawer that
 * slides up from it (G8), a top edge to drag (G9), and the red messages for a shell
 * that could not start (E9, E10) or has ended. The terminal inside is a TerminalView
 * made by a factory, so this file needs no xterm and runs under jsdom.
 *
 * Geometry is driven by two CSS variables on <body>, so the drawer's height, the room
 * left under the workspace and the lifted status bar all move together in one transition:
 *   --vscw-height       the drawer's height when open (px)
 *   --vscw-open-height  that height while open, 0px while closed
 */
import { clampHeight } from "./drawer-geometry";
import type { DrawerState } from "./drawer-state";

/** What the drawer needs from a terminal emulator (xterm in the plugin, a fake in tests). */
export interface TerminalView {
  write(data: Uint8Array | string): void;
  /** Keystrokes and pastes typed into the terminal. */
  onInput(cb: (data: string) => void): void;
  /** The terminal's size in cells changed. */
  onResize(cb: (cols: number, rows: number) => void): void;
  /** The key that toggles the drawer was pressed inside the terminal (so the shell does not get it). */
  onToggleKey(cb: () => void): void;
  /** Fit the terminal to its container. */
  fit(): void;
  size(): { cols: number; rows: number };
  focus(): void;
  /** Clear the screen and scrollback (a new shell starts on a clean terminal). */
  reset(): void;
  /** Re-read the Obsidian theme (light or dark). */
  refreshTheme(): void;
  dispose(): void;
}

export interface DrawerOptions {
  document: Document;
  window: Window;
  /** The state to start from (already clamped). */
  initial: DrawerState;
  /** The state changed in a way worth saving: opened, closed, resized, or corrected by a clamp. */
  onChange(state: DrawerState): void;
  /** The drawer was revealed: make sure there is a shell. */
  onReveal(): void;
  /** The user asked to start the shell again (after it exited or failed). */
  onRestart(): void;
  createTerminal(host: HTMLElement): TerminalView;
}

export const STRIP_LABEL = "Terminal";
/** The strip's own height in px; the stylesheet uses the same number. */
export const STRIP_HEIGHT = 22;

type Message = { kind: "error"; text: string } | { kind: "exited"; text: string } | null;

export class DrawerUI {
  readonly root: HTMLElement;
  private readonly strip: HTMLButtonElement;
  private readonly drawer: HTMLElement;
  private readonly handle: HTMLElement;
  private readonly message: HTMLElement;
  private readonly messageText: HTMLElement;
  private readonly restartButton: HTMLButtonElement;
  private readonly host: HTMLElement;
  private view: TerminalView | null = null;
  private height: number;
  private isOpen: boolean;
  private mounted = false;
  private drag: { startY: number; startHeight: number; pointerId: number | null } | null = null;
  private pending: { cols: number; rows: number } | null = null;
  private readonly cleanups: Array<() => void> = [];
  private inputCb: ((data: string) => void) | null = null;
  private resizeCb: ((cols: number, rows: number) => void) | null = null;

  constructor(private readonly opts: DrawerOptions) {
    const d = opts.document;
    this.height = opts.initial.height;
    this.isOpen = opts.initial.open;

    this.root = d.createElement("div");
    this.root.className = "vscw-root";

    this.drawer = d.createElement("div");
    this.drawer.className = "vscw-drawer";
    this.drawer.setAttribute("role", "region");
    this.drawer.setAttribute("aria-label", "Terminal drawer");

    const inner = d.createElement("div");
    inner.className = "vscw-drawer-inner";

    this.handle = d.createElement("div");
    this.handle.className = "vscw-resize-handle";
    this.handle.setAttribute("role", "separator");
    this.handle.setAttribute("aria-orientation", "horizontal");
    this.handle.setAttribute("aria-label", "Resize terminal drawer");

    const header = d.createElement("div");
    header.className = "vscw-header";
    const title = d.createElement("span");
    title.className = "vscw-title";
    title.textContent = STRIP_LABEL;
    const actions = d.createElement("div");
    actions.className = "vscw-actions";
    const close = d.createElement("button");
    close.className = "vscw-close";
    close.type = "button";
    close.setAttribute("aria-label", "Close terminal drawer");
    close.textContent = "\u00d7";
    actions.appendChild(close);
    header.append(title, actions);

    this.message = d.createElement("div");
    this.message.className = "vscw-message";
    this.message.hidden = true;
    this.messageText = d.createElement("span");
    this.messageText.className = "vscw-message-text";
    this.restartButton = d.createElement("button");
    this.restartButton.className = "vscw-restart";
    this.restartButton.type = "button";
    this.restartButton.textContent = "Restart shell";
    this.message.append(this.messageText, this.restartButton);

    this.host = d.createElement("div");
    this.host.className = "vscw-terminal";

    inner.append(this.handle, header, this.message, this.host);
    this.drawer.appendChild(inner);

    this.strip = d.createElement("button");
    this.strip.className = "vscw-strip";
    this.strip.type = "button";
    this.strip.setAttribute("aria-label", "Toggle terminal drawer");
    this.strip.textContent = STRIP_LABEL;

    this.root.append(this.drawer, this.strip);

    this.listen(this.strip, "click", () => this.toggle());
    this.listen(close, "click", () => this.close());
    this.listen(this.restartButton, "click", () => opts.onRestart());
    this.listen(this.handle, "pointerdown", (ev) => this.beginDrag(ev as PointerEvent));
    this.listen(opts.window, "resize", () => this.onWindowResize());
  }

  // --- Mounting -----------------------------------------------------------

  mount(parent: HTMLElement = this.opts.document.body): void {
    if (this.mounted) return;
    this.mounted = true;
    parent.appendChild(this.root);
    this.opts.document.body.classList.add("vscw-terminal-on");
    this.apply();
    if (this.isOpen) this.reveal();
  }

  unmount(): void {
    for (const off of this.cleanups.splice(0)) off();
    this.endDrag(false);
    this.view?.dispose();
    this.view = null;
    this.root.remove();
    const body = this.opts.document.body;
    body.classList.remove("vscw-terminal-on", "vscw-terminal-open", "vscw-terminal-dragging");
    for (const v of ["--vscw-height", "--vscw-open-height"]) body.style.removeProperty(v);
    this.mounted = false;
  }

  // --- Open and closed ----------------------------------------------------

  get open(): boolean {
    return this.isOpen;
  }

  get currentHeight(): number {
    return this.height;
  }

  get terminal(): TerminalView | null {
    return this.view;
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.openDrawer();
  }

  openDrawer(): void {
    if (this.isOpen && this.view) return;
    this.isOpen = true;
    // The window may have shrunk while the drawer was closed.
    this.height = clampHeight(this.height, this.opts.window.innerHeight);
    this.apply();
    this.reveal();
    this.changed();
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.endDrag(false);
    this.apply();
    this.changed();
  }

  /** The drawer is showing: create the terminal the first time, make sure a shell exists, give it focus. */
  private reveal(): void {
    if (!this.view) this.createView();
    this.opts.onReveal();
    this.view?.focus();
  }

  private createView(): void {
    const view = this.opts.createTerminal(this.host);
    this.view = view;
    view.onInput((data) => this.inputCb?.(data));
    view.onResize((cols, rows) => this.resizeCb?.(cols, rows));
    view.onToggleKey(() => this.toggle());
    view.fit();
  }

  // --- The terminal and its messages --------------------------------------

  /** Where keystrokes typed into the terminal go. */
  onInput(cb: (data: string) => void): void {
    this.inputCb = cb;
  }

  /** Where the terminal's size goes when it changes. */
  onTerminalResize(cb: (cols: number, rows: number) => void): void {
    this.resizeCb = cb;
  }

  write(data: Uint8Array | string): void {
    this.view?.write(data);
  }

  /** A red message in place of the terminal (a shell that cannot start). */
  showError(text: string): void {
    this.setMessage({ kind: "error", text });
  }

  /** The shell ended: a line in the terminal, and the restart control. */
  showExited(code: number | null): void {
    const text = code === null ? "The shell has exited." : `The shell has exited (code ${code}).`;
    this.view?.write(`\r\n\x1b[2m[${text}]\x1b[0m\r\n`);
    this.setMessage({ kind: "exited", text });
  }

  /** A new shell is starting: clear the old screen and the message. */
  showStarting(): void {
    this.setMessage(null);
    this.view?.reset();
  }

  clearMessage(): void {
    this.setMessage(null);
  }

  private setMessage(m: Message): void {
    this.message.hidden = m === null;
    this.message.classList.toggle("vscw-error", m?.kind === "error");
    this.message.classList.toggle("vscw-exited", m?.kind === "exited");
    this.message.setAttribute("role", m?.kind === "error" ? "alert" : "status");
    this.messageText.textContent = m?.text ?? "";
    this.restartButton.textContent = m?.kind === "error" ? "Try again" : "Restart shell";
    // An error replaces the terminal: no blank terminal is left behind it.
    this.host.classList.toggle("vscw-hidden", m?.kind === "error");
    this.refit();
  }

  refreshTheme(): void {
    this.view?.refreshTheme();
  }

  // --- Applying the state to the page ---------------------------------------

  private apply(): void {
    const body = this.opts.document.body;
    body.style.setProperty("--vscw-height", `${this.height}px`);
    body.style.setProperty("--vscw-open-height", this.isOpen ? `${this.height}px` : "0px");
    this.root.classList.toggle("vscw-open", this.isOpen);
    body.classList.toggle("vscw-terminal-open", this.isOpen);
    this.strip.setAttribute("aria-expanded", String(this.isOpen));
  }

  private changed(): void {
    this.opts.onChange({ height: this.height, open: this.isOpen });
  }

  private refit(): void {
    if (this.isOpen) this.view?.fit();
  }

  // --- Dragging the top edge (G9, E14) ---------------------------------------

  private beginDrag(ev: PointerEvent): void {
    if (this.drag || (typeof ev.button === "number" && ev.button !== 0)) return;
    ev.preventDefault();
    this.drag = { startY: ev.clientY, startHeight: this.height, pointerId: typeof ev.pointerId === "number" ? ev.pointerId : null };
    try {
      if (this.drag.pointerId !== null) this.handle.setPointerCapture?.(this.drag.pointerId);
    } catch {
      /* the pointer is already gone */
    }
    this.root.classList.add("vscw-dragging");
    this.opts.document.body.classList.add("vscw-terminal-dragging");
    const win = this.opts.window;
    const move = (e: Event) => this.onDragMove(e as PointerEvent);
    const stop = () => this.endDrag(true);
    win.addEventListener("pointermove", move);
    // A release anywhere ends the drag: over the page, outside the window, or by losing the pointer.
    win.addEventListener("pointerup", stop);
    win.addEventListener("pointercancel", stop);
    win.addEventListener("blur", stop);
    this.handle.addEventListener("lostpointercapture", stop);
    this.dragCleanup = () => {
      win.removeEventListener("pointermove", move);
      win.removeEventListener("pointerup", stop);
      win.removeEventListener("pointercancel", stop);
      win.removeEventListener("blur", stop);
      this.handle.removeEventListener("lostpointercapture", stop);
    };
  }

  private dragCleanup: (() => void) | null = null;

  private onDragMove(ev: PointerEvent): void {
    if (!this.drag) return;
    // A move with no button down means the release happened where this page never saw it.
    if (typeof ev.buttons === "number" && ev.buttons === 0) {
      this.endDrag(true);
      return;
    }
    const wanted = this.drag.startHeight + (this.drag.startY - ev.clientY);
    const next = clampHeight(wanted, this.opts.window.innerHeight);
    if (next === this.height) return;
    this.height = next;
    this.apply();
    this.refit(); // the terminal follows the edge during the drag
  }

  /** Stop dragging. `save` also stores the height and refits. Safe to call when no drag is going. */
  private endDrag(save: boolean): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    this.dragCleanup?.();
    this.dragCleanup = null;
    try {
      if (drag.pointerId !== null) this.handle.releasePointerCapture?.(drag.pointerId);
    } catch {
      /* already released */
    }
    this.root.classList.remove("vscw-dragging");
    this.opts.document.body.classList.remove("vscw-terminal-dragging");
    if (save) {
      this.refit();
      this.changed();
    }
  }

  /** The window changed size: a drawer taller than the new maximum shrinks to it, and the corrected height is stored. */
  private onWindowResize(): void {
    const next = clampHeight(this.height, this.opts.window.innerHeight);
    if (next === this.height) return;
    this.height = next;
    this.apply();
    this.refit();
    this.changed();
  }

  private listen(target: EventTarget, name: string, fn: (ev: Event) => void): void {
    target.addEventListener(name, fn);
    this.cleanups.push(() => target.removeEventListener(name, fn));
  }
}
