/** The text-file rules (Settled calls Q7, fence F6): one table row per rule, then the exclude list. */
import { describe, expect, it } from "vitest";
import {
  BINARY_EXTENSIONS,
  NEVER_CODE_EXTENSIONS,
  decideFile,
  extensionOf,
  isInHiddenFolder,
  isRegistrable,
  opensInCodeTab,
  type FileDecision,
} from "../../src/text-file-rules";

const ext = (extension: string): FileDecision => ({ kind: "extension", extension });
const never = (reason: "markdown" | "canvas" | "base" | "binary"): FileDecision => ({ kind: "never", reason });

describe("decideFile: the rules", () => {
  const table: Array<[string, string, FileDecision]> = [
    // code files open by extension
    ["a code file", "AWS SA Associate Mock Exams/scripts/estimate_time.py", ext("py")],
    ["typescript", "src/app.ts", ext("ts")],
    ["shell", "run.sh", ext("sh")],
    ["a new extension", "notes.zig", ext("zig")],
    ["upper-case extension is folded", "SCRIPT.PY", ext("py")],
    ["only the last extension counts", "archive.tar.gz.py", ext("py")],
    // svg, csv, txt, json open as text
    ["svg is text", "diagram.svg", ext("svg")],
    ["csv is text", "data.csv", ext("csv")],
    ["txt is text", "readme.txt", ext("txt")],
    ["json is text", "package.json", ext("json")],
    // dotfiles open
    ["a dotfile with no other dot is extensionless (click interception)", ".env", { kind: "extensionless" }],
    [".gitignore likewise", "sub/.gitignore", { kind: "extensionless" }],
    ["a dotfile with an extension opens by that extension", ".eslintrc.json", ext("json")],
    ["a dotfile in a normal folder is not hidden", "docs/.editorconfig", { kind: "extensionless" }],
    // extensionless files
    ["Makefile", "Makefile", { kind: "extensionless" }],
    ["Dockerfile in a folder", "build/Dockerfile", { kind: "extensionless" }],
    ["a trailing dot is no extension", "weird.", { kind: "extensionless" }],
    ["a 'dot' inside a sentence is no extension", "Meeting 2024.05 notes", { kind: "extensionless" }],
    // hidden folders
    ["inside .obsidian", ".obsidian/plugins/x/main.js", { kind: "hidden" }],
    ["inside .git", ".git/config", { kind: "hidden" }],
    ["inside .git, a nested path", "vendor/.git/hooks/pre-commit.sample", { kind: "hidden" }],
    ["inside node_modules", "node_modules/left-pad/index.js", { kind: "hidden" }],
    ["inside a nested node_modules", "app/node_modules/x/y.ts", { kind: "hidden" }],
    ["the .git pointer file of a worktree", ".git", { kind: "hidden" }],
    ["a folder that only starts with the name is fine", "node_modules_old/a.js", ext("js")],
    // never: markdown, canvas, base
    ["markdown", "Notes/day.md", never("markdown")],
    ["markdown, upper case", "Notes/DAY.MD", never("markdown")],
    ["canvas", "board.canvas", never("canvas")],
    ["base", "tasks.base", never("base")],
    // never: binaries
    ["png", "img/a.png", never("binary")],
    ["jpg", "photo.jpg", never("binary")],
    ["jpeg", "photo.JPEG", never("binary")],
    ["pdf", "paper.pdf", never("binary")],
    ["zip", "bundle.zip", never("binary")],
    ["mp3", "song.mp3", never("binary")],
    ["mp4", "clip.mp4", never("binary")],
    ["a compiled library", "lib/thing.dylib", never("binary")],
    ["a font", "fonts/x.woff2", never("binary")],
  ];

  it.each(table)("%s: %s", (_name, file, expected) => {
    expect(decideFile(file)).toEqual(expected);
  });
});

describe("decideFile: the exclude list", () => {
  it("an excluded extension is not offered, others still are", () => {
    expect(decideFile("a.py", ["py"])).toEqual({ kind: "excluded", extension: "py" });
    expect(decideFile("a.ts", ["py"])).toEqual(ext("ts"));
  });

  it("the extension is matched case-folded", () => {
    expect(decideFile("A.PY", ["py"])).toEqual({ kind: "excluded", extension: "py" });
  });

  it("the exclude list does not affect extensionless files or the never rules", () => {
    expect(decideFile("Makefile", ["py"])).toEqual({ kind: "extensionless" });
    expect(decideFile("a.md", ["md"])).toEqual(never("markdown"));
  });

  it("hidden folders win over the exclude list", () => {
    expect(decideFile("node_modules/a.py", ["py"])).toEqual({ kind: "hidden" });
  });
});

describe("isRegistrable: what may reach the registration call", () => {
  it.each([...NEVER_CODE_EXTENSIONS, ...BINARY_EXTENSIONS])("never %s", (e) => {
    expect(isRegistrable(e)).toBe(false);
    expect(isRegistrable(e.toUpperCase())).toBe(false);
  });

  it("never md, canvas or base, spelled out", () => {
    expect(NEVER_CODE_EXTENSIONS).toEqual(["md", "canvas", "base"]);
    for (const e of ["md", "canvas", "base"]) expect(isRegistrable(e)).toBe(false);
  });

  it("covers the binaries the spec names", () => {
    for (const e of ["png", "jpg", "pdf", "zip", "mp3", "mp4"]) expect(BINARY_EXTENSIONS).toContain(e);
  });

  it("svg, csv, txt and json are text and registrable", () => {
    for (const e of ["svg", "csv", "txt", "json"]) {
      expect(BINARY_EXTENSIONS).not.toContain(e);
      expect(isRegistrable(e)).toBe(true);
    }
  });

  it("an excluded extension is not registrable", () => {
    expect(isRegistrable("zig", ["zig"])).toBe(false);
    expect(isRegistrable("zig", ["py"])).toBe(true);
  });

  it("a malformed extension is not registrable", () => {
    for (const e of ["", "a b", "a.b", "x".repeat(21), ".py"]) expect(isRegistrable(e), JSON.stringify(e)).toBe(false);
  });
});

describe("path helpers", () => {
  it("extensionOf: lower case, no dot, empty for none or a bare dotfile", () => {
    expect(extensionOf("a/B.Py")).toBe("py");
    expect(extensionOf(".env")).toBe("");
    expect(extensionOf(".env.local")).toBe("local");
    expect(extensionOf("Makefile")).toBe("");
    expect(extensionOf("dir.d/Makefile")).toBe("");
  });

  it("isInHiddenFolder checks every segment", () => {
    expect(isInHiddenFolder("a/.git/b")).toBe(true);
    expect(isInHiddenFolder("a/b/c.py")).toBe(false);
  });

  it("opensInCodeTab is true for extensions and extensionless files only", () => {
    expect(opensInCodeTab("a.py")).toBe(true);
    expect(opensInCodeTab("Makefile")).toBe(true);
    expect(opensInCodeTab("a.md")).toBe(false);
    expect(opensInCodeTab("a.png")).toBe(false);
    expect(opensInCodeTab(".git/config")).toBe(false);
    expect(opensInCodeTab("a.py", ["py"])).toBe(false);
  });
});
