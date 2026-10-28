/**
 * Integration (PR-5): the plugin end to end. A fake desktop VS Code on disk (a real `state.vscdb` read with the system
 * `sqlite3`, a profile with its own `extensions.json`, an extensions folder), the real plugin, the real profile lookup,
 * the real disabled-list reader and the fake `code` server (real processes). It asserts what the server was given:
 * exactly the enabled extensions, rebuilt at each start, read at the first start and at Restart server only.
 * HOME and the app-support root are redirected to temp folders; nothing real is read or written.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileSystemAdapter, Modal, Notice, Plugin, TFile, WorkspaceLeaf, type MockApp } from "../mocks/obsidian";
import VSCodeWorkbenchPlugin from "../../src/main";
import { PROFILES, vscodeFolderUri, writeUserData } from "../fixtures/make-fake-user-data.mjs";
import { FAKE_CODE, isAlive, tempDir } from "../helpers";
import { makeReadOnly, makeWritable, treeDigest } from "../instance-helpers";
import { stateDb } from "../mirror-tree";

const PLUGIN_DIR = ".obsidian/plugins/obsidian-vscode-workbench";
const TCL = "chakrounanas.turbo-console-log-3.0.0";
const PY = "ms-python.python-2026.10.0";
const PYLANCE = "ms-python.vscode-pylance-2026.4.1";

let vault: string;
let home: string;
let appSupport: string;
let userRoot: string;
let extDir: string;
let pidFile: string;
let plugin: VSCodeWorkbenchPlugin;
let guarded: string[] = [];

const inner = () => plugin as unknown as { manager: import("../../src/server-manager").ServerManager };

function makeApp(root: string): MockApp {
  const a = {
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
  };
  return a as unknown as MockApp;
}

/** A copy of the fake `code` laid out like an install, whose product.json points at the redirected `~/.vscode-insiders`. */
function fakeInstall(): string {
  const appDir = path.join(tempDir(), "app");
  fs.mkdirSync(path.join(appDir, "bin"), { recursive: true });
  for (const f of ["fake-code.sh", "fake-serve-web.mjs"]) fs.copyFileSync(path.join(path.dirname(FAKE_CODE), f), path.join(appDir, "bin", f));
  fs.chmodSync(path.join(appDir, "bin/fake-code.sh"), 0o755);
  fs.writeFileSync(path.join(appDir, "product.json"), JSON.stringify({ version: "1.2.0", commit: "b".repeat(40), nameShort: "Code - Insiders", dataFolderName: ".vscode-insiders" }));
  return path.join(appDir, "bin/fake-code.sh");
}

const entry = (id: string, folder: string) => ({
  identifier: { id, uuid: "0479fc1c-3d67-49f9-b087-fb9069afe48f" },
  version: folder.slice(folder.lastIndexOf("-") + 1),
  location: { $mid: 1, path: path.join(extDir, folder), scheme: "file" },
  relativeLocation: folder,
  metadata: { installedTimestamp: 1, pinned: false },
});

const profileListFile = () => path.join(userRoot, "User", "profiles", PROFILES.custom.location, "extensions.json");
const writeProfileList = (entries: unknown[]) => fs.writeFileSync(profileListFile(), JSON.stringify(entries));
const setDisabled = (...ids: string[]) => stateDb(path.join(userRoot, "User", "globalStorage", "state.vscdb"), ...(ids.length ? ["--disabled", ids.join(",")] : []));
const associate = (id: string) => writeUserData(userRoot, { associations: { [vscodeFolderUri(vault)]: id } });

async function load(): Promise<void> {
  Object.assign(process.env, { FAKE_CODE_NODE: process.execPath, FAKE_CODE_PIDFILE: pidFile });
  plugin = new VSCodeWorkbenchPlugin(makeApp(vault) as never, { id: "obsidian-vscode-workbench", dir: PLUGIN_DIR } as never);
  (plugin as unknown as { pluginData: unknown }).pluginData = { codeCliPath: fakeInstall(), serverLicenceAccepted: true, embed: "iframe", userDataFolder: "Code - Insiders" };
  (plugin as unknown as { downloadHostReachable: () => Promise<boolean> }).downloadHostReachable = async () => false;
  await plugin.onload();
}

