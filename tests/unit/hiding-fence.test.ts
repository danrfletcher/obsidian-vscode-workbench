/**
 * PR-6's fences of the editor-only tab, as grep-style checks over the source text:
 *  F2  the terminal drawer's code and its host page never import or quote this ticket's hiding settings;
 *  F7  no hiding settings UI, no retry layer, no selector-version table and no health monitor.
 * (F6, F1 and the drawer's imports are in chrome-fence.test.ts; these add the settings keys and the F7 lines.)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { chromeSettings } from "../../src/chrome-settings";
import { REPO_ROOT } from "../helpers";

const src = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, "src", rel), "utf8");
/** The code with block comments and line comments removed, so a comment that says "not a retry layer" is not read as one. */
const code = (rel: string) => src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const tsFiles = (dir: string): string[] =>
  fs.readdirSync(path.join(REPO_ROOT, "src", dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    return e.isDirectory() ? tsFiles(rel) : e.name.endsWith(".ts") ? [rel] : [];
  });

/** The hiding setting keys, written out here (not read from the table) so a new key must be looked at. */
const HIDING_KEY_NEEDLES = ["zenMode.", "workbench.editor.showTabs", "breadcrumbs.enabled", "workbench.activityBar", "workbench.statusBar", "secondarySideBar"];

describe("F2: the terminal drawer's code never reads this ticket's hiding settings", () => {
  const drawerFiles = [...tsFiles("terminal"), ...tsFiles("terminal-host")];

  it("finds the drawer's files (a moved folder cannot make the checks below pass on nothing)", () => {
    expect(drawerFiles.length).toBeGreaterThan(10);
    expect(drawerFiles).toContain("terminal/terminal-drawer.ts");
    expect(drawerFiles).toContain("terminal-host/host-page.ts");
  });

  it.each(drawerFiles)("src/%s does not import src/chrome-settings.ts", (rel) => {
    expect(code(rel)).not.toMatch(/from\s+["'][^"']*chrome-settings["']/);
  });

  it.each(drawerFiles)("src/%s does not quote a hiding setting key", (rel) => {
    const text = code(rel);
    for (const needle of HIDING_KEY_NEEDLES) expect(text, needle).not.toContain(needle);
  });

  it("the needles above cover the hiding settings the table really writes (the set was not left behind)", () => {
    const keys = Object.keys(chromeSettings());
    for (const needle of HIDING_KEY_NEEDLES) expect(keys.some((k) => k.includes(needle)), needle).toBe(true);
  });
});

describe("F7: no hiding settings UI", () => {
  const WORDS = /hide_?(chrome|workbench|bars?|parts?|layout|zen)|hiding|hid(e|es)\s+(the\s+)?(chrome|workbench|parts?)|chrome|layout|zen|side\s*bar|activity\s*bar|status\s*bar|title\s*bar|breadcrumb|show\s*workbench|full\s*workbench/i;

  it.each(["settings/settings-tab.ts", "settings/data.ts"])("src/%s has no control or field for hiding, layout or showing the workbench", (rel) => {
    const text = code(rel);
    const hits = text.split("\n").filter((l) => WORDS.test(l));
    expect(hits).toEqual([]);
  });

  it("neither file imports the hiding modules", () => {
    for (const rel of ["settings/settings-tab.ts", "settings/data.ts"]) {
      expect(code(rel), rel).not.toMatch(/from\s+["'][^"']*(chrome-settings|chrome-script|keybinding-overlay)["']/);
    }
  });
});

describe("F7: no retry layer, selector versioning or health monitor in the modules that hide chrome", () => {
  const HIDING_MODULES = ["chrome-settings.ts", "chrome-script.ts", "keybinding-overlay.ts"];

  it.each(HIDING_MODULES)("src/%s has no timer that re-runs the hiding", (rel) => {
    expect(code(rel)).not.toMatch(/\bsetInterval\b|\bsetTimeout\b/);
  });

  it.each(HIDING_MODULES)("src/%s has no retry loop, selector-version table or health / monitor / watchdog symbol", (rel) => {
    const text = code(rel);
    expect(text).not.toMatch(/\bretr(y|ies|ied)\b|\bbackoff\b|\bwatchdog\b|\bheartbeat\b|\bhealth\w*|\bmonitor\w*/i);
    expect(text).not.toMatch(/selector[_-]?versions?|SELECTORS_BY|selectorTable|versionedSelectors?|\bforVersion\b/i);
  });

  it("the one thing that re-presses a close chord is a fixed budget, driven by the page's own change events (a MutationObserver, not a timer)", () => {
    const text = code("chrome-script.ts");
    expect(text).toContain("MutationObserver");
    expect(text).not.toMatch(/\bwhile\s*\(\s*true\s*\)|\bfor\s*\(\s*;\s*;\s*\)/);
  });
});
