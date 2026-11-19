/**
 * Integration: the fake `code` ends itself when the test process that started it is gone (a SIGKILLed run runs no cleanup), and
 * after a lifetime cap. Real processes throughout: a throwaway node "owner" starts tests/fixtures/fake-code.sh the way
 * `WorkbenchServer` does (detached, stdio [ignore, pipe, pipe]); the test kills the owner, not the runner, and watches `ps`.
 * The only stand-in is a `ps` shim on PATH for the "owner pid reused" case. Every pid started here is recorded and killed in
 * afterEach, so a failing test leaves nothing behind either.
 *
 * What counts as "left over from that run" is decided by pid, not by name: the wrapper, everything under it (found by a `ps`
 * walk once the fake is fully up), the `setsid` pids it wrote to its pidfile, and any process whose command line carries this
 * test's own temp dir. Other test files run their own fakes at the same time, so a match by name would see theirs.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findFreePort, httpStatus } from "../../src/server";
import { FAKE_CODE, FIXTURES, tempDir } from "../helpers";

const FAKE_SERVE_WEB = path.join(FIXTURES, "fake-serve-web.mjs");
const TOKEN = "w".repeat(64);
const hasHttpServer = spawnSync("python3", ["--version"]).status === 0;

interface Row {
  pid: number;
  ppid: number;
  stat: string;
  command: string;
}

/** The whole process table (`ps -A`), by pid. */
function table(): Map<number, Row> {
  const out = spawnSync("ps", ["-A", "-ww", "-o", "pid=,ppid=,stat=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const rows = new Map<number, Row>();
  for (const line of out.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (m) rows.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), stat: m[3], command: m[4] });
  }
  return rows;
}

/** Alive and not a zombie (a zombie answers `kill -0` but is already dead). */
const running = (pid: number, rows = table()): boolean => {
  const row = rows.get(pid);
  return row !== undefined && !row.stat.startsWith("Z");
};

/** Every descendant of `root` (not `root` itself). */
function descendants(root: number, rows = table()): number[] {
  const found: number[] = [];
  let level = [root];
  while (level.length) {
    level = [...rows.values()].filter((r) => level.includes(r.ppid) && !found.includes(r.pid) && r.pid !== root).map((r) => r.pid);
    found.push(...level);
  }
  return found;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls `cond` every `interval` ms until it is true; returns the milliseconds it took. Throws with `what` after `timeout`. */
async function until(cond: () => boolean | Promise<boolean>, timeout: number, what: string, interval = 250): Promise<number> {
  const start = Date.now();
  for (;;) {
    if (await cond()) return Date.now() - start;
    if (Date.now() - start > timeout) throw new Error(`timed out after ${timeout} ms: ${what}`);
    await sleep(interval);
  }
}

/** Every pid this file started, killed in afterEach. */
const started = new Set<number>();
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
  for (const pid of started) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  started.clear();
});

/**
 * A throwaway "test process": starts the wrapper like `WorkbenchServer` (detached, own group, piped stdio, output drained) and
 * prints one JSON line: its own pid and the wrapper's. Killing it stands in for a SIGKILLed vitest worker.
 */
const OWNER_JS = `
import { spawn } from "node:child_process";
const [bin, ...args] = process.argv.slice(2);
const child = spawn(bin, args, { detached: true, stdio: ["ignore", "pipe", "pipe"], env: process.env });
child.stdout.on("data", () => {});
child.stderr.on("data", () => {});
console.log(JSON.stringify({ owner: process.pid, wrapper: child.pid }));
setInterval(() => {}, 1000);
`;

interface Fake {
  dir: string;
  owner: number;
  wrapper: number;
  server: number;
  port: number;
  shellPort: number;
  /** FAKE_CODE_PIDFILE: the server's pid, then `shell <pid>` and `setsid <pid>` lines. */
  pidfile: string;
  /** The owner's parent, when a test gave it one. */
  parent?: number;
  /** The pids that make up this fake once it is fully up: wrapper, everything under it, the `setsid` pids. */
  ours: number[];
}

interface StartOptions {
  /** The wrapper to run (default: the fixture; a test that copies the two files passes the copy). */
  wrapperPath?: string;
  dir?: string;
  env?: Record<string, string>;
  /** Start the owner under an `sh` that turns into a `sleep` (never reaps its child), so a killed owner is left a zombie. */
  underShell?: boolean;
  /** Start extras: three shells of kinds sleep, fg and ignore, the pty host and (when python3 exists) the http-server shell. */
  extras?: boolean;
}

