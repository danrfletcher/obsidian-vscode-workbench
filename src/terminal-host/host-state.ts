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
 *  - lost:     the page reloaded under us, or came back after a server restart; the terminals may be gone (shown over the page
 *              until dismissed).
 *  - crashed:  the server died under a mounted page (G13): the page is gone, the crash banner with Restart is shown, and nothing
 *              restarts by itself. The next start of the server (Restart here, or any other) brings the page back with the lost message.
 *
 * `visible` is separate from the phase: hiding the drawer never stops a start or unmounts the page, so a start
 * that finishes while the drawer is hidden ends in `running` and the terminal is what the next `show` reveals.
 * `hostView` folds the two into the single word the drawer is showing, where a hidden drawer is "hidden".
 */

export type HostPhase = "stopped" | "licence" | "starting" | "error" | "running" | "lost" | "crashed";

export interface HostState {
  phase: HostPhase;
  visible: boolean;
  /** The reason shown with Retry; set only in the `error` phase. */
  error: string | null;
  /** The plugin unloaded: the host is torn down and every later event is ignored. */
  disposed: boolean;
  /**
   * Why the terminals may be gone. In the `lost` phase it picks the message (\"reload\": the page reloaded under us; \"restart\": the
   * server was restarted or died). In any other phase \"restart\" is pending: the page was dropped with a dying server, and the page
   * that replaces it is announced with the lost message. Null on a first start, after an idle stop, and once the message is dismissed.
   */
  lostCause: LostCause | null;
}

export type LostCause = "reload" | "restart";

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
  /** The server died on its own (G13). */
  | { type: "server-crashed" }
  /** The server was stopped to be started again (Restart server). Quit and unload never send this: they dispose the host first. */
  | { type: "server-stopped" }
  /** The server was stopped for being idle (no shell, no visible Code tab, nothing dirty). */
  | { type: "server-idle" }
  /** A server is running again. */
  | { type: "server-running" }
  /** A start of the server that nothing in the host started failed (a restart); `reason` is token-free. */
  | { type: "server-failed"; reason: string }
  | { type: "dispose" };

/** What the caller does after a transition. "start" begins one start (licence step, server, page). */
export type HostEffect =
  | "start"
  | "notice-declined"
  | "teardown"
  /** Remove the webview and abandon any start in flight (the server it was loading from is gone). */
  | "drop-page";

export interface HostStep {
  state: HostState;
  effects: HostEffect[];
}

export const INITIAL_HOST_STATE: HostState = { phase: "stopped", visible: false, error: null, disposed: false, lostCause: null };

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
      if (state.phase !== "starting") return stay(state);
      // A page that replaces one lost with its server says so.
      return { state: { ...state, phase: state.lostCause === "restart" ? "lost" : "running", error: null }, effects: [] };
    case "failed":
      return state.phase === "starting" || state.phase === "licence" ? { state: { ...state, phase: "error", error: event.reason }, effects: [] } : stay(state);
    case "retry":
      // Only an error retries. A Retry while a start is running is not an error state, so it does nothing: it shares that start.
      return state.phase === "error" ? { state: { ...state, phase: "starting", error: null }, effects: ["start"] } : stay(state);
    case "page-reloaded":
      return state.phase === "running" ? { state: { ...state, phase: "lost", lostCause: "reload" }, effects: [] } : stay(state);
    case "dismiss-lost":
      return state.phase === "lost" ? { state: { ...state, phase: "running", lostCause: null }, effects: [] } : stay(state);
    case "server-crashed":
      // Only a page that is up or being made has anything to lose. A host that was never shown (or sits at its licence or its
      // error) is untouched: opening it later starts a server as any first open does.
      if (state.phase === "running" || state.phase === "lost") return { state: { ...state, phase: "crashed", error: null, lostCause: "restart" }, effects: ["drop-page"] };
      if (state.phase === "starting") return { state: { ...state, phase: "crashed", error: null }, effects: ["drop-page"] };
      return stay(state);
    case "server-stopped":
      // Restart server: the page is dropped now and made again when the new server runs. A crashed host keeps its banner.
      if (state.phase === "running" || state.phase === "lost") return { state: { ...state, phase: "starting", error: null, lostCause: "restart" }, effects: ["drop-page"] };
      if (state.phase === "starting") return { state, effects: ["drop-page"] };
      return stay(state);
    case "server-idle":
      // An idle stop means no shell was alive, so nothing is lost and nothing is announced. A drawer that is open starts again at
      // once rather than show an empty drawer; a hidden one starts at its next show.
      if (state.phase === "running" || state.phase === "lost" || state.phase === "starting") {
        const next = { ...state, error: null, lostCause: null };
        return state.visible ? { state: { ...next, phase: "starting" }, effects: ["drop-page", "start"] } : { state: { ...next, phase: "stopped" }, effects: ["drop-page"] };
      }
      return stay(state);
    case "server-running":
      // The server is back after a crash, or after the stop of a restart whose page was dropped: make the page again.
      return state.phase === "crashed" ? { state: { ...state, phase: "starting", error: null }, effects: ["start"] } : state.phase === "starting" ? { state, effects: ["start"] } : stay(state);
    case "server-failed":
      // A restart that could not start: a crashed host keeps its banner and shows why; a host whose page was dropped shows the
      // reason with Retry. The lost message is still owed to the page that Retry makes.
      if (state.phase === "crashed") return { state: { ...state, error: event.reason }, effects: [] };
      if (state.phase === "starting") return { state: { ...state, phase: "error", error: event.reason }, effects: [] };
      return stay(state);
    case "dispose":
      return { state: { phase: "stopped", visible: false, error: null, disposed: true, lostCause: null }, effects: ["teardown"] };
  }
}
