/**
 * Integration: VS Code instance discovery, the settings tab, and the one-way copy
 * of the chosen instance's settings (PR-3: G15, G16, G17, F3), through the real
 * plugin, the real scan and probe, fake app bundles on disk and the fake `code`
 * server (real processes). Nothing here touches /Applications or the real
 * Application Support folder: the two roots are redirected per test.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileSystemAdapter, Notice, Plugin, Setting, TFile, WorkspaceLeaf, type FakeNode, type MockApp } from "../mocks/obsidian";
import VSCodeWorkbenchPlugin, { SPIKE_FILE } from "../../src/main";
import { FAKE_CODE, isAlive, tempDir } from "../helpers";
import { makeApp as makeBundle, makeReadOnly, makeWritable, treeDigest } from "../instance-helpers";

const PLUGIN_DIR = ".obsidian/plugins/obsidian-vscode-workbench";
const HERE = path.dirname(FAKE_CODE);

let vault: string;
let apps: string;
let support: string;
let pidFile: string;
let launchLog: string;
let plugin: VSCodeWorkbenchPlugin;
let app: MockApp;

/** A CLI that logs every call, then hands it to the fake `code` next to it (which answers `serve-web --help` and serves). */
function stubScript(name: string): string {
  return `#!/bin/sh
echo "${name}|$*" >> "$WB_LAUNCH_LOG"
here=$(dirname "$0")
exec "$here/fake-code.sh" "$@"
`;
}

/** A fake bundle that really serves: the stub plus the fake server files in its bin folder. */
function servingApp(name: string, bundleId: string, version: string, cli = "code", dataFolder = ".vscode", nameShort = "Code"): string {
  const appPath = makeBundle(apps, { name, bundleId, version, cli, script: stubScript(name), nameShort, dataFolderName: dataFolder });
  const res = path.join(appPath, "Contents/Resources/app");
  const bin = path.join(res, "bin");
  for (const f of ["fake-code.sh", "fake-serve-web.mjs"]) fs.copyFileSync(path.join(HERE, f), path.join(bin, f));
  fs.chmodSync(path.join(bin, "fake-code.sh"), 0o755);
  // findNewestBuild reads version and commit from product.json
  // The data folder name decides which `~/<name>/extensions` the plugin looks at: the default is a name that does not exist, so tests never touch a real one.
  fs.writeFileSync(path.join(res, "product.json"), JSON.stringify({ version, commit: "c0ffee", dataFolderName: dataFolder === ".vscode" || dataFolder.startsWith(".vscode-") ? `.wb-test-none${dataFolder}` : dataFolder, nameShort, darwinBundleIdentifier: bundleId }));
  return appPath;
}

const STABLE = "Visual Studio Code.app";
const INSIDERS = "Visual Studio Code - Insiders.app";
const CODIUM = "VSCodium.app";

function bothMicrosoft(): void {
  servingApp(STABLE, "com.microsoft.VSCode", "1.143.1", "code", ".vscode", "Code");
  servingApp(INSIDERS, "com.microsoft.VSCodeInsiders", "1.144.0-insider", "code", ".vscode-insiders", "Code - Insiders");
}

