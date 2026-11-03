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

/**
 * The workbench's own command that puts a part away, bound to a chord the plugin seeds into the browser profile's keybindings.
 * For the side bar, secondary side bar and panel it is a close command; the status bar and the activity bar have no close
 * command, only a toggle, which the page script presses when (and only when) the part is on screen.
 */
export interface CloseRoute {
  command: string;
  /** In VS Code's keybinding syntax. The page script presses exactly this chord (ctrl+alt+shift plus one digit). */
  key: string;
  /**
   * CSS selector of the part's own "hide" button, for the one time the chord cannot get through: a modal dialog (the Workspace Trust
   * prompt that "Terminal: Create New Terminal" brings up) takes the focus and stops every key at itself, so with the panel open
   * behind it the chord does nothing until the dialog is answered. A click on the button is not stopped. Best effort: if the
   * selector stops matching, the panel stays until the dialog is answered, then the chord closes it.
   */
  button?: string;
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
  /**
   * The close command and chord of a "page-script" route. A "setting" route may carry one too: the settings hide the part at
   * every load, and the command puts it away again if a palette command (or a user rule) reveals it later in the tab (E8).
   */
  close?: CloseRoute;
  /** What the spike measured for the route in the Obsidian embed. */
  measured: "hidden" | "visible" | "not-open-by-default";
}

export const CHROME_SURFACES: readonly ChromeSurface[] = [
  // "Toggle Activity Bar Visibility" and "Toggle Status Bar Visibility" change the setting in the profile's settings.json, which the
  // overlay only re-applies at the next load, so the toggle is also the way back: pressed by the page script while the bar shows (E8).
  {
    surface: "activityBar",
    selector: ".part.activitybar",
    route: "setting",
    setting: { "workbench.activityBar.location": "hidden" },
    close: { command: "workbench.action.toggleActivityBarVisibility", key: "ctrl+alt+shift+7" },
    measured: "hidden",
  },
  {
    surface: "statusBar",
    selector: ".part.statusbar",
    route: "setting",
    setting: { "workbench.statusBar.visible": false },
    close: { command: "workbench.action.toggleStatusbarVisibility", key: "ctrl+alt+shift+6" },
    measured: "hidden",
  },
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
    close: { command: "workbench.action.closePanel", key: "ctrl+alt+shift+3", button: ".part.panel .action-label.codicon-panel-close" },
    measured: "hidden",
  },
];

/**
 * Not a part, so not a row above: the settings that make the editor fill the pane (GP6). VS Code 1.143.1 and later draw the editor
 * as a floating card with a 4 px margin on each outer side (`workbench.experimental.modernUI`, on by default; the card classes
 * `floating-editor-outer-*`), so with every part hidden the editor still measured 8 px narrower than the pane. Off, the editor's
 * width equals the webview's (`npm run check:workbench` measures it at four sizes). A user's own copy of this key loses to it.
 * Measured on VS Code 1.143.1 (stable) and on 1.145.0-insider (the installed Insiders build); 1.144.0 was not available to measure.
 * The key is experimental: if a VS Code build renames or promotes it, it is ignored silently, the 4 px margin comes back, and only
 * `npm run check:workbench` (the editor-fills-the-pane measurement) notices, not `npm test`. Re-run it after a VS Code update.
 */
export const EDITOR_FILL_SETTINGS: Readonly<Record<string, unknown>> = { "workbench.experimental.modernUI": false };

/**
 * Not a part either: the window title the plugin's unsaved-edit signal reads (PR-5; src/dirty-script.ts, docs/spike-chrome.md S5).
 * With the tab strip hidden the title's leading "●" (`${dirty}`) is the only mark of an unsaved editor, so the plugin writes the
 * template itself: a `window.title` copied from the user's own settings cannot drop the mark, and the overlay wins over it. The
 * template is the default one without the folder name; it never reads empty (`${appName}` stays when no editor is open).
 */
export const DIRTY_TITLE_SETTINGS: Readonly<Record<string, unknown>> = { "window.title": "${dirty}${activeEditorShort}${separator}${appName}" };

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

