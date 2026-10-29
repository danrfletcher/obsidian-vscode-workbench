import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CHROME_SURFACES, chromeSettings, visibleChrome } from "../../src/chrome-settings";
import { buildMachineSettings, writeMachineSettings, workbenchOverlay } from "../../src/settings";
import { tempDir } from "../helpers";

const settingsFile = (dir: string) => path.join(dir, "data", "Machine", "settings.json");
const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;

describe("chrome settings (G5)", () => {
  // Written out literally: a change to the table must be a change to this test too.
  const EXPECTED = {
    "workbench.activityBar.location": "hidden",
    "workbench.statusBar.visible": false,
    "window.commandCenter": false,
    "workbench.layoutControl.enabled": false,
    "workbench.secondarySideBar.defaultVisibility": "hidden",
  };

  it("hides every surface that has a settings switch", () => {
    expect(chromeSettings()).toEqual(EXPECTED);
  });

  it("names the four surfaces of the spec and says honestly which ones have no switch (the PR-1 decision: chrome visible)", () => {
    const bySurface = Object.fromEntries(CHROME_SURFACES.map((s) => [s.surface, s]));
    for (const name of ["activityBar", "statusBar", "sideBar", "panel"]) expect(bySurface[name], name).toBeDefined();
    // hidden by a setting
    expect(bySurface.activityBar.setting).toEqual({ "workbench.activityBar.location": "hidden" });
    expect(bySurface.statusBar.setting).toEqual({ "workbench.statusBar.visible": false });
    // no setting exists: shown, and the README says so (F11)
    expect(bySurface.sideBar.setting).toBeNull();
    expect(bySurface.panel.setting).toBeNull();
    expect(visibleChrome()).toEqual(["secondarySideBar", "sideBar"]);
  });

  it("every setting in the table is in the generated Machine settings, with the theme", () => {
    const machine = buildMachineSettings({ dark: false });
    for (const [k, v] of Object.entries(EXPECTED)) expect(machine[k], k).toEqual(v);
    expect(machine["workbench.colorTheme"]).toBe("Light Modern");
    expect(workbenchOverlay({ dark: true })).toEqual({ ...EXPECTED, "workbench.colorTheme": "Dark Modern" });
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

  it("does not throw when the file cannot be written at all (F11): the tab still opens, with the workbench's own defaults", () => {
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
