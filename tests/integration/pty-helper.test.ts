/**
 * The real pty_helper.py, run with python3 and /bin/sh: input and output, the window size,
 * the start directory, the exit frame, and that no child survives however the helper ends.
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FRAME_EXIT, FRAME_OUTPUT, FrameDecoder, decodeExit, encodeInput, encodeResize } from "../../src/terminal/pty-protocol";
import { listDescendants } from "../../src/process-utils";
import { isAlive, tempDir } from "../helpers";

const HELPER = path.join(__dirname, "../../src/terminal/pty_helper.py");
const running: ChildProcess[] = [];

class Helper {
  readonly child: ChildProcess;
  output = "";
  exitCode: number | null | undefined;
  private decoder = new FrameDecoder();
  closed: Promise<void>;

  constructor(cwd: string, size = { rows: 24, cols: 80 }, shell = "/bin/sh") {
    this.child = spawn("python3", [HELPER, "--cwd", cwd, "--shell", shell, "--rows", String(size.rows), "--cols", String(size.cols)], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, TERM: "xterm-256color", PS1: "$ ", ENV: "" },
    });
    running.push(this.child);
    this.child.stdout?.on("data", (d: Buffer) => {
      for (const f of this.decoder.push(d)) {
        if (f.type === FRAME_OUTPUT) this.output += f.payload.toString("utf8");
        else if (f.type === FRAME_EXIT) this.exitCode = decodeExit(f.payload);
      }
    });
    this.closed = new Promise((r) => this.child.once("close", () => r()));
  }

  type(text: string): void {
    this.child.stdin?.write(encodeInput(text));
  }

  resize(rows: number, cols: number): void {
    this.child.stdin?.write(encodeResize({ rows, cols }));
  }

  /** Wait until the output matches. */
  async expectOutput(pattern: RegExp, ms = 8000): Promise<RegExpMatchArray> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const m = this.output.match(pattern);
      if (m) return m;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`no output matching ${pattern} in ${ms} ms; got ${JSON.stringify(this.output)}`);
  }

  /** Run a command and return its output between two markers, so prompt echo does not matter. */
  async run(command: string): Promise<string> {
    const id = Math.random().toString(36).slice(2, 8);
    this.type(`echo START${id}; ${command}; echo END${id}\n`);
    const m = await this.expectOutput(new RegExp(`(?:^|\\n)START${id}\\r?\\n([\\s\\S]*?)END${id}\\r?\\n`));
    return m[1].replace(/\r/g, "").trim();
  }
}

async function waitDead(pids: number[], ms = 8000): Promise<number[]> {
  const end = Date.now() + ms;
  let alive = pids.filter(isAlive);
  while (alive.length && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 25));
    alive = pids.filter(isAlive);
  }
  return alive;
}

afterEach(() => {
  for (const c of running.splice(0)) {
    if (c.pid && isAlive(c.pid)) {
      for (const d of listDescendants(c.pid)) {
        try { process.kill(d, "SIGKILL"); } catch { /* gone */ }
      }
      try { c.kill("SIGKILL"); } catch { /* gone */ }
    }
  }
});

