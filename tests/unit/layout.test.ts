// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LayoutController, NO_BOUNDS, computeBounds, type Bounds, type Rect } from "../../src/terminal/layout";

const rect = (left: number, width: number): Rect => ({ left, right: left + width, width });
const WINDOW = 1600;

// Fixed fixtures for a 1600px window: left sidebar 260, right sidebar 300.
const BOTH_SIDEBARS = rect(260, 1040);
const LEFT_COLLAPSED = rect(0, 1300);
const RIGHT_COLLAPSED = rect(260, 1340);
const NO_SIDEBARS = rect(0, 1600);

describe("computeBounds", () => {
  it("spans only the main pane area: the sidebars are excluded", () => {
    expect(computeBounds(BOTH_SIDEBARS, WINDOW, 300)).toEqual({ left: 260, width: 1040, offset: 300, statusLift: 0 });
  });

  it("a collapsed left sidebar widens it from the window's left edge", () => {
    expect(computeBounds(LEFT_COLLAPSED, WINDOW, 300)).toMatchObject({ left: 0, width: 1300 });
  });

  it("a collapsed right sidebar widens it to the window's right edge, and the status bar lifts over it", () => {
    expect(computeBounds(RIGHT_COLLAPSED, WINDOW, 300)).toEqual({ left: 260, width: 1340, offset: 300, statusLift: 300 });
  });

  it("with no sidebars it spans the window and lifts the status bar", () => {
    expect(computeBounds(NO_SIDEBARS, WINDOW, 250)).toEqual({ left: 0, width: 1600, offset: 250, statusLift: 250 });
  });

  it("the offset is the drawer's height and nothing else", () => {
    for (const h of [120, 301, 640]) expect(computeBounds(BOTH_SIDEBARS, WINDOW, h).offset).toBe(h);
  });

  it("closed (height 0), negative or not a number: no offset and no lift, with no gap left", () => {
    for (const h of [0, -50, Number.NaN, Number.POSITIVE_INFINITY]) {
      const b = computeBounds(RIGHT_COLLAPSED, WINDOW, h);
      expect(b.offset).toBe(0);
      expect(b.statusLift).toBe(0);
    }
  });

  it("with no main pane area on the page it spans the window", () => {
    expect(computeBounds(null, WINDOW, 300)).toEqual({ left: 0, width: 1600, offset: 300, statusLift: 300 });
  });

  it("rounds fractional pixels and never returns a negative edge or width", () => {
    expect(computeBounds(rect(260.4, 1039.6), WINDOW, 300)).toMatchObject({ left: 260, width: 1040 });
    expect(computeBounds({ left: -5, right: -5, width: -1 }, WINDOW, 300)).toMatchObject({ left: 0, width: 0 });
  });
});

