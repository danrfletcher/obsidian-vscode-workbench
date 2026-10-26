/** Parser for the machine-readable header of docs/spike-decision.md. */
export const DECISION_FIELDS = {
  embed: ["works", "partial", "fails"],
  chrome: ["hidden", "visible"],
  hotkey_bridge: ["yes", "no"],
} as const;

export type Decision = { embed: string; chrome: string; hotkey_bridge: string };

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
