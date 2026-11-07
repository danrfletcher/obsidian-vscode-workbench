// @vitest-environment jsdom
/**
 * Two fence lines of PR-3, through the real plugin class (main.ts) with the mocked `obsidian` module:
 *  - a hand-edited or corrupt `data.json` never crashes the plugin and never gives the drawer a bad height: it opens at the
 *    default height (300 px) unless this device has a good saved height (G3);
 *  - the edge and the drawer belong to the main window's document only: a pop-out window's document gets neither, however
 *    the workspace changes (F7).
 * The terminal host page is stubbed where a drawer is opened (opening for real starts a server; terminal-host.test.ts covers that).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileSystemAdapter, Notice, Plugin, TFile, WorkspaceLeaf, type MockApp } from "../mocks/obsidian";
import VSCodeWorkbenchPlugin from "../../src/main";
import { DEFAULT_HEIGHT } from "../../src/terminal/drawer-geometry";
import { DEVICE_ID_KEY, DRAWER_KEY } from "../../src/terminal/drawer-state";
import { resetPage, tick } from "../page-helpers";
import { tempDir } from "../helpers";

const DEVICE = "device-aaaa-0001";
const OTHER_DEVICE = "device-bbbb-0002";

interface DrawerLike {
  isOpen: boolean;
  currentHeight: number;
  openDrawer(): void;
  close(): void;
}

let vault: string;
let plugin: VSCodeWorkbenchPlugin | undefined;
let layoutHandlers: Array<() => void>;

function makeApp(root: string): MockApp {
  return {
    vault: {
      adapter: new FileSystemAdapter(root),
      configDir: ".obsidian",
      getAbstractFileByPath: (p: string) => (fs.existsSync(path.join(root, p)) ? new TFile(p) : null),
      on: (name: string, cb: (...args: any[]) => void) => ({ name, cb }),
    },
    // This device's id, as Obsidian's per-device local storage would hold it.
    loadLocalStorage: (key: string) => (key === DEVICE_ID_KEY ? DEVICE : null),
    saveLocalStorage: () => undefined,
    workspace: {
      onLayoutReady: (cb: () => void) => cb(),
      activeFile: null,
      leaves: [],
      getActiveFile: () => null,
      getLeavesOfType: () => [] as WorkspaceLeaf[],
      getLeaf: () => new WorkspaceLeaf(),
      revealLeaf: async () => undefined,
      detachLeavesOfType: () => undefined,
      getMostRecentLeaf: () => ({ view: { getViewType: () => "markdown" } }),
      getActiveViewOfType: () => ({ getViewType: () => "file-explorer" }),
      on: (name: string, cb: () => void) => {
        if (name === "active-leaf-change" || name === "layout-change") layoutHandlers.push(cb);
        return { name, cb };
      },
    },
  } as never;
}

/** Load the plugin with `raw` exactly as `loadData()` returns it (what is in data.json, whatever its shape). */
async function loadRaw(raw: unknown): Promise<void> {
  plugin = new VSCodeWorkbenchPlugin(makeApp(vault) as never, { id: "vscode-workbench", dir: ".obsidian/plugins/vscode-workbench" } as never);
  (plugin as unknown as { pluginData: unknown }).pluginData = raw;
  await plugin.onload();
}

const drawer = () => (plugin as unknown as { drawer: DrawerLike }).drawer;
const edges = (doc: Document) => doc.querySelectorAll(".vscw-edge");

/** Open the drawer without a real host page (which would start a server). */
function openWithStubbedHost(): void {
  const host = (plugin as unknown as { terminalHostPage(): { show(): void; hide(): void; focusTerminal(): void } }).terminalHostPage();
  vi.spyOn(host, "show").mockImplementation(() => undefined);
  vi.spyOn(host, "hide").mockImplementation(() => undefined);
  vi.spyOn(host, "focusTerminal").mockImplementation(() => undefined);
  drawer().openDrawer();
}

beforeEach(() => {
  vault = tempDir();
  Plugin.reset();
  Notice.reset();
  resetPage();
  layoutHandlers = [];
});

afterEach(async () => {
  plugin?.onunload();
  plugin = undefined;
  vi.restoreAllMocks();
  await tick();
  resetPage();
});

