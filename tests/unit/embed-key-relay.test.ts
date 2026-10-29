/**
 * The relay's host side: message shape, origin check, the decision constant, and (re)attaching to a frame.
 * `window.addEventListener` and the frame are fakes; the messages are the ones the page script would send.
 */
import { describe, expect, it } from "vitest";
import { HOTKEY_BRIDGE, bridgeEnabled } from "../../src/hotkey/decision";
import { EmbedKeyRelay, acceptKeyMessage, loopbackOrigin, parseKeyMessage, type RelayFrame } from "../../src/hotkey/embed-key-relay";
import { KEY_MESSAGE_PREFIX, type BridgeAction, type ChordConfig } from "../../src/hotkey/hotkey-bridge";

const ORIGIN = "http://127.0.0.1:41234";
const line = (action: unknown, extra: Record<string, unknown> = {}) => `${KEY_MESSAGE_PREFIX}${JSON.stringify({ v: 1, action, ...extra })}`;
const posted = (action: unknown, extra: Record<string, unknown> = {}) => ({ vscw: 1, v: 1, action, ...extra });
/** The nonce the relay wrote into the most recent script it gave a frame. */
const nonceOf = (f: { scripts: string[] }) => /var nonce = "([0-9a-f]+)";/.exec(f.scripts[f.scripts.length - 1])?.[1] ?? "";
/** A console line as the page script would write it: the action plus this load's nonce. */
const pageLine = (f: { scripts: string[] }, action: unknown) => line(action, { n: nonceOf(f) });

class FakeFrame implements RelayFrame {
  handlers = new Map<string, Array<(ev: any) => void>>();
  scripts: string[] = [];
  url: string | null = `${ORIGIN}/?folder=/v&tkn=SECRET`;
  isConnected = true;
  contentWindow: unknown = undefined;
  rejectScripts = false;
  throwScripts = false;
  addEventListener(type: string, cb: (ev: any) => void) {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), cb]);
  }
  removeEventListener(type: string, cb: (ev: any) => void) {
    this.handlers.set(type, (this.handlers.get(type) ?? []).filter((h) => h !== cb));
  }
  getURL() {
    if (this.url === null) throw new Error("not loaded");
    return this.url;
  }
  executeJavaScript(code: string) {
    this.scripts.push(code);
    if (this.throwScripts) throw new Error("webview is gone");
    return this.rejectScripts ? Promise.reject(new Error("gone")) : Promise.resolve(undefined);
  }
  emit(type: string, ev: any = {}) {
    for (const h of this.handlers.get(type) ?? []) h(ev);
  }
  count(type: string) {
    return (this.handlers.get(type) ?? []).length;
  }
}

class FakeWindow {
  handlers: Array<(ev: any) => void> = [];
  addEventListener(_t: "message", cb: (ev: any) => void) { this.handlers.push(cb); }
  removeEventListener(_t: "message", cb: (ev: any) => void) { this.handlers = this.handlers.filter((h) => h !== cb); }
  message(ev: any) { for (const h of [...this.handlers]) h(ev); }
}

function rig(opts: { decision?: "yes" | "no"; origin?: string | null; chords?: () => ChordConfig } = {}) {
  const win = new FakeWindow();
  const actions: Array<{ action: BridgeAction; frame: RelayFrame }> = [];
  let origin: string | null = opts.origin === undefined ? ORIGIN : opts.origin;
  let config: ChordConfig = { chords: [{ action: "toggle-terminal", ctrl: true, meta: false, alt: false, shift: false, key: "`" }] };
  const relay = new EmbedKeyRelay({
    decision: () => opts.decision ?? "yes",
    window: win,
    serverOrigin: () => origin,
    chords: opts.chords ?? (() => config),
    onAction: (action, frame) => actions.push({ action, frame }),
  });
  return { relay, win, actions, setOrigin: (o: string | null) => (origin = o), setChords: (c: ChordConfig) => (config = c) };
}

