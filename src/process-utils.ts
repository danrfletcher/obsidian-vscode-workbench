/**
 * Small process helpers shared by the server, the child registry and the
 * orphan sweep. Everything here is synchronous or tiny so that quit and unload
 * can signal children before the app goes away.
 */
import { execFileSync } from "node:child_process";

/** Parse `ps -A -o pid=,ppid=` output into all descendant pids of `rootPid`. */
export function descendantsFromPs(psOutput: string, rootPid: number): number[] {
  const children = new Map<number, number[]>();
  for (const line of psOutput.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid || Number.isNaN(ppid)) continue;
    const list = children.get(ppid) ?? [];
    list.push(pid);
    children.set(ppid, list);
  }
  const out: number[] = [];
  const queue = [rootPid];
  while (queue.length) {
    for (const c of children.get(queue.shift() as number) ?? []) {
      out.push(c);
      queue.push(c);
    }
  }
  return out;
}

/**
 * All descendant pids of `rootPid` (the `code` wrapper forks several layers and
 * some leave the process group). Synchronous so stop() can collect them before
 * the parent dies and its children are re-parented.
 */
export function listDescendants(rootPid: number): number[] {
  try {
    return descendantsFromPs(execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" }), rootPid);
  } catch {
    return [];
  }
}

/** The full command line of a live pid, or null when no such process exists. */
export function commandLineOf(pid: number): string | null {
  try {
    const out = execFileSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out === "" ? null : out;
  } catch {
    return null; // ps exits 1 when the pid does not exist
  }
}

/**
 * Pids (other than this process) whose command line contains `marker`.
 * Used to find leftovers of a server whose wrapper has already exited.
 */
export function pidsWithCommandContaining(marker: string): number[] {
  if (!marker) return [];
  try {
    const out = execFileSync("ps", ["-A", "-ww", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const pids: number[] = [];
    for (const line of out.split("\n")) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (m && Number(m[1]) !== process.pid && m[2].includes(marker)) pids.push(Number(m[1]));
    }
    return pids;
  } catch {
    return [];
  }
}

export function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    /* already gone */
  }
}

/** Signal a whole process group (the child was spawned `detached`, so its pgid is its pid). */
export function signalGroup(pgid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pgid, sig);
  } catch {
    /* group already gone */
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
