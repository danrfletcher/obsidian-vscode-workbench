/**
 * When the bottom edge, the drawer and the reveal hotkey are available (G6).
 *
 * A Code tab always has the edge. Notes, canvas, graph, PDF and every other view are governed by the one "drawer over
 * non-code views" setting, identically: on shows the always-visible edge, off hides it. The setting only decides that edge.
 * The reveal command and its hotkey are explicit actions and work over every view, and an open drawer stays open and shown
 * when the view changes or the setting is turned off. The open state is an input and is never changed here, so turning the
 * setting back on brings the edge back without closing an open drawer.
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
  /** The "drawer over non-code views" setting. */
  nonCodeDrawer: boolean;
  /** The drawer is open (what was last asked for). */
  drawerOpen: boolean;
}

export interface Visibility {
  /** The always-visible edge at the bottom of the main pane area is on the page. */
  edge: boolean;
  /** The drawer is on the page and showing the terminal. */
  drawer: boolean;
  /** The reveal command and its hotkey work. True over every view. */
  hotkey: boolean;
}

export function drawerVisibility(input: VisibilityInput): Visibility {
  return { edge: input.kind === "code" || input.nonCodeDrawer, drawer: input.drawerOpen, hotkey: true };
}
