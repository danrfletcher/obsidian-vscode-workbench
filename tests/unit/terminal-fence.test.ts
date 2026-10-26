import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../helpers";

const DIR = path.join(REPO_ROOT, "src/terminal");
const files = fs.readdirSync(DIR).filter((f) => /\.(ts|py)$/.test(f));
const sources = files.map((f) => [f, fs.readFileSync(path.join(DIR, f), "utf8")] as const);

describe("the terminal module's fences", () => {
  it("has source files to check", () => {
    expect(files).toEqual(expect.arrayContaining(["drawer-ui.ts", "pty-session.ts", "pty_helper.py", "xterm-view.ts", "feature.ts"]));
  });

  it("makes no network calls and has no telemetry (F5): no fetch, XMLHttpRequest or http in it", () => {
    for (const [file, text] of sources) expect(text, file).not.toMatch(/fetch|XMLHttpRequest|http/i);
  });

  it("opens no listening socket (F4): no net, dgram, http, tls or WebSocket, and no listen call on a server", () => {
    for (const [file, text] of sources) {
      expect(text, file).not.toMatch(/from\s+["'](?:node:)?(?:net|dgram|http2?|https|tls|ws)["']/);
      expect(text, file).not.toMatch(/require\(["'](?:node:)?(?:net|dgram|http2?|https|tls|ws)["']\)/);
      expect(text, file).not.toMatch(/WebSocket|createServer|\.listen\(\s*\d|import\s+socket|from\s+socket/);
    }
  });

  it("starts the helper with plain pipes on stdin and stdout and nothing else (F4)", () => {
    const session = fs.readFileSync(path.join(DIR, "pty-session.ts"), "utf8");
    expect(session).toMatch(/stdio:\s*\[\s*"pipe",\s*"pipe",\s*"pipe"\s*\]/);
    expect(session).not.toMatch(/"ipc"|shell:\s*true/);
  });

  it("brings in no native module (F9): the only third-party imports are xterm and its fit add-on, and no .node files", () => {
    const third = new Set<string>();
    for (const [, text] of sources) for (const m of text.matchAll(/from\s+["']([^."'][^"']*)["']/g)) if (!m[1].startsWith("node:")) third.add(m[1]);
    expect([...third].sort()).toEqual(["@xterm/addon-fit", "@xterm/xterm"]);
    for (const [file, text] of sources) expect(text, file).not.toMatch(/node-pty|\.node["']/);
  });
});
