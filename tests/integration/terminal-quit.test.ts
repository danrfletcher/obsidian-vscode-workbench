/**
 * Integration (real processes): quit and unload end every shell under the server (E6, G14). The fake `serve-web` holds shell
 * children started the way the real server starts a terminal's shell (`FAKE_CODE_SHELLS`): an idle one, one with a foreground child,
 * one that ignores SIGTERM and SIGHUP; plus one `setsid` child in a session of its own, which is the documented exception (as in real
 * VS Code) and is not asserted dead. `isAlive` and `listenersOn` from `tests/helpers.ts` check the result.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChildRegistry } from "../../src/child-registry";
import { PidFile } from "../../src/pidfile";
import { WorkbenchServer, type CodeBuild } from "../../src/server";
import { ServerManager } from "../../src/server-manager";
import { Modal, Notice, Plugin, Tasks } from "../mocks/obsidian";
import VSCodeWorkbenchPlugin, { SPIKE_FILE } from "../../src/main";
import { FAKE_CODE, isAlive, listenersOn, tempDir } from "../helpers";
import { installFakeDocument, makeHostApp } from "../fake-host-page";

const build: CodeBuild = { cli: FAKE_CODE, version: [1, 0, 0], versionText: "1.0.0", extensionsDir: null };
const KINDS = "sleep,fg,ignore";

let pidFile: string;
let runtimeDir: string;

interface Listed {
  servers: number[];
  shells: number[];
  setsid: number[];
}

/** The fake server's pidfile: a bare pid per server, `shell <pid>` and `setsid <pid>` per child. */
function pids(): Listed {
  const out: Listed = { servers: [], shells: [], setsid: [] };
  if (!fs.existsSync(pidFile)) return out;
  for (const line of fs.readFileSync(pidFile, "utf8").split("\n").filter(Boolean)) {
    const [kind, pid] = line.split(" ");
    if (pid === undefined) out.servers.push(Number(kind));
    else if (kind === "shell") out.shells.push(Number(pid));
    else if (kind === "setsid") out.setsid.push(Number(pid));
  }
  return out;
}

const env = (extra: Record<string, string> = {}) => ({ FAKE_CODE_NODE: process.execPath, FAKE_CODE_PIDFILE: pidFile, FAKE_CODE_SHELLS: "3", FAKE_CODE_SHELL_KINDS: KINDS, ...extra });

function makeManager(extra: Record<string, string> = {}): ServerManager {
  const registry = new ChildRegistry(new PidFile(path.join(runtimeDir, "pids.json")));
  return new ServerManager({
    registry,
    healthIntervalMs: 0,
    create: async () => new WorkbenchServer({ build, runtimeDir, acceptLicense: true, pollIntervalMs: 25, registry, env: env(extra) }),
  });
}

beforeEach(() => {
  pidFile = path.join(tempDir(), "pids");
  runtimeDir = path.join(tempDir(), ".server");
});

afterEach(() => {
  const p = pids();
  for (const pid of [...p.servers, ...p.shells, ...p.setsid]) if (isAlive(pid)) process.kill(pid, "SIGKILL");
});

/** The fake server has spawned all its children and written their pids. */
async function allChildrenListed(): Promise<Listed> {
  await vi.waitFor(
    () => {
      const p = pids();
      expect(p.shells).toHaveLength(3);
      expect(p.setsid).toHaveLength(1);
      expect(p.servers).toHaveLength(1);
    },
    { timeout: 8000, interval: 25 },
  );
  return pids();
}

