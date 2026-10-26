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
import { chromeSettings } from "./chrome-settings";
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
 * The plugin's own theme and chrome settings (G5, G6). They are written to the Machine file at every server
 * start and also laid over the browser profile's user settings on every load (`buildBrowserSeedScript`), so
 * a `workbench.colorTheme` or layout setting copied from the chosen instance cannot override them.
 */
export function workbenchOverlay(opts: { dark: boolean }): Record<string, unknown> {
  return { ...themeSettings(opts.dark), ...chromeSettings() };
}

export function buildMachineSettings(opts: { dark: boolean }): Record<string, unknown> {
  return {
    // Theme follows Obsidian light/dark (applied at server start; a running tab is switched live), and the
    // chrome-hiding settings (src/chrome-settings.ts: only the parts that have a settings switch).
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
 * own defaults (F11). Only ever writes inside the plugin's own server data dir (F3).
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
 * A script for the workbench's origin (run through `webview.executeJavaScript`
 * before the workbench itself loads) that merges `settings` into the browser
 * profile's user settings.json. Keys already there are kept except the ones
 * given; a file that is not a plain JSON object (hand-edited with comments, say)
 * is left alone. Resolves to "seeded" or "kept".
 *
 * With `copy`, the instance's settings and keybindings are also put there, once per
 * `copy.id` (recorded in localStorage): the copied keys replace what is in the profile,
 * `settings` (the off switches) win over the copy, and keybindings.json is replaced by
 * the copy or removed when the instance has none.
 */
export function buildBrowserSeedScript(settings: Readonly<Record<string, unknown>> = BROWSER_APP_SETTINGS, copy?: UserDataCopy | null): string {
  const db = WORKBENCH_DB;
  const keybindingsKey = "/User/keybindings.json";
  return `(async () => {
  const ours = ${JSON.stringify(settings)};
  const copy = ${JSON.stringify(copy ?? null)};
  const markerKey = ${JSON.stringify(USER_DATA_MARKER_KEY)};
  const stores = ["vscode-userdata-store", "vscode-logs-store", "vscode-filehandles-store"];
  const db = await new Promise((resolve, reject) => {
    const r = indexedDB.open(${JSON.stringify(db.name)}, ${db.version});
    r.onupgradeneeded = () => { for (const s of stores) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  try {
    const existing = await new Promise((resolve, reject) => {
      const q = db.transaction(${JSON.stringify(db.store)}).objectStore(${JSON.stringify(db.store)}).get(${JSON.stringify(db.settingsKey)});
      q.onsuccess = () => resolve(q.result);
      q.onerror = () => reject(q.error);
    });
    const applyCopy = copy !== null && (typeof localStorage === "undefined" || localStorage.getItem(markerKey) !== copy.id);
    let merged = Object.assign({}, applyCopy ? copy.settings : {}, ours);
    if (existing !== undefined) {
      const text = typeof existing === "string" ? existing : new TextDecoder().decode(existing);
      if (text.trim() !== "") {
        let current;
        try { current = JSON.parse(text); } catch (e) { return "kept"; }
        if (current === null || typeof current !== "object" || Array.isArray(current)) return "kept";
        merged = Object.assign({}, current, applyCopy ? copy.settings : {}, ours);
      }
    }
    await new Promise((resolve, reject) => {
      const tx = db.transaction(${JSON.stringify(db.store)}, "readwrite");
      const store = tx.objectStore(${JSON.stringify(db.store)});
      store.put(new TextEncoder().encode(JSON.stringify(merged, null, 2)), ${JSON.stringify(db.settingsKey)});
      if (applyCopy) {
        if (copy.keybindingsBase64 !== null) store.put(Uint8Array.from(atob(copy.keybindingsBase64), (c) => c.charCodeAt(0)), ${JSON.stringify(keybindingsKey)});
        else store.delete(${JSON.stringify(keybindingsKey)});
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    if (applyCopy && typeof localStorage !== "undefined") localStorage.setItem(markerKey, copy.id);
    return "seeded";
  } finally {
    db.close();
  }
})()`;
}
