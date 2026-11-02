import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BROWSER_APP_SETTINGS, USER_DATA_MARKER_KEY, buildBrowserSeedScript, buildMachineSettings, workbenchOverlay, writeMachineSettings, type UserDataCopy } from "../../src/settings";
import { excludeGlobs, profileSeedSource, seedUserData } from "../../src/server/user-data-seed";
import { STOP_TEXT, describeAge, describeDisabledLists, describeExtensionsSection, describePort, describeProfile, renderExtensionsSection, type PortStatus, type SpikeResult } from "../../src/settings/extensions-section";
import { SPIKE_RESULT } from "../../src/settings/spike-result";
import { FakeNode, Setting } from "../mocks/obsidian";
import { WorkbenchSettingTab, type SettingsHost } from "../../src/settings/settings-tab";
import { DEFAULT_SETTINGS, type WorkbenchSettings } from "../../src/settings/data";
import { MANUAL_TRUST_STEPS, describeTrust } from "../../src/trust/trust-message";
import { findMirroredProfile, type MirroredProfile, type ProfileState } from "../../src/profile/mirrored-profile";
import { PROFILES, TOGGLE_PANEL_KEY, TRUST_KEYS, vscodeFolderUri, writeUserData } from "../fixtures/make-fake-user-data.mjs";
import type { MirrorResult } from "../../src/mirror/mirror";
import { tempDir } from "../helpers";
import { fakeIndexedDB, fakeStorage } from "../fake-seed-page";
import { chromeKeybindings, type KeybindingEntry } from "../../src/chrome-settings";

describe("writeMachineSettings", () => {
  it("writes the dark theme and chrome-hiding settings into the plugin's own server data dir", () => {
    const dir = tempDir();
    const file = writeMachineSettings(dir, { dark: true });
    expect(file).toBe(path.join(dir, "data", "Machine", "settings.json"));
    const s = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(s["workbench.colorTheme"]).toBe("Dark Modern");
    expect(s["workbench.activityBar.location"]).toBe("hidden");
    expect(s["workbench.statusBar.visible"]).toBe(false);
    expect(s["telemetry.telemetryLevel"]).toBe("off");
  });

  it("leaves Workspace Trust on (the Machine file cannot switch it off, and a silent trust-off would trust the whole vault)", () => {
    const s = JSON.parse(fs.readFileSync(writeMachineSettings(tempDir(), { dark: true }), "utf8")) as Record<string, unknown>;
    expect(s).not.toHaveProperty("security.workspace.trust.enabled");
  });

  it("switches to the light theme and rewrites the same file", () => {
    const dir = tempDir();
    writeMachineSettings(dir, { dark: true });
    const file = writeMachineSettings(dir, { dark: false });
    expect((JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>)["workbench.colorTheme"]).toBe("Light Modern");
  });
});

describe("workspace excludes in the Machine file (G16)", () => {
  it("carries the five excludes under files.watcherExclude and search.exclude, light or dark, on every rewrite", () => {
    const dir = tempDir();
    const file = writeMachineSettings(dir, { dark: true });
    const first = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    writeMachineSettings(dir, { dark: false }); // what css-change does
    const second = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    const expected = {
      "**/.git": true,
      "**/.obsidian": true,
      "**/Attachments": true,
      "**/node_modules": true,
      "**/_to_delete": true,
    };
    for (const s of [first, second]) {
      expect(s["files.watcherExclude"]).toEqual(expected);
      expect(s["search.exclude"]).toEqual(expected);
    }
    expect(excludeGlobs()).toEqual(expected);
  });
});

describe("application-scoped off switches (F5)", () => {
  it("lists the switches for extension updates, update checks, experiments, recommendations and telemetry", () => {
    expect(BROWSER_APP_SETTINGS).toEqual({
      "extensions.autoUpdate": false,
      "extensions.autoCheckUpdates": false,
      "extensions.ignoreRecommendations": true,
      "workbench.enableExperiments": false,
      "telemetry.telemetryLevel": "off",
      "update.mode": "none",
      "update.showReleaseNotes": false,
    });
  });

  it("also carries them in the Machine file (harmless, but measured to have no effect there)", () => {
    const s = buildMachineSettings({ dark: false });
    for (const [k, v] of Object.entries(BROWSER_APP_SETTINGS)) expect(s[k]).toEqual(v);
  });
});

async function runSeed(initial?: Record<string, unknown>, copy?: UserDataCopy | null, storage = fakeStorage(), chords?: readonly KeybindingEntry[]) {
  const fake = fakeIndexedDB(initial);
  const run = new Function("indexedDB", "localStorage", "TextEncoder", "TextDecoder", `return ${buildBrowserSeedScript(BROWSER_APP_SETTINGS, copy, chords)}`) as (...a: unknown[]) => Promise<string>;
  const outcome = await run(fake.indexedDB, storage, TextEncoder, TextDecoder);
  const raw = fake.stores.get("vscode-userdata-store")?.get("/User/settings.json") as Uint8Array | string | undefined;
  const text = raw === undefined ? undefined : typeof raw === "string" ? raw : new TextDecoder().decode(raw);
  const kb = fake.stores.get("vscode-userdata-store")?.get("/User/keybindings.json") as Uint8Array | undefined;
  return { outcome, text, keybindings: kb === undefined ? undefined : new TextDecoder().decode(kb), storage, ...fake };
}

