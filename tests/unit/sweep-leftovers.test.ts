/**
 * The sweep's decisions (tests/sweep-leftovers.ts), against a simulated process table. `ps` and the kill function are injected, so
 * no real signal is sent: the table is a plain object, a signal changes it the way the OS would, and the test reads which
 * pids were signalled, with what, and what the one printed line said.
 */
import { describe, expect, it } from "vitest";
import { defaultPs, parseProcessTable, runnersNamedIn, sweepLeftovers } from "../sweep-leftovers";
import type { SweepOptions } from "../sweep-leftovers";

const T0 = "Thu Nov 19 17:00:00 2026";
const T1 = "Thu Nov 19 17:05:00 2026";
const OTHER = "Wed Nov 18 09:30:12 2026";
const UID = 501;
const SELF = 5000;
const PARENT = 4000;

interface P {
  pid: number;
  ppid: number;
  pgid?: number;
  uid?: number;
  stat?: string;
  start?: string;
  command: string;
  /** Ignores SIGTERM: only SIGKILL ends it. */
  ignoresTerm?: boolean;
  /** Ignores everything: stays after SIGKILL (a process the sweep cannot end). */
  immortal?: boolean;
}

/** A process table that reacts to signals. */
class World {
  procs = new Map<number, P>();
  signals: Array<[number, string]> = [];
  logs: string[] = [];
  psCalls = 0;
  /** Calls to ps (1-based) that fail. */
  failPsAt = new Set<number>();
  sleeps: number[] = [];
  constructor(rows: P[]) {
    // The sweep's own process and its ancestry, which every test has.
    this.add({ pid: 1, ppid: 0, pgid: 1, uid: 0, command: "/sbin/launchd" });
    this.add({ pid: 3000, ppid: 1, pgid: 3000, command: "/bin/zsh -l" });
    this.add({ pid: PARENT, ppid: 3000, pgid: 4000, command: "npm test" });
    this.add({ pid: SELF, ppid: PARENT, pgid: 4000, command: "node vitest run" });
    this.add({ pid: 5001, ppid: SELF, pgid: 4000, command: "ps -A -ww -o pid=,ppid=,pgid=,uid=,stat=,lstart=,command=" });
    for (const r of rows) this.add(r);
  }
  add(p: P) {
    this.procs.set(p.pid, p);
  }
  has(pid: number) {
    return this.procs.has(pid);
  }
  ps = (): string => {
    this.psCalls++;
    if (this.failPsAt.has(this.psCalls)) throw Object.assign(new Error("ps failed"), { status: 1 });
    return [...this.procs.values()]
      .map((p) => ` ${p.pid} ${p.ppid} ${p.pgid ?? p.pid} ${p.uid ?? UID} ${p.stat ?? "S"} ${p.start ?? T0} ${p.command}`)
      .join("\n");
  };
  kill = (pid: number, signal: NodeJS.Signals): void => {
    this.signals.push([pid, signal]);
    const targets = pid < 0 ? [...this.procs.values()].filter((p) => p.pgid === -pid || (p.pgid === undefined && p.pid === -pid)) : [this.procs.get(pid)].filter(Boolean) as P[];
    for (const p of targets) {
      if (p.immortal) continue;
      if (signal === "SIGKILL" || (signal === "SIGTERM" && !p.ignoresTerm)) this.procs.delete(p.pid);
    }
  };
  sleep = async (ms: number): Promise<void> => {
    this.sleeps.push(ms);
  };
  signalled(pid: number): boolean {
    return this.signals.some(([p]) => p === pid);
  }
  /** Every pid a signal was sent to (a group as its negative number). */
  get signalledPids(): number[] {
    return [...new Set(this.signals.map(([p]) => p))];
  }
}

interface Run {
  leases?: Record<number, string>;
  setsid?: Record<string, number[]>;
  runDirs?: string[];
  options?: Partial<SweepOptions>;
}

