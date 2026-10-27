/**
 * The "Extensions" section of the plugin settings: what the extension spike (docs/spike-extensions.md,
 * `npm run check:extensions-spike`) measured, the decision it recorded for each of its four questions, the
 * stable port in use and the date of the measurement.
 *
 * It shows a recorded result. Nothing here reads desktop VS Code's state, starts a timer or watches a file
 * (F7): it is drawn from `SPIKE_RESULT` and the host's port status each time the settings tab is opened.
 */

/** The marker the section and the doc use when the spike says the profile's settings and keybindings never reach the tab (F8). */
export const STOP_MARKER = "STOP";

/** What the section says in place of the settings route when it is a STOP. */
export const STOP_TEXT =
  "STOP: the mirrored profile's settings and keybindings do not reach the tab by any route. The profile settings work is not built until Dan has been asked.";

export interface SpikeResult {
  /** The day the measurement ran, `YYYY-MM-DD`. */
  measuredOn: string;
  /** The VS Code build the measurement ran on, for example `1.145.0-insider`. */
  vscodeVersion: string;
  /** Q1: does a stable port keep the webview's origin, and so the trust record, steady across a restart? */
  stablePort: { stable: boolean; result: string; decision: string };
  /** Q2: where VS Code keeps its trust record. `found: false` = the measurement could not find it. */
  trustRecord: { found: boolean; location: string | null; result: string; decision: string };
  /** Q3: do the mirrored profile's settings and keybindings reach the tab? `route` names the one that works. */
  settingsRoute: { arrives: boolean; route: string | null; result: string; decision: string };
  /** Q4: the Turbo Console Log reproduction. `cause` is the real cause from the extension host log, or null. */
  turboConsoleLog: { state: "active" | "inactive" | "failed"; cause: string | null; result: string; decision: string };
}

/** The stable port as the host knows it. */
export interface PortStatus {
  /** The port stored in data.json (`stablePort`); null = none stored yet. */
  stored: number | null;
  /** The port the running server listens on; null when no server runs. */
  current: number | null;
  /** Why the last start did not use the stored port; null when it did. */
  note: string | null;
}

export type Tone = "error" | "warning" | "ok" | "info";

export interface SectionRow {
  name: string;
  text: string;
  tone: Tone;
}

export interface SectionView {
  heading: string;
  rows: SectionRow[];
}

/** The line about the stable port in use. */
export function describePort(port: PortStatus): SectionRow {
  const { stored, current, note } = port;
  let text: string;
  if (stored === null) {
    text = current === null ? "None stored yet: the first server start picks a free port and stores it." : `Server running on port ${current}; it will be stored as this vault's stable port.`;
  } else if (current === null) {
    text = `Stored port ${stored}. No server is running; the next start tries this port first.`;
  } else if (current === stored) {
    text = `Port ${stored} (stored), in use by the running server.`;
  } else {
    text = `Stored port ${stored}; the running server is on ${current} this time.`;
  }
  if (note) text += ` ${note}`;
  return { name: "Stable port in use", text, tone: note ? "warning" : "info" };
}

/** Everything the section shows, as plain data. `result` null = nothing recorded yet. */
export function describeExtensionsSection(result: SpikeResult | null, port: PortStatus): SectionView {
  const rows: SectionRow[] = [];
  if (result === null) {
    rows.push({ name: "Extension spike", text: "No spike result recorded yet.", tone: "info" });
    rows.push(describePort(port));
    return { heading: "Extensions", rows };
  }
  rows.push({ name: "Measured", text: `${result.measuredOn}, on VS Code ${result.vscodeVersion}.`, tone: "info" });
  rows.push({ name: "Stable port", text: `${result.stablePort.result} Decision: ${result.stablePort.decision}`, tone: result.stablePort.stable ? "ok" : "warning" });
  rows.push(describePort(port));

  const t = result.trustRecord;
  rows.push(
    t.found
      ? { name: "Trust record", text: `${t.location ? `Found at ${t.location}. ` : ""}${t.result} Decision: ${t.decision}`, tone: "ok" }
      : { name: "Trust record", text: `not found. ${t.result} Decision: ${t.decision}`, tone: "warning" },
  );

  const s = result.settingsRoute;
  rows.push(
    s.arrives
      ? { name: "Settings and keybindings", text: `${s.route ? `Route: ${s.route}. ` : ""}${s.result} Decision: ${s.decision}`, tone: "ok" }
      : { name: "Settings and keybindings", text: `${STOP_TEXT} ${s.result}`, tone: "error" },
  );

  const c = result.turboConsoleLog;
  const state = c.state === "active" ? "active" : c.state === "failed" ? "failed" : "not active";
  rows.push({
    name: "Turbo Console Log",
    text: `${state}.${c.cause ? ` Cause: ${c.cause}.` : ""} ${c.result} Decision: ${c.decision}`,
    tone: c.state === "active" ? "ok" : "warning",
  });
  return { heading: "Extensions", rows };
}

/**
 * Draw the section into `el`. Called when the settings tab is displayed; it draws once and never refreshes
 * itself. The text is always in Obsidian's own description colour, which reads in both light and dark themes
 * (the success, warning and error text colours do not: `--text-success` is about 2.6:1 on white). The tone is
 * a coloured bar down the left edge of the row (`workbench-extensions-row.workbench-<tone>` in styles.css), and
 * the words themselves ("STOP", "not found", "failed") carry the meaning too, so colour is never the only signal.
 */
export function renderExtensionsSection(el: HTMLElement, view: SectionView): void {
  const box = el.createDiv({ cls: "workbench-extensions" });
  box.createEl("h3", { text: view.heading });
  for (const row of view.rows) {
    const item = box.createDiv({ cls: `workbench-extensions-row workbench-${row.tone}` });
    item.createDiv({ text: row.name, cls: "setting-item-name" });
    item.createDiv({ text: row.text, cls: "setting-item-description workbench-message" });
  }
}
