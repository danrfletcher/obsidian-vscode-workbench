/**
 * What a Code tab does with a file that was opened from inside its editor (Go to Definition, Cmd+P quick open, a link; PR-4). The
 * tab never shows the file itself (one file per tab): the target becomes an Obsidian tab of the right kind, or nothing opens and
 * the user is told why. No Obsidian objects here; the plugin passes in what it does (`EditorOpenDeps`), so the rule is tested
 * with fake leaves.
 */
import type { EditorTarget } from "./paths";
import type { LeafLike, OpenFiles } from "./open-file";
import { decideFile, fileName, extensionOf } from "./text-file-rules";

/**
 * Extensions Obsidian opens in a view of its own besides the notes, canvases and bases `decideFile` already names: images, PDF,
 * audio and video. A target of one of these opens the way Obsidian opens it. Every other binary file (an archive, an
 * executable, a font) goes the existing way, which refuses it.
 */
export const OBSIDIAN_VIEW_EXTENSIONS: readonly string[] = [
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "pdf",
  "mp3", "wav", "m4a", "ogg", "flac", "webm", "mp4", "mov", "mkv", "ogv", "3gp",
];

export type EditorOpenPlan =
  /** Not a file of this server: nothing to do (the tab leaves it as VS Code opened it). */
  | { action: "ignore" }
  /** Outside the vault: nothing opens in Obsidian; the user is told which file. */
  | { action: "outside"; name: string }
  /** A kind Obsidian opens in a view of its own (a note, canvas, base, image, PDF). */
  | { action: "obsidian"; file: string }
  /** A Code tab, or the refusal the Code tab path applies (a binary, an over-2 MB file, a hidden folder). */
  | { action: "code"; file: string };

/** The rule: which way a file opened from the editor goes. `excluded` is the extensions the user left to other plugins. */
export function planEditorOpen(target: EditorTarget, excluded: readonly string[] = []): EditorOpenPlan {
  if (target.kind === "other") return { action: "ignore" };
  if (target.kind === "outside") return { action: "outside", name: fileName(target.path) };
  const file = target.file;
  const decision = decideFile(file, excluded);
  if (decision.kind === "hidden") return { action: "code", file }; // the Code tab path refuses it with its own notice
  if (decision.kind === "excluded") return { action: "obsidian", file };
  if (decision.kind === "never") {
    return decision.reason === "binary" && !OBSIDIAN_VIEW_EXTENSIONS.includes(extensionOf(file)) ? { action: "code", file } : { action: "obsidian", file };
  }
  return { action: "code", file };
}

export interface EditorOpenDeps {
  /** The extensions left to other plugins (settings). */
  excluded(): readonly string[];
  /** Open (or focus) the Code tab for `file`, the cursor on `line` (null: leave the cursor). Applies the size and binary guard. */
  openCode(file: string, line: number | null): Promise<void>;
  /** Obsidian's usual open for `file`, in a new tab. */
  openInObsidian(file: string): Promise<void>;
  /** Tell the user. */
  notify(message: string): void;
}

/** What was done, for the log and the tests. */
export type EditorOpenOutcome = EditorOpenPlan["action"];

/** Carry out the plan for a target the editor reported. */
export async function openFromEditor(target: EditorTarget, line: number | null, deps: EditorOpenDeps): Promise<EditorOpenOutcome> {
  const plan = planEditorOpen(target, deps.excluded());
  switch (plan.action) {
    case "ignore":
      break;
    case "outside":
      deps.notify(`VS Code Workbench: ${plan.name} is outside this vault, so Obsidian does not open it.`);
      break;
    case "obsidian":
      await deps.openInObsidian(plan.file);
      break;
    case "code":
      await deps.openCode(plan.file, line);
      break;
  }
  return plan.action;
}

/**
 * Open `file` in a Code tab once: the tab that already shows it (loaded, loading, or restored and not loaded yet; the two
 * spellings of a name that differ in Unicode form count as one file) is focused and its cursor moved to `line`, else `create`
 * makes one. A second call while the first tab is loading waits for it and then focuses it. `line` null leaves the cursor.
 */
export function openCodeTabOnce<L extends LeafLike>(
  openFiles: OpenFiles<L>,
  file: string,
  line: number | null,
  hooks: { create(): Promise<void>; focus(leaf: L): Promise<void> | void; placeCursor(leaf: L, line: number): Promise<void> | void },
): Promise<void> {
  return openFiles.openOnce(file, hooks.create, async (leaf) => {
    await hooks.focus(leaf);
    if (line !== null) await hooks.placeCursor(leaf, line);
  });
}
