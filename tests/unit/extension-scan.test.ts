/** Extension extraction and the vault walk: case folding, dotfiles, de-duplication, extensionless files, loops, batching. */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ExtensionCollector, extensionsOf, scanVault, type DirEntryLike, type ScanFs } from "../../src/extension-scan";
import { tempDir } from "../helpers";

describe("extension extraction", () => {
  it("collects extensions, case folded, de-duplicated and sorted", () => {
    expect(extensionsOf(["a.PY", "b.py", "c/d.Py", "x.TS", "z.zig"])).toEqual(["py", "ts", "zig"]);
  });

  it("a dotfile with only the leading dot contributes no extension", () => {
    expect(extensionsOf([".env", ".gitignore", "sub/.dockerignore"])).toEqual([]);
  });

  it("a dotfile with a further dot contributes its last extension", () => {
    expect(extensionsOf([".eslintrc.json", ".env.local"])).toEqual(["json", "local"]);
  });

  it("counts extensionless files separately and does not register them", () => {
    const c = new ExtensionCollector();
    for (const p of ["Makefile", "build/Dockerfile", ".env", "a.py", "LICENSE"]) c.add(p);
    expect(c.extensionless).toBe(4);
    expect(c.files).toBe(5);
    expect(c.extensions).toEqual(["py"]);
  });

  it("leaves out markdown, canvas, base and binaries, and hidden folders", () => {
    expect(extensionsOf(["a.md", "b.canvas", "c.base", "d.png", "e.pdf", ".git/x.py", "node_modules/y.rs", ".obsidian/z.css", "ok.go"])).toEqual(["go"]);
  });

  it("skips the user's excluded extensions", () => {
    expect(extensionsOf(["a.py", "b.ts", "c.zig"], ["py", "zig"])).toEqual(["ts"]);
  });

  it("a name with no real extension (spaces, trailing dot) is extensionless", () => {
    const c = new ExtensionCollector();
    for (const p of ["Meeting 2024.05 notes", "weird."]) c.add(p);
    expect(c.extensions).toEqual([]);
    expect(c.extensionless).toBe(2);
  });
});

function build(files: string[]): string {
  const root = tempDir();
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), "x");
  }
  return root;
}

const noWarn = () => undefined;

