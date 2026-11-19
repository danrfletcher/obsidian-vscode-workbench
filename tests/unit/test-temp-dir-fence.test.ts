/**
 * Fence for the next-run sweep (PR-2 of the "fakes outlive a killed run" ticket).
 *
 * E12: a test that starts a fake server must get its temp dir from `tempDir()` with the default prefix, because only that name
 * carries the runner's pid, which is how the sweep knows whose leftovers they are. A direct `mkdtempSync`, or a custom prefix,
 * would give a name no sweep can read.
 * Also: the global setup is registered once in the one config; the sweep never finds a process by name alone; the real plugin
 * code (src/) knows nothing of the sweep; the new code needs no new dependency and the fake server has no parent or stdin watch.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../helpers";

const TESTS = path.join(REPO_ROOT, "tests");
const SELF = path.join(TESTS, "unit", "test-temp-dir-fence.test.ts");
/** The one place that may call `mkdtempSync`: it makes the name every other test gets. */
const HELPERS = path.join(TESTS, "helpers.ts");

/** What marks a file as one that starts a fake VS Code server. */
const STARTS_A_SERVER = /fake-code\.sh|FAKE_CODE|WorkbenchServer|ServerManager|plugin\.onload/;
/** `mkdtempSync(...)` called directly, and `tempDir(<anything>)`: every argument is a custom prefix (or a name for another run). */
const DIRECT_MKDTEMP = /\bmkdtempSync\s*\(/;
const CUSTOM_PREFIX = /\btempDir\(\s*[^\s)]/;

/** The ways `source` would give a server-starting test a temp dir without the runner pid. Empty when it does not start a server. */
function tempDirViolations(source: string): string[] {
  if (!STARTS_A_SERVER.test(source)) return [];
  const found: string[] = [];
  if (DIRECT_MKDTEMP.test(source)) found.push("calls mkdtempSync directly");
  if (CUSTOM_PREFIX.test(source)) found.push("calls tempDir() with a custom prefix");
  return found;
}

function* sourceFiles(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* sourceFiles(full);
    else if (/\.(ts|mts|mjs|js|sh)$/.test(e.name)) yield full;
  }
}

describe("E12: server-starting tests take their temp dir from tempDir() with the default prefix", () => {
  it("the scan itself: flags a direct mkdtempSync and a custom prefix in a file that starts a server, and nothing else", () => {
    const starts = `import { plugin } from "x"; await plugin.onload();\n`;
    expect(tempDirViolations(`${starts}const d = fs.mkdtempSync(path.join(os.tmpdir(), "x-"));`)).toEqual(["calls mkdtempSync directly"]);
    expect(tempDirViolations(`${starts}const d = mkdtempSync(p);`)).toEqual(["calls mkdtempSync directly"]);
    expect(tempDirViolations(`${starts}const d = tempDir("ctc-cwd-");`)).toEqual(["calls tempDir() with a custom prefix"]);
    expect(tempDirViolations(`${starts}const d = tempDir('x-');`)).toEqual(["calls tempDir() with a custom prefix"]);
    expect(tempDirViolations(`${starts}const d = tempDir(\`x-\${n}\`);`)).toEqual(["calls tempDir() with a custom prefix"]);
    expect(tempDirViolations(`${starts}const d = tempDir(prefix);`)).toEqual(["calls tempDir() with a custom prefix"]);
    expect(tempDirViolations(`${starts}const d = tempDir( "x" );`)).toEqual(["calls tempDir() with a custom prefix"]);
    for (const marker of ["fake-code.sh", "FAKE_CODE_PIDFILE", "new WorkbenchServer()", "new ServerManager()"]) {
      expect(tempDirViolations(`// ${marker}\nconst d = fs.mkdtempSync(p);`), marker).toEqual(["calls mkdtempSync directly"]);
    }
    // The default prefix, and a file that starts no server, are fine.
    expect(tempDirViolations(`${starts}const d = tempDir();\nconst e = tempDir( );`)).toEqual([]);
    expect(tempDirViolations(`const d = fs.mkdtempSync(p); const e = tempDir("ctc-");`)).toEqual([]);
  });

  it("no file under tests/ that starts a fake server calls mkdtempSync or tempDir with a custom prefix", () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const file of sourceFiles(TESTS)) {
      if (file === SELF || file === HELPERS) continue;
      const found = tempDirViolations(fs.readFileSync(file, "utf8"));
      if (STARTS_A_SERVER.test(fs.readFileSync(file, "utf8"))) scanned++;
      if (found.length) offenders.push(`${path.relative(REPO_ROOT, file)}: ${found.join(", ")}`);
    }
    // The scan reaches real server-starting files (a scan that matched nothing would pass for the wrong reason).
    expect(scanned).toBeGreaterThan(20);
    expect(offenders).toEqual([]);
  });

  it("the two direct mkdtempSync users start no server, and stay as they are", () => {
    for (const f of ["integration/container-chrome-check.test.ts", "integration/terminal-at-extension.test.ts"]) {
      const text = fs.readFileSync(path.join(TESTS, f), "utf8");
      expect(DIRECT_MKDTEMP.test(text), f).toBe(true);
      expect(STARTS_A_SERVER.test(text), f).toBe(false);
    }
  });
});

