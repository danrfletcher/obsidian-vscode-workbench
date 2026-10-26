/**
 * Integration: the plugin's server lifecycle end to end, with the mocked
 * `obsidian` module, the real modals and the fake `code` script (real
 * processes): the first-open licence modal, decline and Escape, nothing running
 * or downloading before accept, idle stop with and without unsaved buffers, quit
 * with unsaved buffers, restart, and the offline re-download offer.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileSystemAdapter, Modal, Notice, Plugin, Tasks, TFile, WorkspaceLeaf, FakeNode, type MockApp } from "../mocks/obsidian";
import VSCodeWorkbenchPlugin, { SPIKE_FILE } from "../../src/main";
import { CodeView } from "../../src/code-view";
import { IDLE_MS } from "../../src/idle-timer";
import { FAKE_CODE, isAlive, listenersOn, tempDir } from "../helpers";

let vault: string;
let pidFile: string;
let argsFile: string;
let plugin: VSCodeWorkbenchPlugin;
let app: MockApp & { openedWithDefault: string[]; openWithDefaultApp: (p: string) => Promise<void> };
let windowListeners: Record<string, Array<(e?: unknown) => void>>;
/** What the download-host reachability check answers: false = the network is down. */
let networkUp = false;
const strays: number[] = [];

const DOWNLOADING = "VS Code Workbench: downloading the VS Code server. The first run needs internet and can take a minute.";
const PLUGIN_DIR = ".obsidian/plugins/obsidian-vscode-workbench";

/** A copy of the fake `code` laid out like an install (app/bin/code next to app/product.json), so the build has a version and a commit. */
function fakeInstall(version: string, commit: string): string {
  const app = path.join(tempDir(), "app");
  fs.mkdirSync(path.join(app, "bin"), { recursive: true });
  for (const f of ["fake-code.sh", "fake-serve-web.mjs"]) fs.copyFileSync(path.join(path.dirname(FAKE_CODE), f), path.join(app, "bin", f));
  fs.chmodSync(path.join(app, "bin/fake-code.sh"), 0o755);
  fs.writeFileSync(path.join(app, "product.json"), JSON.stringify({ version, commit }));
  return path.join(app, "bin/fake-code.sh");
}

function makeApp(root: string): typeof app {
  const a = {
    openedWithDefault: [] as string[],
    openWithDefaultApp: async (p: string) => void a.openedWithDefault.push(p),
    vault: {
      adapter: new FileSystemAdapter(root),
      configDir: ".obsidian",
      getAbstractFileByPath: (p: string) => (fs.existsSync(path.join(root, p)) ? new TFile(p) : null),
    },
    workspace: {
      activeFile: null as TFile | null,
      leaves: [] as WorkspaceLeaf[],
      getActiveFile: () => a.workspace.activeFile,
      getLeaf: () => {
        const l = new WorkspaceLeaf();
        a.workspace.leaves.push(l);
        return l;
      },
      revealLeaf: async () => undefined,
      detachLeavesOfType: () => undefined,
      on: (name: string, cb: (...args: unknown[]) => void) => ({ name, cb }),
    },
  };
  return a as unknown as typeof app;
}

async function load(env: Record<string, string> = {}, data: Record<string, unknown> = {}): Promise<void> {
  Object.assign(process.env, { FAKE_CODE_NODE: process.execPath, FAKE_CODE_PIDFILE: pidFile, FAKE_CODE_ARGSFILE: argsFile }, env);
  app = makeApp(vault);
  plugin = new VSCodeWorkbenchPlugin(app as never, { id: "obsidian-vscode-workbench", dir: PLUGIN_DIR } as never);
  (plugin as unknown as { pluginData: unknown }).pluginData = { codeCliPath: FAKE_CODE, embed: "iframe", ...data };
  (plugin as unknown as { downloadHostReachable: () => Promise<boolean> }).downloadHostReachable = async () => networkUp;
  await plugin.onload();
}

