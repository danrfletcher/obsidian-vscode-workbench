/**
 * The next-run sweep: ends what a killed test run left behind.
 *
 * Every test temp dir is named `vscode-workbench-test-<runner pid>-<random>` (`tempDir()` in helpers.ts), so a fake server started
 * by a run carries that run's pid on its command line. This sweep looks at the process table once, finds every process whose
 * command line names a runner that is dead, and ends it with its whole descendant tree and process group (SIGTERM, a grace
 * period, then SIGKILL on what is left). A runner counts as dead when its pid is not in the table, is a zombie, or is alive with
 * another start time than the one its lease file recorded (the pid was reused). A runner that is alive is never touched, and a
 * live runner with no lease file is left alone too: ending a live run's server is worse than leaving a dead run's.
 *
 * Only pids from the command-line marker, their `ps` descendants, their process group (when the leader leads its own group) and
 * the `setsid <pid>` lines a fake wrote to its pidfile (only when that pid is now a `sleep` whose parent is init) are signalled.
 * A process is never found by its name alone. `ps` and the kill function are injected so the decisions can be tested without
 * a real signal.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

/** The folder under the temp dir that holds one lease file (and one ledger) per run. Not `vscode-workbench-test-<digits>-`. */
export const LEASE_DIR_NAME = "vscode-workbench-test-runs";
/** The environment variable that carries the path of the run's fake-server ledger (written by the fake, read by the teardown). */
export const LEDGER_ENV = "FAKE_CODE_LEDGER";
/** The environment variable that carries the runner's pid to the workers, and so into every temp dir name. */
export const RUN_ENV = "WORKBENCH_TEST_RUN";

export const leaseDirOf = (tmp: string = os.tmpdir()): string => path.join(tmp, LEASE_DIR_NAME);
/** The lease file of runner `pid`: it holds the runner's start time (`ps -o lstart=`). */
export const leaseFile = (pid: number, dir: string = leaseDirOf()): string => path.join(dir, String(pid));
/** The ledger of runner `pid`, in the same folder as its lease. The setup only names it; nothing is written to it by this sweep. */
export const ledgerFile = (pid: number, dir: string = leaseDirOf()): string => path.join(dir, `${pid}.ledger`);

/** Matches the runner pid in `vscode-workbench-test-<digits>-`. The lease folder and an old-style `...-AbC123` dir never match. */
const MARKER = /vscode-workbench-test-(\d+)-/g;
/** A temp dir path on a command line: the path up to the end of the marked directory name. */
const MARKED_DIR = /(\/[^\s'"]*?vscode-workbench-test-(\d+)-[^/\s'"]*)/g;
/** The ps columns (one line per process; the command is last, so it may hold spaces). `LC_ALL=C` fixes the lstart format. */
const PS_ARGS = ["-A", "-ww", "-o", "pid=,ppid=,pgid=,uid=,stat=,lstart=,command="];
const PS_ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/;

export interface Proc {
  pid: number;
  ppid: number;
  pgid: number;
  uid: number;
  stat: string;
  /** The start time as `ps -o lstart=` prints it, with the white space collapsed. */
  start: string;
  command: string;
}

/** Runs `ps` and returns its output. Throws when `ps` cannot be run or exits non-zero. */
export type PsRunner = () => string;
export type KillFn = (pid: number, signal: NodeJS.Signals) => void;

export const defaultPs: PsRunner = () =>
  execFileSync("ps", PS_ARGS, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 15_000, env: { ...process.env, LC_ALL: "C" } });

/** The start time of `pid` as `ps -o lstart=` prints it, or undefined when `ps` cannot say. */
export function startTimeOf(pid: number): string | undefined {
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 15_000, env: { ...process.env, LC_ALL: "C" } });
    return normaliseStart(out) || undefined;
  } catch {
    return undefined;
  }
}

export const normaliseStart = (s: string): string => s.trim().replace(/\s+/g, " ");

/** The default kill: a negative pid is a process group. A process that is already gone, or is not ours, is not an error. */
export const defaultKill: KillFn = (pid, signal) => {
  try {
    process.kill(pid, signal);
  } catch {
    /* gone, or not ours to signal */
  }
};

/**
 * Parse the `ps` output. Returns null when it cannot be trusted: no row at all, or a line that starts like a row (a pid) but does
 * not have the columns. A line that does not start with a digit is the tail of a command line that holds a line break and is
 * skipped.
 */
