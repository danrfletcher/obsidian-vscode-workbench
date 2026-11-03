import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceLeaf } from "../mocks/obsidian";
import { CodeView, DIRTY_SCRIPT, VIEW_TYPE_CODE, baseName, logChromeOutcome, logGoToLine, logSeedOutcome, logTrustOutcome, runInWebview, runScriptsInWebview, type CodeViewHost } from "../../src/code-view";
import { LicenceDeclinedError } from "../../src/licence";
import { BROWSER_APP_SETTINGS, buildBrowserSeedScript } from "../../src/settings";
import { FakeWebview as FakeEl } from "../helpers";
import { buildTrustSeedScript } from "../../src/trust/trust-seed";
import { CHROME_SCRIPT_INSTALLED, buildChromeHideScript } from "../../src/chrome-script";
import { chromeKeybindings } from "../../src/chrome-settings";
import { GO_TO_LINE_DONE, buildGoToLineScript } from "../../src/goto-line-script";
import { OPEN_INTERCEPT_INSTALLED, OPEN_REPORT_PREFIX, OTHER_EDITOR_PREFIX, RESTORE_OPEN_SCRIPT, RESTORE_SWITCHED } from "../../src/open-intercept-script";
import type { EditorTarget } from "../../src/paths";
import { workbenchOverlay as workbenchOverlayFor } from "../../src/settings";

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

  it("F5: with embedElement() returning iframe and every hiding host method present, the tab opens, runs no page script and shows no error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { view, el } = makeView({
      embedElement: () => "iframe",
      chromeHiding: () => ({ keybindings: chromeKeybindings(), script: buildChromeHideScript() }),
      openFromEditor: vi.fn() as never,
      noteTrustOutcome: vi.fn(),
    });
    await view.setState({ file: "a.py" }, {} as never);
    const frame = el.children[0];
    frame.fire("dom-ready");
    await new Promise((r) => setTimeout(r, 0));
    // the tab opened: one iframe on the workbench URL with the token, and nothing else (no banner or message element)
    expect(el.children).toHaveLength(1);
    expect(frame.tag).toBe("iframe");
    expect(frame.srcs).toHaveLength(1);
    expect(frame.srcs[0]).toContain("tkn=tok123");
    // no page script of any kind: no seed, no hiding script, no open-from-editor script, no go-to-line
    expect(frame.executed).toEqual([]);
    // and nothing complained
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    warn.mockRestore();
    error.mockRestore();
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

  it("a script that fails does not stop the next one", async () => {
    const el = new FakeEl("webview");
    const answers: Array<() => Promise<unknown>> = [() => Promise.reject(new Error("rejected")), async () => "ok"];
    el.executeJavaScript = () => answers.shift()!();
    const ready = runScriptsInWebview(el as never, ["a", "b"], 1000);
    el.fire("dom-ready");
    expect(await ready).toEqual(["error:rejected", "ok"]);
  });

  it("timeoutMs is one budget for the whole sequence: a script that never answers uses it up, and the scripts after it are not run", async () => {
    const el = new FakeEl("webview");
    const answers: Array<() => Promise<unknown>> = [async () => "first", () => new Promise(() => undefined), async () => "never run"];
    const started: string[] = [];
    el.executeJavaScript = (code: string) => {
      started.push(code);
      return answers.shift()!();
    };
    const t0 = Date.now();
    const ready = runScriptsInWebview(el as never, ["a", "b", "c"], 60);
    el.fire("dom-ready");
    expect(await ready).toEqual(["first", "timeout", "timeout"]);
    expect(Date.now() - t0).toBeLessThan(150); // not 3 x 60 ms
    expect(started).toEqual(["a", "b"]);
  });

  it("the wait for dom-ready counts against the same budget", async () => {
    vi.useFakeTimers();
    try {
      const el = new FakeEl("webview");
      el.executeJavaScript = (code: string) => new Promise((resolve) => setTimeout(() => resolve(`done:${code}`), 40));
      const ready = runScriptsInWebview(el as never, ["a", "b"], 100);
      await vi.advanceTimersByTimeAsync(70);
      el.fire("dom-ready"); // 70 ms of the 100 ms are gone
      await vi.advanceTimersByTimeAsync(200);
      expect(await ready).toEqual(["timeout", "timeout"]); // "a" needs 40 ms but only 30 are left
    } finally {
      vi.useRealTimers();
    }
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
    expect(noteTrustOutcome).toHaveBeenCalledWith("build-failed");
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

describe("CodeView: the chrome-hiding script (GP1)", () => {
  const hiding = () => ({ keybindings: chromeKeybindings(), script: buildChromeHideScript() });
  const settle = () => new Promise((r) => setTimeout(r, 0));

  /** A webview that answers each script the way the page would: the chrome script with its install answer. */
  function stubWebviews(answerChrome: () => Promise<unknown>) {
    vi.stubGlobal("document", {
      createElement: (t: string) => {
        const e = new FakeEl(t);
        const execute = e.executeJavaScript.bind(e);
        e.executeJavaScript = (code: string) => {
          if (code === buildChromeHideScript()) {
            e.executed.push(code);
            return answerChrome();
          }
          return execute(code);
        };
        return e;
      },
    });
  }

  it("seeds the chords with the settings, then runs the script on the workbench page's own dom-ready, after it has been pointed at the file", async () => {
    stubWebviews(async () => CHROME_SCRIPT_INSTALLED);
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const { view, el } = makeView({ chromeHiding: hiding });
    await view.setState({ file: "a.py" }, {} as never);
    const wv = el.children[0];
    // the settings seed ran on the server origin page and carries the chords; the chrome script waits for the workbench page
    expect(wv.executed).toEqual([buildBrowserSeedScript(BROWSER_APP_SETTINGS, null, chromeKeybindings())]);
    expect(wv.executed[0]).toContain("workbench.action.closeSidebar");
    expect(wv.srcs[1]).toContain("tkn=tok123");
    wv.fire("dom-ready");
    await settle();
    expect(wv.executed).toEqual([buildBrowserSeedScript(BROWSER_APP_SETTINGS, null, chromeKeybindings()), buildChromeHideScript()]);
    expect(wv.executed[1]).not.toContain("tok123");
    expect(debug.mock.calls.flat().join(" ")).toContain("chrome-hiding script installed");
    debug.mockRestore();
  });

  it("does not hold the load for the workbench page: setState has finished before that dom-ready", async () => {
    stubWebviews(async () => CHROME_SCRIPT_INSTALLED);
    const { view, el } = makeView({ chromeHiding: hiding });
    await view.setState({ file: "a.py" }, {} as never); // resolves although the second dom-ready never fires here
    expect(el.children[0].executed).toHaveLength(1);
  });

  it("a script that fails, or a page that never reports dom-ready, is logged and the tab is already open (F3)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    stubWebviews(async () => {
      throw new Error("Blocked");
    });
    const { view, el } = makeView({ chromeHiding: hiding });
    await view.setState({ file: "a.py" }, {} as never);
    expect(el.children[0].srcs[1]).toContain("tkn=tok123");
    el.children[0].fire("dom-ready");
    await settle();
    expect(warn.mock.calls.flat().join(" ")).toContain("the chrome-hiding script did not run (error:Blocked)");
    warn.mockRestore();
  });

  it.each([
    ["throws", () => Promise.reject(new Error("Blocked")), "error:Blocked"],
    ["times out", () => Promise.resolve("timeout"), "timeout"],
    ["is unsupported", () => Promise.resolve("unsupported"), "unsupported"],
  ])("E1: a hiding script that %s is logged once through the log pattern, and the URL navigation still happened", async (_name, answer, shown) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    stubWebviews(answer as () => Promise<unknown>);
    const { view, el } = makeView({ chromeHiding: hiding });
    await view.setState({ file: "a.py" }, {} as never);
    expect(el.children[0].srcs[1]).toContain("tkn=tok123"); // navigated before the script's outcome was known
    el.children[0].fire("dom-ready");
    await settle();
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("chrome-hiding"));
    expect(lines).toEqual([`VS Code Workbench: the chrome-hiding script did not run (${shown}); this tab may show the side bar, secondary side bar or panel of VS Code.`]);
    warn.mockRestore();
  });

  it("E1: a webview without executeJavaScript answers unsupported for the chrome script as well, and the tab opens", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("document", {
      createElement: (t: string) => {
        const e = new FakeEl(t);
        (e as unknown as { executeJavaScript?: unknown }).executeJavaScript = undefined;
        return e;
      },
    });
    const { view, el } = makeView({ chromeHiding: hiding });
    await view.setState({ file: "a.py" }, {} as never);
    el.children[0].fire("dom-ready");
    await settle();
    expect(el.children[0].srcs[1]).toContain("tkn=tok123");
    expect(warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("chrome-hiding script did not run (unsupported)"))).toHaveLength(1);
    warn.mockRestore();
  });

  it("GP1: the overlay and the chords are read from the host and seeded on every load: a second tab, and a reload after the theme changed", async () => {
    let dark = false;
    const workbenchOverlay = vi.fn(() => workbenchOverlayFor({ dark }));
    const chromeHiding = vi.fn(hiding);
    let notify: (s: "stopped-by-idle") => void = () => undefined;
    const host = { workbenchOverlay, chromeHiding, onServerState: ((cb: (s: "stopped-by-idle") => void) => { notify = cb; return () => undefined; }) as never };
    const seeded = (el: FakeEl[]) => el.flatMap((c) => c.executed).filter((c) => c.includes("workbench.colorTheme"));
    const first = makeView(host);
    await first.view.onOpen();
    await first.view.setState({ file: "a.py" }, {} as never);
    const second = makeView(host);
    await second.view.setState({ file: "b.py" }, {} as never);
    const want = (d: boolean) => buildBrowserSeedScript({ ...BROWSER_APP_SETTINGS, ...workbenchOverlayFor({ dark: d }) }, null, chromeKeybindings());
    expect(seeded(first.el.children)).toEqual([want(false)]);
    expect(seeded(second.el.children)).toEqual([want(false)]);
    dark = true;
    notify("stopped-by-idle");
    await first.view.setState({ file: "a.py" }, {} as never); // stale: reloads with a fresh element and a fresh read of the host
    expect(seeded(first.el.children).at(-1)).toBe(want(true));
    expect(workbenchOverlay).toHaveBeenCalledTimes(3);
    expect(chromeHiding).toHaveBeenCalledTimes(3);
    expect(want(true)).toContain("Dark Modern");
  });

  it("F3: a host whose overlay cannot be built logs once and the tab still opens, the script still runs", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    stubWebviews(async () => CHROME_SCRIPT_INSTALLED);
    const { view, el } = makeView({
      chromeHiding: hiding,
      workbenchOverlay: () => {
        throw new Error("overlay broke");
      },
    });
    await view.setState({ file: "a.py" }, {} as never);
    expect(el.children[0].srcs[1]).toContain("tkn=tok123");
    expect(el.children[0].executed).toEqual([buildBrowserSeedScript(BROWSER_APP_SETTINGS, null, chromeKeybindings())]);
    expect(warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("settings were not built (overlay broke)"))).toHaveLength(1);
    warn.mockRestore();
  });

  it("F3: a host that throws something that is not an Error from the overlay or the script is logged by its text, and the tab still opens", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { view, el } = makeView({
      workbenchOverlay: () => {
        throw "overlay text"; // eslint-disable-line no-throw-literal
      },
      chromeHiding: () => {
        throw "script text"; // eslint-disable-line no-throw-literal
      },
    });
    await view.setState({ file: "a.py" }, {} as never);
    expect(el.children[0].srcs[1]).toContain("tkn=tok123");
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes("settings were not built (overlay text)"))).toBe(true);
    expect(lines.some((l) => l.includes("script was not built (script text)"))).toBe(true);
    warn.mockRestore();
  });

  it("a host that fails to build the script opens the tab with the chrome the settings leave, and says so", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { view, el } = makeView({
      chromeHiding: () => {
        throw new Error("no script");
      },
    });
    await view.setState({ file: "a.py" }, {} as never);
    expect(el.children[0].executed).toEqual([buildBrowserSeedScript()]);
    expect(el.children[0].srcs[1]).toContain("tkn=tok123");
    expect(warn.mock.calls.flat().join(" ")).toContain("was not built (no script)");
    warn.mockRestore();
  });

  it("without the host method (an older host) or with an iframe tab, no chords and no script", async () => {
    const older = makeView();
    await older.view.setState({ file: "a.py" }, {} as never);
    expect(older.el.children[0].executed).toEqual([buildBrowserSeedScript()]);
    const frame = makeView({ embedElement: () => "iframe", chromeHiding: hiding });
    await frame.view.setState({ file: "a.py" }, {} as never);
    expect(frame.el.children[0].executed).toEqual([]);
  });

  it("a load that was replaced before its workbench page was ready logs nothing for the old element", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    stubWebviews(async () => "timeout");
    const { view, el } = makeView({ chromeHiding: hiding });
    await view.setState({ file: "a.py" }, {} as never);
    const first = el.children[0];
    await view.setState({ file: "b.py" }, {} as never);
    first.fire("dom-ready");
    await settle();
    expect(warn.mock.calls.flat().join(" ")).not.toContain("chrome-hiding");
    warn.mockRestore();
  });

  describe("the editor takes keyboard focus on open", () => {
    /** Webviews that count focus() calls. */
    function focusStub() {
      const focused: FakeEl[] = [];
      vi.stubGlobal("document", {
        createElement: (t: string) => {
          const e = new FakeEl(t);
          (e as unknown as { focus: () => void }).focus = () => focused.push(e);
          return e;
        },
      });
      return focused;
    }

    it("focuses the active tab's webview when the workbench page's dom-ready fires, and not before", async () => {
      const focused = focusStub();
      const isActiveTab = vi.fn(() => true);
      const { view, el } = makeView({ isActiveTab, chromeHiding: hiding });
      await view.setState({ file: "a.py" }, {} as never);
      expect(focused).toEqual([]); // the server's origin page has been ready; the workbench page has not
      el.children[0].fire("dom-ready");
      await settle();
      expect(focused).toEqual([el.children[0]]);
      expect(isActiveTab).toHaveBeenCalledWith((view as unknown as { leaf: unknown }).leaf);
    });

    it("focuses without the chrome-hiding script too (the host gives no chords)", async () => {
      const focused = focusStub();
      const { view, el } = makeView({ isActiveTab: () => true });
      await view.setState({ file: "a.py" }, {} as never);
      el.children[0].fire("dom-ready");
      expect(focused).toEqual([el.children[0]]);
    });

    it("a background tab does not take focus", async () => {
      const focused = focusStub();
      const { view, el } = makeView({ isActiveTab: () => false, chromeHiding: hiding });
      await view.setState({ file: "a.py" }, {} as never);
      el.children[0].fire("dom-ready");
      await settle();
      expect(focused).toEqual([]);
    });

    it("a tab becomes active or not by the time the page is ready: the answer at that moment decides", async () => {
      const focused = focusStub();
      let active = false;
      const { view, el } = makeView({ isActiveTab: () => active });
      await view.setState({ file: "a.py" }, {} as never); // in the background while loading
      active = true; // the user switched to it before the page was ready
      el.children[0].fire("dom-ready");
      expect(focused).toEqual([el.children[0]]);
    });

    it("a load that was replaced does not take focus; the replacing load does", async () => {
      const focused = focusStub();
      const { view, el } = makeView({ isActiveTab: () => true, chromeHiding: hiding });
      await view.setState({ file: "a.py" }, {} as never);
      const first = el.children[0];
      await view.setState({ file: "b.py" }, {} as never);
      const second = el.children[0];
      expect(second).not.toBe(first);
      first.fire("dom-ready");
      await settle();
      expect(focused).toEqual([]);
      second.fire("dom-ready");
      await settle();
      expect(focused).toEqual([second]);
    });

    it("a tab with no host answer (no isActiveTab) takes no focus", async () => {
      const focused = focusStub();
      const { view, el } = makeView({ chromeHiding: hiding });
      await view.setState({ file: "a.py" }, {} as never);
      el.children[0].fire("dom-ready");
      await settle();
      expect(focused).toEqual([]);
    });
  });

  it("logChromeOutcome: debug for the install answer, a warning naming the parts for anything else", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    logChromeOutcome(CHROME_SCRIPT_INSTALLED);
    expect(debug).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    for (const outcome of ["timeout", "unsupported", "error:x"]) logChromeOutcome(outcome);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls[0][0]).toContain("side bar, secondary side bar or panel");
    debug.mockRestore();
    warn.mockRestore();
  });
});

