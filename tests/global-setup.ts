/**
 * Vitest `globalSetup`: runs once, in the main process, before any test file starts.
 *
 * 1. It names this run: WORKBENCH_TEST_RUN is the runner's pid, which `tempDir()` puts in every temp dir name, so a fake server
 *    started by this run carries the pid on its command line.
 * 2. It records the runner's start time in a lease file, so a later run can tell a dead runner from a pid that was reused.
 * 3. It names the run's fake-server ledger in FAKE_CODE_LEDGER (a path next to the lease). Nothing writes to it yet.
 * 4. It ends what earlier, killed runs left behind (tests/sweep-leftovers.ts). The sweep finishes before the first test file starts.
 *
 * A setup that throws would fail the whole run, so nothing here is allowed to: a problem with the lease or the sweep costs only
 * the sweep, with one line saying so.
 */
import * as fs from "node:fs";
import { LEDGER_ENV, RUN_ENV, ledgerFile, leaseDirOf, leaseFile, startTimeOf, sweepLeftovers } from "./sweep-leftovers";

export { LEDGER_ENV, RUN_ENV, ledgerFile, leaseDirOf, leaseFile };

/**
 * Writes this runner's lease, after removing any lease already at that pid: a leftover from an earlier holder of the pid (macOS
 * pids wrap) names a different start time, and a sweep that read it would take this live runner for a reused pid and end its fakes.
 * With no start time, or a failed write, there is then no lease at all: a live runner without one is left alone by every sweep.
 * Never throws. `startOf` is a parameter so a test can stand in for a platform where the start time cannot be read.
 */
export function recordLease(pid: number, dir: string, startOf: (pid: number) => string | undefined = startTimeOf): void {
  try {
    fs.rmSync(leaseFile(pid, dir), { force: true });
    fs.mkdirSync(dir, { recursive: true });
    const start = startOf(pid);
    if (start) fs.writeFileSync(leaseFile(pid, dir), `${start}\n`);
  } catch (e) {
    console.log(`test sweep: could not write this run's lease (${(e as Error).message}); a later sweep leaves this run alone`);
  }
}

export async function setup(): Promise<void> {
  const pid = process.pid;
  process.env[RUN_ENV] = String(pid);
  const dir = leaseDirOf();
  process.env[LEDGER_ENV] = ledgerFile(pid, dir);
  recordLease(pid, dir);
  try {
    await sweepLeftovers({ leaseDir: dir });
  } catch (e) {
    console.log(`test sweep skipped: ${(e as Error).message}`);
  }
}

/** A run that ends cleanly drops its lease. A killed run runs no teardown: its lease stays, and the next sweep reads it. */
export function teardown(): void {
  try {
    fs.rmSync(leaseFile(process.pid), { force: true });
  } catch {
    /* a stale lease is harmless */
  }
}
