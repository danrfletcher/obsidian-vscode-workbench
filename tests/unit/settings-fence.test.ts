/**
 * The Extensions list's fences, by scanning the files it is made of (as hotkey-fence.test.ts does for the hotkey
 * bridge): F2 no control and no mutating wording, F5 no workbench UI and the chrome stays hidden, F6 no publisher
 * special-casing or rewriting, and read-only access (F1, F7).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { writeMachineSettings } from "../../src/settings";
import { LIST_FAILED, LIST_INTRO, LIST_LOADING, SERVER_NOT_RUNNING } from "../../src/settings/extensions-section";
import { ACTIVE_REASON, DISABLED_REASON, INACTIVE_REASON, NO_LOG_NOTE, NO_REASON_IN_LOG, STATE_LABEL, UNTRUSTED_REASON } from "../../src/settings/extension-states";
import { REPO_ROOT, tempDir } from "../helpers";

const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
/** The three files this feature adds, plus the list builder. */
const LIST_FILES = ["src/settings/extension-states.ts", "src/settings/extension-list.ts", "src/settings/exthost-log.ts"];
const sources = LIST_FILES.map((f) => [f, read(f)] as const);
/** Code with comments removed, so a sentence that explains a fence does not trip it. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("F2: the section only reports", () => {
  it("adds no Setting, button, toggle, dropdown, text field or event listener of its own", () => {
    for (const [file, text] of sources) expect(code(text), file).not.toMatch(/new\s+Setting\b|addButton|addToggle|addDropdown|addText|addEventListener|createEl\(\s*["'](?:button|input|a|select)["']|onClick|setButtonText/);
    const section = code(read("src/settings/extensions-section.ts"));
    expect(section).not.toMatch(/new\s+Setting\b|addButton|addToggle|addDropdown|addText|addEventListener|createEl\(\s*["'](?:button|input|a|select)["']|onClick|setButtonText/);
  });

  it("the words the list shows name no install, update, uninstall, enable, disable or marketplace action", () => {
    const words = [LIST_INTRO, LIST_LOADING, LIST_FAILED, SERVER_NOT_RUNNING, DISABLED_REASON, UNTRUSTED_REASON, ACTIVE_REASON, INACTIVE_REASON, NO_LOG_NOTE, NO_REASON_IN_LOG, ...Object.values(STATE_LABEL)];
    for (const w of words) {
      expect(w, w).not.toMatch(/\b(?:install|uninstall|update|enable|re-enable|marketplace|click|toggle|remove)\b/i);
      // "disabled in VS Code" is a state, not an action: nothing in the text tells the user to disable anything
      expect(w, w).not.toMatch(/\bdisable\b/i);
    }
    expect(words.length).toBeGreaterThan(10);
  });

  it("the only action the section mentions is Restart server, which the tab already has", () => {
    expect(LIST_INTRO).toBe("Changes made in desktop VS Code show here after Restart server.");
    expect(DISABLED_REASON).toContain("Restart server");
  });
});

describe("F5: no workbench UI for this feature, and the chrome stays hidden", () => {
  it("the list files reach nothing in the workbench: no webview, view, command, status-bar or activity-bar code", () => {
    for (const [file, text] of sources) {
      expect(code(text), file).not.toMatch(/iframe|webview|registerView|addCommand|addStatusBarItem|addRibbonIcon|statusBar|activityBar|workbench\.(?:activityBar|statusBar)/i);
    }
  });

  it("writeMachineSettings still writes activityBar hidden and statusBar not visible", () => {
    const s = JSON.parse(fs.readFileSync(writeMachineSettings(tempDir(), { dark: true }), "utf8")) as Record<string, unknown>;
    expect(s["workbench.activityBar.location"]).toBe("hidden");
    expect(s["workbench.statusBar.visible"]).toBe(false);
  });

  it("only the settings files and main.ts (the host that feeds the settings tab) mention the list: it has one surface", () => {
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".ts") && /extension-states|exthost-log|extension-list/.test(fs.readFileSync(p, "utf8"))) hits.push(path.relative(REPO_ROOT, p));
      }
    };
    walk(path.join(REPO_ROOT, "src"));
    expect(hits.sort()).toEqual(["src/main.ts", "src/settings/extension-list.ts", "src/settings/extension-states.ts", "src/settings/extensions-section.ts", "src/settings/exthost-log.ts", "src/settings/settings-tab.ts"]);
  });
});

describe("F6: Microsoft publisher ids are only reported", () => {
  it("no list file names a publisher, an id prefix or a vendor, and none edits product.json or the gallery", () => {
    for (const [file, text] of sources) {
      expect(code(text), file).not.toMatch(/ms-|microsoft|vscode\.|pylance|cpptools|publisher|extensionsGallery|product\.json|serviceUrl/i);
    }
  });

  it("no id is rewritten: the row's id is the profile's own identifier, and the reason is the log's words", () => {
    const list = code(read("src/settings/extension-list.ts"));
    expect(list).not.toMatch(/\.replace\(|\.id\s*=[^=]/);
  });
});

describe("read-only access (F1, F7)", () => {
  it("the list files open nothing for writing and start no timer or watcher", () => {
    for (const [file, text] of sources) {
      const c = code(text);
      expect(c, file).not.toMatch(/writeFile|appendFile|createWriteStream|mkdir|rmSync|\brm\(|unlink|symlink|rename|copyFile|truncate|chmod|utimes/);
      expect(c, file).not.toMatch(/fs\.watch|watchFile|chokidar|setInterval|setTimeout|child_process|sqlite|fetch\s*\(|node:(?:net|http|https)/);
      // every open is a read
      for (const m of c.matchAll(/\.open\(\s*[^,)]+,\s*["']([^"']+)["']/g)) expect(m[1], file).toBe("r");
    }
  });

  it("keeps no state between calls: no module-level mutable variable in the list files", () => {
    for (const [file, text] of sources) expect(code(text), file).not.toMatch(/^(?:let|var)\s/m);
  });

  it("the plugin writes the list nowhere: main.ts's extensionRows only calls buildExtensionList", () => {
    const main = read("src/main.ts");
    const body = main.slice(main.indexOf("extensionRows()"));
    const method = body.slice(0, body.indexOf("\n  }\n"));
    expect(method).toContain("buildExtensionList(");
    expect(method).not.toMatch(/write|save|mkdir|rm|unlink/i);
  });
});
