/**
 * The drawer's height rule (G3, E9), in one place so the drag, the restore from
 * `data.json` and the window-resize handler all clamp the same way.
 */

/** The least height the drawer can have, in px. */
export const MIN_HEIGHT = 120;
/** Window height kept free for the note area above the drawer, in px. */
export const HEADROOM = 160;
/** The height of a drawer that has never been resized, in px. */
export const DEFAULT_HEIGHT = 300;
/**
 * A drag that ends with the drawer shorter than this closes it, in px. The drawer follows the pointer all the way down to 0
 * while it is dragged (so there is no minimum height to get stuck on); letting go that low means "close", because the pointer
 * rarely stops on exactly 0.
 */
export const COLLAPSE_HEIGHT = 40;

/** The tallest the drawer may be in a window `windowHeight` px high. Never negative. */
export function maxHeight(windowHeight: number): number {
  if (typeof windowHeight !== "number" || !Number.isFinite(windowHeight)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor(windowHeight - HEADROOM));
}

/**
 * `height` held between MIN_HEIGHT and maxHeight(windowHeight), as a whole number of px.
 * Zero, negative and too-small input gives the minimum; too-large input the maximum; NaN
 * (or anything that is not a number) gives the default height, itself clamped. In a window
 * so small that the maximum is under the minimum, the maximum wins: the edge and the note
 * area must stay reachable.
 */
export function clampHeight(height: unknown, windowHeight: number): number {
  const max = maxHeight(windowHeight);
  const h = typeof height === "number" && !Number.isNaN(height) ? height : DEFAULT_HEIGHT;
  const rounded = Number.isFinite(h) ? Math.round(h) : h > 0 ? Number.POSITIVE_INFINITY : 0;
  const clamped = Math.min(Math.max(rounded, MIN_HEIGHT), max);
  return Number.isFinite(clamped) ? clamped : DEFAULT_HEIGHT; // an unbounded height in a window of unknown size
}

/**
 * The height a drag asks for, as the drawer shows it while the pointer is down: whole px between 0 and maxHeight(windowHeight).
 * Unlike clampHeight there is no minimum, so the drawer follows the pointer down to nothing. Anything that is not a number is 0.
 */
export function dragHeight(wanted: unknown, windowHeight: number): number {
  if (typeof wanted !== "number" || Number.isNaN(wanted)) return 0;
  const max = maxHeight(windowHeight);
  const rounded = Number.isFinite(wanted) ? Math.round(wanted) : wanted > 0 ? Number.POSITIVE_INFINITY : 0;
  const h = Math.min(Math.max(rounded, 0), max);
  return Number.isFinite(h) ? h : 0; // an unbounded height in a window of unknown size
}

/**
 * What a drag that ends at `height` leaves: null when the drawer is to close (shorter than COLLAPSE_HEIGHT), else the height to
 * keep, which is never under MIN_HEIGHT.
 */
export function settleHeight(height: number, windowHeight: number): number | null {
  if (!(height >= COLLAPSE_HEIGHT)) return null;
  return clampHeight(height, windowHeight);
}