const serverPids = () => (fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8").split("\n").filter(Boolean).map(Number) : []);
const lastModal = () => Modal.opened[Modal.opened.length - 1] as unknown as { contentEl: FakeNode; close(): void };
const press = (label: string) => {
  const b = lastModal().contentEl.buttons().find((n) => n.text === label);
  if (!b) throw new Error(`no button "${label}" in: ${lastModal().contentEl.buttons().map((x) => x.text)}`);
  b.click();
};
const event = (name: string) => Plugin.events.filter((e) => e.name === name);
const inner = () => plugin as unknown as { manager: import("../../src/server-manager").ServerManager; views: Set<unknown>; idle: import("../../src/idle-timer").IdleTimer; data_: Record<string, unknown> };

/** A stand-in Code tab: what main.ts needs from a CodeView. */
function fakeView(o: { file?: string; visible?: boolean; dirty?: boolean; saves?: boolean } = {}) {
  const v = {
    filePath: o.file ?? "a.py",
    visible: o.visible ?? false,
    dirty: o.dirty ?? false,
    saved: 0,
    isVisible: () => v.visible,
    isDirty: async () => v.dirty,
    saveBuffers: async () => {
      v.saved++;
      if (o.saves !== false) v.dirty = false;
      return o.saves !== false;
    },
    notifyVisible: () => undefined,
    reload: () => undefined,
  };
  plugin.trackView(v as never);
  return v;
}

/** Wait for the open modal, then run `then` (a button press). */
let handledModals = 0;
async function onModal(then: () => void): Promise<void> {
  await vi.waitFor(() => expect(Modal.opened.length).toBeGreaterThan(handledModals), { timeout: 3000, interval: 10 });
  handledModals++;
  then();
}

beforeEach(() => {
  vault = tempDir();
  fs.mkdirSync(path.join(vault, path.dirname(SPIKE_FILE)), { recursive: true });
  fs.writeFileSync(path.join(vault, SPIKE_FILE), "import os\n");
  pidFile = path.join(tempDir(), "pids");
  argsFile = path.join(tempDir(), "args.json");
  Plugin.reset();
  Notice.reset();
  Modal.reset();
  handledModals = 0;
  windowListeners = {};
  networkUp = false;
  vi.stubGlobal("window", { addEventListener: (n: string, cb: (e?: unknown) => void) => (windowListeners[n] ??= []).push(cb) });
  vi.stubGlobal("document", { body: { classList: { contains: () => false } } });
});

afterEach(async () => {
  vi.useRealTimers();
  plugin?.onunload();
  await new Promise((r) => setTimeout(r, 400));
  for (const pid of [...serverPids(), ...strays.splice(0)]) if (isAlive(pid)) process.kill(pid, "SIGKILL");
  for (const k of ["FAKE_CODE_NODE", "FAKE_CODE_PIDFILE", "FAKE_CODE_ARGSFILE", "FAKE_CODE_MODE", "FAKE_CODE_PARTIAL_DIR", "FAKE_CODE_OFFLINE_EXCEPT"]) delete process.env[k];
  vi.unstubAllGlobals();
});

describe("licence flow at the first Code-tab open", () => {
  it("starts nothing at load: no process, no port, no download, no modal (G13)", async () => {
    await load();
    expect(serverPids()).toEqual([]);
    expect(fs.existsSync(argsFile)).toBe(false);
    expect(Modal.opened).toHaveLength(0);
    expect(inner().manager.state).toBe("stopped");
  });

  it("the first open shows the licence modal and downloads nothing until Accept", async () => {
    await load();
    const opening = plugin.openSpikeFile();
    await vi.waitFor(() => expect(Modal.opened).toHaveLength(1));
    expect(lastModal().contentEl.textContent()).toContain("https://aka.ms/vscode-server-license");
    // the modal is up: no process was spawned, no download started, no tab exists
    await new Promise((r) => setTimeout(r, 200));
    expect(fs.existsSync(argsFile)).toBe(false);
    expect(serverPids()).toEqual([]);
    expect(app.workspace.leaves).toHaveLength(0);
    expect(inner().manager.state).toBe("stopped");

    press("Accept and download");
    await opening;
    expect(app.workspace.leaves).toHaveLength(1);
    expect(serverPids()).toHaveLength(1);
    const args = JSON.parse(fs.readFileSync(argsFile, "utf8")) as string[];
    expect(args).toContain("--accept-server-license-terms"); // passed only after the user accepted
  });

  it("after Accept the download progress notice shows once, and a later open from the cache does not show it again", async () => {
    await load();
    const opening = plugin.openSpikeFile();
    await onModal(() => press("Accept and download"));
    await opening;
    expect(Notice.messages).toEqual([DOWNLOADING]);
    // the stub downloads nothing, so stand in for the download by putting a build in the cache, as the real CLI does
    const commit = "e".repeat(40);
    fs.mkdirSync(path.join(vault, PLUGIN_DIR, ".server/cli-data/serve-web", commit), { recursive: true });
    await inner().manager.stop("manual");
    Notice.reset();
    (plugin as unknown as { lastBuild: unknown }).lastBuild = null;
    await plugin.openSpikeFile();
    // no product.json commit for the stub: with a cached build present the notice is not repeated
    expect(Notice.messages).toEqual([]);
  });

  it("Accept is remembered in data.json and survives a reload: the second session does not ask", async () => {
    await load();
    const opening = plugin.openSpikeFile();
    await onModal(() => press("Accept and download"));
    await opening;
    // saveData of the mock keeps what data.json would hold; the reload below reads it back
    const saved = JSON.parse(JSON.stringify((plugin as unknown as { pluginData: unknown }).pluginData)) as Record<string, unknown>;
    expect(saved.serverLicenceAccepted).toBe(true);
    plugin.onunload();
    await vi.waitFor(() => expect(inner().manager.state).toBe("stopped"));

    Modal.reset();
    handledModals = 0;
    await load({}, saved);
    await plugin.openSpikeFile();
    expect(Modal.opened).toHaveLength(0);
    expect(app.workspace.leaves).toHaveLength(1);
  });

  it("Decline: no download, no process, no tab; the file opens in the system app; the flag stays false; the next open asks again", async () => {
    await load();
    const opening = plugin.openSpikeFile();
    await onModal(() => press("Decline"));
    await opening;
    expect(serverPids()).toEqual([]);
    expect(fs.existsSync(argsFile)).toBe(false);
    expect(app.workspace.leaves).toHaveLength(0);
    expect(app.openedWithDefault).toEqual([SPIKE_FILE]);
    expect(inner().data_.serverLicenceAccepted).not.toBe(true);
    expect((plugin as unknown as { pluginData: Record<string, unknown> }).pluginData.serverLicenceAccepted).not.toBe(true);

    const again = plugin.openSpikeFile();
    await onModal(() => press("Accept and download"));
    await again;
    expect(Modal.opened).toHaveLength(2);
    expect(serverPids()).toHaveLength(1);
  });

  it("Decline logs that the file goes to the system app; a launch that fails says so", async () => {
    await load();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const opening = plugin.openSpikeFile();
      await onModal(() => press("Decline"));
      await opening;
      expect(info).toHaveBeenCalledWith(expect.stringContaining(`opening ${SPIKE_FILE} in the system app`));

      app.openWithDefaultApp = async () => {
        throw new Error("no handler");
      };
      const again = plugin.openSpikeFile();
      await onModal(() => press("Decline"));
      await again;
      await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not open"), "no handler"));
      expect(Notice.messages.some((m) => m.includes("could not open"))).toBe(true);
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });

  it("Escape and click-away count as a decline", async () => {
    await load();
    const opening = plugin.openSpikeFile();
    await onModal(() => lastModal().close());
    await opening;
    expect(serverPids()).toEqual([]);
    expect(fs.existsSync(argsFile)).toBe(false);
    expect(inner().data_.serverLicenceAccepted).not.toBe(true);
    expect(app.openedWithDefault).toEqual([SPIKE_FILE]);
  });

  it("two opens while the modal is up share one modal and one server", async () => {
    await load();
    const a = plugin.openSpikeFile();
    const b = plugin.openSpikeFile();
    await onModal(() => press("Accept and download"));
    await Promise.all([a, b]);
    expect(Modal.opened).toHaveLength(1);
    expect(serverPids()).toHaveLength(1);
    expect(app.workspace.leaves).toHaveLength(2);
  });
});

describe("start failures", () => {
  it("a non-zero exit shows the exit code and last stderr line in a Notice, with no token, leaves no tab and lets the next open retry", async () => {
    await load({ FAKE_CODE_MODE: "exit-plain" }, { serverLicenceAccepted: true });
    await plugin.openSpikeFile();
    expect(Notice.messages).toEqual([DOWNLOADING, "VS Code Workbench: The VS Code server exited with code 5. Last message: fatal: the fake server broke"]);
    expect(app.workspace.leaves).toHaveLength(0);
    expect(inner().manager.state).toBe("failed");

    delete process.env.FAKE_CODE_MODE;
    await plugin.openSpikeFile();
    expect(app.workspace.leaves).toHaveLength(1);
    expect(inner().manager.state).toBe("running");
  });

  it("offline on the first run: says the network is unreachable, cleans up the half-downloaded build, keeps the licence", async () => {
    const partial = path.join(vault, PLUGIN_DIR, ".server/cli-data/serve-web", "d".repeat(40));
    await load({ FAKE_CODE_MODE: "offline", FAKE_CODE_PARTIAL_DIR: partial }, { serverLicenceAccepted: true });
    await plugin.openSpikeFile();
    expect(Notice.messages).toEqual([
      DOWNLOADING,
      "VS Code Workbench: The VS Code server could not be downloaded because the network is unreachable. Connect to the internet and open a Code tab again. Your licence acceptance is kept.",
    ]);
    expect(fs.existsSync(partial)).toBe(false);
    expect(inner().data_.serverLicenceAccepted).toBe(true);
    expect(app.workspace.leaves).toHaveLength(0);
    expect(Modal.opened).toHaveLength(0);
  });

  it("a failed download with the download host reachable: a plain download-failed notice, the half-downloaded build is still cleaned up", async () => {
    const partial = path.join(vault, PLUGIN_DIR, ".server/cli-data/serve-web", "d".repeat(40));
    networkUp = true;
    await load({ FAKE_CODE_MODE: "offline", FAKE_CODE_PARTIAL_DIR: partial }, { serverLicenceAccepted: true });
    await plugin.openSpikeFile();
    expect(Notice.messages[1]).toContain("The VS Code server could not be downloaded. Try again later");
    expect(Notice.messages[1]).not.toContain("network is unreachable");
    expect(fs.existsSync(partial)).toBe(false);
    expect(app.workspace.leaves).toHaveLength(0);
  });

  it("offline after a VS Code update: names the change and, if the user accepts, starts the cached older build", async () => {
    const oldCommit = "a".repeat(40);
    const cached = path.join(vault, PLUGIN_DIR, ".server/cli-data/serve-web", oldCommit);
    fs.mkdirSync(cached, { recursive: true });
    // VS Code 1.2.0 (commit b...) is installed; the last server that ran was 0.9.0 (commit a...), and the network is down
    await load(
      { FAKE_CODE_MODE: "offline", FAKE_CODE_OFFLINE_EXCEPT: oldCommit },
      { serverLicenceAccepted: true, codeCliPath: fakeInstall("1.2.0", "b".repeat(40)), lastServer: { commit: oldCommit, version: "0.9.0" } },
    );
    const opening = plugin.openSpikeFile();
    await onModal(() => {
      const text = lastModal().contentEl.textContent();
      expect(text).toContain("updated from 0.9.0 to 1.2.0");
      press("Use 0.9.0 server");
    });
    await opening;
    expect(Notice.messages.join("\n")).toContain("VS Code was updated from 0.9.0 to 1.2.0");
    expect(app.workspace.leaves).toHaveLength(1);
    expect(inner().manager.state).toBe("running");
    const args = JSON.parse(fs.readFileSync(argsFile, "utf8")) as string[];
    expect(args[args.indexOf("--commit-id") + 1]).toBe(oldCommit);
    expect(fs.existsSync(cached)).toBe(true); // the cached build is never removed by the cleanup
  });
});

describe("idle stop (G13, E13)", () => {
  async function running() {
    await load({}, { serverLicenceAccepted: true });
    await plugin.openSpikeFile();
    const wrapper = inner().manager.serverInstance as unknown as { pid: number; current: { port: number } };
    const pid = wrapper.pid;
    const port = wrapper.current.port;
    // restart the idle clock under fake timers, with the plugin's own wiring
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    inner().idle.stop();
    inner().idle.start();
    return { pid, port };
  }

  it("stops the server after 5 minutes with no visible Code tab and no unsaved buffer, and the next open starts it again", async () => {
    const { pid, port } = await running();
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1000);
    expect(inner().manager.state).toBe("running");
    await vi.advanceTimersByTimeAsync(6000);
    expect(inner().manager.state).toBe("stopped-by-idle");
    vi.useRealTimers();
    await vi.waitFor(() => {
      expect(isAlive(pid)).toBe(false);
      expect(listenersOn(port)).toEqual([]);
    }, { timeout: 5000 });

    await plugin.openSpikeFile();
    expect(inner().manager.state).toBe("running");
    expect(app.workspace.leaves).toHaveLength(2);
  });

  it("a visible Code tab keeps it running for 30 minutes", async () => {
    await running();
    const v = fakeView({ visible: true });
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(v.visible).toBe(true);
    expect(inner().manager.state).toBe("running");
  });

  it("a tab with an unsaved buffer keeps it running even when hidden; once saved the clock starts and it stops 5 minutes later", async () => {
    await running();
    const v = fakeView({ visible: false, dirty: true });
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(inner().manager.state).toBe("running");
    v.dirty = false;
    await vi.advanceTimersByTimeAsync(5_000); // the poll sees the save
    await vi.advanceTimersByTimeAsync(IDLE_MS - 5_000);
    expect(inner().manager.state).toBe("running"); // the clock restarted at the save, not before
    await vi.advanceTimersByTimeAsync(10_000);
    expect(inner().manager.state).toBe("stopped-by-idle");
  });
});

