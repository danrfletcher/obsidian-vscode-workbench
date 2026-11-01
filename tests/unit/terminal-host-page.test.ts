import { afterEach, describe, expect, it, vi } from "vitest";
import { StartCancelledError } from "../../src/server";
import { LicenceDeclinedError } from "../../src/licence";
import { TERMINAL_PARTITION } from "../../src/terminal-host/host-url";
import { CANCELLED_TEXT, DECLINED_NOTICE, LICENCE_TEXT, LOST_TEXT, NOT_LOADED_TEXT, NOT_PANEL_TEXT, STARTING_TEXT, TerminalHostPage } from "../../src/terminal-host/host-page";
import { LAYOUT_SCRIPT } from "../../src/terminal-host/panel-only";
import { deferred, makeWorld, type World } from "../host-fakes";

let host: TerminalHostPage | null = null;
function open(world: World): TerminalHostPage {
  host = new TerminalHostPage(world.deps);
  return host;
}
afterEach(() => {
  host?.dispose();
  host = null;
  vi.restoreAllMocks();
});
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("starting and running (G2)", () => {
  it("shows 'Starting VS Code server...' until the page is ready, then only the terminal", async () => {
    const world = makeWorld({ accepted: true });
    const gate = deferred();
    world.server.gate = gate.promise;
    const h = open(world);
    h.show();
    await flush();
    expect(h.view()).toBe("starting");
    expect(world.text()).toBe(STARTING_TEXT);
    expect(world.webviews()).toHaveLength(0);

    gate.release();
    await h.settled();
    expect(h.view()).toBe("running");
    // replaced, never left behind it
    expect(world.text()).not.toContain("Starting");
    const status = world.container().children[0];
    expect(status.style.display).toBe("none");
    expect(world.webviews()).toHaveLength(1);
  });

  it("keeps the text up while the page loads after the server is ready", async () => {
    const world = makeWorld({ accepted: true });
    const h = open(world);
    h.show();
    await vi.waitFor(() => expect(world.webviews()).toHaveLength(1));
    // the webview exists but the page has not painted or become panel-only: still Starting
    if (h.view() === "starting") expect(world.text()).toBe(STARTING_TEXT);
    await h.settled();
    expect(h.view()).toBe("running");
  });

  it("loads the origin first, writes the panel-only settings into the partition's profile, then the folder with the token", async () => {
    const world = makeWorld({ accepted: true });
    const h = open(world);
    h.show();
    await h.settled();
    const wv = world.webviews()[0];
    expect(wv.attrs.partition).toBe(TERMINAL_PARTITION);
    expect(wv.srcs).toHaveLength(2);
    expect(wv.srcs[0]).toBe("http://127.0.0.1:5555/");
    const url = new URL(wv.srcs[1]);
    expect(url.origin).toBe("http://127.0.0.1:5555");
    expect(url.searchParams.get("folder")).toBe("/Users/dan/My Vault");
    expect(url.searchParams.get("tkn")).toBe("tok-SECRET-123");
    const seed = wv.executed[0];
    expect(seed).toContain('"workbench.panel.opensMaximized":"always"');
    expect(seed).toContain('"obsidianWorkbench.terminalPage":true');
    expect(seed).toContain('"workbench.colorTheme":"Dark Modern"');
    // the token is never in a script
    for (const code of wv.executed) expect(code).not.toContain("tok-SECRET-123");
    // the trust record is the second script (settings first, then trust)
    expect(wv.executed[1]).toContain("vscode-web-state-db-global-shared");
  });

  it("runs no trust seed when the trust setting is off", async () => {
    const world = makeWorld({ accepted: true, trust: false });
    const h = open(world);
    h.show();
    await h.settled();
    expect(world.webviews()[0].executed.filter((c) => c.includes("vscode-web-state-db-global-shared"))).toEqual([]);
  });

  it("a fresh page gets a click, then the side bar key, then Ctrl+backtick, and ends panel-only", async () => {
    const world = makeWorld({ accepted: true, mac: true });
    const h = open(world);
    h.show();
    await h.settled();
    const wv = world.webviews()[0];
    const kinds = wv.sent.map((e) => (e.type === "keyDown" ? `${e.modifiers?.join("+")}+${e.keyCode}` : e.type));
    expect(kinds).toEqual(["mouseDown", "mouseUp", "meta+B", "keyUp", "control+`", "keyUp"]);
    expect(wv.focusCount).toBeGreaterThan(0);
    expect(wv.page!.shown()).toEqual(["panel"]);
    expect(h.view()).toBe("running");
  });

  it("a page whose profile already is panel-only gets no key at all", async () => {
    const world = makeWorld({ accepted: true, page: { panelOnlyAlready: true } });
    const h = open(world);
    h.show();
    await h.settled();
    expect(world.webviews()[0].sent).toEqual([]);
    expect(h.view()).toBe("running");
  });

  it("a page that ignores the keys is an error with Retry, not a half-drawn drawer (E3)", async () => {
    const world = makeWorld({ accepted: true, page: { deaf: true } });
    const h = open(world);
    h.show();
    await h.settled();
    expect(h.view()).toBe("error");
    expect(world.text()).toContain(NOT_PANEL_TEXT);
    expect(world.text()).toContain("Retry");
    expect(world.webviews().every((w) => w.removed)).toBe(true);
  });

  it("a page that never paints is an error with Retry after the load time", async () => {
    const world = makeWorld({ accepted: true, page: { neverPaints: true } });
    world.deps.loadMs = 60;
    const h = open(world);
    h.show();
    await h.settled();
    expect(h.view()).toBe("error");
    expect(world.text()).toContain(NOT_LOADED_TEXT);
  });

  it("a page that never reports dom-ready is an error with Retry", async () => {
    const world = makeWorld({ accepted: true });
    world.deps.loadMs = 60;
    const orig = world.deps.createElement;
    world.deps.createElement = (tag) => {
      const e = orig(tag) as unknown as { autoDomReady: boolean; setAttribute(k: string, v: string): void };
      if (tag === "webview") {
        const set = e.setAttribute.bind(e);
        // the first page (the origin) loads; the workbench never does
        e.setAttribute = (k, v) => {
          e.autoDomReady = !(k === "src" && v.includes("tkn="));
          set(k, v);
        };
      }
      return e as unknown as HTMLElement;
    };
    const h = open(world);
    h.show();
    await h.settled();
    expect(h.view()).toBe("error");
    expect(world.text()).toContain(NOT_LOADED_TEXT);
  });

  it("a seed that fails or times out still opens the workbench (the seed is best effort)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const world = makeWorld({ accepted: true, page: { seedResult: "error:SecurityError", trustResult: "timeout" } });
    const h = open(world);
    h.show();
    await h.settled();
    expect(h.view()).toBe("running");
    expect(warn).toHaveBeenCalled();
    for (const call of warn.mock.calls) expect(String(call[0])).not.toContain("tok-SECRET-123");
  });
});