describe("the overlay and the Machine settings carry the hiding set (GP1, G5)", () => {
  const HIDING_KEYS = [
    "workbench.activityBar.location",
    "workbench.statusBar.visible",
    "window.commandCenter",
    "workbench.layoutControl.enabled",
    "window.menuBarVisibility",
    "workbench.editor.showTabs",
    "workbench.editor.editorActionsLocation",
    "workbench.editor.enablePreview",
    "breadcrumbs.enabled",
    "workbench.secondarySideBar.defaultVisibility",
    "workbench.panel.defaultLocation",
  ];
  const ZEN = { "zenMode.fullScreen": false, "zenMode.silentNotifications": false, "zenMode.centerLayout": false, "zenMode.hideLineNumbers": false };

  it.each([true, false])("dark=%s: every hiding setting and the four Zen overrides, in both the Machine settings and the overlay", (dark) => {
    for (const settings of [buildMachineSettings({ dark }), workbenchOverlay({ dark })]) {
      for (const k of HIDING_KEYS) expect(settings, k).toHaveProperty(k);
      expect(settings).toMatchObject(ZEN);
      expect(settings["workbench.editor.showTabs"]).toBe("none");
      expect(settings["breadcrumbs.enabled"]).toBe(false);
      expect(settings["workbench.colorTheme"]).toBe(dark ? "Dark Modern" : "Light Modern");
    }
  });

  it("is byte-identical on repeated calls, and the written Machine file too", () => {
    for (const dark of [true, false]) {
      const once = JSON.stringify(buildMachineSettings({ dark }));
      const overlay = JSON.stringify(workbenchOverlay({ dark }));
      for (let i = 0; i < 5; i++) {
        expect(JSON.stringify(buildMachineSettings({ dark }))).toBe(once);
        expect(JSON.stringify(workbenchOverlay({ dark }))).toBe(overlay);
      }
    }
    const dir = tempDir();
    const file = writeMachineSettings(dir, { dark: false });
    const first = fs.readFileSync(file, "utf8");
    for (let i = 0; i < 3; i++) writeMachineSettings(dir, { dark: false });
    expect(fs.readFileSync(file, "utf8")).toBe(first);
  });

  it.each([true, false])("dark=%s: the overlay (what the Code tab writes on every load) has no key that silences notifications, trust, close or save dialogs (F8)", (dark) => {
    const overlay = workbenchOverlay({ dark });
    // the one notification-related key is Zen Mode's, carried only to keep it false
    expect(overlay["zenMode.silentNotifications"]).toBe(false);
    const keys = Object.keys(overlay).filter((k) => k !== "zenMode.silentNotifications");
    expect(keys.filter((k) => /notification|trust|confirm|tips|dialog|conflict|hotExit|autoSave|restoreWindows/i.test(k))).toEqual([]);
    for (const k of ["workbench.tips.enabled", "window.confirmBeforeClose", "files.hotExit", "files.autoSave", "security.workspace.trust.enabled", "security.workspace.trust.startupPrompt", "security.workspace.trust.banner"]) {
      expect(overlay, k).not.toHaveProperty(k);
    }
  });

  it("the Machine file has no key that silences notifications, trust or save dialogs, and no extensions.* key (F8, GP5)", () => {
    const all = Object.keys(buildMachineSettings({ dark: true }));
    // the extensions.* keys are the update off switches from before this PR (BROWSER_APP_SETTINGS); hiding adds none
    const extensionKeys = all.filter((k) => /^extensions\./.test(k));
    for (const k of extensionKeys) expect(Object.keys(BROWSER_APP_SETTINGS), k).toContain(k);
    expect(extensionKeys.sort()).toEqual(Object.keys(BROWSER_APP_SETTINGS).filter((k) => /^extensions\./.test(k)).sort());
    for (const k of ["workbench.tips.enabled", "window.confirmBeforeClose", "files.hotExit"]) expect(all, k).not.toContain(k);
    expect(all.filter((k) => /trust/i.test(k))).toEqual([]);
  });

  it("the overlay wins over copied settings that turn each part back on, on the first load and on every later one (same copy id)", async () => {
    const hostile = {
      "workbench.statusBar.visible": true,
      "zenMode.centerLayout": true,
      "workbench.editor.showTabs": "multiple",
      "breadcrumbs.enabled": true,
      "workbench.activityBar.location": "default",
      "zenMode.hideLineNumbers": true,
      "editor.fontSize": 21,
    };
    const copy: UserDataCopy = { id: "same", settings: hostile, keybindingsBase64: null };
    const overlay = { ...BROWSER_APP_SETTINGS, ...workbenchOverlay({ dark: true }) };
    const fake = fakeIndexedDB();
    const storage = fakeStorage();
    const seed = () =>
      (new Function("indexedDB", "localStorage", "TextEncoder", "TextDecoder", `return ${buildBrowserSeedScript(overlay, copy, chromeKeybindings())}`) as (...a: unknown[]) => Promise<string>)(fake.indexedDB, storage, TextEncoder, TextDecoder);
    const stored = () => JSON.parse(new TextDecoder().decode(fake.stores.get("vscode-userdata-store")!.get("/User/settings.json") as Uint8Array)) as Record<string, unknown>;
    for (let load = 1; load <= 3; load++) {
      expect(await seed(), `load ${load}`).toBe("seeded");
      expect(stored(), `load ${load}`).toMatchObject(workbenchOverlay({ dark: true }));
      expect(stored()["editor.fontSize"], `load ${load}`).toBe(21); // what the user did not set against us is theirs
    }
    // the tab changes a hiding setting itself between loads: the next load puts ours back
    const tampered = { ...stored(), "workbench.statusBar.visible": true, "breadcrumbs.enabled": true };
    fake.stores.get("vscode-userdata-store")!.set("/User/settings.json", new TextEncoder().encode(JSON.stringify(tampered)));
    expect(await seed()).toBe("seeded");
    expect(stored()).toMatchObject({ "workbench.statusBar.visible": false, "breadcrumbs.enabled": false });
  });

  it("line numbers are the user's: the plugin sets no editor.lineNumbers, keeps Zen's hideLineNumbers false, and a copied editor.lineNumbers survives every load (GP6)", async () => {
    for (const dark of [true, false]) {
      for (const built of [buildMachineSettings({ dark }), workbenchOverlay({ dark })]) {
        expect(built).not.toHaveProperty("editor.lineNumbers");
        expect(built["zenMode.hideLineNumbers"]).toBe(false);
      }
    }
    for (const value of ["off", "relative", "interval"]) {
      const copy: UserDataCopy = { id: `ln-${value}`, settings: { "editor.lineNumbers": value, "zenMode.hideLineNumbers": true }, keybindingsBase64: null };
      const overlay = { ...BROWSER_APP_SETTINGS, ...workbenchOverlay({ dark: false }) };
      const fake = fakeIndexedDB();
      const storage = fakeStorage();
      const seed = () =>
        (new Function("indexedDB", "localStorage", "TextEncoder", "TextDecoder", `return ${buildBrowserSeedScript(overlay, copy, chromeKeybindings())}`) as (...a: unknown[]) => Promise<string>)(fake.indexedDB, storage, TextEncoder, TextDecoder);
      for (let load = 1; load <= 2; load++) {
        await seed();
        const stored = JSON.parse(new TextDecoder().decode(fake.stores.get("vscode-userdata-store")!.get("/User/settings.json") as Uint8Array)) as Record<string, unknown>;
        expect(stored["editor.lineNumbers"], `${value} load ${load}`).toBe(value);
        expect(stored["zenMode.hideLineNumbers"], `${value} load ${load}`).toBe(false); // the one line-number key we own
      }
    }
  });
});

describe("buildBrowserSeedScript (run against a fake IndexedDB)", () => {
  it("creates the workbench's database and writes the off switches into /User/settings.json", async () => {
    const r = await runSeed();
    expect(r.outcome).toBe("seeded");
    expect(r.state.opened).toEqual([["vscode-web-db", 3]]);
    expect([...r.stores.keys()].sort()).toEqual(["vscode-filehandles-store", "vscode-logs-store", "vscode-userdata-store"]);
    expect(JSON.parse(r.text as string)).toEqual(BROWSER_APP_SETTINGS);
    expect(r.state.closed).toBe(1);
  });

  it("keeps settings the user already has and overrides only the off switches", async () => {
    const existing = JSON.stringify({ "editor.fontSize": 18, "extensions.autoUpdate": true });
    const r = await runSeed({ "/User/settings.json": new TextEncoder().encode(existing) });
    expect(r.outcome).toBe("seeded");
    expect(JSON.parse(r.text as string)).toEqual({ ...BROWSER_APP_SETTINGS, "editor.fontSize": 18 });
  });

  it("leaves a settings file it cannot parse (comments) untouched", async () => {
    const commented = '{\n  // my font\n  "editor.fontSize": 18\n}';
    const r = await runSeed({ "/User/settings.json": new TextEncoder().encode(commented) });
    expect(r.outcome).toBe("kept");
    expect(r.text).toContain("// my font");
    expect(r.text).not.toContain("extensions.autoUpdate");
    expect(r.state.closed).toBe(1);
  });
});

