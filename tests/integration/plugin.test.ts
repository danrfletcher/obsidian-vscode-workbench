/**
 * Integration: the plugin class (main.ts) with the mocked `obsidian` module and the
 * fake `code` script: ribbon/command surface (F7), one shared server for two files,
 * Notice on a build without serve-web, and unload leaving nothing behind.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileSystemAdapter, Notice, Plugin, TFile, WorkspaceLeaf, type MockApp } from "../mocks/obsidian";
import VSCodeWorkbenchPlugin, { SPIKE_FILE } from "../../src/main";
import { FAKE_CODE, isAlive, listenersOn, tempDir } from "../helpers";

let vault: string;
let pidFile: string;
let plugin: VSCodeWorkbenchPlugin;
let app: MockApp;

function makeApp(root: string): MockApp {
  const a: MockApp = {
    vault: {
      adapter: new FileSystemAdapter(root),
      configDir: ".obsidian",
      getAbstractFileByPath: (p: string) => (fs.existsSync(path.join(root, p)) ? new TFile(p) : null),
    },
    workspace: {
      activeFile: null,
      leaves: [],
      getActiveFile: () => a.workspace.activeFile,
      getLeaf: () => {
        const l = new WorkspaceLeaf();
        a.workspace.leaves.push(l);
        return l;
      },
      revealLeaf: async () => undefined,
      detachLeavesOfType: () => undefined,
      on: (name, cb) => ({ name, cb }),
    },
  };
  return a;
}

async function load(env: Record<string, string> = {}): Promise<void> {
  Object.assign(process.env, { FAKE_CODE_NODE: process.execPath, FAKE_CODE_PIDFILE: pidFile }, env);
  app = makeApp(vault);
  plugin = new VSCodeWorkbenchPlugin(app as never, { id: "obsidian-vscode-workbench", dir: ".obsidian/plugins/obsidian-vscode-workbench" } as never);
  (plugin as unknown as { pluginData: unknown }).pluginData = { codeCliPath: FAKE_CODE, embed: "iframe" };
  await plugin.onload();
}

const serverPids = () => (fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8").split("\n").filter(Boolean).map(Number) : []);

beforeEach(() => {
  vault = tempDir();
  fs.mkdirSync(path.join(vault, path.dirname(SPIKE_FILE)), { recursive: true });
  fs.writeFileSync(path.join(vault, SPIKE_FILE), "import os\n");
  fs.mkdirSync(path.join(vault, "Mock Exams/scripts"), { recursive: true });
  fs.writeFileSync(path.join(vault, "Mock Exams/scripts/estimaté tïme 文件.py"), "x = 1\n");
  pidFile = path.join(tempDir(), "pids");
  Plugin.reset();
  Notice.reset();
  vi.stubGlobal("window", { addEventListener: () => undefined });
  vi.stubGlobal("document", { body: { classList: { contains: () => false } } });
});

afterEach(async () => {
  plugin?.onunload();
  await new Promise((r) => setTimeout(r, 400));
  for (const pid of serverPids()) if (isAlive(pid)) process.kill(pid, "SIGKILL");
  for (const k of ["FAKE_CODE_NODE", "FAKE_CODE_PIDFILE", "FAKE_CODE_MODE"]) delete process.env[k];
  vi.unstubAllGlobals();
});

describe("surface (F7)", () => {
  it("adds one ribbon icon titled 'Open in VS Code' and one command, nothing else", async () => {
    await load();
    expect(Plugin.ribbon).toEqual([{ icon: "code-2", title: "Open in VS Code" }]);
    expect(Plugin.commands.map((c) => [c.id, c.name])).toEqual([["open-spike-file", "Open spike file in Code tab"]]);
    expect(Plugin.views).toEqual(["vscode-workbench-code"]);
  });
});

describe("opening files", () => {
  it("opens the spike file in a Code tab holding only the vault-relative path", async () => {
    await load();
    await plugin.openSpikeFile();
    expect(app.workspace.leaves).toHaveLength(1);
    expect(app.workspace.leaves[0].viewState).toEqual({ type: "vscode-workbench-code", state: { file: SPIKE_FILE }, active: true });
    expect(JSON.stringify(app.workspace.leaves[0].viewState)).not.toMatch(/tkn|[0-9a-f]{64}/);
  });

  it("opens the active non-ASCII file (E5) and never a markdown note", async () => {
    await load();
    const rel = "Mock Exams/scripts/estimaté tïme 文件.py";
    app.workspace.activeFile = new TFile(rel);
    await plugin.openSpikeFile();
    expect((app.workspace.leaves[0].viewState?.state as { file: string }).file).toBe(rel);

    app.workspace.activeFile = new TFile("note.md");
    await plugin.openSpikeFile();
    expect((app.workspace.leaves[1].viewState?.state as { file: string }).file).toBe(SPIKE_FILE);
  });

  // Obsidian has no view for .py, so such a file is never the active file: the
  // ribbon has to reach it through the data.json `spikeFile` (T13/T15).
  it("ribbon with no openable active file opens data.json spikeFile, non-ASCII included (E5)", async () => {
    await load();
    const rel = "Mock Exams/scripts/estimaté tïme 文件.py";
    (plugin as unknown as { data_: { spikeFile?: string } }).data_.spikeFile = rel;
    app.workspace.activeFile = null;
    await plugin.openSpikeFile();
    expect(app.workspace.leaves[0].viewState).toEqual({ type: "vscode-workbench-code", state: { file: rel }, active: true });
  });

  it("an openable active file wins over spikeFile; a missing spikeFile falls back to the built-in one", async () => {
    await load();
    const data = (plugin as unknown as { data_: { spikeFile?: string } }).data_;
    data.spikeFile = "Mock Exams/scripts/estimaté tïme 文件.py";
    app.workspace.activeFile = new TFile(SPIKE_FILE);
    await plugin.openSpikeFile();
    expect((app.workspace.leaves[0].viewState?.state as { file: string }).file).toBe(SPIKE_FILE);

    app.workspace.activeFile = null;
    data.spikeFile = "does/not/exist.py";
    await plugin.openSpikeFile();
    expect((app.workspace.leaves[1].viewState?.state as { file: string }).file).toBe(SPIKE_FILE);
  });

  it("finds a spikeFile whose name the vault stores in the other Unicode normal form", async () => {
    await load();
    const nfc = "Mock Exams/scripts/estimaté tïme 文件.py".normalize("NFC");
    const nfd = nfc.normalize("NFD");
    expect(nfd).not.toBe(nfc);
    // A vault that only knows the decomposed name, as a strict (non-APFS) lookup would.
    app.vault.getAbstractFileByPath = (p: string) => (p === nfd ? new TFile(nfd) : null);
    (plugin as unknown as { data_: { spikeFile?: string } }).data_.spikeFile = nfc;
    await plugin.openSpikeFile();
    expect((app.workspace.leaves[0].viewState?.state as { file: string }).file).toBe(nfd);
  });

  it("opening a second file reuses the one server (no second process)", async () => {
    await load();
    await plugin.openSpikeFile();
    app.workspace.activeFile = new TFile("Mock Exams/scripts/estimaté tïme 文件.py");
    await plugin.openSpikeFile();
    expect(app.workspace.leaves).toHaveLength(2);
    expect(serverPids()).toHaveLength(1);
  });

  it("shows a Notice and opens no tab when there is nothing to open", async () => {
    await load();
    fs.rmSync(path.join(vault, SPIKE_FILE));
    await plugin.openSpikeFile();
    expect(app.workspace.leaves).toHaveLength(0);
    expect(Notice.messages.join("\n")).toMatch(/open a code file first/);
  });
});

describe("failure", () => {
  it("refuses a build with no serve-web: Notice, no tab, no process, no crash", async () => {
    await load({ FAKE_CODE_MODE: "no-serve-web" });
    await expect(plugin.openSpikeFile()).resolves.toBeUndefined();
    expect(app.workspace.leaves).toHaveLength(0);
    expect(Notice.messages.join("\n")).toMatch(/no "serve-web" command/);
    expect(serverPids()).toEqual([]);
  });

  it("early server exit: Notice has the exit code and stderr, never the token", async () => {
    await load({ FAKE_CODE_MODE: "exit-early" });
    await plugin.openSpikeFile();
    const shown = Notice.messages.join("\n");
    expect(shown).toContain("exited with code 3");
    expect(shown).toContain("address already in use");
    const tokenFile = path.join(vault, ".obsidian/plugins/obsidian-vscode-workbench/.server/connection-token");
    expect(shown).not.toContain(fs.readFileSync(tokenFile, "utf8"));
    expect(app.workspace.leaves).toHaveLength(0);
  });
});

describe("unload", () => {
  it("leaves no code child process and no listener on the port", async () => {
    await load();
    await plugin.openSpikeFile();
    const [serverPid] = serverPids();
    const wrapper = (plugin as unknown as { server: { pid: number; current: { port: number } } }).server;
    const port = wrapper.current.port;
    const wrapperPid = wrapper.pid;
    expect(listenersOn(port).length).toBeGreaterThan(0);
    plugin.onunload();
    await vi.waitFor(() => {
      expect(isAlive(wrapperPid)).toBe(false);
      expect(isAlive(serverPid)).toBe(false);
      expect(listenersOn(port)).toEqual([]);
    }, { timeout: 5000 });
  });

  it("never writes the token anywhere in the vault except the token file itself", async () => {
    await load();
    await plugin.openSpikeFile();
    const pluginDir = path.join(vault, ".obsidian/plugins/obsidian-vscode-workbench");
    const tokenFile = path.join(pluginDir, ".server/connection-token");
    const token = fs.readFileSync(tokenFile, "utf8");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.existsSync(path.join(pluginDir, "data.json"))).toBe(false);
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.isFile() && p !== tokenFile && fs.readFileSync(p, "utf8").includes(token)) hits.push(p);
      }
    };
    walk(vault);
    expect(hits).toEqual([]);
    expect(Notice.messages.join("\n")).not.toContain(token);
  });
});