async function startFake(opts: StartOptions = {}): Promise<Fake> {
  const dir = opts.dir ?? tempDir();
  const tokenFile = path.join(dir, "connection-token");
  fs.writeFileSync(tokenFile, TOKEN, { mode: 0o600 });
  const ownerJs = path.join(dir, "owner.mjs");
  fs.writeFileSync(ownerJs, OWNER_JS);
  const port = await findFreePort();
  const shellPort = opts.extras && hasHttpServer ? await findFreePort() : 0;
  const pidfile = path.join(dir, "server-pids");
  const terminalPidfile = path.join(dir, "terminal-pids");
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    FAKE_CODE_NODE: process.execPath,
    FAKE_CODE_PIDFILE: pidfile,
    ...(opts.extras
      ? {
          FAKE_CODE_SHELLS: "3",
          FAKE_CODE_SHELL_KINDS: "sleep,fg,ignore",
          FAKE_CODE_TERMINAL_PIDFILE: terminalPidfile,
          ...(shellPort ? { FAKE_CODE_SHELL_PORT: String(shellPort) } : {}),
        }
      : {}),
    ...opts.env,
  };
  const wrapperPath = opts.wrapperPath ?? FAKE_CODE;
  const ownerArgs = [ownerJs, wrapperPath, "serve-web", "--host", "127.0.0.1", "--port", String(port), "--connection-token-file", tokenFile];
  let proc: ChildProcess;
  if (opts.underShell) {
    // `$0` is node; the owner is a background child of the shell, which then becomes a `sleep` (exec): a parent that never calls
    // wait, so a killed owner stays a zombie. (A shell that merely waits for a foreground `sleep` reaps it at once on macOS.)
    proc = spawn("sh", ["-c", '"$0" "$@" & exec sleep 1000', process.execPath, ...ownerArgs], { stdio: ["ignore", "pipe", "ignore"], env });
  } else {
    proc = spawn(process.execPath, ownerArgs, { stdio: ["ignore", "pipe", "ignore"], env });
  }
  started.add(proc.pid as number);
  const line = await new Promise<string>((resolve, reject) => {
    let buf = "";
    proc.stdout!.on("data", (d: Buffer) => {
      buf += d.toString();
      if (buf.includes("\n")) resolve(buf.split("\n")[0]);
    });
    proc.once("exit", () => reject(new Error("the owner exited before it started the wrapper")));
  });
  const { owner, wrapper } = JSON.parse(line) as { owner: number; wrapper: number };
  started.add(owner);
  started.add(wrapper);
  await until(async () => (await httpStatus(port, TOKEN)) === 302, 10_000, "the fake server answers", 50);
  const server = Number(fs.readFileSync(pidfile, "utf8").trim().split("\n")[0]);
  started.add(server);
  const fake: Fake = { dir, owner, wrapper, server, port, shellPort, pidfile, ours: [], parent: opts.underShell ? (proc.pid as number) : undefined };
  if (opts.extras) {
    // Fully up: the three shells, the survivor, the pty host and its terminal (and the http-server shell with its child).
    await until(
      () => {
        const lines = fs.readFileSync(pidfile, "utf8").trim().split("\n");
        return (
          lines.filter((l) => l.startsWith("shell ")).length === 3 &&
          lines.some((l) => l.startsWith("setsid ")) &&
          fs.existsSync(terminalPidfile) &&
          fs.readFileSync(terminalPidfile, "utf8").trim() !== ""
        );
      },
      10_000,
      "the extras are started",
      50,
    );
    if (shellPort) await until(() => fetch(`http://127.0.0.1:${shellPort}/`, { signal: AbortSignal.timeout(500) }).then(() => true, () => false), 10_000, "the http-server shell answers", 100);
  }
  // Two reads a moment apart, and only the pids in both: a belt on top of snapshotOf's own choice of what to record.
  const first = snapshotOf(fake);
  await sleep(150);
  const second = new Set(snapshotOf(fake));
  fake.ours = first.filter((p) => second.has(p));
  for (const pid of fake.ours) started.add(pid);
  return fake;
}

/**
 * The stable parts of the fake, now: the wrapper, its watchdog loop, everything under the node server (the extras are
 * long-lived) and the `setsid` pids in its pidfile. Not every descendant of the wrapper: the watchdog loop forks short-lived
 * children all the time (its `sleep 2`, a `date`, `ps` through the PATH shim and the shim's own `sh` and `cat`, and the subshell
 * of each `$(...)`), which are gone a moment after a snapshot and would be counted as "left" or "not running".
 */
