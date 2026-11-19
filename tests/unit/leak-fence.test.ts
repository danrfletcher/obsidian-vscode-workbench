/**
 * Fence for the end-of-run leak report (PR-3 of the "fakes outlive a killed run" ticket), read as text.
 *
 *  F6  the report never fails the run and never ends anything; there is no strict mode.
 *  F7  there is no registry of started servers: the ledger file the fake wrote is the only source of "which servers".
 *  F1/F8  nothing in src/ knows of the report; no new dependency, no new language: sh and node only.
 *
 * The files read are tests/leak-report.ts (the helper), tests/global-setup.ts (the file that registers the teardown) and
 * tests/fixtures/fake-code.sh (the ledger write). Comments are removed before the code is searched, so a comment may say what the
 * code does not do. (The `git diff --stat` against the PR-2 tip, which cannot stay a test because every later change to src/ would
 * fail it, was run by hand: see the PR notes.)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, listTsFiles } from "../helpers";

const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
/** TypeScript without comments. */
const tsCode = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "");
/** Shell without comments. */
const shCode = (text: string) => text.replace(/^\s*#.*$/gm, "").replace(/\s#\s.*$/gm, "");

const HELPER = "tests/leak-report.ts";
const TEARDOWN_FILE = "tests/global-setup.ts";
const WRAPPER = "tests/fixtures/fake-code.sh";
const LEAK_FILES = [HELPER, TEARDOWN_FILE];

/** The body of `export async function teardown()`: from its signature to the closing brace in column 0. */
function teardownBody(): string {
  const text = tsCode(read(TEARDOWN_FILE));
  const start = text.indexOf("export async function teardown");
  expect(start, "teardown is exported from tests/global-setup.ts").toBeGreaterThanOrEqual(0);
  const end = text.indexOf("\n}\n", start);
  return text.slice(start, end + 2);
}

/** Matches a signal, or a call that ends or signals a process. */
const SIGNALS = /\bprocess\s*\.\s*kill\b|\bkill\w*\s*\(|\bpkill\b|\bkillall\b|\bSIG(TERM|KILL|INT|HUP|STOP|QUIT)\b|\.kill\s*\(|\bkill\s+-/;
const ENDS_RUN = /\bthrow\b|\bprocess\s*\.\s*exit\b|\bexitCode\b|\bprocess\s*\.\s*abort\b|\bprocess\s*\.\s*emit\b/;

/** Every relative import of a file (static, dynamic and re-export), as a path from the repo root, with .ts added. */
function importsOf(rel: string): { spec: string; file: string | null }[] {
  const code = tsCode(read(rel));
  const specs = [...code.matchAll(/(?:from|import\s*\()\s*"([^"]+)"/g)].map((m) => m[1]);
  return specs.map((spec) => {
    if (!spec.startsWith(".")) return { spec, file: null };
    const base = path.join(path.dirname(rel), spec);
    return { spec, file: fs.existsSync(path.join(REPO_ROOT, `${base}.ts`)) ? `${base}.ts` : base };
  });
}


describe("F6: the report only reports", () => {
  it("the scans themselves: they catch what they are for and nothing else", () => {
    for (const bad of ["process.kill(1, 0)", "kill(pid)", "child.kill()", "execSync('pkill x')", "sh('killall node')", "SIGKILL", "x(SIGTERM)", "kill -9 1"]) {
      expect(SIGNALS.test(bad), bad).toBe(true);
    }
    for (const ok of ["a killed run", "const skill = 1", "spawnSync('ps', args)", "leaked server"]) expect(SIGNALS.test(ok), ok).toBe(false);
    for (const bad of ["throw new Error()", "process.exit(1)", "process.exitCode = 1", "exitCode"]) expect(ENDS_RUN.test(bad), bad).toBe(true);
    expect(ENDS_RUN.test("if (x) throw e")).toBe(true); // the scan runs on code with comments removed
    expect(ENDS_RUN.test(tsCode("// never throws\n/* throw */ const a = 1;"))).toBe(false);
  });

  it("the report helper and the teardown file signal no process", () => {
    for (const file of LEAK_FILES) expect(SIGNALS.exec(tsCode(read(file)))?.[0] ?? null, file).toBeNull();
  });

  it("the report helper and the teardown file have no `throw`, and set no exit code and never exit", () => {
    for (const file of LEAK_FILES) expect(ENDS_RUN.exec(tsCode(read(file)))?.[0] ?? null, file).toBeNull();
  });

  it("the helper's only child process is `ps`, listing the process table", () => {
    const code = tsCode(read(HELPER));
    expect(code.match(/import\s*\{([^}]*)\}\s*from\s*"node:child_process"/)?.[1].trim()).toBe("spawnSync");
    const calls = [...code.matchAll(/(?<![.\w])(spawnSync|spawn|exec|execFile|execSync|execFileSync|fork)\s*\(([^,)]*)/g)].map((m) => `${m[1]} ${m[2].trim()}`);
    expect(calls).toEqual(['spawnSync "ps"']);
    expect(code).toContain('"-A", "-o", "pid=,stat=,lstart="');
  });

  it("the teardown function neither starts the sweep nor any process, and does not call anything that ends one", () => {
    const body = teardownBody();
    expect(body).toContain("reportLeaks(");
    for (const word of ["sweepLeftovers", "defaultKill", "spawn", "exec", "process.exit"]) expect(body, word).not.toContain(word);
    expect(SIGNALS.test(body)).toBe(false);
    expect(ENDS_RUN.test(body)).toBe(false);
  });

  it("the teardown is registered once, in the one config, next to the setup that names the ledger", async () => {
    const config = read("vitest.config.mts");
    expect((config.match(/globalSetup/g) ?? []).length).toBe(1);
    const setup = await import("../global-setup");
    expect(typeof setup.setup).toBe("function");
    expect(typeof setup.teardown).toBe("function");
    expect(tsCode(read(TEARDOWN_FILE))).toMatch(/process\.env\[LEDGER_ENV\]\s*=\s*ledgerFile\(pid,\s*dir\)/);
    expect(setup.LEDGER_ENV).toBe("FAKE_CODE_LEDGER");
  });

  it("no strict mode: no variable, option or flag in the config, the helper or the teardown file turns the report into a failure", () => {
    const strict = /strict|fail[-_ ]?(on|if|when)[-_ ]?leak|leak[-_ ]?(fail|error|is[-_ ]?fatal)|FAIL_ON|STRICT|bail|exitOnLeak|--fail/i;
    for (const file of [HELPER, TEARDOWN_FILE, "vitest.config.mts"]) expect(strict.exec(tsCode(read(file)))?.[0] ?? null, file).toBeNull();
  });

  it("the only environment variables the helper and the teardown file read are the run's pid and its ledger (the helper reads none by name)", () => {
    const names = (file: string) => [...tsCode(read(file)).matchAll(/process\.env(?:\.(\w+)|\[(\w+)\])/g)].map((m) => m[1] ?? m[2]).sort();
    expect(names(HELPER)).toEqual([]);
    expect(names(TEARDOWN_FILE)).toEqual(["LEDGER_ENV", "LEDGER_ENV", "RUN_ENV"]);
    // `LeakDeps` is the helper's whole option list: data and functions, no switch
    const options = /export interface LeakDeps \{([\s\S]*?)\n\}/.exec(read(HELPER))?.[1] ?? "";
    expect([...options.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1])).toEqual(["inspect", "sleep", "now", "print", "readFile", "windowMs", "intervalMs"]);
  });

  it("the output is a plain console.log of the one line format, and nothing else is printed", () => {
    const code = tsCode(read(HELPER));
    expect([...code.matchAll(/console\.\w+/g)].map((m) => m[0])).toEqual(["console.log"]);
    expect(code).toContain("`leaked server: pid ${entry.pid} from ${entry.dir}`");
    expect(tsCode(teardownBody())).not.toMatch(/console\./);
  });
});

describe("F7: no registry of servers", () => {
  it("tests/helpers.ts: its afterEach removes temp dirs and does nothing else, and it keeps no list of servers", () => {
    const code = tsCode(read("tests/helpers.ts"));
    const hooks = [...code.matchAll(/afterEach\(\(\) => \{([\s\S]*?)\n\}\);/g)];
    expect(hooks).toHaveLength(1);
    expect(hooks[0][1].trim()).toBe("for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });");
    expect(code).not.toMatch(/onTestFinished/);
    // the one module-level list is the list of temp dirs
    expect([...code.matchAll(/^const (\w+): [^=]*\[\] = \[\];/gm)].map((m) => m[1])).toEqual(["dirs"]);
  });

  it("the report code registers nothing: no afterEach, onTestFinished, global list or map of servers", () => {
    for (const file of [...LEAK_FILES, "vitest.config.mts"]) {
      const code = tsCode(read(file));
      expect(code, file).not.toMatch(/\bafterEach\b|\bafterAll\b|\bonTestFinished\b|\bbeforeEach\b/);
      expect(code, file).not.toMatch(/\b(const|let|var)\s+\w*(servers|started|fakes|registry|leaked)\w*\s*(:[^=]*)?=\s*(\[|new (Set|Map))/i);
    }
  });

  it("no test file in tests/ uses onTestFinished", () => {
    const files = [...listTsFiles(path.join(REPO_ROOT, "tests"))].map((f) => path.join("tests", f)).filter((f) => f !== "tests/unit/leak-fence.test.ts");
    expect(files.filter((f) => /\bonTestFinished\b/.test(read(f)))).toEqual([]);
  });

  it("the only source of which servers is the ledger: the teardown's imports, transitively, reach nothing of the plugin or tests/helpers.ts", () => {
    const seen = new Set<string>();
    const queue = [TEARDOWN_FILE];
    while (queue.length) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const { file: next } of importsOf(file)) if (next) queue.push(next);
    }
    expect([...seen].sort()).toEqual(["tests/global-setup.ts", "tests/leak-report.ts", "tests/sweep-leftovers.ts"]);
    for (const file of seen) {
      expect(file.startsWith("src/"), file).toBe(false);
      expect(file, file).not.toBe("tests/helpers.ts");
      for (const { spec } of importsOf(file)) expect(spec, `${file} imports ${spec}`).not.toMatch(/\bobsidian\b|\/src\/|helpers|instance-helpers|host-fakes/);
    }
    // and the helper imports only node
    expect(importsOf(HELPER).map((i) => i.spec).sort()).toEqual(["node:child_process", "node:fs"]);
  });
});

describe("F1/F8: no src/ change, no new dependency, no new language", () => {
  it("nothing under src/ names the ledger, the report or the teardown", () => {
    const src = path.join(REPO_ROOT, "src");
    const hits = listTsFiles(src).filter((f) => /FAKE_CODE_LEDGER|leak-report|leaked server|LEDGER_ENV|reportLeaks/.test(fs.readFileSync(path.join(src, f), "utf8")));
    expect(hits).toEqual([]);
  });

  it("the new code imports only node built-ins and the repo's own files: no package (package.json and the lock file are checked by `git diff`, see above)", () => {
    for (const file of LEAK_FILES) {
      for (const { spec } of importsOf(file)) expect(spec.startsWith("node:") || spec.startsWith("./"), `${file} imports ${spec}`).toBe(true);
    }
  });

  it("the ledger write in the wrapper is sh and uses no other language", () => {
    const text = read(WRAPPER);
    expect(text.split("\n")[0]).toBe("#!/bin/sh");
    const other = new RegExp(["pyth" + "on3?", "perl", "ruby", "\\bawk\\b", "\\bnode\\b -e", "osascript"].join("|"));
    expect(other.exec(shCode(text))?.[0] ?? null).toBeNull();
    // exactly one write to the ledger, in one `>>`
    expect([...shCode(text).matchAll(/>>\s*"\$FAKE_CODE_LEDGER"/g)]).toHaveLength(1);
    expect(shCode(text)).toContain("printf '%s\\t%s\\t%s\\n' \"$child\" \"$child_start\" \"$dir\"");
  });

  it("the ledger write is skipped without FAKE_CODE_LEDGER and its failure cannot end the wrapper", () => {
    const text = shCode(read(WRAPPER));
    const fn = /ledger_append\(\) \{([\s\S]*?)\n\}/.exec(text)?.[1] ?? "";
    expect(fn).toContain('[ -n "$FAKE_CODE_LEDGER" ] || return 0');
    expect(fn).toMatch(/\) 2>\/dev\/null \|\| :/);
    expect(fn).not.toMatch(/\bexit\b/);
    // after the help branch: `--help` returns before any ledger code runs
    expect(text.indexOf("ledger_append()")).toBeGreaterThan(text.indexOf("exit 0"));
    expect(text.trimEnd().endsWith('wait "$child"\nexit $?')).toBe(true);
  });
});