async function sweep(world: World, run: Run = {}) {
  const removed: number[] = [];
  const result = await sweepLeftovers({
    ps: world.ps,
    kill: world.kill,
    sleep: world.sleep,
    log: (l) => world.logs.push(l),
    selfPid: SELF,
    parentPid: PARENT,
    uid: UID,
    graceMs: 2000,
    readLease: (pid) => run.leases?.[pid],
    removeLease: (pid) => void removed.push(pid),
    listRunDirs: () => run.runDirs ?? [],
    readSetsidPids: (dir) => run.setsid?.[dir] ?? [],
    ...run.options,
  });
  return { result, removed };
}

const DEAD = 900;
const DIR = `/var/folders/zz/T/vscode-workbench-test-${DEAD}-AbCd12`;
/** A fake under a runner: the wrapper (leader of its own group), the node server, and a shell with a `sleep` child. */
const fakeOf = (runner: number, base = 100, dir = `/var/folders/zz/T/vscode-workbench-test-${runner}-AbCd12`): P[] => [
  { pid: base, ppid: 1, command: `/bin/sh /repo/tests/fixtures/fake-code.sh serve-web --host 127.0.0.1 --port 0 --connection-token-file ${dir}/token` },
  { pid: base + 1, ppid: base, pgid: base, command: `node /repo/tests/fixtures/fake-serve-web.mjs serve-web --host 127.0.0.1 --port 0 --connection-token-file ${dir}/token` },
  { pid: base + 2, ppid: base + 1, pgid: base + 2, command: `sh -c trap '' TERM HUP; while :; do sleep 600; done # ${dir}`, ignoresTerm: true },
  { pid: base + 3, ppid: base + 2, pgid: base + 2, command: "sleep 600" },
];
const fakePids = (base = 100) => [base, base + 1, base + 2, base + 3];

