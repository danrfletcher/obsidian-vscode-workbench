import { describe, expect, it } from "vitest";
import { OpenFiles } from "../../src/open-file";
import { TabRegistry } from "../../src/tab-registry";
import { opensInCodeTab } from "../../src/text-file-rules";

/** A stand-in tab: just an identity with a saved view state, as a Code leaf has. */
interface Leaf {
  name: string;
  file: string;
  getViewState(): { type: string; state: { file: string } };
}
const leaf = (name: string, file: string): Leaf => ({ name, file, getViewState: () => ({ type: "vscode-workbench-code", state: { file } }) });

function setup(...files: Array<[string, string]>) {
  const leaves = files.map(([name, file]) => leaf(name, file));
  const open = new OpenFiles<Leaf>(() => []);
  for (const l of leaves) expect(open.claim(l.file, l)).toBeNull();
  const registry = new TabRegistry<Leaf>(open);
  return { leaves, open, registry };
}
const eligible = (p: string) => opensInCodeTab(p);
const claimed = (open: OpenFiles<Leaf>) => open.entries().map((c) => [c.path, c.leaf.name]);

describe("TabRegistry: rename and move", () => {
  it("a rename moves the claim to the new path, for the same tab", () => {
    const { registry, open, leaves } = setup(["A", "scripts/a b.py"]);
    const out = registry.rename("scripts/a b.py", "scripts/ünï.ts", eligible);
    expect(out.follow).toEqual([{ leaf: leaves[0], from: "scripts/a b.py", to: "scripts/ünï.ts" }]);
    expect(out.ineligible).toEqual([]);
    expect(claimed(open)).toEqual([["scripts/ünï.ts", "A"]]);
    expect(registry.tabAt("scripts/a b.py")).toBeUndefined();
    expect(registry.tabAt("scripts/ünï.ts")).toBe(leaves[0]);
  });

  it("a move to another folder is the same thing", () => {
    const { registry, open } = setup(["A", "src/main.py"]);
    registry.rename("src/main.py", "lib/deep/main.py", eligible);
    expect(claimed(open)).toEqual([["lib/deep/main.py", "A"]]);
  });

  it("one tab per file survives: after a rename, opening the new path finds the same tab, and the old path is free", () => {
    const { registry, open, leaves } = setup(["A", "a.py"]);
    registry.rename("a.py", "b.py", eligible);
    const stranger = leaf("B", "b.py");
    expect(open.claim("b.py", stranger)).toBe(leaves[0]); // the existing tab is the one to focus
    const other = leaf("C", "a.py");
    expect(open.claim("a.py", other)).toBeNull();
  });

  it("finds the tab however the name is spelled (macOS decomposes é, typed names compose it)", () => {
    const nfd = "scripts/ünï.ts".normalize("NFD");
    const { registry, leaves } = setup(["A", nfd]);
    const out = registry.rename("scripts/ünï.ts".normalize("NFC"), "scripts/plain.ts", eligible);
    expect(out.follow.map((m) => m.leaf)).toEqual([leaves[0]]);
  });

  it("a renamed folder moves every tab under it, and nothing outside it or with a similar prefix", () => {
    const { registry, open } = setup(["A", "proj/a.py"], ["B", "proj/sub/b.ts"], ["C", "project/c.py"], ["D", "other/d.py"], ["E", "Makefile"]);
    const out = registry.rename("proj", "renamed", eligible);
    expect(out.follow.map((m) => [m.from, m.to])).toEqual([
      ["proj/a.py", "renamed/a.py"],
      ["proj/sub/b.ts", "renamed/sub/b.ts"],
    ]);
    expect(claimed(open).sort()).toEqual([["Makefile", "E"], ["other/d.py", "D"], ["project/c.py", "C"], ["renamed/a.py", "A"], ["renamed/sub/b.ts", "B"]]);
  });

  it("an extensionless file stays eligible when renamed", () => {
    const { registry, open } = setup(["M", "Makefile"]);
    registry.rename("Makefile", "build/Makefile", eligible);
    expect(claimed(open)).toEqual([["build/Makefile", "M"]]);
  });

  it.each([
    ["a new name ending .md", "notes.md"],
    ["a canvas", "board.canvas"],
    ["a base", "table.base"],
    ["a binary extension", "image.png"],
    ["a hidden folder", ".git/hooks/a.py"],
  ])("%s: the tab is not handed the file; its claim is released and it is reported for closing (F6)", (_n, to) => {
    const { registry, open, leaves } = setup(["A", "a.py"]);
    const out = registry.rename("a.py", to, eligible);
    expect(out.follow).toEqual([]);
    expect(out.ineligible).toEqual([{ leaf: leaves[0], from: "a.py", to }]);
    expect(claimed(open)).toEqual([]);
    expect(registry.tabAt(to)).toBeUndefined();
  });

  it("an excluded extension is not eligible either", () => {
    const { registry } = setup(["A", "a.py"]);
    const out = registry.rename("a.py", "a.log", (p) => opensInCodeTab(p, ["log"]));
    expect(out.ineligible).toHaveLength(1);
  });

  it("a rename onto a path another tab already holds does not give one file two tabs", () => {
    const { registry, open, leaves } = setup(["A", "a.py"], ["B", "b.py"]);
    const out = registry.rename("a.py", "b.py", eligible);
    expect(out.follow).toEqual([]);
    expect(out.duplicate).toEqual([{ leaf: leaves[0], from: "a.py", to: "b.py" }]);
    expect(claimed(open)).toEqual([["b.py", "B"]]);
  });

  it("a rename of a file no tab shows changes nothing", () => {
    const { registry, open } = setup(["A", "a.py"]);
    expect(registry.rename("zzz.py", "yyy.py", eligible)).toEqual({ follow: [], ineligible: [], duplicate: [] });
    expect(claimed(open)).toEqual([["a.py", "A"]]);
  });

  it("ten renames in a row leave one claim, on the final path", () => {
    const { registry, open, leaves } = setup(["A", "f0.py"]);
    for (let i = 0; i < 10; i++) registry.rename(`f${i}.py`, `f${i + 1}.py`, eligible);
    expect(claimed(open)).toEqual([["f10.py", "A"]]);
    expect(registry.tabAt("f10.py")).toBe(leaves[0]);
    for (let i = 0; i < 10; i++) expect(registry.tabAt(`f${i}.py`)).toBeUndefined();
  });
});

