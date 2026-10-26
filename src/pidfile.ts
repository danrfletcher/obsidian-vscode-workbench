/**
 * The pidfile: a record of every child process the plugin started, so that a
 * crash or force-quit of Obsidian cannot leave a server (or, in later PRs, a
 * shell) running forever (E11). The next startup reads it and sweeps.
 *
 * The file holds only pids, a command-line marker and the workspace path. It
 * never holds the connection token.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { commandLineOf, isAlive, listDescendants, signal, signalGroup, sleep } from "./process-utils";

export interface PidEntry {
  pid: number;
  /** What it is, e.g. "vscode-server". */
  label: string;
  /**
   * A substring the process's command line must still contain for the sweep to
   * kill it (e.g. "serve-web"). A reused pid that belongs to another program
   * will not match and is left alone.
   */
  match: string;
  startedAt: number;
  /** The vault folder the process serves (may contain spaces and non-ASCII characters). */
  workspace?: string;
  /** True when the process leads its own process group (spawned `detached`). */
  group?: boolean;
}

export class PidFile {
  constructor(readonly file: string) {}

  /** Entries in the file. A missing, unreadable or corrupt file reads as empty; bad entries are skipped. */
  read(): { entries: PidEntry[]; corrupt: boolean } {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch {
      return { entries: [], corrupt: false };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { entries: [], corrupt: true };
    }
    if (!Array.isArray(parsed)) return { entries: [], corrupt: true };
    const entries: PidEntry[] = [];
    let corrupt = false;
    for (const e of parsed as unknown[]) {
      const entry = toEntry(e);
      if (entry) entries.push(entry);
      else corrupt = true;
    }
    return { entries, corrupt };
  }

  private write(entries: PidEntry[]): void {
    if (entries.length === 0) {
      this.remove();
      return;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  add(entry: PidEntry): void {
    const rest = this.read().entries.filter((e) => e.pid !== entry.pid);
    this.write([...rest, entry]);
  }

  removePid(pid: number): void {
    const { entries } = this.read();
    const rest = entries.filter((e) => e.pid !== pid);
    if (rest.length !== entries.length) this.write(rest);
  }

  remove(): void {
    fs.rmSync(this.file, { force: true });
  }
}

function toEntry(e: unknown): PidEntry | null {
  if (typeof e !== "object" || e === null) return null;
  const o = e as Record<string, unknown>;
  if (typeof o.pid !== "number" || !Number.isInteger(o.pid) || o.pid <= 1) return null;
  if (typeof o.match !== "string" || o.match === "") return null;
  return {
    pid: o.pid,
    label: typeof o.label === "string" ? o.label : "child",
    match: o.match,
    startedAt: typeof o.startedAt === "number" ? o.startedAt : 0,
    workspace: typeof o.workspace === "string" ? o.workspace : undefined,
    group: o.group === true,
  };
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

export interface SweepDeps {
  /** Command line of a live pid; null when the pid is not running. */
  commandOf(pid: number): string | null;
  descendants(pid: number): number[];
  signal(pid: number, sig: NodeJS.Signals): void;
  signalGroup(pgid: number, sig: NodeJS.Signals): void;
  isAlive(pid: number): boolean;
  sleep(ms: number): Promise<void>;
  /** Pids that must never be signalled (this process). */
  protectedPids: number[];
}

export const realSweepDeps: SweepDeps = {
  commandOf: commandLineOf,
  descendants: listDescendants,
  signal,
  signalGroup,
  isAlive,
  sleep,
  protectedPids: [process.pid, process.ppid],
};

export interface SweepResult {
  /** Entries whose process was still running our command and was killed. */
  killed: PidEntry[];
  /** Entries whose pid is no longer running. */
  gone: PidEntry[];
  /** Entries whose pid now belongs to another program: left alone. */
  reused: PidEntry[];
  /** The file was not valid (it is removed). */
  corrupt: boolean;
}

/**
 * Kill what the pidfile says is left over, then delete the pidfile. A pid is
 * killed only when its command line still contains the entry's marker.
 */
export async function sweepOrphans(file: string, deps: SweepDeps = realSweepDeps, graceMs = 2000): Promise<SweepResult> {
  const pidfile = new PidFile(file);
  const { entries, corrupt } = pidfile.read();
  const result: SweepResult = { killed: [], gone: [], reused: [], corrupt };
  const victims: Array<{ entry: PidEntry; all: number[] }> = [];

  for (const entry of entries) {
    if (deps.protectedPids.includes(entry.pid)) {
      result.reused.push(entry);
      continue;
    }
    const cmd = deps.commandOf(entry.pid);
    if (cmd === null) {
      result.gone.push(entry);
    } else if (!cmd.includes(entry.match)) {
      result.reused.push(entry);
    } else {
      // Collect the tree before signalling: once the parent dies its children are re-parented.
      const all = [entry.pid, ...deps.descendants(entry.pid)].filter((p) => !deps.protectedPids.includes(p));
      victims.push({ entry, all });
    }
  }

  for (const { entry, all } of victims) {
    if (entry.group) deps.signalGroup(entry.pid, "SIGTERM");
    for (const p of all) deps.signal(p, "SIGTERM");
  }
  const deadline = Date.now() + graceMs;
  while (victims.some((v) => v.all.some(deps.isAlive)) && Date.now() < deadline) await deps.sleep(50);
  for (const { entry, all } of victims) {
    for (const p of all) if (deps.isAlive(p)) deps.signal(p, "SIGKILL");
    if (entry.group) deps.signalGroup(entry.pid, "SIGKILL");
    result.killed.push(entry);
  }

  pidfile.remove();
  return result;
}
