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

  it("documents which files open: the scan, the rules, the guard, coexistence, one tab per file (PR-4)", () => {
    const text = section("## Which files open");
    expect(text).not.toBeNull();
    for (const needle of [".obsidian", ".git", "node_modules", "svg", "csv", "txt", "json", "Markdown", "binaries", "exclude list", "2 MB", "2,097,152", "8 KB", "Code Files", "VSCode Editor", "Code Workbench", "notice naming the owner", "One tab per file", "symlink loop"]) {
      expect(text, needle).toContain(needle);
    }
  });

  it("states the extensionless limit and the fallback, so there is never a silent blank tab (G7)", () => {
    const text = section("### Extensionless files and dotfiles");
    expect(text).not.toBeNull();
    for (const needle of ["Makefile", "Dockerfile", ".env", "best effort", "system's app", "never as a blank tab", "Detect all file extensions", "never lists dotfiles", "system-app"]) {
      expect(text, needle).toContain(needle);
    }
  });

  describe("the terminal drawer is VS Code's own (PR-4)", () => {
    it("has no python3, xterm or Python helper text anywhere", () => {
      for (const needle of [/python3/i, /xterm/i, /Python helper/i, /pty_helper/i, /\bnode-pty\b/i]) expect(readme, String(needle)).not.toMatch(needle);
    });

    it("has no Status bar or Shell paragraph, and no shell count", () => {
      const bullets = readme.split("\n").filter((l) => l.startsWith("- **"));
      expect(bullets.filter((l) => /^- \*\*(Status bar|Shell|Tabs|How it works)\b/.test(l))).toEqual([]);
      expect(readme).not.toMatch(/\b1 shell\b|N shells/);
    });

    it("documents the drawer section as VS Code's terminal, with the vault root, no plugin dialog, and the 0.1.0 change", () => {
      const text = section("## Terminal drawer");
      expect(text).not.toBeNull();
      for (const needle of ["VS Code's own integrated terminal", "vault root", "never asks first", "What changed from 0.1.0", "`shellPath`", "ignored and left in the file"]) {
        expect(text, needle).toContain(needle);
      }
    });

    it("still documents the Settings section with the one drawer toggle and no Shell setting", () => {
      const text = section("## Settings");
      expect(text).not.toBeNull();
      expect(text).toContain("**Excluded file extensions and the terminal drawer toggle.**");
      expect(text).not.toMatch(/\*\*Shell|shell path|shellPath|\$SHELL|\/bin\/zsh/i);
    });
  });

  it("the Hidden chrome bullet says the Code tab shows the editor only and that the full workbench is not available (GP1, F6)", () => {
    const bullet = readme.split("\n").find((l) => l.startsWith("- **Hidden chrome.**"));
    expect(bullet, "a Hidden chrome bullet").toBeDefined();
    for (const needle of ["Explorer", "Open Editors", "tab strip", "breadcrumbs", "activity bar", "status bar", "title bar", "panel", "side bar", "secondary side bar", "The full workbench is not available", "best effort", "never stops a tab from opening"]) {
      expect(bullet, needle).toContain(needle);
    }
  });

  describe("Working in a Code tab: the lost views, the keys, the popups and the iframe embed (PR-6)", () => {
    const text = section("## Working in a Code tab") ?? "";

    it("names the views that are gone from the tab", () => {
      expect(text).not.toBe("");
      for (const needle of ["Source Control", "Run and Debug", "Testing", "Extensions", "Problems", "Output", "Debug Console", "integrated terminal panel", "any view an extension adds to the side bar, secondary side bar or panel"]) {
        expect(text, needle).toContain(needle);
      }
    });

    it("says extensions still run in the editor and that the terminal drawer replaces VS Code's terminal", () => {
      for (const needle of ["Extensions still run in the editor", "squiggles", "hovers", "completions", "formatting", "Cmd+Shift+P", "The terminal drawer", "replaces VS Code's own terminal panel"]) {
        expect(text, needle).toContain(needle);
      }
    });

    it("says what the keys do and that a file opened from the editor is a new Obsidian tab", () => {
      for (const needle of ["Cmd+B and Cmd+J do nothing in a tab", "Cmd+W closes the Obsidian tab", "Cmd+Shift+P and Cmd+P open as overlays", "opens as a new Obsidian tab"]) {
        expect(text, needle).toContain(needle);
      }
    });

    it("says VS Code's popups still appear, that a part that cannot be hidden shows again, and that there is no setting for the full workbench", () => {
      for (const needle of ["VS Code's own popups (save conflicts, Workspace Trust, extension notifications) still appear", "that part shows again and the tab still works", "There is no setting to bring the full workbench back"]) {
        expect(text, needle).toContain(needle);
      }
    });

    it("says what the iframe embed gets, keeps the webview as the default, and makes no mobile claim", () => {
      for (const needle of ["The webview is the default", "gets no page script", "no hotkey bridge", "no script-based hiding"]) {
        expect(text, needle).toContain(needle);
      }
      expect(text).not.toMatch(/\bmobile\b/i);
    });

    it("documents no hiding setting and no retry behaviour (F7), and mentions no tab strip as shown", () => {
      expect(text).not.toMatch(/hiding[^.\n]*\bretr(y|ies)\b|\bretr(y|ies)\b[^.\n]*hiding/i);
      expect(text).not.toMatch(/`(hideChrome|hiding|showWorkbench|layout)[A-Za-z]*`/);
      expect(text).not.toMatch(/tab strip (is|stays|remains) (shown|visible)|shows? (the|a) (VS Code )?tab strip/i);
    });
  });

  it("no longer says the chrome is visible or lists the side bar as shown", () => {
    expect(readme).not.toMatch(/chrome:\s*visible/i);
    expect(readme).not.toMatch(/side bar[^.\n]*(stays|remains|is|still)\s+(visible|shown)/i);
    expect(readme).not.toMatch(/\bF11\b/);
  });
});
