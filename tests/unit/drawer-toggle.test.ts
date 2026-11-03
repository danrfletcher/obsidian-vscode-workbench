// @vitest-environment jsdom
/**
 * Ctrl+` from the embed: the toggle state machine against a mocked drawer controller, and the same presses against the
 * real terminal drawer (odd/even counts, blur and focus handoff, the G1 focus-back fallback to the active leaf).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DrawerToggle, toggleState, type FocusHandle, type PageProgress, type ToggleTarget } from "../../src/hotkey/drawer-toggle";
import { resetPage } from "../page-helpers";
import { HEADROOM } from "../../src/terminal/drawer-geometry";
import { FocusReturn } from "../../src/terminal/focus-return";
import { TerminalDrawer, type DrawerHost } from "../../src/terminal/terminal-drawer";
import type { HostView } from "../../src/terminal-host/host-state";

/** A drawer controller reduced to what the toggle drives; the first reveal starts the terminal page. */
class FakeDrawer implements ToggleTarget {
  open = false;
  enabled = true;
  shells = 0;
  toggles = 0;
  progress: PageProgress = "none";
  get isOpen() { return this.open; }
  hotkeyEnabled() { return this.enabled; }
  pageProgress() { return this.progress; }
  toggle() {
    this.toggles += 1;
    this.open = !this.open;
    if (this.open && this.shells === 0) {
      this.shells = 1; // ensureFirst: synchronous, never a second one
      this.progress = "starting";
    }
  }
}

class FakeFocus implements FocusHandle {
  calls: string[] = [];
  blur() { this.calls.push("blur"); }
  focus() { this.calls.push("focus"); }
}

describe("toggle state machine against a mocked drawer", () => {
  it("hidden -> revealing -> shown -> hidden, and shown again with the same shell", () => {
    const d = new FakeDrawer();
    const t = new DrawerToggle(d);
    expect(t.state).toBe("hidden");
    expect(t.press()).toBe("revealing"); // first reveal: the shell is starting
    d.progress = "running";
    expect(t.state).toBe("shown");
    expect(t.press()).toBe("hidden");
    expect(t.press()).toBe("shown"); // the shell is still running: no new one
    expect(d.shells).toBe(1);
  });

  it.each<[boolean, PageProgress, string]>([
    [false, "none", "hidden"],
    [false, "running", "hidden"],
    [true, "none", "revealing"],
    [true, "starting", "revealing"],
    [true, "running", "shown"],
    [true, "ended", "shown"], // the drawer shows the exited or failed message
  ])("open=%s with the shell %s is %s", (open, progress, expected) => {
    const d = new FakeDrawer();
    d.open = open;
    d.progress = progress;
    expect(toggleState(d)).toBe(expected);
  });

  it.each([1, 2, 3, 10, 11])("%i presses in a row end open when odd, closed when even, with one shell", (n) => {
    const d = new FakeDrawer();
    const t = new DrawerToggle(d);
    for (let i = 0; i < n; i++) t.press();
    expect(d.open).toBe(n % 2 === 1);
    expect(d.toggles).toBe(n);
    expect(d.shells).toBe(1);
  });

  it("does nothing, and says so, where the drawer is not available", () => {
    const d = new FakeDrawer();
    d.enabled = false;
    const f = new FakeFocus();
    expect(new DrawerToggle(d).press(f)).toBeNull();
    expect(d.toggles).toBe(0);
    expect(d.shells).toBe(0);
    expect(f.calls).toEqual([]);
  });

  it("opening takes focus out of the embed before the drawer focuses its terminal; closing hands it back", () => {
    const d = new FakeDrawer();
    const f = new FakeFocus();
    const order: string[] = [];
    const orig = d.toggle.bind(d);
    d.toggle = () => {
      order.push("toggle");
      orig();
    };
    const t = new DrawerToggle(d);
    f.blur = () => order.push("blur");
    f.focus = () => order.push("focus");
    t.press(f);
    t.press(f);
    expect(order).toEqual(["blur", "toggle", "toggle", "focus"]);
  });

  it("works with no focus handle and with a handle that has neither method", () => {
    const d = new FakeDrawer();
    const t = new DrawerToggle(d);
    expect(() => { t.press(); t.press({}); t.press(null); }).not.toThrow();
    expect(d.toggles).toBe(3);
  });
});

