import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CHROME_SURFACES, DISABLED_CHORDS, GP1_PARTS, REVEALING_COMMANDS, chromeKeybindings, chromeSettings, closeRoutes, legacyChromeSettings, visibleChrome } from "../../src/chrome-settings";
import { buildChromeHideScript } from "../../src/chrome-script";
import { buildMachineSettings, terminalOverlay, writeMachineSettings, workbenchOverlay } from "../../src/settings";
import { tempDir } from "../helpers";

const settingsFile = (dir: string) => path.join(dir, "data", "Machine", "settings.json");
const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;

describe("chrome settings (G5, GP1)", () => {
  // Written out literally: a change to the table must be a change to this test too. This is the PR-1 route
  // (docs/spike-chrome.md, "Best combination"): R2 + R3 + R4 settings, with the four Zen overrides, and modernUI off (GP6).
  const EXPECTED = {
    "workbench.activityBar.location": "hidden",
    "workbench.statusBar.visible": false,
    "window.commandCenter": false,
    "workbench.layoutControl.enabled": false,
    "window.menuBarVisibility": "hidden",
    "workbench.editor.showTabs": "none",
    "workbench.editor.editorActionsLocation": "hidden",
    "workbench.editor.enablePreview": false,
    "breadcrumbs.enabled": false,
    "workbench.secondarySideBar.defaultVisibility": "hidden",
    "workbench.panel.defaultLocation": "bottom",
    "zenMode.fullScreen": false,
    "zenMode.silentNotifications": false,
    "zenMode.centerLayout": false,
    "zenMode.hideLineNumbers": false,
    // GP6: the floating-card layout's 4 px margin around the editor, off so the editor is as wide as the pane
    "workbench.experimental.modernUI": false,
    // PR-5: with the tab strip hidden the title's leading "●" is the unsaved-edit signal (src/dirty-script.ts), so the template is ours
    "window.title": "${dirty}${activeEditorShort}${separator}${appName}",
  };

  it("carries every hiding setting, the four Zen overrides, the one that makes the editor fill the pane and the window title of the unsaved-edit signal", () => {
    expect(chromeSettings()).toEqual(EXPECTED);
  });

  it("leaves no part visible: no row without a setting, none measured visible, visibleChrome() is empty", () => {
    expect(CHROME_SURFACES.filter((s) => (s.setting as unknown) === null)).toEqual([]);
    for (const s of CHROME_SURFACES) expect(Object.keys(s.setting).length, s.surface).toBeGreaterThan(0);
    expect(CHROME_SURFACES.filter((s) => s.measured === "visible")).toEqual([]);
    expect(CHROME_SURFACES.map((s) => s.measured)).toEqual(CHROME_SURFACES.map(() => "hidden"));
    expect(visibleChrome()).toEqual([]);
  });

  it("names the eight surfaces and which route hides each: settings alone for five, the page script for the three that settings cannot", () => {
    expect(Object.fromEntries(CHROME_SURFACES.map((s) => [s.surface, s.route]))).toEqual({
      activityBar: "setting",
      statusBar: "setting",
      titleBar: "setting",
      tabStrip: "setting",
      breadcrumbs: "setting",
      secondarySideBar: "page-script",
      sideBar: "page-script",
      panel: "page-script",
    });
  });

  // The parts GP1 names, written out from the GP1 wording ("no Explorer, no Open Editors, no VS Code tab strip, no breadcrumb row,
  // no activity bar, status bar, title bar, panel, side bar or secondary side bar"), not read from the source table.
  const GP1 = ["Explorer", "Open Editors", "tab strip", "breadcrumbs", "activity bar", "status bar", "title bar", "panel", "side bar", "secondary side bar"];

  it("the part list equals the GP1 wording", () => {
    expect(Object.keys(GP1_PARTS).sort()).toEqual([...GP1].sort());
  });

  describe.each(GP1)("GP1 part: %s", (part) => {
    it("has a hiding route in chromeSettings() or in the page script", () => {
      const surface = CHROME_SURFACES.find((s) => s.surface === GP1_PARTS[part]);
      expect(surface, part).toBeDefined();
      if (surface!.route === "setting") {
        for (const [k, v] of Object.entries(surface!.setting)) expect(chromeSettings()[k], k).toEqual(v);
      } else {
        // the page script closes it: a close command bound to a seeded chord, and the script presses that chord for the part's selector
        expect(surface!.close, part).toBeDefined();
        expect(chromeKeybindings()).toContainEqual({ key: surface!.close!.key, command: surface!.close!.command });
        expect(buildChromeHideScript()).toContain(JSON.stringify(surface!.selector));
      }
    });
  });

  it("closes the side bar, secondary side bar and panel with the workbench's own commands, and toggles the activity bar and status bar, then PR-4's four editor chords, on ten distinct seeded chords", () => {
    // literal: PR-1's chords (docs/spike-chrome.md R6a, S2) and PR-3's two toggles for the bars the settings hide (E8)
    expect(chromeKeybindings()).toEqual([
      { key: "ctrl+alt+shift+7", command: "workbench.action.toggleActivityBarVisibility" },
      { key: "ctrl+alt+shift+6", command: "workbench.action.toggleStatusbarVisibility" },
      { key: "ctrl+alt+shift+2", command: "workbench.action.closeAuxiliaryBar" },
      { key: "ctrl+alt+shift+1", command: "workbench.action.closeSidebar" },
      { key: "ctrl+alt+shift+3", command: "workbench.action.closePanel" },
      { key: "ctrl+alt+shift+4", command: "workbench.action.closeOtherEditors" },
      // PR-4: put away the editor a file opened from the editor made, show the previous editor when that is refused, join split groups, go to a line
      { key: "ctrl+alt+shift+5", command: "workbench.action.closeActiveEditor" },
      { key: "ctrl+alt+shift+0", command: "workbench.action.openPreviousRecentlyUsedEditorInGroup" },
      { key: "ctrl+alt+shift+8", command: "workbench.action.joinAllGroups" },
      { key: "ctrl+alt+shift+9", command: "workbench.action.gotoLine" },
    ]);
    expect(closeRoutes().map((r) => r.surface)).toEqual(["activityBar", "statusBar", "secondarySideBar", "sideBar", "panel"]);
    expect(new Set(chromeKeybindings().map((k) => k.key)).size).toBe(10);
  });

  it("gives only the panel a hide button for the time a modal dialog swallows the chord, and the button never reaches the seeded keybindings", () => {
    expect(closeRoutes().filter((r) => r.button).map((r) => [r.surface, r.button])).toEqual([["panel", ".part.panel .action-label.codicon-panel-close"]]);
    expect(JSON.stringify(chromeKeybindings())).not.toContain("codicon");
  });

  it("the disabled chords are an exported constant that names every GP4 chord in both spellings (a test fails if it is emptied)", () => {
    // literal: the chords GP4 and E9 name, and the default rules the `-command` removals must match
    expect(DISABLED_CHORDS).toEqual([
      { command: "workbench.action.toggleSidebarVisibility", keys: ["cmd+b", "ctrl+b"] },
      { command: "workbench.action.togglePanel", keys: ["cmd+j", "ctrl+j"] },
      { command: "workbench.action.toggleZenMode", keys: ["cmd+k z", "ctrl+k z"] },
      { command: "workbench.action.closeActiveEditor", keys: ["cmd+w", "ctrl+w", "ctrl+f4"] },
      { command: "workbench.action.toggleAuxiliaryBar", keys: ["cmd+alt+b", "ctrl+alt+b"] },
      { command: "workbench.action.splitEditor", keys: ["cmd+\\", "ctrl+\\"] },
      { command: "workbench.action.splitEditorOrthogonal", keys: ["cmd+k cmd+\\", "ctrl+k ctrl+\\"] },
      { command: "workbench.action.splitEditorInGroup", keys: ["cmd+k cmd+shift+\\", "ctrl+k ctrl+shift+\\"] },
    ]);
  });

  it("the revealing commands are an exported constant that holds the commands E8 names (a test fails if it is emptied)", () => {
    expect(REVEALING_COMMANDS.length).toBeGreaterThanOrEqual(25);
    expect(new Set(REVEALING_COMMANDS).size).toBe(REVEALING_COMMANDS.length);
    expect(REVEALING_COMMANDS).toEqual(
      expect.arrayContaining([
        "workbench.action.toggleSidebarVisibility",
        "workbench.action.togglePanel",
        "workbench.action.toggleAuxiliaryBar",
        "workbench.action.toggleActivityBarVisibility",
        "workbench.action.toggleStatusbarVisibility",
        "workbench.action.toggleZenMode",
        "workbench.view.explorer",
        "workbench.action.terminal.new",
      ]),
    );
    for (const c of REVEALING_COMMANDS) expect(c, c).toMatch(/^workbench\.(action|actions|view|debug)\./);
  });

  it("touches no extensions.* key and nothing that starts or stops the extension host (GP5)", () => {
    for (const k of Object.keys(chromeSettings())) expect(k, k).not.toMatch(/extension/i);
    for (const c of chromeKeybindings()) expect(c.command, c.key).toMatch(/^workbench\.action\.(close(Sidebar|AuxiliaryBar|Panel|OtherEditors|ActiveEditor)|openPreviousRecentlyUsedEditorInGroup|joinAllGroups|gotoLine|toggle(ActivityBarVisibility|StatusbarVisibility))$/);
  });

  it("changes no notification, trust or save-dialog setting (F8)", () => {
    const all = { ...workbenchOverlay({ dark: true }), ...buildMachineSettings({ dark: true }) };
    expect(all["zenMode.silentNotifications"]).toBe(false);
    // zenMode.silentNotifications is the one such key, carried only to keep it false (Zen Mode would otherwise silence notifications)
    for (const k of Object.keys(chromeSettings()).filter((k) => k !== "zenMode.silentNotifications")) expect(k, k).not.toMatch(/notification|trust|confirm|tips|dialog|saveConflict/i);
    for (const k of ["workbench.tips.enabled", "window.confirmBeforeClose", "security.workspace.trust.enabled"]) expect(all, k).not.toHaveProperty(k);
  });

  it("every setting in the table is in the generated Machine settings and in the overlay, light and dark, with the theme", () => {
    for (const dark of [false, true]) {
      const machine = buildMachineSettings({ dark });
      const overlay = workbenchOverlay({ dark });
      for (const [k, v] of Object.entries(EXPECTED)) {
        expect(machine[k], `machine ${dark} ${k}`).toEqual(v);
        expect(overlay[k], `overlay ${dark} ${k}`).toEqual(v);
      }
      expect(machine["workbench.colorTheme"]).toBe(dark ? "Dark Modern" : "Light Modern");
    }
    expect(workbenchOverlay({ dark: true })).toEqual({ ...EXPECTED, "workbench.colorTheme": "Dark Modern" });
    expect(workbenchOverlay({ dark: false })).toEqual({ ...EXPECTED, "workbench.colorTheme": "Light Modern" });
  });

  it("the terminal drawer's overlay is its own: the 0.1.0 hiding settings and the theme, none of the Code tab's new ones (F2)", () => {
    const legacy = {
      "workbench.activityBar.location": "hidden",
      "workbench.statusBar.visible": false,
      "window.commandCenter": false,
      "workbench.layoutControl.enabled": false,
      "workbench.secondarySideBar.defaultVisibility": "hidden",
    };
    expect(legacyChromeSettings()).toEqual(legacy);
    expect(terminalOverlay({ dark: true })).toEqual({ ...legacy, "workbench.colorTheme": "Dark Modern" });
    for (const k of ["workbench.editor.showTabs", "breadcrumbs.enabled", "zenMode.centerLayout", "workbench.editor.editorActionsLocation", "window.title"]) {
      expect(terminalOverlay({ dark: false }), k).not.toHaveProperty(k);
    }
  });
});