describe("buildBrowserSeedScript with the copy of the instance's settings and keybindings (G17)", () => {
  const kb = '[{ "key": "ctrl+alt+n", "command": "workbench.action.toggleSidebarVisibility" }] // mine\n';
  const copy: UserDataCopy = {
    id: "start-1",
    settings: { "editor.fontSize": 23, "extensions.autoUpdate": true, "search.exclude": { "**/.obsidian": true, "**/mine": true } },
    keybindingsBase64: Buffer.from(kb).toString("base64"),
  };

  it("writes the copied keys and the keybindings into the browser profile, the off switches winning", async () => {
    const r = await runSeed(undefined, copy);
    expect(r.outcome).toBe("seeded");
    expect(JSON.parse(r.text as string)).toEqual({ ...copy.settings, ...BROWSER_APP_SETTINGS });
    expect(r.keybindings).toBe(kb); // byte for byte, comment included
    expect(r.storage.map.get(USER_DATA_MARKER_KEY)).toBe("start-1");
  });

  it("replaces a copy from an earlier start, and removes keybindings the instance no longer has", async () => {
    const r = await runSeed(
      { "/User/settings.json": new TextEncoder().encode(JSON.stringify({ "editor.fontSize": 9, "editor.tabSize": 3 })), "/User/keybindings.json": new TextEncoder().encode("[]") },
      { ...copy, id: "start-2", keybindingsBase64: null },
    );
    // the copy replaces the profile's file whole: a key set inside the tab (editor.tabSize) or removed from the instance is gone
    expect(JSON.parse(r.text as string)).toEqual({ ...copy.settings, ...BROWSER_APP_SETTINGS });
    expect(r.keybindings).toBeUndefined();
  });

  // Characterisation (chrome spike S3): the seed treats keybindings.json as the instance's file, not as ours. Chord
  // disables written into the profile's file (`-command` entries) are not in the instance's copy, so a seed with a new
  // copy id wipes them. A later PR must append them to the copied file (or re-apply them on every load); nothing does today.
  it("replaces a profile keybindings.json that holds `-command` chord disables with the copy, so the disables are lost and need a re-apply route (S3)", async () => {
    const disables = [
      { key: "cmd+b", command: "-workbench.action.toggleSidebarVisibility" },
      { key: "cmd+j", command: "-workbench.action.togglePanel" },
      { key: "cmd+k z", command: "-workbench.action.toggleZenMode" },
      { key: "cmd+w", command: "-workbench.action.closeActiveEditor" },
    ];
    const withDisables = new TextEncoder().encode(JSON.stringify(disables));
    const initial = { "/User/settings.json": new TextEncoder().encode("{}"), "/User/keybindings.json": withDisables };
    const storage = fakeStorage();

    // the same copy id (a tab reload): the profile's file is left alone, the disables are still there
    storage.map.set(USER_DATA_MARKER_KEY, "start-1");
    const reload = await runSeed(initial, copy, storage);
    expect(reload.keybindings).toContain("-workbench.action.toggleSidebarVisibility");

    // a new copy id (a server start): the copy replaces the file whole, and none of the four disables survive
    const start = await runSeed(initial, { ...copy, id: "start-2" }, storage);
    expect(start.keybindings).toBe(kb);
    for (const d of disables) expect(start.keybindings).not.toContain(d.command);

    // and a copy with no keybindings removes the file, the disables with it
    const bare = await runSeed(initial, { ...copy, id: "start-3", keybindingsBase64: null }, fakeStorage());
    expect(bare.keybindings).toBeUndefined();
  });

  it("drops a key the instance removed since the last start, instead of keeping it in the profile (PR-3 R4)", async () => {
    const storage = fakeStorage();
    const first = await runSeed(undefined, { ...copy, settings: { "editor.fontSize": 23, "editor.rulers": [80] } }, storage);
    expect(JSON.parse(first.text as string)["editor.rulers"]).toEqual([80]);
    const second = await runSeed(
      { "/User/settings.json": new TextEncoder().encode(first.text as string) },
      { ...copy, id: "start-2", settings: { "editor.fontSize": 23 } },
      storage,
    );
    expect(JSON.parse(second.text as string)).toEqual({ "editor.fontSize": 23, ...BROWSER_APP_SETTINGS });
  });

  it("applies a copy once per server start: a tab reload keeps what the user changed in the tab", async () => {
    const storage = fakeStorage();
    const first = await runSeed(undefined, copy, storage);
    // the user changes the font size in the tab; the tab reloads and seeds again with the same copy id
    const edited = { ...JSON.parse(first.text as string), "editor.fontSize": 40 };
    const second = await runSeed({ "/User/settings.json": new TextEncoder().encode(JSON.stringify(edited)) }, copy, storage);
    expect(JSON.parse(second.text as string)["editor.fontSize"]).toBe(40);
    // a new server start has a new id: the instance's value is applied again
    const third = await runSeed({ "/User/settings.json": new TextEncoder().encode(JSON.stringify(edited)) }, { ...copy, id: "start-2" }, storage);
    expect(JSON.parse(third.text as string)["editor.fontSize"]).toBe(23);
  });

  it("replaces a profile settings file that no longer parses when a new copy is due, so the copy still reaches the editor (PR-3 R5)", async () => {
    const r = await runSeed({ "/User/settings.json": new TextEncoder().encode('{ // hand edited in the tab\n}') }, copy);
    expect(r.outcome).toBe("seeded");
    expect(JSON.parse(r.text as string)).toEqual({ ...copy.settings, ...BROWSER_APP_SETTINGS });
    expect(r.keybindings).toBe(kb);
    expect(r.storage.map.get(USER_DATA_MARKER_KEY)).toBe("start-1");
  });

  it("on a tab reload within one start, a file that no longer parses is kept and the outcome says so (PR-3 R5)", async () => {
    const storage = fakeStorage();
    storage.setItem(USER_DATA_MARKER_KEY, "start-1"); // this start's copy is already applied
    const r = await runSeed({ "/User/settings.json": new TextEncoder().encode('{ // hand edited\n}') }, copy, storage);
    expect(r.outcome).toBe("kept");
    expect(r.text).toContain("// hand edited");
  });
});