describe("the decision constant (E12)", () => {
  it("is the recorded value, read through bridgeEnabled", () => {
    expect(["yes", "no"]).toContain(HOTKEY_BRIDGE);
    expect(bridgeEnabled()).toBe(HOTKEY_BRIDGE === "yes");
    expect(bridgeEnabled("yes")).toBe(true);
    expect(bridgeEnabled("no")).toBe(false);
  });

  it("with `yes` the relay installs: a window listener, a script given to each frame on load", () => {
    const { relay, win } = rig({ decision: "yes" });
    expect(relay.install()).toBe(true);
    expect(relay.active).toBe(true);
    expect(win.handlers).toHaveLength(1);
    const f = new FakeFrame();
    relay.attach(f);
    f.emit("dom-ready");
    expect(f.scripts).toHaveLength(1);
  });

  it("with `no` nothing is installed: no window listener, no frame listener, no script, no action", () => {
    const { relay, win, actions } = rig({ decision: "no" });
    expect(relay.install()).toBe(false);
    expect(relay.active).toBe(false);
    expect(win.handlers).toHaveLength(0);
    const f = new FakeFrame();
    const off = relay.attach(f);
    expect(f.count("dom-ready") + f.count("console-message")).toBe(0);
    f.emit("dom-ready");
    f.emit("console-message", { message: line("toggle-terminal") });
    win.message({ origin: ORIGIN, source: undefined, data: posted("toggle-terminal") });
    expect(f.scripts).toEqual([]);
    expect(actions).toEqual([]);
    expect(relay.deliver(ORIGIN, line("toggle-terminal"), f)).toBeNull();
    expect(() => off()).not.toThrow();
    relay.sync();
    expect(f.scripts).toEqual([]);
  });

  it("install is idempotent and dispose removes the window listener", () => {
    const { relay, win } = rig();
    relay.install();
    relay.install();
    expect(win.handlers).toHaveLength(1);
    relay.dispose();
    expect(win.handlers).toHaveLength(0);
    expect(relay.active).toBe(false);
  });
});

describe("loopbackOrigin", () => {
  it.each([
    [`${ORIGIN}/?tkn=x`, ORIGIN],
    [ORIGIN, ORIGIN],
  ])("%s is the server's origin", (value, expected) => expect(loopbackOrigin(value)).toBe(expected));

  it.each([
    ["localhost", "http://localhost:41234/"],
    ["another loopback spelling", "http://127.0.0.2:41234/"],
    ["https", "https://127.0.0.1:41234/"],
    ["no port", "http://127.0.0.1/"],
    ["an app origin", "app://obsidian.md"],
    ["an external host that starts like loopback", "http://127.0.0.1.evil.example:41234/"],
    ["credentials trick", "http://127.0.0.1:41234@evil.example/"],
    ["empty", ""],
    ["not a url", "not a url"],
    ["null", null],
    ["a number", 5],
  ])("rejects %s", (_name, value) => expect(loopbackOrigin(value)).toBeNull());
});

describe("parseKeyMessage: shape", () => {
  it("takes the console line and the posted object for each known action", () => {
    expect(parseKeyMessage(line("toggle-terminal"))).toBe("toggle-terminal");
    expect(parseKeyMessage(line("open-switcher"))).toBe("open-switcher");
    expect(parseKeyMessage(posted("toggle-terminal"))).toBe("toggle-terminal");
    expect(parseKeyMessage(posted("open-switcher"))).toBe("open-switcher");
  });

  it.each([
    ["an unknown action", line("run-anything")],
    ["a missing action", `${KEY_MESSAGE_PREFIX}{"v":1}`],
    ["an action that is not a string", line(5)],
    ["a wrong version", `${KEY_MESSAGE_PREFIX}{"v":2,"action":"toggle-terminal"}`],
    ["a missing version", `${KEY_MESSAGE_PREFIX}{"action":"toggle-terminal"}`],
    ["bad json after the prefix", `${KEY_MESSAGE_PREFIX}{nope`],
    ["a json array", `${KEY_MESSAGE_PREFIX}["toggle-terminal"]`],
    ["json null", `${KEY_MESSAGE_PREFIX}null`],
    ["a string without the prefix", JSON.stringify({ v: 1, action: "toggle-terminal" })],
    ["an unrelated console line", "Uncaught TypeError: x is not a function"],
    ["a posted object without the marker", { v: 1, action: "toggle-terminal" }],
    ["an unknown posted action", posted("rm -rf")],
    ["null", null],
    ["undefined", undefined],
    ["a number", 7],
    ["an array", [posted("toggle-terminal")]],
    ["a prototype key as action", posted("constructor")],
  ])("ignores %s", (_name, raw) => expect(parseKeyMessage(raw)).toBeNull());

  it("ignores extra fields rather than passing them on: only the action name comes out", () => {
    expect(parseKeyMessage(line("toggle-terminal", { text: "secret typed", token: "t" }))).toBe("toggle-terminal");
    expect(parseKeyMessage(posted("open-switcher", { data: "x" }))).toBe("open-switcher");
  });
});

