// @vitest-environment jsdom
/**
 * The bottom edge on a jsdom page (G1, G3 and the drag edge cases): click versus drag, resize clamping through the real
 * TerminalDrawer, pointer capture release, one toggle per click, and a drag that ends without a release on the edge.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BottomEdge, CLICK_SLOP } from "../../src/terminal/bottom-edge";
import { DEFAULT_HEIGHT, HEADROOM, MIN_HEIGHT } from "../../src/terminal/drawer-geometry";
import { FocusReturn } from "../../src/terminal/focus-return";
import { TerminalDrawer, type DrawerHost } from "../../src/terminal/terminal-drawer";

function pointer(type: string, init: { x?: number; y?: number; button?: number; buttons?: number; id?: number } = {}): Event {
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: init.x ?? 0, clientY: init.y ?? 0, button: init.button ?? 0, buttons: init.buttons ?? 1 });
  Object.defineProperty(ev, "pointerId", { value: init.id ?? 1 });
  return ev;
}

/** jsdom has no pointer capture: record it. */
function captureSpy(el: HTMLElement) {
  const log = { set: [] as number[], released: [] as number[] };
  (el as unknown as { setPointerCapture: (id: number) => void }).setPointerCapture = (id) => log.set.push(id);
  (el as unknown as { releasePointerCapture: (id: number) => void }).releasePointerCapture = (id) => log.released.push(id);
  return log;
}

beforeEach(() => {
  document.body.className = "";
  document.body.removeAttribute("style");
  document.body.innerHTML = "";
});
afterEach(() => {
  document.body.innerHTML = "";
});