const target = () => path.join(inner().manager.serverInstance!.serverDataDir, "extensions");
const links = () =>
  fs
    .readdirSync(target())
    .filter((n) => n !== "extensions.json")
    .sort();
const listed = () => (JSON.parse(fs.readFileSync(path.join(target(), "extensions.json"), "utf8")) as Array<{ relativeLocation: string }>).map((e) => e.relativeLocation).sort();
const disabledShown = () => plugin.disabledLists();

beforeEach(() => {
  vault = tempDir();
  home = tempDir();
  appSupport = tempDir();
  pidFile = path.join(tempDir(), "pids");
  Plugin.reset();
  Notice.reset();
  vi.stubGlobal("window", { addEventListener: () => undefined });
  vi.stubGlobal("document", { body: { classList: { contains: () => false } } });
  vi.stubEnv("HOME", home);
  vi.stubEnv("WORKBENCH_APP_SUPPORT_ROOT", appSupport);
  userRoot = path.join(appSupport, "Code - Insiders");
  extDir = path.join(home, ".vscode-insiders", "extensions");
  for (const n of [TCL, PY, PYLANCE]) {
    fs.mkdirSync(path.join(extDir, n), { recursive: true });
    fs.writeFileSync(path.join(extDir, n, "package.json"), "{}");
  }
  associate(PROFILES.custom.location);
  writeProfileList([entry("chakrounanas.turbo-console-log", TCL), entry("ms-python.python", PY), entry("ms-python.vscode-pylance", PYLANCE)]);
  setDisabled();
  guarded = [];
});

