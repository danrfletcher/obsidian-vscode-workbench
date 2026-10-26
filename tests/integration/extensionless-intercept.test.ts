/**
 * Extensionless files and dotfiles (G7): a simulated explorer click on Makefile,
 * Dockerfile and .env, through the interceptor alone and through the real plugin
 * class. Both the intercept path and the fallback path of the spike decision are
 * asserted; the plugin's default mode is checked against the decision header.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileSystemAdapter, Notice, Plugin, TFile, WorkspaceLeaf, type MockApp } from "../mocks/obsidian";
import VSCodeWorkbenchPlugin from "../../src/main";
import {
  DEFAULT_EXTENSIONLESS_MODE,
  FILE_ROW_SELECTOR,
  SYSTEM_APP_NOTICE,
  createClickInterceptor,
  readMode,
  type ExtensionlessMode,
  type InterceptHost,
} from "../../src/extensionless-intercept";
import { parseDecision } from "../decision";
import { FAKE_CODE, REPO_ROOT, isAlive, tempDir } from "../helpers";

/** A click on the explorer row for `vaultPath` (or on something that is not a row). */
function click(vaultPath: string | null, o: { button?: number; inRow?: boolean } = {}) {
  const row = vaultPath === null ? null : { getAttribute: (n: string) => (n === "data-path" ? vaultPath : null) };
  const target = {
    closest: (selector: string) => (selector === FILE_ROW_SELECTOR && (o.inRow ?? true) ? row : null),
  };
  const ev = { button: o.button ?? 0, target, preventDefault: vi.fn(), stopPropagation: vi.fn() };
  return ev;
}

