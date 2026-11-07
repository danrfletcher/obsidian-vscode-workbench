/**
 * Integration: what the terminal page does when the server under it is restarted, dies or stops idle (G13, E7), through the real
 * plugin (`main.ts`), the real host page and the fake `code` script (real processes, real `kill -9`). The webview is the fake of
 * `tests/host-fakes.ts`. Covers the crash banner and its Restart, the "terminals lost" message after any restart (and its absence
 * after a first start or an idle-stop start), dismissing it, a failed restart, and the token never reaching text.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Modal, Notice, Plugin } from "../mocks/obsidian";
import VSCodeWorkbenchPlugin, { SPIKE_FILE } from "../../src/main";
import { LOST_TEXT, RESTART_LOST_TEXT, TERMINAL_CRASH_TEXT, TERMINAL_RESTART_FAILED_TEXT } from "../../src/terminal-host/host-page";
import { FAKE_CODE, isAlive, tempDir, openTerminal, closeTerminal } from "../helpers";
import { installFakeDocument, makeHostApp, type FakeDocument } from "../fake-host-page";

const PLUGIN_DIR = ".obsidian/plugins/vscode-workbench";
let vault: string;
let pidFile: string;
let argsFile: string;
let plugin: VSCodeWorkbenchPlugin;
let doc: FakeDocument;

async function load(env: Record<string, string> = {}, data: Record<string, unknown> = {}): Promise<void> {
  Object.assign(process.env, { FAKE_CODE_NODE: process.execPath, FAKE_CODE_PIDFILE: pidFile, FAKE_CODE_ARGSFILE: argsFile }, env);
  plugin = new VSCodeWorkbenchPlugin(makeHostApp(vault) as never, { id: "vscode-workbench", dir: PLUGIN_DIR } as never);
  (plugin as unknown as { pluginData: unknown }).pluginData = { codeCliPath: FAKE_CODE, embed: "iframe", serverLicenceAccepted: true, ...data };
  (plugin as unknown as { downloadHostReachable: () => Promise<boolean> }).downloadHostReachable = async () => false;
  await plugin.onload();
}

const serverPids = () => (fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8").split("\n").filter(Boolean).map(Number) : []);
const inner = () => plugin as unknown as { manager: import("../../src/server-manager").ServerManager; data_: Record<string, unknown> };
const host = () => (plugin as unknown as { terminalHost: import("../../src/terminal-host/host-page").TerminalHostPage | null }).terminalHost!;
const until = (fn: () => void, timeout = 8000) => vi.waitFor(fn, { timeout, interval: 25 });

/** A shown drawer with the page up. */
async function showRunning(): Promise<void> {
  openTerminal(plugin);
  await host().settled();
  expect(host().view()).toBe("running");
}

/** `kill -9` of the newest server and wait until the manager has noticed. */
async function crashServer(): Promise<void> {
  const pids = serverPids();
  process.kill(pids[pids.length - 1], "SIGKILL");
  await until(() => expect(inner().manager.state).toBe("crashed"));
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
  doc = installFakeDocument();
});

