/**
 * Integration (PR-7): the Extensions list through the real plugin. The live container checkpoints (GP4, G4, GP6, E4)
 * need a running Obsidian; this runs the same sequence against the real `VSCodeWorkbenchPlugin`: a fake desktop VS Code
 * on disk (a real `state.vscdb` read with the system `sqlite3`, a profile `extensions.json`), the real disabled-list
 * reader, the real start / stop / Restart server, the fake `code` server (real processes, each on a port the plugin
 * picks), and `plugin.extensionRows()` (what the settings tab calls). The one stand-in is the extension host log: the
 * fake server runs no extension host, so each test writes the `remoteexthost.log` a tab load would have produced, in the
 * folder layout the real reader expects. HOME and the app-support root are redirected to temp folders.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileSystemAdapter, Notice, Plugin, TFile, WorkspaceLeaf, type MockApp } from "../mocks/obsidian";
import VSCodeWorkbenchPlugin from "../../src/main";
import type { ExtensionListView, ExtensionRow } from "../../src/settings/extension-states";
import { PROFILES, vscodeFolderUri, writeUserData } from "../fixtures/make-fake-user-data.mjs";
import { FAKE_CODE, isAlive, tempDir } from "../helpers";
import { stateDb } from "../mirror-tree";

const PLUGIN_DIR = ".obsidian/plugins/obsidian-vscode-workbench";
const TCL = "chakrounanas.turbo-console-log-3.2.1";
const PYLANCE = "ms-python.vscode-pylance-2026.4.1";
const CPPTOOLS = "ms-vscode.cpptools-1.22.0";
const TCL_ID = "chakrounanas.turbo-console-log";

let vault: string;
let home: string;
let appSupport: string;
let userRoot: string;
let extDir: string;
let pidFile: string;
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

const setDisabled = (...ids: string[]) => stateDb(path.join(userRoot, "User", "globalStorage", "state.vscdb"), ...(ids.length ? ["--disabled", ids.join(",")] : []));

async function load(): Promise<void> {
  Object.assign(process.env, { FAKE_CODE_NODE: process.execPath, FAKE_CODE_PIDFILE: pidFile });
  plugin = new VSCodeWorkbenchPlugin(makeApp(vault) as never, { id: "obsidian-vscode-workbench", dir: PLUGIN_DIR } as never);
  (plugin as unknown as { pluginData: unknown }).pluginData = { codeCliPath: fakeInstall(), serverLicenceAccepted: true, embed: "iframe", userDataFolder: "Code - Insiders" };
  (plugin as unknown as { downloadHostReachable: () => Promise<boolean> }).downloadHostReachable = async () => false;
  await plugin.onload();
}

const serverDir = () => inner().manager.serverInstance!.serverDataDir;
const sharedLinks = () => fs.readdirSync(path.join(serverDir(), "extensions")).filter((n) => n !== "extensions.json").sort();

/** What the web extension host writes for a Code tab load: one `exthost1` log in a new run folder. */
function writeHostLog(run: string, text: string): void {
  const file = path.join(serverDir(), "data", "logs", run, "exthost1", "remoteexthost.log");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
const activated = (id: string) => `2026-10-28 09:00:02.300 [info] ExtensionService#_doActivateExtension ${id}, startup: false, activationEvent: 'onStartupFinished'\n`;

async function rows(): Promise<ExtensionRow[]> {
  const view: ExtensionListView = await plugin.extensionRows();
  if (view.status !== "listed") throw new Error(`expected a list, got ${view.status}`);
  return view.rows;
}
const row = (list: ExtensionRow[], id: string) => list.find((r) => r.id.toLowerCase() === id.toLowerCase())!;

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
  for (const n of [TCL, PYLANCE, CPPTOOLS]) {
    fs.mkdirSync(path.join(extDir, n), { recursive: true });
    fs.writeFileSync(path.join(extDir, n, "package.json"), JSON.stringify({ name: n.slice(0, n.lastIndexOf("-")).split(".")[1], version: "1.0.0" }));
  }
  writeUserData(userRoot, { associations: { [vscodeFolderUri(vault)]: PROFILES.custom.location } });
  fs.writeFileSync(
    path.join(userRoot, "User", "profiles", PROFILES.custom.location, "extensions.json"),
    JSON.stringify([entry(TCL_ID, TCL), entry("ms-python.vscode-pylance", PYLANCE), entry("ms-vscode.cpptools", CPPTOOLS)]),
  );
  setDisabled();
});

