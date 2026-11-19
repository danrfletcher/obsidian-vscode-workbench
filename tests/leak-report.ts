/**
 * The end-of-run leak report: which fake servers are still alive after the run, read from the ledger the fake wrote.
 *
 * tests/fixtures/fake-code.sh appends one line per `serve-web` start to the file named by FAKE_CODE_LEDGER:
 *
 *     <server pid> TAB <server start time, as `ps -o lstart=` prints it> TAB <temp dir path>
 *
 * Report only. This file reads the ledger and the process table and prints a line; it never changes a process, never
 * fails the run and never throws. The ledger is the only source of "which servers": nothing is imported from the plugin or
 * from tests/helpers.ts.
 *
 * A ledger entry counts as a leak when its pid is in the process table, is not a zombie, and has the start time the ledger
 * recorded (another start time means the pid was reused by an unrelated process). The check polls for up to `windowMs`
 * (default 3 s), because a fake whose owner has just gone is ended by its own watchdog within a moment; it returns as soon
 * as no entry is left. One `ps` call covers every pid still open in a round, not one per pid.
 */
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";

export interface LedgerEntry {
  pid: number;
  /** The start time, with the white space collapsed. */
  start: string;
  dir: string;
}

/** What the process table says about one pid. */
export interface ProcInfo {
  stat: string;
  /** The start time, with the white space collapsed. */
  start: string;
}

/** One `ps` call for all of `pids`. The pids that are in the table are in the map. `undefined` when `ps` cannot be asked. */
export type Inspect = (pids: number[]) => Map<number, ProcInfo> | undefined;

export interface LeakDeps {
  inspect?: Inspect;
  /** Resolves after `ms`. */
  sleep?: (ms: number) => Promise<void>;
  /** The clock, in ms. */
  now?: () => number;
  /** Prints one line (default: console.log). */
  print?: (line: string) => void;
  /** Reads the ledger file as text; throws when it cannot (default: fs.readFileSync). */
  readFile?: (file: string) => string;
  /** How long to poll for the leaked fakes to go (default 3000 ms). */
  windowMs?: number;
  /** The gap between two polls (default 200 ms). */
  intervalMs?: number;
}

export const POLL_WINDOW_MS = 3000;
export const POLL_INTERVAL_MS = 200;

const normalise = (s: string): string => s.trim().replace(/\s+/g, " ");

/**
 * The well-formed lines of a ledger, in order, without repeats. A line is skipped when it is empty, has fewer than three
 * tab-separated fields, has a pid that is not a whole number above 1, or has an empty start time or path. A last line with
 * no line break after it was cut short by a write that never finished, so it is skipped too. A path that holds a tab is
 * kept whole (every field after the second belongs to it).
 */
export function parseLedger(text: string): LedgerEntry[] {
  const lines = text.split("\n");
  lines.pop(); // what follows the last line break: empty, or a truncated line
  const seen = new Set<string>();
  const entries: LedgerEntry[] = [];
  for (const line of lines) {
    const fields = line.split("\t");
    if (fields.length < 3) continue;
    if (!/^\d+$/.test(fields[0])) continue;
    const pid = Number(fields[0]);
    if (!Number.isSafeInteger(pid) || pid <= 1) continue;
    const start = normalise(fields[1]);
    const dir = fields.slice(2).join("\t");
    if (!start || !dir.trim()) continue;
    const key = `${pid}\t${start}\t${dir}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ pid, start, dir });
  }
  return entries;
}

const PS_ROW = /^\s*(\d+)\s+(\S+)\s+(\S.*)$/;

/** Parses `ps -o pid=,stat=,lstart=` output. */
export function parsePsRows(out: string): Map<number, ProcInfo> {
  const rows = new Map<number, ProcInfo>();
  for (const line of out.split("\n")) {
    const m = PS_ROW.exec(line);
    if (m) rows.set(Number(m[1]), { stat: m[2], start: normalise(m[3]) });
  }
  return rows;
}

/**
 * The real `ps`: one call that lists every process, narrowed to `pids`. (`ps -p a,b,c` lists nothing at all when one of the pids
 * is not a valid pid, which a bad ledger line could be; the whole table has no such failure.) `ps` exits non-zero when it cannot
 * run or timed out: then it cannot be asked.
 */
export const defaultInspect: Inspect = (pids) => {
  if (!pids.length) return new Map();
  const res = spawnSync("ps", ["-A", "-o", "pid=,stat=,lstart="], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, LC_ALL: "C" },
  });
  if (res.error || res.signal || res.status !== 0) return undefined;
  const wanted = new Set(pids);
  const rows = new Map<number, ProcInfo>();
  for (const [pid, info] of parsePsRows(res.stdout ?? "")) if (wanted.has(pid)) rows.set(pid, info);
  return rows;
};

/** True when the process the ledger recorded is still running there: in the table, not a zombie, same start time. */
export function isLeak(entry: LedgerEntry, info: ProcInfo | undefined): boolean {
  if (!info) return false;
  if (info.stat.startsWith("Z")) return false;
  return info.start === entry.start;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The leak line for one entry. */
export const leakLine = (entry: LedgerEntry): string => `leaked server: pid ${entry.pid} from ${entry.dir}`;

/**
 * Reads the ledger at `ledgerPath`, polls up to the window, and prints one line per fake that is still alive. Prints nothing
 * when the path is unset, the file cannot be read, nothing is well-formed, `ps` cannot be asked, or nothing is alive.
 * Resolves with the lines it printed. Never rejects.
 */
export async function reportLeaks(ledgerPath: string | undefined, deps: LeakDeps = {}): Promise<string[]> {
  try {
    if (!ledgerPath) return [];
    const inspect = deps.inspect ?? defaultInspect;
    const sleep = deps.sleep ?? realSleep;
    const now = deps.now ?? Date.now;
    const print = deps.print ?? ((line: string) => console.log(line));
    const windowMs = deps.windowMs ?? POLL_WINDOW_MS;
    const intervalMs = deps.intervalMs ?? POLL_INTERVAL_MS;
    const readFile = deps.readFile ?? ((file: string) => fs.readFileSync(file, "utf8"));

    let entries: LedgerEntry[];
    try {
      entries = parseLedger(readFile(ledgerPath));
    } catch {
      return [];
    }
    if (!entries.length) return [];

    const deadline = now() + windowMs;
    let open = entries;
    for (;;) {
      const table = inspect([...new Set(open.map((e) => e.pid))]);
      if (!table) return [];
      open = open.filter((e) => isLeak(e, table.get(e.pid)));
      if (!open.length) return [];
      if (now() >= deadline) break;
      await sleep(intervalMs);
    }
    const lines = open.map(leakLine);
    for (const line of lines) {
      try {
        print(line);
      } catch {
        /* a print that fails costs that line only */
      }
    }
    return lines;
  } catch {
    return [];
  }
}
