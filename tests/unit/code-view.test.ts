import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceLeaf } from "../mocks/obsidian";
import { CodeView, VIEW_TYPE_CODE, baseName, logSeedOutcome, logTrustOutcome, runInWebview, runScriptsInWebview, type CodeViewHost } from "../../src/code-view";
import { LicenceDeclinedError } from "../../src/licence";
import { BROWSER_APP_SETTINGS, buildBrowserSeedScript } from "../../src/settings";
import { FakeWebview as FakeEl } from "../helpers";
import { buildTrustSeedScript } from "../../src/trust/trust-seed";

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

  it("an iframe tab cannot be read, so it counts as holding unsaved edits: idle stop and quit keep it (PR-2 R6)", async () => {
    const { view, el } = makeView({ embedElement: () => "iframe" });
    await view.setState({ file: "a.py" }, {} as never);
    // a real iframe has no executeJavaScript
    (el.children[0] as unknown as { executeJavaScript?: unknown }).executeJavaScript = undefined;
    expect(await view.bufferState()).toBe("unreadable");
    expect(await view.isDirty()).toBe(true);
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

describe("CodeView: one tab per file and the open guard", () => {
  const leafOf = (view: CodeView) => view.leaf as unknown as WorkspaceLeaf & { detached: boolean };

  it("asks the host to admit the file before it asks for the server, with nothing awaited first", async () => {
    const order: string[] = [];
    const { view } = makeView({
      admitFile: async (f) => {
        order.push(`admit ${f}`);
        return true;
      },
      ensureServer: async () => {
        order.push("server");
        return { baseUrl: "http://127.0.0.1:5555", port: 5555, token: "tok123" };
      },
    });
    const pending = view.setState({ file: "a.py" }, {} as never);
    expect(order).toEqual(["admit a.py"]); // the claim is taken in the same tick setState is called
    await pending;
    expect(order).toEqual(["admit a.py", "server"]);
  });

  it("a refused file closes the tab and never loads the workbench", async () => {
    const ensure = vi.fn();
    const { view, el } = makeView({ admitFile: async () => false, ensureServer: ensure as never });
    await view.setState({ file: "big.log" }, {} as never);
    expect(leafOf(view).detached).toBe(true);
    expect(ensure).not.toHaveBeenCalled();
    expect(el.children).toHaveLength(0);
    expect(view.filePath).toBe("");
  });

  it("gives the claim back on close", async () => {
    const { view, full } = makeView({ releaseFile: vi.fn() });
    await view.setState({ file: "a.py" }, {} as never);
    await view.onClose();
    expect(full.releaseFile).toHaveBeenCalledWith("a.py", view.leaf);
  });

  it("gives the old claim back when the tab moves to another file", async () => {
    const { view, full } = makeView({ releaseFile: vi.fn() });
    await view.setState({ file: "a.py" }, {} as never);
    await view.setState({ file: "b.py" }, {} as never);
    expect(full.releaseFile).toHaveBeenCalledWith("a.py", view.leaf);
    expect(full.releaseFile).toHaveBeenCalledTimes(1);
  });

  it("a second setState with the file the tab already shows does not reload the workbench", async () => {
    const ensure = vi.fn(async () => ({ baseUrl: "http://127.0.0.1:5555", port: 5555, token: "tok123" }));
    const admit = vi.fn(async () => true);
    const { view, el } = makeView({ ensureServer: ensure, admitFile: admit });
    await view.setState({ file: "a.py" }, {} as never);
    const wv = el.children[0];
    await view.setState({ file: "a.py" }, {} as never);
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(admit).toHaveBeenCalledTimes(1);
    expect(el.children).toEqual([wv]); // same element, content not emptied
    expect(wv.srcs).toHaveLength(2); // seed origin + workbench, nothing more
    expect(leafOf(view).detached).toBe(false);
    expect(view.filePath).toBe("a.py");
  });

  it("a second setState with the same file while the first is still loading does not start another load", async () => {
    const ensure = vi.fn(async () => ({ baseUrl: "http://127.0.0.1:5555", port: 5555, token: "tok123" }));
    const { view } = makeView({ ensureServer: ensure });
    const first = view.setState({ file: "a.py" }, {} as never);
    const second = view.setState({ file: "a.py" }, {} as never); // while admitFile is still pending
    await Promise.all([first, second]);
    expect(ensure).toHaveBeenCalledTimes(1);
  });

  it("a tab that went stale or crashed does reload when it is given its own file again", async () => {
    const ensure = vi.fn(async () => ({ baseUrl: "http://127.0.0.1:5555", port: 5555, token: "tok123" }));
    let notify: (s: "stopped-by-idle") => void = () => undefined;
    const { view } = makeView({
      ensureServer: ensure,
      onServerState: ((cb: (s: "stopped-by-idle") => void) => {
        notify = cb;
        return () => undefined;
      }) as never,
    });
    await view.onOpen();
    await view.setState({ file: "a.py" }, {} as never);
    notify("stopped-by-idle");
    await view.setState({ file: "a.py" }, {} as never);
    expect(ensure).toHaveBeenCalledTimes(2);
  });

  it("a declined licence hands the file to the system app (a tab Obsidian opened itself)", async () => {
    const openInSystemApp = vi.fn();
    const { view } = makeView({
      openInSystemApp,
      ensureServer: async () => {
        throw new LicenceDeclinedError();
      },
    });
    await view.setState({ file: "a.py" }, {} as never);
    expect(openInSystemApp).toHaveBeenCalledWith("a.py");
    expect(leafOf(view).detached).toBe(true);
  });

  it("another start failure does not open the system app", async () => {
    const openInSystemApp = vi.fn();
    const { view } = makeView({
      openInSystemApp,
      ensureServer: async () => {
        throw new Error("boom");
      },
    });
    await view.setState({ file: "a.py" }, {} as never);
    expect(openInSystemApp).not.toHaveBeenCalled();
  });
});

describe("runInWebview", () => {
  it("resolves after the timeout when the page never reports dom-ready", async () => {
    const el = new FakeEl("webview");
    expect(await runInWebview(el as never, "x", 20)).toBe("timeout");
    expect(el.executed).toEqual([]);
  });

  it("resolves with what the script returned, and with the error's message when it throws", async () => {
    const ok = new FakeEl("webview");
    ok.executeResult = async () => "kept";
    const ready = runInWebview(ok as never, "x", 1000);
    ok.fire("dom-ready");
    expect(await ready).toBe("kept");
    const bad = new FakeEl("webview");
    bad.executeResult = async () => {
      throw new Error("Script failed to execute");
    };
    const failed = runInWebview(bad as never, "x", 1000);
    bad.fire("dom-ready");
    expect(await failed).toBe("error:Script failed to execute");
  });
});

describe("the seed outcome is logged (PR-1 R9)", () => {
  it("a Code tab logs a seed that did not apply, with the reason, and still opens the workbench", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { view, el } = makeView();
    vi.stubGlobal("document", { createElement: (t: string) => { const e = new FakeEl(t); e.executeResult = async () => "version-mismatch"; return e; } });
    await view.setState({ file: "a.py" }, {} as never);
    expect(el.children[0].srcs[1]).toContain("tkn=tok123");
    expect(warn.mock.calls.flat().join(" ")).toContain("version-mismatch");
    warn.mockRestore();
  });

  it("a seed that applied is only a debug line, and a timeout is a warning", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    logSeedOutcome("seeded");
    expect(warn).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledTimes(1);
    logSeedOutcome("timeout");
    expect(warn.mock.calls.flat().join(" ")).toContain("timeout");
    debug.mockRestore();
    warn.mockRestore();
  });
});

