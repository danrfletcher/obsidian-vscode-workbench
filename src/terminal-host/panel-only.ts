/**
 * Making the host page panel-only (docs/terminal-spike.md, S1). With the plugin's chrome settings and
 * `workbench.panel.opensMaximized: always` in the page's profile, two key presses do the rest, once per profile:
 * the side bar toggle (Cmd+B / Ctrl+B) and Ctrl+backtick (opens the terminal panel and starts the first shell). Both are
 * VS Code's own key bindings, sent into its page; the layout then lives in the partition's profile and holds across
 * reloads, so a page that already is panel-only gets no key.
 *
 * Everything here is pure: a script that reads the layout, and decisions about the layout it returns.
 */

export const PART_NAMES = ["titlebar", "activitybar", "sidebar", "auxiliarybar", "editor", "panel", "statusbar"] as const;
export type PartName = (typeof PART_NAMES)[number];

/** Size of each workbench part in px, or null when the page has no such part. */
export interface PageLayout {
  win: [number, number];
  parts: Record<PartName, [number, number] | null>;
}

/** Runs in the host page; answers a JSON string (or "" while there is no document body). Reads sizes only. */
export const LAYOUT_SCRIPT = `(() => {
  const names = ${JSON.stringify(PART_NAMES)};
  const r = { win: [innerWidth, innerHeight], parts: {} };
  for (const n of names) {
    const e = document.querySelector(".part." + n);
    const b = e && e.getBoundingClientRect();
    r.parts[n] = e ? [Math.round(b.width), Math.round(b.height)] : null;
  }
  return JSON.stringify(r);
})()`;

/** Parse the script's answer; null for anything that is not a layout (a page that is still loading answers nothing useful). */
export function parseLayout(raw: unknown): PageLayout | null {
  if (typeof raw !== "string" || raw === "") return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  const o = v as { win?: unknown; parts?: Record<string, unknown> } | null;
  const pair = (x: unknown): [number, number] | null => (Array.isArray(x) && x.length === 2 && x.every((n) => typeof n === "number") ? [x[0], x[1]] : null);
  const win = pair(o?.win);
  if (!win || !o?.parts || typeof o.parts !== "object") return null;
  const parts = {} as Record<PartName, [number, number] | null>;
  for (const n of PART_NAMES) parts[n] = pair(o.parts[n]);
  return { win, parts };
}

const shown = (p: [number, number] | null): boolean => p !== null && p[0] > 0 && p[1] > 0;

/** Whether one part is drawn (non-zero size). */
export function partShown(l: PageLayout, name: PartName): boolean {
  return shown(l.parts[name]);
}

/** The workbench has drawn something: until then the layout says nothing about the page. */
export function isPainted(l: PageLayout): boolean {
  return PART_NAMES.some((n) => shown(l.parts[n]));
}

/** Slack for scroll bars and borders when comparing the panel with the window. */
const FILL_SLACK = 16;

/** The terminal panel fills the window and no other part shows (F2). */
export function isPanelOnly(l: PageLayout): boolean {
  const panel = l.parts.panel;
  if (!panel || panel[0] < l.win[0] - FILL_SLACK || panel[1] < l.win[1] - FILL_SLACK) return false;
  return PART_NAMES.filter((n) => n !== "panel").every((n) => !shown(l.parts[n]));
}

/** A key press for Electron's `webContents.sendInputEvent`. */
export interface KeyStep {
  name: "side-bar" | "panel";
  keyCode: string;
  modifiers: string[];
}

/**
 * The key presses a page still needs, in the order to send them: the side bar first (focus is still in the editor, where
 * its key works; once the panel is open, focus sits in the terminal and the shell would get it), then the panel.
 * A part that is already the way it should be gets no press: Ctrl+backtick on an open panel would close it.
 */
export function missingSteps(l: PageLayout, mac: boolean): KeyStep[] {
  const steps: KeyStep[] = [];
  if (shown(l.parts.sidebar)) steps.push({ name: "side-bar", keyCode: "B", modifiers: [mac ? "meta" : "control"] });
  if (!shown(l.parts.panel)) steps.push({ name: "panel", keyCode: "`", modifiers: ["control"] });
  return steps;
}
