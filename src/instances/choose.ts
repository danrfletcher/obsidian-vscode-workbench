/**
 * Which instance the next server start uses (G15): a saved choice always beats
 * the default; the default is the newest VS Code build (stable or Insiders,
 * compared by numeric version). Nothing here writes anything: a saved id that
 * no longer works is reported, and left in data.json until Dan picks again.
 */
import type { Instance, RejectedBuild, ScanResult } from "./scan";

/** `1.144.0-insider` -> [1, 144, 0]. The suffix is ignored; unreadable text gives [0, 0, 0]. */
export function parseVersionNumbers(text: string): number[] {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(text.trim());
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : [0, 0, 0];
}

/** Positive when `a` is newer than `b`. Equal numbers: stable beats Insiders. */
export function compareInstances(a: Instance, b: Instance): number {
  const va = parseVersionNumbers(a.version);
  const vb = parseVersionNumbers(b.version);
  for (let i = 0; i < 3; i++) if (va[i] !== vb[i]) return va[i] - vb[i];
  const rank = (i: Instance) => (i.kind === "vscode" ? 1 : 0);
  return rank(a) - rank(b);
}

function newest(list: Instance[]): Instance | null {
  let best: Instance | null = null;
  for (const i of list) if (!best || compareInstances(i, best) > 0) best = i;
  return best;
}

/**
 * The default: the newest VS Code build. When no VS Code build is present the
 * newest of what is left (VSCodium, Antigravity) so a Code tab can still open;
 * the settings tab warns about Microsoft-only extensions for those.
 */
export function defaultInstance(instances: readonly Instance[]): Instance | null {
  const vscode = instances.filter((i) => i.kind === "vscode" || i.kind === "vscode-insiders");
  return newest(vscode) ?? newest(instances.filter((i) => i.id !== "custom")) ?? newest([...instances]);
}

export interface SavedProblem {
  id: string;
  reason: string;
}

export interface Selection {
  /** What the next start uses; null when nothing usable was found. */
  selected: Instance | null;
  default: Instance | null;
  /** The saved id is shown selected (true) or the default stands in (false). */
  usingSaved: boolean;
  /** The saved id could not be used: why. The id is not rewritten. */
  problem: SavedProblem | null;
}

function reasonFor(id: string, scan: Pick<ScanResult, "rejected" | "customFailure">): string {
  if (id === "custom") return scan.customFailure ? `the custom CLI failed its check: ${scan.customFailure}` : "the custom CLI path is not set.";
  const appPath = id.slice(id.indexOf(":") + 1);
  const rej: RejectedBuild | undefined = scan.rejected.find((r) => r.appPath === appPath);
  if (rej) return `${rej.label} is installed but ${rej.reason}`;
  return "it is no longer installed.";
}

export function chooseInstance(scan: Pick<ScanResult, "instances" | "rejected" | "customFailure">, savedId: string | null): Selection {
  const def = defaultInstance(scan.instances);
  if (savedId) {
    const saved = scan.instances.find((i) => i.id === savedId);
    if (saved) return { selected: saved, default: def, usingSaved: true, problem: null };
    return { selected: def, default: def, usingSaved: false, problem: { id: savedId, reason: reasonFor(savedId, scan) } };
  }
  return { selected: def, default: def, usingSaved: false, problem: null };
}
