import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, listTsFiles } from "../helpers";

const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "manifest.json"), "utf8")) as Record<string, unknown>;

describe("manifest.json", () => {
  it("is desktop only (F1)", () => {
    expect(manifest.isDesktopOnly).toBe(true);
  });

  it("requires Obsidian 1.13.0 or newer", () => {
    expect(manifest.minAppVersion).toBe("1.13.0");
  });

  it("has the plugin id and the required fields", () => {
    expect(manifest.id).toBe("obsidian-vscode-workbench");
    for (const k of ["id", "name", "version", "minAppVersion", "description", "author", "isDesktopOnly"]) {
      expect(manifest, k).toHaveProperty(k);
    }
  });

  it("has no mobile code paths in src/ (F1)", () => {
    const dir = path.join(REPO_ROOT, "src");
    const text = listTsFiles(dir)
      .map((f) => fs.readFileSync(path.join(dir, f), "utf8"))
      .join("\n");
    expect(text).not.toMatch(/Platform\.isMobile|isMobileApp|Capacitor/);
  });
});
