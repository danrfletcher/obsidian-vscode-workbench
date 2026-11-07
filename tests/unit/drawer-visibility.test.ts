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

describe("drawerVisibility (G6)", () => {
  const kinds: ViewKind[] = ["code", "markdown", "canvas", "graph", "pdf", "other"];

  // view kind × non-code setting × drawer open → edge, drawer, hotkey. The hotkey is true in every row (0.1.0 made it follow the setting).
  const table: Array<[ViewKind, boolean, boolean, boolean, boolean, boolean]> = [];
  for (const kind of kinds) {
    for (const setting of [true, false]) {
      for (const open of [true, false]) {
        table.push([kind, setting, open, kind === "code" || setting, open, true]);
      }
    }
  }
  it("covers every view kind by setting by open state", () => expect(table).toHaveLength(24));

  it.each(table)("%s, setting %s, drawer open %s → edge %s, drawer %s, hotkey %s", (kind, nonCodeDrawer, drawerOpen, edge, drawer, hotkey) => {
    expect(drawerVisibility({ kind, nonCodeDrawer, drawerOpen })).toEqual({ edge, drawer, hotkey });
  });

  it("with the setting on, notes, canvas, graph and PDF have the edge, like a Code tab", () => {
    for (const kind of ["markdown", "canvas", "graph", "pdf", "other", "code"] as const) {
      expect(drawerVisibility({ kind, nonCodeDrawer: true, drawerOpen: false }).edge).toBe(true);
    }
  });

  it("with the setting off, the four non-code views lose the edge identically; an open drawer and the hotkey stay", () => {
    for (const kind of ["markdown", "canvas", "graph", "pdf", "other"] as const) {
      expect(drawerVisibility({ kind, nonCodeDrawer: false, drawerOpen: true })).toEqual({ edge: false, drawer: true, hotkey: true });
      expect(drawerVisibility({ kind, nonCodeDrawer: false, drawerOpen: false })).toEqual({ edge: false, drawer: false, hotkey: true });
    }
  });

  it("a Code tab always has the edge, whatever the setting", () => {
    for (const nonCodeDrawer of [true, false]) expect(drawerVisibility({ kind: "code", nonCodeDrawer, drawerOpen: false }).edge).toBe(true);
  });

  it("going off and back on over a note gives the same result as before, because the open state is an input and never changed", () => {
    const before = drawerVisibility({ kind: "markdown", nonCodeDrawer: true, drawerOpen: true });
    drawerVisibility({ kind: "markdown", nonCodeDrawer: false, drawerOpen: true });
    expect(drawerVisibility({ kind: "markdown", nonCodeDrawer: true, drawerOpen: true })).toEqual(before);
  });
});