/** Every setting that hides a surface, the ones that make the editor fill the pane, and the window title of the unsaved-edit signal. Idempotent: the same object content on every call. */
export function chromeSettings(): Record<string, unknown> {
  return Object.assign({}, ...CHROME_SURFACES.map((s) => s.setting), EDITOR_FILL_SETTINGS, DIRTY_TITLE_SETTINGS);
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

/**
 * Puts away the editor a file opened from inside the editor (Go to Definition, quick open, a link) just opened, so the tab shows
 * its own file again at its own cursor (PR-4; spike S2: the first file comes back at the line it was left on). The file itself
 * opens as a new Obsidian tab. This is the command Cmd+W normally runs, which is one of the disabled chords; this chord is ours.
 */
export const CLOSE_ACTIVE_EDITOR: KeybindingEntry = { key: "ctrl+alt+shift+5", command: "workbench.action.closeActiveEditor" };

/**
 * Shows the editor that was in front before the active one, without closing the active one (PR-4). The page script presses it when
 * closing the opened editor is refused by VS Code's "Do you want to save" prompt (the file opened from the editor already holds
 * unsaved edits in this tab): the prompt is cancelled and the tab shows its own file again, the edits kept.
 */
export const SHOW_PREVIOUS_EDITOR: KeybindingEntry = { key: "ctrl+alt+shift+0", command: "workbench.action.openPreviousRecentlyUsedEditorInGroup" };

/**
 * Merges the editor groups of a tab into one (PR-4, E4): the palette's "Split Editor" has no chord to disable, so the page script
 * presses this when it finds a second group on screen. The tab then shows one editor group again.
 */
export const JOIN_ALL_GROUPS: KeybindingEntry = { key: "ctrl+alt+shift+8", command: "workbench.action.joinAllGroups" };

/**
 * Opens VS Code's Go to Line input (PR-4). A tab opened, or an open tab asked, to show a file at a line presses this and types
 * `:<line>` (the default Ctrl+G is not used because a copied keybinding may have moved it).
 */
export const GO_TO_LINE: KeybindingEntry = { key: "ctrl+alt+shift+9", command: "workbench.action.gotoLine" };

/**
 * The chords the page scripts press: one close command per part with a close route, close-other-editors, and the four editor
 * chords of PR-4 (put away an opened editor, show the previous editor instead, join split groups, go to a line).
 */
export function chromeKeybindings(): KeybindingEntry[] {
  return [...closeRoutes().map(({ key, command }) => ({ key, command })), CLOSE_OTHER_EDITORS, CLOSE_ACTIVE_EDITOR, SHOW_PREVIOUS_EDITOR, JOIN_ALL_GROUPS, GO_TO_LINE];
}

/**
 * The layout and Zen chords that stay dead in a Code tab (GP4, E9; docs/spike-chrome.md S3): Cmd/Ctrl+B, Cmd/Ctrl+J, Cmd+K Z, Cmd+W,
 * and the side-bar chord of the secondary side bar. Each is listed in both spellings because a `-command` removal only matches the
 * default rule written the same way (Mac `cmd`, Linux and Windows `ctrl`); Ctrl+F4 is the other default of close-editor. The
 * bridged chords (Ctrl+` and the quick switcher, src/hotkey/hotkey-bridge.ts) are not here, and neither is `escape escape`: Zen Mode is
 * not a hiding route of this plugin, so a Zen Mode entered from the palette must still be left the usual way.
 */
export const DISABLED_CHORDS: readonly { command: string; keys: readonly string[] }[] = [
  { command: "workbench.action.toggleSidebarVisibility", keys: ["cmd+b", "ctrl+b"] },
  { command: "workbench.action.togglePanel", keys: ["cmd+j", "ctrl+j"] },
  { command: "workbench.action.toggleZenMode", keys: ["cmd+k z", "ctrl+k z"] },
  { command: "workbench.action.closeActiveEditor", keys: ["cmd+w", "ctrl+w", "ctrl+f4"] },
  { command: "workbench.action.toggleAuxiliaryBar", keys: ["cmd+alt+b", "ctrl+alt+b"] },
  // VS Code's own editor splits (PR-4, E4): a tab is one editor for one file. The palette's "Split Editor" has no chord, and the page
  // script joins the groups again if one appears; these are the chords (Cmd+\ and Cmd+K Cmd+\).
  { command: "workbench.action.splitEditor", keys: ["cmd+\\", "ctrl+\\"] },
  { command: "workbench.action.splitEditorOrthogonal", keys: ["cmd+k cmd+\\", "ctrl+k ctrl+\\"] },
  // Splits the one editor inside its own group (a second pane in the same editor-group-container), which the join-groups script
  // cannot see. Cmd+K Cmd+Shift+\ is its default chord (VS Code 1.145.0's workbench bundle).
  { command: "workbench.action.splitEditorInGroup", keys: ["cmd+k cmd+shift+\\", "ctrl+k ctrl+shift+\\"] },
];

/**
 * The commands that can bring a bar (or Zen Mode, or the panel through a terminal) back. Collected from the ids VS Code 1.145.0
 * ships in its workbench bundle (every `workbench.action.toggle*` that shows or hides a part, the `workbench.view.*` view
 * containers, the `workbench.action.focus*` commands that open a hidden part) plus PR-1's S4 findings (docs/spike-chrome.md: the
 * palette toggles for the side bar, panel and secondary side bar; "Terminal: Create New Terminal" opens the panel). Used two ways:
 * the tests run each one and check that every bar ends hidden, and the keybinding overlay unbinds any chord a copied
 * keybindings.json gives them (`unbindCommands()`). View containers that extensions contribute (`workbench.view.extension.*`)
 * cannot be listed; the page script covers them, since it watches the parts, not the commands.
 */
export const REVEALING_COMMANDS: readonly string[] = [
  // parts
  "workbench.action.toggleSidebarVisibility",
  "workbench.action.toggleAuxiliaryBar",
  "workbench.action.togglePanel",
  "workbench.action.toggleActivityBarVisibility",
  "workbench.action.toggleStatusbarVisibility",
  "workbench.action.toggleMenuBar",
  "workbench.action.toggleZenMode",
  "workbench.action.toggleMaximizedPanel",
  "workbench.action.toggleMaximizedAuxiliaryBar",
  // focus commands that open a part that is hidden
  "workbench.action.focusSideBar",
  "workbench.action.focusAuxiliaryBar",
  "workbench.action.focusPanel",
  "workbench.action.focusActivityBar",
  "workbench.action.focusStatusBar",
  "workbench.action.focusCommentsPanel",
  // view containers (the side bar)
  "workbench.view.explorer",
  "workbench.view.search",
  "workbench.view.scm",
  "workbench.view.debug",
  "workbench.view.extensions",
  "workbench.view.remote",
  "workbench.view.sync",
  "workbench.view.testing",
  "workbench.view.testCoverage",
  "workbench.view.editSessions",
  "workbench.action.openView",
  // views of the panel and the secondary side bar
  "workbench.action.terminal.new",
  "workbench.action.terminal.newInActiveWorkspace",
  "workbench.action.terminal.newWithProfile",
  "workbench.action.terminal.toggleTerminal",
  "workbench.action.terminal.focus",
  "workbench.action.output.toggleOutput",
  "workbench.actions.view.problems",
  "workbench.debug.action.toggleRepl",
  "workbench.action.chat.open",
];

/**
 * Every command a user's own keybinding must not bind to a chord in a Code tab: the revealing commands and the commands of the
 * disabled chords (a copied `cmd+w` -> `closeActiveEditor` would close the editor inside VS Code). The overlay writes an
 * unbound rule after each such copied rule.
 */
export function unbindCommands(): string[] {
  return [...new Set([...REVEALING_COMMANDS, ...DISABLED_CHORDS.map((d) => d.command)])];
}

/** The `-command` entries that remove the default rule of every disabled chord. */
export function chordRemovals(): KeybindingEntry[] {
  return DISABLED_CHORDS.flatMap(({ command, keys }) => keys.map((key) => ({ key, command: `-${command}` })));
}

/**
 * Everything the browser profile's keybindings.json gains at EVERY load (src/keybinding-overlay.ts lays it over the copied or
 * stored file): the chords the page script presses, then the removals of the disabled chords.
 */
export function overlayKeybindings(): KeybindingEntry[] {
  return [...chromeKeybindings(), ...chordRemovals()];
}
