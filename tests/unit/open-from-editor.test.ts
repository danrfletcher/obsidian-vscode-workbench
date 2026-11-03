/**
 * The rule for a file opened from inside a Code tab's editor (PR-4: E2, E3), table-driven, with a temp vault on disk and fake
 * leaves in `OpenFiles`. No Obsidian objects: the plugin's side of it is tests/integration/one-tab-per-file.test.ts.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkFile } from "../../src/binary-guard";
import { OBSIDIAN_VIEW_EXTENSIONS, openCodeTabOnce, openFromEditor, planEditorOpen, type EditorOpenDeps } from "../../src/open-from-editor";
import { OpenFiles } from "../../src/open-file";
import { buildFileUri, targetOfUri } from "../../src/paths";
import { tempDir } from "../helpers";

const AUTH = "127.0.0.1:5555";
const BASE = `http://${AUTH}`;

/** A vault with the fixtures the spec names: `pd.js`, an imported helper, a note, a PNG, and a file outside it. */
function fixtures() {
  const root = path.join(tempDir(), "My Vault");
  const outside = path.join(tempDir(), "elsewhere");
  const put = (rel: string, content: Buffer | string = "x\n") => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
    return rel;
  };
  put("t/pd.js", "import { helper } from './helper.js';\nhelper(1);\n");
  put("t/helper.js", "// helper\n\n\n\nexport function helper(n) {\n  return n + 1;\n}\n");
  put("Notes/daily note.md", "# note\n");
  put("Board.canvas", "{}");
  put("Tasks.base", "views: []\n");
  put("img/shot.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  put("docs/paper.pdf", Buffer.from("%PDF-1.4\n"));
  put("bin/tool.zip", Buffer.from([0x50, 0x4b, 3, 4, 0, 0]));
  put("data/huge.json", Buffer.alloc(2 * 1024 * 1024 + 10, "a"));
  put(".obsidian/app.json", "{}");
  put(".git/config", "[core]\n");
  put("node_modules/lib/index.js", "module.exports = 1;\n");
  put("Makefile", "all:\n");
  put("src/ünï 文件 🚀.ts", "export {};\n");
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "lib.d.ts"), "declare const x: number;\n");
  const uri = (abs: string) => buildFileUri(BASE, abs);
  const targetOfVault = (rel: string) => targetOfUri(uri(path.join(root, rel)), AUTH, root);
  return { root, outside, targetOfVault, targetOfAbs: (abs: string) => targetOfUri(uri(abs), AUTH, root) };
}

describe("planEditorOpen: where each kind of target goes (E2)", () => {
  let v: ReturnType<typeof fixtures>;
  beforeEach(() => void (v = fixtures())); // a fresh vault per test: the shared helper removes temp dirs after each one
  const code = (file: string) => ({ action: "code", file });
  const obsidian = (file: string) => ({ action: "obsidian", file });

  it.each([
    ["a code file", "t/helper.js", code("t/helper.js")],
    ["a code file with spaces, accents, CJK and emoji", "src/ünï 文件 🚀.ts", code("src/ünï 文件 🚀.ts")],
    ["an extensionless file", "Makefile", code("Makefile")],
    ["a note", "Notes/daily note.md", obsidian("Notes/daily note.md")],
    ["a canvas", "Board.canvas", obsidian("Board.canvas")],
    ["a base", "Tasks.base", obsidian("Tasks.base")],
    ["an image", "img/shot.png", obsidian("img/shot.png")],
    ["a PDF", "docs/paper.pdf", obsidian("docs/paper.pdf")],
    ["a binary Obsidian has no view for", "bin/tool.zip", code("bin/tool.zip")], // the Code tab path refuses it (below)
    ["an over-2 MB file", "data/huge.json", code("data/huge.json")], // the Code tab path refuses it (below)
    ["a file inside .obsidian", ".obsidian/app.json", code(".obsidian/app.json")], // the Code tab path refuses it
    ["a file inside .git", ".git/config", code(".git/config")],
    ["a file inside node_modules", "node_modules/lib/index.js", code("node_modules/lib/index.js")],
  ])("%s", (_name, rel, expected) => {
    expect(planEditorOpen(v.targetOfVault(rel))).toEqual(expected);
  });

  it("a file outside the vault (an absolute path elsewhere) only gets a notice, by the name of the file", () => {
    expect(planEditorOpen(v.targetOfAbs(path.join(v.outside, "lib.d.ts")))).toEqual({ action: "outside", name: "lib.d.ts" });
  });

  it("a path above the vault root is outside, not a vault file", () => {
    expect(planEditorOpen(v.targetOfAbs(path.join(v.root, "..", "elsewhere", "lib.d.ts")))).toEqual({ action: "outside", name: "lib.d.ts" });
  });

  it("a node_modules type definition outside the vault is outside, not refused as a hidden folder", () => {
    expect(planEditorOpen(v.targetOfAbs("/usr/lib/node_modules/typescript/lib/lib.d.ts"))).toEqual({ action: "outside", name: "lib.d.ts" });
  });

  it("a target that is not a file of this server is ignored: the tab leaves it as VS Code opened it", () => {
    expect(planEditorOpen({ kind: "other" })).toEqual({ action: "ignore" });
  });

  it("an extension the user left to another plugin opens the way Obsidian opens it", () => {
    expect(planEditorOpen(v.targetOfVault("t/helper.js"), ["js"])).toEqual(obsidian("t/helper.js"));
  });

  it("the Obsidian-view extensions are all kinds the Code tab would refuse as binaries or never open (no code file is taken from the Code tab)", () => {
    for (const ext of OBSIDIAN_VIEW_EXTENSIONS) {
      const plan = planEditorOpen({ kind: "vault", file: `f.${ext}` });
      expect(plan.action, ext).toBe("obsidian");
    }
  });

  it("the refusals the plan hands to the Code tab path are the existing ones: the guard refuses the binary and the oversize file, and the hidden folders are never opened", async () => {
    expect(await checkFile(path.join(v.root, "bin/tool.zip"))).toMatchObject({ ok: false });
    expect(await checkFile(path.join(v.root, "data/huge.json"))).toMatchObject({ ok: false });
    expect(await checkFile(path.join(v.root, "t/helper.js"))).toMatchObject({ ok: true });
    expect(await checkFile(path.join(v.root, "Makefile"))).toMatchObject({ ok: true });
  });
});

