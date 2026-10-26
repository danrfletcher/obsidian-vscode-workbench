// @vitest-environment jsdom
/**
 * Ctrl+` from the embed: the toggle state machine against a mocked drawer controller, then the same presses
 * against the real terminal feature (fake emulator and fake helper processes) for shell counts, the window clamp,
 * the red messages and the non-code setting.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DrawerToggle, toggleState, type FocusHandle, type ShellProgress, type ToggleTarget } from "../../src/hotkey/drawer-toggle";
import { CODE_VIEW, featureRig, resetPage, tick, type Rig } from "../feature-rig";
import { HEADROOM } from "../../src/terminal/drawer-geometry";

/** The drawer controller as PR-6 offers it, reduced to what the toggle drives; the first reveal makes one shell. */
class FakeDrawer implements ToggleTarget {
  open = false;
  enabled = true;
  shells = 0;
  toggles = 0;
  progress: ShellProgress = "none";
  get isOpen() { return this.open; }
  hotkeyEnabled() { return this.enabled; }
  shellProgress() { return this.progress; }
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

  it.each<[boolean, ShellProgress, string]>([
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

describe("the real terminal feature under hotkey presses", () => {
  let r: Rig;
  const viewTypeIsCode = () => { r.view.type = CODE_VIEW; };

  beforeEach(() => {
    resetPage();
    r = featureRig();
    viewTypeIsCode();
    r.feature.mount();
  });

  afterEach(async () => {
    await r.feature.dispose();
    resetPage();
  });

  it("the first press reveals the drawer and creates exactly one shell, started once", async () => {
    const t = new DrawerToggle(r.feature);
    expect(t.state).toBe("hidden");
    expect(t.press()).toBe("revealing");
    await tick();
    expect(t.state).toBe("shown");
    expect(r.feature.sessions.sessions).toHaveLength(1);
    expect(r.world.spawned).toHaveLength(1);
  });

  it("ten presses in a row leave the drawer closed, one shell, one helper process", async () => {
    const t = new DrawerToggle(r.feature);
    for (let i = 0; i < 10; i++) t.press();
    await tick();
    expect(r.feature.drawer?.open).toBe(false);
    expect(r.feature.sessions.sessions).toHaveLength(1);
    expect(r.world.spawned).toHaveLength(1);
    t.press(); // an eleventh reveals the same shell, no new one
    await tick();
    expect(r.feature.drawer?.open).toBe(true);
    expect(r.world.spawned).toHaveLength(1);
    expect(r.feature.sessions.sessions).toHaveLength(1);
  });

  it("hiding and revealing again shows the same shell with its history (the scrollback is kept)", async () => {
    const t = new DrawerToggle(r.feature);
    t.press();
    await tick();
    r.world.spawned[0].child.output("ls output\r\n");
    await tick();
    const resetsBefore = r.views[0].resets; // the start of the shell cleared the screen once
    t.press();
    t.press();
    await tick();
    expect(r.world.spawned).toHaveLength(1);
    expect(r.views).toHaveLength(1);
    expect(r.views[0].text()).toContain("ls output");
    expect(r.views[0].resets).toBe(resetsBefore);
  });

  it("revealing moves focus to the terminal; closing from the embed hands it back to the embed", async () => {
    const t = new DrawerToggle(r.feature);
    const embed = new FakeFocus();
    t.press(embed);
    await tick();
    expect(embed.calls).toEqual(["blur"]);
    expect(r.views[0].focuses).toBeGreaterThan(0);
    t.press(embed);
    expect(embed.calls).toEqual(["blur", "focus"]);
  });

  it("closing with focus inside the terminal (its own key) asks the host to focus the editor", async () => {
    let focused = 0;
    r.host.focusEditor = () => { focused += 1; };
    const t = new DrawerToggle(r.feature);
    t.press();
    await tick();
    const field = document.createElement("textarea");
    document.querySelector(".vscw-terminal")!.appendChild(field);
    field.focus();
    r.views[0].pressToggleKey(); // Ctrl+` typed in the terminal
    expect(r.feature.drawer?.open).toBe(false);
    expect(focused).toBe(1);
  });

  it("closing with focus elsewhere does not steal focus for the editor", async () => {
    let focused = 0;
    r.host.focusEditor = () => { focused += 1; };
    const t = new DrawerToggle(r.feature);
    t.press();
    await tick();
    t.press();
    expect(focused).toBe(0);
  });

  it("a drawer remembered taller than the window is clamped when the hotkey reveals it (E14)", async () => {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
    const t = new DrawerToggle(r.feature);
    t.press();
    r.feature.drawer!.close();
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 300 });
    const tall = r.feature.drawer!.currentHeight;
    t.press();
    expect(r.feature.drawer!.currentHeight).toBeLessThanOrEqual(300 - HEADROOM);
    expect(r.feature.drawer!.currentHeight).toBeLessThanOrEqual(tall);
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 768 });
  });

  it.each([
    ["python3 missing", { ok: false, kind: "python-missing", message: "python3 was not found on your PATH." }],
    ["the macOS Command Line Tools stub (E9)", { ok: false, kind: "python-stub", message: "python3 is the macOS Command Line Tools placeholder." }],
    ["a missing shell binary (E10)", { ok: false, kind: "shell-missing", message: "The shell /nope does not exist." }],
  ])("%s shows the red message and the same hotkey still hides the drawer", async (_name, result) => {
    r.preflight.result = () => result as never;
    const t = new DrawerToggle(r.feature);
    t.press();
    await tick();
    const msg = document.querySelector(".vscw-message") as HTMLElement;
    expect(msg.hidden).toBe(false);
    expect(msg.classList.contains("vscw-error")).toBe(true);
    expect(msg.textContent).toContain(result.message);
    expect(t.state).toBe("shown");
    expect(r.world.spawned).toHaveLength(0);
    expect(t.press()).toBe("hidden");
    expect(r.feature.drawer?.open).toBe(false);
  });

  it("with the non-code setting off the press does nothing over a note, canvas, graph or PDF, and works over a Code tab", async () => {
    r.setting.nonCodeDrawer = false;
    r.feature.applyVisibility();
    const t = new DrawerToggle(r.feature);
    for (const type of ["markdown", "canvas", "graph", "pdf"]) {
      r.view.type = type;
      expect(t.press(), type).toBeNull();
    }
    expect(r.feature.drawer?.open).toBe(false);
    expect(r.feature.sessions.sessions).toHaveLength(0);
    r.view.type = CODE_VIEW;
    expect(t.press()).toBe("revealing");
    expect(r.feature.drawer?.open).toBe(true);
  });
});
