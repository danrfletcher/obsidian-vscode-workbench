import { describe, expect, it } from "vitest";
import { INITIAL_HOST_STATE, hostView, reduceHost, type HostEffect, type HostEvent, type HostPhase, type HostState } from "../../src/terminal-host/host-state";

const state = (phase: HostPhase, visible: boolean, error: string | null = null): HostState => ({ phase, visible, error, disposed: false });

const SHOW_NEW: HostEvent = { type: "show", licenceAccepted: false };
const SHOW_ACCEPTED: HostEvent = { type: "show", licenceAccepted: true };

interface Row {
  name: string;
  from: HostState;
  event: HostEvent;
  to: HostState;
  effects: HostEffect[];
}

/** Every transition that changes something, written out. Each row is one cell of the PR's acceptance grid or an edge case. */
const TRANSITIONS: Row[] = [
  // stopped
  { name: "stopped + show, licence not accepted -> licence, start", from: state("stopped", false), event: SHOW_NEW, to: state("licence", true), effects: ["start"] },
  { name: "stopped + show, licence accepted -> starting, start", from: state("stopped", false), event: SHOW_ACCEPTED, to: state("starting", true), effects: ["start"] },
  // licence
  { name: "licence + accepted -> starting", from: state("licence", true), event: { type: "licence-accepted" }, to: state("starting", true), effects: [] },
  { name: "licence + accepted while hidden -> starting, still hidden", from: state("licence", false), event: { type: "licence-accepted" }, to: state("starting", false), effects: [] },
  { name: "licence + declined -> stopped, closed, one notice", from: state("licence", true), event: { type: "licence-declined" }, to: state("stopped", false), effects: ["notice-declined"] },
  { name: "licence + declined while hidden -> stopped, one notice", from: state("licence", false), event: { type: "licence-declined" }, to: state("stopped", false), effects: ["notice-declined"] },
  { name: "licence + failed -> error", from: state("licence", true), event: { type: "failed", reason: "no saveData" }, to: state("error", true, "no saveData"), effects: [] },
  { name: "licence + hide -> licence, hidden (the modal stays)", from: state("licence", true), event: { type: "hide" }, to: state("licence", false), effects: [] },
  { name: "licence + show again -> licence, visible, no second start", from: state("licence", false), event: SHOW_NEW, to: state("licence", true), effects: [] },
  // starting
  { name: "starting + ready -> running", from: state("starting", true), event: { type: "ready" }, to: state("running", true), effects: [] },
  { name: "starting + ready while hidden -> running, still hidden", from: state("starting", false), event: { type: "ready" }, to: state("running", false), effects: [] },
  { name: "starting + failed -> error with the reason", from: state("starting", true), event: { type: "failed", reason: "boom" }, to: state("error", true, "boom"), effects: [] },
  { name: "starting + failed while hidden -> error, still hidden", from: state("starting", false), event: { type: "failed", reason: "boom" }, to: state("error", false, "boom"), effects: [] },
  { name: "starting + declined (the start found the licence declined) -> stopped, closed", from: state("starting", true), event: { type: "licence-declined" }, to: state("stopped", false), effects: ["notice-declined"] },
  { name: "starting + hide -> starting, hidden (the start goes on)", from: state("starting", true), event: { type: "hide" }, to: state("starting", false), effects: [] },
  { name: "starting + show again (double show) -> same start", from: state("starting", true), event: SHOW_ACCEPTED, to: state("starting", true), effects: [] },
  { name: "starting + show while hidden -> visible, same start", from: state("starting", false), event: SHOW_ACCEPTED, to: state("starting", true), effects: [] },
  { name: "starting + retry (Retry during a start) -> unchanged, shares the start", from: state("starting", true), event: { type: "retry" }, to: state("starting", true), effects: [] },
  // error
  { name: "error + retry -> starting, start", from: state("error", true, "boom"), event: { type: "retry" }, to: state("starting", true), effects: ["start"] },
  { name: "error + show while hidden -> visible with the reason, no start", from: state("error", false, "boom"), event: SHOW_ACCEPTED, to: state("error", true, "boom"), effects: [] },
  { name: "error + hide -> error, hidden", from: state("error", true, "boom"), event: { type: "hide" }, to: state("error", false, "boom"), effects: [] },
  // running
  { name: "running + hide -> running, hidden", from: state("running", true), event: { type: "hide" }, to: state("running", false), effects: [] },
  { name: "running + show while hidden -> running, visible, no start", from: state("running", false), event: SHOW_ACCEPTED, to: state("running", true), effects: [] },
  { name: "running + page reloaded -> lost", from: state("running", true), event: { type: "page-reloaded" }, to: state("lost", true), effects: [] },
  { name: "running + page reloaded while hidden -> lost, still hidden", from: state("running", false), event: { type: "page-reloaded" }, to: state("lost", false), effects: [] },
  // lost
  { name: "lost + dismiss -> running", from: state("lost", true), event: { type: "dismiss-lost" }, to: state("running", true), effects: [] },
  { name: "lost + hide -> lost, hidden (the notice is still there at the next show)", from: state("lost", true), event: { type: "hide" }, to: state("lost", false), effects: [] },
  { name: "lost + show -> lost, visible, no start", from: state("lost", false), event: SHOW_ACCEPTED, to: state("lost", true), effects: [] },
];

