/**
 * When the strip, the drawer and the reveal hotkey are available (G11, GP6).
 *
 * A Code tab always has them. Notes, canvas, graph, PDF and every other view are governed
 * by the one "non-code views" setting, identically: on shows them, off hides them. The
 * drawer's open state is not part of this and is never changed by it, so turning the
 * setting back on brings the same open drawer, with the same shells, back.
 */

export type ViewKind = "code" | "markdown" | "canvas" | "graph" | "pdf" | "other";

/** The kind of a view, from the type Obsidian reports. `codeViewType` is this plugin's own Code tab type. */
export function viewKind(viewType: string | null | undefined, codeViewType: string): ViewKind {
  if (viewType === codeViewType) return "code";
  switch (viewType) {
    case "markdown":
    case "canvas":
    case "graph":
    case "pdf":
      return viewType;
    default:
      return "other"; // an empty tab, a base, an image: governed by the setting like the rest
  }
}

export interface VisibilityInput {
  kind: ViewKind;
  /** The "terminal drawer over non-code views" setting. */
  nonCodeDrawer: boolean;
  /** The drawer is open (what was last asked for, shown or not). */
  drawerOpen: boolean;
}

export interface Visibility {
  /** The strip at the bottom edge is on the page. */
  strip: boolean;
  /** The drawer is on the page and showing its shells. */
  drawer: boolean;
  /** The reveal command and its hotkey work. */
  hotkey: boolean;
}

export function drawerVisibility(input: VisibilityInput): Visibility {
  const available = input.kind === "code" || input.nonCodeDrawer;
  return { strip: available, drawer: available && input.drawerOpen, hotkey: available };
}
