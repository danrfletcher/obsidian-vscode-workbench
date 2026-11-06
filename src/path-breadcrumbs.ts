/**
 * The file path above a Code tab's editor, drawn the way Obsidian draws a note's: one `view-header-breadcrumb` per parent folder, each
 * followed by a `/` separator, in the view header's `titleParentEl`. Clicking a folder reveals it in the file explorer. Obsidian only
 * does this for its own `FileView`s, which a Code tab is not (it holds a path, not a `TFile`), so the tab draws it itself.
 */

/** The part of Obsidian's `titleParentEl` the breadcrumbs use. */
export interface BreadcrumbParent {
  empty(): void;
  createSpan(o: { cls: string; text: string }): BreadcrumbSpan;
}

export interface BreadcrumbSpan {
  addEventListener(name: "click", fn: () => void): void;
}

/** The vault-relative folder paths above `file`, outermost first: "a/b/c.py" gives ["a", "a/b"]. A file at the vault root has none. */
export function folderChain(file: string): string[] {
  const parts = file.split("/").filter(Boolean);
  parts.pop(); // the file name is the tab's title, not a breadcrumb
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

/** Redraw the breadcrumbs for `file` ("" clears them). `reveal` is called with the vault-relative folder path of the clicked crumb. */
export function renderPathBreadcrumbs(parent: BreadcrumbParent, file: string, reveal: (folder: string) => void): void {
  parent.empty();
  for (const folder of folderChain(file)) {
    const crumb = parent.createSpan({ cls: "view-header-breadcrumb", text: folder.split("/").pop() ?? folder });
    crumb.addEventListener("click", () => reveal(folder));
    parent.createSpan({ cls: "view-header-breadcrumb-separator", text: "/" });
  }
}
