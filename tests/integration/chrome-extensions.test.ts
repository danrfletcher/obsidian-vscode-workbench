/**
 * Integration (PR-2, GP5 programmatic): with the chrome hiding on, the user's extensions are still mirrored and the workbench is
 * still served. This stands in for tests/integration/golden-path-gp5.test.ts, which the terminal-removal ticket deleted on purpose
 * (tests/unit/removal-fence.test.ts asserts it is gone), so it cannot be run as the spec wrote it.
 *
 * The real plugin starts the fake `code` server (a real process) against a fake desktop VS Code on disk, as
 * tests/integration/shared-extensions.test.ts does. It asserts, from what the server was given: every enabled extension is linked and
 * listed; the Machine settings file carries the hiding settings; and nothing the hiding adds touches an `extensions.*` key or the
 * arguments that start the extension host. HOME and the app-support root are redirected to temp folders.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileSystemAdapter, Notice, Plugin, TFile, WorkspaceLeaf, type MockApp } from "../mocks/obsidian";
import { EXTENSION_DIR_NAME } from "../../src/terminal-host/terminal-at-extension";
import { chromeSettings } from "../../src/chrome-settings";
import { BROWSER_APP_SETTINGS } from "../../src/settings";
import VSCodeWorkbenchPlugin from "../../src/main";
import { PROFILES, vscodeFolderUri, writeUserData } from "../fixtures/make-fake-user-data.mjs";
import { FAKE_CODE, isAlive, tempDir } from "../helpers";
import { stateDb } from "../mirror-tree";

const PLUGIN_DIR = ".obsidian/plugins/vscode-workbench";
const TCL = "chakrounanas.turbo-console-log-3.0.0";
const PY = "ms-python.python-2026.10.0";
const PYLANCE = "ms-python.vscode-pylance-2026.4.1";

let vault: string;
let home: string;
let appSupport: string;
let userRoot: string;
let extDir: string;
let pidFile: string;
let argsFile: string;
let plugin: VSCodeWorkbenchPlugin;

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

beforeEach(() => {
  vault = tempDir();
  home = tempDir();
  appSupport = tempDir();
  pidFile = path.join(tempDir(), "pids");
  argsFile = path.join(tempDir(), "args.json");
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
  writeUserData(userRoot, { associations: { [vscodeFolderUri(vault)]: PROFILES.custom.location } });
  fs.writeFileSync(path.join(userRoot, "User", "profiles", PROFILES.custom.location, "extensions.json"), JSON.stringify([entry("chakrounanas.turbo-console-log", TCL), entry("ms-python.python", PY), entry("ms-python.vscode-pylance", PYLANCE)]));
  stateDb(path.join(userRoot, "User", "globalStorage", "state.vscdb")); // desktop VS Code's disabled list: nothing disabled
});

afterEach(async () => {
  plugin?.onunload();
  await new Promise((r) => setTimeout(r, 300));
  // only the servers this file started: their pids are in this file's own pid file
  const pids = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8").split("\n").filter(Boolean).map(Number) : [];
  for (const pid of pids) if (isAlive(pid)) process.kill(pid, "SIGKILL");
  for (const k of ["FAKE_CODE_NODE", "FAKE_CODE_PIDFILE", "FAKE_CODE_ARGSFILE"]) delete process.env[k];
  Plugin.reset();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function start(): Promise<void> {
  Object.assign(process.env, { FAKE_CODE_NODE: process.execPath, FAKE_CODE_PIDFILE: pidFile, FAKE_CODE_ARGSFILE: argsFile });
  plugin = new VSCodeWorkbenchPlugin(makeApp(vault) as never, { id: "vscode-workbench", dir: PLUGIN_DIR } as never);
  (plugin as unknown as { pluginData: unknown }).pluginData = { codeCliPath: fakeInstall(), serverLicenceAccepted: true, embed: "iframe", userDataFolder: "Code - Insiders" };
  (plugin as unknown as { downloadHostReachable: () => Promise<boolean> }).downloadHostReachable = async () => false;
  await plugin.onload();
  await plugin.ensureServer();
}

describe("GP5: with the chrome hiding on, the extensions are still mirrored and the workbench is still served", () => {
  it("serves the workbench, links and lists every enabled extension, and writes the hiding settings into the Machine file", async () => {
    await start();
    expect(inner().manager.state).toBe("running");
    const serverData = inner().manager.serverInstance!.serverDataDir;

    const target = path.join(serverData, "extensions");
    const shared = (n: string) => n !== "extensions.json" && n !== EXTENSION_DIR_NAME; // the plugin's own terminal-at extension is not a shared one
    expect(fs.readdirSync(target).filter(shared).sort()).toEqual([PYLANCE, PY, TCL].sort());
    const listed = (JSON.parse(fs.readFileSync(path.join(target, "extensions.json"), "utf8")) as Array<{ relativeLocation: string }>).map((e) => e.relativeLocation).filter(shared);
    expect(listed.sort()).toEqual([PYLANCE, PY, TCL].sort());

    // hiding is on in what the same start wrote: the Machine file holds every setting the table names
    const machine = JSON.parse(fs.readFileSync(path.join(serverData, "data", "Machine", "settings.json"), "utf8")) as Record<string, unknown>;
    for (const [k, v] of Object.entries(chromeSettings())) expect(machine[k], k).toEqual(v);
    expect(machine["workbench.statusBar.visible"]).toBe(false);
  });

  it("the hiding adds no extensions.* key to the Machine file and no argument that disables or reconfigures the extension host", async () => {
    await start();
    const serverData = inner().manager.serverInstance!.serverDataDir;
    const machine = JSON.parse(fs.readFileSync(path.join(serverData, "data", "Machine", "settings.json"), "utf8")) as Record<string, unknown>;
    // the extensions.* keys that are there are the update off switches the plugin wrote before the hiding existed, and no others
    expect(Object.keys(machine).filter((k) => /^extensions\./.test(k)).sort()).toEqual(Object.keys(BROWSER_APP_SETTINGS).filter((k) => /^extensions\./.test(k)).sort());
    expect(Object.keys(chromeSettings()).filter((k) => /extension/i.test(k))).toEqual([]);

    const args = JSON.parse(fs.readFileSync(argsFile, "utf8")) as string[];
    expect(args).toContain("--server-data-dir");
    expect(args.filter((a) => /disable-extension|extensions-dir|install-extension|extension-host/i.test(a))).toEqual([]);
  });
});
