/**
 * The idle clock (G13, G10, E5): every stop rule and every reset rule, on a fake clock.
 * Table rows are timelines of (time, visible Code tab, dirty buffer, live terminal shell)
 * changes and the instant the server must stop (or never).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDLE_MS, IdleTimer } from "../../src/idle-timer";

const MIN = 60_000;
const SEC = 1000;

interface Step {
  at: number;
  visible?: boolean;
  dirty?: boolean;
  shell?: boolean;
  /**
   * A shell opening or closing is never announced to the timer: the real plugin has no shell event (the shells live inside
   * VS Code's page), so only the poll or the re-check at the moment the clock runs out can see it. Rows time a shell step
   * just before a poll (polls fall on multiples of 5 s) and say when the poll sees it.
   */
}

interface Row {
  name: string;
  start: { visible: boolean; dirty: boolean; shell: boolean };
  steps: Step[];
  /** When the server must stop (ms after start), or null for never within `until`. */
  stopsAt: number | null;
  until: number;
  pollMs?: number;
}

const rows: Row[] = [
  { name: "nothing visible, nothing dirty: stops after exactly 5 minutes", start: { visible: false, dirty: false, shell: false }, steps: [], stopsAt: 5 * MIN, until: 6 * MIN },
  { name: "a visible Code tab all the time: never stops", start: { visible: true, dirty: false, shell: false }, steps: [], stopsAt: null, until: 30 * MIN },
  { name: "a dirty buffer all the time (tab hidden): never stops", start: { visible: false, dirty: true, shell: false }, steps: [], stopsAt: null, until: 30 * MIN },
  {
    name: "a tab visible until 4:59, then hidden: the clock restarts at 4:59 and stops at 9:59",
    start: { visible: true, dirty: false, shell: false },
    steps: [{ at: 4 * MIN + 59 * SEC, visible: false }],
    stopsAt: 9 * MIN + 59 * SEC,
    until: 11 * MIN,
  },
  {
    name: "becomes visible mid-countdown (at 4:59) and is hidden again at 6:00: stops at 11:00, not 5:00",
    start: { visible: false, dirty: false, shell: false },
    steps: [
      { at: 4 * MIN + 59 * SEC, visible: true },
      { at: 6 * MIN, visible: false },
    ],
    stopsAt: 11 * MIN,
    until: 12 * MIN,
  },
  {
    name: "dirty buffer saved at 4:00: the clock restarts from when the save is seen",
    start: { visible: false, dirty: true, shell: false },
    steps: [{ at: 4 * MIN + 500, dirty: false }],
    stopsAt: 4 * MIN + 1000 + 5 * MIN,
    until: 10 * MIN,
    pollMs: 1000,
  },
  {
    name: "buffer turns dirty at 4:30 (mid-countdown) and is saved at 10:00: no stop at 5:00; the poll sees the save at 10:01 and the clock runs out at 15:01",
    start: { visible: false, dirty: false, shell: false },
    steps: [
      { at: 4 * MIN + 30 * SEC, dirty: true },
      { at: 10 * MIN, dirty: false },
    ],
    stopsAt: 15 * MIN + SEC,
    until: 16 * MIN,
    pollMs: 1000,
  },
  {
    name: "buffer turns dirty 500 ms before the clock runs out and the poll has not seen it: the re-check at 5:00 keeps the server",
    start: { visible: false, dirty: false, shell: false },
    steps: [{ at: 5 * MIN - 500, dirty: true }],
    stopsAt: null,
    until: 5 * MIN + 10 * SEC,
    pollMs: 60 * MIN,
  },
  {
    name: "a visible tab that never goes away, with a dirty buffer that is saved: still no stop",
    start: { visible: true, dirty: true, shell: false },
    steps: [{ at: 2 * MIN, dirty: false }],
    stopsAt: null,
    until: 20 * MIN,
  },
  // --- the live terminal shell (G10, E5) ---
  { name: "a shell alive for 30 minutes (nothing else keeping the server up): never stops", start: { visible: false, dirty: false, shell: true }, steps: [], stopsAt: null, until: 30 * MIN },
  {
    name: "a shell alive for 30 minutes and then closed (the poll sees it at 30:00): the clock restarts at 30:00 and stops at 35:00",
    start: { visible: false, dirty: false, shell: true },
    steps: [{ at: 30 * MIN - 2 * SEC, shell: false }],
    stopsAt: 35 * MIN,
    until: 36 * MIN,
  },
  {
    name: "shell closes at minute 4 (the poll sees it at 4:00): the clock restarts from zero then and the server stops at minute 9, not minute 5",
    start: { visible: false, dirty: false, shell: true },
    steps: [{ at: 4 * MIN - 2 * SEC, shell: false }],
    stopsAt: 9 * MIN,
    until: 10 * MIN,
  },
  {
    name: "shell opens at 4:59 of a running countdown (nothing announces it; the poll or the re-check at 5:00 sees it): the countdown is cancelled and nothing stops at 5:00; it is closed at 8:00 and the server stops at 13:00",
    start: { visible: false, dirty: false, shell: false },
    steps: [
      { at: 4 * MIN + 59 * SEC, shell: true },
      { at: 8 * MIN - 2 * SEC, shell: false },
    ],
    stopsAt: 13 * MIN,
    until: 14 * MIN,
  },
  {
    name: "shell opens at 4:59 and is never closed: nothing stops at 5:00 or later",
    start: { visible: false, dirty: false, shell: false },
    steps: [{ at: 4 * MIN + 59 * SEC, shell: true }],
    stopsAt: null,
    until: 30 * MIN,
  },
  {
    name: "the last shell closes while a Code tab is visible: the server stays up because of the tab",
    start: { visible: true, dirty: false, shell: true },
    steps: [{ at: 2 * MIN, shell: false }],
    stopsAt: null,
    until: 30 * MIN,
  },
  {
    name: "the last shell closes while a buffer is dirty: the server stays up because of the buffer",
    start: { visible: false, dirty: true, shell: true },
    steps: [{ at: 2 * MIN, shell: false }],
    stopsAt: null,
    until: 30 * MIN,
  },
  {
    name: "a shell and a visible tab, the tab hidden at 3:00: the shell still keeps it up",
    start: { visible: true, dirty: false, shell: true },
    steps: [{ at: 3 * MIN, visible: false }],
    stopsAt: null,
    until: 30 * MIN,
  },
  {
    name: "a shell appears 500 ms before the clock runs out and no poll has seen it: the re-check at 5:00 (fire) keeps the server",
    start: { visible: false, dirty: false, shell: false },
    steps: [{ at: 5 * MIN - 500, shell: true }],
    stopsAt: null,
    until: 5 * MIN + 10 * SEC,
    pollMs: 60 * MIN,
  },
  {
    name: "a shell appears with no announcement and the poll sees it at 2:00: the countdown is cancelled",
    start: { visible: false, dirty: false, shell: false },
    steps: [{ at: 2 * MIN - 500, shell: true }],
    stopsAt: null,
    until: 30 * MIN,
    pollMs: 1000,
  },
];

