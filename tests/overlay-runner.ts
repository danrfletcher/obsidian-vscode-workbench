/**
 * Runs the keybinding overlay's page-side source (`KEYBINDING_OVERLAY_JS`, the text `buildBrowserSeedScript` embeds in the seed
 * script) on strings, so a unit test checks what the page does, not a copy of it.
 */
import { overlayKeybindings, unbindCommands, type KeybindingEntry } from "../src/chrome-settings";
import { KEYBINDING_OVERLAY_JS } from "../src/keybinding-overlay";

interface OverlayFunctions {
  removeOverlay(text: string, chords: readonly KeybindingEntry[]): string;
  withOverlay(text: string | null, chords: readonly KeybindingEntry[], unbind: readonly string[]): string;
  stripJsonc(text: string): string;
}

const fns = new Function(`${KEYBINDING_OVERLAY_JS}\nreturn { removeOverlay, withOverlay, stripJsonc };`)() as OverlayFunctions;

/** The keybindings.json text with the overlay laid over it; `text` null: there is no file. */
export function applyOverlay(
  text: string | null,
  entries: readonly KeybindingEntry[] = overlayKeybindings(),
  unbind: readonly string[] = unbindCommands(),
): string {
  return fns.withOverlay(text, entries, unbind);
}

/** The text without the overlay block: the file as the user had it. */
export function removeOverlay(text: string, entries: readonly KeybindingEntry[] = overlayKeybindings()): string {
  return fns.removeOverlay(text, entries);
}

export type Rule = { key: string; command: string; when?: string };

/** The rules a file holds, read the way VS Code reads keybindings.json: comments and trailing commas allowed, a leading byte-order mark ignored. */
export function rulesOf(text: string): Rule[] {
  const parsed = JSON.parse(fns.stripJsonc(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)) as unknown;
  if (!Array.isArray(parsed)) throw new Error("not an array");
  return parsed as Rule[];
}
