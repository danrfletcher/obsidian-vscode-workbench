/**
 * Integration: the terminal host page through `main.ts`, with the mocked `obsidian` module, the real licence modal and the
 * fake `code` script (real processes). The page itself is the fake webview of `tests/host-fakes.ts` (the `FakeEl` webview
 * pattern of `tests/unit/code-view.test.ts`, plus a fake workbench behind it). Covers G2, G5, G17, E1, E2, E10, F3 and the token.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileSystemAdapter, Modal, Notice, Plugin, TFile, WorkspaceLeaf, FakeNode, type MockApp } from "../mocks/obsidian";
import VSCodeWorkbenchPlugin, { SPIKE_FILE } from "../../src/main";
import { LOST_TEXT, STARTING_TEXT } from "../../src/terminal-host/host-page";
import { FAKE_CODE, isAlive, tempDir } from "../helpers";
import { FakeHostEl, FakeWorkbenchPage } from "../host-fakes";

let vault: string;
let pidFile: string;
let argsFile: string;
let plugin: VSCodeWorkbenchPlugin;
let app: MockApp;
let body: FakeHostEl & { classList?: { contains(c: string): boolean } };
let webviews: FakeHostEl[];
let dark = false;
let seenModals = 0;
const PLUGIN_DIR = ".obsidian/plugins/obsidian-vscode-workbench";
const MODAL_ACCEPT = "Accept and download";

function makeApp(root: string): MockApp {
  const a = {
    vault: {
      adapter: new FileSystemAdapter(root),
      configDir: ".obsidian",
      getAbstractFileByPath: (p: string) => (fs.existsSync(path.join(root, p)) ? new TFile(p) : null),
      on: (name: string, cb: (...args: any[]) => void) => ({ name, cb }),
    },
    workspace: {
      // The old drawer mounts at layout-ready and needs a real DOM; these tests are about the new host only.
      onLayoutReady: () => undefined,
      activeFile: null as TFile | null,
      leaves: [] as WorkspaceLeaf[],
      getActiveFile: () => a.workspace.activeFile,
      getLeavesOfType: () => [] as WorkspaceLeaf[],
      getLeaf: () => {
        const l = new WorkspaceLeaf();
        a.workspace.leaves.push(l);
        return l;
      },
      revealLeaf: async () => undefined,
      detachLeavesOfType: () => undefined,
      on: (name: string, cb: (...args: unknown[]) => void) => ({ name, cb }),
    },
    openWithDefaultApp: async () => undefined,
  };
  return a as unknown as MockApp;
}

async function load(env: Record<string, string> = {}, data: Record<string, unknown> = {}): Promise<void> {
  Object.assign(process.env, { FAKE_CODE_NODE: process.execPath, FAKE_CODE_PIDFILE: pidFile, FAKE_CODE_ARGSFILE: argsFile }, env);
  app = makeApp(vault);
  plugin = new VSCodeWorkbenchPlugin(app as never, { id: "obsidian-vscode-workbench", dir: PLUGIN_DIR } as never);
  (plugin as unknown as { pluginData: unknown }).pluginData = { codeCliPath: FAKE_CODE, embed: "iframe", ...data };
  (plugin as unknown as { downloadHostReachable: () => Promise<boolean> }).downloadHostReachable = async () => false;
  await plugin.onload();
}

const serverPids = () => (fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8").split("\n").filter(Boolean).map(Number) : []);
const lastModal = () => Modal.opened[Modal.opened.length - 1] as unknown as { contentEl: FakeNode; close(): void };
const press = (label: string) => {
  const b = lastModal().contentEl.buttons().find((n) => n.text === label);
  if (!b) throw new Error(`no button "${label}" in: ${lastModal().contentEl.buttons().map((x) => x.text)}`);
  b.click();
};
async function onModal(then: () => void): Promise<void> {
  await vi.waitFor(() => expect(Modal.opened.length).toBeGreaterThan(seenModals), { timeout: 3000, interval: 10 });
  seenModals++;
  then();
}
const inner = () => plugin as unknown as { manager: import("../../src/server-manager").ServerManager; data_: Record<string, unknown> };
const host = () => (plugin as unknown as { terminalHost: import("../../src/terminal-host/host-page").TerminalHostPage | null }).terminalHost;
const drawerText = () => body.visibleText();
const token = () => inner().manager.current!.token;

beforeEach(() => {
  vault = tempDir();
  fs.mkdirSync(path.join(vault, path.dirname(SPIKE_FILE)), { recursive: true });
  fs.writeFileSync(path.join(vault, SPIKE_FILE), "import os\n");
  pidFile = path.join(tempDir(), "pids");
  argsFile = path.join(tempDir(), "args.json");
  Plugin.reset();
  Notice.reset();
  Modal.reset();
  seenModals = 0;
  dark = false;
  webviews = [];
  body = new FakeHostEl("body");
  body.classList = { contains: (c: string) => c === "theme-dark" && dark };
  vi.stubGlobal("window", { addEventListener: () => undefined });
  vi.stubGlobal("document", {
    body,
    createElement: (tag: string) => {
      const e = new FakeHostEl(tag);
      if (tag === "webview") {
        e.page = new FakeWorkbenchPage();
        webviews.push(e);
      }
      return e;
    },
  });
});

afterEach(async () => {
  vi.useRealTimers();
  plugin?.onunload();
  await new Promise((r) => setTimeout(r, 400));
  for (const pid of serverPids()) if (isAlive(pid)) process.kill(pid, "SIGKILL");
  for (const k of ["FAKE_CODE_NODE", "FAKE_CODE_PIDFILE", "FAKE_CODE_ARGSFILE", "FAKE_CODE_MODE", "FAKE_CODE_PARTIAL_DIR"]) delete process.env[k];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("G2: reveal starts the server behind the licence modal", () => {
  it("registers the temporary test command, and loading starts nothing", async () => {
    await load();
    expect(Plugin.commands.map((c) => c.id)).toContain("toggle-terminal-host-test");
    expect(Plugin.commands.find((c) => c.id === "toggle-terminal-host-test")!.name).toBe("Toggle terminal host (test)");
    expect(host()).toBeNull();
    expect(serverPids()).toEqual([]);
    expect(Modal.opened).toHaveLength(0);
  });

  it("first reveal: the modal first and nothing started or downloaded; after Accept 'Starting...' then the terminal", async () => {
    await load();
    Plugin.commands.find((c) => c.id === "toggle-terminal-host-test")!.callback!();
    await vi.waitFor(() => expect(Modal.opened).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 200));
    expect(lastModal().contentEl.textContent()).toContain("https://aka.ms/vscode-server-license");
    expect(fs.existsSync(argsFile)).toBe(false);
    expect(serverPids()).toEqual([]);
    expect(webviews).toHaveLength(0);
    expect(host()!.view()).toBe("licence");

    press(MODAL_ACCEPT);
    await vi.waitFor(() => expect(host()!.view()).toBe("starting"));
    await host()!.settled();
    expect(host()!.view()).toBe("running");
    expect(serverPids()).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(argsFile, "utf8"))).toContain("--accept-server-license-terms");
    expect(drawerText()).not.toContain(STARTING_TEXT);
    expect(webviews).toHaveLength(1);
    // the page is the vault root on the same server
    const url = new URL(webviews[0].srcs[webviews[0].srcs.length - 1]);
    expect(url.origin).toBe(inner().manager.current!.baseUrl);
    expect(url.searchParams.get("folder")).toBe(vault);
  });

  it("with the licence already accepted there is no modal, and 'Starting...' is up until the page is ready", async () => {
    await load({}, { serverLicenceAccepted: true });
    plugin.showTerminalHost();
    await vi.waitFor(() => expect(host()!.view()).toBe("starting"));
    expect(drawerText()).toBe(STARTING_TEXT);
    await host()!.settled();
    expect(Modal.opened).toHaveLength(0);
    expect(host()!.view()).toBe("running");
  });
});

describe("E2: licence declined", () => {
  it("Decline: drawer closed, one notice, no download, no process; the next reveal asks again", async () => {
    await load();
    plugin.showTerminalHost();
    await onModal(() => press("Decline"));
    await host()!.settled();
    expect(host()!.view()).toBe("hidden");
    expect(Notice.messages).toHaveLength(1);
    expect(Notice.messages[0]).toContain("needs the VS Code server licence");
    expect(serverPids()).toEqual([]);
    expect(fs.existsSync(argsFile)).toBe(false);
    expect(webviews).toHaveLength(0);
    expect(inner().data_.serverLicenceAccepted).not.toBe(true);

    plugin.showTerminalHost();
    await onModal(() => press(MODAL_ACCEPT));
    await host()!.settled();
    expect(Modal.opened).toHaveLength(2);
    expect(Notice.messages.filter((m) => m.includes("needs the VS Code server licence"))).toHaveLength(1); // no second decline notice
    expect(host()!.view()).toBe("running");
  });

  it("Escape counts as a decline", async () => {
    await load();
    plugin.showTerminalHost();
    await onModal(() => lastModal().close());
    await host()!.settled();
    expect(host()!.view()).toBe("hidden");
    expect(serverPids()).toEqual([]);
  });
});

describe("E1: a failed start keeps the drawer open with the reason and Retry", () => {
  const retryButton = () => body.find("button").find((b) => b.textContent === "Retry")!;

  it("missing binary: the missing-binary reason, then Retry after the install is back reaches the terminal", async () => {
    await load({}, { serverLicenceAccepted: true });
    inner().data_.codeCliPath = path.join(vault, "no-such-code");
    plugin.showTerminalHost();
    await host()!.settled();
    expect(host()!.view()).toBe("error");
    expect(host()!.isVisible()).toBe(true);
    expect(drawerText()).toContain("VS Code was not found. Install Visual Studio Code");
    expect(drawerText()).toContain("Retry");
    expect(webviews).toHaveLength(0);

    inner().data_.codeCliPath = FAKE_CODE;
    retryButton().click();
    await vi.waitFor(() => expect(host()!.view()).toBe("starting"));
    expect(drawerText()).toBe(STARTING_TEXT);
    await host()!.settled();
    expect(host()!.view()).toBe("running");
    expect(webviews).toHaveLength(1);
  });

  it("an instance that fails its start (exit): the exit code and last line, with Retry", async () => {
    await load({ FAKE_CODE_MODE: "exit-plain" }, { serverLicenceAccepted: true });
    plugin.showTerminalHost();
    await host()!.settled();
    expect(host()!.view()).toBe("error");
    expect(drawerText()).toContain("The VS Code server exited with code 5. Last message: fatal: the fake server broke");
    expect(drawerText()).toContain("Retry");

    delete process.env.FAKE_CODE_MODE;
    retryButton().click();
    await host()!.settled();
    expect(host()!.view()).toBe("running");
  });

  it("offline on the first run: the offline-first-run wording with Retry, no old drawer as fallback", async () => {
    const partial = path.join(vault, PLUGIN_DIR, ".server/cli-data/serve-web", "d".repeat(40));
    await load({ FAKE_CODE_MODE: "offline", FAKE_CODE_PARTIAL_DIR: partial }, { serverLicenceAccepted: true });
    plugin.showTerminalHost();
    await host()!.settled();
    expect(host()!.view()).toBe("error");
    expect(drawerText()).toContain("could not be downloaded because the network is unreachable");
    expect(drawerText()).toContain("Retry");
    expect(inner().data_.serverLicenceAccepted).toBe(true);
    expect((plugin as unknown as { terminal: unknown }).terminal).not.toBeNull(); // the old drawer is still the old drawer
    expect(webviews).toHaveLength(0);
  });

  it("Retry while a start is running shares it: one process, one webview", async () => {
    await load({ FAKE_CODE_MODE: "exit-plain" }, { serverLicenceAccepted: true });
    plugin.showTerminalHost();
    await host()!.settled();
    delete process.env.FAKE_CODE_MODE;
    const failedStarts = serverPids().length; // the failed start spawned (and lost) one process
    const retry = retryButton();
    retry.click();
    retry.click();
    plugin.showTerminalHost();
    await host()!.settled();
    expect(serverPids()).toHaveLength(failedStarts + 1);
    expect(webviews).toHaveLength(1);
    expect(host()!.view()).toBe("running");
  });
});

describe("E10 and G17: rapid reveals, hide during a start, and hide/show", () => {
  it("two rapid reveals give one modal, one server and one webview", async () => {
    await load();
    plugin.showTerminalHost();
    plugin.showTerminalHost();
    await onModal(() => press(MODAL_ACCEPT));
    await host()!.settled();
    plugin.showTerminalHost();
    expect(Modal.opened).toHaveLength(1);
    expect(serverPids()).toHaveLength(1);
    expect(webviews).toHaveLength(1);
    expect(body.children).toHaveLength(1);
  });

  it("reveal while the modal is open, then hide and reveal again: one coherent state, one webview", async () => {
    await load();
    plugin.showTerminalHost();
    await vi.waitFor(() => expect(Modal.opened).toHaveLength(1));
    plugin.showTerminalHost();
    plugin.hideTerminalHost();
    plugin.showTerminalHost();
    press(MODAL_ACCEPT);
    await host()!.settled();
    expect(Modal.opened).toHaveLength(1);
    expect(webviews).toHaveLength(1);
    expect(host()!.view()).toBe("running");
  });

  it("hide during 'Starting', show after it finished: the terminal, not a stale Starting", async () => {
    await load({}, { serverLicenceAccepted: true });
    plugin.showTerminalHost();
    await vi.waitFor(() => expect(host()!.view()).toBe("starting"));
    plugin.hideTerminalHost();
    await host()!.settled();
    expect(host()!.view()).toBe("hidden");
    expect(webviews).toHaveLength(1);
    plugin.showTerminalHost();
    expect(host()!.view()).toBe("running");
    expect(drawerText()).not.toContain("Starting");
  });

  it("hide and show keep the same webview element in the same parent, with no reload", async () => {
    await load({}, { serverLicenceAccepted: true });
    plugin.showTerminalHost();
    await host()!.settled();
    const wv = webviews[0];
    const parent = wv.parent;
    const srcs = [...wv.srcs];
    for (let i = 0; i < 3; i++) {
      plugin.hideTerminalHost();
      plugin.showTerminalHost();
    }
    expect(webviews).toEqual([wv]);
    expect(wv.parent).toBe(parent);
    expect(wv.removed).toBe(false);
    expect(wv.srcs).toEqual(srcs);
  });

  it("a reload under the page shows 'terminals lost'", async () => {
    await load({}, { serverLicenceAccepted: true });
    plugin.showTerminalHost();
    await host()!.settled();
    webviews[0].fire("dom-ready");
    expect(drawerText()).toContain(LOST_TEXT);
  });
});

describe("unload", () => {
  it("during the licence modal: no webview, and Accept afterwards starts no server nobody owns", async () => {
    await load();
    plugin.showTerminalHost();
    await vi.waitFor(() => expect(Modal.opened).toHaveLength(1));
    const unloading = plugin.onunload();
    press(MODAL_ACCEPT);
    await unloading;
    await new Promise((r) => setTimeout(r, 400));
    expect(webviews).toHaveLength(0);
    expect(serverPids()).toEqual([]);
    expect(body.children).toHaveLength(0);
  });

  it("during the server start: no webview is left behind and the server is stopped", async () => {
    await load({}, { serverLicenceAccepted: true });
    plugin.showTerminalHost();
    await vi.waitFor(() => expect(host()!.view()).toBe("starting"));
    plugin.onunload();
    await new Promise((r) => setTimeout(r, 800));
    expect(webviews.every((w) => w.removed)).toBe(true);
    expect(body.children).toHaveLength(0);
    for (const pid of serverPids()) expect(isAlive(pid)).toBe(false);
  });

  it("after a run: the webview and the container are removed", async () => {
    await load({}, { serverLicenceAccepted: true });
    plugin.showTerminalHost();
    await host()!.settled();
    plugin.onunload();
    expect(webviews[0].removed).toBe(true);
    expect(body.children).toHaveLength(0);
  });
});

describe("F3: one server", () => {
  it("a Code tab and the host together are one serve-web process, and the host's origin is the Code tab server's baseUrl", async () => {
    await load({}, { serverLicenceAccepted: true });
    await plugin.openSpikeFile();
    plugin.showTerminalHost();
    await host()!.settled();
    expect(serverPids()).toHaveLength(1);
    expect(new URL(webviews[0].srcs[webviews[0].srcs.length - 1]).origin).toBe(inner().manager.current!.baseUrl);
  });

  it("the host's start with a Code tab already starting shares that start", async () => {
    await load({}, { serverLicenceAccepted: true });
    const opening = plugin.openSpikeFile();
    plugin.showTerminalHost();
    await Promise.all([opening, host()!.settled()]);
    expect(serverPids()).toHaveLength(1);
    expect(host()!.view()).toBe("running");
  });
});

describe("G5: the theme follows Obsidian without a reload", () => {
  const cssChange = () => Plugin.events.filter((e) => e.name === "css-change")[0];

  it("a flip to dark re-themes the running page in place, with no new load", async () => {
    await load({}, { serverLicenceAccepted: true });
    plugin.showTerminalHost();
    await host()!.settled();
    const wv = webviews[0];
    const loads = wv.srcs.length;
    dark = true;
    cssChange().cb();
    await vi.waitFor(() => expect(wv.page!.themeScripts).toHaveLength(1));
    expect(wv.page!.themeScripts[0]).toContain("Dark Modern");
    expect(wv.srcs).toHaveLength(loads);
    expect(webviews).toEqual([wv]);
    expect(host()!.view()).toBe("running");
  });

  it("a css-change that is not a light/dark flip sends the page nothing", async () => {
    await load({}, { serverLicenceAccepted: true });
    plugin.showTerminalHost();
    await host()!.settled();
    for (let i = 0; i < 5; i++) cssChange().cb();
    await new Promise((r) => setTimeout(r, 100));
    expect(webviews[0].page!.themeScripts).toEqual([]);
  });
});

describe("the connection token", () => {
  it("is in no drawer text, notice or log line across a start, a failure, a retry, a hide and a reload", async () => {
    const spies = (["log", "info", "warn", "debug", "error"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    await load({ FAKE_CODE_MODE: "exit-early" }, { serverLicenceAccepted: true });
    plugin.showTerminalHost();
    await host()!.settled();
    expect(host()!.view()).toBe("error");
    expect(drawerText()).not.toMatch(/tkn=|secret [0-9a-f]{20}/);
    delete process.env.FAKE_CODE_MODE;
    body.find("button").find((b) => b.textContent === "Retry")!.click();
    await host()!.settled();
    plugin.hideTerminalHost();
    plugin.showTerminalHost();
    webviews[0].fire("dom-ready");
    const tkn = token();
    expect(tkn.length).toBeGreaterThan(20);
    expect(drawerText()).not.toContain(tkn);
    for (const m of Notice.messages) expect(m).not.toContain(tkn);
    for (const spy of spies) for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain(tkn);
    // the token reaches the page only as the URL's tkn, and no script carries it
    for (const code of webviews[0].executed) expect(code).not.toContain(tkn);
    expect(webviews[0].srcs[webviews[0].srcs.length - 1]).toContain(`tkn=${tkn}`);
  });
});
