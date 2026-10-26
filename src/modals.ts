/**
 * The modals the server lifecycle needs. All of them are one `ChoiceModal`: a
 * title, some lines of text, and buttons. Closing the modal any other way
 * (Escape, clicking away) settles with the `dismiss` value, so Escape on the
 * licence modal is a decline, and Escape on the quit prompt saves.
 */
import { Modal, type App } from "obsidian";
import { SERVER_LICENCE_URL } from "./licence";

export interface Choice<T> {
  label: string;
  value: T;
  cta?: boolean;
  warning?: boolean;
}

export interface ChoiceModalOptions<T> {
  title: string;
  lines: string[];
  choices: Choice<T>[];
  /** The result when the modal is closed without pressing a button. */
  dismiss: T;
}

export class ChoiceModal<T> extends Modal {
  private settled = false;
  private resolve!: (v: T) => void;
  readonly result: Promise<T>;
  private buttons: Array<{ disabled: boolean }> = [];

  constructor(app: App, private readonly o: ChoiceModalOptions<T>) {
    super(app);
    this.result = new Promise<T>((r) => (this.resolve = r));
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    // A file name has no spaces to break at, so a long one (the unsaved-changes prompts name the file in the
    // title and the text) would run past the modal's edge; let it break anywhere instead.
    const title = contentEl.createEl("h2", { text: this.o.title });
    title.style.overflowWrap = "anywhere";
    for (const line of this.o.lines) contentEl.createEl("p", { text: line }).style.overflowWrap = "anywhere";
    const row = contentEl.createDiv({ cls: "modal-button-container" });
    for (const c of this.o.choices) {
      const cls = c.cta ? "mod-cta" : c.warning ? "mod-warning" : undefined;
      const btn = row.createEl("button", { text: c.label, cls });
      this.buttons.push(btn as unknown as { disabled: boolean });
      btn.addEventListener("click", () => this.choose(c.value));
    }
  }

  private choose(value: T): void {
    if (this.settled) return; // a double click settles once
    this.settled = true;
    for (const b of this.buttons) b.disabled = true;
    this.resolve(value);
    this.close();
  }

  onClose(): void {
    if (!this.settled) {
      this.settled = true;
      this.resolve(this.o.dismiss);
    }
    this.contentEl.empty();
  }

  /** Open and wait for the answer. */
  ask(): Promise<T> {
    this.open();
    return this.result;
  }
}

/** The VS Code server licence. true only for an explicit Accept; Decline, Escape and clicking away are false. */
export function promptLicence(app: App): Promise<boolean> {
  return new ChoiceModal<boolean>(app, {
    title: "VS Code server licence",
    lines: [
      "Code tabs run the real Visual Studio Code in this window, using its web server (code serve-web) on this computer.",
      "The first time, that server is downloaded from Microsoft. It is covered by the Visual Studio Code Server licence terms, which you can read at " +
        `${SERVER_LICENCE_URL}.`,
      "Nothing is downloaded until you accept. If you decline, files open in your system's default app instead, and you will be asked again the next time.",
      "The server only listens on 127.0.0.1 and is protected by a secret that is never shown or stored in your notes.",
    ],
    choices: [
      { label: "Decline", value: false },
      { label: "Accept and download", value: true, cta: true },
    ],
    dismiss: false,
  }).ask();
}

/** Offline after a VS Code update: offer the last downloaded server build. */
export function promptReuseBuild(app: App, change: { from: string; to: string }): Promise<boolean> {
  return new ChoiceModal<boolean>(app, {
    title: "Use the last downloaded VS Code server?",
    lines: [
      `VS Code was updated from ${change.from} to ${change.to}, and the matching server cannot be downloaded because the network is unreachable.`,
      `You can start the server downloaded for ${change.from} instead. If you decline, Code tabs stay unavailable until you are online.`,
    ],
    choices: [
      { label: "Not now", value: false },
      { label: `Use ${change.from} server`, value: true, cta: true },
    ],
    dismiss: false,
  }).ask();
}

/**
 * Quit with unsaved Code buffers. Save or Discard; Escape saves: it never discards. There is no Cancel:
 * this prompt runs as one of Obsidian's quit tasks, and Obsidian closes the window once the tasks finish,
 * so a Cancel could not stop the quit and would only drop the unsaved edits with the window.
 */