describe("writeMachineSettings: the chrome settings reach the embed at every server start", () => {
  it("is idempotent: the same bytes on every call, whatever happened in between", () => {
    const dir = tempDir();
    const file = writeMachineSettings(dir, { dark: true });
    const first = fs.readFileSync(file, "utf8");
    writeMachineSettings(dir, { dark: true });
    expect(fs.readFileSync(file, "utf8")).toBe(first);
    writeMachineSettings(dir, { dark: false });
    writeMachineSettings(dir, { dark: true });
    expect(fs.readFileSync(file, "utf8")).toBe(first);
  });

  it("regenerates a corrupt settings file", () => {
    const dir = tempDir();
    const file = settingsFile(dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ "workbench.activityBar.location": "vis'); // cut off mid-write
    writeMachineSettings(dir, { dark: true });
    const s = read(file);
    for (const [k, v] of Object.entries(chromeSettings())) expect(s[k], k).toEqual(v);
    expect(s["workbench.colorTheme"]).toBe("Dark Modern");
  });

  it("regenerates a missing file and a missing folder", () => {
    const dir = tempDir();
    fs.rmSync(path.join(dir, "data"), { recursive: true, force: true });
    const file = writeMachineSettings(dir, { dark: false });
    expect(read(file)["workbench.statusBar.visible"]).toBe(false);
  });

  it("replaces a folder sitting where the file belongs", () => {
    const dir = tempDir();
    fs.mkdirSync(settingsFile(dir), { recursive: true });
    const file = writeMachineSettings(dir, { dark: false });
    expect(fs.statSync(file).isFile()).toBe(true);
    expect(read(file)["workbench.activityBar.location"]).toBe("hidden");
  });

  it("does not throw when the file cannot be written at all (F3): the tab still opens, with the workbench's own defaults", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "data"), "a file where the data folder belongs");
    fs.chmodSync(path.join(dir, "data"), 0o444);
    // `data` is a file inside the plugin's own dir: the folder cannot be created under it, and removing only the target does not help
    expect(() => writeMachineSettings(dir, { dark: true })).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("could not write the workbench settings");
    warn.mockRestore();
  });

  it("writes nothing outside the server data dir it was given (F3)", () => {
    const parent = tempDir();
    const dir = path.join(parent, "server-data");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(parent, "other-instance-settings.json"), '{"keep":true}');
    writeMachineSettings(dir, { dark: true });
    expect(fs.readdirSync(parent).sort()).toEqual(["other-instance-settings.json", "server-data"]);
    expect(fs.readFileSync(path.join(parent, "other-instance-settings.json"), "utf8")).toBe('{"keep":true}');
  });
});
