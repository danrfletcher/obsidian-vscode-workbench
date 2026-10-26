// @vitest-environment jsdom
/**
 * Sessions as tabs, the kill confirm, the layout, the non-code toggle and the status-bar count (G10, G11, G18, GP6),
 * on a jsdom page with fake helper processes and a fake terminal emulator. Nothing here starts a real shell.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileSystemAdapter, Notice, Platform, Plugin, TFile, WorkspaceLeaf, type MockApp } from "../mocks/obsidian";
import VSCodeWorkbenchPlugin from "../../src/main";
import { DRAWER_KEY } from "../../src/terminal/drawer-state";
import { CODE_VIEW, activeTab, featureRig, px, q, qa, resetPage, root, shownPanes, statusText, strip, tabLabels, tabs, tick, type Rig } from "../feature-rig";
import { tempDir } from "../helpers";

let rigs: Rig[] = [];
function rig(opts: Parameters<typeof featureRig>[0] = {}): Rig {
  const r = featureRig(opts);
  rigs.push(r);
  return r;
}

beforeEach(() => {
  resetPage();
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1600 });
});

afterEach(async () => {
  for (const r of rigs.splice(0)) await r.feature.dispose();
  resetPage();
});

/** Mount, reveal and wait for the first shell. */
async function opened(r: Rig = rig()): Promise<Rig> {
  r.feature.mount();
  strip().click();
  await tick();
  return r;
}

const click = (sel: string) => q(sel).click();
const addTab = async () => {
  click(".vscw-new");
  await tick();
};

describe("sessions as tabs (G10)", () => {
  it("the first reveal shows one tab, the active one, with one pane showing", async () => {
    await opened();
    expect(tabLabels()).toEqual(["zsh 1"]);
    expect(activeTab().textContent).toBe("zsh 1");
    expect(activeTab().getAttribute("aria-selected")).toBe("true");
    expect(shownPanes()).toHaveLength(1);
  });

  it("+ adds a session and focuses its tab, with its own terminal and its own shell", async () => {
    const r = await opened();
    await addTab();
    expect(tabLabels()).toEqual(["zsh 1", "zsh 2"]);
    expect(activeTab().textContent).toBe("zsh 2");
    expect(r.views).toHaveLength(2);
    expect(r.world.spawned).toHaveLength(2);
    expect(shownPanes()).toHaveLength(1);
    expect(shownPanes()[0].dataset.session).toBe(r.feature.sessions.activeId);
    expect(r.views[1].focuses).toBeGreaterThan(0);
  });

  it("clicking a tab shows that session's terminal without restarting a shell or clearing any screen", async () => {
    const r = await opened();
    await addTab();
    r.world.spawned[0].child.output("one\r\n");
    r.world.spawned[1].child.output("two\r\n");
    await tick();
    tabs()[0].click();
    expect(activeTab().textContent).toBe("zsh 1");
    expect(shownPanes()[0].dataset.session).toBe(r.feature.sessions.sessions[0].id);
    tabs()[1].click();
    tabs()[0].click();
    expect(r.world.spawned).toHaveLength(2);
    expect(r.world.signals).toEqual([]);
    expect(r.views.map((v) => v.resets)).toEqual([1, 1]); // the one reset each got when its shell started; switching never resets
    expect(r.views[0].text()).toContain("one");
    expect(r.views[1].text()).toContain("two");
    expect(r.views.every((v) => !v.disposed)).toBe(true);
  });

  it("output goes to its own session's terminal even while another tab is showing", async () => {
    const r = await opened();
    await addTab();
    r.world.spawned[0].child.output("for the first");
    await tick();
    expect(r.views[0].text()).toContain("for the first");
    expect(r.views[1].text()).not.toContain("for the first");
  });

  it("keystrokes go to the session whose terminal they were typed in", async () => {
    const r = await opened();
    await addTab();
    r.views[0].type("echo one\r");
    r.views[1].type("echo two\r");
    expect(r.world.spawned[0].child.sent().toString("latin1")).toContain("echo one");
    expect(r.world.spawned[0].child.sent().toString("latin1")).not.toContain("echo two");
    expect(r.world.spawned[1].child.sent().toString("latin1")).toContain("echo two");
  });

  it("a tab can be selected from the keyboard", async () => {
    await opened();
    await addTab();
    tabs()[0].dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(activeTab().textContent).toBe("zsh 1");
  });

  it("the first reveal creates exactly one shell on a double click and on a double hotkey press", async () => {
    const r = rig();
    r.feature.mount();
    strip().click();
    strip().click(); // closes
    strip().click(); // reopens
    await tick();
    expect(r.world.spawned).toHaveLength(1);

    const h = rig();
    h.feature.mount();
    h.feature.toggle();
    h.feature.toggle();
    h.feature.toggle();
    await tick();
    expect(h.world.spawned).toHaveLength(1);
    expect(h.feature.sessions.sessions).toHaveLength(1);
  });

  it("ten rapid clicks on + make ten sessions with ten unique tabs and the right count", async () => {
    const r = await opened();
    for (let i = 0; i < 9; i++) click(".vscw-new");
    await tick();
    await tick();
    expect(tabs()).toHaveLength(10);
    const ids = tabs().map((t) => t.dataset.session);
    expect(new Set(ids).size).toBe(10);
    expect(r.world.spawned).toHaveLength(10);
    expect(statusText(r)).toBe("10 shells");
    expect(shownPanes()).toHaveLength(1);
  });

  it("hiding the drawer, switching tabs and switching notes never end a shell", async () => {
    const r = await opened();
    await addTab();
    strip().click(); // hide
    r.view.type = "canvas";
    r.feature.applyVisibility();
    tabs()[0].click();
    r.view.type = "markdown";
    r.feature.applyVisibility();
    r.feature.layoutChanged();
    strip().click(); // reveal
    expect(r.world.signals).toEqual([]);
    expect(r.feature.sessions.count).toBe(2);
    expect(r.world.spawned).toHaveLength(2);
  });
});

