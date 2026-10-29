import { describe, expect, it } from "vitest";
import { DEFAULT_HEIGHT, HEADROOM, MIN_HEIGHT, clampHeight, maxHeight } from "../../src/terminal/drawer-geometry";

const WINDOW = 900;
const MAX = WINDOW - HEADROOM; // 740

describe("drawer height clamp (G9, E14)", () => {
  it("keeps the numbers the spec names: a minimum of about 120 px and a fixed headroom", () => {
    expect(MIN_HEIGHT).toBe(120);
    expect(HEADROOM).toBeGreaterThan(0);
    expect(maxHeight(WINDOW)).toBe(MAX);
  });

  const table: Array<[string, unknown, number, number]> = [
    ["inside the range is kept", 300, WINDOW, 300],
    ["exactly the minimum", 120, WINDOW, 120],
    ["exactly the maximum", MAX, WINDOW, MAX],
    ["below the minimum goes up to it", 50, WINDOW, 120],
    ["one under the minimum", 119, WINDOW, 120],
    ["above the maximum comes down to it", 5000, WINDOW, MAX],
    ["one over the maximum", MAX + 1, WINDOW, MAX],
    ["a saved height taller than the window (E14)", 2000, 600, 600 - HEADROOM],
    ["the window shrinks under an open drawer (E14)", 740, 500, 500 - HEADROOM],
    ["zero gives the minimum", 0, WINDOW, 120],
    ["negative gives the minimum", -40, WINDOW, 120],
    ["negative infinity gives the minimum", Number.NEGATIVE_INFINITY, WINDOW, 120],
    ["positive infinity gives the maximum", Number.POSITIVE_INFINITY, WINDOW, MAX],
    ["a fraction rounds down", 300.4, WINDOW, 300],
    ["a fraction rounds up", 300.6, WINDOW, 301],
    ["a fraction under the minimum", 119.6, WINDOW, 120],
    ["NaN gives the default height", Number.NaN, WINDOW, DEFAULT_HEIGHT],
    ["a string gives the default height", "tall", WINDOW, DEFAULT_HEIGHT],
    ["undefined gives the default height", undefined, WINDOW, DEFAULT_HEIGHT],
    ["null gives the default height", null, WINDOW, DEFAULT_HEIGHT],
    ["the default height is itself clamped in a small window", Number.NaN, 400, 400 - HEADROOM],
    ["a window too small for the minimum: the maximum wins, so the strip and notes stay reachable", 300, 200, 40],
    ["a window smaller than the headroom leaves no drawer", 300, 100, 0],
    ["a window of unknown height: only the minimum applies", 50, Number.NaN, 120],
    ["a window of unknown height keeps a large height", 5000, Number.NaN, 5000],
    ["a window of unknown height and an unbounded height gives the default", Number.POSITIVE_INFINITY, Number.NaN, DEFAULT_HEIGHT],
  ];

  it.each(table)("%s", (_name, height, windowHeight, expected) => {
    expect(clampHeight(height, windowHeight)).toBe(expected);
  });

  it("always returns a whole number", () => {
    for (const h of [0.1, 123.456, 299.5, 740.49]) expect(Number.isInteger(clampHeight(h, WINDOW))).toBe(true);
  });

  it("maxHeight is never negative", () => {
    expect(maxHeight(0)).toBe(0);
    expect(maxHeight(-10)).toBe(0);
  });
});
