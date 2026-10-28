/**
 * The Extensions section of the settings tab, against a fake SettingsHost and the obsidian mock: the list
 * (G3, G4, G16), the empty and not-running cases, the stale-render drop, and no mutating control (F2).
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/settings/data";
import { buildExtensionList } from "../../src/settings/extension-list";
import type { ExtensionListView } from "../../src/settings/extension-states";
import { LIST_FAILED, LIST_LOADING, renderExtensionList } from "../../src/settings/extensions-section";
import { SPIKE_RESULT } from "../../src/settings/spike-result";
import { WorkbenchSettingTab, type SettingsHost } from "../../src/settings/settings-tab";
import { IDS, logText, makeTree, runningInput } from "../fixtures/extensions-section/tree";
import { FakeNode, Setting } from "../mocks/obsidian";

describe("the extension list in the Extensions section (G11, G16, F2)", () => {
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const LISTED: ExtensionListView = {
    status: "listed",
    rows: [
      { id: "a.one", name: "One", version: "1.0.0", state: "active", stateLabel: "active", reason: "activated by the extension host" },
      { id: "b.two", name: "Two", version: "2.0.0", state: "failed", stateLabel: "failed", reason: "<b>boom</b>" },
      { id: "c.three", name: "Three", version: "3.0.0", state: "disabled", stateLabel: "disabled in VS Code", reason: "switched off in desktop VS Code" },
    ],
  };

  function open(rows: () => Promise<ExtensionListView>) {
    const host: SettingsHost = {
      restartServer: async () => undefined,
      serverState: () => "running",
      workbenchSettings: () => ({ ...DEFAULT_SETTINGS }),
      updateSettings: async () => undefined,
      scanInstances: async () => ({ instances: [], rejected: [], customFailure: null }),
      verifyCustomCli: async () => ({ ok: false, reason: "no" }),
      codeCliOverride: () => undefined,
      portStatus: () => ({ stored: null, current: null, note: null }),
      spikeResult: () => SPIKE_RESULT,
      mirroredProfile: () => ({ status: "not-read" }),
      extensionRows: rows,
    };
    Setting.reset();
    const tab = new WorkbenchSettingTab({} as never, {} as never, host);
    tab.display();
    const el = tab.containerEl as unknown as FakeNode;
    const list = () => el.all().find((n) => n.cls === "workbench-extension-list")!;
    return { tab, el, list, items: () => el.all().filter((n) => n.cls?.includes("workbench-extension-item")) };
  }

  it("shows \"Reading…\" first, then one item per extension with name, id and version, and state and reason", async () => {
    const t = open(async () => LISTED);
    expect(t.list().textContent()).toBe(LIST_LOADING);
    await settle();
    const items = t.items();
    expect(items.map((i) => i.children.map((c) => c.text))).toEqual([
      ["One", "a.one · 1.0.0", "active: activated by the extension host"],
      ["Two", "b.two · 2.0.0", "failed: <b>boom</b>"],
      ["Three", "c.three · 3.0.0", "disabled in VS Code: switched off in desktop VS Code"],
    ]);
    expect(items.map((i) => i.cls)).toEqual([
      "workbench-extension-item workbench-ok",
      "workbench-extension-item workbench-error",
      "workbench-extension-item workbench-info",
    ]);
    expect(t.list().textContent()).not.toContain(LIST_LOADING);
  });

  it("has no control: no button, toggle or setting in the list (F2)", async () => {
    const t = open(async () => LISTED);
    await settle();
    expect(t.list().buttons()).toEqual([]);
    expect(t.list().all().every((n) => n.tag === "div")).toBe(true);
    // the only controls on the tab are the ones that were already there
    expect(Setting.all.map((s) => s.name).filter((n) => /extension/i.test(n))).toEqual(["Excluded file extensions"]);
  });

  it("sits under the Extensions heading, ahead of the recorded-result rows", async () => {
    const t = open(async () => LISTED);
    await settle();
    const box = t.el.all().find((n) => n.cls === "workbench-extensions")!;
    expect(box.children[0].text).toBe("Extensions");
    expect(box.children[2]).toBe(t.list());
    expect(box.children[3].cls).toContain("workbench-extensions-row");
  });

  it("the section sits after Instances and before Restart server, with the line about Restart server under the heading", async () => {
    const t = open(async () => LISTED);
    await settle();
    // The instance list's container is the first child of the tab, so the section (index > 0) comes after it.
    const top = t.el.children;
    const sectionIdx = top.findIndex((c) => c.children.some((x) => x.cls === "workbench-extensions"));
    expect(sectionIdx).toBeGreaterThan(0);
    // The tab's own settings are created in order: Trust the vault folder (just before the section), then Restart server (after it).
    const names = Setting.all.map((s) => s.name);
    expect(names.indexOf("Trust the vault folder")).toBeGreaterThan(-1);
    expect(names.indexOf("Restart server")).toBeGreaterThan(names.indexOf("Trust the vault folder"));
    // Restart server is drawn straight into the tab, so it comes after every child made before it, the section included.
    const restart = Setting.all.find((s) => s.name === "Restart server")!;
    expect(restart.containerEl).toBe(t.el);
    expect(t.el.children[sectionIdx].children[0].children[0].text).toBe("Extensions");
    expect(t.el.children[sectionIdx].children[0].children[1].text).toBe("Changes made in desktop VS Code show here after Restart server.");
  });

  it("server not running: says so, and lists nothing", async () => {
    const t = open(async () => ({ status: "server-not-running" }));
    await settle();
    expect(t.list().textContent()).toBe("server not running");
    expect(t.items()).toEqual([]);
  });

  it("empty: \"No extensions shared\" with the reason", async () => {
    const t = open(async () => ({ status: "empty", message: "No extensions shared", reason: "the profile lists no extensions" }));
    await settle();
    expect(t.list().children.map((c) => c.text)).toEqual(["No extensions shared", "the profile lists no extensions"]);
  });

  it("a host that rejects or throws shows one plain line and leaves the rest of settings drawn", async () => {
    for (const rows of [
      async (): Promise<ExtensionListView> => {
        throw new Error("secret detail");
      },
      (): Promise<ExtensionListView> => {
        throw new Error("secret detail");
      },
    ]) {
      const t = open(rows);
      await settle();
      expect(t.list().textContent()).toBe(LIST_FAILED);
      expect(t.el.textContent()).not.toContain("secret");
      expect(Setting.all.find((x) => x.name === "Restart server")).toBeDefined();
    }
  });

  it("asks the host again each time settings opens, and a slow answer for an earlier display never overwrites the later one", async () => {
    const answers: Array<(v: ExtensionListView) => void> = [];
    let calls = 0;
    const t = open(() => {
      calls++;
      return new Promise<ExtensionListView>((resolve) => answers.push(resolve));
    });
    await settle();
    t.tab.display();
    await settle();
    expect(calls).toBe(2);
    answers[1]({ status: "listed", rows: [LISTED.status === "listed" ? LISTED.rows[0] : (null as never)] });
    await settle();
    answers[0]({ status: "server-not-running" });
    await settle();
    const items = (t.tab.containerEl as unknown as FakeNode).all().filter((n) => n.cls?.includes("workbench-extension-item"));
    expect(items.map((i) => i.children[0].text)).toEqual(["One"]);
    expect((t.tab.containerEl as unknown as FakeNode).textContent()).not.toContain("server not running");
  });

  it("renderExtensionList redraws from empty: a second call replaces the first", () => {
    const el = new FakeNode("div");
    renderExtensionList(el as unknown as HTMLElement, LISTED);
    renderExtensionList(el as unknown as HTMLElement, { status: "server-not-running" });
    expect(el.textContent()).toBe("server not running");
  });

  it("end to end with the real builder: a failing extension, a disabled one and an active one on a real tree", async () => {
    const tree = makeTree({ disabled: [IDS.gitlens], logs: { exthost1: `${logText("failing")}${logText("healthy")}` } });
    const t = open(() => buildExtensionList(runningInput(tree)));
    for (let i = 0; i < 200 && t.items().length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    const text = (id: string) => t.items().find((i) => i.children[1].text.startsWith(`${id} ·`))?.children[2].text;
    expect(text(IDS.gitlens)).toMatch(/^disabled in VS Code: /);
    expect(text(IDS.pylance)).toBe("failed: Error: Pylance can only be used with Microsoft's own builds of VS Code.");
    expect(text(IDS.turbo)).toMatch(/^active: /);
    expect(t.items()).toHaveLength(8);
  });

  it("the list is drawn with a snapshot that says \"no extensions shared\" (disabled list unreadable): that message, not server not running", async () => {
    const tree = makeTree();
    const mirror = {
      ...tree.mirror,
      disabled: { source: "none" as const, disabled: [], why: "desktop VS Code's disabled list could not be read and there is no earlier copy" },
    };
    const t = open(() => buildExtensionList(runningInput(tree, { mirror: mirror as never })));
    for (let i = 0; i < 200 && t.list().children.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
    expect(t.list().children.map((c) => c.text)).toEqual(["No extensions shared", mirror.disabled.why]);
    expect(t.list().textContent()).not.toContain("server not running");
  });

  it("two entries for one extension id: only one row, the first the profile lists", async () => {
    const tree = makeTree();
    const dupe = JSON.parse(JSON.stringify(tree.mirror.extensions));
    const first = dupe.extensions.find((e: { id: string }) => e.id === "ms-python.python");
    const older = { ...first, folder: "ms-python.python-2025.1.0", entry: { ...first.entry, version: "2025.1.0" } };
    dupe.extensions.push(older);
    const t = open(() => buildExtensionList(runningInput(tree, { mirror: { ...tree.mirror, extensions: dupe } })));
    for (let i = 0; i < 200 && t.items().length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    const python = t.items().filter((i) => i.children[1].text.startsWith("ms-python.python ·"));
    expect(python).toHaveLength(1);
    expect(python[0].children[1].text).toBe(`ms-python.python · ${first.entry.version}`);
    expect(t.items()).toHaveLength(8);
  });
});