/** The drawer the plugin uses (PR-3), driven by the same toggle, with a fake host page and fake leaves. */
describe("the real TerminalDrawer under hotkey presses (G1, E9)", () => {
  interface Leaf { name: string }
  const leaves = { a: { name: "a" } as Leaf, b: { name: "b" } as Leaf };
  let alive: Leaf[];
  let active: Leaf | null;
  let focused: string[];
  let calls: string[];
  let progress: HostView;
  let drawer: TerminalDrawer;

  const host: DrawerHost = {
    show: () => calls.push("show"),
    hide: () => calls.push("hide"),
    focusTerminal: () => calls.push("focus-terminal"),
    view: () => progress,
  };

  beforeEach(() => {
    resetPage();
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
    alive = [leaves.a, leaves.b];
    active = leaves.a;
    focused = [];
    calls = [];
    progress = "hidden";
    drawer = new TerminalDrawer({
      document,
      window,
      host: () => host,
      initialHeight: 300,
      saveHeight: () => undefined,
      viewKind: () => "markdown",
      nonCodeDrawer: () => false, // the edge is off over this note; the hotkey is not
      focus: new FocusReturn<Leaf>({
        activeLeaf: () => active,
        isAlive: (l) => alive.includes(l),
        focusLeaf: (l) => focused.push(l.name),
      }) as FocusReturn<unknown>,
    });
    drawer.mount();
  });
  afterEach(() => {
    drawer.dispose();
    resetPage();
  });

  it("the toggle is available over every view whatever the setting, and the edge is off", () => {
    expect(drawer.hotkeyEnabled()).toBe(true);
    expect((document.querySelector(".vscw-edge") as HTMLElement).hidden).toBe(true);
    expect(new DrawerToggle(drawer).press()).toBe("revealing");
    expect(drawer.isOpen).toBe(true);
  });

  it.each([1, 2, 3, 10, 11])("%i presses end open when odd and closed when even, showing the one host page once per open", (n) => {
    const t = new DrawerToggle(drawer);
    for (let i = 0; i < n; i++) t.press();
    expect(drawer.isOpen).toBe(n % 2 === 1);
    expect(calls.filter((c) => c === "show")).toHaveLength(Math.ceil(n / 2));
    expect(calls.filter((c) => c === "hide")).toHaveLength(Math.floor(n / 2));
  });

  it("opening: the embed gives up focus first, the host is shown, then the terminal takes focus; closing from the embed hands focus back", () => {
    const embed = new FakeFocus();
    const t = new DrawerToggle(drawer);
    embed.blur = () => calls.push("embed-blur");
    embed.focus = () => calls.push("embed-focus");
    t.press(embed);
    expect(calls).toEqual(["embed-blur", "show", "focus-terminal"]);
    t.press(embed);
    expect(calls.slice(3)).toEqual(["hide", "embed-focus"]);
  });

  it("hiding sends focus back to the leaf that had it when the drawer opened, even if another is active now", () => {
    const t = new DrawerToggle(drawer);
    t.press(); // remembers a
    active = leaves.b;
    t.press();
    expect(focused).toEqual(["a"]);
  });

  it("G1: when that leaf is gone, focus goes to the active leaf", () => {
    const t = new DrawerToggle(drawer);
    t.press();
    alive = [leaves.b];
    active = leaves.b;
    t.press();
    expect(focused).toEqual(["b"]);
  });

  it("with no leaf at all, closing does not throw and focuses nothing", () => {
    active = null;
    const t = new DrawerToggle(drawer);
    t.press();
    expect(() => t.press()).not.toThrow();
    expect(focused).toEqual([]);
  });

  it("the host closing itself (the licence declined) closes the drawer and sends focus back, without a second hide", () => {
    const t = new DrawerToggle(drawer);
    t.press();
    drawer.hostClosed();
    expect(drawer.isOpen).toBe(false);
    expect(focused).toEqual(["a"]);
    expect(calls).not.toContain("hide");
    expect(t.state).toBe("hidden");
  });

  it.each<[HostView, string]>([
    ["hidden", "revealing"],
    ["stopped", "revealing"],
    ["licence", "revealing"],
    ["starting", "revealing"],
    ["running", "shown"],
    ["lost", "shown"],
    ["error", "shown"],
  ])("with the host page %s the open drawer reads %s", (view, expected) => {
    progress = view;
    drawer.openDrawer();
    expect(toggleState(drawer)).toBe(expected);
  });

  it("a drawer saved open is not restored: a new drawer starts closed", () => {
    expect(drawer.isOpen).toBe(false);
    expect(calls).toEqual([]);
  });

  it("E9: reopening after the window shrank clamps the height", () => {
    const t = new DrawerToggle(drawer);
    t.press();
    t.press();
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 300 });
    t.press();
    expect(drawer.currentHeight).toBe(300 - HEADROOM);
  });
});

describe("FocusReturn", () => {
  it("forgets the remembered leaf after one restore: the next close uses the active leaf", () => {
    const out: string[] = [];
    let active: string | null = "x";
    const f = new FocusReturn<string>({ activeLeaf: () => active, isAlive: () => true, focusLeaf: (l) => out.push(l) });
    f.remember();
    active = "y";
    f.restore();
    f.restore();
    expect(out).toEqual(["x", "y"]);
  });
});
