/**
 * What the server's process tree shows for each shell state (S4 of the terminal spike, docs/terminal-spike.md), pinned
 * to data: `descendantsFromPs` is the function the plugin's stop and sweep use to find everything under the server.
 *
 * The fixtures are the `ps -A -o pid=,ppid=` shape of the tree measured by `npm run check:terminal-spike`:
 * wrapper 100 -> cli 101 -> tunnel 102 -> launcher 103 -> server-main 104 -> { extension host 110, pty host 120 },
 * and under the pty host one `zsh -il` per terminal. The numbers are made up; the shape is the measured one.
 */
import { describe, expect, it } from "vitest";
import { descendantsFromPs } from "../../src/process-utils";

const WRAPPER = 100;
const SERVER_CHAIN = ["101 100", "102 101", "103 102", "104 103", "110 104", "120 104"];
const PTY_HOST = 120;

const ps = (...rows: string[]) => rows.map((r) => `  ${r}`).join("\n") + "\n";

interface Case {
  name: string;
  /** The ps output. */
  rows: string[];
  /** Shells (children of the pty host) that must be reported as live. */
  liveShells: number[];
  /** Every descendant of the wrapper. */
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
    rows: [...SERVER_CHAIN, "130 120"],
    liveShells: [130],
    all: [101, 102, 103, 104, 110, 120, 130],
  },
  {
    name: "a running command: the shell has a child, and the child's child",
    rows: [...SERVER_CHAIN, "130 120", "131 130", "132 131"],
    liveShells: [130],
    all: [101, 102, 103, 104, 110, 120, 130, 131, 132],
  },
  {
    name: "two terminals, one idle and one running a dev server",
    rows: [...SERVER_CHAIN, "130 120", "140 120", "141 140"],
    liveShells: [130, 140],
    all: [101, 102, 103, 104, 110, 120, 130, 140, 141],
  },
  {
    name: "an exited shell with a leftover tab: of two terminals only the one whose shell is still running is in the tree",
    rows: [...SERVER_CHAIN, "130 120" /* the terminal 140 was beside is gone from ps; its tab may remain */],
    liveShells: [130],
    all: [101, 102, 103, 104, 110, 120, 130],
  },
  {
    name: "a reparented child: a nohup/disown process whose shell exited is now a child of init and is not under the server",
    rows: [...SERVER_CHAIN, "130 120", "900 1"],
    liveShells: [130],
    all: [101, 102, 103, 104, 110, 120, 130],
  },
  {
    name: "a reparented child of a killed shell: its parent is init, so the walk does not reach it",
    rows: [...SERVER_CHAIN, "131 1", "132 131"],
    liveShells: [],
    all: [101, 102, 103, 104, 110, 120],
  },
  {
    name: "a nohup process still under its (live) shell is reached through the shell",
    rows: [...SERVER_CHAIN, "130 120", "133 130"],
    liveShells: [130],
    all: [101, 102, 103, 104, 110, 120, 130, 133],
  },
  {
    name: "a stopped shell (ps state T) is still a child of the pty host: the tree alone cannot tell it from a live one",
    rows: [...SERVER_CHAIN, "130 120", "140 120"],
    liveShells: [130, 140],
    all: [101, 102, 103, 104, 110, 120, 130, 140],
  },
];

describe("descendantsFromPs over measured server trees", () => {
  it.each(CASES)("$name", ({ rows, liveShells, all }) => {
    const out = descendantsFromPs(ps(...rows), WRAPPER);
    expect([...out].sort((a, b) => a - b)).toEqual(all);
    const shells = rows
      .map((r) => r.split(" ").map(Number))
      .filter(([pid, ppid]) => ppid === PTY_HOST && out.includes(pid))
      .map(([pid]) => pid);
    expect(shells).toEqual(liveShells);
  });

  it("returns nothing for a wrapper that is not in the output", () => {
    expect(descendantsFromPs(ps(...SERVER_CHAIN), 999)).toEqual([]);
  });

  it("does not include the root itself", () => {
    expect(descendantsFromPs(ps(...SERVER_CHAIN), WRAPPER)).not.toContain(WRAPPER);
  });

  it("walks a whole terminal's subtree from the pty host down", () => {
    expect(descendantsFromPs(ps(...SERVER_CHAIN, "130 120", "131 130", "132 131", "140 120"), PTY_HOST).sort((a, b) => a - b)).toEqual([130, 131, 132, 140]);
  });

  it("ignores blank and malformed lines", () => {
    const out = descendantsFromPs(`\n  ${SERVER_CHAIN.join("\n  ")}\n  garbage\n\n`, WRAPPER);
    expect(out).toEqual([101, 102, 103, 104, 110, 120]);
  });
});
