/**
 * Integration (PR-6, G12, G13, F9): the mirrored profile's settings and keybindings are what a server start copies,
 * through the real plugin, the real profile lookup, a fake Application Support made by
 * tests/fixtures/make-fake-user-data.mjs (the real filesystem, in a scratch dir) and the fake `code` server
 * (tests/fixtures/fake-serve-web.mjs, real processes). Nothing here touches /Applications or the real
 * Application Support folder: the two roots are redirected per test.
 *
 * The association is changed in `storage.json` between two starts, as desktop VS Code would; the plugin picks it up
 * at Restart server (G2), never live (F7).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileSystemAdapter, Notice, Plugin, Setting, TFile, WorkspaceLeaf, type MockApp } from "../mocks/obsidian";
import VSCodeWorkbenchPlugin, { SPIKE_FILE } from "../../src/main";
import { FAKE_CODE, isAlive, tempDir } from "../helpers";
import { makeApp as makeBundle, makeReadOnly, makeWritable, treeDigest } from "../instance-helpers";
import { PROFILES, TOGGLE_PANEL_KEY, TOGGLE_SIDEBAR_KEY, makeFakeUserData, vscodeFolderUri, writeUserData } from "../fixtures/make-fake-user-data.mjs";

const PLUGIN_DIR = ".obsidian/plugins/obsidian-vscode-workbench";
const HERE = path.dirname(FAKE_CODE);
const DEFAULT = "__default__profile__";

let vault: string;
let apps: string;
let support: string;
let pidFile: string;
let plugin: VSCodeWorkbenchPlugin;

function stubScript(name: string): string {
  return `#!/bin/sh\necho "${name}|$*" >> "$WB_LAUNCH_LOG"\nhere=$(dirname "$0")\nexec "$here/fake-code.sh" "$@"\n`;
}

/** A fake bundle that really serves: the stub plus the fake server files in its bin folder. */
function servingApp(name: string, bundleId: string, version: string, nameShort: string, dataFolder: string): void {
  const appPath = makeBundle(apps, { name, bundleId, version, cli: "code", script: stubScript(name), nameShort, dataFolderName: dataFolder });
  const res = path.join(appPath, "Contents/Resources/app");
  for (const f of ["fake-code.sh", "fake-serve-web.mjs"]) fs.copyFileSync(path.join(HERE, f), path.join(res, "bin", f));
  fs.chmodSync(path.join(res, "bin", "fake-code.sh"), 0o755);
  // A data folder name that does not exist under the home folder, so no real extensions folder is looked at.
  fs.writeFileSync(path.join(res, "product.json"), JSON.stringify({ version, commit: "c0ffee", dataFolderName: `.wb-test-none${dataFolder}`, nameShort, darwinBundleIdentifier: bundleId }));
}

function threeBuilds(): void {
  servingApp("Visual Studio Code.app", "com.microsoft.VSCode", "1.143.1", "Code", ".vscode");
  servingApp("Visual Studio Code - Insiders.app", "com.microsoft.VSCodeInsiders", "1.144.0-insider", "Code - Insiders", ".vscode-insiders");
  servingApp("VSCodium.app", "com.vscodium", "1.143.0", "VSCodium", ".vscodium");
}

function makeAppObj(root: string): MockApp {
  return {
    vault: {
      adapter: new FileSystemAdapter(root),
      configDir: ".obsidian",
      getAbstractFileByPath: (p: string) => (fs.existsSync(path.join(root, p)) ? new TFile(p) : null),
      on: (name: string, cb: (...args: any[]) => void) => ({ name, cb }),
    },
    workspace: {
      onLayoutReady: (cb: () => void) => cb(),
      getActiveFile: () => null,
      getLeavesOfType: () => [] as WorkspaceLeaf[],
      getLeaf: () => new WorkspaceLeaf(),
      revealLeaf: async () => undefined,
      detachLeavesOfType: () => undefined,
      on: (name: string, cb: (...args: unknown[]) => void) => ({ name, cb }),
    },
    openWithDefaultApp: async () => undefined,
  } as unknown as MockApp;
}

