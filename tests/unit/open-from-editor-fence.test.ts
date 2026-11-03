/**
 * PR-4's fences, the pattern of tests/unit/hotkey-fence.test.ts applied to the files this PR adds: no network connection or listener
 * of their own (F4), no editor or marketplace UI of our own and nothing written to VS Code's settings or profile (F1), no new
 * module (F9). The page scripts read the page and press seeded chords; they write nowhere.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../helpers";

const FILES = ["src/open-from-editor.ts", "src/open-intercept-script.ts", "src/goto-line-script.ts"];
const sources = FILES.map((f) => [f, fs.readFileSync(path.join(REPO_ROOT, f), "utf8")] as const);

describe("the files PR-4 adds", () => {
  it("open no socket and make no request (F4): no net, http, ws, fetch, XMLHttpRequest, WebSocket, beacon, listener", () => {
    for (const [file, text] of sources) {
      expect(text, file).not.toMatch(/from\s+["'](?:node:)?(?:net|dgram|http2?|https|tls|ws)["']/);
      expect(text, file).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|createServer|\.listen\s*\(/);
    }
  });

  it("import only the plugin's own modules: no third-party or native module, no child process, no file access", () => {
    for (const [file, text] of sources) {
      for (const m of text.matchAll(/from\s+["']([^"']+)["']/g)) expect(m[1], file).toMatch(/^\.\.?\//);
      expect(text, file).not.toMatch(/child_process|node:fs|require\(/);
    }
  });

  it("write nothing to VS Code's settings, profile or storage (F1): the page scripts read the DOM and press seeded chords", () => {
    for (const [file, text] of sources) {
      expect(text, file).not.toMatch(/indexedDB|localStorage|sessionStorage|document\.cookie|settings\.json|keybindings\.json|\.vscode/);
    }
  });

  it("add no editor of our own (F1): no Monaco, no CodeMirror, no element creation in the page", () => {
    for (const [file, text] of sources) {
      expect(text, file).not.toMatch(/monaco\.editor|monaco-editor\/esm|CodeMirror|createElement|innerHTML|insertAdjacent/);
    }
  });

  it("never show the tab strip (E7): nothing in them names a setting or an element of it", () => {
    for (const [file, text] of sources) expect(text, file).not.toMatch(/showTabs|tabs-and-actions-container|\.tabs-container/);
  });
});
