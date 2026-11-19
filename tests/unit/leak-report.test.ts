/**
 * The end-of-run leak report (tests/leak-report.ts), table-driven. Only `ps` (the injected `inspect`, one call for all pids) and
 * the clock (`sleep`, `now`) are stand-ins; the ledger text goes through the real parser and the real decision, and a few cases
 * read a real file with the real default reader. The real `ps` is checked against this very process.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  POLL_INTERVAL_MS,
  POLL_WINDOW_MS,
  defaultInspect,
  isLeak,
  leakLine,
  parseLedger,
  parsePsRows,
  reportLeaks,
  type Inspect,
  type ProcInfo,
} from "../leak-report";
import { tempDir } from "../helpers";

/** A ledger line as the fake writes it. */
const line = (pid: number | string, start: string, dir: string): string => `${pid}\t${start}\t${dir}\n`;
const START = "Thu Nov 19 18:36:02 2026";
const OTHER_START = "Thu Nov 19 19:01:44 2026";

/** A fake clock: `sleep` moves it, nothing waits. */
function clock() {
  let t = 1_000_000;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
    elapsed: () => t - 1_000_000,
  };
}

/** `ps` stand-in: `alive` says, per call number (0-based), what the process table holds. Records every call's pid list. */
function fakePs(alive: (call: number, pid: number) => ProcInfo | undefined) {
  const calls: number[][] = [];
  const inspect: Inspect = (pids) => {
    const call = calls.length;
    calls.push([...pids]);
    const table = new Map<number, ProcInfo>();
    for (const pid of pids) {
      const info = alive(call, pid);
      if (info) table.set(pid, info);
    }
    return table;
  };
  return { inspect, calls };
}

const up: ProcInfo = { stat: "Ss", start: START };

async function run(ledger: string | undefined, ps: Inspect, extra: { windowMs?: number } = {}) {
  const c = clock();
  const printed: string[] = [];
  const result = await reportLeaks("/ledger", { inspect: ps, sleep: c.sleep, now: c.now, print: (l) => printed.push(l), readFile: () => ledger ?? "", ...extra });
  return { printed, result, clock: c };
}

describe("parseLedger", () => {
  const cases: { name: string; text: string; want: { pid: number; start: string; dir: string }[] }[] = [
    { name: "empty file", text: "", want: [] },
    { name: "one well-formed line", text: line(4242, START, "/tmp/a"), want: [{ pid: 4242, start: START, dir: "/tmp/a" }] },
    { name: "an empty line is skipped", text: `\n${line(4242, START, "/tmp/a")}\n`, want: [{ pid: 4242, start: START, dir: "/tmp/a" }] },
    { name: "one field is skipped", text: `4242\n${line(7, START, "/tmp/b")}`, want: [{ pid: 7, start: START, dir: "/tmp/b" }] },
    { name: "two fields are skipped", text: `4242\t${START}\n${line(7, START, "/tmp/b")}`, want: [{ pid: 7, start: START, dir: "/tmp/b" }] },
    { name: "a non-numeric pid is skipped", text: line("abc", START, "/tmp/a") + line("12x", START, "/tmp/a") + line(8, START, "/tmp/c"), want: [{ pid: 8, start: START, dir: "/tmp/c" }] },
    { name: "pid 0, 1 and a negative pid are skipped", text: line(0, START, "/x") + line(1, START, "/x") + line("-5", START, "/x") + line(9, START, "/ok"), want: [{ pid: 9, start: START, dir: "/ok" }] },
    { name: "a pid too large to be exact is skipped", text: line("99999999999999999999", START, "/x"), want: [] },
    { name: "an empty start time or path is skipped", text: line(5, "", "/x") + line(6, START, "") + line(7, START, "  "), want: [] },
    { name: "a truncated last line (no line break) is skipped, the lines before it are kept", text: line(4242, START, "/tmp/a") + `5555\t${START}\t/tmp/tru`, want: [{ pid: 4242, start: START, dir: "/tmp/a" }] },
    { name: "a last line with no line break is skipped even when it has three fields", text: `${line(1234, START, "/tmp/a")}6666\t${START}\t/tmp/b`, want: [{ pid: 1234, start: START, dir: "/tmp/a" }] },
    { name: "the same entry twice is one", text: line(4242, START, "/tmp/a") + line(4242, START, "/tmp/a"), want: [{ pid: 4242, start: START, dir: "/tmp/a" }] },
    { name: "a path with spaces and unicode is kept whole", text: line(4242, START, "/tmp/my dir/vscode-workbench-test-1-é世界 ✓"), want: [{ pid: 4242, start: START, dir: "/tmp/my dir/vscode-workbench-test-1-é世界 ✓" }] },
    { name: "a tab inside the path stays in the path", text: line(4242, START, "/tmp/a\tb"), want: [{ pid: 4242, start: START, dir: "/tmp/a\tb" }] },
    { name: "the start time's white space is collapsed", text: line(4242, "Thu Nov  9 08:01:02 2026", "/tmp/a"), want: [{ pid: 4242, start: "Thu Nov 9 08:01:02 2026", dir: "/tmp/a" }] },
    { name: "bad lines between good ones", text: line(1111, START, "/a") + "garbage\n" + line(2222, START, "/b"), want: [{ pid: 1111, start: START, dir: "/a" }, { pid: 2222, start: START, dir: "/b" }] },
  ];
  it.each(cases)("$name", ({ text, want }) => {
    expect(parseLedger(text)).toEqual(want);
  });
});

