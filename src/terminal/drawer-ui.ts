/**
 * The drawer itself: a strip along the bottom edge of the window, and the drawer that
 * slides up from it (G8), a top edge to drag (G9), one tab per shell session with + and
 * trash (G10), and the red messages for a shell that could not start (E9, E10) or has
 * ended. Each session has its own pane and its own terminal; switching tabs only shows
 * another pane, so no shell restarts and no scrollback is cleared. The terminal inside is
 * a TerminalView made by a factory, so this file needs no xterm and runs under jsdom.
 *
 * Geometry is driven by CSS variables on <body>, so the drawer's height, the room taken
 * from the main pane area and the lifted status bar all move together in one transition:
 *   --vscw-height       the drawer's height when open (px)
 *   --vscw-open-height  that height while open, 0px while closed or hidden
 * The drawer's left edge and width come from the layout controller (layout.ts).
 */
import { clampHeight } from "./drawer-geometry";
import type { DrawerState } from "./drawer-state";
import type { LayoutController } from "./layout";

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
  /** The + button. */
  onNewSession(): void;
  /** The trash button: end the active session. */
  onKillActive(): void;
  /** A tab was clicked. */
  onSelect(id: string): void;
  /** The user asked to start session `id`'s shell again (after it exited or failed). */
  onRestart(id: string): void;
  createTerminal(host: HTMLElement): TerminalView;
  /** The drawer closed. `hadFocus` is true when keyboard focus was inside it (the terminal), so the caller can hand it back to the editor (GP5e). */
  onClosed?(hadFocus: boolean): void;
  /** Takes the drawer's open height and bounds into account for the main pane area. */
  layout?: LayoutController;
}

export const STRIP_LABEL = "Terminal";
/** The strip's own height in px; the stylesheet uses the same number. */
export const STRIP_HEIGHT = 22;

type Message = { kind: "error"; text: string } | { kind: "exited"; text: string } | null;

/** One session's pane: its terminal, its message line and its tab. */
interface Pane {
  id: string;
  tab: HTMLElement;
  label: HTMLElement;
  pane: HTMLElement;
  message: HTMLElement;
  messageText: HTMLElement;
  restart: HTMLButtonElement;
  host: HTMLElement;
  view: TerminalView;
}

export class DrawerUI {
  readonly root: HTMLElement;
  private readonly strip: HTMLButtonElement;
  private readonly drawer: HTMLElement;
  private readonly handle: HTMLElement;
  private readonly tabs: HTMLElement;
  private readonly panes: HTMLElement;
  private readonly panesById = new Map<string, Pane>();
  private activeId: string | null = null;
  private height: number;
  private isOpen: boolean;
  private isHidden = false;
  private mounted = false;
  private drag: { startY: number; startHeight: number; pointerId: number | null } | null = null;
  private readonly cleanups: Array<() => void> = [];
  private inputCb: ((id: string, data: string) => void) | null = null;
  private resizeCb: ((id: string, cols: number, rows: number) => void) | null = null;

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
    this.tabs = d.createElement("div");
    this.tabs.className = "vscw-tabs";
    this.tabs.setAttribute("role", "tablist");
    this.tabs.setAttribute("aria-label", "Terminal sessions");
    const actions = d.createElement("div");
    actions.className = "vscw-actions";
    // The + and trash icons are drawn by the stylesheet, so the buttons hold no children.
    const add = this.button("vscw-new", "New terminal");
    const trash = this.button("vscw-trash", "Kill terminal");
    const close = this.button("vscw-close", "Close terminal drawer");
    close.textContent = "\u00d7";
    actions.append(add, trash, close);
    header.append(this.tabs, actions);

    this.panes = d.createElement("div");
    this.panes.className = "vscw-panes";

    inner.append(this.handle, header, this.panes);
    this.drawer.appendChild(inner);

    this.strip = d.createElement("button");
    this.strip.className = "vscw-strip";
    this.strip.type = "button";
    this.strip.setAttribute("aria-label", "Toggle terminal drawer");
    this.strip.textContent = STRIP_LABEL;

    this.root.append(this.drawer, this.strip);