function snapshotOf(fake: Fake): number[] {
  const rows = table();
  const pids = new Set<number>([fake.wrapper, ...descendants(fake.server, rows)]);
  // The loop is the wrapper's one other child (after start-up the wrapper does nothing but `wait`); it stays until the fake ends.
  for (const r of rows.values()) if (r.ppid === fake.wrapper && r.pid !== fake.server) pids.add(r.pid);
  for (const l of fs.readFileSync(fake.pidfile, "utf8").split("\n")) {
    const m = /^setsid (\d+)$/.exec(l.trim());
    if (m && rows.has(Number(m[1]))) pids.add(Number(m[1]));
  }
  pids.add(fake.server);
  return [...pids].filter((p) => running(p, rows));
}

/** Pids of `fake.ours` that are still running, plus any process whose command line carries this test's temp dir (not the owner, whose script is there). */
function leftOf(fake: Fake): number[] {
  const rows = table();
  const left = new Set(fake.ours.filter((p) => running(p, rows)));
  for (const r of rows.values()) if (r.command.includes(fake.dir) && !r.stat.startsWith("Z") && r.pid !== process.pid && r.pid !== fake.owner && r.pid !== fake.parent) left.add(r.pid);
  return [...left];
}

/** SIGKILL a pid, as the OS would for a killed run: no handler, no cleanup. */
const kill9 = (pid: number) => process.kill(pid, "SIGKILL");
const kill = (pid: number, signal: NodeJS.Signals) => process.kill(pid, signal);

describe("fake-code.sh watchdog: owner death", () => {
  it("a SIGKILLed owner with two fakes running leaves nothing of either within 15 s (GP2, GP3, E13)", async () => {
    // Two fakes, so a watchdog that ends only one, or all of one run's pids but the other's, shows.
    const a = await startFake({ extras: true });
    const b = await startFake({ extras: true });
    // GP2: the wrapper has a watchdog child next to the node server, and the extras are under the server.
    const rows = table();
    const kids = [...rows.values()].filter((r) => r.ppid === a.wrapper);
    expect(kids.some((r) => r.pid === a.server)).toBe(true);
    expect(kids.some((r) => r.command.includes("fake-code.sh"))).toBe(true);
    expect(a.ours.length).toBeGreaterThan(8);

    kill9(a.owner);
    kill9(b.owner);
    const took = await until(() => leftOf(a).length === 0 && leftOf(b).length === 0, 15_000, `no fixture process is left: ${JSON.stringify([...leftOf(a), ...leftOf(b)])}`);
    expect(took).toBeLessThan(15_000);
    // an `ignore` shell (SIGTERM and SIGHUP ignored) and the pty host are among the pids that went
    const shellCommands = [...a.ours, ...b.ours].filter((p) => rows.get(p)?.command.includes("trap ''"));
    expect(shellCommands.length).toBeGreaterThanOrEqual(2);
    expect(rows.get(a.server)?.command).toContain("fake-serve-web.mjs");
  });

  it("a live owner keeps the fake and its extras up well past one poll interval", async () => {
    const fake = await startFake({ extras: true });
    await sleep(5000);
    expect(fake.ours.filter((p) => !running(p))).toEqual([]);
    expect(await httpStatus(fake.port, TOKEN)).toBe(302);
  });
});

