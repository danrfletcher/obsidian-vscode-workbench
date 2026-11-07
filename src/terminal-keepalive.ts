/**
 * Terminal keep-alive (G10): is there a live terminal shell under the server? The idle clock asks this as its third
 * input, so the server never idle-stops while a shell lives, however the drawer is shown.
 *
 * Process-tree mode, chosen from the spike's finding `live_shells: reliable` (docs/terminal-spike.md, S4): VS Code's pty
 * host (`... --type=ptyHost`) runs under the server, and every terminal is one child process of it (an idle prompt has no
 * child of its own, a running command is a child of the shell). So a live shell is a direct child of a pty host that is
 * itself under the server's pid. A shell that is hung (stopped) is still its child and counts until it is closed; a shell
 * that has exited is gone from the table, even when its tab is left on the page, and does not.
 */
import { descendantsFromPs, readProcessTable } from "./process-utils";

const PTY_HOST = /(?:^|\s)--type=ptyHost(?:\s|$)/;

interface Row {
  pid: number;
  ppid: number;
  command: string;
}

/** Parse `ps -A -o pid=,ppid=,command=` text; a line that is not `<pid> <ppid> <command>` is skipped. */
function parseRows(psOutput: string): Row[] {
  const rows: Row[] = [];
  for (const line of psOutput.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*\S)\s*$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] });
  }
  return rows;
}

/** A process that has exited but has not been collected yet: `ps` shows `(zsh)` (macOS) or `[zsh] <defunct>` (Linux). Its shell is gone. */
const isDefunct = (command: string): boolean => /<defunct>\s*$/.test(command) || /^\(.*\)$/.test(command);

/**
 * The pids of the live terminal shells under `rootPid` (the server's wrapper process), from the text of
 * `ps -A -o pid=,ppid=,command=`. Empty for an empty or unreadable table, or a root that is not in it.
 */
export function liveShellPids(psOutput: string, rootPid: number): number[] {
  const under = new Set(descendantsFromPs(psOutput, rootPid));
  const rows = parseRows(psOutput);
  const ptyHosts = new Set(rows.filter((r) => under.has(r.pid) && PTY_HOST.test(r.command)).map((r) => r.pid));
  return rows.filter((r) => ptyHosts.has(r.ppid) && !isDefunct(r.command)).map((r) => r.pid);
}

/**
 * True while a live terminal shell exists under `serverPid`. Rejects when the process table cannot be read: the idle clock
 * reads a rejection as "cannot tell" and keeps the server up. `read` is the process table reader (tests pass their own).
 */
export async function hasLiveTerminalShell(serverPid: number | undefined, read: () => Promise<string> = readProcessTable): Promise<boolean> {
  if (serverPid === undefined) return false; // no server process, so nothing under it
  return liveShellPids(await read(), serverPid).length > 0;
}
