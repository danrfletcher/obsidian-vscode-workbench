/**
 * Hiding VS Code's chrome inside a Code tab (G5, F11).
 *
 * Each surface is hidden by a workbench setting where VS Code has one. The PR-1 spike measured what
 * works in the embed (docs/spike-decision.md, header `chrome: visible`): the activity bar, status bar,
 * title bar and panel measured 0 px; the side bar and the secondary side bar stayed visible, because
 * the workbench has no settings switch for them. Surfaces without a switch are listed here with
 * `setting: null`, so the table says what is hidden and what is not, and the README says the same.
 *
 * Hiding is best effort and never blocks anything (F11): the settings are written into the plugin's own
 * files only; if a setting is ignored the tab simply shows that part of the chrome.
 */

export interface ChromeSurface {
  /** The part of the workbench. */
  surface: "activityBar" | "statusBar" | "titleBar" | "secondarySideBar" | "sideBar" | "panel";
  /** The settings that hide it, or null when the workbench has no setting for it. */
  setting: Readonly<Record<string, unknown>> | null;
  /** What the spike measured in the Obsidian embed. */
  measured: "hidden" | "visible" | "not-open-by-default";
}

export const CHROME_SURFACES: readonly ChromeSurface[] = [
  { surface: "activityBar", setting: { "workbench.activityBar.location": "hidden" }, measured: "hidden" },
  { surface: "statusBar", setting: { "workbench.statusBar.visible": false }, measured: "hidden" },
  { surface: "titleBar", setting: { "window.commandCenter": false, "workbench.layoutControl.enabled": false }, measured: "hidden" },
  { surface: "secondarySideBar", setting: { "workbench.secondarySideBar.defaultVisibility": "hidden" }, measured: "visible" },
  // No settings switch exists for these two (docs/spike-decision.md): the side bar is shown, the panel is closed until opened.
  { surface: "sideBar", setting: null, measured: "visible" },
  { surface: "panel", setting: null, measured: "not-open-by-default" },
];

/** Every setting that hides a surface. Idempotent: the same object content on every call. */
export function chromeSettings(): Record<string, unknown> {
  return Object.assign({}, ...CHROME_SURFACES.map((s) => s.setting ?? {}));
}

/** The surfaces that stay visible in the embed (no setting hides them, or the spike measured the setting as ignored). */
export function visibleChrome(): string[] {
  return CHROME_SURFACES.filter((s) => s.measured === "visible").map((s) => s.surface);
}