async function load(data: Record<string, unknown> = {}): Promise<void> {
  Object.assign(process.env, { FAKE_CODE_NODE: process.execPath, FAKE_CODE_PIDFILE: pidFile, WB_LAUNCH_LOG: path.join(tempDir(), "launches.log") });
  plugin = new VSCodeWorkbenchPlugin(makeAppObj(vault) as never, { id: "obsidian-vscode-workbench", dir: PLUGIN_DIR } as never);
  (plugin as unknown as { pluginData: unknown }).pluginData = { serverLicenceAccepted: true, embed: "iframe", ...data };
  (plugin as unknown as { downloadHostReachable: () => Promise<boolean> }).downloadHostReachable = async () => false;
  await plugin.onload();
}

const inner = () => plugin as unknown as { manager: import("../../src/server-manager").ServerManager };
const serverPids = () => (fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8").split("\n").filter(Boolean).map(Number) : []);
const userDataDir = () => inner().manager.serverInstance!.userDataDir;
const copied = (f: string) => path.join(userDataDir(), "User", f);
const copiedSettings = () => JSON.parse(fs.readFileSync(copied("settings.json"), "utf8")) as Record<string, unknown>;
const trustKeys = (o: Record<string, unknown>) => Object.keys(o).filter((k) => k.startsWith("security.workspace.trust."));

/** Point the vault at `location` in the Insiders folder's storage.json, the way desktop VS Code records it. */
function associate(location: string): void {
  const file = path.join(support, "Code - Insiders", "User", "globalStorage", "storage.json");
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  json.profileAssociations.workspaces[vscodeFolderUri(vault)] = location;
  fs.writeFileSync(file, JSON.stringify(json));
}

beforeEach(() => {
  vault = tempDir();
  fs.mkdirSync(path.join(vault, path.dirname(SPIKE_FILE)), { recursive: true });
  fs.writeFileSync(path.join(vault, SPIKE_FILE), "import os\n");
  apps = path.join(tempDir(), "Applications");
  support = path.join(tempDir(), "Application Support");
  fs.mkdirSync(apps);
  fs.mkdirSync(support);
  pidFile = path.join(tempDir(), "pids");
  process.env.WORKBENCH_SCAN_ROOTS = apps;
  process.env.WORKBENCH_APP_SUPPORT_ROOT = support;
  Plugin.reset();
  Notice.reset();
  Setting.reset();
  vi.stubGlobal("window", { addEventListener: () => undefined });
  vi.stubGlobal("document", { body: { classList: { contains: () => false } } });
});

afterEach(async () => {
  plugin?.onunload();
  await new Promise((r) => setTimeout(r, 300));
  for (const pid of serverPids()) if (isAlive(pid)) process.kill(pid, "SIGKILL");
  for (const k of ["FAKE_CODE_NODE", "FAKE_CODE_PIDFILE", "WB_LAUNCH_LOG"]) delete process.env[k];
  process.env.WORKBENCH_SCAN_ROOTS = "/nonexistent-workbench-scan-root";
  process.env.WORKBENCH_APP_SUPPORT_ROOT = "/nonexistent-workbench-app-support";
  vi.unstubAllGlobals();
});

describe("a server start copies the mirrored profile's settings and keybindings (G13, GP7)", () => {
  it("FDE Practice: its font size and keybinding, not Default's; a restart after moving the association back copies Default's, with nothing of FDE Practice left", async () => {
    threeBuilds();
    makeFakeUserData(support, { associations: { [vscodeFolderUri(vault)]: PROFILES.custom.location }, folders: ["Code - Insiders"] });
    await load();
    await plugin.openSpikeFile();

    const first = plugin.userDataCopy()!;
    expect(copiedSettings()["editor.fontSize"]).toBe(22);
    expect(copiedSettings().fixture).toBe("Code - Insiders FDE Practice");
    expect(first.settings["editor.fontSize"]).toBe(22);
    expect(Buffer.from(first.keybindingsBase64!, "base64").toString("utf8")).toContain(TOGGLE_PANEL_KEY.command);
    expect(fs.readFileSync(copied("keybindings.json"), "utf8")).toContain(TOGGLE_PANEL_KEY.command);
    expect(fs.readFileSync(copied("keybindings.json"), "utf8")).not.toContain(TOGGLE_SIDEBAR_KEY.command);

    associate(DEFAULT);
    await plugin.restartServer();
    const second = plugin.userDataCopy()!;
    expect(second.id).not.toBe(first.id); // a new start is a new copy: a tab reload alone never undoes edits made in the tab
    expect(copiedSettings()["editor.fontSize"]).toBe(14);
    expect(JSON.stringify(second.settings)).not.toContain("FDE Practice");
    expect(second.settings["editor.fontSize"]).toBe(14);
    expect(fs.readFileSync(copied("settings.json"), "utf8")).not.toContain("FDE Practice");
    expect(fs.readFileSync(copied("keybindings.json"), "utf8")).toContain(TOGGLE_SIDEBAR_KEY.command);
    expect(Buffer.from(second.keybindingsBase64!, "base64").toString("utf8")).not.toContain(TOGGLE_PANEL_KEY.command);

    associate(PROFILES.custom.location);
    await plugin.restartServer();
    expect(copiedSettings()["editor.fontSize"]).toBe(22);
  });

  it("no trust key is in the copy, in what the tab is given or in the Machine file, though both fixture settings files carry them", async () => {
    threeBuilds();
    makeFakeUserData(support, { associations: { [vscodeFolderUri(vault)]: PROFILES.custom.location }, folders: ["Code - Insiders"] });
    const profileFile = path.join(support, "Code - Insiders", "User", "profiles", PROFILES.custom.location, "settings.json");
    expect(fs.readFileSync(profileFile, "utf8")).toContain("security.workspace.trust.enabled");
    await load();
    for (const location of [PROFILES.custom.location, DEFAULT]) {
      associate(location);
      if (plugin.userDataCopy()) await plugin.restartServer();
      else await plugin.openSpikeFile();
      expect(trustKeys(copiedSettings())).toEqual([]);
      expect(trustKeys(plugin.userDataCopy()!.settings as Record<string, unknown>)).toEqual([]);
      const machine = fs.readFileSync(path.join(inner().manager.serverInstance!.serverDataDir, "data", "Machine", "settings.json"), "utf8");
      expect(machine).not.toContain("security.workspace.trust");
      // the user's other keys and the plugin's excludes survive
      expect(copiedSettings()).toMatchObject({ "files.watcherExclude": expect.any(Object), "search.exclude": expect.any(Object) });
    }
  });

  it("a profile flagged useDefaultFlags (Agents) copies Default's files", async () => {
    threeBuilds();
    makeFakeUserData(support, { associations: { [vscodeFolderUri(vault)]: PROFILES.agents.location }, folders: ["Code - Insiders"] });
    await load();
    await plugin.openSpikeFile();
    expect(copiedSettings()["editor.fontSize"]).toBe(14);
    expect(copiedSettings().fixture).toBe("Code - Insiders default");
    expect(fs.readFileSync(copied("keybindings.json"), "utf8")).toContain(TOGGLE_SIDEBAR_KEY.command);
  });

  it("a deleted profile (folder gone) falls back to Default's files; the copy is regular files", async () => {
    threeBuilds();
    makeFakeUserData(support, { associations: { [vscodeFolderUri(vault)]: PROFILES.deleted.location }, folders: ["Code - Insiders"] });
    await load();
    await plugin.openSpikeFile();
    expect(copiedSettings()["editor.fontSize"]).toBe(14);
    for (const f of ["settings.json", "keybindings.json"]) expect(fs.lstatSync(copied(f)).isSymbolicLink()).toBe(false);
  });

  it("a profile with no keybindings.json, then with no settings.json: excludes only, no throw, and the old keybindings copy is removed", async () => {
    threeBuilds();
    makeFakeUserData(support, { associations: { [vscodeFolderUri(vault)]: PROFILES.custom.location }, folders: ["Code - Insiders"] });
    await load();
    await plugin.openSpikeFile();
    expect(fs.existsSync(copied("keybindings.json"))).toBe(true);
    const dir = path.join(support, "Code - Insiders", "User", "profiles", PROFILES.custom.location);
    fs.rmSync(path.join(dir, "keybindings.json"));
    await plugin.restartServer();
    expect(fs.existsSync(copied("keybindings.json"))).toBe(false);
    expect(plugin.userDataCopy()!.keybindingsBase64).toBeNull();
    expect(copiedSettings()["editor.fontSize"]).toBe(22);
    fs.rmSync(path.join(dir, "settings.json"));
    await plugin.restartServer();
    expect(Object.keys(copiedSettings()).sort()).toEqual(["files.watcherExclude", "search.exclude"]);
    expect(Notice.messages.filter((m) => /could not copy|could not be read/.test(m))).toEqual([]);
  });

  it("a symlinked profile folder is read by content", async () => {
    threeBuilds();
    makeFakeUserData(support, { associations: { [vscodeFolderUri(vault)]: PROFILES.custom.location }, folders: ["Code - Insiders"] });
    const profiles = path.join(support, "Code - Insiders", "User", "profiles");
    const real = path.join(tempDir(), "real-profile");
    fs.renameSync(path.join(profiles, PROFILES.custom.location), real);
    fs.symlinkSync(real, path.join(profiles, PROFILES.custom.location));
    await load();
    await plugin.openSpikeFile();
    expect(copiedSettings()["editor.fontSize"]).toBe(22);
    expect(fs.lstatSync(copied("settings.json")).isSymbolicLink()).toBe(false);
  });

  it("the copied files are private (0600 in a 0700 folder) and no notice quotes a settings file", async () => {
    threeBuilds();
    makeFakeUserData(support, { associations: { [vscodeFolderUri(vault)]: PROFILES.custom.location }, folders: ["Code - Insiders"] });
    await load();
    await plugin.openSpikeFile();
    expect(fs.statSync(copied("settings.json")).mode & 0o777).toBe(0o600);
    expect(fs.statSync(copied("keybindings.json")).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(userDataDir(), "User")).mode & 0o777).toBe(0o700);
    expect(Notice.messages.join("\n")).not.toMatch(/fontSize|FDE Practice|security\.workspace/);
  });
});