describe("fake-serve-web.mjs reaper: extras that outlive the wrapper and the server (GP3, T1)", () => {
  /**
   * What a `stop()` in progress looks like to the extras: the wrapper (with its watchdog loop) and the node server are gone, the
   * pty host follows its server on its own, and what is left is the shell that ignores SIGTERM with its `sleep`, and the
   * deliberate `setsid` survivor. A run SIGKILLed in that window runs no cleanup, and neither the watchdog (it died with the
   * wrapper) nor the server's cap (it died with the server) is left to end them.
   */
  async function stopInProgress(opts: StartOptions = {}): Promise<{ fake: Fake; left: number[] }> {
    const fake = await startFake({ extras: true, ...opts });
    kill9(fake.server);
    if (fake.wrapper !== fake.server) kill9(fake.wrapper);
    // the loop leaves with its wrapper within one poll; the pty host and its shell leave on their own
    await until(() => [...table().values()].every((r) => !(r.ppid === 1 && r.command.includes("fake-code.sh") && r.command.includes(fake.dir))), 6000, "the watchdog loop left with its wrapper");
    await sleep(1500);
    const rows = table();
    const left = fake.ours.filter((p) => p !== fake.server && p !== fake.wrapper && running(p, rows));
    // the ignore shell, its sleep and the survivor are among what is still up
    expect(left.some((p) => rows.get(p)?.command.includes("trap ''"))).toBe(true);
    const survivorPid = Number(/setsid (\d+)/.exec(fs.readFileSync(fake.pidfile, "utf8"))?.[1]);
    expect(left).toContain(survivorPid);
    return { fake, left };
  }

  it("a SIGKILLed owner ends the shell that ignores SIGTERM and the setsid survivor even though the wrapper and the server are already gone", async () => {
    const { fake, left } = await stopInProgress();
    // while the owner lives, they are not touched (the test's own cleanup is the one to end them)
    await sleep(3000);
    expect(left.filter((p) => !running(p))).toEqual([]);

    kill9(fake.owner);
    await until(() => leftOf(fake).length === 0, 15_000, `no fixture process is left: ${JSON.stringify(leftOf(fake))}`);
  }, 45_000);

  it("the same, with the server started directly by node and no wrapper (its owner is its own parent)", async () => {
    const dir = tempDir();
    const direct = path.join(dir, "direct.sh");
    fs.writeFileSync(direct, `#!/bin/sh\nexec "$FAKE_CODE_NODE" ${JSON.stringify(FAKE_SERVE_WEB)} "$@"\n`, { mode: 0o755 });
    const { fake, left } = await stopInProgress({ dir, wrapperPath: direct });
    expect(left.length).toBeGreaterThan(2);
    kill9(fake.owner);
    await until(() => leftOf(fake).length === 0, 15_000, `no fixture process is left: ${JSON.stringify(leftOf(fake))}`);
  }, 45_000);

  it("with a live owner it signals nothing, and leaves by itself once every extra has ended", async () => {
    const { fake, left } = await stopInProgress();
    const reaper = () => [...table().values()].filter((r) => r.command.includes(fake.dir) && r.command.includes("node") && r.ppid === 1 && !r.stat.startsWith("Z"));
    expect(reaper().length).toBe(1);
    for (const p of left) if (running(p)) kill9(p);
    await until(() => reaper().length === 0, 8000, "the reaper left when nothing was left to watch");
    expect(running(fake.owner)).toBe(true);
    expect(leftOf(fake)).toEqual([]);
  }, 45_000);
});

describe("fake-code.sh watchdog: zombie and reuse (E1)", () => {
  it("what a started fake records as its own is only its stable processes, even when every `ps` the wrapper runs is slow (T3)", async () => {
    // A shim that makes each of the wrapper's own `ps` calls take 0.25 s, so the loop's short-lived children (the shim's `sh`, its
    // `sleep`, `ps`, the `$(...)` subshells) are in the process table most of the time instead of for a few milliseconds.
    const dir = tempDir();
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "ps"), `#!/bin/sh\nsleep 0.25\nexec /bin/ps "$@"\n`, { mode: 0o755 });
    const fake = await startFake({ dir, extras: true, env: { PATH: `${bin}:${process.env.PATH}` } });
    // The shim is really in use: the loop (or its `$(...)` subshell) has a child that is the shim's `sh` or its `sleep 0.25`.
    let sawTransient = false;
    for (let i = 0; i < 40 && !sawTransient; i++) {
      sawTransient = [...table().values()].some((r) => r.command.includes(path.join(bin, "ps")) || r.command === "sleep 0.25");
      if (!sawTransient) await sleep(50);
    }
    expect(sawTransient).toBe(true);
    // None of the recorded pids is a transient of the loop...
    const rows = table();
    for (const p of fake.ours) expect(rows.get(p)?.command ?? "", `pid ${p}`).not.toMatch(/bin\/ps|^sleep 0\.25$|^date |^ps |^\/bin\/ps /);
    // ...and all of them are still running, repeatedly, over several poll intervals.
    for (let i = 0; i < 6; i++) {
      await sleep(500);
      expect(fake.ours.filter((p) => !running(p))).toEqual([]);
    }
    expect(running(fake.owner)).toBe(true);
    expect(fake.ours).toContain(fake.wrapper);
    expect(fake.ours).toContain(fake.server);
    expect(fake.ours.length).toBeGreaterThan(8);
  }, 90_000);

  it("an owner that was killed but never reaped (a zombie, which still passes kill -0) ends the fake", async () => {
    const fake = await startFake({ extras: true, underShell: true });
    // The owner's parent (a `sleep` by now) never reaps it: once killed, the owner is a zombie that `kill -0` still reaches.
    expect(table().get(fake.owner)?.ppid).toBe(fake.parent);
    kill9(fake.owner);
    await until(() => table().get(fake.owner)?.stat.startsWith("Z") === true, 5000, "the killed owner is a zombie", 50);
    expect(() => process.kill(fake.owner, 0)).not.toThrow();

    await until(() => leftOf(fake).length === 0, 15_000, `no fixture process is left: ${JSON.stringify(leftOf(fake))}`);
    // the zombie was still there: only the state check could have told
    expect(table().get(fake.owner)?.stat.startsWith("Z")).toBe(true);
  });

  it("an owner pid that now has another start time (pid reuse) ends the fake", async () => {
    const dir = tempDir();
    const flag = path.join(dir, "reuse-flag");
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    // Prints another start time for the pid in the flag file once it exists; every other call goes to the real ps.
    fs.writeFileSync(
      path.join(bin, "ps"),
      `#!/bin/sh\nif [ -f "${flag}" ] && [ "$1" = "-o" ] && [ "$2" = "lstart=" ] && [ "$3" = "-p" ] && [ "$4" = "$(cat "${flag}")" ]; then\n  echo "Thu Jan  1 00:00:00 1970"\n  exit 0\nfi\nexec /bin/ps "$@"\n`,
      { mode: 0o755 },
    );
    const fake = await startFake({ dir, extras: true, env: { PATH: `${bin}:${process.env.PATH}` } });
    await sleep(3000);
    expect(fake.ours.filter((p) => !running(p))).toEqual([]); // same owner, same start time: alive
    expect(running(fake.owner)).toBe(true);

    fs.writeFileSync(flag, String(fake.owner));
    await until(() => leftOf(fake).length === 0, 15_000, `no fixture process is left: ${JSON.stringify(leftOf(fake))}`);
    expect(running(fake.owner)).toBe(true); // the owner is alive and untouched: only its start time "changed"
  });
});