function userDir(folder: string): string {
  const d = path.join(support, folder, "User");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function makeAppObj(root: string): MockApp {
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

async function load(data: Record<string, unknown> | null = {}, env: Record<string, string> = {}): Promise<void> {
  Object.assign(process.env, { FAKE_CODE_NODE: process.execPath, FAKE_CODE_PIDFILE: pidFile, WB_LAUNCH_LOG: launchLog }, env);
  app = makeAppObj(vault);
  plugin = new VSCodeWorkbenchPlugin(app as never, { id: "obsidian-vscode-workbench", dir: PLUGIN_DIR } as never);
  (plugin as unknown as { pluginData: unknown }).pluginData = data === null ? null : { serverLicenceAccepted: true, embed: "iframe", ...data };
  (plugin as unknown as { downloadHostReachable: () => Promise<boolean> }).downloadHostReachable = async () => false;
  await plugin.onload();
}

const inner = () => plugin as unknown as { manager: import("../../src/server-manager").ServerManager; data_: Record<string, unknown>; instances: { started: number } };
const stored = () => (plugin as unknown as { pluginData: Record<string, unknown> }).pluginData;
const launches = () => (fs.existsSync(launchLog) ? fs.readFileSync(launchLog, "utf8").split("\n").filter(Boolean) : []);
const serveLaunches = () => launches().filter((l) => !l.includes("|serve-web --help"));
const serverPids = () => (fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8").split("\n").filter(Boolean).map(Number) : []);

/** Open the settings tab, wait for the scan, return the tab and its text. */
async function openTab() {
  const tab = Plugin.settingTabs[0] as { display(): void; containerEl: FakeNode };
  Setting.reset();
  tab.display();
  await vi.waitFor(() => expect(tab.containerEl.textContent()).not.toContain("Scanning…"), { timeout: 5000, interval: 10 });
  const byName = (n: string) => Setting.all.filter((s) => s.name === n);
  return { tab, text: () => tab.containerEl.textContent(), byName, one: (n: string) => byName(n)[0] };
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
  launchLog = path.join(tempDir(), "launches.log");
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

describe("which instance a Code tab runs on", () => {
  it("with nothing chosen runs the newest VS Code build: Insiders 1.144 over stable 1.143, and loading started nothing", async () => {
    bothMicrosoft();
    await load();
    expect(launches()).toEqual([]); // loading scans nothing and runs nothing
    await plugin.openSpikeFile();
    expect(serveLaunches().map((l) => l.split("|")[0])).toEqual([INSIDERS]);
  });

  it("a saved choice beats the default, and the default is never written to data.json", async () => {
    bothMicrosoft();
    const stableId = (await (async () => {
      await load();
      const scan = await (plugin as unknown as { scanInstances(): Promise<{ instances: Array<{ id: string; label: string }> }> }).scanInstances();
      return scan.instances.find((i) => i.label.startsWith("VS Code 1.143"))!.id;
    })());
    plugin.onunload();
    Plugin.reset();
    await load({ instanceId: stableId });
    await plugin.openSpikeFile();
    expect(serveLaunches().map((l) => l.split("|")[0])).toEqual([STABLE]);
    expect(stored().instanceId).toBe(stableId);
  });

  it("a saved id that no longer works: the default is used, the id stays in data.json, and the tab says so", async () => {
    bothMicrosoft();
    const gone = `vscodium:${path.join(apps, CODIUM)}`;
    await load({ instanceId: gone });
    await plugin.openSpikeFile();
    expect(serveLaunches().map((l) => l.split("|")[0])).toEqual([INSIDERS]);
    expect(inner().data_.instanceId).toBe(gone);
    const t = await openTab();
    expect(t.text()).toMatch(/instance you chose earlier \(VSCodium\) cannot be used: it is no longer installed\. Using VS Code Insiders/);
    expect(stored().instanceId).toBe(gone);
  });

  it("a hand-edited codeCliPath still wins, and the tab says it overrides the choice", async () => {
    bothMicrosoft();
    await load({ codeCliPath: FAKE_CODE });
    await plugin.openSpikeFile();
    expect(launches().some((l) => l.startsWith(INSIDERS))).toBe(false);
    expect(serverPids()).toHaveLength(1);
    const t = await openTab();
    expect(t.text()).toContain("A hand-edited codeCliPath in data.json");
  });

  it("no VS Code build at all: the missing-binary notice, no tab, and the next open retries", async () => {
    await load();
    await plugin.openSpikeFile();
    expect(serverPids()).toHaveLength(0);
    expect(Notice.messages.join("\n")).toMatch(/VS Code/);
    servingApp(INSIDERS, "com.microsoft.VSCodeInsiders", "1.144.0-insider", "code", ".vscode-insiders", "Code - Insiders");
    await plugin.openSpikeFile();
    expect(serverPids()).toHaveLength(1);
  });

  it("the scan runs the probe only: serve-web --help, never a server, and nothing listens", async () => {
    bothMicrosoft();
    await load();
    await openTab();
    const calls = launches();
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c).toMatch(/\|serve-web --help$/);
    expect(serverPids()).toEqual([]);
  });
});

describe("the settings tab", () => {
  it("lists the found builds with the default marked, and Antigravity IDE (ENOENT) is left out", async () => {
    bothMicrosoft();
    servingApp(CODIUM, "com.vscodium", "1.140.0", "codium", ".vscode-oss", "VSCodium");
    makeBundle(apps, {
      name: "Antigravity IDE.app",
      bundleId: "com.google.antigravity-ide",
      version: "1.3.0",
      cli: "antigravity-ide",
      script: `#!/bin/sh\nexec "$(dirname "$0")/antigravity-tunnel" "$@"\n`,
    });
    await load();
    const t = await openTab();
    const dd = t.one("VS Code instance").dropdown!;
    expect(dd.options.map((o) => o.label)).toEqual(["VS Code 1.143.1", "VS Code Insiders 1.144.0-insider (default)", "VSCodium 1.140.0"]);
    expect(dd.value).toBe(dd.options[1].value);
    expect(t.one("VS Code instance").desc).toContain("Contents/Resources/app/bin/code");
  });

  it("choosing a build saves it to data.json at once and does not restart a running server", async () => {
    bothMicrosoft();
    await load();
    await plugin.openSpikeFile();
    const pidsBefore = serverPids();
    const t = await openTab();
    const dd = t.one("VS Code instance").dropdown!;
    const stable = dd.options.find((o) => o.label === "VS Code 1.143.1")!;
    await dd.handler!(stable.value);
    expect(stored().instanceId).toBe(stable.value);
    expect(serverPids()).toEqual(pidsBefore);
    expect(isAlive(pidsBefore[0])).toBe(true);
    expect(t.text()).toContain("applies the next time the server starts");
    // the next start (restart) uses the new choice
    await plugin.restartServer();
    expect(serveLaunches().map((l) => l.split("|")[0])).toEqual([INSIDERS, STABLE]);
  });

  it("says plainly when no build with serve-web is found", async () => {
    makeBundle(apps, { name: "Visual Studio Code.app", bundleId: "com.microsoft.VSCode", version: "1.143.1", cli: "code", script: "#!/bin/sh\necho no >&2\nexit 1\n" });
    await load();
    const t = await openTab();
    expect(t.text()).toContain("No VS Code build with serve-web found");
    expect(t.one("VS Code instance").dropdown).toBeNull();
  });

  it("warns that a non-Microsoft build may refuse Microsoft-only extensions, and not for VS Code", async () => {
    servingApp(CODIUM, "com.vscodium", "1.140.0", "codium", ".vscode-oss", "VSCodium");
    await load();
    expect((await openTab()).text()).toMatch(/VSCodium 1\.140\.0 is not a Microsoft build: Microsoft-only extensions/);
    plugin.onunload();
    Plugin.reset();
    fs.rmSync(path.join(apps, CODIUM), { recursive: true });
    bothMicrosoft();
    await load();
    expect((await openTab()).text()).not.toContain("not a Microsoft build");
  });

  it("opening the tab again and again shares one scan, then scans afresh each time it is closed and reopened", async () => {
    bothMicrosoft();
    await load();
    const tab = Plugin.settingTabs[0] as { display(): void; containerEl: FakeNode };
    Setting.reset();
    tab.display();
    tab.display();
    tab.display();
    expect(inner().instances.started).toBe(1);
    await vi.waitFor(() => expect(tab.containerEl.textContent()).not.toContain("Scanning…"), { timeout: 5000, interval: 10 });
    expect(Setting.all.filter((s) => s.name === "VS Code instance")).toHaveLength(1); // the stale displays drew nothing
    tab.display();
    expect(inner().instances.started).toBe(2);
    await vi.waitFor(() => expect(tab.containerEl.textContent()).not.toContain("Scanning…"), { timeout: 5000, interval: 10 });
  });

  it("a slow scan shows Scanning… first and the tab's other settings are usable meanwhile", async () => {
    bothMicrosoft();
    await load();
    const tab = Plugin.settingTabs[0] as { display(): void; containerEl: FakeNode };
    Setting.reset();
    tab.display();
    expect(tab.containerEl.textContent()).toContain("Scanning…");
    expect(Setting.all.map((s) => s.name)).toEqual(expect.arrayContaining(["Excluded file extensions", "Terminal drawer over non-code views", "Shell", "Restart server"]));
    await vi.waitFor(() => expect(tab.containerEl.textContent()).not.toContain("Scanning…"), { timeout: 5000, interval: 10 });
  });

  describe("custom CLI path", () => {
    const customCli = (content = stubScript("custom")) => {
      const dir = tempDir();
      for (const f of ["fake-code.sh", "fake-serve-web.mjs"]) fs.copyFileSync(path.join(HERE, f), path.join(dir, f));
      fs.chmodSync(path.join(dir, "fake-code.sh"), 0o755);
      const f = path.join(dir, "my code");
      fs.writeFileSync(f, content, { mode: 0o755 });
      return f;
    };

    it("a bad path shows the reason and saves nothing; a good one is saved and listed as Custom", async () => {
      bothMicrosoft();
      await load();
      let t = await openTab();
      const field = t.one("Custom CLI path");
      field.text!.handler!("relative/code");
      await field.button!.handler!();
      expect(t.text()).toContain("absolute path");
      expect(stored().customCliPath ?? null).toBeNull();

      const good = customCli();
      field.text!.handler!(good);
      await field.button!.handler!();
      await vi.waitFor(() => expect(stored().customCliPath).toBe(good));
      t = { ...t, ...(await (async () => {
        await vi.waitFor(() => expect(Setting.all.some((s) => s.dropdown?.options.some((o) => o.value === "custom"))).toBe(true), { timeout: 5000 });
        return {};
      })()) };
      const dd = Setting.all.filter((s) => s.name === "VS Code instance").pop()!.dropdown!;
      expect(dd.options.map((o) => o.label)).toContain("Custom");
      await dd.handler!("custom");
      expect(stored().instanceId).toBe("custom");
      await plugin.openSpikeFile();
      expect(serveLaunches().map((l) => l.split("|")[0])).toEqual(["custom"]);
    });

    it("a program that fails the serve-web check is rejected with the reason and not saved", async () => {
      await load();
      const t = await openTab();
      const field = t.one("Custom CLI path");
      field.text!.handler!(customCli("#!/bin/sh\necho 'no serve-web here' >&2\nexit 3\n"));
      await field.button!.handler!();
      expect(t.text()).toMatch(/exited with code 3/);
      expect(stored().customCliPath ?? null).toBeNull();
    });

    it("a saved custom path that vanished is reported when the tab opens, and left in data.json", async () => {
      bothMicrosoft();
      const gone = path.join(tempDir(), "gone");
      await load({ customCliPath: gone });
      const t = await openTab();
      expect(t.text()).toContain("The saved custom CLI cannot be used now");
      expect(stored().customCliPath).toBe(gone);
    });
  });

  describe("exclude list, drawer toggle and shell", () => {
    it("adds an extension normalised, de-duplicates it, rejects bad input and removes it again", async () => {
      await load();
      let t = await openTab();
      const add = async (v: string) => {
        const f = Setting.all.find((s) => s.name === "Excluded file extensions")!;
        f.text!.handler!(v);
        await f.button!.handler!();
      };
      await add(".PY");
      expect(stored().excludeExtensions).toEqual(["py"]);
      await add("py");
      expect(stored().excludeExtensions).toEqual(["py"]);
      await add("a b");
      expect(stored().excludeExtensions).toEqual(["py"]);
      expect(Setting.all.some((s) => s.name === "py")).toBe(true);
      await add("md");
      expect(stored().excludeExtensions).toEqual(["py", "md"]);
      const remove = Setting.all.filter((s) => s.name === "py").pop()!;
      await remove.button!.handler!();
      expect(stored().excludeExtensions).toEqual(["md"]);
      t = await openTab();
      expect(Setting.all.filter((s) => s.name === "md")).toHaveLength(1);
    });

    it("the drawer toggle defaults on, saves false, and survives a reload; the shell saves and defaults to $SHELL", async () => {
      await load({});
      let t = await openTab();
      const toggle = t.one("Terminal drawer over non-code views").toggle!;
      expect(toggle.value).toBe(true);
      toggle.handler!(false);
      const shell = t.one("Shell");
      expect(shell.text!.placeholder).toBe(process.env.SHELL && path.isAbsolute(process.env.SHELL) ? process.env.SHELL : "/bin/zsh");
      shell.text!.handler!(" /bin/bash ");
      await vi.waitFor(() => expect(stored()).toMatchObject({ nonCodeDrawer: false, shellPath: "/bin/bash" }));
      const saved = { ...stored() };
      plugin.onunload();
      Plugin.reset();
      await load(saved);
      t = await openTab();
      expect(t.one("Terminal drawer over non-code views").toggle!.value).toBe(false);
      expect(t.one("Shell").text!.value).toBe("/bin/bash");
    });

    it("saving a setting keeps the unknown fields already in data.json (the licence flag)", async () => {
      await load({ serverLicenceAccepted: true, somethingElse: { a: 1 } });
      const t = await openTab();
      t.one("Terminal drawer over non-code views").toggle!.handler!(false);
      await vi.waitFor(() => expect(stored().nonCodeDrawer).toBe(false));
      expect(stored()).toMatchObject({ serverLicenceAccepted: true, somethingElse: { a: 1 } });
    });
  });

  describe("a corrupt, partial or missing data.json", () => {
    it.each([
      ["missing (null)", null],
      ["empty", {}],
      ["wrong types", { instanceId: 5, excludeExtensions: "py", nonCodeDrawer: "no", shellPath: false, customCliPath: {} }],
    ])("%s: the plugin loads and the tab opens with defaults", async (_n, data) => {
      bothMicrosoft();
      await load(data as Record<string, unknown> | null);
      const t = await openTab();
      expect(t.one("Terminal drawer over non-code views").toggle!.value).toBe(true);
      expect(t.one("Shell").text!.value).toBe("");
      expect(t.one("VS Code instance").dropdown!.value).toMatch(/^vscode-insiders:/);
    });

    it("an unreadable data.json (loadData throws) still loads the plugin with defaults", async () => {
      bothMicrosoft();
      Object.assign(process.env, { FAKE_CODE_NODE: process.execPath, FAKE_CODE_PIDFILE: pidFile, WB_LAUNCH_LOG: launchLog });
      app = makeAppObj(vault);
      plugin = new VSCodeWorkbenchPlugin(app as never, { id: "obsidian-vscode-workbench", dir: PLUGIN_DIR } as never);
      plugin.loadData = async () => {
        throw new Error("Unexpected token in JSON");
      };
      await plugin.onload();
      const t = await openTab();
      expect(t.one("VS Code instance").dropdown).not.toBeNull();
    });
  });
});

describe("the copy of the instance's settings (G16, G17)", () => {
  const SETTINGS = '{\n  // font\n  "editor.fontSize": 15,\n  "python.analysis.typeCheckingMode": "basic",\n}\n';
  const KEYS = '[\n  { "key": "cmd+k cmd+t", "command": "workbench.action.selectTheme" },\n]\n';

  const userDataDir = () => inner().manager.serverInstance!.userDataDir;
  const read = (f: string) => fs.readFileSync(path.join(userDataDir(), "User", f), "utf8");

  it("each start copies the chosen instance's settings and keybindings into the plugin's user-data dir, with the excludes on top", async () => {
    bothMicrosoft();
    const u = userDir("Code - Insiders");
    fs.writeFileSync(path.join(u, "settings.json"), SETTINGS);
    fs.writeFileSync(path.join(u, "keybindings.json"), KEYS);
    await load();
    await plugin.openSpikeFile();
    const copied = JSON.parse(read("settings.json")) as Record<string, unknown>;
    expect(copied).toMatchObject({ "editor.fontSize": 15, "python.analysis.typeCheckingMode": "basic" });
    for (const key of ["files.watcherExclude", "search.exclude"]) {
      expect(copied[key]).toEqual({ "**/.git": true, "**/.obsidian": true, "**/Attachments": true, "**/node_modules": true, "**/_to_delete": true });
    }
    expect(read("keybindings.json")).toBe(KEYS);
    expect(userDataDir().startsWith(path.join(vault, PLUGIN_DIR))).toBe(true);
    expect(Notice.messages.filter((m) => /settings/i.test(m))).toEqual([]);
  });

  it("the same copy is what the Code tab seeds into the browser profile, and the excludes are in the Machine file the server reads", async () => {
    bothMicrosoft();
    const u = userDir("Code - Insiders");
    fs.writeFileSync(path.join(u, "settings.json"), SETTINGS);
    fs.writeFileSync(path.join(u, "keybindings.json"), KEYS);
    await load();
    expect(plugin.userDataCopy()).toBeNull(); // nothing before a server has started
    await plugin.openSpikeFile();
    const copy = plugin.userDataCopy()!;
    expect(copy.settings).toEqual(JSON.parse(read("settings.json")));
    expect(copy.settings).toMatchObject({ "editor.fontSize": 15 });
    expect(Buffer.from(copy.keybindingsBase64!, "base64").toString("utf8")).toBe(KEYS);
    const firstId = copy.id;
    const machine = JSON.parse(fs.readFileSync(path.join(inner().manager.serverInstance!.serverDataDir, "data", "Machine", "settings.json"), "utf8"));
    for (const key of ["files.watcherExclude", "search.exclude"]) expect(machine[key]).toMatchObject({ "**/.obsidian": true, "**/Attachments": true });
    await plugin.restartServer();
    expect(plugin.userDataCopy()!.id).not.toBe(firstId); // a new start is a new copy, applied again
  });

  it("a copy of the instance that is not the default: the stable build's folder, not Insiders'", async () => {
    bothMicrosoft();
    fs.writeFileSync(path.join(userDir("Code - Insiders"), "settings.json"), '{"from": "insiders"}');
    fs.writeFileSync(path.join(userDir("Code"), "settings.json"), '{"from": "stable"}');
    await load();
    const scan = await (plugin as unknown as { scanInstances(): Promise<{ instances: Array<{ id: string; label: string }> }> }).scanInstances();
    await (plugin as unknown as { updateSettings(p: object): Promise<void> }).updateSettings({ instanceId: scan.instances.find((i) => i.label.startsWith("VS Code 1.143"))!.id });
    await plugin.openSpikeFile();
    expect(JSON.parse(read("settings.json")).from).toBe("stable");
  });

  it("the instance's own folders and files are not touched: read-only sources copy fine and their digest is unchanged (F3)", async () => {
    bothMicrosoft();
    const u = userDir("Code - Insiders");
    fs.writeFileSync(path.join(u, "settings.json"), SETTINGS);
    fs.writeFileSync(path.join(u, "keybindings.json"), KEYS);
    const dataFolder = path.join(support, "Code - Insiders");
    makeReadOnly(support);
    makeReadOnly(apps);
    const apps0 = treeDigest(apps); // contents, modes and names: any write, rename, delete or chmod changes it
    const data0 = treeDigest(support);
    try {
      await load();
      await plugin.openSpikeFile();
      await plugin.restartServer();
      expect(JSON.parse(read("settings.json"))["editor.fontSize"]).toBe(15);
      expect(treeDigest(support)).toBe(data0);
      expect(treeDigest(apps)).toBe(apps0);
      expect(fs.readdirSync(dataFolder)).toEqual(["User"]);
    } finally {
      makeWritable(support);
      makeWritable(apps);
    }
  });

  it("an edit made inside the embed to the copy is replaced at the next start, and the source never sees it", async () => {
    bothMicrosoft();
    const u = userDir("Code - Insiders");
    fs.writeFileSync(path.join(u, "settings.json"), '{"editor.fontSize": 15}');
    await load();
    await plugin.openSpikeFile();
    fs.writeFileSync(path.join(userDataDir(), "User", "settings.json"), '{"editor.fontSize": 99}');
    await plugin.restartServer();
    expect(JSON.parse(read("settings.json"))["editor.fontSize"]).toBe(15);
    expect(fs.readFileSync(path.join(u, "settings.json"), "utf8")).toBe('{"editor.fontSize": 15}');
  });

  it("an instance with no settings folder starts fine with the excludes only", async () => {
    bothMicrosoft();
    await load();
    await plugin.openSpikeFile();
    expect(serverPids()).toHaveLength(1);
    expect(Object.keys(JSON.parse(read("settings.json"))).sort()).toEqual(["files.watcherExclude", "search.exclude"]);
    expect(fs.existsSync(path.join(userDataDir(), "User", "keybindings.json"))).toBe(false);
  });

  it("an invalid settings.json: the server still starts, with a notice that quotes nothing from the file", async () => {
    bothMicrosoft();
    fs.writeFileSync(path.join(userDir("Code - Insiders"), "settings.json"), '{"github.token": "ghp_s3cret" oops');
    await load();
    await plugin.openSpikeFile();
    expect(serverPids()).toHaveLength(1);
    const notice = Notice.messages.find((m) => /could not be read/.test(m));
    expect(notice).toBeDefined();
    expect(Notice.messages.join("\n")).not.toContain("ghp_s3cret");
    expect(read("settings.json")).not.toContain("ghp_s3cret");
  });

  it("the copied files are private to the user (0600 in a 0700 folder)", async () => {
    bothMicrosoft();
    fs.writeFileSync(path.join(userDir("Code - Insiders"), "settings.json"), '{"a": 1}');
    await load();
    await plugin.openSpikeFile();
    expect(fs.statSync(path.join(userDataDir(), "User", "settings.json")).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(userDataDir(), "User")).mode & 0o777).toBe(0o700);
  });

  it("nothing is created in the vault outside the plugin folder", async () => {
    bothMicrosoft();
    fs.writeFileSync(path.join(userDir("Code - Insiders"), "settings.json"), '{"a": 1}');
    const before = fs.readdirSync(vault).filter((n) => n !== ".obsidian").sort();
    await load();
    await plugin.openSpikeFile();
    expect(fs.readdirSync(vault).filter((n) => n !== ".obsidian").sort()).toEqual(before);
    expect(fs.existsSync(path.join(vault, PLUGIN_DIR, ".server"))).toBe(true);
  });
});

describe("extensions of other instances are never combined (F3)", () => {
  const oldHome = process.env.HOME;
  afterEach(() => {
    process.env.HOME = oldHome;
  });

  it("switching instance replaces the shared extension links: only the chosen instance's extensions are visible, and neither folder is touched", async () => {
    const home = tempDir();
    process.env.HOME = home; // os.homedir() reads it: `~/<dataFolderName>/extensions` is under this temp home
    for (const [dir, ext] of [
      [".ext-a", "alpha.one-1.0.0"],
      [".ext-b", "beta.two-2.0.0"],
    ]) {
      fs.mkdirSync(path.join(home, dir, "extensions", ext), { recursive: true });
      fs.writeFileSync(path.join(home, dir, "extensions", ext, "package.json"), "{}");
    }
    servingApp(STABLE, "com.microsoft.VSCode", "1.143.1", "code", ".ext-a", "Code");
    servingApp(INSIDERS, "com.microsoft.VSCodeInsiders", "1.144.0-insider", "code", ".ext-b", "Code - Insiders");
    const digestA = treeDigest(path.join(home, ".ext-a"));
    const digestB = treeDigest(path.join(home, ".ext-b"));
    await load();
    const shared = () => fs.readdirSync(path.join(inner().manager.serverInstance!.serverDataDir, "extensions")).sort();

    await plugin.openSpikeFile(); // default: Insiders, so .ext-b
    expect(shared()).toEqual(["beta.two-2.0.0"]);

    const scan = await (plugin as unknown as { scanInstances(): Promise<{ instances: Array<{ id: string; label: string }> }> }).scanInstances();
    await (plugin as unknown as { updateSettings(p: object): Promise<void> }).updateSettings({ instanceId: scan.instances.find((i) => i.label.startsWith("VS Code 1.143"))!.id });
    await plugin.restartServer();
    expect(shared()).toEqual(["alpha.one-1.0.0"]); // B's link is gone, A's is the only one

    expect(treeDigest(path.join(home, ".ext-a"))).toBe(digestA);
    expect(treeDigest(path.join(home, ".ext-b"))).toBe(digestB);
  });

  it("the scan, choose and copy code never mention an extensions folder", () => {
    for (const f of ["src/instances/scan.ts", "src/instances/probe.ts", "src/instances/choose.ts", "src/instances/service.ts", "src/server/user-data-seed.ts"]) {
      const code = fs
        .readFileSync(path.join(path.resolve(__dirname, "../.."), f), "utf8")
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join("\n");
      expect(code, f).not.toMatch(/extensions/i);
    }
  });
});