const PHASES: HostPhase[] = ["stopped", "licence", "starting", "error", "running", "lost"];
const EVENTS: HostEvent[] = [
  SHOW_NEW,
  SHOW_ACCEPTED,
  { type: "hide" },
  { type: "licence-accepted" },
  { type: "licence-declined" },
  { type: "ready" },
  { type: "failed", reason: "x" },
  { type: "retry" },
  { type: "page-reloaded" },
  { type: "dismiss-lost" },
  { type: "dispose" },
];

describe("reduceHost: the transition table", () => {
  it.each(TRANSITIONS)("$name", ({ from, event, to, effects }) => {
    expect(reduceHost(from, event)).toEqual({ state: to, effects });
  });

  it("starts with nothing running, hidden and not disposed", () => {
    expect(INITIAL_HOST_STATE).toEqual({ phase: "stopped", visible: false, error: null, disposed: false });
  });

  it("every phase, visible or hidden, handles every event, and only the rows above change anything but visibility", () => {
    const listed = (from: HostState, event: HostEvent) =>
      TRANSITIONS.some((r) => r.from.phase === from.phase && r.event.type === event.type && (r.event.type !== "show" || (r.event as { licenceAccepted: boolean }).licenceAccepted === (event as { licenceAccepted: boolean }).licenceAccepted));
    for (const phase of PHASES) {
      for (const visible of [true, false]) {
        for (const event of EVENTS) {
          const from = state(phase, visible, phase === "error" ? "boom" : null);
          const step = reduceHost(from, event);
          if (event.type === "dispose") {
            expect(step, `${phase}/${visible} + dispose`).toEqual({ state: { phase: "stopped", visible: false, error: null, disposed: true }, effects: ["teardown"] });
            continue;
          }
          if (listed(from, event)) continue;
          // not a listed transition: nothing starts, nothing is noticed, and the phase is the same
          expect(step.effects, `${phase}/${visible} + ${event.type}`).toEqual([]);
          expect(step.state.phase, `${phase}/${visible} + ${event.type}`).toBe(phase);
          expect(step.state.error, `${phase}/${visible} + ${event.type}`).toBe(from.error);
          // show and hide are the only events that change visibility
          if (event.type === "show") expect(step.state.visible).toBe(true);
          else if (event.type === "hide") expect(step.state.visible).toBe(false);
          else expect(step.state.visible, `${phase}/${visible} + ${event.type}`).toBe(visible);
        }
      }
    }
  });

  it("dispose from any phase tears down once and ignores every later event", () => {
    for (const phase of PHASES) {
      const disposed = reduceHost(state(phase, true), { type: "dispose" });
      expect(disposed.effects).toEqual(["teardown"]);
      expect(disposed.state.disposed).toBe(true);
      for (const event of EVENTS) expect(reduceHost(disposed.state, event), `${phase} + ${event.type} after dispose`).toEqual({ state: disposed.state, effects: [] });
    }
  });

  it("a declined licence is asked again: the next show starts again", () => {
    let s = reduceHost(INITIAL_HOST_STATE, SHOW_NEW).state;
    s = reduceHost(s, { type: "licence-declined" }).state;
    expect(hostView(s)).toBe("hidden");
    expect(reduceHost(s, SHOW_NEW)).toEqual({ state: state("licence", true), effects: ["start"] });
  });

  it("two shows in a row start once", () => {
    const first = reduceHost(INITIAL_HOST_STATE, SHOW_ACCEPTED);
    const second = reduceHost(first.state, SHOW_ACCEPTED);
    expect([...first.effects, ...second.effects]).toEqual(["start"]);
  });

  it("hide during a start, then the start finishes, then show: the terminal, not a stale Starting", () => {
    let s = reduceHost(INITIAL_HOST_STATE, SHOW_ACCEPTED).state;
    s = reduceHost(s, { type: "hide" }).state;
    expect(hostView(s)).toBe("hidden");
    s = reduceHost(s, { type: "ready" }).state;
    expect(hostView(s)).toBe("hidden");
    s = reduceHost(s, SHOW_ACCEPTED).state;
    expect(hostView(s)).toBe("running");
  });

  it("a failed start, Retry, then ready ends running with the error cleared", () => {
    let s = reduceHost(INITIAL_HOST_STATE, SHOW_ACCEPTED).state;
    s = reduceHost(s, { type: "failed", reason: "no VS Code" }).state;
    expect(s).toEqual(state("error", true, "no VS Code"));
    const retry = reduceHost(s, { type: "retry" });
    expect(retry.effects).toEqual(["start"]);
    expect(reduceHost(retry.state, { type: "ready" }).state).toEqual(state("running", true));
  });
});

describe("hostView", () => {
  it("is the phase while visible and 'hidden' while not, whatever the phase", () => {
    for (const phase of PHASES) {
      expect(hostView(state(phase, true))).toBe(phase);
      expect(hostView(state(phase, false))).toBe("hidden");
    }
  });
});
