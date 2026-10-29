/**
 * Ctrl+` carried in from the embed (G8, GP5): one press flips the drawer once, and keyboard focus follows.
 *
 * States: `hidden` (drawer closed), `revealing` (open, its shell not running yet: the first reveal is
 * creating it, or the shell is starting) and `shown` (open with a running shell, or showing an ended or failed
 * shell's message). A press never makes a second shell: the first reveal creates one in the session manager
 * synchronously, so ten presses in a second leave an open drawer after an odd count, a closed one after an even
 * count, and one shell either way.
 *
 * Focus (GP5e): opening moves focus out of the embed so the next keystrokes reach the terminal; closing from
 * the embed hands focus back to it. Closing from the terminal (its own key) returns focus to the editor through
 * the drawer's close hook (feature.ts), not through here.
 */

export type ToggleState = "hidden" | "revealing" | "shown";

/** The active shell, as far as the toggle cares. */
export type ShellProgress = "none" | "starting" | "running" | "ended";

/** The drawer, as the toggle drives it (the terminal feature in the plugin; a fake in the tests). */
export interface ToggleTarget {
  /** The reveal command works over the current view (the non-code setting, G11). */
  hotkeyEnabled(): boolean;
  readonly isOpen: boolean;
  toggle(): void;
  shellProgress(): ShellProgress;
}

/** What has focus when the key arrives: the embed, which can give focus up and take it back. */
export interface FocusHandle {
  blur?(): void;
  focus?(): void;
}

export function toggleState(target: ToggleTarget): ToggleState {
  if (!target.isOpen) return "hidden";
  const shell = target.shellProgress();
  return shell === "none" || shell === "starting" ? "revealing" : "shown";
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
