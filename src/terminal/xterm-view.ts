/**
 * The real terminal emulator: xterm.js (plain JavaScript, no native code) fitted to its
 * container. Only main.ts reaches this file, so tests that stand in for the terminal
 * never load xterm.
 */
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { TerminalView } from "./drawer-ui";
import { terminalColours } from "./terminal-theme";

const FONT_FALLBACK = 'Menlo, Monaco, "Courier New", monospace';

/** A key chord that closes the drawer from inside the terminal. `key` is lower-case `event.key`. */
export interface ToggleChord {
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
  /** The US-layout `event.code` of the key, used when Alt is held or the layout reports a dead key (as in the page script). */
  code?: string;
}

/** The command's default hotkey, used when the plugin gives the view no live list. */
export const DEFAULT_TOGGLE_CHORDS: readonly ToggleChord[] = [{ ctrl: true, meta: false, alt: false, shift: false, key: "`" }];

export interface XtermOptions {
  /**
   * The chords Obsidian has for "Toggle terminal drawer" right now (Settings > Hotkeys), read on every key, so a
   * rebinding applies at once and the old chord goes back to the shell (PR-8 R3). An empty list means no key closes
   * the drawer from the terminal. Without it the default Ctrl+` is used.
   */
  toggleChords?: () => readonly ToggleChord[];
}

/** Whether `ev` is one of `chords`: modifiers must match exactly, the key by the character it produces. */
export function isToggleKey(ev: KeyboardEvent, chords: readonly ToggleChord[] = DEFAULT_TOGGLE_CHORDS): boolean {
  const key = typeof ev.key === "string" ? ev.key.toLowerCase() : "";
  return chords.some(
    (c) =>
      !!ev.ctrlKey === c.ctrl &&
      !!ev.metaKey === c.meta &&
      !!ev.altKey === c.alt &&
      !!ev.shiftKey === c.shift &&
      (key === c.key ||
        (c.key === "`" && ev.code === "Backquote") ||
        // Alt/Option changes the character on macOS and a dead key has none: use the key's position (PR-8 R7)
        (!!c.code && ev.code === c.code && (!!ev.altKey || key === "dead" || key === "unidentified" || key === ""))),
  );
}

export function createXtermView(host: HTMLElement, options: XtermOptions = {}): TerminalView {
  const doc = host.ownerDocument;
  const win = doc.defaultView ?? window;
  const style = () => win.getComputedStyle(doc.body);
  const dark = () => doc.body.classList.contains("theme-dark");
  const colours = () => terminalColours(dark(), (v) => style().getPropertyValue(v));
  const font = () => style().getPropertyValue("--font-monospace").trim() || FONT_FALLBACK;

  const term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: font(),
    scrollback: 5000,
    macOptionIsMeta: true,
    allowProposedApi: false,
    theme: colours(),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);

  let toggle: (() => void) | null = null;
  // The command's hotkey (Ctrl+` unless rebound) inside the terminal closes the drawer and never reaches the shell.
  // It is handled here, and kept from Obsidian's own keymap, so the command's hotkey cannot toggle a second time
  //.
  term.attachCustomKeyEventHandler((ev) => {
    if (isToggleKey(ev, options.toggleChords?.() ?? DEFAULT_TOGGLE_CHORDS)) {
      if (ev.type === "keydown") {
        ev.preventDefault();
        ev.stopPropagation();
        toggle?.();
      }
      return false;
    }
    return true;
  });

  const fitNow = () => {
    if (host.clientWidth === 0 || host.clientHeight === 0) return; // hidden or collapsed: nothing to fit to
    try {
      fit.fit();
    } catch {
      /* the renderer is not ready yet; the next resize fits */
    }
  };
  // The terminal follows its container however that changes (drag, window resize, a message appearing).
  let frame = 0;
  const observer = new win.ResizeObserver(() => {
    if (frame) return;
    frame = win.requestAnimationFrame(() => {
      frame = 0;
      fitNow();
    });
  });
  observer.observe(host);

  return {
    write: (data) => term.write(data),
    onInput: (cb) => void term.onData(cb),
    onResize: (cb) => void term.onResize(({ cols, rows }) => cb(cols, rows)),
    onToggleKey: (cb) => {
      toggle = cb;
    },
    fit: fitNow,
    size: () => ({ cols: term.cols, rows: term.rows }),
    focus: () => term.focus(),
    reset: () => term.reset(),
    refreshTheme: () => {
      term.options.theme = colours();
      term.options.fontFamily = font();
    },
    dispose: () => {
      observer.disconnect();
      if (frame) win.cancelAnimationFrame(frame);
      term.dispose();
    },
  };
}
