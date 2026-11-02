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

  it("imports nothing from the old drawer, which is gone (the files left in src/terminal/ are the new drawer's)", () => {
    for (const [file, text] of sources) expect(text, file).not.toMatch(/from\s+["'](?:\.\.\/)+terminal\/|from\s+["']\.\.\/terminal["']/);
  });

  it("draws no terminal tab, list or kill control (F1): the only controls are Retry, Dismiss and the crash banner's Restart", () => {
    for (const [file, text] of sources) {
      const c = code(text);
      expect(c, file).not.toMatch(/vscw-|\btabs?\b|tablist|terminal-list|kill|trash|New terminal|Close terminal/i);
    }
    const page = code(fs.readFileSync(path.join(DIR, "host-page.ts"), "utf8"));
    const buttons = [...page.matchAll(/createElement\("button"\)[\s\S]{0,80}?textContent = "([^"]+)"/g)].map((m) => m[1]).sort();
    expect(buttons).toEqual(["Dismiss", "Restart", "Retry"]);
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

  it("sends the page no key press and no click: the layout is made by the extension's commands, not by input events", () => {
    for (const [file, text] of sources) expect(code(text), file).not.toMatch(/sendInputEvent|\bkeyDown\b|\bkeyUp\b|mouseDown|mouseUp|missingSteps/);
  });

  it("the layout probe the page is asked reads sizes only", () => {
    const text = code(fs.readFileSync(path.join(DIR, "panel-only.ts"), "utf8"));
    expect(text).not.toMatch(/localStorage|indexedDB|document\.cookie|\.click\(|dispatchEvent|\.value\s*=/);
  });

  // "New terminal at folder" (PR-5): the new files in src/terminal-host/ are already covered by the checks above; these add its own.
  const NEW_FILES = ["new-terminal.ts", "terminal-at-extension.ts", "terminal-folder-target.ts"].map((f) => path.join("src/terminal-host", f)).concat("src/terminal/new-terminal-menu.ts");
  const newCode = NEW_FILES.map((f) => [f, code(fs.readFileSync(path.join(REPO_ROOT, f), "utf8"))] as const);

  it("PR-5: the new files exist and are all checked", () => {
    expect(newCode).toHaveLength(4);
    for (const [, text] of newCode) expect(text.length).toBeGreaterThan(0);
  });

  it("PR-5 F1/F4: the new files bring in no xterm, make no network call, open no socket and spawn nothing", () => {
    for (const [file, text] of newCode) {
      expect(text, file).not.toMatch(/xterm|python3|\bfetch\(|XMLHttpRequest|WebSocket|createServer|\.listen\(|child_process|\bspawn\(|\bexec\(/);
      expect(text, file).not.toMatch(/from\s+[\"'](?:node:)?(?:net|dgram|http2?|https|tls|ws)[\"']/);
    }
  });

  it("PR-5 G8: no `cd` and no text is sent to a shell: the folder goes as the command's cwd argument", () => {
    for (const [file, text] of newCode) expect(text, file).not.toMatch(/\bcd\s|sendText|sendSequence|\bpwd\b/);
    const ext = newCode.find(([f]) => f.endsWith("terminal-at-extension.ts"))![1];
    expect(ext).toMatch(/executeCommand\(\$\{JSON\.stringify\(NEW_WITH_CWD_COMMAND\)\}, \{ cwd: req\.cwd \}\)/);
  });

  it("PR-5 F9: no retry or backoff loop and no logging in the new files", () => {
    for (const [file, text] of newCode) expect(text, file).not.toMatch(/console\.|setInterval|setTimeout\(\w+,\s*\w*[Rr]etry|backoff|retry|\bwhile\s*\(|\bfor\s*\(let i\b/i);
    const ext = newCode.find(([f]) => f.endsWith("terminal-at-extension.ts"))![1];
    // each panel-only command is asked once: it is in a try/catch, not in a loop
    expect(ext).toMatch(/const runCommand = async \(command\) => \{\s*try \{ await vscode\.commands\.executeCommand\(command\); \} catch/);
  });

  it("PR-5 F6: the only place the request code writes to is under the server data dir it is given", () => {
    for (const [file, text] of newCode) {
      expect(text, file).not.toMatch(/Library\/Application Support|\.vscode|homedir\(\)|os\.homedir|process\.env\.HOME/);
    }
  });
});
