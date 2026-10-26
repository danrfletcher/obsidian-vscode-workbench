import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceLeaf } from "../mocks/obsidian";
import { CodeView, VIEW_TYPE_CODE, baseName, runInWebview, type CodeViewHost } from "../../src/code-view";
import { BROWSER_APP_SETTINGS, buildBrowserSeedScript } from "../../src/settings";

class FakeEl {
  attrs: Record<string, string> = {};
  style: Record<string, string> = {};
  children: FakeEl[] = [];
  text = "";
  /** Every value `src` has been set to, in order. */
  srcs: string[] = [];
  executed: string[] = [];
  /** Fire `dom-ready` after the first src is set (a webview does once its page has loaded). */
  autoDomReady = true;
  executeResult: () => Promise<unknown> = async () => "seeded";
  private listeners: Record<string, (() => void)[]> = {};
  constructor(public tag: string) {}
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
    if (k === "src") {
      this.srcs.push(v);
      if (this.srcs.length === 1 && this.autoDomReady) setTimeout(() => this.fire("dom-ready"), 0);
    }
  }
  addEventListener(name: string, fn: () => void) {
    (this.listeners[name] ??= []).push(fn);
  }
  fire(name: string) {
    for (const fn of this.listeners[name]?.splice(0) ?? []) fn();
  }
  executeJavaScript(code: string) {
    this.executed.push(code);
    return this.executeResult();
  }
  appendChild(c: FakeEl) {
    this.children.push(c);
  }
  addClass() {}
  empty() {
    this.children = [];
    this.text = "";
  }
  createDiv(o: { text: string }) {
    this.text = o.text;
  }
  remove() {}
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
    ...host,
  };
  const view = new CodeView(new WorkspaceLeaf() as never, full);
  (view as unknown as { contentEl: FakeEl }).contentEl = new FakeEl("div");
  return { view, full, el: (view as unknown as { contentEl: FakeEl }).contentEl };
}

beforeEach(() => {
  vi.stubGlobal("document", { createElement: (t: string) => new FakeEl(t) });
});
afterEach(() => vi.unstubAllGlobals());

describe("CodeView", () => {
  it("is the vscode-workbench-code view, titled by the file name", async () => {
    const { view } = makeView();
    expect(view.getViewType()).toBe(VIEW_TYPE_CODE);
    expect(view.getDisplayText()).toBe("VS Code");
    await view.setState({ file: "Mock Exams/scripts/estimaté tïme 文件.py" }, {} as never);
    expect(view.getDisplayText()).toBe("estimaté tïme 文件.py");
    expect(baseName("a/b/c.py")).toBe("c.py");
  });

  it("persists only the vault-relative path, never the token or URL", async () => {
    const { view } = makeView();
    await view.setState({ file: "a/b.py" }, {} as never);
    expect(view.getState()).toEqual({ file: "a/b.py" });
  });

  it("embeds a webview whose src opens that file with the token", async () => {
    const { view, el } = makeView();
    await view.setState({ file: "My Dir/a b.py" }, {} as never);
    expect(el.children).toHaveLength(1);
    const wv = el.children[0];
    expect(wv.tag).toBe("webview");
    expect(wv.attrs.partition).toBe("persist:vscode-workbench");
    const url = new URL(wv.srcs[wv.srcs.length - 1]);
    expect(url.origin).toBe("http://127.0.0.1:5555");
    expect(url.searchParams.get("tkn")).toBe("tok123");
    expect(url.searchParams.get("folder")).toBe("/Users/dan/My Vault");
    const payload = JSON.parse(url.searchParams.get("payload") as string) as string[][];
    expect(payload[0][1]).toBe("vscode-remote://127.0.0.1:5555/Users/dan/My%20Vault/My%20Dir/a%20b.py");
  });

  it("seeds the browser profile's off switches on the server origin before it opens the workbench (F5)", async () => {
    const { view, el } = makeView();
    await view.setState({ file: "a.py" }, {} as never);
    const wv = el.children[0];
    expect(wv.srcs).toHaveLength(2);
    // first the bare origin (no workbench, no token), then the workbench
    expect(wv.srcs[0]).toBe("http://127.0.0.1:5555/");
    expect(wv.srcs[0]).not.toContain("tok123");
    expect(wv.srcs[1]).toContain("tkn=tok123");
    expect(wv.executed).toEqual([buildBrowserSeedScript()]);
    expect(wv.executed[0]).not.toContain("tok123");
  });

  it("puts the copied settings and keybindings into the seed script the host gives it (G17)", async () => {
    const copy = { id: "start-1", settings: { "editor.fontSize": 23 }, keybindingsBase64: Buffer.from("[]").toString("base64") };
    const { view, el } = makeView({ userDataCopy: () => copy });
    await view.setState({ file: "a.py" }, {} as never);
    expect(el.children[0].executed).toEqual([buildBrowserSeedScript(BROWSER_APP_SETTINGS, copy)]);
    expect(el.children[0].executed[0]).toContain('"editor.fontSize":23');
    expect(el.children[0].executed[0]).not.toContain("tok123");
  });

  it("still opens the workbench when the seed script fails", async () => {
    const { view, el } = makeView();
    const orig = document.createElement;
    vi.stubGlobal("document", {
      createElement: (t: string) => {
        const e = orig(t) as unknown as FakeEl;
        e.executeResult = async () => {
          throw new Error("IndexedDB blocked");
        };
        return e;
      },
    });
    await view.setState({ file: "a.py" }, {} as never);
    expect(el.children[0].srcs[1]).toContain("tkn=tok123");
  });

  it("does not navigate a webview that was replaced while it was being seeded", async () => {
    const { view, el } = makeView();
    const first = view.setState({ file: "a.py" }, {} as never);
    await new Promise((r) => setTimeout(r, 0));
    const stale = el.children[0];
    stale.executeResult = async () => {
      await view.setState({ file: "b.py" }, {} as never);
      return "seeded";
    };
    await first;
    expect(stale.srcs).toHaveLength(1);
  });

  it("can embed an iframe instead (spike switch), loading the workbench directly with no seeding", async () => {
    const { view, el } = makeView({ embedElement: () => "iframe" });
    await view.setState({ file: "a.py" }, {} as never);
    expect(el.children[0].tag).toBe("iframe");
    expect(el.children[0].attrs.partition).toBeUndefined();
    expect(el.children[0].srcs).toHaveLength(1);
    expect(el.children[0].executed).toEqual([]);
  });

  it("closes the tab instead of leaving a blank embed when the server cannot start", async () => {
    const { view, el } = makeView({
      ensureServer: async () => {
        throw new Error("boom");
      },
    });
    await view.setState({ file: "a.py" }, {} as never);
    expect(el.children).toHaveLength(0);
    expect((view.leaf as unknown as WorkspaceLeaf & { detached: boolean }).detached).toBe(true);
  });

  it("registers with the host on open and unregisters on close", async () => {
    const { view, full } = makeView();
    await view.onOpen();
    expect(full.trackView).toHaveBeenCalledWith(view);
    await view.onClose();
    expect(full.untrackView).toHaveBeenCalledWith(view);
  });
});

describe("runInWebview", () => {
  it("resolves after the timeout when the page never reports dom-ready", async () => {
    const el = new FakeEl("webview");
    await runInWebview(el as never, "x", 20);
    expect(el.executed).toEqual([]);
  });
});