export function promptSaveOrDiscard(app: App, files: string[]): Promise<"save" | "discard"> {
  const list = files.length <= 5 ? files.join(", ") : `${files.slice(0, 5).join(", ")} and ${files.length - 5} more`;
  return new ChoiceModal<"save" | "discard">(app, {
    title: "Unsaved changes in Code tabs",
    lines: [`${list} ${files.length === 1 ? "has" : "have"} unsaved changes. Save them before Obsidian quits, or discard them?`],
    choices: [
      { label: "Discard changes", value: "discard", warning: true },
      { label: "Save", value: "save", cta: true },
    ],
    dismiss: "save",
  }).ask();
}

/** Quit: some buffers were still unsaved after the save. Retry or Discard; Escape retries: it never discards. No Cancel, as above. */
export function promptSaveFailed(app: App, files: string[]): Promise<"retry" | "discard"> {
  const list = files.length <= 5 ? files.join(", ") : `${files.slice(0, 5).join(", ")} and ${files.length - 5} more`;
  return new ChoiceModal<"retry" | "discard">(app, {
    title: "Some changes could not be saved",
    lines: [
      `${list} ${files.length === 1 ? "is" : "are"} still unsaved. A new file without a name cannot be saved from here.`,
      "Obsidian is quitting. Retry saving, or discard these changes?",
    ],
    choices: [
      { label: "Discard changes", value: "discard", warning: true },
      { label: "Retry", value: "retry", cta: true },
    ],
    dismiss: "retry",
  }).ask();
}

export interface CloseDirtyRequest {
  /** The file name shown in the prompt. */
  file: string;
  /** "dirty": the editor reports unsaved changes. "unreadable": the editor could not be asked. */
  state: "dirty" | "unreadable";
  /** A save was tried and the editor still holds unsaved changes. */
  failed?: boolean;
}

/**
 * Closing a Code tab whose editor holds unsaved changes (G2, E13). Cancel keeps the tab open; Escape and
 * clicking away are Cancel, so they never discard. An editor that could not be asked is not offered Save
 * (there is nothing to press it in); it can be closed anyway or kept.
 */
export function promptCloseDirty(app: App, req: CloseDirtyRequest): Promise<"save" | "discard" | "cancel"> {
  let lines: string[];
  let choices: Array<Choice<"save" | "discard" | "cancel">>;
  if (req.state === "unreadable") {
    lines = [
      `The editor for ${req.file} is not ready, so Obsidian cannot tell whether it has unsaved changes.`,
      "Close the tab anyway (unsaved changes would be lost), or keep it open?",
    ];
    choices = [
      { label: "Keep open", value: "cancel" },
      { label: "Close anyway", value: "discard", warning: true },
    ];
  } else {
    lines = req.failed
      ? [`${req.file} is still unsaved. A new file without a name has to be saved from its tab first.`, "Retry saving, discard the changes, or keep the tab open?"]
      : [`${req.file} has unsaved changes. Save them before closing, discard them, or keep the tab open?`];
    choices = [
      { label: "Cancel", value: "cancel" },
      { label: "Discard changes", value: "discard", warning: true },
      { label: req.failed ? "Retry" : "Save", value: "save", cta: true },
    ];
  }
  return new ChoiceModal<"save" | "discard" | "cancel">(app, {
    title: req.state === "unreadable" ? "Close this Code tab?" : `Unsaved changes in ${req.file}`,
    lines,
    choices,
    dismiss: "cancel",
  }).ask();
}

/** Restarting the server while Code tabs hold unsaved changes. Escape cancels. */
export function promptRestartWithDirty(app: App, files: string[]): Promise<boolean> {
  return new ChoiceModal<boolean>(app, {
    title: "Restart the VS Code server?",
    lines: [
      `${files.join(", ")} ${files.length === 1 ? "has" : "have"} unsaved changes. Restarting reloads every Code tab, and unsaved changes are lost.`,
    ],
    choices: [
      { label: "Cancel", value: false },
      { label: "Restart and discard changes", value: true, warning: true },
    ],
    dismiss: false,
  }).ask();
}

/** Killing a running terminal shell (G10). true only for an explicit Kill; Cancel, Escape and clicking away keep the shell. */
export function promptKillShell(app: App, title: string): Promise<boolean> {
  return new ChoiceModal<boolean>(app, {
    title: `Kill ${title}?`,
    lines: [`${title} is still running. Killing it ends the shell and any program running in it, and its scrollback is lost.`],
    choices: [
      { label: "Cancel", value: false },
      { label: "Kill shell", value: true, warning: true },
    ],
    dismiss: false,
  }).ask();
}