describe("fake-code.sh watchdog: lifetime cap", () => {
  it("FAKE_CODE_MAX_LIFETIME_S=3 ends the wrapper and the server of a live owner by about 6 s (GP4, E6)", async () => {
    const t0 = Date.now(); // before the wrapper starts, so its cap cannot have begun earlier than this
    const fake = await startFake({ env: { FAKE_CODE_MAX_LIFETIME_S: "3" } });
    await until(() => !running(fake.wrapper) && !running(fake.server), 15_000, "the 3 s cap ends the wrapper and the server");
    const took = Date.now() - t0;
    // Ends by about 6 s: the 3 s cap, one 2 s poll and the one-second grain of `date +%s`, counted from before the start, so the
    // start-up is inside it. The extra 2 s is slack for a loaded machine. The floor is the cap less that one-second grain.
    expect(took).toBeLessThan(6000 + 2000);
    expect(took).toBeGreaterThanOrEqual(2000);
    expect(running(fake.owner)).toBe(true); // the owner was alive the whole time
    // the loop's own last `sleep 2` may still be winding down a moment after the wrapper is gone
    await until(() => leftOf(fake).length === 0, 5000, `nothing of the fake is left: ${JSON.stringify(leftOf(fake))}`, 50);
  });

  it("FAKE_CODE_MAX_LIFETIME_S=8 keeps the wrapper and the server of a live owner up at 4 s, then ends them at the cap (GP4, E6)", async () => {
    const t0 = Date.now(); // before the wrapper starts: the cap runs from the wrapper's start, so this is never later than it
    const fake = await startFake({ env: { FAKE_CODE_MAX_LIFETIME_S: "8" } });
    await sleep(Math.max(0, 4000 - (Date.now() - t0)));
    expect(Date.now() - t0).toBeLessThan(6000); // the check is at 4 s, well inside the cap, even if start-up was slow
    expect(running(fake.wrapper)).toBe(true);
    expect(running(fake.server)).toBe(true);
    expect(running(fake.owner)).toBe(true);
    expect(await httpStatus(fake.port, TOKEN)).toBe(302);

    // and it is the 8, not no cap at all: the same fake is gone at the cap (8 s + one 2 s poll + the 1 s grain, plus slack)
    await until(() => !running(fake.wrapper) && !running(fake.server), 20_000, "the 8 s cap ends the wrapper and the server");
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(7000);
    expect(took).toBeLessThan(8000 + 2000 + 1000 + 4000);
    expect(running(fake.owner)).toBe(true);
  }, 40_000);

  it("the wrapper's own cap ends the wrapper, the server and the extras when the server cannot end itself (GP4)", async () => {
    // The node server is stopped (SIGSTOP) once it is up, so its own setTimeout cap cannot fire and nothing but the wrapper's
    // watchdog loop can end this fake. A wrapper whose cap check did nothing would leave the stopped server and its extras for
    // good (a stopped process does not end by itself, and the owner is alive).
    const cap = 12;
    const t0 = Date.now();
    const fake = await startFake({ extras: true, env: { FAKE_CODE_MAX_LIFETIME_S: String(cap) } });
    kill(fake.server, "SIGSTOP");
    await until(() => table().get(fake.server)?.stat.startsWith("T") === true, 3000, "the server is stopped", 20);
    // the cap must not have fired yet, or this proves nothing (startup took most of it)
    expect(Date.now() - t0).toBeLessThan((cap - 2) * 1000);
    expect(running(fake.wrapper)).toBe(true);

    await until(() => fake.ours.every((p) => !running(p)) && !running(fake.server) && !running(fake.wrapper), (cap + 8) * 1000, `the wrapper's cap ends everything: ${JSON.stringify(leftOf(fake))}`);
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual((cap - 1) * 1000); // it was the cap, not the owner (alive) or an early exit
    // cap + one 2 s poll + the one-second grain of `date +%s`, plus slack for a loaded machine
    expect(took).toBeLessThan((cap + 2 + 1 + 5) * 1000);
    expect(running(fake.owner)).toBe(true);
    expect(leftOf(fake)).toEqual([]);
  }, 60_000);

  it("the default is 600 s in both files (read, not waited for), and a cap that is not a positive number means 600 too", () => {
    const sh = fs.readFileSync(FAKE_CODE, "utf8");
    const mjs = fs.readFileSync(FAKE_SERVE_WEB, "utf8");
    expect(sh).toContain("cap=${FAKE_CODE_MAX_LIFETIME_S:-600}");
    expect(sh).toMatch(/case \$cap in '' \| \*\[!0-9\]\*\) cap=600 ;; esac/);
    expect(sh).toContain('[ "$cap" -gt 0 ] 2>/dev/null || cap=600');
    expect(mjs).toContain("Number(process.env.FAKE_CODE_MAX_LIFETIME_S || 600)");
    expect(mjs).toContain("maxLifetimeS > 0 ? maxLifetimeS : 600");
  });
});

