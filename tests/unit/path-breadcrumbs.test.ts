/**
 * The file path above a Code tab's editor (a note shows its folder path as header breadcrumbs; a Code tab did not), and the click that
 * reveals a folder in the file explorer. Driven through the real CodeView and the real plugin class.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Plugin, WorkspaceLeaf } from "../mocks/obsidian";
import { CodeView, type CodeViewHost } from "../../src/code-view";
import VSCodeWorkbenchPlugin from "../../src/main";
import { folderChain, renderPathBreadcrumbs } from "../../src/path-breadcrumbs";
import { FakeWebview as FakeEl } from "../helpers";

/** Obsidian's `titleParentEl`, as far as the breadcrumbs touch it. */
class FakeTitleParent {
  spans: Array<{ cls: string; text: string; click: () => void }> = [];
  empty(): void {
    this.spans = [];
  }
  createSpan(o: { cls: string; text: string }) {
    let handler: () => void = () => undefined;
    const span = { ...o, click: () => handler(), addEventListener: (_n: string, fn: () => void) => void (handler = fn) };
    this.spans.push(span);
    return span;
  }
  crumbs(): string[] {
    return this.spans.filter((s) => s.cls === "view-header-breadcrumb").map((s) => s.text);
  }
  texts(): string {
    return this.spans.map((s) => s.text).join("");
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
  Object.assign(view, { contentEl: new FakeEl("div"), titleParentEl: parent });
  return { view, parent };
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
    renderPathBreadcrumbs(parent, "old/dir/x.py", () => undefined);
    renderPathBreadcrumbs(parent, "a/b/c.py", () => undefined);
    expect(parent.spans.map((s) => s.cls)).toEqual(["view-header-breadcrumb", "view-header-breadcrumb-separator", "view-header-breadcrumb", "view-header-breadcrumb-separator"]);
    expect(parent.texts()).toBe("a/b/");
    renderPathBreadcrumbs(parent, "", () => undefined);
    expect(parent.spans).toEqual([]);
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
    parent.spans.filter((s) => s.cls === "view-header-breadcrumb")[2].click();
    expect(revealFolder).toHaveBeenCalledExactlyOnceWith("HackerRank Mini-Course/_internals/research-pack");
  });

  it("a click with a host that cannot reveal does nothing", async () => {
    const { view, parent } = makeView();
    await view.setState({ file: PD }, {} as never);
    expect(() => parent.spans[0].click()).not.toThrow();
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

  it("does nothing when the file explorer is off or the folder is gone", () => {
    const revealInFolder = vi.fn();
    expect(() => pluginWith({ internalPlugins: { getEnabledPluginById: () => null }, vault: { getFolderByPath: () => ({}) } }).revealFolder("a")).not.toThrow();
    pluginWith({ internalPlugins: { getEnabledPluginById: () => ({ revealInFolder }) }, vault: { getFolderByPath: () => null } }).revealFolder("a");
    expect(revealInFolder).not.toHaveBeenCalled();
  });
});
