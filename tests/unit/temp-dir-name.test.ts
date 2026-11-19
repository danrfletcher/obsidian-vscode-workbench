/**
 * `tempDir()` naming (tests/helpers.ts) and what the global setup puts in a worker's environment (tests/global-setup.ts).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordLease } from "../global-setup";
import { isAlive, tempDir, tempDirForRun } from "../helpers";
import { LEDGER_ENV, RUN_ENV, ledgerFile, leaseDirOf, leaseFile, runnersNamedIn, startTimeOf } from "../sweep-leftovers";

const RANDOM = "[A-Za-z0-9]{6}";

describe("the run the global setup names", () => {
  it("puts the runner's pid in the worker's environment: a live pid that is not this worker's", () => {
    const run = process.env[RUN_ENV];
    expect(run).toMatch(/^\d+$/);
    const pid = Number(run);
    expect(pid).toBeGreaterThan(1);
    expect(isAlive(pid)).toBe(true);
    // The runner is the vitest main process, not the worker that is running this test.
    expect(pid).not.toBe(process.pid);
  });

  it("has written the lease file for that pid, holding the runner's start time", () => {
    const pid = Number(process.env[RUN_ENV]);
    const lease = leaseFile(pid);
    expect(path.dirname(lease)).toBe(path.join(os.tmpdir(), "vscode-workbench-test-runs"));
    expect(fs.existsSync(lease)).toBe(true);
    const start = startTimeOf(pid);
    expect(start).toBeTruthy();
    expect(fs.readFileSync(lease, "utf8").trim()).toBe(start);
  });

  it("names the run's ledger in the same folder as its lease, and writes nothing to it", () => {
    const pid = Number(process.env[RUN_ENV]);
    expect(process.env[LEDGER_ENV]).toBe(ledgerFile(pid));
    expect(path.dirname(ledgerFile(pid))).toBe(leaseDirOf());
    expect(fs.existsSync(ledgerFile(pid))).toBe(false);
  });
});

describe("tempDir naming", () => {
  let created: string;
  const saved = process.env[RUN_ENV];
  afterEach(() => {
    if (saved === undefined) delete process.env[RUN_ENV];
    else process.env[RUN_ENV] = saved;
  });

  it("the default prefix gives vscode-workbench-test-<WORKBENCH_TEST_RUN>-<random>, in the temp dir", () => {
    created = tempDir();
    expect(path.dirname(created)).toBe(os.tmpdir());
    expect(path.basename(created)).toMatch(new RegExp(`^vscode-workbench-test-${saved}-${RANDOM}$`));
    expect(fs.statSync(created).isDirectory()).toBe(true);
    expect(runnersNamedIn(created)).toEqual([Number(saved)]);
  });

  it("removed the previous test's dir in afterEach", () => {
    expect(created).toBeTruthy();
    expect(fs.existsSync(created)).toBe(false);
  });

  it("a custom prefix is used as given, with no runner pid in it", () => {
    for (const prefix of ["exthost-log-", "ctc-cwd-"]) {
      const d = tempDir(prefix);
      expect(path.basename(d)).toMatch(new RegExp(`^${prefix}${RANDOM}$`));
      expect(runnersNamedIn(d)).toEqual([]);
    }
  });

  it("a name for another runner carries that pid", () => {
    const d = tempDirForRun(4242);
    expect(path.basename(d)).toMatch(new RegExp(`^vscode-workbench-test-4242-${RANDOM}$`));
    expect(runnersNamedIn(d)).toEqual([4242]);
  });

  it("with the run variable unset it gives the old name, never a runner pid, and does not throw (a deliberate choice)", () => {
    delete process.env[RUN_ENV];
    const d = tempDir();
    expect(path.basename(d)).toMatch(new RegExp(`^vscode-workbench-test-${RANDOM}$`));
    // The old-style name is never read as a runner pid, so no sweep ends anything on its account.
    expect(runnersNamedIn(d)).toEqual([]);
    expect(runnersNamedIn(`${d}/token`)).toEqual([]);
    expect(fs.statSync(d).isDirectory()).toBe(true);
  });

  it("a value that is not a pid is not put in a path", () => {
    process.env[RUN_ENV] = "../evil";
    const d = tempDir();
    expect(path.dirname(d)).toBe(os.tmpdir());
    expect(path.basename(d)).toMatch(new RegExp(`^vscode-workbench-test-${RANDOM}$`));
  });
});

describe("names the sweep must not read as a runner", () => {
  it("the lease folder (and a lease or ledger in it) does not match the sweep's pattern", () => {
    expect(path.basename(leaseDirOf())).toBe("vscode-workbench-test-runs");
    expect(runnersNamedIn(leaseDirOf())).toEqual([]);
    expect(runnersNamedIn(leaseFile(123))).toEqual([]);
    expect(runnersNamedIn(ledgerFile(123))).toEqual([]);
  });

  it("an old-style dir such as vscode-workbench-test-AbC123 is never read as a runner pid", () => {
    for (const name of ["vscode-workbench-test-AbC123", "vscode-workbench-test-123456", "vscode-workbench-test-123456/token"]) {
      expect(runnersNamedIn(path.join(os.tmpdir(), name))).toEqual([]);
    }
  });
});

describe("recordLease: a stale lease at this pid never survives the setup", () => {
  const PID = 4242424;
  let dir: string;
  beforeEach(() => {
    dir = tempDir();
    fs.writeFileSync(leaseFile(PID, dir), "Mon Jan  1 00:00:00 2001\n");
  });

  it("replaces a stale lease from an earlier holder of the pid with this runner's start time", () => {
    recordLease(PID, dir, () => "Thu Nov 19 17:00:00 2026");
    expect(fs.readFileSync(leaseFile(PID, dir), "utf8")).toBe("Thu Nov 19 17:00:00 2026\n");
  });

  it("removes the stale lease when the start time cannot be read, and writes none", () => {
    recordLease(PID, dir, () => undefined);
    expect(fs.existsSync(leaseFile(PID, dir))).toBe(false);
  });

  it("removes the stale lease when the new one cannot be written, and does not throw", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      recordLease(PID, dir, () => {
        throw new Error("ps is gone");
      });
      expect(fs.existsSync(leaseFile(PID, dir))).toBe(false);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("ps is gone"));
    } finally {
      log.mockRestore();
    }
  });

  it("leaves other runners' leases alone", () => {
    fs.writeFileSync(leaseFile(PID + 1, dir), "other\n");
    recordLease(PID, dir, () => undefined);
    expect(fs.readFileSync(leaseFile(PID + 1, dir), "utf8")).toBe("other\n");
  });
});
