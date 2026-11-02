/**
 * Workbench settings the plugin writes for the served workbench (never into any
 * VS Code instance's folders, F3).
 *
 * Two places, because VS Code reads them from two places:
 *  - the server's Machine settings file (`writeMachineSettings`): theme, layout and
 *    start-up behaviour, which are machine/window-scoped and do take effect, plus the
 *    workspace excludes (`files.watcherExclude`, `search.exclude`; measured: a search
 *    skips the excluded folders when they are here);
 *  - the browser profile's user settings and keybindings (`buildBrowserSeedScript`): the
 *    application-scoped switches (telemetry, updates, experiments) and the copy of the
 *    chosen instance's own settings.json and keybindings.json. The remote
 *    server's settings files are not read for those. Measured in PR-1 round 2:
 *    with them only in the Machine file (and also in data/User/settings.json) the
 *    workbench still asked the marketplace about every installed extension and
 *    default.exp-tas.com for experiments; seeding the browser profile removed the
 *    experiments request. See docs/spike-decision.md.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { chromeSettings, legacyChromeSettings, type KeybindingEntry } from "./chrome-settings";
import { excludeGlobs, EXCLUDE_SETTING_KEYS, writeAtomic } from "./server/user-data-seed";
import { themeSettings } from "./theme-map";
import { WORKBENCH_DB_NAME, WORKBENCH_DB_VERSION, WORKBENCH_SETTINGS_KEY, WORKBENCH_USERDATA_STORE } from "./workbench-db";

// The theme ids (Dark Modern / Light Modern) live in ./theme-map.
export { DARK_THEME, LIGHT_THEME } from "./theme-map";

/**
 * Application-scoped switches that turn off extension auto-update, update checks,
 * experiments and telemetry. They are applied through the browser profile
 * (`buildBrowserSeedScript`); the Machine file also carries them, which is harmless.
 */
export const BROWSER_APP_SETTINGS: Readonly<Record<string, unknown>> = {
  "extensions.autoUpdate": false,
  "extensions.autoCheckUpdates": false,
  "extensions.ignoreRecommendations": true,
  "workbench.enableExperiments": false,
  "telemetry.telemetryLevel": "off",
  "update.mode": "none",
  "update.showReleaseNotes": false,
};

/**
 * The plugin's own theme and chrome settings (G5, G6): the settings that hide every part but the editor, and the Zen Mode
 * overrides (src/chrome-settings.ts). They are written to the Machine file at every server start and also laid over the browser
 * profile's user settings on every load (`buildBrowserSeedScript`), so a `workbench.colorTheme`, tab or layout setting copied from the
 * chosen instance cannot override them. Same bytes for the same `dark`, on every call.
 */
export function workbenchOverlay(opts: { dark: boolean }): Record<string, unknown> {
  return { ...themeSettings(opts.dark), ...chromeSettings() };
}

/**
 * The overlay of the terminal drawer's host page: its theme and the parts the Code tab hid before the editor-only tab. It does
 * not carry the Code tab's hiding settings (tab strip, breadcrumbs, Zen overrides: F2), so the drawer is exactly what it was.
 */
export function terminalOverlay(opts: { dark: boolean }): Record<string, unknown> {
  return { ...themeSettings(opts.dark), ...legacyChromeSettings() };
}

export function buildMachineSettings(opts: { dark: boolean }): Record<string, unknown> {
  return {
    // Theme follows Obsidian light/dark (applied at server start; a running tab is switched live), and the
    // chrome-hiding settings (src/chrome-settings.ts: the settings of every route, and the Zen Mode overrides).
    ...workbenchOverlay(opts),
    // Quiet start: no welcome page. Workspace Trust is left on: the one-time "Trust" click
    // is stored in the Code tab's browser profile (see docs/spike-decision.md).
    // `security.workspace.trust.enabled` was removed here: it has no effect from the
    // Machine file, and a silent trust-off would trust whatever sits in the vault.
    "workbench.startupEditor": "none",
    ...BROWSER_APP_SETTINGS,
    // Workspace excludes (G16). They live here, not only in the copied User settings, because this
    // file is the one the server reads; every rewrite (a theme change included) carries them.
    ...Object.fromEntries(EXCLUDE_SETTING_KEYS.map((key) => [key, excludeGlobs()])),
  };
}

/**
 * Write the Machine settings file, regenerating it whole every time: whatever was there before (missing,
 * corrupt, a folder where the file belongs) is replaced, so the output is the same bytes on every call. A
 * write that cannot be done is logged and skipped, never thrown: the tab still opens, with the workbench's
 * own defaults (F3). Only ever writes inside the plugin's own server data dir (F3).
 */
