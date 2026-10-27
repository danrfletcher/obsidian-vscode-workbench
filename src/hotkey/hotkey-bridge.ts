/**
 * The hotkey bridge: which chords are carried out of a Code tab's embed, and the script that watches for them
 * inside the page.
 *
 * Why it exists: a key pressed while the VS Code page has focus never reaches Obsidian (a `<webview>` is its own
 * page and does not forward keys; the plain `<iframe>` is a cross-origin frame that swallows them), so Obsidian's
 * own hotkeys are dead there. The page script is run inside the workbench page (`executeJavaScript`, the same way
 * the settings seed is) and reports one thing only: the NAME of a bridged action. It never sends the key, the
 * text typed, or anything from the page.
 *
 * Which chords are bridged is read from Obsidian's hotkey manager each time the script is (re)written, so a
 * rebinding in Settings > Hotkeys is followed live and the old chord goes back to VS Code. Only two actions are
 * bridged; every other key is left alone: the script returns without touching the event.
 *
 * Matching rules (the page script is the only implementation, so tests run it with synthetic key events):
 *  - modifiers must match exactly: Cmd+O is not Cmd+Shift+O, and on macOS Ctrl is not Cmd (`Mod` is Cmd on macOS,
 *    Ctrl elsewhere);
 *  - the key is compared by the character it produces (`event.key`, lower-cased), not by position, so a layout
 *    that has the backtick elsewhere still matches the chord Obsidian shows;
 *  - where the produced character cannot be trusted, the physical key is used instead: when Alt/Option is held
 *    (on macOS Alt+O types "ø") or the layout reports a dead key ("Dead", "Unidentified"). The chord's key is then
 *    taken as the US-layout position (`PageChord.code`: KeyO, Digit1, Backquote), so a rebound Alt chord and
 *    Ctrl+` on a dead-backtick layout still match (PR-8 R7);
 *  - a matched chord is consumed (default prevented, propagation stopped) so VS Code does not also act on it
 *    (no backtick typed, no Open File dialog); auto-repeat events are consumed but report nothing, so a held key
 *    acts once per physical press; keys during IME composition are never touched.
 */

export type BridgeAction = "toggle-terminal" | "open-switcher";

/** The bridged actions: what the page reports, and the Obsidian command whose hotkey is followed. */
export const BRIDGED_ACTIONS: ReadonlyArray<{ action: BridgeAction; commandId: string }> = [
  { action: "toggle-terminal", commandId: "obsidian-vscode-workbench:toggle-terminal-drawer" },
  { action: "open-switcher", commandId: "switcher:open" },
];

export const BRIDGE_ACTION_NAMES: readonly BridgeAction[] = BRIDGED_ACTIONS.map((a) => a.action);

/** Obsidian's hotkey shape (`Hotkey` in its API). */
export interface HotkeyLike {
  modifiers: readonly string[];
  key: string;
}

/** One chord the page script watches for. */
export interface PageChord {
  action: BridgeAction;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
  /** Lower-case `event.key`. */
  key: string;
  /** The `event.code` of that key on a US layout (KeyO, Digit1, Backquote), or "" when the key is not a letter, digit or backtick. */
  code?: string;
}

/** The US-layout `event.code` of a chord key: letters, digits and the backtick; "" for anything else. */
export function codeForKey(key: string): string {
  if (/^[a-z]$/.test(key)) return "Key" + key.toUpperCase();
  if (/^[0-9]$/.test(key)) return "Digit" + key;
  if (key === "`") return "Backquote";
  return "";
}

export interface ChordConfig {
  chords: PageChord[];
}

/** The hotkeys of one Obsidian command: the user's own if they set any (even none), else the default. */
export type HotkeyLookup = (commandId: string) => readonly HotkeyLike[];

export function toPageChord(action: BridgeAction, hotkey: HotkeyLike, isMac: boolean): PageChord | null {
  if (!hotkey || typeof hotkey.key !== "string" || hotkey.key === "" || !Array.isArray(hotkey.modifiers)) return null;
  const mods = new Set(hotkey.modifiers);
  const mod = mods.has("Mod");
  return {
    action,
    ctrl: mods.has("Ctrl") || (mod && !isMac),
    meta: mods.has("Meta") || (mod && isMac),
    alt: mods.has("Alt"),
    shift: mods.has("Shift"),
    key: hotkey.key.toLowerCase(),
    code: codeForKey(hotkey.key.toLowerCase()),
  };
}