describe("the seed script built from a stripped profile copy holds no trust key (G12, G13)", () => {
  const vault = "/Users/x/Vault";
  const copyFor = (location: string): UserDataCopy => {
    const root = writeUserData(path.join(tempDir(), "Code - Insiders"), { associations: { [vscodeFolderUri(vault)]: location } });
    const profile = findMirroredProfile({ userDataRoot: root, vaultPath: vault });
    // The fixture's settings.json files carry all five trust keys (and comments, trailing commas).
    expect(fs.readFileSync(path.join(profile.files.settings.dir as string, "settings.json"), "utf8")).toContain("security.workspace.trust.enabled");
    const seeded = seedUserData({ userDataDir: path.join(tempDir(), "data"), ...profileSeedSource({ status: "resolved", profile }, null) });
    return { id: "start-1", settings: seeded.merged, keybindingsBase64: seeded.keybindingsBase64 };
  };

  it.each([
    ["FDE Practice", PROFILES.custom.location, 22],
    ["Default", "__default__profile__", 14],
  ])("%s: /User/settings.json in IndexedDB has the profile's values and no security.workspace.trust.* key", async (_n, location, fontSize) => {
    const copy = copyFor(location);
    // An earlier file in the tab with trust keys in it is replaced whole by the copy.
    const old = new TextEncoder().encode(JSON.stringify(TRUST_KEYS));
    const r = await runSeed({ "/User/settings.json": old }, copy);
    expect(r.outcome).toBe("seeded");
    const written = JSON.parse(r.text as string) as Record<string, unknown>;
    expect(written["editor.fontSize"]).toBe(fontSize);
    expect(Object.keys(written).filter((k) => k.startsWith("security.workspace.trust."))).toEqual([]);
    expect(r.text).not.toContain("security.workspace.trust");
  });

  it("the profile's keybinding is written byte for byte, and a later Default copy replaces it", async () => {
    const storage = fakeStorage();
    const first = await runSeed(undefined, copyFor(PROFILES.custom.location), storage);
    expect(first.keybindings).toContain(TOGGLE_PANEL_KEY.command);
    const second = await runSeed({ "/User/settings.json": new TextEncoder().encode(first.text as string), "/User/keybindings.json": new TextEncoder().encode(first.keybindings as string) }, { ...copyFor("__default__profile__"), id: "start-2" }, storage);
    expect(second.keybindings).not.toContain(TOGGLE_PANEL_KEY.command);
    expect(JSON.parse(second.text as string)["editor.fontSize"]).toBe(14);
    expect(second.text).not.toContain("FDE Practice");
  });

  it("the Machine file still has no security.workspace.trust.* key, and the seed script still turns telemetry off", () => {
    const machine = buildMachineSettings({ dark: true });
    expect(Object.keys(machine).filter((k) => k.startsWith("security.workspace.trust."))).toEqual([]);
    expect(BROWSER_APP_SETTINGS).toMatchObject({ "telemetry.telemetryLevel": "off" });
    expect(buildBrowserSeedScript(BROWSER_APP_SETTINGS, copyFor(PROFILES.custom.location))).toContain('"telemetry.telemetryLevel":"off"');
  });
});

describe("buildBrowserSeedScript with the chrome-hiding chords (GP1; the chrome spike's S3 re-apply route)", () => {
  const chords = chromeKeybindings();
  const parse = (text: string | undefined) => JSON.parse(text as string) as Array<{ key: string; command: string }>;
  const kb = '// mine\n[{ "key": "ctrl+alt+n", "command": "workbench.action.toggleSidebarVisibility" },]\n';
  const copy: UserDataCopy = { id: "start-1", settings: {}, keybindingsBase64: Buffer.from(kb).toString("base64") };
  const mine = { key: "ctrl+alt+n", command: "workbench.action.toggleSidebarVisibility" };
  const enc = (s: string) => new TextEncoder().encode(s);

  it("writes the four chords into a profile that has no keybindings.json", async () => {
    const r = await runSeed(undefined, null, undefined, chords);
    expect(r.outcome).toBe("seeded");
    expect(parse(r.keybindings)).toEqual([
      { key: "ctrl+alt+shift+2", command: "workbench.action.closeAuxiliaryBar" },
      { key: "ctrl+alt+shift+1", command: "workbench.action.closeSidebar" },
      { key: "ctrl+alt+shift+3", command: "workbench.action.closePanel" },
      { key: "ctrl+alt+shift+4", command: "workbench.action.closeOtherEditors" },
    ]);
  });

  it("puts them after the copied rules (comments and trailing commas read), the copy's own rule kept", async () => {
    const r = await runSeed(undefined, copy, undefined, chords);
    expect(r.outcome).toBe("seeded");
    expect(parse(r.keybindings)).toEqual([mine, ...chords]);
  });

  it("is the same bytes on every load: a reload with the same copy id does not add them twice", async () => {
    const first = await runSeed(undefined, copy, undefined, chords);
    const again = await runSeed({ "/User/keybindings.json": enc(first.keybindings as string), "/User/settings.json": enc(first.text as string) }, copy, first.storage, chords);
    expect(again.keybindings).toBe(first.keybindings);
    const noCopy = await runSeed({ "/User/keybindings.json": enc(first.keybindings as string) }, null, undefined, chords);
    expect(noCopy.keybindings).toBe(first.keybindings);
  });

  it("re-adds chords the profile lost, and keeps the rules a user added in the tab", async () => {
    const stored = JSON.stringify([mine, { key: "ctrl+alt+shift+1", command: "workbench.action.closeSidebar" }, { key: "ctrl+k", command: "-x" }]);
    const r = await runSeed({ "/User/keybindings.json": enc(stored) }, null, undefined, chords);
    expect(parse(r.keybindings)).toEqual([mine, { key: "ctrl+k", command: "-x" }, ...chords]);
  });

  it("puts ours last for the same chord, after a copied rule on one of our chords", async () => {
    const theirs = { key: "ctrl+alt+shift+1", command: "workbench.action.toggleSidebarVisibility" };
    const withTheirs: UserDataCopy = { ...copy, keybindingsBase64: Buffer.from(JSON.stringify([theirs])).toString("base64") };
    const r = await runSeed(undefined, withTheirs, undefined, chords);
    expect(parse(r.keybindings)).toEqual([theirs, ...chords]);
  });

  it("leaves a stored keybindings.json that is not an array alone (the tab then shows that chrome, F3), and still seeds the settings", async () => {
    const r = await runSeed({ "/User/keybindings.json": enc("not json at all") }, null, undefined, chords);
    expect(r.outcome).toBe("seeded");
    expect(r.keybindings).toBe("not json at all");
    expect(JSON.parse(r.text as string)).toEqual(BROWSER_APP_SETTINGS);
  });

  it("replaces a copied keybindings.json that is not an array with the chords alone", async () => {
    const bad: UserDataCopy = { ...copy, keybindingsBase64: Buffer.from("{").toString("base64") };
    const r = await runSeed(undefined, bad, undefined, chords);
    expect(parse(r.keybindings)).toEqual(chords);
  });

  it("with an instance that has no keybindings, a new copy leaves the chords alone in the profile", async () => {
    const r = await runSeed({ "/User/keybindings.json": enc("[]") }, { ...copy, keybindingsBase64: null }, undefined, chords);
    expect(parse(r.keybindings)).toEqual(chords);
  });

  it("without chords the keybindings handling is what it was", async () => {
    const r = await runSeed(undefined, copy);
    expect(r.keybindings).toBe(kb);
  });
});

describe("buildBrowserSeedScript when VS Code's database is not what the plugin expects (PR-1 R9)", () => {
  const script = () => new Function("indexedDB", "localStorage", "TextEncoder", "TextDecoder", `return ${buildBrowserSeedScript(BROWSER_APP_SETTINGS, null)}`) as (...a: unknown[]) => Promise<string>;

  it("answers version-mismatch when the database is already at a newer version", async () => {
    const indexedDB = {
      open: () => {
        const r: { error: unknown; onerror?: () => void } = { error: { name: "VersionError" } };
        queueMicrotask(() => r.onerror?.());
        return r;
      },
    };
    expect(await script()(indexedDB, fakeStorage(), TextEncoder, TextDecoder)).toBe("version-mismatch");
  });

  it("answers no-store when the database has no user-data store", async () => {
    let closed = 0;
    const indexedDB = {
      open: () => {
        const r: { result: unknown; onsuccess?: () => void } = { result: { objectStoreNames: { contains: () => false }, close: () => void closed++ } };
        queueMicrotask(() => r.onsuccess?.());
        return r;
      },
    };
    expect(await script()(indexedDB, fakeStorage(), TextEncoder, TextDecoder)).toBe("no-store");
    expect(closed).toBe(1);
  });

  it("answers error:<name> for anything else the page refuses, and still closes the database", async () => {
    const real = fakeIndexedDB({ "/User/settings.json": "{}" });
    const db = (real.indexedDB.open("x", 3) as { result: { transaction: unknown } }).result;
    db.transaction = () => {
      throw Object.assign(new Error("denied"), { name: "SecurityError" });
    };
    const indexedDB = { open: () => { const r: { result: unknown; onsuccess?: () => void } = { result: db }; queueMicrotask(() => r.onsuccess?.()); return r; } };
    expect(await script()(indexedDB, fakeStorage(), TextEncoder, TextDecoder)).toBe("error:SecurityError");
    expect(real.state.closed).toBe(1);
  });
});