describe("scanVault on a real folder", () => {
  it("finds every extension, nested, and skips hidden folders without entering them", async () => {
    const root = build([
      "a.py",
      "Mock Exams/scripts/estimate_time.py",
      "src/app.TS",
      "notes.zig",
      "Makefile",
      "Dockerfile",
      ".env",
      "note.md",
      "board.canvas",
      "pic.png",
      ".obsidian/plugins/x/main.js",
      ".git/hooks/pre-commit.sample",
      "node_modules/pkg/index.rs",
      "deep/node_modules/pkg/index.kt",
    ]);
    const result = await scanVault(root, { warn: noWarn });
    expect(result.extensions).toEqual(["py", "ts", "zig"]);
    expect(result.extensionless).toBe(3);
    expect(result.skipped).toBe(0);
  });

  it("does not list a hidden folder at all", async () => {
    const root = build([".git/a.py", "node_modules/b.py", "ok/c.py"]);
    const real = (await import("../../src/extension-scan")).nodeScanFs;
    const listed: string[] = [];
    await scanVault(root, {
      warn: noWarn,
      fs: {
        ...real,
        readdir: (d) => {
          listed.push(path.relative(root, d));
          return real.readdir(d);
        },
      },
    });
    expect(listed.sort()).toEqual(["", "ok"]);
  });

  it("applies the exclude list", async () => {
    const root = build(["a.py", "b.ts", "c.zig"]);
    expect((await scanVault(root, { excluded: ["py", "zig"], warn: noWarn })).extensions).toEqual(["ts"]);
  });

  it("a file renamed to a new extension is found by the next scan", async () => {
    const root = build(["thing.txt"]);
    expect((await scanVault(root, { warn: noWarn })).extensions).toEqual(["txt"]);
    fs.renameSync(path.join(root, "thing.txt"), path.join(root, "thing.zig"));
    expect((await scanVault(root, { warn: noWarn })).extensions).toEqual(["zig"]);
  });

  it("a symlink loop does not stop the scan: skipped with a warning", async () => {
    const root = build(["a/one.py", "b/two.rs"]);
    fs.symlinkSync(root, path.join(root, "a", "loop-to-root")); // back to the vault root
    fs.symlinkSync(path.join(root, "a"), path.join(root, "a", "self")); // into its own folder
    fs.symlinkSync(path.join(root, "x-self"), path.join(root, "x-self")); // a link to itself
    const warn = vi.fn();
    const result = await scanVault(root, { warn });
    expect(result.extensions).toEqual(["py", "rs"]);
    expect(result.skipped).toBeGreaterThanOrEqual(2);
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/scan skipped the link/);
  });

  it("a broken link is skipped with a warning and the rest is scanned", async () => {
    const root = build(["ok.py"]);
    fs.symlinkSync(path.join(root, "gone"), path.join(root, "dangling.lnk"));
    const warn = vi.fn();
    const result = await scanVault(root, { warn });
    expect(result.extensions).toEqual(["py"]);
    expect(result.skipped).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("a link to a file counts as that file; a link to a folder outside the vault is followed once", async () => {
    const outside = build(["lib/x.go"]);
    const root = build(["real.py"]);
    fs.symlinkSync(path.join(root, "real.py"), path.join(root, "alias.rs"));
    fs.symlinkSync(path.join(outside, "lib"), path.join(root, "linked"));
    expect((await scanVault(root, { warn: noWarn })).extensions).toEqual(["go", "py", "rs"]);
  });

  it("an unreadable folder is skipped with a warning and the rest is scanned", async () => {
    const root = build(["ok/a.py", "locked/b.rs", "other/c.ts"]);
    const locked = path.join(root, "locked");
    fs.chmodSync(locked, 0o000);
    try {
      const warn = vi.fn();
      const result = await scanVault(root, { warn });
      // Running as root would read it anyway; the point is that the scan finishes either way.
      expect(result.extensions).toEqual(expect.arrayContaining(["py", "ts"]));
      if (!result.extensions.includes("rs")) {
        expect(result.skipped).toBe(1);
        expect(warn).toHaveBeenCalledTimes(1);
      }
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  });

  it("a root that cannot be resolved gives an empty result and a warning", async () => {
    const warn = vi.fn();
    const result = await scanVault(path.join(tempDir(), "missing"), { warn });
    expect(result).toMatchObject({ extensions: [], files: 0, skipped: 1 });
    expect(warn).toHaveBeenCalled();
  });

  it("stops between slices when cancelled", async () => {
    const root = build(["a/1.py", "b/2.ts", "c/3.rs"]);
    const result = await scanVault(root, { warn: noWarn, isCancelled: () => true });
    expect(result.extensions).toEqual([]);
  });
});

/** An in-memory vault: one folder per entry of `dirs`, `perDir` files in each, `cost` ms of virtual time per entry. */
function fakeVault(dirs: number, perDir: number, cost: number, clock: { t: number }): ScanFs {
  const entry = (name: string, dir: boolean): DirEntryLike => ({
    name,
    isDirectory: () => dir,
    isSymbolicLink: () => {
      clock.t += cost;
      return false;
    },
  });
  return {
    readdir: async (d) => {
      if (d === "/v") return Array.from({ length: dirs }, (_, i) => entry(`d${i}`, true));
      return Array.from({ length: perDir }, (_, i) => entry(`f${i}.${["py", "ts", "rs", "go"][i % 4]}`, false));
    },
    stat: async () => ({ isDirectory: () => false }),
    realpath: async (p) => p,
  };
}

describe("scanVault batching (a very large vault does not block the UI)", () => {
  it("40,000 files are walked in slices no longer than the budget plus one clock check", async () => {
    const clock = { t: 0 };
    const cost = 0.05; // virtual ms per entry
    const budget = 8;
    const slices: number[] = [];
    let sliceStart = 0;
    const result = await scanVault("/v", {
      fs: fakeVault(400, 100, cost, clock),
      budgetMs: budget,
      now: () => clock.t,
      yieldToUi: async () => {
        slices.push(clock.t - sliceStart);
        sliceStart = clock.t;
      },
      warn: noWarn,
    });
    expect(result.files).toBe(40_000);
    expect(result.extensions).toEqual(["go", "py", "rs", "ts"]);
    const total = 40_400 * cost;
    expect(result.yields).toBeGreaterThanOrEqual(Math.floor(total / (budget + 64 * cost)));
    expect(slices.length).toBe(result.yields);
    // The clock is read every 64 entries (and after each folder), so a slice overruns by at most that much.
    expect(Math.max(...slices)).toBeLessThanOrEqual(budget + 64 * cost + 1e-9);
  });

  it("one folder with 50,000 files is also sliced", async () => {
    const clock = { t: 0 };
    const result = await scanVault("/v", {
      fs: fakeVault(1, 50_000, 0.05, clock),
      budgetMs: 8,
      now: () => clock.t,
      yieldToUi: async () => undefined,
      warn: noWarn,
    });
    expect(result.files).toBe(50_000);
    expect(result.yields).toBeGreaterThan(100);
  });

  it("really yields to the event loop: a timer fires during a long scan", async () => {
    const root = build(Array.from({ length: 3000 }, (_, i) => `d${i % 30}/f${i}.py`));
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    const result = await scanVault(root, { budgetMs: 0, warn: noWarn }); // a zero budget yields after every folder
    clearInterval(timer);
    expect(result.files).toBe(3000);
    expect(result.yields).toBeGreaterThan(10);
    expect(ticks).toBeGreaterThan(0);
  });
});
