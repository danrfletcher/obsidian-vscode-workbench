/**
 * The file path above a Code tab's editor (a note shows its folder path as header breadcrumbs; a Code tab did not), and the click that
 * reveals a folder in the file explorer. Driven through the real CodeView and the real plugin class.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FILE_EXPLORER_SOURCE, NEW_TERMINAL_TITLE } from "../../src/terminal/new-terminal-menu";
import { Menu, Plugin, TFolder, WorkspaceLeaf, tooltips } from "../mocks/obsidian";
import { CodeView, type CodeViewHost } from "../../src/code-view";
import VSCodeWorkbenchPlugin from "../../src/main";
import { folderChain, renderFileTitle, renderPathBreadcrumbs } from "../../src/path-breadcrumbs";
import { FakeWebview as FakeEl } from "../helpers";

type Handler = (evt: { preventDefault(): void }) => void;
interface FakeSpan {
  cls: string;
  text: string;
  draggable?: boolean;
  addEventListener(name: string, fn: Handler): void;
  /** Fire the event as the browser would; returns whether the page called preventDefault. */
  fire(name: string): boolean;
  click(): void;
}

/** Obsidian's `titleParentEl`, as far as the breadcrumbs touch it. */
class FakeTitleParent {
  spans: FakeSpan[] = [];
  empty(): void {
    this.spans = [];
  }
  createSpan(o: { cls: string; text: string }): FakeSpan {
    const handlers: Record<string, Handler[]> = {};
    const span: FakeSpan = {
      ...o,
      addEventListener: (name, fn) => void (handlers[name] ??= []).push(fn),
      fire: (name) => {
        let prevented = false;
        for (const fn of handlers[name] ?? []) fn({ preventDefault: () => void (prevented = true) });
        return prevented;
      },
      click: () => void span.fire("click"),
    };
    this.spans.push(span);
    return span;
  }
  crumbList(): FakeSpan[] {
    return this.spans.filter((s) => s.cls === "view-header-breadcrumb");
  }
  crumbs(): string[] {
    return this.crumbList().map((s) => s.text);
  }
  texts(): string {
    return this.spans.map((s) => s.text).join("");
  }
}

/** Obsidian's `titleEl` (the header title), as far as the file name touches it. */
class FakeTitle {
  text = "VS Code"; // what the header holds before the tab knows its file
  onclick: ((evt: unknown) => unknown) | null = null;
  style = { cursor: "" };
  setText(t: string): void {
    this.text = t;
  }
  click(): void {
    this.onclick?.({});
  }
}

function makeView(host: Partial<CodeViewHost> = {}) {
  const full: CodeViewHost = {
    vaultRoot: () => "/Users/dan/My Vault",
    embedElement: () => "webview",
    ensureServer: async () => ({ baseUrl: "http://127.0.0.1:5555", port: 5555, token: "tok123" }),
    trackView: vi.fn(),
    untrackView: vi.fn(),
    serverState: () => "running",
    onServerState: () => () => undefined,
    restartServer: async () => undefined,
    userDataCopy: () => null,
    admitFile: async () => true,
    releaseFile: () => undefined,
    openInSystemApp: () => undefined,
    ...host,
  };
  const view = new CodeView(new WorkspaceLeaf() as never, full);
  const parent = new FakeTitleParent();
  const title = new FakeTitle();
  Object.assign(view, { contentEl: new FakeEl("div"), titleParentEl: parent, titleEl: title });
  return { view, parent, title };
}

beforeEach(() => {
  vi.stubGlobal("document", { createElement: (t: string) => new FakeEl(t) });
});
afterEach(() => vi.unstubAllGlobals());

const PD = "HackerRank Mini-Course/_internals/research-pack/t/pd.js";

describe("folderChain", () => {
  it("lists the folders above the file, outermost first, as vault-relative paths", () => {
    expect(folderChain(PD)).toEqual([
      "HackerRank Mini-Course",
      "HackerRank Mini-Course/_internals",
      "HackerRank Mini-Course/_internals/research-pack",
      "HackerRank Mini-Course/_internals/research-pack/t",
    ]);
  });

  it("gives nothing for a file at the vault root", () => {
    expect(folderChain("pd.js")).toEqual([]);
  });
});

