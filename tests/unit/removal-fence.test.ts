/**
 * The 0.1.0 custom terminal (xterm.js, the python pty helper, the "Terminal" strip, the shell count, the Shell setting) is
 * gone and nothing can bring it back (F1, F8). Table-driven over every removed name: the files, the imports, the code
 * names, the package entries, the build config, the stylesheet, and a real bundle of src/main.ts.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import { builtinModules } from "node:module";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, listTsFiles } from "../helpers";

const SRC = path.join(REPO_ROOT, "src");
const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
const exists = (rel: string) => fs.existsSync(path.join(REPO_ROOT, rel));
/** Code without comments, so a comment that explains what was removed is not mistaken for using it. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "");

const absTs = (dir: string) => listTsFiles(dir).map((f) => path.join(dir, f));
const srcFiles = absTs(SRC);

const REMOVED_SRC_FILES = [
  "src/terminal/drawer-ui.ts",
  "src/terminal/feature.ts",
  "src/terminal/helper-source.ts",
  "src/terminal/kill-confirm.ts",
  "src/terminal/pty-preflight.ts",
  "src/terminal/pty-protocol.ts",
  "src/terminal/pty-session.ts",
  "src/terminal/pty_helper.py",
  "src/terminal/session-manager.ts",
  "src/terminal/shell-count.ts",
  "src/terminal/shell-cwd.ts",
  "src/terminal/terminal-controller.ts",
  "src/terminal/terminal-theme.ts",
  "src/terminal/xterm-view.ts",
  "src/py-modules.d.ts",
];

const REMOVED_TEST_FILES = [
  ...["pty-preflight", "pty-protocol", "pty-session", "helper-source", "session-manager", "terminal-controller", "shell-cwd", "shell-count", "kill-confirm", "terminal-theme", "terminal-fence"].map((n) => `tests/unit/${n}.test.ts`),
  ...["pty-helper", "xterm-view", "drawer-sessions", "drawer-tabs", "drawer-dom", "golden-path-gp5"].map((n) => `tests/integration/${n}.test.ts`),
  ...["fake-pty", "fake-terminal-view", "feature-rig", "helpers-sessions"].map((n) => `tests/${n}.ts`),
];

/** The module names a source file may not import any more (the last path segment, with or without extension). */
const REMOVED_MODULES = ["kill-confirm", "shell-count", "shell-cwd", "drawer-ui", "feature", "helper-source", "pty-preflight", "pty-protocol", "pty-session", "session-manager", "terminal-controller", "terminal-theme", "xterm-view"];

/** Names that existed only for the old terminal. None may appear in code (a comment may say what was removed). */
const REMOVED_NAMES = [
  "promptKillShell",
  "ShellCountItem",
  "addStatusBarItem",
  "TerminalFeature",
  "ShellController",
  "SessionManager",
  "PtySession",
  "KillConfirm",
  "ShellStartDir",
  "installHelper",
  "effectiveShell",
  "defaultShell",
  "FALLBACK_SHELL",
  "shellPath",
  "createXtermView",
  "terminalColours",
  "pty_helper",
  "vscw-shell-count",
];

describe("removed files", () => {
  it.each([...REMOVED_SRC_FILES, ...REMOVED_TEST_FILES])("%s does not exist", (rel) => {
    expect(exists(rel)).toBe(false);
  });

  it("src/py-modules.d.ts does not exist and no .py file is left under src", () => {
    expect(exists("src/py-modules.d.ts")).toBe(false);
    const py: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(dir, e.name));
        else if (e.name.endsWith(".py")) py.push(path.join(dir, e.name));
      }
    };
    walk(SRC);
    expect(py).toEqual([]);
  });
});