describe("CodeView: a file opened from the editor becomes its own tab (PR-4)", () => {
  const hiding = () => ({ keybindings: chromeKeybindings(), script: buildChromeHideScript() });
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const OWN = "vscode-remote://127.0.0.1:5555/Users/dan/My%20Vault/a.py";
  const HELPER = "vscode-remote://127.0.0.1:5555/Users/dan/My%20Vault/lib/helper%20x.js";

  /** The nonce the tab made for this load, read off the script it ran in the page (what the page script prints with). */
  const nonceOf = (wv: FakeEl): string => {
    const script = wv.executed.find((c) => c.includes("__vscwOpen")) ?? "";
    return /__vscw_open__([0-9a-f-]+):/.exec(script)?.[1] ?? "";
  };
  const report = (wv: FakeEl, nonce: string, body: unknown) => wv.emit("console-message", { message: `${OPEN_REPORT_PREFIX}${nonce}:${JSON.stringify(body)}`, level: 0 });

  async function loaded(host: Partial<CodeViewHost> = {}) {
    const calls: Array<{ target: EditorTarget; line: number | null }> = [];
    const order: string[] = [];
    const openFromEditor = vi.fn(async (_from: unknown, target: EditorTarget, line: number | null) => void (calls.push({ target, line }), order.push("open")));
    const made = makeView({ chromeHiding: hiding, openFromEditor: openFromEditor as never, ...host });
    await made.view.setState({ file: "a.py" }, {} as never);
    const wv = made.el.children[0];
    const execute = wv.executeJavaScript.bind(wv);
    const restoreResult = { value: "pressed" as unknown };
    wv.executeJavaScript = (code: string) => {
      if (code === RESTORE_OPEN_SCRIPT) {
        order.push("restore");
        void execute(code);
        return Promise.resolve(restoreResult.value);
      }
      if (code.includes("__vscwOpen")) {
        void execute(code); // recorded as run; the fake page answers like a page the script installed in
        return Promise.resolve(OPEN_INTERCEPT_INSTALLED);
      }
      return execute(code);
    };
    wv.fire("dom-ready");
    await settle();
    return { ...made, wv, calls, order, openFromEditor, restoreResult, nonce: nonceOf(wv) };
  }

  it("runs the open-from-editor script on the workbench page with a nonce of its own, and nothing about the token", async () => {
    const t = await loaded();
    expect(t.nonce).toMatch(/^[0-9a-f-]{36}$/);
    expect(t.wv.executed.filter((c) => c.includes("__vscwOpen"))).toHaveLength(1);
    expect(t.wv.executed.join("\n")).not.toContain("tok123");
  });

  it("two loads use two nonces", async () => {
    const a = await loaded();
    const b = await loaded();
    expect(a.nonce).not.toBe(b.nonce);
  });

  it("a file reported by the page is put away in this tab and handed to the host as a vault file at its line; the tab keeps its own file", async () => {
    const t = await loaded();
    const srcs = [...t.wv.srcs];
    report(t.wv, t.nonce, { uri: HELPER, line: 5 });
    await vi.waitFor(() => expect(t.calls).toHaveLength(1));
    expect(t.calls[0]).toEqual({ target: { kind: "vault", file: "lib/helper x.js" }, line: 5 });
    expect(t.order).toEqual(["restore", "open"]); // the first tab shows its own file again before the new tab opens
    expect(t.openFromEditor.mock.calls[0][0]).toBe((t.view as unknown as { leaf: unknown }).leaf);
    // never navigates in place, and the first tab's state is not touched
    expect(t.view.filePath).toBe("a.py");
    expect(t.view.getState()).toEqual({ file: "a.py" });
    expect(t.wv.srcs).toEqual(srcs);
    expect(t.el.children).toHaveLength(1);
    expect(t.el.children[0]).toBe(t.wv);
  });

  it("a file the page reports with no line is handed on with a null line", async () => {
    const t = await loaded();
    report(t.wv, t.nonce, { uri: HELPER, line: null });
    await vi.waitFor(() => expect(t.calls).toHaveLength(1));
    expect(t.calls[0].line).toBeNull();
  });

  it("a file outside the vault is handed to the host as outside (it shows the notice); the editor is still put away", async () => {
    const t = await loaded();
    report(t.wv, t.nonce, { uri: "vscode-remote://127.0.0.1:5555/usr/lib/node_modules/typescript/lib/lib.d.ts", line: 9 });
    await vi.waitFor(() => expect(t.calls).toHaveLength(1));
    expect(t.calls[0].target).toEqual({ kind: "outside", path: "/usr/lib/node_modules/typescript/lib/lib.d.ts" });
    expect(t.order).toEqual(["restore", "open"]);
  });

  it.each([
    ["a message with another nonce (an extension printing)", (n: string) => ({ nonce: "x" + n, uri: HELPER })],
    ["a report of this tab's own file", (n: string) => ({ nonce: n, uri: OWN })],
    ["a report of another server's file", (n: string) => ({ nonce: n, uri: "vscode-remote://127.0.0.1:9999/Users/dan/My%20Vault/lib/h.js" })],
    ["a report of a file that is not a file URI", (n: string) => ({ nonce: n, uri: "untitled:Untitled-1" })],
  ])("%s does nothing: no host call, the editor is not touched", async (_name, make) => {
    const t = await loaded();
    const { nonce, uri } = make(t.nonce);
    report(t.wv, nonce, { uri, line: 3 });
    await settle();
    expect(t.calls).toEqual([]);
    expect(t.order).toEqual([]);
  });

  it("a message that is not a report is ignored", async () => {
    const t = await loaded();
    for (const message of ["hello", undefined, 5, `${OPEN_REPORT_PREFIX}${t.nonce}:{oops`]) t.wv.emit("console-message", { message });
    t.wv.emit("console-message", undefined);
    await settle();
    expect(t.calls).toEqual([]);
  });

  it("the same path spelled in the other Unicode form is the tab's own file: nothing opens", async () => {
    const nfd = "caf\u0065\u0301.py";
    const t = makeView({ chromeHiding: hiding, openFromEditor: vi.fn() as never });
    await t.view.setState({ file: nfd.normalize("NFC") }, {} as never);
    const wv = t.el.children[0];
    wv.fire("dom-ready");
    await settle();
    report(wv, nonceOf(wv), { uri: `vscode-remote://127.0.0.1:5555/Users/dan/My%20Vault/${encodeURIComponent(nfd)}`, line: 1 });
    await settle();
    expect(t.full.openFromEditor).not.toHaveBeenCalled();
  });

  it("a report from a page the tab has since replaced is ignored", async () => {
    const t = await loaded();
    await t.view.setState({ file: "b.py" }, {} as never); // the tab moved on (an explorer click handed it another file)
    report(t.wv, t.nonce, { uri: HELPER, line: 5 });
    await settle();
    expect(t.calls).toEqual([]);
  });

  it("a host that throws is logged and the tab stays open and unchanged (F3)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const t = await loaded({ openFromEditor: async () => { throw new Error("no server"); } });
    report(t.wv, t.nonce, { uri: HELPER, line: 5 });
    await vi.waitFor(() => expect(warn.mock.calls.flat().join(" ")).toContain("was not opened as a tab (no server)"));
    expect(t.view.filePath).toBe("a.py");
    warn.mockRestore();
  });

  it("a page that rejects with something that is not an Error is logged by its text, and the file is still handed on", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const t = await loaded();
    t.wv.executeJavaScript = () => Promise.reject("page gone"); // eslint-disable-line prefer-promise-reject-errors
    report(t.wv, t.nonce, { uri: HELPER, line: 5 });
    await vi.waitFor(() => expect(t.calls).toHaveLength(1));
    expect(warn.mock.calls.flat().join(" ")).toContain("could not put the opened editor away (page gone)");
    warn.mockRestore();
  });

  it("a host that rejects with something that is not an Error is logged by its text, and the tab stays open", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const t = await loaded({ openFromEditor: () => Promise.reject("no server") }); // eslint-disable-line prefer-promise-reject-errors
    report(t.wv, t.nonce, { uri: HELPER, line: 5 });
    await vi.waitFor(() => expect(warn.mock.calls.flat().join(" ")).toContain("was not opened as a tab (no server)"));
    expect(t.view.filePath).toBe("a.py");
    warn.mockRestore();
  });

  it("a page that cannot put the editor away is logged, and the file is still handed on", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const t = await loaded();
    t.wv.executeJavaScript = async () => { throw new Error("page gone"); };
    report(t.wv, t.nonce, { uri: HELPER, line: 5 });
    await vi.waitFor(() => expect(t.calls).toHaveLength(1));
    expect(warn.mock.calls.flat().join(" ")).toContain("could not put the opened editor away (page gone)");
    warn.mockRestore();
  });

  it.each(["no budget", "not installed", "blocked by a dialog", "dialog stays"])("a restore the page answers with '%s' is logged, and the file is still handed on", async (answer) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const t = await loaded();
    t.restoreResult.value = answer;
    report(t.wv, t.nonce, { uri: HELPER, line: 5 });
    await vi.waitFor(() => expect(t.calls).toHaveLength(1));
    expect(warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("put away"))).toEqual([
      `VS Code Workbench: the opened editor was not put away (${answer}); this tab may show the other file too.`,
    ]);
    warn.mockRestore();
  });

  it("T1: the opened file held unsaved edits, so the page cancelled the save prompt and showed the previous editor: the tab keeps its own file, the edits stay, and the file is still handed on", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const t = await loaded();
    t.restoreResult.value = RESTORE_SWITCHED;
    const srcs = [...t.wv.srcs];
    report(t.wv, t.nonce, { uri: HELPER, line: 5 });
    await vi.waitFor(() => expect(t.calls).toHaveLength(1));
    expect(t.order).toEqual(["restore", "open"]);
    expect(info.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("unsaved edits"))).toHaveLength(1);
    expect(warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("put away"))).toEqual([]);
    // the tab did not navigate, was not reloaded, and was not closed
    expect(t.view.filePath).toBe("a.py");
    expect(t.view.getState()).toEqual({ file: "a.py" });
    expect(t.wv.srcs).toEqual(srcs);
    expect(t.el.children[0]).toBe(t.wv);
    warn.mockRestore();
    info.mockRestore();
  });

  describe("R1: a page that may hold another editor behind the tab's file never reads clean", () => {
    /** The window title the tab's DIRTY_SCRIPT reads: the active editor is the tab's own file, so the title carries no dirty mark. */
    const titleReads = (wv: FakeEl, dirty: boolean) => {
      const run = wv.executeJavaScript.bind(wv);
      wv.executeJavaScript = (code: string) => (code === DIRTY_SCRIPT ? Promise.resolve(dirty) : run(code));
    };
    const quiet = () => [vi.spyOn(console, "warn").mockImplementation(() => undefined), vi.spyOn(console, "info").mockImplementation(() => undefined)];
    const choices = () => {
      const asked: Array<{ file: string; state: string }> = [];
      const confirmClose = vi.fn(async (req: { file: string; state: string }) => (asked.push({ file: req.file, state: req.state }), "cancel" as const));
      return { asked, confirmClose };
    };

    it("a restore that answered 'switched': the title reads clean, but the tab is unreadable, isDirty() is true, and closing asks (Cancel keeps the tab)", async () => {
      quiet();
      const c = choices();
      const t = await loaded({ confirmClose: c.confirmClose as never });
      titleReads(t.wv, false);
      expect(await t.view.bufferState()).toBe("clean"); // before: nothing else is in the page
      t.restoreResult.value = RESTORE_SWITCHED;
      report(t.wv, t.nonce, { uri: HELPER, line: 5 });
      await vi.waitFor(() => expect(t.calls).toHaveLength(1)); // the other file was handed on and opened from disk
      expect(await t.view.bufferState()).toBe("unreadable");
      expect(await t.view.isDirty()).toBe(true);
      await t.view.requestClose();
      expect(c.asked).toEqual([{ file: "a.py", state: "unreadable" }]);
      expect((t.view as unknown as { leaf: { detached: boolean } }).leaf.detached).toBe(false);
    });

    it("a title that does carry the dirty mark still reads dirty", async () => {
      quiet();
      const t = await loaded();
      titleReads(t.wv, true);
      t.restoreResult.value = RESTORE_SWITCHED;
      report(t.wv, t.nonce, { uri: HELPER, line: 5 });
      await vi.waitFor(() => expect(t.calls).toHaveLength(1));
      expect(await t.view.bufferState()).toBe("dirty");
    });

    it.each(["no budget", "not installed", "blocked by a dialog", "dialog stays"])("a restore answered '%s' leaves the tab unreadable, not clean", async (answer) => {
      quiet();
      const t = await loaded();
      titleReads(t.wv, false);
      t.restoreResult.value = answer;
      report(t.wv, t.nonce, { uri: HELPER, line: 5 });
      await vi.waitFor(() => expect(t.calls).toHaveLength(1));
      expect(await t.view.bufferState()).toBe("unreadable");
      expect(await t.view.isDirty()).toBe(true);
    });

    it("a restore that throws leaves the tab unreadable, not clean", async () => {
      quiet();
      const t = await loaded();
      const run = t.wv.executeJavaScript.bind(t.wv);
      t.wv.executeJavaScript = (code: string) => (code === RESTORE_OPEN_SCRIPT ? Promise.reject(new Error("page gone")) : code === DIRTY_SCRIPT ? Promise.resolve(false) : run(code));
      report(t.wv, t.nonce, { uri: HELPER, line: 5 });
      await vi.waitFor(() => expect(t.calls).toHaveLength(1));
      expect(await t.view.bufferState()).toBe("unreadable");
    });

    it("an open-from-editor script that did not install leaves the tab unreadable, not clean", async () => {
      quiet();
      const { view, el } = makeView({ chromeHiding: hiding, openFromEditor: vi.fn() as never });
      await view.setState({ file: "a.py" }, {} as never);
      const wv = el.children[0];
      wv.executeResult = async () => "seeded"; // not "installed"
      titleReads(wv, false);
      wv.fire("dom-ready");
      await settle();
      expect(await view.bufferState()).toBe("unreadable");
    });

    it("a restore that was pressed leaves the tab clean: close goes ahead with no prompt", async () => {
      quiet();
      const c = choices();
      const t = await loaded({ confirmClose: c.confirmClose as never });
      titleReads(t.wv, false);
      report(t.wv, t.nonce, { uri: HELPER, line: 5 });
      await vi.waitFor(() => expect(t.calls).toHaveLength(1));
      expect(await t.view.bufferState()).toBe("clean");
      await t.view.requestClose();
      expect(c.asked).toEqual([]);
      expect((t.view as unknown as { leaf: { detached: boolean } }).leaf.detached).toBe(true);
    });

    describe("R7: an editor VS Code keeps inside the tab (untitled, user settings, another server's file)", () => {
      const other = (wv: FakeEl, nonce: string, uri: string) => wv.emit("console-message", { message: `${OTHER_EDITOR_PREFIX}${nonce}:${JSON.stringify({ uri })}`, level: 0 });

      it.each(["untitled:Untitled-1", "vscode-userdata://127.0.0.1:5555/User/settings.json"])("%s shown in the page: the title reads clean, but the tab is unreadable, isDirty() is true, and closing asks", async (uri) => {
        quiet();
        const c = choices();
        const t = await loaded({ confirmClose: c.confirmClose as never });
        titleReads(t.wv, false);
        expect(await t.view.bufferState()).toBe("clean");
        other(t.wv, t.nonce, uri);
        expect(await t.view.bufferState()).toBe("unreadable");
        expect(await t.view.isDirty()).toBe(true);
        await t.view.requestClose();
        expect(c.asked).toEqual([{ file: "a.py", state: "unreadable" }]);
        expect((t.view as unknown as { leaf: { detached: boolean } }).leaf.detached).toBe(false);
        expect(t.calls).toEqual([]); // nothing was handed on and nothing was put away: it stays in the tab, as VS Code does
        expect(t.order).toEqual([]);
      });

      it("a vscode-remote file of another server (reported as an open, which the tab does not take) also marks the page", async () => {
        quiet();
        const t = await loaded();
        titleReads(t.wv, false);
        report(t.wv, t.nonce, { uri: "vscode-remote://127.0.0.1:9999/Users/dan/My%20Vault/lib/h.js", line: 3 });
        await settle();
        expect(t.calls).toEqual([]);
        expect(await t.view.bufferState()).toBe("unreadable");
      });

      it("a dirty title is still dirty", async () => {
        quiet();
        const t = await loaded();
        titleReads(t.wv, true);
        other(t.wv, t.nonce, "untitled:Untitled-1");
        expect(await t.view.bufferState()).toBe("dirty");
      });

      it("a notice with another nonce (an extension printing) marks nothing", async () => {
        quiet();
        const t = await loaded();
        titleReads(t.wv, false);
        other(t.wv, "x" + t.nonce, "untitled:Untitled-1");
        expect(await t.view.bufferState()).toBe("clean");
      });
    });

    it("a reload of the page clears it: the new page holds only the tab's file", async () => {
      quiet();
      const t = await loaded();
      titleReads(t.wv, false);
      t.restoreResult.value = RESTORE_SWITCHED;
      report(t.wv, t.nonce, { uri: HELPER, line: 5 });
      await vi.waitFor(() => expect(t.calls).toHaveLength(1));
      expect(await t.view.bufferState()).toBe("unreadable");
      await (t.view as unknown as { loadWorkbench(): Promise<void> }).loadWorkbench();
      expect((t.view as unknown as { mayHoldOtherEditor: boolean }).mayHoldOtherEditor).toBe(false);
    });
  });

  it("a restore that was pressed logs nothing about it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const t = await loaded();
    report(t.wv, t.nonce, { uri: HELPER, line: 5 });
    await vi.waitFor(() => expect(t.calls).toHaveLength(1));
    expect(warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("put away"))).toEqual([]);
    warn.mockRestore();
  });

  it("a script that did not install is logged once, and the tab is open", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { view, el } = makeView({ chromeHiding: hiding, openFromEditor: vi.fn() as never });
    await view.setState({ file: "a.py" }, {} as never);
    const wv = el.children[0];
    wv.executeResult = async () => { throw new Error("Blocked"); };
    wv.fire("dom-ready");
    await settle();
    expect(warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("open-from-editor"))).toEqual([
      "VS Code Workbench: the open-from-editor script did not install (error:Blocked); a file opened from this tab's editor opens inside the tab, as VS Code does.",
    ]);
    expect(el.children).toHaveLength(1);
    warn.mockRestore();
  });

  it("F5/F3: an iframe tab, a host without openFromEditor, and a host without chrome hiding all run no such script and listen to nothing", async () => {
    for (const make of [
      () => makeView({ embedElement: () => "iframe", chromeHiding: hiding, openFromEditor: vi.fn() as never }),
      () => makeView({ chromeHiding: hiding }),
      () => makeView({ openFromEditor: vi.fn() as never }),
    ]) {
      const { view, el } = make();
      await view.setState({ file: "a.py" }, {} as never);
      const wv = el.children[0];
      wv.fire("dom-ready");
      await settle();
      expect(wv.executed.some((c) => c.includes("__vscwOpen"))).toBe(false);
      wv.emit("console-message", { message: `${OPEN_REPORT_PREFIX}anything:{"uri":"${HELPER}","line":1}` });
      await settle();
    }
  });
});

