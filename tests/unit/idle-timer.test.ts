/**
 * The idle clock (G13): every stop rule and every reset rule, on a fake clock.
 * Table rows are timelines of (time, visible Code tab, dirty buffer) changes and
 * the instant the server must stop (or never).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDLE_MS, IdleTimer } from "../../src/idle-timer";

const MIN = 60_000;
const SEC = 1000;

interface Step {
  at: number;
  visible?: boolean;
  dirty?: boolean;
}

interface Row {
  name: string;
  start: { visible: boolean; dirty: boolean };
  steps: Step[];
  /** When the server must stop (ms after start), or null for never within `until`. */
  stopsAt: number | null;
  until: number;
  pollMs?: number;
}

const rows: Row[] = [
  { name: "nothing visible, nothing dirty: stops after exactly 5 minutes", start: { visible: false, dirty: false }, steps: [], stopsAt: 5 * MIN, until: 6 * MIN },
  { name: "a visible Code tab all the time: never stops", start: { visible: true, dirty: false }, steps: [], stopsAt: null, until: 30 * MIN },
  { name: "a dirty buffer all the time (tab hidden): never stops", start: { visible: false, dirty: true }, steps: [], stopsAt: null, until: 30 * MIN },
  {
    name: "a tab visible until 4:59, then hidden: the clock restarts at 4:59 and stops at 9:59",
    start: { visible: true, dirty: false },
    steps: [{ at: 4 * MIN + 59 * SEC, visible: false }],
    stopsAt: 9 * MIN + 59 * SEC,
    until: 11 * MIN,
  },
  {
    name: "becomes visible mid-countdown (at 4:59) and is hidden again at 6:00: stops at 11:00, not 5:00",
    start: { visible: false, dirty: false },
    steps: [
      { at: 4 * MIN + 59 * SEC, visible: true },
      { at: 6 * MIN, visible: false },
    ],
    stopsAt: 11 * MIN,
    until: 12 * MIN,
  },
  {
    name: "dirty buffer saved at 4:00: the clock restarts from when the save is seen",
    start: { visible: false, dirty: true },
    steps: [{ at: 4 * MIN + 500, dirty: false }],
    stopsAt: 4 * MIN + 1000 + 5 * MIN,
    until: 10 * MIN,
    pollMs: 1000,
  },
  {
    name: "buffer turns dirty at 4:30 (mid-countdown) and is saved at 10:00: no stop at 5:00; the poll sees the save at 10:01 and the clock runs out at 15:01",
    start: { visible: false, dirty: false },
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
    start: { visible: false, dirty: false },
    steps: [{ at: 5 * MIN - 500, dirty: true }],
    stopsAt: null,
    until: 5 * MIN + 10 * SEC,
    pollMs: 60 * MIN,
  },
  {
    name: "a visible tab that never goes away, with a dirty buffer that is saved: still no stop",
    start: { visible: true, dirty: true },
    steps: [{ at: 2 * MIN, dirty: false }],
    stopsAt: null,
    until: 20 * MIN,
  },
];

let visible = false;
let dirty = false;
let idleCalls: number[] = [];
let t0 = 0;

function make(pollMs: number, hasDirty?: () => boolean | Promise<boolean>) {
  return new IdleTimer({
    visibleCodeTab: () => visible,
    hasDirtyBuffer: hasDirty ?? (() => dirty),
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
  idleCalls = [];
  t0 = Date.now();
});
afterEach(() => vi.useRealTimers());

describe("IdleTimer: table over (visible tab, dirty buffer, elapsed time)", () => {
  it("uses a 5 minute idle period", () => {
    expect(IDLE_MS).toBe(5 * MIN);
  });

  it.each(rows)("$name", async (row) => {
    visible = row.start.visible;
    dirty = row.start.dirty;
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
});