describe("runScriptsInWebview", () => {
  it("runs every script after the same dom-ready, in order, and answers one outcome each", async () => {
    const el = new FakeEl("webview");
    const order: string[] = [];
    el.executeJavaScript = (code: string) => {
      order.push(code);
      return Promise.resolve(`done:${code}`);
    };
    const ready = runScriptsInWebview(el as never, ["a", "b"], 1000);
    el.fire("dom-ready");
    expect(await ready).toEqual(["done:a", "done:b"]);
    expect(order).toEqual(["a", "b"]);
  });

  it("a script that fails or never answers does not stop the next one", async () => {
    const el = new FakeEl("webview");
    const answers: Array<() => Promise<unknown>> = [() => Promise.reject(new Error("rejected")), () => new Promise(() => undefined), async () => "ok"];
    el.executeJavaScript = () => answers.shift()!();
    const ready = runScriptsInWebview(el as never, ["a", "b", "c"], 30);
    el.fire("dom-ready");
    expect(await ready).toEqual(["error:rejected", "timeout", "ok"]);
  });

  it("a non-Error rejection is reported by its text, and a throw before a promise exists is an error outcome too", async () => {
    const el = new FakeEl("webview");
    const answers: Array<() => Promise<unknown>> = [() => Promise.reject("plain"), () => { throw new Error("sync"); }];
    el.executeJavaScript = () => answers.shift()!();
    const ready = runScriptsInWebview(el as never, ["a", "b"], 1000);
    el.fire("dom-ready");
    expect(await ready).toEqual(["error:plain", "error:sync"]);
  });

  it("answers timeout for every script when the page never reports dom-ready, and runs none", async () => {
    const el = new FakeEl("webview");
    expect(await runScriptsInWebview(el as never, ["a", "b"], 20)).toEqual(["timeout", "timeout"]);
    el.fire("dom-ready"); // late: nothing runs now
    await new Promise((r) => setTimeout(r, 0));
    expect(el.executed).toEqual([]);
  });

  it("answers unsupported for every script when the element has no executeJavaScript", async () => {
    const el = new FakeEl("webview");
    (el as unknown as { executeJavaScript?: unknown }).executeJavaScript = undefined;
    const ready = runScriptsInWebview(el as never, ["a", "b"], 1000);
    el.fire("dom-ready");
    expect(await ready).toEqual(["unsupported", "unsupported"]);
    el.fire("dom-ready");
    const one = new FakeEl("webview");
    (one as unknown as { executeJavaScript?: unknown }).executeJavaScript = undefined;
    const single = runInWebview(one as never, "x", 1000);
    one.fire("dom-ready");
    expect(await single).toBe("unsupported");
  });
});