describe("acceptKeyMessage: origin", () => {
  it("accepts the server's own origin only", () => {
    expect(acceptKeyMessage(ORIGIN, ORIGIN, line("toggle-terminal"))).toBe("toggle-terminal");
    expect(acceptKeyMessage(`${ORIGIN}/page?tkn=1`, ORIGIN, line("toggle-terminal"))).toBe("toggle-terminal");
  });

  it.each([
    ["another port on loopback", "http://127.0.0.1:9999"],
    ["a foreign origin", "https://evil.example"],
    ["the Obsidian app origin", "app://obsidian.md"],
    ["localhost", "http://localhost:41234"],
    ["an empty origin", ""],
    ["no origin", undefined],
  ])("ignores a valid message from %s", (_name, origin) => {
    expect(acceptKeyMessage(origin, ORIGIN, line("toggle-terminal"))).toBeNull();
  });

  it("ignores everything while no server runs (no allowed origin)", () => {
    expect(acceptKeyMessage(ORIGIN, null, line("toggle-terminal"))).toBeNull();
    expect(acceptKeyMessage("http://127.0.0.1:41234", "https://example.com", line("toggle-terminal"))).toBeNull();
  });
});

describe("the webview channel", () => {
  it("a console line from the server's page runs the action, with the frame it came from", () => {
    const { relay, actions } = rig();
    relay.install();
    const f = new FakeFrame();
    relay.attach(f);
    f.emit("dom-ready");
    f.emit("console-message", { message: pageLine(f, "toggle-terminal") });
    expect(actions).toEqual([{ action: "toggle-terminal", frame: f }]);
  });

  it("other console output is skipped without parsing it", () => {
    const { relay, actions } = rig();
    relay.install();
    const f = new FakeFrame();
    relay.attach(f);
    for (const message of ["workbench loaded", "", undefined, 5, null, "__vscw_key__ no colon"]) f.emit("console-message", { message });
    f.emit("console-message", null);
    expect(actions).toEqual([]);
  });

  it("a page that is not the server's (the webview navigated elsewhere) is ignored", () => {
    const { relay, actions } = rig();
    relay.install();
    const f = new FakeFrame();
    relay.attach(f);
    f.emit("dom-ready");
    f.url = "https://evil.example/page";
    f.emit("console-message", { message: pageLine(f, "toggle-terminal") });
    f.url = null; // before the first load, getURL throws
    f.emit("console-message", { message: pageLine(f, "toggle-terminal") });
    expect(actions).toEqual([]);
  });

  it("is ignored when the server has stopped", () => {
    const { relay, actions, setOrigin } = rig();
    relay.install();
    const f = new FakeFrame();
    relay.attach(f);
    f.emit("dom-ready");
    setOrigin(null);
    f.emit("console-message", { message: pageLine(f, "toggle-terminal") });
    expect(actions).toEqual([]);
  });

  it("a server restart on a new port: the reloaded page is scripted again and works; the old page's line is refused (C20)", () => {
    const { relay, actions, setOrigin } = rig();
    relay.install();
    const f = new FakeFrame();
    relay.attach(f);
    f.emit("dom-ready");
    const oldNonce = nonceOf(f);
    f.emit("console-message", { message: pageLine(f, "toggle-terminal") });
    expect(actions).toHaveLength(1);

    // The server goes down: the page is still the old one, and keys it reports are not taken.
    setOrigin(null);
    f.emit("console-message", { message: pageLine(f, "toggle-terminal") });
    expect(actions).toHaveLength(1);

    // It comes back on another port and the tab reloads onto it: the new page announces itself and is scripted
    // again, with a nonce of its own.
    const NEW_ORIGIN = "http://127.0.0.1:45678";
    setOrigin(NEW_ORIGIN);
    f.url = `${NEW_ORIGIN}/?folder=/v&tkn=NEWSECRET`;
    expect(() => f.emit("dom-ready")).not.toThrow();
    expect(f.scripts).toHaveLength(2);
    expect(nonceOf(f)).not.toBe(oldNonce);
    f.emit("console-message", { message: line("toggle-terminal", { n: oldNonce }) });
    expect(actions).toHaveLength(1);
    f.emit("console-message", { message: pageLine(f, "toggle-terminal") });
    expect(actions).toHaveLength(2);
  });

  it("an action that throws is contained", () => {
    const win = new FakeWindow();
    const relay = new EmbedKeyRelay({ window: win, decision: () => "yes", serverOrigin: () => ORIGIN, chords: () => ({ chords: [] }), onAction: () => { throw new Error("boom"); } });
    relay.install();
    const f = new FakeFrame();
    relay.attach(f);
    f.emit("dom-ready");
    expect(() => f.emit("console-message", { message: pageLine(f, "toggle-terminal") })).not.toThrow();
    expect(f.scripts).toHaveLength(1);
  });
});