describe("renderPathBreadcrumbs", () => {
  it("draws a crumb and a separator per folder in Obsidian's classes, and clears what was there", () => {
    const parent = new FakeTitleParent();
    renderPathBreadcrumbs(parent, "old/dir/x.py", { reveal: () => undefined });
    renderPathBreadcrumbs(parent, "a/b/c.py", { reveal: () => undefined });
    expect(parent.spans.map((s) => s.cls)).toEqual(["view-header-breadcrumb", "view-header-breadcrumb-separator", "view-header-breadcrumb", "view-header-breadcrumb-separator"]);
    expect(parent.texts()).toBe("a/b/");
    renderPathBreadcrumbs(parent, "", { reveal: () => undefined });
    expect(parent.spans).toEqual([]);
  });

  it("with only reveal, a crumb is click-only: not draggable, no menu or drag handling", () => {
    const parent = new FakeTitleParent();
    renderPathBreadcrumbs(parent, "a/b/c.py", { reveal: () => undefined });
    const [crumb] = parent.crumbList();
    expect(crumb.draggable).toBeUndefined();
    expect(crumb.fire("contextmenu")).toBe(false);
    expect(crumb.fire("dragstart")).toBe(false);
  });

  it("gives each crumb its tooltip, menu and drag with that crumb's own folder", () => {
    const parent = new FakeTitleParent();
    const tooltip = vi.fn();
    const menu = vi.fn();
    const drag = vi.fn(() => true);
    renderPathBreadcrumbs(parent, "a/b/c.py", { reveal: () => undefined, tooltip, menu, drag });
    const [a, ab] = parent.crumbList();
    expect(tooltip.mock.calls).toEqual([[a, "a"], [ab, "a/b"]]);
    expect(ab.draggable).toBe(true);
    expect(ab.fire("contextmenu")).toBe(true); // the browser's own menu is suppressed
    expect(menu).toHaveBeenCalledExactlyOnceWith("a/b", expect.anything());
    expect(ab.fire("dragstart")).toBe(false);
    expect(drag).toHaveBeenCalledExactlyOnceWith("a/b", expect.anything());
  });

  it("cancels the drag when the host cannot start one", () => {
    const parent = new FakeTitleParent();
    renderPathBreadcrumbs(parent, "a/b/c.py", { reveal: () => undefined, drag: () => false });
    expect(parent.crumbList()[0].fire("dragstart")).toBe(true);
  });
});

