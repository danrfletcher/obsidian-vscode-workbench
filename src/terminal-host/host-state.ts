/**
 * The terminal host's state machine (G2, G17, E1, E2, E10). Pure: `reduceHost` takes a state and an event and
 * returns the next state plus the effects the caller must carry out. `host-page.ts` owns the DOM and the webview.
 *
 * Phases:
 *  - stopped:  nothing running and nothing mounted (the start state, and where a declined licence returns to).
 *  - licence:  the licence modal is up; nothing is downloaded or started until Accept.
 *  - starting: the server is starting or the page is loading ("Starting VS Code server...").
 *  - error:    the start failed; the reason and a Retry are shown.
 *  - running:  the terminal page is ready.
 *  - lost:     the page reloaded under us; the terminals may be gone (shown over the page until dismissed).
 *
 * `visible` is separate from the phase: hiding the drawer never stops a start or unmounts the page, so a start
 * that finishes while the drawer is hidden ends in `running` and the terminal is what the next `show` reveals.
 * `hostView` folds the two into the single word the drawer is showing, where a hidden drawer is "hidden".
 */

export type HostPhase = "stopped" | "licence" | "starting" | "error" | "running" | "lost";

export interface HostState {
  phase: HostPhase;
  visible: boolean;
  /** The reason shown with Retry; set only in the `error` phase. */
  error: string | null;
  /** The plugin unloaded: the host is torn down and every later event is ignored. */
  disposed: boolean;
}

export type HostView = HostPhase | "hidden";

export type HostEvent =
  | { type: "show"; licenceAccepted: boolean }
  | { type: "hide" }
  | { type: "licence-accepted" }
  | { type: "licence-declined" }
  | { type: "ready" }
  | { type: "failed"; reason: string }
  | { type: "retry" }
  | { type: "page-reloaded" }
  | { type: "dismiss-lost" }
  | { type: "dispose" };

/** What the caller does after a transition. "start" begins one start (licence step, server, page). */
export type HostEffect = "start" | "notice-declined" | "teardown";

export interface HostStep {
  state: HostState;
  effects: HostEffect[];
}

export const INITIAL_HOST_STATE: HostState = { phase: "stopped", visible: false, error: null, disposed: false };

export function hostView(state: HostState): HostView {
  return state.visible ? state.phase : "hidden";
}

function stay(state: HostState): HostStep {
  return { state, effects: [] };
}

export function reduceHost(state: HostState, event: HostEvent): HostStep {
  if (state.disposed) return stay(state);
  switch (event.type) {
    case "show": {
      const shown = { ...state, visible: true };
      // Only a stopped host starts. A host that is already licence/starting/running/lost/error just becomes
      // visible: a second show never starts a second server, modal or page, and an error waits for Retry.
      if (state.phase !== "stopped") return { state: shown, effects: [] };
      return { state: { ...shown, phase: event.licenceAccepted ? "starting" : "licence" }, effects: ["start"] };
    }
    case "hide":
      return { state: { ...state, visible: false }, effects: [] };
    case "licence-accepted":
      return state.phase === "licence" ? { state: { ...state, phase: "starting" }, effects: [] } : stay(state);
    case "licence-declined":
      // The drawer closes, nothing was downloaded, one notice; the next show asks again. (From `starting` this is the
      // start itself finding the licence declined, which the host's own licence step normally catches first.)
      return state.phase === "licence" || state.phase === "starting"
        ? { state: { ...state, phase: "stopped", visible: false }, effects: ["notice-declined"] }
        : stay(state);
    case "ready":
      return state.phase === "starting" ? { state: { ...state, phase: "running", error: null }, effects: [] } : stay(state);
    case "failed":
      return state.phase === "starting" || state.phase === "licence" ? { state: { ...state, phase: "error", error: event.reason }, effects: [] } : stay(state);
    case "retry":
      // Only an error retries. A Retry while a start is running is not an error state, so it does nothing: it shares that start.
      return state.phase === "error" ? { state: { ...state, phase: "starting", error: null }, effects: ["start"] } : stay(state);
    case "page-reloaded":
      return state.phase === "running" ? { state: { ...state, phase: "lost" }, effects: [] } : stay(state);
    case "dismiss-lost":
      return state.phase === "lost" ? { state: { ...state, phase: "running" }, effects: [] } : stay(state);
    case "dispose":
      return { state: { phase: "stopped", visible: false, error: null, disposed: true }, effects: ["teardown"] };
  }
}
