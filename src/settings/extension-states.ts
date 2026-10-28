/**
 * The state of one extension in the settings list (G11, G16): one of five, picked by a fixed precedence, with a
 * one-line reason. Pure: it is given facts and returns words. It reads no file and asks no host (the facts come
 * from src/settings/extension-list.ts), and it adds no control: the list only reports (F2).
 *
 *   disabled > untrusted > failed > active > inactive
 *
 * The first one that applies wins, so an extension that is both disabled in desktop VS Code and failed reads
 * "disabled in VS Code". Nothing here treats any publisher differently from another (F6).
 */

export type ExtensionState = "disabled" | "untrusted" | "failed" | "active" | "inactive";

/** Highest first: the first state in this list that applies is the one shown. */
export const STATE_PRECEDENCE: readonly ExtensionState[] = ["disabled", "untrusted", "failed", "active", "inactive"];

/** The word the list shows for each state. */
export const STATE_LABEL: Record<ExtensionState, string> = {
  disabled: "disabled in VS Code",
  untrusted: "untrusted",
  failed: "failed",
  active: "active",
  inactive: "inactive",
};

export type StateTone = "ok" | "warning" | "error" | "info";

/** The bar colour of a row. The words carry the meaning too, so colour is never the only signal. */
export const STATE_TONE: Record<ExtensionState, StateTone> = {
  disabled: "info",
  untrusted: "warning",
  failed: "error",
  active: "ok",
  inactive: "info",
};

/** What the extension host log said about one extension; `found: false` = there is no log to ask. */
export type LogFacts =
  | { found: false }
  | {
      found: true;
      /** The log recorded an activation failure; `reason` is its message, or null when it gave none. */
      failed: { reason: string | null } | null;
      /** The log recorded an activation. */
      activated: boolean;
    };

export interface StateFacts {
  /** Desktop VS Code has switched the extension off (the combined disabled lists). */
  disabled: boolean;
  /** The vault folder is not trusted, so the tab keeps the extension from running. */
  untrusted: boolean;
  log: LogFacts;
}

export interface ResolvedState {
  state: ExtensionState;
  /** The words shown for the state: `STATE_LABEL[state]`. */
  label: string;
  /** One line; plain text only. */
  reason: string;
}

/** The longest reason (or name) the list shows; a longer one ends in an ellipsis. */
export const MAX_REASON_CHARS = 200;

/**
 * Plain text for the list: control and bidirectional-override characters become spaces, runs of white space
 * become one space, and text longer than `max` ends in an ellipsis. Null when nothing is left. Idempotent. The
 * result is always set as text content, never as HTML.
 */
export function cleanText(raw: string, max: number = MAX_REASON_CHARS): string | null {
  const text = raw
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text === "") return null;
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

/** The reason line for a failed extension with nothing usable in the log. */
export const NO_REASON_IN_LOG = "no reason in the log";

/** The reason line when the log cannot tell active from inactive. */
export const NO_LOG_NOTE = "no extension host log found";

export const DISABLED_REASON = "switched off in desktop VS Code, so the tab does not run it; changes made there show here after Restart server";
export const UNTRUSTED_REASON = "the vault folder is not trusted, so the tab keeps it from running (see the trust setting above)";
export const ACTIVE_REASON = "activated by the extension host";
export const INACTIVE_REASON = "not activated yet; most extensions start when a file they handle is opened in the tab";

/** Which state applies, by the fixed precedence, and the reason line for it. */
export function resolveState(facts: StateFacts): ResolvedState {
  const state = pick(facts);
  return { state, label: STATE_LABEL[state], reason: reasonFor(state, facts) };
}

function pick(f: StateFacts): ExtensionState {
  if (f.disabled) return "disabled";
  if (f.untrusted) return "untrusted";
  if (f.log.found && f.log.failed) return "failed";
  if (f.log.found && f.log.activated) return "active";
  return "inactive";
}

function reasonFor(state: ExtensionState, f: StateFacts): string {
  switch (state) {
    case "disabled":
      return DISABLED_REASON;
    case "untrusted":
      return UNTRUSTED_REASON;
    case "failed":
      return (f.log.found && f.log.failed?.reason ? cleanText(f.log.failed.reason) : null) ?? NO_REASON_IN_LOG;
    case "active":
      return ACTIVE_REASON;
    case "inactive":
      return f.log.found ? INACTIVE_REASON : NO_LOG_NOTE;
  }
}

/** One row of the list. */
export interface ExtensionRow {
  /** `publisher.name`, as the profile wrote it. */
  id: string;
  name: string;
  version: string;
  state: ExtensionState;
  /** The word shown for the state. */
  stateLabel: string;
  reason: string;
}

/** What the Extensions section draws under its heading. */
export type ExtensionListView =
  /** No server runs: runtime states cannot be told, and nothing from an earlier run is shown. */
  | { status: "server-not-running" }
  /** Nothing is shared (or listed): the message and the reason line. */
  | { status: "empty"; message: string; reason: string }
  | { status: "listed"; rows: ExtensionRow[] };