describe("a Code tab's path", () => {
  it("shows the folder path of the file once the tab has its file, and nothing before", async () => {
    const { view, parent } = makeView();
    expect(parent.spans).toEqual([]);
    await view.setState({ file: PD }, {} as never);
    expect(parent.crumbs()).toEqual(["HackerRank Mini-Course", "_internals", "research-pack", "t"]);
    expect(parent.texts()).toBe("HackerRank Mini-Course/_internals/research-pack/t/");
  });

  it("clicking a folder asks the host to reveal that folder, by its full vault-relative path", async () => {
    const revealFolder = vi.fn();
    const { view, parent } = makeView({ revealFolder });
    await view.setState({ file: PD }, {} as never);
    parent.crumbList()[2].click();
    expect(revealFolder).toHaveBeenCalledExactlyOnceWith("HackerRank Mini-Course/_internals/research-pack");
  });

  it("a click with a host that cannot reveal does nothing", async () => {
    const { view, parent } = makeView();
    await view.setState({ file: PD }, {} as never);
    expect(() => parent.spans[0].click()).not.toThrow();
  });

  it("wires the host's tooltip, menu and drag to the crumbs, by full folder path", async () => {
    const folderTooltip = vi.fn();
    const folderMenu = vi.fn();
    const dragFolder = vi.fn(() => true);
    const { view, parent } = makeView({ folderTooltip, folderMenu, dragFolder });
    await view.setState({ file: PD }, {} as never);
    const crumb = parent.crumbList()[1];
    expect(folderTooltip).toHaveBeenCalledWith(crumb, "HackerRank Mini-Course/_internals");
    crumb.fire("contextmenu");
    expect(folderMenu).toHaveBeenCalledExactlyOnceWith("HackerRank Mini-Course/_internals", expect.anything());
    crumb.fire("dragstart");
    expect(dragFolder).toHaveBeenCalledExactlyOnceWith("HackerRank Mini-Course/_internals", expect.anything());
  });

  it("a host with no menu or drag leaves the crumbs click-only", async () => {
    const { view, parent } = makeView();
    await view.setState({ file: PD }, {} as never);
    expect(parent.crumbList()[0].draggable).toBeUndefined();
    expect(parent.crumbList()[0].fire("contextmenu")).toBe(false);
  });

  it("follows a rename or move of the file", async () => {
    const { view, parent } = makeView();
    await view.setState({ file: "a/b/x.py" }, {} as never);
    view.followTo("c/y.py");
    expect(parent.texts()).toBe("c/");
    view.followTo("top.py");
    expect(parent.spans).toEqual([]);
  });

  it("a file refused at open leaves no path behind", async () => {
    const { view, parent } = makeView({ admitFile: async () => false });
    await view.setState({ file: PD }, {} as never);
    expect(parent.spans).toEqual([]);
  });

  it("ends the path with the file name in the header title, in place of the 'VS Code' placeholder", async () => {
    const { view, title } = makeView();
    expect(title.text).toBe("VS Code");
    await view.setState({ file: PD }, {} as never);
    expect(title.text).toBe("pd.js");
  });

  it("clicking the file name asks the host to reveal that file, by its full vault-relative path", async () => {
    const revealFile = vi.fn();
    const revealFolder = vi.fn();
    const { view, title } = makeView({ revealFile, revealFolder });
    await view.setState({ file: PD }, {} as never);
    title.click();
    expect(revealFile).toHaveBeenCalledExactlyOnceWith(PD);
    expect(revealFolder).not.toHaveBeenCalled();
  });

  it("a click on the file name with a host that cannot reveal does nothing", async () => {
    const { view, title } = makeView();
    await view.setState({ file: PD }, {} as never);
    expect(() => title.click()).not.toThrow();
  });

  it("follows a rename: the title shows the new name and a click reveals the new path, once", async () => {
    const revealFile = vi.fn();
    const { view, title } = makeView({ revealFile });
    await view.setState({ file: "a/b/x.py" }, {} as never);
    view.followTo("c/y.py");
    expect(title.text).toBe("y.py");
    title.click();
    expect(revealFile).toHaveBeenCalledExactlyOnceWith("c/y.py");
  });

  it("a file at the vault root still gets its name as the title", async () => {
    const { view, title, parent } = makeView();
    await view.setState({ file: "top.py" }, {} as never);
    expect(parent.spans).toEqual([]);
    expect(title.text).toBe("top.py");
  });
});

describe("renderFileTitle", () => {
  it("clears the name and the click for an empty path", () => {
    const title = new FakeTitle();
    const reveal = vi.fn();
    renderFileTitle(title, "a/b.py", reveal);
    renderFileTitle(title, "", reveal);
    expect(title.text).toBe("");
    expect(title.onclick).toBeNull();
  });
});