describe("parsePsRows", () => {
  it("reads pid, stat and the start time (which holds spaces)", () => {
    const rows = parsePsRows(`  4242 Ss   Thu Nov 19 18:36:02 2026\n 77 Z+ Thu Nov  9 08:01:02 2026\n\nnot a row\n`);
    expect([...rows]).toEqual([
      [4242, { stat: "Ss", start: "Thu Nov 19 18:36:02 2026" }],
      [77, { stat: "Z+", start: "Thu Nov 9 08:01:02 2026" }],
    ]);
  });
});

describe("isLeak: one entry against what the process table says", () => {
  const entry = { pid: 10, start: START, dir: "/d" };
  const cases: { name: string; info: ProcInfo | undefined; leak: boolean }[] = [
    { name: "alive with the recorded start time", info: { stat: "S", start: START }, leak: true },
    { name: "running state R+", info: { stat: "R+", start: START }, leak: true },
    { name: "gone (not in the table)", info: undefined, leak: false },
    { name: "pid reused (another start time)", info: { stat: "S", start: OTHER_START }, leak: false },
    { name: "zombie Z", info: { stat: "Z", start: START }, leak: false },
    { name: "zombie Z+", info: { stat: "Z+", start: START }, leak: false },
    { name: "stopped T is still alive", info: { stat: "T", start: START }, leak: true },
  ];
  it.each(cases)("$name", ({ info, leak }) => {
    expect(isLeak(entry, info)).toBe(leak);
  });
});

