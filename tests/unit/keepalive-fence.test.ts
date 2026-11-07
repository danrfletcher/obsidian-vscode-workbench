/**
 * The fences of the terminal keep-alive (PR-6): F9 (no retry or backoff loop, no extra logging or telemetry), F3 (no second
 * server to count shells) and F1 (no terminal UI), as static scans of the new and the changed code, in the style of
 * terminal-host-fence.test.ts. Files that already held timers or logging before this PR (idle-timer.ts, main.ts, host-page.ts)
 * are checked by count and by the exact lines this PR added, not wholesale.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../helpers";

const read = (f: string) => fs.readFileSync(path.join(REPO_ROOT, f), "utf8");
/** Code without comments, so a doc comment that says "no retry" is not mistaken for one. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "");
const count = (text: string, re: RegExp) => [...text.matchAll(re)].length;

const KEEPALIVE = code(read("src/terminal-keepalive.ts"));
const IDLE = code(read("src/idle-timer.ts"));
const MAIN = code(read("src/main.ts"));
const HOST = code(read("src/terminal-host/host-page.ts"));
const UTILS = read("src/process-utils.ts");
/** The one function this PR added to process-utils.ts. */
const READER = code(UTILS.slice(UTILS.indexOf("export function readProcessTable"), UTILS.indexOf("export function commandLineOf")));
/** The lines of main.ts this PR added. */
const MAIN_LINES = MAIN.split("\n").filter((l) => /liveTerminalShell|hasLiveTerminalShell|processTable|stateChanged|readProcessTable/.test(l));

const TIMERS = /\bsetInterval\s*\(|\bsetTimeout\s*\(|\bsetImmediate\s*\(|requestAnimationFrame|queueMicrotask|\.unref\(/;
const LOGGING = /\bconsole\s*\.|\blogger\b|appendFile|writeFile|createWriteStream|\bopenSync\(|\.log\(|telemetry/i;
const NETWORK = /\bfetch\s*\(|XMLHttpRequest|WebSocket|createServer|\.listen\(|\bhttps?\.request|from\s+["'](?:node:)?(?:net|dgram|http2?|https|tls|ws)["']/;
const RETRY = /retry|retries|backoff|\battempt|\bwhile\s*\(|\bfor\s*\(\s*(?:let|;)|do\s*\{[\s\S]*?\}\s*while/i;

describe("F9: no retry or backoff loop", () => {
  it("scans the new and changed code", () => {
    expect(KEEPALIVE.length).toBeGreaterThan(200);
    expect(READER).toContain("execFile(");
    expect(MAIN_LINES.length).toBeGreaterThanOrEqual(4);
  });

  it("the keep-alive module and the process table reader start no timer and no loop, and wrap nothing in a retry", () => {
    for (const [name, text] of [["terminal-keepalive.ts", KEEPALIVE], ["readProcessTable", READER]] as const) {
      expect(text, name).not.toMatch(TIMERS);
      expect(text, name).not.toMatch(RETRY);
    }
  });

  it("the existing 5 second poll in IdleTimer.start() is the only interval, and the one countdown timer is the only timeout", () => {
    expect(count(IDLE, /\bsetInterval\s*\(/g)).toBe(1);
    expect(count(IDLE, /\bsetTimeout\s*\(/g)).toBe(1);
    expect(IDLE).toMatch(/this\.poller = setInterval\(\(\) => void this\.evaluate\(\), poll\);/);
    expect(IDLE).not.toMatch(RETRY);
    expect(IDLE).not.toMatch(LOGGING);
  });

  it("the lines main.ts and host-page.ts gained start no timer", () => {
    for (const l of MAIN_LINES) expect(l).not.toMatch(TIMERS);
    expect(count(HOST, /stateChanged/g)).toBe(2); // the call and its use
    for (const l of HOST.split("\n").filter((l) => /stateChanged/.test(l))) expect(l).not.toMatch(TIMERS);
  });

  it("one failed read is one answer: keepAlive catches the shell read once, returns true, and does not call it again", () => {
    const keepAlive = IDLE.slice(IDLE.indexOf("private async keepAlive"), IDLE.indexOf("private async fire"));
    expect(count(keepAlive, /liveTerminalShell\(\)/g)).toBe(1);
    expect(keepAlive).toMatch(/try \{\s*return await this\.deps\.liveTerminalShell\(\);\s*\} catch \{\s*return true;/);
  });
});

describe("F9: no extra logging or telemetry, no log file, no network call", () => {
  it("the keep-alive module and the reader have no console call, no log file, no telemetry and no network", () => {
    for (const [name, text] of [["terminal-keepalive.ts", KEEPALIVE], ["readProcessTable", READER]] as const) {
      expect(text, name).not.toMatch(LOGGING);
      expect(text, name).not.toMatch(NETWORK);
    }
  });

  it("the lines main.ts and host-page.ts gained log nothing", () => {
    for (const l of MAIN_LINES) expect(l).not.toMatch(LOGGING);
    for (const l of HOST.split("\n").filter((l) => /stateChanged/.test(l))) expect(l).not.toMatch(LOGGING);
  });

  it("the keep-alive module imports only the process helpers", () => {
    const imports = [...KEEPALIVE.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(imports).toEqual(["./process-utils"]);
  });
});

describe("F3: no second server is started to count shells", () => {
  it("the keep-alive module starts no process and names no server", () => {
    expect(KEEPALIVE).not.toMatch(/child_process|\bspawn\(|(?<![.\w])exec\(|\bexecFile|serve-web|ServerManager|WorkbenchServer|ensureServer/);
  });

  it("the reader runs only `ps`, once per call", () => {
    expect(count(READER, /execFile\(/g)).toBe(1);
    expect(READER).toMatch(/execFile\("ps", \["-A", "-ww", "-o", "pid=,ppid=,command="\]/);
  });

  it("main.ts makes one ServerManager, and the shell check reads that manager's server pid", () => {
    expect(count(MAIN, /new ServerManager\(/g)).toBe(1);
    expect(MAIN).toMatch(/hasLiveTerminalShell\(this\.manager\.serverInstance\?\.pid,/);
  });

  it("nothing else in src/ reads the process table for shells", () => {
    const users = fs
      .readdirSync(path.join(REPO_ROOT, "src"), { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => /readProcessTable|liveShellPids|hasLiveTerminalShell|--type=ptyHost/.test(read(path.join("src", f))))
      .sort();
    expect(users).toEqual(["main.ts", "process-utils.ts", "terminal-keepalive.ts"]);
  });
});

describe("F1: no terminal UI appears", () => {
  it("no status bar item, tab list, kill button or shell count is drawn by this PR's code", () => {
    for (const [name, text] of [["terminal-keepalive.ts", KEEPALIVE], ["main.ts lines", MAIN_LINES.join("\n")]] as const) {
      expect(text, name).not.toMatch(/addStatusBarItem|createEl\(|createElement\(|\.textContent|setText\(|Setting\(|\bkill\b/);
    }
  });

  it("the plugin as a whole still has no status bar item (G11 is retired) and no shell count in settings", () => {
    expect(MAIN).not.toMatch(/addStatusBarItem/);
    for (const f of fs.readdirSync(path.join(REPO_ROOT, "src/settings"))) {
      expect(code(read(path.join("src/settings", f))), f).not.toMatch(/shell count|liveShell|hasLiveTerminalShell|liveTerminalShell/i);
    }
  });
});