describe("the plugin's folder reveal", () => {
  function pluginWith(app: unknown): VSCodeWorkbenchPlugin {
    Plugin.reset();
    return new VSCodeWorkbenchPlugin(app as never, { id: "obsidian-vscode-workbench", dir: ".obsidian/plugins/obsidian-vscode-workbench" } as never);
  }

  it("reveals the vault folder in the file-explorer plugin", () => {
    const folder = { path: "a/b" };
    const revealInFolder = vi.fn(function (this: unknown) {
      return this;
    });
    const explorer = { revealInFolder };
    const plugin = pluginWith({
      internalPlugins: { getEnabledPluginById: (id: string) => (id === "file-explorer" ? explorer : null) },
      vault: { getFolderByPath: (p: string) => (p === "a/b" ? folder : null) },
    });
    plugin.revealFolder("a/b");
    expect(revealInFolder).toHaveBeenCalledExactlyOnceWith(folder);
    expect(revealInFolder.mock.contexts[0]).toBe(explorer); // called as a method of the plugin object
  });

  it("finds a folder stored in the other Unicode form (macOS names are decomposed)", () => {
    const folder = { path: "café" };
    const revealInFolder = vi.fn();
    const plugin = pluginWith({
      internalPlugins: { getEnabledPluginById: () => ({ revealInFolder }) },
      vault: { getFolderByPath: (p: string) => (p === "café".normalize("NFD") ? folder : null) },
    });
    plugin.revealFolder("café".normalize("NFC"));
    expect(revealInFolder).toHaveBeenCalledExactlyOnceWith(folder);
  });

  it("reveals a vault file in the file-explorer plugin, found in either Unicode form", () => {
    const file = { path: "café/x.js" };
    const revealInFolder = vi.fn(function (this: unknown) {
      return this;
    });
    const explorer = { revealInFolder };
    const plugin = pluginWith({
      internalPlugins: { getEnabledPluginById: (id: string) => (id === "file-explorer" ? explorer : null) },
      vault: { getFileByPath: (p: string) => (p === "café/x.js".normalize("NFD") ? file : null) },
    });
    plugin.revealFile("café/x.js".normalize("NFC"));
    expect(revealInFolder).toHaveBeenCalledExactlyOnceWith(file);
    expect(revealInFolder.mock.contexts[0]).toBe(explorer);
  });

  it("revealing a file does nothing when the file explorer is off or the file is not in the vault", () => {
    const revealInFolder = vi.fn();
    expect(() => pluginWith({ internalPlugins: { getEnabledPluginById: () => null }, vault: { getFileByPath: () => ({}) } }).revealFile("a.js")).not.toThrow();
    pluginWith({ internalPlugins: { getEnabledPluginById: () => ({ revealInFolder }) }, vault: { getFileByPath: () => null } }).revealFile("a.js");
    expect(revealInFolder).not.toHaveBeenCalled();
  });

  it("does nothing when the file explorer is off or the folder is gone", () => {
    const revealInFolder = vi.fn();
    expect(() => pluginWith({ internalPlugins: { getEnabledPluginById: () => null }, vault: { getFolderByPath: () => ({}) } }).revealFolder("a")).not.toThrow();
    pluginWith({ internalPlugins: { getEnabledPluginById: () => ({ revealInFolder }) }, vault: { getFolderByPath: () => null } }).revealFolder("a");
    expect(revealInFolder).not.toHaveBeenCalled();
  });

  it("tooltips a crumb with the folder's own name, as a note's crumb does", () => {
    const el = {};
    const before = tooltips.length;
    pluginWith({}).folderTooltip(el, "HackerRank Mini-Course/_internals/research-pack");
    expect(tooltips.slice(before)).toEqual([{ el, text: "research-pack" }]);
  });

  /** An app whose workspace.trigger records what the `file-menu` event carried, and whose file explorer is on or off. */
  function menuApp(explorer: { revealInFolder: ReturnType<typeof vi.fn> } | null, extra: Record<string, unknown> = {}) {
    const folder = { path: "a/b" };
    const trigger = vi.fn();
    const app = {
      vault: { getFolderByPath: (p: string) => (p === "a/b" ? folder : null) },
      workspace: { trigger, ...(extra.workspace as object) },
      internalPlugins: { getEnabledPluginById: (id: string) => (id === "file-explorer" ? explorer : null) },
      fileManager: extra.fileManager,
    };
    return { app, folder, trigger };
  }

  it("right-click builds a note's crumb menu: Obsidian's sections, New note, New folder, Reveal, then file-menu with the file explorer's source", () => {
    Menu.created = [];
    const revealInFolder = vi.fn();
    const { app, folder, trigger } = menuApp({ revealInFolder });
    const evt = { type: "contextmenu" };
    pluginWith(app).folderMenu("a/b", evt);
    expect(Menu.created).toHaveLength(1);
    const menu = Menu.created[0];
    expect(menu.forEventEvt).toBe(evt);
    expect(menu.sections).toEqual(["title", "open", "action-primary", "action", "info", "info.copy", "view", "system", "", "danger"]);
    expect(menu.items.map((i) => [i.title, i.section, i.icon])).toEqual([
      ["New note", "action-primary", "lucide-edit"],
      ["New folder", "action-primary", "lucide-folder-open"],
      ["Reveal in file explorer", "system", "lucide-folder-open"],
    ]);
    expect(trigger).toHaveBeenCalledExactlyOnceWith("file-menu", menu, folder, FILE_EXPLORER_SOURCE);
    expect(FILE_EXPLORER_SOURCE).toBe("file-explorer-context-menu");
    menu.items[2].click();
    expect(revealInFolder).toHaveBeenCalledExactlyOnceWith(folder);
  });

  it("the plugin's own 'New terminal at folder' item is added to the crumb menu by its file-menu listener", () => {
    Menu.created = [];
    const root = new TFolder("/");
    const a = new TFolder("a");
    a.parent = root;
    const folder = new TFolder("a/b");
    folder.parent = a;
    const { app } = menuApp({ revealInFolder: vi.fn() });
    app.vault.getFolderByPath = (p: string) => (p === "a/b" ? folder : null);
    const plugin = pluginWith(app);
    // What Obsidian does with a triggered file-menu: hand it to the plugin's registered listener.
    app.workspace.trigger = vi.fn((name: string, menu: Menu, target: unknown, source: string) => {
      if (name === "file-menu") (plugin as unknown as { onFileMenu(m: Menu, t: unknown, s: string): void }).onFileMenu(menu, target, source);
    });
    plugin.folderMenu("a/b", {});
    expect(Menu.created[0].items.map((i) => i.title)).toContain(NEW_TERMINAL_TITLE);
  });

  it("New note creates a note in the folder and opens it in source mode, with rename on, in a new tab on a mod-click", async () => {
    Menu.created = [];
    const note = { path: "a/b/Untitled.md" };
    const createNewMarkdownFile = vi.fn(async () => note);
    const openFile = vi.fn();
    const getLeaf = vi.fn(() => ({ openFile }));
    const { app, folder } = menuApp(null, { fileManager: { createNewMarkdownFile }, workspace: { getLeaf } });
    pluginWith(app).folderMenu("a/b", {});
    await Menu.created[0].items[0].click({ modKey: true });
    expect(createNewMarkdownFile).toHaveBeenCalledExactlyOnceWith(folder);
    expect(getLeaf).toHaveBeenCalledExactlyOnceWith(true);
    expect(openFile).toHaveBeenCalledExactlyOnceWith(note, { active: true, state: { mode: "source" }, eState: { rename: "all" } });
  });

  it("New folder creates a folder in the folder and shows it in the file explorer for naming", async () => {
    Menu.created = [];
    const createNewFolder = vi.fn(async () => ({ path: "a/b/Untitled" }));
    const ensureSideLeaf = vi.fn();
    const { app, folder } = menuApp({ revealInFolder: vi.fn() }, { fileManager: { createNewFolder }, workspace: { ensureSideLeaf } });
    pluginWith(app).folderMenu("a/b", {});
    await Menu.created[0].items[1].click();
    expect(createNewFolder).toHaveBeenCalledExactlyOnceWith(folder);
    expect(ensureSideLeaf).toHaveBeenCalledExactlyOnceWith("file-explorer", "left", { active: true, reveal: true, state: { newFile: "a/b/Untitled" } });
  });

  it("with the file explorer off the crumb menu has only New note, and still triggers file-menu", () => {
    Menu.created = [];
    const { app, trigger } = menuApp(null);
    pluginWith(app).folderMenu("a/b", {});
    expect(Menu.created[0].items.map((i) => i.title)).toEqual(["New note"]);
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it("right-click on a folder that is gone shows no menu", () => {
    Menu.created = [];
    const trigger = vi.fn();
    pluginWith({ vault: { getFolderByPath: () => null }, workspace: { trigger } }).folderMenu("gone", {});
    expect(Menu.created).toEqual([]);
    expect(trigger).not.toHaveBeenCalled();
  });

  it("drag start hands the folder to Obsidian's drag manager", () => {
    const folder = { path: "a/b" };
    const dragged = { drag: true };
    const dragFolder = vi.fn(() => dragged);
    const onDragStart = vi.fn();
    const evt = { type: "dragstart" };
    const plugin = pluginWith({ vault: { getFolderByPath: () => folder }, dragManager: { dragFolder, onDragStart } });
    expect(plugin.dragFolder("a/b", evt)).toBe(true);
    expect(dragFolder).toHaveBeenCalledExactlyOnceWith(evt, folder);
    expect(onDragStart).toHaveBeenCalledExactlyOnceWith(evt, dragged);
  });

  it("drag cannot start without the drag manager, the folder, or a drag object", () => {
    const folder = {};
    expect(pluginWith({ vault: { getFolderByPath: () => folder } }).dragFolder("a", {})).toBe(false);
    expect(pluginWith({ vault: { getFolderByPath: () => null }, dragManager: { dragFolder: () => ({}), onDragStart: () => undefined } }).dragFolder("a", {})).toBe(false);
    const onDragStart = vi.fn();
    expect(pluginWith({ vault: { getFolderByPath: () => folder }, dragManager: { dragFolder: () => null, onDragStart } }).dragFolder("a", {})).toBe(false);
    expect(onDragStart).not.toHaveBeenCalled();
  });
});
