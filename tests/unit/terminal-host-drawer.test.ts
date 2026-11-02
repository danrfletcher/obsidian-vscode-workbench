/**
 * What PR-3 adds to the terminal host page: focus into the terminal by a script in the page (G1), the key bridge attached
 * to the page's frame and detached with it (G16), the host closing the drawer when the licence is declined, and the
 * container's place and size coming from the stylesheet rather than from the host (G4).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmbedKeyRelay, type RelayFrame } from "../../src/hotkey/embed-key-relay";
import { KEY_MESSAGE_PREFIX } from "../../src/hotkey/hotkey-bridge";
import { FOCUS_TERMINAL_SCRIPT, TerminalHostPage } from "../../src/terminal-host/host-page";
import { deferred, makeWorld, type World } from "../host-fakes";

let host: TerminalHostPage | null = null;
const flush = () => new Promise((r) => setTimeout(r, 0));
function open(world: World): TerminalHostPage {
  host = new TerminalHostPage(world.deps);
  return host;
}
afterEach(() => {
  host?.dispose();
  host = null;
  vi.restoreAllMocks();
});

describe("focus into the terminal (G1)", () => {
  it("focuses the webview, then runs the script that puts focus on the terminal's input, inside the page", async () => {
    const world = makeWorld({ accepted: true });
    const h = open(world);
    h.show();
    await h.settled();
    const wv = world.webviews()[0];
    const focusBefore = wv.focusCount;
    const scriptsBefore = wv.executed.length;
    h.focusTerminal();
    expect(wv.focusCount).toBe(focusBefore + 1);
    expect(wv.executed.slice(scriptsBefore)).toEqual([FOCUS_TERMINAL_SCRIPT]);
    expect(FOCUS_TERMINAL_SCRIPT).toContain("t.focus()");
    expect(FOCUS_TERMINAL_SCRIPT).toContain("-helper-textarea");
  });

  it("asked while the page is still loading, it waits and focuses once the page is ready", async () => {
    const world = makeWorld({ accepted: true });
    const gate = deferred();
    world.server.gate = gate.promise;
    const h = open(world);
    h.show();
    await flush();
    h.focusTerminal();
    expect(world.webviews()).toHaveLength(0); // nothing to focus yet
    gate.release();
    await h.settled();
    const wv = world.webviews()[0];
    expect(wv.executed.filter((c) => c === FOCUS_TERMINAL_SCRIPT)).toHaveLength(1);
  });

  it("asked while hidden it does nothing, and a request left over from before a hide is dropped", async () => {
    const world = makeWorld({ accepted: true });
    const h = open(world);
    h.focusTerminal(); // hidden
    h.show();
    await flush();
    h.focusTerminal(); // loading
    h.hide();
    await h.settled();
    const wv = world.webviews()[0];
    expect(wv?.executed.filter((c) => c === FOCUS_TERMINAL_SCRIPT) ?? []).toHaveLength(0);
  });

  it("a script that cannot be run (the page is gone) does not throw", async () => {
    const world = makeWorld({ accepted: true });
    const h = open(world);
    h.show();
    await h.settled();
    const wv = world.webviews()[0] as unknown as { executeJavaScript: () => Promise<unknown> };
    wv.executeJavaScript = () => Promise.reject(new Error("gone"));
    expect(() => h.focusTerminal()).not.toThrow();
    await flush();
    wv.executeJavaScript = () => {
      throw new Error("detached");
    };
    expect(() => h.focusTerminal()).not.toThrow();
  });
});

describe("the container is placed by the stylesheet (G4)", () => {
  it("carries the class the stylesheet positions, with no position, size or stacking of its own", () => {
    const world = makeWorld({ accepted: true });
    open(world);
    const c = world.container();
    expect(c.className).toBe("vscode-workbench-terminal-host");
    for (const k of ["position", "left", "right", "bottom", "height", "width", "zIndex", "top"]) expect((c.style as Record<string, unknown>)[k], k).toBeUndefined();
  });
});

describe("the host closing the drawer (declined licence)", () => {
  it("tells the drawer once when the host hides itself, but not when the drawer hid it or on dispose", async () => {
    const world = makeWorld();
    world.licence.answer = false;
    const closed = vi.fn();
    host = new TerminalHostPage({ ...world.deps, closedByHost: closed });
    host.show();
    await host.settled();
    expect(closed).toHaveBeenCalledTimes(1);

    world.licence.answer = true;
    host.show();
    await host.settled();
    host.hide();
    expect(closed).toHaveBeenCalledTimes(1);
    host.show();
    host.dispose();
    expect(closed).toHaveBeenCalledTimes(1);
  });
});

describe("the key bridge on the host page's frame (G16)", () => {
  it("attaches to the webview as the page is made, and detaches when the page is taken down", async () => {
    const world = makeWorld({ accepted: true });
    const attached: HTMLElement[] = [];
    const detach = vi.fn();
    host = new TerminalHostPage({
      ...world.deps,
      attachKeys: (frame) => {
        attached.push(frame);
        return detach;
      },
    });
    host.show();
    await host.settled();
    expect(attached).toEqual([world.webviews()[0]]);
    expect(host.webview).toBe(world.webviews()[0]);
    expect(detach).not.toHaveBeenCalled();
    host.dispose();
    expect(detach).toHaveBeenCalledTimes(1);
  });

  it("with the real relay: the script goes into the host page on dom-ready, and its console line (right nonce, the server's origin) gives the action with that frame", async () => {
    const world = makeWorld({ accepted: true });
    const actions: Array<{ action: string; frame: unknown }> = [];
    const relay = new EmbedKeyRelay({
      decision: () => "yes",
      window: { addEventListener: () => undefined, removeEventListener: () => undefined },
      serverOrigin: () => "http://127.0.0.1:5555",
      chords: () => ({ chords: [{ action: "toggle-terminal", ctrl: true, meta: false, alt: false, shift: false, key: "`" }] }),
      onAction: (action, frame) => actions.push({ action, frame }),
    });
    relay.install();
    host = new TerminalHostPage({ ...world.deps, attachKeys: (f) => relay.attach(f as unknown as RelayFrame) });
    host.show();
    await host.settled();
    const wv = world.webviews()[0] as unknown as { executed: string[]; fire(n: string, ev?: unknown): void; getURL?: () => string };
    wv.getURL = () => "http://127.0.0.1:5555/?folder=/v&tkn=tok-SECRET-123";
    wv.fire("dom-ready"); // a (re)load: the page gets its script
    const script = wv.executed.filter((c) => c.includes(KEY_MESSAGE_PREFIX)).at(-1)!;
    expect(script).toBeTruthy();
    expect(script).not.toContain("tok-SECRET-123");
    const nonce = /var nonce = "([0-9a-f]+)";/.exec(script)![1];
    const line = (n: string, action = "toggle-terminal") => `${KEY_MESSAGE_PREFIX}${JSON.stringify({ v: 1, action, n })}`;

    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errored = vi.spyOn(console, "error").mockImplementation(() => undefined);
    wv.fire("console-message", { message: line("wrong") }); // another script in the page guessing
    wv.fire("console-message", { message: `${KEY_MESSAGE_PREFIX}not json` });
    wv.fire("console-message", { message: line(nonce, "format-disk") });
    wv.fire("console-message", { message: 42 });
    expect(actions).toEqual([]);
    wv.fire("console-message", { message: line(nonce) });
    expect(actions).toEqual([{ action: "toggle-terminal", frame: wv }]);
    expect(logged).not.toHaveBeenCalled();
    expect(errored).not.toHaveBeenCalled();

    // the page navigates away from the server (a foreign origin): its lines are ignored
    wv.getURL = () => "http://127.0.0.1:9999/";
    wv.fire("console-message", { message: line(nonce) });
    expect(actions).toHaveLength(1);
    host.dispose();
    expect(relay.attachedCount).toBe(0);
  });
});
