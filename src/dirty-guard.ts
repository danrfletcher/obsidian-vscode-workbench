/**
 * The unsaved-buffer rule (G2, GP7, E13), as a pure table. Three callers ask the same question about a
 * Code tab's buffer, and the rule is the one place that answers it:
 *
 *  - close: the user closes a tab (the tab's close button, "close all", "close others", Cmd+W, a
 *    background or pinned tab all end in the same call);
 *  - idle:  the 5 minute idle clock wants to stop the server;
 *  - quit:  Obsidian is quitting and the server is about to be stopped.
 *
 * A buffer is "dirty" (the workbench says it holds unsaved text), "clean", or "unreadable" (the embed is
 * not loaded, the page did not answer, or the embed type cannot be read). Unreadable is treated as dirty:
 * an unsaved buffer is never discarded on a guess.
 */

export type BufferState = "clean" | "dirty" | "unreadable";
export type Caller = "close" | "idle" | "quit";
export type AutoSave = "on" | "off";

/**
 * What the caller does next.
 *  - proceed: nothing to protect; close / stop / quit goes ahead.
 *  - settle:  auto-save is on and the buffer is dirty (an edit moments ago): give auto-save a short
 *             time to write it, read the state again, and only then decide (clean closes silently).
 *  - ask:     show the Save / Discard / Cancel prompt.
 *  - block:   do not stop (the idle clock only): no prompt, the server simply stays up.
 */
export type GuardAction = "proceed" | "settle" | "ask" | "block";

export function decide(caller: Caller, state: BufferState, autoSave: AutoSave): GuardAction {
  if (state === "clean") return "proceed";
  if (caller === "idle") return "block";
  if (caller === "close" && state === "dirty" && autoSave === "on") return "settle";
  return "ask";
}

/**
 * What the user chose in the prompt. Escape and clicking away are "cancel" for a tab close and "save" for a quit.
 * A quit prompt has no Cancel (Obsidian closes the window after its quit tasks whatever they answer, so Cancel
 * could only lose the edits).
 */
export type Choice = "save" | "discard" | "cancel";

/**
 * What a choice leads to:
 *  - proceed: the caller goes ahead (close the tab, stop the server);
 *  - stay:    Cancel (a tab close only). The tab stays open and is focused;
 *  - retry:   Save was chosen but the buffer is still dirty afterwards: ask again, in the "could not save" wording.
 * `saved` is the answer of the save attempt, ignored unless the choice is "save". Discard never writes anything.
 */
export type Resolution = "proceed" | "stay" | "retry";

export function resolveChoice(choice: Choice, saved: boolean): Resolution {
  if (choice === "cancel") return "stay";
  if (choice === "discard") return "proceed";
  return saved ? "proceed" : "retry";
}

/** VS Code's `files.autoSave` setting. */
export const AUTO_SAVE_KEY = "files.autoSave";

/** The instance's auto-save: only "off" (VS Code's desktop default, also when the key is missing or unknown) is off. */
export function autoSaveMode(value: unknown): AutoSave {
  return value === "afterDelay" || value === "onFocusChange" || value === "onWindowChange" ? "on" : "off";
}

/**
 * The settings with `files.autoSave` written out. The web workbench's own default is `afterDelay` while
 * VS Code on the desktop defaults to `off`, so a missing key would make the embed save when the chosen
 * instance would not (G2, "per the instance's auto-save"). A value the instance sets is kept.
 */
export function withAutoSaveDefault(settings: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return AUTO_SAVE_KEY in settings ? { ...settings } : { ...settings, [AUTO_SAVE_KEY]: "off" };
}

/** How long a close waits for auto-save to write a just-typed edit (the default delay is 1 s). */
export const SETTLE_MS = 2000;
export const SETTLE_POLL_MS = 200;