    this.listen(this.strip, "click", () => this.toggle());
    this.listen(close, "click", () => this.close());
    this.listen(add, "click", () => opts.onNewSession());
    this.listen(trash, "click", () => opts.onKillActive());
    this.listen(this.handle, "pointerdown", (ev) => this.beginDrag(ev as PointerEvent));
    this.listen(opts.window, "resize", () => this.onWindowResize());
  }

  private button(cls: string, label: string): HTMLButtonElement {
    const b = this.opts.document.createElement("button");
    b.className = cls;
    b.type = "button";
    b.setAttribute("aria-label", label);
    b.title = label;
    return b;
  }

  // --- Mounting -----------------------------------------------------------

  mount(parent: HTMLElement = this.opts.document.body): void {
    if (this.mounted) return;
    this.mounted = true;
    parent.appendChild(this.root);
    this.apply();
    if (this.isOpen && !this.isHidden) this.reveal();
  }

  unmount(): void {
    for (const off of this.cleanups.splice(0)) off();
    this.endDrag(false);
    for (const p of this.panesById.values()) p.view.dispose();
    this.panesById.clear();
    this.activeId = null;
    this.opts.layout?.setOpenHeight(0);
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

  /** The strip and drawer are off the page (the non-code setting is off over this view). */
  get hidden(): boolean {
    return this.isHidden;
  }

  get currentHeight(): number {
    return this.height;
  }

  /** The active session's terminal; null with no sessions. */
  get terminal(): TerminalView | null {
    return this.activeId ? (this.panesById.get(this.activeId)?.view ?? null) : null;
  }

  terminalOf(id: string): TerminalView | null {
    return this.panesById.get(id)?.view ?? null;
  }

  get sessionIds(): string[] {
    return [...this.panesById.keys()];
  }

  get active(): string | null {
    return this.activeId;
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.openDrawer();
  }

  openDrawer(): void {
    if (this.isOpen && this.panesById.size > 0) return;
    this.isOpen = true;
    // The window may have shrunk while the drawer was closed.
    this.height = clampHeight(this.height, this.opts.window.innerHeight);
    this.apply();
    this.reveal();
    this.changed();
  }

  close(): void {
    if (!this.isOpen) return;
    const active = this.opts.document.activeElement;
    const hadFocus = !!active && this.root.contains(active);
    this.isOpen = false;
    this.endDrag(false);
    this.apply();
    this.changed();
    this.opts.onClosed?.(hadFocus);
  }

  /** Show or take off the whole strip and drawer. The open state, the shells and their scrollback are untouched. */
  setHidden(hidden: boolean): void {
    if (this.isHidden === hidden) return;
    this.isHidden = hidden;
    if (hidden) this.endDrag(false);
    this.apply();
    if (!hidden) {
      this.refit();
      if (this.isOpen) this.terminal?.focus();
    }
  }

  /** The drawer is showing: make sure there is a shell, give the active one focus. */
  private reveal(): void {
    this.opts.onReveal();
    this.terminal?.focus();
  }

  // --- Sessions -------------------------------------------------------------

  /** Add a session's tab, pane and terminal. It is not shown until `setActive`. */
  addSession(id: string, title: string): void {
    if (this.panesById.has(id)) return;
    const d = this.opts.document;
    const tab = d.createElement("div");
    tab.className = "vscw-tab";
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", "false");
    tab.dataset.session = id;
    tab.tabIndex = 0;
    const label = d.createElement("span");
    label.className = "vscw-tab-label";
    label.textContent = title;
    tab.appendChild(label);
    this.tabs.appendChild(tab);

    const pane = d.createElement("div");
    pane.className = "vscw-pane";
    pane.hidden = true;
    pane.dataset.session = id;
    const message = d.createElement("div");
    message.className = "vscw-message";
    message.hidden = true;
    const messageText = d.createElement("span");
    messageText.className = "vscw-message-text";
    const restart = d.createElement("button");
    restart.className = "vscw-restart";
    restart.type = "button";
    restart.textContent = "Restart shell";
    message.append(messageText, restart);
    const host = d.createElement("div");
    host.className = "vscw-terminal";
    pane.append(message, host);
    this.panes.appendChild(pane);

    const view = this.opts.createTerminal(host);
    view.onInput((data) => this.inputCb?.(id, data));
    view.onResize((cols, rows) => this.resizeCb?.(id, cols, rows));
    view.onToggleKey(() => this.toggle());

    const entry: Pane = { id, tab, label, pane, message, messageText, restart, host, view };
    this.panesById.set(id, entry);
    tab.addEventListener("click", () => this.opts.onSelect(id));
    tab.addEventListener("keydown", (ev) => {
      const k = (ev as KeyboardEvent).key;
      if (k === "Enter" || k === " ") {
        ev.preventDefault();
        this.opts.onSelect(id);
      }
    });
    restart.addEventListener("click", () => this.opts.onRestart(id));
  }

  /** Take a session's tab, pane and terminal away. The next tab is chosen by the caller (`setActive`). */
  removeSession(id: string): void {
    const p = this.panesById.get(id);
    if (!p) return;
    this.panesById.delete(id);
    p.view.dispose();
    p.tab.remove();
    p.pane.remove();
    if (this.activeId === id) this.activeId = null;
  }

  /** Show session `id`'s pane (null: none). The other panes stay as they are, hidden. */
  setActive(id: string | null): void {
    this.activeId = id !== null && this.panesById.has(id) ? id : null;
    for (const p of this.panesById.values()) {
      const on = p.id === this.activeId;
      p.pane.hidden = !on;
      p.tab.classList.toggle("vscw-active", on);
      p.tab.setAttribute("aria-selected", String(on));
    }
    if (this.activeId) {
      this.refit();
      if (this.isOpen && !this.isHidden) this.terminal?.focus();
    }
  }

  /** Where keystrokes typed into any session's terminal go. */
  onInput(cb: (id: string, data: string) => void): void {
    this.inputCb = cb;
  }

  /** Where a terminal's size goes when it changes. */
  onTerminalResize(cb: (id: string, cols: number, rows: number) => void): void {
    this.resizeCb = cb;
  }

  write(id: string, data: Uint8Array | string): void {
    this.panesById.get(id)?.view.write(data);
  }

  /** A red message in place of the session's terminal (a shell that cannot start). */
  showError(id: string, text: string): void {
    this.setMessage(id, { kind: "error", text });
  }

  /** The shell ended: a line in the terminal, and the restart control. */
  showExited(id: string, code: number | null): void {
    const text = code === null ? "The shell has exited." : `The shell has exited (code ${code}).`;
    this.panesById.get(id)?.view.write(`\r\n\x1b[2m[${text}]\x1b[0m\r\n`);
    this.setMessage(id, { kind: "exited", text });
  }

  /** A new shell is starting in the session: clear the old screen and the message. */
  showStarting(id: string): void {
    this.setMessage(id, null);
    this.panesById.get(id)?.view.reset();
  }

  clearMessage(id: string): void {
    this.setMessage(id, null);
  }

  private setMessage(id: string, m: Message): void {
    const p = this.panesById.get(id);
    if (!p) return;
    p.message.hidden = m === null;
    p.message.classList.toggle("vscw-error", m?.kind === "error");
    p.message.classList.toggle("vscw-exited", m?.kind === "exited");
    p.message.setAttribute("role", m?.kind === "error" ? "alert" : "status");
    p.messageText.textContent = m?.text ?? "";
    p.restart.textContent = m?.kind === "error" ? "Try again" : "Restart shell";
    p.tab.classList.toggle("vscw-tab-error", m?.kind === "error");
    p.tab.classList.toggle("vscw-tab-exited", m?.kind === "exited");
    // An error replaces the terminal: no blank terminal is left behind it.
    p.host.classList.toggle("vscw-hidden", m?.kind === "error");
    if (id === this.activeId) this.refit();
  }

  refreshTheme(): void {
    for (const p of this.panesById.values()) p.view.refreshTheme();
  }

  /** Fit the active terminal to its pane (the drawer's width or height changed). */
  refit(): void {
    if (this.isOpen && !this.isHidden) this.terminal?.fit();
  }

  // --- Applying the state to the page ---------------------------------------

  private apply(): void {
    const body = this.opts.document.body;
    const shown = this.isOpen && !this.isHidden;
    body.classList.toggle("vscw-terminal-on", !this.isHidden);
    body.style.setProperty("--vscw-height", `${this.height}px`);
    body.style.setProperty("--vscw-open-height", shown ? `${this.height}px` : "0px");
    this.root.hidden = this.isHidden;
    this.root.classList.toggle("vscw-open", this.isOpen);
    body.classList.toggle("vscw-terminal-open", shown);
    this.strip.setAttribute("aria-expanded", String(this.isOpen));
    this.opts.layout?.setOpenHeight(shown ? this.height : 0);
  }

  private changed(): void {
    this.opts.onChange({ height: this.height, open: this.isOpen });
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
