/**
 * Extension registration through the real plugin class with a mocked Obsidian:
 * the start scan, the create/rename events, refusal when another plugin owns an
 * extension (E7), and coexistence with Code Files, VSCode Editor and Code
 * Workbench (F8). The mock `registerExtensions` behaves like Obsidian's: it
 * throws for an extension that already has a view type.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileSystemAdapter, Notice, Plugin, TFile, WorkspaceLeaf, type MockApp } from "../mocks/obsidian";
import VSCodeWorkbenchPlugin from "../../src/main";
import { tempDir } from "../helpers";

let vault: string;
let plugin: VSCodeWorkbenchPlugin;
let app: MockApp;
let info: { mock: { calls: unknown[][] } };

function makeApp(root: string, owners: Record<string, string> = {}): MockApp {
  return {
    vault: {
      adapter: new FileSystemAdapter(root),
      configDir: ".obsidian",
      getAbstractFileByPath: () => null,
      on: (name, cb) => ({ name, cb }),
    },
    viewRegistry: { typeByExtension: { ...owners } },
    workspace: {
      onLayoutReady: (cb: () => void) => cb(),
      activeFile: null,
      leaves: [],
      getActiveFile: () => null,
      getLeavesOfType: () => [] as WorkspaceLeaf[],
      getLeaf: () => new WorkspaceLeaf(),
      revealLeaf: async () => undefined,
      detachLeavesOfType: () => undefined,
      on: (name, cb) => ({ name, cb }),
    },
  };
}

async function load(owners: Record<string, string> = {}, data: Record<string, unknown> = {}): Promise<void> {
  app = makeApp(vault, owners);
  plugin = new VSCodeWorkbenchPlugin(app as never, { id: "obsidian-vscode-workbench", dir: ".obsidian/plugins/obsidian-vscode-workbench" } as never);
  (plugin as unknown as { pluginData: unknown }).pluginData = { serverLicenceAccepted: true, ...data };
  await plugin.onload();
  await plugin.rescanExtensions(); // joins the scan onload started
}

function write(...files: string[]): void {
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(vault, f)), { recursive: true });
    fs.writeFileSync(path.join(vault, f), "x");
  }
}

const registered = () => Plugin.registrations.flatMap((r) => r.extensions).sort();
const fire = (name: string, file: TFile) => {
  const handlers = Plugin.events.filter((e) => e.name === name);
  expect(handlers.length, `a ${name} handler`).toBeGreaterThan(0);
  for (const h of handlers) h.cb(file);
};

beforeEach(() => {
  vault = tempDir();
  Plugin.reset();
  Notice.reset();
  info = vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.stubGlobal("window", { addEventListener: () => undefined });
  vi.stubGlobal("document", { body: { classList: { contains: () => false } } });
});

afterEach(() => {
  plugin?.onunload();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("start scan (GP1)", () => {
  it("registers every extension in the vault against the Code tab view type, and logs the set", async () => {
    write("Mock Exams/scripts/estimate_time.py", "src/app.TS", "notes.zig", "data.csv", "package.json", "Makefile", ".env");
    await load();
    expect(registered()).toEqual(["csv", "json", "py", "ts", "zig"]);
    expect(Plugin.registrations.every((r) => r.viewType === "vscode-workbench-code")).toBe(true);
    // The registered set is in the dev console and matches the scan.
    const lines = info.mock.calls.map((c) => String(c[0]));
    const scanned = lines.find((l) => l.includes("found 5 extensions"));
    const logged = lines.filter((l) => l.includes("registered extensions (5): csv, json, py, ts, zig"));
    expect(scanned).toContain("csv, json, py, ts, zig");
    expect(logged.length).toBeGreaterThan(0);
  });

  it("never passes md, canvas, base or a binary extension to the registration call (F6)", async () => {
    write("a.md", "b.canvas", "c.base", "d.png", "e.jpg", "f.pdf", "g.zip", "h.mp3", "i.mp4", "ok.rs");
    const calls: string[][] = [];
    const real = Plugin.prototype.registerExtensions;
    vi.spyOn(Plugin.prototype, "registerExtensions").mockImplementation(function (this: Plugin, e: string[], t: string) {
      calls.push(e);
      return real.call(this, e, t);
    });
    await load();
    plugin.registerExtensions(["pdf"], "x"); // sanity: the spy sees direct calls too
    expect(calls.flat().filter((e) => e !== "pdf")).toEqual(["rs"]);
  });

  it("skips hidden folders: .obsidian, .git and node_modules extensions are not registered", async () => {
    write(".obsidian/plugins/x/main.css", ".git/hooks/a.sample", "node_modules/p/i.kt", "ok.go");
    await load();
    expect(registered()).toEqual(["go"]);
  });

  it("does not block onload: the scan runs after it returns", async () => {
    write("a.py");
    app = makeApp(vault);
    plugin = new VSCodeWorkbenchPlugin(app as never, { id: "obsidian-vscode-workbench", dir: ".obsidian/plugins/obsidian-vscode-workbench" } as never);
    await plugin.onload();
    expect(registered()).toEqual([]); // nothing yet: the walk has only started
    await plugin.rescanExtensions();
    expect(registered()).toEqual(["py"]);
  });

  it("the user's exclude list: those extensions are never registered, and the scan skips them", async () => {
    write("a.py", "b.ts", "c.zig");
    await load({}, { excludeExtensions: ["py", "ZIG"] });
    expect(registered()).toEqual(["ts"]);
    expect(info.mock.calls.map((c) => String(c[0])).join("\n")).not.toMatch(/found .*\bpy\b/);
  });

  it("a second scan registers nothing twice", async () => {
    write("a.py");
    await load();
    await plugin.rescanExtensions();
    expect(Plugin.registrations).toHaveLength(1);
  });

  it("a scan that fails is logged and does not throw", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    app = makeApp(path.join(vault, "does-not-exist"));
    plugin = new VSCodeWorkbenchPlugin(app as never, { id: "obsidian-vscode-workbench", dir: ".obsidian/plugins/obsidian-vscode-workbench" } as never);
    await plugin.onload().catch(() => undefined);
    await expect(plugin.rescanExtensions()).resolves.toBeUndefined();
    expect(registered()).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });
});

describe("files that appear later (GP1)", () => {
  it("a created file with a new extension becomes registered without a reload", async () => {
    write("a.py");
    await load();
    expect(registered()).toEqual(["py"]);
    fire("create", new TFile("notes.zig"));
    expect(registered()).toEqual(["py", "zig"]);
  });

  it("a file renamed to a new extension is registered by the rename event", async () => {
    await load();
    fire("rename", new TFile("thing.rs"));
    expect(registered()).toEqual(["rs"]);
  });

  it("is picked up by the next scan too (a file made outside Obsidian)", async () => {
    write("a.py");
    await load();
    write("later.zig");
    await plugin.rescanExtensions();
    expect(registered()).toEqual(["py", "zig"]);
  });

  it("events for md, binaries, hidden paths, excluded extensions and known extensions register nothing", async () => {
    write("a.py");
    await load({}, { excludeExtensions: ["lua"] });
    const before = Plugin.registrations.length;
    for (const p of ["n.md", "b.canvas", "i.png", ".git/x.rb", "node_modules/y.rb", "s.lua", "again.py", "Makefile"]) fire("create", new TFile(p));
    expect(Plugin.registrations).toHaveLength(before);
  });

  it("ignores a folder event", async () => {
    await load();
    for (const h of Plugin.events.filter((e) => e.name === "create")) h.cb({ path: "dir.zig", children: [] });
    expect(registered()).toEqual([]);
  });
});

describe("another plugin owns an extension (E7)", () => {
  it("refuses that extension only, names the owner in a notice, and registers the rest", async () => {
    write("a.py", "b.ts", "c.rs");
    await load({ py: "code-editor" });
    expect(registered()).toEqual(["rs", "ts"]);
    expect(Notice.messages).toHaveLength(1);
    expect(Notice.messages[0]).toMatch(/Code Files/);
    expect(Notice.messages[0]).toMatch(/\.py/);
    expect(Notice.messages[0]).not.toMatch(/\.ts|\.rs/);
    expect(app.viewRegistry?.typeByExtension.py).toBe("code-editor"); // theirs, untouched
  });

  it("names an unrecognised owner by its view type", async () => {
    write("a.py");
    await load({ py: "some-other-view" });
    expect(Notice.messages[0]).toMatch(/another plugin \(view type "some-other-view"\)/);
  });

  it("does not throw or leave a half-registered state when the registration call itself throws", async () => {
    write("a.py", "b.ts", "c.rs");
    // The lookup cannot see the owner (no registry), then the call throws for one extension.
    const real = Plugin.prototype.registerExtensions;
    vi.spyOn(Plugin.prototype, "registerExtensions").mockImplementation(function (this: Plugin, e: string[], t: string) {
      if (e.includes("ts")) throw new Error('Attempting to register an existing view extension "ts"');
      return real.call(this, e, t);
    });
    await load();
    expect(registered()).toEqual(["py", "rs"]);
    expect(Notice.messages).toHaveLength(1);
    expect(Notice.messages[0]).toMatch(/\.ts/);
    expect(Notice.messages[0]).toMatch(/another plugin/);
  });

  it("works when Obsidian's private view registry is missing", async () => {
    write("a.py");
    app = makeApp(vault);
    delete app.viewRegistry;
    plugin = new VSCodeWorkbenchPlugin(app as never, { id: "obsidian-vscode-workbench", dir: ".obsidian/plugins/obsidian-vscode-workbench" } as never);
    await plugin.onload();
    await plugin.rescanExtensions();
    expect(registered()).toEqual(["py"]);
  });

  it("the notice shows once per extension per session, not on every scan or file event", async () => {
    write("a.py", "b.ts");
    await load({ py: "code-editor" });
    expect(Notice.messages).toHaveLength(1);
    await plugin.rescanExtensions();
    await plugin.rescanExtensions();
    fire("create", new TFile("more.py"));
    fire("rename", new TFile("again.py"));
    expect(Notice.messages).toHaveLength(1);
    // A different extension owned by the same plugin is a new refusal and gets its own notice.
    app.viewRegistry!.typeByExtension.go = "code-editor";
    write("x.go");
    await plugin.rescanExtensions();
    expect(Notice.messages).toHaveLength(2);
    expect(Notice.messages[1]).toMatch(/\.go/);
    expect(Notice.messages[1]).not.toMatch(/\.py/);
  });

  it("an extension freed later is registered by the next scan", async () => {
    write("a.py");
    await load({ py: "code-editor" });
    expect(registered()).toEqual([]);
    delete app.viewRegistry!.typeByExtension.py;
    await plugin.rescanExtensions();
    expect(registered()).toEqual(["py"]);
  });

  it("an extension Obsidian itself owns (svg) is left alone without a notice", async () => {
    write("logo.svg", "a.py");
    await load({ svg: "image" });
    expect(registered()).toEqual(["py"]);
    expect(Notice.messages).toEqual([]);
    expect(app.viewRegistry!.typeByExtension.svg).toBe("image");
  });
});

describe("coexistence with the other code editors (F8)", () => {
  const owners = { py: "code-editor", ts: "vscode-editor", rs: "code-workbench" };

  it("no extension is stolen, nothing crashes, every refusal has a notice naming its owner", async () => {
    write("a.py", "b.ts", "c.rs", "d.go", "e.json");
    await load(owners);
    expect(registered()).toEqual(["go", "json"]);
    expect(app.viewRegistry!.typeByExtension).toMatchObject(owners);
    const text = Notice.messages.join("\n");
    expect(Notice.messages).toHaveLength(3);
    expect(text).toMatch(/Code Files already opens \.py/);
    expect(text).toMatch(/VSCode Editor already opens \.ts/);
    expect(text).toMatch(/Code Workbench already opens \.rs/);
  });

  it("several extensions owned by one plugin are named in one notice, each once", async () => {
    write("a.py", "b.ts", "c.js", "d.go");
    await load({ py: "code-editor", ts: "code-editor", js: "code-editor" });
    expect(registered()).toEqual(["go"]);
    expect(Notice.messages).toHaveLength(1);
    for (const e of ["py", "ts", "js"]) expect(Notice.messages[0].split(`.${e}`)).toHaveLength(2);
  });

  it("never edits another plugin's registration or settings: only this plugin's own registerExtensions is called", async () => {
    write("a.py", "b.go");
    const unregister = vi.fn();
    app = makeApp(vault, { py: "code-editor" });
    (app.viewRegistry as unknown as { unregisterExtensions: unknown }).unregisterExtensions = unregister;
    plugin = new VSCodeWorkbenchPlugin(app as never, { id: "obsidian-vscode-workbench", dir: ".obsidian/plugins/obsidian-vscode-workbench" } as never);
    await plugin.onload();
    await plugin.rescanExtensions();
    expect(unregister).not.toHaveBeenCalled();
    expect(app.viewRegistry!.typeByExtension.py).toBe("code-editor");
    expect(registered()).toEqual(["go"]);
    expect(Plugin.registrations).toEqual([{ extensions: ["go"], viewType: "vscode-workbench-code" }]);
  });
});

describe("registration waits for layout-ready (F8)", () => {
  it("registers nothing at onload; a plugin that loads later and registers py first is not broken, and py is left to it", async () => {
    write("a.py", "b.go");
    app = makeApp(vault);
    const layoutReady: Array<() => void> = [];
    app.workspace.onLayoutReady = (cb) => void layoutReady.push(cb);
    plugin = new VSCodeWorkbenchPlugin(app as never, { id: "obsidian-vscode-workbench", dir: ".obsidian/plugins/obsidian-vscode-workbench" } as never);
    (plugin as unknown as { pluginData: unknown }).pluginData = { serverLicenceAccepted: true };
    await plugin.onload();
    expect(layoutReady).toHaveLength(1);

    // Community plugins still loading: Code Files loads after this plugin and registers py itself. Its call must succeed.
    const codeFiles = new Plugin(app, { id: "code-editor" });
    expect(() => codeFiles.registerExtensions(["py"], "code-editor")).not.toThrow();
    // Nothing of ours was registered, and no create/rename handler runs before then either.
    expect(registered()).toEqual(["py"]);
    expect(Plugin.events.filter((e) => e.name === "create" || e.name === "rename")).toEqual([]);

    layoutReady.forEach((cb) => cb());
    await plugin.rescanExtensions();
    expect(registered()).toEqual(["go", "py"]);
    expect(app.viewRegistry!.typeByExtension.py).toBe("code-editor");
    expect(Notice.messages.join("\n")).toMatch(/Code Files already opens \.py/);
  });
});