describe("reportLeaks: what is printed", () => {
  it("prints exactly `leaked server: pid <n> from <temp dir>` for a live fake", async () => {
    const { printed, result } = await run(line(4242, START, "/tmp/vscode-workbench-test-99-abc"), fakePs(() => up).inspect);
    expect(printed).toEqual(["leaked server: pid 4242 from /tmp/vscode-workbench-test-99-abc"]);
    expect(result).toEqual(printed);
  });

  it("prints one line per live fake, in ledger order, and none for the dead, the reused and the zombie", async () => {
    const ledger = [line(11, START, "/d/one"), line(12, START, "/d/gone"), line(13, START, "/d/reused"), line(14, START, "/d/zombie"), line(15, START, "/d/two")].join("");
    const table: Record<number, ProcInfo | undefined> = {
      11: { stat: "S", start: START },
      13: { stat: "S", start: OTHER_START },
      14: { stat: "Z", start: START },
      15: { stat: "Ss", start: START },
    };
    const { printed } = await run(ledger, fakePs((_c, pid) => table[pid]).inspect);
    expect(printed).toEqual(["leaked server: pid 11 from /d/one", "leaked server: pid 15 from /d/two"]);
  });

  it("prints a path with spaces and unicode whole and unchanged", async () => {
    const dir = "/var/folders/x y/T/vscode-workbench-test-1234-ñ世 ✓ [a](b)";
    const { printed } = await run(line(4242, START, dir), fakePs(() => up).inspect);
    expect(printed).toEqual([`leaked server: pid 4242 from ${dir}`]);
    expect(leakLine({ pid: 4242, start: START, dir })).toBe(printed[0]);
  });

  it("prints nothing when no fake is alive, and does not poll", async () => {
    const ps = fakePs(() => undefined);
    const { printed, clock: c } = await run(line(4242, START, "/d"), ps.inspect);
    expect(printed).toEqual([]);
    expect(ps.calls).toHaveLength(1);
    expect(c.sleeps).toEqual([]);
  });

  it("prints nothing for an empty ledger and never asks `ps`", async () => {
    const ps = fakePs(() => up);
    expect((await run("", ps.inspect)).printed).toEqual([]);
    expect(ps.calls).toEqual([]);
  });

  it("a ledger of only malformed lines prints nothing and never asks `ps`", async () => {
    const ps = fakePs(() => up);
    expect((await run(`\nabc\t${START}\t/d\n4242\n7\t${START}`, ps.inspect)).printed).toEqual([]);
    expect(ps.calls).toEqual([]);
  });

  it("malformed lines are skipped and the well-formed lines in the same file are still checked", async () => {
    const ledger = `\n99\nxyz\t${START}\t/bad\n${line(4242, START, "/d/good")}${line(5, START, "/d/also")}6\t${START}\t/trunc`;
    const ps = fakePs(() => up);
    const { printed } = await run(ledger, ps.inspect);
    expect(printed).toEqual(["leaked server: pid 4242 from /d/good", "leaked server: pid 5 from /d/also"]);
    expect(ps.calls[0]).toEqual([4242, 5]);
  });

  it("prints nothing when `ps` cannot be asked", async () => {
    const { printed } = await run(line(4242, START, "/d"), () => undefined);
    expect(printed).toEqual([]);
  });

  it("prints nothing when `ps` throws, and does not throw itself", async () => {
    const { printed } = await run(line(4242, START, "/d"), () => {
      throw new Error("ps broke");
    });
    expect(printed).toEqual([]);
  });

  it("a `print` that throws costs that line only and does not throw out of the report", async () => {
    const c = clock();
    const seen: string[] = [];
    const lines = await reportLeaks("/l", {
      inspect: fakePs(() => up).inspect,
      sleep: c.sleep,
      now: c.now,
      readFile: () => line(1111, START, "/a") + line(2222, START, "/b"),
      print: (l) => {
        seen.push(l);
        if (l.includes("1111")) throw new Error("stdout closed");
      },
    });
    expect(seen).toEqual(["leaked server: pid 1111 from /a", "leaked server: pid 2222 from /b"]);
    expect(lines).toHaveLength(2);
  });
});