describe("fake-serve-web.mjs: node alone (GP4, E2)", () => {
  it("started directly with node and a cap of 2 it ends itself and the extras it started", async () => {
    const dir = tempDir();
    const tokenFile = path.join(dir, "connection-token");
    fs.writeFileSync(tokenFile, TOKEN);
    const pidfile = path.join(dir, "server-pids");
    const port = await findFreePort();
    const child = spawn(process.execPath, [FAKE_SERVE_WEB, "--host", "127.0.0.1", "--port", String(port), "--connection-token-file", tokenFile], {
      env: {
        ...process.env,
        FAKE_CODE_MAX_LIFETIME_S: "2",
        FAKE_CODE_PIDFILE: pidfile,
        FAKE_CODE_SHELLS: "3",
        FAKE_CODE_SHELL_KINDS: "sleep,fg,ignore",
        FAKE_CODE_TERMINAL_PIDFILE: path.join(dir, "terminal-pids"),
      },
      stdio: "ignore",
    });
    started.add(child.pid as number);
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    await until(() => fs.existsSync(pidfile) && fs.readFileSync(pidfile, "utf8").includes("setsid"), 5000, "the extras are started", 50);
    const extras = descendants(child.pid as number);
    const survivor = Number(/setsid (\d+)/.exec(fs.readFileSync(pidfile, "utf8"))?.[1]);
    for (const p of [...extras, survivor]) started.add(p);
    expect(extras.length).toBeGreaterThanOrEqual(3);

    expect(await Promise.race([exited, sleep(10_000).then(() => "still running")])).toBe(0);
    await until(() => [...extras, survivor].every((p) => !running(p)), 5000, "the extras went with it");
  });

  it("a wrapper killed alone leaves the server and its extras up until the server's own cap", async () => {
    // The cap runs from the server's start, and startFake (the extras, the pty host, the http-server shell) can take several
    // seconds on a loaded machine, so it is far longer than the 3 s wait plus any startup: the server must still be up after it.
    const fake = await startFake({ extras: true, env: { FAKE_CODE_MAX_LIFETIME_S: "20" } });
    const watchdogLoop = [...table().values()].find((r) => r.ppid === fake.wrapper && r.pid !== fake.server);
    kill9(fake.wrapper);
    await sleep(3000); // longer than one poll: the loop has had its chance
    const rows = table();
    expect(running(fake.server, rows)).toBe(true);
    expect(watchdogLoop?.command).toContain("fake-code.sh");
    expect(running((watchdogLoop as Row).pid, rows)).toBe(false); // the loop died with its wrapper
    // everything else (the server and every extra) is still up
    expect(fake.ours.filter((p) => p !== fake.wrapper && p !== watchdogLoop?.pid && !running(p, rows))).toEqual([]);
    await until(() => fake.ours.every((p) => !running(p)), 25_000, "the server's cap ends the server and the extras");
  }, 60_000);
});