describe("the licence (G2, E2)", () => {
  it("asks before anything starts, and starts only after Accept", async () => {
    const world = makeWorld();
    const gate = deferred();
    world.licence.gate = gate.promise;
    const h = open(world);
    h.show();
    await flush();
    expect(h.view()).toBe("licence");
    expect(world.text()).toBe(LICENCE_TEXT);
    expect(world.calls).toEqual({ licence: 1, server: 0 });
    expect(world.webviews()).toHaveLength(0);
    gate.release();
    await h.settled();
    expect(world.calls).toEqual({ licence: 1, server: 1 });
    expect(h.view()).toBe("running");
  });

  it("declined: the drawer closes with one notice, nothing starts, and the next show asks again", async () => {
    const world = makeWorld();
    world.licence.answer = false;
    const h = open(world);
    h.show();
    await h.settled();
    expect(h.view()).toBe("hidden");
    expect(h.isVisible()).toBe(false);
    expect(world.notices).toEqual([DECLINED_NOTICE]);
    expect(world.calls).toEqual({ licence: 1, server: 0 });
    expect(world.webviews()).toHaveLength(0);

    world.licence.answer = true;
    h.show();
    await h.settled();
    expect(world.calls).toEqual({ licence: 2, server: 1 });
    expect(world.notices).toHaveLength(1);
    expect(h.view()).toBe("running");
  });

  it("a start that finds the licence declined (a race with a Code tab) is handled as a decline", async () => {
    const world = makeWorld({ accepted: true });
    world.server.fail = new LicenceDeclinedError();
    const h = open(world);
    h.show();
    await h.settled();
    expect(h.view()).toBe("hidden");
    expect(world.notices).toEqual([DECLINED_NOTICE]);
  });
});

