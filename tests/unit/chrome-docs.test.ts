/**
 * The docs agree with the code: the README names the surfaces CHROME_SURFACES hides (and says so for any that stays visible), and
 * the `chrome` header of docs/spike-decision.md is the value those same rows give. Read from disk, no mock.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { CHROME_SURFACES, DIRTY_TITLE_SETTINGS, visibleChrome, type ChromeSurfaceName } from "../../src/chrome-settings";
import { parseDecision } from "../decision";
import { REPO_ROOT } from "../helpers";

const readme = fs.readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");
const decisionText = fs.readFileSync(path.join(REPO_ROOT, "docs/spike-decision.md"), "utf8");

/** How the README spells each surface. Written out here: a new surface in the table fails the first test until it is added. */
const README_NAME: Readonly<Record<ChromeSurfaceName, string>> = {
  activityBar: "activity bar",
  statusBar: "status bar",
  titleBar: "title bar",
  tabStrip: "tab strip",
  breadcrumbs: "breadcrumbs",
  secondarySideBar: "secondary side bar",
  sideBar: "side bar",
  panel: "panel",
};

/** The README's "Hidden chrome" bullet, the one place that lists what the tab shows and what it hides. */
const hiddenChromeBullet = readme.split("\n").find((l) => l.startsWith("- **Hidden chrome.**")) ?? "";

describe("README and CHROME_SURFACES", () => {
  it("the README has a name for every surface in the table", () => {
    expect(CHROME_SURFACES.map((s) => s.surface).sort()).toEqual(Object.keys(README_NAME).sort());
    expect(hiddenChromeBullet).not.toBe("");
  });

  it("names every surface that is hidden, in the Hidden chrome text", () => {
    const hidden = CHROME_SURFACES.filter((s) => s.measured !== "visible");
    expect(hidden.length).toBeGreaterThan(0);
    for (const s of hidden) expect(hiddenChromeBullet, s.surface).toContain(README_NAME[s.surface]);
  });

  it("names each surface that visibleChrome() returns as visible, in a sentence that says it is shown", () => {
    for (const surface of visibleChrome()) {
      const name = README_NAME[surface as ChromeSurfaceName];
      const sentences = readme.split(/(?<=[.!?])\s+/).filter((t) => t.includes(name));
      expect(sentences.some((t) => /\b(stays?|remains?|is|are|still)\s+(visible|shown)|\bshows?\b/i.test(t)), surface).toBe(true);
    }
  });

  it("has no 'stay visible' sentence when visibleChrome() is empty", () => {
    expect(visibleChrome()).toEqual([]);
    expect(readme).not.toMatch(/\bstay(s)?\s+visible\b/i);
    expect(readme).not.toMatch(/the tab shows part of VS Code's chrome/i);
  });

});

describe("docs/spike-decision.md and CHROME_SURFACES", () => {
  it("the header chrome value is the one derived from the table: hidden when visibleChrome() is empty, otherwise visible", () => {
    const derived = visibleChrome().length === 0 ? "hidden" : "visible";
    expect(parseDecision(decisionText).chrome).toBe(derived);
  });

  it("every surface the table lists as hidden is one the conditional-checks row for `chrome: hidden` asks to check", () => {
    const row = decisionText.split("\n").find((l) => l.startsWith("| `chrome: hidden`")) ?? "";
    expect(row).not.toBe("");
    for (const s of CHROME_SURFACES.filter((x) => x.measured !== "visible")) expect(row, s.surface).toContain(README_NAME[s.surface]);
  });
});

describe("README and the unsaved-edits signal", () => {
  const closing = readme.split("\n").find((l) => l.startsWith("- **Closing with unsaved edits.**")) ?? "";
  const keys = readme.split("\n").find((l) => l.startsWith("- **Keys and other files in a Code tab.**")) ?? "";

  it("the Closing bullet names the window.title case DIRTY_SCRIPT cannot catch (src/dirty-script.ts says the README does), and that the plugin writes ${dirty} itself", () => {
    expect(closing).not.toBe("");
    expect(closing).toContain(".vscode/settings.json");
    expect(closing).toContain("`window.title`");
    expect(closing).toContain("${dirty}");
    expect(String(DIRTY_TITLE_SETTINGS["window.title"])).toContain("${dirty}");
  });

  it("the Closing bullet says what a tab that may hold another editor loses until it is reloaded", () => {
    for (const effect of ["never reads clean", "renamed file is not reloaded", "does not close the tab", "idle"]) expect(closing, effect).toContain(effect);
  });

  it("the Keys bullet says a file opens at the top when editor.lineNumbers is off", () => {
    expect(keys).toContain("at the definition's line");
    expect(keys).toContain("`editor.lineNumbers` off");
    expect(keys).toContain("top of the file");
  });
});
