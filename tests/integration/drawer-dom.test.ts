// @vitest-environment jsdom
/**
 * The drawer in a DOM (jsdom): the strip and close control, the drag with pointer events, the clamp,
 * per-device state in data.json, the shell on first reveal, and the command with its default hotkey.
 * The terminal emulator and the helper process are fakes; nothing here starts a real shell.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileSystemAdapter, Notice, Plugin, TFile, WorkspaceLeaf, type MockApp } from "../mocks/obsidian";
import VSCodeWorkbenchPlugin from "../../src/main";
import { DrawerUI } from "../../src/terminal/drawer-ui";
import { HEADROOM, MIN_HEIGHT } from "../../src/terminal/drawer-geometry";
import { DRAWER_KEY } from "../../src/terminal/drawer-state";
import { TerminalFeature, type TerminalHost } from "../../src/terminal/feature";
import type { PreflightResult } from "../../src/terminal/pty-preflight";
import { ChildRegistry } from "../../src/child-registry";
import { fakeWorld } from "../fake-pty";
import { FakeTerminalView } from "../fake-terminal-view";
import { REPO_ROOT, tempDir } from "../helpers";

const GOOD: PreflightResult = { ok: true, python: "/usr/bin/python3", shell: "/bin/zsh" };
const tick = () => new Promise((r) => setTimeout(r, 5));
const body = () => document.body;
const root = () => document.querySelector(".vscw-root") as HTMLElement;
const strip = () => document.querySelector(".vscw-strip") as HTMLButtonElement;
const handle = () => document.querySelector(".vscw-resize-handle") as HTMLElement;
const px = (name: string) => Number.parseFloat(body().style.getPropertyValue(name));

function pointer(type: string, init: { clientY?: number; clientX?: number; buttons?: number } = {}): Event {
  const Ctor = (window as unknown as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? MouseEvent;
  return new Ctor(type, { bubbles: true, cancelable: true, button: 0, buttons: 1, ...init });
}

function setWindowHeight(h: number): void {
  Object.defineProperty(window, "innerHeight", { configurable: true, value: h });
}

beforeEach(() => {
  setWindowHeight(900);
  document.body.className = "";
  document.body.removeAttribute("style");
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
});

/** A drawer with a fake terminal; `states` records what it asks to be saved. */
function makeUI(initial = { height: 300, open: false }) {
  const views: FakeTerminalView[] = [];
  const saved: Array<{ height: number; open: boolean }> = [];
  const events: string[] = [];
  const ui = new DrawerUI({
    document,
    window,
    initial,
    onChange: (s) => saved.push({ ...s }),
    onReveal: () => events.push("reveal"),
    onRestart: () => events.push("restart"),
    createTerminal: () => {
      const v = new FakeTerminalView();
      views.push(v);
      return v;
    },
  });
  ui.mount();
  return { ui, views, saved, events };
}

