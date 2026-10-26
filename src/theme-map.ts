/**
 * Obsidian light/dark to VS Code's `workbench.colorTheme` (G6), and the message that switches a running
 * embed without reloading it.
 *
 * Obsidian marks its theme with the `theme-dark` / `theme-light` class on <body>; reading that class
 * (not the OS setting) means custom themes map too. VS Code 1.143 names its built-in themes
 * "Dark Modern" / "Light Modern"; the older "Default ..." ids are not recognised for light (PR-1 round 3).
 *
 * Nothing here talks to the network: the live switch is a script run inside the already loaded page.
 */
import { WORKBENCH_DB_NAME, WORKBENCH_DB_VERSION, WORKBENCH_SETTINGS_KEY, WORKBENCH_USERDATA_STORE } from "./workbench-db";

export const DARK_THEME = "Dark Modern";
export const LIGHT_THEME = "Light Modern";
export const THEME_SETTING = "workbench.colorTheme";

/** The part of a DOM class list this reads. */
export interface ClassListLike {
  contains(name: string): boolean;
}

/** Obsidian is dark when <body> has `theme-dark`. */
export function isDarkBody(classList: ClassListLike): boolean {
  return classList.contains("theme-dark");
}

export function themeFor(dark: boolean): string {
  return dark ? DARK_THEME : LIGHT_THEME;
}

/** The settings that make the embed follow Obsidian's theme. */
export function themeSettings(dark: boolean): Record<string, string> {
  return { [THEME_SETTING]: themeFor(dark) };
}

/** What the plugin sends a running embed when Obsidian's theme changes. */
export interface ThemeSwitchMessage {
  type: "workbench-theme";
  /** The `workbench.colorTheme` value to switch to. */
  theme: string;
  /** Whether the target is a dark theme (used to confirm the switch took effect). */
  dark: boolean;
}

export function themeSwitchMessage(dark: boolean): ThemeSwitchMessage {
  return { type: "workbench-theme", theme: themeFor(dark), dark };
}

/** The result of one live switch: confirmed, sent but not confirmed in time, or not possible (no readable embed). */
export type ThemeSwitchResult = "applied" | "unconfirmed" | "skipped";

/** The channel to one embed. A Code tab's webview implements it; tests use a fake. */
export interface EmbedChannel {
  switchTheme(message: ThemeSwitchMessage): Promise<ThemeSwitchResult>;
}

/** The change broadcast the web workbench listens on for its browser-profile user settings. */
export const SETTINGS_CHANGE_CHANNEL = "vscode.indexedDB.vscode-userdata.changes";

/**
 * A script for the loaded workbench page (`webview.executeJavaScript`) that carries out a ThemeSwitchMessage:
 * it writes `workbench.colorTheme` into the browser profile's user settings (the same store the seed script
 * writes) and tells the workbench's own settings watcher the file changed, so the theme changes in place:
 * no reload, the open file and the cursor stay. It resolves to "applied" once the workbench's dark/light
 * class matches, or "unconfirmed" after 3 seconds. A settings file it cannot parse is left alone ("kept").
 */
export function buildThemeSwitchScript(message: ThemeSwitchMessage): string {
  return `(async () => {
  const theme = ${JSON.stringify(message.theme)};
  const wantDark = ${JSON.stringify(message.dark)};
  const settingKey = ${JSON.stringify(THEME_SETTING)};
  const db = await new Promise((resolve, reject) => {
    const r = indexedDB.open(${JSON.stringify(WORKBENCH_DB_NAME)}, ${WORKBENCH_DB_VERSION});
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  try {
    const existing = await new Promise((resolve, reject) => {
      const q = db.transaction(${JSON.stringify(WORKBENCH_USERDATA_STORE)}).objectStore(${JSON.stringify(WORKBENCH_USERDATA_STORE)}).get(${JSON.stringify(WORKBENCH_SETTINGS_KEY)});
      q.onsuccess = () => resolve(q.result);
      q.onerror = () => reject(q.error);
    });
    let current = {};
    if (existing !== undefined) {
      const text = typeof existing === "string" ? existing : new TextDecoder().decode(existing);
      if (text.trim() !== "") {
        try { current = JSON.parse(text); } catch (e) { return "kept"; }
        if (current === null || typeof current !== "object" || Array.isArray(current)) return "kept";
      }
    }
    if (current[settingKey] !== theme) {
      current[settingKey] = theme;
      await new Promise((resolve, reject) => {
        const tx = db.transaction(${JSON.stringify(WORKBENCH_USERDATA_STORE)}, "readwrite");
        tx.objectStore(${JSON.stringify(WORKBENCH_USERDATA_STORE)}).put(new TextEncoder().encode(JSON.stringify(current, null, 2)), ${JSON.stringify(WORKBENCH_SETTINGS_KEY)});
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }
  } finally {
    db.close();
  }
  const channel = new BroadcastChannel(${JSON.stringify(SETTINGS_CHANGE_CHANNEL)});
  channel.postMessage([{ scheme: "vscode-userdata", path: ${JSON.stringify(WORKBENCH_SETTINGS_KEY)} }]);
  channel.close();
  const isDark = () => document.querySelector(".vs-dark, .hc-black") !== null;
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (isDark() === wantDark) return "applied";
    await new Promise((r) => setTimeout(r, 100));
  }
  return "unconfirmed";
})()`;
}

/**
 * Follows Obsidian's theme with a bounded amount of work however fast it changes. `set` records the latest
 * wish and one loop applies it: while a switch is in flight, further changes only update the wish, and the
 * loop ends when what was applied equals the wish. Ten toggles in a second therefore cost at most a couple of
 * applications, end on the final state, and leave no timer or listener behind.
 */
export class ThemeSync {
  private wanted: boolean;
  private applied: boolean;
  private running: Promise<void> | null = null;
  private draining = false;

  constructor(
    private readonly apply: (dark: boolean) => void | Promise<void>,
    initialDark: boolean,
  ) {
    this.wanted = initialDark;
    this.applied = initialDark;
  }

  /** The theme the embeds were last told to show. */
  get current(): boolean {
    return this.applied;
  }

  /** The server was (re)started with this theme already written: nothing needs applying. */
  markApplied(dark: boolean): void {
    this.wanted = dark;
    this.applied = dark;
  }

  /** Obsidian's theme is now `dark`. Resolves once the final wish has been applied. */
  set(dark: boolean): Promise<void> {
    this.wanted = dark;
    if (this.running) return this.running;
    this.draining = true;
    const p = this.drain();
    // drain() runs synchronously up to its first await: if it finished without waiting, nothing is left running.
    if (this.draining) this.running = p;
    return p;
  }

  private async drain(): Promise<void> {
    try {
      while (this.applied !== this.wanted) {
        const target = this.wanted;
        this.applied = target;
        try {
          await this.apply(target);
        } catch (e) {
          console.warn("VS Code Workbench: the theme switch failed:", e instanceof Error ? e.message : e);
        }
      }
    } finally {
      // Cleared in the same synchronous step as the last check of the loop: a set() that comes after it starts a new drain,
      // and none can slip in between the check and the clear and be left unapplied.
      this.running = null;
      this.draining = false;
    }
  }
}