describe("reportLeaks: the ledger file", () => {
  it("an unset path prints nothing and does not read", async () => {
    let read = 0;
    const out: string[] = [];
    await reportLeaks(undefined, { readFile: () => ((read += 1), ""), print: (l) => out.push(l), inspect: fakePs(() => up).inspect });
    await reportLeaks("", { readFile: () => ((read += 1), ""), print: (l) => out.push(l), inspect: fakePs(() => up).inspect });
    expect(read).toBe(0);
    expect(out).toEqual([]);
  });

  it("a reader that throws (missing, unreadable, a directory) prints nothing and does not throw", async () => {
    const out: string[] = [];
    for (const code of ["ENOENT", "EACCES", "EISDIR", "ENOSPC", "EIO"]) {
      await expect(
        reportLeaks("/l", {
          readFile: () => {
            throw Object.assign(new Error(code), { code });
          },
          print: (l) => out.push(l),
          inspect: fakePs(() => up).inspect,
        }),
      ).resolves.toEqual([]);
    }
    expect(out).toEqual([]);
  });

  it("the default reader: a missing file, a directory and an unreadable file (mode 000) print nothing", async ({ skip }) => {
    if (process.getuid?.() === 0) skip(); // root reads a mode-000 file
    const dir = tempDir();
    const out: string[] = [];
    const ps = fakePs(() => up);
    const unreadable = path.join(dir, "unreadable.ledger");
    fs.writeFileSync(unreadable, line(4242, START, "/d"));
    fs.chmodSync(unreadable, 0o000);
    const asDir = path.join(dir, "a-directory.ledger");
    fs.mkdirSync(asDir);
    for (const file of [path.join(dir, "missing.ledger"), asDir, unreadable]) {
      await expect(reportLeaks(file, { print: (l) => out.push(l), inspect: ps.inspect })).resolves.toEqual([]);
    }
    fs.chmodSync(unreadable, 0o600);
    // nothing was read, so `ps` was never asked
    expect(ps.calls).toEqual([]);
    expect(out).toEqual([]);
  });

  it("the default reader reads a real file", async () => {
    const dir = tempDir();
    const file = path.join(dir, "1.ledger");
    fs.writeFileSync(file, line(4242, START, "/d/real"));
    const out: string[] = [];
    await reportLeaks(file, { print: (l) => out.push(l), inspect: fakePs(() => up).inspect, sleep: async () => {}, windowMs: 0 });
    expect(out).toEqual(["leaked server: pid 4242 from /d/real"]);
  });
});

describe("reportLeaks: polling for up to 3 s", () => {
  it("the window is 3 s and the gap 200 ms", () => {
    expect(POLL_WINDOW_MS).toBe(3000);
    expect(POLL_INTERVAL_MS).toBe(200);
  });

  it("a fake that is alive at the first check and gone within 3 s is not reported, and the poll stops at once", async () => {
    // alive for the first 5 checks (1 s of polling), then gone
    const ps = fakePs((call) => (call < 5 ? up : undefined));
    const { printed, clock: c } = await run(line(4242, START, "/d"), ps.inspect);
    expect(printed).toEqual([]);
    expect(ps.calls).toHaveLength(6);
    expect(c.elapsed()).toBe(5 * POLL_INTERVAL_MS);
  });

  it("a fake that is still alive at 3 s is reported, after about 3 s and not much more", async () => {
    const ps = fakePs(() => up);
    const { printed, clock: c } = await run(line(4242, START, "/d"), ps.inspect);
    expect(printed).toEqual(["leaked server: pid 4242 from /d"]);
    expect(c.elapsed()).toBeGreaterThanOrEqual(3000);
    expect(c.elapsed()).toBeLessThan(3000 + POLL_INTERVAL_MS);
  });

  it("a fake that goes just before the window ends is not reported; one that goes just after is", async () => {
    const goneAt = (ms: number) => fakePs((call) => (call * POLL_INTERVAL_MS < ms ? up : undefined));
    expect((await run(line(4242, START, "/d"), goneAt(2800).inspect)).printed).toEqual([]);
    expect((await run(line(4242, START, "/d"), goneAt(100_000).inspect)).printed).toHaveLength(1);
  });

  it("only the pids still alive are asked about on the next round, and each round is one `ps` call", async () => {
    // 11 is gone from the second look on, 12 from the fourth, 13 stays
    const ps = fakePs((call, pid) => (pid === 11 ? (call < 1 ? up : undefined) : pid === 12 ? (call < 3 ? up : undefined) : up));
    const { printed } = await run(line(11, START, "/a") + line(12, START, "/b") + line(13, START, "/c"), ps.inspect);
    expect(printed).toEqual(["leaked server: pid 13 from /c"]);
    expect(ps.calls[0]).toEqual([11, 12, 13]);
    expect(ps.calls[1]).toEqual([11, 12, 13]); // 11 is still in the table on the second look (call 0 was the first)
    expect(ps.calls[2]).toEqual([12, 13]);
    expect(ps.calls[4]).toEqual([13]);
  });

  it("a pid that shows another start time is dropped at once and never polled again", async () => {
    const ps = fakePs(() => ({ stat: "S", start: OTHER_START }));
    const { printed, clock: c } = await run(line(4242, START, "/d"), ps.inspect);
    expect(printed).toEqual([]);
    expect(ps.calls).toHaveLength(1);
    expect(c.sleeps).toEqual([]);
  });

  it("a zombie at first that never goes is not reported (it is already dead)", async () => {
    const { printed } = await run(line(4242, START, "/d"), fakePs(() => ({ stat: "Z", start: START })).inspect);
    expect(printed).toEqual([]);
  });

  it("a custom window and gap are honoured", async () => {
    const c = clock();
    const ps = fakePs(() => up);
    const out: string[] = [];
    await reportLeaks("/l", { inspect: ps.inspect, sleep: c.sleep, now: c.now, print: (l) => out.push(l), readFile: () => line(10, START, "/d"), windowMs: 1000, intervalMs: 500 });
    expect(c.sleeps).toEqual([500, 500]);
    expect(out).toHaveLength(1);
  });
});