export function parseProcessTable(out: string): Proc[] | null {
  const rows: Proc[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    if (!/^\s*\d/.test(line)) continue;
    const m = PS_ROW.exec(line);
    if (!m) return null;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), uid: Number(m[4]), stat: m[5], start: normaliseStart(m[6]), command: m[7] });
  }
  return rows.length ? rows : null;
}

/** The runner pids named on a command line (`vscode-workbench-test-<pid>-`), without pids 0 and 1, which no runner has. */
export function runnersNamedIn(command: string): number[] {
  const found = new Set<number>();
  for (const m of command.matchAll(MARKER)) {
    const pid = Number(m[1]);
    if (Number.isSafeInteger(pid) && pid > 1) found.add(pid);
  }
  return [...found];
}

export interface SweepOptions {
  ps?: PsRunner;
  kill?: KillFn;
  /** Resolves after `ms`; injected so a test does not wait. */
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  /** Where the lease files are. */
  leaseDir?: string;
  /** This process (never signalled) and its parent (never signalled). */
  selfPid?: number;
  parentPid?: number;
  uid?: number;
  /** SIGTERM to SIGKILL grace in ms (default 2000). */
  graceMs?: number;
  /** The temp dirs of dead runs to read `setsid` pidfile lines from, besides those named on a command line. */
  listRunDirs?: () => string[];
  /** The `setsid <pid>` pids that a run dir's files list. */
  readSetsidPids?: (dir: string) => number[];
  /** The text of a lease file, or undefined when there is none. */
  readLease?: (pid: number) => string | undefined;
  removeLease?: (pid: number) => void;
}

export interface SweepResult {
  /** True when the sweep did nothing because `ps` failed or its output could not be read. */
  skipped: boolean;
  /** The pids that were ended (gone after the sweep). */
  ended: number[];
  /** The dead runners whose leftovers they were. */
  runners: number[];
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The dirs in `tmp` named for a runner (`vscode-workbench-test-<digits>-...`). */
export function defaultListRunDirs(tmp: string = os.tmpdir()): string[] {
  try {
    return fs
      .readdirSync(tmp)
      .filter((n) => /^vscode-workbench-test-\d+-/.test(n))
      .map((n) => path.join(tmp, n));
  } catch {
    return [];
  }
}

/** The `setsid <pid>` lines of the files directly in `dir` (a fake's FAKE_CODE_PIDFILE lives there). */
export function defaultReadSetsidPids(dir: string): number[] {
  const pids: number[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return pids;
  }
  for (const name of names) {
    try {
      const file = path.join(dir, name);
      const st = fs.statSync(file);
      if (!st.isFile() || st.size > 1024 * 1024) continue;
      for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        const m = /^setsid (\d+)$/.exec(line.trim());
        if (m) pids.push(Number(m[1]));
      }
    } catch {
      /* unreadable: nothing to reap from it */
    }
  }
  return pids;
}

const firstWordBase = (command: string): string => path.basename(command.trim().split(/\s+/)[0] ?? "");

/**
 * End the leftovers of dead test runs. Never throws for a `ps` problem: it returns `skipped` and says so in one line. Prints one
 * line when it ended something, and nothing when it found nothing.
 */