describe("killing a shell (G10)", () => {
  it("trash on a running shell asks first; Cancel leaves it running with its tab", async () => {
    const r = await opened();
    r.confirm.answer = false;
    click(".vscw-trash");
    await tick();
    expect(r.confirm.asked).toEqual(["zsh 1"]);
    expect(tabLabels()).toEqual(["zsh 1"]);
    expect(r.world.signals).toEqual([]);
    expect(r.feature.sessions.count).toBe(1);
  });

  it("Confirm kills the shell and removes its tab; the other tab becomes the active one and keeps running", async () => {
    const r = await opened();
    await addTab();
    click(".vscw-trash");
    await tick();
    expect(r.confirm.asked).toEqual(["zsh 2"]);
    expect(tabLabels()).toEqual(["zsh 1"]);
    expect(activeTab().textContent).toBe("zsh 1");
    expect(r.world.signals.some(([pid, sig]) => pid === r.world.spawned[1].child.pid && sig === "SIGTERM")).toBe(true);
    expect(r.world.signals.some(([pid]) => pid === r.world.spawned[0].child.pid)).toBe(false);
    expect(r.views[1].disposed).toBe(true);
    expect(shownPanes()).toHaveLength(1);
    expect(root().classList.contains("vscw-open")).toBe(true);
  });

  it("the trash button kills the active session, not the first one", async () => {
    const r = await opened();
    await addTab();
    await addTab();
    tabs()[1].click();
    click(".vscw-trash");
    await tick();
    expect(r.confirm.asked).toEqual(["zsh 2"]);
    expect(tabLabels()).toEqual(["zsh 1", "zsh 3"]);
  });

  it("a shell that exited is removed with no question", async () => {
    const r = await opened();
    await addTab();
    r.world.spawned[1].child.shellExit(0);
    await tick();
    expect(tabs()[1].classList.contains("vscw-tab-exited")).toBe(true);
    click(".vscw-trash");
    await tick();
    expect(r.confirm.asked).toEqual([]);
    expect(tabLabels()).toEqual(["zsh 1"]);
  });

  it("killing the last shell closes the drawer, leaves the strip, and the next reveal makes one fresh shell", async () => {
    const r = await opened();
    click(".vscw-trash");
    await tick();
    expect(tabs()).toHaveLength(0);
    expect(root().classList.contains("vscw-open")).toBe(false);
    expect(strip()).not.toBeNull();
    expect(r.feature.drawer?.open).toBe(false);
    expect((r.data[DRAWER_KEY] as Record<string, { open: boolean }>)["device-aaaa-1111"].open).toBe(false);
    expect(px("--vscw-open-height")).toBe(0);

    strip().click();
    await tick();
    expect(tabLabels()).toEqual(["zsh 2"]);
    expect(r.world.spawned).toHaveLength(2);
    expect(r.feature.sessions.sessions).toHaveLength(1);
  });

  it("a shell that exits by itself, the last one included, leaves its tab and the drawer open", async () => {
    const r = await opened();
    r.world.spawned[0].child.shellExit(0);
    await tick();
    expect(tabLabels()).toEqual(["zsh 1"]);
    expect(r.feature.drawer?.open).toBe(true);
  });

  it("a kill racing a natural exit removes the tab once and the count stays at zero", async () => {
    const r = await opened();
    r.confirm.answer = true;
    const killing = r.feature.killActive();
    r.world.spawned[0].child.shellExit(0);
    await killing;
    await tick();
    expect(tabs()).toHaveLength(0);
    expect(statusText(r)).toBe("");
    expect(r.feature.sessions.count).toBe(0);
  });
});