describe("openFromEditor: what is done (E2)", () => {
  let v: ReturnType<typeof fixtures>;
  beforeEach(() => void (v = fixtures()));
  function deps(over: Partial<EditorOpenDeps> = {}) {
    const calls: string[] = [];
    const d: EditorOpenDeps = {
      excluded: () => [],
      openCode: vi.fn(async (file: string, line: number | null) => void calls.push(`code ${file} ${line}`)),
      openInObsidian: vi.fn(async (file: string) => void calls.push(`obsidian ${file}`)),
      notify: vi.fn((m: string) => void calls.push(`notice ${m}`)),
      ...over,
    };
    return { d, calls };
  }

  it("a code file opens as a Code tab at the line", async () => {
    const { d, calls } = deps();
    expect(await openFromEditor(v.targetOfVault("t/helper.js"), 5, d)).toBe("code");
    expect(calls).toEqual(["code t/helper.js 5"]);
  });

  it("a code file with no line known opens with the cursor left alone", async () => {
    const { d, calls } = deps();
    await openFromEditor(v.targetOfVault("t/helper.js"), null, d);
    expect(calls).toEqual(["code t/helper.js null"]);
  });

  it.each(["Notes/daily note.md", "Board.canvas", "Tasks.base", "img/shot.png", "docs/paper.pdf"])("%s opens the way Obsidian opens it, and no Code tab is asked for", async (rel) => {
    const { d, calls } = deps();
    expect(await openFromEditor(v.targetOfVault(rel), 12, d)).toBe("obsidian");
    expect(calls).toEqual([`obsidian ${rel}`]);
    expect(d.openCode).not.toHaveBeenCalled();
  });

  it("a file outside the vault opens nothing and the notice names it", async () => {
    const { d, calls } = deps();
    expect(await openFromEditor(v.targetOfAbs(path.join(v.outside, "lib.d.ts")), 3, d)).toBe("outside");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("lib.d.ts");
    expect(calls[0]).toContain("outside this vault");
    expect(d.openCode).not.toHaveBeenCalled();
    expect(d.openInObsidian).not.toHaveBeenCalled();
  });

  it("something that is not a file of this server does nothing at all", async () => {
    const { d, calls } = deps();
    expect(await openFromEditor({ kind: "other" }, 1, d)).toBe("ignore");
    expect(calls).toEqual([]);
  });

  it("reads the excluded extensions at the time of the open", async () => {
    let excluded: string[] = [];
    const { d, calls } = deps({ excluded: () => excluded });
    await openFromEditor(v.targetOfVault("t/helper.js"), 1, d);
    excluded = ["js"];
    await openFromEditor(v.targetOfVault("t/helper.js"), 1, d);
    expect(calls).toEqual(["code t/helper.js 1", "obsidian t/helper.js"]);
  });
});