describe("the webview channel: the per-load nonce (R6)", () => {
  function loaded() {
    const r = rig();
    r.relay.install();
    const f = new FakeFrame();
    r.relay.attach(f);
    f.emit("dom-ready");
    return { ...r, f };
  }

  it("the script carries a nonce, and the same page content cannot guess it: a line without one is ignored", () => {
    const { actions, f } = loaded();
    expect(nonceOf(f)).toMatch(/^[0-9a-f]{32}$/);
    f.emit("console-message", { message: line("toggle-terminal") });
    f.emit("console-message", { message: line("open-switcher") });
    expect(actions).toEqual([]);
  });

  it("a line with a wrong, empty or non-string nonce is ignored; the right one is taken", () => {
    const { actions, f } = loaded();
    for (const n of ["0".repeat(32), "", 5, null, [nonceOf(f)], { n: nonceOf(f) }]) f.emit("console-message", { message: line("toggle-terminal", { n }) });
    expect(actions).toEqual([]);
    f.emit("console-message", { message: pageLine(f, "toggle-terminal") });
    expect(actions).toHaveLength(1);
  });

  it("a line with the prefix but no readable object after it is ignored", () => {
    const { actions, f } = loaded();
    for (const message of [`${KEY_MESSAGE_PREFIX}{nope`, `${KEY_MESSAGE_PREFIX}null`, `${KEY_MESSAGE_PREFIX}"text"`, `${KEY_MESSAGE_PREFIX}[1]`]) f.emit("console-message", { message });
    expect(actions).toEqual([]);
  });

  it("a right nonce still needs a known action and the server's origin", () => {
    const { actions, f } = loaded();
    f.emit("console-message", { message: pageLine(f, "run-anything") });
    f.url = "https://evil.example/";
    f.emit("console-message", { message: pageLine(f, "toggle-terminal") });
    expect(actions).toEqual([]);
  });

  it("before the page has been given a script no line is taken, even one that guesses an empty nonce", () => {
    const r = rig();
    r.relay.install();
    const f = new FakeFrame();
    r.relay.attach(f);
    for (const n of ["", null, undefined]) f.emit("console-message", { message: line("toggle-terminal", { n }) });
    f.emit("console-message", { message: line("toggle-terminal") });
    expect(r.actions).toEqual([]);
    expect(f.scripts).toEqual([]);
  });

  it("a rebinding re-push to the same page keeps its nonce (the page keeps the first script's)", () => {
    const { relay, setChords, actions, f } = loaded();
    const first = nonceOf(f);
    setChords({ chords: [{ action: "toggle-terminal", ctrl: true, meta: false, alt: true, shift: false, key: "j" }] });
    relay.sync();
    expect(f.scripts).toHaveLength(2);
    expect(nonceOf(f)).toBe(first);
    f.emit("console-message", { message: pageLine(f, "toggle-terminal") });
    expect(actions).toHaveLength(1);
  });

  it("a reload gets a new nonce, and a line with the old page's nonce is refused", () => {
    const { actions, f } = loaded();
    const old = nonceOf(f);
    f.emit("dom-ready"); // the server restarted: a fresh page
    expect(f.scripts).toHaveLength(2);
    expect(nonceOf(f)).not.toBe(old);
    f.emit("console-message", { message: line("toggle-terminal", { n: old }) });
    expect(actions).toEqual([]);
    f.emit("console-message", { message: pageLine(f, "toggle-terminal") });
    expect(actions).toHaveLength(1);
  });

  it("each frame has its own nonce: one tab's line is not taken from another", () => {
    const r = rig();
    r.relay.install();
    const a = new FakeFrame();
    const b = new FakeFrame();
    r.relay.attach(a);
    r.relay.attach(b);
    a.emit("dom-ready");
    b.emit("dom-ready");
    expect(nonceOf(a)).not.toBe(nonceOf(b));
    a.emit("console-message", { message: pageLine(b, "toggle-terminal") });
    expect(r.actions).toEqual([]);
    a.emit("console-message", { message: pageLine(a, "toggle-terminal") });
    expect(r.actions).toEqual([{ action: "toggle-terminal", frame: a }]);
  });

  it("the nonce is not logged or put in the page address, and the script keeps it off window state", () => {
    const { f } = loaded();
    const script = f.scripts[0];
    expect(script).not.toContain("SECRET");
    // The only place it appears is the one closure variable.
    expect(script.split(nonceOf(f)).length - 1).toBe(1);
  });
});