describe("CodeView: the cursor line (PR-4, GP3)", () => {
  const hiding = () => ({ keybindings: chromeKeybindings(), script: buildChromeHideScript() });
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const goScripts = (wv: FakeEl) => wv.executed.filter((c) => c.includes("quick-input-widget"));

  it("a tab opened with a line puts its cursor there once the workbench page is ready; the line is not persisted", async () => {
    const { view, el } = makeView({ chromeHiding: hiding });
    await view.setState({ file: "a.py", line: 5 }, {} as never);
    const wv = el.children[0];
    expect(goScripts(wv)).toEqual([]); // not before the workbench page
    wv.fire("dom-ready");
    await settle();
    expect(goScripts(wv)).toEqual([buildGoToLineScript(5)]);
    expect(view.getState()).toEqual({ file: "a.py" });
  });

  it.each<[unknown, string?]>([[0], [-3], ["abc"], [NaN], [null, "none"], [undefined, "none"]])("a line of %j: line 1 for a bad value, no move when none was given", async (line, none) => {
    const { view, el } = makeView({ chromeHiding: hiding });
    await view.setState({ file: "a.py", line }, {} as never);
    el.children[0].fire("dom-ready");
    await settle();
    expect(goScripts(el.children[0])).toEqual(none ? [] : [buildGoToLineScript(1)]);
  });

  it("a line past the end of the file is passed on as it is: Go to Line puts the cursor on the last line", async () => {
    const { view, el } = makeView({ chromeHiding: hiding });
    await view.setState({ file: "a.py", line: 99999 }, {} as never);
    el.children[0].fire("dom-ready");
    await settle();
    expect(goScripts(el.children[0])).toEqual([buildGoToLineScript(99999)]);
    expect(buildGoToLineScript(99999)).toContain("const line = 99999;");
  });

  it("works without the chrome-hiding script too (the line is the tab's own business)", async () => {
    const { view, el } = makeView();
    await view.setState({ file: "a.py", line: 4 }, {} as never);
    el.children[0].fire("dom-ready");
    await settle();
    expect(goScripts(el.children[0])).toEqual([buildGoToLineScript(4)]);
  });

  it("an iframe cannot be scripted: the line is dropped and the tab opens (F5)", async () => {
    const { view, el } = makeView({ embedElement: () => "iframe" });
    await view.setState({ file: "a.py", line: 4 }, {} as never);
    expect(el.children[0].executed).toEqual([]);
  });

  it("goToLine on an open tab runs the script in the page now, and a bad line is line 1", async () => {
    const { view, el } = makeView({ chromeHiding: hiding });
    await view.setState({ file: "a.py" }, {} as never);
    const wv = el.children[0];
    wv.fire("dom-ready");
    await settle();
    wv.executeResult = async () => GO_TO_LINE_DONE;
    await view.goToLine(7);
    await view.goToLine(-1);
    await view.goToLine("junk");
    expect(goScripts(wv)).toEqual([buildGoToLineScript(7), buildGoToLineScript(1), buildGoToLineScript(1)]);
  });

  it("goToLine on a tab that is still loading keeps the line for its page; on a tab that has none it keeps it for the next load", async () => {
    const { view, el } = makeView({ chromeHiding: hiding });
    const loading = view.setState({ file: "a.py" }, {} as never);
    await settle(); // the load is under way: the server is up, the page is not
    await view.goToLine(9);
    await loading;
    const wv = el.children[0];
    wv.fire("dom-ready");
    await settle();
    expect(goScripts(wv)).toEqual([buildGoToLineScript(9)]);
  });

  it("a tab whose page cannot run the script logs it and stays open at its own cursor", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { view, el } = makeView({ chromeHiding: hiding });
    await view.setState({ file: "a.py" }, {} as never);
    el.children[0].fire("dom-ready");
    await settle();
    el.children[0].executeResult = async () => { throw new Error("gone"); };
    await view.goToLine(3);
    expect(warn.mock.calls.flat().join(" ")).toContain("the cursor was not moved to the requested line (error:gone)");
    expect(el.children).toHaveLength(1);
    warn.mockRestore();
  });

  it("a page that rejects with something that is not an Error is logged by its text, and the tab stays open", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { view, el } = makeView({ chromeHiding: hiding });
    await view.setState({ file: "a.py" }, {} as never);
    el.children[0].fire("dom-ready");
    await settle();
    el.children[0].executeResult = () => Promise.reject("page closed"); // eslint-disable-line prefer-promise-reject-errors
    await view.goToLine(3);
    expect(warn.mock.calls.flat().join(" ")).toContain("the cursor was not moved to the requested line (error:page closed)");
    expect(el.children).toHaveLength(1);
    warn.mockRestore();
  });

  it("a page without executeJavaScript (an iframe) logs the line as unsupported and the tab stays open", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { view, el } = makeView({ chromeHiding: hiding });
    await view.setState({ file: "a.py" }, {} as never);
    el.children[0].fire("dom-ready");
    await settle();
    (el.children[0] as unknown as { executeJavaScript?: unknown }).executeJavaScript = undefined;
    await view.goToLine(3);
    expect(warn.mock.calls.flat().join(" ")).toContain("the cursor was not moved to the requested line (unsupported)");
    expect(el.children).toHaveLength(1);
    warn.mockRestore();
  });

  it("logGoToLine: debug when the cursor moved, a warning with the reason when it did not", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    logGoToLine(GO_TO_LINE_DONE);
    expect(debug).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    logGoToLine("no editor");
    expect(warn.mock.calls[0][0]).toContain("(no editor)");
    debug.mockRestore();
    warn.mockRestore();
  });
});

