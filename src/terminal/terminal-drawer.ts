/**
 * The terminal drawer as the plugin uses it (G1, G3, G4, G6, E9): the bottom edge, the open/closed state, the height, and
 * the layout, wired to the terminal host page. It shows and hides the host page and gives it the room; the terminal itself
 * is VS Code's, drawn by the page. It draws nothing of its own but the edge.
 *
 * Page variables, all on <body> (the stylesheet turns them into positions):
 *   --vscw-height       the drawer's height (px), kept while it is closed
 *   --vscw-open-height  that height while it is open, 0px while it is closed
 * and, from the layout controller, --vscw-left, --vscw-width and --vscw-status-lift (layout.ts).
 *
 * The open state lives only in memory: the drawer is closed at launch. Every toggle, from the edge, the command or the
 * hotkey bridge, goes through `toggle`, which flips the state synchronously, so ten presses in a second end open after an
 * odd count and closed after an even count, with the one host page.
 */
import type { PageProgress, ToggleTarget } from "../hotkey/drawer-toggle";
import type { HostView } from "../terminal-host/host-state";
import { BottomEdge } from "./bottom-edge";
import { clampHeight } from "./drawer-geometry";
import { drawerVisibility, type ViewKind, type Visibility } from "./drawer-visibility";
import type { FocusHandoff } from "./focus-return";
import { LayoutController } from "./layout";

/** The terminal host page, as the drawer drives it. */
export interface DrawerHost {
  show(): void;
  hide(): void;
  /** Focus goes into the terminal, by a script running in the host page. */
  focusTerminal(): void;
  view(): HostView;
}

export interface TerminalDrawerOptions {
  document: Document;
  window: Window;
  /** The host page; null once the plugin has unloaded (the drawer then does nothing). */
  host(): DrawerHost | null;
  /** This device's saved height, already clamped. */
  initialHeight: number;
  /** The height changed and is final (a drag ended, or the window forced a new one): save it. */
  saveHeight(height: number): void;
  /** The kind of the view the user is on. */
  viewKind(): ViewKind;
  /** The "drawer over non-code views" setting, read each time it matters so a change applies live. */
  nonCodeDrawer(): boolean;
  /** Remembers the view that has focus when the drawer opens and gives it back when the drawer hides. */
  focus: FocusHandoff;
}

export class TerminalDrawer implements ToggleTarget {
  private height: number;
  private open = false;
  private disposed = false;
  /** A drag opened the drawer: focus goes into the terminal when the drag ends, not while it runs (see openDrawer). */
  private focusAfterDrag = false;
  private edge: BottomEdge | null = null;
  private layout: LayoutController | null = null;
  private readonly onWindowResize = () => this.windowResized();

  constructor(private readonly opts: TerminalDrawerOptions) {
    this.height = opts.initialHeight;
  }

  // --- ToggleTarget (the hotkey bridge) ------------------------------------------------------------------------

  get isOpen(): boolean {
    return this.open;
  }

  get currentHeight(): number {
    return this.height;
  }

  /** The reveal command and its hotkey are explicit actions: they work over every view (G6). */
  hotkeyEnabled(): boolean {
    return this.visibility().hotkey;
  }

  /** What the host page is doing, in the words the toggle uses: not started, starting, running, or ended (failed). */
  pageProgress(): PageProgress {
    switch (this.opts.host()?.view() ?? "hidden") {
      case "hidden":
      case "stopped":
        return "none";
      case "licence":
      case "starting":
        return "starting";
      case "error":
      case "crashed":
        return "ended";
      default:
        return "running";
    }
  }

  // --- Mounting -------------------------------------------------------------------------------------------------

  /** Put the edge on the page. Call once the workspace is ready (the main pane area exists then). Safe to call twice. */
  mount(): void {
    if (this.edge || this.disposed) return;
    const doc = this.opts.document;
    if (!doc?.body || typeof doc.createElement !== "function") return; // a host with no page to draw on
    this.layout = new LayoutController({ document: doc, window: this.opts.window });
    this.edge = new BottomEdge({
      document: doc,
      window: this.opts.window,
      heightNow: () => (this.open ? this.height : 0),
      onToggle: () => this.toggle(),
      onResize: (wanted) => this.resizeTo(wanted),
      onResizeEnd: () => this.resizeEnded(),
    });
    this.edge.mount(doc.body);
    this.opts.window.addEventListener("resize", this.onWindowResize);
    this.apply();
  }