afterEach(async () => {
  vi.useRealTimers();
  plugin?.onunload();
  await new Promise((r) => setTimeout(r, 400));
  for (const pid of serverPids()) if (isAlive(pid)) process.kill(pid, "SIGKILL");
  for (const k of ["FAKE_CODE_NODE", "FAKE_CODE_PIDFILE", "FAKE_CODE_ARGSFILE", "FAKE_CODE_MODE"]) delete process.env[k];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the lost message is for a restart, not for a start", () => {
  it("a first start shows no lost message", async () => {
    await load();
    await showRunning();
    expect(doc.text()).not.toContain(RESTART_LOST_TEXT);
    expect(doc.text()).not.toContain(LOST_TEXT);
    expect(doc.text()).not.toContain(TERMINAL_CRASH_TEXT);
  });

  it("an ordinary start after an idle stop shows no lost message, with the drawer open or hidden", async () => {
    await load();
    await showRunning();
    const first = inner().manager.current!;
    await inner().manager.stop("idle");
    await host().settled(); // an open drawer starts again at once
    await until(() => expect(host().view()).toBe("running"));
    expect(inner().manager.current!.token).not.toBe(first.token);
    expect(doc.webviews).toHaveLength(2);
    expect(doc.text()).not.toContain(RESTART_LOST_TEXT);

    closeTerminal(plugin);
    await inner().manager.stop("idle");
    expect(host().view()).toBe("hidden");
    expect(doc.webviews).toHaveLength(2); // nothing starts for a hidden drawer
    openTerminal(plugin);
    await until(() => expect(host().view()).toBe("running"));
    expect(doc.webviews).toHaveLength(3);
    expect(doc.text()).not.toContain(RESTART_LOST_TEXT);
  });

  it("a restart from the settings button reloads the page at the new address and says the terminals were lost; it can be dismissed and a second restart says it again", async () => {
    await load();
    await showRunning();
    const before = inner().manager.current!;
    expect(doc.webviews).toHaveLength(1);

    await plugin.restartServer(); // no dirty buffer, no shell: no prompt
    expect(Modal.opened).toHaveLength(0);
    await until(() => expect(host().view()).toBe("lost"));
    const after = inner().manager.current!;
    expect(after.token).not.toBe(before.token);
    expect(doc.webviews).toHaveLength(2);
    expect(doc.webviews[0].removed).toBe(true); // the page under the dead server is gone
    expect(doc.webviews[1].srcs.some((s) => s.startsWith(`${after.baseUrl}/`) || s.startsWith(after.baseUrl))).toBe(true);
    expect(doc.text()).toContain(RESTART_LOST_TEXT);
    expect(doc.text()).not.toContain(before.token);
    expect(doc.text()).not.toContain(after.token);

    doc.button("Dismiss")!.click();
    expect(host().view()).toBe("running");
    expect(doc.text()).not.toContain(RESTART_LOST_TEXT);

    await plugin.restartServer();
    await until(() => expect(host().view()).toBe("lost"));
    expect(doc.webviews).toHaveLength(3);
    expect(doc.text()).toContain(RESTART_LOST_TEXT);
  });

  it("a restart while the drawer is hidden: the page comes back at the new address and the message is there when the drawer opens", async () => {
    await load();
    await showRunning();
    closeTerminal(plugin);
    await plugin.restartServer();
    await until(() => expect(doc.webviews).toHaveLength(2));
    await host().settled();
    openTerminal(plugin);
    expect(host().view()).toBe("lost");
    expect(doc.text()).toContain(RESTART_LOST_TEXT);
  });

  it("a reload of the page itself still says the older message, not the restart one", async () => {
    await load();
    await showRunning();
    doc.webviews[0].fire("dom-ready");
    expect(doc.text()).toContain(LOST_TEXT);
    expect(doc.text()).not.toContain(RESTART_LOST_TEXT);
  });
});

