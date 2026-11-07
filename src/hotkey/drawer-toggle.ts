/**
 * Ctrl+` carried in from the embed (G8, GP5): one press flips the drawer once, and keyboard focus follows.
 *
 * States: `hidden` (drawer closed), `revealing` (open, the terminal page not up yet: it is starting or waiting for
 * the licence) and `shown` (open with the terminal page running, or showing its lost or error message). A press
 * never makes a second host page: ten presses in a second leave an open drawer after an odd count, a closed one
 * after an even count.
 *
 * Focus (G1): opening moves focus out of the embed so the next keystrokes reach the terminal; closing from
 * the embed hands focus back to it. Closing from the terminal host page (its bridged key, G16) passes no handle:
 * the drawer returns focus to the view that had it when it opened (focus-return.ts), not through here.
 */

export type ToggleState = "hidden" | "revealing" | "shown";

/** How far the terminal page is (not started, starting, up, or ended with an error), as far as the toggle cares. */
export type PageProgress = "none" | "starting" | "running" | "ended";

/** The drawer, as the toggle drives it (the terminal drawer in the plugin; a fake in the tests). */
export interface ToggleTarget {
  /** The reveal command and its hotkey work over the current view. True over every view (G6): only the edge follows the non-code setting. */
  hotkeyEnabled(): boolean;
  readonly isOpen: boolean;
  toggle(): void;
  pageProgress(): PageProgress;
}

/** What has focus when the key arrives: the embed, which can give focus up and take it back. */
export interface FocusHandle {
  blur?(): void;
  focus?(): void;
}

export function toggleState(target: ToggleTarget): ToggleState {
  if (!target.isOpen) return "hidden";
  const page = target.pageProgress();
  return page === "none" || page === "starting" ? "revealing" : "shown";
}

export class DrawerToggle {
  constructor(private readonly target: ToggleTarget) {}

  get state(): ToggleState {
    return toggleState(this.target);
  }

  /**
   * One press. Returns the state afterwards, or null when the drawer is not available over this view (the
   * press did nothing).
   */
  press(from: FocusHandle | null = null): ToggleState | null {
    if (!this.target.hotkeyEnabled()) return null;
    const opening = !this.target.isOpen;
    if (opening) from?.blur?.(); // before the toggle: the drawer focuses its terminal, and a late blur would take that away
    this.target.toggle();
    if (!opening) from?.focus?.();
    return this.state;
  }
}
