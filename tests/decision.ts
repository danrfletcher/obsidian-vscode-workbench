/** Parser for the machine-readable header of docs/spike-decision.md. */
export const DECISION_FIELDS = {
  embed: ["works", "partial", "fails"],
  chrome: ["hidden", "visible"],
  hotkey_bridge: ["yes", "no"],
  /** What a click on an extensionless file does: open a Code tab, or (the fallback) hand it to the system app. */
  extensionless: ["intercept", "system-app"],
} as const;

export type Decision = { embed: string; chrome: string; hotkey_bridge: string; extensionless: string };

export function parseDecision(text: string): Decision {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!m) throw new Error("spike-decision.md has no header block");
  const values: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([a-z_]+):\s*(\S+)\s*$/.exec(line);
    if (kv) values[kv[1]] = kv[2];
  }
  for (const [field, allowed] of Object.entries(DECISION_FIELDS)) {
    if (!(field in values)) throw new Error(`spike-decision.md header is missing "${field}"`);
    if (!(allowed as readonly string[]).includes(values[field])) {
      throw new Error(`spike-decision.md header "${field}: ${values[field]}" must be one of ${allowed.join("|")}`);
    }
  }
  return values as Decision;
}

/** A `fails` embed stops the build (red test) instead of going green. */
export function stopMessage(d: Decision): string | null {
  return d.embed === "fails" ? "STOP: ask Dan. The VS Code embed cannot run inside Obsidian; there is no Monaco fallback." : null;
}

/** Whether the side bar can be hidden by some route, per measured build (docs/spike-chrome.md, rows S1). */
export type SideBarHideable = { "1.143.1": boolean; "1.144.0": boolean };

/**
 * The chrome spike's stop rule (PR-1 of "Code tab shows just the editor"): the build stops only when NEITHER measured
 * build can hide the side bar by any route. One build hiding it is a pass; the other build's gap is recorded in the report.
 */
export function chromeStopMessage(hideable: SideBarHideable): string | null {
  return hideable["1.143.1"] || hideable["1.144.0"]
    ? null
    : "STOP: ask Dan. The side bar cannot be hidden by any route on either VS Code build (1.143.1, 1.144.0).";
}