export async function sweepLeftovers(options: SweepOptions = {}): Promise<SweepResult> {
  const ps = options.ps ?? defaultPs;
  const kill = options.kill ?? defaultKill;
  const sleep = options.sleep ?? realSleep;
  const log = options.log ?? ((line: string) => console.log(line));
  const dir = options.leaseDir ?? leaseDirOf();
  const selfPid = options.selfPid ?? process.pid;
  const parentPid = options.parentPid ?? process.ppid;
  const uid = options.uid ?? process.getuid?.() ?? -1;
  const graceMs = options.graceMs ?? 2000;
  const readLease = options.readLease ?? ((pid: number) => {
    try {
      return fs.readFileSync(leaseFile(pid, dir), "utf8");
    } catch {
      return undefined;
    }
  });
  const removeLease = options.removeLease ?? ((pid: number) => fs.rmSync(leaseFile(pid, dir), { force: true }));
  const listRunDirs = options.listRunDirs ?? (() => defaultListRunDirs());
  const readSetsidPids = options.readSetsidPids ?? defaultReadSetsidPids;
  const nothing: SweepResult = { skipped: false, ended: [], runners: [] };

  const skip = (why: string): SweepResult => {
    log(`test sweep skipped: ${why}`);
    return { skipped: true, ended: [], runners: [] };
  };
  const snapshot = (): Proc[] | { error: string } => {
    let out: string;
    try {
      out = ps();
    } catch (e) {
      return { error: `ps failed (${(e as { code?: unknown; status?: unknown }).status ?? (e as { code?: unknown }).code ?? "error"})` };
    }
    const rows = parseProcessTable(out);
    return rows ? rows : { error: "ps output could not be read" };
  };

  const first = snapshot();
  if (!Array.isArray(first)) return skip(first.error);
  const byPid = new Map(first.map((p) => [p.pid, p]));
  // A table that does not even list this process is not a table to act on.
  if (!byPid.has(selfPid)) return skip("ps output could not be read");

  // Never signalled: this process, its whole ancestry (the parent, the shell that started the run), and the `ps` it spawned.
  const protectedPids = new Set<number>([selfPid, parentPid]);
  for (let p = byPid.get(selfPid)?.ppid, guard = 0; p && p > 1 && guard < 100; p = byPid.get(p)?.ppid, guard++) protectedPids.add(p);
  for (const p of first) if (p.ppid === selfPid && firstWordBase(p.command) === "ps") protectedPids.add(p.pid);
  const protectedGroups = new Set<number>();
  for (const p of protectedPids) {
    const row = byPid.get(p);
    if (row) protectedGroups.add(row.pgid);
  }

  const dead = (runner: number): boolean => {
    const row = byPid.get(runner);
    if (!row) return true;
    if (row.stat.startsWith("Z")) return true;
    const lease = normaliseStart(readLease(runner) ?? "");
    return lease !== "" && lease !== row.start;
  };
  const deadCache = new Map<number, boolean>();
  const isDead = (runner: number): boolean => {
    let v = deadCache.get(runner);
    if (v === undefined) deadCache.set(runner, (v = dead(runner)));
    return v;
  };

  // 1. The leaders: processes of ours whose command line names runners, every one of them dead.
  const children = new Map<number, Proc[]>();
  for (const p of first) (children.get(p.ppid) ?? children.set(p.ppid, []).get(p.ppid)!).push(p);
  const victims = new Map<number, Proc>();
  const runnerOf = new Map<number, number>();
  const groups = new Set<number>();
  const deadRunners = new Set<number>();
  const markedDirs = new Set<string>();
  const add = (p: Proc, runner: number): void => {
    if (victims.has(p.pid) || protectedPids.has(p.pid) || p.uid !== uid || p.stat.startsWith("Z")) return;
    victims.set(p.pid, p);
    runnerOf.set(p.pid, runner);
    deadRunners.add(runner);
  };
  for (const p of first) {
    if (protectedPids.has(p.pid) || p.uid !== uid || p.stat.startsWith("Z")) continue;
    const named = runnersNamedIn(p.command);
    if (!named.length || !named.every(isDead)) continue;
    add(p, named[0]);
    // The leader's process group, only when it leads one of its own (a fake started by hand from a shell shares the shell's group).
    if (p.pgid === p.pid && !protectedGroups.has(p.pgid)) groups.add(p.pgid);
    for (const m of p.command.matchAll(MARKED_DIR)) markedDirs.add(m[1]);
    // Its whole descendant tree.
    const stack = [...(children.get(p.pid) ?? [])];
    for (let seen = 0; stack.length && seen < 100_000; seen++) {
      const c = stack.pop()!;
      if (victims.has(c.pid)) continue;
      add(c, named[0]);
      stack.push(...(children.get(c.pid) ?? []));
    }
  }
  // Members of those groups that the tree walk did not reach.
  for (const p of first) if (groups.has(p.pgid)) add(p, runnerOf.get(p.pgid) ?? [...deadRunners][0]);

  // 2. `setsid <pid>` lines in the pidfiles of dead runs' temp dirs: a re-parented `sleep` that no tree or group reaches.
  const runDirs = new Set<string>(markedDirs);
  for (const d of listRunDirs()) runDirs.add(d);
  for (const d of runDirs) {
    // A dir counts only for the runner in its own name, and only when that runner is dead.
    const m = /^vscode-workbench-test-(\d+)-/.exec(path.basename(d));
    const runner = m ? Number(m[1]) : 0;
    if (runner <= 1 || !isDead(runner)) continue;
    for (const pid of readSetsidPids(d)) {
      const row = byPid.get(pid);
      if (row && row.ppid === 1 && firstWordBase(row.command) === "sleep") add(row, runner);
    }
  }

  if (!victims.size) return nothing;

  // 3. SIGTERM, a grace period, then SIGKILL on what is left.
  const identity = (p: Proc) => `${p.pid}:${p.start}`;
  const originals = new Map([...victims.values()].map((p) => [p.pid, identity(p)]));
  for (const g of groups) kill(-g, "SIGTERM");
  for (const pid of victims.keys()) kill(pid, "SIGTERM");

  let survivors: Proc[] = [];
  let lost: string | undefined;
  const alive = (rows: Proc[]): Proc[] => rows.filter((p) => originals.get(p.pid) === identity(p) && !p.stat.startsWith("Z"));
  for (let waited = 0; ; waited += 100) {
    await sleep(Math.min(100, Math.max(graceMs - waited, 0)));
    const now = snapshot();
    if (!Array.isArray(now)) {
      lost = now.error;
      break;
    }
    survivors = alive(now);
    if (!survivors.length || waited + 100 >= graceMs) {
      if (survivors.length) {
        // A survivor may have started children since the first look: end those too.
        const kids = new Map<number, Proc[]>();
        for (const p of now) (kids.get(p.ppid) ?? kids.set(p.ppid, []).get(p.ppid)!).push(p);
        const extra: Proc[] = [];
        const stack = [...survivors];
        for (let seen = 0; stack.length && seen < 100_000; seen++) {
          for (const c of kids.get(stack.pop()!.pid) ?? []) {
            if (originals.has(c.pid) || protectedPids.has(c.pid) || c.uid !== uid || c.stat.startsWith("Z")) continue;
            originals.set(c.pid, identity(c));
            runnerOf.set(c.pid, runnerOf.get(c.ppid) ?? [...deadRunners][0]);
            extra.push(c);
            stack.push(c);
          }
        }
        survivors = [...survivors, ...extra];
        for (const g of groups) if (now.some((p) => p.pgid === g)) kill(-g, "SIGKILL");
        for (const p of survivors) kill(p.pid, "SIGKILL");
      }
      break;
    }
  }
  if (lost) {
    // `ps` cannot confirm anything now: say what was done and leave the leases alone.
    log(`test sweep: sent SIGTERM to ${originals.size} leftover process(es) of dead test run(s) ${[...deadRunners].join(", ")}; could not confirm they ended (${lost})`);
    return { skipped: false, ended: [], runners: [...deadRunners] };
  }

  // 4. Say what is gone, and drop the lease of every runner whose leftovers have all ended.
  let finalRows: Proc[] | undefined;
  if (survivors.length) {
    await sleep(200);
    const after = snapshot();
    finalRows = Array.isArray(after) ? after : undefined;
  } else {
    finalRows = [];
  }
  const stillThere = (pid: number): boolean => !!finalRows?.some((p) => p.pid === pid && originals.get(pid) === identity(p) && !p.stat.startsWith("Z"));
  const ended = [...originals.keys()].filter((pid) => (finalRows ? !stillThere(pid) : false)).sort((a, b) => a - b);
  const runners = [...deadRunners].sort((a, b) => a - b);
  for (const r of runners) {
    const mine = [...originals.keys()].filter((pid) => runnerOf.get(pid) === r);
    if (finalRows && mine.every((pid) => !stillThere(pid))) {
      try {
        removeLease(r);
      } catch {
        /* a lease that cannot be removed is only a stale file */
      }
    }
  }
  if (!finalRows) {
    log(`test sweep: sent SIGKILL to the leftover process(es) of dead test run(s) ${runners.join(", ")}; could not confirm they ended (ps failed)`);
    return { skipped: false, ended: [], runners };
  }
  if (ended.length) log(`test sweep: ended ${ended.length} leftover process(es) of dead test run(s) ${runners.join(", ")}: pids ${ended.join(", ")}`);
  const notEnded = originals.size - ended.length;
  if (notEnded > 0) log(`test sweep: ${notEnded} leftover process(es) of dead test run(s) ${runners.join(", ")} did not end`);
  return { skipped: false, ended, runners };
}