describe("reportLeaks: sizes (0, 1 and 700 lines)", () => {
  it.each([0, 1, 700])("%i ledger lines: one printed line per live leak, one `ps` call per round, all pids in it", async (n) => {
    const pids = Array.from({ length: n }, (_, i) => 1000 + i);
    const ledger = pids.map((p) => line(p, START, `/d/${p}`)).join("");
    const liveSet = new Set(pids.filter((p) => p % 7 === 0));
    const ps = fakePs((_c, pid) => (liveSet.has(pid) ? up : undefined));
    const { printed } = await run(ledger, ps.inspect);
    expect(printed).toEqual(pids.filter((p) => liveSet.has(p)).map((p) => `leaked server: pid ${p} from /d/${p}`));
    if (n > 0) {
      expect(ps.calls[0]).toEqual(pids);
      // every round is one call, so the number of calls is the number of polls, not of pids
      expect(ps.calls.length).toBeLessThanOrEqual(Math.ceil(POLL_WINDOW_MS / POLL_INTERVAL_MS) + 1);
    }
  });

  it("700 lines with the real `ps` finish well inside the poll window", async () => {
    // 700 pids that are not running processes: pids above the system's range are never in the table
    const ledger = Array.from({ length: 700 }, (_, i) => line(4_000_000 + i, START, `/d/${i}`)).join("");
    const out: string[] = [];
    const t0 = Date.now();
    await reportLeaks("/l", { readFile: () => ledger, print: (l) => out.push(l) });
    expect(out).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(POLL_WINDOW_MS);
  });
});

describe("the real `ps` (defaultInspect)", () => {
  it("finds this process with its start time and not a zombie, and leaves out a pid that is not running", () => {
    const table = defaultInspect([process.pid, 4_000_001]);
    expect(table).toBeDefined();
    const me = table!.get(process.pid);
    expect(me).toBeDefined();
    expect(me!.stat.startsWith("Z")).toBe(false);
    expect(me!.start).toMatch(/^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/);
    expect(table!.has(4_000_001)).toBe(false);
    expect(isLeak({ pid: process.pid, start: me!.start, dir: "/d" }, me)).toBe(true);
  });

  it("answers an empty table (not a failure) when no pid is running, and for an empty list", () => {
    expect(defaultInspect([4_000_001, 4_000_002])).toEqual(new Map());
    expect(defaultInspect([])).toEqual(new Map());
  });
});