describe("a shell that cannot start (E10)", () => {
  it("+ with a missing shell gives a red message in that tab; closing it asks nothing and the count excludes it", async () => {
    const r = await opened();
    r.preflight.result = () => ({ ok: false, kind: "shell-missing", message: "The shell /nope does not exist." });
    await addTab();
    expect(tabLabels()).toEqual(["zsh 1", "zsh 2"]);
    const msg = shownPanes()[0].querySelector(".vscw-message") as HTMLElement;
    expect(msg.hidden).toBe(false);
    expect(msg.classList.contains("vscw-error")).toBe(true);
    expect(msg.textContent).toContain("The shell /nope does not exist.");
    expect(activeTab().classList.contains("vscw-tab-error")).toBe(true);
    expect(r.feature.sessions.count).toBe(1);
    expect(statusText(r)).toBe("1 shell");

    click(".vscw-trash");
    await tick();
    expect(r.confirm.asked).toEqual([]);
    expect(tabLabels()).toEqual(["zsh 1"]);
    expect(statusText(r)).toBe("1 shell");
  });

  it("the message belongs to its tab: the other tab's pane is not red", async () => {
    const r = await opened();
    r.preflight.result = () => ({ ok: false, kind: "shell-missing", message: "no shell" });
    await addTab();
    tabs()[0].click();
    const msg = shownPanes()[0].querySelector(".vscw-message") as HTMLElement;
    expect(msg.hidden).toBe(true);
  });

  it("Try again in the failed tab starts that session's shell", async () => {
    const r = await opened();
    r.preflight.result = () => ({ ok: false, kind: "shell-missing", message: "no shell" });
    await addTab();
    r.preflight.result = () => ({ ok: true, python: "/usr/bin/python3", shell: "/bin/zsh" });
    (shownPanes()[0].querySelector(".vscw-restart") as HTMLElement).click();
    await tick();
    await tick();
    expect(r.feature.sessions.count).toBe(2);
    expect(tabs()).toHaveLength(2);
  });
});

describe("the status-bar count (G18)", () => {
  it("is absent with no shell, appears on the first, follows create, kill and exit, and goes at zero", async () => {
    const r = rig();
    r.feature.mount();
    expect(statusText(r)).toBe("");
    strip().click();
    await tick();
    expect(statusText(r)).toBe("1 shell");
    await addTab();
    expect(statusText(r)).toBe("2 shells");
    r.world.spawned[0].child.shellExit(0);
    await tick();
    expect(statusText(r)).toBe("1 shell");
    click(".vscw-trash");
    await tick();
    expect(statusText(r)).toBe("");
    expect(r.statusBar.children).toHaveLength(0);
    expect(tabLabels()).toEqual(["zsh 1"]); // the exited tab is still there; the count excludes it
    click(".vscw-trash");
    await tick();
    expect(r.statusBar.children).toHaveLength(0);
  });

  it("stays while the drawer is closed", async () => {
    const r = await opened();
    await addTab();
    strip().click();
    expect(r.feature.drawer?.open).toBe(false);
    expect(statusText(r)).toBe("2 shells");
  });

  it("stays with the non-code toggle off, over a note", async () => {
    const r = await opened();
    r.setting.nonCodeDrawer = false;
    r.feature.applyVisibility();
    expect(statusText(r)).toBe("1 shell");
    expect(r.statusBar.children).toHaveLength(1);
  });

  it("is removed when the feature is disposed", async () => {
    const r = await opened();
    await r.feature.dispose();
    expect(r.statusBar.children).toHaveLength(0);
  });
});

