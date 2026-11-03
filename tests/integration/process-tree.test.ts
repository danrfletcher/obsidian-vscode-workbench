/**
 * What the server's process tree shows for each shell state (S4 of the terminal spike, docs/terminal-spike.md), pinned
 * to data. Two real functions read it: `descendantsFromPs` (the plugin's stop and sweep use it to find everything under
 * the server) and `liveShellPids` (the idle clock's third input: which children of the pty host are live shells).
 *
 * The fixtures are the `ps -A -o pid=,ppid=,command=` shape of the tree measured by `npm run check:terminal-spike`:
 * wrapper 100 -> cli 101 -> tunnel 102 -> launcher 103 -> server-main 104 -> { extension host 110, pty host 120 },
 * and under the pty host one `zsh -il` per terminal. The numbers are made up; the shape is the measured one. The
 * expected shell lists are written out here, not derived from the fixture rows.
 *
 * There is no stopped-shell case here: `ps -o pid=,ppid=,command=` has no state column, so a stopped shell (state T) has the
 * same row as a running one and a case with it would pin nothing. A hung shell counting as live is pinned with a real
 * SIGSTOPped shell in tests/integration/server-lifecycle.test.ts ("a hung shell (stopped with SIGSTOP) still counts").
 */
import { describe, expect, it } from "vitest";
import { liveShellPids } from "../../src/terminal-keepalive";
import { descendantsFromPs } from "../../src/process-utils";

const WRAPPER = 100;
const SERVER_CHAIN = [
  "101 100 /app/cli.js serve-web --host 127.0.0.1 --port 5000",
  "102 101 /app/code-tunnel serve-web --host 127.0.0.1 --port 5000",
  "103 102 bash /srv/bin/code-server --socket-path /tmp/s",
  "104 103 /srv/node /srv/out/server-main.js --socket-path /tmp/s",
  "110 104 /srv/node /srv/out/bootstrap-fork --type=extensionHost",
  "120 104 /srv/node /srv/out/bootstrap-fork --type=ptyHost --logsPath /tmp/logs",
];
const PTY_HOST = 120;
const SHELL = "/bin/zsh -il";

const ps = (...rows: string[]) => rows.map((r) => `  ${r}`).join("\n") + "\n";

interface Case {
  name: string;
  /** The ps output. */
  rows: string[];
  /** Shells (children of the pty host) that must be reported as live, written out by hand. */
  liveShells: number[];
  /** Every descendant of the wrapper, written out by hand. */
  all: number[];
}

const CASES: Case[] = [
  {
    name: "no terminal yet",
    rows: [...SERVER_CHAIN],
    liveShells: [],
    all: [101, 102, 103, 104, 110, 120],
  },
  {
    name: "an idle prompt: one shell, no child",
    rows: [...SERVER_CHAIN, `130 120 ${SHELL}`],
    liveShells: [130],
    all: [101, 102, 103, 104, 110, 120, 130],
  },
  {
    name: "a running command: the shell has a child, and the child's child; only the shell counts as a shell",
    rows: [...SERVER_CHAIN, `130 120 ${SHELL}`, "131 130 sleep 601", "132 131 sleep 602"],
    liveShells: [130],
    all: [101, 102, 103, 104, 110, 120, 130, 131, 132],
  },
  {
    name: "two terminals, one idle and one running a dev server",
    rows: [...SERVER_CHAIN, `130 120 ${SHELL}`, `140 120 ${SHELL}`, "141 140 node dev-server.js 8000"],
    liveShells: [130, 140],
    all: [101, 102, 103, 104, 110, 120, 130, 140, 141],
  },
  {
    name: "an exited shell with a leftover tab: of two terminals only the one whose shell is still running is in the tree",
    rows: [...SERVER_CHAIN, `130 120 ${SHELL}` /* the terminal 140 was beside is gone from ps; its tab may remain */],
    liveShells: [130],
    all: [101, 102, 103, 104, 110, 120, 130],
  },
  {
    name: "an exited shell not collected yet (macOS shows `(zsh)`): it is still a child of the pty host and in the tree, but it is not a live shell",
    rows: [...SERVER_CHAIN, `130 120 ${SHELL}`, "140 120 (zsh)"],
    liveShells: [130],
    all: [101, 102, 103, 104, 110, 120, 130, 140],
  },
  {
    name: "an exited shell not collected yet (Linux shows `[zsh] <defunct>`): in the tree, not a live shell",
    rows: [...SERVER_CHAIN, "130 120 [zsh] <defunct>"],
    liveShells: [],
    all: [101, 102, 103, 104, 110, 120, 130],
  },
  {
    name: "a reparented child: a nohup/disown process whose shell exited is now a child of init and is not under the server",
    rows: [...SERVER_CHAIN, `130 120 ${SHELL}`, "900 1 sleep 603"],
    liveShells: [130],
    all: [101, 102, 103, 104, 110, 120, 130],
  },
  {
    name: "a reparented child of a killed shell: its parent is init, so the walk does not reach it",
    rows: [...SERVER_CHAIN, "131 1 sleep 604", "132 131 sleep 605"],
    liveShells: [],
    all: [101, 102, 103, 104, 110, 120],
  },
  {
    name: "a nohup process still under its (live) shell is reached through the shell",
    rows: [...SERVER_CHAIN, `130 120 ${SHELL}`, "133 130 nohup sleep 606"],
    liveShells: [130],
    all: [101, 102, 103, 104, 110, 120, 130, 133],
  },
  {
    name: "a second process that looks like a pty host but is not under the server: its children are not this server's shells",
    rows: [...SERVER_CHAIN, `130 120 ${SHELL}`, "800 1 /other/node --type=ptyHost", `801 800 ${SHELL}`],
    liveShells: [130],
    all: [101, 102, 103, 104, 110, 120, 130],
  },
];

describe("process tree over measured server trees", () => {
  it.each(CASES)("$name", ({ rows, liveShells, all }) => {
    const text = ps(...rows);
    expect([...descendantsFromPs(text, WRAPPER)].sort((a, b) => a - b)).toEqual(all);
    expect(liveShellPids(text, WRAPPER).sort((a, b) => a - b)).toEqual(liveShells);
  });

  it("returns nothing for a wrapper that is not in the output", () => {
    expect(descendantsFromPs(ps(...SERVER_CHAIN), 999)).toEqual([]);
    expect(liveShellPids(ps(...SERVER_CHAIN, `130 120 ${SHELL}`), 999)).toEqual([]);
  });

  it("does not include the root itself", () => {
    expect(descendantsFromPs(ps(...SERVER_CHAIN), WRAPPER)).not.toContain(WRAPPER);
  });

  it("walks a whole terminal's subtree from the pty host down", () => {
    const text = ps(...SERVER_CHAIN, `130 120 ${SHELL}`, "131 130 sleep 601", "132 131 sleep 602", `140 120 ${SHELL}`);
    expect(descendantsFromPs(text, PTY_HOST).sort((a, b) => a - b)).toEqual([130, 131, 132, 140]);
  });

  it("ignores blank and malformed lines", () => {
    const text = `\n  ${SERVER_CHAIN.join("\n  ")}\n  garbage\n\n`;
    expect(descendantsFromPs(text, WRAPPER)).toEqual([101, 102, 103, 104, 110, 120]);
    expect(liveShellPids(text, WRAPPER)).toEqual([]);
  });
});
