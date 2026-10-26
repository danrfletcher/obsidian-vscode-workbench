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
import { excludeGlobs, EXCLUDE_SETTING_KEYS } from "./server/user-data-seed";

// VS Code 1.143 names its built-in themes "Dark Modern" / "Light Modern". The older
// "Default Dark Modern" / "Default Light Modern" ids are not recognised for light: the
// workbench rewrites the Machine file back to "Dark Modern" when it loads (seen in the
// Obsidian container run, PR-1 round 3).
export const DARK_THEME = "Dark Modern";
export const LIGHT_THEME = "Light Modern";

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

export function buildMachineSettings(opts: { dark: boolean }): Record<string, unknown> {
  return {
    // Theme follows Obsidian light/dark (applied at server start and on reload).
    "workbench.colorTheme": opts.dark ? DARK_THEME : LIGHT_THEME,
    // Chrome hiding: only the parts that have a settings switch.
    "workbench.activityBar.location": "hidden",
    "workbench.statusBar.visible": false,
    "window.commandCenter": false,
    "workbench.layoutControl.enabled": false,
    "workbench.secondarySideBar.defaultVisibility": "hidden",
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

export function writeMachineSettings(serverDataDir: string, opts: { dark: boolean }): string {
  const file = path.join(serverDataDir, "data", "Machine", "settings.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(buildMachineSettings(opts), null, 2));
  return file;
}

/** IndexedDB names the web workbench uses for its browser-side user data (VS Code 1.14x). */
export const WORKBENCH_DB = { name: "vscode-web-db", version: 3, store: "vscode-userdata-store", settingsKey: "/User/settings.json" };

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