describe("the non-code toggle (G11, GP6)", () => {
  it("GP6: a note with the toggle on keeps the drawer open under it and the shell untouched", async () => {
    const r = await opened();
    r.view.type = "markdown";
    r.feature.applyVisibility();
    expect(root().hidden).toBe(false);
    expect(root().classList.contains("vscw-open")).toBe(true);
    expect(r.feature.drawer?.hidden).toBe(false);
    expect(r.world.signals).toEqual([]);
    expect(r.world.spawned).toHaveLength(1);
  });

  it("the toggle governs markdown, canvas, graph, pdf and any other view identically", async () => {
    const r = await opened();
    for (const type of ["markdown", "canvas", "graph", "pdf", "empty"]) {
      r.view.type = type;
      r.setting.nonCodeDrawer = true;
      r.feature.applyVisibility();
      expect([type, root().hidden, r.feature.hotkeyEnabled()]).toEqual([type, false, true]);
      r.setting.nonCodeDrawer = false;
      r.feature.applyVisibility();
      expect([type, root().hidden, r.feature.hotkeyEnabled()]).toEqual([type, true, false]);
    }
  });

  it("GP6: toggle off hides the strip and drawer and the hotkey, keeps the shells running, and removes the layout offset completely", async () => {
    const r = await opened();
    await addTab();
    r.setting.nonCodeDrawer = false;
    r.feature.applyVisibility();
    expect(root().hidden).toBe(true);
    expect(document.body.classList.contains("vscw-terminal-on")).toBe(false);
    expect(document.body.classList.contains("vscw-terminal-open")).toBe(false);
    expect(px("--vscw-open-height")).toBe(0);
    expect(px("--vscw-status-lift")).toBe(0);
    expect(r.feature.hotkeyEnabled()).toBe(false);
    r.feature.toggle();
    expect(r.feature.drawer?.open).toBe(true); // the hotkey did nothing

    // The shells keep running: output still arrives, and nothing was signalled.
    r.world.spawned[0].child.output("still going");
    await tick();
    expect(r.views[0].text()).toContain("still going");
    expect(r.world.signals).toEqual([]);
    expect(r.feature.sessions.count).toBe(2);
    expect(statusText(r)).toBe("2 shells");
  });

  it("GP6: toggle back on brings the same sessions back with their scrollback and the drawer open", async () => {
    const r = await opened();
    await addTab();
    r.world.spawned[0].child.output("scrollback line\r\n");
    await tick();
    const before = r.feature.sessions.sessions.map((s) => s.id);
    r.setting.nonCodeDrawer = false;
    r.feature.applyVisibility();
    r.world.spawned[0].child.output("while hidden\r\n");
    await tick();
    r.setting.nonCodeDrawer = true;
    r.feature.applyVisibility();
    expect(root().hidden).toBe(false);
    expect(root().classList.contains("vscw-open")).toBe(true);
    expect(r.feature.sessions.sessions.map((s) => s.id)).toEqual(before);
    expect(tabLabels()).toEqual(["zsh 1", "zsh 2"]);
    expect(r.views[0].text()).toContain("scrollback line");
    expect(r.views[0].text()).toContain("while hidden");
    expect(r.world.spawned).toHaveLength(2);
    expect(px("--vscw-open-height")).toBe(300);
  });

  it("a Code tab always shows the strip, the drawer and the hotkey, even with the toggle off", async () => {
    const r = await opened();
    r.setting.nonCodeDrawer = false;
    r.view.type = "markdown";
    r.feature.applyVisibility();
    expect(root().hidden).toBe(true);
    r.view.type = CODE_VIEW;
    r.feature.applyVisibility();
    expect(root().hidden).toBe(false);
    expect(root().classList.contains("vscw-open")).toBe(true);
    expect(r.feature.hotkeyEnabled()).toBe(true);
    r.feature.toggle();
    expect(r.feature.drawer?.open).toBe(false);
  });

  it("the toggle key is ignored over a note with the toggle off, and the strip is gone to click", async () => {
    const r = rig();
    r.feature.mount();
    r.setting.nonCodeDrawer = false;
    r.feature.applyVisibility();
    r.feature.toggle();
    await tick();
    expect(r.feature.drawer?.open).toBe(false);
    expect(r.world.spawned).toHaveLength(0);
  });

  it("a restored open drawer starts no shell while it is hidden, and makes the first one when it comes into view", async () => {
    const data = { [DRAWER_KEY]: { "device-aaaa-1111": { height: 300, open: true } } };
    const r = rig({ data });
    r.setting.nonCodeDrawer = false;
    r.feature.mount();
    await tick();
    expect(root().hidden).toBe(true);
    expect(r.world.spawned).toHaveLength(0);
    r.view.type = CODE_VIEW;
    r.feature.applyVisibility();
    await tick();
    expect(r.world.spawned).toHaveLength(1);
    expect(tabLabels()).toEqual(["zsh 1"]);
  });

  it("closing the drawer removes the layout offset completely", async () => {
    const r = await opened();
    expect(px("--vscw-open-height")).toBe(300);
    strip().click();
    expect(px("--vscw-open-height")).toBe(0);
    expect(document.body.classList.contains("vscw-terminal-open")).toBe(false);
    expect(document.body.style.getPropertyValue("--vscw-status-lift")).toBe("0px");
    expect(r.feature.drawer?.open).toBe(false);
  });
});