afterEach(async () => {
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

describe("the Extensions list through the real plugin (GP4, G4, GP6, E4, G16)", () => {
  it("GP4: a running server lists every shared extension; the one the tab activated reads active, the others inactive", async () => {
    await load();
    await plugin.ensureServer();
    expect(inner().manager.state).toBe("running");
    writeHostLog("20261028T090000", activated(TCL_ID.replace("chakrounanas.turbo-console-log", "ChakrounAnas.turbo-console-log")));
    const list = await rows();
    expect(list.map((r) => r.id.toLowerCase()).sort()).toEqual([TCL_ID, "ms-python.vscode-pylance", "ms-vscode.cpptools"].sort());
    for (const r of list) expect([r.name, r.id, r.version, r.state, r.reason].every((v) => typeof v === "string" && v !== "")).toBe(true);
    expect(row(list, TCL_ID)).toMatchObject({ state: "active", stateLabel: "active", version: "3.2.1" });
    expect(row(list, "ms-vscode.cpptools").state).toBe("inactive");
  });

  it("G4: after the server stops the section reads server not running, and a log left from the run is not shown", async () => {
    await load();
    await plugin.ensureServer();
    writeHostLog("20261028T090000", activated("ChakrounAnas.turbo-console-log"));
    expect(row(await rows(), TCL_ID).state).toBe("active");
    await inner().manager.stop("idle");
    expect(inner().manager.state).not.toBe("running");
    expect(await plugin.extensionRows()).toEqual({ status: "server-not-running" });
  });

  it("GP6: disabled in desktop VS Code, then Restart server: the server is not given it, its row says disabled in VS Code, and it is not active", async () => {
    await load();
    await plugin.ensureServer();
    writeHostLog("20261028T090000", activated("ChakrounAnas.turbo-console-log"));
    expect(row(await rows(), TCL_ID).state).toBe("active");
    expect(sharedLinks()).toContain(TCL);

    setDisabled(TCL_ID); // Dan switches it off in desktop VS Code
    expect(row(await rows(), TCL_ID).state).toBe("active"); // nothing changes until Restart server (F7)
    await plugin.restartServer();
    expect(inner().manager.state).toBe("running");

    // The tab cannot activate what the server does not have: no link, no entry for it.
    expect(sharedLinks()).not.toContain(TCL);
    const listed = JSON.parse(fs.readFileSync(path.join(serverDir(), "extensions", "extensions.json"), "utf8")) as Array<{ relativeLocation: string }>;
    expect(listed.map((e) => e.relativeLocation)).not.toContain(TCL);
    // A new run, whose tab load activated what it was given (the new server's log has no line for the disabled one).
    writeHostLog("20261028T091000", activated("ms-vscode.cpptools"));
    const list = await rows();
    expect(row(list, TCL_ID)).toMatchObject({ state: "disabled", stateLabel: "disabled in VS Code" });
    expect(row(list, "ms-vscode.cpptools").state).toBe("active");
    expect(list.filter((r) => r.state === "active").map((r) => r.id)).not.toContain(TCL_ID);
  });

  it("GP6, precedence on the real path: an activation line for the disabled extension in the newest log still reads disabled in VS Code", async () => {
    setDisabled(TCL_ID);
    await load();
    await plugin.ensureServer();
    writeHostLog("20261028T090000", activated("ChakrounAnas.turbo-console-log"));
    expect(row(await rows(), TCL_ID).stateLabel).toBe("disabled in VS Code");
  });

  it("G16, E4: Microsoft-only extensions read failed with the log's reason (or the no-reason text); the other rows are unaffected", async () => {
    await load();
    await plugin.ensureServer();
    writeHostLog(
      "20261028T090000",
      activated("ChakrounAnas.turbo-console-log") +
        "2026-10-28 09:00:02.400 [error] Activating extension ms-python.vscode-pylance failed due to an error:\n" +
        "2026-10-28 09:00:02.401 [error] Error: Pylance can only be used with Microsoft's own builds of VS Code.\n" +
        "    at activate (/x/dist/extension.js:1:2345)\n" +
        "2026-10-28 09:00:02.500 [error] ms-vscode.cpptools\n",
    );
    const list = await rows();
    expect(row(list, "ms-python.vscode-pylance")).toMatchObject({ state: "failed", reason: "Error: Pylance can only be used with Microsoft's own builds of VS Code." });
    expect(row(list, "ms-vscode.cpptools")).toMatchObject({ state: "failed", reason: "no reason in the log" });
    expect(row(list, TCL_ID).state).toBe("active");
  });

  it("every open reads the log again: a failure that is gone from the newest run does not survive a re-open", async () => {
    await load();
    await plugin.ensureServer();
    writeHostLog("20261028T090000", "2026-10-28 09:00:02.400 [error] Activating extension ms-python.vscode-pylance failed due to an error:\n2026-10-28 09:00:02.401 [error] Error: first run failure\n");
    expect(row(await rows(), "ms-python.vscode-pylance")).toMatchObject({ state: "failed" });
    writeHostLog("20261028T091000", activated("ms-python.vscode-pylance"));
    expect(row(await rows(), "ms-python.vscode-pylance")).toMatchObject({ state: "active" });
  });
});
