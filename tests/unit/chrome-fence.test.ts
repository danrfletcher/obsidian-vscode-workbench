/**
 * Fences of the editor-only tab (PR-2): no way back to the full workbench (F6), the terminal drawer's own page stays apart
 * from the Code tab's hiding (F2), and the hiding code makes no network request (F1). Grep-style, over the source text.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, dataObject, readSettings } from "../../src/settings/data";
import { REPO_ROOT } from "../helpers";

const src = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, "src", rel), "utf8");
const code = (rel: string) => src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const files = (dir: string) => fs.readdirSync(path.join(REPO_ROOT, "src", dir)).filter((f) => f.endsWith(".ts")).map((f) => `${dir}/${f}`);

describe("F6: nothing registers a way to see the full workbench", () => {
  // Words that would name such a switch, in a setting, a command, a hotkey or a data.json key.
  const WAY_BACK = /show\s*workbench|full\s*workbench|show\s*chrome|show\s*side\s*bar|show\s*(the\s*)?status\s*bar|toggle\s*chrome|reveal\s*workbench/i;

  it.each(["main.ts", "settings/settings-tab.ts", "settings/data.ts"])("src/%s names no setting, command or hotkey that shows it", (rel) => {
    expect(code(rel)).not.toMatch(WAY_BACK);
  });

  it("every command id and name main.ts registers is on a list written out here (a new one must be looked at)", () => {
    const text = code("main.ts");
    const ids = [...text.matchAll(/\bid:\s*"([^"]+)"/g)].map((m) => m[1]).sort();
    expect(ids).toEqual(expect.arrayContaining(["open-spike-file", "toggle-terminal-drawer"]));
    for (const id of ids) expect(id, id).not.toMatch(/chrome|workbench-full|show-workbench|sidebar|side-bar|explorer/i);
  });

  it("the settings tab adds no toggle for the chrome: its settings are the ones data.ts reads", () => {
    expect(Object.keys(DEFAULT_SETTINGS).sort()).toEqual(["customCliPath", "excludeExtensions", "instanceId", "nonCodeDrawer", "stablePort", "trustVaultFolder"]);
    expect(code("settings/settings-tab.ts")).not.toMatch(/chromeSettings|CHROME_SURFACES|chrome-settings|chrome-script/);
  });

  it("a hand-written data.json key like showWorkbench: true is ignored: it changes no setting, and the overlay does not read data.json", () => {
    const raw = { showWorkbench: true, showChrome: true, fullWorkbench: true, chrome: "visible", nonCodeDrawer: false };
    expect(readSettings(raw)).toEqual({ ...DEFAULT_SETTINGS, nonCodeDrawer: false });
    // kept as it was on the next save (the file is the user's), but nothing in the source reads such a key
    expect(dataObject(raw)).toMatchObject({ showWorkbench: true });
    for (const rel of ["main.ts", "settings.ts", "chrome-settings.ts", "chrome-script.ts", "code-view.ts"]) {
      expect(code(rel), rel).not.toMatch(/showWorkbench|showChrome|fullWorkbench/);
    }
  });
});

describe("F2: the terminal drawer and its host page do not import the Code tab's hiding", () => {
  it.each([...files("terminal"), ...files("terminal-host")])("src/%s imports neither chrome-settings nor chrome-script", (rel) => {
    expect(code(rel)).not.toMatch(/from\s+["'][^"']*chrome-(settings|script)["']/);
  });
});

describe("F1: the hiding code makes no network request", () => {
  it.each(["chrome-settings.ts", "chrome-script.ts"])("src/%s has no network API and no outside address", (rel) => {
    expect(code(rel)).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|node:https?|node:net|require\(["']https?["']\)/);
    expect(code(rel)).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/);
  });
});