describe("sweepLeftovers: which runners count as dead", () => {
  it("ends the whole tree and process group of a fake whose runner pid is not alive", async () => {
    const w = new World(fakeOf(DEAD));
    const { result } = await sweep(w);
    expect(fakePids().filter((p) => w.has(p))).toEqual([]);
    expect(result.ended).toEqual(fakePids());
    expect(result.runners).toEqual([DEAD]);
    // The leader leads its own group, so the group got the signal too.
    expect(w.signals).toContainEqual([-100, "SIGTERM"]);
    expect(w.signals).toContainEqual([-102, "SIGTERM"]);
  });

  it("sends SIGTERM first, waits the 2 s grace, and sends SIGKILL only to what is still there", async () => {
    const w = new World(fakeOf(DEAD));
    await sweep(w);
    const firstKill = w.signals.findIndex(([, s]) => s === "SIGKILL");
    const termed = w.signals.slice(0, firstKill).map(([p]) => p);
    expect(w.signals.slice(0, firstKill).every(([, s]) => s === "SIGTERM")).toBe(true);
    expect(termed).toEqual(expect.arrayContaining([100, 101, 102, 103]));
    // Only the shell that ignores SIGTERM (and its `sleep`) was still there for the SIGKILL.
    const killed = w.signals.filter(([, s]) => s === "SIGKILL").map(([p]) => p);
    expect(killed).toContain(102);
    expect(killed).not.toContain(100);
    expect(killed).not.toContain(101);
    // The grace is waited out in full before the SIGKILL.
    expect(w.sleeps.slice(0, -1).reduce((a, b) => a + b, 0)).toBe(2000);
  });

  it("does not wait the grace when everything ended on SIGTERM", async () => {
    const w = new World(fakeOf(DEAD).map((p) => ({ ...p, ignoresTerm: false })));
    await sweep(w);
    expect(w.signals.some(([, s]) => s === "SIGKILL")).toBe(false);
    expect(w.sleeps.reduce((a, b) => a + b, 0)).toBeLessThan(2000);
  });

  it("treats a live pid whose start time differs from the lease as a reused pid: its fakes end, the live process is never signalled (E1)", async () => {
    const w = new World([{ pid: DEAD, ppid: 1, start: T1, command: "/usr/sbin/cupsd -l" }, ...fakeOf(DEAD)]);
    const { result } = await sweep(w, { leases: { [DEAD]: T0 } });
    expect(result.ended).toEqual(fakePids());
    expect(w.has(DEAD)).toBe(true);
    expect(w.signalled(DEAD)).toBe(false);
    expect(w.signalled(-DEAD)).toBe(false);
  });

  it("treats a runner that is a zombie as dead (E1)", async () => {
    const w = new World([{ pid: DEAD, ppid: 1, stat: "Z", start: T0, command: "(node)" }, ...fakeOf(DEAD)]);
    const { result } = await sweep(w, { leases: { [DEAD]: T0 } });
    expect(result.ended).toEqual(fakePids());
    expect(w.signalled(DEAD)).toBe(false);
  });

  it("compares start times with the white space collapsed (a day before the 10th is padded)", async () => {
    const w = new World([{ pid: DEAD, ppid: 1, start: "Thu Nov  5 09:00:00 2026", command: "node vitest" }, ...fakeOf(DEAD)]);
    const { result } = await sweep(w, { leases: { [DEAD]: "Thu Nov 5 09:00:00 2026\n" } });
    expect(result.ended).toEqual([]);
    expect(w.signals).toEqual([]);
  });

  it("leaves a live runner whose start time matches its lease alone, prints nothing (F4)", async () => {
    const w = new World([{ pid: DEAD, ppid: 1, start: T0, command: "node vitest run" }, ...fakeOf(DEAD)]);
    const { result } = await sweep(w, { leases: { [DEAD]: T0 } });
    expect(result).toEqual({ skipped: false, ended: [], runners: [] });
    expect(w.signals).toEqual([]);
    expect(w.logs).toEqual([]);
    expect(fakePids().every((p) => w.has(p))).toBe(true);
  });

  it("leaves a live runner with no lease file alone: F4 wins over the sweep", async () => {
    const w = new World([{ pid: DEAD, ppid: 1, start: T0, command: "node vitest run" }, ...fakeOf(DEAD)]);
    const { result } = await sweep(w, { leases: {} });
    expect(result.ended).toEqual([]);
    expect(w.signals).toEqual([]);
    expect(w.logs).toEqual([]);
  });

  it("leaves a live runner whose lease file is empty alone", async () => {
    const w = new World([{ pid: DEAD, ppid: 1, start: T0, command: "node vitest run" }, ...fakeOf(DEAD)]);
    await sweep(w, { leases: { [DEAD]: "\n" } });
    expect(w.signals).toEqual([]);
  });

  it("ends a dead run's fakes and leaves a concurrent run's fakes up beside them (E4)", async () => {
    const LIVE = 700;
    const w = new World([{ pid: LIVE, ppid: 1, command: "node vitest run" }, ...fakeOf(DEAD, 100), ...fakeOf(LIVE, 200)]);
    const { result } = await sweep(w, { leases: { [LIVE]: T0 } });
    expect(result.ended).toEqual(fakePids(100));
    expect(fakePids(200).every((p) => w.has(p))).toBe(true);
    expect(w.signalled(LIVE)).toBe(false);
    expect(w.signalledPids.filter((p) => Math.abs(p) >= 200)).toEqual([]);
  });

  it("ends a dead runner's fake even though the worker that started it is still alive (E8)", async () => {
    const WORKER = 880;
    const w = new World([{ pid: WORKER, ppid: 1, command: "node vitest/dist/workers/forks.js" }, ...fakeOf(DEAD)]);
    const { result } = await sweep(w);
    expect(result.ended).toEqual(fakePids());
    expect(w.has(WORKER)).toBe(true);
    expect(w.signalled(WORKER)).toBe(false);
  });

  it("does not end a process that names a dead runner and a live runner at once", async () => {
    const LIVE = 700;
    const w = new World([
      { pid: LIVE, ppid: 1, command: "node vitest run" },
      { pid: 300, ppid: 1, command: `tool ${DIR}/a /var/folders/zz/T/vscode-workbench-test-${LIVE}-xYz/b` },
    ]);
    await sweep(w, { leases: { [LIVE]: T0 } });
    expect(w.signals).toEqual([]);
  });
});