describe("the Extensions section of the settings tab", () => {
  const OK: SpikeResult = {
    measuredOn: "2026-10-27",
    vscodeVersion: "1.145.0-insider",
    stablePort: { stable: true, result: "Same origin after a restart.", decision: "Store one port per vault." },
    trustRecord: { found: true, location: "db-x / ItemTable / content.trust.model.key", result: "Written by the Trust click.", decision: "Seed it in PR-2." },
    settingsRoute: { arrives: true, route: "the IndexedDB write", result: "fontSize 12px to 23px.", decision: "PR-6 builds on the IndexedDB write." },
    turboConsoleLog: { state: "active", cause: "Restricted Mode kept it from activating", result: "Activation logged after trust.", decision: "Trust is the fix." },
  };
  const PORT: PortStatus = { stored: 51789, current: 51789, note: null };
  const draw = (result: SpikeResult | null, port: PortStatus = PORT) => {
    const el = new FakeNode("div");
    renderExtensionsSection(el as unknown as HTMLElement, describeExtensionsSection(result, port));
    const rows = el.all().filter((n) => n.cls?.includes("workbench-extensions-row"));
    return {
      el,
      text: el.all().map((n) => n.text).join("\n"),
      row: (name: string) => rows.find((r) => r.children[0]?.text === name),
      tone: (name: string) => rows.find((r) => r.children[0]?.text === name)?.children[1],
    };
  };

  it("measured OK: the decision for each of the four questions, the date and the port in use", () => {
    const d = draw(OK);
    expect(d.text).toContain("Extensions");
    expect(d.row("Measured")?.children[1].text).toBe("2026-10-27, on VS Code 1.145.0-insider.");
    expect(d.row("Stable port")?.children[1].text).toBe("Same origin after a restart. Decision: Store one port per vault.");
    expect(d.row("Stable port in use")?.children[1].text).toBe("Port 51789 (stored), in use by the running server.");
    expect(d.row("Trust record")?.children[1].text).toBe("Found at db-x / ItemTable / content.trust.model.key. Written by the Trust click. Decision: Seed it in PR-2.");
    expect(d.row("Settings and keybindings")?.children[1].text).toBe("Route: the IndexedDB write. fontSize 12px to 23px. Decision: PR-6 builds on the IndexedDB write.");
    expect(d.row("Turbo Console Log")?.children[1].text).toBe("active. Cause: Restricted Mode kept it from activating. Activation logged after trust. Decision: Trust is the fix.");
    expect(d.text).not.toContain("STOP");
    expect(d.text).not.toContain("not found");
  });

  it("STOP: the settings route row shows the stop text, in the error colour, and the others are unaffected", () => {
    const stop: SpikeResult = { ...OK, settingsRoute: { arrives: false, route: null, result: "No route moved editor.fontSize.", decision: "STOP: ask Dan." } };
    const d = draw(stop);
    const row = d.tone("Settings and keybindings")!;
    expect(row.text).toBe(`${STOP_TEXT} No route moved editor.fontSize.`);
    expect(row.text.startsWith("STOP:")).toBe(true);
    expect(d.row("Settings and keybindings")?.cls).toContain("workbench-error");
    expect(row.style.color).toBeFalsy();
    expect(d.row("Trust record")?.children[1].text).toContain("Found at");
  });

  it("trust record not found: the row says \"not found\" and claims no location or format", () => {
    const d = draw({ ...OK, trustRecord: { found: false, location: null, result: "No key with trust in its name changed.", decision: "Build nothing on it." } });
    const row = d.tone("Trust record")!;
    expect(row.text).toBe("not found. No key with trust in its name changed. Decision: Build nothing on it.");
    expect(row.text).not.toContain("Found at");
    expect(d.row("Trust record")?.cls).toContain("workbench-warning");
    expect(row.style.color).toBeFalsy();
  });

  it("no record yet: one line saying so, and the port still shown", () => {
    const d = draw(null, { stored: null, current: null, note: null });
    expect(d.row("Extension spike")?.children[1].text).toBe("No spike result recorded yet.");
    expect(d.row("Stable port in use")?.children[1].text).toContain("None stored yet");
    expect(d.row("Trust record")).toBeUndefined();
  });

  it("a failing Turbo Console Log shows the separate finding with its real cause", () => {
    const d = draw({ ...OK, turboConsoleLog: { state: "failed", cause: "Cannot find module 'x' (extension host log)", result: "Activated, then threw.", decision: "Fix that first." } });
    expect(d.tone("Turbo Console Log")?.text).toBe("failed. Cause: Cannot find module 'x' (extension host log). Activated, then threw. Decision: Fix that first.");
  });

  it("no text is drawn in a tone colour: --text-success is 2.6:1 on white, so the tone is a row class (a bar) and the text keeps the theme's own colour", () => {
    const stop: SpikeResult = { ...OK, settingsRoute: { ...OK.settingsRoute, arrives: false }, trustRecord: { ...OK.trustRecord, found: false } };
    for (const result of [OK, stop]) {
      const d = draw(result);
      expect(d.el.all().map((n) => n.style.color).filter(Boolean)).toEqual([]);
    }
    const d = draw(OK);
    for (const name of ["Stable port", "Trust record", "Settings and keybindings", "Turbo Console Log"]) expect(d.row(name)?.cls).toContain("workbench-ok");
    expect(d.row("Measured")?.cls).toContain("workbench-info");
  });

  it("styles.css gives each tone its bar colour from a theme variable", () => {
    const css = fs.readFileSync(path.join(process.cwd(), "src/styles.css"), "utf8");
    for (const [tone, v] of [["ok", "--text-success"], ["warning", "--text-warning"], ["error", "--text-error"]]) {
      expect(css).toMatch(new RegExp(`\\.workbench-extensions-row\\.workbench-${tone}\\s*\\{[^}]*border-left-color:\\s*var\\(${v}\\)`));
    }
    expect(css).not.toMatch(/\.workbench-message[^{]*\{[^}]*color:/);
  });

  it("styles.css lets an Extensions row's text wrap and never clips it (long paths, why-text, snapshot age)", () => {
    const css = fs.readFileSync(path.join(process.cwd(), "src/styles.css"), "utf8");
    // Every rule that targets the row or its message, whatever else it sets.
    const rules = [...css.matchAll(/([^{}]*\.workbench-extensions-row[^{}]*)\{([^}]*)\}/g)].map((m) => m[2]);
    expect(rules.length).toBeGreaterThan(0);
    for (const body of rules) {
      expect(body).not.toMatch(/overflow(-x|-y)?:\s*(hidden|clip)/);
      expect(body).not.toMatch(/white-space:\s*(nowrap|pre)\b/);
      expect(body).not.toMatch(/text-overflow:/);
      expect(body).not.toMatch(/(^|[;\s])(max-)?height:/);
    }
    expect(css).toMatch(/\.workbench-extensions-row \.workbench-message\s*\{[^}]*white-space:\s*normal[^}]*overflow-wrap:\s*anywhere/);
  });

  it.each<[string, PortStatus, string]>([
    ["nothing stored, no server", { stored: null, current: null, note: null }, "None stored yet: the first server start picks a free port and stores it."],
    ["nothing stored, server running", { stored: null, current: 52000, note: null }, "Server running on port 52000; it will be stored as this vault's stable port."],
    ["stored, no server", { stored: 51789, current: null, note: null }, "Stored port 51789. No server is running; the next start tries this port first."],
    ["stored and in use", { stored: 51789, current: 51789, note: null }, "Port 51789 (stored), in use by the running server."],
    ["stored but another port in use, with the reason", { stored: 51789, current: 52000, note: "Another program has it." }, "Stored port 51789; the running server is on 52000 this time. Another program has it."],
  ])("the port line: %s", (_n, port, text) => {
    const row = describePort(port);
    expect(row.text).toBe(text);
    expect(row.tone).toBe(port.note ? "warning" : "info");
  });

  it("the recorded result shipped in SPIKE_RESULT has all four questions answered, a date, and no STOP", () => {
    expect(SPIKE_RESULT).not.toBeNull();
    const r = SPIKE_RESULT!;
    expect(r.measuredOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const q of [r.stablePort, r.trustRecord, r.settingsRoute, r.turboConsoleLog]) {
      expect(q.result.length).toBeGreaterThan(0);
      expect(q.decision.length).toBeGreaterThan(0);
    }
    expect(r.settingsRoute.arrives).toBe(true);
    expect(r.settingsRoute.decision).not.toContain("STOP");
  });
});

