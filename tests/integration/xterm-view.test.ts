// @vitest-environment jsdom
/**
 * The real xterm-backed terminal view in a DOM: it mounts, takes output, follows the theme,
 * lets the drawer's toggle key through, and cleans up. jsdom has no layout, canvas or
 * ResizeObserver, so those are stubbed; what is checked is our wiring, not xterm's drawing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createXtermView } from "../../src/terminal/xterm-view";

let observed: Array<{ cb: () => void; disconnected: boolean }>;

beforeEach(() => {
  observed = [];
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  window.matchMedia = (globalThis as unknown as { matchMedia: typeof window.matchMedia }).matchMedia;
  class RO {
    private rec = { cb: () => undefined as void, disconnected: false };
    constructor(cb: () => void) {
      this.rec.cb = cb;
      observed.push(this.rec);
    }
    observe() {}
    disconnect() {
      this.rec.disconnected = true;
    }
  }
  (window as unknown as { ResizeObserver: unknown }).ResizeObserver = RO;
  document.body.className = "theme-dark";
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return { host, view: createXtermView(host) };
}

describe("createXtermView", () => {
  it("opens an xterm inside the host and reports its cell grid", () => {
    const { host, view } = mount();
    expect(host.querySelector(".xterm")).not.toBeNull();
    const size = view.size();
    expect(size.cols).toBeGreaterThan(0);
    expect(size.rows).toBeGreaterThan(0);
    view.dispose();
  });

  it("takes text and byte output without throwing, and has a keyboard input to type into", () => {
    const { host, view } = mount();
    view.write("hello é 日本\r\n");
    view.write(new Uint8Array([0x68, 0x69]));
    const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();
    view.dispose();
  });

  it("lets Ctrl+` through to the drawer: it calls the toggle hook once and never reaches the shell", () => {
    const { host, view } = mount();
    const typed: string[] = [];
    const toggled: number[] = [];
    view.onInput((d) => typed.push(d));
    view.onToggleKey(() => toggled.push(1));
    const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
    const down = new KeyboardEvent("keydown", { key: "`", code: "Backquote", ctrlKey: true, bubbles: true, cancelable: true });
    textarea.dispatchEvent(down);
    textarea.dispatchEvent(new KeyboardEvent("keyup", { key: "`", code: "Backquote", ctrlKey: true, bubbles: true }));
    expect(toggled).toEqual([1]);
    expect(down.defaultPrevented).toBe(true);
    expect(typed).toEqual([]);
    view.dispose();
  });

  it("does not take other keys: a plain backquote or Ctrl+C is left to the terminal", () => {
    const { host, view } = mount();
    const toggled: number[] = [];
    view.onToggleKey(() => toggled.push(1));
    const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "`", code: "Backquote", bubbles: true, cancelable: true }));
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "c", code: "KeyC", ctrlKey: true, bubbles: true, cancelable: true }));
    expect(toggled).toEqual([]);
    view.dispose();
  });

  it("accepts a theme refresh in dark and light mode (the colours themselves are checked in terminal-theme.test.ts)", () => {
    document.body.style.setProperty("--background-primary", "#102030");
    const { view } = mount();
    expect(() => view.refreshTheme()).not.toThrow();
    document.body.className = "theme-light";
    document.body.style.setProperty("--background-primary", "#fafafa");
    expect(() => view.refreshTheme()).not.toThrow();
    view.dispose();
  });

  it("dispose stops watching the container and removes the terminal", () => {
    const { host, view } = mount();
    view.dispose();
    expect(observed.every((o) => o.disconnected)).toBe(true);
    expect(host.querySelector(".xterm")).toBeNull();
  });

  it("fit() on a container with no size does nothing instead of throwing", () => {
    const { view } = mount();
    expect(() => view.fit()).not.toThrow();
    view.dispose();
  });
});