describe("imports", () => {
  it("has source files to check", () => {
    expect(srcFiles.length).toBeGreaterThan(30);
  });

  it("no file under src imports @xterm/*, a .py file or any package that is not node:, obsidian, electron or relative", () => {
    for (const file of srcFiles) {
      for (const m of fs.readFileSync(file, "utf8").matchAll(/from\s+["']([^"']+)["']/g)) {
        const spec = m[1];
        expect(spec, `${path.relative(REPO_ROOT, file)}: ${spec}`).not.toMatch(/^@xterm\//);
        expect(spec, `${path.relative(REPO_ROOT, file)}: ${spec}`).not.toMatch(/\.py$/);
        const allowed = spec.startsWith(".") || spec.startsWith("node:") || spec === "obsidian" || spec === "electron" || builtinModules.includes(spec);
        expect(allowed, `${path.relative(REPO_ROOT, file)}: ${spec}`).toBe(true);
      }
    }
  });

  it.each(REMOVED_MODULES)("no file under src imports %s", (name) => {
    const re = new RegExp(`from\\s+["'][^"']*/${name.replace(/[-_]/g, "[-_]")}(\\.ts)?["']`);
    for (const file of srcFiles) expect(fs.readFileSync(file, "utf8"), path.relative(REPO_ROOT, file)).not.toMatch(re);
  });

  it("no test file imports a removed helper or module", () => {
    const re = new RegExp(`from\\s+["'][^"']*/(${[...REMOVED_MODULES, "fake-pty", "fake-terminal-view", "feature-rig", "helpers-sessions"].join("|")})(\\.ts)?["']`);
    for (const file of absTs(path.join(REPO_ROOT, "tests"))) {
      if (file.endsWith("removal-fence.test.ts")) continue;
      expect(fs.readFileSync(file, "utf8"), path.relative(REPO_ROOT, file)).not.toMatch(re);
    }
  });

  it("every file in src/terminal is imported by the code reachable from src/main.ts (nothing is left unreferenced, F8)", () => {
    const resolve = (from: string, spec: string): string | null => {
      if (!spec.startsWith(".")) return null;
      const base = path.resolve(path.dirname(from), spec);
      for (const c of [`${base}.ts`, path.join(base, "index.ts")]) if (fs.existsSync(c)) return c;
      return null;
    };
    const seen = new Set<string>();
    const queue = [path.join(SRC, "main.ts")];
    while (queue.length) {
      const f = queue.pop() as string;
      if (seen.has(f)) continue;
      seen.add(f);
      for (const m of fs.readFileSync(f, "utf8").matchAll(/(?:from|import)\s+["']([^"']+)["']/g)) {
        const r = resolve(f, m[1]);
        if (r) queue.push(r);
      }
    }
    const terminalFiles = srcFiles.filter((f) => f.startsWith(path.join(SRC, "terminal") + path.sep));
    expect(terminalFiles.map((f) => path.basename(f)).sort()).toEqual(["bottom-edge.ts", "drawer-geometry.ts", "drawer-state.ts", "drawer-visibility.ts", "focus-return.ts", "height-store.ts", "layout.ts", "terminal-drawer.ts"]);
    expect(terminalFiles.filter((f) => !seen.has(f)).map((f) => path.basename(f))).toEqual([]);
  });
});

describe("names", () => {
  it.each(REMOVED_NAMES)("%s appears nowhere in the code under src", (name) => {
    for (const file of srcFiles) expect(code(fs.readFileSync(file, "utf8")), path.relative(REPO_ROOT, file)).not.toContain(name);
  });

  it("WorkbenchSettings and DEFAULT_SETTINGS have no shell entry", async () => {
    const { DEFAULT_SETTINGS, readSettings } = await import("../../src/settings/data");
    expect(Object.keys(DEFAULT_SETTINGS).filter((k) => /shell/i.test(k))).toEqual([]);
    expect(Object.keys(readSettings({ shellPath: "/bin/bash" })).filter((k) => /shell/i.test(k))).toEqual([]);
  });

  it("no setting, command or ribbon entry can bring back the old drawer: the plugin registers only the commands it should", () => {
    const main = code(fs.readFileSync(path.join(SRC, "main.ts"), "utf8"));
    const ids = [...main.matchAll(/id:\s*"([^"]+)"/g)].map((m) => m[1]);
    for (const id of ids) expect(id, id).not.toMatch(/old|legacy|classic|builtin|xterm|pty/i);
  });
});

describe("package and build config", () => {
  it("package.json lists no @xterm entry, and the lockfile has none either", () => {
    const pkg = JSON.parse(read("package.json")) as Record<string, Record<string, string> | undefined>;
    const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies });
    expect(names.filter((n) => n.startsWith("@xterm/"))).toEqual([]);
    expect(read("package.json")).not.toMatch(/xterm/i);
    expect(read("package-lock.json")).not.toMatch(/xterm/i);
  });

  it("esbuild.config.mjs has no .py loader and reads no xterm.css", () => {
    const cfg = read("esbuild.config.mjs");
    expect(cfg).not.toMatch(/\.py\b/);
    expect(cfg).not.toMatch(/loader/);
    expect(cfg).not.toMatch(/xterm/i);
  });

  it("vitest.config.mts has no .py text loader", () => {
    const cfg = read("vitest.config.mts");
    expect(cfg).not.toMatch(/\.py\b/);
    expect(cfg).not.toMatch(/py-as-text/);
    expect(cfg).not.toMatch(/xterm/i);
  });

  it.each([".xterm", "xterm", "vscw-strip", "vscw-tab", "vscw-trash", "vscw-shell-count", "vscw-pane", "vscw-drawer-inner", "vscw-terminal-on"])("src/styles.css has no %s rule", (needle) => {
    expect(read("src/styles.css")).not.toContain(needle);
  });
});

