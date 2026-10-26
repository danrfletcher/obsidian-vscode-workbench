/**
 * The hotkey bridge: chord resolution from Obsidian's hotkeys, and the page script that matches key events.
 * The script is the only matcher, so these tests run the real script text against synthetic key events.
 */
import { describe, expect, it } from "vitest";
import {
  BRIDGED_ACTIONS,
  KEY_MESSAGE_PREFIX,
  PAGE_STATE_KEY,
  buildRelayScript,
  configSignature,
  resolveChords,
  toPageChord,
  type ChordConfig,
  type HotkeyLike,
} from "../../src/hotkey/hotkey-bridge";

const TOGGLE_ID = "obsidian-vscode-workbench:toggle-terminal-drawer";

interface KeyInit {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
}

class FakeKey {
  prevented = 0;
  stopped = 0;
  constructor(readonly init: KeyInit) {}
  get key() { return this.init.key; }
  get ctrlKey() { return !!this.init.ctrlKey; }
  get metaKey() { return !!this.init.metaKey; }
  get altKey() { return !!this.init.altKey; }
  get shiftKey() { return !!this.init.shiftKey; }
  get repeat() { return !!this.init.repeat; }
  get isComposing() { return !!this.init.isComposing; }
  preventDefault() { this.prevented += 1; }
  stopImmediatePropagation() { this.stopped += 1; }
}

/** A page: the script run against a fake window. `framed` makes `window.parent` another window. */
function page(config: ChordConfig, opts: { framed?: boolean; win?: Record<string, unknown>; nonce?: string } = {}) {
  const listeners: Array<{ type: string; fn: (ev: FakeKey) => void; capture: unknown }> = [];
  const logged: string[] = [];
  const posted: Array<{ message: unknown; target: unknown }> = [];
  const win: Record<string, unknown> = opts.win ?? {};
  win.addEventListener = (type: string, fn: (ev: FakeKey) => void, capture: unknown) => listeners.push({ type, fn, capture });
  win.parent = opts.framed ? { postMessage: (message: unknown, target: unknown) => posted.push({ message, target }) } : win;
  const run = (c: ChordConfig) => new Function("window", "console", buildRelayScript(c, opts.nonce))(win, { log: (m: string) => logged.push(m) });
  run(config);
  return {
    win,
    listeners,
    logged,
    posted,
    rerun: run,
    press(init: KeyInit): FakeKey {
      const ev = new FakeKey(init);
      for (const l of listeners) if (l.type === "keydown") l.fn(ev);
      return ev;
    },
    actions: () => logged.map((m) => JSON.parse(m.slice(KEY_MESSAGE_PREFIX.length)).action as string),
  };
}

const hk = (key: string, ...modifiers: string[]): HotkeyLike => ({ modifiers, key });
const lookupOf = (table: Record<string, HotkeyLike[]>) => (id: string) => table[id] ?? [];

describe("toPageChord: Obsidian hotkeys to page chords", () => {
  it.each([
    ["Mod on macOS is Cmd", hk("o", "Mod"), true, { ctrl: false, meta: true, alt: false, shift: false, key: "o" }],
    ["Mod elsewhere is Ctrl", hk("o", "Mod"), false, { ctrl: true, meta: false, alt: false, shift: false, key: "o" }],
    ["Ctrl stays Ctrl on macOS", hk("`", "Ctrl"), true, { ctrl: true, meta: false, alt: false, shift: false, key: "`" }],
    ["Meta stays Meta elsewhere", hk("k", "Meta"), false, { ctrl: false, meta: true, alt: false, shift: false, key: "k" }],
    ["all four modifiers", hk("P", "Ctrl", "Meta", "Alt", "Shift"), true, { ctrl: true, meta: true, alt: true, shift: true, key: "p" }],
    ["no modifiers", hk("F9"), true, { ctrl: false, meta: false, alt: false, shift: false, key: "f9" }],
  ])("%s", (_name, hotkey, isMac, expected) => {
    expect(toPageChord("open-switcher", hotkey, isMac as boolean)).toEqual({ action: "open-switcher", ...(expected as object) });
  });

  it("refuses a hotkey with no key or a malformed shape", () => {
    expect(toPageChord("open-switcher", { modifiers: ["Mod"], key: "" }, true)).toBeNull();
    expect(toPageChord("open-switcher", { modifiers: "Mod" as never, key: "o" }, true)).toBeNull();
    expect(toPageChord("open-switcher", null as never, true)).toBeNull();
  });
});