afterEach(async () => {
  for (const d of guarded) makeWritable(d);
  plugin?.onunload();
  await new Promise((r) => setTimeout(r, 300));
  // only the servers this file started: their pids are in this file's own pid file
  const pids = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8").split("\n").filter(Boolean).map(Number) : [];
  for (const pid of pids) if (isAlive(pid)) process.kill(pid, "SIGKILL");
  for (const k of ["FAKE_CODE_NODE", "FAKE_CODE_PIDFILE"]) delete process.env[k];
  Plugin.reset();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("the server is given exactly the extensions that are enabled in the mirrored profile (G2, G10)", () => {
  it("a disabled extension is not linked and not in extensions.json; the rest are", async () => {
    setDisabled("Ms-Python.Python");
    await load();
    await plugin.ensureServer();
    expect(inner().manager.state).toBe("running");
    expect(links()).toEqual([PYLANCE, TCL].sort());
    expect(listed()).toEqual([PYLANCE, TCL].sort());
    expect(disabledShown()).toMatchObject({ source: "read", disabled: ["ms-python.python"] });
    for (const n of links()) expect(fs.lstatSync(path.join(target(), n)).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(target(), "extensions.json"), "utf8")).not.toContain(extDir);
  });

  it("an extension installed on the instance but not in the profile's list is not shared", async () => {
    writeProfileList([entry("chakrounanas.turbo-console-log", TCL)]);
    await load();
    await plugin.ensureServer();
    expect(links()).toEqual([TCL]);
  });

  it("Default profile: the list is the instance's own extensions.json", async () => {
    associate("__default__profile__");
    fs.writeFileSync(path.join(extDir, "extensions.json"), JSON.stringify([entry("ms-python.python", PY)]));
    await load();
    await plugin.ensureServer();
    expect(links()).toEqual([PY]);
    expect(listed()).toEqual([PY]);
  });

  it("a profile with no extensions.json shares nothing and the start still runs", async () => {
    fs.rmSync(profileListFile());
    await load();
    await plugin.ensureServer();
    expect(inner().manager.state).toBe("running");
    expect(links()).toEqual([]);
    expect(fs.readFileSync(path.join(target(), "extensions.json"), "utf8")).toBe("[]");
  });

  it("a disabled list that cannot be read and has no snapshot shares nothing; the start still runs", async () => {
    fs.rmSync(path.join(userRoot, "User", "globalStorage", "state.vscdb"));
    await load();
    await plugin.ensureServer();
    expect(inner().manager.state).toBe("running");
    expect(disabledShown()).toMatchObject({ source: "none" });
    expect(links()).toEqual([]);
  });

  it("a disabled list that cannot be read falls back to the last good snapshot, and that list applies", async () => {
    setDisabled("ms-python.python");
    await load();
    await plugin.ensureServer();
    expect(links()).toEqual([PYLANCE, TCL].sort());
    fs.rmSync(path.join(userRoot, "User", "globalStorage", "state.vscdb"));
    await plugin.restartServer();
    expect(disabledShown()).toMatchObject({ source: "snapshot", disabled: ["ms-python.python"] });
    expect(links()).toEqual([PYLANCE, TCL].sort());
  });
});

describe("when desktop VS Code is read (G2, F7)", () => {
  it("only at the first start and at Restart server: an idle restart shares the same set whatever changed in between", async () => {
    setDisabled("ms-python.python");
    await load();
    await plugin.ensureServer();
    expect(links()).toEqual([PYLANCE, TCL].sort());

    // Dan changes things in desktop VS Code while the server runs: nothing happens until a start.
    setDisabled("chakrounanas.turbo-console-log");
    writeProfileList([entry("ms-python.python", PY)]);
    expect(links()).toEqual([PYLANCE, TCL].sort());

    await inner().manager.stop("idle");
    await plugin.ensureServer(); // wakes: a new server from the state it already has
    expect(inner().manager.state).toBe("running");
    expect(links()).toEqual([PYLANCE, TCL].sort());
    expect(listed()).toEqual([PYLANCE, TCL].sort());

    await plugin.restartServer(); // now it reads again
    expect(links()).toEqual([PY]);
    expect(listed()).toEqual([PY]);
    expect(disabledShown()).toMatchObject({ source: "read", disabled: ["chakrounanas.turbo-console-log"] });
  });

  it("an extension uninstalled in desktop VS Code after the start: the link dangles until Restart server, which removes it and its entry", async () => {
    await load();
    await plugin.ensureServer();
    fs.rmSync(path.join(extDir, PY), { recursive: true });
    expect(links()).toContain(PY); // untouched mid-session
    expect(plugin.danglingExtensionLinks()).toEqual([PY]);
    writeProfileList([entry("chakrounanas.turbo-console-log", TCL), entry("ms-python.vscode-pylance", PYLANCE)]);
    await plugin.restartServer();
    expect(links()).toEqual([PYLANCE, TCL].sort());
    expect(listed()).toEqual([PYLANCE, TCL].sort());
    expect(plugin.danglingExtensionLinks()).toEqual([]);
  });
});

describe("the instance and the profile's files are only read (F1)", () => {
  it("a read-only home and app-support tree has identical contents after a start, an idle restart and a Restart server", async () => {
    setDisabled("ms-python.python");
    // a second instance (F9): its own extensions folder and settings must come out unchanged too
    fs.mkdirSync(path.join(home, ".vscode", "extensions", "x.y-1.0.0"), { recursive: true });
    fs.writeFileSync(path.join(home, ".vscode", "extensions", "extensions.json"), "[]");
    fs.mkdirSync(path.join(appSupport, "Code", "User"), { recursive: true });
    fs.writeFileSync(path.join(appSupport, "Code", "User", "settings.json"), '{"other": true}');
    await load();
    guarded = [home, appSupport];
    makeReadOnly(home);
    makeReadOnly(appSupport);
    const before = [treeDigest(home), treeDigest(appSupport)];
    await plugin.ensureServer();
    await inner().manager.stop("idle");
    await plugin.ensureServer();
    await plugin.restartServer();
    expect(inner().manager.state).toBe("running");
    expect(links()).toEqual([PYLANCE, TCL].sort());
    expect([treeDigest(home), treeDigest(appSupport)]).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// E7 and the restart guard: the prompt comes before anything is stopped or touched
// ---------------------------------------------------------------------------

/** A stand-in Code tab with unsaved edits: what main.ts needs from a CodeView. */
function dirtyView() {
  const v = {
    filePath: "a.py",
    leaf: {},
    isVisible: () => false,
    isDirty: async () => true,
    saveBuffers: async () => false,
    notifyVisible: () => undefined,
    settleRename: async () => undefined,
    abandonRename: () => undefined,
    pathTaken: () => undefined,
    reload: () => undefined,
  };
  plugin.trackView(v as never);
  return v;
}

const lastModal = () => Modal.opened[Modal.opened.length - 1] as unknown as { contentEl: { buttons(): Array<{ text: string; click(): void }> }; close(): void };
const serverPids = () => (fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8").split("\n").filter(Boolean).map(Number) : []);
const seenModals = () => Modal.opened.length;

describe("Restart server with unsaved edits (E7)", () => {
  it("the prompt appears while the old server still runs and its links are untouched; cancelling changes nothing, confirming rebuilds", async () => {
    setDisabled("ms-python.python");
    await load();
    await plugin.ensureServer();
    const oldServer = inner().manager.serverInstance!;
    const oldPid = oldServer.pid;
    const pidsBefore = serverPids();
    expect(pidsBefore).toHaveLength(1);
    const dir = target();
    const linkTargetsBefore = links().map((n) => fs.readlinkSync(path.join(dir, n)));
    const jsonBefore = fs.readFileSync(path.join(dir, "extensions.json"), "utf8");
    const shownBefore = disabledShown();
    dirtyView();

    // desktop VS Code changes: a cancelled restart must not read it
    setDisabled("chakrounanas.turbo-console-log");
    const opened = seenModals();
    const cancelled = plugin.restartServer();
    await vi.waitFor(() => expect(seenModals()).toBeGreaterThan(opened), { timeout: 3000, interval: 10 });
    expect(inner().manager.state).toBe("running"); // nothing stopped before the answer
    expect(inner().manager.serverInstance).toBe(oldServer);
    expect(links().map((n) => fs.readlinkSync(path.join(dir, n)))).toEqual(linkTargetsBefore);
    expect(fs.readFileSync(path.join(dir, "extensions.json"), "utf8")).toBe(jsonBefore);
    lastModal().contentEl.buttons().find((b) => b.text === "Cancel")!.click();
    await cancelled;
    expect(inner().manager.serverInstance).toBe(oldServer);
    expect(oldServer.pid).toBe(oldPid);
    expect(serverPids()).toEqual(pidsBefore);
    expect(isAlive(pidsBefore[0])).toBe(true);
    expect(links()).toEqual([PYLANCE, TCL].sort());
    expect(fs.readFileSync(path.join(dir, "extensions.json"), "utf8")).toBe(jsonBefore);
    expect(disabledShown()).toBe(shownBefore); // the Mirror snapshot kept, not read again

    // confirming: the old server stops, and the set is rebuilt from a new read
    const opened2 = seenModals();
    const confirmed = plugin.restartServer();
    await vi.waitFor(() => expect(seenModals()).toBeGreaterThan(opened2), { timeout: 3000, interval: 10 });
    lastModal().contentEl.buttons().find((b) => b.text === "Restart and discard changes")!.click();
    await confirmed;
    expect(inner().manager.state).toBe("running");
    expect(inner().manager.serverInstance).not.toBe(oldServer);
    expect(links()).toEqual([PY, PYLANCE].sort());
    expect(disabledShown()).toMatchObject({ disabled: ["chakrounanas.turbo-console-log"] });
  });

  it("Restart server pressed twice: the second press joins the first, one prompt, one rebuild", async () => {
    await load();
    await plugin.ensureServer();
    const first = inner().manager.serverInstance!;
    dirtyView();
    const opened = seenModals();
    const a = plugin.restartServer();
    const b = plugin.restartServer();
    expect(b).toBe(a);
    await vi.waitFor(() => expect(seenModals()).toBeGreaterThan(opened), { timeout: 3000, interval: 10 });
    lastModal().contentEl.buttons().find((x) => x.text === "Restart and discard changes")!.click();
    await Promise.all([a, b]);
    expect(seenModals()).toBe(opened + 1);
    expect(inner().manager.serverInstance).not.toBe(first);
    expect(serverPids()).toHaveLength(2); // the first start and one restart, nothing else
  });
});