  dispose(): void {
    this.disposed = true;
    this.open = false;
    this.focusAfterDrag = false;
    if (!this.edge) return; // never mounted: nothing of ours is on the page
    this.opts.window.removeEventListener("resize", this.onWindowResize);
    this.edge.dispose();
    this.edge = null;
    this.layout?.dispose();
    this.layout = null;
    const body = this.opts.document.body;
    body.classList.remove("vscw-drawer-on", "vscw-drawer-open", "vscw-terminal-dragging");
    for (const v of ["--vscw-height", "--vscw-open-height"]) body.style.removeProperty(v);
  }

  // --- Open and closed ------------------------------------------------------------------------------------------

  toggle(): void {
    if (this.open) this.close();
    else this.openDrawer();
  }

  openDrawer(): void {
    const host = this.disposed ? null : this.opts.host();
    if (!host || this.open) return;
    // The window may have shrunk since the height was saved (E9).
    const clamped = clampHeight(this.height, this.opts.window.innerHeight);
    if (clamped !== this.height) {
      this.height = clamped;
      this.opts.saveHeight(clamped);
    }
    this.opts.focus.remember(); // before the terminal takes focus
    this.open = true;
    this.apply();
    host.show();
    // Focus moving into the host page's webview blurs this window, which the edge reads as the end of a drag. So while
    // a drag is going the focus waits for its end (resizeEnded).
    if (this.edge?.dragging) this.focusAfterDrag = true;
    else host.focusTerminal();
  }

  /** A drag that moved has ended: the height is final, and a drag that opened the drawer now hands focus to the terminal. */
  private resizeEnded(): void {
    this.opts.saveHeight(this.height);
    const focus = this.focusAfterDrag;
    this.focusAfterDrag = false;
    if (focus && this.open && !this.disposed) this.opts.host()?.focusTerminal();
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.focusAfterDrag = false;
    this.opts.host()?.hide();
    this.apply();
    this.opts.focus.restore();
  }

  /** The host page closed itself (the licence was declined): the drawer follows, with its notice already shown. */
  hostClosed(): void {
    if (!this.open) return;
    this.open = false;
    this.focusAfterDrag = false;
    this.apply();
    this.opts.focus.restore();
  }

  // --- Views and layout -----------------------------------------------------------------------------------------

  /** What the edge, the drawer and the hotkey do over the view the user is on and with the setting as it is now. */
  visibility(): Visibility {
    return drawerVisibility({ kind: this.opts.viewKind(), nonCodeDrawer: this.opts.nonCodeDrawer(), drawerOpen: this.open });
  }

  /** The view changed or the setting did: show or take off the edge. An open drawer and its terminal are untouched. */
  applyVisibility(): void {
    this.apply();
  }

  /** The main pane area changed shape (a tab moved, a sidebar was collapsed): measure again. */
  layoutChanged(): void {
    this.layout?.refresh();
  }

  // --- Resizing -------------------------------------------------------------------------------------------------

  /** A drag asks for `wanted` px. A closed drawer opens first. */
  private resizeTo(wanted: number): void {
    const next = clampHeight(wanted, this.opts.window.innerHeight);
    if (!this.open) {
      this.height = next;
      this.openDrawer();
      return;
    }
    if (next === this.height) return;
    this.height = next;
    this.apply();
  }

  /** The window changed size: a drawer taller than the new maximum shrinks to it, and the corrected height is saved (E9). */
  private windowResized(): void {
    const next = clampHeight(this.height, this.opts.window.innerHeight);
    if (next === this.height) return;
    this.height = next;
    this.apply();
    this.opts.saveHeight(next);
  }

  // --- Applying the state to the page ---------------------------------------------------------------------------

  private apply(): void {
    if (!this.edge || !this.layout || this.disposed) return;
    const body = this.opts.document.body;
    body.classList.add("vscw-drawer-on");
    body.classList.toggle("vscw-drawer-open", this.open);
    body.style.setProperty("--vscw-height", `${this.height}px`);
    body.style.setProperty("--vscw-open-height", this.open ? `${this.height}px` : "0px");
    this.edge.setHidden(!this.visibility().edge);
    this.layout.setOpenHeight(this.open ? this.height : 0);
  }
}