describe("resolveChords", () => {
  it("bridges exactly two actions, the drawer toggle and the quick switcher", () => {
    expect(BRIDGED_ACTIONS.map((a) => [a.action, a.commandId])).toEqual([
      ["toggle-terminal", TOGGLE_ID],
      ["open-switcher", "switcher:open"],
    ]);
  });

  it("reads each command's hotkeys, several per command", () => {
    const config = resolveChords(lookupOf({ [TOGGLE_ID]: [hk("`", "Ctrl"), hk("j", "Alt")], "switcher:open": [hk("o", "Mod")] }), true);
    expect(config.chords.map((c) => [c.action, c.key])).toEqual([["toggle-terminal", "`"], ["toggle-terminal", "j"], ["open-switcher", "o"]]);
  });

  it("a command with no hotkeys (the user unbound it) bridges nothing", () => {
    expect(resolveChords(lookupOf({ [TOGGLE_ID]: [] }), true).chords).toEqual([]);
  });

  it("a hotkey manager that has no answer (null or undefined) bridges nothing and does not throw", () => {
    expect(resolveChords(() => null as never, true).chords).toEqual([]);
    expect(resolveChords(() => undefined as never, true).chords).toEqual([]);
    // One command answering nothing does not stop the other from being read.
    const config = resolveChords((id) => (id === TOGGLE_ID ? (undefined as never) : [hk("o", "Mod")]), true);
    expect(config.chords.map((c) => [c.action, c.key])).toEqual([["open-switcher", "o"]]);
  });

  it("a malformed hotkey is dropped and the well-formed ones around it are kept", () => {
    const bad = [{ modifiers: "Mod", key: "o" }, { modifiers: ["Mod"], key: "" }, { modifiers: ["Mod"] }, null] as unknown as HotkeyLike[];
    const config = resolveChords(lookupOf({ [TOGGLE_ID]: [hk("`", "Ctrl"), ...bad, hk("j", "Alt")], "switcher:open": bad }), true);
    expect(config.chords.map((c) => [c.action, c.key])).toEqual([["toggle-terminal", "`"], ["toggle-terminal", "j"]]);
  });

  it("a hotkey manager that throws bridges nothing and does not throw", () => {
    expect(resolveChords(() => { throw new Error("no manager"); }, true).chords).toEqual([]);
  });

  it("the signature changes with a rebinding and not with the order of chords", () => {
    const a = resolveChords(lookupOf({ [TOGGLE_ID]: [hk("`", "Ctrl")], "switcher:open": [hk("o", "Mod")] }), true);
    const reordered: ChordConfig = { chords: [...a.chords].reverse() };
    const rebound = resolveChords(lookupOf({ [TOGGLE_ID]: [hk("j", "Ctrl")], "switcher:open": [hk("o", "Mod")] }), true);
    expect(configSignature(reordered)).toBe(configSignature(a));
    expect(configSignature(rebound)).not.toBe(configSignature(a));
  });
});