describe("failures (E1)", () => {
  it("shows the reason from describeFailure's text with a Retry, and the drawer stays open", async () => {
    const world = makeWorld({ accepted: true });
    world.server.fail = new Error("VS Code was not found");
    const h = open(world);
    h.show();
    await h.settled();
    expect(h.view()).toBe("error");
    expect(h.isVisible()).toBe(true);
    expect(world.text()).toBe("failed: VS Code was not found\nRetry");
    expect(world.webviews()).toHaveLength(0);
  });

  it("Retry starts again and shows 'Starting VS Code server...' again, then the terminal", async () => {
    const world = makeWorld({ accepted: true });
    world.server.fail = new Error("exit 5");
    const h = open(world);
    h.show();
    await h.settled();
    const gate = deferred();
    world.server.fail = null;
    world.server.gate = gate.promise;
    const retry = world.container().children[0].find("button")[0];
    retry.click();
    await flush();
    expect(h.view()).toBe("starting");
    expect(world.text()).toBe(STARTING_TEXT);
    gate.release();
    await h.settled();
    expect(h.view()).toBe("running");
    expect(world.calls.server).toBe(2);
    expect(world.text()).not.toContain("Retry");
  });

  it("Retry while a start is still running shares that start", async () => {
    const world = makeWorld({ accepted: true });
    world.server.fail = new Error("first");
    const h = open(world);
    h.show();
    await h.settled();
    const gate = deferred();
    world.server.fail = null;
    world.server.gate = gate.promise;
    const retry = world.container().children[0].find("button")[0];
    retry.click();
    retry.click(); // the old button is gone from the page, but a second click on it must not start a second one
    await flush();
    expect(world.calls.server).toBe(2);
    gate.release();
    await h.settled();
    expect(world.calls.server).toBe(2);
    expect(world.webviews()).toHaveLength(1);
  });

  it("a failed Retry leaves no webview behind and the old one is gone", async () => {
    const world = makeWorld({ accepted: true, page: { deaf: true } });
    const h = open(world);
    h.show();
    await h.settled();
    world.container().children[0].find("button")[0].click();
    await h.settled();
    expect(world.webviews()).toHaveLength(2);
    expect(world.container().children.filter((c) => c.tag === "webview")).toEqual([]);
  });

  it("a cancelled start (the server was stopped under it) is an error with Retry, not a silent blank", async () => {
    const world = makeWorld({ accepted: true });
    world.server.fail = new StartCancelledError();
    const h = open(world);
    h.show();
    await h.settled();
    expect(h.view()).toBe("error");
    expect(world.text()).toContain(CANCELLED_TEXT);
  });
});

describe("hide and show (G17, E10)", () => {
  it("two rapid shows make one webview, one licence modal and one server start", async () => {
    const world = makeWorld();
    const h = open(world);
    h.show();
    h.show();
    await h.settled();
    h.show();
    expect(world.calls).toEqual({ licence: 1, server: 1 });
    expect(world.webviews()).toHaveLength(1);
    expect(world.container()).toBeDefined();
    expect(world.parent.children).toHaveLength(1);
  });

  it("keeps the same element in the same parent, never moved or re-created, across hide and show", async () => {
    const world = makeWorld({ accepted: true });
    const h = open(world);
    h.show();
    await h.settled();
    const wv = world.webviews()[0];
    const parentBefore = wv.parent;
    const srcsBefore = [...wv.srcs];
    for (let i = 0; i < 3; i++) {
      h.hide();
      expect(world.container().style.visibility).toBe("hidden");
      expect(world.container().style.pointerEvents).toBe("none");
      expect(wv.parent).toBe(parentBefore);
      expect(wv.removed).toBe(false);
      h.show();
      expect(world.container().style.visibility).toBe("visible");
      expect(wv.parent).toBe(parentBefore);
    }
    expect(world.webviews()).toEqual([wv]);
    expect(wv.srcs).toEqual(srcsBefore); // no reload
    expect(parentBefore!.children).toContain(wv);
    expect(world.parent.children).toHaveLength(1);
  });

  it("hide during Starting, then show after it finished: the terminal, not a stale Starting", async () => {
    const world = makeWorld({ accepted: true });
    const gate = deferred();
    world.server.gate = gate.promise;
    const h = open(world);
    h.show();
    await flush();
    h.hide();
    expect(h.view()).toBe("hidden");
    gate.release();
    await h.settled();
    expect(world.webviews()).toHaveLength(1);
    expect(h.view()).toBe("hidden");
    h.show();
    expect(h.view()).toBe("running");
    expect(world.text()).not.toContain("Starting");
  });

  it("reveal while the licence modal is open, then hide, leaves one coherent state and no orphan webview", async () => {
    const world = makeWorld();
    const gate = deferred();
    world.licence.gate = gate.promise;
    const h = open(world);
    h.show();
    await flush();
    h.show();
    h.hide();
    h.show();
    expect(world.calls.licence).toBe(1);
    gate.release();
    await h.settled();
    expect(world.calls).toEqual({ licence: 1, server: 1 });
    expect(world.webviews()).toHaveLength(1);
    expect(h.view()).toBe("running");
  });

  it("toggle shows, then hides", async () => {
    const world = makeWorld({ accepted: true });
    const h = open(world);
    h.toggle();
    expect(h.isVisible()).toBe(true);
    h.toggle();
    expect(h.isVisible()).toBe(false);
    await h.settled();
  });
});

