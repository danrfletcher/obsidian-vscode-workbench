/**
 * The file path above a Code tab's editor, drawn the way Obsidian draws a note's: one `view-header-breadcrumb` per parent folder, each
 * followed by a `/` separator, in the view header's `titleParentEl`, and ending with the file name in the header title, which reveals
 * the file when clicked. Clicking a folder reveals it in the file explorer; hovering, right-clicking and dragging it do what they do on a note's crumb. Obsidian only
 * does this for its own `FileView`s, which a Code tab is not (it holds a path, not a `TFile`), so the tab draws it itself.
 */

/** The part of Obsidian's `titleParentEl` the breadcrumbs use. */
export interface BreadcrumbParent {
  empty(): void;
  createSpan(o: { cls: string; text: string }): BreadcrumbSpan;
}

/** A mouse or drag event, as far as the crumbs touch it. */
export interface CrumbEvent {
  preventDefault(): void;
}

export interface BreadcrumbSpan {
  addEventListener(name: "click" | "contextmenu" | "dragstart", fn: (evt: CrumbEvent) => void): void;
  draggable?: boolean;
}

/** What a crumb does. Only `reveal` is required: a host without the other three gets a crumb that reveals and nothing more. */
export interface CrumbActions {
  /** Click: reveal the vault-relative folder in the file explorer. */
  reveal(folder: string): void;
  /** Called once as the crumb is drawn: give it a hover tooltip (the host shows the folder's own name, as a note's crumb does). */
  tooltip?(crumb: BreadcrumbSpan, folder: string): void;
  /** Right-click: show the menu a note's crumb shows for the folder. */
  menu?(folder: string, evt: CrumbEvent): void;
  /** Drag start: hand the folder to Obsidian's drag manager. Returns false when it cannot, so the drag is cancelled. */
  drag?(folder: string, evt: CrumbEvent): boolean;
}

/** The vault-relative folder paths above `file`, outermost first: "a/b/c.py" gives ["a", "a/b"]. A file at the vault root has none. */
export function folderChain(file: string): string[] {
  const parts = file.split("/").filter(Boolean);
  parts.pop(); // the file name is not a folder crumb: it ends the path as the header title (renderFileTitle)
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

/** The part of Obsidian's `titleEl` (the view header's title, which follows the path's crumbs) the file name uses. */
export interface FileTitleEl {
  setText(text: string): void;
  onclick: ((evt: unknown) => unknown) | null;
  style?: { cursor: string };
}

/**
 * Put the file name at the end of the path: in the header title, after the folder crumbs, as a note's path ends with its name.
 * The title is set here rather than left to `getDisplayText()` and the leaf's header update, which can leave the placeholder
 * ("VS Code") the tab had before it knew its file. Clicking the name reveals the file in the file explorer. Assigning `onclick`
 * (not adding a listener) keeps a redraw after a rename from stacking handlers.
 */
export function renderFileTitle(titleEl: FileTitleEl, file: string, reveal: (file: string) => void): void {
  const name = file.split("/").filter(Boolean).pop() ?? "";
  titleEl.setText(name);
  if (!name) {
    titleEl.onclick = null;
    return;
  }
  titleEl.onclick = () => reveal(file);
  if (titleEl.style) titleEl.style.cursor = "pointer";
}

/**
 * Redraw the breadcrumbs for `file` ("" clears them). Each crumb carries the same behaviour as a note's: click to reveal,
 * a tooltip, a right-click folder menu, and drag of the folder. The three beyond click are drawn only when `actions` has them.
 */
export function renderPathBreadcrumbs(parent: BreadcrumbParent, file: string, actions: CrumbActions): void {
  parent.empty();
  for (const folder of folderChain(file)) {
    const crumb = parent.createSpan({ cls: "view-header-breadcrumb", text: folder.split("/").pop() ?? folder });
    crumb.addEventListener("click", () => actions.reveal(folder));
    actions.tooltip?.(crumb, folder);
    const { menu, drag } = actions;
    if (menu) {
      crumb.addEventListener("contextmenu", (evt) => {
        evt.preventDefault();
        menu(folder, evt);
      });
    }
    if (drag) {
      crumb.draggable = true;
      crumb.addEventListener("dragstart", (evt) => {
        if (!drag(folder, evt)) evt.preventDefault();
      });
    }
    parent.createSpan({ cls: "view-header-breadcrumb-separator", text: "/" });
  }
}
