/**
 * What the "Restart the VS Code server?" prompt says and when it appears (G12), as a pure rule. The plugin gathers the inputs
 * (the server state, the unsaved Code buffers, the live-shell answer, whether the terminal page is loaded) and asks this; the
 * modal draws what it returns. It is the one place that answers the question, so the table test pins it.
 *
 *  - The prompt is asked only of a running server: a crashed, failed or stopped one is restarted without it (the crash banner's
 *    Restart and the failed state's Restart never prompt).
 *  - Unsaved Code buffers give the dirty line, as they always did.
 *  - Live terminal shells give "N terminals will end." ("1 terminal will end." for one), never a line for none. Shells that cannot
 *    be counted (the process table could not be read) give "Terminals will end." with no number, but only while the terminal page
 *    is loaded: with no page there is nothing to end. An exited shell whose tab is left on the page is not in the process table
 *    and so is not counted.
 *  - With nothing dirty and no terminal line there is no prompt.
 */
import type { ServerState } from "./server-manager";

/** The live-shell answer: a count (0 for none), or "unknown" when the shells could not be counted. */
export type ShellAnswer = number | "unknown";

export interface RestartPromptInput {
  state: ServerState;
  /** Names of the Code files with unsaved buffers. */
  dirtyFiles: readonly string[];
  shells: ShellAnswer;
  /** The terminal page is loaded (running, or showing its lost notice). */
  pageLoaded: boolean;
}

export interface RestartPrompt {
  files: string[];
  /** The line about terminals, or null. */
  terminalLine: string | null;
}

/** The terminal line for a live-shell answer, or null when there is none to show. */
export function terminalLine(shells: ShellAnswer, pageLoaded: boolean): string | null {
  if (shells === "unknown") return pageLoaded ? "Terminals will end." : null;
  if (shells <= 0) return null;
  return shells === 1 ? "1 terminal will end." : `${shells} terminals will end.`;
}

/** The prompt to show for these inputs, or null when the restart goes ahead without one. */
export function restartPrompt(input: RestartPromptInput): RestartPrompt | null {
  if (input.state !== "running") return null;
  const line = terminalLine(input.shells, input.pageLoaded);
  if (input.dirtyFiles.length === 0 && line === null) return null;
  return { files: [...input.dirtyFiles], terminalLine: line };
}