describe("strip and slide (G8)", () => {
  it("shows the strip when mounted, with the drawer closed and no terminal created yet", () => {
    const { views } = makeUI();
    expect(strip()).not.toBeNull();
    expect(strip().textContent).toBe("Terminal");
    expect(root().classList.contains("vscw-open")).toBe(false);
    expect(strip().getAttribute("aria-expanded")).toBe("false");
    expect(px("--vscw-open-height")).toBe(0);
    expect(views).toHaveLength(0);
  });

  it("a click on the strip toggles the open class and the height variables, and a second click closes", () => {
    const { views, events } = makeUI();
    strip().click();
    expect(root().classList.contains("vscw-open")).toBe(true);
    expect(body().classList.contains("vscw-terminal-open")).toBe(true);
    expect(strip().getAttribute("aria-expanded")).toBe("true");
    expect(px("--vscw-open-height")).toBe(300);
    expect(px("--vscw-height")).toBe(300);
    expect(views).toHaveLength(1);
    expect(events).toEqual(["reveal"]);
    strip().click();
    expect(root().classList.contains("vscw-open")).toBe(false);
    expect(px("--vscw-open-height")).toBe(0);
    expect(px("--vscw-height")).toBe(300); // the content keeps its height, so nothing reflows mid-slide
  });

  it("the close control closes the drawer", () => {
    makeUI();
    strip().click();
    (document.querySelector(".vscw-close") as HTMLElement).click();
    expect(root().classList.contains("vscw-open")).toBe(false);
  });

  it("hiding and revealing again keeps the same terminal and reveals to the shell each time", () => {
    const { views, events } = makeUI();
    strip().click();
    strip().click();
    strip().click();
    expect(views).toHaveLength(1);
    expect(views[0].disposed).toBe(false);
    expect(events).toEqual(["reveal", "reveal"]);
  });

  it("a rapid run of clicks ends in the state the click count says, never in between", () => {
    const { ui } = makeUI();
    for (let i = 1; i <= 7; i++) {
      strip().click();
      expect(ui.open).toBe(i % 2 === 1);
      expect(root().classList.contains("vscw-open")).toBe(ui.open);
    }
  });

  it("focuses the terminal on reveal", () => {
    const { views } = makeUI();
    strip().click();
    expect(views[0].focuses).toBeGreaterThan(0);
  });

  it("slides: the stylesheet transitions the drawer's height in about 150-250 ms", () => {
    const css = fs.readFileSync(path.join(REPO_ROOT, "src/styles.css"), "utf8");
    const slide = /--vscw-slide:\s*(\d+)ms/.exec(css);
    expect(slide).not.toBeNull();
    expect(Number(slide?.[1])).toBeGreaterThanOrEqual(150);
    expect(Number(slide?.[1])).toBeLessThanOrEqual(250);
    const drawerRule = /\.vscw-drawer\s*\{[^}]*\}/.exec(css)?.[0] ?? "";
    expect(drawerRule).toMatch(/transition:[^;]*height var\(--vscw-slide/);
  });

  it("the cursor over the top edge is the vertical-resize cursor (styles applied by the browser's cascade)", () => {
    const css = fs.readFileSync(path.join(REPO_ROOT, "src/styles.css"), "utf8");
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
    makeUI();
    expect(getComputedStyle(handle()).cursor).toBe("ns-resize");
    style.remove();
  });

  it("unmount removes the strip, the drawer and every page variable", () => {
    const { ui, views } = makeUI();
    strip().click();
    ui.unmount();
    expect(root()).toBeNull();
    expect(body().classList.contains("vscw-terminal-on")).toBe(false);
    expect(body().style.getPropertyValue("--vscw-height")).toBe("");
    expect(views[0].disposed).toBe(true);
  });
});