describe("quit", () => {
  const quit = async () => {
    const tasks = new Tasks();
    for (const e of event("quit")) e.cb(tasks);
    expect(tasks.fns).toHaveLength(1);
    await tasks.runAll();
  };

  it("kills the server and leaves nothing listening", async () => {
    await load({}, { serverLicenceAccepted: true });
    await plugin.openSpikeFile();
    const w = inner().manager.serverInstance as unknown as { pid: number; current: { port: number } };
    const [server] = serverPids();
    await quit();
    expect(isAlive(w.pid)).toBe(false);
    expect(isAlive(server)).toBe(false);
    expect(listenersOn(w.current?.port ?? 0)).toEqual([]);
    expect(inner().manager.state).toBe("stopped");
  });

  it("with unsaved buffers asks first; Save saves them and then quits", async () => {
    await load({}, { serverLicenceAccepted: true });
    await plugin.openSpikeFile();
    const v = fakeView({ file: "Mock Exams/estimate.py", dirty: true });
    const quitting = quit();
    await onModal(() => {
      expect(lastModal().contentEl.textContent()).toContain("estimate.py");
      press("Save");
    });
    await quitting;
    expect(v.saved).toBe(1);
    expect(inner().manager.state).toBe("stopped");
  });

  it("Escape on the quit prompt saves: it never discards", async () => {
    await load({}, { serverLicenceAccepted: true });
    await plugin.openSpikeFile();
    const v = fakeView({ dirty: true });
    const quitting = quit();
    await onModal(() => lastModal().close());
    await quitting;
    expect(v.saved).toBe(1);
  });

  it("Discard quits without saving", async () => {
    await load({}, { serverLicenceAccepted: true });
    await plugin.openSpikeFile();
    const v = fakeView({ dirty: true });
    const quitting = quit();
    await onModal(() => press("Discard changes"));
    await quitting;
    expect(v.saved).toBe(0);
    expect(inner().manager.state).toBe("stopped");
  });

  it("a buffer that cannot be saved is never dropped silently: it asks again, and Retry saves it", async () => {
    await load({}, { serverLicenceAccepted: true });
    await plugin.openSpikeFile();
    const w = inner().manager.serverInstance as unknown as { pid: number };
    const v = fakeView({ file: "untitled.py", dirty: true, saves: false });
    const quitting = quit();
    await onModal(() => press("Save"));
    await onModal(() => {
      expect(lastModal().contentEl.textContent()).toContain("Some changes could not be saved");
      expect(lastModal().contentEl.textContent()).toContain("untitled.py");
      v.dirty = false; // the user saved it from its tab while the prompt was open
      press("Retry");
    });
    await quitting;
    expect(v.saved).toBe(2);
    expect(inner().manager.state).toBe("stopped");
    expect(isAlive(w.pid)).toBe(false);
  });

  it("while a buffer stays unsaved the server keeps running and the prompt keeps coming back; Escape retries, never discards", async () => {
    await load({}, { serverLicenceAccepted: true });
    await plugin.openSpikeFile();
    const w = inner().manager.serverInstance as unknown as { pid: number };
    const v = fakeView({ file: "untitled.py", dirty: true, saves: false });
    let done = false;
    const quitting = quit().then(() => (done = true));
    await onModal(() => press("Save"));
    await onModal(() => lastModal().close()); // Escape on the "could not save" prompt
    await onModal(() => lastModal().close());
    await new Promise((r) => setTimeout(r, 300));
    expect(done).toBe(false);
    expect(isAlive(w.pid)).toBe(true);
    expect(inner().manager.state).toBe("running");
    expect(v.saved).toBe(3);
    await onModal(() => press("Discard changes"));
    await quitting;
    expect(inner().manager.state).toBe("stopped");
    expect(isAlive(w.pid)).toBe(false);
  });

  it("with two Code tabs, one saves and one does not: only the stuck one is asked about again", async () => {
    await load({}, { serverLicenceAccepted: true });
    await plugin.openSpikeFile();
    const ok = fakeView({ file: "ok.py", dirty: true });
    const stuck = fakeView({ file: "stuck.py", dirty: true, saves: false });
    const quitting = quit();
    await onModal(() => press("Save"));
    await onModal(() => {
      const text = lastModal().contentEl.textContent();
      expect(text).toContain("stuck.py");
      expect(text).not.toContain("ok.py");
      press("Discard changes");
    });
    await quitting;
    expect(ok.saved).toBe(1);
    expect(stuck.saved).toBe(1);
    expect(inner().manager.state).toBe("stopped");
  });

  it("no prompt when nothing is unsaved", async () => {
    await load({}, { serverLicenceAccepted: true });
    await plugin.openSpikeFile();
    fakeView({ dirty: false });
    await quit();
    expect(Modal.opened).toHaveLength(0);
  });

  it("a quit with no server running is harmless", async () => {
    await load();
    await quit();
    expect(inner().manager.state).toBe("stopped");
  });

  it("window unload without the quit event (pagehide) still stops the server, without a prompt", async () => {
    await load({}, { serverLicenceAccepted: true });
    await plugin.openSpikeFile();
    const w = inner().manager.serverInstance as unknown as { pid: number };
    const [server] = serverPids();
    fakeView({ dirty: true });
    expect(windowListeners.pagehide).toHaveLength(1);
    windowListeners.pagehide[0]();
    await vi.waitFor(() => {
      expect(isAlive(w.pid)).toBe(false);
      expect(isAlive(server)).toBe(false);
    }, { timeout: 5000 });
    expect(Modal.opened).toHaveLength(0);
  });

  it("the plugin does not act on beforeunload at all (Obsidian's quit flow runs inside it)", async () => {
    await load({}, { serverLicenceAccepted: true });
    expect(windowListeners.beforeunload ?? []).toHaveLength(0);
  });

  // Obsidian 1.14.5 runs its quit flow inside window.onbeforeunload: any beforeunload listener of ours may run
  // BEFORE the "quit" event fires (reproduced live: shutdown, then the quit event). So the dispatch below is
  // beforeunload first, then quit, as Obsidian orders it; the server must still be alive when the prompt shows.
  it("a real quit: beforeunload first, then the quit event; the server stays alive until the prompt is answered", async () => {
    await load({}, { serverLicenceAccepted: true });
    await plugin.openSpikeFile();
    const w = inner().manager.serverInstance as unknown as { pid: number; current: { port: number } };
    const [server] = serverPids();
    const v = fakeView({ file: "edited.py", dirty: true });

    for (const l of windowListeners.beforeunload ?? []) l({ defaultPrevented: false });
    const tasks = new Tasks();
    for (const e of event("quit")) e.cb(tasks);
    const quitting = tasks.runAll();

    await onModal(() => {
      // the prompt is up: the server must still be there for Save to reach
      expect(lastModal().contentEl.textContent()).toContain("edited.py");
    });
    await new Promise((r) => setTimeout(r, 500));
    expect(isAlive(w.pid)).toBe(true);
    expect(isAlive(server)).toBe(true);
    expect(listenersOn(w.current.port).length).toBeGreaterThan(0);
    expect(inner().manager.state).toBe("running");

    press("Save");
    await quitting;
    expect(v.saved).toBe(1); // saved against a live server
    expect(isAlive(w.pid)).toBe(false);
    expect(isAlive(server)).toBe(false);
    expect(inner().manager.state).toBe("stopped");

    // Obsidian closes the window once the tasks are done: that final unload is harmless
    for (const l of windowListeners.pagehide ?? []) l();
    expect(inner().manager.state).toBe("stopped");
  });

  it("a quit with nothing unsaved: beforeunload first, then the tasks finish and the server is gone", async () => {
    await load({}, { serverLicenceAccepted: true });
    await plugin.openSpikeFile();
    const w = inner().manager.serverInstance as unknown as { pid: number };
    for (const l of windowListeners.beforeunload ?? []) l({ defaultPrevented: true });
    const tasks = new Tasks();
    for (const e of event("quit")) e.cb(tasks);
    await tasks.runAll();
    expect(Modal.opened).toHaveLength(0);
    expect(isAlive(w.pid)).toBe(false);
  });
});