describe("a real bundle of src/main.ts (what esbuild.config.mjs builds)", () => {
  it("contains no xterm, pty_helper or python3 string", async () => {
    const out = await build({
      entryPoints: [path.join(SRC, "main.ts")],
      bundle: true,
      write: false,
      external: ["obsidian", "electron", ...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
      format: "cjs",
      target: "es2022",
      platform: "node",
      logLevel: "silent",
    });
    // No exceptions: the focus script in src/terminal-host/host-page.ts joins VS Code's input class name at run time, so the
    // bundle holds only its pieces. The run-time value is checked in tests/unit/terminal-host-drawer.test.ts.
    const text = out.outputFiles.map((f) => f.text).join("\n");
    expect(text.length).toBeGreaterThan(10_000);
    // Report the needle and a short excerpt, not the whole bundle.
    for (const needle of [/xterm/i, /pty_helper/, /python3/i, /promptKillShell/, /ShellCountItem/]) {
      const hit = needle.exec(text);
      expect(hit ? `${needle}: ...${text.slice(Math.max(0, hit.index - 60), hit.index + 60)}...` : null).toBeNull();
    }
  });
});

/**
 * The spec's F1 line: `git grep -i -E "xterm|node-pty|pty_helper|python3|promptKillShell|ShellCountItem|effectiveShell"` over src,
 * tests, package.json, esbuild.config.mjs, vitest.config.mts and README.md. Read literally it should find only this file and the
 * README note, but the files below name the words on purpose. Each is listed with its reason, so the search result is a known set:
 * a new file that names the old terminal fails here until someone decides it belongs.
 */
const F1_PATTERN = "xterm|node-pty|pty_helper|python3|promptKillShell|ShellCountItem|effectiveShell";
const F1_ROOTS = ["src", "tests", "package.json", "esbuild.config.mjs", "vitest.config.mts", "README.md"];
const F1_ALLOWED: Record<string, string> = {
  "tests/unit/removal-fence.test.ts": "this fence: names every removed thing",
  "tests/unit/dependencies.test.ts": "negative check: no node-pty or other native package",
  "tests/unit/terminal-host-fence.test.ts": "negative check: the terminal host brings in no xterm",
  "tests/integration/readme-docs.test.ts": "negative check: the README has no python3, xterm or Python helper text",
  "tests/integration/orphan-sweep.test.ts": "backward compatibility: a stale pids.json entry for a 0.1.0 pty_helper.py; also a python3 process as the fake server's child",
  "tests/integration/plugin.test.ts": "backward compatibility: a pty_helper.py left in .server by 0.1.0 is left alone",
  "tests/integration/terminal-spike-doc.test.ts": "earlier slice: checks docs/terminal-spike.md discusses node-pty",
  "tests/integration/container-terminal-check.test.ts": "earlier slice: tests the container check tool, which is a python3 script",
  "tests/render/container-terminal-check.py": "earlier slice: container check tool (python3 script that reads VS Code's own terminal input)",
  "tests/render/terminal-spike-check.mjs": "earlier slice: spike check that reads VS Code's own terminal input and runs python3 -m http.server",
  "tests/fixtures/container_check_world.py": "earlier slice: fixture for the container check; `python3 -m http.server` is a process-table row",
  "tests/fixtures/fake-serve-web.mjs": "earlier slice: fake serve-web whose shell runs `python3 -m http.server` as a dev server",
};

describe("F1: the files that still name the old terminal are exactly the listed ones", () => {
  const hits = (): string[] =>
    execFileSync("git", ["grep", "-l", "-i", "-E", F1_PATTERN, "--", ...F1_ROOTS], { cwd: REPO_ROOT, encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .sort();

  it("git grep finds no file outside the list, and none in src, package.json, the build config or README.md", () => {
    const found = hits();
    expect(found.filter((f) => !(f in F1_ALLOWED))).toEqual([]);
    expect(found.filter((f) => !f.startsWith("tests/"))).toEqual([]);
  });

  it("every listed file still names one of the words (a file that stops should leave the list)", () => {
    const found = new Set(hits());
    expect(Object.keys(F1_ALLOWED).filter((f) => !found.has(f))).toEqual([]);
  });
});