export function writeMachineSettings(serverDataDir: string, opts: { dark: boolean }): string {
  const file = path.join(serverDataDir, "data", "Machine", "settings.json");
  const text = JSON.stringify(buildMachineSettings(opts), null, 2);
  const attempt = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeAtomic(file, text);
  };
  try {
    attempt();
  } catch {
    try {
      fs.rmSync(file, { recursive: true, force: true }); // a corrupt or misplaced entry in the plugin's own folder
      attempt();
    } catch (e) {
      console.warn("VS Code Workbench: could not write the workbench settings; the editor opens with its defaults:", e instanceof Error ? e.message : e);
    }
  }
  return file;
}

/** IndexedDB names the web workbench uses for its browser-side user data (VS Code 1.14x). */
export const WORKBENCH_DB = { name: WORKBENCH_DB_NAME, version: WORKBENCH_DB_VERSION, store: WORKBENCH_USERDATA_STORE, settingsKey: WORKBENCH_SETTINGS_KEY };

/** The copy of the chosen instance's own settings and keybindings, for the browser profile. */
export interface UserDataCopy {
  /** Changes at every server start; the copy is applied once per id (a tab reload must not undo edits made in the tab). */
  id: string;
  /** The merged settings (copied keys, excludes on top). */
  settings: Readonly<Record<string, unknown>>;
  /** The instance's keybindings.json, base64; null when it has none. */
  keybindingsBase64: string | null;
}

/** localStorage key (on the server's origin) remembering which copy was applied. */
export const USER_DATA_MARKER_KEY = "obsidian-vscode-workbench.user-data";

/**
 * What the seed script answers (see `buildBrowserSeedScript`); the Code tab logs it, so a seed that stops
 * working shows up in the console instead of as marketplace and telemetry traffic coming back.
 *  - seeded:           the settings (and, with a copy, the keybindings) were written.
 *  - kept:             the profile's settings.json is not plain JSON (hand-edited with comments, say) and no new copy
 *                      was due, so it was left alone; the off switches are not re-applied until the next start.
 *  - version-mismatch: the workbench's database is at another version than this plugin knows (VS Code changed it).
 *  - no-store:         the database has no user-data store (VS Code renamed it).
 *  - error:<name>:     anything else the page refused.
 */
export type SeedOutcome = "seeded" | "kept" | "version-mismatch" | "no-store" | `error:${string}`;

/**
 * Page-side helper of the seed script: `withChords(text, fresh)` puts the plugin's `chords` at the END of a keybindings.json
 * text (JSON with comments and trailing commas allowed, like VS Code reads it), after removing any earlier copy of the same
 * chord and command, so the result is the same bytes however often it is applied and the plugin's rule is the last one for its
 * chord. It answers the new text, or null when `text` is not a keybindings array and `fresh` is false (the stored file is the
 * user's to fix, so it is left alone); with `fresh` (a new copy replaces the file whole anyway) a file that does not parse
 * is replaced by the plugin's chords alone. Written as a raw string: it runs in the page.
 */
const KEYBINDINGS_MERGE_JS = String.raw`const stripJsonc = (t) => {
    let out = "", i = 0, inString = false;
    while (i < t.length) {
      const c = t[i], n = t[i + 1];
      if (inString) {
        out += c;
        if (c === "\\") { out += n === undefined ? "" : n; i += 2; continue; }
        if (c === '"') inString = false;
        i++;
      } else if (c === '"') { inString = true; out += c; i++; }
      else if (c === "/" && n === "/") { while (i < t.length && t[i] !== "\n") i++; }
      else if (c === "/" && n === "*") { i += 2; while (i < t.length && !(t[i] === "*" && t[i + 1] === "/")) i++; i += 2; }
      else { out += c; i++; }
    }
    return out.replace(/,(\s*[\]}])/g, "$1");
  };
  const withChords = (text, fresh) => {
    let list = [];
    if (text !== null && text.trim() !== "") {
      let parsed;
      try { parsed = JSON.parse(stripJsonc(text)); } catch (e) { parsed = undefined; }
      if (Array.isArray(parsed)) list = parsed;
      else if (!fresh) return null;
    }
    const ours = (e) => e !== null && typeof e === "object" && chords.some((c) => c.key === e.key && c.command === e.command);
    return JSON.stringify(list.filter((e) => !ours(e)).concat(chords), null, 2);
  };`;

