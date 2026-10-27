import { PluginSettingTab, Setting, type App, type Plugin } from "obsidian";
import { chooseInstance, type Selection } from "../instances/choose";
import type { CliCheck } from "../instances/probe";
import { CUSTOM_ID, KNOWN_BUILDS, type Instance, type ScanResult } from "../instances/scan";
import type { ServerState } from "../server-manager";
import { addExtension, defaultShell, type WorkbenchSettings } from "./data";
import { describeExtensionsSection, renderExtensionsSection, type PortStatus, type SpikeResult } from "./extensions-section";

export interface SettingsHost {
  restartServer(): Promise<void>;
  serverState(): ServerState;
  workbenchSettings(): WorkbenchSettings;
  updateSettings(patch: Partial<WorkbenchSettings>): Promise<void>;
  /** Scan for VS Code builds (at most one scan in flight). */
  scanInstances(): Promise<ScanResult>;
  /** Check a typed custom CLI path. */
  verifyCustomCli(input: string): Promise<CliCheck>;
  /** A hand-edited `codeCliPath` in data.json, which overrides the choice made here. */
  codeCliOverride(): string | undefined;
  /** The stable port: stored, in use, and why the stored one was passed over. */
  portStatus(): PortStatus;
  /** What the extension spike recorded; null = nothing recorded yet. */
  spikeResult(): SpikeResult | null;
}

type Tone = "error" | "warning" | "ok" | "info";
const TONE_COLOUR: Record<Tone, string | null> = { error: "var(--text-error)", warning: "var(--text-warning)", ok: "var(--text-success)", info: null };

function message(parent: HTMLElement, text: string, tone: Tone): HTMLElement {
  const el = parent.createDiv({ text, cls: `setting-item-description workbench-message workbench-${tone}` });
  const colour = TONE_COLOUR[tone];
  if (colour) el.style.color = colour;
  return el;
}

/** The label of a saved instance id that is not in the list now (the id is `<kind>:<app path>` or `custom`). */
function savedLabel(id: string): string {
  if (id === CUSTOM_ID) return "Custom";
  const kind = id.split(":")[0];
  return KNOWN_BUILDS.find((k) => k.kind === kind)?.label ?? id;
}

/** Dropdown labels: the instance label, with the folder added when two entries would read the same. */
function optionLabels(instances: readonly Instance[], defaultId: string | null): Map<string, string> {
  const counts = new Map<string, number>();
  for (const i of instances) counts.set(i.label, (counts.get(i.label) ?? 0) + 1);
  const out = new Map<string, string>();
  for (const i of instances) {
    let label = i.label;
    if ((counts.get(i.label) ?? 0) > 1 && i.appPath) label += ` (${i.appPath.replace(/\/[^/]*$/, "")})`;
    if (i.id === defaultId) label += " (default)";
    out.set(i.id, label);
  }
  return out;
}

interface InstanceViewState {
  /** A change was made while the server runs: say it applies at the next start. */
  appliesNextStart: boolean;
  /** What the custom path field held, kept across a re-render. */
  customTyped?: string;
  customResult: { tone: Tone; text: string } | null;
}

/** The settings tab: instances, custom CLI, excludes, the drawer toggle, the shell, the extension spike result and Restart server. */
export class WorkbenchSettingTab extends PluginSettingTab {
  /** Bumped by every display(): an answer that belongs to an older display is dropped. */
  private renderId = 0;

  constructor(
    app: App,
    plugin: Plugin,
    private readonly host: SettingsHost,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    const render = ++this.renderId;
    containerEl.empty();

    // The scan answers later; everything else is drawn at once.
    this.loadInstances(containerEl.createDiv(), render, { appliesNextStart: false, customResult: null });
    this.renderExcludes(containerEl.createDiv());
    this.renderDrawerAndShell(containerEl);
    // Read once, here: the section shows the recorded result and the port as they are when settings opens.
    renderExtensionsSection(containerEl.createDiv(), describeExtensionsSection(this.host.spikeResult(), this.host.portStatus()));
    this.renderRestart(containerEl);
  }

