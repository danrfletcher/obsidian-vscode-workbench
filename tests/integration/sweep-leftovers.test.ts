/**
 * The next-run sweep against real processes (tests/sweep-leftovers.ts): `ps` and `kill` are the real ones. A stand-in runner is
 * spawned and killed to give a pid that is really dead, and a real fake server (the wrapper, the node server, its shells and
 * its reaper) is started under a temp dir named for that pid. The fake's owner, this worker, stays alive, so PR-1's watchdog does
 * not fire: only the sweep can end it. Everything started here is ended in afterEach, by pid and by this test's own temp dir.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { FAKE_CODE, FIXTURES, isAlive, tempDir, tempDirForRun } from "../helpers";
import { leaseFile, startTimeOf, sweepLeftovers } from "../sweep-leftovers";

const started: ChildProcess[] = [];
const dirsUsed: string[] = [];
/** Every dir a fake was started in, kept for the last test. */
const allDirs: string[] = [];
const lines: string[] = [];

function sleepMs(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

async function until(what: string, ok: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`gave up waiting for ${what}`);
    await sleepMs(50);
  }
}

function psCommands(): Array<{ pid: number; command: string }> {
  const out = execFileSync("ps", ["-A", "-ww", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out
    .split("\n")
    .map((l) => /^\s*(\d+)\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ pid: Number(m[1]), command: m[2] }));
}
/** Every process whose command line carries `dir` (this test's own unique temp dir). */
const naming = (dir: string) => psCommands().filter((p) => p.command.includes(dir));

/** A process that does nothing until it is killed, standing in for a vitest runner. */
function standIn(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  started.push(child);
  return child;
}

/** A pid that is really dead (its process was killed and reaped). */
async function deadPid(): Promise<number> {
  const child = standIn();
  await until("the stand-in runner to start", () => startTimeOf(child.pid!) !== undefined);
  const gone = new Promise<void>((r) => child.once("exit", () => r()));
  child.kill("SIGKILL");
  await gone;
  expect(isAlive(child.pid!)).toBe(false);
  return child.pid!;
}

interface Fake {
  dir: string;
  wrapper: ChildProcess;
  pidfile: string;
  /** The pids the fake wrote to its pidfile: the server, `shell <pid>` and `setsid <pid>`. */
  pids: { server: number; shells: number[]; setsid: number[] };
}

/**
 * Start a fake the way WorkbenchServer does (detached, own group, piped stdio) with shells, in `dir`. `code` is the wrapper to run
 * (the fixture, or a copy of it).
 */
async function startFake(dir: string, code: string = FAKE_CODE): Promise<Fake> {
  dirsUsed.push(dir);
  allDirs.push(dir);
  const pidfile = path.join(dir, "pids");
  const tokenFile = path.join(dir, "token");
  fs.writeFileSync(tokenFile, "secret-token\n");
  const wrapper = spawn(code, ["serve-web", "--host", "127.0.0.1", "--port", "0", "--connection-token-file", tokenFile], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, FAKE_CODE_NODE: process.execPath, FAKE_CODE_PIDFILE: pidfile, FAKE_CODE_SHELLS: "2", FAKE_CODE_SHELL_KINDS: "sleep,ignore" },
  });
  started.push(wrapper);
  wrapper.stdout!.resume();
  wrapper.stderr!.resume();
  const read = () => (fs.existsSync(pidfile) ? fs.readFileSync(pidfile, "utf8").split("\n").filter(Boolean) : []);
  await until("the fake's pidfile", () => read().some((l) => l.startsWith("setsid ")));
  await until("the fake's reaper", () => naming(dir).some((p) => p.command.includes("reaperMain")));
  const l = read();
  return {
    dir,
    wrapper,
    pidfile,
    pids: {
      server: Number(l.find((x) => /^\d+$/.test(x))),
      shells: l.filter((x) => x.startsWith("shell ")).map((x) => Number(x.slice(6))),
      setsid: l.filter((x) => x.startsWith("setsid ")).map((x) => Number(x.slice(7))),
    },
  };
}

const everyPid = (f: Fake) => [f.wrapper.pid!, f.pids.server, ...f.pids.shells, ...f.pids.setsid];

async function sweepWith(leaseDir: string) {
  lines.length = 0;
  return sweepLeftovers({ leaseDir, log: (l) => lines.push(l) });
}