function fakeHost(mode: ExtensionlessMode, o: { openFails?: boolean; excluded?: string[] } = {}) {
  const host = {
    mode: () => mode,
    excluded: () => o.excluded ?? [],
    openInCodeTab: vi.fn(async (_p: string) => {
      if (o.openFails) throw new Error("no tab");
    }),
    openInSystemApp: vi.fn(),
    notice: vi.fn(),
  };
  return host satisfies InterceptHost;
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("the interceptor: intercept mode (the spike decision's default)", () => {
  it.each(["Makefile", "Dockerfile", ".env", ".gitignore", "build/Dockerfile", "scripts/.env"])("a click on %s opens a Code tab and stops Obsidian's own handling", async (p) => {
    const host = fakeHost("intercept");
    const ev = click(p);
    createClickInterceptor(host)(ev);
    await settle();
    expect(ev.preventDefault).toHaveBeenCalledTimes(1);
    expect(ev.stopPropagation).toHaveBeenCalledTimes(1);
    expect(host.openInCodeTab).toHaveBeenCalledWith(p);
    expect(host.openInSystemApp).not.toHaveBeenCalled();
    expect(host.notice).not.toHaveBeenCalled();
  });

  it("falls back to the system app with a notice when the Code tab cannot open (never a blank tab)", async () => {
    const host = fakeHost("intercept", { openFails: true });
    createClickInterceptor(host)(click("Makefile"));
    await settle();
    expect(host.openInCodeTab).toHaveBeenCalledWith("Makefile");
    expect(host.notice).toHaveBeenCalledWith(SYSTEM_APP_NOTICE);
    expect(host.openInSystemApp).toHaveBeenCalledWith("Makefile");
  });
});

describe("the interceptor: system-app fallback mode (interception does not give a Code tab)", () => {
  it.each(["Makefile", "Dockerfile", ".env"])("a click on %s opens the system app with a notice and no Code tab", async (p) => {
    const host = fakeHost("system-app");
    const ev = click(p);
    createClickInterceptor(host)(ev);
    await settle();
    expect(ev.preventDefault).toHaveBeenCalledTimes(1);
    expect(host.openInCodeTab).not.toHaveBeenCalled();
    expect(host.notice).toHaveBeenCalledWith(SYSTEM_APP_NOTICE);
    expect(host.openInSystemApp).toHaveBeenCalledWith(p);
  });

  it("the notice says why and that nothing is left blank", () => {
    expect(SYSTEM_APP_NOTICE).toMatch(/no extension/);
    expect(SYSTEM_APP_NOTICE).toMatch(/system's app/);
  });
});

describe("the interceptor leaves everything else to Obsidian", () => {
  it.each([
    ["a file with an extension", click("scripts/a.py")],
    ["a markdown note", click("Notes/day.md")],
    ["a hidden-folder file", click(".git/config")],
    ["an excluded-extension file (still has an extension)", click("a.zig")],
    ["a right click", click("Makefile", { button: 2 })],
    ["a middle click", click("Makefile", { button: 1 })],
    ["a click outside the explorer rows", click("Makefile", { inRow: false })],
    ["a click on nothing", click(null)],
  ])("%s", async (_n, ev) => {
    const host = fakeHost("intercept", { excluded: ["zig"] });
    createClickInterceptor(host)(ev);
    await settle();
    expect(ev.preventDefault).not.toHaveBeenCalled();
    expect(ev.stopPropagation).not.toHaveBeenCalled();
    expect(host.openInCodeTab).not.toHaveBeenCalled();
    expect(host.openInSystemApp).not.toHaveBeenCalled();
  });

  it("copes with a target that is not an element", () => {
    const host = fakeHost("intercept");
    const ev = { button: 0, target: null, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    expect(() => createClickInterceptor(host)(ev)).not.toThrow();
    expect(ev.preventDefault).not.toHaveBeenCalled();
  });
});

describe("the spike decision", () => {
  it("the plugin starts in the mode docs/spike-decision.md records", () => {
    const decision = parseDecision(fs.readFileSync(path.join(REPO_ROOT, "docs/spike-decision.md"), "utf8"));
    expect(decision.extensionless).toBe(DEFAULT_EXTENSIONLESS_MODE);
  });

  it("readMode accepts the two modes and falls back to the default for anything else", () => {
    expect(readMode("intercept")).toBe("intercept");
    expect(readMode("system-app")).toBe("system-app");
    for (const v of [undefined, null, "", "nope", 3, {}]) expect(readMode(v)).toBe(DEFAULT_EXTENSIONLESS_MODE);
  });
});

// --- through the real plugin class ------------------------------------------

let vault: string;
let pidFile: string;
let plugin: VSCodeWorkbenchPlugin;
let app: MockApp;
let created: WorkspaceLeaf[];
let systemApp: string[];
let docListeners: Array<{ name: string; cb: (ev: unknown) => void; options: unknown }>;

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
      activeFile: null,
      leaves: [],
      getActiveFile: () => null,
      getLeavesOfType: (type: string) => created.filter((l) => !l.detached && l.viewState?.type === type),
      getLeaf: () => {
        const l = new WorkspaceLeaf();
        created.push(l);
        return l;
      },
      revealLeaf: async () => undefined,
      detachLeavesOfType: () => undefined,
      on: (name: string, cb: (...args: any[]) => void) => ({ name, cb }),
    },
    openWithDefaultApp: async (p: string) => void systemApp.push(p),
  };
  return a as unknown as MockApp;
}

async function load(data: Record<string, unknown> = {}): Promise<void> {
  Object.assign(process.env, { FAKE_CODE_NODE: process.execPath, FAKE_CODE_PIDFILE: pidFile });
  app = makeApp(vault);
  plugin = new VSCodeWorkbenchPlugin(app as never, { id: "obsidian-vscode-workbench", dir: ".obsidian/plugins/obsidian-vscode-workbench" } as never);
  (plugin as unknown as { pluginData: unknown }).pluginData = { codeCliPath: FAKE_CODE, embed: "iframe", serverLicenceAccepted: true, ...data };
  await plugin.onload();
}

/** Deliver a click to every click listener the plugin put on `document`. */
function clickInDocument(ev: ReturnType<typeof click>): void {
  for (const l of docListeners.filter((x) => x.name === "click")) l.cb(ev);
}

