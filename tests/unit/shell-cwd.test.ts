import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ShellStartDir, startDirectory } from "../../src/terminal/shell-cwd";
import { tempDir } from "../helpers";

/** A vault on disk with the folders the spec names. */
function makeVault(): string {
  const root = tempDir();
  fs.mkdirSync(path.join(root, "AWS SA Associate Mock Exams/scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "AWS SA Associate Mock Exams/scripts/estimate_time.py"), "print('hi')\n");
  fs.mkdirSync(path.join(root, "Areas/Café Notes/Mock Exams"), { recursive: true });
  fs.mkdirSync(path.join(root, "Notes/日本語 folder"), { recursive: true });
  fs.mkdirSync(path.join(root, "Café Notes"), { recursive: true });
  fs.writeFileSync(path.join(root, "Café Notes/my script.py"), "print('hi')\n");
  return root;
}

describe("shell start directory (G12)", () => {
  let vault: string;
  beforeEach(() => {
    vault = makeVault();
  });

  it("is the folder of the active file", () => {
    expect(startDirectory(vault, "AWS SA Associate Mock Exams/scripts/estimate_time.py")).toBe(path.join(vault, "AWS SA Associate Mock Exams/scripts"));
  });

  it("falls back to the vault root with no active file", () => {
    expect(startDirectory(vault, null)).toBe(vault);
    expect(startDirectory(vault, undefined)).toBe(vault);
    expect(startDirectory(vault, "")).toBe(vault);
  });

  it("falls back to the vault root for a file at the top level", () => {
    expect(startDirectory(vault, "Top level.md")).toBe(vault);
  });

  it("keeps spaces and non-ASCII characters in the folder", () => {
    expect(startDirectory(vault, "Areas/Café Notes/Mock Exams/estimaté tïme.py")).toBe(path.join(vault, "Areas/Café Notes/Mock Exams"));
    expect(startDirectory(vault, "Notes/日本語 folder/a.txt")).toBe(path.join(vault, "Notes/日本語 folder"));
  });

  it("returns the folder as the literal path, with no quoting or escaping added (E5)", () => {
    const dir = startDirectory(vault, "Café Notes/my script.py");
    expect(dir).toBe(path.join(vault, "Café Notes"));
    expect(dir).not.toMatch(/\\|'|"/);
  });

  it("a hotkey-created shell for `Café Notes/my script.py` pins that folder and keeps it after later tab switches (E5, G12)", () => {
    let active: string | null = "Café Notes/my script.py";
    const dir = new ShellStartDir(() => vault, () => active);
    expect(dir.pin()).toBe(path.join(vault, "Café Notes"));
    active = "Notes/日本語 folder/a.txt";
    expect(dir.pin()).toBe(path.join(vault, "Café Notes"));
  });

  it("falls back to the vault root when the folder is gone or is a file", () => {
    expect(startDirectory(vault, "Deleted folder/x.py")).toBe(vault);
    expect(startDirectory(vault, "AWS SA Associate Mock Exams/scripts/estimate_time.py/x.py")).toBe(vault);
  });

  it("never leaves the vault", () => {
    expect(startDirectory(vault, "../outside/x.py")).toBe(vault);
    expect(startDirectory(vault, "a/../../outside/x.py")).toBe(vault);
  });
});

describe("ShellStartDir: the folder is taken once and kept (G12)", () => {
  let vault: string;
  beforeEach(() => {
    vault = makeVault();
  });

  it("does not follow later switches of the active file", () => {
    let active: string | null = "AWS SA Associate Mock Exams/scripts/estimate_time.py";
    let calls = 0;
    const dir = new ShellStartDir(() => vault, () => { calls += 1; return active; });
    const first = dir.pin();
    expect(first).toBe(path.join(vault, "AWS SA Associate Mock Exams/scripts"));
    active = "Areas/Café Notes/Mock Exams/other.py";
    expect(dir.pin()).toBe(first);
    active = null;
    expect(dir.pin()).toBe(first);
    expect(calls).toBe(1);
  });

  it("takes the folder fresh for the next shell once released", () => {
    let active: string | null = "AWS SA Associate Mock Exams/scripts/estimate_time.py";
    const dir = new ShellStartDir(() => vault, () => active);
    dir.pin();
    dir.release();
    active = "Areas/Café Notes/Mock Exams/other.py";
    expect(dir.pin()).toBe(path.join(vault, "Areas/Café Notes/Mock Exams"));
  });

  it("uses the vault root when the first reveal has no active file, and keeps it", () => {
    let active: string | null = null;
    const dir = new ShellStartDir(() => vault, () => active);
    expect(dir.pin()).toBe(vault);
    active = "AWS SA Associate Mock Exams/scripts/estimate_time.py";
    expect(dir.pin()).toBe(vault);
  });
});
