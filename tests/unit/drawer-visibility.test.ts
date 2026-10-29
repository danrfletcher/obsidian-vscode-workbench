import { describe, expect, it } from "vitest";
import { drawerVisibility, viewKind, type ViewKind } from "../../src/terminal/drawer-visibility";

const CODE = "vscode-workbench-code";

describe("viewKind", () => {
  it.each([
    ["markdown", "markdown"],
    ["canvas", "canvas"],
    ["graph", "graph"],
    ["pdf", "pdf"],
    [CODE, "code"],
    ["empty", "other"],
    ["bases", "other"],
    ["image", "other"],
    ["", "other"],
  ])("%s is %s", (type, kind) => {
    expect(viewKind(type, CODE)).toBe(kind);
  });

  it("an unknown or missing type is 'other'", () => {
    expect(viewKind(undefined, CODE)).toBe("other");
    expect(viewKind(null, CODE)).toBe("other");
  });
});

describe("drawerVisibility", () => {
  const kinds: ViewKind[] = ["markdown", "canvas", "graph", "pdf", "other", "code"];

  // view kind × non-code setting × drawer open → strip, drawer, hotkey
  const table: Array<[ViewKind, boolean, boolean, boolean, boolean, boolean]> = [];
  for (const kind of kinds) {
    for (const toggle of [true, false]) {
      for (const open of [true, false]) {
        const available = kind === "code" || toggle;
        table.push([kind, toggle, open, available, available && open, available]);
      }
    }
  }

  it.each(table)("%s, setting %s, drawer open %s → strip %s, drawer %s, hotkey %s", (kind, nonCodeDrawer, drawerOpen, strip, drawer, hotkey) => {
    expect(drawerVisibility({ kind, nonCodeDrawer, drawerOpen })).toEqual({ strip, drawer, hotkey });
  });

  it("G11: with the setting on, notes, canvas, graph and PDF show the strip and the open drawer, like a Code tab", () => {
    for (const kind of ["markdown", "canvas", "graph", "pdf"] as const) {
      expect(drawerVisibility({ kind, nonCodeDrawer: true, drawerOpen: true })).toEqual({ strip: true, drawer: true, hotkey: true });
    }
  });

  it("G11: with the setting off, notes, canvas, graph and PDF lose the strip, the drawer and the hotkey, identically", () => {
    const results = (["markdown", "canvas", "graph", "pdf"] as const).map((kind) => drawerVisibility({ kind, nonCodeDrawer: false, drawerOpen: true }));
    for (const r of results) expect(r).toEqual({ strip: false, drawer: false, hotkey: false });
  });

  it("G11: a Code tab always has them, whatever the setting", () => {
    for (const nonCodeDrawer of [true, false]) {
      expect(drawerVisibility({ kind: "code", nonCodeDrawer, drawerOpen: true })).toEqual({ strip: true, drawer: true, hotkey: true });
      expect(drawerVisibility({ kind: "code", nonCodeDrawer, drawerOpen: false })).toEqual({ strip: true, drawer: false, hotkey: true });
    }
  });

  it("GP6: going off and back on over a note gives the same result as before, because the open state is an input and never changed", () => {
    const before = drawerVisibility({ kind: "markdown", nonCodeDrawer: true, drawerOpen: true });
    drawerVisibility({ kind: "markdown", nonCodeDrawer: false, drawerOpen: true });
    expect(drawerVisibility({ kind: "markdown", nonCodeDrawer: true, drawerOpen: true })).toEqual(before);
  });
});
