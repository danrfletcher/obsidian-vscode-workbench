/**
 * The drawer's height rule (G9, E14), in one place so the drag, the restore from
 * `data.json` and the window-resize handler all clamp the same way.
 */

/** The least height the drawer can have, in px. */
export const MIN_HEIGHT = 120;
/** Window height kept free for the strip and the note area above the drawer, in px. */
export const HEADROOM = 160;
/** The height of a drawer that has never been resized, in px. */
export const DEFAULT_HEIGHT = 300;

/** The tallest the drawer may be in a window `windowHeight` px high. Never negative. */
export function maxHeight(windowHeight: number): number {
  if (typeof windowHeight !== "number" || !Number.isFinite(windowHeight)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor(windowHeight - HEADROOM));
}

/**
 * `height` held between MIN_HEIGHT and maxHeight(windowHeight), as a whole number of px.
 * Zero, negative and too-small input gives the minimum; too-large input the maximum; NaN
 * (or anything that is not a number) gives the default height, itself clamped. In a window
 * so small that the maximum is under the minimum, the maximum wins: the strip and the note
 * area must stay reachable.
 */
export function clampHeight(height: unknown, windowHeight: number): number {
  const max = maxHeight(windowHeight);
  const h = typeof height === "number" && !Number.isNaN(height) ? height : DEFAULT_HEIGHT;
  const rounded = Number.isFinite(h) ? Math.round(h) : h > 0 ? Number.POSITIVE_INFINITY : 0;
  const clamped = Math.min(Math.max(rounded, MIN_HEIGHT), max);
  return Number.isFinite(clamped) ? clamped : DEFAULT_HEIGHT; // an unbounded height in a window of unknown size
}