describe("other instances' folders are never modified (F9)", () => {
  /** The folders a start must leave alone, by name under Application Support, plus a configured one elsewhere. */
  const others = [
    ["Code (stable)", () => path.join(support, "Code")],
    ["VSCodium", () => path.join(support, "VSCodium")],
    ["a configured folder", () => path.join(support, "Configured")],
  ] as const;

  it.each(others)("%s: every file hashes the same before and after a start, a profile switch and a restart", async (_name, folder) => {
    threeBuilds();
    makeFakeUserData(support, { associations: { [vscodeFolderUri(vault)]: PROFILES.custom.location }, folders: ["Code", "Code - Insiders", "VSCodium"] });
    writeUserData(path.join(support, "Configured"), { associations: { [vscodeFolderUri(vault)]: PROFILES.custom.location } });
    const insiders = path.join(support, "Code - Insiders");
    const guarded = [folder(), insiders];
    for (const d of guarded) makeReadOnly(d); // any write, rename, delete or chmod in them fails
    const before = guarded.map(treeDigest);
    try {
      await load();
      await plugin.openSpikeFile();
      expect(copiedSettings()["editor.fontSize"]).toBe(22);
      // The chosen instance's own folder, the non-mirrored profiles' folders included, is untouched too (second entry).
      makeWritable(insiders);
      associate(DEFAULT);
      makeReadOnly(insiders);
      const afterAssociationEdit = treeDigest(insiders);
      await plugin.restartServer();
      expect(copiedSettings()["editor.fontSize"]).toBe(14);
      expect(treeDigest(folder())).toBe(before[0]);
      expect(treeDigest(insiders)).toBe(afterAssociationEdit);
      // Non-mirrored profile folders of the chosen instance: byte-identical to the fixture.
      for (const p of [PROFILES.agents.location]) {
        expect(fs.readdirSync(path.join(insiders, "User", "profiles", p)).sort()).toEqual(["extensions.json"]);
      }
    } finally {
      makeWritable(support);
      makeWritable(apps);
    }
  });

  it("the settings copy is not written in the chosen instance's own folder, and the user-data dir is inside the plugin's folder", async () => {
    threeBuilds();
    makeFakeUserData(support, { associations: { [vscodeFolderUri(vault)]: PROFILES.custom.location }, folders: ["Code - Insiders"] });
    const before = treeDigest(path.join(support, "Code - Insiders"));
    await load();
    await plugin.openSpikeFile();
    expect(treeDigest(path.join(support, "Code - Insiders"))).toBe(before);
    expect(userDataDir().startsWith(path.join(vault, PLUGIN_DIR))).toBe(true);
    expect(fs.readdirSync(path.join(userDataDir(), "User")).sort()).toEqual(["keybindings.json", "settings.json"]);
  });
});
