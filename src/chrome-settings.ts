/**
 * Hiding VS Code's chrome inside a Code tab, so a tab shows the editor and nothing else (G5, GP1).
 *
 * The routes come from the chrome spike (docs/spike-chrome.md, measured on VS Code 1.143.1 and 1.144.0, host and Obsidian
 * Code tab). Settings alone hide the activity bar, status bar, title bar, tab strip and breadcrumbs. They do NOT hide the
 * side bar at all, and they hide the secondary side bar and the panel only on a profile with no saved layout, so those three
 * are closed by the page script (src/chrome-script.ts: the workbench's own close commands, bound to the seeded chords below
 * and pressed whenever the part shows). Every row therefore has a hiding route that was measured as hidden; none is left
 * visible. The Explorer and Open Editors views live inside the side bar, so hiding the side bar hides them.
 *
 * Hiding is best effort and never blocks anything (F3): the settings are written into the plugin's own files only; if a
 * route stops matching (a VS Code update renames a part), the tab shows that part, the way 0.1.0 did, and still opens (E1).
 * There is no setting to bring the full workbench back (F6).
 */

export type ChromeSurfaceName = "activityBar" | "statusBar" | "titleBar" | "tabStrip" | "breadcrumbs" | "secondarySideBar" | "sideBar" | "panel";

/** The workbench's own command that closes a part, bound to a chord the plugin seeds into the browser profile's keybindings. */
export interface CloseRoute {
  command: string;
  /** In VS Code's keybinding syntax. The page script presses exactly this chord (ctrl+alt+shift plus one digit). */
  key: string;
}

export interface ChromeSurface {
  /** The part of the workbench. */
  surface: ChromeSurfaceName;
  /** CSS selector of the part's element in the workbench page (what the page script and the real-workbench check measure). */
  selector: string;
  /**
   * "setting": the settings below hide the part on every profile. "page-script": the settings below are only supporting
   * ones (the part can come back from saved layout state) and the page script closes it with `close`.
   */
  route: "setting" | "page-script";
  /** The settings that go with the route. Never empty. */
  setting: Readonly<Record<string, unknown>>;
  /** The close command and chord of a "page-script" route. */
  close?: CloseRoute;
  /** What the spike measured for the route in the Obsidian embed. */
  measured: "hidden" | "visible" | "not-open-by-default";
}

export const CHROME_SURFACES: readonly ChromeSurface[] = [
  { surface: "activityBar", selector: ".part.activitybar", route: "setting", setting: { "workbench.activityBar.location": "hidden" }, measured: "hidden" },
  { surface: "statusBar", selector: ".part.statusbar", route: "setting", setting: { "workbench.statusBar.visible": false }, measured: "hidden" },
  // `showTabs: none` on its own brings the title bar back at full width (the editor actions move into it); hiding the editor
  // actions and the menu bar together with the command centre and layout controls keeps it at 0 px.
  {
    surface: "titleBar",
    selector: ".part.titlebar",
    route: "setting",
    setting: { "window.commandCenter": false, "workbench.layoutControl.enabled": false, "window.menuBarVisibility": "hidden" },
    measured: "hidden",
  },
  {
    surface: "tabStrip",
    selector: ".tabs-and-actions-container",
    route: "setting",
    setting: { "workbench.editor.showTabs": "none", "workbench.editor.editorActionsLocation": "hidden", "workbench.editor.enablePreview": false },
    measured: "hidden",
  },
  { surface: "breadcrumbs", selector: ".breadcrumbs-control", route: "setting", setting: { "breadcrumbs.enabled": false }, measured: "hidden" },
  // `defaultVisibility: hidden` only applies to a profile with no saved layout; the close command covers the rest.
  {
    surface: "secondarySideBar",
    selector: ".part.auxiliarybar",
    route: "page-script",
    setting: { "workbench.secondarySideBar.defaultVisibility": "hidden" },
    close: { command: "workbench.action.closeAuxiliaryBar", key: "ctrl+alt+shift+2" },
    measured: "hidden",
  },
  // No setting hides the side bar. The Zen Mode overrides are carried so that, if Zen Mode is ever switched on (a user's own
  // chord), it does not go full-screen, centre the editor, swallow notifications or drop line numbers (GP6, F8).
  {
    surface: "sideBar",
    selector: ".part.sidebar",
    route: "page-script",
    setting: { "zenMode.fullScreen": false, "zenMode.silentNotifications": false, "zenMode.centerLayout": false, "zenMode.hideLineNumbers": false },
    close: { command: "workbench.action.closeSidebar", key: "ctrl+alt+shift+1" },
    measured: "hidden",
  },
  // No setting closes the panel; it starts closed on a fresh profile and the close command covers a saved layout that has it open.
  {
    surface: "panel",
    selector: ".part.panel",
    route: "page-script",
    setting: { "workbench.panel.defaultLocation": "bottom" },
    close: { command: "workbench.action.closePanel", key: "ctrl+alt+shift+3" },
    measured: "hidden",
  },
];

