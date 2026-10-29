import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { STUB_PYTHON, findOnPath, messages, preflight, realPreflightDeps, type PreflightDeps, type RunResult } from "../../src/terminal/pty-preflight";
import { tempDir } from "../helpers";

/** Real file checks against a temp PATH; `run` is replaced when a test must not run the program. */
function deps(pathEnv: string, over: Partial<PreflightDeps> = {}): PreflightDeps {
  return { ...realPreflightDeps, pathEnv, platform: "linux", ...over };
}

function write(file: string, body: string, mode = 0o755): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, { mode });
  fs.chmodSync(file, mode);
  return file;
}

/** The fixtures of the spec: a good python3, the Command Line Tools stub, an executable shell, and a shell that is not executable. */
function fixtures() {
  const root = tempDir();
  const good = write(path.join(root, "good/python3"), "#!/bin/sh\necho 'Python 3.12.1'\n");
  const stub = write(path.join(root, "stub/python3"), "#!/bin/sh\necho 'xcode-select: note: No developer tools were found, requesting install.' >&2\nexit 1\n");
  const broken = write(path.join(root, "broken/python3"), "#!/bin/sh\necho 'Segmentation fault' >&2\nexit 139\n");
  const shell = write(path.join(root, "bin/sh-ok"), "#!/bin/sh\nexit 0\n");
  const notExec = write(path.join(root, "bin/sh-not-exec"), "#!/bin/sh\nexit 0\n", 0o644);
  fs.mkdirSync(path.join(root, "a-directory"));
  return { root, good, stub, broken, shell, notExec, dir: (n: string) => path.join(root, n) };
}

describe("python3 check (E9)", () => {
  it("passes a real python3 and returns its path", async () => {
    const f = fixtures();
    const r = await preflight(f.shell, deps(f.dir("good")));
    expect(r).toEqual({ ok: true, python: f.good, shell: f.shell });
  });

  it("reports python3 missing from the PATH with the exact message", async () => {
    const f = fixtures();
    const r = await preflight(f.shell, deps(f.dir("bin")));
    expect(r).toEqual({ ok: false, kind: "python-missing", message: messages.pythonMissing });
    expect(messages.pythonMissing).toBe(
      "python3 was not found on your PATH, so the terminal cannot start. Install Python 3 (for example: brew install python3) or add it to your PATH, then reveal the terminal again.",
    );
  });

  it("reports python3 missing for an empty PATH and for PATH entries that do not exist", async () => {
    const f = fixtures();
    expect((await preflight(f.shell, deps(""))).ok).toBe(false);
    expect(await preflight(f.shell, deps(`${f.dir("nope")}${path.delimiter}${f.dir("also-nope")}`))).toMatchObject({ kind: "python-missing" });
  });

  it("does not take a python3 that is not executable, or a directory called python3", async () => {
    const root = tempDir();
    write(path.join(root, "noexec/python3"), "#!/bin/sh\n", 0o644);
    fs.mkdirSync(path.join(root, "dir/python3"), { recursive: true });
    const shell = write(path.join(root, "sh"), "#!/bin/sh\n");
    expect(await preflight(shell, deps(`${path.join(root, "noexec")}${path.delimiter}${path.join(root, "dir")}`))).toMatchObject({ kind: "python-missing" });
  });

  it("takes the first python3 on the PATH", async () => {
    const f = fixtures();
    const r = await preflight(f.shell, deps(`${f.dir("good")}${path.delimiter}${f.dir("stub")}`));
    expect(r).toMatchObject({ ok: true, python: f.good });
  });

  it("detects the Command Line Tools stub by its exit code and output, and shows the exact message", async () => {
    const f = fixtures();
    const r = await preflight(f.shell, deps(f.dir("stub")));
    expect(r).toEqual({ ok: false, kind: "python-stub", message: messages.pythonStub });
    expect(messages.pythonStub).toBe(
      "python3 is only the macOS Command Line Tools placeholder, and the tools are not installed, so the terminal cannot start. Run xcode-select --install in another terminal (or install Python 3 with brew install python3), then reveal the terminal again.",
    );
  });

  it("reports a python3 that fails for another reason with its exit code", async () => {
    const f = fixtures();
    const r = await preflight(f.shell, deps(f.dir("broken")));
    expect(r).toEqual({ ok: false, kind: "python-broken", message: messages.pythonBroken(f.broken, "exit code 139") });
    expect((r as { message: string }).message).toBe(
      `python3 (${f.broken}) could not run (exit code 139), so the terminal cannot start. Reinstall Python 3 or fix your PATH, then reveal the terminal again.`,
    );
  });

  it("never runs /usr/bin/python3 on macOS (running the placeholder opens the install dialog): xcode-select -p decides", async () => {
    const f = fixtures();
    const ran: string[] = [];
    const run = async (file: string, args: string[]): Promise<RunResult> => {
      ran.push([file, ...args].join(" "));
      return { code: 2, output: "xcode-select: error: unable to get active developer directory" };
    };
    const d = deps("/usr/bin", {
      platform: "darwin",
      kind: (p) => (p === STUB_PYTHON ? "file" : realPreflightDeps.kind(p)),
      canExecute: (p) => p === STUB_PYTHON || realPreflightDeps.canExecute(p),
      realpath: (p) => p,
      run,
    });
    expect(await preflight(f.shell, d)).toMatchObject({ ok: false, kind: "python-stub" });
    expect(ran).toEqual(["/usr/bin/xcode-select -p"]);
  });

  it("accepts /usr/bin/python3 on macOS when the Command Line Tools are installed", async () => {
    const f = fixtures();
    const ran: string[] = [];
    const d = deps("/usr/bin", {
      platform: "darwin",
      kind: (p) => (p === STUB_PYTHON ? "file" : realPreflightDeps.kind(p)),
      canExecute: (p) => p === STUB_PYTHON || realPreflightDeps.canExecute(p),
      realpath: (p) => p,
      run: async (file, args) => {
        ran.push([file, ...args].join(" "));
        return { code: 0, output: "/Library/Developer/CommandLineTools" };
      },
    });
    expect(await preflight(f.shell, d)).toMatchObject({ ok: true, python: STUB_PYTHON });
    expect(ran).toEqual(["/usr/bin/xcode-select -p"]);
  });

  it("treats a link that leads to /usr/bin/python3 as the placeholder too", async () => {
    const f = fixtures();
    const d = deps(f.dir("good"), {
      platform: "darwin",
      realpath: () => STUB_PYTHON,
      run: async () => ({ code: 2, output: "" }),
    });
    expect(await preflight(f.shell, d)).toMatchObject({ kind: "python-stub" });
  });
});

