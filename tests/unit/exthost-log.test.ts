import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_HOSTS, TAIL_BYTES, parseExtHostLog, readExtHostLog, realLogFs, type LogFs } from "../../src/settings/exthost-log";
import { ALL_IDS, IDS, logText } from "../fixtures/extensions-section/tree";
import { tempDir } from "../helpers";

const ids = (...list: string[]) => new Set(list.map((i) => i.toLowerCase()));
const ALL = ids(...ALL_IDS);
const stamp = (n: number) => `2026-10-28 09:00:${String(n % 60).padStart(2, "0")}.000`;

describe("parseExtHostLog", () => {
  it("activated: a _doActivateExtension line is active, whatever the case of the id in the log", () => {
    const facts = parseExtHostLog(logText("healthy"), ALL);
    expect(facts.get("chakrounanas.turbo-console-log")).toEqual({ kind: "active" });
    expect(facts.get("esbenp.prettier-vscode")).toEqual({ kind: "active" });
    expect(facts.get("ms-python.python")).toEqual({ kind: "active" });
    expect(facts.get("redhat.vscode-yaml")).toEqual({ kind: "active" });
    expect(facts.size).toBe(4);
  });

  it("activation error: the error line's message after \"failed due to an error:\" is the reason, stack lines left out", () => {
    const facts = parseExtHostLog(logText("failing"), ALL);
    expect(facts.get("ms-python.vscode-pylance")).toEqual({ kind: "failed", reason: "Error: Pylance can only be used with Microsoft's own builds of VS Code." });
  });

  it("an error line that names the extension and carries its message: that message is the reason", () => {
    const facts = parseExtHostLog(logText("failing"), ALL);
    expect(facts.get("ms-vscode.cpptools")).toEqual({
      kind: "failed",
      reason: "ms-vscode.cpptools: Error: The C/C++ extension may be used only with Microsoft Visual Studio, Visual Studio Code and successor Microsoft products.",
    });
  });

  it("a failure that gives no message: failed with a null reason", () => {
    const facts = parseExtHostLog(logText("failing"), ALL);
    expect(facts.get("dbaeumer.vscode-eslint")).toEqual({ kind: "failed", reason: null });
  });

  it("an error with the message in continuation lines of the same record", () => {
    const text = `${stamp(1)} [error] Activating extension esbenp.prettier-vscode failed due to an error:\nTypeError: x is not a function\n    at foo (bar.js:1:1)\n`;
    expect(parseExtHostLog(text, ALL).get("esbenp.prettier-vscode")).toEqual({ kind: "failed", reason: "TypeError: x is not a function" });
  });

  it("a non-generic error head is the reason on its own, with the id and without the trailing colon", () => {
    const text = `${stamp(1)} [error] Extension 'eamodio.gitlens' threw while starting:\n`;
    expect(parseExtHostLog(text, ALL).get("eamodio.gitlens")).toEqual({ kind: "failed", reason: "Extension 'eamodio.gitlens' threw while starting" });
  });

  it("no line about an extension: it is absent from the result", () => {
    const facts = parseExtHostLog(logText("healthy"), ALL);
    expect(facts.has("eamodio.gitlens")).toBe(false);
    expect(facts.has("ms-vscode.cpptools")).toBe(false);
  });

  it("an id that is not in the asked-for set is ignored, in activation and in error lines", () => {
    const facts = parseExtHostLog(logText("failing"), ids(IDS.turbo));
    expect([...facts.keys()]).toEqual(["chakrounanas.turbo-console-log"]);
    expect(parseExtHostLog(logText("failing"), ids("some.unshared-extension")).get("some.unshared-extension")).toEqual({
      kind: "failed",
      reason: "Error: this extension is not in the shared set",
    });
    expect(parseExtHostLog(logText("failing"), new Set()).size).toBe(0);
  });

  it("ids match case-insensitively in both directions", () => {
    const text = `${stamp(1)} [info] ExtensionService#_doActivateExtension CHAKROUNANAS.TURBO-CONSOLE-LOG, startup: false, activationEvent: '*'\n`;
    expect(parseExtHostLog(text, new Set(["ChakrounAnas.turbo-console-log"])).get("chakrounanas.turbo-console-log")).toEqual({ kind: "active" });
    const err = `${stamp(2)} [error] MS-Python.Python crashed\n`;
    expect(parseExtHostLog(err, ids("ms-python.python")).get("ms-python.python")).toEqual({ kind: "failed", reason: "MS-Python.Python crashed" });
  });

  it("an id that only appears inside a longer name or path is not the extension", () => {
    const text = [
      `${stamp(1)} [error] Cannot read /ext/ms-python.python-2026.10.0/out/x.js`,
      `${stamp(2)} [error] something about ms-python.python-debugger`,
      `${stamp(3)} [error] ms-python.pythonic exploded`,
    ].join("\n");
    expect(parseExtHostLog(text, ids("ms-python.python")).size).toBe(0);
  });

  it("only [error] records fail an extension: an info or warning line that names it does not", () => {
    const text = [`${stamp(1)} [info] ms-python.python says hello`, `${stamp(2)} [warning] ms-python.python is slow`, `${stamp(3)} [trace] ms-python.python`].join("\n");
    expect(parseExtHostLog(text, ids("ms-python.python")).size).toBe(0);
  });

  it("the latest line decides: an activation after a failure is active, a failure after an activation is failed", () => {
    const failThenOk = [`${stamp(1)} [error] ms-python.python failed`, `${stamp(2)} [info] ExtensionService#_doActivateExtension ms-python.python, startup: false`].join("\n");
    expect(parseExtHostLog(failThenOk, ids("ms-python.python")).get("ms-python.python")).toEqual({ kind: "active" });
    const okThenFail = [`${stamp(1)} [info] ExtensionService#_doActivateExtension ms-python.python, startup: false`, `${stamp(2)} [error] ms-python.python failed`].join("\n");
    expect(parseExtHostLog(okThenFail, ids("ms-python.python")).get("ms-python.python")).toEqual({ kind: "failed", reason: "ms-python.python failed" });
  });

  it("truncated and garbage lines: skipped, and the good lines around them still count", () => {
    const text = [
      "xtensionService#_doActivateExtension ms-python.python, startup: false", // the start of the log was cut off
      "\u0000\u0001\u0002 binary garbage ￿",
      "2026-10-28 09:00:0", // cut mid-timestamp
      `${stamp(5)} [info] ExtensionService#_doActivateExtension esbenp.prettier-vscode, startup: false`,
      "{\"json\": \"line\"}",
      `${stamp(6)} [info] ExtensionService#_doActivateExtension`, // cut mid-line: no id
      `${stamp(7)} [info] ExtensionService#_doActivateExtension redhat.vscode-yaml, sta`, // cut after the id
    ].join("\n");
    const facts = parseExtHostLog(text, ALL);
    expect([...facts.keys()].sort()).toEqual(["esbenp.prettier-vscode", "redhat.vscode-yaml"]);
  });

  it("empty and whitespace-only text give no facts and do not throw", () => {
    expect(parseExtHostLog("", ALL).size).toBe(0);
    expect(parseExtHostLog("\n\n   \n", ALL).size).toBe(0);
  });

  it("CRLF and bare CR line endings read the same as LF", () => {
    const lf = logText("failing");
    const crlf = lf.replace(/\n/g, "\r\n");
    const cr = lf.replace(/\n/g, "\r");
    const base = parseExtHostLog(lf, ALL);
    expect(parseExtHostLog(crlf, ALL)).toEqual(base);
    expect(parseExtHostLog(cr, ALL)).toEqual(base);
    expect(base.size).toBeGreaterThan(3);
    for (const f of base.values()) if (f.kind === "failed" && f.reason) expect(f.reason).not.toMatch(/[\r\n]/);
  });

  it("a reason is plain and capped: markup stays as text, control characters go, and a long one ends in an ellipsis", () => {
    const text = `${stamp(1)} [error] ms-python.python: <script>alert(1)</script>\u001b[31m ${"x".repeat(400)}\n`;
    const f = parseExtHostLog(text, ids("ms-python.python")).get("ms-python.python");
    expect(f?.kind).toBe("failed");
    const reason = (f as { reason: string }).reason;
    expect(reason.startsWith("ms-python.python: <script>alert(1)</script> [31m x")).toBe(true);
    expect(reason.endsWith("…")).toBe(true);
    expect(Array.from(reason).length).toBe(200);
    expect(reason).not.toContain("\u001b");
  });

  it("the plugin adds no home-directory text of its own to a reason: the reason is the log's words only", () => {
    const f = parseExtHostLog(`${stamp(1)} [error] ms-python.python failed to start\n`, ids("ms-python.python")).get("ms-python.python");
    expect((f as { reason: string }).reason).toBe("ms-python.python failed to start");
  });
});

