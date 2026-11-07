/**
 * The folder a "New terminal at folder" choice opens in (G8, E8), over a real temporary vault on disk: a folder uses its
 * own path, the vault root works, a folder that is gone or not a folder falls back to the vault root, a path that would leave
 * the vault does too, and a vault that is itself missing gives no folder at all (VS Code's own default start folder).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { resolveTerminalFolder } from "../../src/terminal-host/terminal-folder-target";
import { tempDir } from "../helpers";

let vault: string;
const mk = (rel: string) => fs.mkdirSync(path.join(vault, rel), { recursive: true });

// Folders with awkward names: spaces, underscore, non-ASCII, shell characters, a leading dot, two dots in a name.
const AWKWARD = ["HackerRank Mini-Course/_internals", "日本語 folder", "Café Notes", "it's $HOME & (x)", 'say "hi" `x` ;rm', ".hidden/inner", "..dots", "a/b/c d/e"];

beforeEach(() => {
  vault = tempDir();
  for (const f of AWKWARD) mk(f);
  fs.writeFileSync(path.join(vault, "note.md"), "x");
});

describe("a folder that exists", () => {
  it.each(AWKWARD)("%s: its own path, byte for byte", (folder) => {
    expect(resolveTerminalFolder(vault, folder)).toBe(path.join(vault, folder));
  });

  it("the NFD spelling of a name that is on disk in NFC (macOS treats them as one folder) is passed through as given", () => {
    const nfd = "Café Notes".normalize("NFD");
    const got = resolveTerminalFolder(vault, nfd);
    expect(got).toBe(path.join(vault, nfd));
    expect(Buffer.from(got!.slice(vault.length + 1))).toEqual(Buffer.from(nfd));
  });
});

describe("the vault root", () => {
  it.each(["", "/"])("the folder %j is the vault's base path", (root) => {
    expect(resolveTerminalFolder(vault, root)).toBe(vault);
  });
});

describe("a folder that is not there (E8)", () => {
  it.each([
    ["never existed", "no such folder"],
    ["a child of one that never existed", "no such folder/inner"],
    ["a file, not a folder", "note.md"],
    ["a name with spaces that was renamed", "HackerRank Mini-Course/_internals old"],
  ])("%s: the vault root, no error", (_why, folder) => {
    expect(resolveTerminalFolder(vault, folder)).toBe(vault);
  });

  it("a folder deleted after it was seen falls back to the vault root", () => {
    expect(resolveTerminalFolder(vault, "Café Notes")).toBe(path.join(vault, "Café Notes"));
    fs.rmSync(path.join(vault, "Café Notes"), { recursive: true });
    expect(resolveTerminalFolder(vault, "Café Notes")).toBe(vault);
  });

  it("a folder renamed on disk behind Obsidian falls back to the vault root", () => {
    fs.renameSync(path.join(vault, "日本語 folder"), path.join(vault, "renamed"));
    expect(resolveTerminalFolder(vault, "日本語 folder")).toBe(vault);
  });
});

describe("a path that would leave the vault", () => {
  const outside = () => path.dirname(vault);
  it.each([
    ["..", () => ".."],
    ["../sibling", () => "../sibling"],
    ["a/../../x", () => "a/../../x"],
    ["an absolute path", () => outside()],
    ["a path with a NUL", () => "a\0b"],
  ])("%s: the vault root, never the outside folder", (_why, folder) => {
    expect(resolveTerminalFolder(vault, folder())).toBe(vault);
  });

  it("a path that goes up and comes back inside the vault is still inside it", () => {
    expect(resolveTerminalFolder(vault, "a/b/../b/c d")).toBe(path.join(vault, "a/b/c d"));
  });

  it("a name that merely starts with two dots is a folder inside the vault", () => {
    expect(resolveTerminalFolder(vault, "..dots")).toBe(path.join(vault, "..dots"));
  });
});

describe("a vault folder that is missing or unreadable (E8)", () => {
  it("is null whatever the folder: VS Code's own default start folder", () => {
    const gone = path.join(vault, "gone");
    expect(resolveTerminalFolder(gone, "")).toBeNull();
    expect(resolveTerminalFolder(gone, "a/b")).toBeNull();
  });

  it("a vault base path that is a file is null", () => {
    expect(resolveTerminalFolder(path.join(vault, "note.md"), "")).toBeNull();
  });
});