describe("sweepLeftovers: what is a leftover (F3)", () => {
  it("leaves decoys alone: an unrelated sleep, a markerless node and a markerless python http.server", async () => {
    const w = new World([
      ...fakeOf(DEAD),
      { pid: 301, ppid: 1, command: "sleep 300" },
      { pid: 302, ppid: 1, command: "node /Users/dan/app/server.js --port 3000" },
      { pid: 303, ppid: 1, command: "python3 -m http.server 8000 --bind 127.0.0.1" },
      { pid: 304, ppid: 1, command: "/bin/sh /repo/tests/fixtures/fake-code.sh serve-web --connection-token-file /somewhere/else/token" },
      { pid: 305, ppid: 1, command: `node /x/vscode-workbench-test-runs/${DEAD}` },
      { pid: 306, ppid: 1, command: "node /x/vscode-workbench-test-AbC123/server.js" },
    ]);
    await sweep(w);
    for (const decoy of [301, 302, 303, 304, 305, 306]) {
      expect(w.has(decoy), `decoy ${decoy}`).toBe(true);
      expect(w.signalled(decoy)).toBe(false);
    }
    expect(fakePids().filter((p) => w.has(p))).toEqual([]);
  });

  it("finds a python shell leader that carries the temp dir only as a `sh -c` comment, and ends its tree (E3)", async () => {
    const w = new World([
      { pid: 400, ppid: 1, command: `sh -c python3 -m http.server 8123 --bind 127.0.0.1; true # ${DIR}` },
      { pid: 401, ppid: 400, pgid: 400, command: "python3 -m http.server 8123 --bind 127.0.0.1" },
    ]);
    const { result } = await sweep(w);
    expect(result.ended).toEqual([400, 401]);
  });

  it("does not sweep a bare `sleep N` extra that was re-parented to init and is not in the pidfile (E3)", async () => {
    const w = new World([...fakeOf(DEAD), { pid: 410, ppid: 1, pgid: 410, command: "sleep 600" }]);
    await sweep(w, { setsid: { [DIR]: [] }, runDirs: [DIR] });
    expect(w.has(410)).toBe(true);
    expect(w.signalled(410)).toBe(false);
  });

  it("ends a `setsid <pid>` line from a dead run's pidfile only when that pid's parent is init (E3)", async () => {
    const w = new World([
      { pid: 420, ppid: 1, pgid: 420, command: "sleep 600" },
      { pid: 421, ppid: 777, pgid: 421, command: "sleep 600" },
      { pid: 422, ppid: 1, pgid: 422, command: "/usr/sbin/cupsd -l" },
      { pid: 777, ppid: 1, command: "node unrelated.js" },
    ]);
    const { result } = await sweep(w, { runDirs: [DIR], setsid: { [DIR]: [420, 421, 422, 999999] } });
    expect(result.ended).toEqual([420]);
    expect(w.has(421)).toBe(true);
    expect(w.has(422)).toBe(true);
    expect(w.signalled(421)).toBe(false);
    expect(w.signalled(422)).toBe(false);
  });

  it("does not read a pidfile that belongs to a live runner's dir", async () => {
    const LIVE = 700;
    const liveDir = `/var/folders/zz/T/vscode-workbench-test-${LIVE}-QwErTy`;
    const w = new World([{ pid: LIVE, ppid: 1, command: "node vitest run" }, { pid: 420, ppid: 1, pgid: 420, command: "sleep 600" }]);
    await sweep(w, { leases: { [LIVE]: T0 }, runDirs: [liveDir], setsid: { [liveDir]: [420] } });
    expect(w.signals).toEqual([]);
  });

  it("finds the dir for the pidfile from a command line when the temp dir list does not hold it", async () => {
    const w = new World([...fakeOf(DEAD), { pid: 420, ppid: 1, pgid: 420, command: "sleep 600" }]);
    const { result } = await sweep(w, { setsid: { [DIR]: [420] } });
    expect(result.ended).toContain(420);
  });
});