describe("the iframe channel (postMessage to the Obsidian window)", () => {
  function framed() {
    const r = rig();
    r.relay.install();
    const f = new FakeFrame();
    f.contentWindow = { id: "frame-window" };
    r.relay.attach(f);
    return { ...r, f };
  }

  it("accepts a message from an attached frame at the server's origin", () => {
    const { win, actions, f } = framed();
    win.message({ origin: ORIGIN, source: f.contentWindow, data: posted("open-switcher") });
    expect(actions).toEqual([{ action: "open-switcher", frame: f }]);
  });

  it("ignores a foreign origin, a foreign source, a malformed payload and a message with no source", () => {
    const { win, actions, f } = framed();
    win.message({ origin: "https://evil.example", source: f.contentWindow, data: posted("toggle-terminal") });
    win.message({ origin: ORIGIN, source: { id: "other-window" }, data: posted("toggle-terminal") });
    win.message({ origin: ORIGIN, source: f.contentWindow, data: { vscw: 1, v: 1, action: "x" } });
    win.message({ origin: ORIGIN, source: f.contentWindow, data: "toggle-terminal" });
    win.message({ origin: ORIGIN, data: posted("toggle-terminal") });
    win.message(undefined);
    expect(actions).toEqual([]);
  });
});

describe("giving the page its script", () => {
  it("writes the script on every load, so a reload or a restarted server gets it again", () => {
    const { relay } = rig();
    relay.install();
    const f = new FakeFrame();
    relay.attach(f);
    f.emit("dom-ready");
    f.emit("dom-ready"); // the server restarted and the tab reloaded
    expect(f.scripts).toHaveLength(2);
    expect(f.scripts[0]).toContain('"key":"`"');
  });

  it("does not run a script before the page has loaded, and does not throw", () => {
    const { relay } = rig();
    relay.install();
    const f = new FakeFrame();
    f.url = null;
    relay.attach(f);
    expect(() => f.emit("dom-ready")).not.toThrow();
    expect(f.scripts).toEqual([]);
  });

  it("a rejected script is tried again on the next sync", async () => {
    const { relay } = rig();
    relay.install();
    const f = new FakeFrame();
    relay.attach(f);
    f.rejectScripts = true;
    f.emit("dom-ready");
    await Promise.resolve();
    await Promise.resolve();
    f.rejectScripts = false;
    relay.sync();
    expect(f.scripts).toHaveLength(2);
    relay.sync();
    expect(f.scripts).toHaveLength(2); // delivered: no more until something changes
  });

  it("a late rejection of an older script does not undo a newer delivery", async () => {
    const { relay, setChords } = rig();
    relay.install();
    const f = new FakeFrame();
    const rejectors: Array<() => void> = [];
    f.executeJavaScript = (code: string) => {
      f.scripts.push(code);
      return new Promise((_resolve, reject) => rejectors.push(() => reject(new Error("late"))));
    };
    relay.attach(f);
    f.emit("dom-ready"); // script 1, still pending
    setChords({ chords: [{ action: "toggle-terminal", ctrl: true, meta: false, alt: true, shift: false, key: "j" }] });
    relay.sync(); // script 2 for the new chords
    expect(f.scripts).toHaveLength(2);
    rejectors[0](); // the first one fails after the second was sent
    await Promise.resolve();
    await Promise.resolve();
    relay.sync();
    expect(f.scripts).toHaveLength(2); // the newer chords are still recorded as given
  });

  it("sync pushes only when the chords changed (a rebinding), to every frame", () => {
    const { relay, setChords } = rig();
    relay.install();
    const a = new FakeFrame();
    const b = new FakeFrame();
    relay.attach(a);
    relay.attach(b);
    a.emit("dom-ready");
    b.emit("dom-ready");
    relay.sync();
    expect([a.scripts.length, b.scripts.length]).toEqual([1, 1]);
    setChords({ chords: [{ action: "toggle-terminal", ctrl: true, meta: false, alt: true, shift: false, key: "j" }] });
    relay.sync();
    expect([a.scripts.length, b.scripts.length]).toEqual([2, 2]);
    expect(a.scripts[1]).toContain('"key":"j"');
    expect(a.scripts[1]).not.toContain('"key":"`"');
  });

  it("a script that throws at once (not a rejection) is tried again on the next sync", () => {
    const { relay } = rig();
    relay.install();
    const f = new FakeFrame();
    relay.attach(f);
    f.throwScripts = true;
    expect(() => f.emit("dom-ready")).not.toThrow();
    expect(f.scripts).toHaveLength(1);
    f.throwScripts = false;
    relay.sync();
    expect(f.scripts).toHaveLength(2); // it was not recorded as delivered
    relay.sync();
    expect(f.scripts).toHaveLength(2);
  });

  it("a chord lookup that throws pushes nothing", () => {
    const { relay } = rig({ chords: () => { throw new Error("no hotkey manager"); } });
    relay.install();
    const f = new FakeFrame();
    relay.attach(f);
    expect(() => f.emit("dom-ready")).not.toThrow();
    expect(f.scripts).toEqual([]);
  });

  it("a frame without executeJavaScript (an iframe) is only listened to", () => {
    const { relay } = rig();
    relay.install();
    const f = new FakeFrame();
    (f as { executeJavaScript?: unknown }).executeJavaScript = undefined;
    relay.attach(f);
    expect(() => { f.emit("dom-ready"); relay.sync(); }).not.toThrow();
  });

  it("the token in the page address is never part of the script", () => {
    const { relay } = rig();
    relay.install();
    const f = new FakeFrame();
    relay.attach(f);
    f.emit("dom-ready");
    expect(f.scripts.join("")).not.toContain("SECRET");
  });
});