describe("CodeView: a tab handed another file by Obsidian still holds one file (PR-4, GP2)", () => {
  it("a clean tab loads the new file alone: the old claim is given back, the page is replaced, and no page shows two files", async () => {
    const released: string[] = [];
    const { view, el } = makeView({ releaseFile: (f) => void released.push(f) });
    await view.setState({ file: "a.py" }, {} as never);
    const first = el.children[0];
    await view.setState({ file: "b.py" }, {} as never);
    const second = el.children[0];
    expect(second).not.toBe(first);
    expect(el.children).toHaveLength(1);
    expect(released).toEqual(["a.py"]);
    expect(view.filePath).toBe("b.py");
    const payloadOf = (src: string) => JSON.parse(new URL(src).searchParams.get("payload") as string) as string[][];
    expect(payloadOf(second.srcs.at(-1) as string)).toEqual([["openFile", "vscode-remote://127.0.0.1:5555/Users/dan/My%20Vault/b.py"]]);
  });

  it("a tab with unsaved edits asks first (the existing prompt), and on Cancel keeps its page and its file while the new file opens in its own tab", async () => {
    const opened: string[] = [];
    const asked: unknown[] = [];
    const { view, el } = makeView({
      confirmClose: async (r) => { asked.push(r); return "cancel"; },
      openInNewTab: (f) => void opened.push(f),
    });
    await view.setState({ file: "a.py" }, {} as never);
    const page = el.children[0];
    page.executeResult = async () => ({ dirty: true, state: "dirty" });
    vi.spyOn(view, "isDirty").mockResolvedValue(true);
    vi.spyOn(view, "bufferState").mockResolvedValue("dirty");
    await view.setState({ file: "b.py" }, {} as never);
    expect(asked).toHaveLength(1);
    expect(opened).toEqual(["b.py"]);
    expect(view.filePath).toBe("a.py");
    expect(el.children[0]).toBe(page);
    expect(page.srcs).toHaveLength(2); // origin page, then the workbench; never re-pointed
  });

  /** A tab with unsaved edits, handed b.py while it shows a.py; `answers` are what the user picks in the prompt, in turn. */
  async function dirtyTabHandedAnotherFile(answers: Array<"save" | "discard" | "cancel">, saveResults: boolean[] = []) {
    const released: string[] = [];
    const opened: string[] = [];
    const asked: Array<{ file: string; state: string; failed?: boolean }> = [];
    const order: string[] = [];
    const { view, el } = makeView({
      releaseFile: (f) => void released.push(f),
      openInNewTab: (f) => void opened.push(f),
      confirmClose: async (r) => {
        asked.push(r as never);
        order.push(`ask:${answers[0]}`);
        return answers.shift() ?? "cancel";
      },
    });
    await view.setState({ file: "a.py" }, {} as never);
    const first = el.children[0];
    first.executeResult = async () => ({ dirty: true, state: "dirty" });
    vi.spyOn(view, "isDirty").mockResolvedValue(true);
    vi.spyOn(view, "bufferState").mockResolvedValue("dirty");
    const save = vi.spyOn(view, "saveBuffers").mockImplementation(async () => (order.push("save"), saveResults.shift() ?? true));
    await view.setState({ file: "b.py" }, {} as never);
    return { view, el, first, released, opened, asked, save, order };
  }

  it("Save in the prompt: the edits are saved first, then this tab shows b.py alone (one page, one file, the old claim given back)", async () => {
    const t = await dirtyTabHandedAnotherFile(["save"]);
    expect(t.order).toEqual(["ask:save", "save"]);
    expect(t.save).toHaveBeenCalledTimes(1);
    expect(t.opened).toEqual([]); // not handed on to another tab: this tab is the one that shows b.py now
    expect(t.view.filePath).toBe("b.py");
    expect(t.released).toEqual(["a.py"]);
    expect(t.el.children).toHaveLength(1);
    expect(t.el.children[0]).not.toBe(t.first);
    const payload = JSON.parse(new URL(t.el.children[0].srcs.at(-1) as string).searchParams.get("payload") as string) as string[][];
    expect(payload).toEqual([["openFile", "vscode-remote://127.0.0.1:5555/Users/dan/My%20Vault/b.py"]]);
  });

  it("Don't save in the prompt: nothing is saved, and this tab shows b.py alone", async () => {
    const t = await dirtyTabHandedAnotherFile(["discard"]);
    expect(t.asked).toHaveLength(1);
    expect(t.save).not.toHaveBeenCalled();
    expect(t.opened).toEqual([]);
    expect(t.view.filePath).toBe("b.py");
    expect(t.released).toEqual(["a.py"]);
    expect(t.el.children).toHaveLength(1);
    expect(t.el.children[0]).not.toBe(t.first);
  });

  it("a save that does not finish asks again in the could-not-save wording; Cancel then keeps a.py and opens b.py in its own tab", async () => {
    const t = await dirtyTabHandedAnotherFile(["save", "cancel"], [false]);
    expect(t.asked.map((r) => r.failed ?? false)).toEqual([false, true]);
    expect(t.save).toHaveBeenCalledTimes(1);
    expect(t.opened).toEqual(["b.py"]);
    expect(t.view.filePath).toBe("a.py");
    expect(t.released).toEqual([]);
    expect(t.el.children[0]).toBe(t.first);
    expect(t.first.srcs).toHaveLength(2);
  });

  it("a tab with no unsaved edits is not asked at all", async () => {
    const asked: unknown[] = [];
    const { view } = makeView({ confirmClose: async (r) => (asked.push(r), "cancel") });
    await view.setState({ file: "a.py" }, {} as never);
    await view.setState({ file: "b.py" }, {} as never);
    expect(asked).toEqual([]);
    expect(view.filePath).toBe("b.py");
  });
});
