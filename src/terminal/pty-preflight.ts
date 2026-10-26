/**
 * Checks made before the drawer starts a shell (E9, E10): that `python3` exists and is
 * a real Python (not the macOS Command Line Tools placeholder), and that the shell
 * binary exists and can be run. A failed check gives the exact red message the drawer shows.
 *
 * The placeholder at /usr/bin/python3 opens an install dialog when it is run, so it is
 * never run: when it is the python3 found, `xcode-select -p` says whether the tools are
 * installed. Any other python3 is run once (`--version`) and a failure whose output
 * names the developer tools is the same placeholder.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export type PreflightFailure = "python-missing" | "python-stub" | "python-broken" | "shell-missing" | "shell-not-executable";

export type PreflightResult =
  | { ok: true; python: string; shell: string }
  | { ok: false; kind: PreflightFailure; message: string };

export const STUB_PYTHON = "/usr/bin/python3";

export const messages = {
  pythonMissing: "python3 was not found on your PATH, so the terminal cannot start. Install Python 3 (for example: brew install python3) or add it to your PATH, then reveal the terminal again.",
  pythonStub:
    "python3 is only the macOS Command Line Tools placeholder, and the tools are not installed, so the terminal cannot start. Run xcode-select --install in another terminal (or install Python 3 with brew install python3), then reveal the terminal again.",
  pythonBroken: (python: string, detail: string): string =>
    `python3 (${python}) could not run (${detail}), so the terminal cannot start. Reinstall Python 3 or fix your PATH, then reveal the terminal again.`,
  shellMissing: (shell: string): string =>
    `The shell ${shell} does not exist, so the terminal cannot start. Set an existing shell in the VS Code Workbench settings (Shell), or clear that field to use the default, then reveal the terminal again.`,
  shellNotExecutable: (shell: string): string =>
    `The shell ${shell} is not executable, so the terminal cannot start. Set a shell that can be run in the VS Code Workbench settings (Shell), or clear that field to use the default, then reveal the terminal again.`,
};

export interface RunResult {
  code: number | null;
  output: string;
}

export interface PreflightDeps {
  /** The PATH to search for python3 (and for a shell given as a bare name). */
  pathEnv: string;
  platform: NodeJS.Platform;
  /** "file" for a regular file (after following links), "dir" for a directory, null when nothing is there. */
  kind(p: string): "file" | "dir" | null;
  canExecute(p: string): boolean;
  realpath(p: string): string;
  /** Run a program with no shell and report its exit code and combined output. Never rejects. */
  run(file: string, args: string[]): Promise<RunResult>;
}

export const realPreflightDeps: PreflightDeps = {
  get pathEnv(): string {
    return process.env.PATH ?? "";
  },
  platform: process.platform,
  kind: (p) => {
    try {
      const s = fs.statSync(p);
      return s.isDirectory() ? "dir" : "file";
    } catch {
      return null;
    }
  },
  canExecute: (p) => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  realpath: (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return p;
    }
  },
  run: (file, args) =>
    new Promise((resolve) => {
      execFile(file, args, { timeout: 5000, encoding: "utf8" }, (err, stdout, stderr) => {
        const output = `${stdout ?? ""}${stderr ?? ""}`.trim();
        if (!err) return resolve({ code: 0, output });
        const code = (err as { code?: unknown }).code;
        resolve({ code: typeof code === "number" ? code : null, output: output || String(err.message) });
      });
    }),
};

/** The first executable regular file called `name` in `pathEnv`, or null. */
export function findOnPath(name: string, deps: Pick<PreflightDeps, "pathEnv" | "kind" | "canExecute">): string | null {
  for (const dir of deps.pathEnv.split(path.delimiter)) {
    if (dir === "") continue;
    const candidate = path.join(dir, name);
    if (deps.kind(candidate) === "file" && deps.canExecute(candidate)) return candidate;
  }
  return null;
}

const STUB_OUTPUT = /xcode-select|developer tools|command line tools/i;

/** Is `python` the Command Line Tools placeholder? Runs `xcode-select -p` for /usr/bin/python3, `--version` for any other. */
async function stubOrBroken(python: string, deps: PreflightDeps): Promise<"ok" | "stub" | { broken: string }> {
  if (deps.platform === "darwin" && (python === STUB_PYTHON || deps.realpath(python) === STUB_PYTHON)) {
    const tools = await deps.run("/usr/bin/xcode-select", ["-p"]);
    return tools.code === 0 ? "ok" : "stub";
  }
  const version = await deps.run(python, ["--version"]);
  if (version.code === 0) return "ok";
  if (STUB_OUTPUT.test(version.output)) return "stub";
  return { broken: version.code === null ? "it did not start" : `exit code ${version.code}` };
}

/** Check python3 and the shell. `shellPath` is the shell to start: absolute, or a bare name looked up on the PATH. */
export async function preflight(shellPath: string, deps: PreflightDeps = realPreflightDeps): Promise<PreflightResult> {
  const python = findOnPath("python3", deps);
  if (!python) return { ok: false, kind: "python-missing", message: messages.pythonMissing };
  const check = await stubOrBroken(python, deps);
  if (check === "stub") return { ok: false, kind: "python-stub", message: messages.pythonStub };
  if (check !== "ok") return { ok: false, kind: "python-broken", message: messages.pythonBroken(python, check.broken) };

  const shell = path.isAbsolute(shellPath) || shellPath.includes("/") ? shellPath : (findOnPath(shellPath, deps) ?? shellPath);
  const kind = deps.kind(shell);
  if (kind === null) return { ok: false, kind: "shell-missing", message: messages.shellMissing(shellPath) };
  if (kind === "dir" || !deps.canExecute(shell)) return { ok: false, kind: "shell-not-executable", message: messages.shellNotExecutable(shellPath) };
  return { ok: true, python, shell };
}
