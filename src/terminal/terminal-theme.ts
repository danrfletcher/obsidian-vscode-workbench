/**
 * Terminal colours that follow Obsidian's light or dark mode. The background, text and
 * selection colours come from Obsidian's own CSS variables, so a custom theme carries
 * over; the sixteen ANSI colours are fixed palettes picked for contrast on that
 * background (the default white of a dark palette would vanish on a light one).
 */

export interface TerminalColours {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

type Ansi = Omit<TerminalColours, "background" | "foreground" | "cursor" | "cursorAccent" | "selectionBackground">;

const DARK_ANSI: Ansi = {
  black: "#000000",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#3b8eea",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#8a8a8a",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#6aa9f4",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#ffffff",
};

const LIGHT_ANSI: Ansi = {
  black: "#000000",
  red: "#cd3131",
  green: "#007a00",
  yellow: "#7a6e00",
  blue: "#0451a5",
  magenta: "#a0049f",
  cyan: "#0a6f8a",
  white: "#555555",
  brightBlack: "#5a5a5a",
  brightRed: "#c01f1f",
  brightGreen: "#0a7a0a",
  brightYellow: "#7a6e00",
  brightBlue: "#0451a5",
  brightMagenta: "#a0049f",
  brightCyan: "#0a6f8a",
  brightWhite: "#3c3c3c",
};

export const DARK_FALLBACK = { background: "#1e1e1e", foreground: "#d4d4d4" };
export const LIGHT_FALLBACK = { background: "#ffffff", foreground: "#1f1f1f" };

/** The theme for `dark`; `read` returns a CSS variable's value, or "" when it has none. */
export function terminalColours(dark: boolean, read: (variable: string) => string): TerminalColours {
  const fallback = dark ? DARK_FALLBACK : LIGHT_FALLBACK;
  const pick = (variable: string, otherwise: string) => read(variable).trim() || otherwise;
  const foreground = pick("--text-normal", fallback.foreground);
  return {
    background: pick("--background-primary", fallback.background),
    foreground,
    cursor: foreground,
    cursorAccent: pick("--background-primary", fallback.background),
    selectionBackground: pick("--text-selection", dark ? "#264f78" : "#add6ff"),
    ...(dark ? DARK_ANSI : LIGHT_ANSI),
  };
}
