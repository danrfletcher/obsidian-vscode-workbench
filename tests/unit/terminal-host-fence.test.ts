import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../helpers";

const DIR = path.join(REPO_ROOT, "src/terminal-host");
const files = fs.readdirSync(DIR).filter((f) => /\.ts$/.test(f));
const sources = files.map((f) => [f, fs.readFileSync(path.join(DIR, f), "utf8")] as const);
/** Code without comments, so a doc comment that says "no tab" is not mistaken for drawing one. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the terminal host's fences", () => {
  it("has source files to check", () => {
    expect(files).toEqual(expect.arrayContaining(["host-state.ts", "host-page.ts", "host-url.ts", "panel-only.ts"]));
  });

  it("brings in no xterm and no other third-party module (F1): every import is relative or node:", () => {
    for (const [file, text] of sources) {
      for (const m of text.matchAll(/from\s+["']([^"']+)["']/g)) expect(m[1].startsWith(".") || m[1].startsWith("node:"), `${file}: ${m[1]}`).toBe(true);
      expect(text, file).not.toMatch(/xterm/i);
    }
  });

  it("imports nothing from the old drawer, which PR-4 removes (src/terminal/)", () => {
    for (const [file, text] of sources) expect(text, file).not.toMatch(/from\s+["'](?:\.\.\/)+terminal\/|from\s+["']\.\.\/terminal["']/);
  });

  it("draws no terminal tab, list or kill control (F1): the only controls are Retry and Dismiss", () => {
    for (const [file, text] of sources) {
      const c = code(text);
      expect(c, file).not.toMatch(/vscw-|\btabs?\b|tablist|terminal-list|kill|trash|New terminal|Close terminal/i);
    }
    const page = code(fs.readFileSync(path.join(DIR, "host-page.ts"), "utf8"));
    const buttons = [...page.matchAll(/createElement\("button"\)[\s\S]{0,80}?textContent = "([^"]+)"/g)].map((m) => m[1]).sort();
    expect(buttons).toEqual(["Dismiss", "Retry"]);
  });

  it("makes no network call and opens no socket of its own (the page loads from the server the plugin already owns)", () => {
    for (const [file, text] of sources) {
      const c = code(text);
      expect(c, file).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|createServer|\.listen\(|from\s+["'](?:node:)?(?:net|dgram|http2?|https|tls|ws)["']/);
    }
  });

  it("spawns no process and starts no server: it asks the plugin's shared start (F3)", () => {
    for (const [file, text] of sources) expect(code(text), file).not.toMatch(/child_process|\bspawn\(|\bexec\(|serve-web/);
  });

  it("puts no token in a script or log: no connection token is read into a string that is logged or executed", () => {
    const page = code(fs.readFileSync(path.join(DIR, "host-page.ts"), "utf8"));
    expect(page).not.toMatch(/console\.\w+\([^)]*token/);
    expect(page).not.toMatch(/executeJavaScript\([^)]*token/);
    // the token is used in one place: the page's URL
    expect([...page.matchAll(/server\.token/g)]).toHaveLength(1);
  });

  it("the layout probe the page is asked reads sizes only", () => {
    const text = code(fs.readFileSync(path.join(DIR, "panel-only.ts"), "utf8"));
    expect(text).not.toMatch(/localStorage|indexedDB|document\.cookie|\.click\(|dispatchEvent|\.value\s*=/);
  });
});