const serverPids = () => (fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8").split("\n").filter(Boolean).map(Number) : []);

describe("through the plugin (explorer click)", () => {
  beforeEach(() => {
    vault = tempDir();
    pidFile = path.join(tempDir(), "pids");
    created = [];
    systemApp = [];
    docListeners = [];
    Plugin.reset();
    Notice.reset();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.stubGlobal("window", { addEventListener: () => undefined });
    vi.stubGlobal("document", {
      body: { classList: { contains: () => false } },
      addEventListener: (name: string, cb: (ev: unknown) => void, options: unknown) => docListeners.push({ name, cb, options }),
    });
    for (const f of ["Makefile", "Dockerfile", ".env", ".gitignore", "a.py"]) fs.writeFileSync(path.join(vault, f), "x\n");
  });

  afterEach(async () => {
    plugin?.onunload();
    await new Promise((r) => setTimeout(r, 400));
    for (const pid of serverPids()) if (isAlive(pid)) process.kill(pid, "SIGKILL");
    for (const k of ["FAKE_CODE_NODE", "FAKE_CODE_PIDFILE"]) delete process.env[k];
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("listens for clicks on the document in the capture phase", async () => {
    await load();
    const l = docListeners.filter((x) => x.name === "click");
    expect(l).toHaveLength(1);
    expect(l[0].options).toBe(true);
  });

  it.each(["Makefile", "Dockerfile", ".env", ".gitignore"])("intercept path: a click on %s opens one Code tab holding only the path", async (p) => {
    await load();
    const ev = click(p);
    clickInDocument(ev);
    await vi.waitFor(() => expect(created).toHaveLength(1), { timeout: 5000 });
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(created[0].viewState).toEqual({ type: "vscode-workbench-code", state: { file: p }, active: true });
    expect(systemApp).toEqual([]);
  });

  it("intercept path: clicking the same file again adds no tab", async () => {
    await load();
    clickInDocument(click("Makefile"));
    await vi.waitFor(() => expect(created).toHaveLength(1), { timeout: 5000 });
    clickInDocument(click("Makefile"));
    clickInDocument(click("Makefile"));
    await new Promise((r) => setTimeout(r, 50));
    expect(created).toHaveLength(1);
  });

  it("fallback path (extensionlessMode: system-app): the file opens in the system app with a notice and no tab", async () => {
    await load({ extensionlessMode: "system-app" });
    const ev = click("Dockerfile");
    clickInDocument(ev);
    await vi.waitFor(() => expect(systemApp).toEqual(["Dockerfile"]));
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(Notice.messages).toContain(SYSTEM_APP_NOTICE);
    expect(created).toHaveLength(0);
    expect(serverPids()).toEqual([]); // nothing was started for a file that goes to the system app
  });

  it("a click on a file with an extension is left to Obsidian", async () => {
    await load();
    const ev = click("a.py");
    clickInDocument(ev);
    await new Promise((r) => setTimeout(r, 20));
    expect(ev.preventDefault).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
  });

  it("a huge or binary extensionless file is refused like any other (notice, system app, no tab)", async () => {
    fs.writeFileSync(path.join(vault, "blob"), Buffer.from([0x61, 0, 0x62]));
    await load();
    clickInDocument(click("blob"));
    await vi.waitFor(() => expect(systemApp).toEqual(["blob"]));
    expect(created).toHaveLength(0);
    expect(Notice.messages.join("\n")).toMatch(/binary/);
  });

  it("the Code tab falling over takes the fallback path", async () => {
    await load();
    vi.spyOn(plugin, "openCodeFile").mockRejectedValue(new Error("boom"));
    clickInDocument(click("Makefile"));
    await vi.waitFor(() => expect(systemApp).toEqual(["Makefile"]));
    expect(Notice.messages).toContain(SYSTEM_APP_NOTICE);
  });
});