  // --- Instances -----------------------------------------------------------

  /** "Scanning…", then the list. Every display() scans again; the host keeps at most one scan in flight. */
  private loadInstances(el: HTMLElement, render: number, state: InstanceViewState): void {
    el.empty();
    message(el, "Scanning…", "info");
    this.host.scanInstances().then(
      (scan) => {
        if (render === this.renderId) this.renderInstances(el, render, scan, state);
      },
      () => {
        if (render !== this.renderId) return;
        el.empty();
        message(el, "Scanning for VS Code builds failed. Close and reopen this tab to try again.", "error");
      },
    );
  }

  private renderInstances(el: HTMLElement, render: number, scan: ScanResult, state: InstanceViewState): void {
    el.empty();
    const settings = this.host.workbenchSettings();
    const sel: Selection = chooseInstance(scan, settings.instanceId);
    const override = this.host.codeCliOverride();
    let typed = state.customTyped ?? settings.customCliPath ?? "";

    if (override) message(el, `A hand-edited codeCliPath in data.json (${override}) overrides the choice below.`, "warning");

    if (scan.instances.length === 0) {
      new Setting(el).setName("VS Code instance").setDesc("The VS Code build the Code tabs run on.");
      message(el, "No VS Code build with serve-web found", "error");
    } else {
      const labels = optionLabels(scan.instances, sel.default?.id ?? null);
      new Setting(el)
        .setName("VS Code instance")
        .setDesc(sel.selected ? `The VS Code build the Code tabs run on. Selected: ${sel.selected.cli}` : "The VS Code build the Code tabs run on.")
        .addDropdown((dd) => {
          for (const i of scan.instances) dd.addOption(i.id, labels.get(i.id) ?? i.label);
          if (sel.selected) dd.setValue(sel.selected.id);
          dd.onChange(async (id) => {
            await this.host.updateSettings({ instanceId: id });
            if (render !== this.renderId) return;
            const live = this.host.serverState();
            this.renderInstances(el, render, scan, { ...state, customTyped: typed, appliesNextStart: live === "running" || live === "starting" });
          });
        });
    }

    if (sel.problem) {
      const using = sel.selected ? `Using ${sel.selected.label} until you pick another.` : "No other build is available.";
      message(el, `The instance you chose earlier (${savedLabel(sel.problem.id)}) cannot be used: ${sel.problem.reason} ${using}`, "error");
    }
    if (state.appliesNextStart) {
      message(el, "The running server keeps its current instance so unsaved changes are not lost; the change applies the next time the server starts.", "info");
    }
    if (sel.selected && !sel.selected.microsoft) {
      message(
        el,
        `${sel.selected.label} is not a Microsoft build: Microsoft-only extensions (Pylance, C/C++, Remote) may refuse to run in it. See "Microsoft-only extensions" in the README.`,
        "warning",
      );
    }

    // Custom CLI path
    new Setting(el)
      .setName("Custom CLI path")
      .setDesc("The absolute path of a VS Code command-line tool. It is listed as Custom, and selected, only after it passes the same serve-web check.")
      .addText((t) => {
        t.setPlaceholder("/path/to/code").setValue(typed);
        t.onChange((v) => {
          typed = v;
        });
      })
      .addButton((b) =>
        b.setButtonText("Verify").onClick(async () => {
          b.setDisabled(true);
          try {
            const r = await this.host.verifyCustomCli(typed);
            if (render !== this.renderId) return;
            if (!r.ok) {
              setCustomResult({ tone: "error", text: r.reason });
              return;
            }
            // A program that passed the check is the one the user means to use: select it, so it does not
            // have to be picked from the list afterwards.
            await this.host.updateSettings({ customCliPath: r.cli, instanceId: CUSTOM_ID });
            if (render !== this.renderId) return;
            const live = this.host.serverState();
            // Rescan so the Custom entry appears in the list, selected.
            this.loadInstances(el, render, {
              ...state,
              appliesNextStart: live === "running" || live === "starting",
              customTyped: r.cli,
              customResult: { tone: "ok", text: "Verified and selected: Custom is now the VS Code instance above." },
            });
          } finally {
            b.setDisabled(false);
          }
        }),
      );
    const customResultEl = el.createDiv();
    const setCustomResult = (r: { tone: Tone; text: string } | null) => {
      customResultEl.empty();
      if (r) message(customResultEl, r.text, r.tone);
    };
    if (state.customResult) setCustomResult(state.customResult);
    else if (scan.customFailure) setCustomResult({ tone: "error", text: `The saved custom CLI cannot be used now: ${scan.customFailure}` });
  }