describe("the \"Trust the vault folder\" toggle in the settings tab (G6, E3)", () => {
  function openTab(initial: Partial<WorkbenchSettings> = {}, outcome: string | null | undefined = null) {
    let current: WorkbenchSettings = { ...DEFAULT_SETTINGS, ...initial };
    let last = outcome;
    const updateSettings = vi.fn(async (patch: Partial<WorkbenchSettings>) => {
      current = { ...current, ...patch };
    });
    const host: SettingsHost = {
      restartServer: async () => undefined,
      serverState: () => "running",
      workbenchSettings: () => current,
      updateSettings,
      scanInstances: async () => ({ instances: [], rejected: [], customFailure: null }),
      verifyCustomCli: async () => ({ ok: false, reason: "no" }),
      codeCliOverride: () => undefined,
      portStatus: () => ({ stored: null, current: null, note: null }),
      spikeResult: () => null,
      mirroredProfile: () => ({ status: "not-read" }),
      extensionRows: async () => ({ status: "server-not-running" }),
      ...(last === undefined ? {} : { trustOutcome: () => last ?? null }),
    };
    Setting.reset();
    const tab = new WorkbenchSettingTab({} as never, {} as never, host);
    tab.display();
    const toggle = () => Setting.all.find((s) => s.name === "Trust the vault folder")!;
    const messages = () => (tab.containerEl as unknown as FakeNode).all().filter((n) => n.cls?.includes("workbench-message")).map((n) => n.text);
    return { tab, host, updateSettings, toggle, messages, setOutcome: (o: string | null) => void (last = o), current: () => current };
  }

  it("renders the toggle next to the other toggles, on by default, with a description that says what it does", () => {
    const { toggle } = openTab();
    const names = Setting.all.map((s) => s.name);
    expect(names.indexOf("Trust the vault folder")).toBe(names.indexOf("Terminal drawer over non-code views") + 1);
    expect(names).not.toContain("Shell");
    expect(toggle().toggle?.value).toBe(true);
    expect(toggle().desc).toContain("trusted");
    expect(toggle().desc).toContain("Only the vault folder is trusted");
    expect(toggle().desc).toContain("applies at the next tab load");
    expect(toggle().desc).toContain("Workspaces: Manage Workspace Trust");
  });

  it("shows the stored value when it is off", () => {
    expect(openTab({ trustVaultFolder: false }).toggle().toggle?.value).toBe(false);
  });

  it("onChange saves through updateSettings({ trustVaultFolder })", async () => {
    const t = openTab();
    await t.toggle().toggle!.handler!(false);
    expect(t.updateSettings).toHaveBeenCalledTimes(1);
    expect(t.updateSettings).toHaveBeenCalledWith({ trustVaultFolder: false });
    expect(t.current().trustVaultFolder).toBe(false);
    await t.toggle().toggle!.handler!(true);
    expect(t.updateSettings).toHaveBeenLastCalledWith({ trustVaultFolder: true });
  });

  it("turning it off shows how to trust by hand, naming the command; turning it on again clears that line", async () => {
    const t = openTab();
    expect(t.messages().filter((m) => m.includes("Manage Workspace Trust"))).toEqual([]);
    await t.toggle().toggle!.handler!(false);
    expect(t.messages().join("\n")).toContain('"Workspaces: Manage Workspace Trust"');
    expect(t.messages().join("\n")).toContain("Restricted Mode");
    await t.toggle().toggle!.handler!(true);
    expect(t.messages().filter((m) => m.includes("Manage Workspace Trust"))).toEqual([]);
  });

  it.each([
    ["version-mismatch", "is not in the format this plugin knows"],
    ["no-store", "has no place for the trust record"],
    ["error:SecurityError", "the page refused the write (SecurityError)"],
    ["timeout", "did not answer in time"],
    ["unsupported", "cannot run scripts in the Code tab"],
  ])("a %s outcome from the host shows a message that names the manual Trust command", (outcome, reason) => {
    const t = openTab({}, outcome);
    const text = t.messages().join("\n");
    expect(text).toContain(reason);
    expect(text).toContain('"Workspaces: Manage Workspace Trust"');
    expect(text).toContain("then choose Trust");
    expect(text).toContain("The Code tab still opens");
  });

  it("reads the outcome from the host each time the tab is displayed, not from anywhere else", () => {
    const t = openTab({}, "timeout");
    expect(t.messages().join("\n")).toContain("did not answer in time");
    t.setOutcome("seeded");
    t.tab.display();
    const text = (t.tab.containerEl as unknown as FakeNode).textContent();
    expect(text).toContain("The vault folder was trusted when the last Code tab loaded.");
    expect(text).not.toContain("did not answer in time");
  });

  it("says nothing about the outcome before any tab has run the seed, and also when the host has no outcome method", () => {
    expect(openTab({}, null).messages().filter((m) => /trusted/.test(m))).toEqual([]);
    expect(openTab({}, undefined).messages().filter((m) => /trusted/.test(m))).toEqual([]);
  });

  it("with the toggle off, the off message wins over an old failure outcome", () => {
    const text = openTab({ trustVaultFolder: false }, "timeout").messages().join("\n");
    expect(text).toContain("Trusting is off");
    expect(text).not.toContain("did not answer in time");
  });
});

describe("describeTrust", () => {
  it("covers every state in plain words", () => {
    expect(describeTrust(true, null)).toBeNull();
    expect(describeTrust(true, "seeded")).toEqual({ tone: "ok", text: "The vault folder was trusted when the last Code tab loaded." });
    expect(describeTrust(false, "seeded")?.tone).toBe("info");
    expect(describeTrust(true, "error:")?.text).toContain("(unknown error)");
    expect(describeTrust(true, "something-new")?.text).toContain('the seed reported "something-new"');
    expect(describeTrust(true, "no-store")?.tone).toBe("warning");
    expect(MANUAL_TRUST_STEPS).toBe('run "Workspaces: Manage Workspace Trust" from the command palette, then choose Trust');
  });
});