describe("the edge on its own", () => {
  let toggles = 0;
  let resizes: number[] = [];
  let ends = 0;
  let height = 0;
  let edge: BottomEdge;
  let cap: ReturnType<typeof captureSpy>;

  beforeEach(() => {
    toggles = 0;
    resizes = [];
    ends = 0;
    height = 300;
    edge = new BottomEdge({ document, window, heightNow: () => height, onToggle: () => toggles++, onResize: (h) => resizes.push(h), onResizeEnd: () => ends++ });
    edge.mount();
    cap = captureSpy(edge.element);
  });
  afterEach(() => edge.dispose());

  const down = (y = 500, extra = {}) => edge.element.dispatchEvent(pointer("pointerdown", { y, ...extra }));
  const move = (y: number, extra = {}) => window.dispatchEvent(pointer("pointermove", { y, ...extra }));
  const up = (y?: number) => window.dispatchEvent(pointer("pointerup", { y: y ?? 0, buttons: 0 }));

  it("has no label, icon or button of its own (F1)", () => {
    expect(edge.element.textContent).toBe("");
    expect(edge.element.children).toHaveLength(0);
    expect(edge.element.className).toBe("vscw-edge");
    expect(document.body.textContent).not.toMatch(/terminal/i);
  });

  it("a press and release in place is one toggle, on release, and captures then releases the pointer", () => {
    down();
    expect(toggles).toBe(0);
    expect(cap.set).toEqual([1]);
    up();
    expect(toggles).toBe(1);
    expect(cap.released).toEqual([1]);
    expect(resizes).toEqual([]);
    expect(ends).toBe(0);
  });

  it(`a press that moves up to ${CLICK_SLOP} px is still a click`, () => {
    down(500);
    move(500 - CLICK_SLOP);
    move(500 + CLICK_SLOP);
    up();
    expect(toggles).toBe(1);
    expect(resizes).toEqual([]);
  });

  it("a press that moves further is a resize and does not toggle on release, even back at the start", () => {
    down(500);
    move(500 - CLICK_SLOP - 1);
    move(380);
    move(500); // back where it began
    up();
    expect(toggles).toBe(0);
    expect(resizes).toEqual([300 + CLICK_SLOP + 1, 300 + 120, 300]);
    expect(ends).toBe(1);
  });

  it("dragging down shrinks and dragging up grows, from the height now", () => {
    height = 0; // a closed drawer grows from nothing
    down(500);
    move(450);
    expect(resizes).toEqual([50]);
    up();
    height = 300;
    down(500);
    move(560);
    expect(resizes.at(-1)).toBe(240);
    up();
  });

  it("ten clicks are ten toggles, one each", () => {
    for (let i = 0; i < 10; i++) {
      down();
      up();
    }
    expect(toggles).toBe(10);
  });

  it("the move and release listeners are gone after the release: later moves do nothing", () => {
    down(500);
    move(400);
    up();
    const n = resizes.length;
    move(300);
    up();
    expect(resizes).toHaveLength(n);
    expect(toggles).toBe(0);
  });

  it("a right or middle button press starts nothing", () => {
    down(500, { button: 2 });
    up();
    expect(toggles).toBe(0);
    expect(cap.set).toEqual([]);
  });

  it("while dragging the page is marked, and the mark and the selection go when it ends (release)", () => {
    const sel = vi.spyOn(window, "getSelection");
    down(500);
    move(400);
    expect(document.body.classList.contains("vscw-terminal-dragging")).toBe(true);
    expect(edge.element.classList.contains("vscw-dragging")).toBe(true);
    expect(edge.dragging).toBe(true);
    up();
    expect(document.body.classList.contains("vscw-terminal-dragging")).toBe(false);
    expect(edge.element.classList.contains("vscw-dragging")).toBe(false);
    expect(edge.dragging).toBe(false);
    expect(sel).toHaveBeenCalled();
    sel.mockRestore();
  });

  it("selecting text is blocked while dragging and allowed again after", () => {
    down(500);
    move(400);
    const during = new Event("selectstart", { cancelable: true });
    document.dispatchEvent(during);
    expect(during.defaultPrevented).toBe(true);
    up();
    const after = new Event("selectstart", { cancelable: true });
    document.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  it("a window blur ends a drag that moved cleanly: the final height is reported, no toggle", () => {
    down(500);
    move(400);
    window.dispatchEvent(new Event("blur"));
    expect(ends).toBe(1);
    expect(toggles).toBe(0);
    expect(document.body.classList.contains("vscw-terminal-dragging")).toBe(false);
    expect(cap.released).toEqual([1]);
  });

  it("a window blur during a press that has not moved is not a click", () => {
    down(500);
    window.dispatchEvent(new Event("blur"));
    up();
    expect(toggles).toBe(0);
    expect(document.body.classList.contains("vscw-terminal-dragging")).toBe(false);
  });

  it("a cancelled pointer and a lost capture end the drag without a toggle", () => {
    down(500);
    move(400);
    window.dispatchEvent(pointer("pointercancel"));
    expect(ends).toBe(1);
    down(500);
    edge.element.dispatchEvent(new Event("lostpointercapture"));
    expect(toggles).toBe(0);
    expect(edge.dragging).toBe(false);
  });

  it("released outside the window: the next move with no button held ends the drag, and the height is final", () => {
    down(500);
    move(380);
    move(300, { buttons: 0 }); // the release happened where this page never saw it
    expect(edge.dragging).toBe(false);
    expect(ends).toBe(1);
    expect(toggles).toBe(0);
    expect(resizes).toEqual([420]); // the buttonless move did not resize
    expect(document.body.classList.contains("vscw-terminal-dragging")).toBe(false);
  });

  it("hiding the edge mid-drag ends the drag without a toggle; disposing removes the element and its listeners", () => {
    down(500);
    move(400);
    edge.setHidden(true);
    expect(edge.dragging).toBe(false);
    expect(ends).toBe(1);
    expect(edge.element.hidden).toBe(true);
    edge.dispose();
    expect(document.querySelector(".vscw-edge")).toBeNull();
    window.dispatchEvent(pointer("pointermove", { y: 100 }));
    expect(resizes).toHaveLength(1);
  });
});

describe("the edge driving the real drawer (G1, G3, E9)", () => {
  let host: DrawerHost & { shows: number; hides: number; focuses: number };
  type FakeHost = typeof host;
  let saved: number[];
  let drawer: TerminalDrawer;
  let order: string[];

  const makeDrawer = (initialHeight = DEFAULT_HEIGHT) => {
    drawer = new TerminalDrawer({
      document,
      window,
      host: () => host,
      initialHeight,
      saveHeight: (h) => saved.push(h),
      viewKind: () => "code",
      nonCodeDrawer: () => true,
      focus: new FocusReturn<unknown>({ activeLeaf: () => null, isAlive: () => false, focusLeaf: () => undefined }),
    });
    drawer.mount();
  };
  const edgeEl = () => document.querySelector(".vscw-edge") as HTMLElement;
  const drag = (from: number, to: number) => {
    edgeEl().dispatchEvent(pointer("pointerdown", { y: from }));
    window.dispatchEvent(pointer("pointermove", { y: to }));
    window.dispatchEvent(pointer("pointerup", { y: to, buttons: 0 }));
  };
  const click = () => {
    edgeEl().dispatchEvent(pointer("pointerdown", { y: 800 }));
    window.dispatchEvent(pointer("pointerup", { y: 800, buttons: 0 }));
  };

  beforeEach(() => {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
    saved = [];
    order = [];
    host = {
      shows: 0,
      hides: 0,
      focuses: 0,
      show() { this.shows++; order.push("show"); },
      hide() { this.hides++; order.push("hide"); },
      focusTerminal() { this.focuses++; order.push("focus"); },
      view: () => "running",
    } as FakeHost;
  });
  afterEach(() => drawer.dispose());

  it("a click opens at the default height when none is saved, shows the host and focuses the terminal; a second click closes", () => {
    makeDrawer();
    click();
    expect(drawer.isOpen).toBe(true);
    expect(drawer.currentHeight).toBe(DEFAULT_HEIGHT);
    expect(document.body.style.getPropertyValue("--vscw-open-height")).toBe(`${DEFAULT_HEIGHT}px`);
    expect(order).toEqual(["show", "focus"]);
    click();
    expect(drawer.isOpen).toBe(false);
    expect(order).toEqual(["show", "focus", "hide"]);
    expect(document.body.style.getPropertyValue("--vscw-open-height")).toBe("0px");
    expect(host.shows).toBe(1);
  });

  it("a click opens at the saved height", () => {
    makeDrawer(450);
    click();
    expect(document.body.style.getPropertyValue("--vscw-open-height")).toBe("450px");
  });

  it("dragging up on a closed drawer opens it and sizes it; the height is saved once, at the end", () => {
    makeDrawer();
    drag(800, 500);
    expect(drawer.isOpen).toBe(true);
    expect(drawer.currentHeight).toBe(300);
    expect(saved).toEqual([300]);
    drag(800, 560); // 240 px up from the open height of 300
    expect(drawer.currentHeight).toBe(540);
    expect(saved).toEqual([300, 540]);
    expect(host.shows).toBe(1); // resizing never makes a second host page or re-shows
  });

  it("R1: focus moving into the host's webview blurs the window; that does not end a drag that opened the drawer", () => {
    makeDrawer();
    // The page has loaded, so focusTerminal() takes effect at once, and the webview taking focus blurs the window.
    host.focusTerminal = function () {
      this.focuses++;
      order.push("focus");
      window.dispatchEvent(new Event("blur"));
    };
    edgeEl().dispatchEvent(pointer("pointerdown", { y: 800 }));
    window.dispatchEvent(pointer("pointermove", { y: 780 })); // past the slope: opens the drawer
    expect(drawer.isOpen).toBe(true);
    expect(order).toEqual(["show"]); // no focus into the terminal while the pointer is down
    window.dispatchEvent(pointer("pointermove", { y: 500 }));
    expect(drawer.currentHeight).toBe(300); // still following the pointer
    window.dispatchEvent(pointer("pointermove", { y: 400 }));
    expect(drawer.currentHeight).toBe(400);
    expect(saved).toEqual([]);
    window.dispatchEvent(pointer("pointerup", { y: 400, buttons: 0 }));
    expect(saved).toEqual([400]);
    expect(order).toEqual(["show", "focus"]); // focus goes in once, at the end
    expect(host.hides).toBe(0);
  });

  it("R1: a drag on an already open drawer does not move focus into the terminal", () => {
    makeDrawer();
    click();
    order.length = 0;
    drag(800, 600);
    expect(order).toEqual([]);
  });

  it("R1: a drag that opened the drawer and ended by a window blur still hands focus to the terminal once", () => {
    makeDrawer();
    edgeEl().dispatchEvent(pointer("pointerdown", { y: 800 }));
    window.dispatchEvent(pointer("pointermove", { y: 600 }));
    window.dispatchEvent(new Event("blur")); // the user switched away
    expect(saved).toEqual([200]);
    expect(order).toEqual(["show", "focus"]);
  });

  it("dragging to the top stops at the window height minus the headroom; to the bottom stops at the minimum", () => {
    makeDrawer();
    drag(800, -2000);
    expect(drawer.currentHeight).toBe(900 - HEADROOM);
    drag(100, 5000);
    expect(drawer.currentHeight).toBe(MIN_HEIGHT);
    expect(saved.at(-1)).toBe(MIN_HEIGHT);
  });

  it("a drag does not toggle on release: an open drawer stays open", () => {
    makeDrawer();
    click();
    drag(600, 560);
    expect(drawer.isOpen).toBe(true);
    expect(host.hides).toBe(0);
  });

  it("ten clicks in a row end open after an odd count and closed after an even count, with one show per open", () => {
    makeDrawer();
    for (let i = 0; i < 10; i++) click();
    expect(drawer.isOpen).toBe(false);
    expect(host.shows).toBe(5);
    click();
    expect(drawer.isOpen).toBe(true);
  });

  it("E9: shrinking the window under an open drawer re-flows it to the new maximum and saves the correction", () => {
    makeDrawer(700);
    click();
    expect(drawer.currentHeight).toBe(700);
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 500 });
    window.dispatchEvent(new Event("resize"));
    expect(drawer.currentHeight).toBe(500 - HEADROOM);
    expect(document.body.style.getPropertyValue("--vscw-open-height")).toBe(`${500 - HEADROOM}px`);
    expect(saved.at(-1)).toBe(500 - HEADROOM);
  });

  it("E9: a saved height taller than the window is clamped when the drawer opens", () => {
    makeDrawer(2000);
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
    click();
    expect(drawer.currentHeight).toBe(600 - HEADROOM);
    expect(saved).toEqual([600 - HEADROOM]);
  });

  it("a drag released outside the window leaves the page clean and the height saved", () => {
    makeDrawer();
    edgeEl().dispatchEvent(pointer("pointerdown", { y: 800 }));
    window.dispatchEvent(pointer("pointermove", { y: 600 }));
    window.dispatchEvent(pointer("pointermove", { y: 400, buttons: 0 }));
    expect(document.body.classList.contains("vscw-terminal-dragging")).toBe(false);
    expect(saved).toEqual([200]);
    expect(drawer.isOpen).toBe(true);
  });

  it("dispose takes the edge and every page variable and class off the page", () => {
    makeDrawer();
    click();
    drawer.dispose();
    expect(document.querySelector(".vscw-edge")).toBeNull();
    expect(document.body.className).toBe("");
    expect(document.body.getAttribute("style") ?? "").not.toMatch(/vscw/);
  });
});
