import { describe, expect, it } from "vitest";
import { LAYOUT_SCRIPT, PART_NAMES, isPainted, isPanelOnly, parseLayout, partShown, type PageLayout, type PartName } from "../../src/terminal-host/panel-only";

const WIN: [number, number] = [1000, 400];
function layout(shown: Partial<Record<PartName, [number, number] | null>>): PageLayout {
  const parts = Object.fromEntries(PART_NAMES.map((n) => [n, null])) as Record<PartName, [number, number] | null>;
  return { win: WIN, parts: { ...parts, ...shown } };
}

const FRESH = layout({ sidebar: [250, 400], editor: [750, 400], panel: [0, 0] });
const PANEL_ONLY = layout({ sidebar: [0, 0], editor: [0, 0], panel: [1000, 400] });

describe("parseLayout", () => {
  it("reads what the layout script prints", () => {
    const raw = JSON.stringify({ win: WIN, parts: { sidebar: [250, 400], panel: [0, 0] } });
    const l = parseLayout(raw);
    expect(l?.win).toEqual(WIN);
    expect(l?.parts.sidebar).toEqual([250, 400]);
    expect(l?.parts.editor).toBeNull();
  });

  it.each([["empty"], [""], ["not json"], ["null"], [JSON.stringify({ win: [1], parts: {} })], [JSON.stringify({ win: WIN })], [42], [undefined]])("answers null for %s", (raw) => {
    expect(parseLayout(raw)).toBeNull();
  });

  it("the script it parses reads all seven parts by their class, and only sizes", () => {
    for (const n of PART_NAMES) expect(LAYOUT_SCRIPT).toContain(n);
    expect(LAYOUT_SCRIPT).toContain("getBoundingClientRect");
    expect(LAYOUT_SCRIPT).not.toMatch(/localStorage|indexedDB|fetch|click\(|dispatchEvent/);
  });
});

describe("the layout decisions", () => {
  it("a page that has drawn nothing is not painted; one with any part is", () => {
    expect(isPainted(layout({}))).toBe(false);
    expect(isPainted(layout({ editor: [0, 0] }))).toBe(false);
    expect(isPainted(FRESH)).toBe(true);
  });

  it("panel-only means the panel fills the window and every other part is 0 px (F2)", () => {
    expect(isPanelOnly(PANEL_ONLY)).toBe(true);
    expect(isPanelOnly(layout({ panel: [1000, 400] }))).toBe(true); // parts that do not exist at all count as hidden
    expect(isPanelOnly(FRESH)).toBe(false);
    expect(isPanelOnly(layout({ editor: [10, 10], panel: [1000, 400] }))).toBe(false);
    expect(isPanelOnly(layout({ sidebar: [250, 400], panel: [750, 400] }))).toBe(false);
    expect(isPanelOnly(layout({ statusbar: [1000, 22], panel: [1000, 378] }))).toBe(false);
    expect(isPanelOnly(layout({ titlebar: [1000, 30], panel: [1000, 370] }))).toBe(false);
    expect(isPanelOnly(layout({ activitybar: [48, 400], panel: [952, 400] }))).toBe(false);
    expect(isPanelOnly(layout({ auxiliarybar: [200, 400], panel: [800, 400] }))).toBe(false);
    expect(isPanelOnly(layout({ panel: [0, 0] }))).toBe(false);
    expect(isPanelOnly(layout({}))).toBe(false);
  });

  it("tolerates a few pixels of border when comparing the panel with the window", () => {
    expect(isPanelOnly(layout({ panel: [992, 392] }))).toBe(true);
    expect(isPanelOnly(layout({ panel: [900, 400] }))).toBe(false);
  });

  it("partShown is a non-zero size", () => {
    expect(partShown(FRESH, "sidebar")).toBe(true);
    expect(partShown(FRESH, "panel")).toBe(false);
    expect(partShown(FRESH, "titlebar")).toBe(false);
  });
});