describe("the Profile row of the Extensions section (G7, G8, G9, E2, E10)", () => {
  /** A real lookup against a generated user-data folder, so the row is drawn from what the module really returns. */
  function lookup(associations: Record<string, string>, vaultPath = "/Users/x/My Vault/Café Ünï"): MirroredProfile {
    const root = writeUserData(path.join(tempDir(), "Code - Insiders"), { associations });
    return findMirroredProfile({ userDataRoot: root, vaultPath });
  }
  const resolved = (profile: MirroredProfile): ProfileState => ({ status: "resolved", profile });

  it("before the first server start: says the profile is read when the server starts, and names no profile", () => {
    const row = describeProfile({ status: "not-read" });
    expect(row).toEqual({ name: "Profile", text: "Not read yet: the profile is read when the server starts.", tone: "info" });
    for (const name of ["Default", "FDE Practice", "Agents"]) expect(row.text).not.toContain(name);
  });

  it("chosen from the vault folder: the profile name and where it came from, no fallback line", () => {
    const row = describeProfile(resolved(lookup({ [vscodeFolderUri("/Users/x/My Vault/Café Ünï")]: PROFILES.custom.location })));
    expect(row).toEqual({ name: "Profile", text: "FDE Practice. Chosen from: the vault folder.", tone: "ok" });
  });

  it("associated with Default: Default, chosen from the vault folder, no fallback line (GP1, GP2)", () => {
    const row = describeProfile(resolved(lookup({ [vscodeFolderUri("/Users/x/My Vault/Café Ünï")]: "__default__profile__" })));
    expect(row).toEqual({ name: "Profile", text: "Default. Chosen from: the vault folder.", tone: "ok" });
  });

  it("chosen from a parent folder: names the parent", () => {
    const row = describeProfile(resolved(lookup({ [vscodeFolderUri("/Users/x")]: PROFILES.custom.location })));
    expect(row.text).toBe("FDE Practice. Chosen from: a parent folder (file:///Users/x).");
  });

  it("a profile that reads Default's files says which", () => {
    const row = describeProfile(resolved(lookup({ [vscodeFolderUri("/Users/x/My Vault/Café Ünï")]: PROFILES.agents.location })));
    expect(row.text).toBe("Agents. Chosen from: the vault folder. Reads Default's settings, keybindings.");
    expect(row.tone).toBe("ok");
  });

  it("no association: Default, chosen from default, the reason and the vault URI that was tried (G7, E10)", () => {
    const row = describeProfile(resolved(lookup({})));
    expect(row).toEqual({
      name: "Profile",
      text: "Default. Chosen from: default. Fallback: the vault folder is not associated with a profile in desktop VS Code (vault URI tried: file:///Users/x/My Vault/Café Ünï), so Default is used.",
      tone: "warning",
    });
  });

  it("an unknown profile: the fallback line names the location id (G8)", () => {
    const row = describeProfile(resolved(lookup({ [vscodeFolderUri("/Users/x/My Vault/Café Ünï")]: "ffff0000" })));
    expect(row.text).toBe(
      'Default. Chosen from: default. Fallback: the vault folder is associated with profile location "ffff0000", which is not in desktop VS Code\'s list of profiles (it was deleted or is unknown), so Default is used.',
    );
    expect(row.tone).toBe("warning");
  });

  it("a profile whose folder is gone (E2)", () => {
    const row = describeProfile(resolved(lookup({ [vscodeFolderUri("/Users/x/My Vault/Café Ünï")]: PROFILES.deleted.location })));
    expect(row.text).toBe(
      'Default. Chosen from: default. Fallback: the vault folder is associated with profile "Old Profile" (location "d3adbeef"), but its folder under User/profiles/ is missing, so Default is used.',
    );
  });

  it("an unreadable storage.json", () => {
    const root = writeUserData(path.join(tempDir(), "Code - Insiders"));
    fs.writeFileSync(path.join(root, "User", "globalStorage", "storage.json"), "");
    const row = describeProfile(resolved(findMirroredProfile({ userDataRoot: root, vaultPath: "/Users/x/Vault" })));
    expect(row.text).toBe("Default. Chosen from: default. Fallback: desktop VS Code's storage.json could not be read (the file is empty), so Default is used.");
  });

  it("a profile that could not be worked out (a custom CLI with no known folder): says so and shows no profile", () => {
    const row = describeProfile({ status: "unavailable", reason: "the user-data folder of this custom VS Code cannot be told" });
    expect(row).toEqual({
      name: "Profile",
      text: "Could not be worked out: the user-data folder of this custom VS Code cannot be told. Default is not assumed; no profile is shown.",
      tone: "warning",
    });
  });

  describe("in the settings tab, against the mock host", () => {
    function open(profile: () => ProfileState) {
      const host: SettingsHost = {
        restartServer: async () => undefined,
        serverState: () => "running",
        workbenchSettings: () => ({ ...DEFAULT_SETTINGS }),
        updateSettings: async () => undefined,
        scanInstances: async () => ({ instances: [], rejected: [], customFailure: null }),
        verifyCustomCli: async () => ({ ok: false, reason: "no" }),
        codeCliOverride: () => undefined,
        portStatus: () => ({ stored: 51789, current: 51789, note: null }),
        spikeResult: () => SPIKE_RESULT,
        mirroredProfile: profile,
        extensionRows: async () => ({ status: "server-not-running" }),
      };
      Setting.reset();
      const tab = new WorkbenchSettingTab({} as never, {} as never, host);
      tab.display();
      const el = tab.containerEl as unknown as FakeNode;
      const rows = el.all().filter((n) => n.cls?.includes("workbench-extensions-row"));
      const row = (name: string) => rows.find((r) => r.children[0]?.text === name);
      return { tab, el, row, text: () => el.textContent() };
    }

    it("renders the not-read state, with no stale guess", () => {
      const t = open(() => ({ status: "not-read" }));
      expect(t.row("Profile")?.children[1].text).toBe("Not read yet: the profile is read when the server starts.");
      expect(t.row("Profile")?.cls).toContain("workbench-info");
    });

    it("renders a chosen profile", () => {
      const t = open(() => resolved(lookup({ [vscodeFolderUri("/Users/x/My Vault/Café Ünï")]: PROFILES.custom.location })));
      expect(t.row("Profile")?.children[1].text).toBe("FDE Practice. Chosen from: the vault folder.");
      expect(t.row("Profile")?.cls).toContain("workbench-ok");
    });

    it("renders a fallback with its reason, in the warning tone", () => {
      const t = open(() => resolved(lookup({})));
      expect(t.row("Profile")?.children[1].text).toContain("not associated with a profile in desktop VS Code");
      expect(t.row("Profile")?.cls).toContain("workbench-warning");
    });

    it("sits in the Extensions section, after the port row, followed by the disabled-lists row", () => {
      const t = open(() => ({ status: "not-read" }));
      const names = t.el.all().filter((n) => n.cls?.includes("workbench-extensions-row")).map((r) => r.children[0]?.text);
      expect(names).toEqual(["Measured", "Stable port", "Stable port in use", "Profile", "Disabled in VS Code", "Trust record", "Settings and keybindings", "Turbo Console Log"]);
    });

    it("reads the host each time the tab is displayed: a restart's new result shows at once, nothing is cached", () => {
      let state: ProfileState = { status: "not-read" };
      const t = open(() => state);
      expect(t.row("Profile")?.children[1].text).toContain("Not read yet");
      state = resolved(lookup({ [vscodeFolderUri("/Users/x/My Vault/Café Ünï")]: PROFILES.custom.location }));
      t.tab.display();
      expect(t.text()).toContain("FDE Practice. Chosen from: the vault folder.");
      expect(t.text()).not.toContain("Not read yet: the profile is read when the server starts.");
    });

    it("a host that throws: the Profile row says it could not be shown, and the rest of settings is still drawn", () => {
      const t = open(() => {
        throw new Error("secret detail that must not be shown");
      });
      expect(t.row("Profile")?.children[1].text).toBe("Could not be worked out: the plugin could not report it. Default is not assumed; no profile is shown.");
      expect(t.text()).not.toContain("secret detail");
      expect(Setting.all.find((x) => x.name === "Trust the vault folder")).toBeDefined();
      expect(t.row("Turbo Console Log")).toBeDefined();
      expect(t.row("Stable port in use")).toBeDefined();
      expect(Setting.all.find((x) => x.name === "Restart server")).toBeDefined();
    });
  });

  it("a Profile row and a disabled-lists row with no spike result recorded are still drawn, after the port", () => {
    const el = new FakeNode("div");
    renderExtensionsSection(el as unknown as HTMLElement, describeExtensionsSection(null, { stored: null, current: null, note: null }, { status: "not-read" }));
    const names = el.all().filter((n) => n.cls?.includes("workbench-extensions-row")).map((r) => r.children[0]?.text);
    expect(names).toEqual(["Extension spike", "Stable port in use", "Profile", "Disabled in VS Code"]);
  });

  it("describeExtensionsSection without a profile argument says not read yet", () => {
    const view = describeExtensionsSection(null, { stored: null, current: null, note: null });
    expect(view.rows.find((r) => r.name === "Profile")?.text).toBe("Not read yet: the profile is read when the server starts.");
  });
});