/**
 * A script for the workbench's origin (run through `webview.executeJavaScript`
 * before the workbench itself loads) that merges `settings` into the browser
 * profile's user settings.json. Resolves to a `SeedOutcome`.
 *
 * Without `copy` (or on a tab reload within one server start), keys already in the profile are kept except
 * the ones given, and a file that is not a plain JSON object is left alone ("kept").
 *
 * With `copy`, the instance's settings and keybindings are put there once per `copy.id` (recorded in
 * localStorage), and that replaces the profile's settings.json whole: whatever was in it, a key removed from the
 * instance's settings, a key set inside the tab, a file that no longer parses, is gone, as the README says.
 * `settings` (the off switches) win over the copy, and keybindings.json is replaced by the copy or removed
 * when the instance has none.
 *
 * With `keybindings` (the chords the chrome page script presses, src/chrome-settings.ts `chromeKeybindings()`), they are put at
 * the end of keybindings.json at EVERY load, with or without a copy: after the copy's rules on a new copy, after the stored
 * rules otherwise, so a copied rule for the same chord cannot win and a reload (same copy id) keeps them. A stored file that is
 * not a keybindings array is left alone (the chords then do not apply and the chrome shows, F3); a copy that is not one is
 * replaced by the chords alone. Without `keybindings`, keybindings.json is handled as described above.
 */
export function buildBrowserSeedScript(
  settings: Readonly<Record<string, unknown>> = BROWSER_APP_SETTINGS,
  copy?: UserDataCopy | null,
  keybindings?: readonly KeybindingEntry[],
): string {
  const db = WORKBENCH_DB;
  const keybindingsKey = "/User/keybindings.json";
  return `(async () => {
  const ours = ${JSON.stringify(settings)};
  const copy = ${JSON.stringify(copy ?? null)};
  const chords = ${JSON.stringify(keybindings ?? [])};
  const markerKey = ${JSON.stringify(USER_DATA_MARKER_KEY)};
  const stores = ["vscode-userdata-store", "vscode-logs-store", "vscode-filehandles-store"];
  ${KEYBINDINGS_MERGE_JS}
  let db;
  try {
    db = await new Promise((resolve, reject) => {
      const r = indexedDB.open(${JSON.stringify(db.name)}, ${db.version});
      r.onupgradeneeded = () => { for (const s of stores) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s); };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  } catch (e) {
    return e && e.name === "VersionError" ? "version-mismatch" : "error:" + ((e && e.name) || "open");
  }
  try {
    if (!db.objectStoreNames.contains(${JSON.stringify(db.store)})) return "no-store";
    const read = (key) => new Promise((resolve, reject) => {
      const q = db.transaction(${JSON.stringify(db.store)}).objectStore(${JSON.stringify(db.store)}).get(key);
      q.onsuccess = () => resolve(q.result);
      q.onerror = () => reject(q.error);
    });
    const existing = await read(${JSON.stringify(db.settingsKey)});
    const applyCopy = copy !== null && (typeof localStorage === "undefined" || localStorage.getItem(markerKey) !== copy.id);
    let merged = Object.assign({}, applyCopy ? copy.settings : {}, ours);
    if (existing !== undefined && !applyCopy) {
      const text = typeof existing === "string" ? existing : new TextDecoder().decode(existing);
      if (text.trim() !== "") {
        let current;
        try { current = JSON.parse(text); } catch (e) { return "kept"; }
        if (current === null || typeof current !== "object" || Array.isArray(current)) return "kept";
        merged = Object.assign({}, current, ours);
      }
    }
    // The plugin's own chords go at the end of keybindings.json at every load (they are read by the page script, which presses
    // them). null: nothing of ours to add, or the stored file is not a keybindings array and is left alone.
    let chordText = null;
    if (chords.length > 0) {
      let text = null;
      if (applyCopy) {
        if (copy.keybindingsBase64 !== null) text = new TextDecoder().decode(Uint8Array.from(atob(copy.keybindingsBase64), (c) => c.charCodeAt(0)));
      } else {
        const stored = await read(${JSON.stringify(keybindingsKey)});
        if (stored !== undefined) text = typeof stored === "string" ? stored : new TextDecoder().decode(stored);
      }
      chordText = withChords(text, applyCopy);
    }
    await new Promise((resolve, reject) => {
      const tx = db.transaction(${JSON.stringify(db.store)}, "readwrite");
      const store = tx.objectStore(${JSON.stringify(db.store)});
      store.put(new TextEncoder().encode(JSON.stringify(merged, null, 2)), ${JSON.stringify(db.settingsKey)});
      if (chordText !== null) store.put(new TextEncoder().encode(chordText), ${JSON.stringify(keybindingsKey)});
      else if (applyCopy) {
        if (copy.keybindingsBase64 !== null) store.put(Uint8Array.from(atob(copy.keybindingsBase64), (c) => c.charCodeAt(0)), ${JSON.stringify(keybindingsKey)});
        else store.delete(${JSON.stringify(keybindingsKey)});
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    if (applyCopy && typeof localStorage !== "undefined") localStorage.setItem(markerKey, copy.id);
    return "seeded";
  } catch (e) {
    return "error:" + ((e && e.name) || "seed");
  } finally {
    db.close();
  }
})()`;
}
