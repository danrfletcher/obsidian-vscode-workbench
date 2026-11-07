import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_HEIGHT, HEADROOM } from "../../src/terminal/drawer-geometry";
import { DRAWER_KEY } from "../../src/terminal/drawer-state";
import { HeightStore, SAVE_DEBOUNCE_MS } from "../../src/terminal/height-store";

let data: Record<string, unknown>;
let saves: string[];
let windowHeight: number;
const store = () => new HeightStore({ data: () => data, save: async () => void saves.push(JSON.stringify(data)), deviceId: "dev-a", windowHeight: () => windowHeight });

beforeEach(() => {
  vi.useFakeTimers();
  data = {};
  saves = [];
  windowHeight = 900;
});
afterEach(() => vi.useRealTimers());

describe("the saved drawer height (G3)", () => {
  it("reads the default when nothing is saved, and the saved height after a write, per device", () => {
    const s = store();
    expect(s.read()).toBe(DEFAULT_HEIGHT);
    s.write(410);
    expect(s.read()).toBe(410);
    expect((data[DRAWER_KEY] as Record<string, unknown>)["dev-a"]).toEqual({ height: 410 });
    expect(new HeightStore({ data: () => data, save: async () => undefined, deviceId: "dev-b", windowHeight: () => windowHeight }).read()).toBe(DEFAULT_HEIGHT);
  });

  it("many writes in a drag make one file write, after the last, holding the last height", () => {
    const s = store();
    for (const h of [200, 250, 300, 350]) s.write(h);
    expect(saves).toEqual([]);
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS - 1);
    expect(saves).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(saves).toHaveLength(1);
    expect(JSON.parse(saves[0])[DRAWER_KEY]["dev-a"]).toEqual({ height: 350 });
  });

  it("flush writes a waiting save at once, and only once", () => {
    const s = store();
    s.write(300);
    s.flush();
    s.flush();
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS * 2);
    expect(saves).toHaveLength(1);
  });

  it("the open state is never written, and a saved open flag is not read back", () => {
    data = { [DRAWER_KEY]: { "dev-a": { height: 333, open: true } } };
    const s = store();
    expect(s.read()).toBe(333);
    s.write(340);
    expect(JSON.stringify(data[DRAWER_KEY])).not.toContain("open");
  });

  it("a height taller than the window is clamped on read (E9)", () => {
    store().write(2000);
    windowHeight = 600;
    expect(store().read()).toBe(600 - HEADROOM);
  });

  it("a failing file write is contained", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const s = new HeightStore({ data: () => data, save: () => Promise.reject(new Error("disk full")), deviceId: "dev-a", windowHeight: () => 900 });
    s.write(300);
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
    await vi.advanceTimersByTimeAsync(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