describe("the global setup is registered once, in the default config only", () => {
  it("vitest.config.mts has one globalSetup entry, tests/global-setup.ts, which exists and exports setup and teardown", async () => {
    const configs = fs.readdirSync(REPO_ROOT).filter((n) => /^vitest\.(config|workspace)/.test(n));
    expect(configs).toEqual(["vitest.config.mts"]);
    const file = path.join(REPO_ROOT, "vitest.config.mts");
    expect((fs.readFileSync(file, "utf8").match(/globalSetup/g) ?? []).length).toBe(1);
    const config = (await import(/* @vite-ignore */ pathToFileURL(file).href)).default as { test?: { globalSetup?: unknown; projects?: unknown } };
    expect(config.test?.globalSetup).toEqual(["./tests/global-setup.ts"]);
    expect(config.test?.projects).toBeUndefined();
    const setup = await import("../global-setup");
    expect(typeof setup.setup).toBe("function");
    expect(typeof setup.teardown).toBe("function");
  });
});

describe("F3: the sweep never finds a process by name alone", () => {
  const source = fs.readFileSync(path.join(TESTS, "sweep-leftovers.ts"), "utf8");
  const code = source
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\/?\*)/.test(l))
    .join("\n");

  it("has no name-based killer", () => {
    for (const word of ["pkill", "killall", "pgrep", "killProcess"]) expect(source, word).not.toContain(word);
    // The only `ps` it runs lists pids and command lines, with no name filter (-C, -c or a command argument).
    expect(code).not.toMatch(/["']-[A-Za-z]*[cC]\b["']/);
    expect(code).not.toMatch(/exec(File)?(Sync)?\(\s*["'](?!ps["'])/);
  });

  it("chooses its victims only through the runner pid on the command line, the ps tree, the group and the setsid pidfile lines", () => {
    expect(code).toContain("runnersNamedIn(p.command)");
    expect(code).toContain("named.every(isDead)");
    // A pid is signalled only through `kill(...)`, from the victim set, the groups of marked leaders, or the survivors of those.
    const signalCalls = code.match(/\bkill\(/g) ?? [];
    expect(signalCalls.length).toBeGreaterThan(0);
    expect(code).not.toMatch(/process\.kill\(\s*(?!pid, signal)/);
  });
});

describe("F1, F8, F9: nothing leaks out of the test infrastructure", () => {
  const NEW_FILES = [
    "sweep-leftovers.ts",
    "global-setup.ts",
    "unit/sweep-leftovers.test.ts",
    "unit/temp-dir-name.test.ts",
    "unit/test-temp-dir-fence.test.ts",
    "integration/sweep-leftovers.test.ts",
  ];

  it("F1: nothing under src/ knows about the sweep, the run variable or the lease folder", () => {
    const words = /WORKBENCH_TEST_RUN|FAKE_CODE_LEDGER|vscode-workbench-test-runs|sweep-leftovers|global-setup|vscode-workbench-test-\d/;
    const offenders: string[] = [];
    for (const file of sourceFiles(path.join(REPO_ROOT, "src"))) if (words.test(fs.readFileSync(file, "utf8"))) offenders.push(path.relative(REPO_ROOT, file));
    expect(offenders).toEqual([]);
  });

  it("F8: the new files import only node built-ins, vitest and each other (no new dependency, node and sh only)", () => {
    for (const f of NEW_FILES) {
      const text = fs.readFileSync(path.join(TESTS, f), "utf8");
      const specifiers = [...text.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/g)].map((m) => m[1]);
      expect(specifiers.length, f).toBeGreaterThan(0);
      for (const spec of specifiers) expect(/^(node:|vitest$|\.\.?\/)/.test(spec), `${f} imports ${spec}`).toBe(true);
    }
  });

  it("F8: package.json and the lockfile's root entry declare exactly the dependencies they did before this ticket", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
    const lock = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package-lock.json"), "utf8"));
    const DEV = ["@types/node", "@vitest/coverage-v8", "esbuild", "jsdom", "obsidian", "typescript", "vitest"];
    const kinds = ["dependencies", "optionalDependencies", "peerDependencies", "bundledDependencies"];
    for (const [label, manifest] of [["package.json", pkg], ["package-lock.json packages[\"\"]", lock.packages[""]]] as const) {
      expect(Object.keys(manifest.devDependencies ?? {}).sort(), `${label} devDependencies`).toEqual(DEV);
      for (const kind of kinds) expect(manifest[kind], `${label} ${kind}`).toBeUndefined();
    }
    // The lockfile and the manifest agree on every version range, so neither moved without the other.
    expect(lock.packages[""].devDependencies).toEqual(pkg.devDependencies);
  });

  it("F9: fake-serve-web.mjs has no parent-pid or stdin watch (its parent is the wrapper, which stays alive)", () => {
    const text = fs.readFileSync(path.join(TESTS, "fixtures", "fake-serve-web.mjs"), "utf8");
    expect(text).not.toMatch(/process\.ppid/);
    expect(text).not.toMatch(/process\.stdin/);
  });
});