describe("layout (G11)", () => {
  let main: HTMLElement;
  let rect = { left: 260, width: 1040 };

  beforeEach(() => {
    rect = { left: 260, width: 1040 };
    main = document.createElement("div");
    main.className = "workspace-split mod-root";
    main.getBoundingClientRect = () => ({ left: rect.left, right: rect.left + rect.width, width: rect.width, top: 0, bottom: 800, height: 800, x: rect.left, y: 0, toJSON: () => ({}) }) as DOMRect;
    document.body.appendChild(main);
  });

  it("with the drawer open the drawer takes the main pane area's left edge and width, and the area is shortened by the drawer's height", async () => {
    await opened();
    expect(px("--vscw-left")).toBe(260);
    expect(px("--vscw-width")).toBe(1040);
    expect(px("--vscw-open-height")).toBe(300);
  });

  it("the stylesheet shortens only the main pane area by that height and leaves the sidebars alone", () => {
    const css = fs.readFileSync(path.join(__dirname, "../../src/styles.css"), "utf8");
    const rule = /body\.vscw-terminal-on \.workspace-split\.mod-root\s*\{[^}]*\}/.exec(css)?.[0] ?? "";
    expect(rule).toMatch(/margin-bottom:\s*var\(--vscw-open-height\)/);
    expect(css).not.toMatch(/mod-left-split|mod-right-split/);
    expect(css).not.toMatch(/\.app-container\s*\{[^}]*--vscw-open-height/);
    expect(/\.vscw-drawer\s*\{[^}]*\}/.exec(css)?.[0]).toMatch(/left:\s*var\(--vscw-left[\s\S]*width:\s*var\(--vscw-width/);
  });

  it("collapsing a sidebar or resizing the window re-flows the width and refits the terminal, and the new size reaches the PTY", async () => {
    const r = await opened();
    const fits = r.views[0].fits;
    const sentBefore = r.world.spawned[0].child.sent().length;
    rect = { left: 0, width: 1300 }; // the left sidebar collapsed
    window.dispatchEvent(new Event("resize"));
    expect(px("--vscw-left")).toBe(0);
    expect(px("--vscw-width")).toBe(1300);
    expect(r.views[0].fits).toBeGreaterThan(fits);
    r.views[0].setCells(150, 30); // what the emulator reports after the fit
    expect(r.world.spawned[0].child.sent().length).toBeGreaterThan(sentBefore);
  });

  it("a layout change from the workspace (a pane moved) is picked up", async () => {
    const r = await opened();
    rect = { left: 260, width: 700 };
    r.feature.layoutChanged();
    expect(px("--vscw-width")).toBe(700);
  });

  it("each session's terminal size reaches its own shell, not the active one", async () => {
    const r = await opened();
    await addTab();
    const first = r.world.spawned[0].child.sent().length;
    const second = r.world.spawned[1].child.sent().length;
    r.views[0].setCells(101, 20);
    expect(r.world.spawned[0].child.sent().length).toBeGreaterThan(first);
    expect(r.world.spawned[1].child.sent().length).toBe(second);
  });

  it("switching tabs fits the terminal that comes into view", async () => {
    const r = await opened();
    await addTab();
    const fits = r.views[0].fits;
    tabs()[0].click();
    expect(r.views[0].fits).toBeGreaterThan(fits);
  });

  it("dispose takes every page variable and class away", async () => {
    const r = await opened();
    await r.feature.dispose();
    for (const v of ["--vscw-left", "--vscw-width", "--vscw-status-lift", "--vscw-open-height", "--vscw-height"]) expect(document.body.style.getPropertyValue(v)).toBe("");
    expect(document.body.classList.contains("vscw-terminal-on")).toBe(false);
  });
});