/** A server data dir with a log tree. */
function logTree(runs: Record<string, Record<string, string | null>>): string {
  const dir = tempDir("exthost-log-");
  for (const [run, hosts] of Object.entries(runs)) {
    for (const [host, text] of Object.entries(hosts)) {
      const file = path.join(dir, "data", "logs", run, host, "remoteexthost.log");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (text !== null) fs.writeFileSync(file, text);
    }
  }
  return dir;
}

describe("readExtHostLog", () => {
  it("reads the host log of the server's run", async () => {
    const dir = logTree({ "20261028T090000": { exthost1: logText("healthy") } });
    const r = await readExtHostLog(dir, ALL);
    expect(r.found).toBe(true);
    if (r.found) expect(r.facts.get("chakrounanas.turbo-console-log")).toEqual({ kind: "active" });
  });

  it("no logs folder, an empty one, a run with no host, or a host with no log file: found is false", async () => {
    expect(await readExtHostLog(tempDir("exthost-log-"), ALL)).toEqual({ found: false });
    const empty = tempDir("exthost-log-");
    fs.mkdirSync(path.join(empty, "data", "logs"), { recursive: true });
    expect(await readExtHostLog(empty, ALL)).toEqual({ found: false });
    const noHost = tempDir("exthost-log-");
    fs.mkdirSync(path.join(noHost, "data", "logs", "20261028T090000"), { recursive: true });
    expect(await readExtHostLog(noHost, ALL)).toEqual({ found: false });
    const noFile = logTree({ "20261028T090000": { exthost1: null } });
    expect(await readExtHostLog(noFile, ALL)).toEqual({ found: false });
  });

  it("an empty or whitespace-only log is found: false, not an error", async () => {
    expect(await readExtHostLog(logTree({ r1: { exthost1: logText("empty") } }), ALL)).toEqual({ found: false });
    expect(await readExtHostLog(logTree({ r1: { exthost1: "\n \n" } }), ALL)).toEqual({ found: false });
  });

  it("an unreadable log (a folder where the file should be, or a file where the logs folder should be) is found: false", async () => {
    const dir = tempDir("exthost-log-");
    fs.mkdirSync(path.join(dir, "data", "logs", "r1", "exthost1", "remoteexthost.log"), { recursive: true });
    expect(await readExtHostLog(dir, ALL)).toEqual({ found: false });
    const file = tempDir("exthost-log-");
    fs.mkdirSync(path.join(file, "data"), { recursive: true });
    fs.writeFileSync(path.join(file, "data", "logs"), "not a folder");
    expect(await readExtHostLog(file, ALL)).toEqual({ found: false });
  });

  it("a log that was rotated away (the file gone after the folder was listed) is found: false", async () => {
    const dir = logTree({ r1: { exthost1: logText("healthy") } });
    const gone: LogFs = { list: realLogFs.list, tail: async () => null };
    expect(await readExtHostLog(dir, ALL, { fs: gone })).toEqual({ found: false });
  });

  it("a file system that throws gives found: false", async () => {
    const boom: LogFs = {
      list: async () => {
        throw new Error("EIO");
      },
      tail: async () => {
        throw new Error("EIO");
      },
    };
    expect(await readExtHostLog("/x", ALL, { fs: boom })).toEqual({ found: false });
  });

  it("only the newest run is read: a failure from an earlier server run never survives (a stale reason does not come back)", async () => {
    const dir = logTree({
      "20261028T080000": { exthost1: logText("failing") },
      "20261028T090000": { exthost1: logText("healthy") },
    });
    const r = await readExtHostLog(dir, ALL);
    expect(r.found && r.facts.get("ms-vscode.cpptools")).toBeFalsy();
    expect(r.found && r.facts.get("chakrounanas.turbo-console-log")).toEqual({ kind: "active" });
    // and a newest run that has no log yet is not filled in from the old one
    const fresh = logTree({ "20261028T080000": { exthost1: logText("failing") }, "20261028T100000": {} });
    fs.mkdirSync(path.join(fresh, "data", "logs", "20261028T100000"), { recursive: true });
    expect(await readExtHostLog(fresh, ALL)).toEqual({ found: false });
  });

  it("merges the hosts of the run: a failure in any host stands over an activation in another", async () => {
    const dir = logTree({ r1: { exthost1: logText("healthy"), exthost2: logText("failing") } });
    const r = await readExtHostLog(dir, ALL);
    expect(r.found).toBe(true);
    if (!r.found) return;
    expect(r.facts.get("chakrounanas.turbo-console-log")).toEqual({ kind: "active" });
    expect(r.facts.get("esbenp.prettier-vscode")).toEqual({ kind: "active" });
    expect(r.facts.get("ms-vscode.cpptools")?.kind).toBe("failed");
    const both = logTree({
      r1: {
        exthost1: `${stamp(1)} [info] ExtensionService#_doActivateExtension ms-python.python, startup: false\n`,
        exthost2: `${stamp(2)} [error] ms-python.python failed\n`,
      },
    });
    const m = await readExtHostLog(both, ids("ms-python.python"));
    expect(m.found && m.facts.get("ms-python.python")).toEqual({ kind: "failed", reason: "ms-python.python failed" });
  });

  it("reads at most the newest MAX_HOSTS hosts, numbered by their number rather than their text (exthost10 is newer than exthost9)", async () => {
    const hosts: Record<string, string> = {};
    for (let i = 1; i <= 12; i++) hosts[`exthost${i}`] = `${stamp(i)} [info] ExtensionService#_doActivateExtension pub.ext${i}, startup: false\n`;
    const dir = logTree({ r1: hosts });
    const r = await readExtHostLog(dir, new Set(Array.from({ length: 12 }, (_, i) => `pub.ext${i + 1}`)));
    expect(r.found).toBe(true);
    if (!r.found) return;
    expect(r.facts.size).toBe(MAX_HOSTS);
    expect(r.facts.has("pub.ext12")).toBe(true);
    expect(r.facts.has("pub.ext5")).toBe(true);
    expect(r.facts.has("pub.ext4")).toBe(false);
  });

  it("huge file: only the tail is read, and the cut line is dropped", async () => {
    const early = `${stamp(1)} [info] ExtensionService#_doActivateExtension esbenp.prettier-vscode, startup: false\n`;
    const filler = `${stamp(2)} [info] ${"padding ".repeat(20)}\n`;
    const late = `${stamp(3)} [info] ExtensionService#_doActivateExtension ChakrounAnas.turbo-console-log, startup: false\n`;
    const body = early + filler.repeat(Math.ceil((TAIL_BYTES * 3) / filler.length)) + late;
    const dir = logTree({ r1: { exthost1: body } });
    expect(fs.statSync(path.join(dir, "data/logs/r1/exthost1/remoteexthost.log")).size).toBeGreaterThan(TAIL_BYTES * 3);
    const r = await readExtHostLog(dir, ALL);
    expect(r.found).toBe(true);
    if (!r.found) return;
    expect(r.facts.get("chakrounanas.turbo-console-log")).toEqual({ kind: "active" }); // in the tail
    expect(r.facts.has("esbenp.prettier-vscode")).toBe(false); // before the tail: never read
  });

  it("the real tail reader returns at most the asked bytes and starts at a line start", async () => {
    const dir = tempDir("exthost-log-");
    const file = path.join(dir, "x.log");
    fs.writeFileSync(file, "aaaa\nbbbb\ncccc\n");
    expect(await realLogFs.tail(file, 1000)).toBe("aaaa\nbbbb\ncccc\n");
    expect(await realLogFs.tail(file, 7)).toBe("cccc\n"); // cut inside "bbbb": that line is dropped
    expect(await realLogFs.tail(file, 3)).toBe(""); // cut inside the only line left: nothing whole
    expect(await realLogFs.tail(path.join(dir, "missing.log"), 10)).toBeNull();
    fs.writeFileSync(file, "");
    expect(await realLogFs.tail(file, 10)).toBe("");
  });

  it("asks the file system for no more than TAIL_BYTES by default, and for what it is told when given a size", async () => {
    const asked: number[] = [];
    const spy: LogFs = {
      list: async (d) => (d.endsWith("logs") ? ["r1"] : d.endsWith("r1") ? ["exthost1"] : null),
      tail: async (_f, n) => {
        asked.push(n);
        return "";
      },
    };
    await readExtHostLog("/x", ALL, { fs: spy });
    await readExtHostLog("/x", ALL, { fs: spy, tailBytes: 123 });
    expect(asked).toEqual([TAIL_BYTES, 123]);
    expect(TAIL_BYTES).toBeLessThanOrEqual(1024 * 1024);
  });

  it("ignores dot-folders and non-host folders in the run", async () => {
    const dir = logTree({ r1: { exthost1: logText("healthy"), "agent-host": logText("failing") } });
    fs.mkdirSync(path.join(dir, "data", "logs", ".hidden", "exthost1"), { recursive: true });
    fs.writeFileSync(path.join(dir, "data", "logs", ".hidden", "exthost1", "remoteexthost.log"), logText("failing"));
    const r = await readExtHostLog(dir, ALL);
    expect(r.found && r.facts.has("ms-vscode.cpptools")).toBe(false);
  });
});