describe("dragging the top edge (G9, E14)", () => {
  function open() {
    const made = makeUI();
    strip().click();
    return made;
  }

  it("resizes live as the pointer moves: up grows the drawer, down shrinks it", () => {
    const { ui } = open();
    handle().dispatchEvent(pointer("pointerdown", { clientY: 600 }));
    expect(root().classList.contains("vscw-dragging")).toBe(true);
    window.dispatchEvent(pointer("pointermove", { clientY: 500 }));
    expect(ui.currentHeight).toBe(400);
    expect(px("--vscw-open-height")).toBe(400);
    window.dispatchEvent(pointer("pointermove", { clientY: 650 }));
    expect(ui.currentHeight).toBe(250);
    expect(px("--vscw-height")).toBe(250);
  });

  it("refits the terminal during the drag and on release, and saves the height once, on release", () => {
    const { views, saved } = open();
    const before = views[0].fits;
    handle().dispatchEvent(pointer("pointerdown", { clientY: 600 }));
    window.dispatchEvent(pointer("pointermove", { clientY: 550 }));
    window.dispatchEvent(pointer("pointermove", { clientY: 500 }));
    expect(views[0].fits).toBeGreaterThanOrEqual(before + 2); // while dragging
    const during = views[0].fits;
    expect(saved).toEqual([{ height: 300, open: true }]); // only the open, nothing yet from the drag
    window.dispatchEvent(pointer("pointerup", { clientY: 500, buttons: 0 }));
    expect(views[0].fits).toBeGreaterThan(during); // on release
    expect(saved.at(-1)).toEqual({ height: 400, open: true });
    expect(saved).toHaveLength(2);
    expect(root().classList.contains("vscw-dragging")).toBe(false);
  });

  it("stops at the minimum however far the pointer goes down", () => {
    const { ui } = open();
    handle().dispatchEvent(pointer("pointerdown", { clientY: 600 }));
    window.dispatchEvent(pointer("pointermove", { clientY: 5000 }));
    expect(ui.currentHeight).toBe(MIN_HEIGHT);
    window.dispatchEvent(pointer("pointermove", { clientY: -99999 + 5000 }));
    expect(ui.currentHeight).toBeGreaterThan(MIN_HEIGHT);
  });

  it("stops at the maximum (window height minus the headroom) however far the pointer goes up", () => {
    const { ui } = open();
    handle().dispatchEvent(pointer("pointerdown", { clientY: 600 }));
    window.dispatchEvent(pointer("pointermove", { clientY: -4000 }));
    expect(ui.currentHeight).toBe(900 - HEADROOM);
    window.dispatchEvent(pointer("pointermove", { clientY: -9000 }));
    expect(ui.currentHeight).toBe(900 - HEADROOM);
  });

  it("a pointer-up outside the window ends the drag: later moves do nothing and no drag state is left", () => {
    const { ui, saved } = open();
    handle().dispatchEvent(pointer("pointerdown", { clientY: 600 }));
    window.dispatchEvent(pointer("pointermove", { clientY: 520 }));
    document.dispatchEvent(pointer("pointerup", { clientY: 5000, clientX: -300, buttons: 0 })); // released far outside the window
    const height = ui.currentHeight;
    expect(root().classList.contains("vscw-dragging")).toBe(false);
    expect(body().classList.contains("vscw-terminal-dragging")).toBe(false);
    window.dispatchEvent(pointer("pointermove", { clientY: 100 }));
    expect(ui.currentHeight).toBe(height);
    expect(saved.at(-1)).toEqual({ height, open: true });
  });

  it("a move with no button down (the release happened where the page saw nothing) also ends the drag", () => {
    const { ui } = open();
    handle().dispatchEvent(pointer("pointerdown", { clientY: 600 }));
    window.dispatchEvent(pointer("pointermove", { clientY: 500, buttons: 0 }));
    expect(root().classList.contains("vscw-dragging")).toBe(false);
    window.dispatchEvent(pointer("pointermove", { clientY: 200, buttons: 1 }));
    expect(ui.currentHeight).toBe(300);
  });

  it("losing the pointer or the window ends the drag", () => {
    for (const end of [() => window.dispatchEvent(new Event("blur")), () => window.dispatchEvent(pointer("pointercancel")), () => handle().dispatchEvent(new Event("lostpointercapture"))]) {
      document.body.innerHTML = "";
      open();
      handle().dispatchEvent(pointer("pointerdown", { clientY: 600 }));
      expect(root().classList.contains("vscw-dragging")).toBe(true);
      end();
      expect(root().classList.contains("vscw-dragging")).toBe(false);
    }
  });

  it("closing during a drag drops the drag, and a second pointer-down does not start a second drag", () => {
    const { ui } = open();
    handle().dispatchEvent(pointer("pointerdown", { clientY: 600 }));
    handle().dispatchEvent(pointer("pointerdown", { clientY: 100 }));
    window.dispatchEvent(pointer("pointermove", { clientY: 500 }));
    expect(ui.currentHeight).toBe(400); // measured from the first pointer-down
    ui.close();
    expect(root().classList.contains("vscw-dragging")).toBe(false);
    window.dispatchEvent(pointer("pointermove", { clientY: 300 }));
    expect(ui.currentHeight).toBe(400);
  });

  it("ignores a press of a button other than the main one", () => {
    open();
    handle().dispatchEvent(pointer("pointerdown", { clientY: 600, buttons: 2 }) as Event & { button: number });
    // the helper above sets button 0; build one with button 2 explicitly
    document.body.innerHTML = "";
    const { ui } = open();
    const Ctor = (window as unknown as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? MouseEvent;
    handle().dispatchEvent(new Ctor("pointerdown", { bubbles: true, button: 2, buttons: 2, clientY: 600 }));
    window.dispatchEvent(pointer("pointermove", { clientY: 500 }));
    expect(ui.currentHeight).toBe(300);
  });
});

describe("window shrink (E14)", () => {
  it("clamps an open drawer to the new maximum, keeps the strip, and stores the corrected height", () => {
    const { ui, saved } = makeUI({ height: 700, open: true });
    expect(ui.currentHeight).toBe(700);
    setWindowHeight(500);
    window.dispatchEvent(new Event("resize"));
    expect(ui.currentHeight).toBe(500 - HEADROOM);
    expect(px("--vscw-open-height")).toBe(500 - HEADROOM);
    expect(strip()).not.toBeNull();
    expect(saved.at(-1)).toEqual({ height: 500 - HEADROOM, open: true });
  });

  it("does nothing, and saves nothing, when the window still fits the drawer", () => {
    const { saved } = makeUI({ height: 300, open: true });
    const before = saved.length;
    setWindowHeight(800);
    window.dispatchEvent(new Event("resize"));
    expect(saved.length).toBe(before);
  });

  it("a drawer closed while the window shrank is clamped when it is next opened", () => {
    const { ui } = makeUI({ height: 700, open: false });
    setWindowHeight(450);
    ui.toggle();
    expect(ui.currentHeight).toBe(450 - HEADROOM);
  });
});

describe("messages in the drawer (E9, E10)", () => {
  it("shows an error as a red alert in place of the terminal, with a way to try again", () => {
    const { ui, events } = makeUI();
    strip().click();
    ui.showError("python3 was not found on your PATH");
    const msg = document.querySelector(".vscw-message") as HTMLElement;
    expect(msg.hidden).toBe(false);
    expect(msg.classList.contains("vscw-error")).toBe(true);
    expect(msg.getAttribute("role")).toBe("alert");
    expect(msg.textContent).toContain("python3 was not found on your PATH");
    expect((document.querySelector(".vscw-terminal") as HTMLElement).classList.contains("vscw-hidden")).toBe(true);
    const retry = document.querySelector(".vscw-restart") as HTMLButtonElement;
    expect(retry.textContent).toBe("Try again");
    retry.click();
    expect(events).toContain("restart");
  });

  it("the error style is red from Obsidian's own error colour", () => {
    const css = fs.readFileSync(path.join(REPO_ROOT, "src/styles.css"), "utf8");
    expect(css).toMatch(/\.vscw-message\.vscw-error\s*\{[^}]*color:\s*var\(--text-error/);
  });

  it("an exited shell writes an 'exited' line into the terminal and offers a restart", () => {
    const { ui, views, events } = makeUI();
    strip().click();
    ui.showExited(0);
    expect(views[0].text()).toContain("The shell has exited (code 0).");
    const msg = document.querySelector(".vscw-message") as HTMLElement;
    expect(msg.hidden).toBe(false);
    expect(msg.classList.contains("vscw-error")).toBe(false);
    const restart = document.querySelector(".vscw-restart") as HTMLButtonElement;
    expect(restart.textContent).toBe("Restart shell");
    restart.click();
    expect(events).toContain("restart");
  });

  it("a new shell clears the message and the old screen", () => {
    const { ui, views } = makeUI();
    strip().click();
    ui.showError("oops");
    ui.showStarting();
    expect((document.querySelector(".vscw-message") as HTMLElement).hidden).toBe(true);
    expect((document.querySelector(".vscw-terminal") as HTMLElement).classList.contains("vscw-hidden")).toBe(false);
    expect(views[0].resets).toBe(1);
  });

  it("keystrokes typed into the terminal and its size reach the callbacks", () => {
    const { ui, views } = makeUI();
    const typed: string[] = [];
    const sizes: Array<[number, number]> = [];
    ui.onInput((d) => typed.push(d));
    ui.onTerminalResize((c, r) => sizes.push([c, r]));
    strip().click();
    views[0].type("ls\r");
    views[0].setCells(120, 33);
    expect(typed).toEqual(["ls\r"]);
    expect(sizes).toEqual([[120, 33]]);
  });

  it("the toggle key pressed inside the terminal toggles the drawer", () => {
    const { ui, views } = makeUI();
    strip().click();
    views[0].pressToggleKey();
    expect(ui.open).toBe(false);
  });
});

// --- The feature: drawer, shell and data.json together -----------------------------------------

interface Rig {
  host: TerminalHost;
  data: Record<string, unknown>;
  saves: number;
  setActive(p: string | null): void;
  views: FakeTerminalView[];
  world: ReturnType<typeof fakeWorld>;
  feature: TerminalFeature;
  vault: string;
  id: string;
}

function rig(opts: { data?: Record<string, unknown>; id?: string; preflight?: () => Promise<PreflightResult>; vault?: string } = {}): Rig {
  const vault = opts.vault ?? tempDir();
  for (const d of ["AWS SA Associate Mock Exams/scripts", "Areas/Café Notes/Mock Exams", "Other"]) fs.mkdirSync(path.join(vault, d), { recursive: true });
  const world = fakeWorld();
  const views: FakeTerminalView[] = [];
  let active: string | null = "AWS SA Associate Mock Exams/scripts/estimate_time.py";
  const id = opts.id ?? "device-aaaa-1111";
  const r = { saves: 0 } as Rig;
  const data = opts.data ?? {};
  const host: TerminalHost = {
    document,
    window,
    vaultRoot: () => vault,
    activeFile: () => active,
    data: () => data,
    save: async () => {
      r.saves += 1;
    },
    shell: () => "/bin/zsh",
    runtimeDir: () => path.join(vault, ".server"),
    registry: new ChildRegistry(null),
    deviceStore: { get: () => id, set: () => undefined },
  };
  const feature = new TerminalFeature(host, {
    createTerminal: () => {
      const v = new FakeTerminalView();
      views.push(v);
      return v;
    },
    preflight: opts.preflight ?? (async () => GOOD),
    session: world.deps,
    baseEnv: { PATH: "/usr/bin" },
  });
  return Object.assign(r, { host, data, setActive: (p: string | null) => (active = p), views, world, feature, vault, id });
}

const cwdOf = (r: Rig, n = 0) => {
  const args = r.world.spawned[n].args;
  return args[args.indexOf("--cwd") + 1];
};

describe("the drawer with its shell (G12) and its state (G9)", () => {
  it("the first reveal creates one shell in the active file's folder (GP5)", async () => {
    const r = rig();
    r.feature.mount();
    expect(r.world.spawned).toHaveLength(0); // nothing starts until the first reveal
    strip().click();
    await tick();
    expect(r.world.spawned).toHaveLength(1);
    expect(cwdOf(r)).toBe(path.join(r.vault, "AWS SA Associate Mock Exams/scripts"));
    expect(r.world.spawned[0].command).toBe("/usr/bin/python3");
  });

  it("uses the vault root when there is no active file or the view has no file", async () => {
    const r = rig();
    r.setActive(null);
    r.feature.mount();
    strip().click();
    await tick();
    expect(cwdOf(r)).toBe(r.vault);
  });

  it("starts in a folder with spaces and non-ASCII characters (E5)", async () => {
    const r = rig();
    r.setActive("Areas/Café Notes/Mock Exams/estimaté.py");
    r.feature.mount();
    strip().click();
    await tick();
    expect(cwdOf(r)).toBe(path.join(r.vault, "Areas/Café Notes/Mock Exams"));
  });

  it("switching files, hiding and revealing keeps one live shell in the first folder", async () => {
    const r = rig();
    r.feature.mount();
    strip().click();
    await tick();
    r.setActive("Other/note.md");
    strip().click();
    strip().click();
    await tick();
    expect(r.world.spawned).toHaveLength(1);
    expect(r.world.signals).toEqual([]);
    expect(r.feature.shells.liveCount).toBe(1);
    expect(r.views).toHaveLength(1);
  });

  it("rapid double clicks leave one shell, in a consistent state", async () => {
    const r = rig();
    r.feature.mount();
    strip().click();
    strip().click();
    strip().click();
    strip().click();
    strip().click();
    await tick();
    expect(r.world.spawned).toHaveLength(1);
    expect(r.feature.drawer?.open).toBe(true);
    expect(root().classList.contains("vscw-open")).toBe(true);
  });

  it("sends typed text and resizes to the shell, and shell output to the terminal", async () => {
    const r = rig();
    r.feature.mount();
    strip().click();
    await tick();
    r.views[0].type("python3 estimate_time.py --help\r");
    r.views[0].setCells(111, 22);
    r.world.spawned[0].child.output("usage: estimate_time.py\r\n");
    await tick();
    expect(r.world.spawned[0].child.sent().toString("latin1")).toContain("python3 estimate_time.py --help");
    expect(r.views[0].text()).toContain("usage: estimate_time.py");
  });

  it("an exited shell shows an exited line and a restart; revealing again does not leave a dead terminal", async () => {
    const r = rig();
    r.feature.mount();
    strip().click();
    await tick();
    r.world.spawned[0].child.shellExit(0);
    await tick();
    expect(r.views[0].text()).toContain("The shell has exited (code 0).");
    expect((document.querySelector(".vscw-restart") as HTMLElement).textContent).toBe("Restart shell");
    strip().click(); // hide
    strip().click(); // reveal again
    await tick();
    expect(r.world.spawned).toHaveLength(2);
    expect(r.feature.shells.state).toEqual({ kind: "running" });
    expect((document.querySelector(".vscw-message") as HTMLElement).hidden).toBe(true);
  });

  it("the restart control starts a new shell after an exit", async () => {
    const r = rig();
    r.feature.mount();
    strip().click();
    await tick();
    r.world.spawned[0].child.shellExit(2);
    await tick();
    (document.querySelector(".vscw-restart") as HTMLElement).click();
    await tick();
    await tick();
    expect(r.world.spawned).toHaveLength(2);
  });

  it("a failed check shows the exact message in red, opens the drawer anyway, and the next reveal retries", async () => {
    let result: PreflightResult = { ok: false, kind: "python-missing", message: "python3 was not found on your PATH, so the terminal cannot start." };
    const r = rig({ preflight: async () => result });
    r.feature.mount();
    strip().click();
    await tick();
    expect(root().classList.contains("vscw-open")).toBe(true);
    const msg = document.querySelector(".vscw-message") as HTMLElement;
    expect(msg.classList.contains("vscw-error")).toBe(true);
    expect(msg.textContent).toContain("python3 was not found on your PATH, so the terminal cannot start.");
    expect(r.world.spawned).toHaveLength(0);

    strip().click(); // hide
    result = GOOD;
    strip().click(); // reveal: retries
    await tick();
    expect(r.world.spawned).toHaveLength(1);
    expect((document.querySelector(".vscw-message") as HTMLElement).hidden).toBe(true);
  });

  it("dispose (quit, disable the plugin) kills the shell and removes the drawer", async () => {
    const r = rig();
    r.feature.mount();
    strip().click();
    await tick();
    const pid = r.world.spawned[0].child.pid;
    const done = r.feature.dispose();
    expect(r.world.signals).toContainEqual([pid, "SIGTERM"]);
    await done;
    expect(root()).toBeNull();
    expect(r.feature.shells.liveCount).toBe(0);
  });

  it("closing the drawer does not kill the shell", async () => {
    const r = rig();
    r.feature.mount();
    strip().click();
    await tick();
    strip().click();
    expect(r.world.signals).toEqual([]);
    expect(r.feature.shells.liveCount).toBe(1);
  });

  describe("per-device state in data.json", () => {
    it("saves the open state and the dragged height under this device's id", async () => {
      const r = rig();
      r.feature.mount();
      strip().click();
      handle().dispatchEvent(pointer("pointerdown", { clientY: 600 }));
      window.dispatchEvent(pointer("pointermove", { clientY: 450 }));
      window.dispatchEvent(pointer("pointerup", { buttons: 0 }));
      expect(r.data[DRAWER_KEY]).toEqual({ [r.id]: { height: 450, open: true } });
      expect(r.saves).toBeGreaterThanOrEqual(2);
      strip().click();
      expect(r.data[DRAWER_KEY]).toEqual({ [r.id]: { height: 450, open: false } });
    });

    it("restores height and open state after the plugin is reloaded: the drawer comes back open with a fresh shell", async () => {
      const first = rig({ id: "device-aaaa-1111" });
      first.feature.mount();
      strip().click();
      handle().dispatchEvent(pointer("pointerdown", { clientY: 600 }));
      window.dispatchEvent(pointer("pointermove", { clientY: 500 }));
      window.dispatchEvent(pointer("pointerup", { buttons: 0 }));
      await first.feature.dispose();
      const saved = JSON.parse(JSON.stringify(first.data)); // what data.json holds

      const second = rig({ id: "device-aaaa-1111", data: saved, vault: first.vault });
      second.feature.mount();
      await tick();
      expect(second.feature.drawer?.open).toBe(true);
      expect(second.feature.drawer?.currentHeight).toBe(400);
      expect(root().classList.contains("vscw-open")).toBe(true);
      expect(second.world.spawned).toHaveLength(1);
    });

    it("a different device id keeps its own value and starts from the default", async () => {
      const a = rig({ id: "device-aaaa-1111" });
      a.feature.mount();
      strip().click();
      await a.feature.dispose();
      const saved = JSON.parse(JSON.stringify(a.data));

      const b = rig({ id: "device-bbbb-2222", data: saved, vault: a.vault });
      b.feature.mount();
      expect(b.feature.drawer?.open).toBe(false);
      expect(b.feature.drawer?.currentHeight).toBe(300);
      strip().click();
      expect(Object.keys(b.data[DRAWER_KEY] as object).sort()).toEqual(["device-aaaa-1111", "device-bbbb-2222"]);
      expect((b.data[DRAWER_KEY] as Record<string, { open: boolean }>)["device-aaaa-1111"].open).toBe(true);
    });

    it("clamps a saved height taller than the window on restore, and corrects the stored value (E14)", () => {
      setWindowHeight(600);
      const r = rig({ data: { [DRAWER_KEY]: { "device-aaaa-1111": { height: 4000, open: true } } } });
      r.feature.mount();
      expect(r.feature.drawer?.currentHeight).toBe(600 - HEADROOM);
      expect(px("--vscw-open-height")).toBe(600 - HEADROOM);
      expect(strip()).not.toBeNull();
      expect((r.data[DRAWER_KEY] as Record<string, { height: number }>)["device-aaaa-1111"].height).toBe(600 - HEADROOM);
      expect(r.saves).toBeGreaterThan(0);
    });

    it("a corrupt value in data.json falls back to the default height, closed", () => {
      const r = rig({ data: { [DRAWER_KEY]: "garbage" } });
      r.feature.mount();
      expect(r.feature.drawer?.open).toBe(false);
      expect(r.feature.drawer?.currentHeight).toBe(300);
    });

    it("a window shrunk while the drawer is open corrects the stored height too", () => {
      const r = rig();
      r.feature.mount();
      strip().click();
      handle().dispatchEvent(pointer("pointerdown", { clientY: 600 }));
      window.dispatchEvent(pointer("pointermove", { clientY: -100 }));
      window.dispatchEvent(pointer("pointerup", { buttons: 0 }));
      expect(r.feature.drawer?.currentHeight).toBe(900 - HEADROOM);
      setWindowHeight(500);
      window.dispatchEvent(new Event("resize"));
      expect((r.data[DRAWER_KEY] as Record<string, { height: number }>)[r.id].height).toBe(500 - HEADROOM);
    });
  });

  it("does not mount on a host with no page to draw on", () => {
    const r = rig();
    const bare = new TerminalFeature({ ...r.host, document: { body: {} } as unknown as Document });
    expect(() => bare.mount()).not.toThrow();
    expect(bare.drawer).toBeNull();
  });

  it("toggle() opens and closes the drawer (what the command and Ctrl+` do)", async () => {
    const r = rig();
    r.feature.mount();
    r.feature.toggle();
    await tick();
    expect(r.feature.drawer?.open).toBe(true);
    expect(r.world.spawned).toHaveLength(1);
    r.feature.toggle();
    expect(r.feature.drawer?.open).toBe(false);
    expect(root().classList.contains("vscw-open")).toBe(false);
  });

  it("passes a theme change on to the terminal", () => {
    const r = rig();
    r.feature.mount();
    strip().click();
    r.feature.themeChanged();
    expect(r.views[0].themes).toBe(1);
  });
});

// --- The command and its default hotkey --------------------------------------------------------

describe("the command (G8)", () => {
  let vault: string;
  let plugin: VSCodeWorkbenchPlugin | undefined;

  function makeApp(root: string): MockApp {
    const a: MockApp = {
      vault: {
        adapter: new FileSystemAdapter(root),
        configDir: ".obsidian",
        getAbstractFileByPath: (p: string) => (fs.existsSync(path.join(root, p)) ? new TFile(p) : null),
        on: (name: string, cb: (...args: any[]) => void) => ({ name, cb }),
      },
      workspace: {
        onLayoutReady: (cb: () => void) => cb(),
        activeFile: null,
        leaves: [],
        getActiveFile: () => a.workspace.activeFile,
        getLeavesOfType: () => [] as WorkspaceLeaf[],
        getLeaf: () => new WorkspaceLeaf(),
        revealLeaf: async () => undefined,
        detachLeavesOfType: () => undefined,
        on: (name, cb) => ({ name, cb }),
      },
    };
    return a;
  }

  beforeEach(() => {
    vault = tempDir();
    Plugin.reset();
    Notice.reset();
  });

  afterEach(async () => {
    plugin?.onunload();
    plugin = undefined;
    await tick();
  });

  async function load(): Promise<void> {
    const app = makeApp(vault);
    plugin = new VSCodeWorkbenchPlugin(app as never, { id: "obsidian-vscode-workbench", dir: ".obsidian/plugins/obsidian-vscode-workbench" } as never);
    (plugin as unknown as { pluginData: unknown }).pluginData = { serverLicenceAccepted: true };
    await plugin.onload();
  }

  it("registers 'Toggle terminal drawer' with Ctrl+` as its default hotkey", async () => {
    await load();
    const command = Plugin.commands.find((c) => c.id === "toggle-terminal-drawer") as unknown as { name: string; hotkeys: Array<{ modifiers: string[]; key: string }>; callback: () => void };
    expect(command).toBeDefined();
    expect(command.name).toBe("Toggle terminal drawer");
    expect(command.hotkeys).toEqual([{ modifiers: ["Ctrl"], key: "`" }]);
  });

  it("a strip is on the page whenever the plugin is enabled, and the command toggles the drawer", async () => {
    await load();
    expect(strip()).not.toBeNull(); // visible over a note with no Code tab open
    expect(root().classList.contains("vscw-open")).toBe(false);
    // Opening for real would start a real shell and a real xterm: that path is covered by the rig tests above.
    const toggle = vi.spyOn(TerminalFeature.prototype, "toggle").mockImplementation(() => undefined);
    const command = Plugin.commands.find((c) => c.id === "toggle-terminal-drawer") as unknown as { callback: () => void };
    command.callback();
    command.callback();
    expect(toggle).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });

  it("disabling the plugin takes the strip and the drawer off the page", async () => {
    await load();
    plugin?.onunload();
    expect(root()).toBeNull();
  });
});
