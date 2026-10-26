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

function isToggleKey(ev: KeyboardEvent): boolean {
  return ev.ctrlKey && !ev.metaKey && !ev.altKey && !ev.shiftKey && (ev.key === "`" || ev.code === "Backquote");
}

export function createXtermView(host: HTMLElement): TerminalView {
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
  // Ctrl+` inside the terminal closes the drawer and never reaches the shell. It is handled here, and
  // kept from Obsidian's own keymap, so the command's hotkey cannot toggle a second time.
  term.attachCustomKeyEventHandler((ev) => {
    if (isToggleKey(ev)) {
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