describe("manager.shutdown() with shells under the server", () => {
  it("ends the idle shell, the shell with a foreground child and the shell that ignores SIGTERM, with the server; the setsid child survives", async () => {
    const m = makeManager();
    const running = await m.ensureStarted();
    const { servers, shells, setsid } = await allChildrenListed();
    for (const pid of [...servers, ...shells, ...setsid]) expect(isAlive(pid)).toBe(true);
    const wrapper = m.serverInstance!.pid as number;

    await m.shutdown();

    await vi.waitFor(
      () => {
        for (const pid of [wrapper, ...servers, ...shells]) expect(isAlive(pid)).toBe(false);
      },
      { timeout: 8000, interval: 50 },
    );
    expect(listenersOn(running.port)).toEqual([]);
    expect(m.state).toBe("stopped");
    // the documented exception: a process that left the server's session and group is not ours to end
    expect(isAlive(setsid[0])).toBe(true);
  });

  it("the foreground child of a shell ends with it", async () => {
    const m = makeManager({ FAKE_CODE_SHELLS: "1", FAKE_CODE_SHELL_KINDS: "fg" });
    await m.ensureStarted();
    await vi.waitFor(() => expect(pids().shells).toHaveLength(1), { timeout: 8000, interval: 25 });
    const [shell] = pids().shells;
    const kids = execFileSync("pgrep", ["-P", String(shell)], { encoding: "utf8" }).split("\n").filter(Boolean).map(Number);
    expect(kids.length).toBeGreaterThan(0);
    await m.shutdown();
    await vi.waitFor(
      () => {
        expect(isAlive(shell)).toBe(false);
        for (const k of kids) expect(isAlive(k)).toBe(false);
      },
      { timeout: 8000, interval: 50 },
    );
  });
});

describe("the plugin: quit and unload", () => {
  let plugin: VSCodeWorkbenchPlugin;

  async function load(): Promise<void> {
    const vault = tempDir();
    fs.mkdirSync(path.join(vault, path.dirname(SPIKE_FILE)), { recursive: true });
    fs.writeFileSync(path.join(vault, SPIKE_FILE), "import os\n");
    Plugin.reset();
    Notice.reset();
    Modal.reset();
    Object.assign(process.env, env());
    plugin = new VSCodeWorkbenchPlugin(makeHostApp(vault) as never, { id: "obsidian-vscode-workbench", dir: ".obsidian/plugins/obsidian-vscode-workbench" } as never);
    (plugin as unknown as { pluginData: unknown }).pluginData = { codeCliPath: FAKE_CODE, embed: "iframe", serverLicenceAccepted: true };
    await plugin.onload();
  }
  const host = () => (plugin as unknown as { terminalHost: { settled(): Promise<void> } }).terminalHost;
  afterEach(() => {
    for (const k of ["FAKE_CODE_NODE", "FAKE_CODE_PIDFILE", "FAKE_CODE_SHELLS", "FAKE_CODE_SHELL_KINDS"]) delete process.env[k];
    vi.unstubAllGlobals();
  });

  it("Obsidian's quit: no prompt, and the page, server and every shell are gone when the quit task ends", async () => {
    const d = installFakeDocument();
    await load();
    plugin.showTerminalHost();
    await host().settled();
    const p = await allChildrenListed();
    const tasks = new Tasks();
    for (const e of Plugin.events.filter((x) => x.name === "quit")) e.cb(tasks);
    expect(tasks.fns).toHaveLength(1);
    await tasks.runAll();

    expect(Modal.opened).toHaveLength(0);
    // The last signal (SIGKILL for the shell that ignores SIGTERM) went out before the quit task ended; the kernel needs a moment to
    // deliver it. The wait is 1 s, not the 3 s of the stop's own grace period, so this still shows the task waited for it.
    await vi.waitFor(() => expect([...p.servers, ...p.shells].filter(isAlive)).toEqual([]), { timeout: 1000, interval: 20 });
    expect(d.webviews[0].removed).toBe(true);
    expect(d.text()).not.toContain("stopped unexpectedly");
    expect(d.text()).not.toContain("lost");
    expect(Notice.messages.filter((m) => !m.includes("downloading the VS Code server"))).toEqual([]);
    expect((plugin as unknown as { manager: ServerManager }).manager.state).toBe("stopped");
    expect(isAlive(p.setsid[0])).toBe(true); // the documented exception
  });

  it("onunload (disabling the plugin): no prompt, the page, server and shells end, no banner and no reload", async () => {
    const d = installFakeDocument();
    await load();
    plugin.showTerminalHost();
    await host().settled();
    const p = await allChildrenListed();
    plugin.onunload();
    await vi.waitFor(
      () => {
        for (const pid of [...p.servers, ...p.shells]) expect(isAlive(pid)).toBe(false);
      },
      { timeout: 8000, interval: 50 },
    );
    expect(Modal.opened).toHaveLength(0);
    expect(d.webviews).toHaveLength(1); // no page was made for the dying server
    expect(d.webviews[0].removed).toBe(true);
    expect(d.text()).not.toContain("stopped unexpectedly");
    expect(Notice.messages.filter((m) => !m.includes("downloading the VS Code server"))).toEqual([]);
  });
});