describe("fake-code.sh watchdog: extras and decoys (E3, F3)", () => {
  it("the extras carry the temp dir, a setsid pid is reaped only when its ppid is 1, and decoys survive", async () => {
    const fake = await startFake({ extras: true });
    const rows = table();
    const commands = fake.ours.map((p) => rows.get(p)?.command ?? "");
    const ignoreShell = commands.find((c) => c.includes("trap ''"));
    expect(ignoreShell).toContain(fake.dir);
    expect(commands.filter((c) => c.includes("trap ''"))).toHaveLength(1);
    if (hasHttpServer) {
      const httpShell = commands.find((c) => c.startsWith("sh -c") && c.includes("http.server"));
      expect(httpShell).toContain(fake.dir);
    }
    // the bare `sleep` extra carries nothing: nothing can find it by path
    expect(commands.some((c) => /^sleep 600$/.test(c))).toBe(true);
    expect(commands.filter((c) => /^sleep 600$/.test(c)).every((c) => !c.includes(fake.dir))).toBe(true);

    const survivorPid = Number(/setsid (\d+)/.exec(fs.readFileSync(fake.pidfile, "utf8"))?.[1]);
    expect(rows.get(survivorPid)?.ppid).toBe(1);
    expect(rows.get(survivorPid)?.command).toBe("sleep 600");

    // Decoys, all started here and none under the fake: a sleep 613 and a node, as plain children of this test; and, re-parented
    // to init, a sleep 615 and a node that a `setsid` line names (a reused pid, as far as the fake can tell).
    const plainSleep = spawn("sleep", ["613"], { stdio: "ignore", detached: true });
    const plainNode = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
    const orphan = (cmd: string) => {
      const out = spawnSync("sh", ["-c", `${cmd} >/dev/null 2>&1 & echo $!`], { encoding: "utf8" });
      return Number(out.stdout.trim());
    };
    const orphanSleep = orphan("sleep 615");
    const orphanNode = orphan(`'${process.execPath}' -e 'setInterval(() => {}, 1000)'`);
    const decoys = [plainSleep.pid as number, plainNode.pid as number, orphanSleep, orphanNode];
    for (const p of decoys) started.add(p);
    await until(() => table().get(orphanSleep)?.ppid === 1 && table().get(orphanNode)?.ppid === 1, 5000, "the orphans are re-parented to init", 50);
    // A sleep that is somebody's child, named by a setsid line: ppid is not 1, so it is left. The orphan sleep is named too and,
    // having ppid 1, goes. The orphan node (ppid 1, but not a sleep) is left.
    fs.appendFileSync(fake.pidfile, `setsid ${plainSleep.pid}\nsetsid ${orphanSleep}\nsetsid ${orphanNode}\n`);

    kill9(fake.owner);
    await until(() => leftOf(fake).length === 0 && !running(orphanSleep), 15_000, `no fixture process is left: ${JSON.stringify(leftOf(fake))}`);
    await sleep(1000);
    const after = table();
    expect(running(plainSleep.pid as number, after)).toBe(true);
    expect(running(plainNode.pid as number, after)).toBe(true);
    expect(running(orphanNode, after)).toBe(true);
    expect(after.get(plainSleep.pid as number)?.command).toBe("sleep 613");
  });
});

describe("fake-code.sh watchdog: copied fixtures (E9)", () => {
  it("a copy of the two files alone has the watchdog and the cap: the owner-death case again", async () => {
    const dir = tempDir();
    const app = path.join(dir, "app");
    fs.mkdirSync(app);
    // As instances.test.ts, shared-extensions.test.ts and plugin-lifecycle.test.ts do: these two files and nothing else.
    for (const f of ["fake-code.sh", "fake-serve-web.mjs"]) fs.copyFileSync(path.join(FIXTURES, f), path.join(app, f));
    fs.chmodSync(path.join(app, "fake-code.sh"), 0o755);
    expect(fs.readdirSync(app).sort()).toEqual(["fake-code.sh", "fake-serve-web.mjs"]);

    const fake = await startFake({ dir, wrapperPath: path.join(app, "fake-code.sh"), env: { FAKE_CODE_SHELLS: "3", FAKE_CODE_SHELL_KINDS: "sleep,fg,ignore" } });
    expect(fake.ours.length).toBeGreaterThan(4);
    kill9(fake.owner);
    await until(() => leftOf(fake).length === 0, 15_000, `no fixture process is left: ${JSON.stringify(leftOf(fake))}`);
  });

  it("the copy's node server has its own cap", async () => {
    const dir = tempDir();
    const app = path.join(dir, "app");
    fs.mkdirSync(app);
    for (const f of ["fake-code.sh", "fake-serve-web.mjs"]) fs.copyFileSync(path.join(FIXTURES, f), path.join(app, f));
    fs.chmodSync(path.join(app, "fake-code.sh"), 0o755);
    const fake = await startFake({ dir, wrapperPath: path.join(app, "fake-code.sh"), env: { FAKE_CODE_MAX_LIFETIME_S: "3" } });
    kill9(fake.wrapper); // only the node server's own cap is left to end it
    await until(() => !running(fake.server), 9000, "the node server ends itself");
  });
});