describe("restart", () => {
  it("from the settings button: a new port and token, tabs told to reload", async () => {
    await load({}, { serverLicenceAccepted: true });
    await plugin.openSpikeFile();
    const before = inner().manager.current!;
    const states: string[] = [];
    plugin.onServerState((s) => states.push(s));
    await plugin.restartServer();
    const after = inner().manager.current!;
    expect(after.port).not.toBe(before.port);
    expect(after.token).not.toBe(before.token);
    expect(states).toContain("running");
    expect(serverPids()).toHaveLength(2);
  });

  it("with an unsaved buffer asks first; Cancel (or Escape) keeps the running server", async () => {
    await load({}, { serverLicenceAccepted: true });
    await plugin.openSpikeFile();
    fakeView({ dirty: true });
    const before = inner().manager.current!;
    const restarting = plugin.restartServer();
    await onModal(() => lastModal().close());
    await restarting;
    expect(inner().manager.current).toBe(before);
    expect(serverPids()).toHaveLength(1);
  });

  it("works from the failed state", async () => {
    await load({ FAKE_CODE_MODE: "exit-plain" }, { serverLicenceAccepted: true });
    await plugin.openSpikeFile();
    expect(inner().manager.state).toBe("failed");
    delete process.env.FAKE_CODE_MODE;
    await plugin.restartServer();
    expect(inner().manager.state).toBe("running");
  });

  it("a restart that fails closes a Code tab still showing the stopped server's page, and names the reason (G14)", async () => {
    await load({}, { serverLicenceAccepted: true });
    await plugin.openSpikeFile();
    // a real Code tab, wired to the plugin as its host, holding the running server's page
    const leaf = new WorkspaceLeaf();
    const view = new CodeView(leaf as never, plugin as never);
    const contentEl = Object.assign(new FakeNode("div"), { addClass: () => undefined });
    Object.assign(view, { contentEl });
    await view.onOpen();
    const page = new FakeNode("webview");
    Object.assign(view, { frame: page });

    const before = serverPids();
    inner().data_.codeCliPath = path.join(vault, "no-such-code");
    Notice.reset();
    await expect(plugin.restartServer()).rejects.toThrow();
    expect(inner().manager.state).toBe("failed");
    expect(Notice.messages.length).toBeGreaterThan(0);
    expect(leaf.detached).toBe(true);
    expect(page.removed).toBe(true);
    expect(before).toHaveLength(1);
    await vi.waitFor(() => expect(isAlive(before[0])).toBe(false), { timeout: 3000 });
  });

  it("the settings tab has a Restart server button wired to it", async () => {
    await load({}, { serverLicenceAccepted: true });
    const tab = Plugin.settingTabs[0] as { display(): void };
    const { Setting } = await import("../mocks/obsidian");
    Setting.reset();
    tab.display();
    const s = Setting.all.find((x) => x.name === "Restart server");
    expect(s?.button?.text).toBe("Restart server");
    await s!.button!.handler!();
    expect(inner().manager.state).toBe("running");
    expect(serverPids()).toHaveLength(1);
  });
});