describe("a reload under the page (G17)", () => {
  it("shows 'terminals lost' over the page instead of a silent blank, and Dismiss clears it", async () => {
    const world = makeWorld({ accepted: true });
    const h = open(world);
    h.show();
    await h.settled();
    const wv = world.webviews()[0];
    expect(world.text()).not.toContain("Terminals lost");
    wv.fire("dom-ready"); // Obsidian rebuilt the layout and the webview reloaded
    expect(h.view()).toBe("lost");
    expect(world.text()).toContain(LOST_TEXT);
    expect(world.webviews()).toEqual([wv]); // the page is still the same element
    world.container().children[1].find("button")[0].click();
    expect(h.view()).toBe("running");
    expect(world.text()).not.toContain("Terminals lost");
  });

  it("the first loads are not reloads: no 'lost' notice while the page starts", async () => {
    const world = makeWorld({ accepted: true });
    const h = open(world);
    h.show();
    await h.settled();
    expect(h.view()).toBe("running");
    expect(world.text()).not.toContain("lost");
  });

  it("a reload while hidden is shown at the next show", async () => {
    const world = makeWorld({ accepted: true });
    const h = open(world);
    h.show();
    await h.settled();
    h.hide();
    world.webviews()[0].fire("dom-ready");
    expect(h.view()).toBe("hidden");
    h.show();
    expect(h.view()).toBe("lost");
  });

  it("answers the page's 'leave this page?' question so a reload goes ahead", async () => {
    const world = makeWorld({ accepted: true });
    const h = open(world);
    h.show();
    await h.settled();
    const ev = { preventDefault: vi.fn() };
    world.webviews()[0].fire("will-prevent-unload", ev);
    expect(ev.preventDefault).toHaveBeenCalled();
  });
});

describe("unload (no orphan webview, no server nobody owns)", () => {
  it("during the licence modal: no webview, no server start, even when the modal is answered Accept afterwards", async () => {
    const world = makeWorld();
    const gate = deferred();
    world.licence.gate = gate.promise;
    const h = open(world);
    h.show();
    await flush();
    h.dispose();
    gate.release();
    await flush();
    await flush();
    expect(world.calls).toEqual({ licence: 1, server: 0 });
    expect(world.webviews()).toHaveLength(0);
    expect(world.parent.children).toHaveLength(0);
    expect(world.notices).toEqual([]);
  });

  it("during the server start: the page is never built when the start finishes", async () => {
    const world = makeWorld({ accepted: true });
    const gate = deferred();
    world.server.gate = gate.promise;
    const h = open(world);
    h.show();
    await flush();
    h.dispose();
    gate.release();
    await flush();
    await flush();
    expect(world.webviews()).toHaveLength(0);
    expect(world.parent.children).toHaveLength(0);
  });

  it("during the page load: the webview is removed and nothing is left in the parent", async () => {
    const world = makeWorld({ accepted: true });
    const h = open(world);
    h.show();
    await vi.waitFor(() => expect(world.webviews()).toHaveLength(1));
    h.dispose();
    await flush();
    await new Promise((r) => setTimeout(r, 20));
    expect(world.webviews().every((w) => w.removed)).toBe(true);
    expect(world.parent.children).toHaveLength(0);
    expect(world.notices).toEqual([]);
  });

  it("after a normal run: the webview and the container are removed", async () => {
    const world = makeWorld({ accepted: true });
    const h = open(world);
    h.show();
    await h.settled();
    h.dispose();
    expect(world.webviews()[0].removed).toBe(true);
    expect(world.parent.children).toHaveLength(0);
    h.show(); // a show after unload does nothing
    expect(world.calls.server).toBe(1);
    expect(world.parent.children).toHaveLength(0);
  });
});

describe("the connection token never reaches anything visible (F4)", () => {
  it("is in no text, notice or log line through start, failure, retry, reload and hide", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const world = makeWorld({ accepted: true });
    const h = open(world);
    h.show();
    await h.settled();
    h.hide();
    h.show();
    world.webviews()[0].fire("dom-ready");
    h.themeChanged(false);
    const texts = [world.text(), ...world.notices];
    for (const t of texts) expect(t).not.toContain("tok-SECRET-123");
    for (const spy of [log, info, warn, debug, error]) for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain("tok-SECRET-123");
    // and the layout probe the host runs asks only for sizes
    expect(world.webviews()[0].executed).toContain(LAYOUT_SCRIPT);
  });
});