describe("shell check (E10)", () => {
  it("passes an executable shell and returns it", async () => {
    const f = fixtures();
    expect(await preflight(f.shell, deps(f.dir("good")))).toMatchObject({ ok: true, shell: f.shell });
  });

  it("names a shell path that does not exist, with the exact message", async () => {
    const f = fixtures();
    const missing = f.dir("bin/no-such-shell");
    const r = await preflight(missing, deps(f.dir("good")));
    expect(r).toEqual({ ok: false, kind: "shell-missing", message: messages.shellMissing(missing) });
    expect((r as { message: string }).message).toBe(
      `The shell ${missing} does not exist, so the terminal cannot start. Set an existing shell in the VS Code Workbench settings (Shell), or clear that field to use the default, then reveal the terminal again.`,
    );
  });

  it("names a shell that exists but is not executable, with the exact message", async () => {
    const f = fixtures();
    const r = await preflight(f.notExec, deps(f.dir("good")));
    expect(r).toEqual({ ok: false, kind: "shell-not-executable", message: messages.shellNotExecutable(f.notExec) });
    expect((r as { message: string }).message).toBe(
      `The shell ${f.notExec} is not executable, so the terminal cannot start. Set a shell that can be run in the VS Code Workbench settings (Shell), or clear that field to use the default, then reveal the terminal again.`,
    );
  });

  it("refuses a directory as a shell", async () => {
    const f = fixtures();
    expect(await preflight(f.dir("a-directory"), deps(f.dir("good")))).toMatchObject({ kind: "shell-not-executable" });
  });

  it("finds a shell given as a bare name on the PATH, and reports a bare name that is not there", async () => {
    const f = fixtures();
    const both = `${f.dir("good")}${path.delimiter}${f.dir("bin")}`;
    expect(await preflight("sh-ok", deps(both))).toMatchObject({ ok: true, shell: f.shell });
    expect(await preflight("no-such-shell", deps(both))).toMatchObject({ kind: "shell-missing", message: messages.shellMissing("no-such-shell") });
  });

  it("checks python3 first when both are wrong", async () => {
    const f = fixtures();
    expect(await preflight(f.dir("nothing"), deps(f.dir("bin")))).toMatchObject({ kind: "python-missing" });
  });

  it("keeps spaces and non-ASCII characters in a path named in the message", async () => {
    const f = fixtures();
    const odd = path.join(f.root, "Café Shells", "zsh é");
    const r = await preflight(odd, deps(f.dir("good")));
    expect((r as { message: string }).message).toContain(odd);
  });
});

describe("findOnPath", () => {
  it("skips empty PATH entries and returns null when nothing matches", () => {
    const f = fixtures();
    expect(findOnPath("python3", { ...realPreflightDeps, pathEnv: `${path.delimiter}${path.delimiter}` })).toBeNull();
    expect(findOnPath("python3", { ...realPreflightDeps, pathEnv: `${path.delimiter}${f.dir("good")}` })).toBe(f.good);
  });
});

describe("the real dependencies", () => {
  it("run a real program and report its exit code and output, and never reject", async () => {
    expect(await realPreflightDeps.run("/bin/sh", ["-c", "echo hello"])).toEqual({ code: 0, output: "hello" });
    expect(await realPreflightDeps.run("/bin/sh", ["-c", "echo oops >&2; exit 3"])).toEqual({ code: 3, output: "oops" });
    expect((await realPreflightDeps.run("/no/such/program", [])).code).toBeNull();
  });
});