describe("a crashed server (G13)", () => {
  it("shows the crash banner with Restart in the drawer, saying the terminals are lost, and starts nothing by itself", async () => {
    await load();
    await showRunning();
    await crashServer();
    expect(host().view()).toBe("crashed");
    expect(doc.text()).toContain(TERMINAL_CRASH_TEXT);
    expect(TERMINAL_CRASH_TEXT).toContain("terminals are lost");
    expect(doc.button("Restart")).toBeDefined();
    expect(doc.webviews[0].removed).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
    expect(serverPids()).toHaveLength(1); // no second server
    expect(doc.webviews).toHaveLength(1);
    expect(host().view()).toBe("crashed");
  });

  it("the drawer hidden at the crash and opened afterwards shows the banner", async () => {
    await load();
    await showRunning();
    closeTerminal(plugin);
    await crashServer();
    expect(host().view()).toBe("hidden");
    openTerminal(plugin);
    expect(host().view()).toBe("crashed");
    expect(doc.text()).toContain(TERMINAL_CRASH_TEXT);
    expect(doc.button("Restart")).toBeDefined();
    expect(serverPids()).toHaveLength(1);
  });

  it("Restart gives a new port-or-token server, reloads the page at the new address and shows the lost message", async () => {
    await load();
    await showRunning();
    const before = inner().manager.current!;
    await crashServer();
    doc.button("Restart")!.click();
    await until(() => expect(host().view()).toBe("lost"));
    const after = inner().manager.current!;
    expect(after.token).not.toBe(before.token);
    expect(serverPids()).toHaveLength(2);
    expect(Modal.opened).toHaveLength(0); // a crashed server is restarted without a prompt
    expect(doc.webviews).toHaveLength(2);
    expect(doc.text()).toContain(RESTART_LOST_TEXT);
    expect(doc.text()).not.toContain(TERMINAL_CRASH_TEXT);
    expect(doc.text()).not.toContain(after.token);
    expect(doc.text()).not.toContain(before.token);
  });

  it("two quick presses of Restart give one restart and one new server", async () => {
    await load();
    await showRunning();
    await crashServer();
    const restart = vi.spyOn(inner().manager, "restart");
    const button = doc.button("Restart")!;
    button.click();
    button.click();
    await until(() => expect(host().view()).toBe("lost"));
    expect(restart).toHaveBeenCalledTimes(1);
    expect(serverPids()).toHaveLength(2);
  });

  it("a restart that fails keeps the banner up with the reason; pressing Restart again tries again, and nothing loops", async () => {
    await load();
    await showRunning();
    await crashServer();
    inner().data_.codeCliPath = path.join(vault, "no-such-code");
    const restart = vi.spyOn(inner().manager, "restart");

    doc.button("Restart")!.click();
    await until(() => expect(inner().manager.state).toBe("failed"));
    await until(() => expect(doc.text()).toContain(TERMINAL_RESTART_FAILED_TEXT));
    expect(host().view()).toBe("crashed");
    expect(doc.button("Restart")).toBeDefined();
    expect(Notice.messages.filter((m) => !m.includes("downloading the VS Code server"))).toEqual([]); // the banner carries the reason; no Notice repeats it
    expect(doc.webviews).toHaveLength(1);
    expect(restart).toHaveBeenCalledTimes(1);

    await new Promise((r) => setTimeout(r, 600));
    expect(restart).toHaveBeenCalledTimes(1); // no loop

    doc.button("Restart")!.click();
    await until(() => expect(restart).toHaveBeenCalledTimes(2));
    await until(() => expect(doc.text()).toContain(TERMINAL_RESTART_FAILED_TEXT));
    expect(host().view()).toBe("crashed");

    // and when the cause is gone the same button brings the page back
    inner().data_.codeCliPath = FAKE_CODE;
    doc.button("Restart")!.click();
    await until(() => expect(host().view()).toBe("lost"));
    expect(doc.text()).toContain(RESTART_LOST_TEXT);
  });

  it("neither the banner, the failure text nor a notice carries the connection token", async () => {
    await load();
    await showRunning();
    const first = inner().manager.current!.token;
    await crashServer();
    inner().data_.codeCliPath = path.join(vault, "no-such-code");
    doc.button("Restart")!.click();
    await until(() => expect(doc.text()).toContain(TERMINAL_RESTART_FAILED_TEXT));
    expect(doc.text()).not.toContain(first);
    for (const m of Notice.messages) expect(m).not.toContain(first);
  });

  it("a server that crashes while a start of the page is still running leaves the banner, and nothing comes back by itself", async () => {
    await load();
    openTerminal(plugin);
    // the start is in flight: the server is being made
    await until(() => expect(inner().manager.state).toBe("running"));
    process.kill(serverPids()[0], "SIGKILL");
    await until(() => expect(inner().manager.state).toBe("crashed"));
    await host().settled();
    await new Promise((r) => setTimeout(r, 300));
    expect(host().view()).toBe("crashed");
    expect(serverPids()).toHaveLength(1);
  });
});