  // --- Exclude list --------------------------------------------------------

  private renderExcludes(el: HTMLElement, notice = ""): void {
    el.empty();
    let typed = "";
    new Setting(el)
      .setName("Excluded file extensions")
      .setDesc("Files with these extensions do not open in a Code tab. Enter the extension without a dot, for example py.")
      .addText((t) => {
        t.setPlaceholder("py");
        t.onChange((v) => {
          typed = v;
        });
      })
      .addButton((b) =>
        b.setButtonText("Add").onClick(async () => {
          const r = addExtension(this.host.workbenchSettings().excludeExtensions, typed);
          if (!r.ok) {
            resultEl.empty();
            message(resultEl, r.reason, "error");
            return;
          }
          await this.host.updateSettings({ excludeExtensions: r.list });
          this.renderExcludes(el, r.added ? "" : `That extension is already in the list.`);
        }),
      );
    const resultEl = el.createDiv();
    if (notice) message(resultEl, notice, "info");
    for (const ext of this.host.workbenchSettings().excludeExtensions) {
      new Setting(el)
        .setName(ext)
        .addButton((b) =>
          b.setButtonText("Remove").onClick(async () => {
            await this.host.updateSettings({ excludeExtensions: this.host.workbenchSettings().excludeExtensions.filter((e) => e !== ext) });
            this.renderExcludes(el);
          }),
        );
    }
  }

  // --- Drawer toggle and shell ----------------------------------------------

  private renderDrawerAndShell(el: HTMLElement): void {
    const s = this.host.workbenchSettings();
    new Setting(el)
      .setName("Terminal drawer over non-code views")
      .setDesc("Show the terminal strip and drawer over notes, canvas, graph and PDF as well as Code tabs. Off hides the strip, the drawer and the hotkey over those views (shells keep running and the status bar shows how many); a Code tab always has them. Takes effect at once.")
      .addToggle((t) => {
        t.setValue(s.nonCodeDrawer);
        t.onChange((v) => void this.host.updateSettings({ nonCodeDrawer: v }));
      });
    const fallback = defaultShell();
    new Setting(el)
      .setName("Shell")
      .setDesc(`The shell the terminal drawer starts. Leave empty for the default (${fallback}). Stored here; the drawer reads it.`)
      .addText((t) => {
        t.setPlaceholder(fallback).setValue(s.shellPath);
        t.onChange((v) => void this.host.updateSettings({ shellPath: v.trim() }));
      });
  }

  // --- Restart ---------------------------------------------------------------

  private renderRestart(el: HTMLElement): void {
    new Setting(el)
      .setName("Restart server")
      .setDesc(
        `Stops the VS Code server and starts a fresh one with a new secret, on this vault's stable port when it is free. Open Code tabs reload, and unsaved changes in them are lost. Server state: ${this.host.serverState()}.`,
      )
      .addButton((button) =>
        button.setButtonText("Restart server").onClick(async () => {
          button.setDisabled(true);
          try {
            await this.host.restartServer();
          } catch {
            // The reason has been shown in a notice; the button works again from the failed state.
          } finally {
            button.setDisabled(false);
            this.display();
          }
        }),
      );
  }
}