describe("openCodeTabOnce: a target that is already open (E3), with fake leaves", () => {
  interface Leaf {
    name: string;
    state: { file?: string } | null;
    getViewState(): { state?: unknown };
  }
  const leaf = (name: string, file: string | null): Leaf => ({ name, state: file === null ? null : { file }, getViewState() { return { state: this.state ?? undefined }; } });

  function setup(open: Leaf[] = []) {
    const leaves = [...open];
    const openFiles = new OpenFiles<Leaf>(() => leaves);
    const log: string[] = [];
    let creating = 0;
    const hooks = (file: string, gate?: Promise<void>) => ({
      create: async () => {
        creating++;
        log.push(`create ${file}`);
        const l = leaf(`new${creating}`, null);
        // Obsidian gives the new leaf its state a moment later; the claim is taken as the view admits the file (CodeView.setState)
        await (gate ?? Promise.resolve());
        l.state = { file };
        openFiles.claim(file, l);
        leaves.push(l);
      },
      focus: (l: Leaf) => void log.push(`focus ${l.name}`),
      placeCursor: (l: Leaf, n: number) => void log.push(`line ${l.name} ${n}`),
    });
    const open_ = (file: string, line: number | null, gate?: Promise<void>) => openCodeTabOnce(openFiles, file, line, hooks(file, gate));
    return { leaves, openFiles, log, open: open_ };
  }

  it("a file nobody has open: one tab is made and nothing is focused", async () => {
    const s = setup();
    await s.open("t/helper.js", 5);
    expect(s.log).toEqual(["create t/helper.js"]);
    expect(s.leaves).toHaveLength(1);
  });

  it("a file open in another Code tab: that tab is focused and its cursor moved to the line; no second tab is made", async () => {
    const s = setup([leaf("a", "t/helper.js")]);
    await s.open("t/helper.js", 5);
    expect(s.log).toEqual(["focus a", "line a 5"]);
    expect(s.leaves).toHaveLength(1);
  });

  it("with no line known the open tab is focused and its cursor left alone", async () => {
    const s = setup([leaf("a", "t/helper.js")]);
    await s.open("t/helper.js", null);
    expect(s.log).toEqual(["focus a"]);
  });

  it("two quick opens in a row while the first tab loads: one tab, and the second open focuses it at its line", async () => {
    const s = setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = s.open("t/helper.js", 5, gate);
    const second = s.open("t/helper.js", 9);
    await new Promise((r) => setTimeout(r, 5));
    release();
    await Promise.all([first, second]);
    expect(s.log.filter((l) => l.startsWith("create"))).toEqual(["create t/helper.js"]);
    expect(s.leaves).toHaveLength(1);
    expect(s.log).toContain("focus new1");
    expect(s.log).toContain("line new1 9");
  });

  it("three opens in one tick: still one tab", async () => {
    const s = setup();
    await Promise.all([s.open("a.py", 1), s.open("a.py", 2), s.open("a.py", 3)]);
    expect(s.leaves).toHaveLength(1);
  });

  it("a file spelled composed in the tab and decomposed in the open is one file: focused, not duplicated", async () => {
    const nfc = "src/estimaté.ts".normalize("NFC");
    const s = setup([leaf("a", nfc)]);
    await s.open(nfc.normalize("NFD"), 3);
    expect(s.log).toEqual(["focus a", "line a 3"]);
    expect(s.leaves).toHaveLength(1);
  });

  it("a tab restored from the last session and not loaded yet (saved view state only) counts as open", async () => {
    const restored = leaf("restored", "t/helper.js"); // never ran setState: no claim, only its saved view state
    const s = setup([restored]);
    expect(s.openFiles.entries()).toEqual([]);
    await s.open("t/helper.js", 5);
    expect(s.log).toEqual(["focus restored", "line restored 5"]);
    expect(s.leaves).toHaveLength(1);
  });

  it("a different file gets its own tab even while another is open", async () => {
    const s = setup([leaf("a", "t/pd.js")]);
    await s.open("t/helper.js", 5);
    expect(s.log).toEqual(["create t/helper.js"]);
    expect(s.leaves.map((l) => l.state?.file)).toEqual(["t/pd.js", "t/helper.js"]);
  });

  it("a failed create leaves no claim: the next open tries again", async () => {
    const openFiles = new OpenFiles<Leaf>(() => []);
    let tries = 0;
    const hooks = { create: async () => { tries++; throw new Error("no server"); }, focus: () => undefined, placeCursor: () => undefined };
    await expect(openCodeTabOnce(openFiles, "a.py", 1, hooks)).rejects.toThrow("no server");
    await expect(openCodeTabOnce(openFiles, "a.py", 1, hooks)).rejects.toThrow("no server");
    expect(tries).toBe(2);
  });
});
