/**
 * The "New terminal at folder" menu item (G8): what the file explorer's right-click menu gets, and when. The wiring is
 * tested through the real plugin (`onload` registers the `file-menu` handler with `registerEvent`) with a fake `Menu`, `TFolder`
 * and `TFile` from the mocked `obsidian` module; the rules for the folder are tested on the menu module alone.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileSystemAdapter, Menu, Plugin, TFile, TFolder, WorkspaceLeaf, type MockApp } from "../mocks/obsidian";
import * as obsidian from "../mocks/obsidian";
import VSCodeWorkbenchPlugin from "../../src/main";
import { FILE_EXPLORER_SOURCE, NEW_TERMINAL_ICON, NEW_TERMINAL_TITLE, addNewTerminalItem, folderPathOf } from "../../src/terminal/new-terminal-menu";
import { tempDir } from "../helpers";

function makeApp(root: string): MockApp {
  const a = {
    vault: {
      adapter: new FileSystemAdapter(root),
      configDir: ".obsidian",
      getAbstractFileByPath: () => null,
      on: (name: string, cb: (...args: any[]) => void) => ({ name, cb }),
    },
    workspace: {
      onLayoutReady: () => undefined,
      activeFile: null as TFile | null,
      leaves: [] as WorkspaceLeaf[],
      getActiveFile: () => null,
      getLeavesOfType: () => [] as WorkspaceLeaf[],
      getLeaf: () => new WorkspaceLeaf(),
      revealLeaf: async () => undefined,
      detachLeavesOfType: () => undefined,
      on: (name: string, cb: (...args: unknown[]) => void) => ({ name, cb }),
    },
  };
  return a as unknown as MockApp;
}

const folder = (p: string, parent?: TFolder): TFolder => {
  const f = new TFolder(p);
  f.parent = parent ?? null;
  return f;
};
const root = () => folder("/");
const fileIn = (p: string, parent: TFolder): TFile => {
  const f = new TFile(p);
  f.parent = parent;
  return f;
};

describe("which folder the item acts on", () => {
  it("a folder acts on itself", () => {
    expect(folderPathOf(folder("HackerRank Mini-Course/_internals", folder("HackerRank Mini-Course", root())))).toBe("HackerRank Mini-Course/_internals");
  });

  it("the vault root (a TFolder that isRoot) is the empty folder path", () => {
    expect(root().isRoot()).toBe(true);
    expect(folderPathOf(root())).toBe("");
  });

  it("a file acts on its parent folder", () => {
    const parent = folder("日本語 folder/sub", folder("日本語 folder", root()));
    expect(folderPathOf(fileIn("日本語 folder/sub/a.py", parent))).toBe("日本語 folder/sub");
  });

  it("a file at the top level acts on the vault root", () => {
    expect(folderPathOf(fileIn("note.md", root()))).toBe("");
  });

  it("a file with no parent known acts on the vault root", () => {
    expect(folderPathOf(new TFile("orphan.md"))).toBe("");
  });
});

describe("addNewTerminalItem on a menu", () => {
  it("adds one item with the title and the terminal icon for the file explorer's menu, and choosing it opens that folder", () => {
    const menu = new Menu();
    const opened: string[] = [];
    expect(addNewTerminalItem(menu, folder("Café Notes", root()), FILE_EXPLORER_SOURCE, (f) => opened.push(f))).toBe(true);
    expect(menu.items).toHaveLength(1);
    expect(menu.items[0].title).toBe("New terminal at folder");
    expect(menu.items[0].icon).toBe("terminal");
    expect(NEW_TERMINAL_TITLE).toBe("New terminal at folder");
    expect(NEW_TERMINAL_ICON).toBe("terminal");
    expect(opened).toEqual([]); // adding the item opens nothing
    menu.items[0].click();
    expect(opened).toEqual(["Café Notes"]);
  });

  it.each(["tab-header", "more-options", "link-context-menu", "editor-menu", "", "file-explorer"])("adds nothing to the menu whose source is %j", (source) => {
    const menu = new Menu();
    expect(addNewTerminalItem(menu, folder("a", root()), source, () => undefined)).toBe(false);
    expect(menu.items).toEqual([]);
  });

  it("the file explorer's source is the one Obsidian gives its right-click menu", () => {
    expect(FILE_EXPLORER_SOURCE).toBe("file-explorer-context-menu");
  });
});

describe("the plugin's wiring", () => {
  let vault: string;
  let plugin: VSCodeWorkbenchPlugin;
  const handlers = (name: string) => Plugin.events.filter((e) => e.name === name).map((e) => e.cb);

  beforeEach(() => {
    vault = tempDir();
    Plugin.reset();
    obsidian.Platform.isDesktopApp = true;
    vi.stubGlobal("window", { addEventListener: () => undefined, innerHeight: 900 });
    vi.stubGlobal("document", { body: {}, addEventListener: () => undefined, createElement: () => ({}) });
  });
  afterEach(() => {
    plugin?.onunload();
    obsidian.Platform.isDesktopApp = true;
    vi.unstubAllGlobals();
  });

  async function load(): Promise<void> {
    plugin = new VSCodeWorkbenchPlugin(makeApp(vault) as never, { id: "vscode-workbench", dir: ".obsidian/plugins/vscode-workbench" } as never);
    (plugin as unknown as { pluginData: unknown }).pluginData = {};
    await plugin.onload();
  }

  it("registers one file-menu handler with registerEvent and no files-menu handler", async () => {
    await load();
    expect(handlers("file-menu")).toHaveLength(1);
    expect(handlers("files-menu")).toEqual([]);
  });

  it("the handler adds the item on a folder, on a file's parent and on the vault root, from the file explorer only", async () => {
    await load();
    const [onMenu] = handlers("file-menu");
    const inner = folder("HackerRank Mini-Course/_internals", folder("HackerRank Mini-Course", root()));
    const cases: Array<[string, obsidian.TFile | TFolder, string, number]> = [
      ["folder", inner, FILE_EXPLORER_SOURCE, 1],
      ["file", fileIn("HackerRank Mini-Course/_internals/a.py", inner), FILE_EXPLORER_SOURCE, 1],
      ["root", root(), FILE_EXPLORER_SOURCE, 1],
      ["tab header", fileIn("note.md", root()), "tab-header", 0],
      ["more options", inner, "more-options", 0],
      ["link menu", fileIn("note.md", root()), "link-context-menu", 0],
    ];
    for (const [, target, source, items] of cases) {
      const menu = new Menu();
      onMenu(menu, target, source);
      expect(menu.items).toHaveLength(items);
    }
  });

  it("is desktop only: with Platform.isDesktopApp false, no handler is registered", async () => {
    obsidian.Platform.isDesktopApp = false;
    await load();
    expect(handlers("file-menu")).toEqual([]);
  });

  it("after unload the handler adds nothing", async () => {
    await load();
    const [onMenu] = handlers("file-menu");
    plugin.onunload();
    const menu = new Menu();
    onMenu(menu, folder("a", root()), FILE_EXPLORER_SOURCE);
    expect(menu.items).toEqual([]);
  });

  it("the plugin draws no other control for this item: its only command is the existing drawer toggle", async () => {
    await load();
    expect(Plugin.commands.map((c) => c.id).sort()).toEqual(["open-spike-file", "toggle-terminal-drawer"]);
    expect(fs.existsSync(path.join(vault, ".obsidian"))).toBe(false); // loading wrote nothing into the vault
  });
});