describe("sweepLeftovers: never signals its own side", () => {
  it("never signals the current run's pid, its parent, its other ancestors or the ps it spawned, even when their command lines carry the marker", async () => {
    const w = new World(fakeOf(DEAD));
    w.add({ pid: SELF, ppid: PARENT, pgid: 4000, command: `node vitest run ${DIR}/x` });
    w.add({ pid: PARENT, ppid: 3000, pgid: 4000, command: `npm test ${DIR}/x` });
    w.add({ pid: 3000, ppid: 1, pgid: 3000, command: `/bin/zsh -l ${DIR}/x` });
    w.add({ pid: 5001, ppid: SELF, pgid: 4000, command: `ps -A ${DIR}/x` });
    await sweep(w);
    for (const p of [SELF, PARENT, 3000, 5001, 1]) expect(w.signalled(p), `pid ${p}`).toBe(false);
    expect(fakePids().filter((p) => w.has(p))).toEqual([]);
  });

  it("does not signal a process group that holds this process or an ancestor of it", async () => {
    // The leader leads a group of its own, but the run itself sits in that group: a group signal would end the run.
    const w = new World([{ pid: 4100, ppid: 1, pgid: 4100, command: `sh fake-code.sh ${DIR}/token` }]);
    w.add({ pid: SELF, ppid: PARENT, pgid: 4100, command: "node vitest run" });
    const { result } = await sweep(w);
    expect(w.signals.filter(([p]) => p < 0)).toEqual([]);
    expect(result.ended).toEqual([4100]);
    expect(w.has(SELF)).toBe(true);
  });

  it("does not signal a group when the leader is not the group's own leader (a fake started by hand from a shell)", async () => {
    const w = new World([{ pid: 4200, ppid: 1, pgid: 8888, command: `sh fake-code.sh ${DIR}/token` }, { pid: 8888, ppid: 1, command: "-zsh" }]);
    const { result } = await sweep(w);
    expect(result.ended).toEqual([4200]);
    expect(w.signals.filter(([p]) => p < 0)).toEqual([]);
    expect(w.signalled(8888)).toBe(false);
  });

  it("does not signal a process that belongs to another user", async () => {
    const w = new World([{ pid: 4300, ppid: 1, uid: 0, command: `sh fake-code.sh ${DIR}/token` }]);
    await sweep(w);
    expect(w.signals).toEqual([]);
  });

  it("does not signal a zombie that is left of a dead run", async () => {
    const w = new World([{ pid: 4400, ppid: 1, stat: "Z", command: `(sh) ${DIR}/token` }]);
    await sweep(w);
    expect(w.signals).toEqual([]);
  });
});

describe("sweepLeftovers: the line it prints and the lease it drops", () => {
  it("prints one line with the count, the runner and the pids that were ended", async () => {
    const w = new World(fakeOf(DEAD));
    await sweep(w);
    expect(w.logs).toEqual([`test sweep: ended 4 leftover process(es) of dead test run(s) ${DEAD}: pids 100, 101, 102, 103`]);
  });

  it("prints nothing when it finds nothing, and asks `ps` once", async () => {
    const w = new World([{ pid: 301, ppid: 1, command: "sleep 300" }]);
    const { result } = await sweep(w);
    expect(result).toEqual({ skipped: false, ended: [], runners: [] });
    expect(w.logs).toEqual([]);
    expect(w.signals).toEqual([]);
    expect(w.psCalls).toBe(1);
  });

  it("removes the lease of a runner whose leftovers were all ended, and only that one", async () => {
    const LIVE = 700;
    const w = new World([{ pid: LIVE, ppid: 1, command: "node vitest run" }, ...fakeOf(DEAD, 100), ...fakeOf(LIVE, 200)]);
    const { removed } = await sweep(w, { leases: { [LIVE]: T0, [DEAD]: T0 } });
    expect(removed).toEqual([DEAD]);
  });

  it("keeps the lease and says so when something did not end", async () => {
    const w = new World(fakeOf(DEAD).map((p) => (p.pid === 103 ? { ...p, immortal: true } : p)));
    const { result, removed } = await sweep(w);
    expect(result.ended).toEqual([100, 101, 102]);
    expect(removed).toEqual([]);
    expect(w.logs.join("\n")).toContain("1 leftover process(es) of dead test run(s) 900 did not end");
  });
});