describe("fake-code.sh watchdog: hygiene (E7)", () => {
  it("the loop's sleep is a child of the loop, is never orphaned, and the loop leaves with its wrapper", async () => {
    const fake = await startFake({});
    const loop = [...table().values()].find((r) => r.ppid === fake.wrapper && r.pid !== fake.server);
    expect(loop?.command).toContain("fake-code.sh");
    const loopPid = (loop as Row).pid;
    started.add(loopPid);
    // the loop is in its `sleep 2` nearly all the time
    let nap = 0;
    await until(
      () => {
        const row = [...table().values()].find((r) => r.ppid === loopPid && /^sleep 2$/.test(r.command));
        nap = row?.pid ?? 0;
        return nap !== 0;
      },
      3000,
      "the loop's `sleep 2` is a child of the loop",
      20,
    );
    started.add(nap);

    kill9(fake.wrapper); // the wrapper ends; the loop must follow, and its sleep must not outlive it unparented
    for (let i = 0; i < 200; i++) {
      const rows = table();
      const napRow = rows.get(nap);
      if (napRow && running(nap, rows)) expect(napRow.ppid).toBe(loopPid); // never re-parented to init while the loop is gone
      if (!running(loopPid, rows) && !running(nap, rows)) break;
      await sleep(25);
    }
    const rows = table();
    expect(running(loopPid, rows)).toBe(false);
    expect(running(nap, rows)).toBe(false);
    expect([...rows.values()].filter((r) => r.command === "sleep 2" && r.ppid === 1 && r.pid === nap)).toEqual([]);
  });

  it("a wrapper that ends normally leaves no loop and no sleep 2 of its own behind", async () => {
    // The server exits at once in this mode; the wrapper follows, and its loop within one poll.
    const dir = tempDir();
    const tokenFile = path.join(dir, "connection-token");
    fs.writeFileSync(tokenFile, TOKEN);
    const wrapper = spawn(FAKE_CODE, ["serve-web", "--host", "127.0.0.1", "--port", "1", "--connection-token-file", tokenFile], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FAKE_CODE_NODE: process.execPath, FAKE_CODE_MODE: "exit-plain" },
    });
    started.add(wrapper.pid as number);
    wrapper.stdout.resume();
    wrapper.stderr.resume();
    const mine = (rows = table()) => [...rows.values()].filter((r) => r.command.includes(tokenFile) || r.pid === wrapper.pid);
    await new Promise((r) => wrapper.once("exit", r));
    // the loop (same command line as the wrapper, it carries the token-file path) is gone within one poll plus a margin
    await until(() => mine().filter((r) => !r.stat.startsWith("Z")).length === 0, 5000, "the loop ended with its wrapper", 50);
  });
});

describe("fake fixtures: static fences (F9, F10)", () => {
  const sh = fs.readFileSync(FAKE_CODE, "utf8");
  const mjs = fs.readFileSync(FAKE_SERVE_WEB, "utf8");

  it("fake-serve-web.mjs does not watch its parent or its stdin (its parent is the wrapper, which stays alive)", () => {
    expect(mjs).not.toMatch(/process\.ppid|process\.stdin/);
  });

  it("no environment variable switches the watchdog off: the only FAKE_CODE_* names are the known ones, and the one new name is the cap", () => {
    const names = new Set([...(sh + mjs).matchAll(/FAKE_CODE_[A-Z_]+/g)].map((m) => m[0]));
    expect([...names].sort()).toEqual(
      [
        "FAKE_CODE_ARGSFILE",
        "FAKE_CODE_DOWNLOAD_REQUESTS",
        "FAKE_CODE_HELP_DELAY",
        "FAKE_CODE_MAX_LIFETIME_S",
        "FAKE_CODE_MODE",
        "FAKE_CODE_NODE",
        "FAKE_CODE_OFFLINE_EXCEPT",
        "FAKE_CODE_PARTIAL_DIR",
        "FAKE_CODE_PIDFILE",
        "FAKE_CODE_SHELLS",
        "FAKE_CODE_SHELL_KINDS",
        "FAKE_CODE_SHELL_NOHUP_PIDFILE",
        "FAKE_CODE_SHELL_PIDFILE",
        "FAKE_CODE_SHELL_PORT",
        "FAKE_CODE_TERMINAL_PIDFILE",
      ].sort(),
    );
    for (const name of names) expect(name).not.toMatch(/WATCHDOG|OWNER|NO_?WATCH|DISABLE|OPT_?OUT|SKIP|FOREVER|NO_?CAP|UNLIMITED|KEEP/);
  });
});