describe("pidfile content", () => {
  it("lists the server, the vault path and no token; and is gone after quit", async () => {
    await load({}, { serverLicenceAccepted: true });
    await plugin.openSpikeFile();
    const file = path.join(vault, PLUGIN_DIR, ".server/pids.json");
    const text = fs.readFileSync(file, "utf8");
    const token = inner().manager.current!.token;
    expect(text).not.toContain(token);
    const entries = JSON.parse(text) as Array<{ pid: number; label: string; workspace: string }>;
    expect(entries.map((e) => [e.label, e.workspace])).toEqual([["vscode-server", vault]]);
    plugin.onunload();
    await vi.waitFor(() => expect(fs.existsSync(file)).toBe(false), { timeout: 5000 });
  });

  it("the next startup sweeps a server left by a previous session", async () => {
    // session 1 force-quit: its server and pidfile remain
    await load({}, { serverLicenceAccepted: true });
    await plugin.openSpikeFile();
    const file = path.join(vault, PLUGIN_DIR, ".server/pids.json");
    const leftover = fs.readFileSync(file, "utf8");
    const [oldServer] = serverPids();
    const wrapper = (inner().manager.serverInstance as unknown as { pid: number }).pid;
    strays.push(oldServer, wrapper);
    // forget session 1 without stopping its processes
    (inner().manager as unknown as { server: unknown }).server = null;
    plugin.onunload();
    fs.writeFileSync(file, leftover);
    process.kill(wrapper, "SIGSTOP"); // still alive, as after a force quit
    process.kill(wrapper, "SIGCONT");
    expect(isAlive(wrapper)).toBe(true);

    await load({}, { serverLicenceAccepted: true });
    await vi.waitFor(() => {
      expect(isAlive(wrapper)).toBe(false);
      expect(isAlive(oldServer)).toBe(false);
    }, { timeout: 8000 });
  });
});