afterEach(() => {
  // Only what this test started, by pid, and by its own unique temp dir.
  for (const dir of dirsUsed.splice(0)) {
    for (const p of naming(dir)) {
      try {
        process.kill(p.pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
  }
  for (const child of started.splice(0)) {
    if (child.pid === undefined) continue;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* not a group leader, or gone */
    }
    try {
      process.kill(child.pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
});

describe("sweepLeftovers with real processes", () => {
  it("ends a fake named for a dead runner (its owner still alive) and leaves one named for a live runner", async () => {
    const dead = await deadPid();
    const live = standIn();
    await until("the live stand-in", () => startTimeOf(live.pid!) !== undefined);
    const leases = tempDir();
    fs.writeFileSync(leaseFile(live.pid!, leases), `${startTimeOf(live.pid!)}\n`);

    const doomed = await startFake(tempDirForRun(dead));
    const spared = await startFake(tempDirForRun(live.pid!));
    expect(naming(doomed.dir).length).toBeGreaterThanOrEqual(4);
    expect(doomed.pids.setsid.length).toBe(1);
    // The owner (this worker) is alive, so only the sweep can end it.
    expect(isAlive(process.pid)).toBe(true);

    const result = await sweepWith(leases);

    await until("the dead run's processes to be gone", () => naming(doomed.dir).length === 0);
    for (const pid of everyPid(doomed)) expect(isAlive(pid), `pid ${pid}`).toBe(false);
    expect(result.ended).toEqual(expect.arrayContaining([doomed.wrapper.pid!, doomed.pids.server, ...doomed.pids.setsid]));
    expect(result.runners).toContain(dead);
    expect(lines.filter((l) => l.includes("ended"))).toHaveLength(1);
    expect(lines.join("\n")).toContain(String(doomed.wrapper.pid));

    // The live run's fake is untouched, and so is its runner.
    expect(naming(spared.dir).length).toBeGreaterThanOrEqual(4);
    for (const pid of everyPid(spared)) expect(isAlive(pid), `pid ${pid}`).toBe(true);
    expect(isAlive(live.pid!)).toBe(true);
    for (const pid of everyPid(spared)) expect(result.ended).not.toContain(pid);
    // The dead runner had no lease to remove; the live one's lease is kept.
    expect(fs.existsSync(leaseFile(live.pid!, leases))).toBe(true);
  }, 60_000);

  it("leaves a fake named for a live runner alone when that runner has no lease file", async () => {
    const live = standIn();
    await until("the live stand-in", () => startTimeOf(live.pid!) !== undefined);
    const leases = tempDir();
    const spared = await startFake(tempDirForRun(live.pid!));

    const result = await sweepWith(leases);

    for (const pid of everyPid(spared)) {
      expect(isAlive(pid), `pid ${pid}`).toBe(true);
      expect(result.ended).not.toContain(pid);
    }
    expect(naming(spared.dir).length).toBeGreaterThanOrEqual(4);
  }, 60_000);

  it("ends a fake whose runner pid is alive with another start time than its lease (pid reuse), and never the live process", async () => {
    const reused = standIn();
    await until("the stand-in", () => startTimeOf(reused.pid!) !== undefined);
    const leases = tempDir();
    fs.writeFileSync(leaseFile(reused.pid!, leases), "Mon Jan  1 00:00:00 2001\n");
    const doomed = await startFake(tempDirForRun(reused.pid!));

    const result = await sweepWith(leases);

    await until("the fake's processes to be gone", () => naming(doomed.dir).length === 0);
    expect(isAlive(reused.pid!)).toBe(true);
    expect(result.ended).not.toContain(reused.pid!);
    expect(result.ended).toContain(doomed.wrapper.pid!);
    // Its leftovers have all ended, so the stale lease is gone too.
    expect(fs.existsSync(leaseFile(reused.pid!, leases))).toBe(false);
  }, 60_000);

  it("ends a leftover started from a copy of the fixtures in an app dir named for a dead runner (E9)", async () => {
    const dead = await deadPid();
    const app = tempDirForRun(dead);
    for (const f of ["fake-code.sh", "fake-serve-web.mjs"]) fs.copyFileSync(path.join(FIXTURES, f), path.join(app, f));
    fs.chmodSync(path.join(app, "fake-code.sh"), 0o755);
    // Not under a dir of its own: the copy's own path carries the marker, as the instances and profile-mirror tests' copies do.
    const copy = await startFake(app, path.join(app, "fake-code.sh"));
    expect(naming(app).some((p) => p.command.includes(path.join(app, "fake-code.sh")))).toBe(true);

    await sweepWith(tempDir());

    await until("the copy's processes to be gone", () => naming(app).length === 0);
    for (const pid of everyPid(copy)) expect(isAlive(pid), `pid ${pid}`).toBe(false);
  }, 60_000);

  it("adds under 2 s when there is nothing of ours to end, and leaves no fixture process of this test behind", async () => {
    const t0 = Date.now();
    const result = await sweepWith(tempDir());
    const took = Date.now() - t0;
    // Leftovers of an earlier killed run on this machine would be ended here, and the grace period is part of that work.
    if (result.ended.length === 0) expect(took).toBeLessThan(2000);
    expect(result.skipped).toBe(false);
    expect(dirsUsed).toEqual([]);
  }, 60_000);
});

describe("this file's own cleanup", () => {
  it("leaves no process of the earlier tests running: ps shows none naming a temp dir they used", () => {
    expect(allDirs.length).toBeGreaterThan(0);
    for (const dir of allDirs) expect(naming(dir), dir).toEqual([]);
  });
});
