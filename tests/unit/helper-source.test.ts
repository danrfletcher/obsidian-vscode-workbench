import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { HELPER_FILE, installHelper } from "../../src/terminal/helper-source";
import { REPO_ROOT, tempDir } from "../helpers";

const SOURCE = fs.readFileSync(path.join(REPO_ROOT, "src/terminal/pty_helper.py"), "utf8");

describe("installHelper: the helper ships inside main.js and is written out before a shell starts", () => {
  it("writes the bundled script, byte for byte the source file, into a private folder", () => {
    const dir = path.join(tempDir(), "runtime");
    const file = installHelper(dir);
    expect(file).toBe(path.join(dir, HELPER_FILE));
    expect(fs.readFileSync(file, "utf8")).toBe(SOURCE);
    expect(fs.statSync(file).mode & 0o077).toBe(0);
    expect(fs.statSync(dir).mode & 0o077).toBe(0);
  });

  it("leaves an identical file alone, and replaces an outdated or tampered one", () => {
    const dir = tempDir();
    const file = installHelper(dir);
    const before = fs.statSync(file).mtimeMs;
    installHelper(dir);
    expect(fs.statSync(file).mtimeMs).toBe(before);
    fs.writeFileSync(file, "print('tampered')\n");
    installHelper(dir);
    expect(fs.readFileSync(file, "utf8")).toBe(SOURCE);
  });

  it("leaves no temporary file behind, and throws when the folder cannot be written", () => {
    const dir = tempDir();
    installHelper(dir);
    expect(fs.readdirSync(dir)).toEqual([HELPER_FILE]);
    const blocker = path.join(tempDir(), "file");
    fs.writeFileSync(blocker, "x");
    expect(() => installHelper(path.join(blocker, "sub"))).toThrow();
  });

  it("uses only the Python standard library and opens no socket (F4)", () => {
    const imports = [...SOURCE.matchAll(/^\s*(?:import|from)\s+([a-zA-Z_][\w.]*)/gm)].map((m) => m[1].split(".")[0]);
    expect(imports.length).toBeGreaterThan(3);
    expect(imports).not.toContain("socket");
    expect(imports).not.toContain("requests");
    expect(imports).not.toContain("urllib");
    expect(imports).not.toContain("http");
    expect(SOURCE).not.toMatch(/\.bind\(|\.listen\(|AF_INET/);
  });
});
