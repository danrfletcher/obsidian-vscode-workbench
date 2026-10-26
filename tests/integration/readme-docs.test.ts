/** The README documents what the settings tab warns about (E8) and what the plugin copies (G17). */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../helpers";

const readme = fs.readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");

/** The text of the section whose heading line is `heading`, up to the next heading of the same or a higher level. */
function section(heading: string): string | null {
  const lines = readme.split("\n");
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start < 0) return null;
  const level = /^#+/.exec(heading)![0].length;
  const end = lines.findIndex((l, i) => i > start && /^#+ /.test(l) && /^#+/.exec(l)![0].length <= level);
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
}

describe("README", () => {
  it("has a Microsoft-only extensions section that names the extensions, the builds and the warning (E8)", () => {
    const text = section("### Microsoft-only extensions");
    expect(text).not.toBeNull();
    expect(text).toMatch(/Pylance/);
    expect(text).toMatch(/VSCodium/);
    expect(text).toMatch(/Antigravity/);
    expect(text).toMatch(/warning/i);
  });

  it("the warning wording in the section matches what the settings tab shows", () => {
    const tab = fs.readFileSync(path.join(REPO_ROOT, "src/settings/settings-tab.ts"), "utf8");
    expect(tab).toContain('See "Microsoft-only extensions" in the README.');
  });

  it("explains the one-way copy and that no other instance is modified (G17, F3)", () => {
    const text = section("### Your VS Code settings");
    expect(text).not.toBeNull();
    for (const needle of ["settings.json", "keybindings.json", "one way", ".git", ".obsidian", "Attachments", "node_modules", "_to_delete", "never writes to"]) {
      expect(text, needle).toContain(needle);
    }
  });

  it("documents the probe: no server, no port, no download", () => {
    expect(section("## Settings")).toMatch(/starts no server, opens no port and downloads nothing/);
  });
});
