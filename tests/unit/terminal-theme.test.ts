import { describe, expect, it } from "vitest";
import { DARK_FALLBACK, LIGHT_FALLBACK, terminalColours } from "../../src/terminal/terminal-theme";

const vars = (m: Record<string, string>) => (name: string) => m[name] ?? "";

describe("terminal colours follow Obsidian's mode (G8)", () => {
  it("takes background, text and selection from Obsidian's variables, so a custom theme carries over", () => {
    const c = terminalColours(true, vars({ "--background-primary": "#112233", "--text-normal": " #eeddcc ", "--text-selection": "rgba(1,2,3,0.4)" }));
    expect(c.background).toBe("#112233");
    expect(c.foreground).toBe("#eeddcc");
    expect(c.cursor).toBe("#eeddcc");
    expect(c.cursorAccent).toBe("#112233");
    expect(c.selectionBackground).toBe("rgba(1,2,3,0.4)");
  });

  it("falls back to a dark or light pair when Obsidian gives nothing", () => {
    const dark = terminalColours(true, vars({}));
    const light = terminalColours(false, vars({}));
    expect(dark.background).toBe(DARK_FALLBACK.background);
    expect(light.background).toBe(LIGHT_FALLBACK.background);
    expect(dark.background).not.toBe(light.background);
    expect(dark.foreground).not.toBe(light.foreground);
  });

  it("uses a light-mode palette whose text colours are dark enough to read on white, and a dark-mode one that is bright", () => {
    const luminance = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const light = terminalColours(false, vars({}));
    const dark = terminalColours(true, vars({}));
    for (const k of ["white", "yellow", "brightWhite", "brightYellow", "brightCyan", "green"] as const) expect(luminance(light[k]), `light ${k}`).toBeLessThan(0.45);
    expect(luminance(dark.brightWhite)).toBeGreaterThan(0.9);
    expect(luminance(dark.white)).toBeGreaterThan(0.7);
  });

  it("gives every ANSI colour as a hex value in both modes", () => {
    for (const mode of [true, false]) {
      const c = terminalColours(mode, vars({}));
      for (const k of ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"] as const) {
        expect(c[k]).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });
});
