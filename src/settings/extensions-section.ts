/**
 * The "Extensions" section of the plugin settings: what the extension spike (docs/spike-extensions.md,
 * `npm run check:extensions-spike`) measured, the decision it recorded for each of its four questions, the
 * stable port in use and the date of the measurement.
 *
 * It shows a recorded result. Nothing here reads desktop VS Code's state, starts a timer or watches a file
 * (F7): it is drawn from `SPIKE_RESULT`, the host's port status and the host's last profile result each time
 * the settings tab is opened. The profile and the disabled lists are read by the server start
 * (src/profile/mirrored-profile.ts, src/mirror/), never here.
 *
 * Under the heading it also draws the list of shared extensions (PR-7): `renderExtensionsSection` leaves a
 * container for it and `renderExtensionList` fills that container from a view the host built when settings
 * opened (src/settings/extension-list.ts). The list has no control; it reports.
 */
import type { MirrorResult } from "../mirror/mirror";
import type { MirroredProfile, ProfileState } from "../profile/mirrored-profile";
import { PROFILE_KINDS } from "../profile/profile-kinds";
import { STATE_TONE, type ExtensionListView } from "./extension-states";

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

const CHOSEN_FROM: Record<MirroredProfile["chosenFrom"], (p: MirroredProfile) => string> = {
  "vault-folder": () => "the vault folder",
  "parent-folder": (p) => `a parent folder (${p.matchedUri ?? "unknown"})`,
  default: () => "default",
};

/** The Profile row: the profile desktop VS Code uses for the vault, where it was chosen from, and the reason for any fallback. */
export function describeProfile(state: ProfileState): SectionRow {
  const name = "Profile";
  if (state.status === "not-read") {
    return { name, text: "Not read yet: the profile is read when the server starts.", tone: "info" };
  }
  if (state.status === "unavailable") {
    return { name, text: `Could not be worked out: ${state.reason}. Default is not assumed; no profile is shown.`, tone: "warning" };
  }
  const p = state.profile;
  let text = `${p.name}. Chosen from: ${CHOSEN_FROM[p.chosenFrom](p)}.`;
  const fromDefault = PROFILE_KINDS.filter((k) => !p.isDefault && p.files[k].from === "default");
  if (fromDefault.length > 0) text += ` Reads Default's ${fromDefault.join(", ")}.`;
  if (p.fallback) text += ` Fallback: ${p.reason}.`;
  return { name, text, tone: p.fallback ? "warning" : "ok" };
}