describe("TabRegistry: delete", () => {
  it("releases the claim of a deleted file, so the path can be opened again in a new tab", () => {
    const { registry, open, leaves } = setup(["A", "a.py"], ["B", "b.py"]);
    expect(registry.remove("a.py")).toEqual([{ path: "a.py", leaf: leaves[0] }]);
    expect(claimed(open)).toEqual([["b.py", "B"]]);
    expect(open.claim("a.py", leaf("N", "a.py"))).toBeNull();
  });

  it("a deleted folder releases everything under it", () => {
    const { registry, open } = setup(["A", "d/a.py"], ["B", "d/e/b.py"], ["C", "dd/c.py"]);
    expect(registry.remove("d").map((c) => c.path)).toEqual(["d/a.py", "d/e/b.py"]);
    expect(claimed(open)).toEqual([["dd/c.py", "C"]]);
  });

  it("deleting a file no tab shows does nothing", () => {
    const { registry, open } = setup(["A", "a.py"]);
    expect(registry.remove("nope.py")).toEqual([]);
    expect(claimed(open)).toEqual([["a.py", "A"]]);
  });
});

describe("OpenFiles.move", () => {
  it("refuses a tab that does not hold the path, and a target held by another tab", () => {
    const { open, leaves } = setup(["A", "a.py"], ["B", "b.py"]);
    expect(open.move("a.py", "c.py", leaves[1])).toBe(false);
    expect(open.move("a.py", "b.py", leaves[0])).toBe(false);
    expect(claimed(open)).toEqual([["a.py", "A"], ["b.py", "B"]]);
  });

  it("a case-only or normalisation-only change keeps the claim, with the new spelling", () => {
    const { open, leaves } = setup(["A", "a.py"]);
    expect(open.move("a.py", "A.py", leaves[0])).toBe(true);
    expect(claimed(open)).toEqual([["A.py", "A"]]);
  });
});