describe("the trust seed in loadWorkbench (G5, G6, E3, GP3)", () => {
  const expectedScript = (port = 5555, held: number[] = [port], vault = "/Users/dan/My Vault") =>
    buildTrustSeedScript({ origin: `http://127.0.0.1:${port}`, folderUri: `vscode-remote://127.0.0.1:${port}${vault.split("/").map(encodeURIComponent).join("/")}`, heldPorts: held });
  const on = (extra: Partial<CodeViewHost> = {}): Partial<CodeViewHost> => ({ trustVaultFolder: () => true, heldPorts: () => [5555], noteTrustOutcome: vi.fn(), ...extra });

  it("with the setting on, runs the settings seed and then the trust seed, from the same page, before the workbench src is set", async () => {
    const { view, el } = makeView(on());
    await view.setState({ file: "a.py" }, {} as never);
    const wv = el.children[0];
    expect(wv.executed).toEqual([buildBrowserSeedScript(), expectedScript()]);
    expect(wv.srcs).toHaveLength(2);
    expect(wv.srcs[0]).toBe("http://127.0.0.1:5555/"); // both ran on the bare origin
    expect(wv.srcs[1]).toContain("tkn=tok123");
    expect(wv.executed[1]).not.toContain("tok123");
    expect(wv.executed[1]).toContain('"path":"/Users/dan/My Vault"');
  });

  it("runs on every load: a second tab and a reload each run it again", async () => {
    const { view: first, el: firstEl } = makeView(on());
    await first.setState({ file: "a.py" }, {} as never);
    const { view: second, el: secondEl } = makeView(on());
    await second.setState({ file: "b.py" }, {} as never);
    expect(firstEl.children[0].executed.filter((c) => c.includes("content.trust.model.key"))).toHaveLength(1);
    expect(secondEl.children[0].executed.filter((c) => c.includes("content.trust.model.key"))).toHaveLength(1);
    let notify: (s: "stopped-by-idle") => void = () => undefined;
    const reload = makeView(on({ onServerState: ((cb: (s: "stopped-by-idle") => void) => { notify = cb; return () => undefined; }) as never }));
    await reload.view.onOpen();
    await reload.view.setState({ file: "a.py" }, {} as never);
    notify("stopped-by-idle");
    await reload.view.setState({ file: "a.py" }, {} as never); // stale: reloads
    expect(reload.el.children.flatMap((c) => c.executed).filter((c) => c.includes("content.trust.model.key"))).toHaveLength(1); // the reload built a fresh element
  });

  it("with the setting off, never runs the trust script, and tells the host nothing", async () => {
    const noteTrustOutcome = vi.fn();
    const { view, el } = makeView({ trustVaultFolder: () => false, heldPorts: () => [5555], noteTrustOutcome });
    await view.setState({ file: "a.py" }, {} as never);
    expect(el.children[0].executed).toEqual([buildBrowserSeedScript()]);
    expect(noteTrustOutcome).not.toHaveBeenCalled();
  });

  it("without the host methods (an older host), runs only the settings seed", async () => {
    const { view, el } = makeView();
    await view.setState({ file: "a.py" }, {} as never);
    expect(el.children[0].executed).toEqual([buildBrowserSeedScript()]);
  });

  it("reads the setting at every load: the toggle applies at the next tab load", async () => {
    let enabled = true;
    const { view, el } = makeView(on({ trustVaultFolder: () => enabled }));
    await view.setState({ file: "a.py" }, {} as never);
    expect(el.children[0].executed).toHaveLength(2);
    enabled = false;
    await view.setState({ file: "b.py" }, {} as never);
    expect(el.children[0].executed).toHaveLength(1);
  });

  it("passes the ports of running servers, and a missing list as an empty one", async () => {
    const a = makeView(on({ heldPorts: () => [5555, 6000] }));
    await a.view.setState({ file: "a.py" }, {} as never);
    expect(a.el.children[0].executed[1]).toBe(expectedScript(5555, [5555, 6000]));
    const b = makeView({ trustVaultFolder: () => true });
    await b.view.setState({ file: "a.py" }, {} as never);
    expect(b.el.children[0].executed[1]).toBe(expectedScript(5555, []));
  });

  it("a restart passes the new port", async () => {
    const { view, el } = makeView(
      on({
        ensureServer: async () => ({ baseUrl: "http://127.0.0.1:6001", port: 6001, token: "tok999" }),
        heldPorts: () => [6001, 7000],
      }),
    );
    await view.setState({ file: "a.py" }, {} as never);
    expect(el.children[0].executed[1]).toBe(expectedScript(6001, [6001, 7000]));
  });

  it("logs the outcome to the console and hands it to the host", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const noteTrustOutcome = vi.fn();
    const { view } = makeView(on({ noteTrustOutcome }));
    await view.setState({ file: "a.py" }, {} as never);
    expect(debug.mock.calls.flat().join(" ")).toContain("vault folder trusted");
    expect(noteTrustOutcome).toHaveBeenCalledWith("seeded");
    debug.mockRestore();
  });

  const stubWebviews = (setup: (e: FakeEl) => void) =>
    vi.stubGlobal("document", {
      createElement: (t: string) => {
        const e = new FakeEl(t);
        setup(e);
        return e;
      },
    });

  it.each(["version-mismatch", "no-store", "error:SecurityError"])(
    "still opens the workbench when the trust seed answers %s, warns with the manual steps, and tells the host",
    async (outcome) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const noteTrustOutcome = vi.fn();
      const { view, el } = makeView(on({ noteTrustOutcome }));
      stubWebviews((e) => (e.trustResult = async () => outcome));
      await view.setState({ file: "a.py" }, {} as never);
      expect(el.children[0].srcs[1]).toContain("tkn=tok123");
      expect(noteTrustOutcome).toHaveBeenCalledWith(outcome);
      const text = warn.mock.calls.flat().join(" ");
      expect(text).toContain(outcome);
      expect(text).toContain("Workspaces: Manage Workspace Trust");
      warn.mockRestore();
    },
  );

  it("a rejected trust script is an error outcome and the tab still opens", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const noteTrustOutcome = vi.fn();
    const { view, el } = makeView(on({ noteTrustOutcome }));
    stubWebviews((e) =>
      (e.trustResult = async () => {
        throw new Error("Script failed to execute");
      }),
    );
    await view.setState({ file: "a.py" }, {} as never);
    expect(el.children[0].srcs[1]).toContain("tkn=tok123");
    expect(noteTrustOutcome).toHaveBeenCalledWith("error:Script failed to execute");
    warn.mockRestore();
  });

  it("a webview without executeJavaScript: both seeds answer unsupported and the tab still opens", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const noteTrustOutcome = vi.fn();
    const { view, el } = makeView(on({ noteTrustOutcome }));
    stubWebviews((e) => ((e as unknown as { executeJavaScript?: unknown }).executeJavaScript = undefined));
    await view.setState({ file: "a.py" }, {} as never);
    expect(el.children[0].srcs[1]).toContain("tkn=tok123");
    expect(noteTrustOutcome).toHaveBeenCalledWith("unsupported");
    warn.mockRestore();
  });

  it("a page that never reports dom-ready: the seeds time out and the tab still opens", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const noteTrustOutcome = vi.fn();
      const { view, el } = makeView(on({ noteTrustOutcome }));
      stubWebviews((e) => (e.autoDomReady = false));
      const loading = view.setState({ file: "a.py" }, {} as never);
      await vi.advanceTimersByTimeAsync(8001);
      await loading;
      expect(el.children[0].executed).toEqual([]);
      expect(el.children[0].srcs[1]).toContain("tkn=tok123");
      expect(noteTrustOutcome).toHaveBeenCalledWith("timeout");
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("an iframe tab runs no seed at all, so no trust script", async () => {
    const noteTrustOutcome = vi.fn();
    const { view, el } = makeView(on({ embedElement: () => "iframe", noteTrustOutcome }));
    await view.setState({ file: "a.py" }, {} as never);
    expect(el.children[0].executed).toEqual([]);
    expect(noteTrustOutcome).not.toHaveBeenCalled();
  });

  it("a vault folder the seed refuses to name (the file system root) logs why, opens the tab in Restricted Mode and tells the host", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const noteTrustOutcome = vi.fn();
    const { view, el } = makeView(on({ vaultRoot: () => "/", noteTrustOutcome }));
    await view.setState({ file: "a.py" }, {} as never);
    expect(el.children[0].executed).toEqual([buildBrowserSeedScript()]);
    expect(el.children[0].srcs[1]).toContain("tkn=tok123");
    expect(warn.mock.calls.flat().join(" ")).toContain("file system root");
    expect(noteTrustOutcome).toHaveBeenCalledWith("error:Error");
    warn.mockRestore();
  });

  it("a vault path with spaces and non-ASCII characters is encoded like the URL builder's, and recorded decoded", async () => {
    const vault = "/Users/dan/Mon Coffre/Zürich 文件";
    const { view, el } = makeView(on({ vaultRoot: () => vault }));
    await view.setState({ file: "a.py" }, {} as never);
    const script = el.children[0].executed[1];
    expect(script).toBe(expectedScript(5555, [5555], vault));
    expect(script).toContain(`"path":${JSON.stringify(vault)}`);
  });

  it("logTrustOutcome: seeded is a debug line, anything else a warning that names the manual command", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    logTrustOutcome("seeded");
    expect(warn).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledTimes(1);
    logTrustOutcome("no-store");
    expect(warn.mock.calls.flat().join(" ")).toMatch(/no-store.*Workspaces: Manage Workspace Trust/);
    debug.mockRestore();
    warn.mockRestore();
  });
});