describe("the page script", () => {
  const defaults = (isMac: boolean) =>
    resolveChords(lookupOf({ [TOGGLE_ID]: [hk("`", "Ctrl")], "switcher:open": [hk("o", "Mod")] }), isMac);

  describe.each([
    ["macOS", true, { ctrlKey: true }, { metaKey: true }],
    ["Linux and Windows", false, { ctrlKey: true }, { ctrlKey: true }],
  ])("on %s", (_os, isMac, toggleMods, switcherMods) => {
    it("Ctrl+` reports toggle-terminal and is consumed", () => {
      const p = page(defaults(isMac));
      const ev = p.press({ key: "`", ...toggleMods });
      expect(p.actions()).toEqual(["toggle-terminal"]);
      expect([ev.prevented, ev.stopped]).toEqual([1, 1]);
    });

    it("the quick switcher chord (Mod+O) reports open-switcher and is consumed", () => {
      const p = page(defaults(isMac));
      const ev = p.press({ key: "o", ...switcherMods });
      expect(p.actions()).toEqual(["open-switcher"]);
      expect([ev.prevented, ev.stopped]).toEqual([1, 1]);
    });
  });

  it("on macOS Ctrl+O is not the switcher and Cmd+` is not the toggle", () => {
    const p = page(defaults(true));
    const a = p.press({ key: "o", ctrlKey: true });
    const b = p.press({ key: "`", metaKey: true });
    expect(p.actions()).toEqual([]);
    expect([a.prevented, b.prevented, a.stopped, b.stopped]).toEqual([0, 0, 0, 0]);
  });

  it("matches the key case-insensitively (Caps Lock, Shift held as part of the chord)", () => {
    const p = page(defaults(true));
    p.press({ key: "O", metaKey: true });
    expect(p.actions()).toEqual(["open-switcher"]);
  });

  it.each([
    ["Cmd+P (quick open)", { key: "p", metaKey: true }],
    ["Cmd+S (save)", { key: "s", metaKey: true }],
    ["Ctrl+Space (IntelliSense)", { key: " ", ctrlKey: true }],
    ["plain typing, a letter", { key: "o" }],
    ["plain typing, a backtick", { key: "`" }],
    ["Enter", { key: "Enter" }],
    ["Cmd+Shift+O (a different chord from Cmd+O)", { key: "o", metaKey: true, shiftKey: true }],
    ["Cmd+Alt+O", { key: "o", metaKey: true, altKey: true }],
    ["Ctrl+Shift+`", { key: "`", ctrlKey: true, shiftKey: true }],
    ["Ctrl+Cmd+O (extra modifier)", { key: "o", metaKey: true, ctrlKey: true }],
    ["an event with no key", { key: undefined as unknown as string, ctrlKey: true }],
  ])("leaves %s alone: not consumed, nothing reported", (_name, init) => {
    const p = page(defaults(true));
    const ev = p.press(init);
    expect(p.logged).toEqual([]);
    expect([ev.prevented, ev.stopped]).toEqual([0, 0]);
  });

  it("a held key acts once: auto-repeat events are consumed (no backtick typed) but report nothing", () => {
    const p = page(defaults(true));
    const first = p.press({ key: "`", ctrlKey: true });
    const repeats = [1, 2, 3, 4].map(() => p.press({ key: "`", ctrlKey: true, repeat: true }));
    expect(p.actions()).toEqual(["toggle-terminal"]);
    expect(first.prevented).toBe(1);
    for (const r of repeats) expect([r.prevented, r.stopped]).toEqual([1, 1]);
    p.press({ key: "`", ctrlKey: true }); // released and pressed again: a new press
    expect(p.actions()).toEqual(["toggle-terminal", "toggle-terminal"]);
  });

  it("keys during IME composition are never touched", () => {
    const p = page(defaults(true));
    const ev = p.press({ key: "`", ctrlKey: true, isComposing: true });
    expect(p.logged).toEqual([]);
    expect(ev.prevented).toBe(0);
  });

  it("adds one capture-phase keydown listener on the window, however many times it runs", () => {
    const p = page(defaults(true));
    p.rerun(defaults(true));
    p.rerun(defaults(true));
    expect(p.listeners).toHaveLength(1);
    expect(p.listeners[0]).toMatchObject({ type: "keydown", capture: true });
  });

  it("rebinding is followed live: a rerun with the new chords moves the binding, and the old chord goes back to VS Code", () => {
    const p = page(defaults(true));
    p.rerun(resolveChords(lookupOf({ [TOGGLE_ID]: [hk("j", "Ctrl", "Alt")], "switcher:open": [hk("o", "Mod")] }), true));
    const old = p.press({ key: "`", ctrlKey: true });
    expect(p.logged).toEqual([]);
    expect(old.prevented).toBe(0);
    p.press({ key: "j", ctrlKey: true, altKey: true });
    expect(p.actions()).toEqual(["toggle-terminal"]);
  });

  it("an unbound command (no chords) consumes and reports nothing", () => {
    const p = page({ chords: [] });
    const ev = p.press({ key: "`", ctrlKey: true });
    expect([p.logged.length, ev.prevented]).toEqual([0, 0]);
  });

  it("reports through the webview channel as a prefixed line holding only the version and the action name", () => {
    const p = page(defaults(true));
    p.press({ key: "`", ctrlKey: true });
    expect(p.logged).toHaveLength(1);
    expect(p.logged[0].startsWith(KEY_MESSAGE_PREFIX)).toBe(true);
    expect(JSON.parse(p.logged[0].slice(KEY_MESSAGE_PREFIX.length))).toEqual({ v: 1, action: "toggle-terminal" });
  });

  it("given a nonce, the console line also carries it as `n`, and nothing else is added", () => {
    const p = page(defaults(true), { nonce: "abc123" });
    p.press({ key: "`", ctrlKey: true });
    expect(JSON.parse(p.logged[0].slice(KEY_MESSAGE_PREFIX.length))).toEqual({ v: 1, action: "toggle-terminal", n: "abc123" });
  });

  it("an empty nonce is the same as none", () => {
    const p = page(defaults(true), { nonce: "" });
    p.press({ key: "`", ctrlKey: true });
    expect(JSON.parse(p.logged[0].slice(KEY_MESSAGE_PREFIX.length))).toEqual({ v: 1, action: "toggle-terminal" });
  });

  it("the nonce is not left on the window, and a later run on the same page keeps the first nonce", () => {
    const p = page(defaults(true), { nonce: "first-nonce" });
    expect(JSON.stringify(Object.entries(p.win).filter(([k]) => k !== "addEventListener" && k !== "parent"))).not.toContain("first-nonce");
    p.rerun(defaults(true)); // no nonce this time: the page's first closure is the one that answers
    p.press({ key: "`", ctrlKey: true });
    expect(JSON.parse(p.logged[0].slice(KEY_MESSAGE_PREFIX.length)).n).toBe("first-nonce");
  });

  it("a nonce with quotes or script text cannot break out of the script", () => {
    const p = page(defaults(true), { nonce: '"; throw new Error("x"); //' });
    p.press({ key: "`", ctrlKey: true });
    expect(JSON.parse(p.logged[0].slice(KEY_MESSAGE_PREFIX.length)).n).toBe('"; throw new Error("x"); //');
  });

  it("a framed page posts to its parent instead, with the same two fields and a marker", () => {
    const p = page(defaults(true), { framed: true });
    p.press({ key: "o", metaKey: true });
    expect(p.logged).toEqual([]);
    expect(p.posted).toEqual([{ message: { vscw: 1, v: 1, action: "open-switcher" }, target: "*" }]);
  });

  it("never reports the typed characters: a bridged chord carries no key text", () => {
    const p = page(defaults(true));
    p.press({ key: "`", ctrlKey: true });
    p.press({ key: "a" });
    p.press({ key: "s", metaKey: true });
    expect(p.logged).toHaveLength(1);
    const payload = p.logged[0].slice(KEY_MESSAGE_PREFIX.length);
    expect(Object.keys(JSON.parse(payload)).sort()).toEqual(["action", "v"]);
    expect(payload).not.toMatch(/[`]|"a"/);
  });

  it("a failing report does not break the key handler", () => {
    const listeners: Array<(ev: FakeKey) => void> = [];
    const win: Record<string, unknown> = { addEventListener: (_t: string, fn: (ev: FakeKey) => void) => listeners.push(fn) };
    win.parent = win;
    new Function("window", "console", buildRelayScript(defaults(true)))(win, { log: () => { throw new Error("console gone"); } });
    const ev = new FakeKey({ key: "`", ctrlKey: true });
    expect(() => listeners[0](ev)).not.toThrow();
    expect(ev.prevented).toBe(1);
  });

  it("keeps its state under one window property", () => {
    const p = page(defaults(true));
    expect(Object.keys(p.win).filter((k) => k.startsWith("__"))).toEqual([PAGE_STATE_KEY]);
  });

  it("has no network, storage or eval use in the script text (F4, F5)", () => {
    const text = buildRelayScript(defaults(true));
    for (const banned of [/fetch\(/, /XMLHttpRequest/, /WebSocket/, /sendBeacon/, /localStorage/, /\beval\(/, /import\(/, /<script/i, /\.src\s*=/]) {
      expect(text).not.toMatch(banned);
    }
  });
});