/** Every chord of every bridged action, as the page script needs them. */
export function resolveChords(lookup: HotkeyLookup, isMac: boolean): ChordConfig {
  const chords: PageChord[] = [];
  for (const { action, commandId } of BRIDGED_ACTIONS) {
    let hotkeys: readonly HotkeyLike[] = [];
    try {
      hotkeys = lookup(commandId) ?? [];
    } catch {
      hotkeys = []; // a hotkey manager that cannot answer bridges nothing rather than guessing
    }
    for (const hk of hotkeys) {
      const chord = toPageChord(action, hk, isMac);
      if (chord) chords.push(chord);
    }
  }
  return { chords };
}

/** Two configs that bridge the same chords. Used to push to a page only when something changed. */
export function configSignature(config: ChordConfig): string {
  return JSON.stringify(config.chords.map((c) => [c.action, c.ctrl, c.meta, c.alt, c.shift, c.key, c.code ?? ""]).sort());
}

/** What the page logs (webview) when it reports an action; the host reads only lines starting with this. */
export const KEY_MESSAGE_PREFIX = "__vscw_key__:";

/** The window global that holds the page's state, so a second script run updates the chords instead of adding a listener. */
export const PAGE_STATE_KEY = "__vscwKeyBridge";

/**
 * The script for the workbench page. Idempotent: the first run adds one capture-phase `keydown` listener on
 * `window`, every run replaces the chord list. It reports through `postMessage` to the parent when the page is
 * framed, and through a prefixed `console.log` line when it is a top-level page (a webview, whose host reads
 * `console-message`). Both carry `{ v: 1, action }` and nothing else, except that the console line also carries
 * the per-load `nonce` (`n`) the host handed in, so the host can tell this script's line from any other line
 * that starts with the same prefix.
 */
export function buildRelayScript(config: ChordConfig, nonce?: string): string {
  // The nonce lives in this closure, not on `window`, and the first run keeps its own `log` and nonce for the
  // life of the page. A page's other content (an extension webview, a nested frame) cannot read either, so it
  // cannot write a console line the host would take for ours (R6).
  return `(function () {
  var w = window;
  var state = w[${JSON.stringify(PAGE_STATE_KEY)}];
  if (!state) {
    state = w[${JSON.stringify(PAGE_STATE_KEY)}] = { chords: [] };
    var nonce = ${JSON.stringify(typeof nonce === "string" && nonce !== "" ? nonce : null)};
    var log = console.log.bind(console);
    var send = function (action) {
      try {
        var payload = { v: 1, action: action };
        if (nonce !== null) payload.n = nonce;
        if (w.parent && w.parent !== w) w.parent.postMessage({ vscw: 1, v: payload.v, action: payload.action }, "*");
        else log(${JSON.stringify(KEY_MESSAGE_PREFIX)} + JSON.stringify(payload));
      } catch (e) {}
    };
    w.addEventListener("keydown", function (ev) {
      if (ev.isComposing) return;
      var chords = state.chords;
      var key = typeof ev.key === "string" ? ev.key.toLowerCase() : "";
      for (var i = 0; i < chords.length; i++) {
        var c = chords[i];
        // The produced character, unless Alt is held or the key is dead: then the physical key (PR-8 R7).
        if (c.key !== key && !(!!c.code && ev.code === c.code && (ev.altKey || key === "dead" || key === "unidentified" || key === ""))) continue;
        if (!!ev.ctrlKey !== c.ctrl || !!ev.metaKey !== c.meta || !!ev.altKey !== c.alt || !!ev.shiftKey !== c.shift) continue;
        ev.preventDefault();
        ev.stopImmediatePropagation();
        if (!ev.repeat) send(c.action);
        return;
      }
    }, true);
  }
  state.chords = ${JSON.stringify(config.chords)};
})();`;
}