// --- Through the plugin: registration on desktop only, the live setting and the command --------------

describe("the plugin (F1, G11)", () => {
  let vault: string;
  let plugin: VSCodeWorkbenchPlugin | undefined;
  let mostRecent: { view: { getViewType(): string } } | null;
  let layoutHandlers: Array<() => void>;

  function makeApp(root: string): MockApp {
    const a: MockApp & { workspace: Record<string, unknown> } = {
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
        getLeavesOfType: () => [] as WorkspaceLeaf[],
        getLeaf: () => new WorkspaceLeaf(),
        revealLeaf: async () => undefined,
        detachLeavesOfType: () => undefined,
        getMostRecentLeaf: () => mostRecent,
        // A sidebar view (the file explorer) is the active one; the main-area tab is what decides.
        getActiveViewOfType: () => ({ getViewType: () => "file-explorer" }),
        on: (name: string, cb: () => void) => {
          if (name === "active-leaf-change" || name === "layout-change") layoutHandlers.push(cb);
          return { name, cb };
        },
      },
    } as never;
    return a;
  }

  async function load(data: Record<string, unknown> = {}): Promise<void> {
    plugin = new VSCodeWorkbenchPlugin(makeApp(vault) as never, { id: "obsidian-vscode-workbench", dir: ".obsidian/plugins/obsidian-vscode-workbench" } as never);
    (plugin as unknown as { pluginData: unknown }).pluginData = { serverLicenceAccepted: true, ...data };
    await plugin.onload();
  }

  const command = () => Plugin.commands.find((c) => c.id === "toggle-terminal-drawer");

  beforeEach(() => {
    vault = tempDir();
    Plugin.reset();
    Notice.reset();
    mostRecent = { view: { getViewType: () => "markdown" } };
    layoutHandlers = [];
    Platform.isDesktopApp = true;
  });

  afterEach(async () => {
    plugin?.onunload();
    plugin = undefined;
    Platform.isDesktopApp = true;
    await tick();
  });

  it("F1: off desktop the plugin adds no drawer, no strip, no command and no status-bar item", async () => {
    Platform.isDesktopApp = false;
    await load();
    expect(command()).toBeUndefined();
    expect(strip()).toBeNull();
    expect(Plugin.statusBarItems).toHaveLength(0);
  });

  it("on desktop it registers the command and the strip", async () => {
    await load();
    expect(command()).toBeDefined();
    expect(strip()).not.toBeNull();
  });

  it("the command is unavailable over a note with the toggle off, so the hotkey does nothing, and available over a Code tab", async () => {
    await load({ nonCodeDrawer: false });
    const check = command()?.checkCallback as (checking: boolean) => boolean;
    expect(root().hidden).toBe(true);
    expect(check(true)).toBe(false);
    expect(check(false)).toBe(false);
    expect(q(".vscw-drawer")).not.toBeNull();
    expect(root().classList.contains("vscw-open")).toBe(false);

    mostRecent = { view: { getViewType: () => CODE_VIEW } };
    for (const h of layoutHandlers) h(); // the workspace reports the active tab changed
    expect(root().hidden).toBe(false);
    expect(check(true)).toBe(true);
  });

  it("changing the setting applies live, with no reload", async () => {
    await load();
    expect(root().hidden).toBe(false);
    await plugin!.updateSettings({ nonCodeDrawer: false });
    expect(root().hidden).toBe(true);
    expect(document.body.classList.contains("vscw-terminal-on")).toBe(false);
    await plugin!.updateSettings({ nonCodeDrawer: true });
    expect(root().hidden).toBe(false);
    expect(document.body.classList.contains("vscw-terminal-on")).toBe(true);
  });

  it("a sidebar view being active does not count: the most recent main-area tab decides", async () => {
    await load({ nonCodeDrawer: false });
    expect(root().hidden).toBe(true); // a note, setting off
    mostRecent = { view: { getViewType: () => CODE_VIEW } };
    for (const h of layoutHandlers) h(); // active-leaf-change, with the file explorer the active view
    expect(root().hidden).toBe(false);
  });

  it("with no main-area leaf at all the setting decides, like any non-code view", async () => {
    mostRecent = null;
    await load({ nonCodeDrawer: false });
    expect(root().hidden).toBe(true);
  });
});