describe("a corrupt or hand-edited data.json (G3)", () => {
  const bad: Array<[string, unknown]> = [
    ["no drawer key at all", { serverLicenceAccepted: true }],
    ["drawer is a string", { drawer: "300" }],
    ["drawer is a number", { drawer: 300 }],
    ["drawer is an array", { drawer: [300] }],
    ["drawer is null", { drawer: null }],
    ["this device is missing", { drawer: { [OTHER_DEVICE]: { height: 420 } } }],
    ["this device holds a number", { drawer: { [DEVICE]: 420 } }],
    ["this device holds a string", { drawer: { [DEVICE]: "420" } }],
    ["height is zero", { drawer: { [DEVICE]: { height: 0 } } }],
    ["height is negative", { drawer: { [DEVICE]: { height: -50 } } }],
    ["height is NaN", { drawer: { [DEVICE]: { height: Number.NaN } } }],
    ["height is Infinity", { drawer: { [DEVICE]: { height: Number.POSITIVE_INFINITY } } }],
    ["height is a string", { drawer: { [DEVICE]: { height: "420" } } }],
    ["height is an object", { drawer: { [DEVICE]: { height: { px: 420 } } } }],
    ["height is null", { drawer: { [DEVICE]: { height: null } } }],
    ["height is a boolean", { drawer: { [DEVICE]: { height: true } } }],
  ];

  it.each(bad)("%s: the plugin loads and the drawer opens at the default height", async (_name, raw) => {
    await loadRaw({ serverLicenceAccepted: true, ...(raw as object) });
    expect(drawer().currentHeight).toBe(DEFAULT_HEIGHT);
    openWithStubbedHost();
    expect(drawer().isOpen).toBe(true);
    expect(document.body.style.getPropertyValue("--vscw-open-height")).toBe(`${DEFAULT_HEIGHT}px`);
  });

  it.each([
    ["a string", "drawer"],
    ["an array", [{ drawer: { [DEVICE]: { height: 420 } } }]],
    ["null", null],
    ["a number", 7],
    ["undefined", undefined],
  ])("data.json itself is %s: the plugin loads and the drawer opens at the default height", async (_name, raw) => {
    await loadRaw(raw);
    expect(drawer().currentHeight).toBe(DEFAULT_HEIGHT);
    openWithStubbedHost();
    expect(drawer().isOpen).toBe(true);
    expect(document.body.style.getPropertyValue("--vscw-open-height")).toBe(`${DEFAULT_HEIGHT}px`);
  });

  it("the control: a good saved height for this device is what the drawer opens at (so the cases above prove the fallback)", async () => {
    await loadRaw({ serverLicenceAccepted: true, [DRAWER_KEY]: { [DEVICE]: { height: 420 }, [OTHER_DEVICE]: { height: 200 } } });
    expect(drawer().currentHeight).toBe(420);
    openWithStubbedHost();
    expect(document.body.style.getPropertyValue("--vscw-open-height")).toBe("420px");
  });

  it("an open flag saved in data.json is ignored: the drawer starts closed", async () => {
    await loadRaw({ serverLicenceAccepted: true, [DRAWER_KEY]: { [DEVICE]: { height: 420, open: true } } });
    expect(drawer().isOpen).toBe(false);
    expect(document.body.classList.contains("vscw-drawer-open")).toBe(false);
  });
});

describe("main window only (F7)", () => {
  /** A pop-out window's document: its own page, with its own body, as Obsidian gives a pop-out window. */
  function popoutDocument(): Document {
    const doc = document.implementation.createHTMLDocument("pop-out");
    const split = doc.createElement("div");
    split.className = "workspace-split mod-root";
    doc.body.appendChild(split);
    return doc;
  }

  it("the edge is in the main window's document once, and a pop-out window's document gets no edge, class or variable", async () => {
    const popout = popoutDocument();
    await loadRaw({ serverLicenceAccepted: true });
    expect(edges(document)).toHaveLength(1);
    expect(edges(popout)).toHaveLength(0);

    // The workspace changes (a tab moves to the pop-out, the layout changes, the drawer opens and closes): still nothing there.
    for (const h of layoutHandlers) h();
    openWithStubbedHost();
    for (const h of layoutHandlers) h();
    drawer().close();

    expect(edges(popout)).toHaveLength(0);
    expect(popout.body.querySelector("[class*='vscw']")).toBeNull();
    expect([...popout.body.classList].filter((c) => c.startsWith("vscw"))).toEqual([]);
    expect(popout.body.getAttribute("style")).toBeNull();
    expect(edges(document)).toHaveLength(1);
  });

  it("unloading takes the edge out of the main window and leaves the pop-out untouched", async () => {
    const popout = popoutDocument();
    await loadRaw({ serverLicenceAccepted: true });
    plugin!.onunload();
    plugin = undefined;
    expect(edges(document)).toHaveLength(0);
    expect(popout.body.children).toHaveLength(1);
  });
});
