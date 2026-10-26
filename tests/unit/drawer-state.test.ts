import { describe, expect, it } from "vitest";
import { DEFAULT_HEIGHT, HEADROOM } from "../../src/terminal/drawer-geometry";
import { DEVICE_ID_KEY, DRAWER_KEY, deviceId, readDrawerState, withDrawerState } from "../../src/terminal/drawer-state";

const WINDOW = 900;

describe("per-device drawer state in data.json (G9)", () => {
  it("defaults to the default height, closed, when nothing is stored", () => {
    expect(readDrawerState({}, "dev-a", WINDOW)).toEqual({ height: DEFAULT_HEIGHT, open: false });
    expect(readDrawerState(null, "dev-a", WINDOW)).toEqual({ height: DEFAULT_HEIGHT, open: false });
    expect(readDrawerState(undefined, "dev-a", WINDOW)).toEqual({ height: DEFAULT_HEIGHT, open: false });
  });

  it("round trips through the JSON that saveData writes", () => {
    const saved = withDrawerState({}, "dev-a", { height: 410, open: true });
    const reloaded = JSON.parse(JSON.stringify(saved));
    expect(readDrawerState(reloaded, "dev-a", WINDOW)).toEqual({ height: 410, open: true });
  });

  it("keeps each device's own value: another device id sees its own, or the default", () => {
    let data = withDrawerState({}, "dev-a", { height: 410, open: true });
    data = withDrawerState(data, "dev-b", { height: 200, open: false });
    expect(readDrawerState(data, "dev-a", WINDOW)).toEqual({ height: 410, open: true });
    expect(readDrawerState(data, "dev-b", WINDOW)).toEqual({ height: 200, open: false });
    expect(readDrawerState(data, "dev-c", WINDOW)).toEqual({ height: DEFAULT_HEIGHT, open: false });
  });

  it("writing one device leaves other keys of data.json and other devices alone, and does not modify its input", () => {
    const before = { instanceId: "x", [DRAWER_KEY]: { "dev-b": { height: 200, open: true } } };
    const snapshot = JSON.stringify(before);
    const after = withDrawerState(before, "dev-a", { height: 300, open: false });
    expect(JSON.stringify(before)).toBe(snapshot);
    expect(after.instanceId).toBe("x");
    expect((after[DRAWER_KEY] as Record<string, unknown>)["dev-b"]).toEqual({ height: 200, open: true });
  });

  it("replaces a corrupt drawer value when writing", () => {
    for (const bad of ["oops", 7, [1, 2], null]) {
      const after = withDrawerState({ [DRAWER_KEY]: bad }, "dev-a", { height: 300, open: true });
      expect(after[DRAWER_KEY]).toEqual({ "dev-a": { height: 300, open: true } });
    }
  });

  const corrupt: Array<[string, unknown]> = [
    ["a drawer value that is a string", { [DRAWER_KEY]: "wide" }],
    ["a drawer value that is an array", { [DRAWER_KEY]: [1, 2] }],
    ["a device entry that is a number", { [DRAWER_KEY]: { "dev-a": 5 } }],
    ["a height that is a string", { [DRAWER_KEY]: { "dev-a": { height: "300", open: true } } }],
    ["a height that is NaN (null in JSON)", { [DRAWER_KEY]: { "dev-a": { height: null, open: true } } }],
    ["a negative height", { [DRAWER_KEY]: { "dev-a": { height: -5, open: true } } }],
    ["a zero height", { [DRAWER_KEY]: { "dev-a": { height: 0, open: true } } }],
  ];
  it.each(corrupt)("falls back to the default height for %s", (_n, data) => {
    expect(readDrawerState(data, "dev-a", WINDOW).height).toBe(DEFAULT_HEIGHT);
  });

  it("treats an open value that is not exactly true as closed", () => {
    for (const open of ["true", 1, null, undefined]) {
      expect(readDrawerState({ [DRAWER_KEY]: { "dev-a": { height: 300, open } } }, "dev-a", WINDOW).open).toBe(false);
    }
  });

  it("clamps a stored height on restore (E14)", () => {
    const data = { [DRAWER_KEY]: { "dev-a": { height: 5000, open: true } } };
    expect(readDrawerState(data, "dev-a", 700)).toEqual({ height: 700 - HEADROOM, open: true });
    expect(readDrawerState({ [DRAWER_KEY]: { "dev-a": { height: 3, open: false } } }, "dev-a", 700).height).toBe(120);
  });

  it("does not read inherited properties as a device", () => {
    expect(readDrawerState({ [DRAWER_KEY]: {} }, "constructor", WINDOW)).toEqual({ height: DEFAULT_HEIGHT, open: false });
    expect(readDrawerState({ [DRAWER_KEY]: {} }, "toString", WINDOW).open).toBe(false);
  });

  it("stores a device named __proto__ as an ordinary key", () => {
    const data = withDrawerState({}, "__proto__", { height: 333, open: true });
    expect(readDrawerState(JSON.parse(JSON.stringify(data)), "__proto__", WINDOW)).toEqual({ height: 333, open: true });
    expect(({} as Record<string, unknown>).height).toBeUndefined();
  });
});

describe("the device id", () => {
  const memory = (initial: unknown) => {
    const store = { value: initial, sets: [] as string[], get: () => store.value, set: (id: string) => { store.value = id; store.sets.push(id); } };
    return store;
  };

  it("is made once and stored, then read back", () => {
    const store = memory(null);
    const first = deviceId(store, () => "generated-id-1");
    expect(first).toBe("generated-id-1");
    expect(store.sets).toEqual(["generated-id-1"]);
    expect(deviceId(store, () => "generated-id-2")).toBe("generated-id-1");
    expect(store.sets).toHaveLength(1);
  });

  it("replaces a stored value that is not a usable id", () => {
    for (const bad of ["", "short", "has spaces in it", "../../etc", 42, {}, "x".repeat(100)]) {
      const store = memory(bad);
      expect(deviceId(store, () => "fresh-device-id")).toBe("fresh-device-id");
    }
  });

  it("still returns an id when the store cannot save one", () => {
    const store = { get: () => null, set: () => { throw new Error("read-only"); } };
    expect(deviceId(store, () => "unsaved-device-id")).toBe("unsaved-device-id");
  });

  it("uses a real random id by default, and keeps its key out of data.json's drawer key", () => {
    const store = memory(undefined);
    expect(deviceId(store)).toMatch(/^[0-9a-f-]{36}$/);
    expect(DEVICE_ID_KEY).not.toBe(DRAWER_KEY);
  });
});