/** How long ago, in words: "less than a minute", "5 minutes", "2 hours", "3 days". */
export function describeAge(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "less than a minute";
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (minutes < 60) return unit(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return unit(hours, "hour");
  return unit(Math.floor(hours / 24), "day");
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The Disabled in VS Code row: which of three cases applies to the list of extensions desktop VS Code has
 * switched off. It is read at each server start (src/mirror/), never here.
 *  - read: the lists were read at the last start;
 *  - snapshot: the read failed and the snapshot from an earlier start is used (with its age);
 *  - none: the read failed and there is no usable snapshot, so no extensions are shared.
 */
export function describeDisabledLists(result: MirrorResult | null, now: number): SectionRow {
  const name = "Disabled in VS Code";
  if (result === null) return { name, text: "Not read yet: the disabled lists are read when the server starts.", tone: "info" };
  if (result.source === "read") {
    const c = result.counts;
    const parts = [`global ${c.global}`, ...(c.profile === null ? [] : [`profile ${c.profile}`]), `workspace ${c.workspace}`];
    let text = `Disabled lists read from desktop VS Code at the last server start: ${plural(result.disabled.length, "extension")} disabled (${parts.join(", ")}).`;
    if (result.notes.length > 0) text += ` Note: ${result.notes.join("; ")}.`;
    return { name, text, tone: "ok" };
  }
  if (result.source === "snapshot") {
    return {
      name,
      text: `Using the snapshot from an earlier start, taken ${describeAge(now - result.takenAt)} ago (${plural(result.disabled.length, "extension")} disabled). Why: ${result.why}.`,
      tone: "warning",
    };
  }
  return { name, text: `No extensions are shared: ${result.why}.`, tone: "warning" };
}

/** Everything the section shows, as plain data. `result` null = nothing recorded yet. `profile` defaults to not read yet. */
export function describeExtensionsSection(
  result: SpikeResult | null,
  port: PortStatus,
  profile: ProfileState = { status: "not-read" },
  disabled: MirrorResult | null = null,
  now: number = Date.now(),
): SectionView {
  const rows: SectionRow[] = [];
  if (result === null) {
    rows.push({ name: "Extension spike", text: "No spike result recorded yet.", tone: "info" });
    rows.push(describePort(port));
    rows.push(describeProfile(profile));
    rows.push(describeDisabledLists(disabled, now));
    return { heading: "Extensions", rows };
  }
  rows.push({ name: "Measured", text: `${result.measuredOn}, on VS Code ${result.vscodeVersion}.`, tone: "info" });
  rows.push({ name: "Stable port", text: `${result.stablePort.result} Decision: ${result.stablePort.decision}`, tone: result.stablePort.stable ? "ok" : "warning" });
  rows.push(describePort(port));
  rows.push(describeProfile(profile));
  rows.push(describeDisabledLists(disabled, now));

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
 * Returns the container for the extension list, which sits under the intro line and above these rows.
 */
export function renderExtensionsSection(el: HTMLElement, view: SectionView): HTMLElement {
  const box = el.createDiv({ cls: "workbench-extensions" });
  box.createEl("h3", { text: view.heading });
  box.createDiv({ text: LIST_INTRO, cls: "setting-item-description workbench-message" });
  // The list of extensions goes here, above the recorded results; the caller fills it when its read answers.
  const list = box.createDiv({ cls: "workbench-extension-list" });
  for (const row of view.rows) {
    const item = box.createDiv({ cls: `workbench-extensions-row workbench-${row.tone}` });
    item.createDiv({ text: row.name, cls: "setting-item-name" });
    item.createDiv({ text: row.text, cls: "setting-item-description workbench-message" });
  }
  return list;
}

/** The line under the heading: where the list gets its states and when a change shows. */
export const LIST_INTRO = "Changes made in desktop VS Code show here after Restart server.";

/** Shown while the list is being read. */
export const LIST_LOADING = "Reading the extension list…";

/** Shown when the host could not give a list at all. */
export const LIST_FAILED = "The extension list could not be read. Close and reopen settings to try again.";

/** The text of the server-stopped case. */
export const SERVER_NOT_RUNNING = "server not running";

/**
 * Draw the list into `el` (the container `renderExtensionsSection` returned): one item per extension with its
 * name, id and version, and its state and reason. Plain text only, set as text content; the tone is a bar at
 * the item's left edge (`workbench-extension-item.workbench-<tone>` in styles.css). It has no control: nothing
 * here changes an extension (F2).
 */
export function renderExtensionList(el: HTMLElement, view: ExtensionListView): void {
  el.empty();
  if (view.status === "server-not-running") {
    el.createDiv({ text: SERVER_NOT_RUNNING, cls: "setting-item-description workbench-message workbench-extension-note" });
    return;
  }
  if (view.status === "empty") {
    el.createDiv({ text: view.message, cls: "setting-item-name workbench-extension-note" });
    el.createDiv({ text: view.reason, cls: "setting-item-description workbench-message" });
    return;
  }
  for (const row of view.rows) {
    const item = el.createDiv({ cls: `workbench-extension-item workbench-${STATE_TONE[row.state]}` });
    item.createDiv({ text: row.name, cls: "setting-item-name" });
    item.createDiv({ text: `${row.id} · ${row.version}`, cls: "setting-item-description workbench-message workbench-extension-id" });
    item.createDiv({ text: `${row.stateLabel}: ${row.reason}`, cls: "setting-item-description workbench-message workbench-extension-state" });
  }
}