/**
 * Not a part, so not a row above: the settings that make the editor fill the pane (GP6). VS Code 1.143.1 and later draw the editor
 * as a floating card with a 4 px margin on each outer side (`workbench.experimental.modernUI`, on by default; the card classes
 * `floating-editor-outer-*`), so with every part hidden the editor still measured 8 px narrower than the pane. Off, the editor's
 * width equals the webview's (`npm run check:workbench` measures it at four sizes). A user's own copy of this key loses to it.
 */
export const EDITOR_FILL_SETTINGS: Readonly<Record<string, unknown>> = { "workbench.experimental.modernUI": false };

/**
 * The parts GP1 names, and the surface whose hiding takes each one away. Explorer and Open Editors are views inside the
 * side bar, so they go with it.
 */
export const GP1_PARTS: Readonly<Record<string, ChromeSurfaceName>> = {
  Explorer: "sideBar",
  "Open Editors": "sideBar",
  "tab strip": "tabStrip",
  breadcrumbs: "breadcrumbs",
  "activity bar": "activityBar",
  "status bar": "statusBar",
  "title bar": "titleBar",
  panel: "panel",
  "side bar": "sideBar",
  "secondary side bar": "secondarySideBar",
};

/** Every setting that hides a surface, and the ones that make the editor fill the pane. Idempotent: the same object content on every call. */
export function chromeSettings(): Record<string, unknown> {
  return Object.assign({}, ...CHROME_SURFACES.map((s) => s.setting), EDITOR_FILL_SETTINGS);
}

/** The surfaces no measured route hides. Empty: every part has one. */
export function visibleChrome(): string[] {
  return CHROME_SURFACES.filter((s) => s.measured === "visible").map((s) => s.surface);
}

/**
 * The hiding settings 0.1.0 wrote (the activity bar, status bar, title bar and secondary side bar), before the editor-only tab.
 * Written out here, not read from the table above. The terminal drawer's host page keeps exactly these: its overlay is its own
 * and never carries the Code tab's hiding settings (F2; src/main.ts gives the host page `terminalOverlay`). The chrome spike's
 * R0 baseline (tests/render/chrome-spike-*.mjs, docs/spike-chrome.md) is these settings too.
 */
export function legacyChromeSettings(): Record<string, unknown> {
  return {
    "workbench.activityBar.location": "hidden",
    "workbench.statusBar.visible": false,
    "window.commandCenter": false,
    "workbench.layoutControl.enabled": false,
    "workbench.secondarySideBar.defaultVisibility": "hidden",
  };
}

/** The close commands the page script presses, in table order. */
export function closeRoutes(): Array<{ surface: ChromeSurfaceName; selector: string } & CloseRoute> {
  return CHROME_SURFACES.flatMap((s) => (s.close ? [{ surface: s.surface, selector: s.selector, ...s.close }] : []));
}

/**
 * A keybinding the plugin seeds into the browser profile's keybindings.json at every load (src/settings.ts,
 * `buildBrowserSeedScript`). Appended after the user's own rules so that, for the same chord, ours wins.
 */
export interface KeybindingEntry {
  key: string;
  command: string;
}

/**
 * Keeps the editor to the requested file: closes every other editor the profile restored (E6). Pressed once per load by the
 * page script, after the first editor shows (spike S2: `closeOtherEditors` leaves exactly the active editor).
 */
export const CLOSE_OTHER_EDITORS: KeybindingEntry = { key: "ctrl+alt+shift+4", command: "workbench.action.closeOtherEditors" };

/** The chords the page script presses: one close command per page-script part, then close-other-editors. */
export function chromeKeybindings(): KeybindingEntry[] {
  return [...closeRoutes().map(({ key, command }) => ({ key, command })), CLOSE_OTHER_EDITORS];
}
