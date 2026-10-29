/**
 * What the plugin settings tab says about trust (G6, E3). Pure text from the setting and the last seed outcome the
 * host holds; the tab only draws it. The outcome is read from the host, which received it when a Code tab ran the
 * seed, never from the workbench page.
 */

/** The manual route, in the words VS Code shows. */
export const MANUAL_TRUST_STEPS = 'run "Workspaces: Manage Workspace Trust" from the command palette, then choose Trust';

export interface TrustMessage {
  tone: "ok" | "info" | "warning";
  text: string;
}

/** Why a seed that did not take failed, in plain words. `timeout` and `unsupported` come from the webview runner. */
function reasonFor(outcome: string): string {
  if (outcome === "version-mismatch") return "the trust record VS Code stored is not in the format this plugin knows";
  if (outcome === "no-store") return "VS Code's browser storage has no place for the trust record";
  if (outcome === "timeout") return "the workbench page did not answer in time";
  if (outcome === "unsupported") return "this Obsidian cannot run scripts in the Code tab";
  if (outcome.startsWith("error:")) return `the page refused the write (${outcome.slice("error:".length) || "unknown error"})`;
  return `the seed reported "${outcome}"`;
}

/**
 * The line under the toggle: null when there is nothing to say yet (the toggle is on and no Code tab has loaded
 * since the plugin started).
 */
export function describeTrust(enabled: boolean, lastOutcome: string | null): TrustMessage | null {
  if (!enabled) {
    return { tone: "info", text: `Trusting is off, so Code tabs open in Restricted Mode and extensions stay inactive. To trust the vault folder yourself, ${MANUAL_TRUST_STEPS}.` };
  }
  if (lastOutcome === null) return null;
  if (lastOutcome === "seeded") return { tone: "ok", text: "The vault folder was trusted when the last Code tab loaded." };
  return {
    tone: "warning",
    text: `The vault folder could not be trusted automatically (${reasonFor(lastOutcome)}). The Code tab still opens, in Restricted Mode, and extensions stay inactive until you trust the folder: ${MANUAL_TRUST_STEPS}.`,
  };
}