describe("the Disabled in VS Code row of the Extensions section (G14, E1)", () => {
  const NOW = 1_800_000_000_000;
  const read: MirrorResult = { source: "read", disabled: ["a.b", "c.d", "e.f"], counts: { global: 1, profile: 1, workspace: 2 }, notes: [], at: NOW };

  it("not read yet", () => {
    expect(describeDisabledLists(null, NOW)).toEqual({ name: "Disabled in VS Code", text: "Not read yet: the disabled lists are read when the server starts.", tone: "info" });
  });

  it("read: says the lists were read, how many extensions are disabled and from which lists", () => {
    expect(describeDisabledLists(read, NOW)).toEqual({
      name: "Disabled in VS Code",
      text: "Disabled lists read from desktop VS Code at the last server start: 3 extensions disabled (global 1, profile 1, workspace 2).",
      tone: "ok",
    });
  });

  it("read in the Default profile: no profile count (its list is the global one), one extension in the singular, and the notes", () => {
    const row = describeDisabledLists({ ...read, disabled: ["a.b"], counts: { global: 0, profile: null, workspace: 1 }, notes: ["no workspace storage names the vault"] }, NOW);
    expect(row.text).toBe(
      "Disabled lists read from desktop VS Code at the last server start: 1 extension disabled (global 0, workspace 1). Note: no workspace storage names the vault.",
    );
  });

  it("snapshot: says the snapshot from an earlier start is used, with its age and why the read failed", () => {
    const snap: MirrorResult = { source: "snapshot", disabled: ["a.b"], takenAt: NOW - 3 * 3_600_000 - 5 * 60_000, why: "the disabled list could not be read (the global list: sqlite3 was not found on PATH)" };
    expect(describeDisabledLists(snap, NOW)).toEqual({
      name: "Disabled in VS Code",
      text: "Using the snapshot from an earlier start, taken 3 hours ago (1 extension disabled). Why: the disabled list could not be read (the global list: sqlite3 was not found on PATH).",
      tone: "warning",
    });
  });

  it("none: says no extensions are shared, and why", () => {
    const none: MirrorResult = { source: "none", disabled: [], why: "the disabled list could not be read (the global list: sqlite3 was not found on PATH); there is no earlier snapshot" };
    expect(describeDisabledLists(none, NOW)).toEqual({
      name: "Disabled in VS Code",
      text: "No extensions are shared: the disabled list could not be read (the global list: sqlite3 was not found on PATH); there is no earlier snapshot.",
      tone: "warning",
    });
  });

  it("describeAge: minutes, hours, days, singular and plural, and a clock that ran backwards", () => {
    expect(describeAge(-5000)).toBe("less than a minute");
    expect(describeAge(59_000)).toBe("less than a minute");
    expect(describeAge(60_000)).toBe("1 minute");
    expect(describeAge(45 * 60_000)).toBe("45 minutes");
    expect(describeAge(60 * 60_000)).toBe("1 hour");
    expect(describeAge(23 * 3_600_000)).toBe("23 hours");
    expect(describeAge(24 * 3_600_000)).toBe("1 day");
    expect(describeAge(50 * 3_600_000)).toBe("2 days");
  });

  describe("in the settings tab, against the mock host", () => {
    function open(disabledLists?: () => MirrorResult | null) {
      const host: SettingsHost = {
        restartServer: async () => undefined,
        serverState: () => "running",
        workbenchSettings: () => ({ ...DEFAULT_SETTINGS }),
        updateSettings: async () => undefined,
        scanInstances: async () => ({ instances: [], rejected: [], customFailure: null }),
        verifyCustomCli: async () => ({ ok: false, reason: "no" }),
        codeCliOverride: () => undefined,
        portStatus: () => ({ stored: 51789, current: 51789, note: null }),
        spikeResult: () => SPIKE_RESULT,
        mirroredProfile: () => ({ status: "not-read" }),
        extensionRows: async () => ({ status: "server-not-running" }),
        ...(disabledLists ? { disabledLists } : {}),
      };
      Setting.reset();
      const tab = new WorkbenchSettingTab({} as never, {} as never, host);
      tab.display();
      const el = tab.containerEl as unknown as FakeNode;
      const row = el.all().find((n) => n.cls?.includes("workbench-extensions-row") && n.children[0]?.text === "Disabled in VS Code");
      return { tab, row, text: () => row?.children[1].text };
    }

    it("a host without the method shows not read yet", () => {
      expect(open().text()).toContain("Not read yet");
    });

    it("shows the host's result, and reads it again each time the tab is displayed", () => {
      let result: MirrorResult | null = null;
      const t = open(() => result);
      expect(t.text()).toContain("Not read yet");
      result = read;
      t.tab.display();
      const again = (t.tab.containerEl as unknown as FakeNode).all().find((n) => n.children[0]?.text === "Disabled in VS Code");
      expect(again?.children[1].text).toContain("3 extensions disabled");
    });

    it("a host that throws shows not read yet and leaves the rest drawn", () => {
      const t = open(() => {
        throw new Error("secret detail");
      });
      expect(t.text()).toContain("Not read yet");
      expect(t.text()).not.toContain("secret");
      expect(Setting.all.find((x) => x.name === "Restart server")).toBeDefined();
    });
  });
});