let visible = false;
let dirty = false;
let shell = false;
let idleCalls: number[] = [];
let t0 = 0;

function make(pollMs: number, hasDirty?: () => boolean | Promise<boolean>, liveShell?: () => boolean | Promise<boolean>) {
  return new IdleTimer({
    visibleCodeTab: () => visible,
    hasDirtyBuffer: hasDirty ?? (() => dirty),
    liveTerminalShell: liveShell ?? (() => shell),
    onIdle: () => {
      idleCalls.push(Date.now() - t0);
    },
    pollMs,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  visible = false;
  dirty = false;
  shell = false;
  idleCalls = [];
  t0 = Date.now();
});
afterEach(() => vi.useRealTimers());

describe("IdleTimer: table over (visible tab, dirty buffer, live terminal shell, elapsed time)", () => {
  it("uses a 5 minute idle period", () => {
    expect(IDLE_MS).toBe(5 * MIN);
  });

  it.each(rows)("$name", async (row) => {
    visible = row.start.visible;
    dirty = row.start.dirty;
    shell = row.start.shell;
    const idle = make(row.pollMs ?? 5000);
    idle.start();
    await vi.advanceTimersByTimeAsync(0);

    // walk the clock to each step (and just before the expected stop), applying changes as they happen
    let now = 0;
    const advanceTo = async (target: number) => {
      if (target > now) await vi.advanceTimersByTimeAsync(target - now);
      now = Math.max(now, target);
    };
    for (const s of row.steps) {
      await advanceTo(s.at);
      if (s.visible !== undefined) {
        visible = s.visible;
        await idle.evaluate(); // tab events re-evaluate at once; dirty changes are only picked up by the poll
      }
      if (s.dirty !== undefined) dirty = s.dirty;
      if (s.shell !== undefined) {
        shell = s.shell;
        // no evaluate(): a shell coming or going alone is only seen by the poll
      }
    }
    if (row.stopsAt !== null) {
      await advanceTo(row.stopsAt - 1);
      expect(idleCalls, "not one millisecond early").toEqual([]);
      await advanceTo(row.stopsAt);
      expect(idleCalls).toEqual([row.stopsAt]);
    } else {
      await advanceTo(row.until);
      expect(idleCalls).toEqual([]);
    }
    // it stops once and then stays quiet
    await advanceTo(row.until + 30 * MIN);
    expect(idleCalls.length).toBe(row.stopsAt === null ? 0 : 1);
    idle.stop();
  });

  it("an error reading the dirty state counts as dirty: an unsaved buffer is never risked on a guess", async () => {
    const idle = make(1000, () => {
      throw new Error("webview not ready");
    });
    idle.start();
    await vi.advanceTimersByTimeAsync(20 * MIN);
    expect(idleCalls).toEqual([]);
    idle.stop();
  });

  it("an asynchronous dirty reader is awaited", async () => {
    dirty = true;
    const idle = make(1000, async () => dirty);
    idle.start();
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(idleCalls).toEqual([]);
    dirty = false;
    await vi.advanceTimersByTimeAsync(IDLE_MS + 2000);
    expect(idleCalls.length).toBe(1);
  });

  it("stop() cancels the countdown: nothing fires afterwards", async () => {
    const idle = make(1000);
    idle.start();
    await vi.advanceTimersByTimeAsync(4 * MIN);
    expect(idle.counting).toBe(true);
    idle.stop();
    expect(idle.counting).toBe(false);
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(idleCalls).toEqual([]);
  });

  it("start() twice does not run two clocks", async () => {
    const idle = make(1000);
    idle.start();
    idle.start();
    await vi.advanceTimersByTimeAsync(20 * MIN);
    expect(idleCalls.length).toBe(1);
  });

  it("an error reading the shell state counts as a shell: the server is kept up on a guess, never stopped on one", async () => {
    const idle = make(1000, undefined, () => {
      throw new Error("ps failed");
    });
    idle.start();
    await vi.advanceTimersByTimeAsync(20 * MIN);
    expect(idleCalls).toEqual([]);
    idle.stop();
  });

  it("a rejected asynchronous shell read also keeps the server up", async () => {
    const idle = make(1000, undefined, async () => {
      throw new Error("ps failed");
    });
    idle.start();
    await vi.advanceTimersByTimeAsync(20 * MIN);
    expect(idleCalls).toEqual([]);
    idle.stop();
  });

  it("one failed shell read is one answer of 'keep alive' until the next normal poll: it is read once per evaluation, not retried in a loop", async () => {
    let reads = 0;
    let failing = true;
    const idle = make(
      5 * MIN, // the poll is far away: only the explicit evaluations below read
      undefined,
      () => {
        reads++;
        if (failing) throw new Error("ps failed");
        return false;
      },
    );
    idle.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toBe(1);
    await vi.advanceTimersByTimeAsync(4 * MIN); // no poll yet, no timer of its own
    expect(reads).toBe(1);
    expect(idle.counting).toBe(false);
    failing = false;
    await vi.advanceTimersByTimeAsync(MIN); // the poll at 5:00 reads again and the read now works: the clock starts
    expect(reads).toBe(2);
    expect(idle.counting).toBe(true);
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(idleCalls.length).toBe(1);
  });

  it("an asynchronous shell reader is awaited", async () => {
    shell = true;
    const idle = make(1000, undefined, async () => shell);
    idle.start();
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(idleCalls).toEqual([]);
    shell = false;
    await vi.advanceTimersByTimeAsync(IDLE_MS + 2000);
    expect(idleCalls.length).toBe(1);
  });

  it("the shell is not read while a Code tab is visible, and is read again when the tab goes", async () => {
    let reads = 0;
    visible = true;
    const idle = make(1000, undefined, () => {
      reads++;
      return false;
    });
    idle.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reads).toBe(0);
    visible = false;
    await idle.evaluate();
    expect(reads).toBe(1);
    idle.stop();
  });

  it("the server stopped for another reason (quit, manual stop, crash): stop() runs, an in-flight shell read cannot restart anything, and no later poll reads the shell", async () => {
    let reads = 0;
    let release: (v: boolean) => void = () => undefined;
    const idle = make(1000, undefined, () => {
      reads++;
      return new Promise<boolean>((r) => (release = r));
    });
    idle.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toBe(1); // a read is in flight
    idle.stop();
    release(false); // it answers "no shell" after the stop
    await vi.advanceTimersByTimeAsync(0);
    expect(idle.counting).toBe(false); // the late answer started no countdown
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(reads).toBe(1); // no poller is left
    expect(idleCalls).toEqual([]);
    await idle.evaluate(); // an evaluation after stop() does nothing
    expect(reads).toBe(1);
  });

  it("a stop() while a countdown is running with a shell about to be read leaves nothing behind", async () => {
    const idle = make(1000);
    idle.start();
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(idle.counting).toBe(true);
    idle.stop();
    shell = true;
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(idleCalls).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
  describe("a poll landing while the re-check at the moment the clock runs out is still reading the shell", () => {
    /** A shell reader that answers `false` after `delay` ms, so fire()'s re-check is in flight for a while. */
    function slowShell(delay: number, reads: { n: number }) {
      return () => {
        reads.n++;
        return new Promise<boolean>((r) => setTimeout(() => r(false), delay));
      };
    }

    it("still stops after exactly IDLE_MS plus the read, not a second IDLE_MS later (a poll mid re-check)", async () => {
      const reads = { n: 0 };
      // the first read ends at 30 ms, so the clock runs out at IDLE_MS + 30 and its re-check reads until IDLE_MS + 60;
      // the poll at IDLE_MS + 50 (a 50 ms grid) lands inside that read
      const idle = make(50, undefined, slowShell(30, reads));
      idle.start();
      await vi.advanceTimersByTimeAsync(IDLE_MS + 55); // the countdown has fired, its read is in flight, a poll has landed in it
      expect(idleCalls).toEqual([]);
      await vi.advanceTimersByTimeAsync(2 * SEC);
      expect(idleCalls).toHaveLength(1);
      expect(idleCalls[0]).toBeLessThan(IDLE_MS + 500); // not IDLE_MS * 2
      expect(idle.counting).toBe(false);
      await vi.advanceTimersByTimeAsync(30 * MIN);
      expect(idleCalls).toHaveLength(1); // once
      idle.stop();
    });

    it("a concurrent evaluate() during the re-check does not start a second countdown or delay the stop", async () => {
      const reads = { n: 0 };
      const idle = make(60 * MIN, undefined, slowShell(30, reads));
      idle.start();
      await vi.advanceTimersByTimeAsync(IDLE_MS + 40); // fire() (at IDLE_MS + 30) is awaiting the shell read
      const during = idle.evaluate(); // an event or poll mid re-check
      expect(idle.counting).toBe(false);
      await vi.advanceTimersByTimeAsync(100);
      await during;
      expect(idleCalls).toHaveLength(1);
      expect(idleCalls[0]).toBeLessThan(IDLE_MS + 200);
      await vi.advanceTimersByTimeAsync(IDLE_MS * 2);
      expect(idleCalls).toHaveLength(1);
      idle.stop();
    });

    it("a shell that appears during the re-check still keeps the server up, and the clock then restarts from the next quiet read", async () => {
      let answer = false;
      const idle = make(60 * MIN, undefined, () => new Promise<boolean>((r) => setTimeout(() => r(answer), 30)));
      idle.start();
      await vi.advanceTimersByTimeAsync(IDLE_MS + 40); // fire() (at IDLE_MS + 30) is reading
      answer = true; // a shell opens; the next read (a poll mid re-check) sees it
      const during = idle.evaluate();
      await vi.advanceTimersByTimeAsync(100);
      await during;
      expect(idleCalls).toEqual([]);
      expect(idle.counting).toBe(false);
      await vi.advanceTimersByTimeAsync(30 * MIN);
      expect(idleCalls).toEqual([]);
      answer = false; // closed; the poll is an hour away, so announce it
      const closedAt = Date.now() - t0;
      void idle.evaluate();
      await vi.advanceTimersByTimeAsync(IDLE_MS + 100);
      expect(idleCalls).toHaveLength(1);
      expect(idleCalls[0]).toBeGreaterThanOrEqual(closedAt + IDLE_MS);
      idle.stop();
    });

    it("stop() during the re-check: nothing fires and a later read cannot revive it", async () => {
      const reads = { n: 0 };
      const idle = make(100, undefined, slowShell(30, reads));
      idle.start();
      await vi.advanceTimersByTimeAsync(IDLE_MS + 40);
      idle.stop();
      await vi.advanceTimersByTimeAsync(30 * MIN);
      expect(idleCalls).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