describe("sweepLeftovers: ps problems (E11)", () => {
  it("ps exits non-zero: no signal, one line, no throw", async () => {
    const w = new World(fakeOf(DEAD));
    w.failPsAt.add(1);
    const { result } = await sweep(w);
    expect(result.skipped).toBe(true);
    expect(w.signals).toEqual([]);
    expect(w.logs).toEqual(["test sweep skipped: ps failed (1)"]);
  });

  it("ps cannot be spawned: no signal, one line", async () => {
    const w = new World(fakeOf(DEAD));
    const { result } = await sweep(w, {
      options: {
        ps: () => {
          throw Object.assign(new Error("spawn ps ENOENT"), { code: "ENOENT" });
        },
      },
    });
    expect(result.skipped).toBe(true);
    expect(w.signals).toEqual([]);
    expect(w.logs).toEqual(["test sweep skipped: ps failed (ENOENT)"]);
  });

  it.each([
    ["empty output", ""],
    ["only garbage", "this is not a process table\nnor is this"],
    ["a row with missing columns", "  100 1 100 501 S\n"],
    ["a row whose start time is not a date", "  100 1 100 501 S yesterday-ish sh fake-code.sh"],
  ])("unreadable output (%s): no signal, one line", async (_name, out) => {
    const w = new World(fakeOf(DEAD));
    const { result } = await sweep(w, { options: { ps: () => out } });
    expect(result.skipped).toBe(true);
    expect(w.signals).toEqual([]);
    expect(w.logs).toEqual(["test sweep skipped: ps output could not be read"]);
  });

  it("one bad row among good ones makes the whole table untrusted", async () => {
    const w = new World(fakeOf(DEAD));
    const { result } = await sweep(w, { options: { ps: () => `${w.ps()}\n 77 1 bad` } });
    expect(result.skipped).toBe(true);
    expect(w.signals).toEqual([]);
  });

  it("a table that does not list this process is not acted on", async () => {
    const w = new World(fakeOf(DEAD));
    w.procs.delete(SELF);
    const { result } = await sweep(w);
    expect(result.skipped).toBe(true);
    expect(w.signals).toEqual([]);
  });

  it("a line that continues a command line with a line break is skipped, not fatal", async () => {
    const w = new World(fakeOf(DEAD));
    const { result } = await sweep(w, { options: { ps: () => `${w.ps()}\nsecond line of a command` } });
    expect(result.skipped).toBe(false);
    expect(result.ended).toEqual(fakePids());
  });

  it("ps failing after the SIGTERM: no SIGKILL is sent on a table that cannot be read, and the lease stays", async () => {
    const w = new World(fakeOf(DEAD));
    w.failPsAt.add(2);
    const { result, removed } = await sweep(w);
    expect(result.ended).toEqual([]);
    expect(removed).toEqual([]);
    expect(w.signals.some(([, s]) => s === "SIGKILL")).toBe(false);
    expect(w.logs).toHaveLength(1);
    expect(w.logs[0]).toContain("could not confirm");
  });
});

describe("runnersNamedIn and parseProcessTable", () => {
  it.each([
    ["/tmp/vscode-workbench-test-123-AbC/token", [123]],
    ["a /tmp/vscode-workbench-test-5-x and /tmp/vscode-workbench-test-6-y", [5, 6]],
    ["/tmp/vscode-workbench-test-runs/123", []],
    ["/tmp/vscode-workbench-test-AbC123/token", []],
    ["/tmp/vscode-workbench-test-123456", []],
    ["/tmp/vscode-workbench-test--abc", []],
    ["/tmp/vscode-workbench-test-0-abc /tmp/vscode-workbench-test-1-abc", []],
    ["/tmp/my-vscode-workbench-tests-9-abc", []],
  ])("%s", (command, expected) => {
    expect(runnersNamedIn(command)).toEqual(expected);
  });

  it("reads a row with a padded day, a negative uid and a command with spaces", () => {
    expect(parseProcessTable("  7  1  7 -2 Ss   Thu Nov  5 09:00:00 2026   /usr/libexec/x  --flag value\n")).toEqual([
      { pid: 7, ppid: 1, pgid: 7, uid: -2, stat: "Ss", start: "Thu Nov 5 09:00:00 2026", command: "/usr/libexec/x  --flag value" },
    ]);
  });

  it("reads the real `ps` on this machine, which includes this process", () => {
    const rows = parseProcessTable(defaultPs());
    expect(rows).not.toBeNull();
    expect(rows!.some((r) => r.pid === process.pid && r.uid === process.getuid!())).toBe(true);
  });
});