describe("pty_helper.py with /bin/sh", () => {
  it("runs input in the shell and sends back its output (echo hi)", async () => {
    const h = new Helper(tempDir());
    h.type("echo hi\n");
    await h.expectOutput(/\r?\nhi\r?\n/);
  });

  it("starts in the given directory, including one with spaces and non-ASCII characters", async () => {
    const dir = path.join(tempDir(), "Areas", "Café Notes", "Mock Exams ✓");
    fs.mkdirSync(dir, { recursive: true });
    const h = new Helper(dir);
    const pwd = await h.run("pwd");
    expect(fs.realpathSync(pwd)).toBe(fs.realpathSync(dir));
    expect(path.basename(pwd)).toBe("Mock Exams ✓");
  });

  it("returns non-ASCII text intact", async () => {
    const h = new Helper(tempDir());
    expect(await h.run("echo 'Café 日本語 é'")).toBe("Café 日本語 é");
  });

  it("starts with the size it was given, and a resize frame changes the window size", async () => {
    const h = new Helper(tempDir(), { rows: 31, cols: 97 });
    expect(await h.run("stty size")).toBe("31 97");
    h.resize(40, 120);
    await new Promise((r) => setTimeout(r, 100));
    expect(await h.run("stty size")).toBe("40 120");
    h.resize(10, 33);
    await new Promise((r) => setTimeout(r, 100));
    expect(await h.run("stty size")).toBe("10 33");
  });

  it("gives the shell a terminal (tty) and the TERM the plugin set", async () => {
    const h = new Helper(tempDir());
    expect(await h.run("test -t 0 && echo tty; echo $TERM")).toBe("tty\nxterm-256color");
  });

  it("carries a large paste to the shell without stalling", async () => {
    const h = new Helper(tempDir());
    await h.run("stty -echo");
    h.type("wc -c\n");
    for (let i = 0; i < 400; i++) h.type(`${"x".repeat(49)}\n`); // 20,000 bytes in one burst of frames
    h.type("\x04");
    await h.expectOutput(/\s20000\r?\n/);
  });

  it("reports the shell's exit code in an exit frame and then ends", async () => {
    const h = new Helper(tempDir());
    await h.run("true");
    h.type("exit 3\n");
    await h.closed;
    expect(h.exitCode).toBe(3);
    expect(h.child.exitCode).toBe(0);
  });

  it("reports a shell that cannot be started: a missing start directory shows a message and exit 126", async () => {
    const h = new Helper(path.join(tempDir(), "gone"));
    await h.closed;
    expect(h.output).toContain("cannot start in");
    expect(h.exitCode).toBe(126);
  });

  async function shellPidAndJob(h: Helper): Promise<{ shell: number; job: number }> {
    await h.run("set +H"); // no history expansion of the ! in $!
    const shell = Number(await h.run("echo $$"));
    h.type("sleep 300 &\n"); // a job of the shell, in a process group of its own
    const job = Number(await h.run("echo $!"));
    expect(shell).toBeGreaterThan(1);
    expect(job).toBeGreaterThan(1);
    expect(isAlive(shell) && isAlive(job)).toBe(true);
    return { shell, job };
  }

  it("on SIGTERM to the helper, the shell and the jobs it started are gone and the helper exits", async () => {
    const h = new Helper(tempDir());
    const { shell, job } = await shellPidAndJob(h);
    const tree = [h.child.pid as number, ...listDescendants(h.child.pid as number)];
    expect(tree).toEqual(expect.arrayContaining([shell, job]));
    h.child.kill("SIGTERM");
    await h.closed;
    expect(await waitDead(tree)).toEqual([]);
  });

  it("when the plugin closes the helper's stdin (it went away), the shell and the jobs are gone", async () => {
    const h = new Helper(tempDir());
    const { shell, job } = await shellPidAndJob(h);
    h.child.stdin?.end();
    await h.closed;
    expect(await waitDead([shell, job])).toEqual([]);
  });

  it("when the helper is killed with SIGKILL (no chance to clean up), the shell still ends: its terminal hangs up", async () => {
    const h = new Helper(tempDir());
    const shell = Number(await h.run("echo $$"));
    h.child.kill("SIGKILL");
    await h.closed;
    expect(await waitDead([shell])).toEqual([]);
  });

  it("no process of the helper's tree survives a kill, checked against ps", async () => {
    const h = new Helper(tempDir());
    await shellPidAndJob(h);
    const helperPid = h.child.pid as number;
    const tree = listDescendants(helperPid);
    expect(tree.length).toBeGreaterThanOrEqual(2);
    h.child.kill("SIGTERM");
    await h.closed;
    expect(await waitDead(tree)).toEqual([]);
    expect(listDescendants(helperPid)).toEqual([]);
  });
});