describe("detaching", () => {
  it("the function attach returns removes both listeners and the frame is no longer synced", () => {
    const { relay, actions } = rig();
    relay.install();
    const f = new FakeFrame();
    const off = relay.attach(f);
    f.emit("dom-ready");
    const message = pageLine(f, "toggle-terminal");
    expect(relay.attachedCount).toBe(1);
    off();
    expect(relay.attachedCount).toBe(0);
    expect(f.count("dom-ready") + f.count("console-message")).toBe(0);
    f.emit("console-message", { message });
    expect(actions).toEqual([]);
  });

  it("sync drops a frame whose tab is gone", () => {
    const { relay } = rig();
    relay.install();
    const f = new FakeFrame();
    relay.attach(f);
    f.isConnected = false;
    relay.sync();
    expect(relay.attachedCount).toBe(0);
  });

  it("dispose detaches every frame", () => {
    const { relay } = rig();
    relay.install();
    const f = new FakeFrame();
    relay.attach(f);
    relay.dispose();
    expect(relay.attachedCount).toBe(0);
    expect(f.count("console-message")).toBe(0);
  });

  it("a frame with no removeEventListener is still forgotten", () => {
    const { relay } = rig();
    relay.install();
    const f = new FakeFrame();
    (f as { removeEventListener?: unknown }).removeEventListener = undefined;
    relay.attach(f)();
    expect(relay.attachedCount).toBe(0);
  });
});