describe("LayoutController", () => {
  let main: HTMLElement;
  let current: Rect;
  const changes: Bounds[] = [];
  const observers: Array<{ cb: () => void; observed: Set<Element> }> = [];

  class FakeResizeObserver {
    observed = new Set<Element>();
    constructor(public cb: () => void) {
      observers.push(this);
    }
    observe(e: Element) {
      this.observed.add(e);
    }
    unobserve(e: Element) {
      this.observed.delete(e);
    }
    disconnect() {
      this.observed.clear();
    }
    fire() {
      this.cb();
    }
  }

  function setWindowWidth(w: number) {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: w });
  }
  const px = (name: string) => document.body.style.getPropertyValue(name);

  const made: LayoutController[] = [];
  function make() {
    const layout = new LayoutController({ document, window, onChange: (b) => changes.push(b) });
    made.push(layout);
    return layout;
  }

  beforeEach(() => {
    document.body.removeAttribute("style");
    document.body.innerHTML = "";
    changes.length = 0;
    observers.length = 0;
    setWindowWidth(WINDOW);
    current = BOTH_SIDEBARS;
    main = document.createElement("div");
    main.className = "workspace-split mod-root";
    main.getBoundingClientRect = () => ({ ...current, top: 0, bottom: 800, height: 800, x: current.left, y: 0, toJSON: () => ({}) }) as DOMRect;
    document.body.appendChild(main);
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    (window as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
  });

  afterEach(() => {
    for (const l of made.splice(0)) l.dispose();
    delete (window as unknown as { ResizeObserver?: unknown }).ResizeObserver;
    vi.unstubAllGlobals();
  });

  it("writes the drawer's left edge and width from the main pane area when the drawer opens", () => {
    const layout = make();
    layout.setOpenHeight(300);
    expect(px("--vscw-left")).toBe("260px");
    expect(px("--vscw-width")).toBe("1040px");
    expect(px("--vscw-status-lift")).toBe("0px");
    expect(layout.bounds.offset).toBe(300);
  });

  it("collapsing a sidebar re-flows the width and tells the drawer to fit again", () => {
    const layout = make();
    layout.setOpenHeight(300);
    changes.length = 0;
    current = LEFT_COLLAPSED;
    observers[0].cb(); // the resize observer fires as the sidebar collapses
    expect(px("--vscw-left")).toBe("0px");
    expect(px("--vscw-width")).toBe("1300px");
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ left: 0, width: 1300 });
  });

  it("expanding it again restores the first bounds", () => {
    const layout = make();
    layout.setOpenHeight(300);
    current = LEFT_COLLAPSED;
    layout.refresh();
    current = BOTH_SIDEBARS;
    layout.refresh();
    expect(layout.bounds).toEqual({ left: 260, width: 1040, offset: 300, statusLift: 0 });
  });

  it("a window resize re-flows the width", () => {
    const layout = make();
    layout.setOpenHeight(300);
    changes.length = 0;
    setWindowWidth(1200);
    current = rect(260, 640);
    window.dispatchEvent(new Event("resize"));
    expect(px("--vscw-width")).toBe("640px");
    expect(changes).toHaveLength(1);
    expect(layout.bounds.width).toBe(640);
  });

  it("does not report a change when nothing moved", () => {
    const layout = make();
    layout.setOpenHeight(300);
    changes.length = 0;
    layout.refresh();
    layout.refresh();
    expect(changes).toHaveLength(0);
  });

  it("the status bar lift appears when the right sidebar collapses and goes when it opens", () => {
    const layout = make();
    layout.setOpenHeight(300);
    current = RIGHT_COLLAPSED;
    layout.refresh();
    expect(px("--vscw-status-lift")).toBe("300px");
    current = BOTH_SIDEBARS;
    layout.refresh();
    expect(px("--vscw-status-lift")).toBe("0px");
  });

  it("closing the drawer clears the offset and the lift completely, and keeps the last edges so the slide-down stays in place", () => {
    const layout = make();
    layout.setOpenHeight(300);
    current = RIGHT_COLLAPSED;
    layout.refresh();
    layout.setOpenHeight(0);
    expect(layout.bounds.offset).toBe(0);
    expect(layout.bounds.statusLift).toBe(0);
    expect(px("--vscw-status-lift")).toBe("0px");
    expect(layout.bounds.left).toBe(260);
    expect(layout.bounds.width).toBe(1340);
  });

  it("a closed drawer does not report layout changes (nothing to fit)", () => {
    const layout = make();
    layout.setOpenHeight(300);
    layout.setOpenHeight(0);
    changes.length = 0;
    current = LEFT_COLLAPSED;
    layout.refresh();
    expect(changes).toHaveLength(0);
  });

  it("dispose removes every variable and stops listening", () => {
    const layout = make();
    layout.setOpenHeight(300);
    layout.dispose();
    for (const v of ["--vscw-left", "--vscw-width", "--vscw-status-lift"]) expect(px(v)).toBe("");
    current = LEFT_COLLAPSED;
    window.dispatchEvent(new Event("resize"));
    expect(px("--vscw-width")).toBe("");
    expect(observers[0].observed.size).toBe(0);
  });

  it("watches the main pane area and both sidebars, and follows a main pane area that is replaced", () => {
    const left = document.createElement("div");
    left.className = "workspace-split mod-left-split";
    document.body.appendChild(left);
    const layout = make();
    layout.setOpenHeight(300);
    expect(observers[0].observed.has(main)).toBe(true);
    expect(observers[0].observed.has(left)).toBe(true);
    const replacement = document.createElement("div");
    replacement.className = "workspace-split mod-root";
    replacement.getBoundingClientRect = main.getBoundingClientRect;
    main.replaceWith(replacement);
    layout.refresh();
    expect(observers[0].observed.has(replacement)).toBe(true);
    expect(observers[0].observed.has(main)).toBe(false);
  });

  it("works where there is no ResizeObserver", () => {
    delete (window as unknown as { ResizeObserver?: unknown }).ResizeObserver;
    vi.unstubAllGlobals();
    const layout = make();
    layout.setOpenHeight(300);
    expect(px("--vscw-width")).toBe("1040px");
  });

  it("NO_BOUNDS is all zero", () => {
    expect(NO_BOUNDS).toEqual({ left: 0, width: 0, offset: 0, statusLift: 0 });
  });
});
